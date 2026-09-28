import { requireAdmin } from "@/lib/admin";
import { apiFailure } from "@/lib/database";
import { seoDashboard } from "@/lib/seo/dashboard";

export const maxDuration = 30;
export async function GET(request: Request) {
  try { await requireAdmin(request); return Response.json(await seoDashboard(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiFailure(error); }
}
