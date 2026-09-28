/*
 * Example: the publish decision for one piece of content going to several client sites.
 *
 * Demonstrates:
 *   - the publishing vocabulary: locations (SEO page /rehber/<slug>, blog, homepage, service
 *     page, footer), strategies and scopes, with legacy rows defaulting to an SEO page,
 *   - placement validation (service-page paths are normalised, anything else is rejected),
 *   - SEO-friendly slugs with Turkish transliteration and per-site uniqueness,
 *   - the publish channel contract: every site is evaluated independently, so one unverified
 *     site never blocks the others; with the "all connected sites" scope unverified sites are
 *     SKIPPED with a warning instead of failing,
 *   - scheduled publishing (`scheduled` becomes effectively `published` once the time passes)
 *     and the history entries written for the operation.
 *
 * Source: lib/publication-service.ts (createPublishedPublication, validatePlacement,
 *         assignSlugs, parseSchedule, placementLabel), lib/publishing/channels.ts,
 *         lib/publishing/definitions.ts, lib/publishing/page-model.ts (uniqueSlug),
 *         lib/publications.ts (types, effectiveStatus)
 *
 * Differences from production: `planPublish()` is the pure core of createPublishedPublication().
 * Production additionally validates the payload, re-verifies stale site connections
 * (preflightSites), reads taken slugs from storage, inserts the record into the private Blob
 * store (create-only) and writes activity-log events. Registries keep only the fields used here;
 * the slug-conflict message names the site id instead of looking up the site's display name.
 */

export class ApiError extends Error { constructor(message: string, public status = 400) { super(message); } }

/* ------------------------------------------------------- lib/publications.ts */

export type Payload = { title: string; body: string; summary?: string; metaTitle?: string; metaDescription?: string };
export type TargetState = "draft" | "published" | "scheduled" | "withdrawn" | "deleted" | "failed";
export type Target = { status: TargetState; payload: Payload | null; detail?: string; scheduledAt?: string | null; slug?: string };
export type PublicationEvent = { at: string; action: string; siteIds: string[]; detail?: string };
export type Connection = { site_id: string; site_url: string; verified: boolean; verified_at: string; detail: string };

export function effectiveStatus(target: Target): TargetState {
  return target.status === "scheduled" && target.scheduledAt && Date.parse(target.scheduledAt) <= Date.now() ? "published" : target.status;
}

/* ---------------------------------------- lib/publishing/definitions.ts (trimmed) */

export const publishLocations = {
  "seo-page": { label: "SEO sayfası", kind: "page", pathPrefix: "/rehber" },
  homepage: { label: "Ana sayfa", kind: "slot" },
  blog: { label: "Blog", kind: "page", pathPrefix: "/blog" },
  "service-page": { label: "Hizmet sayfası", kind: "slot" },
  footer: { label: "Footer (iletişimden önce)", kind: "slot" },
} as const satisfies Record<string, { label: string; kind: "page" | "slot"; pathPrefix?: string }>;
export type PublishLocation = keyof typeof publishLocations;

export const publishStrategies = {
  seo: { label: "Sadece SEO", homepageTeaser: false },
  "seo-geo": { label: "SEO + GEO", homepageTeaser: false },
  "local-business": { label: "Yerel işletme", homepageTeaser: false },
  blog: { label: "Blog stratejisi", homepageTeaser: false },
  "homepage-enhancement": { label: "Ana sayfa güçlendirme", homepageTeaser: true },
  "ai-answer": { label: "AI cevap odaklı", homepageTeaser: false },
} as const satisfies Record<string, { label: string; homepageTeaser: boolean }>;
export type PublishStrategy = keyof typeof publishStrategies;

export const publishScopes = {
  current: { label: "Yalnız bu site" },
  selected: { label: "Seçili siteler" },
  "all-connected": { label: "Tüm bağlı siteler" },
} as const;
export type PublishScope = keyof typeof publishScopes;

export type Placement = { location: PublishLocation; strategy: PublishStrategy; servicePath?: string | null };
export const defaultPlacement: Placement = { location: "seo-page", strategy: "seo" };

