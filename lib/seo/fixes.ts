import { readFile as readLocal } from "node:fs/promises";
import path from "node:path";
import type { ScanResult } from "@/lib/seo/scanner";
import type { BusinessProfile } from "@/lib/publishing/business";
import { isLocalBusinessType, areaServed } from "@/lib/publishing/business";
import { truncate } from "@/lib/publishing/content";

/*
 * Plans repository changes for an SEO/GEO scan. Only changes that can be made exactly
 * and safely are automated (new files, or single well-defined insertions into layout /
 * index.html). Everything else becomes a precise manual item in the pull request with
 * the evidence from the scan. Values come from the live scan and configured business
 * data (SITE_BUSINESS_JSON); nothing is invented.
 */

export type FileChange = { path: string; content: string; action: "create" | "update"; checkIds: string[]; description: string };
export type ManualItem = { checkId: string; description: string };
export type FixPlan = { files: FileChange[]; manual: ManualItem[]; installKit: boolean; framework: "next-app" | "next-pages" | "static" | "unknown" };
type RepoReader = { has: (file: string) => boolean; read: (file: string) => Promise<string | null> };

const failing = (scan: ScanResult, id: string) => scan.checks.some((check) => check.id === id && (check.status === "fail" || check.status === "warn"));
const evidence = (scan: ScanResult, id: string) => scan.checks.find((check) => check.id === id);
const first = (repo: RepoReader, candidates: string[]) => candidates.find((file) => repo.has(file)) || null;
const js = (value: unknown) => JSON.stringify(value, null, 2);

function stripJsonComments(text: string) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1").replace(/,\s*([}\]])/g, "$1");
}

async function aliasRoot(repo: RepoReader): Promise<string | null> {
  for (const file of ["tsconfig.json", "jsconfig.json"]) {
    if (!repo.has(file)) continue;
    try {
      const config = JSON.parse(stripJsonComments(await repo.read(file) || "{}")) as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
      const target = config.compilerOptions?.paths?.["@/*"]?.[0];
      if (!target) continue;
      const base = (config.compilerOptions?.baseUrl || ".").replace(/^\.\/?/, "");
      const joined = path.posix.normalize(path.posix.join(base || ".", target.replace(/\*$/, ""))).replace(/\/+$/, "");
      return joined === "." || joined === "" ? "" : `${joined.replace(/^\.\//, "")}/`;
    } catch { continue; }
  }
  return null;
}

export function schemaFor(profile: BusinessProfile, origin: string, strategyLocal: boolean) {
  const local = strategyLocal && isLocalBusinessType(profile.schemaType);
  const node: Record<string, unknown> = { "@context": "https://schema.org", "@type": local ? profile.schemaType : "Organization", "@id": `${origin}/#organization`, name: profile.name, url: `${origin}/` };
  if (profile.logo) node.logo = profile.logo;
  if (profile.telephone) node.telephone = profile.telephone;
  if (profile.email) node.email = profile.email;
  if (profile.sameAs?.length) node.sameAs = profile.sameAs;
  if (local) {
    if (profile.streetAddress || profile.locality) node.address = { "@type": "PostalAddress", ...(profile.streetAddress ? { streetAddress: profile.streetAddress } : {}), ...(profile.postalCode ? { postalCode: profile.postalCode } : {}), ...(profile.locality ? { addressLocality: profile.locality } : {}), ...(profile.region ? { addressRegion: profile.region } : {}), addressCountry: profile.country };
    if (profile.latitude !== undefined && profile.longitude !== undefined) node.geo = { "@type": "GeoCoordinates", latitude: profile.latitude, longitude: profile.longitude };
    if (profile.openingHours?.length) node.openingHours = profile.openingHours;
    if (profile.priceRange) node.priceRange = profile.priceRange;
    if (profile.servesCuisine?.length && profile.schemaType === "Restaurant") node.servesCuisine = profile.servesCuisine;
    const area = areaServed(profile); if (area) node.areaServed = { "@type": "Place", name: area };
    if (profile.mapsUrl) node.hasMap = profile.mapsUrl;
  }
  return node;
}

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

