/*
 * Example: generating /llms.txt for a client site from a live SEO & GEO scan.
 *
 * Demonstrates:
 *   - the llms.txt body: business name, a one-line summary (the site's own meta description or
 *     first substantial paragraph), service area, the important pages with the REAL titles found
 *     by the scan, other discovered URLs, configured contact lines, and the sitemap URL,
 *   - that only reachable pages (status < 400) with a title are listed,
 *   - when the optimizer adds the file to a pull request: the `llms-txt` check is failing, the
 *     framework is known, and the repository does not already contain it
 *     (public/llms.txt for Next.js, llms.txt at the root for static sites).
 *
 * Source: lib/seo/fixes.ts (llmsText, planFixes framework detection + llms.txt step),
 *         lib/publishing/content.ts (truncate), lib/publishing/business.ts (areaServed)
 *
 * Differences from production: the scan and business profile are narrowed to the fields this
 * step reads, and the repository is an in-memory `RepoReader` instead of the GitHub tree.
 * In production the returned change is one of several files in a single optimization PR.
 */

export type BusinessProfile = { name: string; schemaType: string; locality?: string; region?: string; telephone?: string; email?: string; streetAddress?: string; postalCode?: string };
export type PageSummary = { url: string; status: number | null; title: string | null };
export type LlmsScan = {
  checks: { id: string; status: "pass" | "warn" | "fail" | "skip" }[];
  pages: PageSummary[];
  facts: { metaDescription: string | null; firstParagraph: string | null; discoveredUrls: string[] };
};
export type FileChange = { path: string; content: string; action: "create" | "update"; checkIds: string[]; description: string };
type RepoReader = { has: (file: string) => boolean; read: (file: string) => Promise<string | null> };

/** lib/publishing/content.ts */
export function truncate(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean.length <= max) return clean;
  return `${clean.slice(0, max - 1).replace(/\s+\S*$/, "").replace(/[,;:.\s]+$/, "")}…`;
}

/** lib/publishing/business.ts */
export function areaServed(profile: BusinessProfile) {
  return [profile.locality, profile.region].filter(Boolean).join(", ") || undefined;
}

const failing = (scan: LlmsScan, id: string) => scan.checks.some((check) => check.id === id && (check.status === "fail" || check.status === "warn"));
const first = (repo: RepoReader, candidates: string[]) => candidates.find((file) => repo.has(file)) || null;

export function llmsText(scan: LlmsScan, profile: BusinessProfile, origin: string) {
  const summary = scan.facts.metaDescription || (scan.facts.firstParagraph ? truncate(scan.facts.firstParagraph, 300) : null);
  const pages = scan.pages.filter((page) => page.status && page.status < 400 && page.title);
  const lines = [`# ${profile.name}`, "", ...(summary ? [`> ${summary}`, ""] : []),
    ...(areaServed(profile) ? [`Hizmet bölgesi: ${areaServed(profile)}`, ""] : []),
    "## Önemli sayfalar", `- [Ana sayfa](${origin}/)`, ...pages.filter((page) => new URL(page.url).pathname !== "/").map((page) => `- [${page.title}](${page.url})`),
    ...scan.facts.discoveredUrls.filter((url) => !pages.some((page) => page.url === url) && url !== `${origin}/`).slice(0, 20).map((url) => `- ${url}`), ""];
  const contact = [profile.telephone && `Telefon: ${profile.telephone}`, profile.email && `E-posta: ${profile.email}`, profile.streetAddress && `Adres: ${[profile.streetAddress, profile.postalCode, profile.locality, profile.region].filter(Boolean).join(", ")}`].filter(Boolean) as string[];
  if (contact.length) lines.push("## İletişim", ...contact.map((line) => `- ${line}`), "");
  lines.push(`Sitemap: ${origin}/sitemap.xml`, "");
  return lines.join("\n");
}

/** Framework detection exactly as planFixes() does it (App Router layout, Pages Router _app, or a static index.html). */
export function detectFramework(repo: RepoReader) {
  const layout = first(repo, ["app/layout.tsx", "app/layout.jsx", "app/layout.js", "app/layout.ts", "src/app/layout.tsx", "src/app/layout.jsx", "src/app/layout.js"]);
  const pagesApp = first(repo, ["pages/_app.tsx", "pages/_app.jsx", "pages/_app.js", "src/pages/_app.tsx", "src/pages/_app.js"]);
  const staticIndex = !layout && !pagesApp ? first(repo, ["index.html"]) : null;
  const framework: "next-app" | "next-pages" | "static" | "unknown" = layout ? "next-app" : pagesApp ? "next-pages" : staticIndex ? "static" : "unknown";
  return { framework, layout, publicDir: framework === "static" ? "" : "public/" };
}

/** The llms.txt step of planFixes(): returns the file change, or null when nothing should be written. */
export function planLlmsTxt(input: { scan: LlmsScan; repo: RepoReader; profile: BusinessProfile; origin: string }): FileChange | null {
  const { scan, repo, profile, origin } = input;
  const { framework, publicDir } = detectFramework(repo);
  if (failing(scan, "llms-txt") && framework !== "unknown" && !repo.has(`${publicDir}llms.txt`)) return { path: `${publicDir}llms.txt`, action: "create", checkIds: ["llms-txt"], description: "llms.txt: işletme özeti ve önemli sayfalar (taramadaki gerçek başlıklar).", content: llmsText(scan, profile, origin) };
  return null;
}

/* ------------------------------------------------------------------ demo */

export function demo() {
  const origin = "https://zeytinlik.example";
  const scan: LlmsScan = {
    checks: [{ id: "llms-txt", status: "fail" }],
    pages: [
      { url: `${origin}/`, status: 200, title: "Zeytinlik Restoran | Foça" },
      { url: `${origin}/rehber/focada-en-iyi-balik`, status: 200, title: "Foça'da En İyi Balık" },
      { url: `${origin}/eski-menu`, status: 404, title: null },
    ],
    facts: {
      metaDescription: "Foça'da deniz kenarında zeytinyağlı mezeler, günlük balık ve ev yapımı tatlılar.",
      firstParagraph: null,
      discoveredUrls: [`${origin}/`, `${origin}/rehber/focada-en-iyi-balik`, `${origin}/menu`, `${origin}/iletisim`],
    },
  };
  const files = new Set(["package.json", "app/layout.tsx", "app/page.tsx"]);
  const repo: RepoReader = { has: (file) => files.has(file), read: async () => null };
  const profile: BusinessProfile = { name: "Zeytinlik Restoran", schemaType: "Restaurant", locality: "Foça", region: "İzmir" };
  return planLlmsTxt({ scan, repo, profile, origin });
}

if (/llms-generator\.ts$/.test(process.argv[1] ?? "")) { const change = demo(); console.log(change ? `${change.path}\n\n${change.content}` : "no change"); }
