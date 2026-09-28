// Copy to the site as app/api/roistation/revalidate/route.ts and set ROISTATION_REVALIDATE_SECRET
// (same value as on the Master Panel, at least 32 random characters). When content is withdrawn
// or deleted in the panel, the master calls this endpoint so SEO pages, archives, sections and
// the sitemap stop showing it immediately instead of after the ISR window.
import { createHash, timingSafeEqual } from "node:crypto";
import { revalidatePath, revalidateTag } from "next/cache";

const digest = (value: string) => createHash("sha256").update(value).digest();

export async function POST(request: Request) {
  const secret = process.env.ROISTATION_REVALIDATE_SECRET || "";
  const given = request.headers.get("x-roistation-secret") || "";
  if (secret.length < 32 || !timingSafeEqual(digest(secret), digest(given))) return Response.json({ ok: false }, { status: 401 });

  let paths: string[] = [];
  try {
    const body = await request.json() as { paths?: unknown };
    if (Array.isArray(body.paths)) paths = body.paths.filter((path): path is string => typeof path === "string" && /^\/[a-z0-9\-_/.%]*$/i.test(path) && !path.includes("..")).slice(0, 50);
  } catch { /* An empty body still purges every ROIstation fetch. */ }

  // Every connector fetch is tagged "roistation". Next.js 16 takes a cache-life profile
  // ({ expire: 0 } = expire now); older versions ignore the second argument.
  (revalidateTag as (tag: string, profile?: unknown) => void)("roistation", { expire: 0 });
  for (const path of paths) revalidatePath(path);
  revalidatePath("/rehber/[slug]", "page");
  revalidatePath("/blog/[slug]", "page");
  return Response.json({ ok: true, revalidated: paths.length }, { headers: { "Cache-Control": "no-store" } });
}
