# State Management

The panel has no global state library: no Redux, Zustand, React Context store, React Query or SWR. The server (private Blob storage behind the API routes) is the single source of truth, and the client keeps only what a view needs to render and what the user is currently editing. This document describes what state exists, where it lives, how it is refreshed, and why the approach fits this application.

Related documents: [Architecture](Architecture.md) · [Component Library](Component-Library.md) · [Publishing Engine](Publishing-Engine.md#idempotency-and-version-conflicts) · [Developer Guide](Developer-Guide.md)

## Contents

- [State inventory](#state-inventory)
- [Fetching: `lib/client-api.ts`](#fetching-libclient-apits)
- [Polling and refresh](#polling-and-refresh)
- [Mutations and optimistic concurrency](#mutations-and-optimistic-concurrency)
- [Idempotency keys on the client](#idempotency-keys-on-the-client)
- [Browser storage](#browser-storage)
- [The module-level `sites` registry](#the-module-level-sites-registry)
- [Per-instance server caches](#per-instance-server-caches)
- [Why this approach](#why-this-approach)
- [When it would change](#when-it-would-change)

## State inventory

| State | Where | Lifetime | Source of truth |
| --- | --- | --- | --- |
| Current view, mobile nav, toast notice | `useState` in `MasterPanel` | Page session | Client |
| Command search query, open flag, active option | `useState` in `CommandSearch` (inside `MasterPanel`) | Page session; cleared after a choice | Client. The command list itself is derived on every render from `navGroups` and `sites`, so it is never stored |
| Sidebar connection health (`verifiedCount`), pending Vercel projects (bell dot) | Derived from `useConnectionStatus()` and `pendingProjects` state in `MasterPanel` | `verified` is loaded once on mount; `pendingProjects` is refreshed by every background sync | Server (`/api/connections`, `/api/vercel`) |
| AI workflow inputs (selected sites, source text, files, content type, goal, schedule) | `useState` in `MasterPanel` | Page session; survives switching views because `MasterPanel` stays mounted | Client |
| AI results and engine mode | `useState` in `MasterPanel` | Page session; recoverable from the server by generation id | Server (`generations/<id>.json`) |
| Publish placement and scope preferences | `useRememberedState` (`localStorage`) | Across sessions, per browser | Client preference |
| Last generation id and request key | `sessionStorage` | Browser tab | Client; points at a server record |
| Publications, submissions, connections, scans, Vercel overview | `useState` inside each feature component | While the view is mounted | Server |
| Site list | Module-level `sites` array in `lib/sites.ts` | Module lifetime (tab on the client, instance on the server) | Built-in catalogue + Blob site records |
| In-flight flags, progress, selected rows, open dialogs | `useState` / `useRef` in the feature component | While mounted | Client |

Feature components (`PublicationManager`, `ConnectionManager`, `VercelOverview`, `SeoCenter`) own their data and fetch it on mount. `MasterPanel` renders only the active view, so leaving a view discards its data, and returning to it fetches fresh data. The one piece of cross-view communication is callbacks passed as props: `onNotice` for toasts, `onPublished` / `onSitesChanged` to trigger a background refresh in the shell, and `onCreateContent` for the SEO Center to prefill the AI workflow.

## Fetching: `lib/client-api.ts`

Every panel request goes through a 34-line wrapper that disables HTTP caching and turns any failure into an `Error` whose message is the server's Turkish `error` text:

```ts
// lib/client-api.ts
export async function requestApi<T extends ApiPayload = ApiPayload>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, { ...init, cache: "no-store" });
  const data = await readApiResponse(response);
  if (!response.ok) {
    const error = !Array.isArray(data) && typeof data.error === "string" ? data.error : "İşlem tamamlanamadı.";
    throw new Error(error);
  }
  return data as T;
}
```

`readApiResponse()` tolerates non-JSON bodies. In particular it recognises a Vercel `FUNCTION_INVOCATION_TIMEOUT` page and tells the user not to spend new AI credits but to reload and check whether the record was saved, which pairs with the server-side idempotency described below. A few older call sites use `fetch` + `readApiResponse` directly with the same semantics.

On the server, every route returns errors through `apiFailure()` (`lib/errors.ts`): `ApiError` messages and status codes are passed through, anything else becomes a generic 500 "İşlem tamamlanamadı." so internals never leak to the browser.

## Polling and refresh

There are no WebSockets or server-sent events. Views that show externally changing state poll; views that show only the admin's own changes reload after each mutation.

| Component | Interval | What is refreshed | Notes |
| --- | --- | --- | --- |
| `MasterPanel` | on open, then every 2 min; a full sync every 5th tick (10 min) | `GET /api/vercel`, then `POST /api/vercel` `sync`, then `/api/sites` | On open, skipped if the last sync is under 2 minutes old; also after every publish (non-full) |
| `SeoCenter` | 60 s | `GET /api/seo` | Skipped while a scan is running; also updates relative times |
| `VercelOverview` | 60 s | `GET /api/vercel` (stored records only, no Vercel API call) | |
| `ConnectionManager` | 60 s | `GET /api/connections` | |
| `PublicationManager` | 30 s clock tick while a publication dialog is open | No request; updates countdowns and synthesised "auto-published" history | Data reloads after every operation and on page change |
| `SiteWidget` (on client sites) | 15 s | `GET /api/site-content` | Public feed |
| `OperationalOverview` | once on mount | `GET /api/dashboard` | |

Intervals are cleared in the effect cleanup, so only the mounted view polls.

```ts
// components/master-panel.tsx
    // Deployment status every 2 minutes (projects + deployments only); a full sync every 10 minutes.
    let tick = 0;
    const timer = setInterval(() => { tick++; void backgroundSync(tick % 5 === 0 ? "panel-full" : "panel-poll", false, tick % 5 === 0); }, 2 * 60_000);
```

## Mutations and optimistic concurrency

The UI does not apply optimistic updates. A mutation is sent, the server validates and persists it, and the response carries the new state, which replaces local state. This matters because the outcome of a publish is decided per site on the server (connection verification, preflight checks) and cannot be predicted by the client.

Concurrency control is optimistic in the database sense instead: every publication row has a `version`, and every operation sends the version the user saw.

```ts
// components/publication-manager.tsx (inside operate())
      const data=await requestApi<{publication:PublicationRow;results:SummaryResult[];removed?:boolean;revalidation?:{siteId:string;ok:boolean;skipped?:boolean}[]}>("/api/publications",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({id:detail.id,version:detail.version,action:confirm.action,all:confirm.all,siteIds:targets,scheduleAt:publishing && scheduleMode==="later" && scheduleAt ? new Date(scheduleAt).toISOString() : null,...(publishing && !confirm.all ? {scope} : {}),...(publishing && detail.document.kind==="content" && placementDirty ? {placement} : {})})});
```

On the server, `operatePublication()` compares that version with the stored row and then writes with the Blob ETag as `ifMatch`, so both a stale UI and a concurrent request from another tab fail with HTTP 409 "Yayın başka bir işlemle değişti. Listeyi yenile." The client reacts by showing the message, reloading the list and closing the dialog, so the next attempt starts from the current row. On success, `syncDetail(data.publication)` replaces the dialog's row with the returned one, which carries the incremented version.

The same compare-and-swap discipline is used on the server for every mutable object (site records, ignored SEO findings, optimization status, generation records); see `replaceJson()` in `lib/blob-store.ts`.

## Idempotency keys on the client

Two refs in `MasterPanel` make retries safe after timeouts:

- `generationRequestRef` holds `{ key, id }` for AI generation. The key is the serialized request (source text, file names, content type, goal, sorted site ids). While the key is unchanged, the same UUID is sent, so the server returns the stored result instead of starting a second paid call. It is mirrored in `sessionStorage` so "Son kaydedilen AI sonucunu getir" works after a reload.
- `publishRequestRef` does the same for `POST /api/publish`, keyed by the reviewed results, schedule, placement and scope. A repeated click after a timeout returns the already created publication.

Only an explicit "Yeni ücretli deneme başlat" (start a new paid attempt), confirmed in a dialog, forces a new generation id.

## Browser storage

| Key | Storage | Written by | Content |
| --- | --- | --- | --- |
| `roistation:publish-placement` | `localStorage` | `useRememberedState` in `MasterPanel` and `PublicationManager` (create form) | Last chosen location + strategy (+ service path) |
| `roistation:publish-scope` | `localStorage` | `useRememberedState` in `MasterPanel` and `PublicationManager` | Last chosen scope |
| `roistation:last-generation-id` | `sessionStorage` | `MasterPanel` | UUID of the last AI generation |
| `roistation:last-generation-key` | `sessionStorage` | `MasterPanel` | Serialized request for that id |

```ts
// components/publish-options.tsx
/** Remembers a choice per browser. Storage failures (private mode, blocked storage) fall back to the default. */
export function useRememberedState<T>(key: string, fallback: T, isValid: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try { const raw = window.localStorage.getItem(key); if (raw !== null) { const parsed = JSON.parse(raw); if (isValid(parsed)) setValue(parsed); } } catch { /* ignore */ }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (next: T) => { setValue(next); try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ } };
  return [value, update] as const;
}
```

Stored values are validated with the same type guards the server uses (`isPublishLocation`, `isPublishStrategy`, `isPublishScope`), so a value from an older release or a hand-edited entry falls back to the default. The first render always uses the default (no hydration mismatch); the remembered value is applied in an effect. Nothing sensitive is stored in the browser: no tokens, no content, no personal data from form submissions.

## The module-level `sites` registry

The list of sites is needed almost everywhere, on both the server and the client. Instead of threading it through props or a context, `lib/sites.ts` exports one mutable array that is refreshed in place:

```ts
// lib/sites.ts
export const sites: SiteProfile[] = [...baseSites];

export function applySiteRegistry(imported: SiteProfile[]) {
  const known = new Set(baseSites.map((site) => site.id));
  const extra = imported.filter((site) => !known.has(site.id) && /^[a-z0-9-]{2,60}$/.test(site.id));
  sites.splice(0, sites.length, ...baseSites, ...extra);
  return sites;
}
```

- `baseSites` is the configured catalogue (`NEXT_PUBLIC_ROISTATION_SITES`) or the fictional demo catalogue. Built-in sites are never removed; imported sites cannot shadow them.
- **Server:** `ensureSiteRegistry()` (`lib/site-registry.ts`) loads non-archived Vercel-imported site records from Blob and applies them. It is cached for 20 seconds and de-duplicates concurrent loads with a shared in-flight promise. Writes (import, archive, restore) force a reload. Every route that validates site ids calls it first.
- **Client:** `MasterPanel.loadSites()` fetches `/api/sites`, applies the Vercel-sourced entries, and bumps a dummy counter so React re-renders:

```ts
// components/master-panel.tsx
  const [, setRegistryVersion] = useState(0);
  // …
    try { const data = await requestApi<{ sites: SiteProfile[] }>("/api/sites"); applySiteRegistry(data.sites.filter((site) => site.source === "vercel")); setRegistryVersion((value) => value + 1); } catch { /* built-in sites keep working */ }
```

Trade-offs, stated plainly:

- Mutation of a shared module is invisible to React. It works because the only writer on the client is `loadSites()`, which always forces a render afterwards, and child views read `sites` during render.
- State initialised from `sites` with `useState(() => …)` captures the list at mount time. For example, the AI workflow preselects the sites known when the panel first rendered; sites imported later appear in the selectors but are not preselected.
- On the server, the array is shared by concurrent requests in the same instance. The replacement is a single synchronous `splice`, built-ins are constant, and imported sites only change through the registry, so a request sees either the old or the new list, never a partial one.

## Per-instance server caches

Vercel functions keep module state while an instance is warm. The code uses that deliberately in four places; each cache is keyed or bounded so that it cannot serve an outdated write for long.

| Cache | File | Key / validity | Purpose |
| --- | --- | --- | --- |
| `documentCache` | `lib/blob-store.ts` | Object path + listed version (`etag:<etag>` or `meta:<uploadedAt>:<size>`); 10 min TTL with an ETag, 10 s without; max 5,000 entries | List views read only objects that changed since this instance last saw them |
| Site registry | `lib/site-registry.ts` | 20 s, in-flight promise shared | Avoid listing site records on every request |
| Migration flag | `lib/migration.ts` | Boolean after the migration marker is confirmed | One marker read per cold instance |
| Business profile JSON | `lib/publishing/business.ts` | Raw `SITE_BUSINESS_JSON` string | Parse the variable once |

```ts
// lib/blob-store.ts
/*
 * Per-instance cache of parsed documents for LIST views only, keyed by the
 * object's listed version. A changed object gets a new version and is re-read;
 * single-record reads (getPublication, submissions, generations) never use it.
 */
```

Single-record reads always go to Blob with `useCache: false`; that is what every write path uses before a compare-and-swap. A write in one instance forgets its local cache entry immediately; other instances see the new ETag in the next listing.

## Why this approach

- **One user, server-decided outcomes.** There is a single admin account and no collaborative editing. The important state (whether a site is live, whether a publish succeeded) is decided on the server per site. A client cache would mostly duplicate server state and add invalidation bugs.
- **Few, independent views.** Each screen needs one or two endpoints. Fetch-on-mount plus refresh-after-mutation is easy to read and to verify, and leaving a view naturally discards its data.
- **Correctness lives where it can be enforced.** Version checks, ETags and idempotency keys protect against double submits, stale tabs and serverless timeouts regardless of what the client believes.
- **Minimal runtime dependencies.** The production dependency list is `next`, `react`, `react-dom`, `@vercel/blob`, `lucide-react` and `mammoth`. Not adding a state library keeps the bundle and the audit surface small.

## When it would change

These are conditions, not plans:

- **Multiple users or roles.** Concurrent editors would make 409s common; a query cache with background revalidation (for example SWR or TanStack Query) and finer-grained conflict messages would be worth it.
- **Real-time requirements.** If deploy or scan progress had to appear instantly, polling would give way to server-sent events from the Vercel webhook handler.
- **Growth of `MasterPanel`.** `AutomationWorkspace` already receives 36 props from the shell (`AutomationProps` in `components/master-panel.tsx`). Moving the AI workflow into its own component with a `useReducer`, or a small context, would be the first refactor if that workflow grows.
- **Very large site catalogues.** The mutable `sites` array and "list everything" endpoints assume an agency-sized portfolio; hundreds of sites would call for paginated APIs and a proper client cache.
