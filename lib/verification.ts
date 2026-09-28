import { ApiError } from "@/lib/errors";
import { sites } from "@/lib/sites";
import { ensureSiteRegistry } from "@/lib/site-registry";
import { listConnectionsFor, saveConnection } from "@/lib/connection-storage";
import type { Connection, ConnectionStatus } from "@/lib/publications";
import { getVercelCredentials } from "@/lib/vercel/credentials";
import { deploymentState, deploymentTime, listDeployments, VercelApiError } from "@/lib/vercel/api";
import { computeLiveStatus, projectForSite, upsertProjectRecord, type ConnectorInfo, type DeploymentSummary, type VercelProjectRecord } from "@/lib/vercel/projects";
import { eventKeyForSite, logEvents } from "@/lib/vercel/events";

/*
 * One verification engine for every entry point (Verify, Verify All, connection
 * save, pre-publish check, Vercel sync, cron). Order of checks:
 *   1. Vercel: project exists, latest production deployment state (when the account is connected)
 *   2. Connector endpoint  GET <site>/api/roistation/verify   (JSON, connector kit)
 *   3. Legacy widget code  data-roistation-site + widget.js in the page HTML (existing sites keep working)
 * Status rules: reachable + connected:true -> connected; reachable + connected:false -> not connected;
 * 404 / timeout / invalid JSON -> not verified (unless the widget code is found).
 */

const ENDPOINT_TIMEOUT_MS = 4000;
const PAGE_TIMEOUT_MS = 6000;
const FRESH_MS = 120_000;
const USER_AGENT = "ROIstation-Connector-Check/3.0";

export function masterOrigin() {
  if (!process.env.MASTER_PUBLIC_URL) throw new ApiError("MASTER_PUBLIC_URL değişkenine panelin HTTPS adresini ekle.", 503);
  const url = new URL(process.env.MASTER_PUBLIC_URL);
  if (url.protocol !== "https:" || url.username || url.password) throw new ApiError("MASTER_PUBLIC_URL geçerli bir HTTPS adresi olmalı.", 503);
  return url.origin;
}

