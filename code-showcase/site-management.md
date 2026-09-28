# Site Management — catalog, registry, verification

## Overview

The panel manages a portfolio of client sites. A "site" is a profile (`SiteProfile`: id, name, domain, sector,
schema.org business type) plus two kinds of stored state: an optional **site record** for sites imported from
Vercel, and a **connection record** that holds the latest verification result. Everything else in the system —
publishing, SEO scans, forms — keys off the site id.

![Site inventory](../assets/screenshots/site-inventory.png)

## Architecture notes

| Layer | File | Storage |
| --- | --- | --- |
| Built-in catalog | `lib/sites.ts` | `NEXT_PUBLIC_ROISTATION_SITES` (JSON) or the fictional `demoSites` |
| Imported sites | `lib/site-registry.ts` | `roistation-master/sites/<site-id>.json` |
| Verification engine | `lib/verification.ts` | writes connection records |
| Connection records | `lib/connection-storage.ts` | `roistation-master/connections/<site-id>.json` |

- `sites` is a **module-level live array**: built-in profiles first, then non-archived imported sites. Server code
  refreshes it with `ensureSiteRegistry()`; the panel refreshes its own copy from `GET /api/sites`.
- Client names never live in source. Deployments set `NEXT_PUBLIC_ROISTATION_SITES`; the public repository falls
  back to a fictional catalog on `.example` and demo `*.vercel.app` domains (`kiyi-dis`, `zeytinlik-restoran`,
  `konak-otel`, …).
- Archiving a site hides it from `sites` but never deletes publications, forms or history; restoring brings it
  back under the same id.

## The code

### 1. Catalog from configuration, with a safe fallback

The catalog is parsed defensively: invalid entries are skipped, ids are validated and de-duplicated, and a broken
JSON value logs once and falls back to the demo catalog instead of taking the panel down.

**Source:** `lib/sites.ts`

```ts
export function parseSiteCatalog(raw: string | undefined): SiteProfile[] | null {
  if (!raw?.trim()) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const seen = new Set<string>();
    const catalog = value.flatMap((entry, index): SiteProfile[] => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Partial<SiteProfile>;
      if (typeof item.id !== "string" || !/^[a-z0-9-]{2,60}$/.test(item.id) || seen.has(item.id)) return [];
      if (typeof item.name !== "string" || typeof item.domain !== "string" || !item.name.trim() || !item.domain.trim()) return [];
      seen.add(item.id);
      // …
    });
    return catalog.length ? catalog : null;
  } catch {
    console.error("[sites] NEXT_PUBLIC_ROISTATION_SITES is not valid JSON; using the demo catalog");
    return null;
  }
}

/** Built-in site profiles (never removed): the configured catalog, or the demo catalog. */
export const baseSites: SiteProfile[] = parseSiteCatalog(process.env.NEXT_PUBLIC_ROISTATION_SITES) ?? demoSites;
// …
export const sites: SiteProfile[] = [...baseSites];

export function applySiteRegistry(imported: SiteProfile[]) {
  const known = new Set(baseSites.map((site) => site.id));
  const extra = imported.filter((site) => !known.has(site.id) && /^[a-z0-9-]{2,60}$/.test(site.id));
  sites.splice(0, sites.length, ...baseSites, ...extra);
  return sites;
}
```

`applySiteRegistry` mutates the array in place (`splice`) rather than reassigning it, so every module that imported
`sites` sees the refreshed list without re-importing. Built-in ids always win over imported ones.

### 2. Registry refresh: cached, de-duplicated, never throws

**Source:** `lib/site-registry.ts`

```ts
const CACHE_MS = 20_000;
let loadedAt = 0;
let inflight: Promise<SiteProfile[]> | null = null;

/** Refreshes the live `sites` list with imported, non-archived sites. Never throws: built-in sites always work. */
export async function ensureSiteRegistry(force = false): Promise<SiteProfile[]> {
  if (!storageConfigured()) return sites;
  if (!force && Date.now() - loadedAt < CACHE_MS) return sites;
  if (!inflight) {
    inflight = listSiteRecords()
      .then((records) => { applySiteRegistry(records.filter((record) => !record.archived)); loadedAt = Date.now(); return sites; })
      .catch((error) => { console.error("[sites] imported site registry could not be loaded; built-in sites only", error); return sites; })
      .finally(() => { inflight = null; });
  }
  return inflight;
}
```

Three properties matter: a 20-second per-instance cache (almost every API route calls this first), a shared
in-flight promise so concurrent requests trigger one Blob listing, and degradation to built-in sites on any
storage error.

