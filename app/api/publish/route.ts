import { requireAdmin } from "@/lib/admin";
import { ApiError,apiFailure,retryStorageBusy } from "@/lib/database";
import { createPublishedPublication } from "@/lib/publication-service";
import { getGeneration } from "@/lib/generation-storage";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    await requireAdmin(request); const body=await request.json();
    // The stored generation is authoritative; the client-reported mode is only a fast path.
    const generation=typeof body.generationId==="string" && /^[0-9a-f-]{36}$/i.test(body.generationId) ? await getGeneration(body.generationId).catch(()=>null) : null;
    if(body.mode==="demo" || generation?.mode==="demo") throw new ApiError("Demo AI çıktısı canlıya yayınlanamaz. Claude anahtarını ekle veya İçerik ekranından gerçek taslak oluştur.");
    if(!Array.isArray(body.payload)) throw new ApiError("Siteye özel taslaklar bulunamadı.");
    const variants:Record<string,unknown>={};
    for(const result of body.payload) {if(!result || typeof result.siteId!=="string") throw new ApiError("Taslak geçersiz.");variants[result.siteId]={title:result.title,summary:result.summary,body:result.body,metaTitle:result.metaTitle,metaDescription:result.metaDescription};}
    if(typeof body.publicationId!=="string" || !/^[0-9a-f-]{36}$/i.test(body.publicationId)) throw new ApiError("Yayın işlem kimliği geçersiz. Sayfayı yenileyip tekrar dene.");
    return Response.json(await retryStorageBusy(()=>createPublishedPublication({id:body.publicationId,title:body.title || "AI içerik yayını",siteIds:body.siteIds,variants,scheduleAt:body.scheduleAt,placement:body.placement,scope:body.scope,slugs:body.slugs}),8));
  } catch(error) {return apiFailure(error);}
}
