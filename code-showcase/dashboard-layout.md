# Dashboard Layout — the panel shell

## Overview

The whole admin experience is one client component, `MasterPanel`, rendered after login. It owns the sidebar
navigation, the sticky top bar (with a ⌘K command search), a global notice area, the "new Vercel project detected" prompts, and a background
Vercel sync loop. Each screen ("view") is a separate component mounted inside the shell: the operational overview
(*Kontrol Merkezi*, "control center"), AI automation, site inventory, content & publishing, forms, the SEO & GEO
Center, Vercel & Deploy, and settings.

![Dashboard](../assets/screenshots/dashboard.png)

## Architecture notes

| Concern | Where |
| --- | --- |
| Shell, navigation, command search, notices, background sync | `components/master-panel.tsx` |
| Control-center screen | `components/operational-overview.tsx` → `GET /api/dashboard` |
| Screens | `connection-manager.tsx`, `publication-manager.tsx`, `seo-center.tsx`, `vercel-overview.tsx` |
| Layout tokens and responsive rules | `app/globals.css` (`:root`, `.app-shell`, `.sidebar`, `.main-area`, media queries) |

- Navigation is **state, not routes**: `view` is a `useState` value, so switching screens never refetches the
  shell or loses in-progress AI drafts. The trade-off is that views are not deep-linkable (see below).
- The shell is the only place that talks to `/api/sites` and runs the Vercel poll, so every screen reads the same
  live site list (see [state-management.md](state-management.md)).
- Notices are a single string (`notice`) that any screen can set through an `onNotice` callback.

## The code

### 1. Views and navigation as data

The sidebar is generated from a typed registry. Adding a screen means adding a `View` member, a nav entry and a
`pageTitle` label; TypeScript enforces that the `Record<View, string>` title map stays complete.

**Source:** `components/master-panel.tsx`

```tsx
type View = "overview" | "automation" | "sites" | "seo" | "publishing" | "forms" | "deploy" | "settings";
// …
const navGroups: { label?: string; items: { id: View; label: string; icon: typeof LayoutDashboard; badge?: string }[] }[] = [
  { items: [
    { id: "overview", label: "Genel Bakış", icon: LayoutDashboard },
    { id: "automation", label: "AI Otomasyon", icon: Bot, badge: "YENİ" },
  ] },
  { label: "YÖNETİM", items: [
    { id: "sites", label: "Siteler", icon: Globe2, badge: "count" },
    { id: "publishing", label: "İçerik & Yayın", icon: FileText },
    { id: "forms", label: "Formlar", icon: ListChecks },
    { id: "seo", label: "SEO / GEO", icon: Sparkles },
  ] },
  { label: "ALTYAPI", items: [
    { id: "deploy", label: "Vercel & Deploy", icon: CloudCog },
    { id: "settings", label: "Ayarlar", icon: Settings },
  ] },
];
```

`badge: "count"` on *Siteler* ("Sites") is a marker, not a label: the renderer replaces it with the size of the
catalog, so the number can never drift from the configured site list.

**Source:** `components/master-panel.tsx`

```tsx
                    {item.badge && <em>{item.badge === "count" ? sites.length : item.badge}</em>}
```

### 2. Command search (⌘K / Ctrl+K)

The top bar's search box is a small command palette over the same `navGroups` registry plus the site catalog.
⌘K (macOS) or Ctrl+K focuses it from anywhere in the panel; choosing a site opens the SEO & GEO Center.

**Source:** `components/master-panel.tsx`

```tsx
/** ⌘K / Ctrl+K quick navigation across panel views and sites (sites open the SEO & GEO Center). */
function CommandSearch({ onNavigate }: { onNavigate: (view: View) => void }) {
  // …
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); inputRef.current?.focus(); setOpen(true); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const needle = query.trim().toLocaleLowerCase("tr-TR");
  const commands: Command[] = [
    ...navGroups.flatMap((group) => group.items.map((item) => ({ id: `view:${item.id}`, label: item.label, hint: "Ekran", view: item.id }))),
    ...sites.map((site) => ({ id: `site:${site.id}`, label: site.name, hint: site.domain, view: "seo" as View })),
  ];
  const matches = needle ? commands.filter((command) => `${command.label} ${command.hint}`.toLocaleLowerCase("tr-TR").includes(needle)).slice(0, 8) : commands.slice(0, 8);
```

Because the commands are derived from `navGroups`, a new screen is searchable as soon as it is in the sidebar.
Matching uses the `tr-TR` locale so "İ"/"ı" fold the way a Turkish user expects. The input is an ARIA
`combobox` controlling a `listbox`; ArrowUp/ArrowDown move the active option, Enter chooses, Escape closes. Options
are chosen on `mousedown` so the input's `blur` does not close the list before the click registers.

### 3. Sidebar health block and notification bell

Both read live state rather than fixed copy: the health block shows how many catalog sites have a verified
connection, and the bell shows a dot only while newly discovered Vercel projects are waiting.

