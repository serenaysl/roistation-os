// ROIstation connector — copy the whole folder to the target Next.js site as components/roistation/.
// Server-only helpers. No secrets: every endpoint used here is the public, read-only site feed.
//
// Site environment variables:
//   ROISTATION_SITE_ID     e.g. "zeytinlik-restoran" (required)
//   ROISTATION_MASTER_URL  e.g. "https://panel.roistation.example" (required)
//   ROISTATION_SITE_URL    e.g. "https://zeytinlik.example" (optional; forces canonical/OG URLs to this origin)
import type { Metadata, MetadataRoute } from "next";

export type RoistationLocation = "seo-page" | "blog";
export type RoistationBlock =
  | { type: "h2" | "h3"; text: string; id: string }
  | { type: "p" | "quote"; text: string }
  | { type: "ul" | "ol"; items: string[] };
export type RoistationPageSummary = {
  id: string; slug: string; path: string; url: string; location: RoistationLocation; strategy: string;
  title: string; excerpt: string; publishedAt: string; updatedAt: string;
};
export type RoistationPage = RoistationPageSummary & {
  siteId: string; strategyLabel: string; h1: string; metaTitle: string; metaDescription: string; summary?: string; readingMinutes?: number;
  blocks: RoistationBlock[]; toc: { id: string; text: string }[]; faq: { question: string; answer: string }[];
  sections: { shortAnswer?: string; keyFacts?: string[]; areaServed?: string; nap?: { name: string; address?: string; telephone?: string; email?: string; openingHours?: string[]; directionsUrl?: string } };
  breadcrumbs: { name: string; url: string }[]; homeUrl: string; archive: { name: string; url: string };
  related: RoistationPageSummary[]; relatedServices: { name: string; url: string }[];
  seo: {
    canonical: string;
    robots: { index: boolean; follow: boolean; "max-snippet": number; "max-image-preview": "large" };
    openGraph: { type: "article"; url: string; title: string; description: string; siteName: string; locale: string; publishedTime: string; modifiedTime: string };
    twitter: { card: "summary"; title: string; description: string };
  };
  jsonLd: Record<string, unknown>;
};
export type RoistationSlotItem = {
  id: string; kind: "content" | "form";
  payload: { title: string; body: string; summary?: string };
  display?: "collapsible" | "teaser";
  teaser?: { intro: string; highlights: string[]; url: string; cta: string };
};

export function roistationConfig() {
  const siteId = process.env.ROISTATION_SITE_ID || "";
  const masterUrl = process.env.ROISTATION_MASTER_URL || "";
  if (!/^[a-z0-9-]+$/.test(siteId) || !/^https:\/\//.test(masterUrl)) throw new Error("ROISTATION_SITE_ID ve ROISTATION_MASTER_URL (https) ortam değişkenlerini tanımla.");
  return { siteId, master: new URL(masterUrl).origin, siteUrl: process.env.ROISTATION_SITE_URL ? new URL(process.env.ROISTATION_SITE_URL).origin : null };
}

// Pages are cached by Next.js (ISR). Withdraw/delete in the panel purges them immediately through
// app/api/roistation/revalidate; this window is only the fallback. A master outage keeps the last good version.
const REVALIDATE_SECONDS = 30;

async function getJson<T>(path: string, params: Record<string, string | undefined>): Promise<T | null> {
  const { master, siteId } = roistationConfig();
  const url = new URL(path, master);
  url.searchParams.set("siteId", siteId);
  for (const [key, value] of Object.entries(params)) if (value) url.searchParams.set(key, value);
  const response = await fetch(url, { next: { revalidate: REVALIDATE_SECONDS, tags: ["roistation"] }, signal: AbortSignal.timeout(8000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`ROIstation yayın servisi yanıt vermedi (HTTP ${response.status}).`);
  return response.json() as Promise<T>;
}

/** Rewrites absolute URLs to ROISTATION_SITE_URL when the site is served from a different primary domain. */
function rebase<T>(value: T, from: string | undefined): T {
  const { siteUrl } = roistationConfig();
  if (!siteUrl || !from) return value;
  const origin = new URL(from).origin;
  return origin === siteUrl ? value : JSON.parse(JSON.stringify(value).split(origin).join(siteUrl)) as T;
}

export async function getRoistationPage(slug: string, location: RoistationLocation = "seo-page"): Promise<RoistationPage | null> {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) return null;
  const data = await getJson<{ page: RoistationPage }>("/api/site-page", { slug, location });
  return data ? rebase(data.page, data.page.homeUrl) : null;
}

export async function listRoistationPages(location?: RoistationLocation): Promise<RoistationPageSummary[]> {
  try {
    const data = await getJson<{ pages: RoistationPageSummary[] }>("/api/site-pages", { location });
    return data ? data.pages.map((page) => rebase(page, page.url)) : [];
  } catch { return []; }
}

/** In-page slot items: "homepage" (default), "service-page" (pass the page path) or "footer". */
export async function getRoistationSlot(location: "homepage" | "service-page" | "footer" = "homepage", path?: string): Promise<RoistationSlotItem[]> {
  try {
    const data = await getJson<{ items: RoistationSlotItem[] }>("/api/site-content", { location, path });
    return (data?.items || []).filter((item) => item.kind === "content").map((item) => (item.teaser ? rebase(item, item.teaser.url) : item));
  } catch { return []; }
}

export function roistationMetadata(page: RoistationPage): Metadata {
  return {
    title: page.metaTitle,
    description: page.metaDescription,
    alternates: { canonical: page.seo.canonical },
    robots: { index: page.seo.robots.index, follow: page.seo.robots.follow, googleBot: { index: page.seo.robots.index, follow: page.seo.robots.follow, "max-snippet": -1, "max-image-preview": "large" } },
    openGraph: { type: "article", url: page.seo.openGraph.url, title: page.seo.openGraph.title, description: page.seo.openGraph.description, siteName: page.seo.openGraph.siteName, locale: page.seo.openGraph.locale, publishedTime: page.seo.openGraph.publishedTime, modifiedTime: page.seo.openGraph.modifiedTime },
    twitter: { card: page.seo.twitter.card, title: page.seo.twitter.title, description: page.seo.twitter.description },
  };
}

/** Spread into the site's app/sitemap.ts: every published SEO page and blog post. */
export async function roistationSitemapEntries(): Promise<MetadataRoute.Sitemap> {
  const pages = await listRoistationPages();
  return pages.map((page) => ({ url: page.url, lastModified: new Date(page.updatedAt), changeFrequency: "monthly", priority: page.location === "seo-page" ? 0.7 : 0.6 }));
}
