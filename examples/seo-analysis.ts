/*
 * Example: the SEO & GEO analysis core — dependency-free HTML extraction, the weighted check
 * catalogue and the scoring that turns check results into SEO / GEO / category scores.
 *
 * Demonstrates:
 *   - `parseHtml()`: reads the server-rendered HTML that crawlers receive (title, metas, canonical,
 *     Open Graph, headings, links, images, JSON-LD, microdata) with regexes; nothing is executed,
 *   - the check catalogue with weights and SEO / GEO dimensions, `result()` priority rules and
 *     `scoreOf()` (pass = 1, warn = 0.5, fail = 0, skip = excluded),
 *   - `analyzeSnapshot()`: the scanner's home-page checks run against an in-memory snapshot.
 *
 * Source: lib/seo/html.ts, lib/seo/checks.ts, lib/seo/scanner.ts (scanSite / finalize),
 *         lib/publishing/business.ts (isLocalBusinessType)
 *
 * Differences from production: `scanSite()` fetches the live site through the host-checked
 * `safeGet()` (home page + up to 4 sampled inner pages, robots.txt, the declared sitemap,
 * llms.txt, 25 internal link statuses) and Google PageSpeed Insights. Here the caller passes the
 * fetched bodies, only the home page is analysed, the multi-page checks (crawlability,
 * broken-links, breadcrumbs) and the Google Business Profile comparison are left out, and the
 * four performance checks are recorded as "skip" exactly as production does when PSI is
 * unavailable. The declared sitemap is matched by same-site host instead of the per-site host
 * allow-list (lib/verification.ts allowedHosts). Scan ids, persistence and event logging are omitted.
 */

/* ------------------------------------------------------------ lib/seo/html.ts */

export type Tag = { name: string; attrs: Record<string, string> };
export type Heading = { level: number; text: string };
export type LinkRef = { href: string; text: string; rel: string };
export type ImageRef = { src: string; alt: string | null };
export type JsonLdBlock = { raw: string; data: unknown; error: string | null };

export type ParsedPage = {
  lang: string | null; title: string | null; titleCount: number; metaDescription: string | null; robotsMeta: string | null; viewport: string | null;
  canonical: string | null; canonicalCount: number; hreflang: string[]; og: Record<string, string>; twitter: Record<string, string>;
  headings: Heading[]; links: LinkRef[]; images: ImageRef[]; jsonLd: JsonLdBlock[]; microdataTypes: string[]; breadcrumbMarkup: boolean;
  text: string; wordCount: number; paragraphs: string[]; lists: number; htmlBytes: number;
};

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
export function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) { const n = parseInt(lower.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : match; }
    if (lower.startsWith("#")) { const n = parseInt(lower.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : match; }
    return entities[lower] ?? match;
  });
}

const clean = (value: string) => decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

export function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  return attrs;
}

function tags(html: string, name: string): Tag[] {
  const result: Tag[] = [];
  const pattern = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) result.push({ name, attrs: parseAttrs(match[1]) });
  return result;
}

function blocks(html: string, name: string): { attrs: Record<string, string>; inner: string }[] {
  const result: { attrs: Record<string, string>; inner: string }[] = [];
  const pattern = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) result.push({ attrs: parseAttrs(match[1]), inner: match[2] });
  return result;
}

