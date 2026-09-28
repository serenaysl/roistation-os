# Permissions

This document describes who can do what in ROIstation Master Panel, which third-party permissions the panel needs, and which actions the code is built never to take. How each caller proves its identity is covered in [Authentication.md](Authentication.md).

## Single-admin model

The panel has **one administrator account**. There are no user records, roles, teams or per-site permissions: whoever holds a valid admin session can perform every admin action on every site in the catalog. This fits the product's scope (one agency operating its own client portfolio) and keeps the security surface small, but it also means:

- there is no per-user audit trail (publication history records *what* happened and *when*, not *who*),
- access cannot be limited to a subset of sites or to read-only,
- sharing access means sharing the password.

**Roadmap:** multi-user accounts with roles (for example owner, editor, viewer) and per-site scopes. An earlier multi-tenant design with `organizations` and `organization_members` tables is kept in `docs/legacy/supabase/schema.sql` for reference; it is not used by the current release.

## Access tiers

| Tier | Identity | Enforced by |
|---|---|---|
| Anonymous public | Anyone on the internet | Nothing (read-only endpoints) |
| Embedded widget / iframe | Browser code running on the panel origin inside `/embed/<siteId>` | `requireSameOrigin`, form tokens, rate limit |
| Admin session | The administrator | `requireAdmin` (signed cookie + same origin for mutations) |
| Vercel Cron | Vercel platform | `requireCronSecret` (`CRON_SECRET`) |
| Vercel webhook | Vercel platform | HMAC-SHA1 with `VERCEL_WEBHOOK_SECRET` |
| Panel → client site | The panel calling a site's revalidate endpoint | `x-roistation-secret` = `ROISTATION_REVALIDATE_SECRET` on the site |

## Capability matrix

✓ allowed · ✗ refused · — not applicable

| Capability | Public | Widget | Admin | Cron | Webhook | Panel → site |
|---|---|---|---|---|---|---|
| Read published slot content, pages, page list, sitemap (`/api/site-*`) | ✓ | ✓ | ✓ | — | — | — |
| Load `/embed/<siteId>` | ✓ | ✓ | ✓ | — | — | — |
| Get a form token for a published form | ✓ | ✓ | ✓ | — | — | — |
| Submit a form answer | ✗ (403, wrong origin) | ✓ | ✓ | — | — | — |
| Read, export, delete submissions | ✗ | ✗ | ✓ | ✗ | ✗ | — |
| Create, edit, publish, schedule, withdraw, delete publications | ✗ | ✗ | ✓ | ✗ | ✗ | — |
| Generate AI drafts, extract text from files | ✗ | ✗ | ✓ | ✗ | ✗ | — |
| Verify a site connection | ✗ | ✗ | ✓ | ✓ (stale connections) | ✓ (linked projects, via sync) | — |
| Run a Vercel sync | ✗ | ✗ | ✓ | ✓ (full) | ✓ (light or full) | — |
| Auto-import Vercel projects as sites | ✗ | ✗ | ✓ | ✓ (per auto-connect policy) | ✓ (per auto-connect policy) | — |
| Connect / ignore a project, import all, change auto-connect policy | ✗ | ✗ | ✓ | ✗ | ✗ | — |
| Connect / disconnect Vercel or GitHub tokens | ✗ | ✗ | ✓ | ✗ | ✗ | — |
| Run an SEO & GEO scan | ✗ | ✗ | ✓ | ✓ (≤ 3 sites whose deployment changed) | ✗ | — |
| Ignore findings, open an optimization pull request | ✗ | ✗ | ✓ | ✗ | ✗ | — |
| Purge a client site's ROIstation cache | ✗ | ✗ | indirectly (withdraw / delete) | ✗ | ✗ | ✓ |

Notes:

- "Public" callers can only ever read content whose target on that site is published; drafts, withdrawn content, submissions and internal records are not reachable without a session.
- Cron and webhook callers cannot use the admin API, and the admin session is not accepted by the cron endpoints.
- Auto-import by cron or webhook follows the stored auto-connect setting (`disabled`, `ask`, or `auto`, default `auto`) and skips excluded, ignored, archived and opted-out projects.

## Site scope

A site id is accepted only if it is in the live site list:

```ts
// lib/publication-service.ts
export function validateSiteIds(input:unknown):string[] {
  if(!Array.isArray(input) || !input.length || input.length>sites.length || input.some(id=>typeof id!=="string" || !sites.some(site=>site.id===id))) throw new ApiError("En az bir kapsam içi site seç.");return [...new Set(input)] as string[];
}
```