function insertBefore(source: string, marker: RegExp, insertion: string) {
  const matches = source.match(new RegExp(marker.source, "gi"));
  if (!matches || matches.length !== 1) return null;
  return source.replace(marker, (found) => `${insertion}${found}`);
}
function addImport(source: string, statement: string) {
  const lines = source.split("\n");
  let last = -1;
  lines.forEach((line, index) => { if (/^import\s/.test(line.trim())) last = index; });
  if (last === -1) { const directive = /^\s*["']use (client|server)["'];?\s*$/.test(lines[0] || "") ? 1 : 0; lines.splice(directive, 0, statement); }
  else { let end = last; while (end < lines.length && !/;\s*$|from\s+["'][^"']+["']\s*$/.test(lines[end])) end++; lines.splice(end + 1, 0, statement); }
  return lines.join("\n");
}

async function kitFiles(componentsRoot: string, appDir: string) {
  const root = path.join(process.cwd(), "connectors");
  const map: [string, string][] = [
    ["roistation/client.ts", `${componentsRoot}/roistation/client.ts`], ["roistation/article.tsx", `${componentsRoot}/roistation/article.tsx`],
    ["roistation/section.tsx", `${componentsRoot}/roistation/section.tsx`], ["roistation/version.ts", `${componentsRoot}/roistation/version.ts`],
    ["templates/app/rehber/[slug]/page.tsx", `${appDir}/rehber/[slug]/page.tsx`], ["templates/app/rehber/page.tsx", `${appDir}/rehber/page.tsx`],
    ["templates/app/api/roistation/verify/route.ts", `${appDir}/api/roistation/verify/route.ts`], ["templates/app/api/roistation/revalidate/route.ts", `${appDir}/api/roistation/revalidate/route.ts`],
  ];
  return Promise.all(map.map(async ([from, to]) => ({ path: to, content: await readLocal(path.join(root, from), "utf8") })));
}

export async function planFixes(input: { scan: ScanResult; repo: RepoReader; profile: BusinessProfile; origin: string }): Promise<FixPlan> {
  const { scan, repo, profile, origin } = input;
  const files: FileChange[] = []; const manual: ManualItem[] = [];
  const layout = first(repo, ["app/layout.tsx", "app/layout.jsx", "app/layout.js", "app/layout.ts", "src/app/layout.tsx", "src/app/layout.jsx", "src/app/layout.js"]);
  const appDir = layout ? layout.slice(0, layout.lastIndexOf("/")) : null;
  const pagesApp = first(repo, ["pages/_app.tsx", "pages/_app.jsx", "pages/_app.js", "src/pages/_app.tsx", "src/pages/_app.js"]);
  const staticIndex = !layout && !pagesApp ? first(repo, ["index.html"]) : null;
  const framework: FixPlan["framework"] = layout ? "next-app" : pagesApp ? "next-pages" : staticIndex ? "static" : "unknown";
  const ts = layout ? /\.tsx?$/.test(layout) : true;
  const alias = await aliasRoot(repo);
  const componentsRoot = `${alias ?? (appDir?.startsWith("src/") ? "src/" : "")}components`;
  const publicDir = framework === "static" ? "" : "public/";
  const add = (change: FileChange) => { if (!files.some((file) => file.path === change.path)) files.push(change); };

  // Content/GEO gaps are fixed by publishing SEO+GEO pages; that needs the connector kit on the site.
  const contentGaps = ["faq-schema", "question-headings", "ai-readability", "locality-signals", "breadcrumbs"].filter((id) => failing(scan, id));
  const kitPresent = repo.has(`${componentsRoot}/roistation/client.ts`) || (appDir ? [...["page.tsx", "page.jsx", "page.js"].map((f) => `${appDir}/rehber/${f}`)].some((file) => repo.has(file)) : false);
  const installKit = framework === "next-app" && alias !== null && !kitPresent && contentGaps.length > 0;
  if (installKit) for (const file of await kitFiles(componentsRoot, appDir!)) add({ ...file, action: "create", checkIds: contentGaps, description: "ROIstation connector kiti: /rehber SEO sayfaları (FAQ, breadcrumb, LocalBusiness şeması), doğrulama ve anında yenileme uç noktaları." });

  // robots.txt
  const robotsFile = first(repo, [`${publicDir}robots.txt`]);
  const robotsCode = appDir ? first(repo, ["ts", "js"].map((ext) => `${appDir}/robots.${ext}`)) : null;
  if (failing(scan, "robots-txt") && !robotsFile && !robotsCode) {
    if (appDir) add({ path: `${appDir}/robots.${ts ? "ts" : "js"}`, action: "create", checkIds: ["robots-txt", "sitemap-in-robots"], description: "robots.txt: tüm tarayıcılara açık, sitemap bildirimi.", content: `${ts ? 'import type { MetadataRoute } from "next";\n\n' : ""}export default function robots()${ts ? ": MetadataRoute.Robots" : ""} {\n  return { rules: [{ userAgent: "*", allow: "/" }], sitemap: "${origin}/sitemap.xml", host: "${origin}" };\n}\n` });
    else if (framework !== "unknown") add({ path: `${publicDir}robots.txt`, action: "create", checkIds: ["robots-txt", "sitemap-in-robots"], description: "robots.txt: tüm tarayıcılara açık, sitemap bildirimi.", content: `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n` });
  } else if (failing(scan, "sitemap-in-robots") && robotsFile) {
    const current = await repo.read(robotsFile);
    if (current !== null && !/^sitemap:/im.test(current)) add({ path: robotsFile, action: "update", checkIds: ["sitemap-in-robots"], description: "robots.txt dosyasına Sitemap satırı eklendi.", content: `${current.replace(/\s*$/, "")}\n\nSitemap: ${origin}/sitemap.xml\n` });
  }
  if (failing(scan, "robots-allows")) manual.push({ checkId: "robots-allows", description: "robots.txt ana sayfayı engelliyor. Mevcut kurallar bilinçli olabileceği için otomatik değiştirilmedi; genel `Disallow: /` kuralını kaldırın." });
  if (failing(scan, "ai-crawlers")) manual.push({ checkId: "ai-crawlers", description: `AI tarayıcıları engelleniyor (${evidence(scan, "ai-crawlers")?.evidence?.join(", ")}). Bilinçli tercih değilse robots.txt'den kaldırın.` });

  // sitemap
  const sitemapCode = appDir ? first(repo, ["ts", "js"].map((ext) => `${appDir}/sitemap.${ext}`)) : null;
  if (failing(scan, "sitemap") && !sitemapCode && !repo.has(`${publicDir}sitemap.xml`)) {
    const originHost = new URL(origin).hostname.replace(/^www\./, "");
    // Never list URLs the scan found broken (4xx/5xx/unreachable).
    const brokenPaths = new Set([...scan.facts.brokenLinks.map((entry) => entry.split(" → ")[0]), ...scan.pages.filter((page) => !page.status || page.status >= 400).map((page) => { const parsed = new URL(page.url); return `${parsed.pathname}${parsed.search}`; })]);
    const urls = [...new Set([`${origin}/`, ...scan.facts.discoveredUrls.filter((url) => { try { const parsed = new URL(url); return parsed.hostname.replace(/^www\./, "") === originHost && !/\.(pdf|jpe?g|png|webp|gif|svg|zip)$/i.test(parsed.pathname) && !brokenPaths.has(`${parsed.pathname}${parsed.search}`); } catch { return false; } }).map((url) => url.split("#")[0])])].slice(0, 500);
    if (appDir) add({ path: `${appDir}/sitemap.${ts ? "ts" : "js"}`, action: "create", checkIds: ["sitemap"], description: `sitemap.xml: taramada bulunan ${urls.length} URL${installKit ? " + ROIstation SEO sayfaları" : ""}.`, content: `${ts ? 'import type { MetadataRoute } from "next";\n' : ""}${installKit ? 'import { roistationSitemapEntries } from "@/components/roistation/client";\n' : ""}\n// URLs discovered by the ROIstation scan on ${scan.scannedAt.slice(0, 10)}. Add new pages here${installKit ? "; ROIstation SEO pages are added automatically" : ""}.\nconst urls = ${js(urls)};\n\nexport const revalidate = 3600;\n\nexport default async function sitemap()${ts ? ": Promise<MetadataRoute.Sitemap>" : ""} {\n  return [\n    ...urls.map((url) => ({ url, changeFrequency: "weekly"${ts ? " as const" : ""} })),${installKit ? "\n    ...(await roistationSitemapEntries().catch(() => [])),": ""}\n  ];\n}\n` });
    else if (framework !== "unknown") add({ path: `${publicDir}sitemap.xml`, action: "create", checkIds: ["sitemap"], description: `sitemap.xml: taramada bulunan ${urls.length} URL.`, content: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `  <url><loc>${url.replace(/&/g, "&amp;")}</loc></url>`).join("\n")}\n</urlset>\n` });
  } else if (failing(scan, "sitemap") && installKit && sitemapCode) manual.push({ checkId: "sitemap", description: `Mevcut ${sitemapCode} dosyasına \`...(await roistationSitemapEntries())\` ekleyin; ROIstation SEO sayfaları sitemap'e girer.` });

  // llms.txt
  if (failing(scan, "llms-txt") && framework !== "unknown" && !repo.has(`${publicDir}llms.txt`)) add({ path: `${publicDir}llms.txt`, action: "create", checkIds: ["llms-txt"], description: "llms.txt: işletme özeti ve önemli sayfalar (taramadaki gerçek başlıklar).", content: llmsText(scan, profile, origin) });

  // Organization / LocalBusiness JSON-LD + metadata + lang
  const needsSchema = failing(scan, "organization-schema") || (failing(scan, "localbusiness-schema") && !scan.facts.schemaTypes.some((type) => type === profile.schemaType)) || (failing(scan, "schema-present"));
  const schema = schemaFor(profile, origin, true);
  if (layout) {
    let source = await repo.read(layout);
    const original = source;
    const clientLayout = source !== null && /^\s*["']use client["']/.test(source);
    if (source !== null && needsSchema) {
      const componentPath = `${componentsRoot}/roistation-schema.${ts ? "tsx" : "jsx"}`;
      const importPath = alias !== null ? `@/${componentPath.slice(alias.length).replace(/\.(t|j)sx$/, "")}` : path.posix.relative(path.posix.dirname(layout), componentPath).replace(/\.(t|j)sx$/, "").replace(/^(?!\.)/, "./");
      const bodyCloses = source.match(/<\/body>/gi) || [];
      const inserted = repo.has(componentPath) || bodyCloses.length !== 1 ? null : source.replace(/^([ \t]*)<\/body>/m, (_match, indent: string) => `${indent}  <RoistationSchema />\n${indent}</body>`);
      if (inserted) {
        add({ path: componentPath, action: "create", checkIds: ["schema-present", "organization-schema", "localbusiness-schema", "nap-schema"], description: `${schema["@type"]} JSON-LD (işletme verisi SITE_BUSINESS_JSON'dan).`, content: `// Generated by ROIstation from the configured business profile. Keep NAP identical to Google Business Profile.\nconst schema = ${js(schema)};\n\nexport function RoistationSchema() {\n  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(schema).replace(/</g, "\\\\u003c") }} />;\n}\n` });
        source = addImport(inserted, `import { RoistationSchema } from "${importPath}";`);
      } else manual.push({ checkId: "organization-schema", description: `Layout'ta tek bir </body> bulunamadı; aşağıdaki JSON-LD'yi layout'a ekleyin:\n\n${js(schema)}` });
    }
    const metaChecks = ["title", "meta-description", "canonical", "open-graph", "twitter-card"].filter((id) => failing(scan, id));
    if (source !== null && metaChecks.length) {
      const hasMetadata = /export\s+(const\s+metadata\b|(async\s+)?function\s+generateMetadata\b)/.test(source);
      // The live title is kept unless it is missing or too short to describe the site.
      const title = scan.facts.title && scan.facts.title.length >= 10 ? scan.facts.title : profile.name;
      const description = scan.facts.metaDescription || (scan.facts.firstParagraph ? truncate(scan.facts.firstParagraph, 155) : null);
      const metadata = { metadataBase: `__URL__`, title, ...(description ? { description } : {}), alternates: { canonical: "/" }, openGraph: { type: "website", url: `${origin}/`, siteName: profile.name, locale: "tr_TR", title, ...(description ? { description } : {}), ...(scan.facts.ogImage ? { images: [scan.facts.ogImage] } : {}) }, twitter: { card: scan.facts.ogImage ? "summary_large_image" : "summary", title, ...(description ? { description } : {}) } };
      const literal = js(metadata).replace('"__URL__"', `new URL("${origin}")`);
      if (!hasMetadata && !clientLayout) {
        if (ts) source = addImport(source, 'import type { Metadata } from "next";');
        source = `${source.replace(/\s*$/, "")}\n\n// Added by ROIstation SEO optimization (values from the live site scan).\nexport const metadata${ts ? ": Metadata" : ""} = ${literal};\n`;
        if (!description) manual.push({ checkId: "meta-description", description: "Sitede açıklama olarak kullanılabilecek metin bulunamadı; metadata.description alanına 120–155 karakterlik bir açıklama yazın." });
      } else manual.push({ checkId: metaChecks[0], description: `${layout} zaten metadata tanımlıyor${clientLayout ? " veya istemci bileşeni" : ""}; şu alanları mevcut metadata ile birleştirin (${metaChecks.join(", ")}):\n\n${literal}` });
      if (!hasMetadata && !clientLayout && metaChecks.length) files.push({ path: layout, action: "update", checkIds: metaChecks, description: "Layout'a metadata (başlık, açıklama, canonical, Open Graph, Twitter Card) eklendi.", content: "" });
    }
    if (source !== null && failing(scan, "lang") && /<html(?![^>]*\blang=)/.test(source)) source = source.replace(/<html(?![^>]*\blang=)/, '<html lang="tr"');
    if (source !== null && source !== original) {
      const existing = files.find((file) => file.path === layout);
      const ids = [...new Set([...(existing?.checkIds || []), ...(needsSchema ? ["organization-schema"] : []), ...(failing(scan, "lang") ? ["lang"] : [])])];
      if (existing) Object.assign(existing, { content: source, checkIds: ids });
      else files.push({ path: layout, action: "update", checkIds: ids, description: "Layout güncellendi (yapısal veri / dil).", content: source });
    }
  } else if (staticIndex) {
    let source = await repo.read(staticIndex);
    if (source !== null) {
      const head: string[] = []; const ids: string[] = [];
      const description = scan.facts.metaDescription || (scan.facts.firstParagraph ? truncate(scan.facts.firstParagraph, 155) : null);
      if (failing(scan, "meta-description") && !/<meta[^>]+name=["']description/i.test(source) && description) { head.push(`<meta name="description" content="${description.replace(/"/g, "&quot;")}">`); ids.push("meta-description"); }
      if (failing(scan, "canonical") && !/rel=["']canonical/i.test(source)) { head.push(`<link rel="canonical" href="${origin}/">`); ids.push("canonical"); }
      if (failing(scan, "mobile-friendly") && !/name=["']viewport/i.test(source)) { head.push('<meta name="viewport" content="width=device-width, initial-scale=1">'); ids.push("mobile-friendly"); }
      if (failing(scan, "open-graph")) { const t = (scan.facts.title || profile.name).replace(/"/g, "&quot;"); for (const [key, value] of [["og:type", "website"], ["og:url", `${origin}/`], ["og:title", t], ["og:site_name", profile.name]] as const) if (!new RegExp(`property=["']${key}["']`, "i").test(source)) head.push(`<meta property="${key}" content="${value}">`); if (description && !/property=["']og:description/i.test(source)) head.push(`<meta property="og:description" content="${description.replace(/"/g, "&quot;")}">`); ids.push("open-graph"); }
      if (failing(scan, "twitter-card") && !/name=["']twitter:card/i.test(source)) { head.push(`<meta name="twitter:card" content="${scan.facts.ogImage ? "summary_large_image" : "summary"}">`); ids.push("twitter-card"); }
      if (needsSchema) { head.push(`<script type="application/ld+json">${JSON.stringify(schema).replace(/</g, "\\u003c")}</script>`); ids.push("organization-schema"); }
      if (head.length) { const next = insertBefore(source, /<\/head>/, `  ${head.join("\n  ")}\n`); if (next) source = next; else manual.push({ checkId: ids[0], description: "index.html içinde tek </head> bulunamadı; etiketleri elle ekleyin." }); }
      if (failing(scan, "lang") && /<html(?![^>]*\blang=)/i.test(source)) { source = source.replace(/<html(?![^>]*\blang=)/i, '<html lang="tr"'); ids.push("lang"); }
      if (ids.length) add({ path: staticIndex, action: "update", checkIds: ids, description: "index.html: eksik meta etiketleri, yapısal veri ve dil eklendi.", content: source });
    }
  } else if (framework === "next-pages") {
    manual.push({ checkId: "title", description: "Proje Next.js Pages Router kullanıyor; meta etiketlerini ve JSON-LD'yi pages/_document veya ilgili sayfalarda next/head ile ekleyin." });
  }

  // Items that need human judgement (content, design or code paths that cannot be changed safely).
  const manualOnly: [string, (s: ScanResult) => string][] = [
    ["http-status", (s) => `Ana sayfa hatası: ${evidence(s, "http-status")?.finding}`],
    ["indexable", (s) => `${evidence(s, "indexable")?.finding} Canlı ortamdaki noindex kaynağını (meta/X-Robots-Tag) kaldırın.`],
    ["h1", (s) => `${evidence(s, "h1")?.finding} ${evidence(s, "h1")?.evidence?.join(", ") || ""}`.trim()],
    ["heading-hierarchy", (s) => `Başlık seviyeleri: ${evidence(s, "heading-hierarchy")?.evidence?.slice(0, 8).join("; ")}`],
    ["image-alt", (s) => `Alt metni olmayan görseller: ${s.facts.imagesWithoutAlt.slice(0, 15).join(", ")}`],
    ["broken-links", (s) => `Kırık bağlantılar: ${s.facts.brokenLinks.join(", ")}`],
    ["internal-links", (s) => evidence(s, "internal-links")?.finding || ""],
    ["performance-score", (s) => `Mobil performans ${s.performance.score}; LCP ${s.performance.lcpMs ? (s.performance.lcpMs / 1000).toFixed(2) + " sn" : "—"}, CLS ${s.performance.cls ?? "—"}, TBT ${s.performance.tbtMs ? Math.round(s.performance.tbtMs) + " ms" : "—"}.`],
    ["lcp", (s) => evidence(s, "lcp")?.finding || ""], ["cls", (s) => evidence(s, "cls")?.finding || ""], ["interactivity", (s) => evidence(s, "interactivity")?.finding || ""],
    ["gbp-consistency", (s) => `NAP tutarsızlığı: ${evidence(s, "gbp-consistency")?.evidence?.join("; ")}`],
    ["entity-links", () => "sameAs için resmî profil adreslerini SITE_BUSINESS_JSON.sameAs alanına ekleyin; şema bileşeni bir sonraki optimizasyonda bunları içerir."],
    ["crawlability", (s) => evidence(s, "crawlability")?.finding || ""],
  ];
  for (const [id, describe] of manualOnly) if (failing(scan, id)) manual.push({ checkId: id, description: `${evidence(scan, id)?.label}: ${describe(scan)} — Öneri: ${evidence(scan, id)?.fix}` });
  if (contentGaps.length) manual.push({ checkId: contentGaps[0], description: installKit
    ? `İçerik/GEO eksikleri (${contentGaps.join(", ")}): PR birleştirildikten sonra ROIstation'da "SEO + GEO" veya "AI cevap odaklı" stratejisiyle bu siteye SEO sayfası yayınlayın; FAQ, breadcrumb ve LocalBusiness şeması otomatik üretilir.`
    : `İçerik/GEO eksikleri (${contentGaps.join(", ")}): ${framework === "next-app" ? (alias === null ? "Projede @/* yol takma adı yok; connector kiti otomatik eklenemedi." : "Connector kiti zaten kurulu;") : "Bu proje Next.js App Router değil;"} ROIstation'dan "SEO + GEO" stratejisiyle içerik yayınlayın veya sayfalara soru-cevap bölümü ekleyin.` });
  const nonEmpty = files.filter((file) => file.content !== "");
  return { files: nonEmpty, manual, installKit, framework };
}
