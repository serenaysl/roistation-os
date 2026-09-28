# Permissions — the guards between the internet and a write

## Overview

With a single administrator (see [authentication.md](authentication.md)), "permissions" in this codebase are not
roles. They are a small set of **guards**, each answering one question for one class of caller:

| Caller | Guard | Question |
| --- | --- | --- |
| Admin browser session | `requireAdmin(request)` | Is this the signed-in admin, and (for mutations) is the request same-origin? |
| Vercel Cron | `requireCronSecret(request)` | Does it carry `Authorization: Bearer <CRON_SECRET>`? |
| Vercel webhook | HMAC-SHA1 of the raw body | Did Vercel sign this payload with `VERCEL_WEBHOOK_SECRET`? |
| Public form on a client site | signed, expiring form token + rate limit + honeypot | Was this form actually served, recently, for this site? |
| Client site / widget (read) | none needed | Public APIs return only published content for known sites. |
| Outbound requests | host allow-lists | Is this URL on a domain that belongs to this site? |
| Vercel projects | exclusion list, opt-out env var, ignore list | Is the panel allowed to touch this project at all? |
| Any browser framing the panel | `X-Frame-Options` / CSP `frame-ancestors` on `/` | May this page embed the admin UI? (never) |

There is **no multi-user RBAC**: no roles, no per-site permissions, no audit trail per operator. Everything that
requires a session requires *the* session.

## Architecture notes

- Guards live in `lib/admin.ts` (`requireAdmin`, `requireSameOrigin`, `requireCronSecret`, `requestFingerprint`),
  `lib/form-token.ts`, and `lib/verification.ts` (`allowedHosts`, `validateUrl`, `safeGet`).
- Every admin route calls `await requireAdmin(request)` as its first statement inside `try`, and every route funnels
  errors through `apiFailure`, which only exposes messages of `ApiError`s; unexpected errors become a generic 500.
- Public read APIs (`/api/site-content`, `/api/site-page`, `/api/site-pages`, `/api/site-sitemap`) validate the site
  id against the live catalog and read only targets whose effective status is `published`.

## The code

### 1. Admin guard with built-in CSRF defence

**Source:** `lib/admin.ts`

```ts
export async function requireAdmin(request?: Request) {
  if (!adminConfigured()) throw new ApiError("Yönetici girişi için PANEL_ADMIN_PASSWORD ve en az 32 karakterlik PANEL_SESSION_SECRET tanımla.",503);
  if (!await isAdmin()) throw new ApiError("Yönetici oturumu gerekli. Panelde giriş yap.",401);
  if (request && !["GET","HEAD"].includes(request.method)) requireSameOrigin(request);
}
export function requireSameOrigin(request:Request) {
  // Next may use an internal server hostname in request.url behind a proxy.
  // Production origins come from trusted configuration, never arbitrary Host headers.
  const allowed=new Set<string>();
  for(const value of [process.env.MASTER_PUBLIC_URL,process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`]) {if(value) {try {allowed.add(new URL(value).origin);} catch { /* Invalid configuration is not trusted. */ }}}
  if(process.env.VERCEL!=="1") {const host=request.headers.get("host") || "";if(/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) allowed.add(`http://${host}`);}
  if(!allowed.has(request.headers.get("origin") || "")) throw new ApiError("Geçersiz istek kaynağı.",403);
}
```

Two layers against cross-site request forgery: the `SameSite=Strict` cookie is not sent on cross-site requests, and
every non-GET admin request must carry an `Origin` header from a configured origin. The allowed set is built from
configuration, never from the incoming `Host` header, except for `localhost` outside Vercel. A missing `Origin`
fails closed.

### 2. Cron secret, compared in constant time

**Source:** `lib/admin.ts`

```ts
/** Vercel Cron calls carry "Authorization: Bearer <CRON_SECRET>"; compared in constant time. */
export function requireCronSecret(request: Request) {
  const secret = process.env.CRON_SECRET || "";
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (secret.length < 16 || !timingSafeEqual(digest(secret), digest(given))) throw new ApiError("Yetkisiz.", 401);
}
```

A missing or short `CRON_SECRET` disables the cron endpoints entirely rather than leaving them open. Both cron
routes (`/api/cron/vercel-sync`, `/api/cron/seo-scan`) call `requireCronSecret(request)` as their first statement,
so there is one implementation of the check instead of a copy per route. Hashing both sides first gives
`timingSafeEqual` equal-length inputs, so the comparison leaks neither content nor length.

### 3. Public forms: signed, expiring, bound to publication and site

The form token is an HMAC over `form:<publicationId>:<siteId>:<expires>`, issued only for a form that is currently
published on that site, valid for one hour.

**Source:** `lib/form-token.ts`

```ts
export function formToken(id:string,siteId:string,expires:string) {return createHmac("sha256",process.env.PANEL_SESSION_SECRET || "unconfigured").update(`form:${id}:${siteId}:${expires}`).digest("hex");}
```

**Source:** `app/api/form-token/route.ts`

```ts
    const row=await getPublication(id);if(row.document.kind!=="form" || !row.document.targets[siteId] || effectiveStatus(row.document.targets[siteId])!=="published") throw new ApiError("Bu form yayında değil.",404);
    const expires=String(Date.now()+3600000);return Response.json({token:`${expires}.${formToken(id,siteId,expires)}`},{headers:{"Cache-Control":"no-store"}});
