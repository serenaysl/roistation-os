/*
 * Example: the schema.org @graph generator for published SEO / blog pages.
 *
 * Demonstrates:
 *   - how the publish STRATEGY drives the graph: main node type (Article / BlogPosting /
 *     WebPage), whether the business is emitted as Organization or as a LocalBusiness subtype
 *     (Restaurant, Dentist, ...), FAQPage, and geo signals (areaServed / spatialCoverage),
 *   - stable @id references (#organization, #website, #webpage, #breadcrumb, #article, #faq)
 *     so every node links to the others instead of repeating data,
 *   - business identity normalisation: NAP fields come ONLY from configured data
 *     (SITE_BUSINESS_JSON) and are length-checked / https-only, never invented.
 *
 * Source: lib/publishing/schema.ts, lib/publishing/business.ts, lib/publishing/definitions.ts
 *
 * Differences from production: `businessProfileFrom()` takes the site entry and its
 * SITE_BUSINESS_JSON object as arguments (production looks the site up in lib/sites.ts and
 * caches the parsed env var). The location/strategy registries are trimmed to the fields the
 * generator reads. FAQ entries are passed in; production extracts them from question headings
 * in the content (lib/publishing/content.ts extractFaq).
 */

/* ------------------------------------------------ lib/publishing/business.ts */

export type BusinessService = { name: string; path: string };
export type BusinessProfile = {
  name: string; schemaType: string; locality?: string; region?: string; country: string; telephone?: string; email?: string;
  streetAddress?: string; postalCode?: string; openingHours?: string[]; priceRange?: string; servesCuisine?: string[];
  latitude?: number; longitude?: number; mapsUrl?: string; sameAs?: string[]; logo?: string; services?: BusinessService[];
};

const localTypes = new Set(["LocalBusiness","Restaurant","MedicalBusiness","Dentist","Physician","HousekeepingService","GeneralContractor","TravelAgency","ProfessionalService","LodgingBusiness","Hotel","Store","HealthAndBeautyBusiness","FoodEstablishment","CafeOrCoffeeShop","HomeAndConstructionBusiness","MedicalClinic"]);
export const isLocalBusinessType = (type: string) => localTypes.has(type);

const str = (value: unknown, max = 300) => (typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined);
const strList = (value: unknown, max = 20) => (Array.isArray(value) ? value.map((item) => str(item)).filter((item): item is string => Boolean(item)).slice(0, max) : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const httpsUrl = (value: unknown) => { const text = str(value, 500); if (!text) return undefined; try { const url = new URL(text); return url.protocol === "https:" ? url.href : undefined; } catch { return undefined; } };

export type SiteEntry = { id: string; name: string; business?: { schemaType: string; locality?: string; region?: string } };

/** Body of production `businessProfile(siteId)`: site profile + that site's SITE_BUSINESS_JSON entry. */
export function businessProfileFrom(site: SiteEntry, extra: Record<string, unknown> = {}): BusinessProfile {
  const services = Array.isArray(extra.services)
    ? extra.services.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const name = str(record.name, 120); const path = str(record.path, 200);
      return name && path && path.startsWith("/") && !path.startsWith("//") ? [{ name, path }] : [];
    }).slice(0, 20)
    : undefined;
  return {
    name: str(extra.name, 160) || site.name,
    schemaType: str(extra.schemaType, 60) || site.business?.schemaType || "Organization",
    locality: str(extra.locality, 80) || site.business?.locality,
    region: str(extra.region, 80) || site.business?.region,
    country: str(extra.country, 2) || "TR",
    telephone: str(extra.telephone, 40),
    email: str(extra.email, 160),
    streetAddress: str(extra.streetAddress, 200),
    postalCode: str(extra.postalCode, 20),
    openingHours: strList(extra.openingHours, 14),
    priceRange: str(extra.priceRange, 20),
    servesCuisine: strList(extra.servesCuisine, 10),
    latitude: num(extra.latitude),
    longitude: num(extra.longitude),
    mapsUrl: httpsUrl(extra.mapsUrl),
    sameAs: strList(extra.sameAs, 10)?.map((value) => httpsUrl(value)).filter((value): value is string => Boolean(value)),
    logo: httpsUrl(extra.logo),
    services,
  };
}

/** Human "Ayvalık, Balıkesir" style area line, only from configured data. */
export function areaServed(profile: BusinessProfile) {
  return [profile.locality, profile.region].filter(Boolean).join(", ") || undefined;
}

