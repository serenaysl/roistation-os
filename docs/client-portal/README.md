# Client Portal & Automatic Rank Tracking

The customer-facing part of ROIstation Master Panel. The **Client Portal** (introduced in 2.5.0) gives each customer a private dashboard for their own website. The **Automatic Rank Tracker** (2.6.0) fills it with weekly Google rankings.

The panel and the demo screenshots use a Turkish interface. This document refers to every control by its English name.

> **Demo data.** All screenshots and numbers in this folder use a fictional business, *ROIstation Demo Hotel* (`demo-hotel.example`), with invented rankings. They illustrate the product, not the results of a real client, and no ranking improvement is guaranteed.

| Document | What it covers |
|---|---|
| This page | Concepts, feature status, admin workflow, data model, security |
| [advanced-analytics.md](advanced-analytics.md) | Metric definitions, formulas and worked examples |
| [demo-report.md](demo-report.md) | A complete sample monthly SEO / GEO report (demo data) |
| [`screenshots/`](screenshots/) | Demo visuals used in the main README |

---

## Master Panel vs Client Portal

```text
ROIstation Master Panel          agency / admin side
        ↓
SEO / GEO Operations             content, knowledge center, technical fixes
        ↓
Rank Tracking Provider           DataForSEO (Google organic, location + device)
        ↓
Ranking Snapshots                append-only, one per run, private Vercel Blob
        ↓
Client Portal                    /portal/<site-id>, access code, noindex
        ↓
Customer Dashboard               Top 3 / Top 10, movement, history
```

| | Master Panel | Client Portal |
|---|---|---|
| Who uses it | The agency | The agency's customer |
| Scope | Every registered site | Exactly one site |
| Sign-in | Admin password + panel session | Per-site access code + portal session |
| Can change anything | Yes: sites, publishing, fixes, portal and tracker settings | No, read-only |
| Shows technical details | Yes: Vercel, runtime, deployments, scans | No, a simplified performance view |

Customers never access the Master Panel. The portal session cookie is signed for one site id and scoped to `/portal/<site-id>`. It grants no panel rights and opens no other site.

---

## Feature status

| Status | Meaning |
|---|---|
| **Available** | Shipped in the current release (2.6.0) |
| **Preview** | Designed and shown in demo visuals. The underlying data is already stored (snapshots, publications, scans), but the view is not shipped in the portal yet |
| **Planned** | On the roadmap, not built |

