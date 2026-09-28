import { ApiError } from "@/lib/errors";
import { blobPaths, createJson, isRecord, listBlobs, mapLimit, readJson, requireStorage, CorruptDocumentError } from "@/lib/blob-store";
import { anyRecord, parseConnection, parseFingerprintPointer, parseGeneration, parsePublicationRow, parseRateBucket, parseSubmission, type GenerationRecord } from "@/lib/records";
import { rateLimitDigest } from "@/lib/rate-limit-storage";

/*
 * One-time, idempotent migration from the legacy shared snapshot
 * (roistation-master/v1/state.json) and the interim v1/* per-object files into
 * the per-record layout. Every copy is create-only, so it can never overwrite
 * data written in the new layout, and concurrent instances can run it safely.
 * The marker is written last; once it exists, legacy objects are never read again.
 * state.json itself is left untouched as a backup.
 */

const MIGRATION_BUDGET_MS = 25000;
const COPY_CONCURRENCY = 12;

type Copy = { pathname: string; value: unknown };
type LegacyState = {
  publications: Record<string, unknown>;
  connections: Record<string, unknown>;
  submissions: Record<string, unknown>;
  rates: Record<string, unknown>;
  generations: Record<string, unknown>;
};

let migrated = false;
let running: Promise<void> | null = null;

/** Resolves once the new layout is authoritative. Costs one GET per cold instance after migration. */
export async function ensureMigrated() {
  if(migrated) return;
  requireStorage();
  if(!running) running = runMigration().then(()=>{migrated = true;}).finally(()=>{running = null;});
  await running;
}

function parseLegacyState(value: unknown): LegacyState | null {
  if(!isRecord(value) || value.schema !== 1) return null;
  const section = (key: string) => isRecord(value[key]) ? value[key] as Record<string, unknown> : {};
  return {publications:section("publications"),connections:section("connections"),submissions:section("submissions"),rates:section("rates"),generations:section("generations")};
}

const generationRank: Record<GenerationRecord["status"], number> = {complete:3,failed:2,pending:1};
function betterGeneration(current: GenerationRecord | undefined, candidate: GenerationRecord) {
  if(!current) return candidate;
  const rankDiff = generationRank[candidate.status] - generationRank[current.status];
  if(rankDiff !== 0) return rankDiff > 0 ? candidate : current;
  return candidate.updatedAt > current.updatedAt ? candidate : current;
}

async function readLegacyFile<T>(pathname: string, parse: (value: unknown, pathname?: string) => T | null): Promise<T | null> {
  try {return (await readJson(pathname,(value)=>parse(value)))?.value ?? null;}
  catch(error) {
    if(error instanceof CorruptDocumentError) {console.error(`[migration] skipped unreadable legacy object ${pathname}`);return null;}
    throw error;
  }
}

