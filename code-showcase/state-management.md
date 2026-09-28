# State Management — client state, API calls, polling, concurrency

## Overview

The panel has no client state library. State lives in three places, each chosen for how long it must survive and
who owns the truth:

| State | Owner | Lifetime |
| --- | --- | --- |
| Records (publications, connections, projects, scans, settings) | Server, private Blob store | durable |
| Live site list | module-level `sites` array, refreshed from the registry | per instance / per tab |
| Screen state (current view, drafts, selections, busy flags) | React `useState` in `MasterPanel` and screens | until reload |
| Operator preferences (publish placement and scope) | `localStorage` via `useRememberedState` | per browser |
| In-flight AI generation id | `sessionStorage` | per tab |

The server is the source of truth for everything durable. The client reads it with `requestApi`, writes with an
idempotency key or a record `version`, and re-reads after every mutation instead of patching local caches.

## Architecture notes

- **One fetch helper** (`lib/client-api.ts`) normalizes responses, turns non-OK responses into `Error`s with the
  server's message, and forces `cache: "no-store"`.
- **Module registry.** `lib/sites.ts` exports a mutable `sites` array that both server and client code import. The
  shell refreshes it from `GET /api/sites` and forces a re-render; typed registries in
  `lib/publishing/definitions.ts` (`publishLocations`, `publishStrategies`, `publishScopes`) and
  `lib/publishing/channels.ts` (`publishChannels`) are static and shared by UI and server.
- **Optimistic concurrency** end to end: records carry `version` (and, server-side, an ETag); stale writes get a
  409 and the UI asks the user to refresh.
- **Polling**, not push: the shell polls Vercel status every 2 minutes; the Sites, Vercel and SEO screens refresh
  every 60 seconds while open.

## The code

### 1. One way to call the API

**Source:** `lib/client-api.ts`

```ts
export async function readApiResponse(response: Response): Promise<ApiPayload> {
  const contentType = response.headers.get("content-type") || "";
  const text = await response.text();

  if (contentType.includes("application/json") && text.trim()) {
    try { return JSON.parse(text) as ApiPayload; }
    catch { /* Fall through to a clearer message below. */ }
  }

  if (!text.trim()) return {};

  try { return JSON.parse(text) as ApiPayload; }
  catch {
    const short = text.replace(/\s+/g, " ").trim().slice(0, 240);
    if (short.includes("FUNCTION_INVOCATION_TIMEOUT")) {
      throw new Error("Vercel işlem süresi doldu. Yeni Claude kredisi kullanma. İçerik & Yayın ekranını yenileyip kayıt oluştu mu kontrol et; kayıt yoksa daha uzun süreli yayın sürümünü deploy etmek gerekir.");
    }
    throw new Error(response.ok ? "Sunucu okunamayan bir cevap döndürdü." : `Sunucu hata döndürdü: ${short}`);
  }
}

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

Platform errors (for example a Vercel function timeout page) are not JSON. `readApiResponse` recognizes the timeout
and tells the operator what to do — check whether the record was created *before* spending new AI credits —
instead of showing a raw HTML error.

### 2. A shared module registry, refreshed by the shell

**Source:** `components/master-panel.tsx`

```tsx
  // Live site registry: built-in sites + projects imported from Vercel.
  const [, setRegistryVersion] = useState(0);
  const [pendingProjects, setPendingProjects] = useState<VercelOverviewData["pending"]>([]);
  const [pendingBusy, setPendingBusy] = useState(false);
  const loadSites = useCallback(async () => {
    try { const data = await requestApi<{ sites: SiteProfile[] }>("/api/sites"); applySiteRegistry(data.sites.filter((site) => site.source === "vercel")); setRegistryVersion((value) => value + 1); } catch { /* built-in sites keep working */ }
  }, []);
