import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** AES-256-GCM sealing for server-side secrets, keyed from PANEL_SESSION_SECRET plus a per-purpose label. */
export type SealedBox = { v: 1; iv: string; tag: string; data: string };

function key(purpose: string) {
  const secret = process.env.PANEL_SESSION_SECRET || "";
  if (secret.length < 32) throw new Error("PANEL_SESSION_SECRET en az 32 karakter olmalı.");
  return createHash("sha256").update(`roistation:${purpose}:v1:${secret}`).digest();
}

export function seal(plaintext: string, purpose: string): SealedBox {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(purpose), iv);
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

/** Returns null when the box cannot be opened (e.g. PANEL_SESSION_SECRET rotated). */
export function open(box: SealedBox, purpose: string): string | null {
  try {
    const decipher = createDecipheriv("aes-256-gcm", key(purpose), Buffer.from(box.iv, "base64"));
    decipher.setAuthTag(Buffer.from(box.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
  } catch { return null; }
}
