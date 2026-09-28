# GitHub Integration — optimization pull requests

## Overview

The SEO & GEO Center can fix what it measures. "Optimize" turns the latest live scan into repository changes
(robots, sitemap, llms.txt, JSON-LD component, metadata insertions, optionally the connector kit), commits them to
a new branch in the client's repository in **one commit**, and opens a pull request. Vercel builds a preview for
the PR; merging deploys to production; the deployment engine notices the new deploy and the site is re-scanned.

Nothing is pushed to a default branch. A human reviews and merges every change.

![Optimization](../assets/screenshots/optimization.png)

## Architecture notes

| Concern | File |
| --- | --- |
| Minimal GitHub REST client (repos, Git Data API, pulls) | `lib/github/api.ts` |
| Token precedence, sealed storage | `lib/github/credentials.ts` (uses `lib/crypto-box.ts`) |
| Orchestration: guards → plan → env → commit → PR → record | `lib/seo/optimize.ts` |
| Fix planning (what to change, what to leave as manual) | `lib/seo/fixes.ts` |
| Optimization records (create-only history, CAS status updates) | `lib/seo/store.ts` |
| API | `POST /api/seo/optimize`, `GET/POST /api/github` |

The repository is not configured in the panel: it comes from the Vercel project's Git link
(`project.repository` in the project record), so the PR always targets the repository Vercel actually deploys.

![Optimization pipeline](../docs/diagrams/optimization-pipeline.svg)

## The code

### 1. A small, strict REST helper

**Source:** `lib/github/api.ts`

```ts
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
```

`repoPath` validates owner and name before they are interpolated into a URL path. Each part must be a
`segment()`: word characters, dots and dashes only, and not made of dots alone, so `.` and `..` are rejected.
A third path part (`owner/name/extra`) is rejected as well. A malformed repository string from project metadata
therefore cannot traverse to another API route.

### 2. Many files, one commit: the Git Data API

The Contents API would create one commit per file. The Git Data API builds a tree on top of the base commit's tree
and creates a single commit, then a branch ref, then the PR.

**Source:** `lib/github/api.ts`

```ts
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
```

Blobs are uploaded in parallel; everything after depends on the previous step. If the process fails before
`git/refs`, only unreachable blobs/trees/commits remain, which GitHub garbage-collects; no branch is left behind.

### 3. Guards before any write

**Source:** `lib/seo/optimize.ts`

```ts
  const [latest] = await scanHistory(siteId, 1);
  if (!latest) throw new ApiError("Önce bu site için analiz çalıştırın.", 409);
  const ignored = await ignoredChecks(siteId);
  // Only the selected (or all non-ignored) findings are planned; everything else is treated as resolved.
  const scan = { ...latest, checks: latest.checks.map((check) => (options.checkIds ? options.checkIds.includes(check.id) : !ignored.includes(check.id)) ? check : { ...check, status: "pass" as const }) };
  const project = await projectForSite(siteId, site.project);
  if (!project || project.archived) throw new ApiError("Site bir Vercel projesine bağlı değil; kod değişikliği için Vercel hesabını bağlayın.", 409);
  if (project.repository?.provider !== "github" || !project.repository.repo) throw new ApiError(`Vercel projesi (${project.name}) bir GitHub reposuna bağlı değil${project.repository?.provider ? ` (${project.repository.provider})` : ""}.`, 409);
  const github = await getGithubCredentials();
  if (!github) throw new ApiError("GitHub bağlı değil. Ayarlar → GitHub bölümünden erişim anahtarı ekleyin.", 409);

  const open = (await refreshOptimizations()).find((entry) => entry.siteId === siteId && entry.record.status === "open");
  if (open) throw new ApiError(`Bu site için açık bir optimizasyon PR'ı var: ${open.record.prUrl}. Önce birleştirin veya kapatın.`, 409);
