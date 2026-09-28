# SEO Engine — live scans, check catalogue, weighted scoring

## Overview

The SEO & GEO Center audits each client site against what search engines and AI crawlers actually receive:
server-rendered HTML of the home page and up to four inner pages, `robots.txt`, the declared sitemap, `/llms.txt`,
up to 25 internal links, and Google PageSpeed Insights. Every finding is one of 37 catalogued checks with a weight;
every score is a weighted average of those checks. Nothing is estimated — a check that cannot be measured is
recorded as `skip` with the reason and excluded from the score.

![SEO Center](../assets/screenshots/seo-center.png)

## Architecture notes

| Step | File |
| --- | --- |
| Check catalogue, priorities, scoring formula | `lib/seo/checks.ts` |
| Fetching and evaluating one site | `lib/seo/scanner.ts` (`scanSite`, `CRITICAL_CHECKS`) |
| Dependency-free HTML / robots / sitemap parsing | `lib/seo/html.ts` |
| Append-only scan history | `lib/seo/store.ts` |
| Dashboard aggregation, re-scan detection | `lib/seo/dashboard.ts` |
| Plain-language presentation layer | `lib/seo/presentation.ts` |
| API | `POST /api/seo/scan` (one site per request), `GET /api/seo`, `GET /api/seo/report` |

A scan result (`ScanResult`) is stored immutably as `roistation-master/seo/scans/<site-id>/<inverted-ms>-<rand>.json`;
the dashboard reads the newest two per site to show deltas. See [analytics.md](analytics.md) for history and trends.

![SEO flow](../docs/diagrams/seo-flow.svg)

## The code

### 1. The scoring contract

The header of the catalogue is the contract every screen relies on.

**Source:** `lib/seo/checks.ts`

```ts
/*
 * SEO & GEO check catalogue. Every score shown in the panel is computed from these
 * checks, which are evaluated against the live site (HTML, robots.txt, sitemap.xml,
 * llms.txt, internal links) and Google PageSpeed Insights. Nothing is estimated.
 *
 * Scoring: pass = 1, warn = 0.5, fail = 0, skip = excluded (could not be measured or
 * not applicable). Score = Σ(weight × value) / Σ(weight) over the measured checks.
 */
// …
export function result(id: string, status: CheckStatus, finding: string, evidence?: string[]): CheckResult {
  const def = checkDefinitions[id];
  const critical = id === "http-status" || id === "indexable" || id === "robots-allows" || id === "sitemap";
  const priority: Priority = status === "pass" || status === "skip" ? "low" : critical || def.weight >= 6 ? (status === "fail" ? "high" : "medium") : def.weight >= 4 ? "medium" : "low";
  return { ...def, status, priority, finding, ...(evidence?.length ? { evidence: evidence.slice(0, 25) } : {}) };
}

const value = (status: CheckStatus) => (status === "pass" ? 1 : status === "warn" ? 0.5 : 0);

/** Weighted score (0–100) over measured checks; null when nothing in the selection could be measured. */
export function scoreOf(checks: CheckResult[], filter: (check: CheckResult) => boolean): number | null {
  const measured = checks.filter((check) => check.status !== "skip" && filter(check));
  const total = measured.reduce((sum, check) => sum + check.weight, 0);
  if (!total) return null;
  return Math.round((measured.reduce((sum, check) => sum + check.weight * value(check.status), 0) / total) * 100);
}
```

`scoreOf` returns `null`, not 0, when nothing in a selection was measured. The UI renders that as "—"
(*ölçülmedi*, "not measured"), which keeps a site with a PageSpeed quota error from looking like a site with zero
performance.

Each definition carries its own weight, dimension (`seo`, `geo` or `both`) and a fix:

**Source:** `lib/seo/checks.ts`

```ts
  { id: "http-status", label: "Ana sayfa erişilebilir", category: "technical", dimension: "both", weight: 10, explanation: "Arama motorları ve AI tarayıcıları yalnız 200 yanıtı veren sayfaları dizine ekler.", fix: "Sunucu/deploy hatasını giderin; ana sayfanın 200 döndürdüğünden emin olun." },
  { id: "indexable", label: "Dizine eklenebilir (noindex yok)", category: "technical", dimension: "both", weight: 10, explanation: "meta robots veya X-Robots-Tag içindeki noindex, sayfanın arama sonuçlarından tamamen çıkmasına neden olur.", fix: "Canlı ortamda noindex etiketini ve X-Robots-Tag başlığını kaldırın." },
```