```

On submission, the route layers origin check, rate limit (10 per hour per client), a honeypot field (`website`),
token verification with bounds on the expiry, and a re-check that the form is still published:

**Source:** `app/api/submissions/route.ts`

```ts
    requireSameOrigin(request);
    await ensureSiteRegistry();
    await rateLimit(`form:${requestFingerprint(request)}`,10,3600);
    const input=await request.json();if(input.website) throw new ApiError("Form gönderimi reddedildi.");
    validateSiteIds([input.siteId]);const [expires,signed]=String(input.token || "").split(".");
    if(!process.env.PANEL_SESSION_SECRET || !signed || !Number.isFinite(Number(expires)) || Number(expires)<Date.now() || Number(expires)>Date.now()+3600000 || !safeEqual(formToken(input.publicationId,input.siteId,expires),signed)) throw new ApiError("Form oturumu sona erdi. Sayfayı yenile.",403);
```

Rejecting an `expires` more than an hour in the future means a token cannot be pre-minted with a far expiry even if
the formula were known. Forms render inside the `/embed/[siteId]` iframe served from the panel's own origin, which
is why the same-origin check applies to public submissions too.

### 4. Public reads: known sites, published content only

**Source:** `lib/publication-service.ts`

```ts
export function validateSiteIds(input:unknown):string[] {
  if(!Array.isArray(input) || !input.length || input.length>sites.length || input.some(id=>typeof id!=="string" || !sites.some(site=>site.id===id))) throw new ApiError("En az bir kapsam içi site seç.");return [...new Set(input)] as string[];
}
```

**Source:** `app/api/site-page/route.ts`

```ts
    await ensureSiteRegistry();const params=new URL(request.url).searchParams;const siteId=params.get("siteId") || "";validateSiteIds([siteId]);
    const slug=params.get("slug") || "";if(!isValidSlug(slug)) throw new ApiError("Sayfa adresi geçersiz.",404);
    const location=params.get("location");
    if(location && !(location in publishLocations && publishLocations[location as PublishLocation].kind==="page")) throw new ApiError("Sayfa konumu geçersiz.");
    const page=await getSitePage(siteId,slug,(location || undefined) as PublishLocation|undefined);
    if(!page) throw new ApiError("Sayfa bulunamadı veya yayında değil.",404);
```

**Source:** `lib/publishing/page-model.ts`

```ts
  const entry = index.find((item) => item.slug === slug && item.published && (!location || item.primary === location) && pagePath(item));
```

Drafts, withdrawn and deleted targets never leave the server through these routes, and forms are excluded from the
page index entirely. Scheduled targets become visible only once their time has passed.

### 5. Which Vercel projects the panel may touch

**Source:** `lib/sites.ts`

```ts
/**
 * Vercel projects that are never auto-imported, auto-verified or published to by default
 * (comma separated NEXT_PUBLIC_ROISTATION_EXCLUDED_PROJECTS, e.g. internal tools).
 * An admin can still connect one explicitly from the Vercel screen.
 */
export const excludedProjects: string[] = (process.env.NEXT_PUBLIC_ROISTATION_EXCLUDED_PROJECTS ?? "")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);
```

**Source:** `lib/vercel/sync.ts`

```ts
/** A project opts out of ROIstation with a ROISTATION_DISABLED environment variable (name only is read). */
const disabledByEnv = (envKeys: { key: string }[]) => envKeys.some((env) => env.key === "ROISTATION_DISABLED");
// …
  if (by === "auto" && record.excluded) throw new ApiError("Kapsam dışı proje otomatik bağlanmaz.");
  const builtIn = builtInSiteFor(record.name, [record.productionDomain, ...record.customDomains]);
  if (record.compatibility === "not-compatible") throw new ApiError("Bu proje ROISTATION_DISABLED ile ROIstation'ı kapatmış.", 409);
