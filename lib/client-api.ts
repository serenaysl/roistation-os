"use client";

type ApiPayload = Record<string, unknown> | unknown[];

export async function readApiResponse(response: Response): Promise<ApiPayload> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("application/json") && text.trim()) {
    try { return JSON.parse(text) as ApiPayload; }
    catch { /* Fall through to a clearer message below. */ }
  }

  if (!text.trim()) return {};

  try { return JSON.parse(text) as ApiPayload; }
  catch {
    const short = text.replace(/\s+/g, " ").trim().slice(0, 240);
    if (short.includes("FUNCTION_INVOCATION_TIMEOUT")) {
      throw new Error("Vercel işlem süresi doldu. Yeni Claude kredisi kullanma. İçerik & Yayın ekranını yenileyip kayıt oluştu mu kontrol et; kayıt yoksa daha uzun süreli yayın sürümünü deploy etmek gerekir.");
    }
    throw new Error(response.ok ? "Sunucu okunamayan bir cevap döndürdü." : `Sunucu hata döndürdü: ${short}`);
  }
}

export async function requestApi<T extends ApiPayload = ApiPayload>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const data = await readApiResponse(response);
  if (!response.ok) {
    const error = !Array.isArray(data) && typeof data.error === "string" ? data.error : "İşlem tamamlanamadı.";
    throw new Error(error);
  }
  return data as T;
}
