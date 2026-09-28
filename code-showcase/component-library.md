# Component Library — SEO Center primitives, tokens, accessibility

## Overview

The panel does not use a UI kit. Screens are built from a small set of hand-written primitives and a CSS design
token layer. The most deliberate part is the SEO & GEO Center's library in `components/seo/primitives.tsx` and the
scoped `.sx-*` block in `app/globals.css`: score rings, progress bars, health badges, star ratings, deltas,
skeletons, site logos and a dependency-free trend chart. Icons come from `lucide-react`; there is no charting
library.

![SEO site detail](../assets/screenshots/seo-site-detail.png)

## Architecture notes

| Layer | Where |
| --- | --- |
| Global tokens (`--bg`, `--surface*`, `--text`, `--accent`, …) | `app/globals.css` `:root` |
| SEO Center scope (`--sx-*` surfaces/ink, `--sx-seo`/`--sx-geo` series, `--st-*` status tones) | `app/globals.css` `.sx-root` |
| Primitives | `components/seo/primitives.tsx` |
| Consumers | `components/seo-center.tsx`, `components/seo/site-detail.tsx` |
| Dialog behavior (focus trap, Escape) | `components/publication-manager.tsx`, `components/publish-options.tsx` |

The status vocabulary (`good`, `warning`, `serious`, `critical`, `none`) is defined once in
`lib/seo/presentation.ts` (`HealthTone`) and mapped to color tokens in one place (`toneVar`), so a tone can never be
rendered with an ad-hoc color.

## The code

### 1. Motion that respects the user

**Source:** `components/seo/primitives.tsx`

```tsx
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** Counts from 0 to the value once (skipped when the user prefers reduced motion). */
export function useCountUp(value: number | null, duration = 700) {
  const [shown, setShown] = useState<number | null>(value === null ? null : reducedMotion() ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (value === null) { setShown(null); return; }
    if (reducedMotion()) { setShown(value); return; }
    const start = performance.now(); const origin = from.current; let frame = 0;
    const tick = (now: number) => { const t = Math.min(1, (now - start) / duration); const eased = 1 - Math.pow(1 - t, 3); setShown(Math.round(origin + (value - origin) * eased)); if (t < 1) frame = requestAnimationFrame(tick); else from.current = value; };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [value, duration]);
  return shown;
}
```

Animations start from the *previous* value (`from.current`), so a re-scan animates 72 → 81, not 0 → 81. The
`requestAnimationFrame` loop is cancelled on unmount or value change.

### 2. Score ring: one value, labelled, color is secondary

**Source:** `components/seo/primitives.tsx`

```tsx
const toneVar: Record<HealthTone, string> = { good: "var(--st-good)", warning: "var(--st-warning)", serious: "var(--st-serious)", critical: "var(--st-critical)", none: "var(--border-strong)" };

/** Circular score (single headline value). Arc color = status tone; the number stays in text ink. */
export function ScoreRing({ value, tone, size = 132, label, caption }: { value: number | null; tone: HealthTone; size?: number; label: string; caption?: React.ReactNode }) {
  const stroke = size >= 110 ? 9 : 6; const r = (size - stroke) / 2; const c = 2 * Math.PI * r;
  const [drawn, setDrawn] = useState(reducedMotion() ? value ?? 0 : 0);
  useEffect(() => { const id = requestAnimationFrame(() => setDrawn(value ?? 0)); return () => cancelAnimationFrame(id); }, [value]);
  return <figure className="sx-ring" style={{ width: size }} aria-label={`${label}: ${value ?? "ölçülmedi"}`}>
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-hidden="true">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--sx-track)" strokeWidth={stroke} />
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={toneVar[tone]} strokeWidth={stroke} strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - drawn / 100)} transform={`rotate(-90 ${size / 2} ${size / 2})`} className="sx-ring-arc" />
    </svg>
    <div className="sx-ring-center"><strong style={{ fontSize: size >= 110 ? 38 : 22 }}><CountUp value={value} /></strong><span>{label}</span></div>
    {caption && <figcaption>{caption}</figcaption>}
  </figure>;
}
```

The SVG is decorative (`aria-hidden`); the accessible name lives on the `<figure>` ("SEO: 81", or
*"ölçülmedi"*, "not measured"). The arc animates through a CSS transition on `stroke-dashoffset`, which is disabled
under reduced motion by the scope rule below.

### 3. Status never relies on color alone

**Source:** `components/seo/primitives.tsx`