```

Three independent levers: the agency's exclusion list (panel-side), the project's own opt-out variable
(project-side), and a per-project "ignore" choice stored in settings (user-side). They differ in strength on
purpose: an excluded project is only kept out of the automatic paths (`by === "auto"` is refused), so an admin can
still connect it explicitly, while `ROISTATION_DISABLED` is a hard stop even for a manual connect (409).

### 6. Storage that refuses to be public

**Source:** `lib/blob-store.ts`

```ts
    const result = await get(pathname,{access:"private",useCache:false,abortSignal:AbortSignal.timeout(READ_TIMEOUT_MS)});
    if(!result) return null;
    // Leads and drafts must never live in a public store.
    if(!result.blob.url.includes(".private.blob.vercel-storage.com/") || result.statusCode !== 200 || !result.stream) throw new ApiError(accessMessage,503);
```

Every read asserts the object came from a private store. A misconfigured public Blob store makes the panel fail
closed rather than operate on world-readable form submissions.

### 7. Browser-level guards: who may frame the panel

**Source:** `next.config.ts`

```ts
  poweredByHeader: false,
  // …
  async headers() {
    const baseline = [
      { key: "X-Content-Type-Options", value: "nosniff" },
      { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    ];
    return [
      { source: "/:path*", headers: baseline },
      // The admin panel is never framed. /embed/<site> stays frameable: client sites load it in an iframe.
      { source: "/", headers: [{ key: "X-Frame-Options", value: "DENY" }, { key: "Content-Security-Policy", value: "frame-ancestors 'none'" }] },
    ];
  },
```

The anti-framing headers are scoped to `/`, the only route that renders the admin UI, because `/embed/<siteId>`
must stay embeddable in client sites. `nosniff` and the referrer policy apply everywhere; the latter means a client
site that receives a request from the panel (for example a favicon load) sees only the panel's origin.

## Engineering notes

- **Error disclosure.** `apiFailure` returns the message only for `ApiError`; anything else is a generic
  *"İşlem tamamlanamadı."* ("Operation could not be completed") with status 500, and `Cache-Control: no-store`.
- **Input validation at the edge of every route**: UUID regexes for ids, `^[a-z0-9-]{2,60}$` for site ids, strict
  field whitelists for form definitions (ids like `__proto__`/`constructor` are rejected), length caps on every text.
- **Outbound SSRF.** Verification, scans and revalidation contact only allow-listed hosts or the verified connection
  origin, over HTTPS on 443, with manual redirect handling (see [site-management.md](site-management.md)).
- **Env values stay server-side.** `NEXT_PUBLIC_ROISTATION_SITES` and `…_EXCLUDED_PROJECTS` are public by design
  (names and domains only). Tokens, secrets and business contact data are server-only variables.
- **Site ids on write paths are checked against the live registry.** `POST /api/seo/ignore` requires the id to match
  the site-id pattern *and* to exist in `ensureSiteRegistry()`, so it cannot create settings for an unknown site.
  The read-only `GET /api/seo/report` validates the pattern only; an unknown id has no scans and returns 404.
- **Logout is not session-gated.** `DELETE /api/session` requires same-origin but not a session, which is harmless
  (it only clears a cookie).

## Why it is built this way

**Decision:** explicit, per-caller guards at the top of each route, with public surfaces designed to be read-only
and fail closed.

**Alternatives considered:**
- *Middleware-level auth for `/api/*`.* Centralized, but public, cron, webhook and admin routes share the prefix;
  per-route guards keep each route's contract visible where it is implemented.
- *CSRF tokens.* Same-origin `Origin` checks plus `SameSite=Strict` cover the admin API without extra round-trips;
  signed tokens are used only where the caller is anonymous (public forms).
- *RBAC now.* Premature for one operator; the guards are the seam where roles would plug in later.

**Trade-offs accepted:** each new route must remember its guard (reviewed by convention, not enforced by types), and
there is no per-operator accountability.

## Best practices demonstrated

- Fail-closed configuration (missing secrets disable features instead of opening them).
- Defence in depth for anonymous writes: origin, rate limit, honeypot, signed expiring token, state re-check.
- Allow-lists derived from trusted configuration, never from request headers.
- Public APIs built on the same data layer with a "published only" filter, not a separate copy.
- Generic error bodies for unexpected failures.

## Related

- [docs/Permissions.md](../docs/Permissions.md) · [docs/API.md](../docs/API.md) ·
  [authentication flow](../docs/diagrams/authentication-flow.svg)
- Sibling walkthroughs: [authentication.md](authentication.md), [publishing-engine.md](publishing-engine.md),
  [site-management.md](site-management.md), [deployment-engine.md](deployment-engine.md)
