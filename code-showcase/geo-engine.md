# GEO Engine — generative engine optimization

## Overview

"GEO" in this product means making a client site readable, quotable and correctly attributed by AI assistants
(ChatGPT, Claude, Perplexity, Gemini, Google AI Overviews). It is not a separate service; it is a set of concrete,
measurable signals that run through three parts of the codebase:

1. **Measurement** — GEO-dimension checks in the scanner: AI crawler access in `robots.txt`, `/llms.txt`, AI
   readability, question-shaped headings, FAQ schema, locality signals, NAP (name/address/phone) consistency and
   `sameAs` entity links.
2. **Publishing** — strategies (`seo-geo`, `local-business`, `ai-answer`, …) whose layout flags add a short-answer
   box, key facts, table of contents, NAP box and service-area signals to published pages, plus a JSON-LD graph.
3. **Remediation** — generated `llms.txt` and Organization/LocalBusiness JSON-LD in optimization pull requests.

All business facts (phone, address, hours, `sameAs`) come only from the `SITE_BUSINESS_JSON` configuration. The
engine never invents them; that is what keeps NAP consistent with the client's Google Business Profile.

## Architecture notes

| Concern | File |
| --- | --- |
| GEO checks | `lib/seo/scanner.ts`, catalogue in `lib/seo/checks.ts` (`dimension: "geo"`) |
| Business identity (configured only) | `lib/publishing/business.ts` |
| Strategies and layout flags | `lib/publishing/definitions.ts` (`publishStrategies`) |
| JSON-LD graph for published pages | `lib/publishing/schema.ts` |
| Render-ready page model (short answer, key facts, NAP) | `lib/publishing/page-model.ts` |
| FAQ extraction from content | `lib/publishing/content.ts` |
| `llms.txt` / schema generation for PRs | `lib/seo/fixes.ts` |

The GEO score is `scoreOf(checks, c => c.dimension !== "seo")`, i.e. GEO-only checks plus the shared ones
(`http-status`, `indexable`, `lang`, schema validity…). A site that blocks all crawlers cannot score well on GEO.

## The code

### 1. AI crawler access and llms.txt

Four AI user agents are evaluated with the same `robotsBlocks` logic used for Googlebot. Blocking some is a warning
(it may be a deliberate choice); blocking all is a failure.

**Source:** `lib/seo/scanner.ts`

```ts
const AI_BOTS = ["gptbot", "claudebot", "perplexitybot", "google-extended"];
// …
  const llmsOk = llmsRes.ok && llmsRes.body.trim().length > 20 && !/<html/i.test(llmsRes.body.slice(0, 300));
// …
    const blockedBots = AI_BOTS.filter((bot) => robotsBlocks(robots, bot, "/"));
    checks.push(blockedBots.length ? result("ai-crawlers", blockedBots.length === AI_BOTS.length ? "fail" : "warn", `Engellenen AI tarayıcıları: ${blockedBots.join(", ")}.`, blockedBots) : result("ai-crawlers", "pass", "GPTBot, ClaudeBot, PerplexityBot ve Google-Extended engellenmiyor."));
// …
  checks.push(llmsOk ? result("llms-txt", "pass", "/llms.txt bulundu.") : result("llms-txt", "fail", "/llms.txt yok."));
```

The `llms.txt` test rejects HTML bodies because many frameworks answer unknown paths with a 200 "soft 404" page;
without that guard every such site would pass.

### 2. AI readability, measured

Readability is four explicit, explainable criteria rather than a formula like Flesch (which is poorly calibrated
for Turkish): enough text, short sentences, short paragraphs, and some structure.

**Source:** `lib/seo/scanner.ts`

