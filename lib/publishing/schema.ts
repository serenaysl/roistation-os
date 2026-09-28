import { publishLocations, publishStrategies, type PublishLocation, type PublishStrategy } from "@/lib/publishing/definitions";
import { areaServed, isLocalBusinessType, type BusinessProfile } from "@/lib/publishing/business";
import type { FaqEntry } from "@/lib/publishing/content";

export type Breadcrumb = { name: string; url: string };
export type SchemaInput = {
  origin: string;
  canonical: string;
  title: string;
  description: string;
  publishedAt: string;
  updatedAt: string;
  location: PublishLocation;
  strategy: PublishStrategy;
  breadcrumbs: Breadcrumb[];
  faq: FaqEntry[];
  wordCount: number;
  profile: BusinessProfile;
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
