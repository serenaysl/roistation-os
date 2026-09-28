import { get, put, del, list, BlobPreconditionFailedError } from "@vercel/blob";
import { ApiError } from "@/lib/errors";

/*
 * One JSON document per Blob object. Every write touches exactly one pathname:
 *   create   -> allowOverwrite:false (idempotent insert)
 *   replace  -> ifMatch:<etag>       (compare-and-swap on that object only)
 *   overwrite-> last write wins      (independent observations: connections, rate limits)
 * Nothing in this module reads or writes a shared application snapshot.
 */

export const blobRoot = "roistation-master";
export const blobPaths = {
  publications: `${blobRoot}/publications/`,
  publication: (id: string) => `${blobRoot}/publications/${id}.json`,
  submissions: `${blobRoot}/submissions/`,
  submission: (id: string) => `${blobRoot}/submissions/${id}.json`,
  generations: `${blobRoot}/generations/`,
  generation: (id: string) => `${blobRoot}/generations/${id}.json`,
  generationFingerprints: `${blobRoot}/generation-fingerprints/`,
  generationFingerprint: (fingerprint: string) => `${blobRoot}/generation-fingerprints/${fingerprint}.json`,
  connections: `${blobRoot}/connections/`,
  connection: (siteId: string) => `${blobRoot}/connections/${siteId}.json`,
  rateLimits: `${blobRoot}/rate-limit/`,
  rateLimit: (digest: string) => `${blobRoot}/rate-limit/${digest}.json`,
  // Sites imported from Vercel (built-in profiles live in lib/sites.ts).
  siteRecords: `${blobRoot}/sites/`,
  siteRecord: (siteId: string) => `${blobRoot}/sites/${siteId}.json`,
  // Vercel integration: one object per project, per event; small settings/credential docs.
  vercelProjects: `${blobRoot}/vercel/projects/`,
  vercelProject: (projectId: string) => `${blobRoot}/vercel/projects/${projectId}.json`,
  vercelEvents: `${blobRoot}/vercel/events/`,
  vercelEvent: (key: string, name: string) => `${blobRoot}/vercel/events/${key}/${name}.json`,
  vercelCredentials: `${blobRoot}/vercel/credentials.json`,
  vercelSettings: `${blobRoot}/vercel/settings.json`,
  vercelSyncState: `${blobRoot}/vercel/sync-state.json`,
  vercelSyncLock: `${blobRoot}/vercel/sync-lock.json`,
  // SEO & GEO Center: one create-only object per scan and per optimization (history is never rewritten).
  seoScans: `${blobRoot}/seo/scans/`,
  seoScan: (siteId: string, name: string) => `${blobRoot}/seo/scans/${siteId}/${name}.json`,
  seoOptimizations: `${blobRoot}/seo/optimizations/`,
  seoOptimization: (siteId: string, name: string) => `${blobRoot}/seo/optimizations/${siteId}/${name}.json`,
  seoIgnored: (siteId: string) => `${blobRoot}/seo/ignored/${siteId}.json`,
  githubCredentials: `${blobRoot}/github/credentials.json`,
  migrationMarker: `${blobRoot}/migrations/state-json-v1.json`,
  // Legacy layout. Read only by lib/migration.ts, never written.
  legacyState: `${blobRoot}/v1/state.json`,
  legacyConnections: `${blobRoot}/v1/connections/`,
  legacyGenerations: `${blobRoot}/v1/generations/`,
  legacyRates: `${blobRoot}/v1/rates/`,
};

const READ_TIMEOUT_MS = 5000;
const WRITE_TIMEOUT_MS = 8000;
const LIST_TIMEOUT_MS = 8000;
const MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
const LIST_PAGE_SIZE = 1000;
const MAX_LIST_PAGES = 100;

export function storageConfigured() {return Boolean(process.env.BLOB_READ_WRITE_TOKEN || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN));}
export function requireStorage() {
  if(!storageConfigured()) throw new ApiError("Kalıcı kayıt için Vercel Storage bölümünden Private Blob deposunu bu projeye bağla; sonra yeniden deploy et.",503);
}

