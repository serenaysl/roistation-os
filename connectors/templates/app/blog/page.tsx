// For sites WITHOUT their own blog: copy to app/blog/page.tsx (blog archive).
// Sites WITH a blog: merge `await listRoistationPages("blog")` into your existing post list.
import type { Metadata } from "next";
import { listRoistationPages } from "@/components/roistation/client";
import { RoistationArchive } from "@/components/roistation/article";

export const revalidate = 30;
export const metadata: Metadata = { title: "Blog", alternates: { canonical: "/blog" } };

export default async function RoistationBlogIndex() {
  return <RoistationArchive title="Blog" pages={await listRoistationPages("blog")} />;
}
