"use client";
import { useCallback, useEffect, useState } from "react";
import { ArrowRight, CloudCog, LoaderCircle, RefreshCw } from "lucide-react";
import { requestApi } from "@/lib/client-api";
import { formatDateTime, liveStatusMeta, relativeTime } from "@/lib/status-labels";

type Deployment = { id: string; url: string | null; state: string; createdAt: string | null; target: string | null; branch?: string | null; commit?: string | null; projectId: string; projectName: string };
type Project = {
  projectId: string; name: string; framework: string | null; productionDomain: string | null; productionUrl: string | null; previewUrl: string | null; customDomains: string[];
  repository: { provider: string | null; repo: string | null; branch: string | null } | null; envKeys: { key: string }[];
  latestProduction: { state: string; createdAt: string | null } | null; lastSuccessfulDeployAt: string | null; lastDeployAt: string | null;
  compatibility: "connected" | "compatible" | "not-compatible"; connector: { connected: boolean; version: string | null; environment: string | null; lastSeen: string | null } | null;
  health: { domainActive: boolean | null; sslValid: boolean | null; connectorReachable: boolean | null; deploymentReady: boolean | null } | null;
  liveStatus: string; statusDetail: string; siteId: string | null; excluded: boolean; ignored: boolean; pending: boolean; archived: boolean; lastSyncAt: string;
};
type Event = { key: string; type: string; at: string; message: string; projectId?: string; siteId?: string };
export type VercelOverviewData = {
  configured: boolean; source: "env" | "panel" | null; account: string | null; team: string | null; teamId: string | null;
  projectCount: number; lastSyncAt: string | null; lastDeploymentCheckAt: string | null;
  syncState: { status: string; lastSyncAt: string | null; lastSuccessAt: string | null; error: string | null; projectCount: number } | null;
  settings: { autoConnect: "disabled" | "ask" | "auto"; ignoredProjects: string[] };
  counts: { total: number; connected: number; compatible: number; failed: number; awaiting: number; archived: number };
  projects: Project[]; latestDeployments: Deployment[]; queue: Deployment[];
  pending: { projectId: string; name: string; domain: string | null; connector: boolean }[]; events: Event[];
};

const compatibilityLabel = { connected: "Connector kurulu", compatible: "ROIstation'a hazır", "not-compatible": "ROIstation kapalı" } as const;