export const isPublishLocation = (value: unknown): value is PublishLocation => typeof value === "string" && Object.prototype.hasOwnProperty.call(publishLocations, value);
export const isPublishStrategy = (value: unknown): value is PublishStrategy => typeof value === "string" && Object.prototype.hasOwnProperty.call(publishStrategies, value);
export const isPublishScope = (value: unknown): value is PublishScope => typeof value === "string" && Object.prototype.hasOwnProperty.call(publishScopes, value);

/** Legacy publications (no placement) become SEO pages; the homepage stays clean. */
export function resolvePlacement(placement?: Partial<Placement> | null): Placement {
  const location = isPublishLocation(placement?.location) ? placement.location : defaultPlacement.location;
  const strategy = isPublishStrategy(placement?.strategy) ? placement.strategy : defaultPlacement.strategy;
  return { location, strategy, servicePath: location === "service-page" ? placement?.servicePath || null : null };
}

/** The single location where the FULL content renders (no duplicate content). */
export function primaryLocation(placement: Placement): PublishLocation {
  if (publishStrategies[placement.strategy].homepageTeaser && placement.location === "homepage") return "seo-page";
  return placement.location;
}
export function showsHomepageTeaser(placement: Placement) {
  return publishStrategies[placement.strategy].homepageTeaser && publishLocations[primaryLocation(placement)].kind === "page";
}