The live list is the built-in catalog (`NEXT_PUBLIC_ROISTATION_SITES`, or the demo catalog when unset) plus non-archived sites imported from the connected Vercel account (`lib/site-registry.ts`). An archived site disappears from the list, but its publications, forms and history are kept and reattach when it is restored.

### Keeping projects out

| Mechanism | Where | Effect |
|---|---|---|
| `NEXT_PUBLIC_ROISTATION_EXCLUDED_PROJECTS` | Panel env, comma-separated Vercel project names | Project is marked `excluded`: never auto-imported or auto-verified, skipped by "import all", counted out of "compatible". An admin can still connect it explicitly |
| `ROISTATION_DISABLED` | Env var **name** on the client's Vercel project (value ignored) | Project is `not-compatible`: never imported, and a manual connect returns 409 |
| Ignore | Panel action `ignore-project` | Stored in `vercel/settings.json`; the project is not auto-imported |
| Auto-connect `disabled` | Panel setting | Nothing is imported automatically |

An excluded project still appears in the Vercel overview and can still be connected with an explicit `connect-project` action by the admin; exclusion is enforced for automatic paths only.

## Host allow-listing

The panel only makes requests to client-site hosts it can justify. Every verification probe, SEO scan fetch and redirect hop goes through `allowedHosts` and `validateUrl`:

```ts
// lib/verification.ts
/** Hosts a site may be verified on: profile domain, SITE_ALLOWED_HOSTS_JSON and domains reported by its Vercel project. */
export function allowedHosts(siteId: string, project?: Pick<VercelProjectRecord, "productionDomain" | "customDomains" | "name"> | null) {
  const profile = sites.find((site) => site.id === siteId);
  if (!profile) throw new ApiError("Kapsam dışı veya bilinmeyen site.");
  let allowed: Record<string, string[]> = {};
  try { allowed = JSON.parse(process.env.SITE_ALLOWED_HOSTS_JSON || "{}"); } catch { throw new ApiError("SITE_ALLOWED_HOSTS_JSON geçersiz.", 503); }
  const hosts = new Set([profile.domain, `www.${profile.domain}`, ...(Array.isArray(allowed[siteId]) ? allowed[siteId] : [])]);
  if (project) for (const domain of [project.productionDomain, ...project.customDomains, `${project.name}.vercel.app`]) if (domain) { hosts.add(domain); if (!domain.startsWith("www.")) hosts.add(`www.${domain}`); }
  return hosts;
}
```

- URLs must be `https:`, on port 443, without credentials, and on an allowed host.
- Redirects are followed manually (at most 4 hops) and every `Location` is re-validated (`safeGet`), so a site cannot redirect the panel to an internal or third-party address. The integration test asserts that `https://127.0.0.1` is rejected with 400.
- Response bodies are read with a byte cap (`readCapped`).
- The cache-purge call goes only to the site's **verified** connection origin (or its catalog domain) and does not follow redirects.

`SITE_ALLOWED_HOSTS_JSON` adds hosts per site id, for example when a demo site is served from a second domain:

```json
{ "kiyi-dis": ["kiyidis.example", "www.kiyidis.example"], "zeytinlik-restoran": ["zeytinlik.example"] }
```

## External token scopes

Grant each integration the narrowest permission that the code actually uses.

### Vercel Personal Access Token

Set as `VERCEL_TOKEN` (+ optional `VERCEL_TEAM_ID`) or pasted once in the panel (stored sealed). Vercel tokens are scoped to a personal account or a team rather than to individual endpoints, so create the token for the team that owns the client projects only.

| Endpoint | Method | Purpose |
|---|---|---|
| `/v2/user`, `/v2/teams`, `/v2/teams/{id}` | GET | Validate the token, choose a scope, show the account label |
| `/v10/projects` | GET | Discover projects (paged, up to 20 × 100) |
| `/v9/projects/{id}/domains` | GET | Production and custom domains |
| `/v9/projects/{id}/env` | GET | Env var **names and targets only**; values are stripped before storage |
| `/v6/deployments` | GET | Latest production and preview deployments |
| `/v10/projects/{id}/env?upsert=true` | POST | Only when the SEO optimizer installs the connector kit: sets `ROISTATION_SITE_ID`, `ROISTATION_MASTER_URL`, `ROISTATION_SITE_NAME` and, only when it passes `revalidationConfigured()` (≥ 32 characters), `ROISTATION_REVALIDATE_SECRET` (as `sensitive`) for production and preview |

The panel never creates deployments, changes domains or deletes projects.

### GitHub fine-grained token

Set as `GITHUB_TOKEN` or pasted once in the panel (stored sealed). Required repository permissions on the client repositories only:

