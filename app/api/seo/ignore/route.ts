import { requireAdmin } from "@/lib/admin";
import { ApiError, apiFailure } from "@/lib/database";
import { setIgnored } from "@/lib/seo/store";
import { checkDefinitions } from "@/lib/seo/checks";
import { ensureSiteRegistry } from "@/lib/site-registry";

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { siteId?: unknown; checkId?: unknown; ignored?: unknown };
    const siteId = body.siteId;
    if (typeof siteId !== "string" || !/^[a-z0-9-]{2,60}$/.test(siteId) || !(await ensureSiteRegistry()).some((site) => site.id === siteId)) throw new ApiError("Site kimliği geçersiz.");
    if (typeof body.checkId !== "string" || !checkDefinitions[body.checkId]) throw new ApiError("Bulgu geçersiz.");
    return Response.json({ ignored: await setIgnored(siteId, body.checkId, body.ignored !== false) });
  } catch (error) { return apiFailure(error); }
}
