"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { AlertOctagon, CheckSquare, Eye, GitPullRequest, History, LoaderCircle, RefreshCw, Search, Sparkles, Square, WandSparkles } from "lucide-react";
import { requestApi } from "@/lib/client-api";
import { formatDateTime, relativeTime } from "@/lib/status-labels";
import { healthOf, overallScore, scoreTone } from "@/lib/seo/presentation";
import { Bar, CountUp, Delta, HealthBadge, SiteLogo, Skeleton } from "@/components/seo/primitives";
import { SiteDetail, type Report } from "@/components/seo/site-detail";

type Scores = { seo: number | null; geo: number | null; schema: number | null; metadata: number | null; performance: number | null; technical: number | null; content: number | null; local: number | null };
type Summary = { id: string; scannedAt: string; scores: Scores; issues: number; critical: number; deploymentId: string | null; reason: string; durationMs: number };
type Row = {
  siteId: string; name: string; domain: string; origin: string; color: string; initials: string; latest: Summary | null; previous: Summary | null; scans: number;
  improvements: number; autoFixable: number; ignored: number; criticalReasons: string[];
  deployment: { id: string; state: string; createdAt: string | null } | null; rescanNeeded: boolean;
  repository: { provider: string | null; repo: string; branch: string | null } | null;
  optimization: { status: "open" | "merged" | "closed" | "failed"; prUrl: string | null; prNumber: number | null; createdAt: string; mergedAt: string | null; applied: number; manual: number } | null;
};
type Dashboard = { sites: Row[]; totals: { scanned: number; seo: number | null; geo: number | null; schema: number | null; metadata: number | null; performance: number | null; issues: number; autoFixable: number; lastScanAt: string | null } | null; github: { configured: boolean; login: string | null }; pageSpeedKey: boolean };
type Progress = Record<string, "queued" | "scanning" | "done" | "error">;
export type ContentRequest = { siteId: string; strategy: "ai-answer" | "local-business" | "seo-geo"; goal: string };

