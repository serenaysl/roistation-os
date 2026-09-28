import { NextResponse } from "next/server";
import mammoth from "mammoth";
import { requireAdmin } from "@/lib/admin";
import { apiFailure } from "@/lib/database";

export const runtime = "nodejs";

const plainTextExtensions = new Set(["txt", "md", "markdown", "csv", "json", "html"]);

export async function POST(request: Request) {
  try {await requireAdmin(request);} catch(error) {return apiFailure(error);}
  const formData = await request.formData();
  const files = formData.getAll("files").filter((item): item is File => item instanceof File);
  if (!files.length) return NextResponse.json({ error: "Okunacak dosya bulunamadı." }, { status: 400 });
  if (files.length > 30) return NextResponse.json({ error: "Tek işlemde en fazla 30 dosya eklenebilir." }, { status: 400 });

  let totalBytes = 0;
  const extracted: { name: string; text: string; warning?: string }[] = [];

  for (const file of files) {
    totalBytes += file.size;
    if (file.size > 8 * 1024 * 1024 || totalBytes > 24 * 1024 * 1024) {
      return NextResponse.json({ error: "Dosya boyutu sınırı aşıldı. Dosya başına 8 MB, toplam 24 MB kullanılabilir." }, { status: 413 });
    }

    const extension = file.name.split(".").pop()?.toLowerCase() || "";
    const buffer = Buffer.from(await file.arrayBuffer());
    if (plainTextExtensions.has(extension)) {
      extracted.push({ name: file.name, text: buffer.toString("utf8") });
      continue;
    }
    if (extension === "docx") {
      const result = await mammoth.extractRawText({ buffer });
      extracted.push({ name: file.name, text: result.value, warning: result.messages.length ? "Bazı biçimlendirmeler metne çevrilmedi." : undefined });
      continue;
    }
    extracted.push({ name: file.name, text: "", warning: "Bu dosya türü ilk sürümde otomatik metne çevrilmiyor." });
  }

  const combinedText = extracted
    .filter((item) => item.text.trim())
    .map((item) => `\n\n--- ${item.name} ---\n${item.text.trim()}`)
    .join("")
    .trim();

  return NextResponse.json({ combinedText, files: extracted });
}
