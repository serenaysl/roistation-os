import { slugify } from "@/lib/publishing/definitions";

/*
 * Converts the stored plain-text / light-markdown body (as produced by the
 * existing AI pipeline or typed by hand) into typed blocks. Renderers output
 * these as React elements, so no HTML from content is ever injected.
 */

export type HeadingBlock = { type: "h2" | "h3"; text: string; id: string };
export type TextBlock = { type: "p" | "quote"; text: string };
export type ListBlock = { type: "ul" | "ol"; items: string[] };
export type ContentBlock = HeadingBlock | TextBlock | ListBlock;
const isHeading = (block: ContentBlock): block is HeadingBlock => block.type === "h2" || block.type === "h3";
const isList = (block: ContentBlock): block is ListBlock => block.type === "ul" || block.type === "ol";
export type FaqEntry = { question: string; answer: string };
export type TocEntry = { id: string; text: string };

const cleanInline = (text: string) => text
  .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, "$1")   // [label](url) -> label
  .replace(/(\*\*|__)(.+?)\1/g, "$2")
  .replace(/(^|\s)[*_](\S.*?\S|\S)[*_](?=\s|$|[.,;:!?])/g, "$1$2")
  .replace(/`([^`]+)`/g, "$1")
  .replace(/\s+/g, " ")
  .trim();

const questionPrefix = /^(?:soru|s|q|question)\s*[:.)-]\s*/i;
const answerPrefix = /^(?:cevap|yanıt|c|a|answer)\s*[:.)-]\s*/i;

export function parseContent(body: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const usedIds = new Set<string>();
  const headingId = (text: string) => {
    const base = slugify(text, 60) || "bolum";
    let id = base; let n = 2;
    while (usedIds.has(id)) id = `${base}-${n++}`;
    usedIds.add(id); return id;
  };
  let paragraph: string[] = [];
  let list: ListBlock | null = null;
  const flushParagraph = () => { if (paragraph.length) { const text = cleanInline(paragraph.join(" ")); if (text) blocks.push({ type: "p", text }); paragraph = []; } };
  const flushList = () => { if (list && list.items.length) blocks.push(list); list = null; };
  const flush = () => { flushParagraph(); flushList(); };

  for (const rawLine of body.replace(/\r\n?/g, "\n").split("\n")) {
    const line = rawLine.trim();
    if (!line) { flush(); continue; }
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    if (heading) {
      flush();
      const text = cleanInline(heading[2].replace(/#+$/, ""));
      if (text) blocks.push({ type: heading[1].length <= 2 ? "h2" : "h3", text, id: headingId(text) });
      continue;
    }
    // A whole-line bold question ("**Rezervasyon gerekli mi?**") or "Soru: …" becomes a question heading.
    const boldLine = /^(\*\*|__)(.+)\1:?$/.exec(line);
    if (boldLine || questionPrefix.test(line)) {
      const text = cleanInline(boldLine ? boldLine[2] : line.replace(questionPrefix, ""));
      if (text && (text.endsWith("?") || questionPrefix.test(line) || text.length <= 90)) { flush(); blocks.push({ type: "h3", text, id: headingId(text) }); continue; }
    }
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    const ordered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (bullet || ordered) {
      flushParagraph();
      const type = bullet ? "ul" : "ol";
      if (!list || list.type !== type) { flushList(); list = { type, items: [] }; }
      const text = cleanInline((bullet || ordered)![1]);
      if (text) list.items.push(text);
      continue;
    }
    if (line.startsWith(">")) { flush(); const text = cleanInline(line.replace(/^>\s?/, "")); if (text) blocks.push({ type: "quote", text }); continue; }
    flushList();
    paragraph.push(answerPrefix.test(line) ? line.replace(answerPrefix, "") : line);
  }
  flush();
  return blocks;
}

/** Question headings followed by answer text become FAQ entries. */
export function extractFaq(blocks: ContentBlock[], limit = 12): FaqEntry[] {
  const faq: FaqEntry[] = [];
  for (let i = 0; i < blocks.length && faq.length < limit; i++) {
    const block = blocks[i];
    if (!isHeading(block) || !block.text.trim().endsWith("?")) continue;
    const answer: string[] = [];
    for (let j = i + 1; j < blocks.length; j++) {
      const next = blocks[j];
      if (isHeading(next)) break;
      answer.push(isList(next) ? next.items.join("; ") : next.text);
    }
    const text = answer.join(" ").trim();
    if (text) faq.push({ question: block.text, answer: text.length > 1200 ? `${text.slice(0, 1197).replace(/\s+\S*$/, "")}…` : text });
  }
  return faq;
}

export const tableOfContents = (blocks: ContentBlock[]): TocEntry[] => blocks.filter(isHeading).filter((block) => block.type === "h2").map((block) => ({ id: block.id, text: block.text }));

export function plainText(blocks: ContentBlock[]) {
  return blocks.map((block) => (isList(block) ? block.items.join(" ") : block.text)).join(" ");
}

export function readingMinutes(blocks: ContentBlock[]) {
  const words = plainText(blocks).split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 200));
}

export function truncate(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).replace(/\s+\S*$/, "").replace(/[,;:.\s]+$/, "")}…`;
}

export function excerptOf(summary: string | undefined, blocks: ContentBlock[], max = 160) {
  const paragraph = blocks.find((block): block is TextBlock => block.type === "p");
  return truncate(summary?.trim() || paragraph?.text || "", max);
}

/** Up to `count` short highlight lines: first list items, else section headings, else summary sentences. */
export function highlightsOf(blocks: ContentBlock[], summary: string | undefined, count = 3): string[] {
  const list = blocks.find(isList);
  if (list && list.items.length >= 2) return list.items.slice(0, count).map((item) => truncate(item, 110));
  const headings = blocks.filter(isHeading).map((block) => block.text);
  if (headings.length >= 2) return headings.slice(0, count).map((item) => truncate(item, 110));
  const sentences = (summary || plainText(blocks)).split(/(?<=[.!?])\s+/).filter((sentence) => sentence.length > 20);
  return sentences.slice(0, count).map((item) => truncate(item, 110));
}

/** Short standalone facts for "key facts" boxes: short paragraphs' first sentences. */
export function keyFactsOf(blocks: ContentBlock[], count = 4): string[] {
  const facts: string[] = [];
  for (const block of blocks) {
    if (facts.length >= count) break;
    if (block.type !== "p") continue;
    const first = block.text.split(/(?<=[.!?])\s+/)[0];
    if (first && first.length >= 30 && first.length <= 180 && !first.endsWith("?")) facts.push(first);
  }
  return facts;
}
