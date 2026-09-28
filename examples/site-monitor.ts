/*
 * Example: the site verification / monitoring engine that decides whether a client site can
 * receive publications.
 *
 * Demonstrates:
 *   - a per-site host allow-list (profile domain, SITE_ALLOWED_HOSTS_JSON, domains reported by the
 *     Vercel project) and HTTPS-only URL validation,
 *   - `safeGet()`: redirects are followed MANUALLY and every hop is re-validated against the
 *     allow-list (no SSRF through redirects), max 4 hops, per-request timeout,
 *   - `readCapped()`: response bodies are streamed with a byte cap,
 *   - connector probe: GET <site>/api/roistation/verify must return JSON with a boolean
 *     `connected`; a site id mismatch is reported, 404 / invalid JSON / TLS / timeout are classified,
 *   - legacy widget detection in the page HTML when the endpoint does not answer,
 *   - the status decision chain (project missing > deploying > deploy failed > domain offline >
 *     Vercel-owned > connector endpoint > widget > not verified) and the 2-minute freshness
 *     window used by the pre-publish check.
 *
 * Source: lib/verification.ts (allowedHosts, validateUrl, safeGet, readCapped, probeConnector,
 *         probePage, verifySite, preflightSites), lib/vercel/projects.ts (ConnectorInfo),
 *         connectors/templates/app/api/roistation/verify/route.ts (endpoint response shape)
 *
 * Differences from production: the site profile, SITE_ALLOWED_HOSTS_JSON and MASTER_PUBLIC_URL
 * are passed in as arguments; `fetch` is injectable so `demo()` runs offline; the status chain
 * of verifySite() is lifted into the pure `decideStatus()`. Production also reads the Vercel
 * deployment list, saves the Connection record and the project record (compare-and-swap) and
 * logs verification / deployment events.
 */

export class ApiError extends Error { constructor(message: string, public status = 400) { super(message); } }

export type ConnectorInfo = { connected: boolean; siteId: string | null; siteName: string | null; version: string | null; environment: string | null; lastSeen: string | null; capabilities: string[] };
export type ConnectionStatus = "connected" | "connected-widget" | "not-connected" | "not-verified" | "deploying" | "deployment-failed" | "missing-domain" | "domain-offline" | "project-missing";
type ProjectHosts = { productionDomain: string | null; customDomains: string[]; name: string };

const ENDPOINT_TIMEOUT_MS = 4000;
const PAGE_TIMEOUT_MS = 6000;
const FRESH_MS = 120_000;
const USER_AGENT = "ROIstation-Connector-Check/3.0";

type FetchLike = (input: URL, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);
/** Example-only seam: replaces the global fetch (production calls `fetch` directly). */
export const setFetch = (fn: FetchLike) => { fetchImpl = fn; };

/** Hosts a site may be verified on: profile domain, SITE_ALLOWED_HOSTS_JSON and domains reported by its Vercel project. */
export function allowedHosts(siteId: string, profileDomain: string, allowedHostsJson: string, project?: ProjectHosts | null) {
  let allowed: Record<string, string[]> = {};
  try { allowed = JSON.parse(allowedHostsJson || "{}"); } catch { throw new ApiError("SITE_ALLOWED_HOSTS_JSON geçersiz.", 503); }
  const hosts = new Set([profileDomain, `www.${profileDomain}`, ...(Array.isArray(allowed[siteId]) ? allowed[siteId] : [])]);
  if (project) for (const domain of [project.productionDomain, ...project.customDomains, `${project.name}.vercel.app`]) if (domain) { hosts.add(domain); if (!domain.startsWith("www.")) hosts.add(`www.${domain}`); }
  return hosts;
}

export function validateUrl(input: string | URL, hosts: Set<string>) {
  const url = new URL(input);
  if (url.protocol !== "https:" || (url.port && url.port !== "443") || url.username || url.password || !hosts.has(url.hostname)) throw new ApiError("Domain site için izinli değil. SITE_ALLOWED_HOSTS_JSON ile doğru domaini tanımla.");
  return url;
}

