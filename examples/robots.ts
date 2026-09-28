/*
 * Example: robots.txt — parsing, crawl decisions for search and AI crawlers, and the
 * conservative fix the optimizer proposes in a pull request.
 *
 * Demonstrates:
 *   - `parseRobots()`: user-agent groups (consecutive User-agent lines share one group),
 *     Allow / Disallow rules, Sitemap lines, comments stripped,
 *   - `robotsBlocks()`: the most specific group wins, then the longest matching rule; Allow wins
 *     ties; `*` and a trailing `$` are supported,
 *   - the four robots checks, including AI crawlers (GPTBot, ClaudeBot, PerplexityBot,
 *     Google-Extended): warn when some are blocked, fail when all are,
 *   - `planRobots()`: a MISSING robots.txt is created (app/robots.ts on the Next.js App Router,
 *     public/robots.txt otherwise, root robots.txt for static sites); an existing file only ever
 *     gets a Sitemap line appended. Blocking rules are never edited automatically — they may be
 *     deliberate — and become manual items in the pull request.
 *
 * Source: lib/seo/html.ts (parseRobots, robotsBlocks), lib/seo/scanner.ts (robots checks,
 *         AI_BOTS), lib/seo/fixes.ts (planFixes robots.txt step, framework detection)
 *
 * Differences from production: checks return { status, finding, evidence } instead of catalogue
 * CheckResult objects; the repository is an in-memory reader instead of the GitHub tree.
 */

/* ----------------------------------------------------------- lib/seo/html.ts */

