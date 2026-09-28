"use client";
import { useEffect, useRef, useState } from "react";
import { AlertOctagon, AlertTriangle, CheckCircle2, CircleDashed, Star } from "lucide-react";
import type { Health, HealthTone } from "@/lib/seo/presentation";

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

export function CountUp({ value, suffix = "" }: { value: number | null; suffix?: string }) {
  const shown = useCountUp(value);
  return <>{shown === null ? "—" : `${shown}${suffix}`}</>;
}

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

/** Thin horizontal progress bar that grows from 0 on mount. */
export function Bar({ value, tone }: { value: number | null; tone: HealthTone }) {
  const [width, setWidth] = useState(reducedMotion() ? value ?? 0 : 0);
  useEffect(() => { const id = requestAnimationFrame(() => setWidth(value ?? 0)); return () => cancelAnimationFrame(id); }, [value]);
  return <div className="sx-bar" role="presentation"><i style={{ width: `${width}%`, background: toneVar[tone] }} /></div>;
}

export function Stars({ count, label }: { count: number; label: string }) {
  return <span className="sx-stars" role="img" aria-label={`${label}: 5 üzerinden ${count}`} title={label}>{[1, 2, 3, 4, 5].map((n) => <Star key={n} size={12} className={n <= count ? "on" : ""} />)}</span>;
}

/** Status always ships with an icon and a label, never color alone. */
export function HealthBadge({ health, compact = false }: { health: Health; compact?: boolean }) {
  const Icon = health.tone === "critical" ? AlertOctagon : health.tone === "serious" || health.tone === "warning" ? AlertTriangle : health.tone === "good" ? CheckCircle2 : CircleDashed;
  return <span className={`sx-health ${health.tone} ${compact ? "compact" : ""}`}><Icon size={compact ? 13 : 14} />{health.label}</span>;
}

export function Delta({ now, before, suffix = "" }: { now: number | null | undefined; before: number | null | undefined; suffix?: string }) {
  if (now === null || now === undefined || before === null || before === undefined) return null;
  const diff = now - before;
  return <span className={`sx-delta ${diff > 0 ? "up" : diff < 0 ? "down" : "flat"}`}>{diff > 0 ? "+" : diff === 0 ? "±" : ""}{diff}{suffix}</span>;
}

export function Skeleton({ height = 16, width = "100%", radius = 8 }: { height?: number; width?: number | string; radius?: number }) {
  return <span className="sx-skeleton" style={{ height, width, borderRadius: radius }} aria-hidden="true" />;
}

/** Site logo from its own favicon, falling back to the initials avatar. */
export function SiteLogo({ origin, initials, color, size = 36 }: { origin: string; initials: string; color: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  return <span className="sx-logo" style={{ width: size, height: size, "--site-color": color } as React.CSSProperties}>
    {!failed ? <img src={`${origin}/favicon.ico`} alt="" width={size - 12} height={size - 12} loading="lazy" referrerPolicy="no-referrer" onError={() => setFailed(true)} /> : <b>{initials}</b>}
  </span>;
}

/* --------------------------------------------------------------- trend chart */

export type TrendPoint = { at: string; seo: number | null; geo: number | null };
const SERIES = [{ key: "seo" as const, label: "SEO", color: "var(--sx-seo)" }, { key: "geo" as const, label: "GEO", color: "var(--sx-geo)" }];

/** SEO & GEO over scans. One 0–100 axis, 2px lines, end labels, legend, crosshair tooltip. */
export function TrendChart({ points }: { points: TrendPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const plotRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useEffect(() => { const node = plotRef.current; if (!node || typeof ResizeObserver === "undefined") return; const observer = new ResizeObserver(([entry]) => setWidth(Math.max(280, Math.round(entry.contentRect.width)))); observer.observe(node); return () => observer.disconnect(); }, []);
  // Drawn at the real pixel width so text and strokes never scale with the page.
  const W = width, H = 200, L = 30, R = 44, T = 12, B = 26;
  const data = [...points].reverse();
  if (data.length < 2) return <p className="sx-muted">Trend grafiği ikinci taramadan sonra görünür.</p>;
  const x = (i: number) => L + (i * (W - L - R)) / (data.length - 1);
  const y = (v: number) => T + ((100 - v) * (H - T - B)) / 100;
  // An unmeasured scan breaks the line instead of being bridged, so a gap is never drawn as a trend.
  const path = (key: "seo" | "geo") => data.map((point, i) => point[key] === null ? null : `${i === 0 || data[i - 1][key] === null ? "M" : "L"} ${x(i)},${y(point[key]!)}`).filter(Boolean).join(" ");
  const fmt = (at: string) => new Date(at).toLocaleDateString("tr-TR", { day: "numeric", month: "short" });
  const onMove = (event: React.MouseEvent<SVGSVGElement>) => { const box = event.currentTarget.getBoundingClientRect(); const px = ((event.clientX - box.left) / box.width) * W; setHover(Math.max(0, Math.min(data.length - 1, Math.round(((px - L) / (W - L - R)) * (data.length - 1))))); };
  const active = hover !== null ? data[hover] : null;
  return <div className="sx-trend">
    <div className="sx-legend">{SERIES.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}</span>)}</div>
    <div className="sx-trend-plot" ref={plotRef}>
      <svg viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label="SEO ve GEO puanlarının taramalara göre değişimi" onMouseMove={onMove} onMouseLeave={() => setHover(null)}>
        {[0, 50, 100].map((tick) => <g key={tick}><line x1={L} x2={W - R} y1={y(tick)} y2={y(tick)} className="sx-gridline" /><text x={L - 8} y={y(tick) + 4} textAnchor="end" className="sx-axis">{tick}</text></g>)}
        {data.map((point, i) => (i === 0 || i === data.length - 1 || data.length <= 6) && <text key={point.at} x={x(i)} y={H - 6} textAnchor={i === 0 ? "start" : i === data.length - 1 ? "end" : "middle"} className="sx-axis">{fmt(point.at)}</text>)}
        {SERIES.map((s) => { const d = path(s.key); return d ? <path key={s.key} d={d} fill="none" stroke={s.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" /> : null; })}
        {SERIES.map((s) => { const last = data[data.length - 1][s.key]; return last === null ? null : <g key={s.key}><circle cx={x(data.length - 1)} cy={y(last)} r={4} fill={s.color} stroke="var(--sx-card)" strokeWidth={2} /><text x={x(data.length - 1) + 9} y={y(last) + 4} className="sx-end-label">{last}</text></g>; })}
        {hover !== null && <g><line x1={x(hover)} x2={x(hover)} y1={T} y2={H - B} className="sx-crosshair" />{SERIES.map((s) => data[hover][s.key] === null ? null : <circle key={s.key} cx={x(hover)} cy={y(data[hover][s.key]!)} r={4} fill={s.color} stroke="var(--sx-card)" strokeWidth={2} />)}</g>}
      </svg>
      {active && hover !== null && <div className="sx-tooltip" style={{ left: `${(x(hover) / W) * 100}%` }}><strong>{new Date(active.at).toLocaleString("tr-TR", { dateStyle: "medium", timeStyle: "short" })}</strong>{SERIES.map((s) => <span key={s.key}><i style={{ background: s.color }} />{s.label}<b>{active[s.key] ?? "—"}</b></span>)}</div>}
    </div>
  </div>;
}