type FetchFailure = "timeout" | "tls" | "network" | "redirect";
const failureOf = (error: unknown): FetchFailure => {
  if (error instanceof ApiError) return "redirect";
  const name = (error as { name?: string })?.name || "";
  const code = String((error as { cause?: { code?: string } })?.cause?.code || "");
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  if (/CERT|SSL|TLS/i.test(code)) return "tls";
  return "network";
};

/** GET with manual, host-checked redirects (no SSRF through redirects). */
export async function safeGet(start: URL, hosts: Set<string>, timeoutMs: number, accept: string) {
  let url = start;
  for (let hop = 0; hop < 4; hop++) {
    const response = await fetchImpl(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": USER_AGENT, accept } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const next = validateUrl(new URL(response.headers.get("location") || "", url).href, hosts);
      try { await response.body?.cancel(); } catch { /* ignore */ }
      url = next; continue;
    }
    return { response, url };
  }
  throw new ApiError("Çok fazla yönlendirme.");
}

export async function readCapped(response: Response, maxBytes: number) {
  const reader = response.body?.getReader(); if (!reader) return "";
  const decoder = new TextDecoder(); let text = ""; let size = 0;
  while (true) {
    const { value, done } = await reader.read(); if (done) break;
    size += value.byteLength; if (size > maxBytes) { await reader.cancel(); throw new Error("too large"); }
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

export type EndpointProbe =
  | { kind: "connected" | "not-connected"; info: ConnectorInfo; mismatch?: boolean }
  | { kind: "not-verified"; reason: "not-found" | "invalid-json" | "http" | FetchFailure; status?: number };

export async function probeConnector(origin: string, hosts: Set<string>, siteId: string | null): Promise<EndpointProbe> {
  try {
    const { response } = await safeGet(new URL("/api/roistation/verify", origin), hosts, ENDPOINT_TIMEOUT_MS, "application/json");
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return { kind: "not-verified", reason: "not-found", status: 404 }; }
    const text = await readCapped(response, 64_000);
    if (!response.ok) return { kind: "not-verified", reason: "http", status: response.status };
    let data: Record<string, unknown>;
    try { const parsed = JSON.parse(text); if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || typeof parsed.connected !== "boolean") throw new Error(); data = parsed; }
    catch { return { kind: "not-verified", reason: "invalid-json", status: response.status }; }
    const str = (value: unknown, max = 120) => typeof value === "string" && value.length <= max ? value : null;
    const info: ConnectorInfo = {
      connected: data.connected === true, siteId: str(data.siteId, 60), siteName: str(data.siteName), version: str(data.version, 40),
      environment: str(data.environment, 40), lastSeen: str(data.lastSeen, 40) || new Date().toISOString(),
      capabilities: Array.isArray(data.capabilities) ? data.capabilities.filter((item): item is string => typeof item === "string").slice(0, 20) : [],
    };
    const mismatch = Boolean(siteId && info.siteId && info.siteId !== siteId);
    return { kind: info.connected && !mismatch ? "connected" : "not-connected", info, mismatch };
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) throw error;
    return { kind: "not-verified", reason: failureOf(error) };
  }
}

export type PageProbe = { reachable: boolean; sslValid: boolean | null; marker: boolean; status?: number; failure?: FetchFailure; url: string };

export async function probePage(url: URL, hosts: Set<string>, siteId: string, master: string): Promise<PageProbe> {
  try {
    const { response, url: finalUrl } = await safeGet(url, hosts, PAGE_TIMEOUT_MS, "text/html");
    const reachable = response.status < 500;
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) { await response.body?.cancel().catch(() => undefined); return { reachable, sslValid: true, marker: false, status: response.status, url: finalUrl.href }; }
    const html = await readCapped(response, 1_500_000);
    const marker = new RegExp(`data-roistation-site=["']${siteId}["']`).test(html) && [`${master}/widget.js`, `${master}/embed/${siteId}`].some((src) => html.includes(`src="${src}`) || html.includes(`src='${src}`));
    return { reachable: true, sslValid: true, marker, status: response.status, url: finalUrl.href };
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) throw error;
    const failure = failureOf(error);
    return { reachable: false, sslValid: failure === "tls" ? false : null, marker: false, failure, url: url.href };
  }
}