const accessMessage = "Özel Vercel Blob deposuna erişilemedi. Storage → Blob → Private deposunu bu projeye bağla ve yeniden deploy et. İşlem sonucunu listeyi yenileyerek kontrol et.";
const rateLimitedMessage = "Vercel Blob kısa süreli istek sınırına ulaştı. Birkaç saniye bekleyip tekrar dene; işlem yarıda kaldıysa listeyi yenileyerek kontrol et.";
const timeoutMessage = "Vercel Blob zamanında yanıt vermedi. Listeyi yenileyerek işlemin kaydedilip kaydedilmediğini kontrol et, sonra gerekirse tekrar dene.";

export class CorruptDocumentError extends ApiError {
  constructor(public pathname: string) {super("Kayıt dosyası okunamadı veya bozuk. Vercel Blob deposunu kontrol et.",503);}
}

type BlobFailureKind = "precondition" | "access" | "rate-limited" | "timeout" | "not-found" | "unknown";
function errorName(error: unknown) {
  if(!error || typeof error !== "object") return "";
  const ctor = (error as { constructor?: { name?: string } }).constructor?.name || "";
  const name = (error as { name?: string }).name || "";
  return ctor && ctor !== "Error" ? ctor : name;
}
export function classifyBlobError(error: unknown): BlobFailureKind {
  if(error instanceof BlobPreconditionFailedError) return "precondition";
  const name = errorName(error);
  const message = error instanceof Error ? error.message : String(error);
  if(name === "BlobPreconditionFailedError" || /precondition/i.test(message)) return "precondition";
  if(["BlobAccessError","BlobStoreNotFoundError","BlobStoreSuspendedError","BlobClientTokenExpiredError"].includes(name) || /access denied|forbidden|suspended|store does not exist|no token found/i.test(message)) return "access";
  if(name === "BlobServiceRateLimited" || /rate limit|too many requests/i.test(message)) return "rate-limited";
  if(["AbortError","TimeoutError","BlobRequestAbortedError"].includes(name) || /aborted|timed? ?out/i.test(message)) return "timeout";
  if(name === "BlobNotFoundError" || /not found/i.test(message)) return "not-found";
  return "unknown";
}
export function blobFailure(error: unknown, operation: string, pathname: string): ApiError {
  if(error instanceof ApiError) return error;
  const kind = classifyBlobError(error);
  console.error(`[storage] ${operation} ${pathname} failed (${kind}): ${errorName(error) || "Error"}: ${error instanceof Error ? error.message : String(error)}`);
  if(kind === "rate-limited") return new ApiError(rateLimitedMessage,503);
  if(kind === "timeout") return new ApiError(timeoutMessage,503);
  return new ApiError(accessMessage,503);
}

export type Stored<T> = { value: T; etag: string | null; pathname: string };
export type Parser<T> = (value: unknown, pathname: string) => T | null;

/** Latest (uncached) read of one private JSON document. Returns null when it does not exist. */
export async function readJson<T>(pathname: string, parse: Parser<T>): Promise<Stored<T> | null> {
  requireStorage();
  let raw: string;
  let etag: string | null;
  try {
    const result = await get(pathname,{access:"private",useCache:false,abortSignal:AbortSignal.timeout(READ_TIMEOUT_MS)});
    if(!result) return null;
    // Leads and drafts must never live in a public store.
    if(!result.blob.url.includes(".private.blob.vercel-storage.com/") || result.statusCode !== 200 || !result.stream) throw new ApiError(accessMessage,503);
    raw = await new Response(result.stream).text();
    etag = result.blob.etag || null;
  } catch(error) {
    if(classifyBlobError(error) === "not-found" && !(error instanceof ApiError)) return null;
    throw blobFailure(error,"read",pathname);
  }
  if(Buffer.byteLength(raw) > MAX_DOCUMENT_BYTES) throw new CorruptDocumentError(pathname);
  let data: unknown;
  try {data = JSON.parse(raw);} catch {throw new CorruptDocumentError(pathname);}
  const value = parse(data,pathname);
  if(value === null) throw new CorruptDocumentError(pathname);
  return {value,etag,pathname};
}