```

`applySiteRegistry` mutates the imported `sites` array in place (see [site-management.md](site-management.md)).
Because React cannot observe that mutation, the shell bumps a throwaway counter to re-render; children then read
the updated array on their next render. It is a deliberate, contained escape hatch: one writer (the shell), many
readers, and the same array powers server code, so both sides share one shape.

### 3. Remembered operator preferences

**Source:** `components/publish-options.tsx`

```tsx
export function useRememberedState<T>(key: string, fallback: T, isValid: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try { const raw = window.localStorage.getItem(key); if (raw !== null) { const parsed = JSON.parse(raw); if (isValid(parsed)) setValue(parsed); } } catch { /* ignore */ }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (next: T) => { setValue(next); try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ } };
  return [value, update] as const;
}
```

The stored value is validated with a type guard (`isPlacement`, `isScope`) before use, so a strategy removed from the
registry, or a hand-edited value, falls back to the default instead of crashing a form. Reading happens in an
effect, which keeps the server-rendered first frame identical to the client's. Storage errors (private mode, quota)
are ignored: preferences are a convenience.

### 4. Idempotency keys for expensive, retryable actions

AI generation costs money and publishing creates records, so both are keyed by a client-generated UUID that is
reused as long as the input is unchanged. A retry after a timeout hits the same record instead of creating a new
one or paying for a new generation.

**Source:** `components/master-panel.tsx`

```tsx
    const requestKey=JSON.stringify({sourceText,fileNames:files,contentType,goal,siteIds:Array.from(selectedSites).sort()});
    if(forceNew || generationRequestRef.current?.key!==requestKey) generationRequestRef.current={key:requestKey,id:crypto.randomUUID()};
    sessionStorage.setItem("roistation:last-generation-id",generationRequestRef.current.id);sessionStorage.setItem("roistation:last-generation-key",generationRequestRef.current.key);setLastGenerationId(generationRequestRef.current.id);
    // …
      const publishKey=JSON.stringify({results:publishTargets,scheduleAt:schedule === "later" ? scheduleAt : null,placement,publishScope});
      if(publishRequestRef.current?.key!==publishKey) publishRequestRef.current={key:publishKey,id:crypto.randomUUID()};
```

On the server, the generation id maps to a create-only record with a content fingerprint; reusing an id with
different content is rejected:

**Source:** `lib/generation-storage.ts`

```ts
export async function beginGeneration(id:string,fingerprint:string) {
  await ready();
  const existing=(await readRecord(id))?.value;
  if(existing) {
    if(existing.fingerprint!==fingerprint) throw new ApiError("AI işlem kimliği başka bir içerikle eşleşiyor. Sayfayı yenile.",409);
    return {record:existing,created:false};
  }
  const now=new Date().toISOString();const row:GenerationRecord={id,fingerprint,status:"pending",createdAt:now,updatedAt:now};
  if(await createJson(blobPaths.generation(id),row)==="created") return {record:row,created:true};
  const raced=(await readRecord(id))?.value;
  if(!raced) throw unavailable();
  if(raced.fingerprint!==fingerprint) throw new ApiError("AI işlem kimliği başka bir içerikle eşleşiyor. Sayfayı yenile.",409);
  return {record:raced,created:false};
}
```

The id is also kept in `sessionStorage`, so after a reload the operator can restore the last paid result
(*"Son kaydedilen AI sonucunu getir — kredi kullanmaz"*, "fetch the last saved AI result — uses no credits").

### 5. Optimistic concurrency from the client

The client sends the `version` it rendered; the server rejects the write if the record moved on.

**Source:** `components/publication-manager.tsx`

```tsx
    setBusy(true);try {const data=await requestApi<{publication:PublicationRow}>("/api/publications",{method:"PATCH",headers:{"content-type":"application/json"},body:JSON.stringify({id:detail.id,version:detail.version,action:"edit",placement,slugs})});syncDetail(data.publication);onNotice("Yayın yeri, strateji ve adresler kaydedildi.");await load();} catch(error) {onNotice(error instanceof Error ? error.message : "Ayarlar kaydedilemedi.");} finally {setBusy(false);}
```

**Source:** `lib/publication-service.ts`

```ts
  const {value:row,etag}=await loadPublication(id);if(input.version!==row.version) throw new ApiError("Yayın başka bir işlemle değişti. Listeyi yenile.",409);
