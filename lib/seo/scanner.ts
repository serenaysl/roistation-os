import { ApiError } from "@/lib/errors";
import { sites } from "@/lib/sites";
import { ensureSiteRegistry } from "@/lib/site-registry";
import { listConnectionsFor } from "@/lib/connection-storage";
import { allowedHosts, readCapped, safeGet } from "@/lib/verification";
import { projectForSite } from "@/lib/vercel/projects";
import { businessProfile, isLocalBusinessType } from "@/lib/publishing/business";
import { parseHtml, parseRobots, robotsBlocks, schemaNodes, sitemapLocs, typesOf, type ParsedPage } from "@/lib/seo/html";
import { result, scoreOf, type CheckResult } from "@/lib/seo/checks";

/*
 * Live SEO & GEO scan of one site. Sources:
 *   - the site's server-rendered HTML (home page + up to 4 inner pages from sitemap/internal links),
 *   - /robots.txt, the sitemap it declares (or /sitemap.xml), /llms.txt,
 *   - up to 25 internal links (HTTP status),
 *   - Google PageSpeed Insights (mobile): Lighthouse lab data + Chrome UX Report field data when available.
 * Anything that cannot be measured is recorded as "skip" with the reason — never estimated.
 */

const PAGE_TIMEOUT = 8000;
const SMALL_TIMEOUT = 5000;
const PSI_TIMEOUT = 42_000;
const SAMPLE_PAGES = 4;
const LINK_CHECKS = 25;
const AI_BOTS = ["gptbot", "claudebot", "perplexitybot", "google-extended"];

/** Per-page audit. Fields after `words` are absent on scans made before they existed. */
export type PageSummary = { url: string; status: number | null; title: string | null; h1: number; words: number;
  health?: number; indexable?: boolean; hasDescription?: boolean; hasCanonical?: boolean; schemaTypes?: string[]; schemaValid?: boolean; images?: number; imagesMissingAlt?: number };
/** Only these conditions make a site "Critical": offline/unreachable, 5xx, broken SSL, noindex, robots blocking, missing sitemap. */
export const CRITICAL_CHECKS = ["http-status", "indexable", "robots-allows", "sitemap"];

function pageSummary(url: string, status: number | null, parsed: ParsedPage | null, headerNoindex = false): PageSummary {
  if (!parsed) return { url, status, title: null, h1: 0, words: 0, health: 0, indexable: false };
  const nodes = schemaNodes(parsed.jsonLd);
  const schemaTypes = [...new Set([...nodes.flatMap(typesOf), ...parsed.microdataTypes])];
  const schemaValid = parsed.jsonLd.every((block) => !block.error && block.data);
  const h1 = parsed.headings.filter((heading) => heading.level === 1).length;
  const indexable = Boolean(status && status < 400) && !/noindex/i.test(parsed.robotsMeta || "") && !headerNoindex;
  const missingAlt = parsed.images.filter((image) => image.alt === null).length;
  const signals = [indexable, Boolean(parsed.title && parsed.title.length >= 10 && parsed.title.length <= 65), Boolean(parsed.metaDescription), Boolean(parsed.canonical), h1 === 1, schemaTypes.length > 0 && schemaValid, missingAlt === 0, Boolean(parsed.og.title || parsed.og.image)];
  return { url, status, title: parsed.title, h1, words: parsed.wordCount, health: Math.round((signals.filter(Boolean).length / signals.length) * 100), indexable, hasDescription: Boolean(parsed.metaDescription), hasCanonical: Boolean(parsed.canonical), schemaTypes, schemaValid, images: parsed.images.length, imagesMissingAlt: missingAlt };
}
export type PerformanceData = { measured: boolean; source: "field" | "lab" | null; score: number | null; lcpMs: number | null; cls: number | null; inpMs: number | null; tbtMs: number | null; reason?: string };
export type ScanScores = { seo: number | null; geo: number | null; schema: number | null; metadata: number | null; performance: number | null; technical: number | null; content: number | null; local: number | null };
export type ScanResult = {
  id: string; siteId: string; siteName: string; url: string; scannedAt: string; durationMs: number;
  deploymentId: string | null; reason: string;
  scores: ScanScores; issues: number; critical: number;
  checks: CheckResult[]; pages: PageSummary[]; performance: PerformanceData;
  facts: { robotsTxt: boolean; sitemapUrls: number; llmsTxt: boolean; schemaTypes: string[]; internalLinks: number; checkedLinks: number; brokenLinks: string[]; imagesWithoutAlt: string[]; ogImage: string | null; title: string | null; metaDescription: string | null; firstParagraph: string | null; discoveredUrls: string[] };
};

