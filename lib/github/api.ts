import type { GithubCredentials } from "@/lib/github/credentials";

/* Minimal GitHub REST client (https://docs.github.com/rest): repos, Git Data API, pull requests. */

const API = (process.env.GITHUB_API_URL || "https://api.github.com").replace(/\/+$/, "");
export class GithubError extends Error { constructor(message: string, public status: number) { super(message); } }

async function gh<T>(credentials: GithubCredentials, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API}${path}`, {
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