```ts
  const text = allPages.map((item) => item.parsed.text).join(" ");
  const sentences = text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.split(/\s+/).length >= 3);
  const avgSentence = sentences.length ? sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/).length, 0) / sentences.length : 0;
  const paragraphs = allPages.flatMap((item) => item.parsed.paragraphs);
  const avgParagraph = paragraphs.length ? paragraphs.reduce((sum, paragraph) => sum + paragraph.split(/\s+/).length, 0) / paragraphs.length : 0;
  const lists = allPages.reduce((sum, item) => sum + item.parsed.lists, 0);
  const readabilityPoints = [page.wordCount >= 300, avgSentence > 0 && avgSentence <= 22, paragraphs.length > 0 && avgParagraph <= 90, lists > 0 || page.headings.length >= 4];
  const readabilityScore = readabilityPoints.filter(Boolean).length;
  checks.push(result("ai-readability", readabilityScore === 4 ? "pass" : readabilityScore >= 2 ? "warn" : "fail", `Ana sayfa ${page.wordCount} kelime; ortalama cümle ${avgSentence.toFixed(1)} kelime; ortalama paragraf ${avgParagraph.toFixed(0)} kelime; ${lists} liste.`));
  const questions = allPages.flatMap((item) => item.parsed.headings.filter((heading) => heading.text.trim().endsWith("?")).map((heading) => heading.text));
  checks.push(questions.length >= 2 ? result("question-headings", "pass", `${questions.length} soru biçimli başlık.`, questions) : result("question-headings", questions.length ? "warn" : "fail", `${questions.length} soru biçimli başlık.`, questions));
```

The finding text reports the measured numbers ("home page N words; average sentence X words; …"), so the user sees
*why* the check failed, not just that it did.

### 3. Strategies as data: layout flags drive the page

Publishing strategies are a typed registry. Renderers, APIs and the UI iterate it, so a new strategy is one entry.

**Source:** `lib/publishing/definitions.ts`

```ts
export type StrategyDefinition = {
  label: string;
  description: string;
  /** Location the UI pre-selects when this strategy is chosen. */
  defaultLocation: PublishLocation;
  /** schema.org type of the main page node. */
  pageType: "Article" | "BlogPosting" | "WebPage";
  schema: { organization: boolean; localBusiness: "never" | "when-applicable" | "always"; faq: boolean };
  layout: {
    shortAnswer: boolean;   // direct answer box at the top (AI assistants, featured snippets)
    keyFacts: boolean;      // compact fact list derived from the content
    toc: boolean;           // table of contents from headings
    nap: boolean;           // name / address / phone / hours box (only configured data, never invented)
    readingTime: boolean;
    geoSignals: boolean;    // service area / locality line and areaServed
    relatedCount: number;
  };
  // …
};
// …
  "ai-answer": {
    label: "AI cevap odaklı", description: "AI asistanların kolay anlayıp alıntılayacağı yapı: net başlık hiyerarşisi, soru-cevap, kısa olgusal paragraflar.", defaultLocation: "seo-page", pageType: "Article",
    schema: { organization: true, localBusiness: "when-applicable", faq: true },
    layout: { shortAnswer: true, keyFacts: true, toc: true, nap: false, readingTime: false, geoSignals: true, relatedCount: 4 }, homepageTeaser: false,
    preview: ["Kısa cevap kutusu en üstte", "İçindekiler ve anlamsal başlık hiyerarşisi", "Soru-cevap yapısı + SSS şeması", "Makine tarafından okunabilir varlık ilişkileri"],
  },
```

The page model applies the flags; sections that would be empty are omitted rather than rendered hollow:

**Source:** `lib/publishing/page-model.ts`

```ts
  const area = areaServed(profile);
  const shortAnswer = strategy.layout.shortAnswer ? truncate(payload.summary?.trim() || blocks.find((block): block is TextBlock => block.type === "p")?.text || "", 320) || undefined : undefined;
  const keyFacts = strategy.layout.keyFacts ? keyFactsOf(blocks) : [];
  return {
    // …
    readingMinutes: strategy.layout.readingTime ? readingMinutes(blocks) : undefined,
    blocks,
    toc: strategy.layout.toc && toc.length >= 2 ? toc : [],
    faq,
    sections: {
      shortAnswer,
      keyFacts: keyFacts.length >= 2 ? keyFacts : undefined,
      nap: strategy.layout.nap ? napInfo(profile) : undefined,
      areaServed: strategy.layout.geoSignals ? area : undefined,
    },
```

