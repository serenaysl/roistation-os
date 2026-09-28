import { requireAdmin } from "@/lib/admin";
import { apiFailure,retryStorageBusy } from "@/lib/database";
import { listPublications } from "@/lib/storage";
import { createPublication,operatePublication } from "@/lib/publication-service";
export const maxDuration = 60;
export async function GET(request:Request) {try {await requireAdmin(request);const params=new URL(request.url).searchParams;const page=Math.min(10000,Math.max(0,Number(params.get("page")) || 0));const kind=params.get("kind");const publications=await listPublications(kind==="form" || kind==="content" ? kind : undefined,Math.floor(page));return Response.json({publications},{headers:{"Cache-Control":"no-store"}});} catch(error) {return apiFailure(error);}}
export async function POST(request:Request) {try {await requireAdmin(request);const body=await request.json();return Response.json({publication:await retryStorageBusy(()=>createPublication(body),8)},{status:201});} catch(error) {return apiFailure(error);}}
export async function PATCH(request:Request) {try {await requireAdmin(request);const body=await request.json();return Response.json(await retryStorageBusy(()=>operatePublication(body.id,body),8));} catch(error) {return apiFailure(error);}}