const reasonText: Record<string, string> = {
  "not-found": "Connector uç noktası bulunamadı (404).", "invalid-json": "Connector uç noktası geçerli JSON döndürmedi.", http: "Connector uç noktası hata döndürdü.",
  timeout: "Site zamanında yanıt vermedi.", tls: "SSL sertifikası doğrulanamadı.", network: "Siteye erişilemedi.", redirect: "Yönlendirme sınırı aşıldı.",
};

/** Status decision of verifySite(). `vercel` is the fresh deployment lookup (null when Vercel is not connected or skipped). */
export function decideStatus(input: { linked: boolean; projectArchived: boolean; hasLatestProduction: boolean; deploymentState: string; vercel: { ok: true } | { ok: false; auth: boolean; missing: boolean } | null; endpoint: EndpointProbe; page: PageProbe | null }) {
  const { endpoint, page, vercel } = input;
  const state = input.deploymentState;
  const domainActive = endpoint.kind !== "not-verified" ? true : page?.reachable ?? null;
  const connectorState = endpoint.kind === "connected" ? "installed" : page?.marker ? "widget" : "missing";
  const connectorText = connectorState === "installed" ? `Connector kurulu${endpoint.kind === "connected" && endpoint.info.version ? ` (v${endpoint.info.version})` : ""}.` : connectorState === "widget" ? "Widget kodu bulundu." : "Connector yok: yayın alınır, içerik sitede görünmesi için yayın alanı (kit/widget) gerekir.";
  // Projects in the connected Vercel account are verified from Vercel itself; no connector installation is required.
  const vercelOwned = input.linked && Boolean((vercel && vercel.ok) || input.hasLatestProduction);
  let status: ConnectionStatus; let detail: string; let method: "vercel" | "endpoint" | "widget" | null = null;
  if (input.projectArchived || (vercel && !vercel.ok && vercel.missing)) { status = "project-missing"; detail = "Vercel projesi bulunamadı; yayın gönderilmez."; }
  else if (["BUILDING", "QUEUED", "INITIALIZING"].includes(state)) { status = "deploying"; detail = "Production deploy sürüyor; hazır olunca otomatik doğrulanır."; }
  else if (state === "ERROR" || state === "CANCELED") { status = "deployment-failed"; detail = "Son production deploy başarısız; yeni başarılı deploy bekleniyor."; }
  else if (domainActive === false) { status = "domain-offline"; detail = reasonText[page?.failure || "network"]; }
  else if (vercelOwned) { status = "connected"; method = "vercel"; detail = `Vercel doğrulandı: production deploy hazır, domain erişilebilir. ${connectorText}`; }
  else if (endpoint.kind === "connected") { status = "connected"; method = "endpoint"; detail = `Connector doğrulandı${endpoint.info.version ? ` (v${endpoint.info.version})` : ""}.`; }
  else if (endpoint.kind === "not-connected") { status = "not-connected"; method = "endpoint"; detail = endpoint.mismatch ? `Connector başka bir site kimliği bildiriyor (${endpoint.info.siteId}). ROISTATION_SITE_ID değerini kontrol et.` : "Connector yanıt verdi ancak bağlı değil (connected:false). Site ortam değişkenlerini kontrol et."; }
  else if (page?.marker) { status = "connected-widget"; method = "widget"; detail = "Yayın alanı ve merkezi bağlantı kodu doğrulandı."; }
  else { status = "not-verified"; detail = page?.status === 200 ? "Sayfada site kimliği ve Master Panel widget.js bağlantısı bulunamadı; /api/roistation/verify de yok. Kodu sitenin ana sayfasına ekle." : reasonText[endpoint.kind === "not-verified" ? endpoint.reason : "network"] || "Bağlantı doğrulanmadı."; }
  if (vercel && !vercel.ok && vercel.auth) detail += " (Vercel API yetkisi gerekli; deploy durumu kontrol edilemedi.)";
  return { status, detail, method, connectorState, verified: status === "connected" || status === "connected-widget", domainActive };
}

