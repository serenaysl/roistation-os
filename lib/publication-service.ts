import { randomUUID } from "node:crypto";
import { ApiError } from "@/lib/database";
import { readPublication,listAllPublications,insertPublication,replacePublication,removePublication,isRemovedPublication,purgeRemovedPublication } from "@/lib/storage";
import { listConnectionsFor } from "@/lib/connection-storage";
import { sites } from "@/lib/sites";
import { effectiveStatus,type Payload,type Publication,type PublicationRow,type Target } from "@/lib/publications";
import { defaultPlacement,isPublishLocation,isPublishScope,isPublishStrategy,isValidSlug,normalizeServicePath,pagePathPrefix,primaryLocation,publishLocations,publishStrategies,resolvePlacement,type Placement,type PublishScope } from "@/lib/publishing/definitions";
import { revalidateSites } from "@/lib/publishing/revalidate";
import { ensureSiteRegistry } from "@/lib/site-registry";
import { preflightSites } from "@/lib/verification";
import { eventKeyForSite,logEvents,type ProjectEventType } from "@/lib/vercel/events";
import { defaultChannel,type ChannelAction } from "@/lib/publishing/channels";
import { indexSite,isSlotLocation,siteOrigin,slotItems,takenSlugs,uniqueSlug } from "@/lib/publishing/page-model";
export function validateSiteIds(input:unknown):string[] {
  if(!Array.isArray(input) || !input.length || input.length>sites.length || input.some(id=>typeof id!=="string" || !sites.some(site=>site.id===id))) throw new ApiError("En az bir kapsam içi site seç.");return [...new Set(input)] as string[];
}
function text(value:unknown,name:string,max:number,required=true) {if(typeof value!=="string" || value.length>max || (required && !value.trim())) throw new ApiError(`${name} geçersiz veya çok uzun.`);return value.trim();}
export function validatePayload(input:unknown,kind:"content"|"form"):Payload {
  if(!input || typeof input!=="object") throw new ApiError("İçerik bulunamadı.");const p=input as Record<string,unknown>;
  const payload:Payload={title:text(p.title,"Başlık",200),body:text(p.body ?? "","İçerik",40000,kind==="content")};
  if(p.summary!==undefined) payload.summary=text(p.summary,"Özet",1000,false);if(p.metaTitle!==undefined) payload.metaTitle=text(p.metaTitle,"Meta başlık",200,false);if(p.metaDescription!==undefined) payload.metaDescription=text(p.metaDescription,"Meta açıklama",500,false);
  if(kind==="form") {
    if(!Array.isArray(p.fields) || !p.fields.length || p.fields.length>20) throw new ApiError("Formda 1–20 alan olmalı.");const ids=new Set<string>();
    payload.fields=p.fields.map((field:unknown)=>{if(!field || typeof field!=="object") throw new ApiError("Form alanı geçersiz.");const f=field as Record<string,unknown>;const id=text(f.id,"Alan kimliği",60);
      if(!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(id) || ["__proto__","constructor","prototype","roi_consent","roi_website"].includes(id) || ids.has(id) || !["text","email","tel","textarea"].includes(String(f.type)) || typeof f.required!=="boolean") throw new ApiError("Form alanı kimliği veya türü geçersiz.");ids.add(id);return {id,label:text(f.label,"Alan etiketi",120),type:f.type as "text"|"email"|"tel"|"textarea",required:f.required};});
    payload.consentText=text(p.consentText,"Aydınlatma/onay metni",2000);
  }return payload;
}
async function loadPublication(id:string) {if(typeof id!=="string" || !/^[0-9a-f-]{36}$/i.test(id)) throw new ApiError("Yayın kimliği geçersiz.");const stored=await readPublication(id);if(!stored) throw new ApiError("Yayın bulunamadı.",404);if(isRemovedPublication(stored.value)) {await purgeRemovedPublication(id);throw new ApiError("Yayın silinmiş.",404);}return stored;}
export async function getPublication(id:string) {return (await loadPublication(id)).value;}

