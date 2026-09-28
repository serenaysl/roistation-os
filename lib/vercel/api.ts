import type { VercelCredentials } from "@/lib/vercel/credentials";

/*
 * Minimal Vercel REST client (https://vercel.com/docs/rest-api).
 * Reads: GET /v2/user, /v2/teams/{id}, /v10/projects, /v9/projects/{id}/domains,
 * /v9/projects/{id}/env (metadata only — values are never requested or kept), /v6/deployments.
 * The only write is upsertEnv, used by the SEO optimizer to set ROISTATION_* variables on a site.
 */

export const VERCEL_API = (process.env.VERCEL_API_URL || "https://api.vercel.com").replace(/\/+$/, "");
const TIMEOUT_MS = 8000;

export class VercelApiError extends Error {
  constructor(message: string, public kind: "auth" | "not-found" | "rate-limited" | "unavailable", public status?: number) { super(message); }
}

async function call<T>(credentials: VercelCredentials, path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(`${VERCEL_API}${path}`);
  for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  if (credentials.teamId) url.searchParams.set("teamId", credentials.teamId);
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${credentials.token}`, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new VercelApiError("Vercel API zamanında yanıt vermedi.", "unavailable");
  }
  if (response.status === 401 || response.status === 403) throw new VercelApiError("Vercel erişim anahtarı geçersiz, süresi dolmuş veya bu ekibe yetkisi yok.", "auth", response.status);
  if (response.status === 404) throw new VercelApiError("Vercel kaydı bulunamadı.", "not-found", 404);
  if (response.status === 429) throw new VercelApiError("Vercel API istek sınırına ulaşıldı; birkaç dakika sonra tekrar denenecek.", "rate-limited", 429);
  if (!response.ok) throw new VercelApiError(`Vercel API hata döndürdü (HTTP ${response.status}).`, "unavailable", response.status);
  try { return await response.json() as T; }
  catch { throw new VercelApiError("Vercel API okunamayan yanıt döndürdü.", "unavailable", response.status); }
}

export type VercelUser = { user?: { id?: string; username?: string; email?: string; name?: string } };
export type VercelTeam = { id?: string; slug?: string; name?: string };
export type VercelProject = {
  id: string; name: string; framework?: string | null; rootDirectory?: string | null; updatedAt?: number; createdAt?: number;
  link?: { type?: string; org?: string; repo?: string; repoOwner?: string; repoSlug?: string; projectName?: string; productionBranch?: string } | null;
  targets?: { production?: { id?: string; url?: string; alias?: string[]; readyState?: string; createdAt?: number } | null } | null;
};
export type VercelDomain = { name: string; verified?: boolean; redirect?: string | null; gitBranch?: string | null };
export type VercelDeployment = { uid: string; url?: string; state?: string; readyState?: string; created?: number; createdAt?: number; ready?: number; target?: string | null; meta?: Record<string, string> };
export type VercelEnvMeta = { key: string; target: string[]; type: string };

export async function getAccount(credentials: VercelCredentials) {
  const user = await call<VercelUser>({ ...credentials, teamId: null }, "/v2/user");
  let team: VercelTeam | null = null;
  if (credentials.teamId) team = await call<VercelTeam>({ ...credentials, teamId: null }, `/v2/teams/${encodeURIComponent(credentials.teamId)}`);
  return { user: user.user?.username || user.user?.email || user.user?.name || "Vercel hesabı", team: team?.name || team?.slug || null };
}

/** Teams the token can access (GET /v2/teams). */
export async function listTeams(credentials: VercelCredentials): Promise<{ id: string; name: string; slug: string | null }[]> {
  const data = await call<{ teams?: { id?: string; name?: string; slug?: string }[] }>({ ...credentials, teamId: null }, "/v2/teams", { limit: 100 });
  return (data.teams || []).filter((team) => typeof team?.id === "string").map((team) => ({ id: team.id!, name: team.name || team.slug || team.id!, slug: team.slug ?? null }));
}

export async function listProjects(credentials: VercelCredentials): Promise<VercelProject[]> {
  const projects: VercelProject[] = [];
  let from: string | number | undefined;
  for (let page = 0; page < 20; page++) {
    const data = await call<{ projects?: VercelProject[]; pagination?: { next?: number | null } }>(credentials, "/v10/projects", { limit: 100, from });
    projects.push(...(data.projects || []).filter((project) => project && typeof project.id === "string" && typeof project.name === "string"));
    const next = data.pagination?.next;
    if (!next || next === from) break;
    from = next;
  }
  return projects;
}

export async function listDomains(credentials: VercelCredentials, projectId: string): Promise<VercelDomain[]> {
  const data = await call<{ domains?: VercelDomain[] }>(credentials, `/v9/projects/${encodeURIComponent(projectId)}/domains`, { limit: 50 });
  return (data.domains || []).filter((domain) => typeof domain?.name === "string");
}

export async function listDeployments(credentials: VercelCredentials, projectId: string, limit = 10): Promise<VercelDeployment[]> {
  const data = await call<{ deployments?: VercelDeployment[] }>(credentials, "/v6/deployments", { projectId, limit });
  return (data.deployments || []).filter((deployment) => typeof deployment?.uid === "string");
}

/** Environment variable NAMES and targets only. Values are stripped even if the API returns them encrypted. */
export async function listEnvMetadata(credentials: VercelCredentials, projectId: string): Promise<VercelEnvMeta[]> {
  const data = await call<{ envs?: { key?: string; target?: string | string[]; type?: string }[] }>(credentials, `/v9/projects/${encodeURIComponent(projectId)}/env`);
  return (data.envs || []).filter((env) => typeof env?.key === "string").map((env) => ({ key: env.key!, target: Array.isArray(env.target) ? env.target : env.target ? [env.target] : [], type: env.type || "encrypted" }));
}

export const deploymentState = (deployment: VercelDeployment | null | undefined) => String(deployment?.state || deployment?.readyState || "").toUpperCase();
export const deploymentTime = (deployment: VercelDeployment | null | undefined) => deployment?.created ?? deployment?.createdAt ?? 0;

/** Creates or updates project environment variables (POST /v10/projects/{id}/env?upsert=true). Values are sent, never read back. */
export async function upsertEnv(credentials: VercelCredentials, projectId: string, envs: { key: string; value: string; type: "plain" | "encrypted" | "sensitive"; target: string[] }[]) {
  const url = new URL(`${VERCEL_API}/v10/projects/${encodeURIComponent(projectId)}/env`);
  url.searchParams.set("upsert", "true");
  if (credentials.teamId) url.searchParams.set("teamId", credentials.teamId);
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" }, body: JSON.stringify(envs), cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 401 || response.status === 403) throw new VercelApiError("Vercel anahtarının ortam değişkeni yazma yetkisi yok.", "auth", response.status);
  if (!response.ok) throw new VercelApiError(`Vercel ortam değişkenleri yazılamadı (HTTP ${response.status}).`, "unavailable", response.status);
}
