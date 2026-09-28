/*
 * Example: the read-mostly Vercel REST client used for project discovery, domain and
 * deployment status, and environment-variable metadata.
 *
 * Demonstrates:
 *   - one `call()` wrapper that maps HTTP failures to typed errors (auth / not-found /
 *     rate-limited / unavailable) with an 8 s timeout on every request,
 *   - cursor pagination over /v10/projects (bounded to 20 pages),
 *   - env var METADATA only: names and targets are kept, values are never requested or stored,
 *   - the single write path (POST /v10/projects/{id}/env?upsert=true) used when the connector
 *     kit is installed by an optimization pull request.
 *
 * Source: lib/vercel/api.ts, lib/vercel/credentials.ts (VercelCredentials type)
 *
 * Differences from production: `fetch` is injectable through `setFetch()` so `demo()` runs
 * without network access; credentials are passed in directly instead of being read from
 * VERCEL_TOKEN or the AES-256-GCM sealed record in the private Blob store.
 */

export type VercelCredentials = { token: string; teamId: string | null; source: "env" | "panel" };

export const VERCEL_API = (process.env.VERCEL_API_URL || "https://api.vercel.com").replace(/\/+$/, "");
const TIMEOUT_MS = 8000;

type FetchLike = (input: URL | string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);
/** Example-only seam: replaces the global fetch (production calls `fetch` directly). */
export const setFetch = (fn: FetchLike) => { fetchImpl = fn; };

export class VercelApiError extends Error {
  constructor(message: string, public kind: "auth" | "not-found" | "rate-limited" | "unavailable", public status?: number) { super(message); }
}

async function call<T>(credentials: VercelCredentials, path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(`${VERCEL_API}${path}`);
  for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  if (credentials.teamId) url.searchParams.set("teamId", credentials.teamId);
  let response: Response;
  try {
    response = await fetchImpl(url, { headers: { authorization: `Bearer ${credentials.token}`, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
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
  const response = await fetchImpl(url, { method: "POST", headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" }, body: JSON.stringify(envs), cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 401 || response.status === 403) throw new VercelApiError("Vercel anahtarının ortam değişkeni yazma yetkisi yok.", "auth", response.status);
  if (!response.ok) throw new VercelApiError(`Vercel ortam değişkenleri yazılamadı (HTTP ${response.status}).`, "unavailable", response.status);
}

/* ------------------------------------------------------------------ demo */

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Offline run against a stubbed Vercel API (fictional demo project, placeholder token). */
export async function demo() {
  const credentials: VercelCredentials = { token: "demo-token", teamId: null, source: "env" };
  const requests: string[] = [];
  setFetch(async (input) => {
    const url = new URL(String(input));
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname === "/v10/projects" && !url.searchParams.get("from")) return json({ projects: [{ id: "prj_demo_zeytinlik", name: "zeytinlik-restoran", framework: "nextjs" }], pagination: { next: 1700000000000 } });
    if (url.pathname === "/v10/projects") return json({ projects: [{ id: "prj_demo_kiyi", name: "kiyi-dis-klinigi", framework: "nextjs" }], pagination: { next: null } });
    if (url.pathname.endsWith("/env")) return json({ envs: [{ key: "ROISTATION_SITE_ID", target: ["production", "preview"], type: "plain", value: "never-kept" }, { key: "ROISTATION_DISABLED", target: "production" }] });
    if (url.pathname === "/v6/deployments") return json({ deployments: [{ uid: "dpl_demo_1", url: "zeytinlik-restoran-demo.vercel.app", readyState: "ready", created: 1767225600000, target: "production" }] });
    return json({ error: { message: "forbidden" } }, 403);
  });

  const projects = await listProjects(credentials);
  const envs = await listEnvMetadata(credentials, projects[0].id);
  const [deployment] = await listDeployments(credentials, projects[0].id, 10);
  let authError: string | null = null;
  try { await listDomains(credentials, projects[0].id); } catch (error) { if (error instanceof VercelApiError) authError = `${error.kind} (${error.status})`; }
  return {
    projects: projects.map((project) => project.name),
    envs, // { key, target, type } only: the stubbed "value" field is dropped
    deployment: { state: deploymentState(deployment), time: new Date(deploymentTime(deployment)).toISOString() },
    authError,
    requests,
  };
}

if (/vercel-api\.ts$/.test(process.argv[1] ?? "")) demo().then((result) => console.log(JSON.stringify(result, null, 2)));
