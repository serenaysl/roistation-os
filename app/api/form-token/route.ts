import { formToken } from "@/lib/form-token";
import { ensureSiteRegistry } from "@/lib/site-registry";
import { ApiError,apiFailure } from "@/lib/database";
import { getPublication,validateSiteIds } from "@/lib/publication-service";
import { effectiveStatus } from "@/lib/publications";
export async function GET(request:Request) {
  try {
    await ensureSiteRegistry();
    if(!process.env.PANEL_SESSION_SECRET) throw new ApiError("Form güvenliği yapılandırılmadı.",503);
    const params=new URL(request.url).searchParams;const id=params.get("id") || "";const siteId=params.get("siteId") || "";validateSiteIds([siteId]);
    const row=await getPublication(id);if(row.document.kind!=="form" || !row.document.targets[siteId] || effectiveStatus(row.document.targets[siteId])!=="published") throw new ApiError("Bu form yayında değil.",404);
    const expires=String(Date.now()+3600000);return Response.json({token:`${expires}.${formToken(id,siteId,expires)}`},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return apiFailure(error);}
}
