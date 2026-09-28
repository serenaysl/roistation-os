// If the site has NO app/sitemap.ts, copy this file. If it already has one, add
//   ...(await roistationSitemapEntries())
// to the array it returns. SEO pages and blog posts are then listed automatically.
// Make sure robots.txt does not disallow /rehber or /blog.
import type { MetadataRoute } from "next";
import { roistationSitemapEntries } from "@/components/roistation/client";

export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = process.env.ROISTATION_SITE_URL || "";
  return [
    ...(base ? [{ url: `${base}/`, changeFrequency: "weekly" as const, priority: 1 }] : []),
    ...(await roistationSitemapEntries()),
  ];
}
