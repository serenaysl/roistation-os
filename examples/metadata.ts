/*
 * Example: page metadata — produced centrally for published pages, converted to Next.js
 * `Metadata` inside client sites, and added to a client site's root layout by the optimizer.
 *
 * Demonstrates:
 *   - `pageSeo()`: meta title (<= 70 chars) and description (<= 160 chars) with word-boundary
 *     truncation, explicit index/follow robots with max-snippet / max-image-preview, Open Graph
 *     `article` with published/modified times, and a Twitter summary card,
 *   - `roistationMetadata()`: the connector kit's mapping of that model to Next.js Metadata
 *     (generateMetadata in app/rehber/[slug]/page.tsx),
 *   - `layoutMetadataFix()`: when title / description / canonical / OG / Twitter checks fail, a
 *     typed `export const metadata` is appended to app/layout.tsx using values from the live
 *     scan; a layout that already defines metadata (or is a client component) is never edited
 *     and gets a precise manual item instead.
 *
 * Source: lib/publishing/page-model.ts (getSitePage: metaTitle, metaDescription, seo),
 *         connectors/roistation/client.ts (roistationMetadata), lib/seo/fixes.ts (planFixes
 *         metadata step, addImport), lib/publishing/content.ts (truncate)
 *
 * Differences from production: `Metadata` is a local structural type instead of the import from
 * "next"; `pageSeo()` receives the already-resolved fields instead of reading the publication,
 * the site origin and the business profile; the layout step is shown on its own (production
 * combines it with the JSON-LD component and <html lang> edits into one layout change).
 */

/** lib/publishing/content.ts */
export function truncate(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).replace(/\s+\S*$/, "").replace(/[,;:.\s]+$/, "")}…`;
}

/* ----------------------------------------------- lib/publishing/page-model.ts */

export type PageSeo = {
  canonical: string;
  robots: { index: true; follow: true; "max-snippet": -1; "max-image-preview": "large" };
  openGraph: { type: "article"; url: string; title: string; description: string; siteName: string; locale: "tr_TR"; publishedTime: string; modifiedTime: string };
  twitter: { card: "summary"; title: string; description: string };
};

export function pageSeo(input: { canonical: string; title: string; metaTitle?: string; metaDescription?: string; excerpt: string; siteName: string; publishedAt: string; updatedAt: string }) {
  const metaTitle = truncate(input.metaTitle?.trim() || input.title, 70);
  const metaDescription = truncate(input.metaDescription?.trim() || input.excerpt, 160);
  const seo: PageSeo = {
    canonical: input.canonical,
    robots: { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large" },
    openGraph: { type: "article", url: input.canonical, title: metaTitle, description: metaDescription, siteName: input.siteName, locale: "tr_TR", publishedTime: input.publishedAt, modifiedTime: input.updatedAt },
    twitter: { card: "summary", title: metaTitle, description: metaDescription },
  };
  return { metaTitle, metaDescription, seo };
}

/* ------------------------------------------- connectors/roistation/client.ts */

/** Structural subset of Next.js `Metadata` used by the connector. */
export type Metadata = {
  title?: string; description?: string; alternates?: { canonical?: string };
  robots?: { index?: boolean; follow?: boolean; googleBot?: { index?: boolean; follow?: boolean; "max-snippet"?: number; "max-image-preview"?: "none" | "standard" | "large" } };
  openGraph?: { type?: "article" | "website"; url?: string; title?: string; description?: string; siteName?: string; locale?: string; publishedTime?: string; modifiedTime?: string };
  twitter?: { card?: "summary" | "summary_large_image"; title?: string; description?: string };
};
export type RoistationPageMeta = { metaTitle: string; metaDescription: string; seo: { canonical: string; robots: { index: boolean; follow: boolean }; openGraph: PageSeo["openGraph"]; twitter: PageSeo["twitter"] } };

export function roistationMetadata(page: RoistationPageMeta): Metadata {
  return {
    title: page.metaTitle,
    description: page.metaDescription,
    alternates: { canonical: page.seo.canonical },
    robots: { index: page.seo.robots.index, follow: page.seo.robots.follow, googleBot: { index: page.seo.robots.index, follow: page.seo.robots.follow, "max-snippet": -1, "max-image-preview": "large" } },
    openGraph: { type: "article", url: page.seo.openGraph.url, title: page.seo.openGraph.title, description: page.seo.openGraph.description, siteName: page.seo.openGraph.siteName, locale: page.seo.openGraph.locale, publishedTime: page.seo.openGraph.publishedTime, modifiedTime: page.seo.openGraph.modifiedTime },
    twitter: { card: page.seo.twitter.card, title: page.seo.twitter.title, description: page.seo.twitter.description },
  };
}

/* --------------------------------------------------- lib/seo/fixes.ts (layout) */

type ScanFacts = { title: string | null; metaDescription: string | null; firstParagraph: string | null; ogImage: string | null };
type Check = { id: string; status: "pass" | "warn" | "fail" | "skip" };
export type ManualItem = { checkId: string; description: string };
const js = (value: unknown) => JSON.stringify(value, null, 2);

function addImport(source: string, statement: string) {
  const lines = source.split("\n");
  let last = -1;
  lines.forEach((line, index) => { if (/^import\s/.test(line.trim())) last = index; });
  if (last === -1) { const directive = /^\s*["']use (client|server)["'];?\s*$/.test(lines[0] || "") ? 1 : 0; lines.splice(directive, 0, statement); }
  else { let end = last; while (end < lines.length && !/;\s*$|from\s+["'][^"']+["']\s*$/.test(lines[end])) end++; lines.splice(end + 1, 0, statement); }
  return lines.join("\n");
}

export function layoutMetadataFix(input: { checks: Check[]; facts: ScanFacts; siteName: string; origin: string; layout: string; source: string }) {
  const { facts, origin, layout } = input;
  let source = input.source;
  const manual: ManualItem[] = [];
  const failing = (id: string) => input.checks.some((check) => check.id === id && (check.status === "fail" || check.status === "warn"));
  const ts = /\.tsx?$/.test(layout);
  const clientLayout = /^\s*["']use client["']/.test(source);
  const metaChecks = ["title", "meta-description", "canonical", "open-graph", "twitter-card"].filter((id) => failing(id));
  if (!metaChecks.length) return { source, manual, checkIds: [] as string[] };
  const hasMetadata = /export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b)/.test(source);
  // The live title is kept unless it is missing or too short to describe the site.
  const title = facts.title && facts.title.length >= 10 ? facts.title : input.siteName;
  const description = facts.metaDescription || (facts.firstParagraph ? truncate(facts.firstParagraph, 155) : null);
  const metadata = { metadataBase: `__URL__`, title, ...(description ? { description } : {}), alternates: { canonical: "/" }, openGraph: { type: "website", url: `${origin}/`, siteName: input.siteName, locale: "tr_TR", title, ...(description ? { description } : {}), ...(facts.ogImage ? { images: [facts.ogImage] } : {}) }, twitter: { card: facts.ogImage ? "summary_large_image" : "summary", title, ...(description ? { description } : {}) } };
  const literal = js(metadata).replace('"__URL__"', `new URL("${origin}")`);
  if (!hasMetadata && !clientLayout) {
    if (ts) source = addImport(source, 'import type { Metadata } from "next";');
    source = `${source.replace(/\s*$/, "")}\n\n// Added by ROIstation SEO optimization (values from the live site scan).\nexport const metadata${ts ? ": Metadata" : ""} = ${literal};\n`;
    if (!description) manual.push({ checkId: "meta-description", description: "Sitede açıklama olarak kullanılabilecek metin bulunamadı; metadata.description alanına 120–155 karakterlik bir açıklama yazın." });
    return { source, manual, checkIds: metaChecks };
  }
  manual.push({ checkId: metaChecks[0], description: `${layout} zaten metadata tanımlıyor${clientLayout ? " veya istemci bileşeni" : ""}; şu alanları mevcut metadata ile birleştirin (${metaChecks.join(", ")}):\n\n${literal}` });
  return { source: input.source, manual, checkIds: [] as string[] };
}