### 2. Parallel fetches inside the site's allow-list

PageSpeed Insights is slow (up to ~40 s), so it starts first and is awaited last. The HTML, `robots.txt` and
`llms.txt` fetches run in parallel through the same host allow-list used by verification.

**Source:** `lib/seo/scanner.ts`

```ts
/** Only these conditions make a site "Critical": offline/unreachable, 5xx, broken SSL, noindex, robots blocking, missing sitemap. */
export const CRITICAL_CHECKS = ["http-status", "indexable", "robots-allows", "sitemap"];
// …
  const hosts = allowedHosts(siteId, project);
  const origin = new URL(project && !project.archived && project.productionUrl ? project.productionUrl : connection?.site_url || `https://${site.domain}`).origin;
  const home = new URL("/", origin);
  const psi = pageSpeed(home.href);

  const [homeRes, robotsRes, llmsRes] = await Promise.all([
    fetchText(home, hosts, PAGE_TIMEOUT, "text/html"),
    fetchText(new URL("/robots.txt", origin), hosts, SMALL_TIMEOUT, "text/plain", 200_000),
    fetchText(new URL("/llms.txt", origin), hosts, SMALL_TIMEOUT, "text/plain", 200_000),
  ]);
```

`fetchText` never throws: it returns `{ ok: false, status: null, error }`, so one unreachable resource becomes a
failed or skipped check rather than an aborted scan.

### 3. Evidence-backed checks

A typical check: evaluate across the home page *and* the sampled inner pages, and attach the offending URLs as
evidence so the UI can show "affected pages".

**Source:** `lib/seo/scanner.ts`

```ts
  const missingCanonical = allPages.filter((item) => !item.parsed.canonical).map((item) => item.url);
  const canonicalUrl = page.canonical ? toUrl(page.canonical, homeRes.url) : null;
  checks.push(!page.canonical ? result("canonical", "fail", "Ana sayfada canonical etiketi yok.", missingCanonical)
    : page.canonicalCount > 1 ? result("canonical", "warn", `Ana sayfada ${page.canonicalCount} canonical etiketi var.`)
    : canonicalUrl && !sameSite(canonicalUrl.hostname, finalHost) ? result("canonical", "warn", `Canonical başka bir alan adını gösteriyor: ${canonicalUrl.href}`)
    : missingCanonical.length ? result("canonical", "warn", `${missingCanonical.length} iç sayfada canonical yok.`, missingCanonical) : result("canonical", "pass", `Canonical: ${canonicalUrl?.href}`));
```

### 4. robots.txt semantics, not string matching

`robots.txt` is parsed into user-agent groups and evaluated with the longest-match rule (Allow wins ties), with `*`
wildcards and `$` anchors. A crawler without its own group falls back to the `*` group.

**Source:** `lib/seo/html.ts`

```ts
/** Whether a path is blocked for a crawler (longest match wins, Allow beats Disallow on ties). */
export function robotsBlocks(robots: ReturnType<typeof parseRobots>, agent: string, path: string) {
  const group = robots.groups.find((item) => item.agents.includes(agent.toLowerCase())) || robots.groups.find((item) => item.agents.includes("*"));
  if (!group) return false;
  const matchLength = (rule: string) => {
    if (!rule) return -1;
    const pattern = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
    return pattern.test(path) ? rule.length : -1;
  };
  const allow = Math.max(-1, ...group.allow.map(matchLength));
  const disallow = Math.max(-1, ...group.disallow.map(matchLength));
  return disallow > allow;
}
```

An empty `Disallow:` (which means "allow everything") returns `-1` and therefore never blocks.

### 5. One check list, many scores

All dimension and category scores are views over the same check list, so they can never disagree with the
findings the user sees.

**Source:** `lib/seo/scanner.ts`

```ts
    const scores: ScanScores = {
      seo: scoreOf(list, (check) => check.dimension !== "geo"),
      geo: scoreOf(list, (check) => check.dimension !== "seo"),
      schema: scoreOf(list, (check) => check.category === "schema" || check.id === "localbusiness-schema"),
      metadata: scoreOf(list, (check) => check.category === "metadata" || check.category === "social"),
      performance: input.performance.measured ? input.performance.score : null,
      technical: scoreOf(list, (check) => check.category === "technical"),
      content: scoreOf(list, (check) => check.category === "structure" || check.category === "ai" || check.category === "media" || check.category === "links"),
      local: scoreOf(list, (check) => check.category === "local"),
    };
    // …
      scores, issues: list.filter((check) => check.status === "fail" || check.status === "warn").length, critical: list.filter((check) => check.status === "fail" && CRITICAL_CHECKS.includes(check.id)).length,
