# Vercel Integration — REST client, sealed token, settings, events

## Overview

Connecting a Vercel account lets the panel discover every project, verify sites from Vercel's own deployment data,
and write the connector kit's environment variables during an optimization. The integration is intentionally
narrow: a handful of documented REST endpoints, one token, one settings document, and an append-only activity log.

The token can come from the environment (`VERCEL_TOKEN` + optional `VERCEL_TEAM_ID`) or be pasted once into the
panel, in which case it is stored encrypted in the private Blob store and never returned to the browser.

## Architecture notes

| Concern | File |
| --- | --- |
| REST client (read-only except env upsert) | `lib/vercel/api.ts` |
| Token precedence and sealed storage | `lib/vercel/credentials.ts` |
| Auto-connect policy + ignored projects | `lib/vercel/settings.ts` |
| Activity log (one object per event) | `lib/vercel/events.ts` |
| Admin API (`connect`, `sync`, `connect-project`, `ignore-project`, `import-all`, `settings`, `disconnect`) | `app/api/vercel/route.ts` |
| Consumers | `lib/vercel/sync.ts`, `lib/verification.ts`, `lib/seo/optimize.ts` |

Endpoints used: `GET /v2/user`, `/v2/teams`, `/v2/teams/{id}`, `/v10/projects`, `/v9/projects/{id}/domains`,
`/v9/projects/{id}/env` (names and targets only), `/v6/deployments`, and `POST /v10/projects/{id}/env?upsert=true`.

## The code

### 1. One call helper with typed failure kinds

Every Vercel call goes through `call<T>`, which adds the team scope, a timeout, `no-store` caching, and maps HTTP
failures to four kinds that callers branch on.

**Source:** `lib/vercel/api.ts`

```ts
export class VercelApiError extends Error {
  constructor(message: string, public kind: "auth" | "not-found" | "rate-limited" | "unavailable", public status?: number) { super(message); }
}

async function call<T>(credentials: VercelCredentials, path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
  const url = new URL(`${VERCEL_API}${path}`);
  for (const [name, value] of Object.entries(query)) if (value !== undefined && value !== "") url.searchParams.set(name, String(value));
  if (credentials.teamId) url.searchParams.set("teamId", credentials.teamId);
  let response: Response;
  try {
    response = await fetch(url, { headers: { authorization: `Bearer ${credentials.token}`, accept: "application/json" }, cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw new VercelApiError("Vercel API zamanında yanıt vermedi.", "unavailable");
  }
  if (response.status === 401 || response.status === 403) throw new VercelApiError("Vercel erişim anahtarı geçersiz, süresi dolmuş veya bu ekibe yetkisi yok.", "auth", response.status);
  if (response.status === 404) throw new VercelApiError("Vercel kaydı bulunamadı.", "not-found", 404);
  if (response.status === 429) throw new VercelApiError("Vercel API istek sınırına ulaşıldı; birkaç dakika sonra tekrar denenecek.", "rate-limited", 429);
  if (!response.ok) throw new VercelApiError(`Vercel API hata döndürdü (HTTP ${response.status}).`, "unavailable", response.status);
  try { return await response.json() as T; }
  catch { throw new VercelApiError("Vercel API okunamayan yanıt döndürdü.", "unavailable", response.status); }
}
```

`kind === "auth"` drives the "reconnect" state, `not-found` marks a project missing, and everything else is
transient. The token never appears in a thrown message.

### 2. Environment variables: names in, values out

The panel needs to know *which* variables a project has (to detect `ROISTATION_DISABLED` and env changes) but never
their values. Writing is the reverse: values go out for the connector kit, and are never read back.

**Source:** `lib/vercel/api.ts`

