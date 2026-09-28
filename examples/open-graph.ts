/*
 * Example: Open Graph and Twitter Card — detection on a live page and the fix for static sites.
 *
 * Demonstrates:
 *   - how the scanner reads og:* and twitter:* from <meta property> or <meta name> in <head>
 *     (entity-decoded attributes, empty content ignored),
 *   - the `open-graph` check (fail when none of og:title / og:description / og:image / og:url
 *     exist, warn with the missing keys otherwise) and the `twitter-card` check,
 *   - the static index.html fix: only missing tags are added, values come from the live scan
 *     (site title, meta description or first paragraph), `"` is escaped, and twitter:card is
 *     `summary_large_image` only when the site already has an og:image.
 *
 * Source: lib/seo/html.ts (parseAttrs, decodeEntities, og/twitter extraction in parseHtml),
 *         lib/seo/scanner.ts (open-graph, twitter-card checks), lib/seo/fixes.ts (static index
 *         Open Graph / Twitter tags, insertBefore), lib/publishing/content.ts (truncate)
 *
 * Differences from production: extraction is lifted out of parseHtml() into `readSocialTags()`;
 * the static fix is shown for the social tags only (production inserts description, canonical,
 * viewport, social tags and JSON-LD in one </head> insertion). Published ROIstation pages get
 * `openGraph: { type: "article", ... }` from the page model, shown in metadata.ts.
 */

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
export function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) { const n = parseInt(lower.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : match; }
    if (lower.startsWith("#")) { const n = parseInt(lower.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : match; }
    return entities[lower] ?? match;
  });
}

export function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  return attrs;
}

/** The og / twitter part of parseHtml(). */
export function readSocialTags(html: string) {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(withoutComments)?.[1] ?? withoutComments;
  const metas: Record<string, string>[] = [];
  const pattern = /<meta\b([^>]*)>/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(head))) metas.push(parseAttrs(match[1]));
  const og: Record<string, string> = {}; const twitter: Record<string, string> = {};
  for (const attrs of metas) {
    const property = (attrs.property || attrs.name || "").toLowerCase();
    if (property.startsWith("og:") && attrs.content) og[property.slice(3)] = attrs.content;
    if (property.startsWith("twitter:") && attrs.content) twitter[property.slice(8)] = attrs.content;
  }
  return { og, twitter };
}

/** Scanner checks: open-graph and twitter-card. */
export function socialChecks(og: Record<string, string>, twitter: Record<string, string>) {
  const ogMissing = ["title", "description", "image", "url"].filter((key) => !og[key]);
  return {
    "open-graph": ogMissing.length === 4 ? { status: "fail", finding: "Open Graph etiketi yok." } : ogMissing.length ? { status: "warn", finding: `Eksik: ${ogMissing.map((key) => `og:${key}`).join(", ")}`, evidence: ogMissing.map((key) => `og:${key}`) } : { status: "pass", finding: "og:title, og:description, og:image, og:url mevcut." },
    "twitter-card": twitter.card ? { status: "pass", finding: `twitter:card="${twitter.card}"` } : { status: "fail", finding: "twitter:card etiketi yok." },
  };
}

/* ---------------------------------------------------------- static site fix */

export function truncate(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).replace(/\s+\S*$/, "").replace(/[,;:.\s]+$/, "")}…`;
}
function insertBefore(source: string, marker: RegExp, insertion: string) {
  const matches = source.match(new RegExp(marker.source, "gi"));
  if (!matches || matches.length !== 1) return null;
  return source.replace(marker, (found) => `${insertion}${found}`);
}

export function staticSocialFix(input: { source: string; failing: string[]; origin: string; siteName: string; facts: { title: string | null; metaDescription: string | null; firstParagraph: string | null; ogImage: string | null } }) {
  const { source, origin, facts } = input;
  const failing = (id: string) => input.failing.includes(id);
  const head: string[] = []; const ids: string[] = [];
  const description = facts.metaDescription || (facts.firstParagraph ? truncate(facts.firstParagraph, 155) : null);
  if (failing("open-graph")) { const t = (facts.title || input.siteName).replace(/"/g, "&quot;"); for (const [key, value] of [["og:type", "website"], ["og:url", `${origin}/`], ["og:title", t], ["og:site_name", input.siteName]] as const) if (!new RegExp(`property=["']${key}["']`, "i").test(source)) head.push(`<meta property="${key}" content="${value}">`); if (description && !/property=["']og:description/i.test(source)) head.push(`<meta property="og:description" content="${description.replace(/"/g, "&quot;")}">`); ids.push("open-graph"); }
  if (failing("twitter-card") && !/name=["']twitter:card/i.test(source)) { head.push(`<meta name="twitter:card" content="${facts.ogImage ? "summary_large_image" : "summary"}">`); ids.push("twitter-card"); }
  if (!head.length) return { source, ids, manual: null };
  const next = insertBefore(source, /<\/head>/, `  ${head.join("\n  ")}\n`);
  return next ? { source: next, ids, manual: null } : { source, ids, manual: "index.html içinde tek </head> bulunamadı; etiketleri elle ekleyin." };
}

/* ------------------------------------------------------------------ demo */

export function demo() {
  const html = `<html lang="tr"><head>\n  <title>Zeytinlik Restoran | Foça</title>\n  <meta property="og:title" content="Zeytinlik Restoran &amp; Meze">\n</head><body><p>Foça sahilinde "ev usulü" mezeler.</p></body></html>`;
  const { og, twitter } = readSocialTags(html);
  const checks = socialChecks(og, twitter);
  const fix = staticSocialFix({
    source: html, failing: Object.entries(checks).filter(([, check]) => check.status !== "pass").map(([id]) => id), origin: "https://zeytinlik.example", siteName: "Zeytinlik Restoran",
    facts: { title: "Zeytinlik Restoran | Foça", metaDescription: null, firstParagraph: "Foça sahilinde \"ev usulü\" mezeler, günlük balık ve zeytinyağlılar.", ogImage: null },
  });
  return { og, twitter, checks, fix };
}

if (/open-graph\.ts$/.test(process.argv[1] ?? "")) { const result = demo(); console.log(JSON.stringify({ ...result, fix: { ids: result.fix.ids, manual: result.fix.manual } }, null, 2)); console.log(`\n${result.fix.source}`); }
