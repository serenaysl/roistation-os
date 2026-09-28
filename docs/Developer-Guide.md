# Developer Guide

How to run ROIstation Master Panel locally, what the scripts and tests do, the conventions the codebase follows, and step-by-step recipes for the most common extensions. Designed, built and maintained by Serenay Uslu.

Related documents: [Architecture](Architecture.md) · [Folder Structure](Folder-Structure.md) · [API](API.md) · [Deployment](Deployment.md) · [Authentication](Authentication.md) · [Publishing Engine](Publishing-Engine.md) · [SEO Engine](SEO-Engine.md) · [GEO Engine](GEO-Engine.md) · [Component Library](Component-Library.md) · [State Management](State-Management.md)

## Contents

- [Requirements](#requirements)
- [Local setup](#local-setup)
- [Environment variables](#environment-variables)
- [Scripts](#scripts)
- [How the integration test works](#how-the-integration-test-works)
- [Coding conventions](#coding-conventions)
- [Adding a publish location, strategy or channel](#adding-a-publish-location-strategy-or-channel)
- [Adding an SEO check](#adding-an-seo-check)
- [Adding an API route](#adding-an-api-route)
- [Troubleshooting](#troubleshooting)

## Requirements

- Node.js 20.9 or newer (`"engines": { "node": ">=20.9.0" }` in `package.json`)
- npm (the repository ships a `package-lock.json`; use `npm ci`)
- For anything beyond the login screen: a **private** Vercel Blob store and its read-write token

Stack: Next.js 16 (App Router), React 19, TypeScript 5. Runtime dependencies are `next`, `react`, `react-dom`, `@vercel/blob`, `lucide-react` and `mammoth` (DOCX text extraction). There is no database server, no ORM and no test framework dependency; tests are plain Node scripts using `node:assert`.

## Local setup

```bash
npm ci
cp .env.example .env.local
# edit .env.local (see below), then:
npm run dev
```

Open `http://localhost:3000`. Without `PANEL_ADMIN_PASSWORD` and a `PANEL_SESSION_SECRET` of at least 32 characters the page shows setup instructions instead of the login form, and private APIs answer 503.

Minimal `.env.local` for a working panel:

```bash
PANEL_ADMIN_PASSWORD=choose-a-local-password
# node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
PANEL_SESSION_SECRET=<64 hex characters>
BLOB_READ_WRITE_TOKEN=<token of a PRIVATE Vercel Blob store>
MASTER_PUBLIC_URL=https://panel.roistation.example
```

Notes:

- **Sample values are demo data.** `.env.example` ships `SITE_ALLOWED_HOSTS_JSON` and `SITE_BUSINESS_JSON` filled for the demo site `zeytinlik-restoran`, so they work unchanged with the demo catalogue. Replace them with real site ids only in a real deployment's environment, never in the committed file.
- **Leave `NEXT_PUBLIC_ROISTATION_SITES` unset** to use the fictional demo catalogue (`demoSites` in `lib/sites.ts`: `roistation`, `kiyi-dis`, `liman-temizlik`, `zeytinlik-restoran`, `atlas-yapi`, `konak-otel`, `mavi-koy-turizm`, `denge-danismanlik`).
- **Same-origin checks allow localhost.** `requireSameOrigin()` (`lib/admin.ts`) accepts `http://localhost:<port>` and `http://127.0.0.1:<port>` only when `VERCEL !== "1"`. In production the allowed origins come from `MASTER_PUBLIC_URL`, `VERCEL_URL` and `VERCEL_PROJECT_PRODUCTION_URL`, never from the `Host` header.
- **The Blob store must be private.** `readJson()` rejects documents that are not served from `*.private.blob.vercel-storage.com`, because drafts and form submissions must never live in a public store.
- **No AI key is needed for development.** Without `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` the automation endpoint runs in demo mode, and demo output cannot be published.

### Managed containers

Some sandboxed environments deny `os.networkInterfaces()`, which Next.js calls to print LAN URLs. `npm run dev:managed` preloads `scripts/network-shim.cjs`, which falls back to a loopback-only answer, and binds the dev server to `127.0.0.1`:

```json
"dev:managed": "node -r ./scripts/network-shim.cjs node_modules/next/dist/bin/next dev -H 127.0.0.1"
```

## Environment variables

All of these are listed in `.env.example`, grouped by concern, including the two public catalogue variables read by `lib/sites.ts`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `PANEL_ADMIN_PASSWORD` | yes | Single admin password |
| `PANEL_SESSION_SECRET` | yes (≥ 32 chars) | HMAC key for the 8-hour session cookie and form tokens |
| `BLOB_READ_WRITE_TOKEN` or `BLOB_STORE_ID` + `VERCEL_OIDC_TOKEN` | yes | Private Vercel Blob store (Vercel sets these when the store is connected) |
| `MASTER_PUBLIC_URL` | yes for verification and connector setup | HTTPS origin of the panel; trusted origin for same-origin checks |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `ANTHROPIC_WORKSPACE_ID` | optional | Claude drafts (tried first) |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | optional | OpenAI drafts (used when no Anthropic key) |
| `SITE_ALLOWED_HOSTS_JSON` | optional | Extra allowed hosts per site id for verification and scanning |
| `SITE_BUSINESS_JSON` | optional | Business/NAP data per site id for schema, NAP box, llms.txt and GBP consistency |
| `ROISTATION_REVALIDATE_SECRET` | optional (≥ 32 chars) | Same value on panel and sites; enables instant cache purge on withdraw/delete |
| `VERCEL_TOKEN`, `VERCEL_TEAM_ID` | optional | Vercel integration via env (alternatively connect in the panel; stored encrypted) |
| `VERCEL_WEBHOOK_SECRET` | optional | Signature secret for the Vercel webhook |
| `CRON_SECRET` | optional (≥ 16 chars) | Bearer secret for `/api/cron/*` |
| `PAGESPEED_API_KEY` | optional | Higher PageSpeed Insights quota |
| `GITHUB_TOKEN` | optional | Token for optimization PRs (alternatively connect in Settings) |
| `NEXT_PUBLIC_ROISTATION_SITES` | optional | JSON array of the agency's site catalogue; falls back to the demo catalogue |
| `NEXT_PUBLIC_ROISTATION_EXCLUDED_PROJECTS` | optional | Comma-separated Vercel project names that are never auto-imported, auto-verified or published to by default; an admin can still connect one explicitly |
| `VERCEL_API_URL`, `GITHUB_API_URL` | testing only | API base overrides used by local fixtures; commented out in `.env.example`, leave unset in production |

`NEXT_PUBLIC_*` values are inlined at build time. Changing them requires a rebuild.

Example catalogue entry (demo values):

```json
[{ "id": "zeytinlik-restoran", "name": "Zeytinlik Restoran", "domain": "zeytinlik.example", "sector": "Restoran", "business": { "schemaType": "Restaurant", "locality": "Foça", "region": "İzmir" } }]
```

`parseSiteCatalog()` skips invalid entries (id must match `/^[a-z0-9-]{2,60}$/`, name and domain required) and derives initials and colour when omitted.

## Scripts

| Script | Command | What it does |
| --- | --- | --- |
| `dev` | `next dev` | Development server |
| `dev:managed` | `node -r ./scripts/network-shim.cjs … next dev -H 127.0.0.1` | Development server for containers without network-interface access |
| `build` | `next build` | Production build |
| `start` | `next start` | Serve the production build |
| `typecheck` | `tsc --noEmit` | Type checking. **This is the type gate**: `next.config.ts` sets `typescript.ignoreBuildErrors: true`, so `next build` does not fail on type errors |
| `smoke` | `node scripts/smoke.mjs` | Starts the built app with admin and storage variables blanked; asserts the home page renders, private APIs return 503 and the session reports "not configured" |
| `test:integration` | `node scripts/integration.mjs` | End-to-end test against a local Blob fixture (below) |
| `verify` | `build && typecheck && smoke && test:integration` | Everything, in order; run before every push. The build runs first because `next-env.d.ts` references route types generated in `.next/` |

`smoke` and `test:integration` run `next start` on `127.0.0.1:3210`, so they need a fresh `npm run build` and a free port 3210.

## How the integration test works

`scripts/integration.mjs` runs the real application (production build, real `@vercel/blob` SDK) against an in-process HTTP server that emulates the Blob API:

- **Fixture semantics.** It checks the bearer token, supports listing with prefix and cursor, returns ETags, rejects `PUT` with a stale `x-if-match` (412), rejects creating an existing object without `x-allow-overwrite` (400), and throws on any unconditional overwrite outside the few intentionally last-write-wins prefixes (connections, rate limits, fingerprint pointers, Vercel credentials and sync state). Any write to the legacy `state.json` fails the test.
- **Preloaded network redirect.** The server is started with `-r ./scripts/network-shim.cjs -r ./scripts/fixture-fetch.cjs` and `ROI_TEST_FIXTURE=1`. `fixture-fetch.cjs` patches `undici.fetch` (used by the Blob SDK) and `globalThis.fetch` so the fictitious store host `qastore.private.blob.vercel-storage.com` is served by the fixture, and the demo domains return canned HTML. Only `roistation.example` and `atlas-yapi.vercel.app` contain the widget snippet, so exactly those two verify as `connected-widget`.
- **Isolated environment.** AI keys and `VERCEL` are blanked (demo AI mode, localhost origins allowed), `MASTER_PUBLIC_URL` is `https://master.test`.

```js
// scripts/fixture-fetch.cjs
  const map = {'roistation.example':'roistation','atlas-yapi.vercel.app':'atlas-yapi','kiyidis.example':'kiyi-dis','limantemizlik.example':'liman-temizlik','zeytinlik.example':'zeytinlik-restoran','konak-otel-rezervasyon.vercel.app':'konak-otel','mavi-koy-turizm.vercel.app':'mavi-koy-turizm','dengedanismanlik.example':'denge-danismanlik'};
```

**The demo catalogue must be active.** The domain map and the assertions use the demo site ids, and `NEXT_PUBLIC_ROISTATION_SITES` is inlined at build time. Build for tests with the variable unset:

```bash
env -u NEXT_PUBLIC_ROISTATION_SITES npm run build
npm run smoke && npm run test:integration
```

What the test asserts, in order:

1. Unauthenticated access to admin APIs returns 401; a cross-origin mutation returns 403; cron routes without the secret return 401.
2. Eight parallel logins succeed (rate limit allows 10 per 15 minutes).
3. A legacy `state.json` snapshot is migrated once into per-record objects plus a migration marker.
4. The SEO dashboard returns an empty state (`totals: null`) before any scan; GitHub and Vercel report "not configured".
5. Publishing to unverified sites fails per site; after verifying two sites, a three-site publish returns `published, published, failed`.
6. SEO-page content is not injected into the homepage slot; it is listed under `/rehber/`, has a canonical URL and a `BreadcrumbList`, and appears in the sitemap.
7. Deleting from one site leaves the other live; a stale version gets 409; a withdrawn SEO page returns 404 publicly but stays in the admin list.
8. Form flow: token, consent required, idempotent resubmission (one stored submission), 410 after withdrawal, full delete removes the object from storage while submissions remain.
9. Scheduled content is hidden until its time, then visible without any write (the test moves `scheduledAt` into the past directly in the fixture).
10. Demo AI output is rejected by `/api/publish`; an out-of-catalogue site id is rejected.
11. AI generation is recovered by fingerprint and by generation id with identical results; repeating `/api/publish` with the same publication id creates exactly one publication.
12. Parallel creates all persist; a racing withdraw and delete on the same version yield exactly one 200 and one 409.
13. When Blob reads fail, the public feed fails closed with 503; no submitted personal data appears in public feeds.

Set `ROI_QA_KEEP=1` to keep the server running on port 3210 after the assertions for manual inspection.

## Coding conventions

Observed in the codebase and expected in contributions:

- **Turkish UI, English code.** User-visible strings, including API error messages, are Turkish. Identifiers, comments, types and log prefixes (`[storage]`, `[api/automation]`) are English.
- **Errors are `ApiError`.** Throw `new ApiError("<Turkish message for the user>", status)` for anything the user should see (default status 400). Routes end with `catch (error) { return apiFailure(error); }`; unknown errors become a generic 500 without internals. `StorageBusyError` (409) is reserved for repeated compare-and-swap losses and is the only error `retryStorageBusy()` retries.
- **One object per record.** Every entity is its own Blob object under `roistation-master/…` (`blobPaths` in `lib/blob-store.ts`). There is no shared snapshot. Pick the write primitive deliberately: `createJson` (create-only, idempotent inserts), `replaceJson` (compare-and-swap with an ETag), `overwriteJson` (last-write-wins, only for independent observations such as connection checks and rate counters), `deleteJson`.
- **Validate everything read from storage.** Each record type has a `parse*` function in `lib/records.ts` (or next to its store, for example `parseSiteRecord`, `parseScan`) that returns `null` for anything malformed and checks that the id matches the object path. `readJson(pathname, parser)` turns `null` into `CorruptDocumentError`.
- **Validate everything from requests.** Types are not trusted at the boundary: ids are matched against regular expressions (`/^[0-9a-f-]{36}$/i` for UUIDs, `/^[a-z0-9-]{2,60}$/` for site ids), strings are length-limited, site ids are checked against the live catalogue (`validateSiteIds()`).
- **Idempotency by client-generated ids.** Creates accept a client UUID so retries return the existing record instead of duplicating it.
- **No invented data.** Business contact data comes only from configuration; scores come only from measurements; unmeasurable checks are `skip`.
- **`Cache-Control: no-store`** on API responses that carry live state.
- **Minimal runtime dependencies.** HTML parsing, the GitHub client, the Vercel client and scheduling are small in-house modules. Add a dependency only when writing it yourself would be riskier.
- **Formatting.** No linter or formatter is configured in `package.json`. Older modules (for example `lib/publication-service.ts`) use a dense style; newer modules (`lib/seo/*`, `lib/publishing/*`) use conventional formatting. Match the style of the file you are editing.

## Adding a publish location, strategy or channel

See [Publishing Engine: Locations, strategies and scopes](Publishing-Engine.md#locations-strategies-and-scopes) for how the registries are used.

**Strategy** (pure registry change):

1. Add an entry to `publishStrategies` in `lib/publishing/definitions.ts`. `satisfies Record<string, StrategyDefinition>` forces every field: `label`, `description`, `defaultLocation`, `pageType`, `schema`, `layout`, `homepageTeaser`, `preview`.
2. Keep `preview` truthful: each line must describe something the flags actually produce.
3. Nothing else is required: `PlacementFields`, validation (`isPublishStrategy`), the page model and the JSON-LD builder read the flags.

**Page location** (registry + connector):

1. Add an entry with `kind: "page"`, `pathPrefix` and `archiveName` to `publishLocations`.
2. Add route templates to the connector kit, modelled on `connectors/templates/app/rehber/[slug]/page.tsx` and `connectors/templates/app/rehber/page.tsx`, and widen `RoistationLocation` in `connectors/roistation/client.ts`.
3. Add the new dynamic route to `revalidatePath` in `connectors/templates/app/api/roistation/revalidate/route.ts`.
4. If the kit version changes, bump `ROISTATION_CONNECTOR_VERSION` in `connectors/roistation/version.ts`.

**Slot location:**

1. Add an entry with `kind: "slot"` to `publishLocations`.
2. Widen `SlotLocation` and `isSlotLocation()` in `lib/publishing/page-model.ts`, and the `location` parameter type of `RoistationSection` / `getRoistationSlot()` in the connector.

**Channel:**

1. Implement `PublishChannel` (`id`, `label`, `requiresConnection`, `evaluate(context) => ChannelOutcome`) in `lib/publishing/channels.ts` and register it in `publishChannels`.
2. `evaluate()` must be pure and per site: return an outcome, never throw for one site's problem.
3. `lib/publication-service.ts` currently calls `defaultChannel` directly. Selecting channels per publication requires storing the channel choice on the publication and dispatching in `createPublishedPublication()` and `operatePublication()`.

Then extend `scripts/integration.mjs` with a publish/withdraw round trip for the new behaviour.

## Adding an SEO check

1. **Define it** in `lib/seo/checks.ts` (`defs`): unique kebab-case `id`, Turkish `label`, `category`, `dimension` (`seo`, `geo` or `both`; this decides which score it affects), `weight`, `explanation`, `fix`.
2. **Evaluate it** in `scanSite()` (`lib/seo/scanner.ts`) in the matching section, using `result(id, status, finding, evidence?)`. Use `skip` with a reason when the input could not be measured or the check does not apply; never guess.
3. **Present it** in `lib/seo/presentation.ts`: add an `issueCatalog` entry (title, problem, benefit, impact, stars, minutes, fix kind, keywords) and add the id to the relevant `categoryDefs`. Without a catalogue entry the check falls back to a low-impact "guided" item.
4. **Critical?** Only access problems belong in `CRITICAL_CHECKS` (`lib/seo/scanner.ts`); also add the id to the `critical` condition in `result()` (`lib/seo/checks.ts`) so its priority matches, and add a plain-language reason to `criticalText`.
5. **Fixable?** Mark it `auto` only if `planFixes()` (`lib/seo/fixes.ts`) really creates or safely inserts something for it; otherwise add it to the `manualOnly` list so the PR explains it. Mark it `ai` only if publishing content can resolve it, and add a strategy mapping to `aiStrategy` in `components/seo/site-detail.tsx`.
6. **History.** Stored scans are immutable and are not re-scored. The first scan after the change is the first one with the new check, so its SEO/GEO scores may shift; the trend chart will show that step.

## Adding an API route

Routes follow one pattern. `app/api/seo/scan/route.ts` is a complete example:

```ts
// app/api/seo/scan/route.ts
import { requireAdmin } from "@/lib/admin";
import { ApiError, apiFailure } from "@/lib/database";
import { runScan } from "@/lib/seo/dashboard";
import { summarizeScan } from "@/lib/seo/store";

// One site per request (the panel analyses selected sites one by one). PageSpeed Insights can take ~30 s.
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { siteId?: unknown; reason?: unknown };
    if (typeof body.siteId !== "string" || !/^[a-z0-9-]{2,60}$/.test(body.siteId)) throw new ApiError("Site kimliği geçersiz.");
    const scan = await runScan(body.siteId, typeof body.reason === "string" ? body.reason.slice(0, 40) : "manual");
    return Response.json({ scan: summarizeScan(scan), siteId: scan.siteId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
```

Checklist:

- **Admin routes** call `await requireAdmin(request)` first. Passing `request` matters: for non-GET methods it also enforces the same-origin check. There is a single admin account and no role model; do not add per-route permission logic that implies otherwise.
- **Cron routes** call `requireCronSecret(request)` instead and are registered in `vercel.json` under `crons`.
- **Public routes** (consumed by client sites) validate every parameter, call `ensureSiteRegistry()` before `validateSiteIds()`, return only published data, and never include secrets or submissions.
- **Writes** go through a service function and are wrapped in `retryStorageBusy(() => …)` when they touch contended objects.
- **Long-running work** sets `export const maxDuration`; the existing ceiling is 60 seconds.
- **Responses** use `Response.json(…, { headers: { "Cache-Control": "no-store" } })`; errors use `apiFailure()`.
- **Test** the route in `scripts/integration.mjs`, including its 401/403 behaviour.

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Login page shows setup text; APIs return 503 "Yönetici girişi için PANEL_ADMIN_PASSWORD…" | Admin variables missing or secret shorter than 32 characters | Set `PANEL_ADMIN_PASSWORD` and a 32+ character `PANEL_SESSION_SECRET`, restart |
| 503 "Kalıcı kayıt için Vercel Storage bölümünden Private Blob deposunu…" | No Blob credentials | Set `BLOB_READ_WRITE_TOKEN` (local) or connect a private store to the Vercel project |
| 503 "Özel Vercel Blob deposuna erişilemedi…" | Store is public, token invalid or store unreachable | Use a **private** store and a valid token; check the server log line starting with `[storage]` |
| 403 "Geçersiz istek kaynağı." on every save | `Origin` does not match `MASTER_PUBLIC_URL` / Vercel URLs; or running locally with `VERCEL=1` | Set `MASTER_PUBLIC_URL` to the URL you use; unset `VERCEL` locally |
| 503 "MASTER_PUBLIC_URL değişkenine panelin HTTPS adresini ekle." | Verification or connector setup needs the panel's public HTTPS origin | Set `MASTER_PUBLIC_URL=https://…` |
| "Domain site için izinli değil…" when verifying | The site URL is not in the site's allowed hosts | Add the host to `SITE_ALLOWED_HOSTS_JSON` under the site id, or connect Vercel so project domains are allowed |
| 503 "SITE_ALLOWED_HOSTS_JSON geçersiz." | Invalid JSON in that variable | Fix or clear the value |
| `next build` succeeds but code has type errors | `typescript.ignoreBuildErrors: true` in `next.config.ts` | Run `npm run typecheck` (part of `npm run verify`) |
| Next.js crashes enumerating network interfaces in a container | Sandbox denies `os.networkInterfaces()` | Use `npm run dev:managed` |
| `smoke` / `test:integration` fail with "Next start timeout" or "Server exited" | No production build, or port 3210 in use | `npm run build` first; free port 3210 |
| Integration test fails on site ids or domains | Built with `NEXT_PUBLIC_ROISTATION_SITES` set | Rebuild with the variable unset (`env -u NEXT_PUBLIC_ROISTATION_SITES npm run build`) |
| AI returns 409 "Bu AI işlemi hâlâ hazırlanıyor…" | Same request already in progress | Wait, then use "Son kaydedilen AI sonucunu getir" (no credits used) |
| Panel shows "Vercel işlem süresi doldu…" | Function timeout; the write may still have completed | Reload the list before retrying; retries with the same id are idempotent |
| All performance checks are `skip` with "PageSpeed Insights kotası doldu…" | Shared PSI quota exhausted | Set `PAGESPEED_API_KEY` |
| Optimize returns 409 "Site bir Vercel projesine bağlı değil…" or "…GitHub reposuna bağlı değil" | Site not linked to a Vercel project with a GitHub repository | Connect Vercel, make sure the project is Git-connected to GitHub |
| Optimize returns 409 "Bu site için açık bir optimizasyon PR'ı var…" | Previous PR still open | Merge or close it; state refreshes on the next dashboard load |
| Withdrawn content still visible on a site for up to 30 s | Revalidation skipped: `ROISTATION_REVALIDATE_SECRET` missing, shorter than 32 characters or different on the site | Set the same secret on panel and site; install the kit's revalidate route |
| A publish target shows "Başarısız" with "Bağlantı kurulmadı…" | Site never verified | Verify it on the Sites screen ("Siteler"), then publish again; other sites are unaffected |