export type Robots = ReturnType<typeof parseRobots>;

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
export function robotsBlocks(robots: Robots, agent: string, path: string) {
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

/* -------------------------------------------------------- lib/seo/scanner.ts */

const AI_BOTS = ["gptbot", "claudebot", "perplexitybot", "google-extended"];
type Finding = { status: "pass" | "warn" | "fail"; finding: string; evidence?: string[] };

/** robots-txt, robots-allows, ai-crawlers and sitemap-in-robots for a fetched robots.txt (`body` null = not found). */
export function robotsChecks(body: string | null, httpStatus: number | null): Record<string, Finding> {
  const robotsFound = body !== null && !/<html/i.test(body.slice(0, 500));
  const robots = robotsFound ? parseRobots(body!) : null;
  const checks: Record<string, Finding> = {};
  checks["robots-txt"] = robotsFound ? { status: "pass", finding: "robots.txt bulundu." } : { status: "fail", finding: `robots.txt bulunamadı (HTTP ${httpStatus ?? "—"}).` };
  if (robots) {
    const blocked = robotsBlocks(robots, "googlebot", "/");
    checks["robots-allows"] = blocked ? { status: "fail", finding: "robots.txt ana sayfanın taranmasını engelliyor (Disallow: /)." } : { status: "pass", finding: "robots.txt ana sayfanın taranmasına izin veriyor." };
    const blockedBots = AI_BOTS.filter((bot) => robotsBlocks(robots, bot, "/"));
    checks["ai-crawlers"] = blockedBots.length ? { status: blockedBots.length === AI_BOTS.length ? "fail" : "warn", finding: `Engellenen AI tarayıcıları: ${blockedBots.join(", ")}.`, evidence: blockedBots } : { status: "pass", finding: "GPTBot, ClaudeBot, PerplexityBot ve Google-Extended engellenmiyor." };
    checks["sitemap-in-robots"] = robots.sitemaps.length ? { status: "pass", finding: `robots.txt sitemap bildiriyor: ${robots.sitemaps[0]}` } : { status: "fail", finding: "robots.txt içinde Sitemap satırı yok." };
  } else {
    checks["robots-allows"] = { status: "pass", finding: "robots.txt yok; varsayılan olarak tüm tarayıcılara açık." };
    checks["ai-crawlers"] = { status: "pass", finding: "robots.txt yok; AI tarayıcıları engellenmiyor." };
    checks["sitemap-in-robots"] = { status: "fail", finding: "robots.txt olmadığı için sitemap bildirilmiyor." };
  }
  return checks;
}

/* ---------------------------------------------------------- lib/seo/fixes.ts */

export type FileChange = { path: string; content: string; action: "create" | "update"; checkIds: string[]; description: string };
export type ManualItem = { checkId: string; description: string };
type RepoReader = { has: (file: string) => boolean; read: (file: string) => Promise<string | null> };
const first = (repo: RepoReader, candidates: string[]) => candidates.find((file) => repo.has(file)) || null;

export async function planRobots(input: { checks: Record<string, Finding>; repo: RepoReader; origin: string }) {
  const { repo, origin } = input;
  const failing = (id: string) => input.checks[id]?.status === "fail" || input.checks[id]?.status === "warn";
  const files: FileChange[] = []; const manual: ManualItem[] = [];
  const layout = first(repo, ["app/layout.tsx", "app/layout.jsx", "app/layout.js", "app/layout.ts", "src/app/layout.tsx", "src/app/layout.jsx", "src/app/layout.js"]);
  const appDir = layout ? layout.slice(0, layout.lastIndexOf("/")) : null;
  const pagesApp = first(repo, ["pages/_app.tsx", "pages/_app.jsx", "pages/_app.js", "src/pages/_app.tsx", "src/pages/_app.js"]);
  const staticIndex = !layout && !pagesApp ? first(repo, ["index.html"]) : null;
  const framework = layout ? "next-app" : pagesApp ? "next-pages" : staticIndex ? "static" : "unknown";
  const ts = layout ? /\.tsx?$/.test(layout) : true;
  const publicDir = framework === "static" ? "" : "public/";

  const robotsFile = first(repo, [`${publicDir}robots.txt`]);
  const robotsCode = appDir ? first(repo, ["ts", "js"].map((ext) => `${appDir}/robots.${ext}`)) : null;
  if (failing("robots-txt") && !robotsFile && !robotsCode) {
    if (appDir) files.push({ path: `${appDir}/robots.${ts ? "ts" : "js"}`, action: "create", checkIds: ["robots-txt", "sitemap-in-robots"], description: "robots.txt: tüm tarayıcılara açık, sitemap bildirimi.", content: `${ts ? 'import type { MetadataRoute } from "next";\n\n' : ""}export default function robots()${ts ? ": MetadataRoute.Robots" : ""} {\n  return { rules: [{ userAgent: "*", allow: "/" }], sitemap: "${origin}/sitemap.xml", host: "${origin}" };\n}\n` });
    else if (framework !== "unknown") files.push({ path: `${publicDir}robots.txt`, action: "create", checkIds: ["robots-txt", "sitemap-in-robots"], description: "robots.txt: tüm tarayıcılara açık, sitemap bildirimi.", content: `User-agent: *\nAllow: /\n\nSitemap: ${origin}/sitemap.xml\n` });
  } else if (failing("sitemap-in-robots") && robotsFile) {
    const current = await repo.read(robotsFile);
    if (current !== null && !/^sitemap:/im.test(current)) files.push({ path: robotsFile, action: "update", checkIds: ["sitemap-in-robots"], description: "robots.txt dosyasına Sitemap satırı eklendi.", content: `${current.replace(/\s*$/, "")}\n\nSitemap: ${origin}/sitemap.xml\n` });
  }
  if (failing("robots-allows")) manual.push({ checkId: "robots-allows", description: "robots.txt ana sayfayı engelliyor. Mevcut kurallar bilinçli olabileceği için otomatik değiştirilmedi; genel `Disallow: /` kuralını kaldırın." });
  if (failing("ai-crawlers")) manual.push({ checkId: "ai-crawlers", description: `AI tarayıcıları engelleniyor (${input.checks["ai-crawlers"]?.evidence?.join(", ")}). Bilinçli tercih değilse robots.txt'den kaldırın.` });
  return { framework, files, manual };
}

/* ------------------------------------------------------------------ demo */

export async function demo() {
  const existing = "User-agent: *\nDisallow: /admin\nAllow: /admin/public$\n\nUser-agent: GPTBot\nUser-agent: ClaudeBot\nDisallow: /\n";
  const parsed = parseRobots(existing);
  const checks = robotsChecks(existing, 200);
  const files = new Map([["public/robots.txt", existing], ["app/layout.tsx", ""]]);
  const repo: RepoReader = { has: (file) => files.has(file), read: async (file) => files.get(file) ?? null };
  const withRobots = await planRobots({ checks, repo, origin: "https://zeytinlik.example" });
  const bare: RepoReader = { has: (file) => file === "app/layout.tsx", read: async () => "" };
  const missing = await planRobots({ checks: robotsChecks(null, 404), repo: bare, origin: "https://zeytinlik.example" });
  return {
    groups: parsed.groups,
    decisions: { "googlebot /": robotsBlocks(parsed, "googlebot", "/"), "googlebot /admin/x": robotsBlocks(parsed, "googlebot", "/admin/x"), "googlebot /admin/public": robotsBlocks(parsed, "googlebot", "/admin/public"), "claudebot /": robotsBlocks(parsed, "ClaudeBot", "/") },
    checks, withRobots, missing,
  };
}

if (/(^|[\\/])robots\.ts$/.test(process.argv[1] ?? "")) demo().then((result) => console.log(JSON.stringify(result, null, 2)));
