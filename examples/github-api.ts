/*
 * Example: the minimal GitHub REST client behind SEO & GEO optimization pull requests.
 *
 * Demonstrates:
 *   - one `gh()` wrapper with GitHub's recommended headers, a 15 s timeout and plain-language
 *     errors for 401 / 403 / 404,
 *   - repo-name validation before any path is built: exactly `owner/name`, each part [\w.-] only
 *     and never `.` / `..` (the `segment()` helper), so no path traversal into other API routes,
 *   - `openPullRequest()`: every file change lands in ONE commit on a new branch via the Git
 *     Data API (blobs -> tree on top of the base tree -> commit -> ref), then one PR.
 *     No working copy, no force pushes, nothing written to the default branch.
 *
 * Source: lib/github/api.ts, lib/github/credentials.ts (GithubCredentials type)
 *
 * Differences from production: `fetch` is injectable through `setFetch()` so `demo()` records
 * the request sequence offline; credentials are passed in directly instead of GITHUB_TOKEN or
 * the sealed token in the private Blob store.
 */

export type GithubCredentials = { token: string; source: "env" | "panel"; login: string | null };

const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
export class GithubError extends Error { constructor(message: string, public status: number) { super(message); } }

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
let fetchImpl: FetchLike = (input, init) => fetch(input, init);
/** Example-only seam: replaces the global fetch (production calls `fetch` directly). */
export const setFetch = (fn: FetchLike) => { fetchImpl = fn; };

async function gh<T>(credentials: GithubCredentials, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method: init.method || "GET",
      headers: { authorization: `Bearer ${credentials.token}`, accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "ROIstation-Master-Panel", ...(init.body ? { "content-type": "application/json" } : {}) },
      body: init.body ? JSON.stringify(init.body) : undefined, cache: "no-store", signal: AbortSignal.timeout(15000),
    });
  } catch { throw new GithubError("GitHub API zamanında yanıt vermedi.", 504); }
  if (response.status === 401) throw new GithubError("GitHub anahtarı geçersiz veya süresi dolmuş.", 401);
  if (response.status === 403) throw new GithubError("GitHub anahtarının bu işlem için yetkisi yok (Contents ve Pull requests yazma izni gerekli) veya istek sınırı aşıldı.", 403);
  if (response.status === 404) throw new GithubError("GitHub reposu/dalı bulunamadı veya anahtarın bu repoya erişimi yok.", 404);
  if (!response.ok) { const text = await response.text().catch(() => ""); throw new GithubError(`GitHub API hata döndürdü (HTTP ${response.status}) ${text.slice(0, 200)}`, response.status); }
  return response.json() as Promise<T>;
}

const segment = (value: string | undefined): value is string => Boolean(value) && /^[\w.-]+$/.test(value!) && !/^\.+$/.test(value!);
const repoPath = (repo: string) => { const [owner, name, extra] = repo.split("/"); if (extra !== undefined || !segment(owner) || !segment(name)) throw new GithubError("Repo adı geçersiz.", 400); return `/repos/${owner}/${name}`; };

export const getUser = (c: GithubCredentials) => gh<{ login: string }>(c, "/user");
export const getRepo = (c: GithubCredentials, repo: string) => gh<{ default_branch: string; permissions?: { push?: boolean }; private: boolean; html_url: string }>(c, repoPath(repo));
export const getBranchHead = async (c: GithubCredentials, repo: string, branch: string) => (await gh<{ object: { sha: string } }>(c, `${repoPath(repo)}/git/ref/heads/${encodeURIComponent(branch)}`)).object.sha;
export const getCommitTree = async (c: GithubCredentials, repo: string, sha: string) => (await gh<{ tree: { sha: string } }>(c, `${repoPath(repo)}/git/commits/${sha}`)).tree.sha;
export async function listTree(c: GithubCredentials, repo: string, treeSha: string) {
  const data = await gh<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(c, `${repoPath(repo)}/git/trees/${treeSha}?recursive=1`);
  return { paths: new Set(data.tree.filter((item) => item.type === "blob").map((item) => item.path)), truncated: data.truncated };
}
export async function readFile(c: GithubCredentials, repo: string, path: string, ref: string) {
  const data = await gh<{ content?: string; encoding?: string; size?: number }>(c, `${repoPath(repo)}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${encodeURIComponent(ref)}`);
  if (!data.content || data.encoding !== "base64") return null;
  return Buffer.from(data.content, "base64").toString("utf8");
}

