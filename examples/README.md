# Examples

Small, self-contained TypeScript modules taken from the ROIstation Master Panel source. Each one isolates a single mechanism (a REST client, a check, a generator, a decision) so it can be read and run without the Next.js app, the private Vercel Blob store or any credentials.

These are not a separate library and not a second implementation. The logic, naming and Turkish user-facing messages are the same as in the application. Dependencies are the only thing simplified: tiny helpers are inlined, storage and environment lookups become function arguments, and network clients take an injectable `fetch`, so every `demo()` runs offline. Every file starts with a header comment that names its source files and lists exactly how it differs from production.

All demo data comes from the fictional demo catalog in `lib/sites.ts` (for example `zeytinlik-restoran` on `https://zeytinlik.example`). Tokens are placeholders such as `demo-token`.

## Index

| Example | What it shows | Source | Run |
| --- | --- | --- | --- |
| [vercel-api.ts](vercel-api.ts) | Read-mostly Vercel REST client: typed errors (auth / not-found / rate-limited / unavailable), 8 s timeouts, project pagination, env var names without values, the single env upsert write | `lib/vercel/api.ts` | `npx tsx examples/vercel-api.ts` |
| [github-api.ts](github-api.ts) | GitHub client for optimization PRs: repo-name validation (exactly `owner/name`, `.` and `..` rejected), one commit on a new branch through the Git Data API (blobs, tree, commit, ref), then one pull request | `lib/github/api.ts` | `npx tsx examples/github-api.ts` |
| [seo-analysis.ts](seo-analysis.ts) | Dependency-free HTML extraction, the weighted SEO / GEO check catalogue, priority rules and `scoreOf()`, the scanner's home-page checks on an in-memory snapshot | `lib/seo/html.ts`, `lib/seo/checks.ts`, `lib/seo/scanner.ts` | `npx tsx examples/seo-analysis.ts` |
| [schema-generator.ts](schema-generator.ts) | The schema.org `@graph` for published pages; how the publish strategy picks Organization vs LocalBusiness subtype, Article / BlogPosting / WebPage, FAQPage and geo signals; NAP normalisation from configured data only | `lib/publishing/schema.ts`, `lib/publishing/business.ts`, `lib/publishing/definitions.ts` | `npx tsx examples/schema-generator.ts` |
| [llms-generator.ts](llms-generator.ts) | `/llms.txt` built from a live scan (real page titles, summary, service area, contact, sitemap) and when the optimizer adds it to a PR | `lib/seo/fixes.ts` | `npx tsx examples/llms-generator.ts` |
| [jsonld.ts](jsonld.ts) | JSON-LD end to end: the site-wide business node, safe embedding (`<` escaped as `<`), the generated `<RoistationSchema />` component, reading blocks back and the schema checks | `lib/seo/fixes.ts`, `connectors/roistation/article.tsx`, `lib/seo/html.ts`, `lib/seo/scanner.ts` | `npx tsx examples/jsonld.ts` |
| [deployment.ts](deployment.ts) | Deployment summaries, production-domain selection without invented fallbacks, env-name hashing, the `ROISTATION_DISABLED` opt-out, live status (strongest problem first) and the change events the sync logs | `lib/vercel/sync.ts`, `lib/vercel/projects.ts`, `lib/vercel/overview.ts` | `npx tsx examples/deployment.ts` |
| [publishing.ts](publishing.ts) | Locations, strategies and scopes; placement validation; Turkish-aware slugs with per-site uniqueness; the publish channel evaluating each site independently (unverified sites skipped under "all connected sites"); history entries | `lib/publication-service.ts`, `lib/publishing/channels.ts`, `lib/publishing/definitions.ts` | `npx tsx examples/publishing.ts` |
| [site-monitor.ts](site-monitor.ts) | Site verification: per-site host allow-list, manual host-checked redirects, capped body reads, connector endpoint probe, widget detection, the status decision chain and the 2-minute pre-publish freshness window | `lib/verification.ts` | `npx tsx examples/site-monitor.ts` |
| [metadata.ts](metadata.ts) | Page metadata model (title / description truncation, robots, Open Graph article, Twitter card), the connector's mapping to Next.js `Metadata`, and the layout metadata fix | `lib/publishing/page-model.ts`, `connectors/roistation/client.ts`, `lib/seo/fixes.ts` | `npx tsx examples/metadata.ts` |
| [canonical.ts](canonical.ts) | Canonical URLs for page locations, verified-origin fallback, `rebase()` to `ROISTATION_SITE_URL`, the canonical check and the static `index.html` fix | `lib/publishing/page-model.ts`, `connectors/roistation/client.ts`, `lib/seo/scanner.ts`, `lib/seo/fixes.ts` | `npx tsx examples/canonical.ts` |
| [open-graph.ts](open-graph.ts) | Reading `og:*` / `twitter:*` from `<head>`, the Open Graph and Twitter Card checks, and adding only the missing tags to a static site | `lib/seo/html.ts`, `lib/seo/scanner.ts`, `lib/seo/fixes.ts` | `npx tsx examples/open-graph.ts` |
| [robots.ts](robots.ts) | robots.txt parsing and crawl decisions (most specific group, longest rule, Allow wins ties), AI crawler checks, and the conservative robots fix (create when missing, otherwise only append `Sitemap:`) | `lib/seo/html.ts`, `lib/seo/scanner.ts`, `lib/seo/fixes.ts` | `npx tsx examples/robots.ts` |
| [sitemap.ts](sitemap.ts) | The published-pages sitemap feed, the connector's Next.js sitemap entries and template, and the sitemap generated from discovered URLs minus broken ones | `lib/publishing/page-model.ts`, `connectors/roistation/client.ts`, `connectors/templates/app/sitemap.ts`, `lib/seo/fixes.ts` | `npx tsx examples/sitemap.ts` |

## Running

The examples need Node.js 20.9 or later (the same engine range as the app) and use only Node built-ins and the global `fetch` / `Response` APIs. Nothing is sent over the network: modules that wrap an HTTP API install a stub through `setFetch()` inside `demo()`.

```bash
# from the repository root; npx downloads tsx on first use
npx tsx examples/seo-analysis.ts
```

Each file only runs its demo when executed directly, so the modules can also be imported:

```ts
import { parseRobots, robotsBlocks } from "./robots";

const robots = parseRobots("User-agent: *\nDisallow: /admin\n");
robotsBlocks(robots, "googlebot", "/admin/panel"); // true
```

## Type-checking

`examples/tsconfig.json` is independent of the application's `tsconfig.json`, which excludes this folder. It is strict, targets ES2022 with `module: esnext` / `moduleResolution: bundler`, and has no path aliases: the examples never import from `@/…` or `next`.

```bash
npm install                        # provides @types/node
npx tsc -p examples/tsconfig.json
```

## What the examples leave out

- Persistence: production writes scans, publications, project records and events to the private Vercel Blob store with create-only and compare-and-swap (ETag) primitives (`lib/blob-store.ts`). None of that is reproduced here.
- Credentials: Vercel and GitHub tokens come from environment variables or from an AES-256-GCM sealed record in Blob storage. The examples take a credentials object directly.
- Orchestration: locks, retries, cron and webhook entry points, the admin session and same-origin checks live in the application routes and are out of scope.