export function parseHtml(html: string): ParsedPage {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(withoutComments)?.[1] ?? withoutComments;
  const metas = tags(head, "meta");
  const metaBy = (key: string, attr = "name") => metas.find((tag) => (tag.attrs[attr] || "").toLowerCase() === key)?.attrs.content ?? null;
  const og: Record<string, string> = {}; const twitter: Record<string, string> = {};
  for (const tag of metas) {
    const property = (tag.attrs.property || tag.attrs.name || "").toLowerCase();
    if (property.startsWith("og:") && tag.attrs.content) og[property.slice(3)] = tag.attrs.content;
    if (property.startsWith("twitter:") && tag.attrs.content) twitter[property.slice(8)] = tag.attrs.content;
  }
  const linkTags = tags(head, "link");
  const canonicals = linkTags.filter((tag) => (tag.attrs.rel || "").toLowerCase().split(/\s+/).includes("canonical"));
  const titles = blocks(head, "title");

  const scripts = blocks(withoutComments, "script");
  const jsonLd: JsonLdBlock[] = scripts.filter((script) => (script.attrs.type || "").toLowerCase().includes("ld+json")).map((script) => {
    const raw = script.inner.trim();
    try { return { raw, data: JSON.parse(raw), error: null }; }
    catch (error) { return { raw, data: null, error: error instanceof Error ? error.message : "JSON parse error" }; }
  });

  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(withoutComments)?.[1] ?? withoutComments;
  const visible = body.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ");
  const headings: Heading[] = [];
  const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(visible))) headings.push({ level: Number(match[1]), text: clean(match[2]) });

  const links: LinkRef[] = blocks(visible, "a").map((anchor) => ({ href: anchor.attrs.href || "", text: clean(anchor.inner), rel: (anchor.attrs.rel || "").toLowerCase() })).filter((link) => link.href);
  const images: ImageRef[] = tags(visible, "img").map((tag) => ({ src: tag.attrs.src || tag.attrs["data-src"] || "", alt: "alt" in tag.attrs ? tag.attrs.alt : null }));
  const paragraphs = blocks(visible, "p").map((p) => clean(p.inner)).filter((text) => text.length > 0);
  const text = clean(visible);
  const microdataTypes = [...visible.matchAll(/itemtype=["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi)].map((m) => m[1]);
  const htmlLang = /<html\b([^>]*)>/i.exec(withoutComments);

  return {
    lang: htmlLang ? parseAttrs(htmlLang[1]).lang || null : null,
    title: titles[0] ? clean(titles[0].inner) : null,
    titleCount: titles.length,
    metaDescription: metaBy("description"),
    robotsMeta: metaBy("robots") ?? metaBy("googlebot"),
    viewport: metaBy("viewport"),
    canonical: canonicals[0]?.attrs.href || null,
    canonicalCount: canonicals.length,
    hreflang: linkTags.filter((tag) => (tag.attrs.rel || "").toLowerCase() === "alternate" && tag.attrs.hreflang).map((tag) => tag.attrs.hreflang),
    og, twitter, headings, links, images, jsonLd, microdataTypes,
    breadcrumbMarkup: /aria-label=["'][^"']*(breadcrumb|sayfa konumu)[^"']*["']/i.test(visible) || microdataTypes.includes("BreadcrumbList"),
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    paragraphs,
    lists: (visible.match(/<(ul|ol)\b/gi) || []).length,
    htmlBytes: html.length,
  };
}

/** All schema.org nodes in the JSON-LD blocks, flattened across @graph and arrays. */
export function schemaNodes(blocksList: JsonLdBlock[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record["@type"]) nodes.push(record);
    if (record["@graph"]) visit(record["@graph"]);
  };
  for (const block of blocksList) if (block.data) visit(block.data);
  return nodes;
}
export const typesOf = (node: Record<string, unknown>) => (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]).filter((type): type is string => typeof type === "string");

/** Parses robots.txt into user-agent groups. */
export function parseRobots(text: string) {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":"); if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase(); const value = line.slice(separator + 1).trim();
    if (key === "sitemap") { sitemaps.push(value); continue; }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], allow: [], disallow: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow") current.allow.push(value);
    if (key === "disallow") current.disallow.push(value);
  }
  return { groups, sitemaps };
}

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

export function sitemapLocs(xml: string) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => decodeEntities(match[1]));
}

/* ---------------------------------------------------------- lib/seo/checks.ts */

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type Category = "technical" | "metadata" | "structure" | "links" | "schema" | "social" | "media" | "performance" | "ai" | "local";
export type Dimension = "seo" | "geo" | "both";
export type Priority = "high" | "medium" | "low";

export type CheckDefinition = { id: string; label: string; category: Category; dimension: Dimension; weight: number; explanation: string; fix: string };
export type CheckResult = { id: string; label: string; category: Category; dimension: Dimension; weight: number; status: CheckStatus; priority: Priority; finding: string; explanation: string; fix: string; evidence?: string[] };

