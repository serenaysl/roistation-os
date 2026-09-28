// Client-safe status vocabulary for site connections and Vercel projects.
export type StatusTone = "ok" | "busy" | "warn" | "bad" | "idle";
export type StatusMeta = { label: string; tone: StatusTone };

export const connectionStatusMeta: Record<string, StatusMeta> = {
  connected: { label: "Bağlı · Doğrulandı", tone: "ok" },
  "missing-domain": { label: "Domain yok", tone: "warn" },
  "connected-widget": { label: "Bağlı (widget)", tone: "ok" },
  deploying: { label: "Deploy sürüyor", tone: "busy" },
  "not-connected": { label: "Bağlı değil", tone: "idle" },
  "not-verified": { label: "Doğrulanmadı", tone: "warn" },
  "deployment-failed": { label: "Başarısız", tone: "bad" },
  "domain-offline": { label: "Domain çevrimdışı", tone: "bad" },
  "project-missing": { label: "Proje bulunamadı", tone: "idle" },
};

/** Whether the site renders ROIstation content. Shown next to the main status; never blocks publishing for Vercel projects. */
export function connectorMeta(state: string | null | undefined): StatusMeta | null {
  if (state === "installed") return { label: "Connector kurulu", tone: "ok" };
  if (state === "widget") return { label: "Widget kurulu", tone: "ok" };
  if (state === "missing") return { label: "Connector yok", tone: "warn" };
  return null;
}

export const liveStatusMeta: Record<string, StatusMeta> = {
  connected: { label: "Bağlı · Doğrulandı", tone: "ok" },
  "missing-domain": { label: "Domain yok", tone: "warn" },
  disabled: { label: "ROIstation kapalı", tone: "idle" },
  deploying: { label: "Deploy ediliyor", tone: "busy" },
  updating: { label: "Güncelleniyor", tone: "busy" },
  "connector-missing": { label: "Connector yok", tone: "warn" },
  "deployment-failed": { label: "Başarısız", tone: "bad" },
  "domain-offline": { label: "Domain çevrimdışı", tone: "bad" },
  "verification-failed": { label: "Doğrulama başarısız", tone: "bad" },
  "auth-required": { label: "Vercel yetkisi gerekli", tone: "bad" },
  archived: { label: "Arşivlendi", tone: "idle" },
  "project-missing": { label: "Proje bulunamadı", tone: "idle" },
  "not-connected": { label: "Bağlı değil", tone: "idle" },
};

/** Legacy connection rows (before statuses existed) map to connected / not verified. */
export function connectionMeta(connection: { status?: string; verified: boolean } | null | undefined): StatusMeta {
  if (!connection) return { label: "Kontrol edilmedi", tone: "idle" };
  return connectionStatusMeta[connection.status || (connection.verified ? "connected-widget" : "not-verified")] || { label: connection.verified ? "Bağlı" : "Doğrulanmadı", tone: connection.verified ? "ok" : "warn" };
}

export function formatDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toLocaleString("tr-TR", { dateStyle: "short", timeStyle: "short" }) : "—";
}

export function relativeTime(value: string | null | undefined, now = Date.now()) {
  if (!value) return "—";
  const diff = now - Date.parse(value);
  if (!Number.isFinite(diff)) return "—";
  const minutes = Math.round(diff / 60000);
  if (minutes < 1) return "az önce";
  if (minutes < 60) return `${minutes} dk önce`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} sa önce`;
  return `${Math.round(hours / 24)} gün önce`;
}