```tsx
export function Stars({ count, label }: { count: number; label: string }) {
  return <span className="sx-stars" role="img" aria-label={`${label}: 5 üzerinden ${count}`} title={label}>{[1, 2, 3, 4, 5].map((n) => <Star key={n} size={12} className={n <= count ? "on" : ""} />)}</span>;
}

/** Status always ships with an icon and a label, never color alone. */
export function HealthBadge({ health, compact = false }: { health: Health; compact?: boolean }) {
  const Icon = health.tone === "critical" ? AlertOctagon : health.tone === "serious" || health.tone === "warning" ? AlertTriangle : health.tone === "good" ? CheckCircle2 : CircleDashed;
  return <span className={`sx-health ${health.tone} ${compact ? "compact" : ""}`}><Icon size={compact ? 13 : 14} />{health.label}</span>;
}
```

Every health state has a distinct icon shape *and* text, so it survives color-blindness, grayscale printing and
screen readers. Star ratings announce as "Impact: 4 out of 5" (*"5 üzerinden 4"*).

### 4. A chart drawn at real pixel width

**Source:** `components/seo/primitives.tsx`

```tsx
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => { const node = plotRef.current; if (!node || typeof ResizeObserver === "undefined") return; const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width)))); observer.observe(node); return () => observer.disconnect(); }, []);
  // …
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="SEO ve GEO puanlarının taramalara göre değişimi" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
```

Instead of a fixed `viewBox` scaled by CSS (which scales text and stroke widths with the container), the chart
measures its container with `ResizeObserver` and redraws at the real width. Axis labels stay 11 px and lines stay
2 px on every screen. The chart has an accessible name; the numeric history is also listed in the report timeline.

### 5. Scoped design tokens

**Source:** `app/globals.css`

```css
.sx-root { --sx-card:#0e1312; --sx-card-2:#121918; --sx-line:#1d2725; --sx-line-2:#27332f; --sx-track:#1c2523; --sx-ink:#eef3f1; --sx-ink-2:#b7c3bf; --sx-ink-3:#7f8d89;
  --sx-seo:#3987e5; --sx-geo:#d95926; --st-good:#0ca30c; --st-warning:#fab219; --st-serious:#ec835a; --st-critical:#d03b3b;
  display:grid; gap:20px; color:var(--sx-ink); font-feature-settings:"tnum" 1, "cv11" 1; }
/* … */
.sx-health.good svg { color:var(--st-good); } .sx-health.warning svg { color:var(--st-warning); } .sx-health.serious svg { color:var(--st-serious); } .sx-health.critical svg { color:var(--st-critical); } .sx-health.none svg { color:var(--sx-ink-3); }
/* … */
@media (prefers-reduced-motion: reduce) { .sx-root *,.sx-root *::before { transition:none !important; animation:none !important; } }
```

Tokens are declared on the `.sx-root` container rather than `:root`, so the SEO Center's tighter palette (distinct
series colors for SEO vs GEO, a four-step status scale) cannot leak into older screens. Tabular numerals
(`"tnum"`) keep score columns aligned while numbers count up. Status tone is applied to the icon, while the label
stays in the ink color for contrast.

### 6. Dialog focus management

**Source:** `components/publication-manager.tsx`

```tsx
  useEffect(()=>{
    if(!detail) return;const previous=document.activeElement as HTMLElement|null;const dialog=document.querySelector<HTMLElement>(confirm ? ".confirmation-dialog" : ".publication-dialog");const controls=()=>Array.from(dialog?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select,textarea,summary,[tabindex="0"]') || []);controls()[0]?.focus();
    const handler=(event:KeyboardEvent)=>{if(event.key==="Escape" && !busy) {event.preventDefault();if(confirm) setConfirm(null);else setDetail(null);}if(event.key==="Tab") {const items=controls();if(!items.length) return;if(event.shiftKey && document.activeElement===items[0]) {event.preventDefault();items[items.length-1].focus();}else if(!event.shiftKey && document.activeElement===items[items.length-1]) {event.preventDefault();items[0].focus();}}};document.addEventListener("keydown",handler);return()=>{document.removeEventListener("keydown",handler);previous?.focus();};
```

Focus moves into the dialog on open, Tab and Shift+Tab wrap inside it, Escape closes the innermost layer (but not
while a request is in flight), and focus returns to the element that opened it. Confirmation dialogs in the SEO
Center and publish summary use `role="alertdialog"` with `aria-modal="true"`.

