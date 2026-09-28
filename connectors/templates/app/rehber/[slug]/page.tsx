// Copy to the site as app/rehber/[slug]/page.tsx. The site's root layout wraps this page,
// so header, footer, navigation, colors and typography stay exactly as the rest of the site.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getRoistationPage, roistationMetadata } from "@/components/roistation/client";
import { RoistationArticle } from "@/components/roistation/article";

export const revalidate = 30;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = await getRoistationPage(slug, "seo-page");
  return page ? roistationMetadata(page) : { robots: { index: false } };
}

export default async function RoistationSeoPage({ params }: Props) {
  const { slug } = await params;
  const page = await getRoistationPage(slug, "seo-page");
  if (!page) notFound();
  return <RoistationArticle page={page} />;
}