type Fetched = { ok: boolean; status: number | null; url: string; body: string; headers: Headers | null; error?: string };

async function fetchText(url: URL, hosts: Set<string>, timeout: number, accept: string, maxBytes = 2_000_000): Promise<Fetched> {
  try {
    const { response, url: finalUrl } = await safeGet(url, hosts, timeout, accept);
    const body = await readCapped(response, maxBytes).catch(() => "");
    return { ok: response.ok, status: response.status, url: finalUrl.href, body, headers: response.headers };
  } catch (error) {
    return { ok: false, status: null, url: url.href, body: "", headers: null, error: error instanceof Error ? error.name || error.message : "fetch failed" };
  }
}

async function linkStatus(url: URL, hosts: Set<string>): Promise<number | null> {
  try {
    const { response } = await safeGet(url, hosts, SMALL_TIMEOUT, "text/html");
    await response.body?.cancel().catch(() => undefined);
    return response.status;
  } catch (error) {
    // A redirect to another host (e.g. external login) is not a broken internal link.
    if (error instanceof ApiError) return null;
    return 0;
  }
}

/** Google PageSpeed Insights v5 (mobile). PAGESPEED_API_KEY raises the quota; without it Google's shared quota applies. */
async function pageSpeed(url: string): Promise<PerformanceData> {
  const endpoint = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
  endpoint.searchParams.set("url", url); endpoint.searchParams.set("strategy", "mobile"); endpoint.searchParams.set("category", "performance");
  if (process.env.PAGESPEED_API_KEY) endpoint.searchParams.set("key", process.env.PAGESPEED_API_KEY);
  try {
    const response = await fetch(endpoint, { cache: "no-store", signal: AbortSignal.timeout(PSI_TIMEOUT) });
    if (!response.ok) return { measured: false, source: null, score: null, lcpMs: null, cls: null, inpMs: null, tbtMs: null, reason: response.status === 429 ? "PageSpeed Insights kotası doldu (PAGESPEED_API_KEY ekleyin)." : `PageSpeed Insights HTTP ${response.status}` };
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
  } catch (error) {
    return { measured: false, source: null, score: null, lcpMs: null, cls: null, inpMs: null, tbtMs: null, reason: (error as Error)?.name === "TimeoutError" ? "PageSpeed Insights zamanında yanıt vermedi." : "PageSpeed Insights'a ulaşılamadı." };
  }
}

const sameSite = (a: string, b: string) => a.replace(/^www\./, "") === b.replace(/^www\./, "");
const normalizeDigits = (value: string) => value.replace(/\D/g, "").replace(/^90/, "").replace(/^0/, "");
const trLower = (value: string) => value.toLocaleLowerCase("tr");