### 7. Honest comparisons: deltas and gaps

**Source:** `components/seo/primitives.tsx`

```tsx
export function Delta({ now, before, suffix = "" }: { now: number | null | undefined; before: number | null | undefined; suffix?: string }) {
  if (now === null || now === undefined || before === null || before === undefined) return null;
  const diff = now - before;
  return <span className={`sx-delta ${diff > 0 ? "up" : diff < 0 ? "down" : "flat"}`}>{diff > 0 ? "+" : diff === 0 ? "±" : ""}{diff}{suffix}</span>;
}
// …
  // An unmeasured scan breaks the line instead of being bridged, so a gap is never drawn as a trend.
  const path = (key: "seo" | "geo") => data.map((point, i) => point[key] === null ? null : `${i === 0 || data[i - 1][key] === null ? "M" : "L"} ${x(i)},${y(point[key]!)}`).filter(Boolean).join(" ");
```

Both primitives refuse to invent a comparison. `Delta` renders nothing when either side was not measured, and an
unchanged score reads "±0" rather than a bare "0" that could be mistaken for a score. In the trend chart, a `null`
point starts a new subpath (`M`) instead of continuing the line (`L`), so a scan where PageSpeed or the site was
unavailable shows up as a visible gap rather than a straight line implying a measurement.

### 8. Command search as an ARIA combobox

The top-bar search (`CommandSearch` in `components/master-panel.tsx`, walked through in
[dashboard-layout.md](dashboard-layout.md)) follows the same hand-rolled approach as the dialogs: the input has
`role="combobox"`, `aria-expanded` and `aria-controls`, the results are a `role="listbox"` of `role="option"` items
with `aria-selected`, and ArrowUp/ArrowDown/Enter/Escape are handled on the input. ⌘K / Ctrl+K focuses it from
anywhere. Its styles (`.command-search`, `.command-results`) live next to `.search-box` in `app/globals.css`.

## Engineering notes

- **Hydration.** `useCountUp` and `ScoreRing` read `matchMedia` during the initial `useState` call. On the server
  `window` is undefined, so a client that prefers reduced motion can render a different first frame than the server
  HTML. React tolerates text mismatches with a warning; moving the check into an effect would remove it.
- **Two token systems.** Older screens use `:root` tokens and some literal colors; the SEO Center uses `.sx-*`.
  `toneVar.none` reaches back to the global `--border-strong`. Consolidating into one token set is a known cleanup.
- **Favicons as logos.** `SiteLogo` loads `<origin>/favicon.ico` with `referrerPolicy="no-referrer"` and
  `loading="lazy"`, and falls back to initials on error; `alt=""` because the site name is always next to it.
- **Skeletons** are `aria-hidden` and their shimmer is disabled under reduced motion (inside `.sx-root`).
- **Dialog wiring is duplicated.** The publication dialog implements its focus trap inline; a shared `useDialog`
  hook would remove the copy-paste between managers.

## Why it is built this way

**Decision:** small, purpose-built primitives and CSS tokens instead of a component framework or charting library.

**Alternatives considered:**
- *A UI kit (shadcn/ui, MUI).* Faster start, but the panel needs a handful of components, and a kit brings styling
  conventions that fight a dense, dark operations UI.
- *A charting library (Recharts, Chart.js).* One trend chart with two series does not justify another
  client-side dependency; an SVG path and a crosshair are about 30 lines.
- *CSS-in-JS.* Unnecessary with custom properties; plain CSS keeps server rendering simple.

**Trade-offs accepted:** accessibility behaviors (focus traps, keyboard handling) are hand-rolled and need to be
maintained by me rather than inherited from a tested library.

## Best practices demonstrated

- `prefers-reduced-motion` honored in both JavaScript and CSS.
- Icon + text for every status; accessible names on figures, decorative SVG hidden.
- Tokens scoped to a feature root; tabular numerals for changing numbers.
- Resolution-true SVG rendering via `ResizeObserver`.
- Focus trap with restore, and Escape that respects in-flight work.
- `null` carried through to the pixels: no delta and no line segment across an unmeasured scan.

## Related

- [docs/Architecture.md](../docs/Architecture.md) · Screenshots: [SEO Center](../assets/screenshots/seo-center.png),
  [site detail](../assets/screenshots/seo-site-detail.png)
- Sibling walkthroughs: [dashboard-layout.md](dashboard-layout.md), [analytics.md](analytics.md),
  [seo-engine.md](seo-engine.md)
