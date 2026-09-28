import { requireAdmin } from "@/lib/admin";
import { apiFailure } from "@/lib/database";
import { listConnections } from "@/lib/connection-storage";
import { verifyConnection,widgetSnippet } from "@/lib/connections";
import { sites } from "@/lib/sites";
import { ensureSiteRegistry } from "@/lib/site-registry";
import { listProjectRecords } from "@/lib/vercel/projects";

export const maxDuration = 30;

export async function GET(request:Request) {
  try {
    await requireAdmin(request);await ensureSiteRegistry();
    const [saved,projects]=await Promise.all([listConnections(),listProjectRecords().catch(()=>[])]);
    return Response.json({connections:sites.map(site=>{
      const connection=saved.find(c=>c.site_id===site.id) || null;
      const project=projects.find(p=>p.siteId===site.id) || projects.find(p=>p.name===site.project) || null;
      return {siteId:site.id,siteName:site.name,project:site.project,domain:site.domain,siteUrl:connection?.site_url || project?.productionUrl || `https://${site.domain}`,connection,snippet:widgetSnippet(site.id),
        vercel:project ? {projectId:project.projectId,liveStatus:project.liveStatus,statusDetail:project.statusDetail,framework:project.framework,productionUrl:project.productionUrl,lastDeployAt:project.lastDeployAt,lastSyncAt:project.lastSyncAt,deploymentState:project.latestProduction?.state ?? null} : null};
    })},{headers:{"Cache-Control":"no-store"}});
  } catch(error) {return apiFailure(error);}
}
export async function POST(request:Request) {try {await requireAdmin(request);await ensureSiteRegistry();const body=await request.json();return Response.json({connection:await verifyConnection(body.siteId,typeof body.siteUrl==="string" ? body.siteUrl : "")});} catch(error) {return apiFailure(error);}}
