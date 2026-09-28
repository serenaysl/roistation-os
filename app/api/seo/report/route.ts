import { requireAdmin } from "@/lib/admin";
import { ApiError, apiFailure } from "@/lib/database";
import { ignoredChecks, latestOptimizations, scanHistory, summarizeScan } from "@/lib/seo/store";

export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const siteId = new URL(request.url).searchParams.get("siteId") || "";
    if (!/^[a-z0-9-]{2,60}$/.test(siteId)) throw new ApiError("Site kimliği geçersiz.");
    const [history, ignored, optimizations] = await Promise.all([scanHistory(siteId, 12), ignoredChecks(siteId), latestOptimizations().catch(() => [])]);
    if (!history.length) throw new ApiError("Bu site için henüz analiz yok.", 404);
    return Response.json({
      latest: history[0],
      history: history.map(summarizeScan),
      // Per-scan finding states power "Resolved" and the history timeline.
      checkHistory: history.map((scan) => ({ id: scan.id, open: scan.checks.filter((check) => check.status === "fail" || check.status === "warn").map((check) => check.id) })),
      ignored,
      optimization: optimizations.find((entry) => entry.siteId === siteId)?.record ?? null,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
