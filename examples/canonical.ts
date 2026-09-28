/*
 * Example: canonical URLs — how a published page's canonical is built, how a client site
 * served from another primary domain rewrites it, and how the scanner and optimizer treat
 * canonical tags on existing sites.
 *
 * Demonstrates:
 *   - one canonical per page location: `${origin}${pathPrefix}/${slug}` (SEO page /rehber, blog
 *     /blog); slot locations (homepage, service page, footer) never get their own URL, so the
 *     same text is never indexable at two addresses,
 *   - the origin: the VERIFIED connection URL wins, otherwise the site's profile domain,
 *   - `rebase()`: the connector rewrites every absolute URL to ROISTATION_SITE_URL when the site
 *     answers on a different primary domain,
 *   - the `canonical` check (missing / duplicated / pointing at another host) and the static
 *     index.html fix (a single <link rel="canonical"> inserted before a single </head>).
 *
 * Source: lib/publishing/page-model.ts (siteOrigin, pagePath, getSitePage canonical),
 *         lib/publishing/definitions.ts (pagePathPrefix), connectors/roistation/client.ts
 *         (rebase), lib/seo/scanner.ts (canonical check), lib/seo/fixes.ts (insertBefore,
 *         static index canonical)
 *
 * Differences from production: `siteOriginFrom()` receives the stored connection and profile
 * domain instead of reading them; `rebase()` takes ROISTATION_SITE_URL as an argument; the
 * scanner check runs on the home page only (production also lists inner pages without one).
 * Next.js App Router sites get `alternates: { canonical: "/" }` through the layout metadata
 * fix shown in metadata.ts.
 */

const publishLocations = {
  "seo-page": { kind: "page", pathPrefix: "/rehber" },
  homepage: { kind: "slot" },
  blog: { kind: "page", pathPrefix: "/blog" },
  "service-page": { kind: "slot" },
  footer: { kind: "slot" },
} as const satisfies Record<string, { kind: "page" | "slot"; pathPrefix?: string }>;
export type PublishLocation = keyof typeof publishLocations;

/** lib/publishing/definitions.ts */
export function pagePathPrefix(location: PublishLocation): string | null {
  const definition: { kind: "page" | "slot"; pathPrefix?: string } = publishLocations[location];
  return definition.kind === "page" && definition.pathPrefix ? definition.pathPrefix : null;
}

/** lib/publishing/page-model.ts */
export const pagePath = (entry: { primary: PublishLocation; slug: string }) => {
  const prefix = pagePathPrefix(entry.primary);
  return prefix ? `${prefix}/${entry.slug}` : null;
};

/** siteOrigin(): a verified connection's origin, otherwise the profile domain (pages must still render). */
export function siteOriginFrom(connection: { site_url: string; verified: boolean } | undefined, profileDomain: string) {
  try { if (connection?.verified) return new URL(connection.site_url).origin; } catch { /* Fall back to the profile domain; pages must still render. */ }
  return `https://${profileDomain}`;
}

/** connectors/roistation/client.ts: rewrites absolute URLs to ROISTATION_SITE_URL when the site is served from a different primary domain. */
export function rebase<T>(value: T, from: string | undefined, siteUrl: string | null): T {
  if (!siteUrl || !from) return value;
  const origin = new URL(from).origin;
  return origin === siteUrl ? value : JSON.parse(JSON.stringify(value).split(origin).join(siteUrl)) as T;
}

/* ------------------------------------------------------------ scanner check */

const sameSite = (a: string, b: string) => a.replace(/^www\./, "") === b.replace(/^www\./, "");
const toUrl = (href: string, base: string) => { try { const url = new URL(href, base); url.hash = ""; return url; } catch { return null; } };

/** The canonical check for the home page: { status, finding }. */
export function canonicalCheck(pageUrl: string, canonical: string | null, canonicalCount: number) {
  const finalHost = new URL(pageUrl).hostname;
  const canonicalUrl = canonical ? toUrl(canonical, pageUrl) : null;
  return !canonical ? { status: "fail", finding: "Ana sayfada canonical etiketi yok." }
    : canonicalCount > 1 ? { status: "warn", finding: `Ana sayfada ${canonicalCount} canonical etiketi var.` }
    : canonicalUrl && !sameSite(canonicalUrl.hostname, finalHost) ? { status: "warn", finding: `Canonical başka bir alan adını gösteriyor: ${canonicalUrl.href}` }
    : { status: "pass", finding: `Canonical: ${canonicalUrl?.href}` };
}

/* ---------------------------------------------------------- static site fix */

/** Inserts before the marker only when it occurs exactly once; otherwise null (the change becomes a manual item). */
export function insertBefore(source: string, marker: RegExp, insertion: string) {
  const matches = source.match(new RegExp(marker.source, "gi"));
  if (!matches || matches.length !== 1) return null;
  return source.replace(marker, (found) => `${insertion}${found}`);
}

export function staticCanonicalFix(indexHtml: string, origin: string) {
  if (/rel=["']canonical/i.test(indexHtml)) return indexHtml;
  return insertBefore(indexHtml, /<\/head>/, `  ${`<link rel="canonical" href="${origin}/">`}\n`);
}

/* ------------------------------------------------------------------ demo */

export function demo() {
  const origin = siteOriginFrom({ site_url: "https://zeytinlik-restoran.vercel.app/", verified: true }, "zeytinlik.example");
  const path = pagePath({ primary: "seo-page", slug: "focada-en-iyi-balik" });
  const canonical = `${origin}${path}`;
  const page = { canonical, breadcrumbs: [{ name: "Ana sayfa", url: `${origin}/` }, { name: "Rehber", url: `${origin}/rehber` }] };
  return {
    origin, canonical,
    slotHasNoUrl: pagePath({ primary: "homepage", slug: "focada-en-iyi-balik" }),
    rebased: rebase(page, `${origin}/`, "https://zeytinlik.example"),
    checks: {
      missing: canonicalCheck("https://zeytinlik.example/", null, 0),
      otherHost: canonicalCheck("https://zeytinlik.example/", "https://zeytinlik-restoran.vercel.app/", 1),
      ok: canonicalCheck("https://www.zeytinlik.example/", "https://zeytinlik.example/", 1),
    },
    staticFix: staticCanonicalFix("<html><head><title>Zeytinlik Restoran</title>\n</head><body></body></html>", "https://zeytinlik.example"),
  };
}

if (/canonical\.ts$/.test(process.argv[1] ?? "")) console.log(JSON.stringify(demo(), null, 2));
