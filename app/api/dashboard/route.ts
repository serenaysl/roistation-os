import { requireAdmin } from "@/lib/admin";
import { apiFailure } from "@/lib/database";
import { listAllPublications } from "@/lib/storage";
import { listConnections } from "@/lib/connection-storage";
import { effectiveStatus } from "@/lib/publications";
export async function GET(request:Request) {
  try {
    await requireAdmin(request);const [rows,connections]=await Promise.all([listAllPublications(),listConnections()]);
    const targets=rows.flatMap(row=>Object.values(row.document.targets));
    return Response.json({connected:connections.filter(c=>c.verified).length,published:targets.filter(t=>effectiveStatus(t)==="published").length,scheduled:targets.filter(t=>effectiveStatus(t)==="scheduled").length,failed:targets.filter(t=>t.status==="failed").length,events:rows.flatMap(row=>row.document.events.slice(-3).map(event=>({...event,title:row.document.title}))).sort((a,b)=>b.at.localeCompare(a.at)).slice(0,8)},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return apiFailure(error);}
}