### 3. Importing a Vercel project as a site

Ids must be stable (publications and connection records are keyed by them), unique across built-in and imported
sites, and race-safe. The record is written create-only; losing the race is reported as a 409 rather than
silently overwriting another import.

**Source:** `lib/site-registry.ts`

```ts
export async function importVercelSite(input: { preferredId?: string | null; name: string; project: string; domain: string; framework?: string | null; vercelProjectId: string }) {
  const records = await listSiteRecords();
  const existing = records.find((record) => record.vercelProjectId === input.vercelProjectId);
  if (existing) {
    if (existing.archived || existing.domain !== input.domain || existing.name !== input.name) await updateSiteRecord(existing.id, (record) => ({ ...record, archived: false, archivedAt: null, archiveReason: undefined, domain: input.domain, name: input.name, project: input.project }));
    await ensureSiteRegistry(true);
    return existing.id;
  }
  const taken = new Set([...baseSites.map((site) => site.id), ...records.map((record) => record.id)]);
  const candidates = [input.preferredId, slugify(input.project, 50), slugify(input.name, 50)].filter((value): value is string => Boolean(value && /^[a-z0-9-]{2,60}$/.test(value)));
  let id = candidates.find((candidate) => !taken.has(candidate)) || `${slugify(input.project, 40) || "site"}-${input.vercelProjectId.slice(-6).toLowerCase()}`;
  for (let n = 2; taken.has(id); n++) id = `${id.replace(/-\d+$/, "")}-${n}`;
  const record: SiteRecord = { ...importedSiteProfile({ ...input, id }), source: "vercel", vercelProjectId: input.vercelProjectId, archived: false, importedAt: new Date().toISOString() };
  if (await createJson(blobPaths.siteRecord(id), record) === "exists") throw new ApiError("Site kaydı aynı anda oluşturuldu; listeyi yenile.", 409);
  await ensureSiteRegistry(true);
  return id;
}

/** Compare-and-swap update of one site record. */
export async function updateSiteRecord(siteId: string, mutate: (record: SiteRecord) => SiteRecord) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readJson(blobPaths.siteRecord(siteId), parseSiteRecord);
    if (!current) return null;
    const next = mutate(current.value);
    if (await replaceJson(blobPaths.siteRecord(siteId), next, current.etag) === "replaced") { loadedAt = 0; return next; }
  }
  throw new ApiError("Site kaydı aynı anda değişti; tekrar dene.", 409);
}
```

The preferred id comes from the connector's own `siteId` when the site already runs the connector kit, so a site
that was set up by hand keeps the id its environment variables already use.

### 4. Host allow-lists and SSRF-safe fetching

Verification and scanning make outbound requests to client domains. Every URL is checked against an allow-list
built from the profile domain, `SITE_ALLOWED_HOSTS_JSON` and the domains Vercel reports for the linked project, and
redirects are followed manually so a redirect cannot escape the allow-list.

**Source:** `lib/verification.ts`

```ts
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
// …
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
```

### 5. One verification engine, one status vocabulary

Verify buttons, the pre-publish check, Vercel sync and the daily cron all call `verifySite`. The status cascade
reads top to bottom, strongest problem first:

**Source:** `lib/verification.ts`

```ts
  if (project?.archived || (vercel && !vercel.ok && vercel.missing)) { status = "project-missing"; detail = "Vercel projesi bulunamadı; yayın gönderilmez."; }
  else if (["BUILDING", "QUEUED", "INITIALIZING"].includes(state)) { status = "deploying"; detail = "Production deploy sürüyor; hazır olunca otomatik doğrulanır."; }
  else if (state === "ERROR" || state === "CANCELED") { status = "deployment-failed"; detail = "Son production deploy başarısız; yeni başarılı deploy bekleniyor."; }
  else if (domainActive === false) { status = "domain-offline"; detail = reasonText[page?.failure || "network"]; }
  else if (vercelOwned) { status = "connected"; method = "vercel"; detail = `Vercel doğrulandı: production deploy hazır, domain erişilebilir. ${connectorText}`; }
  else if (endpoint.kind === "connected") { status = "connected"; method = "endpoint"; detail = `Connector doğrulandı${endpoint.info.version ? ` (v${endpoint.info.version})` : ""}.`; }
  else if (endpoint.kind === "not-connected") { status = "not-connected"; method = "endpoint"; detail = endpoint.mismatch ? `Connector başka bir site kimliği bildiriyor (${endpoint.info.siteId}). ROISTATION_SITE_ID değerini kontrol et.` : "Connector yanıt verdi ancak bağlı değil (connected:false). Site ortam değişkenlerini kontrol et."; }
  else if (page?.marker) { status = "connected-widget"; method = "widget"; detail = "Yayın alanı ve merkezi bağlantı kodu doğrulandı."; }
  else { status = "not-verified"; detail = page?.status === 200 ? "Sayfada site kimliği ve Master Panel widget.js bağlantısı bulunamadı; /api/roistation/verify de yok. Kodu sitenin ana sayfasına ekle." : reasonText[endpoint.kind === "not-verified" ? endpoint.reason : "network"] || "Bağlantı doğrulanmadı."; }
```

