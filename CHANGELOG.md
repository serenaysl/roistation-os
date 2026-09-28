# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/). Releases before 1.7.0 were deployed
continuously from the main branch and are summarized by milestone.

## [1.7.0] — 2026-09-28

Repository hardening and review pass.

### Added
- ⌘K / Ctrl+K command search across panel views and sites (ARIA combobox).
- Site catalog from configuration (`NEXT_PUBLIC_ROISTATION_SITES`) with a fictional demo catalog as fallback; excluded Vercel projects from `NEXT_PUBLIC_ROISTATION_EXCLUDED_PROJECTS`.
- Baseline security headers: `nosniff`, strict referrer policy, and `frame-ancestors 'none'` / `X-Frame-Options: DENY` for the panel page (`/embed` stays frameable).
- `requireCronSecret()` shared by both cron routes.
- Server-side demo guard on `/api/publish` using the stored generation record.
- `npm run typecheck` and `npm run verify`.
- Documentation set (`docs/`), code walkthroughs (`code-showcase/`), runnable extracts (`examples/`), architecture diagrams and repository artwork.
- `Dentist` and `Physician` as local-business schema types.

### Changed
- Vercel credentials use the shared AES-256-GCM helper in `lib/crypto-box.ts` (same key derivation; stored tokens remain readable).
- `sitemap` is treated as a critical check in issue priority, matching the health status rules.
- `mobile-friendly` is presented as a guided fix; wording of automatic vs. AI-assisted counts clarified.
- Sidebar connection health and site badge are computed from live data; the notification bell reflects pending Vercel projects.
- Trend chart leaves a gap for unmeasured scans instead of bridging them; unchanged deltas render as `±0`.
- Core Web Vitals use Turkish decimal formatting.
- Unused Supabase schema moved to `docs/legacy/supabase`.

### Fixed
- Pending-project banner no longer overlaps notifications.
- Radio inputs in settings forms rendered at text-input size.
- Page-heading actions and deploy-card badges wrap instead of overflowing.
- `ROISTATION_REVALIDATE_SECRET` is pushed to sites only when it meets the 32-character minimum.
- GitHub repository names reject `.`/`..` segments.
- `/api/seo/ignore` rejects site ids that are not in the registry.

## [1.6.0] — SEO & GEO Center redesign

### Added
- Portfolio view with health statuses, trend, improvement count and quick actions; multi-site selection and batch optimization (one PR per site).
- Site audit: deterministic analysis summary, projected scores, score rings with deltas, eight category scores, Core Web Vitals waiting state, prioritized improvement cards with impact, fix time and fix kind, passed checks, scanned-pages table and history timeline.
- Ignore / restore findings (`/api/seo/ignore`) and optimization of selected findings.

### Changed
- *Critical* status limited to unreachable homepage, `noindex`, robots blocking and missing sitemap.

## [1.5.0] — Live SEO & GEO Center

### Added
- Live scanner (HTML, robots, sitemap, `llms.txt`, internal links, structured data, AI crawlers, PageSpeed Insights), weighted scoring and immutable scan history.
- Optimization through GitHub pull requests (Git Data API) with automatic re-scan after deploy.

### Removed
- All placeholder scores and example data.

## [1.4.0] — Zero-configuration Vercel

### Added
- Connect a Vercel account once with a personal access token (sealed in storage); automatic discovery, import and verification of every project; account, team and sync status in Settings.

## [1.3.0] — Vercel integration

### Added
- Project discovery, deployment-aware verification, health checks, event log, signed webhook and daily cron.

## [1.2.1]

### Fixed
- Withdraw and delete now act on exactly the selected targets; fully deleted publications are removed from storage and every public API.

## [1.2.0] — Publishing engine

### Added
- Publish locations (SEO page `/rehber/<slug>`, homepage, blog, service page, footer), strategies, scopes, scheduling, confirmation summary and per-site results.
- Connector kit and route templates for client sites; on-demand revalidation.

## [1.1.0] — Per-record storage

### Changed
- Storage moved from a shared `state.json` to one private Blob object per record with create-only and compare-and-swap writes; one-time automatic migration.

## [1.0.0]

### Added
- Central content and form publishing, embed widget, admin authentication, signed form tokens, submissions inbox and AI-assisted drafting.

[1.7.0]: #170--2026-09-28