async function runMigration() {
  const marker = await readJson(blobPaths.migrationMarker,anyRecord);
  if(marker) return;

  const started = Date.now();
  let legacyState: LegacyState | null = null;
  try {legacyState = (await readJson(blobPaths.legacyState,parseLegacyState))?.value ?? null;}
  catch(error) {
    if(error instanceof CorruptDocumentError) throw new ApiError("Eski state.json kaydı okunamadı; yeni depolama yapısına taşıma durduruldu. Dosyayı Vercel Blob panelinden yedekleyip kontrol et.",503);
    throw error;
  }
  const legacyFiles = await listBlobs(`${blobPaths.legacyState.slice(0,blobPaths.legacyState.lastIndexOf("/")+1)}`);
  const legacyPaths = legacyFiles.map(blob=>blob.pathname).filter(pathname=>pathname !== blobPaths.legacyState);

  const copies = new Map<string, unknown>();
  const queue = (pathname: string, value: unknown) => {if(!copies.has(pathname)) copies.set(pathname,value);};

  // Connections: interim per-site files are newer than the snapshot copy, so they win.
  const connectionFiles = legacyPaths.filter(pathname=>pathname.startsWith(blobPaths.legacyConnections));
  for(const connection of await mapLimit(connectionFiles,COPY_CONCURRENCY,pathname=>readLegacyFile(pathname,parseConnection))) {
    if(connection) queue(blobPaths.connection(connection.site_id),connection);
  }
  for(const value of Object.values(legacyState?.connections ?? {})) {
    const connection = parseConnection(value);if(connection) queue(blobPaths.connection(connection.site_id),connection);
  }

  for(const value of Object.values(legacyState?.publications ?? {})) {
    const row = parsePublicationRow(value);if(row) queue(blobPaths.publication(row.id),row);
  }
  for(const value of Object.values(legacyState?.submissions ?? {})) {
    const row = parseSubmission(value);if(row) queue(blobPaths.submission(row.id),row);
  }

  // Generations: interim layout stored one object per status; keep the most final one.
  const generations = new Map<string, GenerationRecord>();
  const pointers = new Map<string, { id: string; fingerprint: string; updatedAt: string }>();
  const generationFiles = legacyPaths.filter(pathname=>pathname.startsWith(blobPaths.legacyGenerations));
  const fingerprintFiles = generationFiles.filter(pathname=>pathname.startsWith(`${blobPaths.legacyGenerations}by-fingerprint/`));
  const statusFiles = generationFiles.filter(pathname=>!pathname.startsWith(`${blobPaths.legacyGenerations}by-fingerprint/`));
  for(const row of await mapLimit(statusFiles,COPY_CONCURRENCY,pathname=>readLegacyFile(pathname,parseGeneration))) {
    if(row) generations.set(row.id,betterGeneration(generations.get(row.id),row));
  }
  for(const value of Object.values(legacyState?.generations ?? {})) {
    const row = parseGeneration(value);if(row) generations.set(row.id,betterGeneration(generations.get(row.id),row));
  }
  for(const row of generations.values()) {
    queue(blobPaths.generation(row.id),row);
    if(row.status === "complete") pointers.set(row.fingerprint,{id:row.id,fingerprint:row.fingerprint,updatedAt:row.updatedAt});
  }
  for(const pointer of await mapLimit(fingerprintFiles,COPY_CONCURRENCY,pathname=>readLegacyFile(pathname,parseFingerprintPointer))) {
    if(pointer && generations.get(pointer.id)?.status === "complete" && !pointers.has(pointer.fingerprint)) pointers.set(pointer.fingerprint,pointer);
  }
  for(const pointer of pointers.values()) queue(blobPaths.generationFingerprint(pointer.fingerprint),pointer);

  // Rate counters: only still-active windows are worth carrying over.
  const now = Date.now();
  for(const [key,value] of Object.entries(legacyState?.rates ?? {})) {
    const bucket = parseRateBucket(value);if(bucket && bucket.expiresAt > now) queue(blobPaths.rateLimit(rateLimitDigest(key)),bucket);
  }
  const rateFiles = legacyPaths.filter(pathname=>pathname.startsWith(blobPaths.legacyRates));
  const rateBuckets = await mapLimit(rateFiles,COPY_CONCURRENCY,pathname=>readLegacyFile(pathname,parseRateBucket));
  rateFiles.forEach((pathname,index)=>{
    const bucket = rateBuckets[index];
    if(bucket && bucket.expiresAt > now) queue(blobPaths.rateLimit(pathname.slice(blobPaths.legacyRates.length).replace(/\.json$/,"")),bucket);
  });

  // Resumable: skip objects an earlier (possibly interrupted) run already copied.
  const prefixes = [blobPaths.connections,blobPaths.publications,blobPaths.submissions,blobPaths.generations,blobPaths.generationFingerprints,blobPaths.rateLimits];
  const existing = new Set((await Promise.all(prefixes.map(prefix=>listBlobs(prefix)))).flat().map(blob=>blob.pathname));
  const pending: Copy[] = [...copies.entries()].filter(([pathname])=>!existing.has(pathname)).map(([pathname,value])=>({pathname,value}));

  let copied = 0;
  await mapLimit(pending,COPY_CONCURRENCY,async copy=>{
    if(Date.now() - started > MIGRATION_BUDGET_MS) return;
    await createJson(copy.pathname,copy.value);copied++;
  });
  if(copied < pending.length) {
    console.warn(`[migration] copied ${copied}/${pending.length} legacy records; continuing on the next request`);
    throw new ApiError("Eski kayıtlar yeni depolama yapısına taşınıyor. Birkaç saniye sonra sayfayı yenile; veri kaybı yok.",503);
  }

  const counts = {
    publications:[...copies.keys()].filter(pathname=>pathname.startsWith(blobPaths.publications)).length,
    submissions:[...copies.keys()].filter(pathname=>pathname.startsWith(blobPaths.submissions)).length,
    connections:[...copies.keys()].filter(pathname=>pathname.startsWith(blobPaths.connections)).length,
    generations:generations.size,
    fingerprints:pointers.size,
    rateLimits:[...copies.keys()].filter(pathname=>pathname.startsWith(blobPaths.rateLimits)).length,
  };
  await createJson(blobPaths.migrationMarker,{schema:1,migratedAt:new Date().toISOString(),source:legacyState ? "state.json" : legacyPaths.length ? "v1-objects" : "none",counts});
  if(legacyState || legacyPaths.length) console.info(`[migration] legacy storage migrated to per-record layout ${JSON.stringify(counts)}`);
}
