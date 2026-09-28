# Authentication

The panel has one human principal, the agency administrator, and four machine principals: Vercel Cron, the Vercel webhook, client-site visitors submitting forms, and the panel itself calling client sites. Each has its own credential. All of them are derived from a small set of secrets configured as environment variables; nothing is stored in a user table.

![Authentication flow](diagrams/authentication-flow.svg)

## Contents

- [Secrets at a glance](#secrets-at-a-glance)
- [Admin login](#admin-login)
- [Session cookie](#session-cookie)
- [Checking a session](#checking-a-session)
- [Same-origin (CSRF) defence](#same-origin-csrf-defence)
- [Login rate limiting](#login-rate-limiting)
- [Logout](#logout)
- [Sealed tokens](#sealed-tokens)
- [Secret rotation](#secret-rotation)
- [Form tokens](#form-tokens)
- [Cron secret](#cron-secret)
- [Vercel webhook signature](#vercel-webhook-signature)
- [Client-site revalidate secret](#client-site-revalidate-secret)
- [Known limitations](#known-limitations)

## Secrets at a glance

| Secret | Used for | Minimum | Where it lives |
|---|---|---|---|
| `PANEL_ADMIN_PASSWORD` | Admin login | none enforced; use a long random value | Panel env |
| `PANEL_SESSION_SECRET` | Session HMAC, form-token HMAC, IP fingerprint HMAC, key derivation for sealed Vercel and GitHub tokens | 32 characters (enforced) | Panel env |
| `CRON_SECRET` | Vercel Cron → `/api/cron/*` | 16 characters (enforced) | Panel env; Vercel sends it automatically |
| `VERCEL_WEBHOOK_SECRET` | HMAC-SHA1 signature of webhook deliveries | — | Panel env and the Vercel webhook configuration |
| `ROISTATION_REVALIDATE_SECRET` | Panel → client site cache purge | 32 characters (enforced on both sides) | Panel env and every client site's env |

Generate secrets with the command from `.env.example`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

## Admin login

The admin exists only when both variables are configured:

```ts
// lib/admin.ts
export function adminConfigured() { return Boolean(process.env.PANEL_ADMIN_PASSWORD && process.env.PANEL_SESSION_SECRET && process.env.PANEL_SESSION_SECRET.length >= 32); }
```

Until then, `app/page.tsx` renders `LoginView` with setup instructions and every admin endpoint returns 503. The smoke test (`scripts/smoke.mjs`) asserts exactly this for an unconfigured build.

The login handler checks, in this order: configuration, `Origin`, rate limit, password.

```ts
// app/api/session/route.ts
    if (!adminConfigured()) throw new ApiError("PANEL_ADMIN_PASSWORD ve en az 32 karakterlik PANEL_SESSION_SECRET değişkenlerini tanımla.",503);
    requireSameOrigin(request);
    await rateLimit(`login:${requestFingerprint(request)}`,10,900);
    const {password}=await request.json();
    if(typeof password!=="string" || !safeEqual(password,process.env.PANEL_ADMIN_PASSWORD!)) throw new ApiError("Parola yanlış.",401);
    const response=NextResponse.json({authenticated:true});
    response.cookies.set(sessionCookie,sessionToken(),{httpOnly:true,secure:process.env.VERCEL==="1",sameSite:"strict",path:"/",maxAge:8*3600}); return response;
```

The password comparison hashes both sides with SHA-256 before `timingSafeEqual`, so it is constant-time and independent of the input length:

```ts
// lib/admin.ts
export function safeEqual(a: string, b: string) { return timingSafeEqual(createHash("sha256").update(a).digest(),createHash("sha256").update(b).digest()); }
```

After a successful response, `LoginView` calls `router.refresh()`; the server component in `app/page.tsx` now sees a valid cookie and renders `MasterPanel`.

## Session cookie

| Property | Value | Why |
|---|---|---|
| Name | `roi_admin` | — |
| Value | `<expires-ms>.<hex HMAC-SHA256(PANEL_SESSION_SECRET, expires-ms)>` | Stateless: no session store is needed |
| Lifetime | 8 hours (`maxAge: 8*3600`, and the expiry is also inside the signed value) | A stolen cookie has a bounded life even if the browser ignores `Max-Age` |
| `HttpOnly` | yes | Not readable from JavaScript |
| `SameSite` | `Strict` | Not sent on cross-site navigations or sub-requests |
| `Secure` | only when `VERCEL === "1"` | Allows `http://localhost` during development; see [Known limitations](#known-limitations) |
| `Path` | `/` | — |

```ts
// lib/admin.ts
function signature(value: string) { return createHmac("sha256", process.env.PANEL_SESSION_SECRET || "unconfigured").update(value).digest("hex"); }
// …
export function sessionToken() { const expires = String(Date.now() + 8 * 3600000); return `${expires}.${signature(expires)}`; }
```

The signed message is only the expiry timestamp. Other HMACs made with the same key use different message shapes (`form:<id>:<site>:<expires>` for form tokens, a client IP for the rate-limit key), so a value from one purpose cannot be replayed as a session.

## Checking a session

```ts
// lib/admin.ts
export async function isAdmin() {
  if (!adminConfigured()) return false;
  const [expires,signed] = ((await cookies()).get(sessionCookie)?.value || "").split(".");
  return Boolean(expires && signed && Number(expires) > Date.now() && safeEqual(signature(expires),signed));
}
export async function requireAdmin(request?: Request) {
  if (!adminConfigured()) throw new ApiError("Yönetici girişi için PANEL_ADMIN_PASSWORD ve en az 32 karakterlik PANEL_SESSION_SECRET tanımla.",503);
  if (!await isAdmin()) throw new ApiError("Yönetici oturumu gerekli. Panelde giriş yap.",401);
  if (request && !["GET","HEAD"].includes(request.method)) requireSameOrigin(request);
}
```

Every admin route calls `requireAdmin(request)` as its first statement. There is no middleware; the check is explicit in each handler, which keeps it visible in code review and in [API.md](API.md).

## Same-origin (CSRF) defence

`SameSite=Strict` already stops the cookie from being sent with cross-site requests. As a second layer, every state-changing admin request and the public login, logout and form-submission endpoints require an `Origin` header that matches a trusted panel origin:

```ts
// lib/admin.ts
export function requireSameOrigin(request:Request) {
  // Next may use an internal server hostname in request.url behind a proxy.
  // Production origins come from trusted configuration, never arbitrary Host headers.
  const allowed=new Set<string>();
  for(const value of [process.env.MASTER_PUBLIC_URL,process.env.VERCEL_URL && `https://${process.env.VERCEL_URL}`,process.env.VERCEL_PROJECT_PRODUCTION_URL && `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`]) {if(value) {try {allowed.add(new URL(value).origin);} catch { /* Invalid configuration is not trusted. */ }}}
  if(process.env.VERCEL!=="1") {const host=request.headers.get("host") || "";if(/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) allowed.add(`http://${host}`);}
  if(!allowed.has(request.headers.get("origin") || "")) throw new ApiError("Geçersiz istek kaynağı.",403);
}
```

- Allowed origins come from configuration (`MASTER_PUBLIC_URL`) and from variables Vercel sets for the deployment (`VERCEL_URL`, `VERCEL_PROJECT_PRODUCTION_URL`). The `Host` header is never trusted in production.
- A request without an `Origin` header is rejected. Browsers send `Origin` on `POST`, `PATCH` and `DELETE` fetches.
- Local `http://localhost` / `http://127.0.0.1` origins are accepted only when not running on Vercel.
- `GET` admin endpoints do not check `Origin`; they rely on `SameSite=Strict`. They return data and perform only idempotent housekeeping (for example the one-time migration or refreshing pull-request state).

If the panel is served from a custom domain, `MASTER_PUBLIC_URL` must be that domain, otherwise every mutation returns 403. The integration test sends a mutation with `Origin: https://attacker.test` and asserts 403.

## Login rate limiting

```ts
// lib/admin.ts
export function requestFingerprint(request: Request) { const ip=request.headers.get("x-vercel-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown"; return signature(ip); }
```

- The key is `login:<HMAC(PANEL_SESSION_SECRET, client IP)>`, hashed again with SHA-256 for the Blob pathname (`roistation-master/rate-limit/<sha256>.json`). Raw IP addresses are never stored.
- The limit is 10 attempts per 900 seconds. Successful logins count as attempts.
- The bucket is a fixed window: the first request sets `expiresAt`, later requests increment `used` until the window ends.
- It is **best effort** by design (`lib/rate-limit-storage.ts`): read-modify-write with last-write-wins, so concurrent requests can under-count, and storage errors never block a login. The password check, not the limiter, is the authentication control.
- When Blob storage is not configured, rate limiting is skipped.

The same mechanism limits form submissions (`form:<fingerprint>`, 10 per hour).

## Logout

`DELETE /api/session` requires the same origin and deletes the `roi_admin` cookie. It does not require a valid session.

Sessions are stateless, so logout removes the cookie from that browser but cannot revoke a copy of the cookie held elsewhere; such a copy stays valid until its embedded expiry (at most 8 hours). To invalidate every session immediately, rotate `PANEL_SESSION_SECRET` (see [Secret rotation](#secret-rotation)). Changing `PANEL_ADMIN_PASSWORD` alone does **not** invalidate existing sessions, because the password is not part of the signed value.

## Sealed tokens

Tokens that the admin pastes into the panel (Vercel PAT, GitHub token) are stored in the private Blob store encrypted with AES-256-GCM. The key is derived from `PANEL_SESSION_SECRET` and a per-purpose label, so a GitHub box cannot be opened with the Vercel key and vice versa.

```ts
// lib/crypto-box.ts
/** AES-256-GCM sealing for server-side secrets, keyed from PANEL_SESSION_SECRET plus a per-purpose label. */
export type SealedBox = { v: 1; iv: string; tag: string; data: string };

function key(purpose: string) {
  const secret = process.env.PANEL_SESSION_SECRET || "";
  if (secret.length < 32) throw new Error("PANEL_SESSION_SECRET en az 32 karakter olmalı.");
  return createHash("sha256").update(`roistation:${purpose}:v1:${secret}`).digest();
}
```

| Token | Module | Key label | Blob object |
|---|---|---|---|
| GitHub | `lib/github/credentials.ts` via `lib/crypto-box.ts` | `roistation:github-token:v1:<secret>` | `github/credentials.json` |
| Vercel | `lib/vercel/credentials.ts` via `lib/crypto-box.ts` | `roistation:vercel-token:v1:<secret>` | `vercel/credentials.json` |

Both modules call the same `seal()` / `open()` pair, so there is one AES-GCM implementation to review. The Vercel module stores the sealed box together with `teamId`, `savedAt` and the account label.

- Each seal uses a random 12-byte IV and stores `{ v: 1, iv, tag, data }`.
- Environment tokens (`GITHUB_TOKEN`, `VERCEL_TOKEN`) take precedence over stored ones; while they are set, the panel refuses to store a token for that service.
- Neither token is ever returned by an API. `GET /api/github` returns only `configured`, `source` and `login`; `GET /api/vercel` returns the account label and team id.

## Secret rotation

| Secret rotated | Consequences | Action needed |
|---|---|---|
| `PANEL_SESSION_SECRET` | Every admin session becomes invalid. Outstanding form tokens fail (visitors see "Form oturumu sona erdi. Sayfayı yenile." and a reload fetches a new token). Rate-limit keys change, so current windows reset. **Sealed Vercel and GitHub tokens can no longer be decrypted**: `open()` and `getVercelCredentials()` return `null`, and the panel behaves as if they were never connected | Log in again. Reconnect Vercel and GitHub in the panel (or use `VERCEL_TOKEN` / `GITHUB_TOKEN`). Stored publications, submissions and scans are not encrypted and are unaffected |
| `PANEL_ADMIN_PASSWORD` | New logins need the new password | Existing sessions stay valid until they expire; rotate `PANEL_SESSION_SECRET` as well to end them |
| `CRON_SECRET` | Vercel sends the current value automatically | Redeploy so the function sees the new value |
| `VERCEL_WEBHOOK_SECRET` | Deliveries signed with the old secret return 401 | Update the value in the Vercel webhook configuration and the panel together |
| `ROISTATION_REVALIDATE_SECRET` | Sites with the old value return 401 to cache purges; withdrawals then fall back to the 30-second ISR window | Update it on every client site and redeploy them. The SEO optimizer writes the panel's current value to a site's Vercel project when it installs the connector kit, but only when the value passes `revalidationConfigured()` (at least 32 characters), so a short or placeholder secret is never propagated |

```ts
// lib/vercel/credentials.ts — getVercelCredentials
  const token = open(stored, PURPOSE);
  // null: PANEL_SESSION_SECRET changed, the saved token can no longer be read; reconnect from the panel.
  return token === null ? null : { token, teamId: validTeamId(stored.teamId) ? stored.teamId : null, source: "panel" };
```

## Form tokens

Public forms need protection against scripted submissions without requiring visitors to log in. A form token proves that the submitter loaded a form that is currently published on that site, within the last hour.

```ts
// lib/form-token.ts
export function formToken(id:string,siteId:string,expires:string) {return createHmac("sha256",process.env.PANEL_SESSION_SECRET || "unconfigured").update(`form:${id}:${siteId}:${expires}`).digest("hex");}
```

Issue (`GET /api/form-token?id=&siteId=`, public):

1. 503 if `PANEL_SESSION_SECRET` is not set.
2. The publication must be a form, have a target for `siteId`, and be effectively published there; otherwise 404.
3. Returns `{ token: "<now + 3 600 000>.<formToken(id, siteId, expires)>" }`.

Verify (`POST /api/submissions`, public, same-origin):

```ts
// app/api/submissions/route.ts
if(!process.env.PANEL_SESSION_SECRET || !signed || !Number.isFinite(Number(expires)) || Number(expires)<Date.now() || Number(expires)>Date.now()+3600000 || !safeEqual(formToken(input.publicationId,input.siteId,expires),signed)) throw new ApiError("Form oturumu sona erdi. Sayfayı yenile.",403);
```

The token is one of several layers on the submission endpoint: same-origin check (the form runs in the `/embed/<siteId>` iframe on the panel origin), per-IP rate limit, a hidden honeypot field (`website`), explicit consent, per-field validation, and a re-check that the form is still published after the write. Tokens are not single-use; replay within the hour is bounded by the rate limit and by idempotent submission ids.

## Cron secret

Vercel Cron sends `Authorization: Bearer <CRON_SECRET>` when `CRON_SECRET` is defined on the project.

```ts
// lib/admin.ts
/** Vercel Cron calls carry "Authorization: Bearer <CRON_SECRET>"; compared in constant time. */
export function requireCronSecret(request: Request) {
  const secret = process.env.CRON_SECRET || "";
  const given = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const digest = (value: string) => createHash("sha256").update(value).digest();
  if (secret.length < 16 || !timingSafeEqual(digest(secret), digest(given))) throw new ApiError("Yetkisiz.", 401);
}
```

Both cron routes (`app/api/cron/vercel-sync/route.ts`, `app/api/cron/seo-scan/route.ts`) call `requireCronSecret(request)` as their first statement, so the check exists in one place. Both values are hashed with SHA-256 before `timingSafeEqual`, which keeps the comparison constant-time regardless of the length of the supplied header. A missing or short `CRON_SECRET` makes the cron endpoints return 401 for every caller (fail closed). The cron endpoints do not accept the admin session.

## Vercel webhook signature

```ts
// app/api/vercel/webhook/route.ts
    const secret = process.env.VERCEL_WEBHOOK_SECRET || "";
    if (!secret) throw new ApiError("Webhook yapılandırılmadı.", 404);
    const raw = await request.text();
    const expected = createHmac("sha1", secret).update(raw).digest();
    const given = Buffer.from(request.headers.get("x-vercel-signature") || "", "hex");
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new ApiError("İmza geçersiz.", 401);
```

- The HMAC is computed over the raw body before JSON parsing, as Vercel signs it.
- Without a configured secret the endpoint answers 404, so an unconfigured deployment does not expose a working webhook.
- A valid delivery can only trigger a sync, which reads from the Vercel API with the panel's own token. The webhook payload is used only for its `type`; it is never trusted as data.

## Client-site revalidate secret

The direction is reversed here: the panel authenticates to the client sites.

```ts
// lib/publishing/revalidate.ts
      const response = await fetch(`${origin}/api/roistation/revalidate`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-roistation-secret": secret },
        body: JSON.stringify({ paths: unique }),
        redirect: "manual",
        cache: "no-store",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
```

- Sent only when the panel's `ROISTATION_REVALIDATE_SECRET` is at least 32 characters (`revalidationConfigured()`). The SEO optimizer uses the same check before copying the secret into a client site's Vercel environment.
- Sent only to the site's verified connection origin (or its catalog domain), never to a URL from a request, and redirects are not followed.
- The site's route (`connectors/templates/app/api/roistation/revalidate/route.ts`) compares SHA-256 digests with `timingSafeEqual` and refuses when its own secret is shorter than 32 characters.

## Known limitations

These are deliberate trade-offs for a single-agency tool, listed so they can be judged explicitly:

- **Single admin account.** There are no users, roles or per-user audit trail. See [Permissions.md](Permissions.md) for the roadmap.
- **No server-side session revocation** short of rotating `PANEL_SESSION_SECRET`.
- **`Secure` cookie flag depends on `VERCEL === "1"`.** On a non-Vercel host serving HTTPS, the cookie is not marked `Secure`. The panel is built and tested for Vercel; a self-hosted deployment would need this condition changed or the attribute added at the proxy.
- **Rate limiting is best effort** and keyed by client IP. Off Vercel, `x-forwarded-for` is only as trustworthy as the proxy in front of the app.
- **No second factor.** The password is the only login factor.