/* --------------------------------------- lib/publishing/definitions.ts (trimmed) */

export const publishLocations = {
  "seo-page": { label: "SEO sayfası", archiveName: "Rehber" },
  homepage: { label: "Ana sayfa" },
  blog: { label: "Blog", archiveName: "Blog" },
  "service-page": { label: "Hizmet sayfası" },
  footer: { label: "Footer (iletişimden önce)" },
} as const;
export type PublishLocation = keyof typeof publishLocations;

type StrategySchema = { label: string; pageType: "Article" | "BlogPosting" | "WebPage"; schema: { organization: boolean; localBusiness: "never" | "when-applicable" | "always"; faq: boolean }; layout: { geoSignals: boolean } };
export const publishStrategies = {
  seo: { label: "Sadece SEO", pageType: "Article", schema: { organization: true, localBusiness: "never", faq: true }, layout: { geoSignals: false } },
  "seo-geo": { label: "SEO + GEO", pageType: "Article", schema: { organization: true, localBusiness: "when-applicable", faq: true }, layout: { geoSignals: true } },
  "local-business": { label: "Yerel işletme", pageType: "WebPage", schema: { organization: true, localBusiness: "always", faq: true }, layout: { geoSignals: true } },
  blog: { label: "Blog stratejisi", pageType: "BlogPosting", schema: { organization: true, localBusiness: "never", faq: true }, layout: { geoSignals: false } },
  "homepage-enhancement": { label: "Ana sayfa güçlendirme", pageType: "Article", schema: { organization: true, localBusiness: "when-applicable", faq: true }, layout: { geoSignals: false } },
  "ai-answer": { label: "AI cevap odaklı", pageType: "Article", schema: { organization: true, localBusiness: "when-applicable", faq: true }, layout: { geoSignals: true } },
} as const satisfies Record<string, StrategySchema>;
export type PublishStrategy = keyof typeof publishStrategies;

/* -------------------------------------------------- lib/publishing/schema.ts */

export type FaqEntry = { question: string; answer: string };
export type Breadcrumb = { name: string; url: string };
export type SchemaInput = {
  origin: string; canonical: string; title: string; description: string; publishedAt: string; updatedAt: string;
  location: PublishLocation; strategy: PublishStrategy; breadcrumbs: Breadcrumb[]; faq: FaqEntry[]; wordCount: number; profile: BusinessProfile;
};

/** Whether the business node is emitted as a LocalBusiness subtype (e.g. Restaurant) for this strategy. */
export function usesLocalBusiness(strategy: PublishStrategy, profile: BusinessProfile) {
  const rule = publishStrategies[strategy].schema.localBusiness;
  return rule === "always" || (rule === "when-applicable" && isLocalBusinessType(profile.schemaType));
}

function businessNode(input: SchemaInput) {
  const { profile, origin, strategy } = input;
  const id = `${origin}/#organization`;
  const base: Record<string, unknown> = { "@id": id, name: profile.name, url: `${origin}/` };
  if (profile.logo) base.logo = profile.logo;
  if (profile.sameAs?.length) base.sameAs = profile.sameAs;
  if (profile.telephone) base.telephone = profile.telephone;
  if (profile.email) base.email = profile.email;
  if (!usesLocalBusiness(strategy, profile)) return { "@type": "Organization", ...base };

  const type = isLocalBusinessType(profile.schemaType) ? profile.schemaType : "LocalBusiness";
  const node: Record<string, unknown> = { "@type": type, ...base };
  if (profile.locality || profile.streetAddress) {
    node.address = {
      "@type": "PostalAddress",
      ...(profile.streetAddress ? { streetAddress: profile.streetAddress } : {}),
      ...(profile.postalCode ? { postalCode: profile.postalCode } : {}),
      ...(profile.locality ? { addressLocality: profile.locality } : {}),
      ...(profile.region ? { addressRegion: profile.region } : {}),
      addressCountry: profile.country,
    };
  }
  if (profile.latitude !== undefined && profile.longitude !== undefined) node.geo = { "@type": "GeoCoordinates", latitude: profile.latitude, longitude: profile.longitude };
  if (profile.openingHours?.length) node.openingHours = profile.openingHours;
  if (profile.priceRange) node.priceRange = profile.priceRange;
  if (profile.mapsUrl) node.hasMap = profile.mapsUrl;
  if (type === "Restaurant" && profile.servesCuisine?.length) node.servesCuisine = profile.servesCuisine;
  const area = areaServed(profile);
  if (area && publishStrategies[strategy].layout.geoSignals) node.areaServed = { "@type": "Place", name: area };
  return node;
}