export function SeoCenter({ onNotice, onSettings, onCreateContent }: { onNotice: (value: string) => void; onSettings: () => void; onCreateContent: (input: ContentRequest) => void }) {
  const [data, setData] = useState<Dashboard | null>(null);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [progress, setProgress] = useState<Progress>({});
  const [detail, setDetail] = useState<{ siteId: string; focus: "overview" | "history" } | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [confirm, setConfirm] = useState<{ siteIds: string[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const autoScanned = useRef(new Set<string>());
  const running = useRef(false);

  const load = useCallback(async () => {
    try { const next = await requestApi<Dashboard>("/api/seo"); setData(next); setError(""); return next; }
    catch (error) { setError(error instanceof Error ? error.message : "SEO & GEO verisi okunamadı."); return null; }
  }, []);
  const loadReport = useCallback(async (siteId: string, quiet = false) => {
    if (!quiet) { setReportLoading(true); setReport(null); }
    try { setReport(await requestApi<Report>(`/api/seo/report?siteId=${encodeURIComponent(siteId)}`)); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Rapor okunamadı."); setDetail(null); }
    finally { setReportLoading(false); }
  }, [onNotice]);

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
  useEffect(() => { if (data && !selected.length && data.sites.length) setSelected(data.sites.map((row) => row.siteId)); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  // A new Ready production deploy triggers a fresh live scan.
  useEffect(() => {
    if (!data || running.current) return;
    const due = data.sites.filter((row) => row.rescanNeeded && row.deployment && !autoScanned.current.has(`${row.siteId}:${row.deployment.id}`));
    if (!due.length) return;
    due.forEach((row) => autoScanned.current.add(`${row.siteId}:${row.deployment!.id}`));
    onNotice(`${due.length} sitede yeni deploy algılandı; otomatik yeniden analiz ediliyor.`);
    void scan(due.map((row) => row.siteId), "deploy");
  }, [data, scan, onNotice]);

  function openDetail(siteId: string, focus: "overview" | "history" = "overview") { setDetail({ siteId, focus }); void loadReport(siteId); window.scrollTo?.({ top: 0, behavior: "smooth" }); }

  /** Optimizes one or many sites. Each site gets its own pull request built from its own scan and business profile. */
  async function optimize(siteIds: string[], checkIds?: string[]) {
    setConfirm(null); setBusy(checkIds ? `fix:${checkIds[0]}` : "optimize");
    const results: string[] = [];
    for (const siteId of siteIds) {
      const name = data?.sites.find((row) => row.siteId === siteId)?.name || siteId;
      try { const result = await requestApi<{ message: string }>("/api/seo/optimize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ siteId, ...(checkIds ? { checkIds } : {}) }) }); results.push(`${name}: ${result.message}`); }
      catch (error) { results.push(`${name}: ${error instanceof Error ? error.message : "başlatılamadı"}`); }
    }
    onNotice(results.join(" · "));
    await load(); if (detail) await loadReport(detail.siteId, true);
    setBusy(null);
  }
  async function ignore(siteId: string, checkId: string, ignored: boolean) {
    setBusy(`ignore:${checkId}`);
    try { await requestApi("/api/seo/ignore", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ siteId, checkId, ignored }) }); await loadReport(siteId, true); await load(); onNotice(ignored ? "Bulgu yok sayıldı; öneri sayısı ve tahmin güncellendi. Puanlar bir sonraki taramada yenilenir." : "Bulgu yeniden listeye alındı."); }
    catch (error) { onNotice(error instanceof Error ? error.message : "Güncellenemedi."); }
    finally { setBusy(null); }
  }

  const scanning = Object.values(progress).some((state) => state === "queued" || state === "scanning");
  const doneCount = Object.values(progress).filter((state) => state === "done" || state === "error").length;
  const current = Object.entries(progress).find(([, state]) => state === "scanning")?.[0];

  const header = (actions: React.ReactNode) => <div className="sx-page-head"><div><span className="sx-eyebrow">ARAMA & YAPAY ZEKÂ GÖRÜNÜRLÜĞÜ</span><h1>SEO & GEO Merkezi</h1><p>Her sitenin sağlığı ve önce neyin düzeltilmesi gerektiği — canlı taramalardan.</p></div><div className="sx-head-actions">{actions}</div></div>;
  const progressBar = Object.keys(progress).length ? <div className="sx-card sx-progress" role="status">
    <div><strong>{scanning ? "Analiz sürüyor" : "Analiz tamamlandı"}</strong><span className="sx-muted">{doneCount}/{Object.keys(progress).length}{current ? ` · ${data?.sites.find((row) => row.siteId === current)?.name} taranıyor` : ""}</span></div>
    <div className="sx-bar"><i style={{ width: `${(doneCount / Object.keys(progress).length) * 100}%`, background: "var(--sx-seo)" }} /></div>
  </div> : null;

  if (!data) return <div className="sx-root">{header(null)}{error ? <div className="manager-error" role="alert">{error}</div> : <>
    <div className="sx-stats">{Array.from({ length: 5 }).map((_, i) => <div key={i} className="sx-card sx-stat"><Skeleton height={11} width="50%" /><div style={{ height: 10 }} /><Skeleton height={28} width="40%" /></div>)}</div>
    <div className="sx-grid">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="sx-card sx-site"><Skeleton height={36} width={36} radius={10} /><div style={{ height: 12 }} /><Skeleton height={14} width="60%" /><div style={{ height: 18 }} /><Skeleton height={40} /></div>)}</div>
  </>}</div>;

  if (detail) {
    const row = data.sites.find((item) => item.siteId === detail.siteId);
    if (row) return <div className="sx-root">
      {progressBar}
      <SiteDetail site={{ siteId: row.siteId, name: row.name, domain: row.domain, origin: row.origin, color: row.color, initials: row.initials, repository: row.repository }}
        report={report} loading={reportLoading} githubReady={data.github.configured} busy={busy ?? (progress[row.siteId] === "scanning" ? "scan" : null)} focus={detail.focus}
        onBack={() => { setDetail(null); setReport(null); }}
        onRescan={() => void scan([row.siteId], "manual").then(() => loadReport(row.siteId, true))}
        onOptimize={(checkIds) => checkIds ? void optimize([row.siteId], checkIds) : setConfirm({ siteIds: [row.siteId] })}
        onIgnore={(checkId, ignored) => void ignore(row.siteId, checkId, ignored)}
        onCreateContent={onCreateContent} onSettings={onSettings} />
      {confirm && <OptimizeDialog rows={data.sites.filter((item) => confirm.siteIds.includes(item.siteId))} github={data.github.configured} onCancel={() => setConfirm(null)} onConfirm={(ids) => void optimize(ids)} onSettings={onSettings} />}
    </div>;
  }

  const startButton = <button className="button primary" disabled={scanning || !selected.length} onClick={() => void scan(selected, "manual")}>{scanning ? <LoaderCircle className="spin" size={16} /> : <WandSparkles size={16} />}{data.totals ? `Seçili ${selected.length} siteyi tara` : "Analizi başlat"}</button>;
  const allSelected = selected.length === data.sites.length;
  const selector = <div className="sx-select-row">
    <button className="sx-link" onClick={() => setSelected(allSelected ? [] : data.sites.map((row) => row.siteId))}>{allSelected ? <CheckSquare size={15} /> : <Square size={15} />} {allSelected ? "Tüm siteler seçili" : "Tümünü seç"}</button>
    <span className="sx-muted">{selected.length} / {data.sites.length} site seçili</span>
  </div>;

  if (!data.totals) return <div className="sx-root">{header(startButton)}{error && <div className="manager-error" role="alert">{error}</div>}{progressBar}
    <section className="sx-card sx-empty">
      <div className="sx-empty-icon"><Search size={22} /></div>
      <h2>SEO & GEO analizi henüz yapılmadı.</h2>
      <p>Bağlı sitelerini analiz etmek için "Analizi başlat"a bas.</p>
      <p className="sx-muted">Analiz, seçilen her siteyi tek tek inceler ve gerçek SEO ve GEO puanlarını hesaplar.</p>
      {selector}
      <div className="sx-empty-sites">{data.sites.map((row) => <label key={row.siteId} className={selected.includes(row.siteId) ? "on" : ""}><input type="checkbox" checked={selected.includes(row.siteId)} disabled={scanning} onChange={() => setSelected(selected.includes(row.siteId) ? selected.filter((id) => id !== row.siteId) : [...selected, row.siteId])} /><SiteLogo origin={row.origin} initials={row.initials} color={row.color} size={28} /><span>{row.name}<small>{row.domain}</small></span></label>)}</div>
      {startButton}
    </section></div>;

  const totals = data.totals;
  const q = query.toLocaleLowerCase("tr");
  const rows = data.sites.filter((row) => !q || `${row.name} ${row.domain}`.toLocaleLowerCase("tr").includes(q));
  const selectedScanned = selected.filter((id) => data.sites.find((row) => row.siteId === id)?.latest);
  return <div className="sx-root">
    {header(<>
      <button className="button secondary" disabled={scanning || !selected.length} onClick={() => void scan(selected, "manual")}>{scanning ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Seçilileri tara</button>
      <button className="button primary" disabled={busy !== null || !selectedScanned.length} onClick={() => setConfirm({ siteIds: selectedScanned })}><GitPullRequest size={16} /> {selectedScanned.length > 1 ? `${selectedScanned.length} siteyi optimize et` : "Optimize et"}</button>
    </>)}
    {error && <div className="manager-error" role="alert">{error}</div>}
    {progressBar}
    <section className="sx-stats">
      {([["Ortalama SEO", totals.seo], ["Ortalama GEO", totals.geo]] as const).map(([label, value]) => <div key={label} className="sx-card sx-stat"><span>{label}</span><strong><CountUp value={value} /></strong><Bar value={value} tone={scoreTone(value)} /></div>)}
      <div className="sx-card sx-stat"><span>İyileştirme fırsatı</span><strong><CountUp value={totals.issues} /></strong><small>{totals.scanned} sitede</small></div>
      <div className="sx-card sx-stat"><span>Otomatik veya AI ile</span><strong><CountUp value={totals.autoFixable} /></strong><small>onayınla uygulanabilir</small></div>
      <div className="sx-card sx-stat"><span>Son tarama</span><strong className="sx-stat-text">{relativeTime(totals.lastScanAt, now)}</strong><small>{formatDateTime(totals.lastScanAt)}</small></div>
    </section>

    <div className="sx-toolbar">
      {selector}
      <label className="sx-search"><Search size={14} /><input placeholder="Site ara" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
    </div>

    <section className="sx-grid">{rows.map((row) => {
      const state = progress[row.siteId];
      const overall = overallScore(row.latest?.scores.seo ?? null, row.latest?.scores.geo ?? null);
      const health = row.latest ? healthOf(overall, row.criticalReasons.length) : { label: "Taranmadı", tone: "none" as const };
      const checked = selected.includes(row.siteId);
      const trendNow = overall; const trendBefore = row.previous ? overallScore(row.previous.scores.seo, row.previous.scores.geo) : null;
      return <article key={row.siteId} className={`sx-card sx-site ${checked ? "selected" : ""} ${state === "scanning" ? "scanning" : ""}`}>
        <header>
          <button className="sx-check" aria-label={`${row.name} seç`} aria-pressed={checked} onClick={() => setSelected(checked ? selected.filter((id) => id !== row.siteId) : [...selected, row.siteId])}>{checked ? <CheckSquare size={16} /> : <Square size={16} />}</button>
          <SiteLogo origin={row.origin} initials={row.initials} color={row.color} />
          <div className="sx-site-name"><strong>{row.name}</strong><span>{row.domain}</span></div>
          {state === "scanning" ? <span className="sx-health none compact"><LoaderCircle className="spin" size={13} /> Taranıyor</span> : <HealthBadge compact health={health} />}
        </header>
        {row.latest ? <>
          <div className="sx-site-scores">
            <div><span>SEO</span><strong><CountUp value={row.latest.scores.seo} /></strong><Bar value={row.latest.scores.seo} tone={scoreTone(row.latest.scores.seo)} /></div>
            <div><span>GEO</span><strong><CountUp value={row.latest.scores.geo} /></strong><Bar value={row.latest.scores.geo} tone={scoreTone(row.latest.scores.geo)} /></div>
          </div>
          {row.criticalReasons.length > 0 && <p className="sx-critical-line"><AlertOctagon size={13} /> {row.criticalReasons.join(" · ")}</p>}
          <dl className="sx-site-facts">
            <div><dt>İyileştirme</dt><dd>{row.improvements ? `${row.improvements} öneri` : "Yok"}</dd></div>
            <div><dt>Trend</dt><dd>{trendBefore !== null ? <Delta now={trendNow} before={trendBefore} /> : <span className="sx-muted">—</span>}</dd></div>
            <div><dt>Son tarama</dt><dd>{relativeTime(row.latest.scannedAt, now)}</dd></div>
          </dl>
          {row.rescanNeeded && <p className="sx-note"><Sparkles size={12} /> Yeni deploy algılandı — yeniden taranacak</p>}
          {row.optimization?.status === "open" && row.optimization.prUrl && <p className="sx-note"><GitPullRequest size={12} /> <a href={row.optimization.prUrl} target="_blank" rel="noreferrer">PR #{row.optimization.prNumber} incelemede</a></p>}
          <footer>
            <button className="button ghost sm" onClick={() => openDetail(row.siteId)}><Eye size={14} /> Görüntüle</button>
            <button className="button ghost sm" disabled={busy !== null || !row.autoFixable || row.optimization?.status === "open"} title={row.optimization?.status === "open" ? "Açık PR birleştirilince" : !row.autoFixable ? "Otomatik uygulanabilir öneri yok" : undefined} onClick={() => setConfirm({ siteIds: [row.siteId] })}><GitPullRequest size={14} /> Optimize</button>
            <button className="button ghost sm" onClick={() => openDetail(row.siteId, "history")}><History size={14} /> Geçmiş</button>
          </footer>
        </> : <div className="sx-site-empty"><p className="sx-muted">Bu site henüz analiz edilmedi.</p><button className="button secondary sm" disabled={scanning} onClick={() => void scan([row.siteId], "manual")}><RefreshCw size={14} /> Şimdi tara</button></div>}
      </article>;
    })}</section>

    {confirm && <OptimizeDialog rows={data.sites.filter((item) => confirm.siteIds.includes(item.siteId))} github={data.github.configured} onCancel={() => setConfirm(null)} onConfirm={(ids) => void optimize(ids)} onSettings={onSettings} />}
  </div>;
}

function OptimizeDialog({ rows, github, onCancel, onConfirm, onSettings }: { rows: Row[]; github: boolean; onCancel: () => void; onConfirm: (siteIds: string[]) => void; onSettings: () => void }) {
  const ready = rows.filter((row) => row.repository && row.optimization?.status !== "open");
  const blocked = rows.filter((row) => !ready.includes(row));
  return <div className="modal-layer confirmation-layer"><div className="modal-backdrop" /><section className="setup-dialog confirmation-dialog sx-dialog" role="alertdialog" aria-modal="true" aria-labelledby="sx-opt-title">
    <h2 id="sx-opt-title">{rows.length > 1 ? `${rows.length} siteyi optimize et` : `${rows[0]?.name} optimize edilsin mi?`}</h2>
    {!github ? <><p>Değişiklikleri sitelere uygulamak için GitHub bağlantısı gerekir. Ayarlar → GitHub bölümünden erişim anahtarı ekleyin.</p><div className="editor-actions"><button className="button secondary" onClick={onCancel}>Vazgeç</button><button className="button primary" onClick={() => { onCancel(); onSettings(); }}>Ayarlara git</button></div></> : <>
      <p>Her site için son taramaya ve kendi işletme bilgilerine göre ayrı düzeltmeler üretilir; hiçbir site başka bir sitenin içeriğini almaz. Değişiklikler her sitenin reposunda ayrı bir pull request olarak açılır, Vercel önizleme oluşturur; birleştirince yayına alınır ve site otomatik yeniden taranır.</p>
      <ul className="sx-dialog-list">{ready.map((row) => <li key={row.siteId}><span className="sx-health good compact">Hazır</span>{row.name}<small>{row.repository?.repo} · {row.autoFixable} öneri</small></li>)}{blocked.map((row) => <li key={row.siteId}><span className="sx-health none compact">Atlanacak</span>{row.name}<small>{row.optimization?.status === "open" ? `Açık PR #${row.optimization.prNumber}` : "Vercel projesi bir GitHub reposuna bağlı değil"}</small></li>)}</ul>
      <div className="editor-actions"><button className="button secondary" onClick={onCancel}>Vazgeç</button><button className="button primary" disabled={!ready.length} onClick={() => onConfirm(ready.map((row) => row.siteId))}><GitPullRequest size={16} /> {ready.length > 1 ? `${ready.length} PR oluştur` : "PR oluştur"}</button></div>
    </>}
  </section></div>;
}
