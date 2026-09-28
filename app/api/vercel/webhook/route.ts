import { createHmac, timingSafeEqual } from "node:crypto";
import { apiFailure, ApiError } from "@/lib/database";
import { syncVercel } from "@/lib/vercel/sync";

// Optional: Vercel account/team webhook (deployment.*, project.*). Signed with VERCEL_WEBHOOK_SECRET (HMAC-SHA1).
// Keeps statuses current right after every deploy without waiting for the panel poll or the daily cron.
export const maxDuration = 60;
const relevant = /^(deployment\.(created|succeeded|ready|error|canceled|promoted)|project\.(created|removed|renamed)|domain\.)/;

export async function POST(request: Request) {
  try {
    const secret = process.env.VERCEL_WEBHOOK_SECRET || "";
    if (!secret) throw new ApiError("Webhook yapılandırılmadı.", 404);
    const raw = await request.text();
    const expected = createHmac("sha1", secret).update(raw).digest();
    const given = Buffer.from(request.headers.get("x-vercel-signature") || "", "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ApiError("İmza geçersiz.", 401);
    let type = "";
    try { type = String((JSON.parse(raw) as { type?: unknown }).type || ""); } catch { throw new ApiError("Geçersiz gövde."); }
    if (!relevant.test(type)) return Response.json({ ok: true, ignored: type });
    const sync = await syncVercel(`webhook:${type}`.slice(0, 40), { full: /^project\.|^domain\./.test(type) });
    return Response.json({ ok: true, status: sync.state.status, skipped: sync.skipped ?? null });
  } catch (error) { return apiFailure(error); }
}