const defs: CheckDefinition[] = [
  { id: "http-status", label: "Ana sayfa erişilebilir", category: "technical", dimension: "both", weight: 10, explanation: "Arama motorları ve AI tarayıcıları yalnız 200 yanıtı veren sayfaları dizine ekler.", fix: "Sunucu/deploy hatasını giderin; ana sayfanın 200 döndürdüğünden emin olun." },
  { id: "indexable", label: "Dizine eklenebilir (noindex yok)", category: "technical", dimension: "both", weight: 10, explanation: "meta robots veya X-Robots-Tag içindeki noindex, sayfanın arama sonuçlarından tamamen çıkmasına neden olur.", fix: "Canlı ortamda noindex etiketini ve X-Robots-Tag başlığını kaldırın." },
  { id: "robots-txt", label: "robots.txt", category: "technical", dimension: "seo", weight: 4, explanation: "robots.txt tarayıcılara hangi yolların taranabileceğini ve sitemap adresini bildirir.", fix: "Kök dizinde robots.txt yayınlayın (Next.js: app/robots.ts) ve Sitemap satırı ekleyin." },
  { id: "robots-allows", label: "robots.txt siteyi engellemiyor", category: "technical", dimension: "seo", weight: 8, explanation: "Googlebot veya tüm botlar için Disallow: / sitenin taranmasını engeller.", fix: "Genel Disallow kuralını kaldırın; yalnız gizli yolları engelleyin." },
  { id: "ai-crawlers", label: "AI tarayıcılarına açık", category: "technical", dimension: "geo", weight: 6, explanation: "GPTBot, ClaudeBot, PerplexityBot ve Google-Extended engellenirse site AI cevaplarında kaynak olarak kullanılamaz.", fix: "robots.txt içinde bu botlar için Disallow: / kuralını kaldırın (bilinçli tercih değilse)." },
  { id: "sitemap", label: "sitemap.xml", category: "technical", dimension: "seo", weight: 6, explanation: "Sitemap, tüm önemli sayfaların hızlı keşfedilmesini sağlar.", fix: "sitemap.xml yayınlayın (Next.js: app/sitemap.ts) ve tüm kanonik URL'leri listeleyin." },
  { id: "sitemap-in-robots", label: "Sitemap robots.txt'de bildirilmiş", category: "technical", dimension: "seo", weight: 2, explanation: "robots.txt içindeki Sitemap satırı tüm arama motorlarının sitemap'i bulmasını sağlar.", fix: "robots.txt dosyasına 'Sitemap: https://alanadiniz/sitemap.xml' ekleyin." },
  { id: "crawlability", label: "Taranabilirlik", category: "technical", dimension: "seo", weight: 5, explanation: "Sayfalar birbirine HTML bağlantılarıyla bağlı değilse tarayıcılar içeriği bulamaz.", fix: "Ana sayfadan önemli sayfalara normal <a href> bağlantıları verin; JavaScript'e bağımlı gezinmeden kaçının." },
  { id: "title", label: "Meta başlık", category: "metadata", dimension: "seo", weight: 8, explanation: "Başlık, arama sonucunda görünen ana metindir; 10–65 karakter arası olmalıdır.", fix: "Her sayfaya benzersiz, marka ve ana hizmeti içeren 30–60 karakterlik bir <title> ekleyin." },
  { id: "meta-description", label: "Meta açıklama", category: "metadata", dimension: "seo", weight: 6, explanation: "Açıklama, arama sonucundaki özet metindir ve tıklama oranını etkiler (50–160 karakter).", fix: "Sayfayı özetleyen, 120–155 karakterlik benzersiz bir meta description ekleyin." },
  { id: "canonical", label: "Canonical etiketi", category: "metadata", dimension: "seo", weight: 6, explanation: "Canonical, kopya URL'lerin (www, parametreler) tek bir adreste birleşmesini sağlar.", fix: "Her sayfaya kendi mutlak adresini gösteren tek bir <link rel=\"canonical\"> ekleyin." },
  { id: "lang", label: "Dil bildirimi", category: "metadata", dimension: "both", weight: 2, explanation: "<html lang> içeriğin dilini arama motorlarına ve AI modellerine bildirir.", fix: "<html lang=\"tr\"> ekleyin." },
  { id: "h1", label: "H1 başlığı", category: "structure", dimension: "seo", weight: 6, explanation: "Her sayfada sayfanın konusunu anlatan tek bir H1 olmalıdır.", fix: "Sayfaya tek bir, ana konuyu anlatan <h1> ekleyin; diğer başlıkları H2/H3 yapın." },
  { id: "heading-hierarchy", label: "Başlık hiyerarşisi", category: "structure", dimension: "both", weight: 3, explanation: "Atlanan başlık seviyeleri (H2'den H4'e) içerik yapısının makinece anlaşılmasını zorlaştırır.", fix: "Başlıkları sırayla kullanın: H1 → H2 → H3." },
  { id: "internal-links", label: "İç bağlantılar", category: "links", dimension: "seo", weight: 4, explanation: "İç bağlantılar sayfa otoritesini dağıtır ve keşfi kolaylaştırır.", fix: "Ana sayfadan hizmet, iletişim ve içerik sayfalarına açıklayıcı bağlantı metinleriyle bağlantı verin." },
  { id: "broken-links", label: "Kırık iç bağlantılar", category: "links", dimension: "seo", weight: 6, explanation: "404 veren bağlantılar tarama bütçesini harcar ve kullanıcı deneyimini bozar.", fix: "Listelenen bağlantıları düzeltin veya 301 yönlendirme ekleyin." },
  { id: "breadcrumbs", label: "Breadcrumb", category: "links", dimension: "seo", weight: 3, explanation: "Breadcrumb ve BreadcrumbList şeması site hiyerarşisini arama sonuçlarında gösterir.", fix: "İç sayfalara breadcrumb navigasyonu ve BreadcrumbList JSON-LD ekleyin." },
  { id: "schema-present", label: "Schema.org yapısal veri", category: "schema", dimension: "both", weight: 6, explanation: "Yapısal veri, işletmeyi ve içeriği arama motorlarına ve AI sistemlerine makine okunur biçimde tanıtır.", fix: "JSON-LD ile Organization/LocalBusiness ve sayfa türüne uygun şema ekleyin." },
  { id: "schema-valid", label: "Yapısal veri geçerliliği", category: "schema", dimension: "both", weight: 5, explanation: "Hatalı JSON-LD tamamen yok sayılır.", fix: "JSON-LD bloklarını geçerli JSON yapın; @context ve @type alanlarını ekleyin." },
  { id: "organization-schema", label: "Organization şeması", category: "schema", dimension: "both", weight: 4, explanation: "Organization/LocalBusiness düğümü marka varlığını (entity) tanımlar.", fix: "name, url, logo ve sameAs alanlarıyla Organization veya LocalBusiness JSON-LD ekleyin." },
  { id: "localbusiness-schema", label: "LocalBusiness şeması", category: "local", dimension: "geo", weight: 6, explanation: "Yerel işletmeler için adres, telefon ve çalışma saatleri içeren LocalBusiness (ör. Restaurant) yerel aramada ve AI cevaplarında belirleyicidir.", fix: "Uygun alt türle (Restaurant, MedicalBusiness…) LocalBusiness JSON-LD ekleyin; adres ve telefonu Google İşletme Profili ile birebir yazın." },
  { id: "faq-schema", label: "FAQ şeması", category: "schema", dimension: "geo", weight: 4, explanation: "Soru-cevap içeriği ve FAQPage şeması AI asistanlarının doğrudan alıntılayabileceği yapıdır.", fix: "Sık sorulan soruları içeren bir bölüm ve FAQPage JSON-LD ekleyin (ROIstation SEO+GEO stratejisi bunu otomatik üretir)." },
  { id: "open-graph", label: "Open Graph", category: "social", dimension: "seo", weight: 4, explanation: "og:title, og:description, og:image ve og:url paylaşım önizlemelerini belirler.", fix: "Eksik og: etiketlerini ekleyin; og:image için en az 1200×630 görsel kullanın." },
  { id: "twitter-card", label: "Twitter Card", category: "social", dimension: "seo", weight: 2, explanation: "twitter:card etiketi X/Twitter paylaşım görünümünü belirler.", fix: "<meta name=\"twitter:card\" content=\"summary_large_image\"> ekleyin." },
  { id: "image-alt", label: "Görsel alt metinleri", category: "media", dimension: "seo", weight: 4, explanation: "Alt metin, görselleri arama motorlarına ve ekran okuyuculara anlatır.", fix: "Listelenen görsellere içeriği anlatan alt metin ekleyin; dekoratif görsellerde alt=\"\" kullanın." },
  { id: "performance-score", label: "Performans puanı (Lighthouse)", category: "performance", dimension: "seo", weight: 6, explanation: "Google PageSpeed Insights mobil performans puanı.", fix: "Görselleri optimize edin (next/image, WebP/AVIF), kullanılmayan JavaScript'i azaltın, fontları önceden yükleyin." },
  { id: "lcp", label: "Largest Contentful Paint", category: "performance", dimension: "seo", weight: 5, explanation: "Ana içeriğin yüklenme süresi; iyi değer ≤ 2,5 sn.", fix: "LCP görselini priority/preload ile yükleyin, sunucu yanıt süresini kısaltın, render engelleyen kaynakları azaltın." },
  { id: "cls", label: "Cumulative Layout Shift", category: "performance", dimension: "seo", weight: 3, explanation: "Sayfa yüklenirken kayma; iyi değer ≤ 0,1.", fix: "Görsel ve reklam alanlarına sabit boyut verin; font yüklemede size-adjust kullanın." },
  { id: "interactivity", label: "Etkileşim (INP / TBT)", category: "performance", dimension: "seo", weight: 3, explanation: "Gerçek kullanıcı INP (≤ 200 ms) veya laboratuvar Total Blocking Time (≤ 200 ms).", fix: "Uzun JavaScript görevlerini bölün, üçüncü taraf betikleri erteleyin." },
  { id: "mobile-friendly", label: "Mobil uyumluluk", category: "performance", dimension: "seo", weight: 5, explanation: "width=device-width viewport ve mobil uyumlu düzen mobil öncelikli dizinleme için gereklidir.", fix: "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> ekleyin." },
  { id: "ai-readability", label: "AI okunabilirliği", category: "ai", dimension: "geo", weight: 6, explanation: "Yeterli metin, kısa cümleler, listeler ve net paragraflar AI modellerinin içeriği doğru özetlemesini sağlar.", fix: "Ana sayfaya en az 300 kelimelik açıklayıcı metin ekleyin; cümleleri kısa tutun, listeler ve alt başlıklar kullanın." },
  { id: "question-headings", label: "Soru-cevap yapısı", category: "ai", dimension: "geo", weight: 3, explanation: "Soru biçimli başlıklar, kullanıcıların AI asistanlarına sorduğu sorularla eşleşir.", fix: "Müşterilerin sık sorduğu soruları başlık yapın ve altında kısa, net cevap verin." },
  { id: "llms-txt", label: "llms.txt", category: "ai", dimension: "geo", weight: 2, explanation: "llms.txt, AI sistemlerine sitenin özetini ve önemli sayfalarını sunan yeni bir standarttır.", fix: "Kök dizine işletme özeti ve önemli bağlantıları içeren /llms.txt ekleyin." },
  { id: "locality-signals", label: "Yerel sinyaller", category: "local", dimension: "geo", weight: 5, explanation: "Hizmet verilen şehir/ilçenin başlık, H1 ve metinde geçmesi yerel ve AI aramalarında eşleşmeyi güçlendirir.", fix: "Başlık, H1 ve ana metinde hizmet bölgesini (ör. ilçe, il) doğal biçimde belirtin." },
  { id: "nap-schema", label: "Adres ve telefon (NAP)", category: "local", dimension: "geo", weight: 4, explanation: "LocalBusiness şemasında adres ve telefon, yerel aramada güven sinyalidir.", fix: "LocalBusiness şemasına address (PostalAddress) ve telephone ekleyin." },
  { id: "gbp-consistency", label: "Google İşletme Profili tutarlılığı", category: "local", dimension: "geo", weight: 4, explanation: "Sitedeki telefon ve adres, Google İşletme Profili ile birebir aynı olmalıdır (NAP tutarlılığı).", fix: "Şemadaki ve sayfadaki telefon/adres bilgisini SITE_BUSINESS_JSON'daki (Google İşletme Profili) bilgiyle aynı yazın." },
  { id: "entity-links", label: "Varlık bağlantıları (sameAs)", category: "local", dimension: "geo", weight: 3, explanation: "sameAs ile Instagram, Google Maps, Wikipedia gibi resmî profillere bağlantı AI modellerinin markayı doğru eşleştirmesini sağlar.", fix: "Organization/LocalBusiness şemasına resmî profillerin adreslerini sameAs dizisi olarak ekleyin." },
];

