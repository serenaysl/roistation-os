import { ApiError } from "@/lib/errors";
import { blobPaths, createJson, deleteJson, readAllJson, readJson, replaceJson, requireStorage, listBlobs, type Stored } from "@/lib/blob-store";
import { ensureMigrated } from "@/lib/migration";
import { parsePublicationRow, parseSubmission } from "@/lib/records";
import { effectiveStatus, type PublicationRow, type Submission } from "@/lib/publications";

/*
 * Per-record private Blob storage. There is no shared snapshot:
 *   roistation-master/publications/<publication-id>.json
 *   roistation-master/submissions/<submission-id>.json
 *   roistation-master/generations/<generation-id>.json   (lib/generation-storage.ts)
 *   roistation-master/connections/<site-id>.json          (lib/connection-storage.ts)
 *   roistation-master/rate-limit/<sha256>.json            (lib/rate-limit-storage.ts)
 * Each write modifies exactly one object; conflicts are detected per object.
 */

export { storageConfigured } from "@/lib/blob-store";
export type { GenerationRecord } from "@/lib/records";
export { getGeneration, beginGeneration, completeGeneration, failGeneration } from "@/lib/generation-storage";
export { listConnections, saveConnection } from "@/lib/connection-storage";

const PAGE_SIZE = 100;

async function ready() {
  requireStorage();
  await ensureMigrated();
}

/** Verifies that the private store is reachable and the storage layout is ready. */
export async function storageHealth() {
  await ready();
  await listBlobs(blobPaths.migrationMarker.slice(0,blobPaths.migrationMarker.lastIndexOf("/")+1));
  return true;
}

// ---------------------------------------------------------------- publications

export async function readPublication(id:string):Promise<Stored<PublicationRow>|null> {
  await ready();
  return readJson(blobPaths.publication(id),parsePublicationRow);
}

export async function getPublicationRow(id:string) {
  return (await readPublication(id))?.value ?? null;
}

/** A publication deleted from every target. It is removed from storage; a leftover tombstone is never listed. */
export function isRemovedPublication(row:PublicationRow) {
  const targets=Object.values(row.document.targets);
  return targets.length>0 && targets.every(target=>target.status==="deleted");
}

export async function listAllPublications(kind?:string) {
  await ready();
  const rows=(await readAllJson(blobPaths.publications,parsePublicationRow)).filter(row=>!isRemovedPublication(row) && (!kind || row.document.kind===kind));
  rows.sort((a,b)=>b.document.updatedAt.localeCompare(a.document.updatedAt) || b.id.localeCompare(a.id));
  return rows;
}

export async function listPublications(kind?:string,page=0) {
  const rows=await listAllPublications(kind);
  return rows.slice(page*PAGE_SIZE,page*PAGE_SIZE+PAGE_SIZE);
}

const targetPayloads=(value:PublicationRow)=>Object.fromEntries(Object.entries(value.document.targets).map(([siteId,target])=>[siteId,target.payload]));

/** Idempotent insert: repeating the same publication id with the same content returns the stored row. */
export async function insertPublication(row:PublicationRow) {
  await ready();
  if(await createJson(blobPaths.publication(row.id),row)==="created") return row;
  const existing=await getPublicationRow(row.id);
  if(!existing) throw new ApiError("Yayın kaydı doğrulanamadı. Listeyi yenileyip kontrol et.",503);
  const same=existing.document.title===row.document.title && existing.document.kind===row.document.kind && JSON.stringify(targetPayloads(existing))===JSON.stringify(targetPayloads(row));
  if(!same) throw new ApiError("Bu yayın işlem kimliği başka bir içerikle kullanılmış. Sayfayı yenile.",409);
  return existing;
}

/**
 * Compare-and-swap on ONE publication object. When the caller already holds the
 * ETag it read, no extra read is needed. A lost race means another operation
 * changed this publication, which is reported as a version conflict (not retried).
 */
