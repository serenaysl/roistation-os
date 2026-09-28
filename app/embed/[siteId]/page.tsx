import { SiteWidget } from "@/components/site-widget";
import { publicContent } from "@/lib/publication-service";
export const dynamic="force-dynamic";
export const metadata={robots:{index:false,follow:false}};
type SearchParams=Promise<Record<string,string|string[]|undefined>>;
const one=(value:string|string[]|undefined)=>Array.isArray(value) ? value[0] : value;
export default async function Embed({params,searchParams}:{params:Promise<{siteId:string}>;searchParams:SearchParams}) {
  const {siteId}=await params;const query=await searchParams;const location=one(query.location) || "";const path=one(query.path) || "";
  try {return <SiteWidget siteId={siteId} location={location} path={path} initialItems={await publicContent(siteId,{location,path})}/>;}
  catch {return <SiteWidget siteId={siteId} location={location} path={path} initialItems={[]} initialError="Yayın alanı şu anda kullanılamıyor."/>;}
}