function parseSchedule(value:unknown):string|null {
  if(!value) return null;
  if(typeof value!=="string" || !Number.isFinite(Date.parse(value)) || Date.parse(value)<=Date.now()) throw new ApiError("Gelecekteki bir yayın tarihi seç.");
  return new Date(value).toISOString();
}

/** Publish location + AI publish strategy. Missing input keeps the default (SEO page, SEO only). */
export function validatePlacement(input:unknown):Placement {
  if(input===undefined || input===null) return {...defaultPlacement};
  if(typeof input!=="object") throw new ApiError("Yayın yeri geçersiz.");
  const p=input as Record<string,unknown>;
  if(!isPublishLocation(p.location)) throw new ApiError("Yayın yeri geçersiz.");
  if(!isPublishStrategy(p.strategy)) throw new ApiError("AI yayın stratejisi geçersiz.");
  if(p.location!=="service-page") return {location:p.location,strategy:p.strategy};
  if(p.servicePath===undefined || p.servicePath===null || p.servicePath==="") return {location:p.location,strategy:p.strategy};
  const servicePath=normalizeServicePath(p.servicePath);
  if(!servicePath) throw new ApiError("Hizmet sayfası yolu geçersiz. Örnek: /hizmetler/dis-cephe");
  return {location:p.location,strategy:p.strategy,servicePath};
}
function validateScope(value:unknown):PublishScope|undefined {
  if(value===undefined || value===null || value==="") return undefined;
  if(!isPublishScope(value)) throw new ApiError("Yayın hedefi geçersiz.");
  return value;
}
const placementLabel=(placement:Placement)=>`${publishLocations[placement.location].label} · ${publishStrategies[placement.strategy].label}${placement.servicePath ? ` · ${placement.servicePath}` : ""}`;
const samePlacement=(a:Placement,b:Placement)=>a.location===b.location && a.strategy===b.strategy && (a.servicePath || null)===(b.servicePath || null);

/**
 * Gives every content target a unique, SEO friendly slug on its site.
 * Requested slugs (edited in the panel) are validated; otherwise the slug is
 * derived from the site-specific title with Turkish transliteration.
 */
async function assignSlugs(id:string,targets:Record<string,Target>,siteIds:string[],requested?:unknown) {
  const wanted=requested && typeof requested==="object" ? requested as Record<string,unknown> : {};
  const taken=await takenSlugs(siteIds,id);
  for(const siteId of siteIds) {
    const target=targets[siteId];if(!target?.payload) continue;
    const request=wanted[siteId];
    if(typeof request==="string" && request.trim()) {
      const slug=request.trim().toLowerCase();
      if(!isValidSlug(slug)) throw new ApiError("URL kısa adı yalnız küçük harf, rakam ve tire içerebilir (ör. foca-balik-restorani).");
      if(taken[siteId].has(slug)) throw new ApiError(`"${slug}" adresi ${sites.find(site=>site.id===siteId)?.name || siteId} sitesinde başka bir yayında kullanılıyor.`,409);
      target.slug=slug;
    } else if(!isValidSlug(target.slug)) target.slug=uniqueSlug(target.payload.title,taken[siteId],id.slice(0,8));
    taken[siteId].add(target.slug!);
  }
}

/** Persists the URL a legacy (slug-less) target is already served under, so it never changes on republish. */
async function freezeLegacySlugs(row:PublicationRow,document:Publication,siteIds:string[]) {
  if(document.kind!=="content" || siteIds.every(siteId=>isValidSlug(document.targets[siteId]?.slug))) return;
  const rows=await listAllPublications("content");
  const current=rows.some(item=>item.id===row.id) ? rows : [...rows,row];
  for(const siteId of siteIds) {
    const target=document.targets[siteId];if(!target?.payload || isValidSlug(target.slug)) continue;
    const entry=indexSite(current,siteId).find(item=>item.row.id===row.id);
    if(entry) target.slug=entry.slug;
  }
}

