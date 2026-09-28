import { requireAdmin } from "@/lib/admin";
import { ApiError, apiFailure } from "@/lib/database";
import { optimizeSite } from "@/lib/seo/optimize";

export const maxDuration = 60;
export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { siteId?: unknown; checkIds?: unknown };
    if (typeof body.siteId !== "string" || !/^[a-z0-9-]{2,60}$/.test(body.siteId)) throw new ApiError("Site kimliği geçersiz.");
    const checkIds = Array.isArray(body.checkIds) ? body.checkIds.filter((id): id is string => typeof id === "string" && /^[a-z0-9-]{2,40}$/.test(id)).slice(0, 40) : undefined;
    if (Array.isArray(body.checkIds) && !checkIds?.length) throw new ApiError("Düzeltilecek bulgu seçilmedi.");
    return Response.json(await optimizeSite(body.siteId, { checkIds }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