| Permission | Level | Used for |
|---|---|---|
| Contents | Read and write | Read the tree and files; create blobs, a tree, a commit and a new branch ref |
| Pull requests | Read and write | Open the pull request, read its state (open / merged / closed) |
| Metadata | Read (granted automatically) | Repository lookup |

Endpoints used (`lib/github/api.ts`): `GET /user`, `GET /repos/{owner}/{repo}`, `GET …/git/ref/heads/{branch}`, `GET …/git/commits/{sha}`, `GET …/git/trees/{sha}?recursive=1`, `GET …/contents/{path}`, `POST …/git/blobs`, `POST …/git/trees`, `POST …/git/commits`, `POST …/git/refs`, `POST …/pulls`, `GET …/pulls/{number}`.

### Anthropic and OpenAI keys

Used only by `POST /api/automation` (`https://api.anthropic.com/v1/messages`, `https://api.openai.com/v1/responses`). The keys never leave the server and `GET /api/integration-status` reports only whether they are set. Create the Anthropic key scoped to a single workspace (set `ANTHROPIC_WORKSPACE_ID` if the key spans several) and use provider-side spend limits; the idempotent generation records protect against accidental double charges, not against a compromised key.

### Other credentials

| Credential | Scope |
|---|---|
| `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` + `VERCEL_OIDC_TOKEN` | Read/write on the private Blob store. OIDC (managed by Vercel) is preferred over a static token |
| `PAGESPEED_API_KEY` | Optional; raises the PageSpeed Insights quota. Restrict it to the PageSpeed Insights API in Google Cloud |

## What the panel will never do

Each statement below is enforced in code; the reference shows where.

**Repositories (SEO optimizer)**

- **Never commits to an existing branch, including the default branch.** `openPullRequest` creates exactly one commit whose parent is the base head and a **new** ref `refs/heads/roistation/seo-<timestamp>` via `POST /git/refs`, then opens a pull request. No code path updates an existing ref or merges a pull request (`lib/github/api.ts`, `lib/seo/optimize.ts`).
- **Never opens a second optimization PR for a site while one is open** (409, `lib/seo/optimize.ts`).
- **Never overwrites existing metadata.** If the root layout already exports `metadata` or `generateMetadata`, or is a client component, the suggested values go into the PR description as a manual item instead (`lib/seo/fixes.ts`).
- **Never replaces robots rules.** A robots file is created only when neither `public/robots.txt` nor `app/robots.(ts|js)` exists. An existing `robots.txt` is changed only by appending a `Sitemap:` line when it has none. Blocking rules (`Disallow: /`, blocked AI crawlers) are reported as manual items because they may be intentional (`lib/seo/fixes.ts`).
- **Never replaces an existing sitemap, `llms.txt` or schema component**; each is created only when absent.
- **Never lists URLs the scan found broken** in a generated sitemap.
- **Never invents business data.** Phone, address, hours, geo coordinates and profiles come only from `SITE_BUSINESS_JSON`; missing values are left out of schema and NAP boxes (`lib/publishing/business.ts`).

**Vercel**

- **Never reads environment variable values**; only names and targets are requested and stored (`listEnvMetadata` in `lib/vercel/api.ts`).
- **Never deploys, redeploys or changes domains.** The only write is the env var upsert described above, and only during an optimization that installs the connector kit.
- **Never deletes a site's publications, forms or history when its project disappears**; the project and site are archived and restored with the same id if the project returns (`lib/vercel/sync.ts`).

**Data and secrets**

- **Never returns stored Vercel or GitHub tokens** to the browser.
- **Never stores data in a public Blob store**; reads from a non-private store are refused (`lib/blob-store.ts`).
- **Never publishes AI output automatically.** Generation (`/api/automation`) and publishing (`/api/publish`) are separate admin actions, and demo output is refused server-side: `/api/publish` loads the stored generation by `generationId` and rejects it when its recorded `mode` is `"demo"` (`app/api/publish/route.ts`).
- **Never fetches arbitrary URLs from client input**; see [Host allow-listing](#host-allow-listing).
- **Never exposes internal error details**; only `ApiError` messages reach the client (`lib/errors.ts`).

**Browser**

- **Never lets the admin panel be framed.** `/` is served with `X-Frame-Options: DENY` and `Content-Security-Policy: frame-ancestors 'none'`. Only `/embed/<siteId>`, which renders published content and forms, stays frameable for client sites (`next.config.ts`).
- **Never leaks full panel URLs to other origins** (`Referrer-Policy: strict-origin-when-cross-origin` on every path) and never lets a response be content-sniffed (`X-Content-Type-Options: nosniff`). The framework banner is off (`poweredByHeader: false`). See [Deployment.md](Deployment.md#security-headers).
