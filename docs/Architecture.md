# Architecture

ROIstation Master Panel is a single Next.js 16 (App Router) application deployed on Vercel. It is the control plane for a portfolio of client websites: it stores content and forms, decides per site what is live, serves that content to the sites over a small public read-only API, watches the sites' Vercel projects, audits them for SEO and GEO, and proposes code fixes as GitHub pull requests.

This document explains how the pieces fit together and why they are built the way they are. Endpoint details are in [API.md](API.md), the login and token model in [Authentication.md](Authentication.md), and who can do what in [Permissions.md](Permissions.md).

![System architecture](diagrams/system-architecture.svg)

## Contents

- [System context](#system-context)
- [Layers](#layers)
- [Request lifecycles](#request-lifecycles)
- [Storage model](#storage-model)
- [Concurrency and idempotency](#concurrency-and-idempotency)
- [Failure isolation](#failure-isolation)
- [Cron and webhook](#cron-and-webhook)
- [Time budgets](#time-budgets)
- [Key design decisions and trade-offs](#key-design-decisions-and-trade-offs)

## System context

| Actor / system | Direction | What flows |
|---|---|---|
| Agency admin (browser) | → panel | Password login, then all panel operations through `/api/*` with the session cookie |
| Client sites (Next.js on Vercel) | → panel | Server-side fetches of published pages and slot content (`/api/site-page`, `/api/site-pages`, `/api/site-content`) via the connector kit |
| Client site visitors | → panel | The `/embed/<siteId>` iframe (loaded by `public/widget.js` or `RoistationSlot`), form tokens, form submissions |
| Client sites | ← panel | Connector probe `GET /api/roistation/verify`, cache purge `POST /api/roistation/revalidate`, homepage/robots/sitemap/llms.txt fetches during SEO scans |
| Vercel REST API | ← panel | Project, domain, deployment and env-name discovery; env var upsert when the optimizer installs the connector kit |
| Vercel platform | → panel | Daily cron calls (`Authorization: Bearer <CRON_SECRET>`), optional account/team webhook (`x-vercel-signature`) |
| Vercel Blob (private) | ↔ panel | The only persistent store. One JSON object per record |
| GitHub REST API | ← panel | Repository metadata, file reads, Git Data API commits and pull requests |
| Google PageSpeed Insights | ← panel | Mobile Lighthouse lab data and Chrome UX Report field data |
| Anthropic / OpenAI APIs | ← panel | Content drafts for the AI automation screen (Anthropic first, OpenAI as fallback) |

There is no database server, queue, or background worker. All work runs inside Vercel Functions triggered by a user request, a public request, a cron call or a webhook.

## Layers

```
┌──────────────────────────────────────────────────────────────────────────┐
│ UI (client components)          components/*, app/page.tsx, app/embed   │
│   master-panel · publication-manager · seo-center · vercel-overview ... │
├──────────────────────────────────────────────────────────────────────────┤
│ Route handlers                   app/api/**/route.ts                     │
│   auth gate (requireAdmin / requireCronSecret / HMAC) · input shape     │
│   validation · apiFailure() error mapping · maxDuration                  │
├──────────────────────────────────────────────────────────────────────────┤
│ Domain services                  lib/*                                   │
│   publication-service · publishing/* · verification · site-registry     │
│   vercel/* · seo/* · github/* · generation-storage                      │
├──────────────────────────────────────────────────────────────────────────┤
│ Storage primitives               lib/blob-store.ts, lib/storage.ts,     │
│   create-only · compare-and-swap · last-write-wins · list + cache       │
│   lib/migration.ts (one-time legacy import)                             │
├──────────────────────────────────────────────────────────────────────────┤
│ External                         Vercel Blob · Vercel API · GitHub API · │
│                                  PageSpeed · Anthropic / OpenAI · sites  │
└──────────────────────────────────────────────────────────────────────────┘
```

### UI

`app/page.tsx` is a server component that renders either `LoginView` or `MasterPanel` depending on `isAdmin()`. Everything else in the panel is client-side React that talks to `/api/*` through `lib/client-api.ts` (`requestApi` throws the server's `{ error }` message so the UI can show it verbatim). The UI is Turkish because the agency's market is Turkish; labels such as "Yayında" (published) or "Bağlı · Doğrulandı" (connected · verified) come from `lib/publications.ts` and `lib/status-labels.ts`.

`app/embed/[siteId]/page.tsx` is the only public page. It server-renders `SiteWidget` with the site's current slot items, then polls `/api/site-content` every 15 seconds and reports its height to the parent page with `postMessage`.

### Route handlers

Route handlers are deliberately thin. A typical handler:

1. authenticates (`requireAdmin(request)`, `requireCronSecret(request)`, or the webhook HMAC),
2. checks the shape of the input (ids against `/^[0-9a-f-]{36}$/i`, site ids against `/^[a-z0-9-]{2,60}$/`),
3. calls one domain function,
4. converts any thrown error with `apiFailure()`.

```ts
// lib/errors.ts
export function apiFailure(error:unknown) {
  return Response.json({error:error instanceof ApiError ? error.message : "İşlem tamamlanamadı."},{status:error instanceof ApiError ? error.status : 500,headers:{"Cache-Control":"no-store"}});
}
```

Only `ApiError` messages reach the client. Anything else becomes a generic 500, so stack traces and upstream error bodies are not leaked.

### Domain services (`lib/`)

| Module | Responsibility |
|---|---|
| `lib/publication-service.ts` | Validation of payloads, placements, schedules and slugs; create, publish, withdraw, delete, edit; public slot feed |
| `lib/publishing/*` | Publish locations and strategies (`definitions.ts`), per-site outcome channels (`channels.ts`), render-ready page model with metadata and JSON-LD (`page-model.ts`, `schema.ts`, `content.ts`), business profile from `SITE_BUSINESS_JSON` (`business.ts`), client-site cache purge (`revalidate.ts`) |
| `lib/verification.ts` | One verification engine for every entry point: Vercel deployment state, connector endpoint, legacy widget marker; host allow-listing and redirect-safe fetching |
| `lib/site-registry.ts`, `lib/sites.ts` | Built-in catalog from `NEXT_PUBLIC_ROISTATION_SITES` (or the demo catalog) plus sites imported from Vercel |
| `lib/vercel/*` | REST client, encrypted credentials, discovery and sync, per-project records, activity log, settings |
| `lib/seo/*` | Scanner, check catalogue and scoring, scan history, dashboard, presentation layer, fix planner and pull-request optimizer |
| `lib/github/*` | Minimal REST client and encrypted credentials |
| `lib/generation-storage.ts` | AI generation records and the fingerprint index that prevents paying twice for the same request |
| `lib/admin.ts`, `lib/form-token.ts`, `lib/crypto-box.ts`, `lib/rate-limit-storage.ts` | Session, same-origin check, cron secret, form tokens, AES-256-GCM sealing, rate limits |

### Storage primitives

`lib/blob-store.ts` is the only module that talks to `@vercel/blob`. It exposes four write shapes and two read shapes, described in [Storage model](#storage-model). `lib/storage.ts`, `lib/connection-storage.ts`, `lib/generation-storage.ts`, `lib/site-registry.ts`, `lib/vercel/*` and `lib/seo/store.ts` build typed repositories on top of it.

## Request lifecycles

### 1. Admin publishes an existing publication

`PATCH /api/publications` with `{ id, version, action: "publish", siteIds | all, scope?, scheduleAt?, placement? }`.

1. `requireAdmin` verifies the signed cookie and the `Origin` header.
2. `operatePublication` loads the publication object and its ETag, and rejects the request with 409 if `input.version !== row.version`.
3. `preflightSites(ids)` re-verifies every target site whose last successful verification is older than two minutes (`FRESH_MS = 120_000`). Failures do not throw.
4. The publish channel evaluates each site independently (see [Failure isolation](#failure-isolation)).
5. The new document (targets, events, `version + 1`) is written with compare-and-swap on the ETag from step 2.
6. A per-project activity event is written for each successful site (create-only, best effort).
7. The response carries the updated publication and one outcome per site.

Withdraw and delete follow the same path but skip preflight, and after the write call `revalidateSites()` so connected sites purge their ISR cache immediately. When a delete leaves no live target, the publication is tombstoned with CAS and then removed from storage (`removePublication` in `lib/storage.ts`).

### 2. A client site renders a published SEO page

1. The site's `app/rehber/[slug]/page.tsx` (copied from `connectors/templates`) calls `getRoistationPage(slug)`.
2. `connectors/roistation/client.ts` fetches `GET <master>/api/site-page?siteId=…&slug=…&location=seo-page` with `next: { revalidate: 30, tags: ["roistation"] }`.
3. The panel lists content publications (served from the per-instance document cache when unchanged), builds the site index, resolves the slug and returns a render-ready model: blocks, TOC, FAQ, breadcrumbs, canonical, Open Graph, Twitter, robots and JSON-LD.
4. The site renders it inside its own layout with `RoistationArticle`. If the master is down, Next.js keeps serving the last good ISR version.

### 3. A visitor submits a form

1. `widget.js` (or `RoistationSlot`) injects an iframe pointing to `/embed/<siteId>` on the panel's origin.
2. On submit, `SiteWidget` requests `GET /api/form-token?id=…&siteId=…`, which only succeeds if the form is currently published on that site. The token is `<expires>.<HMAC>` and valid for one hour.
3. `POST /api/submissions` from inside the iframe (same origin as the panel) passes `requireSameOrigin`, the per-IP rate limit (10 per hour), the honeypot, the token check, the consent check and per-field validation.
4. `acceptSubmission` writes the submission as a create-only object, then re-reads the form; if the form was withdrawn in between, the submission is deleted again and the request returns 410.

### 4. AI draft generation

1. The panel generates a `generationId` (UUID) in the browser and posts `{ generationId, sourceText, siteIds, goal, … }` to `/api/automation`.
2. The server computes a SHA-256 fingerprint of the request content. If a completed generation with the same fingerprint exists, it is returned (`recovered: true`) without calling a provider.
3. Otherwise a `pending` record is created (create-only). Anthropic is called when `ANTHROPIC_API_KEY` is set, else OpenAI, else a clearly labelled demo result.
4. Results are validated (one result per requested site, valid payloads, numeric scores) and the record is moved to `complete` with CAS. On error it is moved to `failed`, never downgrading a completed result.
5. Nothing is published by this step. A human edits and approves the drafts, then `/api/publish` creates the publication.

### 5. SEO scan and optimization

1. `POST /api/seo/scan` scans one site per request: homepage, up to 4 inner pages, robots.txt, sitemap, llms.txt, up to 25 internal links, and PageSpeed Insights in parallel. Every fetch goes through `safeGet` with the site's host allow-list.
2. The scan is stored as a new create-only object; history is never rewritten.
3. `POST /api/seo/optimize` reads the latest scan, the site's Vercel project and its linked GitHub repository, plans file changes (`lib/seo/fixes.ts`), and opens one pull request on a new branch. See [Permissions.md](Permissions.md#what-the-panel-will-never-do) for the guarantees.

## Storage model

All state lives in one **private** Vercel Blob store under the `roistation-master/` prefix. `readJson` refuses to return data from a non-private store:

```ts
// lib/blob-store.ts — readJson
    // Leads and drafts must never live in a public store.
    if(!result.blob.url.includes(".private.blob.vercel-storage.com/") || result.statusCode !== 200 || !result.stream) throw new ApiError(accessMessage,503);
```

### Layout

| Path | Record | Write mode |
|---|---|---|
| `publications/<uuid>.json` | Publication (targets per site, events, placement, `version`) | create-only, then CAS |
| `submissions/<uuid>.json` | Form submission with consent text and timestamp | create-only, delete |
| `generations/<uuid>.json` | AI generation (`pending` → `complete` / `failed`) | create-only, then CAS |
| `generation-fingerprints/<sha256>.json` | Pointer from request fingerprint to a completed generation | last-write-wins |
| `connections/<site-id>.json` | Latest verification result for a site | last-write-wins |
| `rate-limit/<sha256>.json` | Rate-limit bucket | last-write-wins |
| `sites/<site-id>.json` | Site imported from Vercel (archivable) | create-only, then CAS |
| `vercel/projects/<project-id>.json` | Vercel project record (domains, deployments, health, live status) | create or CAS (`upsertProjectRecord`) |
| `vercel/events/<key>/<inverted-ms>-<rand>.json` | Activity log entry | create-only, pruned to 300 per key |
| `vercel/credentials.json` | Sealed Vercel token | last-write-wins |
| `vercel/settings.json` | Auto-connect mode, ignored projects | create or CAS |
| `vercel/sync-state.json` | Last sync result | last-write-wins |
| `vercel/sync-lock.json` | Cross-instance sync lock (90 s) | create-only, delete |
| `seo/scans/<site-id>/<inverted-ms>-<rand>.json` | Immutable scan result | create-only |
| `seo/optimizations/<site-id>/<inverted-ms>-<rand>.json` | Optimization / pull-request record | create-only, then CAS for PR state |
| `seo/ignored/<site-id>.json` | Findings the admin chose to ignore | create or CAS |
| `github/credentials.json` | Sealed GitHub token | last-write-wins |
| `migrations/state-json-v1.json` | One-time migration marker | create-only |
| `v1/state.json`, `v1/*` | Legacy layout, read only by `lib/migration.ts` | never written |

Paths come from the `blobPaths` map in `lib/blob-store.ts`. Documents larger than 4 MB are rejected on write (413) and treated as corrupt on read.

### Write primitives

```ts
// lib/blob-store.ts
/*
 * One JSON document per Blob object. Every write touches exactly one pathname:
 *   create   -> allowOverwrite:false (idempotent insert)
 *   replace  -> ifMatch:<etag>       (compare-and-swap on that object only)
 *   overwrite-> last write wins      (independent observations: connections, rate limits)
 * Nothing in this module reads or writes a shared application snapshot.
 */
```

- **`createJson`** returns `"created"` or `"exists"`. A failed or timed-out write is settled by one direct read of the same object, because a timed-out write may still have landed.
- **`replaceJson`** returns `"replaced"` or `"conflict"`. A conflict is an expected outcome, not an exception; each caller decides whether to retry (`updateSiteRecord`, `upsertProjectRecord`, `setIgnored`: up to 3–4 attempts) or to surface a 409 (publications).
- **`overwriteJson`** is used only where the newest observation is by definition the right one: verification results, rate buckets, sync state, credentials, the fingerprint index.
- **`deleteJson`** treats "not found" as success.

All reads use `useCache: false`, so the Blob CDN never serves a stale object to a single-record read.

### Caching in `readAllJson`

List views (all publications, all submissions, imported sites, project records) call `readAllJson(prefix)`, which lists the prefix and then reads only objects whose listed version changed since this function instance last saw them.

```ts
// lib/blob-store.ts
const CACHE_LIMIT = 5000;
const ETAG_CACHE_TTL_MS = 10 * 60 * 1000;
// Without a listed ETag the version is uploadedAt+size; keep that fallback short so a
// withdrawal written by another instance is never served for long.
const META_CACHE_TTL_MS = 10 * 1000;
```

- The cache key is the pathname; the version is `etag:<etag>` when the list response includes one, otherwise `meta:<uploadedAt>:<size>`.
- Every write through `blob-store` calls `forgetCached(pathname)` on the writing instance. Other instances pick up the change on their next list, because the listed version changes.
- Objects that disappeared from the listing are evicted.
- A document that fails to parse is logged and skipped (`CorruptDocumentError`), so one damaged object does not take down the admin list or the public feed.
- Single-record reads (`getPublication`, submissions, generations) never use this cache.

Two other in-process caches exist: the imported-site registry is refreshed at most every 20 seconds (`CACHE_MS = 20_000` in `lib/site-registry.ts`, bypassed with `ensureSiteRegistry(true)`), and `ensureMigrated()` remembers that the migration marker exists for the lifetime of the instance.

### Migration from `state.json`

Earlier releases kept everything in one shared `v1/state.json`. `lib/migration.ts` copies it (and the interim `v1/connections`, `v1/generations`, `v1/rates` objects) into the per-record layout on first use. Every copy is create-only, so it cannot overwrite a record already written in the new layout, and concurrent instances can run it safely. The copy is resumable within a 25-second budget per request; the marker is written last. `state.json` is left untouched as a backup. See [Deployment.md](Deployment.md#migration-from-legacy-statejson).

## Concurrency and idempotency

| Operation | Mechanism | Outcome under a race |
|---|---|---|
| Create publication | Client-supplied UUID + `createJson` | Same id and same content returns the stored row; same id with different content returns 409 (`insertPublication`) |
| Publish / withdraw / delete / edit | `version` check + CAS on the ETag read in the same request | The loser gets 409 "Yayın başka bir işlemle değişti. Listeyi yenile." and must reload |
| AI generation | Client-supplied `generationId` + request fingerprint + CAS status transitions | Repeats return the stored result; a `pending` duplicate returns 409 instead of calling the provider again |
| Form submission | Client-supplied submission UUID + `createJson` | A retry with the same id returns 201 without creating a duplicate |
| Vercel sync | Create-only `vercel/sync-lock.json` with a 90 s expiry | Overlapping runs return `skipped: "running"` |
| Project / site / settings records | Read-modify-CAS loop, 3–4 attempts | 409 after repeated contention |
| Activity events, scans, optimizations | Create-only with an inverted-timestamp + random suffix name | Never conflict |

`retryStorageBusy` (`lib/database.ts`) wraps several write routes, but it only re-runs an operation that threw `StorageBusyError`, and it caps attempts at 4 within a 6-second budget. Publication version conflicts are deliberately **not** retried: a conflict means another operation changed the same publication, and silently replaying the request on top of that change could publish something the admin did not see.

Why inverted timestamps: `String(9_999_999_999_999 - Date.parse(at)).padStart(13, "0")` makes lexical listing order equal to newest-first, so "latest scan" and "latest 40 events" need only a listing and a small number of reads.

## Failure isolation

The unit of failure is one site, never a whole operation.

```ts
// lib/publication-service.ts — createPublishedPublication
  // Each site is evaluated independently: one failing site never stops the others.
  const outcomes=ids.map(siteId=>defaultChannel.evaluate({siteId,action:"publish",scheduledAt,scope,connection:connections.find(c=>c.site_id===siteId)}));
```

- **Publish channel** (`lib/publishing/channels.ts`): a site without a verified connection gets `status: "failed"` with the reason, while other sites are published. With the scope "Tüm bağlı siteler" (all connected sites), unverified sites are **skipped** with a warning rather than failed. The response always lists one `ChannelOutcome` per site.
- **Preflight** uses `Promise.allSettled`; a verification error for one site only affects that site's outcome.
- **Cache purge** (`revalidateSites`) runs in parallel with a 4-second timeout per site; a site that is down returns `ok: false` and falls back to its 30-second ISR window. The operation itself still succeeds.
- **Activity logging** is best effort (`logEvents` never throws).
- **Cron jobs** report per-site results (`verified[]`, `rescanned[]`) instead of failing the run.
- **Storage** failures are classified (`access`, `rate-limited`, `timeout`, `precondition`, `not-found`) and mapped to 503 with an actionable message, or to `conflict` for CAS.
- **Site registry**: if imported sites cannot be loaded, the built-in catalog keeps working (`ensureSiteRegistry` never throws).

## Cron and webhook

`vercel.json` defines two daily jobs (UTC):

```json
"crons": [
  { "path": "/api/cron/vercel-sync", "schedule": "13 3 * * *" },
  { "path": "/api/cron/seo-scan",   "schedule": "41 4 * * *" }
]
```

Both routes start with `requireCronSecret(request)` (`lib/admin.ts`), a constant-time check of `Authorization: Bearer <CRON_SECRET>` that refuses every call while the secret is unset or shorter than 16 characters.

- **`/api/cron/vercel-sync`** runs a full Vercel sync (projects, domains, env names, deployments, connector probes, archive detection, auto-import), then re-verifies stored connections whose last check is older than one hour, 6 at a time, stopping new verifications after 45 seconds.
- **`/api/cron/seo-scan`** re-scans up to 3 sites whose latest scan was taken against an older production deployment than the one now live (`rescanNeeded` in `lib/seo/dashboard.ts`).

While the panel is open, the browser also triggers a light sync (projects and deployments only) every 2 minutes and a full sync every 10 minutes (`components/master-panel.tsx`).

The optional **webhook** (`POST /api/vercel/webhook`) verifies the HMAC-SHA1 signature, ignores event types outside `deployment.*`, `project.*` and `domain.*`, and runs a light sync for deployment events or a full sync for project and domain events. It shares the sync lock with every other trigger, so a burst of webhooks cannot run overlapping syncs.

## Time budgets

Vercel Functions have a hard time limit, so every external call has an explicit timeout and the long-running routes declare `maxDuration = 60`.

| Call | Timeout / budget | Source |
|---|---|---|
| Blob read / write / list | 5 s / 8 s / 8 s | `lib/blob-store.ts` |
| Connector endpoint probe / page probe | 4 s / 6 s | `lib/verification.ts` |
| Vercel REST call | 8 s | `lib/vercel/api.ts` |
| GitHub REST call | 15 s | `lib/github/api.ts` |
| PageSpeed Insights | 42 s | `lib/seo/scanner.ts` |
| Client-site revalidate | 4 s | `lib/publishing/revalidate.ts` |
| Connector probes during a sync | stop after 38 s | `lib/vercel/sync.ts` |
| Cron re-verification | stop after 45 s | `app/api/cron/vercel-sync/route.ts` |
| Legacy migration | 25 s per request, resumable | `lib/migration.ts` |
| `retryStorageBusy` | ≤ 4 attempts, 6 s | `lib/database.ts` |

## Key design decisions and trade-offs

### Private Blob, one object per record, instead of a database

**Why.** The panel is operated by one agency with a bounded number of sites and publications. A private Blob store needs no schema migrations, no connection pooling in serverless functions, and no separate provider; it is attached to the Vercel project and authenticated with OIDC. Per-record objects make every write touch exactly one pathname, so a conflict affects one publication instead of the whole application, which was the failure mode of the old shared `state.json`.

**Trade-offs.** There are no queries or indexes: list views read every object under a prefix (mitigated by the version-keyed cache), and Blob list calls are billed as advanced operations, including those made by the public feed. Pagination is done in memory (100 rows per page). Cross-record invariants, such as slug uniqueness across publications on one site, are checked at write time against a fresh listing rather than enforced by a constraint. The legacy Supabase schema in `docs/legacy/supabase/` is kept only as a record of the earlier design; it is not used.

### Optimistic concurrency with explicit versions

**Why.** Conflicts on a single publication are rare, and when they happen the admin should see them. CAS on the ETag plus a document `version` gives a clear 409 without locks.

**Trade-offs.** The client must send the version it read, and a conflict needs a manual reload.

### Client-generated operation ids

**Why.** Vercel function timeouts and flaky networks mean the browser cannot always tell whether a request succeeded. The browser generates `generationId`, `publicationId` and submission ids before the first attempt, so retries are safe. For AI generation this directly protects paid API credits.

**Trade-offs.** A reused id with different content is an error (409) rather than an update.

### Pull-based content delivery

**Why.** Client sites fetch published content from the panel and cache it with ISR, so publishing or withdrawing never requires a redeploy of the site. The master stays the single source of truth.

**Trade-offs.** Sites depend on the panel's availability for fresh content (the last good ISR version is kept during an outage). Withdrawals propagate in up to 30 seconds unless the site has the revalidate endpoint and `ROISTATION_REVALIDATE_SECRET` configured.

### Vercel as the verification source of truth

**Why.** For projects in the connected Vercel account, a Ready production deployment plus a reachable domain is a stronger signal than a marker in the HTML. Sites outside Vercel still verify through the connector endpoint or the legacy widget marker.

**Trade-offs.** A site can be "connected" without rendering any ROIstation slot; the connector state is reported separately so this is visible.

### Pull requests, not commits, for SEO fixes

**Why.** Changes to client repositories must be reviewable and reversible. The optimizer writes one commit on a new branch and opens a pull request; Vercel builds a preview, and a human merges.

**Trade-offs.** Fixes are not live until merged, and only changes that can be made exactly are automated; everything else becomes a manual item in the PR body.

### Single admin, stateless session

**Why.** The product serves one agency. An HMAC-signed expiry in an `HttpOnly`, `SameSite=Strict` cookie needs no session store.

**Trade-offs.** There is no per-user audit trail and no server-side revocation of an individual session. Multi-user roles are on the roadmap; see [Permissions.md](Permissions.md).

## Related documents

- [Folder-Structure.md](Folder-Structure.md) — where each module lives
- [Publishing-Engine.md](Publishing-Engine.md) — placements, strategies and the page model in depth
- [SEO-Engine.md](SEO-Engine.md) and [GEO-Engine.md](GEO-Engine.md) — scanner, checks and optimizer
- [State-Management.md](State-Management.md) — client-side state in the panel
- [Deployment.md](Deployment.md) — environment, crons, webhook and rollout