/** preflightSites(): a verified connection checked within the last two minutes is reused before publishing. */
export const needsPreflight = (connection: { verified: boolean; verified_at: string } | undefined, now = Date.now()) => !(connection?.verified && now - Date.parse(connection.verified_at) < FRESH_MS);

/* ------------------------------------------------------------------ demo */

export async function demo() {
  const master = "https://panel.roistation.example";
  const reply = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(body, { status, headers });
  setFetch(async (url) => {
    const key = `${url.hostname}${url.pathname}`;
    if (key === "zeytinlik.example/api/roistation/verify") return reply(JSON.stringify({ connected: true, siteId: "zeytinlik-restoran", siteName: "Zeytinlik Restoran", version: "3.0.0", lastSeen: "2026-01-01T00:00:00.000Z", environment: "production", capabilities: ["verify", "seo-pages", "blog", "sections", "sitemap", "revalidate"], revalidate: true }), 200, { "content-type": "application/json" });
    if (key === "kiyidis.example/api/roistation/verify") return reply("", 404);
    if (key === "kiyidis.example/") return reply(`<html><body><div data-roistation-site="kiyi-dis"></div><script src="${master}/widget.js" defer></script></body></html>`, 200, { "content-type": "text/html; charset=utf-8" });
    if (key === "limantemizlik.example/api/roistation/verify") return reply("", 302, { location: "https://login.other-host.example/" });
    return reply("", 404);
  });

  const zeytinlikHosts = allowedHosts("zeytinlik-restoran", "zeytinlik.example", "{}", { productionDomain: "zeytinlik.example", customDomains: ["zeytinlik.example"], name: "zeytinlik-restoran" });
  const zeytinlik = await probeConnector("https://zeytinlik.example", zeytinlikHosts, "zeytinlik-restoran");
  const kiyiHosts = allowedHosts("kiyi-dis", "kiyidis.example", "{}");
  const kiyiEndpoint = await probeConnector("https://kiyidis.example", kiyiHosts, "kiyi-dis");
  const kiyiPage = kiyiEndpoint.kind === "not-verified" ? await probePage(new URL("https://kiyidis.example/"), kiyiHosts, "kiyi-dis", master) : null;
  // A redirect to a host outside the allow-list is never requested. validateUrl() throws ApiError(400), which
  // probeConnector() re-throws (it only converts non-400 failures into a "not-verified" result).
  let redirected: string | null = null;
  try { await probeConnector("https://limantemizlik.example", allowedHosts("liman-temizlik", "limantemizlik.example", "{}"), "liman-temizlik"); } catch (error) { redirected = (error as Error).message; }
  let rejected: string | null = null;
  try { validateUrl("http://zeytinlik.example/", zeytinlikHosts); } catch (error) { rejected = (error as Error).message; }

  return {
    zeytinlik: decideStatus({ linked: true, projectArchived: false, hasLatestProduction: true, deploymentState: "READY", vercel: { ok: true }, endpoint: zeytinlik, page: null }),
    kiyiDis: decideStatus({ linked: false, projectArchived: false, hasLatestProduction: false, deploymentState: "", vercel: null, endpoint: kiyiEndpoint, page: kiyiPage }),
    offHostRedirect: redirected,
    plainHttpRejected: rejected,
    preflight: { fresh: needsPreflight({ verified: true, verified_at: new Date(Date.now() - 60_000).toISOString() }), stale: needsPreflight({ verified: true, verified_at: new Date(Date.now() - 180_000).toISOString() }) },
  };
}

if (/site-monitor\.ts$/.test(process.argv[1] ?? "")) demo().then((result) => console.log(JSON.stringify(result, null, 2)));