export async function replacePublication(row:PublicationRow,expectedVersion:number,etag?:string|null) {
  await ready();
  let currentEtag=etag;
  if(currentEtag===undefined) {
    const current=await readPublication(row.id);
    if(current?.value.version!==expectedVersion) throw new ApiError("Yayın başka bir işlemle değişti. Listeyi yenile.",409);
    currentEtag=current.etag;
  }
  if(await replaceJson(blobPaths.publication(row.id),row,currentEtag ?? null)==="conflict") throw new ApiError("Yayın başka bir işlemle değişti. Listeyi yenile.",409);
  return row;
}

/**
 * Completely removes a publication. The removal is first written as a
 * compare-and-swap tombstone on the publication object (so a concurrent
 * withdraw/publish of the same version gets a 409), then the object is deleted.
 * If the delete call itself fails, the tombstone is hidden everywhere and the
 * next read retries the cleanup.
 */
export async function removePublication(tombstone:PublicationRow,etag:string|null) {
  await ready();
  if(!isRemovedPublication(tombstone)) throw new ApiError("Yayın tüm hedeflerden silinmeden kaldırılamaz.",409);
  const pathname=blobPaths.publication(tombstone.id);
  if(await replaceJson(pathname,tombstone,etag)==="conflict") throw new ApiError("Yayın başka bir işlemle değişti. Listeyi yenile.",409);
  try {await deleteJson(pathname);}
  catch(error) {console.error(`[storage] publication ${tombstone.id} tombstoned; blob delete will be retried`,error);}
  return tombstone;
}

/** Best-effort cleanup of a tombstone left by an interrupted delete. */
export async function purgeRemovedPublication(id:string) {
  try {await deleteJson(blobPaths.publication(id));} catch { /* retried on the next read */ }
}

// ----------------------------------------------------------------- submissions

export async function listAllSubmissions(siteId?:string) {
  await ready();
  const rows=(await readAllJson(blobPaths.submissions,parseSubmission)).filter(row=>!siteId || row.site_id===siteId);
  rows.sort((a,b)=>b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  return rows;
}

export async function listSubmissions(page=0,siteId?:string) {
  const rows=await listAllSubmissions(siteId);
  return rows.slice(page*PAGE_SIZE,page*PAGE_SIZE+PAGE_SIZE);
}

export async function deleteSubmission(id:string) {
  await ready();
  await deleteJson(blobPaths.submission(id));
}

function assertAcceptingForm(row:PublicationRow|null,siteId:string):asserts row is PublicationRow {
  const target=row?.document.targets[siteId];
  if(!row || row.document.kind!=="form" || !target || effectiveStatus(target)!=="published" || !target.payload) throw new ApiError("Form yayından kaldırıldı; yanıt kaydedilmedi.",410);
}

export async function acceptSubmission(input:{id:string;publicationId:string;siteId:string;answers:Record<string,string>;version:number}) {
  await ready();
  const row=await getPublicationRow(input.publicationId);
  assertAcceptingForm(row,input.siteId);
  if(row.version!==input.version) throw new ApiError("Form değişti. Sayfayı yenileyip tekrar gönder.",409);
  const target=row.document.targets[input.siteId];
  const now=new Date().toISOString();
  const submission:Submission={id:input.id,publication_id:row.id,site_id:input.siteId,answers:input.answers,consent_at:now,consent_text:target.payload?.consentText || "",created_at:now};
  const pathname=blobPaths.submission(input.id);
  if(await createJson(pathname,submission)==="exists") {
    // Idempotent resubmission of the same id.
    const existing=(await readJson(pathname,parseSubmission))?.value;
    if(!existing || existing.publication_id!==row.id || existing.site_id!==input.siteId) throw new ApiError("Gönderim kimliği çakıştı.",409);
    return true;
  }
  // The form and the submission are separate objects. Re-check the form after the
  // write so a withdrawal that landed in between never keeps a late answer.
  const after=await getPublicationRow(input.publicationId);
  const afterTarget=after?.document.targets[input.siteId];
  if(!after || after.document.kind!=="form" || !afterTarget || effectiveStatus(afterTarget)!=="published" || !afterTarget.payload) {
    await deleteJson(pathname);
    throw new ApiError("Form yayından kaldırıldı; yanıt kaydedilmedi.",410);
  }
  return true;
}