### 4. FAQ extracted from the content itself

FAQ schema is only emitted when the content really contains question headings followed by answers.

**Source:** `lib/publishing/content.ts`

```ts
/** Question headings followed by answer text become FAQ entries. */
export function extractFaq(blocks: ContentBlock[], limit = 12): FaqEntry[] {
  const faq: FaqEntry[] = [];
  for (let i = 0; i < blocks.length && faq.length < limit; i++) {
    const block = blocks[i];
    if (!isHeading(block) || !block.text.trim().endsWith("?")) continue;
    const answer: string[] = [];
    for (let j = i + 1; j < blocks.length; j++) {
      const next = blocks[j];
      if (isHeading(next)) break;
      answer.push(isList(next) ? next.items.join("; ") : next.text);
    }
    const text = answer.join(" ").trim();
    if (text) faq.push({ question: block.text, answer: text.length > 1200 ? `${text.slice(0, 1197).replace(/\s+\S*$/, "")}…` : text });
  }
  return faq;
}
```

### 5. One linked JSON-LD graph

Every published page gets a single `@graph` with stable `@id`s (`/#organization`, `/#website`, `<url>#webpage`,
`#article`, `#breadcrumb`, `#faq`), so the business entity is defined once and referenced everywhere.

**Source:** `lib/publishing/schema.ts`

