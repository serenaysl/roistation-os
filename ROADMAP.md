# Roadmap

Direction for the next releases. Items are grouped by theme and roughly ordered by priority within each group. Nothing here is a commitment to a date.

## Access and accountability

- [ ] **Multi-user accounts** with roles (owner, editor, viewer) replacing the single admin password.
- [ ] **Audit log** of every mutation (who, what, which sites), stored as create-only records like publications.
- [ ] Session revocation list, so a password change or logout ends sessions everywhere.
- [ ] Per-site scoping of editor access.

## Storage

- [ ] Extract a storage adapter interface from `lib/blob-store.ts` / `lib/storage.ts`.
- [ ] Postgres implementation of the adapter (the historical schema in `docs/legacy/supabase` is a starting point).
- [ ] Scheduled export of publications and submissions to a separate backup store.

## Publishing

- [ ] Google Business Profile channel (posts from publications, NAP consistency checks).
- [ ] RSS / JSON Feed channel per site.
- [ ] Newsletter channel.
- [ ] Revalidate client-site caches when a scheduled publication goes live (today it appears within the ISR window).
- [ ] Rich-text editor with live page-model preview.

## SEO & GEO

- [ ] Core Web Vitals field-data trends and threshold alerts.
- [ ] Scheduled batch optimization with pull-request status tracking and auto-close of stale PRs.
- [ ] Larger cron budget: process more than three changed sites per run using a queue.
- [ ] Per-page scan history and diff of findings between scans.
- [ ] Measure AI-search citations as an outcome metric next to readiness signals.

## Client Portal & analytics

Planned only; none of these are available yet. Details in [docs/client-portal](docs/client-portal/README.md#planned--roadmap).

- [ ] Google Maps / Local Pack tracking and a geo-grid visibility map.
- [ ] Google Search Console metrics and GA4 traffic integration.
- [ ] Google Business Profile metrics.
- [ ] AI visibility tracking (ChatGPT, Gemini, Claude, Perplexity).
- [ ] Ranking history charts, keyword detail view and advanced analytics in the portal (designs in the demo screenshots).
- [ ] Automated PDF reports and weekly email reports.
- [ ] White-label custom domain for the portal.
- [ ] Client notification system.

## Operations

- [ ] Vercel sync lock with owner token and compare-and-swap takeover.
- [ ] Structured logging and request ids surfaced in error messages.
- [ ] End-to-end browser tests for the main panel flows.
- [ ] Remove `typescript.ignoreBuildErrors` once CI type-checking is enforced on every branch.

## Done recently

See [CHANGELOG.md](CHANGELOG.md).