/* ------------------------------------------------------------------ demo */

export function demo() {
  const { metaTitle, metaDescription, seo } = pageSeo({
    canonical: "https://zeytinlik.example/rehber/focada-en-iyi-balik", title: "Foça'da En İyi Balık",
    excerpt: "Foça'da taze balık ve zeytinyağlı meze arayanlar için sahildeki restoranlar, rezervasyon önerileri, mevsime göre balık seçimi ve fiyat aralıkları hakkında kısa bir rehber.",
    siteName: "Zeytinlik Restoran", publishedAt: "2026-01-10T09:00:00.000Z", updatedAt: "2026-01-12T09:00:00.000Z",
  });
  const layout = `import "./globals.css";\n\nexport default function RootLayout({ children }: { children: React.ReactNode }) {\n  return <html lang="tr"><body>{children}</body></html>;\n}\n`;
  const fix = layoutMetadataFix({
    checks: [{ id: "meta-description", status: "fail" }, { id: "twitter-card", status: "fail" }],
    facts: { title: "Zeytinlik Restoran | Foça", metaDescription: null, firstParagraph: "Zeytinlik Restoran, Foça sahilinde mevsim ürünleriyle hazırlanan mezeler ve günlük balık sunar.", ogImage: null },
    siteName: "Zeytinlik Restoran", origin: "https://zeytinlik.example", layout: "app/layout.tsx", source: layout,
  });
  return { page: roistationMetadata({ metaTitle, metaDescription, seo }), layoutFix: fix };
}

if (/metadata\.ts$/.test(process.argv[1] ?? "")) { const result = demo(); console.log(JSON.stringify(result.page, null, 2)); console.log(`\n--- app/layout.tsx (${result.layoutFix.checkIds.join(", ")})\n${result.layoutFix.source}`); }