export async function createPublication(input:Record<string,unknown>) {
  await ensureSiteRegistry();
  const ids=validateSiteIds(input.siteIds);const kind=input.kind==="form" ? "form" : "content";const title=text(input.title,"Yayın başlığı",200);
  const id=typeof input.id==="string" && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id : randomUUID();const targets:Record<string,Target>={};
  for(const siteId of ids) {const variants=input.variants as Record<string,unknown>|undefined;targets[siteId]={status:"draft",payload:validatePayload(variants?.[siteId] || input.payload,kind)};}
  const placement=kind==="content" ? validatePlacement(input.placement) : undefined;
  if(placement) await assignSlugs(id,targets,ids,input.slugs);
  const now=new Date().toISOString();const document:Publication={id,title,kind,createdAt:now,updatedAt:now,targets,events:[{at:now,action:"created",siteIds:ids,...(placement ? {detail:placementLabel(placement)} : {})}],...(placement ? {placement} : {})};
  return insertPublication({id,version:1,document});
}
export async function createPublishedPublication(input:Record<string,unknown>) {
  await ensureSiteRegistry();
  const ids=validateSiteIds(input.siteIds);const title=text(input.title,"Yayın başlığı",200);
  const id=typeof input.id==="string" && /^[0-9a-f-]{36}$/i.test(input.id) ? input.id : randomUUID();
  const scheduledAt=parseSchedule(input.scheduleAt);const scope=validateScope(input.scope);const placement=validatePlacement(input.placement);
  if(scope==="current" && ids.length!==1) throw new ApiError("\"Yalnız bu site\" hedefi için tek site seç.");
  const variants=input.variants as Record<string,unknown>|undefined;const targets:Record<string,Target>={};
  for(const siteId of ids) targets[siteId]={status:"draft",payload:validatePayload(variants?.[siteId] || input.payload,"content")};
  // Publish safety: project exists, deployment ready, domain reachable, connector available (fresh checks are reused).
  await Promise.all([preflightSites(ids),assignSlugs(id,targets,ids,input.slugs)]);
  const connections=await listConnectionsFor(ids);
  // Each site is evaluated independently: one failing site never stops the others.
  const outcomes=ids.map(siteId=>defaultChannel.evaluate({siteId,action:"publish",scheduledAt,scope,connection:connections.find(c=>c.site_id===siteId)}));
  const now=new Date().toISOString();
  for(const outcome of outcomes) {const target=targets[outcome.siteId];target.status=outcome.status;target.detail=outcome.detail;if(outcome.success) target.scheduledAt=scheduledAt;}
  const live=outcomes.filter(outcome=>outcome.success).map(outcome=>outcome.siteId);
  const skipped=outcomes.filter(outcome=>outcome.skipped).length;
  const events:Publication["events"]=[{at:now,action:"created",siteIds:ids,detail:placementLabel(placement)},{at:now,action:scheduledAt ? "scheduled" : "published",siteIds:live.length ? live : ids,detail:scheduledAt ? `Planlanan zaman: ${scheduledAt}` : skipped ? `${skipped} doğrulanmamış site atlandı` : undefined}];
  const document:Publication={id,title,kind:"content",createdAt:now,updatedAt:now,targets,events,placement};
  const publication=await insertPublication({id,version:1,document});
  await logPublicationEvents(outcomes.filter(outcome=>outcome.success).map(outcome=>outcome.siteId),"publication-sent",title);
  return {publication,results:outcomes};
}