export const checkDefinitions: Record<string, CheckDefinition> = Object.fromEntries(defs.map((def) => [def.id, def]));

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

/* -------------------------------------------- lib/seo/scanner.ts (home page) */

const AI_BOTS = ["gptbot", "claudebot", "perplexitybot", "google-extended"];
/** Only these conditions make a site "Critical": offline/unreachable, 5xx, broken SSL, noindex, robots blocking, missing sitemap. */
export const CRITICAL_CHECKS = ["http-status", "indexable", "robots-allows", "sitemap"];
const localTypes = new Set(["LocalBusiness","Restaurant","MedicalBusiness","Dentist","Physician","HousekeepingService","GeneralContractor","TravelAgency","ProfessionalService","LodgingBusiness","Hotel","Store","HealthAndBeautyBusiness","FoodEstablishment","CafeOrCoffeeShop","HomeAndConstructionBusiness","MedicalClinic"]);
export const isLocalBusinessType = (type: string) => localTypes.has(type);
const sameSite = (a: string, b: string) => a.replace(/^www\./, "") === b.replace(/^www\./, "");
const trLower = (text: string) => text.toLocaleLowerCase("tr");

export type ScanScores = { seo: number | null; geo: number | null; schema: number | null; metadata: number | null; performance: number | null; technical: number | null; content: number | null; local: number | null };
/** Bodies the production scanner would have fetched. `null` = not found (non-2xx). */
export type Snapshot = {
  url: string; status: number | null; html: string; headers?: Record<string, string>;
  robotsTxt: string | null; sitemapXml: string | null; llmsTxt: string | null;
  profile: { schemaType: string; locality?: string };
};

