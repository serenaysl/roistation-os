/*
 * Dependency-free HTML extraction for the SEO scanner. It is tolerant of real-world
 * markup: it reads tags and attributes, never executes anything, and works on the
 * server-rendered HTML that search engines and AI crawlers actually receive.
 */

export type Tag = { name: string; attrs: Record<string, string> };
export type Heading = { level: number; text: string };
export type LinkRef = { href: string; text: string; rel: string };
export type ImageRef = { src: string; alt: string | null };
export type JsonLdBlock = { raw: string; data: unknown; error: string | null };

export type ParsedPage = {
  lang: string | null;
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  robotsMeta: string | null;
  viewport: string | null;
  canonical: string | null;
  canonicalCount: number;
  hreflang: string[];
  og: Record<string, string>;
  twitter: Record<string, string>;
  headings: Heading[];
  links: LinkRef[];
  images: ImageRef[];
  jsonLd: JsonLdBlock[];
  microdataTypes: string[];
  breadcrumbMarkup: boolean;
  text: string;
  wordCount: number;
  paragraphs: string[];
  lists: number;
  htmlBytes: number;
};

const entities: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
export function decodeEntities(value: string) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (match, code: string) => {
    const lower = code.toLowerCase();
    if (lower.startsWith("#x")) { const n = parseInt(lower.slice(2), 16); return Number.isFinite(n) ? String.fromCodePoint(n) : match; }
    if (lower.startsWith("#")) { const n = parseInt(lower.slice(1), 10); return Number.isFinite(n) ? String.fromCodePoint(n) : match; }
    return entities[lower] ?? match;
  });
}

const clean = (value: string) => decodeEntities(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();

export function parseAttrs(source: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source))) attrs[match[1].toLowerCase()] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  return attrs;
}

