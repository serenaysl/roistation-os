import { open, seal } from "@/lib/crypto-box";
import { blobPaths, deleteJson, isRecord, overwriteJson, readJson } from "@/lib/blob-store";

/*
 * Vercel account connection. Precedence:
 *   1. VERCEL_TOKEN (+ optional VERCEL_TEAM_ID) server environment variables.
 *   2. A token saved once from the panel, stored encrypted (AES-256-GCM) in the private Blob store.
 *      The key is derived from PANEL_SESSION_SECRET (lib/crypto-box.ts, purpose "vercel-token");
 *      the token never leaves the server and is never returned.
 */

export type VercelCredentials = { token: string; teamId: string | null; source: "env" | "panel" };
type StoredCredentials = { v: 1; iv: string; tag: string; data: string; teamId: string | null; savedAt: string; account?: string };

const PURPOSE = "vercel-token";
const sealingAvailable = () => (process.env.PANEL_SESSION_SECRET || "").length >= 32;

const parseStored = (value: unknown): StoredCredentials | null =>
  isRecord(value) && value.v === 1 && typeof value.iv === "string" && typeof value.tag === "string" && typeof value.data === "string" ? value as unknown as StoredCredentials : null;

export const validTeamId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9_-]{3,80}$/.test(value);

export async function getVercelCredentials(): Promise<VercelCredentials | null> {
  const envToken = process.env.VERCEL_TOKEN?.trim();
  if (envToken) return { token: envToken, teamId: validTeamId(process.env.VERCEL_TEAM_ID) ? process.env.VERCEL_TEAM_ID : null, source: "env" };
  if (!sealingAvailable()) return null;
  let stored: StoredCredentials | null = null;
  try { stored = (await readJson(blobPaths.vercelCredentials, parseStored))?.value ?? null; } catch { return null; }
  if (!stored) return null;
  const token = open(stored, PURPOSE);
  // null: PANEL_SESSION_SECRET changed, the saved token can no longer be read; reconnect from the panel.
  return token === null ? null : { token, teamId: validTeamId(stored.teamId) ? stored.teamId : null, source: "panel" };
}

export async function storedAccountLabel() {
  try { return (await readJson(blobPaths.vercelCredentials, parseStored))?.value?.account ?? null; } catch { return null; }
}

export async function saveVercelCredentials(token: string, teamId: string | null, account: string) {
  const stored: StoredCredentials = { ...seal(token, PURPOSE), teamId, savedAt: new Date().toISOString(), account };
  await overwriteJson(blobPaths.vercelCredentials, stored, { cacheControlMaxAge: 0 });
}

export async function clearVercelCredentials() {
  await deleteJson(blobPaths.vercelCredentials);
}