export async function scanSite(siteId: string, reason = "manual"): Promise<ScanResult> {
  const started = Date.now();
  await ensureSiteRegistry();
  const site = sites.find((item) => item.id === siteId);
  if (!site) throw new ApiError("Kapsam dışı veya bilinmeyen site.");
  const [[connection], project] = await Promise.all([listConnectionsFor([siteId]), projectForSite(siteId, site.project).catch(() => null)]);
  const hosts = allowedHosts(siteId, project);
  const origin = new URL(project && !project.archived && project.productionUrl ? project.productionUrl : connection?.site_url || `https://${site.domain}`).origin;
  const home = new URL("/", origin);
  const psi = pageSpeed(home.href);

  const [homeRes, robotsRes, llmsRes] = await Promise.all([
    fetchText(home, hosts, PAGE_TIMEOUT, "text/html"),
    fetchText(new URL("/robots.txt", origin), hosts, SMALL_TIMEOUT, "text/plain", 200_000),
    fetchText(new URL("/llms.txt", origin), hosts, SMALL_TIMEOUT, "text/plain", 200_000),
  ]);
  const checks: CheckResult[] = [];
  const homeOk = homeRes.ok && Boolean(homeRes.body);
  const page: ParsedPage | null = homeOk ? parseHtml(homeRes.body) : null;
  const finalHost = new URL(homeRes.url).hostname;

  // --- robots.txt / sitemap / llms.txt
  const robotsFound = robotsRes.ok && !/<html/i.test(robotsRes.body.slice(0, 500));
  const robots = robotsFound ? parseRobots(robotsRes.body) : null;
  const sitemapCandidate = robots?.sitemaps.find((url) => { try { return hosts.has(new URL(url).hostname); } catch { return false; } }) || new URL("/sitemap.xml", origin).href;
  const sitemapRes = await fetchText(new URL(sitemapCandidate), hosts, SMALL_TIMEOUT, "application/xml", 3_000_000);
  let locs = sitemapRes.ok ? sitemapLocs(sitemapRes.body) : [];
  if (sitemapRes.ok && /<sitemapindex/i.test(sitemapRes.body) && locs[0]) {
    const child = await fetchText(new URL(locs[0]), hosts, SMALL_TIMEOUT, "application/xml", 3_000_000).catch(() => null);
    locs = child?.ok ? sitemapLocs(child.body) : [];
  }
  const sitemapOk = sitemapRes.ok && /<(urlset|sitemapindex)/i.test(sitemapRes.body);
  const llmsOk = llmsRes.ok && llmsRes.body.trim().length > 20 && !/<html/i.test(llmsRes.body.slice(0, 300));

  // --- inner pages (sitemap first, then internal links)
  const toUrl = (href: string, base: string) => { try { const url = new URL(href, base); url.hash = ""; return url; } catch { return null; } };
  const internal = (page?.links || []).map((link) => toUrl(link.href, homeRes.url)).filter((url): url is URL => Boolean(url && /^https?:$/.test(url.protocol) && sameSite(url.hostname, finalHost)));
  const uniqueInternal = [...new Map(internal.map((url) => [url.href, url])).values()];
  const candidates = [...locs.map((loc) => toUrl(loc, origin)).filter((url): url is URL => Boolean(url && sameSite(url.hostname, finalHost))), ...uniqueInternal]
    .filter((url) => url.pathname !== "/" && !/\.(pdf|jpe?g|png|webp|gif|svg|zip|xml|txt)$/i.test(url.pathname));
  const sampleUrls = [...new Map(candidates.map((url) => [url.pathname, url])).values()].slice(0, SAMPLE_PAGES);
  const samples = await Promise.all(sampleUrls.map(async (url) => { const res = await fetchText(url, hosts, 6000, "text/html"); return { url: url.href, res, parsed: res.ok && res.body ? parseHtml(res.body) : null }; }));
  const allPages = [...(page ? [{ url: homeRes.url, parsed: page }] : []), ...samples.filter((sample) => sample.parsed).map((sample) => ({ url: sample.url, parsed: sample.parsed! }))];

  // --- links
  const linkTargets = [...new Map([...uniqueInternal, ...samples.flatMap((sample) => (sample.parsed?.links || []).map((link) => toUrl(link.href, sample.url)).filter((url): url is URL => Boolean(url && sameSite(url.hostname, finalHost))))].map((url) => [url.href, url])).values()].slice(0, LINK_CHECKS);
  const statuses: (number | null)[] = [];
  for (let i = 0; i < linkTargets.length; i += 8) statuses.push(...await Promise.all(linkTargets.slice(i, i + 8).map((url) => linkStatus(url, hosts))));

  // --- technical
  checks.push(homeOk ? result("http-status", "pass", `Ana sayfa HTTP ${homeRes.status} döndürdü.`) : result("http-status", "fail", homeRes.status ? `Ana sayfa HTTP ${homeRes.status} döndürdü.` : "Ana sayfaya ulaşılamadı."));
  if (!page) {
    const performance = await psi;
    return finalize({ checks, performance, pages: [pageSummary(homeRes.url, homeRes.status, null)] });
  }
  const noindexMeta = /noindex/i.test(page.robotsMeta || ""); const noindexHeader = /noindex/i.test(homeRes.headers?.get("x-robots-tag") || "");
  checks.push(noindexMeta || noindexHeader ? result("indexable", "fail", `Sayfa ${noindexHeader ? "X-Robots-Tag başlığında" : "meta robots etiketinde"} noindex içeriyor.`) : result("indexable", "pass", "noindex yok; sayfa dizine eklenebilir."));
  checks.push(robotsFound ? result("robots-txt", "pass", "robots.txt bulundu.") : result("robots-txt", "fail", `robots.txt bulunamadı (HTTP ${robotsRes.status ?? "—"}).`));
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
  const reachableSamples = samples.filter((sample) => sample.res.ok).length;
  checks.push(uniqueInternal.length >= 3 && (sampleUrls.length === 0 || reachableSamples === sampleUrls.length) ? result("crawlability", "pass", `${uniqueInternal.length} iç bağlantı; örneklenen ${sampleUrls.length} iç sayfanın tamamı erişilebilir.`)
    : uniqueInternal.length === 0 && locs.length === 0 ? result("crawlability", "fail", "Ana sayfada taranabilir iç bağlantı yok ve sitemap URL içermiyor.")
    : result("crawlability", "warn", `${uniqueInternal.length} iç bağlantı; örneklenen ${sampleUrls.length} sayfadan ${reachableSamples} tanesi erişilebilir.`));

  // --- metadata (home + inner pages)
  const titleLen = page.title?.length ?? 0;
  const titles = allPages.map((item) => item.parsed.title).filter(Boolean) as string[];
  const duplicateTitles = titles.length > 1 && new Set(titles).size < titles.length;
  checks.push(!page.title ? result("title", "fail", "Ana sayfada <title> yok.") : titleLen < 10 || titleLen > 65 ? result("title", "warn", `Başlık ${titleLen} karakter: "${page.title}"`) : duplicateTitles ? result("title", "warn", "Bazı sayfalar aynı başlığı kullanıyor.", titles) : result("title", "pass", `"${page.title}" (${titleLen} karakter)`));
  const descLen = page.metaDescription?.length ?? 0;
  const missingDesc = allPages.filter((item) => !item.parsed.metaDescription).map((item) => item.url);
  checks.push(!page.metaDescription ? result("meta-description", "fail", "Ana sayfada meta description yok.", missingDesc) : descLen < 50 || descLen > 160 ? result("meta-description", "warn", `Meta açıklama ${descLen} karakter.`) : missingDesc.length ? result("meta-description", "warn", `${missingDesc.length} iç sayfada meta açıklama yok.`, missingDesc) : result("meta-description", "pass", `${descLen} karakter.`));
  const missingCanonical = allPages.filter((item) => !item.parsed.canonical).map((item) => item.url);
  const canonicalUrl = page.canonical ? toUrl(page.canonical, homeRes.url) : null;
  checks.push(!page.canonical ? result("canonical", "fail", "Ana sayfada canonical etiketi yok.", missingCanonical)
    : page.canonicalCount > 1 ? result("canonical", "warn", `Ana sayfada ${page.canonicalCount} canonical etiketi var.`)
    : canonicalUrl && !sameSite(canonicalUrl.hostname, finalHost) ? result("canonical", "warn", `Canonical başka bir alan adını gösteriyor: ${canonicalUrl.href}`)
    : missingCanonical.length ? result("canonical", "warn", `${missingCanonical.length} iç sayfada canonical yok.`, missingCanonical) : result("canonical", "pass", `Canonical: ${canonicalUrl?.href}`));
  checks.push(page.lang ? result("lang", "pass", `lang="${page.lang}"`) : result("lang", "fail", "<html> etiketinde lang yok."));

  // --- structure
  const h1s = page.headings.filter((heading) => heading.level === 1);
  const pagesWithoutH1 = allPages.filter((item) => !item.parsed.headings.some((heading) => heading.level === 1)).map((item) => item.url);
  checks.push(h1s.length === 0 ? result("h1", "fail", "Ana sayfada H1 yok.", pagesWithoutH1) : h1s.length > 1 ? result("h1", "warn", `Ana sayfada ${h1s.length} H1 var.`, h1s.map((heading) => heading.text)) : pagesWithoutH1.length ? result("h1", "warn", `${pagesWithoutH1.length} iç sayfada H1 yok.`, pagesWithoutH1) : result("h1", "pass", `H1: "${h1s[0].text}"`));
  const skips: string[] = [];
  for (const item of allPages) { let last = 0; for (const heading of item.parsed.headings) { if (last && heading.level > last + 1) skips.push(`${new URL(item.url).pathname}: H${last} → H${heading.level} (${heading.text.slice(0, 60)})`); last = heading.level; } }
  checks.push(!page.headings.length ? result("heading-hierarchy", "fail", "Sayfada başlık yok.") : skips.length ? result("heading-hierarchy", "warn", `${skips.length} yerde başlık seviyesi atlanıyor.`, skips) : result("heading-hierarchy", "pass", "Başlık seviyeleri sıralı."));

  // --- links
  checks.push(uniqueInternal.length >= 5 ? result("internal-links", "pass", `${uniqueInternal.length} benzersiz iç bağlantı.`) : result("internal-links", uniqueInternal.length ? "warn" : "fail", `Ana sayfada ${uniqueInternal.length} iç bağlantı var.`));
  const brokenList = linkTargets.map((url, index) => ({ url, status: statuses[index] })).filter((item) => item.status !== null && (item.status === 0 || item.status >= 400)).map((item) => `${item.url.pathname}${item.url.search} → ${item.status || "erişilemedi"}`);
  checks.push(!linkTargets.length ? result("broken-links", "skip", "Kontrol edilecek iç bağlantı yok.") : brokenList.length ? result("broken-links", "fail", `${linkTargets.length} bağlantıdan ${brokenList.length} tanesi kırık.`, brokenList) : result("broken-links", "pass", `${linkTargets.length} iç bağlantı kontrol edildi; kırık yok.`));
  const nodes = schemaNodes(allPages.flatMap((item) => item.parsed.jsonLd));
  const types = [...new Set([...nodes.flatMap(typesOf), ...allPages.flatMap((item) => item.parsed.microdataTypes)])];
  const innerPages = allPages.filter((item) => new URL(item.url).pathname !== "/");
  const breadcrumbPages = innerPages.filter((item) => item.parsed.breadcrumbMarkup || schemaNodes(item.parsed.jsonLd).some((node) => typesOf(node).includes("BreadcrumbList")));
  checks.push(!innerPages.length ? result("breadcrumbs", "skip", "İç sayfa örneklenemedi.") : breadcrumbPages.length === innerPages.length ? result("breadcrumbs", "pass", "İç sayfalarda breadcrumb var.") : result("breadcrumbs", breadcrumbPages.length ? "warn" : "fail", `${innerPages.length} iç sayfadan ${breadcrumbPages.length} tanesinde breadcrumb var.`, innerPages.filter((item) => !breadcrumbPages.includes(item)).map((item) => item.url)));

  // --- schema
  const invalid = allPages.flatMap((item) => item.parsed.jsonLd.filter((block) => block.error || !block.data).map((block) => `${new URL(item.url).pathname}: ${block.error || "boş blok"}`));
  const missingContext = allPages.flatMap((item) => item.parsed.jsonLd.filter((block) => block.data && typeof block.data === "object" && !Array.isArray(block.data) && !(block.data as Record<string, unknown>)["@context"]).map(() => `${new URL(item.url).pathname}: @context yok`));
  checks.push(types.length ? result("schema-present", "pass", `Bulunan türler: ${types.join(", ")}`) : result("schema-present", "fail", "Hiç schema.org yapısal verisi yok."));
  const blocksCount = allPages.reduce((sum, item) => sum + item.parsed.jsonLd.length, 0);
  checks.push(!blocksCount ? result("schema-valid", nodes.length || types.length ? "pass" : "skip", "Doğrulanacak JSON-LD bloğu yok.") : invalid.length ? result("schema-valid", "fail", `${invalid.length} JSON-LD bloğu geçersiz.`, invalid) : missingContext.length ? result("schema-valid", "warn", "Bazı JSON-LD bloklarında @context eksik.", missingContext) : result("schema-valid", "pass", `${blocksCount} JSON-LD bloğu geçerli.`));
  const profile = businessProfile(siteId)!;
  const localTypes = nodes.filter((node) => typesOf(node).some((type) => type === "LocalBusiness" || isLocalBusinessType(type)));
  const orgNode = nodes.find((node) => typesOf(node).some((type) => type === "Organization" || type === "LocalBusiness" || isLocalBusinessType(type)));
  checks.push(!orgNode ? result("organization-schema", "fail", "Organization veya LocalBusiness düğümü yok.") : orgNode.name && orgNode.url ? result("organization-schema", "pass", `${typesOf(orgNode).join("/")}: ${String(orgNode.name)}`) : result("organization-schema", "warn", "Organization düğümünde name veya url eksik."));
  const expectLocal = isLocalBusinessType(profile.schemaType);
  const localNode = localTypes[0];
  checks.push(!expectLocal ? result("localbusiness-schema", "skip", `İşletme türü (${profile.schemaType}) yerel işletme değil.`) : !localNode ? result("localbusiness-schema", "fail", `LocalBusiness (${profile.schemaType}) şeması yok.`) : localNode.address ? result("localbusiness-schema", "pass", `${typesOf(localNode).join("/")} şeması adresle birlikte var.`) : result("localbusiness-schema", "warn", "LocalBusiness şemasında adres yok."));
  const faqNodes = nodes.filter((node) => typesOf(node).includes("FAQPage"));
  checks.push(faqNodes.length ? result("faq-schema", "pass", `FAQPage şeması bulundu (${faqNodes.length}).`) : result("faq-schema", "fail", "Örneklenen sayfalarda FAQPage şeması yok."));

  // --- social / media
  const ogMissing = ["title", "description", "image", "url"].filter((key) => !page.og[key]);
  checks.push(ogMissing.length === 4 ? result("open-graph", "fail", "Open Graph etiketi yok.") : ogMissing.length ? result("open-graph", "warn", `Eksik: ${ogMissing.map((key) => `og:${key}`).join(", ")}`, ogMissing.map((key) => `og:${key}`)) : result("open-graph", "pass", "og:title, og:description, og:image, og:url mevcut."));
  checks.push(page.twitter.card ? result("twitter-card", "pass", `twitter:card="${page.twitter.card}"`) : result("twitter-card", "fail", "twitter:card etiketi yok."));
  const images = allPages.flatMap((item) => item.parsed.images.map((image) => ({ ...image, page: item.url })));
  const noAlt = images.filter((image) => image.alt === null);
  checks.push(!images.length ? result("image-alt", "skip", "Örneklenen sayfalarda görsel yok.") : !noAlt.length ? result("image-alt", "pass", `${images.length} görselin tamamında alt özniteliği var.`) : result("image-alt", noAlt.length / images.length > 0.2 ? "fail" : "warn", `${images.length} görselden ${noAlt.length} tanesinde alt metni yok.`, noAlt.map((image) => `${new URL(image.page).pathname}: ${image.src.slice(0, 120)}`)));

  // --- AI readability / GEO
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
  checks.push(llmsOk ? result("llms-txt", "pass", "/llms.txt bulundu.") : result("llms-txt", "fail", "/llms.txt yok."));
  const locality = profile.locality;
  if (!locality) checks.push(result("locality-signals", "skip", "Sitenin hizmet bölgesi tanımlı değil (SITE_BUSINESS_JSON / site profili)."));
  else {
    const where = [["başlık", page.title || ""], ["H1", h1s.map((h) => h.text).join(" ")], ["metin", page.text]].filter(([, value]) => trLower(value).includes(trLower(locality))).map(([name]) => name);
    checks.push(where.length >= 2 ? result("locality-signals", "pass", `"${locality}" ${where.join(", ")} içinde geçiyor.`) : result("locality-signals", where.length ? "warn" : "fail", where.length ? `"${locality}" yalnız ${where.join(", ")} içinde geçiyor.` : `"${locality}" başlıkta, H1'de ve metinde geçmiyor.`));
  }
  const address = localNode?.address as Record<string, unknown> | string | undefined;
  checks.push(!expectLocal ? result("nap-schema", "skip", "Yerel işletme değil.") : !localNode ? result("nap-schema", "fail", "LocalBusiness şeması olmadığı için adres/telefon yok.") : address && localNode.telephone ? result("nap-schema", "pass", "Adres ve telefon şemada mevcut.") : result("nap-schema", "warn", `${address ? "" : "Adres "}${localNode.telephone ? "" : "Telefon "}eksik.`.trim()));
  if (!profile.telephone && !profile.streetAddress) checks.push(result("gbp-consistency", "skip", "Google İşletme Profili bilgisi tanımlı değil (SITE_BUSINESS_JSON). Karşılaştırma yapılamadı."));
  else {
    const mismatches: string[] = [];
    const pageDigits = normalizeDigits(page.text);
    if (profile.telephone) { const phone = normalizeDigits(profile.telephone); const schemaPhone = localNode?.telephone ? normalizeDigits(String(localNode.telephone)) : ""; if (schemaPhone && schemaPhone !== phone) mismatches.push(`Şema telefonu farklı: ${String(localNode?.telephone)}`); if (!pageDigits.includes(phone) && !schemaPhone) mismatches.push(`Telefon (${profile.telephone}) sayfada ve şemada yok.`); }
    if (profile.streetAddress) { const street = trLower(profile.streetAddress).replace(/\s+/g, " "); const schemaStreet = typeof address === "object" && address ? trLower(String(address.streetAddress || "")) : typeof address === "string" ? trLower(address) : ""; if (!trLower(page.text).includes(street) && !schemaStreet.includes(street)) mismatches.push(`Adres (${profile.streetAddress}) sayfada ve şemada birebir geçmiyor.`); }
    checks.push(mismatches.length ? result("gbp-consistency", "fail", "NAP bilgisi Google İşletme Profili ile tutarsız.", mismatches) : result("gbp-consistency", "pass", "Telefon ve adres Google İşletme Profili bilgisiyle tutarlı."));
  }
  const sameAs = nodes.flatMap((node) => (Array.isArray(node.sameAs) ? node.sameAs : node.sameAs ? [node.sameAs] : []).filter((value): value is string => typeof value === "string"));
  checks.push(sameAs.length >= 2 ? result("entity-links", "pass", `${sameAs.length} sameAs bağlantısı.`, sameAs) : result("entity-links", sameAs.length ? "warn" : "fail", `${sameAs.length} sameAs bağlantısı.`, sameAs));

  // --- performance / mobile
  const performance = await psi;
  const viewportOk = /width\s*=\s*device-width/i.test(page.viewport || "");
  checks.push(viewportOk ? result("mobile-friendly", "pass", `viewport: ${page.viewport}`) : result("mobile-friendly", "fail", page.viewport ? `viewport device-width içermiyor: ${page.viewport}` : "viewport meta etiketi yok."));
  if (!performance.measured) {
    for (const id of ["performance-score", "lcp", "cls", "interactivity"]) checks.push(result(id, "skip", performance.reason || "Ölçülemedi."));
  } else {
    const source = performance.source === "field" ? "gerçek kullanıcı verisi (CrUX)" : "laboratuvar ölçümü (Lighthouse)";
    checks.push(result("performance-score", performance.score! >= 90 ? "pass" : performance.score! >= 50 ? "warn" : "fail", `Mobil performans puanı ${performance.score}.`));
    checks.push(performance.lcpMs === null ? result("lcp", "skip", "LCP ölçülemedi.") : result("lcp", performance.lcpMs <= 2500 ? "pass" : performance.lcpMs <= 4000 ? "warn" : "fail", `LCP ${(performance.lcpMs / 1000).toFixed(2)} sn — ${source}.`));
    checks.push(performance.cls === null ? result("cls", "skip", "CLS ölçülemedi.") : result("cls", performance.cls <= 0.1 ? "pass" : performance.cls <= 0.25 ? "warn" : "fail", `CLS ${performance.cls.toFixed(3)} — ${source}.`));
    checks.push(performance.inpMs !== null ? result("interactivity", performance.inpMs <= 200 ? "pass" : performance.inpMs <= 500 ? "warn" : "fail", `INP ${Math.round(performance.inpMs)} ms — gerçek kullanıcı verisi (CrUX).`)
      : performance.tbtMs !== null ? result("interactivity", performance.tbtMs <= 200 ? "pass" : performance.tbtMs <= 600 ? "warn" : "fail", `Total Blocking Time ${Math.round(performance.tbtMs)} ms — laboratuvar ölçümü.`) : result("interactivity", "skip", "Etkileşim metriği ölçülemedi."));
  }

  return finalize({ checks, performance, pages: [pageSummary(homeRes.url, homeRes.status, page, noindexHeader), ...samples.map((sample) => pageSummary(sample.url, sample.res.status, sample.parsed, /noindex/i.test(sample.res.headers?.get("x-robots-tag") || "")))], extra: { page, locs, llmsOk, robotsFound, types, uniqueInternal: uniqueInternal.map((url) => url.href), linkTargets: linkTargets.length, brokenList, noAlt: noAlt.map((image) => image.src) } });

  function finalize(input: { checks: CheckResult[]; performance: PerformanceData; pages: PageSummary[]; extra?: { page: ParsedPage; locs: string[]; llmsOk: boolean; robotsFound: boolean; types: string[]; uniqueInternal: string[]; linkTargets: number; brokenList: string[]; noAlt: string[] } }): ScanResult {
    const list = input.checks;
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
    const extra = input.extra;
    return {
      id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, siteId, siteName: site!.name, url: homeRes.url, scannedAt: new Date().toISOString(), durationMs: Date.now() - started,
      deploymentId: project?.latestProduction?.state === "READY" ? project.latestProduction.id : project?.currentProduction?.id ?? null, reason,
      scores, issues: list.filter((check) => check.status === "fail" || check.status === "warn").length, critical: list.filter((check) => check.status === "fail" && CRITICAL_CHECKS.includes(check.id)).length,
      checks: list, pages: input.pages, performance: input.performance,
      facts: {
        robotsTxt: extra?.robotsFound ?? false, sitemapUrls: extra?.locs.length ?? 0, llmsTxt: extra?.llmsOk ?? false, schemaTypes: extra?.types ?? [],
        internalLinks: extra?.uniqueInternal.length ?? 0, checkedLinks: extra?.linkTargets ?? 0, brokenLinks: extra?.brokenList ?? [], imagesWithoutAlt: (extra?.noAlt ?? []).slice(0, 50),
        ogImage: extra?.page.og.image ?? null, title: extra?.page.title ?? null, metaDescription: extra?.page.metaDescription ?? null,
        firstParagraph: extra?.page.paragraphs.find((paragraph) => paragraph.length > 60) ?? null,
        discoveredUrls: [...new Set([...(extra?.locs ?? []), ...(extra?.uniqueInternal ?? [])])].slice(0, 200),
      },
    };
  }
}