Three verification methods coexist: Vercel ownership (a Ready production deployment in the connected account plus
a reachable domain), the connector kit's `GET /api/roistation/verify` JSON endpoint, and the legacy widget snippet
found in the page HTML. A connector reporting a *different* site id is treated as not connected — that catches a
copy-pasted `ROISTATION_SITE_ID`.

### 6. Connection records: tolerant reads, last-write-wins writes

**Source:** `lib/connection-storage.ts`

```ts
async function readConnection(siteId:string):Promise<Connection|null> {
  try {return (await readJson(blobPaths.connection(siteId),parseConnection))?.value ?? null;}
  catch(error) {
    // A damaged row behaves like "not verified yet"; the next check rewrites it.
    if(error instanceof CorruptDocumentError) {console.error(`[storage] ignored unreadable connection ${siteId}`);return null;}
    if(error instanceof ApiError) throw error;
    throw unavailable();
  }
}
// …
export async function saveConnection(connection:Connection) {
  await ensureSiteRegistry();
  if(!sites.some(site=>site.id===connection.site_id)) throw new ApiError("Kapsam dışı veya bilinmeyen site.");
  requireStorage();
  await ensureMigrated();
  // Verification rows are independent timestamped observations; the newest check wins.
  await overwriteJson(blobPaths.connection(connection.site_id),connection);
  return connection;
}
```

## Engineering notes

- **Freshness window.** `preflightSites` re-verifies only targets not verified in the last two minutes
  (`FRESH_MS = 120_000`), so a publish to eight sites does not always trigger eight probes.
- **Bounded reads.** `readCapped` aborts responses above a byte limit (64 KB for the verify endpoint, 1.5 MB for
  pages), so a hostile or broken site cannot exhaust function memory.
- **TLS vs network failures** are distinguished from the error `cause.code`, so the UI can say "SSL certificate
  could not be verified" instead of a generic "unreachable".
- **Cache and force refresh.** `ensureSiteRegistry(true)` skips the 20-second cache, but if a load is already in
  flight it returns that promise, which may have started before the write that motivated the refresh. In practice
  the next call picks up the change; it is worth knowing when reasoning about read-after-write in the same request.
- **Archiving is soft.** `setSiteArchived` flips a flag with compare-and-swap; nothing downstream is deleted.

## Why it is built this way

**Decision:** keep built-in profiles in configuration, imported sites as one Blob object each, and verification
results as independent last-write-wins observations.

**Alternatives considered:**
- *A single `sites.json` document* holding everything. Simple, but every import, archive and verification would
  contend on one object and need compare-and-swap retries across unrelated sites.
- *A relational database.* The earlier version used one (see `docs/legacy/supabase`); for a single-admin tool with
  tens of sites, a managed Postgres added setup and cost without adding guarantees the Blob primitives do not
  already give.
- *Compare-and-swap for connection records.* Rejected because a verification result is a timestamped observation:
  the newest check is the truth, and retrying on conflict would only re-assert something stale.

**Trade-offs accepted:** listing imported sites costs a Blob list operation (mitigated by the 20-second cache), and
the live `sites` array is per-instance state, so two serverless instances can briefly disagree for up to that window.

## Best practices demonstrated

- Configuration parsed with validation, de-duplication and a logged, non-fatal fallback.
- In-place mutation of a shared module array so importers never hold a stale reference.
- Promise de-duplication (`inflight`) for expensive refreshes.
- Allow-listed outbound requests with manual redirect handling and capped body reads.
- Choosing the write primitive by data semantics: create-only for identity, CAS for mutable records, last-write-wins
  for observations.

## Related

- [docs/Architecture.md](../docs/Architecture.md) · [docs/Publishing-Engine.md](../docs/Publishing-Engine.md) ·
  [connector flow diagram](../docs/diagrams/connector-flow.svg)
- Sibling walkthroughs: [deployment-engine.md](deployment-engine.md), [permissions.md](permissions.md),
  [state-management.md](state-management.md), [vercel-integration.md](vercel-integration.md)
