import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import { cookies } from "next/headers";
import { ApiError } from "@/lib/database";
export const sessionCookie = "roi_admin";
export function adminConfigured() { return Boolean(process.env.PANEL_ADMIN_PASSWORD && process.env.PANEL_SESSION_SECRET && process.env.PANEL_SESSION_SECRET.length >= 32); }
function signature(value: string) { return createHmac("sha256", process.env.PANEL_SESSION_SECRET || "unconfigured").update(value).digest("hex"); }
export function safeEqual(a: string, b: string) { return timingSafeEqual(createHash("sha256").update(a).digest(),createHash("sha256").update(b).digest()); }
export function sessionToken() { const expires = String(Date.now() + 8 * 3600000); return `${expires}.${signature(expires)}`; }
export async function isAdmin() {
  if (!adminConfigured()) return false;
  const [expires,signed] = ((await cookies()).get(sessionCookie)?.value || "").split(".");
  return Boolean(expires && signed && Number(expires) > Date.now() && safeEqual(signature(expires),signed));
}
export async function requireAdmin(request?: Request) {
  if (!adminConfigured()) throw new ApiError("Yönetici girişi için PANEL_ADMIN_PASSWORD ve en az 32 karakterlik PANEL_SESSION_SECRET tanımla.",503);
  if (!await isAdmin()) throw new ApiError("Yönetici oturumu gerekli. Panelde giriş yap.",401);
  if (request && !["GET","HEAD"].includes(request.method)) requireSameOrigin(request);
}
export function requireSameOrigin(request:Request) {
  // Next may use an internal server hostname in request.url behind a proxy.
  // Production origins come from trusted configuration, never arbitrary Host headers.
  const allowed=new Set<string>();
  for(const value of [process.env.MASTER_PUBLIC_URL,process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`]) {if(value) {try {allowed.add(new URL(value).origin);} catch { /* Invalid configuration is not trusted. */ }}}
  if(process.env.VERCEL!=="1") {const host=request.headers.get("host") || "";if(/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) allowed.add(`http://${host}`);}
  if(!allowed.has(request.headers.get("origin") || "")) throw new ApiError("Geçersiz istek kaynağı.",403);
}
export function requestFingerprint(request: Request) { const ip=request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"; return signature(ip); }
/** Vercel Cron calls carry "Authorization: Bearer <CRON_SECRET>"; compared in constant time. */
export function requireCronSecret(request: Request) {
  const secret = process.env.CRON_SECRET || "";
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (secret.length < 16 || !timingSafeEqual(digest(secret), digest(given))) throw new ApiError("Yetkisiz.", 401);
}
