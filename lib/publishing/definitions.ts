/*
 * Publishing vocabulary shared by the admin UI (client) and the server.
 * Pure data: no Node APIs, safe to import in client components.
 *
 * Extending:
 *   - New location   -> add an entry to `publishLocations`.
 *   - New strategy   -> add an entry to `publishStrategies` (flags drive page
 *                        structure, schema, metadata and homepage behaviour).
 *   - New scope      -> add an entry to `publishScopes`.
 *   - New channel (Google Business Profile, RSS, newsletter…) -> lib/publishing/channels.ts
 * Nothing else needs to change: renderers, APIs and the UI iterate these registries.
 */

export type LocationDefinition = {
  label: string;
  description: string;
  /** "page" gets its own indexable URL on the site; "slot" is rendered inside an existing page. */
  kind: "page" | "slot";
  /** URL prefix on the target site for page locations. */
  pathPrefix?: string;
  /** Human breadcrumb / archive name for page locations. */
  archiveName?: string;
};

export const publishLocations = {
  "seo-page": { label: "SEO sayfası", description: "Kendi URL'si olan, sitenin kendi tasarımıyla açılan makale sayfası (/rehber/…). Ana sayfayı değiştirmez.", kind: "page", pathPrefix: "/rehber", archiveName: "Rehber" },
  homepage: { label: "Ana sayfa", description: "Ana sayfadaki yayın alanında, katlanabilir kısa bölüm olarak görünür.", kind: "slot" },
  blog: { label: "Blog", description: "Sitenin blog bölümünde makale olarak yayınlanır (/blog/…).", kind: "page", pathPrefix: "/blog", archiveName: "Blog" },
  "service-page": { label: "Hizmet sayfası", description: "Seçilen hizmet sayfasının sonuna, düzeni bozmadan katlanabilir bölüm olarak eklenir.", kind: "slot" },
  footer: { label: "Footer (iletişimden önce)", description: "İletişim bölümünün üstünde, katlanabilir içerik olarak görünür.", kind: "slot" },
} as const satisfies Record<string, LocationDefinition>;
export type PublishLocation = keyof typeof publishLocations;

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
  /** Also place a compact teaser with a "Read more" link on the homepage. */
  homepageTeaser: boolean;
  /** What the preview tells the user this strategy will do. */
  preview: string[];
};

export const publishStrategies = {
  seo: {
    label: "Sadece SEO", description: "Arama motorları için ayrı SEO sayfası. Ana sayfaya dokunmaz.", defaultLocation: "seo-page", pageType: "Article",
    schema: { organization: true, localBusiness: "never", faq: true },
    layout: { shortAnswer: false, keyFacts: false, toc: false, nap: false, readingTime: true, geoSignals: false, relatedCount: 4 }, homepageTeaser: false,
    preview: ["Başlık, meta açıklama, canonical", "Open Graph + Twitter Card", "Article + Breadcrumb şeması", "İç bağlantılar ve ilgili sayfalar"],
  },
  "seo-geo": {
    label: "SEO + GEO", description: "SEO'ya ek olarak yerel arama ve AI arama motorları (Google AI Overviews, ChatGPT, Claude, Gemini, Perplexity, Copilot) için yapılandırılır.", defaultLocation: "seo-page", pageType: "Article",
    schema: { organization: true, localBusiness: "when-applicable", faq: true },
    layout: { shortAnswer: true, keyFacts: true, toc: true, nap: false, readingTime: true, geoSignals: true, relatedCount: 4 }, homepageTeaser: false,
    preview: ["SEO sayfasındaki her şey", "LocalBusiness + Organization şeması", "SSS şeması (içerikte soru-cevap varsa)", "Konum sinyalleri ve varlık ilişkileri", "Kısa cevap + ana bilgiler kutusu"],
  },
  "local-business": {
    label: "Yerel işletme", description: "Yerel görünürlük: konum, hizmet bölgesi, çalışma saatleri, iletişim ve yol tarifi. NAP bilgisi yalnız tanımlı işletme verisinden gelir.", defaultLocation: "seo-page", pageType: "WebPage",
    schema: { organization: true, localBusiness: "always", faq: true },
    layout: { shortAnswer: true, keyFacts: true, toc: false, nap: true, readingTime: false, geoSignals: true, relatedCount: 4 }, homepageTeaser: false,
    preview: ["LocalBusiness / Restaurant şeması", "Adres, telefon, çalışma saatleri kutusu (tanımlıysa)", "Yol tarifi bağlantısı", "Hizmet bölgesi sinyalleri", "Google İşletme Profili ile NAP tutarlılığı"],
  },
  blog: {
    label: "Blog stratejisi", description: "Blog makalesi: okuma süresi, özet, başlık alanı, ilgili yazılar ve blog arşivi.", defaultLocation: "blog", pageType: "BlogPosting",
    schema: { organization: true, localBusiness: "never", faq: true },
    layout: { shortAnswer: false, keyFacts: false, toc: true, nap: false, readingTime: true, geoSignals: false, relatedCount: 3 }, homepageTeaser: false,
    preview: ["BlogPosting şeması", "Okuma süresi ve özet", "İçindekiler", "İlgili yazılar ve blog arşivi"],
  },
  "homepage-enhancement": {
    label: "Ana sayfa güçlendirme", description: "Ana sayfaya tam makale eklenmez: kısa giriş, öne çıkanlar ve 'Devamını oku' düğmesi. Tam içerik SEO sayfasında yayınlanır.", defaultLocation: "seo-page", pageType: "Article",
    schema: { organization: true, localBusiness: "when-applicable", faq: true },
    layout: { shortAnswer: false, keyFacts: false, toc: false, nap: false, readingTime: true, geoSignals: false, relatedCount: 4 }, homepageTeaser: true,
    preview: ["Ana sayfada kompakt bölüm (giriş + öne çıkanlar)", "'Devamını oku' → tam SEO sayfası", "Tam makale ana sayfaya eklenmez", "SEO sayfası için tüm meta ve şema"],
  },
  "ai-answer": {
    label: "AI cevap odaklı", description: "AI asistanların kolay anlayıp alıntılayacağı yapı: net başlık hiyerarşisi, soru-cevap, kısa olgusal paragraflar.", defaultLocation: "seo-page", pageType: "Article",
    schema: { organization: true, localBusiness: "when-applicable", faq: true },
    layout: { shortAnswer: true, keyFacts: true, toc: true, nap: false, readingTime: false, geoSignals: true, relatedCount: 4 }, homepageTeaser: false,
    preview: ["Kısa cevap kutusu en üstte", "İçindekiler ve anlamsal başlık hiyerarşisi", "Soru-cevap yapısı + SSS şeması", "Makine tarafından okunabilir varlık ilişkileri"],
  },
} as const satisfies Record<string, StrategyDefinition>;
export type PublishStrategy = keyof typeof publishStrategies;