export function analyzeSnapshot(input: Snapshot) {
  const checks: CheckResult[] = [];
  const origin = new URL(input.url).origin;
  const homeOk = Boolean(input.status && input.status >= 200 && input.status < 300) && Boolean(input.html);
  const page: ParsedPage | null = homeOk ? parseHtml(input.html) : null;
  const finalHost = new URL(input.url).hostname;

  // --- robots.txt / sitemap / llms.txt
  const robotsFound = input.robotsTxt !== null && !/<html/i.test(input.robotsTxt.slice(0, 500));
  const robots = robotsFound ? parseRobots(input.robotsTxt!) : null;
  const sitemapCandidate = robots?.sitemaps.find((url) => { try { return sameSite(new URL(url).hostname, finalHost); } catch { return false; } }) || new URL("/sitemap.xml", origin).href;
  const locs = input.sitemapXml !== null ? sitemapLocs(input.sitemapXml) : [];
  const sitemapOk = input.sitemapXml !== null && /<(urlset|sitemapindex)/i.test(input.sitemapXml);
  const llmsOk = input.llmsTxt !== null && input.llmsTxt.trim().length > 20 && !/<html/i.test(input.llmsTxt.slice(0, 300));

  checks.push(homeOk ? result("http-status", "pass", `Ana sayfa HTTP ${input.status} döndürdü.`) : result("http-status", "fail", input.status ? `Ana sayfa HTTP ${input.status} döndürdü.` : "Ana sayfaya ulaşılamadı."));
  if (!page) return finalize(checks);

  // --- technical
  const noindexMeta = /noindex/i.test(page.robotsMeta || ""); const noindexHeader = /noindex/i.test(input.headers?.["x-robots-tag"] || "");
  checks.push(noindexMeta || noindexHeader ? result("indexable", "fail", `Sayfa ${noindexHeader ? "X-Robots-Tag başlığında" : "meta robots etiketinde"} noindex içeriyor.`) : result("indexable", "pass", "noindex yok; sayfa dizine eklenebilir."));
  checks.push(robotsFound ? result("robots-txt", "pass", "robots.txt bulundu.") : result("robots-txt", "fail", "robots.txt bulunamadı (HTTP —)."));
  if (robots) {
    const blocked = robotsBlocks(robots, "googlebot", "/");
    checks.push(blocked ? result("robots-allows", "fail", "robots.txt ana sayfanın taranmasını engelliyor (Disallow: /).") : result("robots-allows", "pass", "robots.txt ana sayfanın taranmasına izin veriyor."));
    const blockedBots = AI_BOTS.filter((bot) => robotsBlocks(robots, bot, "/"));
    checks.push(blockedBots.length ? result("ai-crawlers", blockedBots.length === AI_BOTS.length ? "fail" : "warn", `Engellenen AI tarayıcıları: ${blockedBots.join(", ")}.`, blockedBots) : result("ai-crawlers", "pass", "GPTBot, ClaudeBot, PerplexityBot ve Google-Extended engellenmiyor."));
    checks.push(robots.sitemaps.length ? result("sitemap-in-robots", "pass", `robots.txt sitemap bildiriyor: ${robots.sitemaps[0]}`) : result("sitemap-in-robots", "fail", "robots.txt içinde Sitemap satırı yok."));
  } else {
    checks.push(result("robots-allows", "pass", "robots.txt yok; varsayılan olarak tüm tarayıcılara açık."));
    checks.push(result("ai-crawlers", "pass", "robots.txt yok; AI tarayıcıları engellenmiyor."));
    checks.push(result("sitemap-in-robots", "fail", "robots.txt olmadığı için sitemap bildirilmiyor."));
  }
  checks.push(sitemapOk ? (locs.length ? result("sitemap", "pass", `Sitemap ${locs.length} URL içeriyor.`) : result("sitemap", "warn", "Sitemap bulundu ancak URL içermiyor.")) : result("sitemap", "fail", `Sitemap bulunamadı: ${sitemapCandidate}`));

  // --- metadata (production also compares up to 4 sampled inner pages here)
  const toUrl = (href: string, base: string) => { try { const url = new URL(href, base); url.hash = ""; return url; } catch { return null; } };
  const titleLen = page.title?.length ?? 0;
  checks.push(!page.title ? result("title", "fail", "Ana sayfada <title> yok.") : titleLen < 10 || titleLen > 65 ? result("title", "warn", `Başlık ${titleLen} karakter: "${page.title}"`) : result("title", "pass", `"${page.title}" (${titleLen} karakter)`));
  const descLen = page.metaDescription?.length ?? 0;
  checks.push(!page.metaDescription ? result("meta-description", "fail", "Ana sayfada meta description yok.", [input.url]) : descLen < 50 || descLen > 160 ? result("meta-description", "warn", `Meta açıklama ${descLen} karakter.`) : result("meta-description", "pass", `${descLen} karakter.`));
  const canonicalUrl = page.canonical ? toUrl(page.canonical, input.url) : null;
  checks.push(!page.canonical ? result("canonical", "fail", "Ana sayfada canonical etiketi yok.", [input.url])
    : page.canonicalCount > 1 ? result("canonical", "warn", `Ana sayfada ${page.canonicalCount} canonical etiketi var.`)
    : canonicalUrl && !sameSite(canonicalUrl.hostname, finalHost) ? result("canonical", "warn", `Canonical başka bir alan adını gösteriyor: ${canonicalUrl.href}`)
    : result("canonical", "pass", `Canonical: ${canonicalUrl?.href}`));
  checks.push(page.lang ? result("lang", "pass", `lang="${page.lang}"`) : result("lang", "fail", "<html> etiketinde lang yok."));

  // --- structure
  const h1s = page.headings.filter((heading) => heading.level === 1);
  checks.push(h1s.length === 0 ? result("h1", "fail", "Ana sayfada H1 yok.", [input.url]) : h1s.length > 1 ? result("h1", "warn", `Ana sayfada ${h1s.length} H1 var.`, h1s.map((heading) => heading.text)) : result("h1", "pass", `H1: "${h1s[0].text}"`));
  const skips: string[] = [];
  let last = 0; for (const heading of page.headings) { if (last && heading.level > last + 1) skips.push(`${new URL(input.url).pathname}: H${last} → H${heading.level} (${heading.text.slice(0, 60)})`); last = heading.level; }
  checks.push(!page.headings.length ? result("heading-hierarchy", "fail", "Sayfada başlık yok.") : skips.length ? result("heading-hierarchy", "warn", `${skips.length} yerde başlık seviyesi atlanıyor.`, skips) : result("heading-hierarchy", "pass", "Başlık seviyeleri sıralı."));

  // --- links
  const internal = page.links.map((link) => toUrl(link.href, input.url)).filter((url): url is URL => Boolean(url && /^https?:$/.test(url.protocol) && sameSite(url.hostname, finalHost)));
  const uniqueInternal = [...new Map(internal.map((url) => [url.href, url])).values()];
  checks.push(uniqueInternal.length >= 5 ? result("internal-links", "pass", `${uniqueInternal.length} benzersiz iç bağlantı.`) : result("internal-links", uniqueInternal.length ? "warn" : "fail", `Ana sayfada ${uniqueInternal.length} iç bağlantı var.`));

  // --- schema
  const nodes = schemaNodes(page.jsonLd);
  const types = [...new Set([...nodes.flatMap(typesOf), ...page.microdataTypes])];
  const invalid = page.jsonLd.filter((block) => block.error || !block.data).map((block) => `/: ${block.error || "boş blok"}`);
  const missingContext = page.jsonLd.filter((block) => block.data && typeof block.data === "object" && !Array.isArray(block.data) && !(block.data as Record<string, unknown>)["@context"]).map(() => "/: @context yok");
  checks.push(types.length ? result("schema-present", "pass", `Bulunan türler: ${types.join(", ")}`) : result("schema-present", "fail", "Hiç schema.org yapısal verisi yok."));
  const blocksCount = page.jsonLd.length;
  checks.push(!blocksCount ? result("schema-valid", nodes.length || types.length ? "pass" : "skip", "Doğrulanacak JSON-LD bloğu yok.") : invalid.length ? result("schema-valid", "fail", `${invalid.length} JSON-LD bloğu geçersiz.`, invalid) : missingContext.length ? result("schema-valid", "warn", "Bazı JSON-LD bloklarında @context eksik.", missingContext) : result("schema-valid", "pass", `${blocksCount} JSON-LD bloğu geçerli.`));
  const profile = input.profile;
  const localNodes = nodes.filter((node) => typesOf(node).some((type) => type === "LocalBusiness" || isLocalBusinessType(type)));
  const orgNode = nodes.find((node) => typesOf(node).some((type) => type === "Organization" || type === "LocalBusiness" || isLocalBusinessType(type)));
  checks.push(!orgNode ? result("organization-schema", "fail", "Organization veya LocalBusiness düğümü yok.") : orgNode.name && orgNode.url ? result("organization-schema", "pass", `${typesOf(orgNode).join("/")}: ${String(orgNode.name)}`) : result("organization-schema", "warn", "Organization düğümünde name veya url eksik."));
  const expectLocal = isLocalBusinessType(profile.schemaType);
  const localNode = localNodes[0];
  checks.push(!expectLocal ? result("localbusiness-schema", "skip", `İşletme türü (${profile.schemaType}) yerel işletme değil.`) : !localNode ? result("localbusiness-schema", "fail", `LocalBusiness (${profile.schemaType}) şeması yok.`) : localNode.address ? result("localbusiness-schema", "pass", `${typesOf(localNode).join("/")} şeması adresle birlikte var.`) : result("localbusiness-schema", "warn", "LocalBusiness şemasında adres yok."));
  const faqNodes = nodes.filter((node) => typesOf(node).includes("FAQPage"));
  checks.push(faqNodes.length ? result("faq-schema", "pass", `FAQPage şeması bulundu (${faqNodes.length}).`) : result("faq-schema", "fail", "Örneklenen sayfalarda FAQPage şeması yok."));

  // --- social / media
  const ogMissing = ["title", "description", "image", "url"].filter((key) => !page.og[key]);
  checks.push(ogMissing.length === 4 ? result("open-graph", "fail", "Open Graph etiketi yok.") : ogMissing.length ? result("open-graph", "warn", `Eksik: ${ogMissing.map((key) => `og:${key}`).join(", ")}`, ogMissing.map((key) => `og:${key}`)) : result("open-graph", "pass", "og:title, og:description, og:image, og:url mevcut."));
  checks.push(page.twitter.card ? result("twitter-card", "pass", `twitter:card="${page.twitter.card}"`) : result("twitter-card", "fail", "twitter:card etiketi yok."));
  const noAlt = page.images.filter((image) => image.alt === null);
  checks.push(!page.images.length ? result("image-alt", "skip", "Örneklenen sayfalarda görsel yok.") : !noAlt.length ? result("image-alt", "pass", `${page.images.length} görselin tamamında alt özniteliği var.`) : result("image-alt", noAlt.length / page.images.length > 0.2 ? "fail" : "warn", `${page.images.length} görselden ${noAlt.length} tanesinde alt metni yok.`, noAlt.map((image) => `/: ${image.src.slice(0, 120)}`)));

  // --- AI readability / GEO
  const sentences = page.text.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.split(/\s+/).length >= 3);
  const avgSentence = sentences.length ? sentences.reduce((sum, sentence) => sum + sentence.split(/\s+/).length, 0) / sentences.length : 0;
  const avgParagraph = page.paragraphs.length ? page.paragraphs.reduce((sum, paragraph) => sum + paragraph.split(/\s+/).length, 0) / page.paragraphs.length : 0;
  const readabilityPoints = [page.wordCount >= 300, avgSentence > 0 && avgSentence <= 22, page.paragraphs.length > 0 && avgParagraph <= 90, page.lists > 0 || page.headings.length >= 4];
  const readabilityScore = readabilityPoints.filter(Boolean).length;
  checks.push(result("ai-readability", readabilityScore === 4 ? "pass" : readabilityScore >= 2 ? "warn" : "fail", `Ana sayfa ${page.wordCount} kelime; ortalama cümle ${avgSentence.toFixed(1)} kelime; ortalama paragraf ${avgParagraph.toFixed(0)} kelime; ${page.lists} liste.`));
  const questions = page.headings.filter((heading) => heading.text.trim().endsWith("?")).map((heading) => heading.text);
  checks.push(questions.length >= 2 ? result("question-headings", "pass", `${questions.length} soru biçimli başlık.`, questions) : result("question-headings", questions.length ? "warn" : "fail", `${questions.length} soru biçimli başlık.`, questions));
  checks.push(llmsOk ? result("llms-txt", "pass", "/llms.txt bulundu.") : result("llms-txt", "fail", "/llms.txt yok."));
  const locality = profile.locality;
  if (!locality) checks.push(result("locality-signals", "skip", "Sitenin hizmet bölgesi tanımlı değil (SITE_BUSINESS_JSON / site profili)."));
  else {
    const where = [["başlık", page.title || ""], ["H1", h1s.map((h) => h.text).join(" ")], ["metin", page.text]].filter(([, text]) => trLower(text).includes(trLower(locality))).map(([name]) => name);
    checks.push(where.length >= 2 ? result("locality-signals", "pass", `"${locality}" ${where.join(", ")} içinde geçiyor.`) : result("locality-signals", where.length ? "warn" : "fail", where.length ? `"${locality}" yalnız ${where.join(", ")} içinde geçiyor.` : `"${locality}" başlıkta, H1'de ve metinde geçmiyor.`));
  }
  const address = localNode?.address as Record<string, unknown> | string | undefined;
  checks.push(!expectLocal ? result("nap-schema", "skip", "Yerel işletme değil.") : !localNode ? result("nap-schema", "fail", "LocalBusiness şeması olmadığı için adres/telefon yok.") : address && localNode.telephone ? result("nap-schema", "pass", "Adres ve telefon şemada mevcut.") : result("nap-schema", "warn", `${address ? "" : "Adres "}${localNode.telephone ? "" : "Telefon "}eksik.`.trim()));
  const sameAs = nodes.flatMap((node) => (Array.isArray(node.sameAs) ? node.sameAs : node.sameAs ? [node.sameAs] : []).filter((item): item is string => typeof item === "string"));
  checks.push(sameAs.length >= 2 ? result("entity-links", "pass", `${sameAs.length} sameAs bağlantısı.`, sameAs) : result("entity-links", sameAs.length ? "warn" : "fail", `${sameAs.length} sameAs bağlantısı.`, sameAs));

  // --- performance / mobile (PageSpeed Insights is not called in this example)
  const viewportOk = /width\s*=\s*device-width/i.test(page.viewport || "");
  checks.push(viewportOk ? result("mobile-friendly", "pass", `viewport: ${page.viewport}`) : result("mobile-friendly", "fail", page.viewport ? `viewport device-width içermiyor: ${page.viewport}` : "viewport meta etiketi yok."));
  for (const id of ["performance-score", "lcp", "cls", "interactivity"]) checks.push(result(id, "skip", "Ölçülemedi."));
  return finalize(checks);
}

