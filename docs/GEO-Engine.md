# GEO Engine

Generative Engine Optimization (GEO) is the part of the product concerned with how well a client site can be read, understood and cited by AI answer engines. The `seo-geo` strategy description in the code names the targets explicitly: Google AI Overviews, ChatGPT, Claude, Gemini, Perplexity and Copilot.

This document describes only what the code does. GEO in this repository is not a separate service; it is three coordinated pieces:

1. **Measurement.** A subset of the SEO & GEO scan checks, weighted into a separate GEO score (`lib/seo/checks.ts`, `lib/seo/scanner.ts`).
2. **Publishing.** Strategies and page layouts that produce answer-shaped, entity-rich pages (`lib/publishing/definitions.ts`, `page-model.ts`, `schema.ts`, `content.ts`).
3. **Fixes.** Repository changes that add machine-readable signals, most notably `llms.txt` and business JSON-LD (`lib/seo/fixes.ts`).

Related documents: [Architecture](Architecture.md) · [SEO Engine](SEO-Engine.md) · [Publishing Engine](Publishing-Engine.md)

## Contents

- [Principles in the code](#principles-in-the-code)
- [GEO checks](#geo-checks)
- [How the GEO score is computed](#how-the-geo-score-is-computed)
- [GEO-oriented publishing strategies](#geo-oriented-publishing-strategies)
- [Layout features](#layout-features)
- [llms.txt generation](#llmstxt-generation)
- [From finding to content](#from-finding-to-content)
- [What GEO does not do](#what-geo-does-not-do)

## Principles in the code

- **Measured, not estimated.** GEO checks run against the live, server-rendered HTML and robots.txt. A check that does not apply (a non-local business, no configured locality) is `skip` and leaves the score.
- **Entity data is configured, never generated.** Business name, type, locality and NAP (name, address, phone) come from `lib/sites.ts` and `SITE_BUSINESS_JSON`. The AI prompts forbid inventing addresses, phone numbers, prices, reviews or certifications.
- **Visible content and structured data agree.** FAQ schema is derived from question headings that are actually in the page body, not from a hidden block.

## GEO checks

Checks with dimension `geo` count only toward the GEO score; checks with dimension `both` count toward SEO and GEO.

### AI crawler access (`ai-crawlers`, geo, weight 6)

The scanner evaluates robots.txt for four user agents:

```ts
// lib/seo/scanner.ts
const AI_BOTS = ["gptbot", "claudebot", "perplexitybot", "google-extended"];
// …
    const blockedBots = AI_BOTS.filter((bot) => robotsBlocks(robots, bot, "/"));
    checks.push(blockedBots.length ? result("ai-crawlers", blockedBots.length === AI_BOTS.length ? "fail" : "warn", `Engellenen AI tarayıcıları: ${blockedBots.join(", ")}.`, blockedBots) : result("ai-crawlers", "pass", "GPTBot, ClaudeBot, PerplexityBot ve Google-Extended engellenmiyor."));
```

- For each bot, `robotsBlocks()` (`lib/seo/html.ts`) picks the group that names the bot, else the `*` group, and applies longest-match semantics with Allow winning ties. Only the path `/` is evaluated.
- Blocked by some bots: `warn`; blocked by all four: `fail`; no robots.txt: `pass`.
- The blocked bot names are stored as evidence.
- Fix kind is **guided**. Blocking AI crawlers can be a deliberate business decision, so the optimizer never edits robots rules; it adds a manual item to the pull request.

### llms.txt (`llms-txt`, geo, weight 2)

`/llms.txt` passes when the response is 2xx, longer than 20 characters and not an HTML page (a catch-all route returning the home page does not count). Its weight of 2 is the lowest in the catalogue (shared with `lang`, `sitemap-in-robots` and `twitter-card`); the check's own explanation calls llms.txt "yeni bir standart" (a new standard). It is the one GEO finding the optimizer can fully automate (see [llms.txt generation](#llmstxt-generation)).

### Structured data

| Check | Dimension | Weight | What it looks for |
| --- | --- | --- | --- |
| `schema-present` | both | 6 | Any JSON-LD `@type` or schema.org microdata on the sampled pages |
| `schema-valid` | both | 5 | Every JSON-LD block parses and has `@context` |
| `organization-schema` | both | 4 | An Organization or LocalBusiness(-subtype) node with `name` and `url` |
| `faq-schema` | geo | 4 | A `FAQPage` node on any sampled page |
| `localbusiness-schema` | geo | 6 | For local business types only: a LocalBusiness node, with `address` for a pass |

JSON-LD is flattened across arrays and `@graph` before evaluation (`schemaNodes()`), so graph-style markup like the one the publishing engine emits is recognised. The set of local business types is shared with publishing (`isLocalBusinessType()` in `lib/publishing/business.ts`), for example `Restaurant`, `Dentist`, `Physician`, `HousekeepingService`, `TravelAgency`, `Hotel`.

### Question headings and FAQ (`question-headings`, geo, weight 3)

Counts headings (any level) ending in `?` across the home page and sampled inner pages: at least two is a pass, one a warning, none a failure. Question headings are what users type into AI assistants, and they are also what the publishing engine converts into `FAQPage` entries.

### Readability for AI (`ai-readability`, geo, weight 6)

Four signals, computed from the visible text of all sampled pages (scripts, styles, `noscript`, SVG and templates removed):

```ts
// lib/seo/scanner.ts
  const readabilityPoints = [page.wordCount >= 300, avgSentence > 0 && avgSentence <= 22, paragraphs.length > 0 && avgParagraph <= 90, lists > 0 || page.headings.length >= 4];
```

| Signal | Threshold |
| --- | --- |
| Enough text on the home page | at least 300 words |
| Short sentences | average at most 22 words (sentences of 3+ words) |
| Short paragraphs | average `<p>` at most 90 words |
| Scannable structure | at least one list, or at least 4 headings |

4/4 passes, 2–3 warns, 0–1 fails. The finding records the actual word count and averages, so the user sees why.

### Entity and local signals

| Check | Weight | Pass condition | Skipped when |
| --- | --- | --- | --- |
| `entity-links` | 3 | At least two `sameAs` URLs across schema nodes (one is a warning) | never |
| `locality-signals` | 5 | The configured locality (for example "Foça" for the demo `zeytinlik-restoran`) appears, Turkish-case-insensitively, in at least two of: title, H1, body text | no locality configured |
| `nap-schema` | 4 | LocalBusiness node with both address and telephone | not a local business type |
| `gbp-consistency` | 4 | Configured phone and street address (from `SITE_BUSINESS_JSON`) appear on the page or in schema; a schema phone that differs fails | no phone and no street address configured |

Phone numbers are compared digits-only with the Turkish country code and trunk prefix removed (`normalizeDigits()`), so `+90 232 …` and `0232 …` match.

## How the GEO score is computed

Both scores use the same weighted formula (`scoreOf()` in `lib/seo/checks.ts`); they differ only in which checks they include:

```ts
// lib/seo/scanner.ts
      seo: scoreOf(list, (check) => check.dimension !== "geo"),
      geo: scoreOf(list, (check) => check.dimension !== "seo"),
```

GEO includes the ten `geo` checks and the seven `both` checks:

| Check | Dimension | Weight |
| --- | --- | --- |
| `http-status` | both | 10 |
| `indexable` | both | 10 |
| `schema-present` | both | 6 |
| `schema-valid` | both | 5 |
| `organization-schema` | both | 4 |
| `heading-hierarchy` | both | 3 |
| `lang` | both | 2 |
| `ai-crawlers` | geo | 6 |
| `ai-readability` | geo | 6 |
| `localbusiness-schema` | geo | 6 |
| `locality-signals` | geo | 5 |
| `faq-schema` | geo | 4 |
| `nap-schema` | geo | 4 |
| `gbp-consistency` | geo | 4 |
| `question-headings` | geo | 3 |
| `entity-links` | geo | 3 |
| `llms-txt` | geo | 2 |
| **Total when every check is measured** | | **83** |

Compared with the SEO score (maximum weight 136):

- **Access dominates both.** `http-status` and `indexable` carry 20 of 83 GEO weight points. A site that cannot be fetched or is `noindex` cannot be cited either.
- **No performance, metadata or link checks.** Core Web Vitals, title/description, canonical, Open Graph and broken links are SEO-only.
- **Local checks are conditional.** For a non-local business type (in the demo catalogue, `konak-otel` with type `Organization`), `localbusiness-schema` and `nap-schema` skip; without configured NAP data, `gbp-consistency` skips; without a locality, `locality-signals` skips. The denominator shrinks accordingly.

Worked example (arithmetic only). A non-local site with no locality and no NAP data configured has 64 measurable GEO weight points (83 − 6 − 4 − 5 − 4). If everything passes except `faq-schema`, `question-headings`, `llms-txt` and `entity-links` (4 + 3 + 2 + 3 = 12 points failing), the GEO score is round(100 × 52 / 64) = 81.

The AI generation pipeline also returns a `geoScore` per draft. That number is the model's editorial estimate, labelled as such in the prompt, and is never mixed with the measured GEO score.

## GEO-oriented publishing strategies

Three strategies in `lib/publishing/definitions.ts` exist mainly for AI answer engines and local search:

| Strategy | Label | Page type | LocalBusiness node | Short answer | Key facts | TOC | NAP box | Geo signals | Reading time |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `seo-geo` | "SEO + GEO" | Article | when the site type is local | yes | yes | yes | – | yes | yes |
| `ai-answer` | "AI cevap odaklı" | Article | when the site type is local | yes | yes | yes | – | yes | – |
| `local-business` | "Yerel işletme" | WebPage | always | yes | yes | – | yes | yes | – |

All three publish to an SEO page (`/rehber/<slug>`) by default, emit `FAQPage` when the content has question headings with answers, and include `BreadcrumbList`.

What `geoSignals` changes in the JSON-LD (`lib/publishing/schema.ts`), given a configured locality:

- The business node gets `areaServed: { "@type": "Place", name: "<locality>, <region>" }` (LocalBusiness only).
- The `Article` node gets `spatialCoverage` with the same place and an `about` array linking the organization and the place:

```ts
// lib/publishing/schema.ts
      ...(area && strategy.layout.geoSignals ? { spatialCoverage: { "@type": "Place", name: area }, about: [{ "@id": orgId }, { "@type": "Place", name: area }] } : { about: { "@id": orgId } }),
```

For `local-business` the page type is `WebPage` with `about` pointing at the business node, and the business node is always a LocalBusiness: the configured subtype when it is a local type, otherwise plain `LocalBusiness`. Address, geo coordinates, opening hours, price range, map link and (for restaurants) `servesCuisine` are added only when configured.

The strategy choice is surfaced in the panel with a preview list of what it will produce (for example "Kısa cevap + ana bilgiler kutusu", short answer and key facts box), and the choice is remembered per browser.

## Layout features

The page model (`getSitePage()` in `lib/publishing/page-model.ts`) produces these sections; the connector's `RoistationArticle` (`connectors/roistation/article.tsx`) renders them in the site's own design.

| Feature | Source | Rendering on the site |
| --- | --- | --- |
| Short answer | `payload.summary`, else the first paragraph, truncated to 320 characters | `<aside aria-label="Kısa cevap">` before the body; the lead summary is hidden to avoid repeating it |
| Key facts | First sentences of paragraphs, 30–180 characters, not questions, up to 4; shown when at least 2 exist | `<aside aria-label="Öne çıkan bilgiler">` list |
| Table of contents | `h2` headings; shown when at least 2 exist | `<nav aria-label="İçindekiler">` with in-page anchors (heading ids are stable slugs) |
| areaServed line | `<locality>, <region>` from the business profile | Appended to the date/reading-time line under the H1; also in JSON-LD |
| NAP box (`local-business` only) | Configured name, address, phone, e-mail, opening hours; directions URL from `mapsUrl`, coordinates or street address | `<aside aria-label="İletişim ve konum">` with `tel:`/`mailto:` links and "Yol tarifi al" (get directions). Omitted when no contact data is configured |
| FAQ | Question headings (`## …?`, whole-line bold questions, `Soru:` prefixes) followed by answer text | Stays inline in the body as headings and paragraphs; mirrored in `FAQPage` JSON-LD |
| Breadcrumbs | Home → archive → page | `<nav aria-label="Sayfa konumu">`, which the scanner's breadcrumb check recognises |

The editorial brief sent to the AI provider asks for explicit section headings and a 4–6 item FAQ inside the body, which is exactly the shape `parseContent()` turns into TOC entries and FAQ schema.

## llms.txt generation

When `llms-txt` fails and the framework is known, the optimizer adds `llms.txt` (under `public/` for Next.js projects, at the repository root for a static site). The file is written only if it does not already exist in the repository. Its content is built from the scan and the configured business profile:

```ts
// lib/seo/fixes.ts
function llmsText(scan: ScanResult, profile: BusinessProfile, origin: string) {
  const summary = scan.facts.metaDescription || (scan.facts.firstParagraph ? truncate(scan.facts.firstParagraph, 300) : null);
  const pages = scan.pages.filter((page) => page.status && page.status < 400 && page.title);
  const lines = [`# ${profile.name}`, "", ...(summary ? [`> ${summary}`, ""] : []),
    ...(areaServed(profile) ? [`Hizmet bölgesi: ${areaServed(profile)}`, ""] : []),
    "## Önemli sayfalar", `- [Ana sayfa](${origin}/)`, ...pages.filter((page) => new URL(page.url).pathname !== "/").map((page) => `- [${page.title}](${page.url})`),
    ...scan.facts.discoveredUrls.filter((url) => !pages.some((page) => page.url === url) && url !== `${origin}/`).slice(0, 20).map((url) => `- ${url}`), ""];
  // …
  lines.push(`Sitemap: ${origin}/sitemap.xml`, "");
  return lines.join("\n");
}
```

Structure of the generated file:

1. `# <business name>`
2. A blockquote summary: the live meta description, else the first substantial paragraph (300 characters).
3. `Hizmet bölgesi:` (service area) when a locality is configured.
4. `## Önemli sayfalar` (important pages): the home page, every successfully scanned inner page with its real `<title>`, then up to 20 further discovered URLs.
5. `## İletişim` (contact) with phone, e-mail and address, only if configured in `SITE_BUSINESS_JSON`.
6. A `Sitemap:` line.

Every line comes from the scan or configured data. The optimizer's pull request shows the file before it is merged.

## From finding to content

Some GEO findings cannot be fixed by a code change because the site lacks the content itself. The presentation layer marks these as fix kind `ai` ("AI ile üretilebilir"). In the site detail view, "AI ile üret" opens the AI Automation workspace prefilled for that site with a matching strategy and goal:

```ts
// components/seo/site-detail.tsx
const aiStrategy: Record<string, { strategy: "ai-answer" | "local-business" | "seo-geo"; goal: string }> = {
  "faq-schema": { strategy: "ai-answer", goal: "Müşterilerin sık sorduğu soruları cevaplayan, AI asistanlarının alıntılayabileceği SSS içeriği" },
  "question-headings": { strategy: "ai-answer", goal: "Soru-cevap yapısında, kısa ve net cevaplı rehber içerik" },
  "locality-signals": { strategy: "local-business", goal: "Hizmet bölgesini, konumu ve yerel aramaları öne çıkaran içerik" },
  "ai-readability": { strategy: "seo-geo", goal: "Kısa paragraflar, listeler ve net başlıklarla AI tarafından kolay okunan içerik" },
  breadcrumbs: { strategy: "seo-geo", goal: "Site yapısını breadcrumb ile gösteren SEO + GEO rehber sayfası" },
};
```

The user still supplies the source text, reviews every draft and confirms publication; the shortcut only preselects site, strategy and goal. If the site's repository does not yet have the connector kit, the optimizer installs it in the pull request so the resulting `/rehber` pages can render (see [SEO Engine](SEO-Engine.md#which-fixes-are-automated)).

## What GEO does not do

- It does not query AI assistants or measure whether a site is actually cited. The GEO score measures readiness signals, not outcomes.
- It does not track AI-referral traffic.
- The crawler check covers GPTBot, ClaudeBot, PerplexityBot and Google-Extended only, and only the root path.
- `gbp-consistency` compares against configured data, not against the Google Business Profile API.
- Entity links (`sameAs`) are never discovered or suggested automatically; they must be added to `SITE_BUSINESS_JSON`, after which the schema component includes them on the next optimization.
