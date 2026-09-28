# Deployment

ROIstation Master Panel is built for Vercel: storage is a private Vercel Blob store attached to the project, scheduled jobs are Vercel Cron, and deployment health comes from the Vercel REST API. This guide covers a production deployment of the panel, the configuration of its integrations, and the one-time setup on each client site.

![Deployment flow](diagrams/deployment-flow.svg)

## Contents

- [Requirements](#requirements)
- [1. Create the project](#1-create-the-project)
- [2. Attach a private Blob store](#2-attach-a-private-blob-store)
- [3. Environment variables](#3-environment-variables)
- [4. Site catalog](#4-site-catalog)
- [5. Cron jobs](#5-cron-jobs)
- [6. Vercel webhook (optional)](#6-vercel-webhook-optional)
- [7. Connect Vercel and GitHub](#7-connect-vercel-and-github)
- [Installing the connector kit on client sites](#installing-the-connector-kit-on-client-sites)
- [Security headers](#security-headers)
- [Production checklist](#production-checklist)
- [Rollback](#rollback)
- [Migration from legacy state.json](#migration-from-legacy-statejson)

## Requirements

| Item | Value |
|---|---|
| Runtime | Node.js `>=20.9.0` (`package.json` `engines`) |
| Framework | Next.js 16 (App Router), detected automatically (`vercel.json` sets `"framework": "nextjs"`) |
| Build command | `npm run build` |
| Storage | One **private** Vercel Blob store |
| Plan | Function duration of 60 seconds is used by several routes (`maxDuration = 60`), and two daily cron jobs are defined |

## 1. Create the project

Import the repository into Vercel. No custom build settings are needed.

Before the first production deployment, run the full local check:

```bash
npm ci
npm run verify   # build → typecheck → smoke → test:integration
```

`next.config.ts` sets `typescript.ignoreBuildErrors: true`, so a Vercel build does **not** fail on type errors. `npm run verify` runs `tsc --noEmit` separately; make it part of CI and treat it as the gate.

## 2. Attach a private Blob store

1. In the Vercel project: **Storage → Create → Blob**.
2. Choose **Private** access. Do not reuse a public media store; `lib/blob-store.ts` refuses to read from a store whose URLs are not `*.private.blob.vercel-storage.com`.
3. Connect the store to the project (at least the Production environment). Vercel adds `BLOB_STORE_ID` and provides `VERCEL_OIDC_TOKEN` to the functions automatically.
4. Redeploy so the functions see the new variables.

Use a separate private store for Preview deployments so previews never write production data.

The panel is ready for storage when:

```ts
// lib/blob-store.ts
export function storageConfigured() {return Boolean(process.env.BLOB_READ_WRITE_TOKEN || (process.env.BLOB_STORE_ID && process.env.VERCEL_OIDC_TOKEN));}
```

No schema setup is needed: objects are created on first write. The Settings screen reports `storageReady` from `GET /api/integration-status`.

## 3. Environment variables

Set these in **Project → Settings → Environment Variables**. Server variables are read at request time, but a change only reaches functions after a redeploy. Never prefix a secret with `NEXT_PUBLIC_`.

### Panel

| Variable | Required | Purpose |
|---|---|---|
| `PANEL_ADMIN_PASSWORD` | **yes** | Admin password |
| `PANEL_SESSION_SECRET` | **yes**, ≥ 32 chars | Signs sessions and form tokens; derives the keys for sealed Vercel/GitHub tokens. Rotating it logs everyone out and makes stored tokens unreadable ([Authentication.md](Authentication.md#secret-rotation)) |
| `MASTER_PUBLIC_URL` | **yes** | The panel's public HTTPS origin, e.g. `https://panel.roistation.example`. Used for the `Origin` allow-list, the widget snippet, the connector env vars and verification. Must be `https:` |
| `BLOB_STORE_ID` | yes (set by Vercel) | Private Blob store id; used with the managed `VERCEL_OIDC_TOKEN` |
| `BLOB_READ_WRITE_TOKEN` | fallback | Static Blob token for local development or an older project connection |
| `CRON_SECRET` | recommended, ≥ 16 chars | Authenticates Vercel Cron. Without it the cron endpoints return 401 |
| `ANTHROPIC_API_KEY` | optional | Enables Claude for AI drafts (tried first) |
| `ANTHROPIC_MODEL` | optional | Default `claude-sonnet-5`. Must be a model id the key can access |
| `ANTHROPIC_WORKSPACE_ID` | optional | Only for an Anthropic key scoped to several workspaces |
| `OPENAI_API_KEY` | optional | Fallback provider when no Anthropic key is set |
| `OPENAI_MODEL` | optional | Default `gpt-5.2` |
| `SITE_ALLOWED_HOSTS_JSON` | optional | Extra allowed hostnames per site id for verification and scans |
| `SITE_BUSINESS_JSON` | optional | Business data (phone, address, hours, geo, profiles, services) per site id for LocalBusiness schema and NAP boxes; nothing is invented when absent |
| `ROISTATION_REVALIDATE_SECRET` | recommended, ≥ 32 chars | Same value on the panel and every client site; enables instant cache purge on withdraw/delete |
| `VERCEL_TOKEN` | optional | Vercel PAT from the environment; takes precedence over a token connected in the panel |
| `VERCEL_TEAM_ID` | optional | Team scope for `VERCEL_TOKEN` |
| `PAGESPEED_API_KEY` | optional | Higher PageSpeed Insights quota for Core Web Vitals |
| `GITHUB_TOKEN` | optional | GitHub token from the environment; takes precedence over a token connected in the panel |
| `VERCEL_WEBHOOK_SECRET` | optional | Enables `POST /api/vercel/webhook` |
| `NEXT_PUBLIC_ROISTATION_SITES` | recommended | Site catalog JSON. Without it the fictional demo catalog is used. See [Site catalog](#4-site-catalog) |
| `NEXT_PUBLIC_ROISTATION_EXCLUDED_PROJECTS` | optional | Comma-separated Vercel project names never auto-imported, auto-verified or published to by default (an admin can still connect one explicitly) |

Every variable above is listed in `.env.example`, grouped by concern (admin access, storage, site catalog, content generation, cache purge, Vercel, SEO & GEO Center) with a comment per variable. It contains demo values only: `NEXT_PUBLIC_ROISTATION_SITES` is left empty with a commented `zeytinlik-restoran` example, and `SITE_ALLOWED_HOSTS_JSON` / `SITE_BUSINESS_JSON` are filled with demo data for `zeytinlik-restoran`. Replace or clear those two before a real deployment.

Variables provided by Vercel and read by the code: `VERCEL` (enables the `Secure` cookie and disables the localhost origin exception), `VERCEL_URL` and `VERCEL_PROJECT_PRODUCTION_URL` (added to the `Origin` allow-list), `VERCEL_OIDC_TOKEN` (Blob access). `GITHUB_API_URL` and `VERCEL_API_URL` override the API base URLs; they appear commented out in the "Testing only" section of `.env.example` and must stay unset in production.

### Client sites

Set on each client site's Vercel project (the SEO optimizer sets the first four automatically when it installs the kit and a Vercel token is connected):

| Variable | Required | Purpose |
|---|---|---|
| `ROISTATION_SITE_ID` | **yes** | The site id in the panel catalog, e.g. `zeytinlik-restoran` |
| `ROISTATION_MASTER_URL` | **yes** | The panel's HTTPS origin (same value as `MASTER_PUBLIC_URL`) |
| `ROISTATION_SITE_NAME` | optional | Reported by `/api/roistation/verify` |
| `ROISTATION_REVALIDATE_SECRET` | recommended | Same value as on the panel |
| `ROISTATION_SITE_URL` | optional | Forces canonical and Open Graph URLs to this origin |
| `ROISTATION_DISABLED` | optional | Presence of the **name** opts the project out of ROIstation entirely |

## 4. Site catalog

Client names and domains are not in source control. `lib/sites.ts` reads the catalog from `NEXT_PUBLIC_ROISTATION_SITES`, a JSON array:

```json
[
  {
    "id": "kiyi-dis",
    "name": "Kıyı Diş Kliniği",
    "project": "kiyi-dis-klinigi",
    "domain": "kiyidis.example",
    "sector": "Sağlık",
    "business": { "schemaType": "Dentist", "locality": "Urla", "region": "İzmir" }
  },
  {
    "id": "zeytinlik-restoran",
    "name": "Zeytinlik Restoran",
    "project": "zeytinlik-restoran",
    "domain": "zeytinlik.example",
    "sector": "Restoran",
    "color": "#ffb45e",
    "business": { "schemaType": "Restaurant", "locality": "Foça", "region": "İzmir" }
  }
]
```

| Field | Rules |
|---|---|
| `id` | Required, `^[a-z0-9-]{2,60}$`, unique. Never change it once content is published: publications, connections and scans are keyed by it |
| `name`, `domain` | Required. `domain` is normalised to a bare hostname |
| `project` | Vercel project name used to match the project; defaults to `id` |
| `sector`, `initials`, `color` | Display only; `color` must be `#rrggbb` |
| `business.schemaType` | schema.org type; defaults to `Organization` |

Invalid entries are skipped; invalid JSON falls back to the demo catalog and logs `[sites] NEXT_PUBLIC_ROISTATION_SITES is not valid JSON; using the demo catalog`.

Excluded projects:

```bash
NEXT_PUBLIC_ROISTATION_EXCLUDED_PROJECTS=roistation-master-panel,internal-forms
```

**Both variables are inlined at build time.** They are read by client components (the site pickers and the connection manager) and by server modules at import time, so Next.js bakes their values into the build. Changing either one requires a **redeploy**; editing the value in the dashboard alone has no effect on the running deployment. They contain names and domains only; never put credentials in them.

Sites discovered through the connected Vercel account are added at runtime (stored in Blob) and do not need to be in the catalog.

## 5. Cron jobs

`vercel.json`:

```json
{
  "framework": "nextjs",
  "crons": [
    { "path": "/api/cron/vercel-sync", "schedule": "13 3 * * *" },
    { "path": "/api/cron/seo-scan", "schedule": "41 4 * * *" }
  ]
}
```

| Job | Time (UTC) | Work |
|---|---|---|
| `vercel-sync` | 03:13 daily | Full Vercel sync, auto-import per policy, archive/restore, re-verify connections older than one hour |
| `seo-scan` | 04:41 daily | Re-scan up to 3 sites whose production deployment changed since their last scan |

Vercel sends `Authorization: Bearer <CRON_SECRET>` automatically when `CRON_SECRET` is set on the project. Crons run only on production deployments. You can trigger a job manually for testing:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" https://panel.roistation.example/api/cron/vercel-sync
```

## 6. Vercel webhook (optional)

The webhook keeps deployment status current right after each deploy instead of waiting for the panel's 2-minute poll or the daily cron.

1. In the Vercel team (or account) settings, open **Webhooks** and create a webhook.
2. URL: `<MASTER_PUBLIC_URL>/api/vercel/webhook`.
3. Events: deployment events (created, succeeded, ready, error, canceled, promoted) and project events (created, removed, renamed). Domain events are also handled.
4. Copy the signing secret Vercel shows into the panel's `VERCEL_WEBHOOK_SECRET` and redeploy.

Until `VERCEL_WEBHOOK_SECRET` is set, the endpoint answers 404. Invalid signatures return 401.

## 7. Connect Vercel and GitHub

### Vercel

Either set `VERCEL_TOKEN` (and `VERCEL_TEAM_ID` for a team) in the environment, or paste a Personal Access Token once in **Ayarlar** (Settings) or **Vercel & Deploy**. The panel validates it, asks for the scope when the token can access teams, stores it sealed in Blob and runs a full sync. Required access is listed in [Permissions.md](Permissions.md#vercel-personal-access-token).

After the first sync, every project in the scope appears in the Vercel overview. With the default auto-connect mode (`auto`), compatible projects are registered as sites and verified automatically. A project's Ready production deployment plus a reachable domain marks it "Bağlı · Doğrulandı" (connected · verified).

### GitHub

Needed only for SEO optimization pull requests. Create a **fine-grained** token for the client repositories with **Contents: read and write** and **Pull requests: read and write**, then set `GITHUB_TOKEN` or paste it in **Ayarlar → GitHub**. The client's Vercel project must be linked to its GitHub repository; the panel reads the repository and production branch from the Vercel project.

## Installing the connector kit on client sites

Verification of Vercel-hosted sites needs nothing on the site. The kit is what makes published content **visible** on the site.

### Next.js App Router sites

1. Copy `connectors/roistation/` to the site as `components/roistation/`. The templates import from `@/components/roistation/*`, so the site needs the `@/*` alias.
2. Copy `connectors/templates/app/rehber/` to `app/rehber/` (SEO pages at `/rehber/<slug>` and the `/rehber` archive). Pages render inside the site's own layout.
3. Blog: copy `connectors/templates/app/blog/` if the site has no blog; otherwise add the `getRoistationPage(slug, "blog")` fallback described in the template comments.
4. Sitemap: copy `connectors/templates/app/sitemap.ts` if the site has none; otherwise add `...(await roistationSitemapEntries())` to the existing array. Make sure `robots.txt` does not block `/rehber` or `/blog`.
5. Copy `connectors/templates/app/api/roistation/verify/route.ts` and `…/revalidate/route.ts` to the same paths.
6. In-page slots (server-rendered): `<RoistationSection />` on the homepage, `<RoistationSection location="service-page" path="/hizmetler/…" />` on a service page, `<RoistationSection location="footer" />` above the contact section.
7. Forms: add `connectors/roistation-slot.tsx` (`<RoistationSlot siteId="kiyi-dis" masterUrl="https://panel.roistation.example" />`) where the form should appear. Forms always render through the iframe so they submit from the panel origin.
8. Set the [client-site environment variables](#client-sites) and deploy.

Do not render the same location with both the widget and `RoistationSection`; the content would appear twice.

The SEO optimizer automates steps 1, 2 and 5 (plus a sitemap when the scan reports none) for App Router sites with an `@/*` alias when a scan finds content/GEO gaps, and sets the env vars on the Vercel project. It delivers the change as a pull request.

### Any HTML site

```html
<div data-roistation-site="zeytinlik-restoran"></div>
<script src="https://panel.roistation.example/widget.js" defer></script>
```

Optional attributes: `data-roistation-location="service-page"` or `"footer"`, and `data-roistation-path="/hizmetler/…"` for service pages. The script injects a sandboxed iframe to `/embed/<siteId>` and resizes it only on messages from the panel origin and that iframe. Non-Next.js sites cannot host `/rehber` pages; they can reference the panel sitemap from `robots.txt`:

```text
Sitemap: https://panel.roistation.example/api/site-sitemap?siteId=zeytinlik-restoran
```

The panel shows the exact snippet per site on the Sites screen (`GET /api/connections`, field `snippet`).

## Security headers

```ts
// next.config.ts
  async headers() {
    const baseline = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    return [
      { source: "/:path*", headers: baseline },
      // The admin panel is never framed. /embed/<site> stays frameable: client sites load it in an iframe.
      { source: "/", headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] },
    ];
  },
```

| Header | Paths | Purpose |
|---|---|---|
| `X-Content-Type-Options: nosniff` | all | Browsers must honour the declared content type (JSON stays JSON) |
| `Referrer-Policy: strict-origin-when-cross-origin` | all | Cross-origin requests (favicons, client sites) see only the panel origin, never a full panel URL |
| `X-Frame-Options: DENY` + `Content-Security-Policy: frame-ancestors 'none'` | `/` only | The admin panel cannot be framed (clickjacking). `/embed/<siteId>` is deliberately excluded because client sites load it in an iframe |

Also: `poweredByHeader: false` (no `X-Powered-By: Next.js`), `reactStrictMode: true`, `@vercel/blob` kept as an external server package, and the `connectors/` folder traced into the `/api/seo/optimize` function. API responses that carry state set `Cache-Control: no-store`. Type checking is a separate step (see [Create the project](#1-create-the-project)).

There is no site-wide Content-Security-Policy beyond `frame-ancestors` on `/`. Adding one is a reasonable hardening step; it must keep `/embed/*` frameable by client sites.

## Production checklist

- [ ] Private Blob store connected to Production (and a separate one to Preview); `storageReady: true` in Settings.
- [ ] `PANEL_ADMIN_PASSWORD` is long and unique; `PANEL_SESSION_SECRET` is 32+ random characters.
- [ ] `MASTER_PUBLIC_URL` equals the exact production origin (custom domain included); a mutation from the panel succeeds (no 403).
- [ ] `NEXT_PUBLIC_ROISTATION_SITES` contains the real catalog, and the build was redeployed after setting it.
- [ ] `CRON_SECRET` set (16+ characters); both cron jobs visible under **Settings → Cron Jobs**.
- [ ] `ROISTATION_REVALIDATE_SECRET` set to the same 32+ character value on the panel and every client site.
- [ ] Vercel connected; sync status `ok`; expected projects listed; excluded projects configured.
- [ ] `VERCEL_WEBHOOK_SECRET` set and a test delivery returns 200 (optional).
- [ ] GitHub token connected with Contents + Pull requests read/write on client repos only (optional).
- [ ] At least one AI key set, or accept demo mode (demo output cannot be published).
- [ ] `SITE_BUSINESS_JSON` filled for local businesses whose NAP should appear in schema.
- [ ] `npm run verify` passes on the commit being deployed.
- [ ] A test publication appears on a connected site and disappears after withdraw.
- [ ] Form submission works from a client site and appears in the inbox; export works.

## Rollback

**Panel code.** Use Vercel's instant rollback (promote a previous production deployment). Stored records keep their shape across releases: parsers in `lib/records.ts` accept documents written by newer code as long as the required fields are present, and newer fields are optional. Two cases need care:

- **Do not roll back to a deployment that predates the per-record storage layout** (one that still reads `v1/state.json`). The migration leaves `state.json` untouched, so such a deployment would read stale data and write to the old file. After migrating, do not route traffic to old deployments.
- **Environment variables are not versioned with deployments.** If a rollback accompanies a secret change, restore the old value too; rotating `PANEL_SESSION_SECRET` back and forth invalidates sealed tokens and sessions each time.

**Client-site changes.** Every code change the panel proposes is a pull request; revert it in GitHub like any other merge. Env vars written by the optimizer (`ROISTATION_*`) stay on the Vercel project until removed there.

**Content.** A wrong publication is withdrawn per site from the panel; with `ROISTATION_REVALIDATE_SECRET` configured, sites purge it immediately, otherwise within 30 seconds. Deletion is permanent (there is no undo), and the panel has no built-in backup of the Blob store; export form submissions regularly from the inbox.

## Migration from legacy state.json

Releases before the per-record layout stored everything in `roistation-master/v1/state.json`, later with some interim objects under `v1/connections/`, `v1/generations/` and `v1/rates/`. Migration is automatic and needs no manual step:

1. The first storage access on each new instance calls `ensureMigrated()`. If `roistation-master/migrations/state-json-v1.json` exists, nothing else happens.
2. Otherwise `lib/migration.ts` reads `state.json` and the interim objects, and queues one create-only copy per record: publications, submissions, connections (interim per-site files win over the snapshot), generations (the most final status wins), fingerprint pointers for completed generations, and rate buckets that are still active.
3. Objects that already exist in the new layout are skipped, so the copy never overwrites newer data and several instances can run it at once.
4. Copies run 12 at a time within a 25-second budget. If the budget runs out, the request returns 503 "Eski kayıtlar yeni depolama yapısına taşınıyor…" (records are being moved; no data is lost) and the next request continues where it stopped.
5. The marker is written last with the source (`state.json`, `v1-objects` or `none`) and per-type counts. From then on, legacy objects are never read again.

`state.json` is kept as a backup and can be deleted manually from the Blob dashboard once the migrated data has been checked. A corrupt `state.json` stops the migration with a 503 instead of silently skipping it.
