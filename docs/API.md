# API Reference

Every endpoint is a Next.js route handler under `app/api/**/route.ts`. There are 26 handler files. All responses are JSON unless stated otherwise, and user-facing messages are in Turkish because they are shown verbatim in the panel.

Examples use the fictional demo catalog from `lib/sites.ts` (`kiyi-dis`, `zeytinlik-restoran`, `liman-temizlik`, …) and `https://panel.roistation.example` as the panel origin.

## Contents

- [Conventions](#conventions)
- [Session](#session)
- [Sites & connections](#sites--connections)
- [Publishing](#publishing)
- [AI automation](#ai-automation)
- [Forms & submissions](#forms--submissions)
- [Public site APIs](#public-site-apis)
- [Vercel](#vercel)
- [GitHub](#github)
- [SEO & GEO](#seo--geo)
- [Cron & webhooks](#cron--webhooks)
- [Endpoints on client sites](#endpoints-on-client-sites)

## Conventions

### Authentication tiers

| Tier | How it is checked | Used by |
|---|---|---|
| **Admin** | `requireAdmin(request)` in `lib/admin.ts`: signed `roi_admin` cookie; for any method other than `GET`/`HEAD`, also `requireSameOrigin` | All panel endpoints |
| **Same-origin public** | `requireSameOrigin(request)` only | Login, logout, form submission |
| **Public** | None | Site content APIs, form token |
| **Cron** | `requireCronSecret(request)`: `Authorization: Bearer <CRON_SECRET>` | `/api/cron/*` |
| **Webhook** | HMAC-SHA1 of the raw body with `VERCEL_WEBHOOK_SECRET`, header `x-vercel-signature` | `/api/vercel/webhook` |

Admin endpoints return:

| Status | When |
|---|---|
| 503 | `PANEL_ADMIN_PASSWORD` is missing or `PANEL_SESSION_SECRET` is shorter than 32 characters |
| 401 | No valid session cookie |
| 403 | Mutating request whose `Origin` header is not an allowed panel origin |

See [Authentication.md](Authentication.md) for the details of each check.

### Error format

Errors are produced by `apiFailure()` in `lib/errors.ts`:

```ts
// lib/errors.ts
export function apiFailure(error:unknown) {
  return Response.json({error:error instanceof ApiError ? error.message : "İşlem tamamlanamadı."},{status:error instanceof ApiError ? error.status : 500,headers:{"Cache-Control":"no-store"}});
}
```

```http
HTTP/1.1 409 Conflict
Content-Type: application/json
Cache-Control: no-store

{ "error": "Yayın başka bir işlemle değişti. Listeyi yenile." }
```

- The body is always `{ "error": string }`. Only messages from `ApiError` are exposed; any other exception becomes `500 {"error":"İşlem tamamlanamadı."}`.
- Validation errors use 400 unless stated otherwise.
- Storage problems (`lib/blob-store.ts`) surface as 503 with an actionable message (store not linked, Blob rate-limited, timeout, corrupt document). A document over 4 MB is rejected with 413.
- Exceptions to the helper: `POST /api/extract` returns its own 400/413 bodies (same shape), and `POST /api/automation` maps provider failures to 502 with the provider error message.

### Common status codes

| Status | Meaning in this API |
|---|---|
| 400 | Invalid input |
| 401 | Not authenticated (admin, cron, webhook signature, GitHub/Vercel token rejected) |
| 403 | Wrong origin, expired form token, missing GitHub write permission |
| 404 | Record not found, form not published, page not published |
| 409 | Version conflict, reused id with different content, operation already running |
| 410 | Form withdrawn |
| 413 | Upload or document too large |
| 429 | Rate limit exceeded |
| 502 | Upstream AI provider or GitHub failure |
| 503 | Admin, storage or a required secret is not configured, or storage is unavailable |

### Identifiers

| Identifier | Format |
|---|---|
| Site id | `^[a-z0-9-]{2,60}$`, must exist in the live site list |
| Publication, generation, submission id | UUID, checked with `^[0-9a-f-]{36}$` (case-insensitive) |
| Vercel project / team id | `^[A-Za-z0-9_-]{3,80}$` |
| Slug | `^[a-z0-9]+(?:-[a-z0-9]+)*$`, up to 120 characters |

### Rate limits

| Endpoint | Key | Limit |
|---|---|---|
| `POST /api/session` | `login:<HMAC(client IP)>` | 10 requests per 15 minutes |
| `POST /api/submissions` | `form:<HMAC(client IP)>` | 10 requests per hour |

Limits are stored in the Blob store (`lib/rate-limit-storage.ts`) and are best effort: when storage is not configured or fails, the request is allowed. No other endpoint is rate-limited by the panel.

---

## Session

### `GET /api/session`

Public. Reports whether the admin is configured and whether the caller has a valid session.

```json
{ "configured": true, "authenticated": false }
```

### `POST /api/session`

Public, same-origin, rate-limited (10 per 15 minutes per IP).

```http
POST /api/session
Origin: https://panel.roistation.example
Content-Type: application/json

{ "password": "…" }
```

```http
HTTP/1.1 200 OK
Set-Cookie: roi_admin=<expires>.<hmac>; Path=/; Max-Age=28800; HttpOnly; Secure; SameSite=Strict

{ "authenticated": true }
```

| Status | Reason |
|---|---|
| 503 | Admin not configured |
| 403 | `Origin` not allowed |
| 429 | Too many attempts |
| 401 | Wrong password (`"Parola yanlış."`) |

### `DELETE /api/session`

Same-origin. Deletes the cookie and returns `{ "authenticated": false }`. No session is required.

---

## Sites & connections

### `GET /api/sites`

Admin. Forces a refresh of the imported-site registry and returns the live list plus archived imported sites.

```json
{
  "sites": [
    { "id": "kiyi-dis", "name": "Kıyı Diş Kliniği", "project": "kiyi-dis-klinigi", "domain": "kiyidis.example",
      "sector": "Sağlık", "initials": "KD", "color": "#63d7ff", "vercel": "READY", "connector": "pending",
      "business": { "schemaType": "Dentist", "locality": "Urla", "region": "İzmir" } }
  ],
  "archived": []
}
```

### `GET /api/connections`

Admin. One entry per live site with the stored verification result, the embed snippet and the linked Vercel project summary.

```json
{
  "connections": [{
    "siteId": "zeytinlik-restoran",
    "siteName": "Zeytinlik Restoran",
    "project": "zeytinlik-restoran",
    "domain": "zeytinlik.example",
    "siteUrl": "https://zeytinlik.example",
    "connection": { "site_id": "zeytinlik-restoran", "verified": true, "status": "connected", "method": "vercel", "connectorState": "installed", "…": "…" },
    "snippet": "<div data-roistation-site=\"zeytinlik-restoran\"></div>\n<script src=\"https://panel.roistation.example/widget.js\" defer></script>",
    "vercel": { "projectId": "prj_…", "liveStatus": "connected", "productionUrl": "https://zeytinlik.example", "deploymentState": "READY", "…": "…" }
  }]
}
```

`connection` is `null` for a site that was never verified; `vercel` is `null` when no project record matches.

### `POST /api/connections`

Admin, same-origin. Runs the unified verification (`verifySite` in `lib/verification.ts`) for one site and stores the result.

```json
{ "siteId": "zeytinlik-restoran", "siteUrl": "https://zeytinlik.example" }
```

Response: `{ "connection": Connection }`. `siteUrl` must be HTTPS on port 443 and its host must be allowed for that site (profile domain, `www.` variant, `SITE_ALLOWED_HOSTS_JSON`, or a domain reported by the linked Vercel project); otherwise 400 `"Domain site için izinli değil. …"`. Redirects are followed manually and re-checked against the same allow-list. `MASTER_PUBLIC_URL` must be an HTTPS URL, otherwise 503.

### `GET /api/dashboard`

Admin. Overview counters.

```json
{ "connected": 5, "published": 12, "scheduled": 2, "failed": 1,
  "events": [{ "at": "2026-09-20T09:12:00.000Z", "action": "published", "siteIds": ["kiyi-dis"], "title": "…" }] }
```

`events` is the last three events of every publication, newest eight overall.

### `GET /api/integration-status`

Admin. Settings screen status. Never returns key values.

```json
{
  "anthropic": { "connected": true, "model": "claude-sonnet-5" },
  "openai": { "connected": false, "model": "gpt-5.2" },
  "activeProvider": "anthropic",
  "storageProvider": "vercel-blob-private",
  "storageConfigured": true,
  "storageReady": true,
  "connectedSites": 5
}
```

---

## Publishing

A publication is `{ id, version, document }` where `document` holds `title`, `kind` (`content` | `form`), `targets` (one per site: `status`, `payload`, `detail`, `scheduledAt`, `slug`), `events` (history, last 200) and `placement` (`location`, `strategy`, `servicePath`). Target statuses are `draft`, `published`, `scheduled`, `withdrawn`, `deleted`, `failed`. See [Publishing-Engine.md](Publishing-Engine.md) for the model.

### `GET /api/publications?kind=&page=`

Admin. `kind` is `content` or `form` (anything else lists both). `page` is zero-based, 100 rows per page, newest `updatedAt` first. Publications deleted from every target are never listed.

```json
{ "publications": [ { "id": "…", "version": 3, "document": { "…": "…" } } ] }
```

### `POST /api/publications`

Admin, same-origin. Creates a draft on the selected sites.

```json
{
  "id": "5f0c1e0a-6a53-4f9b-9d57-0d7f3c1b2a10",
  "title": "Urla'da implant tedavisi",
  "kind": "content",
  "siteIds": ["kiyi-dis"],
  "payload": { "title": "Urla'da implant tedavisi", "body": "…", "summary": "…", "metaTitle": "…", "metaDescription": "…" },
  "placement": { "location": "seo-page", "strategy": "seo-geo" },
  "slugs": { "kiyi-dis": "urla-implant-tedavisi" }
}
```

| Field | Notes |
|---|---|
| `id` | Optional UUID. Repeating the same id with the same content returns the stored row; with different content, 409 |
| `kind` | `"form"` or anything else (treated as `"content"`) |
| `payload` or `variants` | `variants` is a map of site id → payload and wins over `payload` per site |
| `payload.title` / `body` | ≤ 200 / ≤ 40 000 characters; `body` required for content |
| `payload.fields` | Forms only: 1–20 fields `{ id, label, type: text|email|tel|textarea, required }` |
| `payload.consentText` | Forms only, required, ≤ 2 000 characters |
| `placement` | Content only. `location`: `seo-page` (default), `homepage`, `blog`, `service-page`, `footer`. `strategy`: `seo` (default), `seo-geo`, `local-business`, `blog`, `homepage-enhancement`, `ai-answer`. `servicePath` for `service-page` |
| `slugs` | Optional per-site slug; must be unique on that site (409 otherwise). When omitted, a slug is derived from the title with Turkish transliteration |

Response: `201 { "publication": PublicationRow }`.

### `PATCH /api/publications`

Admin, same-origin. Operates on a stored publication.

```json
{ "id": "5f0c1e0a-…", "version": 1, "action": "publish", "siteIds": ["kiyi-dis", "liman-temizlik"], "scheduleAt": "2026-10-01T07:00:00.000Z" }
```

| Field | Notes |
|---|---|
| `version` | Required; must equal the stored version, else 409 |
| `action` | `publish`, `withdraw`, `delete`, or `edit` (change placement/slugs of content) |
| `siteIds` / `all` / `scope` | `all: true` or `scope: "all-connected"` targets every non-deleted target; `scope: "current"` requires exactly one site |
| `scheduleAt` | Publish only; must be in the future |
| `placement`, `slugs` | Publish (content) and edit |

Response:

```json
{
  "publication": { "id": "5f0c1e0a-…", "version": 2, "document": { "…": "…" } },
  "results": [
    { "siteId": "kiyi-dis", "success": true, "status": "scheduled", "detail": "Zamanlı merkezi yayına alındı. …" },
    { "siteId": "liman-temizlik", "success": false, "status": "failed", "detail": "Bağlantı kurulmadı. Siteler ekranından yayın alanını doğrula." }
  ]
}
```

Withdraw and delete responses also include `removed` (true when the publication was deleted from every target and removed from storage) and `revalidation` (`[{ siteId, ok, skipped? }]` from the client-site cache purge). A publish never fails as a whole because one site is not ready; read `results` per site.

### `POST /api/publish`

Admin, same-origin. Creates **and publishes** a content publication from approved AI drafts in one step (the AI automation screen).

```json
{
  "publicationId": "8e1d2b7c-…",
  "mode": "anthropic",
  "generationId": "2b8f5c7e-…",
  "title": "Foça'da balık restoranı rehberi",
  "siteIds": ["zeytinlik-restoran"],
  "payload": [{ "siteId": "zeytinlik-restoran", "title": "…", "summary": "…", "body": "…", "metaTitle": "…", "metaDescription": "…" }],
  "placement": { "location": "seo-page", "strategy": "local-business" },
  "scope": "selected"
}
```

- Demo output is rejected with 400 and never published. The check is server-side: when `generationId` is a UUID, the route loads the stored generation (`getGeneration()`) and refuses it if its recorded `mode` is `"demo"`. The client-reported `mode: "demo"` is also refused, but only as a fast path; it is not what the guard relies on.
- `publicationId` is required and makes the call idempotent.
- Target sites are re-verified if their last check is older than two minutes.

Response: `{ "publication": PublicationRow, "results": ChannelOutcome[] }`.

---

## AI automation

### `POST /api/extract`

Admin, same-origin. `multipart/form-data` with one or more `files` fields.

| Limit | Value |
|---|---|
| Files per request | 30 |
| Size per file / total | 8 MB / 24 MB (413 when exceeded) |
| Converted to text | `txt`, `md`, `markdown`, `csv`, `json`, `html` as UTF-8; `docx` via `mammoth` |
| Other types | Returned with an empty `text` and a warning |

```json
{ "combinedText": "--- menu.docx ---\n…", "files": [{ "name": "menu.docx", "text": "…", "warning": "Bazı biçimlendirmeler metne çevrilmedi." }] }
```

### `POST /api/automation`

Admin, same-origin, `maxDuration = 60`. Generates one draft per selected site. Anthropic is used when `ANTHROPIC_API_KEY` is set, otherwise OpenAI, otherwise demo mode.

```json
{
  "generationId": "2b8f5c7e-…",
  "sourceText": "Kliniğimiz Urla'da …",
  "fileNames": ["hizmetler.docx"],
  "contentType": "SEO makalesi",
  "goal": "İmplant tedavisi hakkında rehber",
  "siteIds": ["kiyi-dis"]
}
```

```json
{
  "mode": "anthropic",
  "results": [{ "siteId": "kiyi-dis", "title": "…", "summary": "…", "body": "…", "metaTitle": "…", "metaDescription": "…",
                "seoScore": 86, "geoScore": 82, "checks": ["…"], "status": "review" }],
  "usage": { "input_tokens": 1834, "output_tokens": 2710 },
  "generationId": "2b8f5c7e-…",
  "recovered": false
}
```

- `sourceText` is required, 1–100 000 characters.
- A request whose content fingerprint (SHA-256 of source, file names, content type, goal and sorted site ids) matches a completed generation returns that result with `recovered: true` and no provider call.
- `seoScore` and `geoScore` are editorial estimates from the model, clamped to 0–100. They are not measurements; measured scores come from the SEO & GEO Center.

| Status | Reason |
|---|---|
| 409 | Same `generationId` with different content; the generation is still pending; or the previous attempt with this id failed |
| 502 | Provider error, unreadable provider response, or results that do not match the requested sites |
| 503 | Blob storage unavailable (no provider call is made) |

### `GET /api/automation?generationId=`

Admin. Recovers a generation after a timeout or reload.

| Stored status | Response |
|---|---|
| `pending` | `202 { "status": "pending", "error": "AI işlemi hâlâ hazırlanıyor." }` |
| `complete` | `200 { "status": "complete", "mode", "results", "usage", "generationId", "recovered": true }` |
| `failed` | `409 { "error": "AI işlemi başarısız: …" }` |
| missing | `404` |

---

## Forms & submissions

### `GET /api/form-token?id=&siteId=`

Public. Returns a signed token for a form that is currently published on that site.

```json
{ "token": "1790000000000.4f3c…e9" }
```

The token is `<expires>.<HMAC-SHA256>` bound to the publication id, the site id and an expiry one hour ahead. 503 when `PANEL_SESSION_SECRET` is not set; 404 when the form is not published on that site.

### `POST /api/submissions`

Public, same-origin, rate-limited (10 per hour per IP). Called from the `/embed/<siteId>` iframe, which runs on the panel origin.

```json
{
  "id": "c4a1…",
  "publicationId": "5f0c1e0a-…",
  "siteId": "kiyi-dis",
  "token": "1790000000000.4f3c…e9",
  "answers": { "name": "…", "email": "…" },
  "consent": true,
  "website": ""
}
```

| Status | Reason |
|---|---|
| 201 | `{ "ok": true }`; also returned for a retry with the same `id` |
| 400 | Honeypot `website` filled, consent missing, invalid or missing field (answers ≤ 4 000 characters, e-mail format for `email` fields) |
| 403 | Wrong origin, or token missing / expired / invalid |
| 409 | The form changed while submitting |
| 410 | The form was withdrawn (also when the withdrawal lands during the write) |
| 429 | Rate limit |

### `GET /api/submissions?page=&siteId=`

Admin. `{ "submissions": Submission[] }`, 100 per page, newest first. A submission is `{ id, publication_id, site_id, answers, consent_at, consent_text, created_at }`.

### `DELETE /api/submissions`

Admin, same-origin. Body `{ "id": "<uuid>" }`. Returns `{ "ok": true }`.

### `GET /api/submissions/export`

Admin. Every submission as a JSON attachment (`Content-Disposition: attachment; filename=roistation-form-talepleri.json`).

```json
{ "exportedAt": "2026-09-27T10:00:00.000Z", "submissions": [ … ] }
```

---

## Public site APIs

Read-only, unauthenticated, `Cache-Control: no-store`. They only return content whose target on that site is currently published (or scheduled with a time in the past). Unknown site ids return 400. Client sites cache these responses themselves (the connector kit uses ISR with a 30-second window).

### `GET /api/site-content?siteId=&location=&path=`

In-page slot items. `location` is `homepage` (default), `service-page` (with `path`, e.g. `/hizmetler/dis-cephe`) or `footer`.

```json
{
  "items": [
    { "id": "…", "kind": "content", "payload": { "title": "…", "body": "…", "summary": "…" }, "display": "collapsible" },
    { "id": "…", "kind": "content", "payload": { "title": "…", "body": "…" }, "display": "teaser",
      "teaser": { "intro": "…", "highlights": ["…"], "url": "https://kiyidis.example/rehber/urla-implant-tedavisi", "cta": "Devamını oku" } },
    { "id": "…", "kind": "form", "payload": { "title": "…", "body": "…", "fields": [ … ], "consentText": "…" } }
  ]
}
```

Content whose primary location is a page (SEO page or blog) is not injected into the homepage; the `homepage-enhancement` strategy adds a teaser instead. Forms appear in the homepage slot.

### `GET /api/site-pages?siteId=&location=`

Published pages of a site, newest first. `location` is optional and must be a page location (`seo-page` or `blog`).

```json
{ "pages": [{ "id": "…", "slug": "urla-implant-tedavisi", "path": "/rehber/urla-implant-tedavisi",
  "url": "https://kiyidis.example/rehber/urla-implant-tedavisi", "location": "seo-page", "strategy": "seo-geo",
  "title": "…", "excerpt": "…", "publishedAt": "…", "updatedAt": "…" }] }
```

### `GET /api/site-page?siteId=&slug=&location=`

Render-ready model of one page: summary fields plus `h1`, `metaTitle`, `metaDescription`, `blocks`, `toc`, `faq`, `sections` (short answer, key facts, area served, NAP), `breadcrumbs`, `archive`, `related`, `relatedServices`, `seo` (canonical, robots, Open Graph, Twitter) and `jsonLd` (`@graph`). 404 when the slug is invalid or not published. The TypeScript shape is `RoistationPage` in `connectors/roistation/client.ts`.

### `GET /api/site-sitemap?siteId=`

`application/xml` sitemap of the site's published pages, for sites that cannot host the connector's `app/sitemap.ts`:

```text
Sitemap: https://panel.roistation.example/api/site-sitemap?siteId=zeytinlik-restoran
```

### `GET /embed/<siteId>?location=&path=`

Not an API route, but public: a `noindex` HTML page rendered by `app/embed/[siteId]/page.tsx` for the iframe widget. It is intentionally frameable; only `/` sends `X-Frame-Options: DENY`.

---

## Vercel

### `GET /api/vercel`

Admin. Read model for the Vercel screen, built from stored records only (no Vercel API call): `configured`, `source` (`env` | `panel`), `account`, `team`, `teamId`, `projectCount`, `lastSyncAt`, `lastDeploymentCheckAt`, `syncState`, `settings`, `counts`, `projects`, `latestDeployments`, `queue`, `pending`, `events`. The token is never returned.

### `POST /api/vercel`

Admin, same-origin, `maxDuration = 60`. Body `{ "action": … }`.

| Action | Body | Effect / response |
|---|---|---|
| `connect` | `{ token, teamId? }` | Validates the token (`/v2/user`), saves it sealed, runs a full sync. If the token can access teams and no `teamId` was chosen, returns `{ ok: false, needsTeam: true, account, teams }`. Pass `teamId: "personal"` for the personal scope. 400 when `VERCEL_TOKEN` is set in the environment; 401 for a rejected token |
| `disconnect` | — | Deletes the stored token. Sites, publications and history are kept |
| `sync` | `{ reason?, full? }` | `full: false` checks projects and deployments only; default is a full sync. Returns `{ ok, sync, overview }`; `sync.skipped` is `"running"` when another sync holds the lock |
| `connect-project` | `{ projectId }` | Registers the project as a site (or links it to a matching built-in site) and verifies it. Returns `{ ok, siteId, connection, overview }` |
| `ignore-project` | `{ projectId }` | Adds the project to the ignored list |
| `import-all` | — | Connects every compatible, unlinked, non-excluded, non-archived project. Returns per-project `results` |
| `settings` | `{ autoConnect: "disabled" | "ask" | "auto" }` | Updates the auto-connect policy |

Unknown actions return 400 `"İşlem geçersiz."`.

---

## GitHub

### `GET /api/github`

Admin. `{ "configured": true, "source": "panel", "login": "…" }`. `source` is `env` when `GITHUB_TOKEN` is set.

### `POST /api/github`

Admin, same-origin.

| Body | Effect |
|---|---|
| `{ "action": "connect", "token": "github_pat_…" }` | Checks the token format (`gh[pousr]_…` or `github_pat_…`), calls `GET /user`, stores the token sealed. 400 if `GITHUB_TOKEN` is set in the environment; 401 if GitHub rejects the token |
| `{ "action": "disconnect" }` | Deletes the stored token; returns the remaining configuration (the environment token, if any) |

---

## SEO & GEO

All admin. See [SEO-Engine.md](SEO-Engine.md) and [GEO-Engine.md](GEO-Engine.md) for the checks and scoring.

### `GET /api/seo`

Portfolio dashboard from stored scans only. Refreshes the state of open optimization pull requests.

```json
{
  "sites": [{ "siteId": "kiyi-dis", "name": "Kıyı Diş Kliniği", "domain": "kiyidis.example", "origin": "https://kiyidis.example",
    "improvements": 7, "autoFixable": 4, "ignored": 1, "criticalReasons": [], "latest": { "id": "…", "scannedAt": "…", "scores": { "seo": 78, "geo": 64, "…": null } },
    "previous": null, "scans": 3, "deployment": { "id": "dpl_…", "state": "READY", "createdAt": "…" }, "rescanNeeded": false,
    "repository": { "provider": "github", "repo": "…", "branch": "main" }, "optimization": null }],
  "totals": { "scanned": 1, "seo": 78, "geo": 64, "schema": 70, "metadata": 85, "performance": 61, "issues": 7, "autoFixable": 4, "lastScanAt": "…" },
  "github": { "configured": true, "source": "panel", "login": "…" },
  "pageSpeedKey": false
}
```

`totals` is `null` until at least one site has been scanned; the API never returns sample scores.

### `POST /api/seo/scan`

`maxDuration = 60`. Body `{ "siteId": "kiyi-dis", "reason": "manual" }` (`reason` optional, ≤ 40 characters). Scans one site and appends the result to its history.

```json
{ "siteId": "kiyi-dis", "scan": { "id": "…", "scannedAt": "…", "scores": { … }, "issues": 7, "critical": 0, "deploymentId": "dpl_…", "reason": "manual", "durationMs": 31840 } }
```

### `GET /api/seo/report?siteId=`

Latest full scan, up to 12 scan summaries, the open finding ids of each scan (`checkHistory`), ignored finding ids and the latest optimization record. 404 when the site has no scan yet.

### `POST /api/seo/ignore`

Body `{ "siteId": "kiyi-dis", "checkId": "llms-txt", "ignored": true }` (`ignored` defaults to `true`; send `false` to restore). `siteId` must match the site-id pattern and exist in the live site registry (`ensureSiteRegistry()`, catalogue plus imported sites); `checkId` must exist in the check catalogue. Either failure is a 400. Response: `{ "ignored": ["llms-txt"] }`.

### `POST /api/seo/optimize`

`maxDuration = 60`. Body `{ "siteId": "kiyi-dis", "checkIds": ["sitemap", "llms-txt"] }`. `checkIds` is optional (default: every open, non-ignored finding), at most 40.

```json
{ "record": { "siteId": "kiyi-dis", "status": "open", "repo": "…", "baseBranch": "main", "branch": "roistation/seo-202609271015",
  "prNumber": 42, "prUrl": "https://github.com/…/pull/42", "applied": [ … ], "manual": [ … ], "env": [ … ] },
  "message": "PR #42 açıldı: 3 dosya. …" }
```

| Status | Reason |
|---|---|
| 409 | No scan yet; site not linked to a Vercel project; project not linked to GitHub; GitHub not connected; an optimization PR for this site is still open; any other GitHub 4xx (for example an expired token or a missing scope) |
| 403 | The repository reports `permissions.push === false` for the token |
| 404 | Repository or branch not found, or not visible to the token |
| 502 | GitHub 5xx |

When no change can be automated, a `closed` record is stored and the message lists the manual items.

---

## Cron & webhooks

### `GET /api/cron/vercel-sync`

Cron (`Authorization: Bearer <CRON_SECRET>`; 401 if the secret is missing, shorter than 16 characters, or wrong). Scheduled daily at 03:13 UTC.

```json
{ "ok": true,
  "sync": { "status": "ok", "discovered": 9, "imported": 0, "archived": 0, "skipped": null },
  "verified": [{ "siteId": "kiyi-dis", "verified": true }, { "siteId": "liman-temizlik", "skipped": true }] }
```

### `GET /api/cron/seo-scan`

Cron. Scheduled daily at 04:41 UTC. Re-scans up to three sites whose production deployment changed since their last scan.

```json
{ "ok": true, "rescanned": [{ "siteId": "zeytinlik-restoran", "ok": true }] }
```

### `POST /api/vercel/webhook`

Webhook. Signed by Vercel with `VERCEL_WEBHOOK_SECRET`.

```http
POST /api/vercel/webhook
x-vercel-signature: 5d41402abc4b2a76b9719d911017c592…
Content-Type: application/json

{ "type": "deployment.succeeded", "payload": { … } }
```

| Status | Body |
|---|---|
| 200 | `{ "ok": true, "ignored": "<type>" }` for events outside `deployment.(created|succeeded|ready|error|canceled|promoted)`, `project.(created|removed|renamed)` and `domain.*` |
| 200 | `{ "ok": true, "status": "ok", "skipped": null }` after a sync (light for deployments, full for project/domain events) |
| 404 | `VERCEL_WEBHOOK_SECRET` not configured |
| 401 | Signature missing or invalid |
| 400 | Body is not JSON |

---

## Endpoints on client sites

These are not served by the panel. They are part of the connector kit (`connectors/templates/app/api/roistation/`) and are called **by** the panel.

### `GET <site>/api/roistation/verify`

Public, read-only. Reports whether `ROISTATION_SITE_ID` and `ROISTATION_MASTER_URL` are set, without exposing secrets.

```json
{ "connected": true, "siteId": "zeytinlik-restoran", "siteName": "Zeytinlik Restoran", "version": "3.0.0",
  "lastSeen": "…", "environment": "production",
  "capabilities": ["verify", "seo-pages", "blog", "sections", "sitemap", "revalidate"], "revalidate": true }
```

### `POST <site>/api/roistation/revalidate`

Protected by `x-roistation-secret` (must equal the site's `ROISTATION_REVALIDATE_SECRET`, at least 32 characters; compared in constant time). Body `{ "paths": ["/", "/sitemap.xml", "/rehber", "/rehber/urla-implant-tedavisi"] }` (up to 50 paths). Expires the `roistation` fetch tag and revalidates the given paths plus `/rehber/[slug]` and `/blog/[slug]`. Returns `{ "ok": true, "revalidated": 4 }` or `401 { "ok": false }`.
