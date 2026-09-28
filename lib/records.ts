import { isRecord } from "@/lib/blob-store";
import type { Connection, PublicationRow, Submission } from "@/lib/publications";

export type GenerationRecord={id:string;fingerprint:string;status:"pending"|"complete"|"failed";mode?:"demo"|"anthropic"|"openai";results?:unknown[];raw?:string;usage?:Record<string,number>;error?:string;createdAt:string;updatedAt:string};
export type RateBucket={used:number;expiresAt:number;updatedAt:string};
export type FingerprintPointer={id:string;fingerprint:string;updatedAt:string};

const idFromPath=(pathname:string|undefined)=>pathname ? pathname.slice(pathname.lastIndexOf("/")+1).replace(/\.json$/,"") : undefined;
const matchesPath=(id:string,pathname?:string)=>pathname===undefined || idFromPath(pathname)===id;

export function parsePublicationRow(value:unknown,pathname?:string):PublicationRow|null {
  if(!isRecord(value) || typeof value.id!=="string" || !Number.isInteger(value.version) || !isRecord(value.document)) return null;
  const document=value.document;
  if(document.id!==value.id || (document.kind!=="content" && document.kind!=="form") || typeof document.title!=="string" || typeof document.updatedAt!=="string" || typeof document.createdAt!=="string" || !isRecord(document.targets) || !Array.isArray(document.events)) return null;
  if(!matchesPath(value.id,pathname)) return null;
  return value as unknown as PublicationRow;
}

export function parseSubmission(value:unknown,pathname?:string):Submission|null {
  if(!isRecord(value) || typeof value.id!=="string" || typeof value.publication_id!=="string" || typeof value.site_id!=="string" || !isRecord(value.answers) || typeof value.created_at!=="string") return null;
  if(!matchesPath(value.id,pathname)) return null;
  return value as unknown as Submission;
}

export function parseConnection(value:unknown,pathname?:string):Connection|null {
  if(!isRecord(value) || typeof value.site_id!=="string" || typeof value.site_url!=="string" || typeof value.verified!=="boolean") return null;
  if(!matchesPath(value.site_id,pathname)) return null;
  return value as unknown as Connection;
}

export function parseGeneration(value:unknown,pathname?:string):GenerationRecord|null {
  if(!isRecord(value) || typeof value.id!=="string" || typeof value.fingerprint!=="string" || !value.fingerprint || !["pending","complete","failed"].includes(String(value.status)) || typeof value.createdAt!=="string" || typeof value.updatedAt!=="string") return null;
  if(!matchesPath(value.id,pathname)) return null;
  return value as unknown as GenerationRecord;
}

export function parseFingerprintPointer(value:unknown):FingerprintPointer|null {
  if(!isRecord(value) || typeof value.id!=="string" || typeof value.fingerprint!=="string") return null;
  return {id:value.id,fingerprint:value.fingerprint,updatedAt:typeof value.updatedAt==="string" ? value.updatedAt : new Date(0).toISOString()};
}

export function parseRateBucket(value:unknown):RateBucket|null {
  if(!isRecord(value) || typeof value.used!=="number" || typeof value.expiresAt!=="number") return null;
  return {used:value.used,expiresAt:value.expiresAt,updatedAt:typeof value.updatedAt==="string" ? value.updatedAt : new Date(0).toISOString()};
}

export const anyRecord=(value:unknown)=>isRecord(value) ? value : null;