/** Changes publish location / strategy / slugs of a stored publication (history: "edited"). */
async function editPublication(id:string,input:Record<string,unknown>) {
  const {value:row,etag}=await loadPublication(id);if(input.version!==row.version) throw new ApiError("Yayın başka bir işlemle değişti. Listeyi yenile.",409);
  if(row.document.kind!=="content") throw new ApiError("Formların yayın yeri ayarı yoktur.");
  const placement=validatePlacement(input.placement);
  const document=structuredClone(row.document);const siteIds=Object.keys(document.targets).filter(siteId=>document.targets[siteId].status!=="deleted");
  await freezeLegacySlugs(row,document,siteIds);
  const before=resolvePlacement(row.document.placement);
  const beforeSlugs=JSON.stringify(siteIds.map(siteId=>document.targets[siteId].slug));
  await assignSlugs(id,document.targets,siteIds,input.slugs);
  const slugsChanged=beforeSlugs!==JSON.stringify(siteIds.map(siteId=>document.targets[siteId].slug)) || !row.document.placement;
  if(samePlacement(before,placement) && !slugsChanged && row.document.placement) return {publication:row,results:[]};
  document.placement=placement;document.updatedAt=new Date().toISOString();
  document.events=[...document.events,{at:document.updatedAt,action:"edited",siteIds,detail:placementLabel(placement)}].slice(-200);
  const updated=await replacePublication({id,document,version:row.version+1},row.version,etag);
  return {publication:updated,results:[]};
}

export async function operatePublication(id:string,input:Record<string,unknown>) {
  await ensureSiteRegistry();
  if(input.action==="edit") return editPublication(id,input);
  const {value:row,etag}=await loadPublication(id);if(input.version!==row.version) throw new ApiError("Yayın başka bir işlemle değişti. Listeyi yenile.",409);
  const scope=validateScope(input.scope);
  const liveIds=Object.keys(row.document.targets).filter(siteId=>row.document.targets[siteId].status!=="deleted");
  const ids=input.all===true || scope==="all-connected" ? liveIds : validateSiteIds(input.siteIds);
  if(!ids.length || ids.some(siteId=>!row.document.targets[siteId] || row.document.targets[siteId].status==="deleted")) throw new ApiError("Hedef site yok veya içerik bu siteden kalıcı olarak silinmiş.");
  if(scope==="current" && ids.length!==1) throw new ApiError("\"Yalnız bu site\" hedefi için tek site seç.");
  const action=input.action;if(!["publish","withdraw","delete"].includes(String(action))) throw new ApiError("İşlem geçersiz.");
  const scheduledAt=action==="publish" ? parseSchedule(input.scheduleAt) : null;
  if(action==="publish") await preflightSites(ids);
  const connections=action==="publish" ? await listConnectionsFor(ids) : [];
  const outcomes=ids.map(siteId=>{const current=row.document.targets[siteId];return defaultChannel.evaluate({siteId,action:action as ChannelAction,scheduledAt,scope,current,effectiveStatus:effectiveStatus(current),connection:connections.find(c=>c.site_id===siteId)});});
  const document=structuredClone(row.document);document.updatedAt=new Date().toISOString();
  const newEvents:Publication["events"]=[];
  if(action==="publish" && document.kind==="content" && input.placement!==undefined && input.placement!==null) {
    const placement=validatePlacement(input.placement);
    if(!document.placement || !samePlacement(resolvePlacement(document.placement),placement)) {document.placement=placement;newEvents.push({at:document.updatedAt,action:"edited",siteIds:ids,detail:placementLabel(placement)});}
  }
  if(action==="publish") await freezeLegacySlugs(row,document,ids);
  const wasLive=ids.some(siteId=>["published","withdrawn"].includes(effectiveStatus(row.document.targets[siteId])));
  for(const outcome of outcomes) {const target=document.targets[outcome.siteId];target.status=outcome.status;target.detail=outcome.detail;if(action==="delete") target.payload=null;if(action!=="publish" || outcome.success) target.scheduledAt=scheduledAt;}
  const affectedPaths=action==="publish" ? [] : await publicPathsOf(row,ids);
  const processed=outcomes.filter(outcome=>!outcome.skipped).map(outcome=>outcome.siteId);
  const skipped=outcomes.length-processed.length;
  const historyAction=action==="publish" ? (scheduledAt ? "scheduled" : wasLive ? "republished" : "published") : action==="withdraw" ? "withdrawn" : "deleted";
  newEvents.push({at:document.updatedAt,action:historyAction,siteIds:processed.length ? processed : ids,...(scheduledAt ? {detail:`Planlanan zaman: ${scheduledAt}`} : skipped ? {detail:`${skipped} doğrulanmamış site atlandı`} : {})});
  document.events=[...document.events,...newEvents].slice(-200);
  if(action==="publish") {
    const updated=await replacePublication({id,document,version:row.version+1},row.version,etag);
    await logPublicationEvents(outcomes.filter(outcome=>outcome.success).map(outcome=>outcome.siteId),row.document.kind==="form" ? "form-synchronized" : "publication-sent",row.document.title);
    return {publication:updated,results:outcomes};
  }
  // Withdraw / delete: when no live target remains after a delete, the publication is removed from storage entirely.
  const removed=action==="delete" && isRemovedPublication({id,version:row.version+1,document});
  const updated=removed
    ? await removePublication({id,document,version:row.version+1},etag)
    : await replacePublication({id,document,version:row.version+1},row.version,etag);
  // Sites drop their cached pages/sections immediately instead of waiting for ISR.
  const revalidation=await revalidateSites(affectedPaths);
  await logPublicationEvents(processed,action==="delete" ? "publication-deleted" : "publication-withdrawn",row.document.title);
  return {publication:updated,results:outcomes,removed,revalidation};
}

