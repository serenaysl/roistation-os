import { ensureSiteRegistry } from "@/lib/site-registry";
import { ApiError,apiFailure } from "@/lib/database";
import { validateSiteIds } from "@/lib/publication-service";
import { listSitePages } from "@/lib/publishing/page-model";
import { publishLocations,type PublishLocation } from "@/lib/publishing/definitions";

// Public list of a site's published pages (SEO pages, blog posts) for sitemaps, archives and related links.
export async function GET(request:Request) {
  try {
    await ensureSiteRegistry();const params=new URL(request.url).searchParams;const siteId=params.get("siteId") || "";validateSiteIds([siteId]);
    const location=params.get("location");
    if(location && !(location in publishLocations && publishLocations[location as PublishLocation].kind==="page")) throw new ApiError("Sayfa konumu geçersiz.");
    return Response.json({pages:await listSitePages(siteId,(location || undefined) as PublishLocation|undefined)},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return apiFailure(error);}
}
