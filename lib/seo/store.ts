import { randomBytes } from "node:crypto";
import { blobPaths, createJson, isRecord, listBlobs, mapLimit, readJson, replaceJson } from "@/lib/blob-store";
import { ApiError } from "@/lib/errors";
import type { ScanResult, ScanScores } from "@/lib/seo/scanner";

/*
 * Scan history: every scan is its own create-only object
 *   roistation-master/seo/scans/<site-id>/<inverted-ms>-<rand>.json
 * so history is append-only and lexical order = newest first.
 */

const MAX_TS = 9_999_999_999_999;
const nameFor = (at: string) => `${String(MAX_TS - Date.parse(at)).padStart(13, "0")}-${randomBytes(3).toString("hex")}`;
const timeOf = (pathname: string) => MAX_TS - Number(pathname.slice(pathname.lastIndexOf("/") + 1).split("-")[0]);

const parseScan = (value: unknown): ScanResult | null => isRecord(value) && typeof value.siteId === "string" && isRecord(value.scores) && Array.isArray(value.checks) ? value as unknown as ScanResult : null;
export type ScanSummary = { id: string; scannedAt: string; scores: ScanScores; issues: number; critical: number; deploymentId: string | null; reason: string; durationMs: number };
export const summarizeScan = (scan: ScanResult): ScanSummary => ({ id: scan.id, scannedAt: scan.scannedAt, scores: scan.scores, issues: scan.issues, critical: scan.critical, deploymentId: scan.deploymentId, reason: scan.reason, durationMs: scan.durationMs });

export async function saveScan(scan: ScanResult) {
  await createJson(blobPaths.seoScan(scan.siteId, nameFor(scan.scannedAt)), scan);
  return scan;
}

/** Pathnames of every stored scan grouped by site, newest first. */
export async function scanIndex() {
  const listed = await listBlobs(blobPaths.seoScans);
  const bySite = new Map<string, string[]>();
  for (const { pathname } of listed) {
    const siteId = pathname.slice(blobPaths.seoScans.length).split("/")[0];
    if (!bySite.has(siteId)) bySite.set(siteId, []);
    bySite.get(siteId)!.push(pathname);
  }
  for (const list of bySite.values()) list.sort((a, b) => timeOf(b) - timeOf(a));
  return bySite;
}

export async function readScan(pathname: string) {
  try { return (await readJson(pathname, parseScan))?.value ?? null; } catch { return null; }
}

export async function scanHistory(siteId: string, limit = 12, index?: Map<string, string[]>) {
  const paths = ((index ?? await scanIndex()).get(siteId) || []).slice(0, limit);
  return (await mapLimit(paths, 6, readScan)).filter((scan): scan is ScanResult => Boolean(scan));
}

/* ------------------------------------------------------------ optimizations */

export type OptimizationRecord = {
  siteId: string; createdAt: string; scanId: string; status: "open" | "merged" | "closed" | "failed";
  repo: string; baseBranch: string; branch: string; prNumber: number | null; prUrl: string | null;
  applied: { checkId: string; path: string; action: "create" | "update"; description: string }[];
  manual: { checkId: string; description: string }[];
  env: { key: string; ok: boolean; detail?: string }[];
  updatedAt: string; mergedAt?: string | null; error?: string;
};
const parseOptimization = (value: unknown): OptimizationRecord | null => isRecord(value) && typeof value.siteId === "string" && typeof value.status === "string" ? value as unknown as OptimizationRecord : null;

export async function saveOptimization(record: OptimizationRecord) {
  const pathname = blobPaths.seoOptimization(record.siteId, nameFor(record.createdAt));
  await createJson(pathname, record);
  return pathname;
}

export async function latestOptimizations() {
  const listed = await listBlobs(blobPaths.seoOptimizations);
  const latest = new Map<string, string>();
  for (const { pathname } of listed.sort((a, b) => timeOf(b.pathname) - timeOf(a.pathname))) {
    const siteId = pathname.slice(blobPaths.seoOptimizations.length).split("/")[0];
    if (!latest.has(siteId)) latest.set(siteId, pathname);
  }
  const entries = await mapLimit([...latest.entries()], 6, async ([siteId, pathname]) => {
    const stored = await readJson(pathname, parseOptimization).catch(() => null);
    return stored ? { siteId, pathname, record: stored.value, etag: stored.etag } : null;
  });
  return entries.filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));
}

export async function updateOptimization(pathname: string, etag: string | null, next: OptimizationRecord) {
  return replaceJson(pathname, next, etag);
}

/* ----------------------------------------------------------------- ignored */

/** Findings the user chose to ignore for a site (one small document per site, compare-and-swap). */
const parseIgnored = (value: unknown): { checkIds: string[]; updatedAt: string } | null => isRecord(value) && Array.isArray(value.checkIds) ? { checkIds: value.checkIds.filter((id): id is string => typeof id === "string"), updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "" } : null;
export async function ignoredChecks(siteId: string) {
  try { return (await readJson(blobPaths.seoIgnored(siteId), parseIgnored))?.value.checkIds ?? []; } catch { return []; }
}
export async function setIgnored(siteId: string, checkId: string, ignored: boolean) {
  const pathname = blobPaths.seoIgnored(siteId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readJson(pathname, parseIgnored);
    const ids = new Set(current?.value.checkIds ?? []);
    if (ignored) ids.add(checkId); else ids.delete(checkId);
    const next = { checkIds: [...ids], updatedAt: new Date().toISOString() };
    if (!current) { if (await createJson(pathname, next) === "created") return next.checkIds; continue; }
    if (await replaceJson(pathname, next, current.etag) === "replaced") return next.checkIds;
  }
  throw new ApiError("Ayar aynı anda değişti; tekrar dene.", 409);
}