```

### 6. Health labels: "Critical" is reserved for access problems

**Source:** `lib/seo/presentation.ts`

```ts
/** Critical is reserved for access problems only (see CRITICAL_CHECKS in the scanner). */
export function healthOf(score: number | null, critical: number): Health {
  if (critical > 0) return { label: "Kritik", tone: "critical" };
  if (score === null) return { label: "Taranmadı", tone: "none" };
  if (score >= 90) return { label: "Mükemmel", tone: "good" };
  if (score >= 80) return { label: "Çok iyi", tone: "good" };
  if (score >= 70) return { label: "Optimizasyon önerilir", tone: "warning" };
  if (score >= 50) return { label: "İyileştirme gerekli", tone: "serious" };
  return { label: "Dikkat gerekli", tone: "serious" };
}
```

Labels gloss as: *Kritik* "Critical", *Taranmadı* "Not scanned", *Mükemmel* "Excellent", *Çok iyi* "Very good",
*Optimizasyon önerilir* "Optimization recommended", *İyileştirme gerekli* "Improvement needed", *Dikkat gerekli*
"Needs attention". A low score alone never produces "Critical"; only a failed access check does.

## Engineering notes

- **Timeouts per resource class**: 8 s pages, 5 s small files and links, 42 s PageSpeed. The scan route sets
  `maxDuration = 60` and scans one site per request; the panel loops over selected sites client-side.
- **Link checks are batched** 8 at a time and capped at 25 targets. A redirect to another host (e.g. an external
  login) yields `null`, which is excluded from the broken-link list rather than reported as broken.
- **Parsing is regex-based by design** (`lib/seo/html.ts`), operating on server-rendered HTML with comments
  stripped and `script/style/noscript/svg/template` removed before text extraction. It never executes page code.
- **Field vs lab data.** When Chrome UX Report field data exists, LCP/CLS/INP use it; otherwise the Lighthouse lab
  values are used and the finding text says which source was used.
- **One notion of "critical".** `result()` escalates priority for the same four ids that `CRITICAL_CHECKS` lists
  (`http-status`, `indexable`, `robots-allows`, `sitemap`), so a finding that marks a site *Critical* is also ranked
  `high`. The two are still separate literals in two files (the scanner imports `checks.ts`, so the reverse import would create a
  cycle), so adding a critical check means touching both.
- **Scan ids** are `Date.now().toString(36)` plus random suffix — unique enough for history keys, not meant as
  security tokens.

## Why it is built this way

**Decision:** a transparent, deterministic, weighted checklist evaluated against the live site, with no
third-party SEO API and no model in the scoring loop.

**Alternatives considered:**
- *Headless browser crawling* (Playwright/Chromium). Renders client-side content, but does not fit a 60-second
  serverless budget across multiple pages and would score what browsers see rather than what crawlers receive
  first.
- *A commercial SEO API.* Opaque scoring that the agency could not explain to clients, and per-call cost.
- *Asking an LLM to grade the page.* Non-deterministic; the same site could score differently on two runs, which
  defeats history and trends.

**Trade-offs accepted:** regex parsing can miss exotic markup, and sampling four inner pages is not a full crawl.
In exchange, every number is reproducible and traceable to a check with evidence, and the scan fits comfortably
in one function invocation.

## Best practices demonstrated

- A single source of truth (the check list) for every derived score.
- `null` for "not measured" instead of a misleading 0.
- Never-throwing fetch helpers so partial failures degrade individual checks, not the whole scan.
- Standards-correct `robots.txt` evaluation (group selection, longest match, wildcards).
- Starting the slowest I/O first and awaiting it last.

## Related

- [docs/SEO-Engine.md](../docs/SEO-Engine.md) · [SEO flow diagram](../docs/diagrams/seo-flow.svg)
- Screenshots: [SEO Center](../assets/screenshots/seo-center.png), [site detail](../assets/screenshots/seo-site-detail.png)
- Sibling walkthroughs: [geo-engine.md](geo-engine.md), [analytics.md](analytics.md),
  [github-integration.md](github-integration.md), [component-library.md](component-library.md)