function serialize(pathname: string, value: unknown) {
  const raw = JSON.stringify(value);
  if(Buffer.byteLength(raw) > MAX_DOCUMENT_BYTES) throw new ApiError("Kayıt 4 MB sınırını aşıyor; işlem kaydedilmedi. İçeriği kısaltıp tekrar dene.",413);
  return raw;
}

/**
 * Create-only write. Returns "exists" when another request (or an earlier
 * attempt of this one) already created the object. Never overwrites.
 */
export async function createJson(pathname: string, value: unknown): Promise<"created" | "exists"> {
  requireStorage();
  const raw = serialize(pathname,value);
  try {
    await put(pathname,raw,{access:"private",addRandomSuffix:false,allowOverwrite:false,contentType:"application/json",cacheControlMaxAge:60,abortSignal:AbortSignal.timeout(WRITE_TIMEOUT_MS)});
    forgetCached(pathname);
    return "created";
  } catch(error) {
    const kind = classifyBlobError(error);
    if(kind === "access" || kind === "rate-limited") throw blobFailure(error,"create",pathname);
    // The SDK has no dedicated "already exists" class, and a timed-out write may
    // still have landed. One direct read of THIS object settles both cases.
    try {
      const existing = await get(pathname,{access:"private",useCache:false,abortSignal:AbortSignal.timeout(READ_TIMEOUT_MS)});
      if(existing) {forgetCached(pathname);return "exists";}
    } catch { /* Report the original write failure below. */ }
    throw blobFailure(error,"create",pathname);
  }
}

/** Compare-and-swap on one object. "conflict" means its ETag changed since it was read. */
export async function replaceJson(pathname: string, value: unknown, etag: string | null): Promise<"replaced" | "conflict"> {
  requireStorage();
  if(!etag) throw new ApiError(accessMessage,503);
  const raw = serialize(pathname,value);
  try {
    await put(pathname,raw,{access:"private",addRandomSuffix:false,allowOverwrite:true,ifMatch:etag,contentType:"application/json",cacheControlMaxAge:60,abortSignal:AbortSignal.timeout(WRITE_TIMEOUT_MS)});
    forgetCached(pathname);
    return "replaced";
  } catch(error) {
    forgetCached(pathname);
    if(classifyBlobError(error) === "precondition") return "conflict";
    throw blobFailure(error,"replace",pathname);
  }
}

/** Last-write-wins write for independent observations (connection checks, rate counters, indexes). */
export async function overwriteJson(pathname: string, value: unknown, options: { cacheControlMaxAge?: number } = {}) {
  requireStorage();
  const raw = serialize(pathname,value);
  try {
    await put(pathname,raw,{access:"private",addRandomSuffix:false,allowOverwrite:true,contentType:"application/json",cacheControlMaxAge:options.cacheControlMaxAge ?? 60,abortSignal:AbortSignal.timeout(WRITE_TIMEOUT_MS)});
    forgetCached(pathname);
  } catch(error) {forgetCached(pathname);throw blobFailure(error,"overwrite",pathname);}
}

/** Deletes one object. Deleting a missing object is a no-op. */
export async function deleteJson(pathname: string) {
  requireStorage();
  try {
    await del(pathname,{abortSignal:AbortSignal.timeout(WRITE_TIMEOUT_MS)});
    forgetCached(pathname);
  } catch(error) {
    forgetCached(pathname);
    if(classifyBlobError(error) === "not-found") return;
    throw blobFailure(error,"delete",pathname);
  }
}

export type ListedBlob = { pathname: string; version: string; hasEtag: boolean };

