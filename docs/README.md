# ROIstation Master Panel — Documentation

Technical documentation for ROIstation Master Panel (ROIstation OS) 1.7.0, a Next.js 16 control panel for publishing SEO/GEO content and forms to a portfolio of client websites on Vercel, auditing them live, and proposing fixes as GitHub pull requests.

The panel UI is in Turkish; the documentation is in English and quotes Turkish labels with an English gloss where it helps. Examples use the fictional demo catalog from `lib/sites.ts`.

## Start here

| Document | What it covers |
|---|---|
| [Architecture.md](Architecture.md) | System context, layers, request lifecycles, Blob storage model, concurrency, failure isolation, cron/webhook and the main design trade-offs |
| [Folder-Structure.md](Folder-Structure.md) | Annotated repository tree: purpose of every folder and key file |
| [Developer-Guide.md](Developer-Guide.md) | Local setup, scripts, testing and contribution workflow |

## Engines

| Document | What it covers |
|---|---|
| [Publishing-Engine.md](Publishing-Engine.md) | Publications, targets and statuses; publish locations and strategies; scheduling; per-site outcomes; page model, JSON-LD and the connector feed |
| [SEO-Engine.md](SEO-Engine.md) | Live site scanner, check catalogue and weighted scoring, immutable scan history, pull-request based optimization |
| [GEO-Engine.md](GEO-Engine.md) | Generative-engine optimization: AI readiness, `llms.txt`, AI crawler access, local and entity signals, answer-oriented page layouts |

## Interfaces

| Document | What it covers |
|---|---|
| [API.md](API.md) | Every route handler: method, auth tier, request, response, errors and rate limits |
| [Component-Library.md](Component-Library.md) | Panel UI components and the embed widget |
| [State-Management.md](State-Management.md) | How the panel manages client state, polling and server synchronisation |

## Operations and security

| Document | What it covers |
|---|---|
| [Deployment.md](Deployment.md) | Vercel setup, private Blob store, environment variables, crons, webhook, connector installation, security headers, checklist, rollback and legacy migration |
| [Authentication.md](Authentication.md) | Admin login and session cookie, same-origin defence, rate limiting, sealed tokens, secret rotation, form tokens, cron secret and webhook signature |
| [Permissions.md](Permissions.md) | Access tiers and capability matrix, external token scopes, host allow-listing, excluded projects and what the panel will never do |

## Diagrams

SVG diagrams live in [`diagrams/`](diagrams/):

| Diagram | Topic |
|---|---|
| `system-architecture.svg` | System context and layers |
| `folder-structure.svg` | Repository layout |
| `authentication-flow.svg` | Login, session and machine credentials |
| `deployment-flow.svg` | Deployment and integrations |
| `publishing-flow.svg`, `ai-publishing-flow.svg`, `connector-flow.svg` | Publishing, AI drafts, connector delivery |
| `seo-flow.svg`, `optimization-pipeline.svg` | Scanning and pull-request optimization |

## Legacy

[`legacy/supabase/`](legacy/supabase/) holds an earlier SQL schema (multi-tenant organizations and publishing tables). It is **not used** by the current release, which stores everything in a private Vercel Blob store, and is kept only as a record of the design history.