```ts
/** Environment variable NAMES and targets only. Values are stripped even if the API returns them encrypted. */
export async function listEnvMetadata(credentials: VercelCredentials, projectId: string): Promise<VercelEnvMeta[]> {
  const data = await call<{ envs?: { key?: string; target?: string | string[]; type?: string }[] }>(credentials, `/v9/projects/${encodeURIComponent(projectId)}/env`);
  return (data.envs || []).filter((env) => typeof env?.key === "string").map((env) => ({ key: env.key!, target: Array.isArray(env.target) ? env.target : env.target ? [env.target] : [], type: env.type || "encrypted" }));
}
// …
/** Creates or updates project environment variables (POST /v10/projects/{id}/env?upsert=true). Values are sent, never read back. */
export async function upsertEnv(credentials: VercelCredentials, projectId: string, envs: { key: string; value: string; type: "plain" | "encrypted" | "sensitive"; target: string[] }[]) {
  const url = new URL(`${VERCEL_API}/v10/projects/${encodeURIComponent(projectId)}/env`);
  url.searchParams.set("upsert", "true");
  if (credentials.teamId) url.searchParams.set("teamId", credentials.teamId);
  const response = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${credentials.token}`, "content-type": "application/json" }, body: JSON.stringify(envs), cache: "no-store", signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 401 || response.status === 403) throw new VercelApiError("Vercel anahtarının ortam değişkeni yazma yetkisi yok.", "auth", response.status);
  if (!response.ok) throw new VercelApiError(`Vercel ortam değişkenleri yazılamadı (HTTP ${response.status}).`, "unavailable", response.status);
}
```

The sync hashes `key:targets` pairs (sorted) into a 16-character `envHash`, so an "environment updated" event can be
logged without ever handling a value.

### 3. Token precedence and sealed storage

**Source:** `lib/vercel/credentials.ts`

```ts
import { open, seal } from "@/lib/crypto-box";
// …
const PURPOSE = "vercel-token";
const sealingAvailable = () => (process.env.PANEL_SESSION_SECRET || "").length >= 32;
// …
export async function getVercelCredentials(): Promise<VercelCredentials | null> {
  const envToken = process.env.VERCEL_TOKEN?.trim();
  if (envToken) return { token: envToken, teamId: validTeamId(process.env.VERCEL_TEAM_ID) ? process.env.VERCEL_TEAM_ID : null, source: "env" };
  if (!sealingAvailable()) return null;
  let stored: StoredCredentials | null = null;
  try { stored = (await readJson(blobPaths.vercelCredentials, parseStored))?.value ?? null; } catch { return null; }
  if (!stored) return null;
  const token = open(stored, PURPOSE);
  // null: PANEL_SESSION_SECRET changed, the saved token can no longer be read; reconnect from the panel.
  return token === null ? null : { token, teamId: validTeamId(stored.teamId) ? stored.teamId : null, source: "panel" };
}
// …
export async function saveVercelCredentials(token: string, teamId: string | null, account: string) {
  const stored: StoredCredentials = { ...seal(token, PURPOSE), teamId, savedAt: new Date().toISOString(), account };
  await overwriteJson(blobPaths.vercelCredentials, stored, { cacheControlMaxAge: 0 });
}
```

Sealing is delegated to the shared `seal()` / `open()` pair in `lib/crypto-box.ts`, the same helper the GitHub token
uses (see [authentication.md](authentication.md)): AES-256-GCM with a random 12-byte IV per save, and an auth tag that
makes tampering detectable. The key is derived from the session secret plus the purpose label `vercel-token`
(`roistation:vercel-token:v1:<secret>`), which is the derivation the module used before it moved onto the shared
helper, so tokens saved earlier remain readable. Rotating `PANEL_SESSION_SECRET` invalidates both sessions and the
stored token: `open()` returns `null` and the panel shows "not connected" rather than failing.

### 4. Connecting: validate first, ask for scope once

**Source:** `app/api/vercel/route.ts`

```ts
      case "connect": {
        if (process.env.VERCEL_TOKEN) throw new ApiError("VERCEL_TOKEN ortam değişkeni tanımlı; bağlantı oradan yönetiliyor.");
        const token = typeof body.token === "string" ? body.token.trim() : "";
        const scope = typeof body.teamId === "string" ? body.teamId.trim() : "";
        const teamId = scope && scope !== "personal" ? scope : null;
        if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) throw new ApiError("Vercel erişim anahtarı geçersiz görünüyor.");
        if (teamId && !validTeamId(teamId)) throw new ApiError("Vercel Team ID geçersiz.");
        let account: Awaited<ReturnType<typeof getAccount>>;
        try {
          account = await getAccount({ token, teamId, source: "panel" });
          // A token with team access: let the user pick the scope (personal account or a team) once.
          if (!scope) { const teams = await listTeams({ token, teamId: null, source: "panel" }); if (teams.length) return Response.json({ ok: false, needsTeam: true, account: account.user, teams }); }
        }
        catch (error) { throw new ApiError(error instanceof VercelApiError ? error.message : "Vercel hesabı doğrulanamadı.", error instanceof VercelApiError && error.kind === "auth" ? 401 : 502); }
        await saveVercelCredentials(token, teamId, account.team ? `${account.user} · ${account.team}` : account.user);
        const sync = await syncVercel("connect", { full: true });
        return Response.json({ ok: true, sync, overview: await vercelOverview() });
      }