export const publishScopes = {
  current: { label: "Yalnız bu site", description: "Tek bir sitede yayınla." },
  selected: { label: "Seçili siteler", description: "Listeden istediğin siteleri seç." },
  "all-connected": { label: "Tüm bağlı siteler", description: "Doğrulanmış tüm sitelerde yayınla; doğrulanmamış siteler atlanır ve uyarı gösterilir." },
} as const;
export type PublishScope = keyof typeof publishScopes;

export type Placement = { location: PublishLocation; strategy: PublishStrategy; servicePath?: string | null };

export const defaultPlacement: Placement = { location: "seo-page", strategy: "seo" };

export const isPublishLocation = (value: unknown): value is PublishLocation => typeof value === "string" && Object.prototype.hasOwnProperty.call(publishLocations, value);
export const isPublishStrategy = (value: unknown): value is PublishStrategy => typeof value === "string" && Object.prototype.hasOwnProperty.call(publishStrategies, value);
export const isPublishScope = (value: unknown): value is PublishScope => typeof value === "string" && Object.prototype.hasOwnProperty.call(publishScopes, value);

/** Legacy publications (no placement) become SEO pages; the homepage stays clean. */
export function resolvePlacement(placement?: Partial<Placement> | null): Placement {
  const location = isPublishLocation(placement?.location) ? placement.location : defaultPlacement.location;
  const strategy = isPublishStrategy(placement?.strategy) ? placement.strategy : defaultPlacement.strategy;
  return { location, strategy, servicePath: location === "service-page" ? placement?.servicePath || null : null };
}

/**
 * The single location where the FULL content renders (no duplicate content).
 * "Homepage enhancement" never puts the whole article on the homepage: the
 * full text lives on the SEO page and the homepage only gets a teaser.
 */
export function primaryLocation(placement: Placement): PublishLocation {
  if (publishStrategies[placement.strategy].homepageTeaser && placement.location === "homepage") return "seo-page";
  return placement.location;
}
export function showsHomepageTeaser(placement: Placement) {
  return publishStrategies[placement.strategy].homepageTeaser && publishLocations[primaryLocation(placement)].kind === "page";
}
export function pagePathPrefix(location: PublishLocation): string | null {
  const definition: LocationDefinition = publishLocations[location];
  return definition.kind === "page" && definition.pathPrefix ? definition.pathPrefix : null;
}

/** Normalizes a service page path entered by the user ("hizmetler/boya/" -> "/hizmetler/boya"). */
export function normalizeServicePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let path = trimmed;
  try { if (/^https?:\/\//i.test(trimmed)) path = new URL(trimmed).pathname; } catch { return null; }
  path = `/${path.replace(/^\/+/, "").replace(/\/+$/, "")}`.toLowerCase();
  if (path.length > 200 || !/^\/[a-z0-9\-_/.%]*$/.test(path) || path.includes("..")) return null;
  return path;
}

const turkishMap: Record<string, string> = { ç: "c", Ç: "c", ğ: "g", Ğ: "g", ı: "i", I: "i", İ: "i", ö: "o", Ö: "o", ş: "s", Ş: "s", ü: "u", Ü: "u", â: "a", Â: "a", î: "i", Î: "i", û: "u", Û: "u" };

/** SEO friendly slug with correct Turkish transliteration ("Foça'da En İyi Balık" -> "focada-en-iyi-balik"). */
export function slugify(value: string, maxLength = 80): string {
  const ascii = value
    .replace(/[çÇğĞıIİöÖşŞüÜâÂîÎûÛ]/g, (char) => turkishMap[char] || char)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " ve ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii.length <= maxLength) return ascii;
  const cut = ascii.slice(0, maxLength);
  return (cut.includes("-") ? cut.slice(0, cut.lastIndexOf("-")) : cut).replace(/-+$/g, "");
}
export const isValidSlug = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 120;

/** History labels for both current and legacy event names. */
export const eventLabels: Record<string, string> = {
  created: "Oluşturuldu", edited: "Düzenlendi", scheduled: "Planlandı", published: "Yayınlandı", republished: "Yeniden yayınlandı",
  withdrawn: "Yayından kaldırıldı", deleted: "Silindi", "auto-published": "Planlı saatte otomatik yayına girdi",
  publish: "Yayın işlemi", withdraw: "Yayından kaldırma", delete: "Silme",
};
