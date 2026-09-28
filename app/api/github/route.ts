import { requireAdmin } from "@/lib/admin";
import { ApiError, apiFailure } from "@/lib/database";
import { clearGithubCredentials, getGithubCredentials, saveGithubCredentials } from "@/lib/github/credentials";
import { getUser, GithubError } from "@/lib/github/api";

export async function GET(request: Request) {
  try { await requireAdmin(request); const c = await getGithubCredentials(); return Response.json({ configured: Boolean(c), source: c?.source ?? null, login: c?.login ?? null }, { headers: { "Cache-Control": "no-store" } }); }
  catch (error) { return apiFailure(error); }
}
export async function POST(request: Request) {
  try {
    await requireAdmin(request);
    const body = await request.json() as { action?: unknown; token?: unknown };
    if (body.action === "disconnect") { await clearGithubCredentials(); return Response.json({ configured: Boolean(process.env.GITHUB_TOKEN), source: process.env.GITHUB_TOKEN ? "env" : null, login: null }); }
    if (body.action !== "connect") throw new ApiError("İşlem geçersiz.");
    if (process.env.GITHUB_TOKEN) throw new ApiError("GITHUB_TOKEN ortam değişkeni tanımlı; bağlantı oradan yönetiliyor.");
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!/^(gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})$/.test(token)) throw new ApiError("GitHub erişim anahtarı geçersiz görünüyor.");
    let login: string;
    try { login = (await getUser({ token, source: "panel", login: null })).login; }
    catch (error) { throw new ApiError(error instanceof GithubError ? error.message : "GitHub doğrulanamadı.", 401); }
    await saveGithubCredentials(token, login);
    return Response.json({ configured: true, source: "panel", login });
  } catch (error) { return apiFailure(error); }
}