/** One commit on a new branch with all file changes, then a pull request. */
export async function openPullRequest(c: GithubCredentials, input: { repo: string; base: string; branch: string; baseSha: string; files: { path: string; content: string }[]; message: string; title: string; body: string }) {
  const rp = repoPath(input.repo);
  const baseTree = await getCommitTree(c, input.repo, input.baseSha);
  const tree = await Promise.all(input.files.map(async (file) => ({ path: file.path, mode: "100644", type: "blob", sha: (await gh<{ sha: string }>(c, `${rp}/git/blobs`, { method: "POST", body: { content: file.content, encoding: "utf-8" } })).sha })));
  const newTree = await gh<{ sha: string }>(c, `${rp}/git/trees`, { method: "POST", body: { base_tree: baseTree, tree } });
  const commit = await gh<{ sha: string }>(c, `${rp}/git/commits`, { method: "POST", body: { message: input.message, tree: newTree.sha, parents: [input.baseSha] } });
  await gh(c, `${rp}/git/refs`, { method: "POST", body: { ref: `refs/heads/${input.branch}`, sha: commit.sha } });
  const pr = await gh<{ number: number; html_url: string }>(c, `${rp}/pulls`, { method: "POST", body: { title: input.title, head: input.branch, base: input.base, body: input.body, maintainer_can_modify: true } });
  return { number: pr.number, url: pr.html_url, commit: commit.sha };
}

export const getPull = (c: GithubCredentials, repo: string, number: number) => gh<{ state: "open" | "closed"; merged: boolean; merged_at: string | null; html_url: string }>(c, `${repoPath(repo)}/pulls/${number}`);

/* ------------------------------------------------------------------ demo */

/** Offline run: records the Git Data API sequence for a two-file optimization PR. */
export async function demo() {
  const credentials: GithubCredentials = { token: "demo-token", source: "env", login: null };
  const calls: string[] = [];
  let blob = 0;
  setFetch(async (input, init) => {
    const path = input.slice(API.length);
    calls.push(`${init?.method || "GET"} ${path}`);
    const body = (value: unknown) => new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json" } });
    if (path.endsWith("/git/ref/heads/main")) return body({ object: { sha: "base000" } });
    if (/\/git\/commits\/\w+$/.test(path)) return body({ tree: { sha: "tree000" } });
    if (path.endsWith("/git/blobs")) return body({ sha: `blob00${++blob}` });
    if (path.endsWith("/git/trees")) return body({ sha: "tree001" });
    if (path.endsWith("/git/commits")) return body({ sha: "commit001" });
    if (path.endsWith("/git/refs")) return body({ ref: "refs/heads/roistation/seo-demo" });
    if (path.endsWith("/pulls")) return body({ number: 1, html_url: "https://github.com/example-org/zeytinlik-restoran/pull/1" });
    return new Response("", { status: 404 });
  });

  const repo = "example-org/zeytinlik-restoran";
  const baseSha = await getBranchHead(credentials, repo, "main");
  const pr = await openPullRequest(credentials, {
    repo, base: "main", branch: "roistation/seo-demo", baseSha, message: "ROIstation SEO/GEO: 2 dosya", title: "SEO & GEO optimizasyonu (2 düzeltme)", body: "Demo",
    files: [{ path: "public/llms.txt", content: "# Zeytinlik Restoran\n" }, { path: "app/robots.ts", content: "export default function robots() {}\n" }],
  });
  let invalidRepo: string | null = null;
  try { await getRepo(credentials, "zeytinlik-restoran"); } catch (error) { if (error instanceof GithubError) invalidRepo = `${error.status}: ${error.message}`; }
  let traversalRepo: string | null = null;
  try { await getRepo(credentials, "example-org/../zeytinlik-restoran"); } catch (error) { if (error instanceof GithubError) traversalRepo = `${error.status}: ${error.message}`; }
  return { pr, calls, invalidRepo, traversalRepo };
}

if (/github-api\.ts$/.test(process.argv[1] ?? "")) demo().then((result) => console.log(JSON.stringify(result, null, 2)));
