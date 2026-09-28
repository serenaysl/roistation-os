"use client";

import {
  Activity,
  ArrowRight,
  BarChart3,
  Bell,
  Bot,
  Boxes,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleGauge,
  Clock3,
  CloudCog,
  Code2,
  FileArchive,
  FileText,
  FolderOpen,
  Globe2,
  LayoutDashboard,
  Link2,
  ListChecks,
  LoaderCircle,
  Megaphone,
  Menu,
  MoreHorizontal,
  Plus,
  Rocket,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  UploadCloud,
  WandSparkles,
  X,
  Zap,
} from "lucide-react";
import { ChangeEvent, ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { applySiteRegistry, excludedProjects, sites, SiteProfile } from "@/lib/sites";
import { AutoConnectSetting, ConnectVercelForm, VercelOverview, vercelAction, type VercelOverviewData } from "@/components/vercel-overview";
import { formatDateTime } from "@/lib/status-labels";
import { SeoCenter, type ContentRequest } from "@/components/seo-center";
import { requestApi } from "@/lib/client-api";
import { PublicationManager } from "@/components/publication-manager";
import { ConnectionManager } from "@/components/connection-manager";
import { OperationalOverview } from "@/components/operational-overview";
import { readApiResponse } from "@/lib/client-api";
import { PlacementFields,PublishSummary,TargetFields,isPlacement,isScope,scheduleLabelOf,useConnectionStatus,useRememberedState,type SummaryResult } from "@/components/publish-options";
import { defaultPlacement,publishLocations,publishStrategies,type Placement,type PublishScope } from "@/lib/publishing/definitions";

type View = "overview" | "automation" | "sites" | "seo" | "publishing" | "forms" | "deploy" | "settings";
type AutomationResult = {
  siteId: string;
  title: string;
  summary: string;
  body?: string;
  metaTitle?: string;
  metaDescription?: string;
  seoScore: number;
  geoScore: number;
  checks: string[];
  status: string;
};

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

type Command = { id: string; label: string; hint: string; view: View };

/** ⌘K / Ctrl+K quick navigation across panel views and sites (sites open the SEO & GEO Center). */
function CommandSearch({ onNavigate }: { onNavigate: (view: View) => void }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
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
  const choose = (command: Command | undefined) => { if (!command) return; onNavigate(command.view); setQuery(""); setOpen(false); inputRef.current?.blur(); };
  return <div className="command-search">
    <label className="search-box"><Search size={17} /><input ref={inputRef} aria-label="Panelde ara" role="combobox" aria-expanded={open} aria-controls="command-results" placeholder="Site veya ekran ara..." value={query}
      onChange={(event) => { setQuery(event.target.value); setActive(0); setOpen(true); }} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 120)}
      onKeyDown={(event) => { if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(index + 1, matches.length - 1)); } else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(index - 1, 0)); } else if (event.key === "Enter") { event.preventDefault(); choose(matches[active]); } else if (event.key === "Escape") { setOpen(false); inputRef.current?.blur(); } }} /><kbd>⌘ K</kbd></label>
    {open && <ul className="command-results" id="command-results" role="listbox">
      {matches.length ? matches.map((command, index) => <li key={command.id} role="option" aria-selected={index === active} className={index === active ? "active" : ""} onMouseDown={(event) => { event.preventDefault(); choose(command); }} onMouseEnter={() => setActive(index)}><span>{command.label}</span><small>{command.hint}</small></li>) : <li className="empty">Sonuç yok</li>}
    </ul>}
  </div>;
}

