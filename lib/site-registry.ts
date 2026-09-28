import { ApiError } from "@/lib/errors";
import { blobPaths, createJson, isRecord, readAllJson, readJson, replaceJson, storageConfigured } from "@/lib/blob-store";
import { applySiteRegistry, baseSites, importedSiteProfile, sites, type SiteProfile } from "@/lib/sites";
import { slugify } from "@/lib/publishing/definitions";

/*
 * Sites imported from Vercel: one private Blob object per site
 * (roistation-master/sites/<site-id>.json). Built-in sites stay in lib/sites.ts.
 * Archiving never deletes publications, forms or history; restoring brings the
 * site back with the same id, so everything reattaches.
 */

export type SiteRecord = SiteProfile & { source: "vercel"; vercelProjectId: string; archived: boolean; importedAt: string; archivedAt?: string | null; archiveReason?: string };

export function parseSiteRecord(value: unknown, pathname?: string): SiteRecord | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.domain !== "string" || typeof value.vercelProjectId !== "string" || typeof value.archived !== "boolean") return null;
  if (pathname && !pathname.endsWith(`/${value.id}.json`)) return null;
  return value as unknown as SiteRecord;
}

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

export async function listSiteRecords() {
  return readAllJson(blobPaths.siteRecords, parseSiteRecord);
}

export async function getSiteRecord(siteId: string) {
  return (await readJson(blobPaths.siteRecord(siteId), parseSiteRecord))?.value ?? null;
}

/** Creates (or restores) the site for a Vercel project. Returns the site id. */
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

export async function setSiteArchived(siteId: string, archived: boolean, reason?: string) {
  const updated = await updateSiteRecord(siteId, (record) => ({ ...record, archived, archivedAt: archived ? new Date().toISOString() : null, archiveReason: archived ? reason : undefined }));
  await ensureSiteRegistry(true);
  return updated;
}
