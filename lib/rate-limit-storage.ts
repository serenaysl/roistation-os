import { createHash } from "node:crypto";
import { ApiError } from "@/lib/errors";
import { blobPaths, overwriteJson, readJson, storageConfigured } from "@/lib/blob-store";
import { parseRateBucket, type RateBucket } from "@/lib/records";

const maxWindowSeconds = 24 * 60 * 60;

export function rateLimitDigest(key: string) {
  return createHash("sha256").update(key).digest("hex");
}

/**
 * Best-effort throttle: one Blob object per key (roistation-master/rate-limit/<sha256>.json).
 * Last write wins is acceptable here because password checks and signed tokens
 * still own authentication; storage hiccups never block a legitimate user.
 */
export async function rateLimit(key: string, limit: number, seconds: number) {
  if (!storageConfigured()) return;

  const path = blobPaths.rateLimit(rateLimitDigest(key));
  const now = Date.now();
  const windowMs = Math.max(1, Math.min(seconds, maxWindowSeconds)) * 1000;

  try {
    const current = (await readJson(path, parseRateBucket))?.value ?? null;
    const next: RateBucket = current && current.expiresAt > now
      ? { used: current.used + 1, expiresAt: current.expiresAt, updatedAt: new Date().toISOString() }
      : { used: 1, expiresAt: now + windowMs, updatedAt: new Date().toISOString() };

    await overwriteJson(path, next, { cacheControlMaxAge: 0 });

    if (next.used > limit) throw new ApiError("Çok fazla istek. Bir süre bekleyip tekrar dene.", 429);
  } catch (error) {
    if (error instanceof ApiError && error.status === 429) throw error;
    // Storage/race errors are never surfaced on the login screen or public forms.
    return;
  }
}
