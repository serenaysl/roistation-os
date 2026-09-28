/*
 * Example: sitemaps — the feed of published ROIstation pages, the connector's Next.js sitemap
 * entries, and the sitemap the optimizer writes for a site that has none.
 *
 * Demonstrates:
 *   - `sitemapXml()`: the XML served at /api/site-sitemap?siteId=… for non-Next.js sites, with
 *     every value XML-escaped and <lastmod> from the publication's last update,
 *   - `sitemapEntries()`: what `roistationSitemapEntries()` returns inside a client site's
 *     app/sitemap.ts (SEO pages priority 0.7, blog posts 0.6), and the kit's template file,
 *   - `planSitemap()`: when the scan finds no sitemap and the repo has neither app/sitemap.* nor
 *     public/sitemap.xml, the file is generated from URLs the scan actually discovered, minus
 *     anything that returned 4xx/5xx or was unreachable, capped at 500 URLs,
 *   - reading <loc> entries back (the scanner's sitemap check).
 *
 * Source: lib/publishing/page-model.ts (sitemapXml), app/api/site-sitemap/route.ts,
 *         connectors/roistation/client.ts (roistationSitemapEntries),
 *         connectors/templates/app/sitemap.ts, lib/seo/fixes.ts (planFixes sitemap step),
 *         lib/seo/html.ts (sitemapLocs), lib/seo/scanner.ts (sitemap check)
 *
 * Differences from production: pages are passed in instead of being derived from stored
 * publications; `sitemapEntries()` receives the page list instead of fetching
 * /api/site-pages; the template's ROISTATION_SITE_URL is an argument; `MetadataRoute.Sitemap`
 * is a local structural type. The scan is narrowed to the fields the sitemap step reads.
 */

export type PageSummary = { id: string; slug: string; path: string; url: string; location: "seo-page" | "blog"; title: string; updatedAt: string };
/** Structural subset of Next.js MetadataRoute.Sitemap. */
export type SitemapEntry = { url: string; lastModified?: Date; changeFrequency?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never"; priority?: number };

/* ------------------------------------------------ lib/publishing/page-model.ts */

export function sitemapXml(pages: Pick<PageSummary, "url" | "updatedAt">[]) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const urls = pages.map((page) => `  <url><loc>${escape(page.url)}</loc><lastmod>${escape(page.updatedAt)}</lastmod></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}

/* ------------------------------------------- connectors/roistation/client.ts */

/** Spread into the site's app/sitemap.ts: every published SEO page and blog post. */
export function sitemapEntries(pages: PageSummary[]): SitemapEntry[] {
  return pages.map((page) => ({ url: page.url, lastModified: new Date(page.updatedAt), changeFrequency: "monthly", priority: page.location === "seo-page" ? 0.7 : 0.6 }));
}

/** connectors/templates/app/sitemap.ts body: the home page (when ROISTATION_SITE_URL is set) + ROIstation pages. */
export function templateSitemap(base: string, entries: SitemapEntry[]): SitemapEntry[] {
  return [
    ...(base ? [{ url: `${base}/`, changeFrequency: "weekly" as const, priority: 1 }] : []),
    ...entries,
  ];
}

/* ------------------------------------------------------- lib/seo/html.ts + scanner */

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) { const n = parseInt(lower.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : match; }
    if (lower.startsWith("#")) { const n = parseInt(lower.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : match; }
    return entities[lower] ?? match;
  });
}
export function sitemapLocs(xml: string) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => decodeEntities(match[1]));
}
export function sitemapCheck(body: string | null, candidate: string) {
  const sitemapOk = body !== null && /<(urlset|sitemapindex)/i.test(body);
  const locs = body !== null ? sitemapLocs(body) : [];
  return sitemapOk ? (locs.length ? { status: "pass", finding: `Sitemap ${locs.length} URL içeriyor.` } : { status: "warn", finding: "Sitemap bulundu ancak URL içermiyor." }) : { status: "fail", finding: `Sitemap bulunamadı: ${candidate}` };
}

/* ---------------------------------------------------------- lib/seo/fixes.ts */

export type SitemapScan = { scannedAt: string; failing: string[]; pages: { url: string; status: number | null }[]; facts: { brokenLinks: string[]; discoveredUrls: string[] } };
export type FileChange = { path: string; content: string; action: "create" | "update"; checkIds: string[]; description: string };
const js = (value: unknown) => JSON.stringify(value, null, 2);

/** The sitemap step of planFixes(). `appDir` is set for the Next.js App Router; `installKit` when the connector kit is added in the same PR. */
export function planSitemap(input: { scan: SitemapScan; origin: string; has: (file: string) => boolean; framework: "next-app" | "next-pages" | "static" | "unknown"; appDir: string | null; ts: boolean; installKit: boolean }) {
  const { scan, origin, appDir, ts, installKit, framework } = input;
  const failing = (id: string) => scan.failing.includes(id);
  const publicDir = framework === "static" ? "" : "public/";
  const sitemapCode = appDir ? ["ts", "js"].map((ext) => `${appDir}/sitemap.${ext}`).find((file) => input.has(file)) || null : null;
  if (failing("sitemap") && !sitemapCode && !input.has(`${publicDir}sitemap.xml`)) {
    const originHost = new URL(origin).hostname.replace(/^www\./, "");
    // Never list URLs the scan found broken (4xx/5xx/unreachable).
    const brokenPaths = new Set([...scan.facts.brokenLinks.map((entry) => entry.split(" → ")[0]), ...scan.pages.filter((page) => !page.status || page.status >= 400).map((page) => { const parsed = new URL(page.url); return `${parsed.pathname}${parsed.search}`; })]);
    const urls = [...new Set([`${origin}/`, ...scan.facts.discoveredUrls.filter((url) => { try { const parsed = new URL(url); return parsed.hostname.replace(/^www\./, "") === originHost && !/\.(pdf|jpe?g|png|webp|gif|svg|zip)$/i.test(parsed.pathname) && !brokenPaths.has(`${parsed.pathname}${parsed.search}`); } catch { return false; } }).map((url) => url.split("#")[0])])].slice(0, 500);
    if (appDir) return { file: { path: `${appDir}/sitemap.${ts ? "ts" : "js"}`, action: "create", checkIds: ["sitemap"], description: `sitemap.xml: taramada bulunan ${urls.length} URL${installKit ? " + ROIstation SEO sayfaları" : ""}.`, content: `${ts ? 'import type { MetadataRoute } from "next";\n' : ""}${installKit ? 'import { roistationSitemapEntries } from "@/components/roistation/client";\n' : ""}\n// URLs discovered by the ROIstation scan on ${scan.scannedAt.slice(0, 10)}. Add new pages here${installKit ? "; ROIstation SEO pages are added automatically" : ""}.\nconst urls = ${js(urls)};\n\nexport const revalidate = 3600;\n\nexport default async function sitemap()${ts ? ": Promise<MetadataRoute.Sitemap>" : ""} {\n  return [\n    ...urls.map((url) => ({ url, changeFrequency: "weekly"${ts ? " as const" : ""} })),${installKit ? "\n    ...(await roistationSitemapEntries().catch(() => [])),": ""}\n  ];\n}\n` } satisfies FileChange, manual: null };
    if (framework !== "unknown") return { file: { path: `${publicDir}sitemap.xml`, action: "create", checkIds: ["sitemap"], description: `sitemap.xml: taramada bulunan ${urls.length} URL.`, content: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${url.replace(/&/g, "&amp;")}</loc></url>`).join("\n")}\n</urlset>\n` } satisfies FileChange, manual: null };
  } else if (failing("sitemap") && installKit && sitemapCode) return { file: null, manual: { checkId: "sitemap", description: `Mevcut ${sitemapCode} dosyasına \`...(await roistationSitemapEntries())\` ekleyin; ROIstation SEO sayfaları sitemap'e girer.` } };
  return { file: null, manual: null };
}

