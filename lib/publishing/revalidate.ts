import { siteOrigin } from "@/lib/publishing/page-model";

/*
 * On-demand cache invalidation on the client sites after withdraw/delete.
 * Each site exposes POST /api/roistation/revalidate (connector kit) protected by
 * ROISTATION_REVALIDATE_SECRET, set to the same value on the master and the sites.
 * Best effort and time-bounded: a site that is down never blocks or fails the
 * operation; it falls back to its short ISR window.
 */

export type RevalidationResult = { siteId: string; ok: boolean; skipped?: boolean };
const TIMEOUT_MS = 4000;
const pathPattern = /^\/[a-z0-9\-_/.%]*$/i;

export function revalidationConfigured() {
  return (process.env.ROISTATION_REVALIDATE_SECRET || "").length >= 32;
}

export async function revalidateSites(targets: { siteId: string; paths: string[] }[]): Promise<RevalidationResult[]> {
  const secret = process.env.ROISTATION_REVALIDATE_SECRET || "";
  if (!revalidationConfigured()) return targets.map((target) => ({ siteId: target.siteId, ok: false, skipped: true }));
  return Promise.all(targets.map(async ({ siteId, paths }) => {
    try {
      // Only the verified connection origin (or the site's profile domain) is ever contacted.
      const origin = await siteOrigin(siteId);
      const unique = [...new Set(["/", "/sitemap.xml", ...paths])].filter((path) => pathPattern.test(path) && !path.includes("..")).slice(0, 50);
      const response = await fetch(`${origin}/api/roistation/revalidate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-roistation-secret": secret },
        body: JSON.stringify({ paths: unique }),
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      return { siteId, ok: response.ok };
    } catch {
      return { siteId, ok: false };
    }
  }));
}