```

Guards, in order: a scan exists; the site is linked to a live Vercel project; that project is linked to GitHub; a
GitHub token exists; there is no open optimization PR for this site. Per-issue "Auto Fix" works by marking every
*unselected* finding as passed in a copy of the scan, so the planner stays unaware of selection.

### 4. Planning edits it can make exactly

The planner only automates changes it can make safely: new files, or a single insertion at a marker that occurs
exactly once. Anything ambiguous becomes a manual item in the PR description.

**Source:** `lib/seo/fixes.ts`

```ts
function insertBefore(source: string, marker: RegExp, insertion: string) {
  const matches = source.match(new RegExp(marker.source, "gi"));
  if (!matches || matches.length !== 1) return null;
  return source.replace(marker, (found) => `${insertion}${found}`);
}
```

It also detects the framework (`app/layout.*` → App Router, `pages/_app.*` → Pages Router, `index.html` → static)
and resolves the `@/*` import alias from `tsconfig.json`/`jsconfig.json` before deciding file paths.

### 5. Commit, PR, record, event

**Source:** `lib/seo/optimize.ts`

```ts
    const branch = `roistation/seo-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    // …
    const pr = await openPullRequest(github, { repo: repoName, base, branch, baseSha, files: plan.files.map((file) => ({ path: file.path, content: file.content })), message: `ROIstation SEO/GEO: ${plan.files.length} dosya`, title: `SEO & GEO optimizasyonu (${plan.files.length} düzeltme)`, body });
    const record: OptimizationRecord = { siteId, createdAt: now.toISOString(), scanId: scan.id, status: "open", repo: repoName, baseBranch: base, branch, prNumber: pr.number, prUrl: pr.url, applied, manual: plan.manual, env, updatedAt: now.toISOString() };
    await saveOptimization(record);
    await logEvents([{ key: eventKeyForSite(siteId, project.projectId), siteId, projectId: project.projectId, type: "seo-optimization-opened", message: `SEO/GEO optimizasyon PR'ı açıldı: ${pr.url}` }]);
```

The PR body lists each changed file with the findings it addresses, the Vercel environment variables that were set
(when the connector kit is installed), and manual steps with scan evidence.

### 6. Tracking PR state without webhooks

**Source:** `lib/seo/optimize.ts`

```ts
/** Updates PR states (open → merged / closed). Never throws. */
export async function refreshOptimizations() {
  const entries = await latestOptimizations().catch(() => []);
  const github = entries.some((entry) => entry.record.status === "open" && entry.record.prNumber) ? await getGithubCredentials() : null;
  for (const entry of entries) {
    if (entry.record.status !== "open" || !entry.record.prNumber || !github) continue;
    try {
      const pull = await getPull(github, entry.record.repo, entry.record.prNumber);
      const status = pull.merged ? "merged" : pull.state === "closed" ? "closed" : "open";
      if (status !== entry.record.status) {
        const next = { ...entry.record, status, mergedAt: pull.merged_at, updatedAt: new Date().toISOString() } as OptimizationRecord;
        if (await updateOptimization(entry.pathname, entry.etag, next) === "replaced") entry.record = next;
      }
    } catch { /* keep last known state */ }
  }
  return entries;
}
```

Only the newest optimization per site is polled, only while it is open, and the status update is a CAS on that
record, so concurrent dashboard loads cannot flap it.

## Engineering notes

- **Token handling.** `GITHUB_TOKEN` wins; otherwise a fine-grained PAT saved from Settings is sealed with
  AES-256-GCM (`seal(token, "github-token")`) and never returned. Tokens are format-checked
  (`ghp_…`, `github_pat_…`) and validated with `GET /user` before being stored.
- **Push permission** is checked from `repo.permissions.push` before planning, so a read-only token fails fast with
  a clear 403 instead of failing at `git/refs`.
- **Error mapping.** `GithubError` is translated to 502 for GitHub 5xx, 404 for missing repos/branches, 409 otherwise,
  so the panel can distinguish "try later" from "fix configuration".
- **Concurrency.** The "one open PR per site" guard is a read-then-act check without a lock; two simultaneous
  optimize clicks for the same site could open two PRs. The admin UI disables the button while a request is in flight,
  which makes this unlikely in practice.
- **Side effects on read.** `seoDashboard()` calls `refreshOptimizations()`, so loading the SEO Center can update
  optimization records and call the GitHub API. It is intentional (no webhook needed) but worth knowing.
- **Truncated trees.** `listTree` reports `truncated` for very large repositories; the planner treats unseen paths as
  absent, which can only lead to a manual item, never to overwriting an unseen file (updates require a successful
  `readFile`).

## Why it is built this way

**Decision:** propose changes as a single-commit pull request against the repository Vercel deploys, generated
deterministically from scan data.

**Alternatives considered:**
- *Commit directly to the production branch.* Faster, but removes review and makes a bad edit an outage.
- *Contents API per file.* Simpler, but N commits per optimization and N chances to fail halfway.
- *Model-generated patches.* Flexible, but non-deterministic and hard to review; the planner only automates edits
  whose exact result is known.
- *Injecting fixes at the edge* (middleware rewriting HTML). No repository access needed, but invisible to the
  client's developers and fragile across deploys.

**Trade-offs accepted:** some findings (broken links, heading structure, performance) cannot be auto-fixed and stay
manual. The flow depends on the Vercel project being linked to GitHub; GitLab and Bitbucket links are reported but
not supported yet (roadmap).

## Best practices demonstrated

- Validated path segments before URL interpolation.
- Git Data API for atomic multi-file commits.
- Guard clauses ordered from cheapest to most expensive.
- Only-exact edits; ambiguity downgrades to a manual instruction.
- Polling external state on read with CAS updates instead of requiring webhooks.

## Related

- [docs/SEO-Engine.md](../docs/SEO-Engine.md) · [docs/Permissions.md](../docs/Permissions.md) ·
  [optimization pipeline](../docs/diagrams/optimization-pipeline.svg)
- Sibling walkthroughs: [seo-engine.md](seo-engine.md), [geo-engine.md](geo-engine.md),
  [vercel-integration.md](vercel-integration.md), [authentication.md](authentication.md)