/* ------------------------------------------------------------------ demo */

export function demo() {
  const origin = "https://zeytinlik.example";
  const pages: PageSummary[] = [
    { id: "p1", slug: "focada-en-iyi-balik", path: "/rehber/focada-en-iyi-balik", url: `${origin}/rehber/focada-en-iyi-balik`, location: "seo-page", title: "Foça'da En İyi Balık", updatedAt: "2026-01-12T09:00:00.000Z" },
    { id: "p2", slug: "meze-ve-zeytinyagli", path: "/blog/meze-ve-zeytinyagli", url: `${origin}/blog/meze-ve-zeytinyagli`, location: "blog", title: "Meze & zeytinyağlı", updatedAt: "2026-01-15T09:00:00.000Z" },
  ];
  const feed = sitemapXml(pages);
  const plan = planSitemap({
    scan: {
      scannedAt: "2026-01-20T08:00:00.000Z", failing: ["sitemap"],
      pages: [{ url: `${origin}/`, status: 200 }, { url: `${origin}/eski-menu`, status: 404 }],
      facts: { brokenLinks: ["/kampanya → 404"], discoveredUrls: [`${origin}/`, `${origin}/menu`, `${origin}/eski-menu`, `${origin}/kampanya`, `${origin}/menu.pdf`, "https://external.example/zeytinlik", `${origin}/iletisim#harita`] },
    },
    origin, has: () => false, framework: "next-app", appDir: "app", ts: true, installKit: true,
  });
  return {
    feed,
    readBack: { locs: sitemapLocs(feed), check: sitemapCheck(feed, `${origin}/sitemap.xml`) },
    nextEntries: templateSitemap(origin, sitemapEntries(pages)),
    plan,
  };
}

if (/sitemap\.ts$/.test(process.argv[1] ?? "")) { const result = demo(); console.log(result.feed); console.log(JSON.stringify({ readBack: result.readBack, nextEntries: result.nextEntries }, null, 2)); console.log(`\n--- ${result.plan.file?.path}\n${result.plan.file?.content}`); }
