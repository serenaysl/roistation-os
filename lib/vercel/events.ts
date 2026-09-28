import { randomBytes } from "node:crypto";
import { blobPaths, createJson, deleteJson, isRecord, listBlobs, mapLimit, readJson } from "@/lib/blob-store";

/*
 * Per-project activity log. Every event is its own create-only object, so logging
 * never rewrites shared state and can never conflict:
 *   roistation-master/vercel/events/<project-or-site-key>/<inverted-ms>-<rand>.json
 * The inverted timestamp makes lexical order = newest first.
 */

export type ProjectEventType =
  | "project-detected" | "project-renamed" | "project-imported" | "project-connected" | "project-ignored" | "project-archived" | "project-restored"
  | "connector-installed" | "connector-updated" | "connector-removed"
  | "deployment-started" | "deployment-completed" | "deployment-failed"
  | "verification-passed" | "verification-failed"
  | "domain-changed" | "framework-changed" | "environment-updated"
  | "publication-sent" | "publication-withdrawn" | "publication-deleted" | "form-synchronized"
  | "seo-scan-completed" | "seo-optimization-opened";

export type ProjectEvent = { key: string; type: ProjectEventType; at: string; message: string; siteId?: string; projectId?: string };

const MAX_TS = 9_999_999_999_999;
const keyPattern = /^[A-Za-z0-9_-]{2,80}$/;
export const eventKeyForSite = (siteId: string, projectId?: string | null) => projectId && keyPattern.test(projectId) ? projectId : `site-${siteId}`;

export const eventLabels: Record<ProjectEventType, string> = {
  "project-detected": "Proje algılandı", "project-renamed": "Proje adı değişti", "project-imported": "Proje içe aktarıldı", "project-connected": "Proje bağlandı",
  "project-ignored": "Proje yok sayıldı", "project-archived": "Proje arşivlendi", "project-restored": "Proje geri yüklendi",
  "connector-installed": "Connector kuruldu", "connector-updated": "Connector güncellendi", "connector-removed": "Connector kaldırıldı",
  "deployment-started": "Deploy başladı", "deployment-completed": "Deploy tamamlandı", "deployment-failed": "Deploy başarısız",
  "verification-passed": "Doğrulama başarılı", "verification-failed": "Doğrulama başarısız",
  "domain-changed": "Domain değişti", "framework-changed": "Framework değişti", "environment-updated": "Ortam değişkenleri güncellendi",
  "publication-sent": "Yayın gönderildi", "publication-withdrawn": "Yayın kaldırıldı", "publication-deleted": "Yayın silindi", "form-synchronized": "Form senkronize edildi",
  "seo-scan-completed": "SEO/GEO taraması tamamlandı", "seo-optimization-opened": "SEO/GEO optimizasyon PR'ı açıldı",
};

export async function logEvent(event: Omit<ProjectEvent, "at"> & { at?: string }) {
  if (!keyPattern.test(event.key)) return;
  const at = event.at || new Date().toISOString();
  const name = `${String(MAX_TS - Date.parse(at)).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
  try { await createJson(blobPaths.vercelEvent(event.key, name), { ...event, at, message: event.message.slice(0, 400) }); }
  catch (error) { console.error("[events] activity log write skipped", error); }
}

/** Logs several events in parallel; never throws. */
export async function logEvents(events: (Omit<ProjectEvent, "at"> & { at?: string })[]) {
  await Promise.allSettled(events.map((event) => logEvent(event)));
}

const parseEvent = (value: unknown): ProjectEvent | null => isRecord(value) && typeof value.key === "string" && typeof value.type === "string" && typeof value.at === "string" && typeof value.message === "string" ? value as unknown as ProjectEvent : null;
const timeOf = (pathname: string) => MAX_TS - Number(pathname.slice(pathname.lastIndexOf("/") + 1).split("-")[0]);

/** Newest events, globally or for one project/site key. Only the newest `limit` objects are read. */
export async function recentEvents(limit = 40, key?: string): Promise<ProjectEvent[]> {
  const prefix = key ? `${blobPaths.vercelEvents}${key}/` : blobPaths.vercelEvents;
  const listed = (await listBlobs(prefix)).map((blob) => blob.pathname).sort((a, b) => timeOf(b) - timeOf(a)).slice(0, limit);
  const rows = await mapLimit(listed, 12, async (pathname) => {
    try { return (await readJson(pathname, parseEvent))?.value ?? null; } catch { return null; }
  });
  return rows.filter((row): row is ProjectEvent => Boolean(row));
}

/** Keeps each project's log bounded (oldest removed first). */
export async function pruneEvents(key: string, keep = 300) {
  if (!keyPattern.test(key)) return;
  const listed = (await listBlobs(`${blobPaths.vercelEvents}${key}/`)).map((blob) => blob.pathname).sort((a, b) => timeOf(b) - timeOf(a));
  await mapLimit(listed.slice(keep), 8, (pathname) => deleteJson(pathname).catch(() => undefined));
}
