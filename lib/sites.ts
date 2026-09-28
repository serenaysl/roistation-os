export type SiteProfile = {
  id: string;
  name: string;
  project: string;
  domain: string;
  sector: string;
  initials: string;
  color: string;
  vercel: "READY" | "BUILDING";
  connector: "active" | "pending";
  /** schema.org business type and locality stated by the business name/domain. NAP details come from SITE_BUSINESS_JSON. */
  business?: { schemaType: string; locality?: string; region?: string };
  /** "vercel" = imported from the connected Vercel account; absent = built-in profile. */
  source?: "static" | "vercel";
  vercelProjectId?: string;
};

/**
 * Demo catalog used when no catalog is configured (local development, previews,
 * the public repository). Fictional businesses on reserved `.example` domains.
 */
export const demoSites: SiteProfile[] = [
  { id: "roistation", name: "ROIstation", project: "roistation-site", domain: "roistation.example", sector: "Dijital ajans", initials: "ROI", color: "#72f5bf", vercel: "READY", connector: "pending", business: { schemaType: "ProfessionalService" } },
  { id: "kiyi-dis", name: "Kıyı Diş Kliniği", project: "kiyi-dis-klinigi", domain: "kiyidis.example", sector: "Sağlık", initials: "KD", color: "#63d7ff", vercel: "READY", connector: "pending", business: { schemaType: "Dentist", locality: "Urla", region: "İzmir" } },
  { id: "liman-temizlik", name: "Liman Temizlik", project: "liman-temizlik", domain: "limantemizlik.example", sector: "Temizlik", initials: "LT", color: "#a6ef74", vercel: "READY", connector: "pending", business: { schemaType: "HousekeepingService", locality: "Çeşme", region: "İzmir" } },
  { id: "zeytinlik-restoran", name: "Zeytinlik Restoran", project: "zeytinlik-restoran", domain: "zeytinlik.example", sector: "Restoran", initials: "ZR", color: "#ffb45e", vercel: "READY", connector: "pending", business: { schemaType: "Restaurant", locality: "Foça", region: "İzmir" } },
  { id: "atlas-yapi", name: "Atlas Yapı", project: "atlas-yapi", domain: "atlas-yapi.vercel.app", sector: "İnşaat", initials: "AY", color: "#ffd45f", vercel: "READY", connector: "pending", business: { schemaType: "GeneralContractor" } },
  { id: "konak-otel", name: "Konak Otel Rezervasyon", project: "konak-otel-rezervasyon", domain: "konak-otel-rezervasyon.vercel.app", sector: "Otel SaaS", initials: "KO", color: "#b9a3ff", vercel: "READY", connector: "pending", business: { schemaType: "Organization" } },
  { id: "mavi-koy-turizm", name: "Mavi Koy Turizm", project: "mavi-koy-turizm", domain: "mavi-koy-turizm.vercel.app", sector: "Turizm", initials: "MK", color: "#5fe4dd", vercel: "READY", connector: "pending", business: { schemaType: "TravelAgency", locality: "Bodrum", region: "Muğla" } },
  { id: "denge-danismanlik", name: "Denge Danışmanlık", project: "denge-danismanlik", domain: "dengedanismanlik.example", sector: "Koçluk & danışmanlık", initials: "DD", color: "#fa96c4", vercel: "READY", connector: "pending", business: { schemaType: "ProfessionalService" } },
];

const siteColors = ["#72f5bf", "#63d7ff", "#a6ef74", "#ffb45e", "#ffd45f", "#b9a3ff", "#5fe4dd", "#fa96c4"];

/**
 * The agency's own catalog comes from NEXT_PUBLIC_ROISTATION_SITES (a JSON array),
 * so client names and domains live in deployment config, not in source control.
 * The value is read on both the server and the panel, which is why it is public;
 * it holds names and domains only, never credentials. Invalid entries are skipped.
 */
export function parseSiteCatalog(raw: string | undefined): SiteProfile[] | null {
  if (!raw?.trim()) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return null;
    const seen = new Set<string>();
    const catalog = value.flatMap((entry, index): SiteProfile[] => {
      if (!entry || typeof entry !== "object") return [];
      const item = entry as Partial<SiteProfile>;
      if (typeof item.id !== "string" || !/^[a-z0-9-]{2,60}$/.test(item.id) || seen.has(item.id)) return [];
      if (typeof item.name !== "string" || typeof item.domain !== "string" || !item.name.trim() || !item.domain.trim()) return [];
      seen.add(item.id);
      const words = item.name.trim().split(/\s+/);
      return [{
        id: item.id,
        name: item.name.trim(),
        project: typeof item.project === "string" && item.project ? item.project : item.id,
        domain: item.domain.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, ""),
        sector: typeof item.sector === "string" ? item.sector : "",
        initials: typeof item.initials === "string" && item.initials ? item.initials : (words.length > 1 ? words.slice(0, 2).map((word) => word[0]).join("") : item.name.slice(0, 2)).toLocaleUpperCase("tr-TR"),
        color: typeof item.color === "string" && /^#[0-9a-f]{6}$/i.test(item.color) ? item.color : siteColors[index % siteColors.length],
        vercel: "READY",
        connector: "pending",
        business: item.business && typeof item.business.schemaType === "string" ? item.business : { schemaType: "Organization" },
      }];
    });
    return catalog.length ? catalog : null;
  } catch {
    console.error("[sites] NEXT_PUBLIC_ROISTATION_SITES is not valid JSON; using the demo catalog");
    return null;
  }
}

/** Built-in site profiles (never removed): the configured catalog, or the demo catalog. */
export const baseSites: SiteProfile[] = parseSiteCatalog(process.env.NEXT_PUBLIC_ROISTATION_SITES) ?? demoSites;

/**
 * Live site list: built-in profiles + projects imported from Vercel. Existing code
 * keeps reading `sites`; the registry (lib/site-registry.ts on the server, /api/sites
 * in the panel) refreshes it in place. Archived projects are left out, their
 * publications, forms and history stay untouched in storage.
 */
export const sites: SiteProfile[] = [...baseSites];

export function applySiteRegistry(imported: SiteProfile[]) {
  const known = new Set(baseSites.map((site) => site.id));
  const extra = imported.filter((site) => !known.has(site.id) && /^[a-z0-9-]{2,60}$/.test(site.id));
  sites.splice(0, sites.length, ...baseSites, ...extra);
  return sites;
}

/** Profile for a project imported from Vercel. */
export function importedSiteProfile(input: { id: string; name: string; project: string; domain: string; framework?: string | null; vercelProjectId: string }): SiteProfile {
  const words = input.name.replace(/[-_]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const initials = (words.length > 1 ? words.slice(0, 3).map((word) => word[0]) : [input.name.slice(0, 2)]).join("").toUpperCase() || "RS";
  let hash = 0; for (const char of input.id) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return { id: input.id, name: input.name, project: input.project, domain: input.domain, sector: input.framework ? `Vercel · ${input.framework}` : "Vercel projesi", initials, color: siteColors[hash % siteColors.length], vercel: "READY", connector: "pending", business: { schemaType: "Organization" }, source: "vercel", vercelProjectId: input.vercelProjectId };
}

/**
 * Vercel projects that are never auto-imported, auto-verified or published to by default
 * (comma separated NEXT_PUBLIC_ROISTATION_EXCLUDED_PROJECTS, e.g. internal tools).
 * An admin can still connect one explicitly from the Vercel screen.
 */
export const excludedProjects: string[] = (process.env.NEXT_PUBLIC_ROISTATION_EXCLUDED_PROJECTS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