```

The token is validated against the live API before it is stored, and a full sync runs immediately so the user sees
their projects on the same screen.

### 5. Settings with compare-and-swap (create-or-replace)

**Source:** `lib/vercel/settings.ts`

```ts
/** Compare-and-swap update of the single settings document. */
export async function updateVercelSettings(mutate: (settings: VercelSettings) => VercelSettings) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const current = await readJson(blobPaths.vercelSettings, parseSettings);
    const next = { ...mutate(current?.value ?? { ...defaultVercelSettings }), updatedAt: new Date().toISOString() };
    if (!current) { if (await createJson(blobPaths.vercelSettings, next) === "created") return next; continue; }
    if (await replaceJson(blobPaths.vercelSettings, next, current.etag) === "replaced") return next;
  }
  throw new ApiError("Ayar aynı anda değişti; tekrar dene.", 409);
}
```

The same create-or-CAS loop is used for project records (`upsertProjectRecord`) and ignored SEO findings; the
mutation is a function of the *current* value, so retries re-apply intent rather than overwrite.

### 6. Activity log: one create-only object per event, newest first by name

**Source:** `lib/vercel/events.ts`

```ts
const MAX_TS = 9_999_999_999_999;
const keyPattern = /^[A-Za-z0-9_-]{2,80}$/;
export const eventKeyForSite = (siteId: string, projectId?: string | null) => projectId && keyPattern.test(projectId) ? projectId : `site-${siteId}`;
// …
export async function logEvent(event: Omit<ProjectEvent, "at"> & { at?: string }) {
  if (!keyPattern.test(event.key)) return;
  const at = event.at || new Date().toISOString();
  const name = `${String(MAX_TS - Date.parse(at)).padStart(13, "0")}-${randomBytes(4).toString("hex")}`;
  try { await createJson(blobPaths.vercelEvent(event.key, name), { ...event, at, message: event.message.slice(0, 400) }); }
  catch (error) { console.error("[events] activity log write skipped", error); }
}
```

The inverted, zero-padded timestamp makes lexical order equal newest-first, so "latest 40 events" needs only a
listing and 40 reads. Logging never throws and never contends.

## Engineering notes

- **Timeouts:** 8 s per call. Project listing paginates up to 20 pages of 100 and stops if the cursor repeats.
- **Team scoping** is a query parameter on every call except `/v2/user` and `/v2/teams`, which are account-level.
- **Overview reads no Vercel API.** `vercelOverview()` builds the screen from stored project records, sync state and
  events, so opening the Vercel screen is cheap and works while Vercel is rate-limiting.
- **Event keys.** Events are grouped by project id when known, otherwise `site-<id>`. Publication events use the
  site profile's `vercelProjectId`, which only imported sites carry; for a built-in site linked to a project,
  publication events land under `site-<id>` while deployment events land under the project id.
- **Webhook signature:** see [deployment-engine.md](deployment-engine.md) — HMAC-SHA1 over the raw body.

## Why it is built this way

**Decision:** a thin hand-written client over a few REST endpoints, environment-first credentials with an encrypted
panel fallback, and an append-only per-object event log.

**Alternatives considered:**
- *The official Vercel SDK.* Broader coverage, but a larger dependency surface for eight endpoints, and less control
  over timeouts and error mapping in a serverless function.
- *OAuth integration (Vercel Integration marketplace).* Better UX for multi-tenant products; for one agency account,
  a scoped personal access token is simpler and auditable.
- *Storing the token in plaintext Blob.* The store is private, but encryption at rest with a key the store never
  sees limits the blast radius of a leaked Blob token.

**Trade-offs accepted:** the token's scope is whatever the user created it with (Vercel PATs are broad); env writes
need a token with write access to the project. Rotating the session secret requires reconnecting.

## Best practices demonstrated

- Typed error kinds instead of string matching at call sites.
- Metadata-only reads of secrets-bearing resources.
- Authenticated encryption with per-purpose key derivation.
- Validate credentials against the live API before persisting them.
- Mutation functions inside CAS loops.
- Lexically sortable, create-only event objects.

## Related

- [docs/Deployment.md](../docs/Deployment.md) · [docs/Permissions.md](../docs/Permissions.md) ·
  [deployment flow](../docs/diagrams/deployment-flow.svg)
- Sibling walkthroughs: [deployment-engine.md](deployment-engine.md), [authentication.md](authentication.md),
  [github-integration.md](github-integration.md), [site-management.md](site-management.md)