/** Lists every object under a prefix (metadata only, no document bodies). */
export async function listBlobs(prefix: string): Promise<ListedBlob[]> {
  requireStorage();
  const rows: ListedBlob[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;
  for(let page = 0; page < MAX_LIST_PAGES; page++) {
    let result: Awaited<ReturnType<typeof list>>;
    try {result = await list({prefix,limit:LIST_PAGE_SIZE,...(cursor ? {cursor} : {}),abortSignal:AbortSignal.timeout(LIST_TIMEOUT_MS)});}
    catch(error) {throw blobFailure(error,"list",prefix);}
    for(const blob of result.blobs) {
      if(!blob.pathname.startsWith(prefix) || !blob.pathname.endsWith(".json")) continue;
      const listedEtag = (blob as { etag?: unknown }).etag;
      const uploadedAt = blob.uploadedAt instanceof Date ? blob.uploadedAt.getTime() : Date.parse(String(blob.uploadedAt));
      rows.push(typeof listedEtag === "string" && listedEtag
        ? {pathname:blob.pathname,version:`etag:${listedEtag}`,hasEtag:true}
        : {pathname:blob.pathname,version:`meta:${uploadedAt}:${blob.size}`,hasEtag:false});
    }
    if(!result.hasMore || !result.cursor || seenCursors.has(result.cursor)) return rows;
    seenCursors.add(result.cursor);cursor = result.cursor;
  }
  console.error(`[storage] list ${prefix} stopped after ${MAX_LIST_PAGES} pages`);
  return rows;
}

export async function mapLimit<T,R>(items: T[], limit: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({length:Math.min(Math.max(1,limit),items.length)},async()=>{
    while(next < items.length) {const index = next++;results[index] = await worker(items[index],index);}
  });
  await Promise.all(runners);
  return results;
}

/*
 * Per-instance cache of parsed documents for LIST views only, keyed by the
 * object's listed version. A changed object gets a new version and is re-read;
 * single-record reads (getPublication, submissions, generations) never use it.
 */
type CacheEntry = { version: string; value: unknown; storedAt: number };
const documentCache = new Map<string, CacheEntry>();
const CACHE_LIMIT = 5000;
const ETAG_CACHE_TTL_MS = 10 * 60 * 1000;
// Without a listed ETag the version is uploadedAt+size; keep that fallback short so a
// withdrawal written by another instance is never served for long.
const META_CACHE_TTL_MS = 10 * 1000;
export function forgetCached(pathname: string) {documentCache.delete(pathname);}
function remember(pathname: string, version: string, value: unknown) {
  if(documentCache.size >= CACHE_LIMIT) {const oldest = documentCache.keys().next().value;if(oldest !== undefined) documentCache.delete(oldest);}
  documentCache.set(pathname,{version,value,storedAt:Date.now()});
}

/** Reads every document under a prefix, fetching only objects that changed since this instance last saw them. */
export async function readAllJson<T>(prefix: string, parse: Parser<T>, concurrency = 12): Promise<T[]> {
  const listed = await listBlobs(prefix);
  const now = Date.now();
  const alive = new Set(listed.map(blob=>blob.pathname));
  for(const pathname of documentCache.keys()) if(pathname.startsWith(prefix) && !alive.has(pathname)) documentCache.delete(pathname);
  const rows = await mapLimit(listed,concurrency,async blob=>{
    const cached = documentCache.get(blob.pathname);
    if(cached && cached.version === blob.version && now - cached.storedAt < (blob.hasEtag ? ETAG_CACHE_TTL_MS : META_CACHE_TTL_MS)) return cached.value as T;
    try {
      const stored = await readJson(blob.pathname,parse);
      if(!stored) {documentCache.delete(blob.pathname);return null;}
      remember(blob.pathname,blob.version,stored.value);
      return stored.value;
    } catch(error) {
      // One damaged document must not take the whole panel or public feed down.
      if(error instanceof CorruptDocumentError) {console.error(`[storage] skipped corrupt document ${blob.pathname}`);return null;}
      throw error;
    }
  });
  return rows.filter((row):row is Awaited<T> & T=>row !== null);
}

export const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
