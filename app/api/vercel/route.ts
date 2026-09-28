import { requireAdmin } from "@/lib/admin";
import { ApiError, apiFailure } from "@/lib/database";
import { getAccount, listTeams, VercelApiError } from "@/lib/vercel/api";
import { clearVercelCredentials, saveVercelCredentials, validTeamId } from "@/lib/vercel/credentials";
import { vercelOverview } from "@/lib/vercel/overview";
import { connectProject, ignoreProject, importAllCompatible, syncVercel } from "@/lib/vercel/sync";
import { isAutoConnectMode, updateVercelSettings } from "@/lib/vercel/settings";
import { validProjectId } from "@/lib/vercel/projects";

export const maxDuration = 60;

export async function GET(request: Request) {
  try { await requireAdmin(request); return Response.json(await vercelOverview(), { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiFailure(error); }
}

export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as Record<string, unknown>;
    switch (body.action) {
      case "connect": {
        if (process.env.VERCEL_TOKEN) throw new ApiError("VERCEL_TOKEN ortam değişkeni tanımlı; bağlantı oradan yönetiliyor.");
        const token = typeof body.token === "string" ? body.token.trim() : "";
        const scope = typeof body.teamId === "string" ? body.teamId.trim() : "";
        const teamId = scope && scope !== "personal" ? scope : null;
        if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new ApiError("Vercel erişim anahtarı geçersiz görünüyor.");
        if (teamId && !validTeamId(teamId)) throw new ApiError("Vercel Team ID geçersiz.");
        let account: Awaited<ReturnType<typeof getAccount>>;
        try {
          account = await getAccount({ token, teamId, source: "panel" });
          // A token with team access: let the user pick the scope (personal account or a team) once.
          if (!scope) { const teams = await listTeams({ token, teamId: null, source: "panel" }); if (teams.length) return Response.json({ ok: false, needsTeam: true, account: account.user, teams }); }
        }
        catch (error) { throw new ApiError(error instanceof VercelApiError ? error.message : "Vercel hesabı doğrulanamadı.", error instanceof VercelApiError && error.kind === "auth" ? 401 : 502); }
        await saveVercelCredentials(token, teamId, account.team ? `${account.user} · ${account.team}` : account.user);
        const sync = await syncVercel("connect", { full: true });
        return Response.json({ ok: true, sync, overview: await vercelOverview() });
      }
      case "disconnect": {
        await clearVercelCredentials();
        return Response.json({ ok: true, overview: await vercelOverview() });
      }
      case "sync": {
        // full:false = deployment status check only (panel poll every 2 min); default is a full sync.
        const sync = await syncVercel(typeof body.reason === "string" ? body.reason.slice(0, 40) : "panel", { full: body.full !== false });
        return Response.json({ ok: true, sync, overview: await vercelOverview() });
      }
      case "connect-project": {
        if (!validProjectId(body.projectId)) throw new ApiError("Proje kimliği geçersiz.");
        const result = await connectProject(body.projectId, "user");
        return Response.json({ ok: true, ...result, overview: await vercelOverview() });
      }
      case "ignore-project": {
        if (!validProjectId(body.projectId)) throw new ApiError("Proje kimliği geçersiz.");
        await ignoreProject(body.projectId);
        return Response.json({ ok: true, overview: await vercelOverview() });
      }
      case "import-all": {
        const results = await importAllCompatible();
        return Response.json({ ok: true, results, overview: await vercelOverview() });
      }
      case "settings": {
        if (!isAutoConnectMode(body.autoConnect)) throw new ApiError("Otomatik bağlama ayarı geçersiz.");
        const mode = body.autoConnect;
        await updateVercelSettings((settings) => ({ ...settings, autoConnect: mode }));
        return Response.json({ ok: true, overview: await vercelOverview() });
      }
      default: throw new ApiError("İşlem geçersiz.");
    }
  } catch (error) { return apiFailure(error); }
}
