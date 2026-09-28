import { blobPaths, deleteJson, isRecord, overwriteJson, readJson } from "@/lib/blob-store";
import { open, seal, type SealedBox } from "@/lib/crypto-box";

/*
 * GitHub token for SEO optimization pull requests. Precedence: GITHUB_TOKEN env,
 * then a token saved once from Settings (encrypted in the private Blob store, never returned).
 * Needed permissions (fine-grained token): Contents read/write + Pull requests read/write on the client repos.
 */
export type GithubCredentials = { token: string; source: "env" | "panel"; login: string | null };
type Stored = SealedBox & { login: string; savedAt: string };
const parse = (value: unknown): Stored | null => isRecord(value) && value.v === 1 && typeof value.data === "string" ? value as unknown as Stored : null;

export async function getGithubCredentials(): Promise<GithubCredentials | null> {
  if (process.env.GITHUB_TOKEN?.trim()) return { token: process.env.GITHUB_TOKEN.trim(), source: "env", login: null };
  let stored: Stored | null = null;
  try { stored = (await readJson(blobPaths.githubCredentials, parse))?.value ?? null; } catch { return null; }
  if (!stored) return null;
  const token = open(stored, "github-token");
  return token ? { token, source: "panel", login: stored.login } : null;
}

export async function saveGithubCredentials(token: string, login: string) {
  await overwriteJson(blobPaths.githubCredentials, { ...seal(token, "github-token"), login, savedAt: new Date().toISOString() }, { cacheControlMaxAge: 0 });
}
export async function clearGithubCredentials() { await deleteJson(blobPaths.githubCredentials); }