/** Normalizes a service page path entered by the user ("hizmetler/boya/" -> "/hizmetler/boya"). */
export function normalizeServicePath(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  let path = trimmed;
  try { if (/^https?:\/\//i.test(trimmed)) path = new URL(trimmed).pathname; } catch { return null; }
  path = `/${path.replace(/^\/+/, "").replace(/\/+$/, "")}`.toLowerCase();
  if (path.length > 200 || !/^\/[a-z0-9\-_/.%]*$/.test(path) || path.includes("..")) return null;
  return path;
}

const turkishMap: Record<string, string> = { ç: "c", Ç: "c", ğ: "g", Ğ: "g", ı: "i", I: "i", İ: "i", ö: "o", Ö: "o", ş: "s", Ş: "s", ü: "u", Ü: "u", â: "a", Â: "a", î: "i", Î: "i", û: "u", Û: "u" };

/** SEO friendly slug with correct Turkish transliteration ("Foça'da En İyi Balık" -> "focada-en-iyi-balik"). */
export function slugify(value: string, maxLength = 80): string {
  const ascii = value
    .replace(/[çÇğĞıIİöÖşŞüÜâÂîÎûÛ]/g, (char) => turkishMap[char] || char)
    .normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`]/g, "")
    .replace(/&/g, " ve ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (ascii.length <= maxLength) return ascii;
  const cut = ascii.slice(0, maxLength);
  return (cut.includes("-") ? cut.slice(0, cut.lastIndexOf("-")) : cut).replace(/-+$/g, "");
}
export const isValidSlug = (value: unknown): value is string => typeof value === "string" && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 120;

/* ------------------------------------------------ lib/publishing/page-model.ts */

export function uniqueSlug(base: string, taken: Set<string>, fallback: string) {
  const clean = slugify(base) || fallback;
  if (!taken.has(clean)) return clean;
  for (let n = 2; n < 1000; n++) { const candidate = `${clean.slice(0, 76)}-${n}`; if (!taken.has(candidate)) return candidate; }
  return `${clean.slice(0, 70)}-${fallback.slice(0, 8)}`;
}

/* -------------------------------------------------- lib/publishing/channels.ts */

export type ChannelAction = "publish" | "withdraw" | "delete";
export type ChannelOutcome = { siteId: string; success: boolean; status: TargetState; detail: string; skipped?: boolean };
export type ChannelContext = { siteId: string; action: ChannelAction; scheduledAt: string | null; scope?: PublishScope; current?: Target; connection?: Connection; effectiveStatus?: TargetState };
export interface PublishChannel { id: string; label: string; requiresConnection: boolean; evaluate(context: ChannelContext): ChannelOutcome }

export const siteFeedChannel: PublishChannel = {
  id: "site-feed",
  label: "Site yayın alanı ve SEO sayfaları",
  requiresConnection: true,
  evaluate({ siteId, action, scheduledAt, scope, current, connection, effectiveStatus }) {
    if (action !== "publish") return { siteId, success: true, status: action === "delete" ? "deleted" : "withdrawn", detail: action === "delete" ? "Merkezi yayın içeriği bu siteden silindi; diğer siteler değişmedi." : "Yayın alanından kaldırıldı; içerik taslağı korundu." };
    const keep: TargetState = current ? (effectiveStatus === "published" ? current.status : "failed") : "failed";
    if (!connection || !connection.verified) {
      const reason = !connection ? "Bağlantı kurulmadı. Siteler ekranından yayın alanını doğrula." : connection.detail || "Bağlantı doğrulanmadı. Siteler ekranından bağlantıyı doğrula.";
      // "All connected sites": unverified sites are skipped with a warning, not failed.
      if (scope === "all-connected") return { siteId, success: false, skipped: true, status: current?.status ?? "draft", detail: `Doğrulanmamış site atlandı. ${reason}` };
      return { siteId, success: false, status: keep, detail: reason };
    }
    return { siteId, success: true, status: scheduledAt ? "scheduled" : "published", detail: scheduledAt ? "Zamanlı merkezi yayına alındı. Tarih geldiğinde yayın alanı otomatik gösterir." : "Doğrulanmış sitenin merkezi yayın alanında aktif." };
  },
};

/* ------------------------------------------------- lib/publication-service.ts */

export function parseSchedule(value: unknown): string | null {
  if (!value) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value)) || Date.parse(value) <= Date.now()) throw new ApiError("Gelecekteki bir yayın tarihi seç.");
  return new Date(value).toISOString();
}

/** Publish location + AI publish strategy. Missing input keeps the default (SEO page, SEO only). */
export function validatePlacement(input: unknown): Placement {
  if (input === undefined || input === null) return { ...defaultPlacement };
  if (typeof input !== "object") throw new ApiError("Yayın yeri geçersiz.");
  const p = input as Record<string, unknown>;
  if (!isPublishLocation(p.location)) throw new ApiError("Yayın yeri geçersiz.");
  if (!isPublishStrategy(p.strategy)) throw new ApiError("AI yayın stratejisi geçersiz.");
  if (p.location !== "service-page") return { location: p.location, strategy: p.strategy };
  if (p.servicePath === undefined || p.servicePath === null || p.servicePath === "") return { location: p.location, strategy: p.strategy };
  const servicePath = normalizeServicePath(p.servicePath);
  if (!servicePath) throw new ApiError("Hizmet sayfası yolu geçersiz. Örnek: /hizmetler/dis-cephe");
  return { location: p.location, strategy: p.strategy, servicePath };
}

export const placementLabel = (placement: Placement) => `${publishLocations[placement.location].label} · ${publishStrategies[placement.strategy].label}${placement.servicePath ? ` · ${placement.servicePath}` : ""}`;

/** assignSlugs(): requested slugs are validated; otherwise one is derived from the site-specific title. */
export function assignSlugs(id: string, targets: Record<string, Target>, siteIds: string[], taken: Record<string, Set<string>>, requested?: unknown) {
  const wanted = requested && typeof requested === "object" ? requested as Record<string, unknown> : {};
  for (const siteId of siteIds) {
    const target = targets[siteId]; if (!target?.payload) continue;
    const request = wanted[siteId];
    if (typeof request === "string" && request.trim()) {
      const slug = request.trim().toLowerCase();
      if (!isValidSlug(slug)) throw new ApiError("URL kısa adı yalnız küçük harf, rakam ve tire içerebilir (ör. foca-balik-restorani).");
      if (taken[siteId].has(slug)) throw new ApiError(`"${slug}" adresi ${siteId} sitesinde başka bir yayında kullanılıyor.`, 409);
      target.slug = slug;
    } else if (!isValidSlug(target.slug)) target.slug = uniqueSlug(target.payload.title, taken[siteId], id.slice(0, 8));
    taken[siteId].add(target.slug!);
  }
}

/** Pure core of createPublishedPublication(): per-site outcomes, target states and history. */
export function planPublish(input: { id: string; title: string; siteIds: string[]; payload: Payload; placement?: unknown; scope?: PublishScope; scheduleAt?: string | null; connections: Connection[]; taken: Record<string, Set<string>>; slugs?: unknown }) {
  const ids = [...new Set(input.siteIds)];
  const scheduledAt = parseSchedule(input.scheduleAt); const scope = input.scope; const placement = validatePlacement(input.placement);
  if (scope === "current" && ids.length !== 1) throw new ApiError("\"Yalnız bu site\" hedefi için tek site seç.");
  const targets: Record<string, Target> = {};
  for (const siteId of ids) targets[siteId] = { status: "draft", payload: input.payload };
  assignSlugs(input.id, targets, ids, input.taken, input.slugs);
  // Each site is evaluated independently: one failing site never stops the others.
  const outcomes = ids.map((siteId) => siteFeedChannel.evaluate({ siteId, action: "publish", scheduledAt, scope, connection: input.connections.find((c) => c.site_id === siteId) }));
  const now = new Date().toISOString();
  for (const outcome of outcomes) { const target = targets[outcome.siteId]; target.status = outcome.status; target.detail = outcome.detail; if (outcome.success) target.scheduledAt = scheduledAt; }
  const live = outcomes.filter((outcome) => outcome.success).map((outcome) => outcome.siteId);
  const skipped = outcomes.filter((outcome) => outcome.skipped).length;
  const events: PublicationEvent[] = [{ at: now, action: "created", siteIds: ids, detail: placementLabel(placement) }, { at: now, action: scheduledAt ? "scheduled" : "published", siteIds: live.length ? live : ids, detail: scheduledAt ? `Planlanan zaman: ${scheduledAt}` : skipped ? `${skipped} doğrulanmamış site atlandı` : undefined }];
  return { document: { id: input.id, title: input.title, kind: "content" as const, createdAt: now, updatedAt: now, targets, events, placement }, results: outcomes };
}

/* ------------------------------------------------------------------ demo */

export function demo() {
  const verified: Connection = { site_id: "zeytinlik-restoran", site_url: "https://zeytinlik.example/", verified: true, verified_at: new Date().toISOString(), detail: "Vercel doğrulandı." };
  const plan = planPublish({
    id: "00000000-0000-4000-8000-000000000001", title: "Foça'da En İyi Balık",
    siteIds: ["zeytinlik-restoran", "kiyi-dis"], scope: "all-connected",
    payload: { title: "Foça'da En İyi Balık", body: "## Nerede yenir?\nZeytinlik Restoran, Foça sahilinde..." },
    placement: { location: "seo-page", strategy: "seo-geo" },
    connections: [verified],
    taken: { "zeytinlik-restoran": new Set(["focada-en-iyi-balik"]), "kiyi-dis": new Set() },
  });
  return {
    targets: Object.fromEntries(Object.entries(plan.document.targets).map(([siteId, target]) => [siteId, { status: target.status, slug: target.slug, detail: target.detail }])),
    events: plan.document.events,
    servicePath: validatePlacement({ location: "service-page", strategy: "seo", servicePath: "https://zeytinlik.example/Hizmetler/Rezervasyon/" }),
    homepageEnhancement: { primary: primaryLocation({ location: "homepage", strategy: "homepage-enhancement" }), teaser: showsHomepageTeaser({ location: "homepage", strategy: "homepage-enhancement" }) },
    legacy: resolvePlacement(null),
  };
}

if (/publishing\.ts$/.test(process.argv[1] ?? "")) console.log(JSON.stringify(demo(), null, 2));
