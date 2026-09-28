import { ApiError } from "@/lib/errors";
import { listAllPublications } from "@/lib/storage";
import { listConnectionsFor } from "@/lib/connection-storage";
import { sites } from "@/lib/sites";
import { ensureSiteRegistry } from "@/lib/site-registry";
import { effectiveStatus, type PublicationRow, type Target } from "@/lib/publications";
import {
  isValidSlug, pagePathPrefix, primaryLocation, publishLocations, publishStrategies, resolvePlacement, showsHomepageTeaser, slugify,
  type Placement, type PublishLocation,
} from "@/lib/publishing/definitions";
import { excerptOf, extractFaq, highlightsOf, keyFactsOf, parseContent, plainText, readingMinutes, tableOfContents, truncate, type ContentBlock, type TextBlock, type FaqEntry, type TocEntry } from "@/lib/publishing/content";
import { areaServed, businessProfile, directionsUrl, type BusinessProfile } from "@/lib/publishing/business";
import { buildJsonLd, type Breadcrumb } from "@/lib/publishing/schema";

/*
 * Read-side publishing engine. Turns stored publications into what each site
 * renders: indexable pages (SEO page / blog), slot items (homepage, service
 * page, footer) and sitemap entries. Pure derivation — nothing is written.
 */

export type IndexedEntry = {
  row: PublicationRow;
  siteId: string;
  target: Target & { payload: NonNullable<Target["payload"]> };
  placement: Placement;
  primary: PublishLocation;
  slug: string;
  published: boolean;
};

export async function siteOrigin(siteId: string) {
  await ensureSiteRegistry();
  const site = sites.find((entry) => entry.id === siteId);
  if (!site) throw new ApiError("Kapsam dışı veya bilinmeyen site.");
  try {
    const [connection] = await listConnectionsFor([siteId]);
    if (connection?.verified) return new URL(connection.site_url).origin;
  } catch { /* Fall back to the profile domain; pages must still render. */ }
  return `https://${site.domain}`;
}

/**
 * Every live content target of a site with a stable, unique slug. Slugs stored
 * at publish time win; legacy rows get a slug from their title. Collisions are
 * resolved deterministically (older publication keeps the clean slug).
 */
export function indexSite(rows: PublicationRow[], siteId: string): IndexedEntry[] {
  const candidates = rows
    .filter((row) => row.document.kind === "content")
    .flatMap((row) => {
      const target = row.document.targets[siteId];
      if (!target || target.status === "deleted" || !target.payload) return [];
      const placement = resolvePlacement(row.document.placement);
      return [{ row, target: target as IndexedEntry["target"], placement, primary: primaryLocation(placement) }];
    })
    .sort((a, b) => a.row.document.createdAt.localeCompare(b.row.document.createdAt) || a.row.id.localeCompare(b.row.id));
  const used = new Set<string>();
  return candidates.map((entry) => {
    const base = (isValidSlug(entry.target.slug) ? entry.target.slug : slugify(entry.target.payload.title || entry.row.document.title)) || entry.row.id.slice(0, 8);
    const slug = used.has(base) ? `${base}-${entry.row.id.slice(0, 6)}` : base;
    used.add(slug);
    return { ...entry, siteId, slug, published: effectiveStatus(entry.target) === "published" };
  });
}

/** Slugs already taken on each site, for assigning new unique slugs at publish time. */
export async function takenSlugs(siteIds: string[], excludeId?: string) {
  const rows = (await listAllPublications("content")).filter((row) => row.id !== excludeId);
  return Object.fromEntries(siteIds.map((siteId) => [siteId, new Set(indexSite(rows, siteId).map((entry) => entry.slug))]));
}
export function uniqueSlug(base: string, taken: Set<string>, fallback: string) {
  const clean = slugify(base) || fallback;
  if (!taken.has(clean)) return clean;
  for (let n = 2; n < 1000; n++) { const candidate = `${clean.slice(0, 76)}-${n}`; if (!taken.has(candidate)) return candidate; }
  return `${clean.slice(0, 70)}-${fallback.slice(0, 8)}`;
}

export const pagePath = (entry: Pick<IndexedEntry, "primary" | "slug">) => {
  const prefix = pagePathPrefix(entry.primary);
  return prefix ? `${prefix}/${entry.slug}` : null;
};

function publishedAt(entry: IndexedEntry) {
  if (entry.target.scheduledAt && Date.parse(entry.target.scheduledAt) <= Date.now()) return entry.target.scheduledAt;
  const event = entry.row.document.events.slice().reverse().find((item) => ["publish", "published", "republished"].includes(item.action) && item.siteIds.includes(entry.siteId));
  return event?.at || entry.row.document.createdAt;
}

