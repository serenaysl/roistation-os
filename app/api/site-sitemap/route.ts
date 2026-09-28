import { ensureSiteRegistry } from "@/lib/site-registry";
import { apiFailure } from "@/lib/database";
import { validateSiteIds } from "@/lib/publication-service";
import { listSitePages,sitemapXml } from "@/lib/publishing/page-model";

// XML sitemap of a site's published SEO/blog pages. Non-Next.js sites can reference it from robots.txt:
//   Sitemap: https://<master>/api/site-sitemap?siteId=<site-id>
export async function GET(request:Request) {
  try {
    await ensureSiteRegistry();const siteId=new URL(request.url).searchParams.get("siteId") || "";validateSiteIds([siteId]);
    return new Response(sitemapXml(await listSitePages(siteId)),{headers:{"content-type":"application/xml; charset=utf-8","Cache-Control":"no-store"}});
  } catch(error) {return apiFailure(error);}
}
