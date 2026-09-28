import { apiFailure } from "@/lib/database";
import { requireCronSecret } from "@/lib/admin";
import { runScan, seoDashboard } from "@/lib/seo/dashboard";

// Daily: re-scans sites whose production deployment changed since their last scan (up to 3 in parallel).
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    const dashboard = await seoDashboard();
    const due = dashboard.sites.filter((site) => site.rescanNeeded).slice(0, 3);
    const results = await Promise.allSettled(due.map((site) => runScan(site.siteId, "deploy")));
    return Response.json({ ok: true, rescanned: due.map((site, index) => ({ siteId: site.siteId, ok: results[index].status === "fulfilled" })) });
  } catch (error) { return apiFailure(error); }
}