/** Hosts a site may be verified on: profile domain, SITE_ALLOWED_HOSTS_JSON and domains reported by its Vercel project. */
export function allowedHosts(siteId: string, project?: Pick<VercelProjectRecord, "productionDomain" | "customDomains" | "name"> | null) {
  const profile = sites.find((site) => site.id === siteId);
  if (!profile) throw new ApiError("Kapsam dışı veya bilinmeyen site.");
  let allowed: Record<string, string[]> = {};
  try { allowed = JSON.parse(process.env.SITE_ALLOWED_HOSTS_JSON || "{}"); } catch { throw new ApiError("SITE_ALLOWED_HOSTS_JSON geçersiz.", 503); }
  const hosts = new Set([profile.domain, `www.${profile.domain}`, ...(Array.isArray(allowed[siteId]) ? allowed[siteId] : [])]);
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
    const response = await fetch(url, { redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": USER_AGENT, accept } });
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

type EndpointProbe =
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

type PageProbe = { reachable: boolean; sslValid: boolean | null; marker: boolean; status?: number; failure?: FetchFailure; url: string };

async function probePage(url: URL, hosts: Set<string>, siteId: string): Promise<PageProbe> {
  try {
    const { response, url: finalUrl } = await safeGet(url, hosts, PAGE_TIMEOUT_MS, "text/html");
    const reachable = response.status < 500;
    if (!response.ok || !response.headers.get("content-type")?.includes("text/html")) { await response.body?.cancel().catch(() => undefined); return { reachable, sslValid: true, marker: false, status: response.status, url: finalUrl.href }; }
    const html = await readCapped(response, 1_500_000);
    const master = masterOrigin();
    const marker = new RegExp(`data-roistation-site=["']${siteId}["']`).test(html) && [`${master}/widget.js`, `${master}/embed/${siteId}`].some((src) => html.includes(`src="${src}`) || html.includes(`src='${src}`));
    return { reachable: true, sslValid: true, marker, status: response.status, url: finalUrl.href };
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) throw error;
    const failure = failureOf(error);
    return { reachable: false, sslValid: failure === "tls" ? false : null, marker: false, failure, url: url.href };
  }
}

const summarizeDeployment = (deployment: Awaited<ReturnType<typeof listDeployments>>[number] | undefined): DeploymentSummary | null => deployment ? {
  id: deployment.uid, url: deployment.url ? `https://${deployment.url}` : null, state: deploymentState(deployment),
  createdAt: deploymentTime(deployment) ? new Date(deploymentTime(deployment)).toISOString() : null, readyAt: deployment.ready ? new Date(deployment.ready).toISOString() : null,
  target: deployment.target ?? null, branch: deployment.meta?.githubCommitRef || deployment.meta?.gitlabCommitRef || deployment.meta?.bitbucketCommitRef || null,
  commit: (deployment.meta?.githubCommitMessage || deployment.meta?.gitlabCommitMessage || "").slice(0, 120) || null,
} : null;

const reasonText: Record<string, string> = {
  "not-found": "Connector uç noktası bulunamadı (404).", "invalid-json": "Connector uç noktası geçerli JSON döndürmedi.", http: "Connector uç noktası hata döndürdü.",
  timeout: "Site zamanında yanıt vermedi.", tls: "SSL sertifikası doğrulanamadı.", network: "Siteye erişilemedi.", redirect: "Yönlendirme sınırı aşıldı.",
};

export type VerifyOptions = { siteUrl?: string | null; project?: VercelProjectRecord | null; skipVercel?: boolean; reason?: string };

export async function verifySite(siteId: string, options: VerifyOptions = {}): Promise<Connection> {
  await ensureSiteRegistry();
  const profile = sites.find((site) => site.id === siteId);
  if (!profile) throw new ApiError("Kapsam dışı veya bilinmeyen site.");
  const [previous] = await listConnectionsFor([siteId]);
  const project = options.project !== undefined ? options.project : await projectForSite(siteId, profile.project).catch(() => null);
  const hosts = allowedHosts(siteId, project);
  const linked = Boolean(project && !project.archived);
  if (linked && project && !project.productionDomain) {
    // Vercel-owned project without a production domain: nothing to probe yet.
    const connection: Connection = { site_id: siteId, site_url: previous?.site_url || `https://${profile.domain}`, verified: false, verified_at: new Date().toISOString(), detail: project.latestProduction ? "Projenin production domaini yok. Vercel'de domain ekleyince otomatik doğrulanır." : "Henüz production deploy yok; ilk deploydan sonra otomatik doğrulanır.", status: "missing-domain", method: "vercel", connectorState: "missing", connector: null, last_seen: previous?.last_seen ?? null, deployment: project.latestProduction ? { state: project.latestProduction.state, createdAt: project.latestProduction.createdAt, readyAt: project.latestProduction.readyAt, url: project.latestProduction.url } : null, checks: { deploymentReady: project.latestProduction ? project.latestProduction.state === "READY" : null, domainActive: null, sslValid: null, connectorReachable: null, publishEndpoint: false } };
    await saveConnection(connection);
    return connection;
  }
  // The Vercel production URL is the source of truth for linked projects; an explicit URL still wins.
  const url = validateUrl(options.siteUrl || (linked ? project?.productionUrl : null) || previous?.site_url || project?.productionUrl || `https://${profile.domain}`, hosts);

  // 1. Vercel deployment state (fresh), in parallel with the site probes.
  const credentials = options.skipVercel || !project || project.archived ? null : await getVercelCredentials();
  const vercelCheck = credentials && project
    ? listDeployments(credentials, project.projectId, 10).then((list) => ({ ok: true as const, latest: summarizeDeployment(list.find((item) => item.target === "production")) }), (error) => ({ ok: false as const, auth: error instanceof VercelApiError && error.kind === "auth", missing: error instanceof VercelApiError && error.kind === "not-found" }))
    : Promise.resolve(null);
  const endpointCheck = probeConnector(url.origin, hosts, siteId);
  const [vercel, endpoint] = await Promise.all([vercelCheck, endpointCheck]);
  // 2./3. Page probe only when the connector endpoint did not answer (legacy widget sites, reachability).
  const page = endpoint.kind === "not-verified" ? await probePage(url, hosts, siteId) : null;

  const latest = vercel && vercel.ok ? vercel.latest : project?.latestProduction ?? null;
  const state = latest?.state || "";
  const domainActive = endpoint.kind !== "not-verified" ? true : page?.reachable ?? null;
  const sslValid = endpoint.kind !== "not-verified" ? true : page?.sslValid ?? null;

  const connectorState: NonNullable<Connection["connectorState"]> = endpoint.kind === "connected" ? "installed" : page?.marker ? "widget" : "missing";
  const connectorText = connectorState === "installed" ? `Connector kurulu${endpoint.kind === "connected" && endpoint.info.version ? ` (v${endpoint.info.version})` : ""}.` : connectorState === "widget" ? "Widget kodu bulundu." : "Connector yok: yayın alınır, içerik sitede görünmesi için yayın alanı (kit/widget) gerekir.";
  // Projects in the connected Vercel account are verified from Vercel itself; no connector installation is required.
  const vercelOwned = linked && Boolean((vercel && vercel.ok) || project?.latestProduction);
  let status: ConnectionStatus; let detail: string; let method: Connection["method"] = null;
  if (project?.archived || (vercel && !vercel.ok && vercel.missing)) { status = "project-missing"; detail = "Vercel projesi bulunamadı; yayın gönderilmez."; }
  else if (["BUILDING", "QUEUED", "INITIALIZING"].includes(state)) { status = "deploying"; detail = "Production deploy sürüyor; hazır olunca otomatik doğrulanır."; }
  else if (state === "ERROR" || state === "CANCELED") { status = "deployment-failed"; detail = "Son production deploy başarısız; yeni başarılı deploy bekleniyor."; }
  else if (domainActive === false) { status = "domain-offline"; detail = reasonText[page?.failure || "network"]; }
  else if (vercelOwned) { status = "connected"; method = "vercel"; detail = `Vercel doğrulandı: production deploy hazır, domain erişilebilir. ${connectorText}`; }
  else if (endpoint.kind === "connected") { status = "connected"; method = "endpoint"; detail = `Connector doğrulandı${endpoint.info.version ? ` (v${endpoint.info.version})` : ""}.`; }
  else if (endpoint.kind === "not-connected") { status = "not-connected"; method = "endpoint"; detail = endpoint.mismatch ? `Connector başka bir site kimliği bildiriyor (${endpoint.info.siteId}). ROISTATION_SITE_ID değerini kontrol et.` : "Connector yanıt verdi ancak bağlı değil (connected:false). Site ortam değişkenlerini kontrol et."; }
  else if (page?.marker) { status = "connected-widget"; method = "widget"; detail = "Yayın alanı ve merkezi bağlantı kodu doğrulandı."; }
  else { status = "not-verified"; detail = page?.status === 200 ? "Sayfada site kimliği ve Master Panel widget.js bağlantısı bulunamadı; /api/roistation/verify de yok. Kodu sitenin ana sayfasına ekle." : reasonText[endpoint.kind === "not-verified" ? endpoint.reason : "network"] || "Bağlantı doğrulanmadı."; }
  if (vercel && !vercel.ok && vercel.auth) detail += " (Vercel API yetkisi gerekli; deploy durumu kontrol edilemedi.)";

  const verified = status === "connected" || status === "connected-widget";
  const now = new Date().toISOString();
  const connector = endpoint.kind === "not-verified" ? (page?.marker ? { connected: true, siteId, siteName: profile.name, version: null, environment: null, lastSeen: now, capabilities: ["widget"] } : null) : endpoint.info;
  const connection: Connection = {
    site_id: siteId, site_url: endpoint.kind === "not-verified" && page ? page.url : url.href, verified, verified_at: now, detail,
    status, method, connectorState, connector, last_seen: verified ? now : previous?.last_seen ?? null,
    deployment: latest ? { state: latest.state, createdAt: latest.createdAt, readyAt: latest.readyAt, url: latest.url } : previous?.deployment ?? null,
    checks: { deploymentReady: latest ? state === "READY" : null, domainActive, sslValid, connectorReachable: endpoint.kind !== "not-verified" || Boolean(page?.marker), publishEndpoint: verified },
  };
  await saveConnection(connection);

  const events = [];
  const key = eventKeyForSite(siteId, project?.projectId);
  // Whoever observes a new production deployment first (verification or sync) logs it.
  if (project && latest && project.latestProduction?.id !== latest.id && ["READY", "ERROR", "BUILDING"].includes(latest.state)) events.push({ key, siteId, projectId: project.projectId, type: latest.state === "READY" ? "deployment-completed" as const : latest.state === "ERROR" ? "deployment-failed" as const : "deployment-started" as const, message: `${project.name}: production deploy ${latest.state.toLowerCase()}${latest.commit ? ` — ${latest.commit}` : ""}` });
  if (previous?.verified !== verified) events.push({ key, siteId, projectId: project?.projectId, type: verified ? "verification-passed" as const : "verification-failed" as const, message: `${profile.name}: ${detail}` });
  if (project && !project.archived) {
    await upsertProjectRecord(project.projectId, (current) => {
      const base = current ?? project;
      const merged = { ...base, siteId: base.siteId || siteId, connector: connector ?? base.connector, latestProduction: latest ?? base.latestProduction, health: { checkedAt: now, apiResponding: vercel ? vercel.ok : base.health?.apiResponding ?? false, deploymentReady: latest ? state === "READY" : null, latestDeploymentSuccessful: latest ? state === "READY" : null, domainActive, sslValid, connectorReachable: connection.checks!.connectorReachable, publishEndpoint: verified } };
      const live = computeLiveStatus(merged, verified);
      return { ...merged, liveStatus: live.status, statusDetail: verified ? live.detail : detail };
    }).catch((error) => console.error("[verify] project record not updated", error));
  }
  await logEvents(events);
  return connection;
}

/**
 * Pre-publish safety: re-verifies target sites that were not checked in the last two
 * minutes. Failures never throw — the publish channel then skips/fails only those sites.
 */
export async function preflightSites(siteIds: string[]) {
  await ensureSiteRegistry();
  const connections = await listConnectionsFor(siteIds);
  await Promise.allSettled(siteIds.map(async (siteId) => {
    const connection = connections.find((row) => row.site_id === siteId);
    const project = await projectForSite(siteId, sites.find((site) => site.id === siteId)?.project).catch(() => null);
    if (!connection && !project) return; // Never connected: the channel reports "Bağlantı kurulmadı" as before.
    if (connection?.verified && Date.now() - Date.parse(connection.verified_at) < FRESH_MS) return;
    await verifySite(siteId, { project, reason: "preflight" });
  }));
}