**Source:** `components/master-panel.tsx`

```tsx
        <div className="system-health">
          <div className="health-head"><span><Activity size={15} /> Site bağlantıları</span><b>{verifiedCount}/{sites.length}</b></div>
          <div className="health-track"><span style={{ width: `${sites.length ? Math.round((verifiedCount / sites.length) * 100) : 0}%` }} /></div>
          <p>{sites.length} site tanımlı · {verifiedCount} doğrulandı</p>
        </div>
```

*"N site tanımlı · M doğrulandı"* reads "N sites defined · M verified". `verifiedCount` comes from
`useConnectionStatus()`, which loads `/api/connections` once when the shell mounts. The bell button navigates to the Vercel &
Deploy view, and its `aria-label` states the number of pending projects ("Bildirim yok", "no notifications", when
there are none).

### 4. Background Vercel sync owned by the shell

The shell keeps deployment status fresh while the panel is open: a light check (projects + deployments) every
2 minutes, a full sync (domains, env names, connector probes) every fifth tick, and a stale-only sync on open.

**Source:** `components/master-panel.tsx`

```tsx
  /** Vercel sync in the background: on open when stale, every 10 minutes while the panel is open, and after publishing. */
  const backgroundSync = useCallback(async (reason: string, onlyIfStale = false, full = true) => {
    try {
      const overview = await requestApi<VercelOverviewData>("/api/vercel");
      if (!overview.configured) return;
      const last = overview.syncState?.lastSyncAt ? Date.parse(overview.syncState.lastSyncAt) : 0;
      const result = onlyIfStale && Date.now() - last < 2 * 60_000 ? { overview } : await vercelAction({ action: "sync", reason, full: full && !(onlyIfStale && Date.now() - last < 10 * 60_000) });
      setPendingProjects(result.overview.pending);
      await loadSites();
    } catch { /* The panel works without Vercel; the Vercel screen shows the error. */ }
  }, [loadSites]);
  useEffect(() => {
    void loadSites(); void backgroundSync("panel-open", true);
    // Deployment status every 2 minutes (projects + deployments only); a full sync every 10 minutes.
    let tick = 0;
    const timer = setInterval(() => { tick++; void backgroundSync(tick % 5 === 0 ? "panel-full" : "panel-poll", false, tick % 5 === 0); }, 2 * 60_000);
    return () => clearInterval(timer);
  }, [loadSites, backgroundSync]);
```

The `catch` is intentionally silent: Vercel is optional, and the Vercel screen is where its errors are surfaced.
The server protects itself against overlapping syncs with a lock (see [deployment-engine.md](deployment-engine.md)),
so several open tabs cannot stampede the Vercel API.

### 5. Global notices and pending-project prompts

One notice slot for the whole panel, plus up to three actionable prompts for newly discovered Vercel projects
(*Şimdi bağla* = "connect now", *Yok say* = "ignore").

**Source:** `components/master-panel.tsx`

```tsx
          {notice && <div className="notice"><CheckCircle2 size={18} /><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Bildirimi kapat"><X size={16} /></button></div>}
          {view !== "deploy" && pendingProjects.slice(0, 3).map((item) => <div className="notice vercel-pending" key={item.projectId}><span><strong>Yeni Vercel projesi algılandı:</strong> {item.name}{item.domain ? ` (${item.domain})` : ""}</span><div>
            <button className="button primary" disabled={pendingBusy} onClick={() => void pendingAction({ action: "connect-project", projectId: item.projectId }, `${item.name} bağlandı ve doğrulandı.`)}>Şimdi bağla</button>
            <button className="button secondary" disabled={pendingBusy} onClick={() => void pendingAction({ action: "ignore-project", projectId: item.projectId }, `${item.name} yok sayıldı.`)}>Yok say</button>
            // …
          </div></div>)}
```

Prompts are hidden on the Vercel & Deploy view because that screen already lists pending projects in context. The
toast (`.notice`) is fixed in the top right, while `.notice.vercel-pending` is `position: static` and sits in the
page flow, so a prompt and a toast can be on screen together without overlapping.

### 6. The control-center screen

The overview fetches operational counters once on mount and guards against setting state after unmount with an
`active` flag (see [analytics.md](analytics.md) for the endpoint).

**Source:** `components/operational-overview.tsx`

```tsx
type Stats={connected:number;published:number;scheduled:number;failed:number;events:{at:string;action:string;title:string}[]};
export function OperationalOverview({onSites,onAutomation,onPublishing}:{onSites:()=>void;onAutomation:()=>void;onPublishing:()=>void}) {
  const [stats,setStats]=useState<Stats|null>(null);const [error,setError]=useState("");
  useEffect(()=>{let active=true;fetch("/api/dashboard",{cache:"no-store"}).then(async response=>{const data=await readApiResponse(response) as Stats & {error?:string};if(!response.ok) throw new Error(data.error || "Özet yüklenemedi.");if(active) setStats(data);}).catch(error=>{if(active) setError(error.message);});return()=>{active=false;};},[]);
```

