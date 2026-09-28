# Analytics — what the panel measures (and what it does not)

## Overview

To be precise about scope first: **the panel ships no third-party analytics.** There is no Google Analytics,
no tracking pixel, no visitor-level data collection on the panel or on the client sites through the connector.
The panel does not know how many people read a published article.

What it does measure is operational and site-quality data that the agency acts on:

| Measurement | Source | Where it shows |
| --- | --- | --- |
| Operational counters: verified sites, live / scheduled / failed targets, recent history | stored publications and connections | Control center (`GET /api/dashboard`) |
| SEO / GEO / schema / metadata / performance scores per scan | live scans | SEO & GEO Center |
| Score history and trends, deltas between scans | append-only scan store | Site detail, `TrendChart` |
| Core Web Vitals (LCP, CLS, INP / TBT) and Lighthouse performance | Google PageSpeed Insights (CrUX field data when available) | Site detail, performance category |
| Form submissions | stored submissions | Forms inbox, JSON export |
| Deployment and verification activity | per-project event log | Vercel & Deploy |

![Analytics](../assets/screenshots/analytics.png)

## Architecture notes

- **Operational metrics** are computed on request from the same records the rest of the panel uses; there is no
  separate metrics store to drift out of sync.
- **Scan history** is append-only: each scan is its own create-only Blob object named with an inverted timestamp,
  `roistation-master/seo/scans/<site-id>/<inverted-ms>-<rand>.json`, so "newest N" is a listing plus N reads.
- **Performance data** is fetched per scan from PageSpeed Insights v5 (`strategy=mobile`), optionally with
  `PAGESPEED_API_KEY` for a higher quota. When it cannot be measured, the performance checks are `skip` and the
  score is `null`, never 0.
- **Exports** are admin-only JSON downloads of stored data.

## The code

### 1. Operational counters from the source records

**Source:** `app/api/dashboard/route.ts`

```ts
export async function GET(request:Request) {
  try {
    await requireAdmin(request);const [rows,connections]=await Promise.all([listAllPublications(),listConnections()]);
    const targets=rows.flatMap(row=>Object.values(row.document.targets));
    return Response.json({connected:connections.filter(c=>c.verified).length,published:targets.filter(t=>effectiveStatus(t)==="published").length,scheduled:targets.filter(t=>effectiveStatus(t)==="scheduled").length,failed:targets.filter(t=>t.status==="failed").length,events:rows.flatMap(row=>row.document.events.slice(-3).map(event=>({...event,title:row.document.title}))).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,8)},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return apiFailure(error);}
}
```

Counts are **per target**, not per publication: one article live on three sites counts as three. `effectiveStatus`
is used so a scheduled target whose time has passed is already counted as published.

### 2. Append-only scan history

**Source:** `lib/seo/store.ts`

```ts
const MAX_TS = 9_999_999_999_999;
const nameFor = (at: string) => `${String(MAX_TS - Date.parse(at)).padStart(13, "0")}-${randomBytes(3).toString("hex")}`;
const timeOf = (pathname: string) => MAX_TS - Number(pathname.slice(pathname.lastIndexOf("/") + 1).split("-")[0]);
// …
export async function saveScan(scan: ScanResult) {
  await createJson(blobPaths.seoScan(scan.siteId, nameFor(scan.scannedAt)), scan);
  return scan;
}
// …
export async function scanHistory(siteId: string, limit = 12, index?: Map<string, string[]>) {
  const paths = ((index ?? await scanIndex()).get(siteId) || []).slice(0, limit);
  return (await mapLimit(paths, 6, readScan)).filter((scan): scan is ScanResult => Boolean(scan));
}
```

History is never rewritten, so a trend line can always be traced back to the exact scan documents behind it. Each
scan stores its full check list, which also powers "resolved since last scan" in the report
(`checkHistory` in `GET /api/seo/report`).

### 3. Portfolio totals and re-scan signal

**Source:** `lib/seo/dashboard.ts`

```ts
const average = (values: (number | null | undefined)[]) => { const list = values.filter((value): value is number => typeof value === "number"); return list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null; };
// …
  const scanned = rows.filter((row) => row.latest);
  return {
    sites: rows,
    totals: scanned.length ? {
      scanned: scanned.length,
      seo: average(scanned.map((row) => row.latest!.scores.seo)), geo: average(scanned.map((row) => row.latest!.scores.geo)),
      schema: average(scanned.map((row) => row.latest!.scores.schema)), metadata: average(scanned.map((row) => row.latest!.scores.metadata)),
      performance: average(scanned.map((row) => row.latest!.scores.performance)),
      issues: scanned.reduce((sum, row) => sum + row.improvements, 0),
      autoFixable: scanned.reduce((sum, row) => sum + row.autoFixable, 0),
      lastScanAt: scanned.map((row) => row.latest!.scannedAt).sort().at(-1) ?? null,
    } : null,
```

Averages skip unmeasured values instead of treating them as zero, and `totals` is `null` until at least one site
has been scanned, so the UI shows an empty state rather than a portfolio average of 0.

### 4. Core Web Vitals ingestion: field first, lab fallback

**Source:** `lib/seo/scanner.ts`

