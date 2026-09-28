import { requireAdmin } from "@/lib/admin";
import { ApiError, apiFailure } from "@/lib/database";
import { runScan } from "@/lib/seo/dashboard";
import { summarizeScan } from "@/lib/seo/store";

// One site per request (the panel analyses selected sites one by one). PageSpeed Insights can take ~30 s.
export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { siteId?: unknown; reason?: unknown };
    if (typeof body.siteId !== "string" || !/^[a-z0-9-]{2,60}$/.test(body.siteId)) throw new ApiError("Site kimliği geçersiz.");
    const scan = await runScan(body.siteId, typeof body.reason === "string" ? body.reason.slice(0, 40) : "manual");
    return Response.json({ scan: summarizeScan(scan), siteId: scan.siteId }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
