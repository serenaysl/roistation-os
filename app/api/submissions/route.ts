import { randomUUID } from "node:crypto";
import { requestFingerprint,requireAdmin,safeEqual,requireSameOrigin } from "@/lib/admin";
import { ApiError,apiFailure,rateLimit,retryStorageBusy } from "@/lib/database";
import { listSubmissions,deleteSubmission,acceptSubmission } from "@/lib/storage";
import { getPublication,validateSiteIds } from "@/lib/publication-service";
import { effectiveStatus } from "@/lib/publications";
import { formToken } from "@/lib/form-token";
import { ensureSiteRegistry } from "@/lib/site-registry";
export async function GET(request:Request) {try {await requireAdmin(request);await ensureSiteRegistry();const params=new URL(request.url).searchParams;const page=Math.min(10000,Math.max(0,Number(params.get("page")) || 0));const siteId=params.get("siteId") || undefined;if(siteId) validateSiteIds([siteId]);return Response.json({submissions:await listSubmissions(Math.floor(page),siteId)},{headers:{"Cache-Control":"no-store"}});} catch(error) {return apiFailure(error);}}
export async function DELETE(request:Request) {try {await requireAdmin(request);const {id}=await request.json();if(typeof id!=="string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError("Talep kimliği geçersiz.");await retryStorageBusy(()=>deleteSubmission(id),8);return Response.json({ok:true});} catch(error) {return apiFailure(error);}}
export async function POST(request:Request) {
  try {
    requireSameOrigin(request);
    await ensureSiteRegistry();
    await rateLimit(`form:${requestFingerprint(request)}`,10,3600);
    const input=await request.json();if(input.website) throw new ApiError("Form gönderimi reddedildi.");
    validateSiteIds([input.siteId]);const [expires,signed]=String(input.token || "").split(".");
    if(!process.env.PANEL_SESSION_SECRET || !signed || !Number.isFinite(Number(expires)) || Number(expires)<Date.now() || Number(expires)>Date.now()+3600000 || !safeEqual(formToken(input.publicationId,input.siteId,expires),signed)) throw new ApiError("Form oturumu sona erdi. Sayfayı yenile.",403);
    const row=await getPublication(input.publicationId);const target=row.document.targets[input.siteId];
    if(row.document.kind!=="form" || !target || effectiveStatus(target)!=="published" || !target.payload) throw new ApiError("Form yayından kaldırıldı.",410);
    if(input.consent!==true) throw new ApiError("Aydınlatma/onay kutusunu işaretle.");
    const answers:Record<string,string>={};
    for(const field of target.payload.fields || []) {const value=input.answers?.[field.id];if(value!==undefined && typeof value!=="string") throw new ApiError("Alan değeri geçersiz.");const answer=(value || "").trim();if(answer.length>4000 || (field.required && !answer)) throw new ApiError(`${field.label} alanını kontrol et.`);if(answer && field.type==="email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(answer)) throw new ApiError("E-posta adresini kontrol et.");answers[field.id]=answer;}
    const id=typeof input.id==="string" && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id : randomUUID();
    const accepted=await retryStorageBusy(()=>acceptSubmission({id,publicationId:row.id,siteId:input.siteId,answers,version:row.version}),8);
    if(!accepted) throw new ApiError("Form yayından kaldırıldı; gönderim kaydedilmedi.",410);
    return Response.json({ok:true},{status:201});
  } catch(error) {return apiFailure(error);}
}