| Feature | Status |
|---|---|
| Per-site portal, enable/disable per site | Available |
| Per-site access code (hashed), signed HttpOnly session, `noindex` pages | Available |
| Keyword list per site (`keyword \| location \| device`, up to 100 rows) | Available |
| Location-based tracking, mobile and desktop | Available |
| Google organic ranking checks through DataForSEO, language and depth (50/100/200) | Available |
| Weekly automatic check (Vercel Cron, Monday 07:15 UTC) and on-demand **Run check now** | Available |
| Append-only weekly ranking snapshots | Available |
| Top 3, Top 10, rising, falling | Available |
| Previous / current position and weekly change per keyword | Available |
| List of tracking periods with Top 10 count | Available |
| Ranking history charts, four-week trend lines | Preview |
| Keyword detail view (best position, device and location comparison) | Preview |
| Average position, Top 10 coverage %, ranking momentum, visibility trend | Preview |
| Keyword winners / losers | Preview |
| SEO / GEO publication count in the portal | Preview |
| Website health summary in the portal | Preview |
| Monthly advanced report layout | Preview |
| Local Pack, geo-grid, Search Console, GA4, Business Profile, AI-assistant visibility, PDF and email reports, white-label domain, notifications | Planned. See [Planned / Roadmap](#planned--roadmap) |

---

## Client Portal

![Client Portal Overview](screenshots/client-portal-overview.png)

- **One site per client.** A portal belongs to one registered site and shows only that site's data.
- **Per-site access control.** **Enable portal** turns the portal on or off for each site. A disabled or unknown portal returns *404*.
- **Own secure access.** Each site has its own access code. The panel stores only its SHA-256 hash and compares it in constant time. Signing in sets an HMAC-SHA256 signed, HttpOnly, `SameSite=Lax` cookie, scoped to `/portal/<site-id>` and valid for 30 days (`Secure` in production). The signing secret is `CLIENT_PORTAL_SESSION_SECRET` (32+ characters), with `PANEL_SESSION_SECRET` as fallback. Sessions are refused if the secret is shorter than 32 characters.
- **No admin interface.** The portal shows no Vercel projects, deployments, runtime state, content tools or settings.
- **Simplified dashboard.** It shows Top 3, Top 10, rising and falling counts, a keyword table (keyword, location, device, previous, current, change) and the latest tracking periods.
- **Private pages.** Rendered dynamically, `robots: noindex, nofollow`.

## Automatic Rank Tracker

![Rank Tracker Setup in the Master Panel](screenshots/master-panel-rank-tracker-setup.png)

- **Keywords per website.** One row per line: `keyword | location | mobile/desktop`, for example `ayvalik hotel | Ayvalık, Balıkesir | mobile`. Up to 100 rows per site.
- **Location.** Each row has its own city or region. The country is appended automatically.
- **Device.** `mobile` or `desktop` per row. To track both, add the keyword twice.
- **Google organic.** Positions come from Google organic results for the site's domain, with a language code (default `tr`) and a depth of Top 50, 100 or 200. A keyword not found within that depth is shown as *100+*.
- **Weekly snapshots.** Each run appends one dated snapshot with all rows. Existing snapshots are never overwritten.
- **Scheduling.** `vercel.json` runs `/api/cron/rank-tracker` every Monday at 07:15 UTC (10:15 Türkiye), protected by `CRON_SECRET` and with a time budget per run. **Run check now** starts a check for one site immediately. A keyword that fails is recorded without a rank, and the other keywords still complete.
- **Provider.** DataForSEO SERP API (`google/organic/live/regular`). The provider layer is isolated, so other SERP data providers can be added without changing the customer dashboard.

### Admin workflow (Master Panel → Client Portal)

1. Select the site, turn on **Enable portal**, set an access code and click **Save settings**.
2. Copy the **Client link** (`/portal/<site-id>`) and share it with the access code through a private channel.
3. Connect DataForSEO once under **DataForSEO connection**. The login and password are sealed with AES-256-GCM, stored in the private Blob store and never returned to the browser.
4. Enter the keyword list, language and depth, turn on **Weekly automatic tracking** and click **Save tracking list**.
5. Optionally click **Run check now** to create the first snapshot right away. After that, the weekly cron adds a new week automatically.

### Data model

| Record | Contents |
|---|---|
| Portal profile (one per site) | site id, site name, domain, enabled, access-code hash, timestamps |
| Tracker config (one per site) | enabled, language code, depth, keyword rows (`keyword`, `location`, `device`) |
| Ranking snapshot (one per run, append-only) | site id, `capturedAt`, rows of `keyword`, `location`, `device`, `rank` (1–200 or `null`) |
| Provider credentials (one, sealed) | provider `dataforseo`, sealed login, sealed password, `updatedAt` |

The weekly change of a row is `previous rank − current rank`, so a positive number means the keyword moved up. Rows are matched across snapshots by `keyword + location + device`. A row with no previous rank is shown as **New**.

### Configuration

| Variable | Purpose |
|---|---|
| `CLIENT_PORTAL_SESSION_SECRET` | Signs portal sessions (32+ characters). Falls back to `PANEL_SESSION_SECRET` |
| `CRON_SECRET` | Protects the weekly rank-tracker cron, like the other cron routes |

DataForSEO credentials are **not** environment variables. They are entered in the panel and stored sealed. Never commit `.env` files, access codes or provider credentials.

---

## Dashboard KPIs

| KPI | Definition | Status |
|---|---|---|
| Top 3 keywords | Rows with current rank 1–3 | Available |
| Top 10 keywords | Rows with current rank 1–10 | Available |
| Rising keywords | Rows whose rank improved since the previous snapshot | Available |
| Falling keywords | Rows whose rank dropped since the previous snapshot | Available |
| Previous position | Rank in the previous snapshot | Available |
| Current position | Rank in the latest snapshot | Available |
| Weekly movement | `previous − current`, for example `+3` | Available |
| Ranking history | All snapshots, newest first, with Top 10 count | Available (list), Preview (charts) |
| Average position | Mean current rank across ranked rows | Preview |
| SEO / GEO publication count | Pages published to the site from the Master Panel in the period | Preview |
| Website health / technical status | Readiness checks and latest scan, summarized | Preview |

**Example.** Keyword `ayvalik hotel`, previous position **8**, current position **5**: change **+3 positions**. Because every snapshot is stored, the same change can be shown as a line chart across weeks (see [Weekly Ranking History](#weekly-ranking-history)).

---

## Demo screens

All screens use demo data. Screens marked *Preview* show designs for views that are not shipped in the portal yet.

### Keyword Ranking Dashboard

![Keyword Ranking Dashboard](screenshots/keyword-ranking-dashboard.png)

All tracked keywords with location, device, previous and current position, weekly movement and a four-week trend. *Preview* (trend column, average position).

### Weekly Ranking History

![Weekly Ranking History](screenshots/weekly-ranking-history.png)

One line per keyword across weekly snapshots, with Top 10 coverage per week. *Preview.*

| Keyword | 07 Sep | 14 Sep | 21 Sep | 28 Sep |
|---|---|---|---|---|
| ayvalik hotel | 12 | 9 | 7 | 5 |
| ayvalik boutique hotel | 8 | 7 | 5 | 4 |
| sarimsakli hotel | 18 | 14 | 11 | 9 |
| ayvalik accommodation | 21 | 17 | 13 | 10 |
| beachfront hotel ayvalik | 15 | 12 | 10 | 8 |

### Keyword Detail View

![Keyword Detail View](screenshots/client-keyword-detail.png)

One keyword: current, previous and best position, weekly and four-week change, mobile vs desktop, positions by location and the check log. *Preview.*

### SEO / GEO Performance Overview

![SEO / GEO Performance Overview](screenshots/seo-geo-performance-overview.png)

Visibility trend, Top 10 coverage, guide pages published through the Master Panel and website health. *Preview.*

### Advanced SEO / GEO Report

![Advanced SEO / GEO Report](screenshots/advanced-seo-geo-report.png)

Sample monthly report for 01–30 September. Full text in [demo-report.md](demo-report.md). *Preview.* PDF export is planned.

---

## Planned / Roadmap

These items are **planned** and **not available** in the current release:

- [ ] Google Maps / Local Pack tracking
- [ ] Geo-grid visibility map
- [ ] Google Search Console metrics
- [ ] GA4 traffic integration
- [ ] Google Business Profile metrics
- [ ] AI visibility tracking
- [ ] ChatGPT visibility
- [ ] Gemini visibility
- [ ] Claude visibility
- [ ] Perplexity visibility
- [ ] Automated PDF reports
- [ ] Weekly email reports
- [ ] White-label custom domain
- [ ] Client notification system

See also [ROADMAP.md](../../ROADMAP.md).
