import { ensureSiteRegistry } from "@/lib/site-registry";
import { ApiError,apiFailure } from "@/lib/database";
import { validateSiteIds } from "@/lib/publication-service";
import { getSitePage } from "@/lib/publishing/page-model";
import { isValidSlug,publishLocations,type PublishLocation } from "@/lib/publishing/definitions";

// Public, render-ready page model: content blocks, metadata, canonical, Open Graph, Twitter, JSON-LD, breadcrumbs, related links.
export async function GET(request:Request) {
  try {
    await ensureSiteRegistry();const params=new URL(request.url).searchParams;const siteId=params.get("siteId") || "";validateSiteIds([siteId]);
    const slug=params.get("slug") || "";if(!isValidSlug(slug)) throw new ApiError("Sayfa adresi geçersiz.",404);
    const location=params.get("location");
    if(location && !(location in publishLocations && publishLocations[location as PublishLocation].kind==="page")) throw new ApiError("Sayfa konumu geçersiz.");
    const page=await getSitePage(siteId,slug,(location || undefined) as PublishLocation|undefined);
    if(!page) throw new ApiError("Sayfa bulunamadı veya yayında değil.",404);
    return Response.json({page},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return apiFailure(error);}
}
