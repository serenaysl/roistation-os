import { requireAdmin } from "@/lib/admin";
import { listAllSubmissions } from "@/lib/storage";
import { apiFailure } from "@/lib/errors";
export async function GET(request:Request) {
  try {await requireAdmin(request);const submissions=await listAllSubmissions();return Response.json({exportedAt:new Date().toISOString(),submissions},{headers:{"Cache-Control":"no-store","Content-Disposition":"attachment; filename=roistation-form-talepleri.json"}});} catch(error) {return apiFailure(error);}
}
