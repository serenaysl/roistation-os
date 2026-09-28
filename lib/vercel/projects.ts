import { blobPaths, createJson, isRecord, readAllJson, readJson, replaceJson } from "@/lib/blob-store";
import { ApiError } from "@/lib/errors";

/*
 * One private Blob object per Vercel project (roistation-master/vercel/projects/<id>.json).
 * Written by the sync (metadata) and by user actions (import / ignore) with
 * compare-and-swap, so neither overwrites the other.
 */

export type DeploymentSummary = { id: string; url: string | null; state: string; createdAt: string | null; readyAt: string | null; target: string | null; branch?: string | null; commit?: string | null };
export type ConnectorInfo = { connected: boolean; siteId: string | null; siteName: string | null; version: string | null; environment: string | null; lastSeen: string | null; capabilities: string[] };
export type HealthChecks = {
  checkedAt: string;
  apiResponding: boolean;
  deploymentReady: boolean | null;
  latestDeploymentSuccessful: boolean | null;
  domainActive: boolean | null;
  sslValid: boolean | null;
  connectorReachable: boolean | null;
  publishEndpoint: boolean | null;
};
export type Compatibility = "connected" | "compatible" | "not-compatible";
export type LiveStatus = "connected" | "deploying" | "updating" | "connector-missing" | "deployment-failed" | "missing-domain" | "domain-offline" | "verification-failed" | "archived" | "not-connected" | "project-missing" | "auth-required" | "disabled";

export type VercelProjectRecord = {
  projectId: string;
  name: string;
  framework: string | null;
  rootDirectory: string | null;
  productionDomain: string | null;
  customDomains: string[];
  productionUrl: string | null;
  previewUrl: string | null;
  repository: { provider: string | null; repo: string | null; branch: string | null } | null;
  envKeys: { key: string; target: string[]; type: string }[];
  envHash: string | null;
  latestProduction: DeploymentSummary | null;
  currentProduction: DeploymentSummary | null;
  latestPreview: DeploymentSummary | null;
  lastSuccessfulDeployAt: string | null;
  lastDeployAt: string | null;
  compatibility: Compatibility;
  connector: ConnectorInfo | null;
  health: HealthChecks | null;
  liveStatus: LiveStatus;
  statusDetail: string;
  siteId: string | null;
  excluded: boolean;
  ignored: boolean;
  pending: boolean;
  archived: boolean;
  archivedAt: string | null;
  firstSeenAt: string;
  lastSyncAt: string;
};

export const parseProjectRecord = (value: unknown, pathname?: string): VercelProjectRecord | null => {
  if (!isRecord(value) || typeof value.projectId !== "string" || typeof value.name !== "string" || typeof value.liveStatus !== "string") return null;
  if (pathname && !pathname.endsWith(`/${value.projectId}.json`)) return null;
  return value as unknown as VercelProjectRecord;
};
export const validProjectId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{3,80}$/.test(value);

export async function listProjectRecords() {
  return readAllJson(blobPaths.vercelProjects, parseProjectRecord);
}
export async function getProjectRecord(projectId: string) {
  if (!validProjectId(projectId)) return null;
  return (await readJson(blobPaths.vercelProject(projectId), parseProjectRecord))?.value ?? null;
}
export async function projectForSite(siteId: string, projectName?: string) {
  const records = await listProjectRecords();
  return records.find((record) => record.siteId === siteId) || (projectName ? records.find((record) => record.name === projectName) : undefined) || null;
}

/** Creates or updates one project record with compare-and-swap; `mutate` gets the current value (or null). */
export async function upsertProjectRecord(projectId: string, mutate: (current: VercelProjectRecord | null) => VercelProjectRecord) {
  if (!validProjectId(projectId)) throw new ApiError("Vercel proje kimliği geçersiz.");
  const pathname = blobPaths.vercelProject(projectId);
  for (let attempt = 0; attempt < 4; attempt++) {
    const current = await readJson(pathname, parseProjectRecord);
    const next = mutate(current?.value ?? null);
    if (!current) { if (await createJson(pathname, next) === "created") return next; continue; }
    if (await replaceJson(pathname, next, current.etag) === "replaced") return next;
  }
  throw new ApiError("Proje kaydı aynı anda değişti; birazdan otomatik tekrar denenecek.", 409);
}

/**
 * Live status from Vercel, strongest problem first:
 * archived > opted out > deploying > failed > missing domain > domain offline > not registered > connected.
 * Vercel ownership + Ready deployment + reachable domain = Connected/Verified. A missing
 * connector does not block publishing; it is reported separately (connector badge).
 */
export function computeLiveStatus(record: Pick<VercelProjectRecord, "archived" | "latestProduction" | "health" | "siteId" | "connector" | "compatibility" | "productionDomain">, connectionVerified: boolean | null): { status: LiveStatus; detail: string } {
  if (record.archived) return { status: "archived", detail: "Proje Vercel hesabında bulunamadı; yayınlar ve geçmiş korunuyor." };
  if (record.compatibility === "not-compatible") return { status: "disabled", detail: "Proje ROISTATION_DISABLED ile ROIstation'ı kapatmış." };
  const state = record.latestProduction?.state || "";
  if (["BUILDING", "QUEUED", "INITIALIZING"].includes(state)) return { status: "deploying", detail: "Production deploy sürüyor." };
  if (state === "ERROR") return { status: "deployment-failed", detail: "Son production deploy başarısız oldu." };
  if (!record.latestProduction) return { status: "missing-domain", detail: "Henüz production deploy yok; ilk deploydan sonra otomatik bağlanır." };
  if (!record.productionDomain) return { status: "missing-domain", detail: "Projenin production domaini yok. Vercel'de domain ekleyince otomatik bağlanır." };
  if (record.health?.domainActive === false) return { status: "domain-offline", detail: record.health.sslValid === false ? "Production domain SSL sertifikası geçersiz." : "Production domain yanıt vermiyor." };
  if (!record.siteId) return { status: "not-connected", detail: "ROIstation'a kaydedilmedi." };
  if (connectionVerified === false) return { status: "verification-failed", detail: "Doğrulama tamamlanamadı; bir sonraki kontrolde tekrar denenir." };
  const connector = record.connector?.connected ? "Connector kurulu." : "Connector yok: içerik sitede görünmesi için yayın alanı (kit/widget) gerekir; yayın yine de alınır.";
  return { status: "connected", detail: `Vercel doğrulandı: deploy hazır, domain erişilebilir. ${connector}` };
}
