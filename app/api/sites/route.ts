import { requireAdmin } from "@/lib/admin";
import { apiFailure } from "@/lib/database";
import { ensureSiteRegistry, listSiteRecords } from "@/lib/site-registry";
import { storageConfigured } from "@/lib/blob-store";

// Live site list for the panel: built-in profiles + projects imported from Vercel (archived ones listed separately).
export async function GET(request: Request) {
  try {
    await requireAdmin(request);
    const live = await ensureSiteRegistry(true);
    const archived = storageConfigured() ? (await listSiteRecords().catch(() => [])).filter((record) => record.archived) : [];
    return Response.json({ sites: live, archived }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
