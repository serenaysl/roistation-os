// For sites WITHOUT their own blog: copy to app/blog/[slug]/page.tsx.
// Sites WITH a blog: keep your route and, where a post is not found, fall back to
//   const page = await getRoistationPage(slug, "blog"); if (page) return <RoistationArticle page={page} />;
// and use roistationMetadata(page) in generateMetadata. The article inherits your blog layout.
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getRoistationPage, roistationMetadata } from "@/components/roistation/client";
import { RoistationArticle } from "@/components/roistation/article";

export const revalidate = 30;

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  const page = await getRoistationPage(slug, "blog");
  return page ? roistationMetadata(page) : { robots: { index: false } };
}

export default async function RoistationBlogPost({ params }: Props) {
  const { slug } = await params;
  const page = await getRoistationPage(slug, "blog");
  if (!page) notFound();
  return <RoistationArticle page={page} />;
}
