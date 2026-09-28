import { apiFailure } from "@/lib/database";
import { requireCronSecret } from "@/lib/admin";
import { syncVercel } from "@/lib/vercel/sync";
import { listConnections } from "@/lib/connection-storage";
import { verifySite } from "@/lib/verification";
import { mapLimit } from "@/lib/blob-store";

// Daily health check (vercel.json crons). Vercel sends "Authorization: Bearer <CRON_SECRET>".
export const maxDuration = 60;

export async function GET(request: Request) {
  try {
    requireCronSecret(request);
    const started = Date.now();
    const sync = await syncVercel("cron", { full: true });
    // Sites that are not linked to a Vercel project are verified directly (24h check).
    const connections = await listConnections();
    const stale = connections.filter((connection) => Date.now() - Date.parse(connection.verified_at) > 60 * 60_000);
    const verified = await mapLimit(stale, 6, async (connection) => {
      if (Date.now() - started > 45_000) return { siteId: connection.site_id, skipped: true };
      try { const result = await verifySite(connection.site_id, { reason: "cron" }); return { siteId: connection.site_id, verified: result.verified }; }
      catch { return { siteId: connection.site_id, verified: false }; }
    });
    return Response.json({ ok: true, sync: { status: sync.state.status, discovered: sync.discovered, imported: sync.imported.length, archived: sync.archived.length, skipped: sync.skipped ?? null }, verified }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return apiFailure(error); }
}
