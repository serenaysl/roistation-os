import { ApiError, StorageBusyError } from "@/lib/errors";
import { blobPaths, createJson, overwriteJson, readJson, replaceJson, requireStorage, storageConfigured, CorruptDocumentError, type Stored } from "@/lib/blob-store";
import { ensureMigrated } from "@/lib/migration";
import { parseFingerprintPointer, parseGeneration, type GenerationRecord } from "@/lib/records";

export type { GenerationRecord } from "@/lib/records";

// One Blob object per generation: roistation-master/generations/<generation-id>.json
// Status transitions (pending -> complete | failed) are compare-and-swap on that object only.
const MAX_CAS_ATTEMPTS = 3;

function unavailable() {return new ApiError("AI güvenli kayıt alanına erişilemedi. Vercel Blob bağlantısını kontrol edip yeniden dene; Claude çağrısı başlatılmadı.",503);}

async function ready() {
  if(!storageConfigured()) throw unavailable();
  requireStorage();
  await ensureMigrated();
}

async function readRecord(id:string):Promise<Stored<GenerationRecord>|null> {
  try {return await readJson(blobPaths.generation(id),parseGeneration);}
  catch(error) {if(error instanceof ApiError) throw error;throw unavailable();}
}

const pause=(attempt:number)=>new Promise(resolve=>setTimeout(resolve,40+attempt*80+Math.floor(Math.random()*60)));

export async function getGeneration(id:string) {
  await ready();
  return (await readRecord(id))?.value ?? null;
}

async function rememberFingerprint(row:GenerationRecord) {
  if(row.status!=="complete") return;
  try {await overwriteJson(blobPaths.generationFingerprint(row.fingerprint),{id:row.id,fingerprint:row.fingerprint,updatedAt:row.updatedAt});}
  catch { /* Fingerprint index is a credit-saver, not the source of truth. */ }
}

export async function getCompleteGenerationByFingerprint(fingerprint:string) {
  await ready();
  try {
    const pointer=(await readJson(blobPaths.generationFingerprint(fingerprint),parseFingerprintPointer))?.value;
    if(!pointer || pointer.fingerprint!==fingerprint) return null;
    const row=(await readRecord(pointer.id))?.value;
    return row?.status==="complete" && row.fingerprint===fingerprint ? row : null;
  } catch(error) {
    // A damaged index entry only means we cannot reuse an earlier result.
    if(error instanceof CorruptDocumentError) return null;
    throw error;
  }
}

export async function beginGeneration(id:string,fingerprint:string) {
  await ready();
  const existing=(await readRecord(id))?.value;
  if(existing) {
    if(existing.fingerprint!==fingerprint) throw new ApiError("AI işlem kimliği başka bir içerikle eşleşiyor. Sayfayı yenile.",409);
    return {record:existing,created:false};
  }
  const now=new Date().toISOString();const row:GenerationRecord={id,fingerprint,status:"pending",createdAt:now,updatedAt:now};
  if(await createJson(blobPaths.generation(id),row)==="created") return {record:row,created:true};
  const raced=(await readRecord(id))?.value;
  if(!raced) throw unavailable();
  if(raced.fingerprint!==fingerprint) throw new ApiError("AI işlem kimliği başka bir içerikle eşleşiyor. Sayfayı yenile.",409);
  return {record:raced,created:false};
}

export async function completeGeneration(id:string,fingerprint:string,input:{mode:"demo"|"anthropic"|"openai";results:unknown[];usage?:Record<string,number>}) {
  await ready();
  for(let attempt=0;attempt<MAX_CAS_ATTEMPTS;attempt++) {
    const current=await readRecord(id);
    if(!current || current.value.fingerprint!==fingerprint) throw new ApiError("AI işlem kaydı bulunamadı; sonuç kaybolmadan işlem durduruldu.",409);
    if(current.value.status==="complete") {await rememberFingerprint(current.value);return current.value;}
    // A paid result always supersedes a pending or failed marker for the same id.
    const row:GenerationRecord={...current.value,status:"complete",mode:input.mode,results:input.results,raw:undefined,error:undefined,usage:input.usage,updatedAt:new Date().toISOString()};
    if(await replaceJson(blobPaths.generation(id),row,current.etag)==="replaced") {await rememberFingerprint(row);return row;}
    await pause(attempt);
  }
  throw new StorageBusyError("AI sonucu kaydedilirken kayıt aynı anda değişti. Yeni kredi harcamadan sayfayı yenileyip sonucu geri yükle.");
}

export async function failGeneration(id:string,fingerprint:string,error:string,input?:{raw?:string;usage?:Record<string,number>}) {
  await ready();
  for(let attempt=0;attempt<MAX_CAS_ATTEMPTS;attempt++) {
    const current=await readRecord(id);
    if(!current || current.value.fingerprint!==fingerprint) return null;
    // Never downgrade a completed (paid) result.
    if(current.value.status!=="pending") return current.value;
    const row:GenerationRecord={...current.value,status:"failed",error:error.slice(0,500),raw:input?.raw?.slice(0,50000),usage:input?.usage,updatedAt:new Date().toISOString()};
    if(await replaceJson(blobPaths.generation(id),row,current.etag)==="replaced") return row;
    await pause(attempt);
  }
  return (await readRecord(id))?.value ?? null;
}