```ts
/** Whether the business node is emitted as a LocalBusiness subtype (e.g. Restaurant) for this strategy. */
export function usesLocalBusiness(strategy: PublishStrategy, profile: BusinessProfile) {
  const rule = publishStrategies[strategy].schema.localBusiness;
  return rule === "always" || (rule === "when-applicable" && isLocalBusinessType(profile.schemaType));
}
// …
  if (strategy.pageType !== "WebPage") {
    graph.push({
      "@type": strategy.pageType, "@id": `${input.canonical}#article`, headline: input.title.slice(0, 110), description: input.description,
      datePublished: input.publishedAt, dateModified: input.updatedAt, inLanguage: "tr-TR", wordCount: input.wordCount,
      mainEntityOfPage: { "@id": webpageId }, author: { "@id": orgId }, publisher: { "@id": orgId },
      articleSection: (publishLocations[input.location] as { archiveName?: string }).archiveName || publishLocations[input.location].label,
      ...(area && strategy.layout.geoSignals ? { spatialCoverage: { "@type": "Place", name: area }, about: [{ "@id": orgId }, { "@type": "Place", name: area }] } : { about: { "@id": orgId } }),
    });
  }
  // …
  if (strategy.schema.faq && input.faq.length) {
    graph.push({
      "@type": "FAQPage", "@id": `${input.canonical}#faq`, isPartOf: { "@id": webpageId }, inLanguage: "tr-TR",
      mainEntity: input.faq.map((entry) => ({ "@type": "Question", name: entry.question, acceptedAnswer: { "@type": "Answer", text: entry.answer } })),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
```

For a demo site like `zeytinlik-restoran` (schema type `Restaurant`, Foça/İzmir), the `seo-geo` strategy yields a
`Restaurant` node with `areaServed: "Foça, İzmir"` and an Article whose `about` includes that place; the plain `seo`
strategy keeps an `Organization` node and no locality claims.

### 6. llms.txt generated from the scan, not from imagination

When `llms-txt` fails and the repository has none, the optimization PR creates one from the scan's real titles,
the meta description or first substantial paragraph, and configured contact data.

**Source:** `lib/seo/fixes.ts`

```ts
function llmsText(scan: ScanResult, profile: BusinessProfile, origin: string) {
  const summary = scan.facts.metaDescription || (scan.facts.firstParagraph ? truncate(scan.facts.firstParagraph, 300) : null);
  const pages = scan.pages.filter((page) => page.status && page.status < 400 && page.title);
  const lines = [`# ${profile.name}`, "", ...(summary ? [`> ${summary}`, ""] : []),
    ...(areaServed(profile) ? [`Hizmet bölgesi: ${areaServed(profile)}`, ""] : []),
    "## Önemli sayfalar", `- [Ana sayfa](${origin}/)`, ...pages.filter((page) => new URL(page.url).pathname !== "/").map((page) => `- [${page.title}](${page.url})`),
    ...scan.facts.discoveredUrls.filter((url) => !pages.some((page) => page.url === url) && url !== `${origin}/`).slice(0, 20).map((url) => `- ${url}`), ""];
  const contact = [profile.telephone && `Telefon: ${profile.telephone}`, profile.email && `E-posta: ${profile.email}`, profile.streetAddress && `Adres: ${[profile.streetAddress, profile.postalCode, profile.locality, profile.region].filter(Boolean).join(", ")}`].filter(Boolean) as string[];
  if (contact.length) lines.push("## İletişim", ...contact.map((line) => `- ${line}`), "");
  lines.push(`Sitemap: ${origin}/sitemap.xml`, "");
  return lines.join("\n");
}
```

## Engineering notes

- **NAP comparison normalizes phone numbers** (strip non-digits, the `90` country code and a leading `0`) and
  compares street addresses case-insensitively with Turkish locale lowering, so `+90 232 …` and `0232 …` match.
- **Skip, don't guess.** Without configured locality, `locality-signals` is `skip`; without a configured phone or
  address, `gbp-consistency` is `skip`. Neither drags the GEO score down for missing configuration.
- **Local business types** are an explicit allow-list (`Restaurant`, `Dentist`, `Physician`, `HousekeepingService`,
  `TravelAgency`, …). A profile type outside the list is emitted as `Organization`.
- **JSON-LD injection safety.** Generated schema components escape `<` as `<` before
  `dangerouslySetInnerHTML`, so a business name containing `</script>` cannot break out of the tag.
- **Limits.** GEO signals are proxies for what AI systems are likely to use; there is no measurement of actual
  citations in AI answers. That would be a separate, roadmap-level feature.

## Why it is built this way

**Decision:** treat GEO as structured, verifiable signals layered onto normal SEO, and drive published page
structure from a declarative strategy registry.

**Alternatives considered:**
- *A separate "GEO page" template per strategy.* More freedom per template, but every strategy would re-implement
  breadcrumbs, canonical, OG tags and schema, and they would drift.
- *LLM-generated schema and llms.txt.* Faster to build, but a model will happily invent an address or opening hours;
  for local businesses an incorrect NAP is worse than none.
- *Tracking AI citations via third-party APIs.* Out of scope for now; data sources are immature and costly.

**Trade-offs accepted:** strategies can only combine the layout flags that exist; a genuinely new section type
needs code in the page model and the connector renderer. The readability heuristic is coarse, but it is explainable
to a client in one sentence per criterion.

## Best practices demonstrated

- Declarative registries (`as const satisfies Record<string, StrategyDefinition>`) for behavior variants.
- Linked-data graphs with stable `@id`s instead of disconnected JSON-LD blocks.
- Facts only from configuration; absent data means an omitted section, never a placeholder.
- Guarding "soft 404" responses when probing for well-known files.
- Findings that carry the measured values that produced them.

## Related

- [docs/SEO-Engine.md](../docs/SEO-Engine.md) · [docs/Publishing-Engine.md](../docs/Publishing-Engine.md) ·
  [AI publishing flow](../docs/diagrams/ai-publishing-flow.svg)
- Sibling walkthroughs: [seo-engine.md](seo-engine.md), [publishing-engine.md](publishing-engine.md),
  [github-integration.md](github-integration.md)
