# Advanced SEO / GEO Analytics

Definitions, formulas and worked examples for the analytics layer of the Client Portal. Basic ranking numbers answer *"where are we?"*. These metrics answer *"is it working, where, and why?"*

> **Status.** The metrics below can be computed from data the Master Panel already stores: weekly ranking snapshots, publication records and live SEO & GEO scans. In the portal they are **Preview** unless stated otherwise. See [feature status](README.md#feature-status). All numbers on this page are **demo data** for the fictional *ROIstation Demo Hotel*.

## Inputs

| Source | Produced by | Used for |
|---|---|---|
| Ranking snapshots | Automatic Rank Tracker (weekly, append-only) | Positions, coverage, momentum, winners/losers, device and location views |
| Publications | Master Panel publishing engine (`/rehber/<slug>`, knowledge-center articles) | SEO / GEO publication count and timeline |
| Readiness checks and live scans | Vercel verification and SEO & GEO Center | Website health |

Notation: for a tracked row *k* (keyword + location + device), `rank(k, t)` is its position in snapshot *t*. Rows with no rank (not found within the search depth) are left out of averages and counted as outside the Top 10.

---

## Visibility Trend

An estimate of overall visibility across all tracked keywords, so that movement near the top of the results counts more than movement far down.

```text
visibility(t) = Σ ctr(rank(k, t)) / (N × ctr(1)) × 100 %
```

`ctr(r)` is a click-through curve by position. The demo uses a typical organic CTR curve (position 1 ≈ 31.7 %, 2 ≈ 24.7 %, 3 ≈ 18.7 %, … 10 ≈ 2.5 %, 11–20 ≈ 1 %, below that ≈ 0.5 %). 100 % would mean every keyword ranks first. The value estimates *share of possible clicks*. It is not measured traffic. Measured clicks need Google Search Console, which is [planned](README.md#planned--roadmap).

| Week | 07 Sep | 14 Sep | 21 Sep | 28 Sep |
|---|---|---|---|---|
| Visibility (demo) | 4.0 % | 5.5 % | 12.1 % | 29.1 % |

## Top 10 Coverage

```text
top10Coverage(t) = |{k : rank(k, t) ≤ 10}| / N
```

Demo: 8 of 12 keywords in the Top 10 on 28 Sep, so **67 %** (2 of 12, 17 %, on 07 Sep).

## Top 3 Coverage

```text
top3(t) = |{k : rank(k, t) ≤ 3}|
```

Demo: **3 keywords** in the Top 3 on 28 Sep (`ayvalik seaside hotel` 1, `cunda island hotel` 2, `ayvalik family hotel` 3).

## Ranking Momentum

The net number of positions gained across all rows between two snapshots:

```text
momentum(a → b) = Σ (rank(k, a) − rank(k, b))
```

Positive means the keyword set moved up overall. Example wording: **"+28 total ranking positions gained this week."** In the demo data, the last week (21 → 28 Sep) is **+19** (8 rows up, 2 down), and the whole month (07 → 28 Sep) is **+75** (80 gained, 5 lost).

## Keyword Winners

The rows with the largest positive `rank(k, a) − rank(k, b)` in the period. Demo (07 → 28 Sep):

| Keyword | Start | End | Change |
|---|---|---|---|
| ayvalik family hotel | 20 | 3 | +17 |
| cunda island hotel | 15 | 2 | +13 |
| ayvalik seaside hotel | 13 | 1 | +12 |

## Keyword Losers

Rows with a negative change, listed early so they can be reviewed. Demo:

| Keyword | Location | Start | End | Change |
|---|---|---|---|---|
| ayvalik hotel deals | Edremit, Balıkesir | 10 | 12 | −2 |
| gomec hotel | Gömeç, Balıkesir | 11 | 14 | −3 |

## Average Position

```text
avgPosition(t) = Σ rank(k, t) / |ranked rows|
```

Lower is better. Example wording: previous average **14.2**, current average **8.7**. In the demo report: **13.8 → 7.6** over September (13.8, 11.6, 9.2, 7.6 by week).

Read average position together with coverage. A new keyword that enters at position 60 raises the average even though visibility improved.

## Local SEO

Each keyword row has its own location, so one search can be tracked in several towns:

| Keyword (mobile, 28 Sep, demo) | Ayvalık, Balıkesir | Edremit, Balıkesir | Gömeç, Balıkesir |
|---|---|---|---|
| ayvalik hotel | 5 | 9 | 12 |

A business can rank well in its own town and weaker in nearby towns. Location-specific guide pages are the usual response.

## Device Comparison

The same keyword tracked as two rows, one `mobile` and one `desktop`:

| Keyword (28 Sep, demo) | Mobile | Desktop | Gap |
|---|---|---|---|
| ayvalik hotel | 5 | 7 | mobile +2 |
| ayvalik boutique hotel | 4 | 5 | mobile +1 |
| sarimsakli hotel | 9 | 10 | mobile +1 |
| ayvalik accommodation | 10 | 12 | mobile +2 |
| beachfront hotel ayvalik | 8 | 9 | mobile +1 |

## SEO / GEO Publications

The number and dates of SEO/GEO guide pages published to the site through the Master Panel, shown next to the ranking timeline. Demo (September):

| Date | Page | Path | Strategy |
|---|---|---|---|
| 03.09.2026 | Where to stay in Ayvalık: area guide | `/rehber/ayvalikta-nerede-kalinir` | SEO + GEO |
| 10.09.2026 | Sarımsaklı beach guide | `/rehber/sarimsakli-plaji` | SEO + GEO |
| 17.09.2026 | Cunda Island travel guide | `/rehber/cunda-adasi-gezi-rehberi` | AI-answer |
| 24.09.2026 | Ayvalık breakfast guide | `/rehber/ayvalik-kahvalti` | SEO |

Publications and ranking changes happen in the same period, but that does not prove cause. Rankings also depend on competitors, search-engine updates and seasonality.

## Website Health

A client-friendly summary of the Master Panel's readiness checks and the latest live scan:

| Indicator | Source | Demo state |
|---|---|---|
| Runtime Connected | Runtime verification (HMAC challenge–response) | OK |
| Publish Ready | All readiness checks passed | OK |
| Knowledge Ready | Knowledge center release live | OK |
| Sitemap | Scan: sitemap reachable, published pages listed | OK (42 URLs) |
| Schema | Scan: JSON-LD present and valid | OK |
| Metadata | Scan: titles and meta descriptions | Warning: 2 pages without a description |
| Canonical | Scan: canonical URLs | OK |
| Indexability | Scan: robots rules, `noindex`, status codes | OK |

The summary score shown to the client is the site's technical SEO score from the latest scan (demo: **94 / 100**).

---

See the complete sample report: [demo-report.md](demo-report.md).