### 7. Layout tokens and the responsive shell

A fixed 256 px sidebar, a sticky blurred top bar, a centered content column capped at 1540 px, and one breakpoint
(900 px) where the sidebar becomes an off-canvas drawer.

**Source:** `app/globals.css`

```css
:root {
  --bg: #070a0a;
  --sidebar: #090d0d;
  --surface: #101515;
  /* … */
  --border: #222c2a;
  --border-strong: #31403d;
  --text: #f4f7f5;
  --muted: #8e9d99;
  /* … */
  --accent: #79f2bf;
  --accent-strong: #42d99a;
  /* … */
}
/* … */
.sidebar { width: 256px; min-height: 100vh; position: fixed; inset: 0 auto 0 0; display: flex; flex-direction: column; padding: 18px 14px 14px; background: rgba(9, 13, 13, .96); border-right: 1px solid var(--border); z-index: 30; }
/* … */
.main-area { width: calc(100% - 256px); min-width: 0; margin-left: 256px; }
.topbar { height: 70px; position: sticky; top: 0; z-index: 20; display: flex; align-items: center; justify-content: space-between; gap: 20px; padding: 0 34px; background: rgba(7,10,10,.86); backdrop-filter: blur(18px); border-bottom: 1px solid rgba(34,44,42,.82); }
/* … */
.content-area { max-width: 1540px; margin: 0 auto; padding: 38px 40px 72px; }
/* … */
@media (max-width: 900px) {
  .sidebar { transform: translateX(-102%); box-shadow: 20px 0 70px rgba(0,0,0,.5); transition: transform .22s ease; }
  .sidebar.is-open { transform: translateX(0); }
  .close-mobile, .mobile-menu { display: inline-grid !important; }
  .nav-backdrop { display: block; position: fixed; inset: 0; border: 0; background: rgba(0,0,0,.62); z-index: 25; }
  .main-area { width: 100%; margin-left: 0; }
  /* … */
}
```

(`/* … */` marks trimmed lines.)

## Engineering notes

- **`min-width: 0` on `.main-area`** is what keeps wide tables and the SEO grid from forcing horizontal page
  scroll inside a flex container.
- **Drawer backdrop is a `<button>`** with an `aria-label`, so it is keyboard- and screen-reader-operable, and a
  tap outside closes the menu.
- **Interval hygiene.** Every polling effect in the shell and screens returns a cleanup that clears its timer;
  the overview uses an `active` flag to avoid state updates after unmount.
- **Global shortcut, single listener.** `CommandSearch` registers one `keydown` listener on `window` and removes it
  on unmount. It calls `preventDefault()` only for ⌘K / Ctrl+K, so other shortcuts reach the browser untouched.
- **Command search is desktop-only.** Below 1180 px `.command-search` is hidden; on small screens navigation goes
  through the drawer.
- **One notice at a time.** A later notice replaces an earlier one. That keeps the UI calm but can hide a failure
  message if two screens report in quick succession.

## Why it is built this way

**Decision:** a single client shell with view state instead of one App Router route per screen.

**Alternatives considered:**
- *Route per screen* (`/sites`, `/seo`, …) with a shared layout. Gives deep links and browser history, but every
  navigation would remount screen state (AI drafts, selected sites, scan progress) unless that state moved to a
  global store or the URL.
- *A client state library* (Redux, Zustand) to survive route changes. Adds a dependency and a second source of
  truth for data that the server already owns.

**Trade-offs accepted:** no deep links or back-button navigation between screens; in exchange, long-running work
(an AI generation, a multi-site scan loop) is never lost by switching screens, and the shell is the single owner of
cross-cutting concerns (site registry refresh, Vercel poll, notices). Deep links are a reasonable roadmap item once
the view state is mirrored into the URL.

## Best practices demonstrated

- Typed registries (`View`, `navGroups`, `Record<View, string>`) that make incomplete additions a compile error.
- Silent failure only where another screen owns the error surface.
- Cleanup for every interval; unmount guards on async effects.
- Tokenized colors on `:root`, one mobile breakpoint for the drawer, `min-width: 0` for flex children.
- Accessible off-canvas navigation (labelled toggle, labelled backdrop button) and an ARIA combobox for search.
- Derived UI (search commands, badge count, health block) computed from the same registries and catalog.

## Related

- [docs/Architecture.md](../docs/Architecture.md) · [system architecture diagram](../docs/diagrams/system-architecture.svg)
- Screenshots: [dashboard](../assets/screenshots/dashboard.png), [command center](../assets/screenshots/command-center.png)
- Sibling walkthroughs: [state-management.md](state-management.md), [component-library.md](component-library.md),
  [analytics.md](analytics.md), [deployment-engine.md](deployment-engine.md)