export function MasterPanel() {
  const [view, setView] = useState<View>("overview");
  const [mobileNav, setMobileNav] = useState(false);
  const [selectedSites, setSelectedSites] = useState(() => new Set(sites.map((site) => site.id)));
  const [files, setFiles] = useState<string[]>([]);
  const [sourceText, setSourceText] = useState("");
  const [contentType, setContentType] = useState("Blog / rehber içerik");
  const [goal, setGoal] = useState("Yerel aramalarda görünürlüğü artır ve AI cevaplarına uygun hale getir");
  const [schedule, setSchedule] = useState<"now" | "later">("now");
  const [scheduleAt, setScheduleAt] = useState("");
  const [generating, setGenerating] = useState(false);
  const [generationFailure, setGenerationFailure] = useState(false);
  const [lastGenerationId, setLastGenerationId] = useState<string|null>(null);
  const [publishing, setPublishing] = useState(false);
  const [results, setResults] = useState<AutomationResult[]>([]);
  const [engineMode, setEngineMode] = useState<"demo" | "anthropic" | "openai" | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [placement, setPlacement] = useRememberedState<Placement>("roistation:publish-placement", defaultPlacement, isPlacement);
  const [publishScope, setPublishScope] = useRememberedState<PublishScope>("roistation:publish-scope", "selected", isScope);
  const [targetIds, setTargetIds] = useState<string[]>(() => sites.map((site) => site.id));
  const [summaryOpen, setSummaryOpen] = useState(false);
  const [summaryResults, setSummaryResults] = useState<SummaryResult[] | null>(null);
  const { verified } = useConnectionStatus();
  const verifiedCount = sites.filter((site) => verified[site.id]).length;
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);
  const generationRequestRef = useRef<{key:string;id:string}|null>(null);
  const publishRequestRef = useRef<{key:string;id:string}|null>(null);

  // Live site registry: built-in sites + projects imported from Vercel.
  const [, setRegistryVersion] = useState(0);
  const [pendingProjects, setPendingProjects] = useState<VercelOverviewData["pending"]>([]);
  const [pendingBusy, setPendingBusy] = useState(false);
  const loadSites = useCallback(async () => {
    try { const data = await requestApi<{ sites: SiteProfile[] }>("/api/sites"); applySiteRegistry(data.sites.filter((site) => site.source === "vercel")); setRegistryVersion((value) => value + 1); } catch { /* built-in sites keep working */ }
  }, []);
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
  /** From the SEO & GEO Center: prefill the AI workflow (site, strategy, goal); generation and approval stay unchanged. */
  function openAutomationFor(request: ContentRequest) {
    setSelectedSites(new Set([request.siteId]));
    setGoal(request.goal);
    setPlacement({ location: "seo-page", strategy: request.strategy });
    setView("automation");
    setNotice("AI taslağı için site, strateji ve hedef hazırlandı. Kaynak metni ekleyip taslak oluştur; yayından önce onayın istenir.");
  }
  async function pendingAction(body: Record<string, unknown>, message: string) {
    setPendingBusy(true);
    try { const result = await vercelAction(body); setPendingProjects(result.overview.pending); setNotice(message); await loadSites(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "İşlem tamamlanamadı."); }
    finally { setPendingBusy(false); }
  }

  useEffect(()=>{
    const id=sessionStorage.getItem("roistation:last-generation-id");
    const key=sessionStorage.getItem("roistation:last-generation-key");
    if(id && key) generationRequestRef.current={id,key};
    setLastGenerationId(id);
  },[]);

  const selectedCount = selectedSites.size;
  const pageTitle: Record<View, string> = {
    overview: "Kontrol Merkezi",
    automation: "AI Yayın Otomasyonu",
    sites: "Site Envanteri",
    seo: "SEO & GEO Merkezi",
    publishing: "İçerik & Yayınlar",
    forms: "Merkezi Formlar",
    deploy: "Vercel & Deploy",
    settings: "Sistem Ayarları",
  };

  function toggleSite(id: string) {
    setSelectedSites((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  async function addFiles(event: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(event.target.files || []);
    const incoming = selectedFiles.map((file) => file.webkitRelativePath || file.name);
    setFiles((current) => Array.from(new Set([...current, ...incoming])).slice(0, 30));
    if (!selectedFiles.length) return;
    setNotice("Dosya içerikleri okunuyor...");
    try {
      const formData = new FormData();
      selectedFiles.slice(0, 30).forEach((file) => formData.append("files", file, file.webkitRelativePath || file.name));
      const response = await fetch("/api/extract", { method: "POST", body: formData });
      const data = await readApiResponse(response) as {combinedText?:string;files?:{warning?:string;text?:string}[];error?:string};
      if (!response.ok) throw new Error(data.error || "Dosyalar okunamadı.");
      if (data.combinedText) setSourceText((current) => [current.trim(), data.combinedText].filter(Boolean).join("\n\n"));
      const unreadable = data.files?.filter((file: { warning?: string; text?: string }) => file.warning && !file.text).length || 0;
      setNotice(unreadable ? `${selectedFiles.length} dosya eklendi; ${unreadable} dosya türü elle kontrol edilmeli.` : `${selectedFiles.length} dosyanın içeriği AI girdisine eklendi.`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Dosya okuma sırasında hata oluştu.");
    } finally {
      event.target.value = "";
    }
  }

  async function runAutomation(forceNew=false) {
    if (!selectedCount) return setNotice("AI çalıştırmak için en az bir site seç.");
    if (!sourceText.trim() && !files.length) return setNotice("Bir taslak yazı, dosya veya klasör ekle.");
    if(forceNew && !window.confirm("Bu işlem Claude'u yeniden çağırır ve yeniden kredi kullanabilir. Yeni üretim başlatılsın mı?")) return;
    const requestKey=JSON.stringify({sourceText,fileNames:files,contentType,goal,siteIds:Array.from(selectedSites).sort()});
    if(forceNew || generationRequestRef.current?.key!==requestKey) generationRequestRef.current={key:requestKey,id:crypto.randomUUID()};
    sessionStorage.setItem("roistation:last-generation-id",generationRequestRef.current.id);sessionStorage.setItem("roistation:last-generation-key",generationRequestRef.current.key);setLastGenerationId(generationRequestRef.current.id);
    setGenerating(true);
    setNotice(null);
    try {
      const response = await fetch("/api/automation", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ generationId:generationRequestRef.current.id,sourceText, fileNames: files, contentType, goal, siteIds: Array.from(selectedSites) }),
      });
      const data = await readApiResponse(response) as {results:AutomationResult[];mode:"demo"|"anthropic"|"openai";usage?:Record<string,number>;generationId:string;recovered?:boolean;error?:string};
      if (!response.ok) throw new Error(data.error || "AI işlemi tamamlanamadı.");
      setResults(data.results);
      setEngineMode(data.mode);
      setGenerationFailure(false);
      const usage=data.usage ? ` Girdi: ${data.usage.input_tokens ?? "—"}, çıktı: ${data.usage.output_tokens ?? "—"} token.` : "";
      setNotice(data.recovered ? `Önceden ücretlendirilmiş sonuç güvenli kayıttan getirildi; yeni AI kredisi kullanılmadı.${usage}` : `${data.results.length} site için ayrı taslak hazırlandı ve güvenli kayda alındı.${usage}`);
    } catch (error) {
      const message=error instanceof Error ? error.message : "Beklenmeyen bir hata oluştu.";
      setGenerationFailure(!message.includes("hâlâ hazırlanıyor"));
      setNotice(message);
    } finally {
      setGenerating(false);
    }
  }

  async function restoreLastGeneration() {
    if(!lastGenerationId) return;
    setGenerating(true);setNotice(null);
    try {
      const response=await fetch(`/api/automation?generationId=${encodeURIComponent(lastGenerationId)}`,{cache:"no-store"});const data=await readApiResponse(response) as {results:AutomationResult[];mode:"demo"|"anthropic"|"openai";usage?:Record<string,number>;generationId:string;recovered?:boolean;error?:string};
      if(response.status===202) throw new Error("AI işlemi hâlâ hazırlanıyor. Biraz bekleyip tekrar kontrol et; bu kontrol kredi kullanmaz.");
      if(!response.ok) throw new Error(data.error || "Kaydedilmiş AI sonucu getirilemedi.");
      setResults(data.results);setEngineMode(data.mode);setGenerationFailure(false);
      const usage=data.usage ? ` Girdi: ${data.usage.input_tokens ?? "—"}, çıktı: ${data.usage.output_tokens ?? "—"} token.` : "";
      setNotice(`Kaydedilmiş AI sonucu getirildi; yeni kredi kullanılmadı.${usage}`);
    } catch(error) {setNotice(error instanceof Error ? error.message : "Kaydedilmiş AI sonucu getirilemedi.");}
    finally {setGenerating(false);}
  }

  // Results that fall inside the chosen publish target. "All connected" sends every result; the server skips unverified sites.
  const publishTargets = publishScope === "all-connected" ? results : results.filter((result) => targetIds.includes(result.siteId)).slice(0, publishScope === "current" ? 1 : undefined);
  function publishResults() {
    if(engineMode === "demo") return setNotice("Demo çıktıları canlıya gönderilmez. Claude anahtarını ekle veya İçerik ekranından gerçek taslak oluştur.");
    if(schedule === "later" && (!scheduleAt || Date.parse(scheduleAt)<=Date.now())) return setNotice("Gelecekteki bir yayın tarihi seç.");
    if(!publishTargets.length) return setNotice("Yayın hedefi seç: taslağı oluşturulan sitelerden en az biri seçili olmalı.");
    setSummaryResults(null);
    setSummaryOpen(true);
  }
  async function confirmPublish() {
    setPublishing(true);
    setNotice(null);
    try {
      const publishKey=JSON.stringify({results:publishTargets,scheduleAt:schedule === "later" ? scheduleAt : null,placement,publishScope});
      if(publishRequestRef.current?.key!==publishKey) publishRequestRef.current={key:publishKey,id:crypto.randomUUID()};
      const response = await fetch("/api/publish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ publicationId:publishRequestRef.current.id,title: goal.slice(0,200),mode:engineMode,generationId:lastGenerationId,siteIds: publishTargets.map((result) => result.siteId),payload:publishTargets,scheduleAt:schedule === "later" ? new Date(scheduleAt).toISOString() : null,placement,scope:publishScope }),
      });
      const data = await readApiResponse(response) as {results:SummaryResult[];error?:string};
      if (!response.ok) throw new Error(data.error || "Yayın tamamlanamadı.");
      setResults((current) => current.map((result) => {const outcome=data.results.find((target)=>target.siteId===result.siteId);return outcome ? {...result,status:outcome.skipped ? "skipped" : outcome.status || "failed"} : result;}));
      setSummaryResults(data.results);
      void backgroundSync("publish", false, false);
      const failed=data.results.filter((target)=>target.status==="failed").length;const skipped=data.results.filter((target)=>target.skipped).length;
      setNotice(`${data.results.length-failed-skipped} hedef ${schedule === "later" ? "planlandı" : "yayınlandı"}.${failed ? ` ${failed} hedef bağlantı olmadığı için yayınlanmadı.` : ""}${skipped ? ` ${skipped} doğrulanmamış site atlandı.` : ""} Ayrıntılar İçerik & Yayın ekranına kaydedildi.`);
    } catch (error) {
      setSummaryOpen(false);
      const message=error instanceof Error ? error.message : "Yayın sırasında hata oluştu.";
      setNotice(message.includes("Vercel işlem süresi doldu") ? message : `${message} Taslak ekranda duruyorsa yeni Claude kredisi kullanmadan aynı yayın düğmesini tekrar deneyebilirsin.`);
    } finally {
      setPublishing(false);
    }
  }

  return (
    <div className="app-shell">
      <aside className={`sidebar ${mobileNav ? "is-open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark">R</div>
          <div><strong>ROIstation</strong><span>OPERATIONS SYSTEM</span></div>
          <button className="icon-button close-mobile" aria-label="Menüyü kapat" onClick={() => setMobileNav(false)}><X size={20} /></button>
        </div>

        <nav className="side-nav" aria-label="Ana menü">
          {navGroups.map((group, groupIndex) => (
            <div className="nav-group" key={group.label || groupIndex}>
              {group.label && <div className="nav-label">{group.label}</div>}
              {group.items.map((item) => {
                const Icon = item.icon;
                return (
                  <button key={item.id} className={`nav-item ${view === item.id ? "active" : ""}`} onClick={() => { setView(item.id); setMobileNav(false); }}>
                    <Icon size={18} strokeWidth={1.9} />
                    <span>{item.label}</span>
                    {item.badge && <em>{item.badge === "count" ? sites.length : item.badge}</em>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        <div className="system-health">
          <div className="health-head"><span><Activity size={15} /> Site bağlantıları</span><b>{verifiedCount}/{sites.length}</b></div>
          <div className="health-track"><span style={{ width: `${sites.length ? Math.round((verifiedCount / sites.length) * 100) : 0}%` }} /></div>
          <p>{sites.length} site tanımlı · {verifiedCount} doğrulandı</p>
        </div>

        <div className="profile-row">
          <div className="avatar">RS</div>
          <div><strong>ROIstation</strong><span>Yönetici</span></div>
          <button className="text-button" onClick={async()=>{await fetch("/api/session",{method:"DELETE"});window.location.reload();}}>Çıkış</button>
        </div>
      </aside>

      {mobileNav && <button className="nav-backdrop" aria-label="Menüyü kapat" onClick={() => setMobileNav(false)} />}

      <main className="main-area">
        <header className="topbar">
          <div className="top-title">
            <button className="icon-button mobile-menu" aria-label="Menüyü aç" onClick={() => setMobileNav(true)}><Menu size={20} /></button>
            <span>ROIstation OS</span><b>/</b><strong>{pageTitle[view]}</strong>
          </div>
          <div className="top-actions">
            <CommandSearch onNavigate={(target) => { setView(target); setMobileNav(false); }} />
            <button className="icon-button notification" aria-label={pendingProjects.length ? `${pendingProjects.length} yeni Vercel projesi` : "Bildirim yok"} title={pendingProjects.length ? `${pendingProjects.length} yeni Vercel projesi bağlanmayı bekliyor` : "Yeni bildirim yok"} onClick={() => setView("deploy")}><Bell size={19} />{pendingProjects.length > 0 && <span />}</button>
            <button className="sync-pill" onClick={()=>setView("sites")}>Site bağlantılarını kontrol et</button>
          </div>
        </header>

        <div className="content-area">
          {notice && <div className="notice"><CheckCircle2 size={18} /><span>{notice}</span><button onClick={() => setNotice(null)} aria-label="Bildirimi kapat"><X size={16} /></button></div>}
          {view !== "deploy" && pendingProjects.slice(0, 3).map((item) => <div className="notice vercel-pending" key={item.projectId}><span><strong>Yeni Vercel projesi algılandı:</strong> {item.name}{item.domain ? ` (${item.domain})` : ""}</span><div>
            <button className="button primary" disabled={pendingBusy} onClick={() => void pendingAction({ action: "connect-project", projectId: item.projectId }, `${item.name} bağlandı ve doğrulandı.`)}>Şimdi bağla</button>
            <button className="button secondary" disabled={pendingBusy} onClick={() => void pendingAction({ action: "ignore-project", projectId: item.projectId }, `${item.name} yok sayıldı.`)}>Yok say</button>
            <button className="button secondary" disabled={pendingBusy} onClick={() => void pendingAction({ action: "settings", autoConnect: "auto" }, "Uyumlu projeler artık otomatik bağlanacak.").then(() => pendingAction({ action: "connect-project", projectId: item.projectId }, `${item.name} bağlandı ve doğrulandı.`))}>Her zaman otomatik bağla</button>
          </div></div>)}
          {view === "overview" && <OperationalOverview onAutomation={()=>setView("automation")} onSites={()=>setView("sites")} onPublishing={()=>setView("publishing")}/>}
          {view === "automation" && (
            <AutomationWorkspace
              selectedSites={selectedSites}
              selectedCount={selectedCount}
              toggleSite={toggleSite}
              files={files}
              setFiles={setFiles}
              fileRef={fileRef}
              folderRef={folderRef}
              addFiles={addFiles}
              sourceText={sourceText}
              setSourceText={setSourceText}
              contentType={contentType}
              setContentType={setContentType}
              goal={goal}
              setGoal={setGoal}
              schedule={schedule}
              setSchedule={setSchedule}
              scheduleAt={scheduleAt}
              setScheduleAt={setScheduleAt}
              generating={generating}
              runAutomation={()=>runAutomation(false)}
              generationFailure={generationFailure}
              startNewGeneration={()=>runAutomation(true)}
              canRestoreGeneration={Boolean(lastGenerationId)}
              restoreGeneration={restoreLastGeneration}
              results={results}
              setResults={setResults}
              engineMode={engineMode}
              publishing={publishing}
              publishResults={publishResults}
              placement={placement}
              setPlacement={setPlacement}
              publishScope={publishScope}
              setPublishScope={setPublishScope}
              targetIds={targetIds}
              setTargetIds={setTargetIds}
              verified={verified}
            />
          )}
          {summaryOpen && <PublishSummary title={goal.slice(0,200) || "AI içerik yayını"} placement={placement} scheduleLabel={scheduleLabelOf(schedule,scheduleAt)} scope={publishScope} siteIds={publishTargets.map((result)=>result.siteId)} verified={verified} busy={publishing} results={summaryResults} onConfirm={()=>void confirmPublish()} onClose={()=>{if(!publishing) {setSummaryOpen(false);setSummaryResults(null);}}}/>}
          {view === "sites" && <ConnectionManager onNotice={setNotice}/>}
          {view === "seo" && <SeoCenter onNotice={setNotice} onSettings={() => setView("settings")} onCreateContent={openAutomationFor} />}
          {view === "publishing" && <PublicationManager key="content" kind="content" onNotice={setNotice} onPublished={() => void backgroundSync("publish", false, false)}/>}
          {view === "forms" && <PublicationManager key="form" kind="form" onNotice={setNotice} onPublished={() => void backgroundSync("publish", false, false)}/>}
          {view === "deploy" && <VercelOverview onNotice={setNotice} onSitesChanged={() => void loadSites()} />}
          {view === "settings" && <SettingsView onSites={()=>setView("sites")} onNotice={setNotice} onSitesChanged={() => void loadSites()}/>}
        </div>
      </main>
    </div>
  );
}

function PageHeading({ eyebrow, title, description, actions }: { eyebrow: string; title: string; description: string; actions?: ReactNode }) {
  return <div className="page-heading"><div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p>{description}</p></div>{actions && <div className="heading-actions">{actions}</div>}</div>;
}

function MetricCard({ icon, label, value, detail, tone, trend }: { icon: ReactNode; label: string; value: string; detail: string; tone: string; trend?: string }) {
  return <div className="metric-card"><div className={`metric-icon ${tone}`}>{icon}</div><div className="metric-copy"><span>{label}</span><strong>{value}</strong><small>{detail}</small></div>{trend && <em className="trend">{trend}</em>}</div>;
}

type AutomationProps = {
  selectedSites: Set<string>; selectedCount: number; toggleSite: (id: string) => void;
  files: string[]; setFiles: (files: string[]) => void;
  fileRef: React.RefObject<HTMLInputElement | null>; folderRef: React.RefObject<HTMLInputElement | null>;
  addFiles: (event: ChangeEvent<HTMLInputElement>) => void;
  sourceText: string; setSourceText: (value: string) => void;
  contentType: string; setContentType: (value: string) => void;
  goal: string; setGoal: (value: string) => void;
  schedule: "now" | "later"; setSchedule: (value: "now" | "later") => void;
  scheduleAt: string; setScheduleAt: (value: string) => void;
  generating: boolean; runAutomation: () => void; generationFailure:boolean;startNewGeneration:()=>void;canRestoreGeneration:boolean;restoreGeneration:()=>void;results: AutomationResult[];setResults:(results:AutomationResult[])=>void;
  engineMode: "demo" | "anthropic" | "openai" | null; publishing: boolean; publishResults: () => void;
  placement: Placement; setPlacement: (value: Placement) => void; publishScope: PublishScope; setPublishScope: (value: PublishScope) => void;
  targetIds: string[]; setTargetIds: (value: string[]) => void; verified: Record<string, boolean>;
};

function AutomationWorkspace(props: AutomationProps) {
  const allSelected = props.selectedCount === sites.length;
  return (
    <>
      <PageHeading eyebrow="AI OTOMASYON" title="Dosyadan yayına, tek akış." description="Kaynağı ekle; AI her site için özgün, kontrol edilebilir bir yayın paketi oluştursun." actions={<span className="secure-badge"><ShieldCheck size={16} /> İnsan onayı zorunlu</span>} />
      <div className="automation-layout">
        <section className="panel composer-panel">
          <div className="step-title"><span>1</span><div><h2>Kaynak içeriği ekle</h2><p>Taslak metin, tek dosya veya bütün bir klasör kullanabilirsin.</p></div></div>
          <div className="source-actions">
            <button onClick={() => props.fileRef.current?.click()}><FileText size={20} /><strong>Dosya seç</strong><span>DOCX, TXT, MD</span></button>
            <button onClick={() => props.folderRef.current?.click()}><FolderOpen size={20} /><strong>Klasör seç</strong><span>Birden çok taslağı birlikte işle</span></button>
          </div>
          <input ref={props.fileRef} className="hidden-input" type="file" multiple accept=".docx,.txt,.md,.markdown,.csv,.json,.html" onChange={props.addFiles} />
          <input ref={props.folderRef} className="hidden-input" type="file" multiple onChange={props.addFiles} {...({ webkitdirectory: "", directory: "" } as Record<string, string>)} />
          {props.files.length > 0 && <div className="file-stack"><div><FileArchive size={17} /><strong>{props.files.length} öğe eklendi</strong><button onClick={() => props.setFiles([])}>Temizle</button></div><p>{props.files.slice(0, 3).join(" · ")}{props.files.length > 3 ? ` · +${props.files.length - 3}` : ""}</p></div>}
          <label className="field-label">Ya da taslağı buraya yapıştır</label>
          <textarea value={props.sourceText} onChange={(event) => props.setSourceText(event.target.value)} placeholder="Örneğin: Eylül ayında yayınlanacak yerel SEO rehberi. Ana mesajlar, kampanya bilgileri ve zorunlu ifadeler..." />

          <div className="field-grid">
            <label><span>İçerik türü</span><select value={props.contentType} onChange={(event) => props.setContentType(event.target.value)}><option>Blog / rehber içerik</option><option>Duyuru / kampanya</option><option>Hizmet sayfası</option><option>FAQ paketi</option><option>SEO / GEO güncellemesi</option><option>Form ve açıklaması</option></select><ChevronDown size={16} /></label>
            <label><span>Ana hedef</span><input value={props.goal} onChange={(event) => props.setGoal(event.target.value)} /></label>
          </div>

          <div className="step-divider" />
          <div className="step-title"><span>2</span><div><h2>Yayınlanacak siteleri seç</h2><p>Her site için ayrı marka dili ve SEO/GEO profili kullanılacak.</p></div><button className="text-button" onClick={() => props.selectedSites.size === sites.length ? sites.forEach((site) => props.toggleSite(site.id)) : sites.filter((site) => !props.selectedSites.has(site.id)).forEach((site) => props.toggleSite(site.id))}>{allSelected ? "Seçimi kaldır" : "Tümünü seç"}</button></div>
          <div className="site-selector-grid">
            {sites.map((site) => <button key={site.id} className={`select-site ${props.selectedSites.has(site.id) ? "selected" : ""}`} onClick={() => props.toggleSite(site.id)}><div className="site-avatar" style={{ "--site-color": site.color } as React.CSSProperties}>{site.initials}</div><div><strong>{site.name}</strong><span>{site.sector}</span></div><i>{props.selectedSites.has(site.id) && <Check size={14} />}</i></button>)}
          </div>

          <div className="step-divider" />
          <div className="step-title"><span>3</span><div><h2>Yayın zamanını belirle</h2><p>AI önce taslakları oluşturur; onayın olmadan canlıya çıkmaz.</p></div></div>
          <div className="schedule-row">
            <button className={props.schedule === "now" ? "selected" : ""} onClick={() => props.setSchedule("now")}><Zap size={18} /><div><strong>Onaydan sonra yayınla</strong><span>Hazır olduğunda tek tık</span></div></button>
            <button className={props.schedule === "later" ? "selected" : ""} onClick={() => props.setSchedule("later")}><Clock3 size={18} /><div><strong>Tarih ve saate planla</strong><span>Zamanlı yayın kuyruğu</span></div></button>
          </div>
          {props.schedule === "later" && <label className="date-field"><span>Yayın tarihi ve saati</span><input type="datetime-local" value={props.scheduleAt} onChange={(event) => props.setScheduleAt(event.target.value)} /></label>}
          <PlacementFields value={props.placement} onChange={props.setPlacement} />
          <TargetFields candidates={sites.filter((site) => props.selectedSites.has(site.id)).map((site) => site.id)} scope={props.publishScope} onScope={props.setPublishScope} selected={props.targetIds} onSelected={props.setTargetIds} verified={props.verified} />
          <button className="button primary generate-button" onClick={props.runAutomation} disabled={props.generating}>{props.generating ? <><LoaderCircle className="spin" size={18} /> Siteler için hazırlanıyor...</> : <><WandSparkles size={18} /> {props.selectedCount} site için taslak oluştur / sonucu getir</>}</button>
          {props.canRestoreGeneration && <button className="button secondary generate-button" onClick={props.restoreGeneration} disabled={props.generating}>Son kaydedilen AI sonucunu getir — kredi kullanmaz</button>}
          {props.generationFailure && <button className="button secondary generate-button" onClick={props.startNewGeneration} disabled={props.generating}>Yeni ücretli deneme başlat</button>}
        </section>

        <aside className="automation-aside">
          <div className="panel guardrail-card">
            <div className="panel-heading"><div><span className="section-kicker"><ShieldCheck size={14} /> GÜVENLİ YAYIN</span><h2>Kontrol katmanları</h2></div></div>
            {["Marka ve sektör uyumu", "SEO teknik kontrolü", "GEO varlık tutarlılığı", "Riskli iddia ve tekrar kontrolü", "Yayından önce insan onayı"].map((item) => <div className="check-row" key={item}><CheckCircle2 size={16} />{item}</div>)}
          </div>
          <div className="panel scope-card"><span className="section-kicker">BU İŞLEMİN KAPSAMI</span><div><strong>{props.selectedCount}</strong><span>hedef site</span></div><dl><dt>İçerik</dt><dd>{props.contentType}</dd><dt>Dağıtım</dt><dd>{props.schedule === "now" ? "Onay sonrası" : "Zamanlı"}</dd><dt>Yayın yeri</dt><dd>{publishLocations[props.placement.location].label}</dd><dt>Strateji</dt><dd>{publishStrategies[props.placement.strategy].label}</dd><dt>Çıktı</dt><dd>Siteye özel {props.selectedCount} sürüm</dd></dl></div>
        </aside>
      </div>

      {props.results.length > 0 && <section className="panel results-panel">
        <div className="panel-heading"><div><span className="section-kicker"><Sparkles size={14} /> AI ÇIKTILARI · {props.engineMode === "demo" ? "DEMO MOTORU — CANLI YAYIN KAPALI" : props.engineMode?.toUpperCase()}</span><h2>Yayın öncesi kontrol</h2></div><button className="button primary" disabled={props.publishing || props.engineMode==="demo"} onClick={props.publishResults}>{props.publishing ? <LoaderCircle className="spin" size={17} /> : <Rocket size={17} />}{props.schedule === "later" ? "Yayınları planla" : "Onayla ve yayınla"}</button></div>
        <div className="result-grid">{props.results.map((result) => {
          const site = sites.find((entry) => entry.id === result.siteId)!;
          return <article className="result-card" key={result.siteId}><div className="result-head"><div className="site-avatar" style={{ "--site-color": site.color } as React.CSSProperties}>{site.initials}</div><div><strong>{site.name}</strong><span>{site.domain}</span></div><StatusChip status={result.status} /></div><h3>{result.title}</h3><p>{result.summary}</p><div className="score-row"><span>AI SEO tahmini <b>{result.seoScore}</b></span><span>AI GEO tahmini <b>{result.geoScore}</b></span></div><div className="result-checks">{result.checks.map((check) => <span key={check}><Check size={13} />{check}</span>)}</div><details className="ai-review"><summary>Taslağı incele / düzenle</summary>{(["title","summary","body","metaTitle","metaDescription"] as const).map(key=><label key={key}>{{title:"Başlık",summary:"Özet",body:"Tam içerik",metaTitle:"Meta başlık",metaDescription:"Meta açıklama"}[key]}<textarea value={result[key] || ""} onChange={event=>props.setResults(props.results.map(item=>item.siteId===result.siteId ? {...item,[key]:event.target.value} : item))}/></label>)}</details></article>;
        })}</div>
      </section>}
    </>
  );
}

function StatusChip({ status }: { status: string }) {
  const label=status==="published" ? "Yayınlandı" : status==="scheduled" ? "Planlandı" : status==="failed" ? "Yayınlanamadı" : status==="skipped" ? "Atlandı (doğrulanmadı)" : "Kontrol bekliyor";
  return <span className={`status-chip ${status}`}>{label}</span>;
}



function SettingsView({onSites,onNotice,onSitesChanged}:{onSites:()=>void;onNotice:(value:string)=>void;onSitesChanged:()=>void}) {
  const [claudeSetup, setClaudeSetup] = useState(false);
  const [aiStatus, setAiStatus] = useState<{ connected: boolean; model: string } | null>(null);
  const [systemStatus,setSystemStatus]=useState<{storageReady:boolean;connectedSites:number}|null>(null);

  async function checkAiStatus() {
    try {const response=await fetch("/api/integration-status",{cache:"no-store"});const data=await readApiResponse(response) as {anthropic:{connected:boolean;model:string}|null;storageReady:boolean;connectedSites:number};if(response.ok) {setAiStatus(data.anthropic);setSystemStatus({storageReady:data.storageReady,connectedSites:data.connectedSites});}} catch {setAiStatus(null);}
  }

  const [vercel, setVercel] = useState<VercelOverviewData | null>(null);
  const [vercelBusy, setVercelBusy] = useState(false);
  useEffect(() => { void checkAiStatus(); requestApi<VercelOverviewData>("/api/vercel").then(setVercel).catch(() => setVercel(null)); }, []);

  const integrations = [
    { name: "Vercel", detail: "Projeler, deploylar ve domainler", icon: <CloudCog />, state: vercel?.configured ? `Bağlı${vercel.account ? ` · ${vercel.account}` : ""} · ${vercel.counts.connected}/${vercel.counts.total} proje doğrulandı` : vercel ? "Bağlı değil — aşağıdaki formdan bağla" : "Durum okunuyor…" },
    { name:"Claude — Anthropic",detail:"AI içerik ve SEO/GEO motoru",icon:<Bot/>,state:aiStatus?.connected ? `Anahtar tanımlı · ${aiStatus.model}` : "API anahtarı gerekli" },
    { name:"Vercel Blob — Private",detail:"Kalıcı yayın ve form talepleri",icon:<Boxes/>,state:systemStatus?.storageReady ? "Özel depoya erişildi" : "Private Blob bağlantısı gerekli" },
    { name:"Site Connectors",detail:"Sitelerdeki merkezi yayın alanları",icon:<Link2/>,state:`${systemStatus?.connectedSites ?? "—"} / ${sites.length} son kontrol başarılı` },
  ];
  return <><PageHeading eyebrow="KURULUM" title="Sistem ayarları" description="Entegrasyonları ve yayın güvenliğini tek noktadan yapılandır."/><div className="panel manager-editor vercel-settings">{vercel?.configured ? <>
      <h2>Vercel hesabı</h2>
      <dl className="connection-facts">
        <dt>Bağlı hesap</dt><dd>{vercel.account || "—"}</dd>
        <dt>Ekip</dt><dd>{vercel.team || "Kişisel hesap"}</dd>
        <dt>Proje sayısı</dt><dd>{vercel.projectCount} ({vercel.counts.connected} bağlı ve doğrulanmış)</dd>
        <dt>Son senkronizasyon</dt><dd>{formatDateTime(vercel.lastSyncAt)}</dd>
        <dt>Son deploy kontrolü</dt><dd>{formatDateTime(vercel.lastDeploymentCheckAt)}</dd>
      </dl>
      {vercel.syncState?.status==="auth-required" && <p className="manager-error">Vercel anahtarı artık geçerli değil. Bağlantıyı kaldırıp yeni anahtarla bağla.</p>}
      <div className="editor-actions">
        <button className="button secondary" disabled={vercelBusy} onClick={()=>{setVercelBusy(true);void vercelAction({action:"sync",reason:"settings",full:true}).then(result=>{setVercel(result.overview);onSitesChanged();}).catch(()=>undefined).finally(()=>setVercelBusy(false));}}>{vercelBusy ? "Senkronize ediliyor…" : "Şimdi senkronize et"}</button>
        {vercel.source==="panel" && <button className="button danger" disabled={vercelBusy} onClick={()=>{if(!window.confirm("Vercel bağlantısı kaldırılsın mı? Siteler, yayınlar ve geçmiş korunur.")) return;setVercelBusy(true);void vercelAction({action:"disconnect"}).then(result=>setVercel(result.overview)).catch(()=>undefined).finally(()=>setVercelBusy(false));}}>Bağlantıyı kaldır</button>}
      </div>
      <AutoConnectSetting value={vercel.settings.autoConnect} disabled={vercelBusy} onChange={(mode)=>{void vercelAction({action:"settings",autoConnect:mode}).then(result=>setVercel(result.overview)).catch(()=>undefined);}}/>
    </> : <>
      <h2>Vercel hesabını bağla</h2>
      <p>Hesaptaki her proje otomatik bulunur, Siteler listesine eklenir, Vercel API ile doğrulanır ve yayına açılır. Siteye ayrıca doğrulama kodu eklemek gerekmez.</p>
      <ConnectVercelForm onNotice={onNotice} onConnected={(overview)=>{setVercel(overview);onSitesChanged();}}/>
    </>}</div><GithubSettings onNotice={onNotice}/><div className="panel manager-editor"><h2>Yayın sistemi kurulumu</h2><p>Vercel → Storage → Blob bölümünden Private depo oluşturup bu projeye bağla. Vercel depolama kimlik bilgilerini otomatik ekler. MASTER_PUBLIC_URL, PANEL_ADMIN_PASSWORD ve en az 32 rastgele karakterlik PANEL_SESSION_SECRET tanımlayıp yeniden deploy et. SQL kurulumu gerekmez.</p><p>Mevcut adminler ve site kayıtları değişmez. Bu sürüm tek ROIstation yönetici hesabı içindir; çok kiracılı SaaS üyelik sistemi değildir.</p></div><div className="settings-grid">{integrations.map(item=><article className="panel integration-card" key={item.name}><div className="integration-icon">{item.icon}</div><div><h3>{item.name}</h3><p>{item.detail}</p></div><span className={aiStatus?.connected && item.name.startsWith("Claude") ? "connected-text" : ""}>{item.state}</span>{item.name.startsWith("Claude") ? <button className="button secondary" onClick={()=>setClaudeSetup(true)}>Claude kurulumu</button> : item.name==="Site Connectors" ? <button className="button secondary" onClick={onSites}>Siteleri bağla</button> : <button className="button secondary" onClick={()=>void checkAiStatus()}>Durumu kontrol et</button>}</article>)}</div><div className="panel security-panel"><ShieldCheck size={24}/><div><h2>Yayın güvenliği</h2><p>Yönetici oturumu, kayıt sürümü ve insan onayı gerekir. Anahtarlar tarayıcıya gönderilmez. Form yanıtları anonim kullanıcıya kapalıdır. Yayındaki form ve içerikler herkese açıktır.</p></div></div>
    {claudeSetup && <div className="modal-layer" role="dialog" aria-modal="true" aria-label="Claude bağlantı kurulumu"><button className="modal-backdrop" aria-label="Kapat" onClick={() => setClaudeSetup(false)} /><div className="setup-dialog"><div className="setup-head"><div className="integration-icon"><Bot /></div><div><span>AI ENTEGRASYONU</span><h2>Claude’u bağla</h2><p>Anahtarı panel ekranına değil, Vercel’in güvenli değişkenlerine ekle.</p></div><button className="icon-button" aria-label="Kapat" onClick={() => setClaudeSetup(false)}><X size={19} /></button></div><div className="setup-steps"><div><b>1</b><p><strong>Anthropic Console’dan API anahtarı oluştur</strong><span>Console → Account Settings → API Keys bölümünü aç.</span></p></div><div><b>2</b><p><strong>Vercel proje ayarlarını aç</strong><span>ROIstation Master Panel → Settings → Environment Variables.</span></p></div><div><b>3</b><p><strong>İki değişkeni ekle</strong><code>ANTHROPIC_API_KEY = sk-ant-...</code><code>ANTHROPIC_MODEL = claude-sonnet-5</code></p></div><div><b>4</b><p><strong>Production, Preview ve Development seç</strong><span>Kaydettikten sonra Deployments bölümünden Redeploy yap.</span></p></div></div><div className={`connection-check ${aiStatus?.connected ? "connected" : ""}`}><span>{aiStatus?.connected ? <CheckCircle2 size={18} /> : <Activity size={18} />}</span><div><strong>{aiStatus?.connected ? "Claude anahtarı tanımlı" : "Claude anahtarı eksik"}</strong><p>{aiStatus?.connected ? `${aiStatus.model} seçili. Gerçek üretim çağrısıyla bağlantıyı test et.` : "Anahtarı ekleyip yeniden deploy ettikten sonra kontrol et."}</p></div><button className="button secondary" onClick={() => void checkAiStatus()}>Tekrar kontrol et</button></div><div className="setup-actions"><a className="button secondary" href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">Anthropic Console’u aç</a><a className="button primary" href="https://vercel.com/dashboard" target="_blank" rel="noreferrer">Vercel’i aç <ArrowRight size={16} /></a></div></div></div>}
  </>;
}

/** GitHub connection for SEO & GEO optimization pull requests. */
function GithubSettings({onNotice}:{onNotice:(value:string)=>void}) {
  const [state,setState]=useState<{configured:boolean;source:"env"|"panel"|null;login:string|null}|null>(null);
  const [token,setToken]=useState("");const [busy,setBusy]=useState(false);
  useEffect(()=>{requestApi<{configured:boolean;source:"env"|"panel"|null;login:string|null}>("/api/github").then(setState).catch(()=>setState(null));},[]);
  async function call(body:Record<string,unknown>,message:string) {
    setBusy(true);
    try {setState(await requestApi("/api/github",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}));setToken("");onNotice(message);}
    catch(error) {onNotice(error instanceof Error ? error.message : "GitHub işlemi tamamlanamadı.");}
    finally {setBusy(false);}
  }
  return <div className="panel manager-editor vercel-settings"><h2>GitHub (SEO optimizasyon PR'ları)</h2>
    {state?.configured ? <><dl className="connection-facts"><dt>Bağlı hesap</dt><dd>{state.login || (state.source==="env" ? "GITHUB_TOKEN ortam değişkeni" : "—")}</dd><dt>Kullanım</dt><dd>SEO & GEO Merkezi'ndeki "Optimize et" düzeltmeleri yeni bir dala yazar ve pull request açar; birleştirilince Vercel deploy eder.</dd></dl>
      {state.source==="panel" && <div className="editor-actions"><button className="button danger" disabled={busy} onClick={()=>{if(window.confirm("GitHub bağlantısı kaldırılsın mı? Açık PR'lar etkilenmez.")) void call({action:"disconnect"},"GitHub bağlantısı kaldırıldı.");}}>Bağlantıyı kaldır</button></div>}</>
    : <><p>İstemci repolarına Contents ve Pull requests yazma izni olan bir fine-grained personal access token ekleyin. Anahtar sunucuda şifrelenip saklanır, tarayıcıya geri gönderilmez.</p>
      <form className="vercel-connect" onSubmit={(event)=>{event.preventDefault();void call({action:"connect",token},"GitHub bağlandı.");}}><label>GitHub personal access token<input type="password" autoComplete="off" required value={token} disabled={busy} onChange={(event)=>setToken(event.target.value)}/></label><div className="editor-actions"><button className="button primary" disabled={busy}>{busy ? "Doğrulanıyor…" : "GitHub'ı bağla"}</button></div></form></>}
  </div>;
}