```ts
    const data = await response.json() as { lighthouseResult?: { categories?: { performance?: { score?: number } }; audits?: Record<string, { numericValue?: number; score?: number | null }> }; loadingExperience?: { metrics?: Record<string, { percentile?: number }> } };
    const audits = data.lighthouseResult?.audits || {};
    const field = data.loadingExperience?.metrics || {};
    const perf = data.lighthouseResult?.categories?.performance?.score;
    const fieldLcp = field.LARGEST_CONTENTFUL_PAINT_MS?.percentile; const fieldCls = field.CUMULATIVE_LAYOUT_SHIFT_SCORE?.percentile; const fieldInp = field.INTERACTION_TO_NEXT_PAINT?.percentile;
    const useField = typeof fieldLcp === "number";
    return {
      measured: typeof perf === "number", source: useField ? "field" : "lab", score: typeof perf === "number" ? Math.round(perf * 100) : null,
      lcpMs: useField ? fieldLcp! : audits["largest-contentful-paint"]?.numericValue ?? null,
      cls: typeof fieldCls === "number" ? fieldCls / 100 : audits["cumulative-layout-shift"]?.numericValue ?? null,
      inpMs: typeof fieldInp === "number" ? fieldInp : null,
      tbtMs: audits["total-blocking-time"]?.numericValue ?? null,
    };
```

Chrome UX Report reports CLS as an integer percentile ×100, hence `/ 100`. INP only exists as field data; without
it the interactivity check falls back to lab Total Blocking Time and says so in the finding. Thresholds follow
Google's published "good / needs improvement" bands (LCP ≤ 2.5 s / ≤ 4 s, CLS ≤ 0.1 / ≤ 0.25, INP ≤ 200 / ≤ 500 ms).

### 5. Trend chart over stored scans

**Source:** `components/seo/primitives.tsx`

```tsx
/** SEO & GEO over scans. One 0–100 axis, 2px lines, end labels, legend, crosshair tooltip. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  // …
  // Drawn at the real pixel width so text and strokes never scale with the page.
  const W = width, H = 200, L = 30, R = 44, T = 12, B = 26;
  const data = [...points].reverse();
  if (data.length < 2) return <p className="sx-muted">Trend grafiği ikinci taramadan sonra görünür.</p>;
  const x = (i: number) => L + (i * (W - L - R)) / (data.length - 1);
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100;
  // An unmeasured scan breaks the line instead of being bridged, so a gap is never drawn as a trend.
  const path = (key: "seo" | "geo") => data.map((point, i) => point[key] === null ? null : `${i === 0 || data[i - 1][key] === null ? "M" : "L"} ${x(i)},${y(point[key]!)}`).filter(Boolean).join(" ");
```

The chart is fed directly from `history` (newest first, hence the reverse). With fewer than two scans it shows a
sentence (*"the trend chart appears after the second scan"*) instead of a single dot pretending to be a trend.
See [component-library.md](component-library.md) for the rendering details.

### 6. Submission export

**Source:** `app/api/submissions/export/route.ts`

```ts
export async function GET(request:Request) {
  try {await requireAdmin(request);const submissions=await listAllSubmissions();return Response.json({exportedAt:new Date().toISOString(),submissions},{headers:{"Cache-Control":"no-store","Content-Disposition":"attachment; filename=roistation-form-talepleri.json"}});} catch(error) {return apiFailure(error);}
}
```

Each submission carries its consent text and consent timestamp (`consent_text`, `consent_at`), captured at write
time from the form definition, so the export is also the record of what the person agreed to.

## Engineering notes

- **Cost of "live" counters.** The dashboard lists and reads all publications and connections on each load. A
  per-instance, version-keyed document cache (`readAllJson` in `lib/blob-store.ts`) avoids re-reading unchanged
  objects, but the Blob listing itself is a billed operation (noted in the README).
- **History reads are bounded**: the report reads the newest 12 scans; the dashboard reads the newest 2 per site.
  There is no retention policy for scans yet; history grows by one object per scan.
- **Gaps in lines.** `path()` starts a new subpath (`M`) after every `null` point, so an unmeasured scan in the
  middle of a series shows up as a visible gap instead of being bridged by a line that implies a measurement.
- **What would be analytics (roadmap):** page views or conversions per published article would require either a
  first-party beacon in the connector kit or a Search Console / GA4 integration. Neither exists today.

## Why it is built this way

**Decision:** measure what the agency controls and can verify (publishing state, site quality, performance), from
primary sources, and store it append-only; do not collect visitor data.

**Alternatives considered:**
- *Embedding a third-party analytics script in the connector.* Would instantly give traffic numbers, but it would
  put a tracking dependency and consent obligations on every client site through a component that is supposed to
  render content.
- *A time-series database for scores.* Better for large histories; unnecessary at one scan per site per deploy or
  per manual run.
- *Pre-aggregated counters.* Faster reads, but another write path that can disagree with the source records.

**Trade-offs accepted:** no traffic or conversion metrics; dashboards compute on read. In exchange, every number is
reproducible from stored records and there is no personal data beyond form submissions users actively send.

## Best practices demonstrated

- Derive metrics from the system of record instead of a parallel store.
- `null` for "not measured" through the whole pipeline, including averages.
- Append-only, lexically ordered history objects.
- Prefer field data, fall back to lab data, and label which one was used.
- Exports that include consent context.

## Related

- [docs/SEO-Engine.md](../docs/SEO-Engine.md) · [docs/API.md](../docs/API.md) ·
  [SEO flow](../docs/diagrams/seo-flow.svg)
- Sibling walkthroughs: [seo-engine.md](seo-engine.md), [component-library.md](component-library.md),
  [dashboard-layout.md](dashboard-layout.md), [publishing-engine.md](publishing-engine.md)
