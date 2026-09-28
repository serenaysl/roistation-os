import { apiFailure } from "@/lib/database";
import { publicContent } from "@/lib/publication-service";
// ?siteId=…&location=homepage|service-page|footer&path=/hizmetler/…  (location defaults to homepage)
export async function GET(request:Request) {try {const params=new URL(request.url).searchParams;return Response.json({items:await publicContent(params.get("siteId") || "",{location:params.get("location"),path:params.get("path")})},{headers:{"Cache-Control":"no-store"}});} catch(error) {return apiFailure(error);}}