export function buildJsonLd(input: SchemaInput) {
  const strategy = publishStrategies[input.strategy];
  const orgId = `${input.origin}/#organization`;
  const websiteId = `${input.origin}/#website`;
  const webpageId = `${input.canonical}#webpage`;
  const breadcrumbId = `${input.canonical}#breadcrumb`;
  const area = areaServed(input.profile);
  const graph: Record<string, unknown>[] = [];

  graph.push(businessNode(input));
  graph.push({ "@type": "WebSite", "@id": websiteId, url: `${input.origin}/`, name: input.profile.name, inLanguage: "tr-TR", publisher: { "@id": orgId } });
  graph.push({
    "@type": "WebPage", "@id": webpageId, url: input.canonical, name: input.title, description: input.description, inLanguage: "tr-TR",
    isPartOf: { "@id": websiteId }, breadcrumb: { "@id": breadcrumbId }, datePublished: input.publishedAt, dateModified: input.updatedAt,
    ...(strategy.pageType === "WebPage" ? { about: { "@id": orgId } } : {}),
  });
  if (strategy.pageType !== "WebPage") {
    graph.push({
      "@type": strategy.pageType, "@id": `${input.canonical}#article`, headline: input.title.slice(0, 110), description: input.description,
      datePublished: input.publishedAt, dateModified: input.updatedAt, inLanguage: "tr-TR", wordCount: input.wordCount,
      mainEntityOfPage: { "@id": webpageId }, author: { "@id": orgId }, publisher: { "@id": orgId },
      articleSection: (publishLocations[input.location] as { archiveName?: string }).archiveName || publishLocations[input.location].label,
      ...(area && strategy.layout.geoSignals ? { spatialCoverage: { "@type": "Place", name: area }, about: [{ "@id": orgId }, { "@type": "Place", name: area }] } : { about: { "@id": orgId } }),
    });
  }
  graph.push({
    "@type": "BreadcrumbList", "@id": breadcrumbId,
    itemListElement: input.breadcrumbs.map((crumb, index) => ({ "@type": "ListItem", position: index + 1, name: crumb.name, item: crumb.url })),
  });
  if (strategy.schema.faq && input.faq.length) {
    graph.push({
      "@type": "FAQPage", "@id": `${input.canonical}#faq`, isPartOf: { "@id": webpageId }, inLanguage: "tr-TR",
      mainEntity: input.faq.map((entry) => ({ "@type": "Question", name: entry.question, acceptedAnswer: { "@type": "Answer", text: entry.answer } })),
    });
  }
  return { "@context": "https://schema.org", "@graph": graph };
}

/* ------------------------------------------------------------------ demo */

/** Same fictional page rendered with two strategies: "seo" (Organization) and "seo-geo" (Restaurant + geo signals). */
export function demo() {
  const site: SiteEntry = { id: "zeytinlik-restoran", name: "Zeytinlik Restoran", business: { schemaType: "Restaurant", locality: "Foça", region: "İzmir" } };
  // Demo SITE_BUSINESS_JSON entry. The http:// logo is dropped: only https URLs are accepted.
  const profile = businessProfileFrom(site, { openingHours: ["Mo-Su 09:00-23:00"], servesCuisine: ["Balık", "Meze"], logo: "http://zeytinlik.example/logo.png" });
  const origin = "https://zeytinlik.example";
  const canonical = `${origin}/rehber/focada-en-iyi-balik`;
  const base = {
    origin, canonical, title: "Foça'da En İyi Balık", description: "Foça'da taze balık ve meze için Zeytinlik Restoran rehberi.",
    publishedAt: "2026-01-10T09:00:00.000Z", updatedAt: "2026-01-12T09:00:00.000Z", location: "seo-page" as const, wordCount: 640, profile,
    breadcrumbs: [{ name: "Ana sayfa", url: `${origin}/` }, { name: "Rehber", url: `${origin}/rehber` }, { name: "Foça'da En İyi Balık", url: canonical }],
    faq: [{ question: "Rezervasyon gerekli mi?", answer: "Hafta sonu akşamları için rezervasyon önerilir." }],
  };
  return { seo: buildJsonLd({ ...base, strategy: "seo" }), seoGeo: buildJsonLd({ ...base, strategy: "seo-geo" }) };
}

if (/schema-generator\.ts$/.test(process.argv[1] ?? "")) console.log(JSON.stringify(demo(), null, 2));
