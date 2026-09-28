import { NextResponse } from "next/server";
import { adminConfigured, isAdmin, safeEqual, sessionCookie, sessionToken, requestFingerprint,requireSameOrigin } from "@/lib/admin";
import { ApiError, apiFailure, rateLimit } from "@/lib/database";
export async function GET() { return Response.json({ configured:adminConfigured(),authenticated:await isAdmin() },{headers:{"Cache-Control":"no-store"}}); }
export async function POST(request: Request) {
  try {
    if (!adminConfigured()) throw new ApiError("PANEL_ADMIN_PASSWORD ve en az 32 karakterlik PANEL_SESSION_SECRET değişkenlerini tanımla.",503);
    requireSameOrigin(request);
    await rateLimit(`login:${requestFingerprint(request)}`,10,900);
    const {password}=await request.json();
    if(typeof password!=="string" || !safeEqual(password,process.env.PANEL_ADMIN_PASSWORD!)) throw new ApiError("Parola yanlış.",401);
    const response=NextResponse.json({authenticated:true});
    response.cookies.set(sessionCookie,sessionToken(),{httpOnly:true,secure:process.env.VERCEL==="1",sameSite:"strict",path:"/",maxAge:8*3600}); return response;
  } catch(error) { return apiFailure(error); }
}
export async function DELETE(request:Request) {try {requireSameOrigin(request);const response=NextResponse.json({authenticated:false});response.cookies.delete(sessionCookie);return response;} catch(error) {return apiFailure(error);} }