function tags(html: string, name: string): Tag[] {
  const result: Tag[] = [];
  const pattern = new RegExp(`<${name}\\b([^>]*)>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) result.push({ name, attrs: parseAttrs(match[1]) });
  return result;
}

function blocks(html: string, name: string): { attrs: Record<string, string>; inner: string }[] {
  const result: { attrs: Record<string, string>; inner: string }[] = [];
  const pattern = new RegExp(`<${name}\\b([^>]*)>([\\s\\S]*?)<\\/${name}>`, "gi");
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html))) result.push({ attrs: parseAttrs(match[1]), inner: match[2] });
  return result;
}

export function parseHtml(html: string): ParsedPage {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const head = /<head\b[^>]*>([\s\S]*?)<\/head>/i.exec(withoutComments)?.[1] ?? withoutComments;
  const metas = tags(head, "meta");
  const metaBy = (key: string, attr = "name") => metas.find((tag) => (tag.attrs[attr] || "").toLowerCase() === key)?.attrs.content ?? null;
  const og: Record<string, string> = {}; const twitter: Record<string, string> = {};
  for (const tag of metas) {
    const property = (tag.attrs.property || tag.attrs.name || "").toLowerCase();
    if (property.startsWith("og:") && tag.attrs.content) og[property.slice(3)] = tag.attrs.content;
    if (property.startsWith("twitter:") && tag.attrs.content) twitter[property.slice(8)] = tag.attrs.content;
  }
  const linkTags = tags(head, "link");
  const canonicals = linkTags.filter((tag) => (tag.attrs.rel || "").toLowerCase().split(/\s+/).includes("canonical"));
  const titles = blocks(head, "title");

  const scripts = blocks(withoutComments, "script");
  const jsonLd: JsonLdBlock[] = scripts.filter((script) => (script.attrs.type || "").toLowerCase().includes("ld+json")).map((script) => {
    const raw = script.inner.trim();
    try { return { raw, data: JSON.parse(raw), error: null }; }
    catch (error) { return { raw, data: null, error: error instanceof Error ? error.message : "JSON parse error" }; }
  });

  const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(withoutComments)?.[1] ?? withoutComments;
  const visible = body.replace(/<(script|style|noscript|svg|template)\b[\s\S]*?<\/\1>/gi, " ");
  const headings: Heading[] = [];
  const headingPattern = /<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi;
  let match: RegExpExecArray | null;
  while ((match = headingPattern.exec(visible))) headings.push({ level: Number(match[1]), text: clean(match[2]) });

  const links: LinkRef[] = blocks(visible, "a").map((anchor) => ({ href: anchor.attrs.href || "", text: clean(anchor.inner), rel: (anchor.attrs.rel || "").toLowerCase() })).filter((link) => link.href);
  const images: ImageRef[] = tags(visible, "img").map((tag) => ({ src: tag.attrs.src || tag.attrs["data-src"] || "", alt: "alt" in tag.attrs ? tag.attrs.alt : null }));
  const paragraphs = blocks(visible, "p").map((p) => clean(p.inner)).filter((text) => text.length > 0);
  const text = clean(visible);
  const microdataTypes = [...visible.matchAll(/itemtype=["']https?:\/\/schema\.org\/([A-Za-z]+)["']/gi)].map((m) => m[1]);
  const htmlLang = /<html\b([^>]*)>/i.exec(withoutComments);

  return {
    lang: htmlLang ? parseAttrs(htmlLang[1]).lang || null : null,
    title: titles[0] ? clean(titles[0].inner) : null,
    titleCount: titles.length,
    metaDescription: metaBy("description"),
    robotsMeta: metaBy("robots") ?? metaBy("googlebot"),
    viewport: metaBy("viewport"),
    canonical: canonicals[0]?.attrs.href || null,
    canonicalCount: canonicals.length,
    hreflang: linkTags.filter((tag) => (tag.attrs.rel || "").toLowerCase() === "alternate" && tag.attrs.hreflang).map((tag) => tag.attrs.hreflang),
    og, twitter, headings, links, images, jsonLd, microdataTypes,
    breadcrumbMarkup: /aria-label=["'][^"']*(breadcrumb|sayfa konumu)[^"']*["']/i.test(visible) || microdataTypes.includes("BreadcrumbList"),
    text,
    wordCount: text.split(/\s+/).filter(Boolean).length,
    paragraphs,
    lists: (visible.match(/<(ul|ol)\b/gi) || []).length,
    htmlBytes: html.length,
  };
}

/** All schema.org nodes in the JSON-LD blocks, flattened across @graph and arrays. */
export function schemaNodes(blocksList: JsonLdBlock[]): Record<string, unknown>[] {
  const nodes: Record<string, unknown>[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    if (record["@type"]) nodes.push(record);
    if (record["@graph"]) visit(record["@graph"]);
  };
  for (const block of blocksList) if (block.data) visit(block.data);
  return nodes;
}
export const typesOf = (node: Record<string, unknown>) => (Array.isArray(node["@type"]) ? node["@type"] : [node["@type"]]).filter((type): type is string => typeof type === "string");

/** Parses robots.txt into user-agent groups. */
export function parseRobots(text: string) {
  const groups: { agents: string[]; allow: string[]; disallow: string[] }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; allow: string[]; disallow: string[] } | null = null;
  let lastWasAgent = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    if (!line) continue;
    const separator = line.indexOf(":"); if (separator < 0) continue;
    const key = line.slice(0, separator).trim().toLowerCase(); const value = line.slice(separator + 1).trim();
    if (key === "sitemap") { sitemaps.push(value); continue; }
    if (key === "user-agent") {
      if (!current || !lastWasAgent) { current = { agents: [], allow: [], disallow: [] }; groups.push(current); }
      current.agents.push(value.toLowerCase()); lastWasAgent = true; continue;
    }
    lastWasAgent = false;
    if (!current) continue;
    if (key === "allow") current.allow.push(value);
    if (key === "disallow") current.disallow.push(value);
  }
  return { groups, sitemaps };
}

/** Whether a path is blocked for a crawler (longest match wins, Allow beats Disallow on ties). */
export function robotsBlocks(robots: ReturnType<typeof parseRobots>, agent: string, path: string) {
  const group = robots.groups.find((item) => item.agents.includes(agent.toLowerCase())) || robots.groups.find((item) => item.agents.includes("*"));
  if (!group) return false;
  const matchLength = (rule: string) => {
    if (!rule) return -1;
    const pattern = new RegExp(`^${rule.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$")}`);
    return pattern.test(path) ? rule.length : -1;
  };
  const allow = Math.max(-1, ...group.allow.map(matchLength));
  const disallow = Math.max(-1, ...group.disallow.map(matchLength));
  return disallow > allow;
}

export function sitemapLocs(xml: string) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => decodeEntities(match[1]));
}