export async function vercelAction(body: Record<string, unknown>) {
  return requestApi<{ overview: VercelOverviewData; needsTeam?: boolean; account?: string; teams?: { id: string; name: string }[]; results?: { name: string; siteId: string | null; verified: boolean; error?: string }[]; siteId?: string; sync?: { discovered: number; imported: string[]; skipped?: string } }>("/api/vercel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

/** "Connect Vercel Account" with a Personal Access Token; asks once for the scope when the token can see teams. */
export function ConnectVercelForm({ onConnected, onNotice }: { onConnected: (overview: VercelOverviewData) => void; onNotice: (value: string) => void }) {
  const [token, setToken] = useState(""); const [scope, setScope] = useState(""); const [busy, setBusy] = useState(false);
  const [teams, setTeams] = useState<{ id: string; name: string }[] | null>(null); const [account, setAccount] = useState("");
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setBusy(true);
    try {
      const result = await vercelAction({ action: "connect", token, teamId: teams ? scope || "personal" : scope });
      if (result.needsTeam && result.teams) { setTeams(result.teams); setAccount(result.account || ""); setScope(result.teams[0]?.id || "personal"); onNotice("Anahtar doğrulandı. Projelerin bulunduğu hesabı seç."); return; }
      setToken(""); setTeams(null); onConnected(result.overview);
      onNotice(`Vercel bağlandı: ${result.sync?.discovered ?? 0} proje bulundu, ${result.sync?.imported.length ?? 0} proje otomatik eklendi ve doğrulandı.`);
    } catch (error) { onNotice(error instanceof Error ? error.message : "Vercel bağlanamadı."); }
    finally { setBusy(false); }
  }
  return <form className="vercel-connect" onSubmit={submit}>
    <label>Vercel Personal Access Token<input type="password" autoComplete="off" required minLength={20} value={token} disabled={busy} onChange={(event) => { setToken(event.target.value); setTeams(null); }} /></label>
    {teams && <label>Projelerin bulunduğu hesap{account ? ` (${account})` : ""}<select value={scope} disabled={busy} onChange={(event) => setScope(event.target.value)}>{teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}<option value="personal">Kişisel hesap</option></select></label>}
    <p className="publish-hint">Vercel → Account Settings → Tokens bölümünden oluştur. Anahtar sunucuda AES-256-GCM ile şifrelenip saklanır, tarayıcıya geri gönderilmez.</p>
    <div className="editor-actions"><button className="button primary" disabled={busy}>{busy ? <><LoaderCircle className="spin" size={16} /> Bağlanıyor, projeler taranıyor…</> : teams ? "Bu hesapla bağla" : "Vercel hesabını bağla"}</button></div>
  </form>;
}

export function AutoConnectSetting({ value, onChange, disabled }: { value: "disabled" | "ask" | "auto"; onChange: (value: "disabled" | "ask" | "auto") => void; disabled?: boolean }) {
  return <fieldset className="publish-options" disabled={disabled}>
    <legend>Uyumlu projeleri otomatik bağla</legend>
    <div className="publish-radio-row">
      {([["disabled", "Kapalı"], ["ask", "Bağlamadan önce sor"], ["auto", "Otomatik bağla"]] as const).map(([id, label]) => <label key={id}><input type="radio" checked={value === id} onChange={() => onChange(id)} />{label}</label>)}
    </div>
    <p className="publish-hint">Connector'ı zaten kurulu projeler "sor" modunda da otomatik bağlanır. Kapsam dışı projeler hiçbir modda otomatik bağlanmaz.</p>
  </fieldset>;
}

export function VercelOverview({ onNotice, onSitesChanged }: { onNotice: (value: string) => void; onSitesChanged: () => void }) {
  const [data, setData] = useState<VercelOverviewData | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try { setData(await requestApi<VercelOverviewData>("/api/vercel")); setError(""); }
    catch (error) { setError(error instanceof Error ? error.message : "Vercel durumu okunamadı."); }
  }, []);
  // Live statuses: stored records are re-read every minute (no Vercel API call); MasterPanel runs the 10-minute sync.
  useEffect(() => { void load(); const timer = setInterval(() => { void load(); setNow(Date.now()); }, 60_000); return () => clearInterval(timer); }, [load]);

  async function run(label: string, body: Record<string, unknown>, success: (result: Awaited<ReturnType<typeof vercelAction>>) => string) {
    setBusy(label);
    try { const result = await vercelAction(body); setData(result.overview); onNotice(success(result)); onSitesChanged(); }
    catch (error) { onNotice(error instanceof Error ? error.message : "İşlem tamamlanamadı."); }
    finally { setBusy(null); }
  }

  if (!data) return <><Heading />{error ? <div className="manager-error" role="alert">{error}</div> : <p>Vercel durumu yükleniyor…</p>}</>;

  if (!data.configured) return <><Heading />
    {error && <div className="manager-error" role="alert">{error}</div>}
    <section className="panel manager-editor">
      <h2>Vercel hesabını bir kez bağla</h2>
      <p>Bağlandıktan sonra hesaptaki her proje otomatik bulunur, Siteler listesine eklenir, Vercel API ile doğrulanır ve yayına açılır. Alternatif: VERCEL_TOKEN ve VERCEL_TEAM_ID ortam değişkenleri.</p>
      <ConnectVercelForm onNotice={onNotice} onConnected={(overview) => { setData(overview); onSitesChanged(); }} />
    </section></>;

  const sync = data.syncState;
  const importable = data.projects.filter((project) => !project.siteId && !project.archived && !project.excluded && project.compatibility !== "not-compatible");
  return <>
    <Heading account={data.account} actions={<>
      <button className="button secondary" disabled={busy !== null} onClick={() => void run("sync", { action: "sync", reason: "manual", full: true }, (result) => result.sync?.skipped === "running" ? "Senkronizasyon zaten çalışıyor; birazdan güncellenecek." : `Senkronize edildi: ${result.sync?.discovered ?? 0} proje.`)}>{busy === "sync" ? <LoaderCircle className="spin" size={16} /> : <RefreshCw size={16} />} Şimdi senkronize et</button>
      <button className="button primary" disabled={busy !== null || !importable.length} onClick={() => void run("import", { action: "import-all" }, (result) => `${result.results?.filter((item) => item.siteId).length ?? 0} proje içe aktarıldı; ${result.results?.filter((item) => item.verified).length ?? 0} tanesi yayına hazır.`)}>Uyumlu projelerin tümünü içe aktar ({importable.length})</button>
    </>} />
    {error && <div className="manager-error" role="alert">{error}</div>}
    {sync?.status === "auth-required" && <div className="manager-error" role="alert">Vercel erişim anahtarı geçersiz veya süresi dolmuş. {data.source === "panel" ? "Bağlantıyı kaldırıp yeni anahtarla tekrar bağla." : "VERCEL_TOKEN değerini güncelle."}</div>}
    {sync?.status === "error" && <div className="manager-error" role="alert">Son senkronizasyon tamamlanamadı: {sync.error}</div>}

    {data.pending.map((item) => <div className="notice vercel-pending" key={item.projectId}><span><strong>Yeni Vercel projesi algılandı:</strong> {item.name}{item.domain ? ` (${item.domain})` : ""}</span><div>
      <button className="button primary" disabled={busy !== null} onClick={() => void run(`c-${item.projectId}`, { action: "connect-project", projectId: item.projectId }, (result) => `${item.name} bağlandı (site: ${result.siteId}).`)}>Şimdi bağla</button>
      <button className="button secondary" disabled={busy !== null} onClick={() => void run(`i-${item.projectId}`, { action: "ignore-project", projectId: item.projectId }, () => `${item.name} yok sayıldı.`)}>Yok say</button>
      <button className="button secondary" disabled={busy !== null} onClick={() => void run("auto", { action: "settings", autoConnect: "auto" }, () => "Uyumlu projeler artık otomatik bağlanacak.").then(() => run(`c-${item.projectId}`, { action: "connect-project", projectId: item.projectId }, (result) => `${item.name} bağlandı (site: ${result.siteId}).`))}>Her zaman otomatik bağla</button>
    </div></div>)}

    <section className="operational-metrics vercel-metrics">
      {[["Toplam proje", data.counts.total], ["Bağlı proje", data.counts.connected], ["Uyumlu, bağlanmamış", data.counts.compatible], ["Başarısız deploy", data.counts.failed], ["Doğrulama bekleyen", data.counts.awaiting]].map(([label, value]) => <div className="panel" key={label}><span>{label}</span><strong>{value}</strong></div>)}
    </section>
    <p className="publish-hint">Son tam senkronizasyon: {formatDateTime(data.lastSyncAt)} · Son deploy kontrolü: {formatDateTime(data.lastDeploymentCheckAt)} ({relativeTime(data.lastDeploymentCheckAt, now)}) · Deploy durumu panel açıkken 2 dakikada bir, tam senkron 10 dakikada bir, her yayından sonra ve günde bir kez otomatik.</p>

    <div className="vercel-columns">
      <section className="panel operational-actions"><h2>Deploy kuyruğu</h2>{data.queue.length ? data.queue.map((item) => <p key={item.id}><span className="status-pill busy"><i />{item.state}</span> {item.projectName} · {item.target || "preview"} · {relativeTime(item.createdAt, now)}</p>) : <p>Şu anda süren deploy yok.</p>}</section>
      <section className="panel operational-actions"><h2>Son deploylar</h2>{data.latestDeployments.length ? data.latestDeployments.slice(0, 8).map((item) => <p key={item.id}><span className={`status-pill ${item.state === "READY" ? "ok" : item.state === "ERROR" ? "bad" : "busy"}`}><i />{item.state}</span> {item.projectName} · {item.target || "preview"}{item.branch ? ` · ${item.branch}` : ""} · {relativeTime(item.createdAt, now)}</p>) : <p>Henüz deploy bilgisi yok.</p>}</section>
    </div>

    <div className="deploy-grid">{data.projects.map((project) => {
      const meta = liveStatusMeta[project.liveStatus] || { label: project.liveStatus, tone: "idle" as const };
      const canConnect = !project.siteId && !project.archived && project.compatibility !== "not-compatible";
      return <article className="panel deploy-card" key={project.projectId}>
        <div className="deploy-head"><span className={`status-pill ${meta.tone}`}><i />{meta.label}</span><span className={`status-pill ${project.connector?.connected ? "ok" : project.siteId && project.liveStatus === "connected" ? "warn" : "idle"}`}><i />{project.excluded ? "Kapsam dışı" : project.siteId && !project.connector?.connected && project.compatibility !== "not-compatible" ? "Connector yok" : compatibilityLabel[project.compatibility]}</span></div>
        <h3>{project.name}</h3>
        {project.productionUrl && <a href={project.productionUrl} target="_blank" rel="noreferrer">{project.productionDomain}</a>}
        <p className="publish-hint">{project.statusDetail}</p>
        <dl>
          <dt>Deploy durumu</dt><dd>{project.latestProduction?.state || "—"}</dd>
          <dt>Bağlantı</dt><dd>{project.siteId ? `Site: ${project.siteId}` : project.pending ? "Onay bekliyor" : project.ignored ? "Yok sayıldı" : "Bağlı değil"}</dd>
          <dt>Framework</dt><dd>{project.framework || "—"}</dd>
          <dt>Son deploy</dt><dd>{formatDateTime(project.lastDeployAt)}</dd>
          <dt>Son başarılı</dt><dd>{formatDateTime(project.lastSuccessfulDeployAt)}</dd>
          <dt>Son senkron</dt><dd>{relativeTime(project.lastSyncAt, now)}</dd>
          <dt>Connector</dt><dd>{project.connector?.connected ? `v${project.connector.version || "?"}${project.connector.environment ? ` · ${project.connector.environment}` : ""}` : "—"}</dd>
          <dt>Kaynak kod</dt><dd>{project.repository?.repo ? `${project.repository.repo}${project.repository.branch ? ` · ${project.repository.branch}` : ""}` : "—"}</dd>
          <dt>Önizleme</dt><dd>{project.previewUrl ? <a href={project.previewUrl} target="_blank" rel="noreferrer">son preview</a> : "—"}</dd>
          <dt>Sağlık</dt><dd>{healthLine(project)}</dd>
        </dl>
        <div className="editor-actions">
          {canConnect && <button className="button primary" disabled={busy !== null} onClick={() => void run(`c-${project.projectId}`, { action: "connect-project", projectId: project.projectId }, (result) => `${project.name} bağlandı (site: ${result.siteId}).`)}>{busy === `c-${project.projectId}` ? "Bağlanıyor…" : "Projeyi bağla"}</button>}
          {canConnect && !project.ignored && <button className="button secondary" disabled={busy !== null} onClick={() => void run(`i-${project.projectId}`, { action: "ignore-project", projectId: project.projectId }, () => `${project.name} yok sayıldı.`)}>Yok say</button>}
          <a className="review-button" href={`https://vercel.com/dashboard`} target="_blank" rel="noreferrer">Vercel'de aç <ArrowRight size={15} /></a>
        </div>
      </article>;
    })}</div>

    <section className="panel operational-actions"><h2>Etkinlik günlüğü</h2>{data.events.length ? data.events.map((event, index) => <p key={index}>{formatDateTime(event.at)} · {event.message}</p>) : <p>Henüz etkinlik yok.</p>}</section>

    <AutoConnectSetting value={data.settings.autoConnect} disabled={busy !== null} onChange={(mode) => void run("settings", { action: "settings", autoConnect: mode }, () => "Otomatik bağlama ayarı kaydedildi.")} />
    {data.source === "panel" && <div className="editor-actions"><button className="button danger" disabled={busy !== null} onClick={() => { if (window.confirm("Vercel bağlantısı kaldırılsın mı? Siteler, yayınlar ve geçmiş korunur.")) void run("disconnect", { action: "disconnect" }, () => "Vercel bağlantısı kaldırıldı. Siteler ve yayınlar korunuyor."); }}>Vercel bağlantısını kaldır</button></div>}
  </>;
}

function healthLine(project: Project) {
  const h = project.health; if (!h) return "Kontrol bekleniyor";
  const mark = (value: boolean | null, label: string) => `${value === true ? "✓" : value === false ? "✗" : "·"} ${label}`;
  return [mark(h.deploymentReady, "deploy"), mark(h.domainActive, "domain"), mark(h.sslValid, "SSL"), mark(h.connectorReachable, "connector")].join("  ");
}

function Heading({ account, actions }: { account?: string | null; actions?: React.ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">VERCEL OPERATIONS</span><h1>Projeler ve deploy bağlantıları</h1><p>{account ? `Bağlı hesap: ${account}. ` : ""}Vercel hesabındaki projeler otomatik bulunur, doğrulanır ve yayına hazırlanır.</p></div><div className="heading-actions">{actions}<a className="button secondary" href="https://vercel.com/dashboard" target="_blank" rel="noreferrer"><CloudCog size={17} /> Vercel'i aç</a></div></div>;
}
