import { ApiError } from "@/lib/errors";
import { blobPaths, mapLimit, overwriteJson, readJson, requireStorage, CorruptDocumentError } from "@/lib/blob-store";
import { ensureMigrated } from "@/lib/migration";
import { parseConnection } from "@/lib/records";
import { sites } from "@/lib/sites";
import { ensureSiteRegistry } from "@/lib/site-registry";
import type { Connection } from "@/lib/publications";

// One Blob object per site: roistation-master/connections/<site-id>.json
function unavailable() {return new ApiError("Site bağlantı kaydı okunamadı. Vercel Blob bağlantısını kontrol edip yeniden dene.",503);}

async function readConnection(siteId:string):Promise<Connection|null> {
  try {return (await readJson(blobPaths.connection(siteId),parseConnection))?.value ?? null;}
  catch(error) {
    // A damaged row behaves like "not verified yet"; the next check rewrites it.
    if(error instanceof CorruptDocumentError) {console.error(`[storage] ignored unreadable connection ${siteId}`);return null;}
    if(error instanceof ApiError) throw error;
    throw unavailable();
  }
}

async function readConnections(siteIds:string[]) {
  requireStorage();
  await ensureMigrated();
  await ensureSiteRegistry();
  const rows=await mapLimit(siteIds,8,siteId=>readConnection(siteId));
  return rows.filter((row):row is Connection=>Boolean(row));
}

export async function listConnections() {
  await ensureSiteRegistry();
  return readConnections(sites.map(site=>site.id));
}

export async function listConnectionsFor(siteIds:string[]) {
  await ensureSiteRegistry();
  const validIds=[...new Set(siteIds)].filter(siteId=>sites.some(site=>site.id===siteId));
  return readConnections(validIds);
}

export async function saveConnection(connection:Connection) {
  await ensureSiteRegistry();
  if(!sites.some(site=>site.id===connection.site_id)) throw new ApiError("Kapsam dışı veya bilinmeyen site.");
  requireStorage();
  await ensureMigrated();
  // Verification rows are independent timestamped observations; the newest check wins.
  await overwriteJson(blobPaths.connection(connection.site_id),connection);
  return connection;
}
