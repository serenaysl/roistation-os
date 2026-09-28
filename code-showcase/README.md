# Code Showcase — ROIstation Master Panel

A curated set of engineering walkthroughs through the real source of ROIstation Master Panel (v1.7.0), the
Next.js 16 / React 19 / TypeScript control panel I built to run an agency's portfolio of client websites from
one place: publishing, site verification, Vercel deployment health, SEO & GEO audits and pull-request based
optimization.

Every snippet in this folder is copied from the repository. Long functions are trimmed with `// …`, but no line
is rewritten, and each snippet names the file it came from. Where a walkthrough says that something is *not*
implemented, that is deliberate: the goal is an accurate picture of the system, not a brochure.

## How to read the showcase

Each file follows the same structure:

| Section | What it answers |
| --- | --- |
| **Overview** | What the subsystem does and where it sits in the product. |
| **Architecture notes** | Files involved, data flow, storage layout, who calls whom. |
| **The code** | 3–6 annotated snippets, each captioned with `**Source:**` and the file path. |
| **Engineering notes** | Edge cases, failure modes, concurrency and security considerations. |
| **Why it is built this way** | The decision, the alternatives I considered, and the trade-offs I accepted. |
| **Best practices demonstrated** | Short list of reusable techniques. |
| **Related** | Links to the long-form docs in `../docs/` and to sibling walkthroughs. |

The UI is in Turkish (the agency's market). When a snippet contains a Turkish string, the surrounding text gives
an English gloss. Site names in examples come from the fictional demo catalog in `lib/sites.ts`
(`kiyi-dis`, `zeytinlik-restoran`, `konak-otel`, …); real client names never live in source.

## Suggested reading order

1. **Foundations**
   - [state-management.md](state-management.md) — client state, `requestApi`, polling, optimistic concurrency, registries.
   - [authentication.md](authentication.md) — single-admin session, HMAC cookies, sealed secrets.
   - [permissions.md](permissions.md) — every guard between the internet and a write.
2. **Core engines**
   - [site-management.md](site-management.md) — site catalog, imported sites, verification, connection records.
   - [publishing-engine.md](publishing-engine.md) — publications, channels, per-site outcomes, compare-and-swap.
   - [deployment-engine.md](deployment-engine.md) — Vercel sync, sync lock, deployment health, cron and webhook.
   - [seo-engine.md](seo-engine.md) — live scanner, check catalogue, weighted scoring, critical checks.
   - [geo-engine.md](geo-engine.md) — AI crawler access, llms.txt, readability, GEO publishing strategies, JSON-LD.
3. **Integrations**
   - [vercel-integration.md](vercel-integration.md) — REST client, encrypted token, settings, activity log.
   - [github-integration.md](github-integration.md) — Git Data API commits and optimization pull requests.
4. **Measurement and UI**
   - [analytics.md](analytics.md) — what is measured (and what is not): operational metrics, score history, Core Web Vitals, exports.
   - [dashboard-layout.md](dashboard-layout.md) — the panel shell, navigation, notices, background sync.
   - [component-library.md](component-library.md) — SEO Center primitives, `.sx-*` design tokens, accessibility.

## Recurring themes

A few decisions show up in almost every file, so it helps to know them up front:

- **One JSON object per record in a private Vercel Blob store** (`lib/blob-store.ts`). Writes are either
  create-only (`allowOverwrite:false`), compare-and-swap on an ETag (`ifMatch`), or deliberately last-write-wins
  for independent observations. There is no shared snapshot to contend on.
- **Nothing is estimated.** Scores come from checks measured against the live site; anything that cannot be
  measured is recorded as `skip` with the reason.
- **Per-target outcomes.** A publish to eight sites is eight independent results; one failing site never blocks
  the others.
- **Best-effort side effects.** Activity logs, cache revalidation and connector probes are time-bounded and never
  fail the primary operation.
- **Single administrator.** The panel has one admin account; there is no multi-user RBAC. See
  [permissions.md](permissions.md).

## Related

- Architecture overview: [docs/Architecture.md](../docs/Architecture.md)
- Diagrams: [system architecture](../docs/diagrams/system-architecture.svg),
  [folder structure](../docs/diagrams/folder-structure.svg),
  [publishing flow](../docs/diagrams/publishing-flow.svg),
  [SEO flow](../docs/diagrams/seo-flow.svg),
  [deployment flow](../docs/diagrams/deployment-flow.svg),
  [authentication flow](../docs/diagrams/authentication-flow.svg),
  [optimization pipeline](../docs/diagrams/optimization-pipeline.svg),
  [connector flow](../docs/diagrams/connector-flow.svg),
  [AI publishing flow](../docs/diagrams/ai-publishing-flow.svg)
- Project README: [../README.md](../README.md)
