"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, Check, ChevronDown, Clock3, ExternalLink, EyeOff, Gauge, GitPullRequest, LoaderCircle, RefreshCw, Search, Sparkles, Undo2, WandSparkles, X } from "lucide-react";
import type { CheckResult } from "@/lib/seo/checks";
import { affectedPages, analysisText, categoryDefs, categoryScore, fixKindLabel, healthOf, impactLabel, isOpen, metaFor, overallScore, projection, scoreTone, sortByImpact, type Impact } from "@/lib/seo/presentation";
import { formatDateTime, relativeTime } from "@/lib/status-labels";
import { Bar, CountUp, Delta, HealthBadge, ScoreRing, SiteLogo, Skeleton, Stars, TrendChart } from "@/components/seo/primitives";

type Scores = { seo: number | null; geo: number | null; performance: number | null; [key: string]: number | null };
type Summary = { id: string; scannedAt: string; scores: Scores; issues: number; critical: number; reason: string };
type Page = { url: string; status: number | null; title: string | null; h1: number; words: number; health?: number; indexable?: boolean; hasDescription?: boolean; hasCanonical?: boolean; schemaTypes?: string[]; schemaValid?: boolean; images?: number; imagesMissingAlt?: number };
export type Report = {
  latest: { url: string; scannedAt: string; durationMs: number; scores: Scores; critical: number; checks: CheckResult[]; pages: Page[]; performance: { measured: boolean; source: string | null; score: number | null; lcpMs: number | null; cls: number | null; inpMs: number | null; tbtMs: number | null } };
  history: Summary[]; checkHistory: { id: string; open: string[] }[]; ignored: string[];
  optimization: { status: string; prUrl: string | null; prNumber: number | null; applied: { checkId: string; path: string }[] } | null;
};
export type SiteRef = { siteId: string; name: string; domain: string; origin: string; color: string; initials: string; repository: { repo: string } | null };
type Filter = "all" | Impact | "auto" | "pending" | "resolved" | "ignored";

const filters: { id: Filter; label: string }[] = [
  { id: "all", label: "Tümü" }, { id: "high", label: "Yüksek etki" }, { id: "medium", label: "Orta" }, { id: "low", label: "Düşük" },
  { id: "auto", label: "Otomatik düzeltilebilir" }, { id: "pending", label: "Beklemede" }, { id: "resolved", label: "Çözüldü" }, { id: "ignored", label: "Yok sayılan" },
];
const aiStrategy: Record<string, { strategy: "ai-answer" | "local-business" | "seo-geo"; goal: string }> = {
  "faq-schema": { strategy: "ai-answer", goal: "Müşterilerin sık sorduğu soruları cevaplayan, AI asistanlarının alıntılayabileceği SSS içeriği" },
  "question-headings": { strategy: "ai-answer", goal: "Soru-cevap yapısında, kısa ve net cevaplı rehber içerik" },
  "locality-signals": { strategy: "local-business", goal: "Hizmet bölgesini, konumu ve yerel aramaları öne çıkaran içerik" },
  "ai-readability": { strategy: "seo-geo", goal: "Kısa paragraflar, listeler ve net başlıklarla AI tarafından kolay okunan içerik" },
  breadcrumbs: { strategy: "seo-geo", goal: "Site yapısını breadcrumb ile gösteren SEO + GEO rehber sayfası" },
};

function dayLabel(at: string) {
  const date = new Date(at); const today = new Date(); const diff = Math.floor((new Date(today.toDateString()).getTime() - new Date(date.toDateString()).getTime()) / 86400000);
  return diff === 0 ? "Bugün" : diff === 1 ? "Dün" : date.toLocaleDateString("tr-TR", { day: "numeric", month: "long" });
}

