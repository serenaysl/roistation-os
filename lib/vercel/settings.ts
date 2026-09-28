import { blobPaths, isRecord, readJson, replaceJson, createJson } from "@/lib/blob-store";
import { ApiError } from "@/lib/errors";

/** "disabled" never imports automatically; "ask" shows a notification; "auto" imports every compatible project. */
export type AutoConnectMode = "disabled" | "ask" | "auto";
export type VercelSettings = { autoConnect: AutoConnectMode; ignoredProjects: string[]; updatedAt: string };

// Default: every project of the connected account is registered automatically.
export const defaultVercelSettings: VercelSettings = { autoConnect: "auto", ignoredProjects: [], updatedAt: new Date(0).toISOString() };
export const isAutoConnectMode = (value: unknown): value is AutoConnectMode => value === "disabled" || value === "ask" || value === "auto";

const parseSettings = (value: unknown): VercelSettings | null => {
  if (!isRecord(value) || !isAutoConnectMode(value.autoConnect)) return null;
  return { autoConnect: value.autoConnect, ignoredProjects: Array.isArray(value.ignoredProjects) ? value.ignoredProjects.filter((id): id is string => typeof id === "string").slice(0, 500) : [], updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString() };
};

export async function getVercelSettings(): Promise<VercelSettings> {
  try { return (await readJson(blobPaths.vercelSettings, parseSettings))?.value ?? { ...defaultVercelSettings }; }
  catch { return { ...defaultVercelSettings }; }
}

/** Compare-and-swap update of the single settings document. */
export async function updateVercelSettings(mutate: (settings: VercelSettings) => VercelSettings) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readJson(blobPaths.vercelSettings, parseSettings);
    const next = { ...mutate(current?.value ?? { ...defaultVercelSettings }), updatedAt: new Date().toISOString() };
    if (!current) { if (await createJson(blobPaths.vercelSettings, next) === "created") return next; continue; }
    if (await replaceJson(blobPaths.vercelSettings, next, current.etag) === "replaced") return next;
  }
  throw new ApiError("Ayar aynı anda değişti; tekrar dene.", 409);
}