/** Public URLs on each site that showed this publication before the change (pages, archives, service page). */
async function publicPathsOf(row:PublicationRow,siteIds:string[]) {
  if(row.document.kind!=="content") return siteIds.map(siteId=>({siteId,paths:[] as string[]}));
  const placement=resolvePlacement(row.document.placement);const primary=primaryLocation(placement);const prefix=pagePathPrefix(primary);
  const needsIndex=Boolean(prefix) && siteIds.some(siteId=>!isValidSlug(row.document.targets[siteId]?.slug));
  const rows=needsIndex ? await listAllPublications("content").catch(()=>[] as PublicationRow[]) : [];
  return siteIds.map(siteId=>{
    const paths:string[]=[];
    if(prefix) {
      paths.push(prefix);
      const slug=isValidSlug(row.document.targets[siteId]?.slug) ? row.document.targets[siteId].slug : indexSite(rows.some(item=>item.id===row.id) ? rows : [...rows,row],siteId).find(entry=>entry.row.id===row.id)?.slug;
      if(slug) paths.push(`${prefix}/${slug}`);
    }
    if(placement.servicePath) paths.push(placement.servicePath);
    return {siteId,paths};
  });
}

/**
 * Public feed for in-page slots. Without a location it returns the homepage
 * slot (widget and SSR helper defaults). Content whose primary location is a
 * page (SEO page / blog) is NOT injected into the homepage; homepage-enhancement
 * strategies add a compact teaser instead.
 */
export async function publicContent(siteId:string,options:{location?:unknown;path?:unknown}={}) {
  await ensureSiteRegistry();
  validateSiteIds([siteId]);
  const location=options.location===undefined || options.location===null || options.location==="" ? "homepage" : options.location;
  if(!isSlotLocation(location)) throw new ApiError("Yayın alanı konumu geçersiz.");
  const path=location==="service-page" ? normalizeServicePath(options.path) : null;
  const [rows,origin]=await Promise.all([listAllPublications(),siteOrigin(siteId)]);
  return slotItems(rows,siteId,location,origin,path);
}

/** Per-project activity log entries for publication operations (best effort, never blocks the operation). */
async function logPublicationEvents(siteIds:string[],type:ProjectEventType,title:string) {
  const verbs:Partial<Record<ProjectEventType,string>>={"publication-sent":"yayına gönderildi","form-synchronized":"form senkronize edildi","publication-withdrawn":"yayından kaldırıldı","publication-deleted":"silindi"};
  await logEvents(siteIds.map(siteId=>{const site=sites.find(item=>item.id===siteId);return {key:eventKeyForSite(siteId,site?.vercelProjectId),siteId,projectId:site?.vercelProjectId,type,message:`"${title.slice(0,120)}" ${verbs[type] || type}.`};}));
}