export function SiteDetail({ site, report, loading, githubReady, busy, focus, onBack, onRescan, onOptimize, onIgnore, onCreateContent, onSettings }: {
  site: SiteRef; report: Report | null; loading: boolean; githubReady: boolean; busy: string | null; focus: "overview" | "history";
  onBack: () => void; onRescan: () => void; onOptimize: (checkIds?: string[]) => void; onIgnore: (checkId: string, ignored: boolean) => void;
  onCreateContent: (input: { siteId: string; strategy: "ai-answer" | "local-business" | "seo-geo"; goal: string }) => void; onSettings: () => void;
}) {
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const [openPage, setOpenPage] = useState<string | null>(null);
  const historyRef = useRef<HTMLElement>(null);
  useEffect(() => { if (focus === "history" && report) historyRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [focus, report]);

  const latest = report?.latest;
  const ignored = report?.ignored ?? [];
  const previous = report?.history[1] ?? null;
  const pendingIds = new Set(report?.optimization?.status === "open" ? report.optimization.applied.map((item) => item.checkId) : []);
  const openChecks = useMemo(() => latest ? sortByImpact(latest.checks.filter(isOpen)) : [], [latest]);
  const resolvedIds = useMemo(() => { if (!report || report.checkHistory.length < 2) return []; const now = new Set(report.checkHistory[0].open); return report.checkHistory[1].open.filter((id) => !now.has(id)); }, [report]);
  const proj = useMemo(() => latest ? projection(latest.checks, ignored) : null, [latest, ignored]);

  if (loading || !report || !latest) return <div className="sx-detail">
    <button className="sx-back" onClick={onBack}><ArrowLeft size={15} /> Tüm siteler</button>
    <div className="sx-card sx-pad"><Skeleton height={22} width="40%" /><div style={{ height: 14 }} /><Skeleton height={14} width="80%" /><div style={{ height: 8 }} /><Skeleton height={14} width="65%" /></div>
    <div className="sx-cat-grid">{Array.from({ length: 8 }).map((_, i) => <div key={i} className="sx-card sx-pad"><Skeleton height={12} width="50%" /><div style={{ height: 12 }} /><Skeleton height={26} width="30%" /></div>)}</div>
  </div>;

  const seoHealth = healthOf(latest.scores.seo, latest.critical); const geoHealth = healthOf(latest.scores.geo, latest.critical);
  const overall = healthOf(overallScore(latest.scores.seo, latest.scores.geo), latest.critical);
  const passed = latest.checks.filter((check) => check.status === "pass");
  const notMeasured = latest.checks.filter((check) => check.status === "skip");
  const matches = (check: CheckResult) => {
    if (!query.trim()) return true;
    const meta = metaFor(check); const q = query.toLocaleLowerCase("tr");
    return [meta.title, meta.problem, meta.keywords, check.label, check.id, ...(check.evidence || [])].join(" ").toLocaleLowerCase("tr").includes(q);
  };
  const visible = (filter === "resolved" ? latest.checks.filter((check) => resolvedIds.includes(check.id))
    : filter === "ignored" ? openChecks.filter((check) => ignored.includes(check.id))
    : openChecks.filter((check) => !ignored.includes(check.id)).filter((check) => filter === "all" || (filter === "auto" ? metaFor(check).fix === "auto" : filter === "pending" ? pendingIds.has(check.id) : metaFor(check).impact === filter))).filter(matches);
  const counts: Record<Filter, number> = {
    all: openChecks.filter((c) => !ignored.includes(c.id)).length, high: 0, medium: 0, low: 0, auto: 0, pending: 0, resolved: resolvedIds.length, ignored: openChecks.filter((c) => ignored.includes(c.id)).length,
  };
  for (const check of openChecks.filter((c) => !ignored.includes(c.id))) { counts[metaFor(check).impact]++; if (metaFor(check).fix === "auto") counts.auto++; if (pendingIds.has(check.id)) counts.pending++; }
  const perf = latest.performance;
  const vital = (value: number | null, good: number, poor: number) => value === null ? { label: "—", tone: "none" as const } : value <= good ? { label: "İyi", tone: "good" as const } : value <= poor ? { label: "İyileştirilmeli", tone: "warning" as const } : { label: "Zayıf", tone: "serious" as const };
  const optimizeDisabledReason = !githubReady ? "GitHub bağlantısı gerekli" : !site.repository ? "Vercel projesi bir GitHub reposuna bağlı değil" : report.optimization?.status === "open" ? `Açık PR #${report.optimization.prNumber} birleştirilince` : null;

  return <div className="sx-detail">
    <div className="sx-detail-head">
      <button className="sx-back" onClick={onBack}><ArrowLeft size={15} /> Tüm siteler</button>
      <div className="sx-detail-title">
        <SiteLogo origin={site.origin} initials={site.initials} color={site.color} size={44} />
        <div><h1>{site.name}</h1><p><a href={latest.url} target="_blank" rel="noreferrer">{new URL(latest.url).hostname} <ExternalLink size={12} /></a> · Son tarama {relativeTime(latest.scannedAt)} · {Math.round(latest.durationMs / 1000)} sn</p></div>
        <HealthBadge health={overall} />
      </div>
      <div className="sx-detail-actions">
        <button className="button secondary" disabled={busy !== null} onClick={onRescan}>{busy === "scan" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Tekrar tara</button>
        <button className="button primary" disabled={busy !== null || Boolean(optimizeDisabledReason) || !proj?.fixable.length} title={optimizeDisabledReason || undefined} onClick={() => onOptimize()}>{busy === "optimize" ? <LoaderCircle className="spin" size={16} /> : <GitPullRequest size={16} />} Tümünü optimize et</button>
      </div>
    </div>

    {report.optimization?.status === "open" && report.optimization.prUrl && <div className="sx-banner"><GitPullRequest size={16} /><span>Optimizasyon PR #{report.optimization.prNumber} incelemede. Birleştirildiğinde Vercel deploy eder ve site otomatik yeniden taranır.</span><a href={report.optimization.prUrl} target="_blank" rel="noreferrer">PR'ı aç <ExternalLink size={12} /></a></div>}

    <section className="sx-card sx-summary">
      <div className="sx-summary-text">
        <span className="sx-eyebrow"><Sparkles size={14} /> ROIstation Analizi</span>
        {analysisText(latest.checks, latest.scores.performance, latest.critical).map((line) => <p key={line}>{line}</p>)}
      </div>
      {proj && proj.fixable.length > 0 && <div className="sx-projection">
        <span className="sx-eyebrow">Otomatik optimizasyon sonrası tahmini</span>
        <div className="sx-proj-row"><span>SEO</span><b>{latest.scores.seo ?? "—"}</b><i>→</i><b className="after">{Math.max(latest.scores.seo ?? 0, proj.seo.after ?? 0) || "—"}</b></div>
        <div className="sx-proj-row"><span>GEO</span><b>{latest.scores.geo ?? "—"}</b><i>→</i><b className="after">{Math.max(latest.scores.geo ?? 0, proj.geo.after ?? 0) || "—"}</b></div>
        <dl><dt>Tahmini süre</dt><dd>{proj.minutes} dk</dd><dt>Güven</dt><dd>{proj.confidence}</dd></dl>
        <small>Otomatik veya AI ile düzeltilebilen {proj.fixable.length} bulgu çözüldüğünde, taramayla aynı puanlama formülüyle hesaplanır.</small>
      </div>}
    </section>

    <section className="sx-health-grid">
      {([["SEO sağlığı", latest.scores.seo, previous?.scores.seo, seoHealth], ["GEO sağlığı", latest.scores.geo, previous?.scores.geo, geoHealth]] as const).map(([label, value, before, health]) => <div key={label} className="sx-card sx-health-card">
        <ScoreRing value={value} tone={scoreTone(value)} label={label.split(" ")[0]} />
        <div><span className="sx-eyebrow">{label}</span><HealthBadge health={health} /><p className="sx-muted">{before !== null && before !== undefined && value !== null ? <><Delta now={value} before={before} /> önceki taramaya göre</> : "İlk tarama"}</p></div>
      </div>)}
      <div className="sx-card sx-health-card sx-stat-stack">
        <div><span className="sx-eyebrow">İyileştirme fırsatı</span><strong><CountUp value={counts.all} /></strong></div>
        <div><span className="sx-eyebrow">Otomatik veya AI ile</span><strong><CountUp value={counts.auto + openChecks.filter((c) => !ignored.includes(c.id) && metaFor(c).fix === "ai").length} /></strong></div>
        <div><span className="sx-eyebrow">Son taramada çözülen</span><strong><CountUp value={resolvedIds.length} /></strong></div>
      </div>
    </section>

    <section className="sx-cat-grid">
      {categoryDefs.map((def) => { const value = categoryScore(def, latest.checks, latest.scores.performance); const before = previous && def.key === "performance" ? previous.scores.performance : null; return <div key={def.key} className="sx-card sx-cat" title={def.description}>
        <div className="sx-cat-head"><span>{def.label}</span>{value === null ? <em className="sx-pending">Bekleniyor</em> : <strong><CountUp value={value} /></strong>}</div>
        <Bar value={value} tone={scoreTone(value)} />
        <p>{def.description}</p>{before !== null && value !== null && <Delta now={value} before={before} />}
      </div>; })}
    </section>

    <section className="sx-card sx-pad">
      <div className="sx-section-head"><h2><Gauge size={17} /> Core Web Vitals</h2>{perf.measured && <span className="sx-chip">{perf.source === "field" ? "Gerçek kullanıcı verisi" : "Laboratuvar ölçümü"}</span>}</div>
      {!perf.measured ? <div className="sx-waiting"><Clock3 size={20} /><div><strong>Ölçüm bekleniyor</strong><p>Performans metrikleri, Google PageSpeed API bağlandığında burada görünür. Canlı performans analizi için Ayarlar'dan PAGESPEED_API_KEY ekleyin; bir sonraki taramada ölçülür.</p></div></div>
        : <div className="sx-vitals">{[
          { label: "Yüklenme hızı (LCP)", value: perf.lcpMs, text: perf.lcpMs !== null ? `${(perf.lcpMs / 1000).toLocaleString("tr-TR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} sn` : "—", verdict: vital(perf.lcpMs, 2500, 4000), note: "Hedef ≤ 2,5 sn" },
          { label: "Görsel kararlılık (CLS)", value: perf.cls, text: perf.cls !== null ? perf.cls.toLocaleString("tr-TR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—", verdict: vital(perf.cls, 0.1, 0.25), note: "Hedef ≤ 0,1" },
          { label: perf.inpMs !== null ? "Etkileşim (INP)" : "Engelleme süresi (TBT)", value: perf.inpMs ?? perf.tbtMs, text: (perf.inpMs ?? perf.tbtMs) !== null ? `${Math.round((perf.inpMs ?? perf.tbtMs)!)} ms` : "—", verdict: vital(perf.inpMs ?? perf.tbtMs, 200, perf.inpMs !== null ? 500 : 600), note: "Hedef ≤ 200 ms" },
          { label: "Mobil performans", value: perf.score, text: perf.score !== null ? String(perf.score) : "—", verdict: perf.score === null ? { label: "—", tone: "none" as const } : perf.score >= 90 ? { label: "İyi", tone: "good" as const } : perf.score >= 50 ? { label: "İyileştirilmeli", tone: "warning" as const } : { label: "Zayıf", tone: "serious" as const }, note: "PageSpeed Insights" },
        ].map((item) => <div key={item.label} className="sx-vital"><span>{item.label}</span><strong>{item.text}</strong><HealthBadge compact health={{ label: item.verdict.label, tone: item.verdict.tone }} /><small>{item.note}</small></div>)}</div>}
    </section>

    <section className="sx-card sx-pad">
      <div className="sx-section-head"><h2>İyileştirmeler</h2><span className="sx-muted">En yüksek iş etkisi önce</span></div>
      <div className="sx-toolbar">
        <div className="sx-filters" role="tablist">{filters.map((item) => <button key={item.id} role="tab" aria-selected={filter === item.id} className={filter === item.id ? "active" : ""} onClick={() => setFilter(item.id)}>{item.label}<em>{counts[item.id]}</em></button>)}</div>
        <label className="sx-search"><Search size={14} /><input placeholder="Sayfa, sorun, şema, metadata, canonical, FAQ…" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button aria-label="Aramayı temizle" onClick={() => setQuery("")}><X size={13} /></button>}</label>
      </div>
      {!visible.length ? <div className="sx-empty-list"><Check size={18} /><span>{filter === "all" && !query ? "Açık iyileştirme yok. Harika iş." : "Bu filtreye uyan kayıt yok."}</span></div>
        : <div className="sx-issues">{visible.map((check) => {
          const meta = metaFor(check); const pages = affectedPages(check); const isIgnored = ignored.includes(check.id); const isResolved = filter === "resolved"; const pending = pendingIds.has(check.id);
          const status = isResolved ? "Çözüldü" : isIgnored ? "Yok sayıldı" : pending ? `Beklemede · PR #${report.optimization?.prNumber}` : check.status === "fail" ? "Eksik" : "İyileştirilebilir";
          const expanded = openIssue === check.id;
          return <article key={check.id} className={`sx-issue ${meta.impact} ${expanded ? "open" : ""}`}>
            <div className="sx-issue-main">
              <div className="sx-issue-title"><h3>{meta.title}</h3><span className={`sx-status ${isResolved ? "resolved" : pending ? "pending" : check.status}`}>{status}</span></div>
              <p>{isResolved ? meta.benefit : meta.problem} <span className="sx-muted">{isResolved ? "" : meta.benefit}</span></p>
              <div className="sx-issue-meta">
                <span className={`sx-impact ${meta.impact}`}>{impactLabel[meta.impact]}</span><Stars count={meta.stars} label={impactLabel[meta.impact]} />
                <span className="sx-meta-item"><Clock3 size={12} /> ~{meta.minutes} dk</span>
                <span className={`sx-chip ${meta.fix}`}>{meta.fix === "auto" ? <WandSparkles size={12} /> : meta.fix === "ai" ? <Sparkles size={12} /> : null}{fixKindLabel[meta.fix]}</span>
                <span className="sx-meta-item">{pages ? `${pages.length} sayfa` : "Tüm site"}</span>
              </div>
            </div>
            {!isResolved && <div className="sx-issue-actions">
              {meta.fix === "auto" && !isIgnored && (githubReady && site.repository ? <button className="button primary sm" disabled={busy !== null || pending || report.optimization?.status === "open"} title={report.optimization?.status === "open" ? "Açık PR birleştirilince kullanılabilir" : undefined} onClick={() => onOptimize([check.id])}>{busy === `fix:${check.id}` ? <LoaderCircle className="spin" size={14} /> : <WandSparkles size={14} />} Otomatik düzelt</button>
                : <button className="button secondary sm" onClick={onSettings} title={!githubReady ? "GitHub bağlantısı gerekli" : "Proje bir GitHub reposuna bağlı değil"}><WandSparkles size={14} /> Otomatik düzelt</button>)}
              {meta.fix === "ai" && !isIgnored && <button className="button primary sm" onClick={() => onCreateContent({ siteId: site.siteId, ...(aiStrategy[check.id] || { strategy: "seo-geo", goal: meta.title }) })}><Sparkles size={14} /> AI ile üret</button>}
              <button className="button ghost sm" onClick={() => setOpenIssue(expanded ? null : check.id)}>Ayrıntılar <ChevronDown size={14} className={expanded ? "flip" : ""} /></button>
              <button className="button ghost sm" disabled={busy !== null} onClick={() => onIgnore(check.id, !isIgnored)}>{isIgnored ? <><Undo2 size={14} /> Geri al</> : <><EyeOff size={14} /> Yok say</>}</button>
            </div>}
            {expanded && <div className="sx-issue-details">
              <div><span className="sx-eyebrow">Bulgu</span><p>{check.finding}</p></div>
              <div><span className="sx-eyebrow">Nasıl düzeltilir</span><p>{check.fix}</p></div>
              {pages && <div><span className="sx-eyebrow">Etkilenen sayfalar</span><div className="sx-page-chips">{pages.slice(0, 12).map((page) => <code key={page}>{page}</code>)}</div></div>}
              {check.evidence?.length && !pages ? <div><span className="sx-eyebrow">Ayrıntı</span><ul>{check.evidence.slice(0, 10).map((item, index) => <li key={index}><code>{item}</code></li>)}</ul></div> : null}
            </div>}
          </article>;
        })}</div>}
    </section>

    <details className="sx-card sx-pad sx-collapse">
      <summary><Check size={16} className="ok" /><strong>{passed.length} kontrol başarılı</strong><span className="sx-muted">Ayrıntıları gör</span><ChevronDown size={15} /></summary>
      <div className="sx-passed">{passed.map((check) => <div key={check.id}><Check size={13} /><span>{metaFor(check).title}</span><small>{check.finding}</small></div>)}</div>
      {notMeasured.length > 0 && <p className="sx-muted sx-note">{notMeasured.length} kontrol bu taramada ölçülmedi veya bu site için geçerli değil; puana katılmadı.</p>}
    </details>

    <section className="sx-card sx-pad">
      <div className="sx-section-head"><h2>Taranan sayfalar</h2><span className="sx-muted">{latest.pages.length} sayfa</span></div>
      <div className="sx-table" role="table">
        <div className="sx-tr sx-th" role="row"><span>Sayfa</span><span>Sağlık</span><span>Dizinde</span><span>Yapısal veri</span><span>Şema</span><span>Durum</span><span>Son tarama</span></div>
        {latest.pages.map((page) => { const path = new URL(page.url).pathname; const expanded = openPage === page.url; return <div key={page.url} className="sx-tr-group">
          <button className="sx-tr" role="row" aria-expanded={expanded} onClick={() => setOpenPage(expanded ? null : page.url)}>
            <span className="sx-page"><b>{page.title || path}</b><small>{path}</small></span>
            <span className="sx-mini-health">{page.health !== undefined ? <><Bar value={page.health} tone={scoreTone(page.health)} /><b>{page.health}</b></> : "—"}</span>
            <span>{page.indexable === undefined ? "—" : page.indexable ? <em className="sx-yes">Evet</em> : <em className="sx-no">Hayır</em>}</span>
            <span>{page.schemaTypes === undefined ? "—" : !page.schemaTypes.length ? <em className="sx-no">Yok</em> : page.schemaValid === false ? <em className="sx-warn">Hatalı</em> : <em className="sx-yes">Geçerli</em>}</span>
            <span className="sx-types">{page.schemaTypes?.slice(0, 2).map((type) => <code key={type}>{type}</code>)}{(page.schemaTypes?.length ?? 0) > 2 && <small>+{page.schemaTypes!.length - 2}</small>}</span>
            <span><em className={page.status && page.status < 400 ? "sx-yes" : "sx-no"}>{page.status ?? "—"}</em></span>
            <span className="sx-muted">{relativeTime(latest.scannedAt)}</span>
          </button>
          {expanded && <div className="sx-page-detail"><span>{page.words} kelime</span><span>Ana başlık: {page.h1}</span><span>Açıklama: {page.hasDescription === undefined ? "—" : page.hasDescription ? "var" : "yok"}</span><span>Tercih edilen adres: {page.hasCanonical === undefined ? "—" : page.hasCanonical ? "var" : "yok"}</span><span>Görsel: {page.images ?? "—"}{page.imagesMissingAlt ? ` (${page.imagesMissingAlt} açıklamasız)` : ""}</span><a href={page.url} target="_blank" rel="noreferrer">Sayfayı aç <ExternalLink size={11} /></a></div>}
        </div>; })}
      </div>
    </section>

    <section className="sx-card sx-pad" ref={historyRef}>
      <div className="sx-section-head"><h2>Tarama geçmişi</h2><span className="sx-muted">{report.history.length} tarama</span></div>
      <TrendChart points={report.history.map((item) => ({ at: item.scannedAt, seo: item.scores.seo, geo: item.scores.geo }))} />
      <ol className="sx-timeline">{report.history.map((item, index) => {
        const older = report.history[index + 1]; const olderOpen = report.checkHistory[index + 1]?.open; const nowOpen = report.checkHistory[index]?.open;
        const resolved = olderOpen && nowOpen ? olderOpen.filter((id) => !nowOpen.includes(id)).length : null;
        return <li key={item.id}><span className="sx-dot" /><div>
          <header><strong>{dayLabel(item.scannedAt)}</strong><span className="sx-muted">{new Date(item.scannedAt).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })} · {item.reason === "deploy" ? "Deploy sonrası" : item.reason === "manual" ? "Elle başlatıldı" : item.reason}</span></header>
          <div className="sx-tl-grid">
            <span>SEO <b>{older?.scores.seo ?? "—"} → {item.scores.seo ?? "—"}</b> <Delta now={item.scores.seo} before={older?.scores.seo} /></span>
            <span>GEO <b>{older?.scores.geo ?? "—"} → {item.scores.geo ?? "—"}</b> <Delta now={item.scores.geo} before={older?.scores.geo} /></span>
            <span>İyileştirme <b>{older ? `${older.issues} → ` : ""}{item.issues}</b></span>
            {resolved !== null && <span>Çözülen <b>{resolved}</b></span>}
          </div></div></li>;
      })}</ol>
    </section>
  </div>;
}