```

Two checks, two purposes: the integer `version` catches a stale *screen*; the ETag passed to `replaceJson` catches a
concurrent *write* between the server's read and its write (see [publishing-engine.md](publishing-engine.md)). After
success the client replaces its copy with the server's response and reloads the list — no local merge logic.

### 6. Polling that never overlaps with work

The SEO Center refreshes every minute, but not while a scan loop is running (the loop reloads after each site
itself). A `useRef` flag is used rather than state so the interval callback sees the current value without being
re-created.

**Source:** `components/seo-center.tsx`

```tsx
  /** Analyses sites one by one; each result is stored in history and the dashboard refreshes after every site. */
  const scan = useCallback(async (siteIds: string[], reason: string) => {
    if (running.current || !siteIds.length) return;
    running.current = true;
    setProgress(Object.fromEntries(siteIds.map((id) => [id, "queued"])));
    let ok = 0;
    for (const siteId of siteIds) {
      setProgress((current) => ({ ...current, [siteId]: "scanning" }));
      try { await requestApi("/api/seo/scan", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ siteId, reason }) }); ok++; setProgress((current) => ({ ...current, [siteId]: "done" })); }
      catch (error) { setProgress((current) => ({ ...current, [siteId]: "error" })); onNotice(error instanceof Error ? error.message : "Tarama tamamlanamadı."); }
      await load();
    }
    running.current = false;
    onNotice(`${ok}/${siteIds.length} site analiz edildi.`);
    setTimeout(() => setProgress({}), 3500);
  }, [load, onNotice]);

  useEffect(() => { void load(); const timer = setInterval(() => { setNow(Date.now()); if (!running.current) void load(); }, 60_000); return () => clearInterval(timer); }, [load]);
```

Scans run sequentially from the client, one request per site, so each stays within the 60-second function limit
and progress is visible per site.

## Engineering notes

- **Server-side read cache.** List endpoints use `readAllJson` (`lib/blob-store.ts`), a per-instance cache keyed by
  each object's listed version (ETag, or upload time + size). Changed objects are re-read; ETag-versioned entries
  live 10 minutes, metadata-versioned ones only 10 seconds so a withdrawal from another instance is never served for
  long. Single-record reads never use the cache.
- **No client caching of records.** Every `requestApi` call is `no-store`; the client always renders the latest
  server state after a mutation.
- **Busy flags as mutexes.** Buttons are disabled while `busy`/`publishing`/`generating` is set, which prevents
  double submission from the same tab. Across tabs, idempotency keys and CAS do that job.
- **Retry helper scope.** `retryStorageBusy` retries only `StorageBusyError` (raised when the AI generation record
  keeps losing CAS races) with a small jittered backoff and a 6-second budget; the attempt count is capped at 4 even
  when routes pass 8. Publication conflicts are intentionally not retried.
- **Derived, not stored.** The command search's result list, the sidebar badge count and the connection health
  block are computed during render from `navGroups`, `sites` and the loaded connection map. Only the search query,
  its open flag and the active option are state (inside `CommandSearch`), so a registry refresh from `loadSites()`
  is reflected in search results on the next render without any extra wiring. The `verified` map behind the health
  block comes from `useConnectionStatus()`, which loads `/api/connections` once when the shell mounts.
- **Mutable registry caveat.** Components that captured `sites` in a `useState` initializer (for example the default
  selection `new Set(sites.map(...))`) keep the list from first render; newly imported sites appear in lists but are
  not auto-selected.

## Why it is built this way

**Decision:** server as the single source of truth, React local state for screens, explicit keys and versions for
writes, and polling for freshness.

**Alternatives considered:**
- *A client cache library (React Query / SWR).* Deduplication and background refresh for free, but another layer
  whose cache must be invalidated after every mutation; with few screens and `no-store` reads, plain `useState` +
  reload-after-write is easier to reason about.
- *A global store (Redux, Zustand).* Useful when many distant components mutate shared state; here, the shell is the
  only cross-cutting owner.
- *Server push (SSE / WebSockets).* Real-time status, but long-lived connections do not fit serverless functions
  well, and minute-level freshness is enough for deployment and SEO status.

**Trade-offs accepted:** some redundant reads while screens are open, and a mutable module array that needs a manual
re-render nudge. In exchange, there is exactly one place where each piece of truth lives, and retries are safe by
construction.

## Best practices demonstrated

- A single fetch wrapper that turns platform failures into actionable messages.
- Client-generated idempotency keys tied to a fingerprint of the input.
- Version checks for stale screens plus ETag CAS for concurrent writes.
- Validated `localStorage` preferences read in an effect.
- Interval polling guarded by a ref so it never overlaps active work.

## Related

- [docs/Architecture.md](../docs/Architecture.md) · [docs/Architecture.md](../docs/Architecture.md) ·
  [AI publishing flow](../docs/diagrams/ai-publishing-flow.svg)
- Sibling walkthroughs: [publishing-engine.md](publishing-engine.md), [dashboard-layout.md](dashboard-layout.md),
  [site-management.md](site-management.md), [deployment-engine.md](deployment-engine.md)
