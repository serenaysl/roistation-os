// Copy to the site as app/rehber/page.tsx — archive of every published SEO page.
// Not linked from the main navigation on purpose: /rehber is reached via internal links, breadcrumbs, sitemap and search.
import type { Metadata } from "next";
import { listRoistationPages } from "@/components/roistation/client";
import { RoistationArchive } from "@/components/roistation/article";

export const revalidate = 30;
export const metadata: Metadata = { title: "Rehber", description: "Güncel rehber yazıları ve sık sorulan sorular.", alternates: { canonical: "/rehber" } };

export default async function RoistationGuideIndex() {
  return <RoistationArchive title="Rehber" pages={await listRoistationPages("seo-page")} />;
}