export type PageSummary = {
  id: string; slug: string; path: string; url: string; location: PublishLocation; strategy: Placement["strategy"];
  title: string; excerpt: string; publishedAt: string; updatedAt: string;
};

function summarize(entry: IndexedEntry, origin: string): PageSummary | null {
  const path = pagePath(entry);
  if (!path) return null;
  const blocks = parseContent(entry.target.payload.body);
  return {
    id: entry.row.id, slug: entry.slug, path, url: `${origin}${path}`, location: entry.primary, strategy: entry.placement.strategy,
    title: entry.target.payload.title, excerpt: excerptOf(entry.target.payload.summary, blocks), publishedAt: publishedAt(entry), updatedAt: entry.row.document.updatedAt,
  };
}

/** Published indexable pages of one site (for sitemap, archives, related links). */
export async function listSitePages(siteId: string, location?: PublishLocation) {
  await ensureSiteRegistry();
  const [rows, origin] = await Promise.all([listAllPublications("content"), siteOrigin(siteId)]);
  return indexSite(rows, siteId)
    .filter((entry) => entry.published && (!location || entry.primary === location))
    .map((entry) => summarize(entry, origin))
    .filter((page): page is PageSummary => Boolean(page))
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
}

export type NapInfo = { name: string; address?: string; telephone?: string; email?: string; openingHours?: string[]; directionsUrl?: string };
export type SitePageModel = PageSummary & {
  siteId: string;
  strategyLabel: string;
  h1: string;
  metaTitle: string;
  metaDescription: string;
  summary?: string;
  readingMinutes?: number;
  blocks: ContentBlock[];
  toc: TocEntry[];
  faq: FaqEntry[];
  sections: { shortAnswer?: string; keyFacts?: string[]; nap?: NapInfo; areaServed?: string };
  breadcrumbs: Breadcrumb[];
  homeUrl: string;
  archive: { name: string; url: string };
  related: PageSummary[];
  relatedServices: { name: string; url: string }[];
  seo: {
    canonical: string;
    robots: { index: true; follow: true; "max-snippet": -1; "max-image-preview": "large" };
    openGraph: { type: "article"; url: string; title: string; description: string; siteName: string; locale: "tr_TR"; publishedTime: string; modifiedTime: string };
    twitter: { card: "summary"; title: string; description: string };
  };
  jsonLd: Record<string, unknown>;
};

function napInfo(profile: BusinessProfile): NapInfo | undefined {
  const address = [profile.streetAddress, [profile.postalCode, profile.locality].filter(Boolean).join(" "), profile.region].filter(Boolean).join(", ") || undefined;
  const info: NapInfo = { name: profile.name, address, telephone: profile.telephone, email: profile.email, openingHours: profile.openingHours, directionsUrl: directionsUrl(profile) };
  return address || info.telephone || info.email || info.openingHours?.length ? info : undefined;
}

export async function getSitePage(siteId: string, slug: string, location?: PublishLocation): Promise<SitePageModel | null> {
  const [rows, origin] = await Promise.all([listAllPublications("content"), siteOrigin(siteId)]);
  const index = indexSite(rows, siteId);
  const entry = index.find((item) => item.slug === slug && item.published && (!location || item.primary === location) && pagePath(item));
  if (!entry) return null;
  const profile = businessProfile(siteId)!;
  const strategy = publishStrategies[entry.placement.strategy];
  const payload = entry.target.payload;
  const blocks = parseContent(payload.body);
  const summary = summarize(entry, origin)!;
  const faq = extractFaq(blocks);
  const toc = tableOfContents(blocks);
  const canonical = summary.url;
  const archiveName = (publishLocations[entry.primary] as { archiveName?: string }).archiveName || publishLocations[entry.primary].label;
  const archive = { name: archiveName, url: `${origin}${pagePathPrefix(entry.primary)}` };
  const breadcrumbs: Breadcrumb[] = [{ name: "Ana sayfa", url: `${origin}/` }, archive, { name: payload.title, url: canonical }];
  const metaTitle = truncate(payload.metaTitle?.trim() || payload.title, 70);
  const metaDescription = truncate(payload.metaDescription?.trim() || summary.excerpt, 160);
  const related = index
    .filter((item) => item.published && item.row.id !== entry.row.id && pagePath(item))
    .sort((a, b) => Number(b.primary === entry.primary) - Number(a.primary === entry.primary) || b.row.document.updatedAt.localeCompare(a.row.document.updatedAt))
    .slice(0, strategy.layout.relatedCount)
    .map((item) => summarize(item, origin)!)
    ;
  const area = areaServed(profile);
  const shortAnswer = strategy.layout.shortAnswer ? truncate(payload.summary?.trim() || blocks.find((block): block is TextBlock => block.type === "p")?.text || "", 320) || undefined : undefined;
  const keyFacts = strategy.layout.keyFacts ? keyFactsOf(blocks) : [];
  return {
    ...summary,
    siteId,
    strategyLabel: strategy.label,
    h1: payload.title,
    metaTitle,
    metaDescription,
    summary: payload.summary?.trim() || undefined,
    readingMinutes: strategy.layout.readingTime ? readingMinutes(blocks) : undefined,
    blocks,
    toc: strategy.layout.toc && toc.length >= 2 ? toc : [],
    faq,
    sections: {
      shortAnswer,
      keyFacts: keyFacts.length >= 2 ? keyFacts : undefined,
      nap: strategy.layout.nap ? napInfo(profile) : undefined,
      areaServed: strategy.layout.geoSignals ? area : undefined,
    },
    breadcrumbs,
    homeUrl: `${origin}/`,
    archive,
    related,
    relatedServices: (profile.services || []).map((service) => ({ name: service.name, url: `${origin}${service.path}` })),
    seo: {
      canonical,
      robots: { index: true, follow: true, "max-snippet": -1, "max-image-preview": "large" },
      openGraph: { type: "article", url: canonical, title: metaTitle, description: metaDescription, siteName: profile.name, locale: "tr_TR", publishedTime: summary.publishedAt, modifiedTime: summary.updatedAt },
      twitter: { card: "summary", title: metaTitle, description: metaDescription },
    },
    jsonLd: buildJsonLd({
      origin, canonical, title: payload.title, description: metaDescription, publishedAt: summary.publishedAt, updatedAt: summary.updatedAt,
      location: entry.primary, strategy: entry.placement.strategy, breadcrumbs, faq, wordCount: plainText(blocks).split(/\s+/).filter(Boolean).length, profile,
    }),
  };
}