function finalize(list: CheckResult[]) {
  const scores: ScanScores = {
    seo: scoreOf(list, (check) => check.dimension !== "geo"),
    geo: scoreOf(list, (check) => check.dimension !== "seo"),
    schema: scoreOf(list, (check) => check.category === "schema" || check.id === "localbusiness-schema"),
    metadata: scoreOf(list, (check) => check.category === "metadata" || check.category === "social"),
    performance: null,
    technical: scoreOf(list, (check) => check.category === "technical"),
    content: scoreOf(list, (check) => check.category === "structure" || check.category === "ai" || check.category === "media" || check.category === "links"),
    local: scoreOf(list, (check) => check.category === "local"),
  };
  return { scores, issues: list.filter((check) => check.status === "fail" || check.status === "warn").length, critical: list.filter((check) => check.status === "fail" && CRITICAL_CHECKS.includes(check.id)).length, checks: list };
}

/* ------------------------------------------------------------------ demo */

export const demoHomeHtml = `<!doctype html>
<html lang="tr"><head>
<title>Zeytinlik Restoran | Foça'da deniz kenarında meze ve balık</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="description" content="Foça'da deniz kenarında zeytinyağlı mezeler, günlük balık ve ev yapımı tatlılar. Rezervasyon ve çalışma saatleri.">
<link rel="canonical" href="https://zeytinlik.example/">
<meta property="og:title" content="Zeytinlik Restoran">
<meta property="og:url" content="https://zeytinlik.example/">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Restaurant","name":"Zeytinlik Restoran","url":"https://zeytinlik.example/","address":{"@type":"PostalAddress","addressLocality":"Foça","addressRegion":"İzmir","addressCountry":"TR"}}</script>
</head><body>
<nav><a href="/">Ana sayfa</a> <a href="/menu">Menü</a> <a href="/rehber">Rehber</a> <a href="/iletisim">İletişim</a></nav>
<h1>Foça'da deniz kenarında Zeytinlik Restoran</h1>
<p>Zeytinlik Restoran, Foça sahilinde mevsim ürünleriyle hazırlanan mezeler sunar. Günlük balık tezgâhı her sabah yenilenir.</p>
<h3>Rezervasyon gerekli mi?</h3>
<p>Hafta sonu akşamları için rezervasyon önerilir.</p>
<img src="/images/teras.webp">
</body></html>`;

/** Offline analysis of a fictional demo homepage. */
export function demo() {
  const analysis = analyzeSnapshot({
    url: "https://zeytinlik.example/", status: 200, html: demoHomeHtml,
    robotsTxt: "User-agent: *\nAllow: /\n\nUser-agent: GPTBot\nDisallow: /\n", sitemapXml: null, llmsTxt: null,
    profile: { schemaType: "Restaurant", locality: "Foça" },
  });
  return {
    scores: analysis.scores, issues: analysis.issues, critical: analysis.critical,
    open: analysis.checks.filter((check) => check.status === "fail" || check.status === "warn").map((check) => `${check.priority.padEnd(6)} ${check.id}: ${check.finding}`),
  };
}

if (/seo-analysis\.ts$/.test(process.argv[1] ?? "")) console.log(JSON.stringify(demo(), null, 2));
