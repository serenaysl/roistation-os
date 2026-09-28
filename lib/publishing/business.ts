import { sites } from "@/lib/sites";

/*
 * Business identity used for Organization / LocalBusiness / Restaurant schema,
 * NAP boxes and geo signals. Base values come from lib/sites.ts; contact data
 * (phone, address, hours, geo, profiles, services) is taken ONLY from the
 * optional SITE_BUSINESS_JSON server variable — never invented, so NAP stays
 * consistent with Google Business Profile.
 */

export type BusinessService = { name: string; path: string };
export type BusinessProfile = {
  name: string;
  schemaType: string;
  locality?: string;
  region?: string;
  country: string;
  telephone?: string;
  email?: string;
  streetAddress?: string;
  postalCode?: string;
  openingHours?: string[];
  priceRange?: string;
  servesCuisine?: string[];
  latitude?: number;
  longitude?: number;
  mapsUrl?: string;
  sameAs?: string[];
  logo?: string;
  services?: BusinessService[];
};

const localTypes = new Set(["LocalBusiness","Restaurant","MedicalBusiness","Dentist","Physician","HousekeepingService","GeneralContractor","TravelAgency","ProfessionalService","LodgingBusiness","Hotel","Store","HealthAndBeautyBusiness","FoodEstablishment","CafeOrCoffeeShop","HomeAndConstructionBusiness","MedicalClinic"]);
export const isLocalBusinessType = (type: string) => localTypes.has(type);

const str = (value: unknown, max = 300) => (typeof value === "string" && value.trim() && value.length <= max ? value.trim() : undefined);
const strList = (value: unknown, max = 20) => (Array.isArray(value) ? value.map((item) => str(item)).filter((item): item is string => Boolean(item)).slice(0, max) : undefined);
const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const httpsUrl = (value: unknown) => { const text = str(value, 500); if (!text) return undefined; try { const url = new URL(text); return url.protocol === "https:" ? url.href : undefined; } catch { return undefined; } };

let cachedRaw: string | undefined;
let cachedOverrides: Record<string, Record<string, unknown>> = {};
function overrides() {
  const raw = process.env.SITE_BUSINESS_JSON || "";
  if (raw === cachedRaw) return cachedOverrides;
  cachedRaw = raw;
  try { const parsed = JSON.parse(raw || "{}"); cachedOverrides = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; }
  catch { console.error("[publishing] SITE_BUSINESS_JSON is not valid JSON; business contact data is ignored."); cachedOverrides = {}; }
  return cachedOverrides;
}

export function businessProfile(siteId: string): BusinessProfile | null {
  const site = sites.find((entry) => entry.id === siteId);
  if (!site) return null;
  const extra = overrides()[siteId] || {};
  const services = Array.isArray(extra.services)
    ? extra.services.flatMap((item: unknown) => {
      if (!item || typeof item !== "object") return [];
      const record = item as Record<string, unknown>;
      const name = str(record.name, 120); const path = str(record.path, 200);
      return name && path && path.startsWith("/") && !path.startsWith("//") ? [{ name, path }] : [];
    }).slice(0, 20)
    : undefined;
  return {
    name: str(extra.name, 160) || site.name,
    schemaType: str(extra.schemaType, 60) || site.business?.schemaType || "Organization",
    locality: str(extra.locality, 80) || site.business?.locality,
    region: str(extra.region, 80) || site.business?.region,
    country: str(extra.country, 2) || "TR",
    telephone: str(extra.telephone, 40),
    email: str(extra.email, 160),
    streetAddress: str(extra.streetAddress, 200),
    postalCode: str(extra.postalCode, 20),
    openingHours: strList(extra.openingHours, 14),
    priceRange: str(extra.priceRange, 20),
    servesCuisine: strList(extra.servesCuisine, 10),
    latitude: num(extra.latitude),
    longitude: num(extra.longitude),
    mapsUrl: httpsUrl(extra.mapsUrl),
    sameAs: strList(extra.sameAs, 10)?.map((value) => httpsUrl(value)).filter((value): value is string => Boolean(value)),
    logo: httpsUrl(extra.logo),
    services,
  };
}

/** Human "Ayvalık, Balıkesir" style area line, only from configured data. */
export function areaServed(profile: BusinessProfile) {
  return [profile.locality, profile.region].filter(Boolean).join(", ") || undefined;
}

export function directionsUrl(profile: BusinessProfile) {
  if (profile.mapsUrl) return profile.mapsUrl;
  if (profile.latitude !== undefined && profile.longitude !== undefined) return `https://www.google.com/maps/dir/?api=1&destination=${profile.latitude},${profile.longitude}`;
  if (profile.streetAddress) return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent([profile.name, profile.streetAddress, profile.locality, profile.region].filter(Boolean).join(", "))}`;
  return undefined;
}