/* ------------------------------------------------------------------ slots */

export type SlotLocation = "homepage" | "service-page" | "footer";
export const isSlotLocation = (value: unknown): value is SlotLocation => value === "homepage" || value === "service-page" || value === "footer";

export type SlotTeaser = { intro: string; highlights: string[]; url: string; cta: string };
export type SlotItem = {
  id: string;
  kind: "content" | "form";
  payload: NonNullable<Target["payload"]>;
  /** "collapsible" keeps long text folded; "teaser" is a compact card linking to the full page. Absent for forms. */
  display?: "collapsible" | "teaser";
  placement?: { location: PublishLocation; strategy: Placement["strategy"] };
  teaser?: SlotTeaser;
};

/** Items for an in-page slot. Legacy/default consumers ask for the homepage slot. */
export function slotItems(rows: PublicationRow[], siteId: string, location: SlotLocation, origin: string, path?: string | null): SlotItem[] {
  const index = new Map(indexSite(rows, siteId).map((entry) => [entry.row.id, entry]));
  const items: { item: SlotItem; updatedAt: string }[] = [];
  for (const row of rows) {
    const target = row.document.targets[siteId];
    if (!target || effectiveStatus(target) !== "published" || !target.payload) continue;
    if (row.document.kind === "form") {
      // Forms keep their existing behaviour: shown in the default (homepage) slot.
      if (location === "homepage") items.push({ item: { id: row.id, kind: "form", payload: target.payload }, updatedAt: row.document.updatedAt });
      continue;
    }
    const entry = index.get(row.id);
    if (!entry) continue;
    const placement = { location: entry.placement.location, strategy: entry.placement.strategy };
    if (entry.primary === location) {
      if (location === "service-page" && entry.placement.servicePath && path && entry.placement.servicePath !== path) continue;
      if (location === "service-page" && entry.placement.servicePath && !path) continue;
      items.push({ item: { id: row.id, kind: "content", payload: target.payload, display: "collapsible", placement }, updatedAt: row.document.updatedAt });
      continue;
    }
    if (location === "homepage" && showsHomepageTeaser(entry.placement)) {
      const pathOnSite = pagePath(entry);
      if (!pathOnSite) continue;
      const blocks = parseContent(target.payload.body);
      const intro = excerptOf(target.payload.summary, blocks, 220);
      items.push({
        item: {
          id: row.id, kind: "content", display: "teaser", placement,
          // Teasers never ship the full article body (no duplicate content on the homepage).
          payload: { title: target.payload.title, summary: intro, body: "" },
          teaser: { intro, highlights: highlightsOf(blocks, target.payload.summary), url: `${origin}${pathOnSite}`, cta: "Devamını oku" },
        },
        updatedAt: row.document.updatedAt,
      });
    }
  }
  return items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((entry) => entry.item);
}

export function sitemapXml(pages: PageSummary[]) {
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  const urls = pages.map((page) => `  <url><loc>${escape(page.url)}</loc><lastmod>${escape(page.updatedAt)}</lastmod></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
}
