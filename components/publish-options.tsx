"use client";
import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, XCircle } from "lucide-react";
import { sites } from "@/lib/sites";
import { requestApi } from "@/lib/client-api";
import {
  isPublishLocation, isPublishScope, isPublishStrategy, normalizeServicePath, pagePathPrefix, primaryLocation, publishLocations, publishScopes, publishStrategies, showsHomepageTeaser,
  type Placement, type PublishLocation, type PublishScope, type PublishStrategy,
} from "@/lib/publishing/definitions";

const siteName = (id: string) => sites.find((site) => site.id === id)?.name || id;

/** Remembers a choice per browser. Storage failures (private mode, blocked storage) fall back to the default. */
export function useRememberedState<T>(key: string, fallback: T, isValid: (value: unknown) => value is T) {
  const [value, setValue] = useState<T>(fallback);
  useEffect(() => {
    try { const raw = window.localStorage.getItem(key); if (raw !== null) { const parsed = JSON.parse(raw); if (isValid(parsed)) setValue(parsed); } } catch { /* ignore */ }
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const update = (next: T) => { setValue(next); try { window.localStorage.setItem(key, JSON.stringify(next)); } catch { /* ignore */ } };
  return [value, update] as const;
}
export const isPlacement = (value: unknown): value is Placement => Boolean(value) && typeof value === "object" && isPublishLocation((value as Placement).location) && isPublishStrategy((value as Placement).strategy);
export const isScope = (value: unknown): value is PublishScope => isPublishScope(value);

/** Verified state of every site connection (admin only). */
export function useConnectionStatus() {
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let active = true;
    requestApi<{ connections: { siteId: string; connection: { verified: boolean } | null }[] }>("/api/connections")
      .then((data) => { if (active) setVerified(Object.fromEntries(data.connections.map((row) => [row.siteId, Boolean(row.connection?.verified)]))); })
      .catch(() => { /* Unknown state: the server still checks every connection before publishing. */ })
      .finally(() => { if (active) setLoaded(true); });
    return () => { active = false; };
  }, []);
  return { verified, loaded };
}

export function PlacementFields({ value, onChange, disabled }: { value: Placement; onChange: (value: Placement) => void; disabled?: boolean }) {
  const strategy = publishStrategies[value.strategy];
  const primary = primaryLocation(value);
  const prefix = pagePathPrefix(primary);
  return <fieldset className="publish-options" disabled={disabled}>
    <legend>Yayın yeri ve AI yayın stratejisi</legend>
    <div className="publish-options-grid">
      <label><span>AI yayın stratejisi</span><select value={value.strategy} onChange={(event) => {
        const next = event.target.value as PublishStrategy;
        // Strategy auto-configures the location; the user can still override it below.
        onChange({ ...value, strategy: next, location: publishStrategies[next].defaultLocation, servicePath: null });
      }}>{Object.entries(publishStrategies).map(([id, item]) => <option key={id} value={id}>{item.label}{id === "seo" ? " (varsayılan)" : ""}</option>)}</select></label>
      <label><span>Yayın yeri</span><select value={value.location} onChange={(event) => onChange({ ...value, location: event.target.value as PublishLocation, servicePath: event.target.value === "service-page" ? value.servicePath : null })}>{Object.entries(publishLocations).map(([id, item]) => <option key={id} value={id}>{item.label}{id === "seo-page" ? " (varsayılan)" : ""}</option>)}</select></label>
    </div>
    {value.location === "service-page" && <label><span>Hizmet sayfası yolu (boş bırakılırsa tüm hizmet sayfası alanlarında görünür)</span><input placeholder="/hizmetler/dis-cephe-boya" value={value.servicePath || ""} maxLength={200} onChange={(event) => onChange({ ...value, servicePath: event.target.value })} onBlur={() => onChange({ ...value, servicePath: normalizeServicePath(value.servicePath) })} /></label>}
    <p className="publish-hint">{strategy.description}</p>
    <p className="publish-hint">{publishLocations[value.location].description}{prefix ? ` Adres: ${prefix}/<site-başlığından-otomatik-kısa-ad>` : ""}{showsHomepageTeaser(value) ? " Ana sayfaya yalnız kısa tanıtım ve 'Devamını oku' düğmesi eklenir." : ""}</p>
    <ul className="publish-preview">{strategy.preview.map((line) => <li key={line}><CheckCircle2 size={14} />{line}</li>)}</ul>
  </fieldset>;
}

export type ScheduleMode = "now" | "later";
export function ScheduleFields({ mode, at, onMode, onAt, disabled }: { mode: ScheduleMode; at: string; onMode: (mode: ScheduleMode) => void; onAt: (value: string) => void; disabled?: boolean }) {
  return <fieldset className="publish-options" disabled={disabled}>
    <legend>Yayın zamanı</legend>
    <div className="publish-radio-row">
      <label><input type="radio" checked={mode === "now"} onChange={() => onMode("now")} />Hemen yayınla (varsayılan)</label>
      <label><input type="radio" checked={mode === "later"} onChange={() => onMode("later")} />Belirli tarih ve saate planla</label>
    </div>
    {mode === "later" && <label><span>Yayın tarihi ve saati (yerel saat)</span><input type="datetime-local" value={at} onChange={(event) => onAt(event.target.value)} /></label>}
    {mode === "later" && <p className="publish-hint">Zamanı geldiğinde içerik kendiliğinden yayına girer; ek işlem gerekmez. Durum, geçmiş ve tüm ayarlar korunur.</p>}
  </fieldset>;
}

export function TargetFields({ candidates, scope, onScope, selected, onSelected, verified, disabled }: {
  candidates: string[]; scope: PublishScope; onScope: (scope: PublishScope) => void; selected: string[]; onSelected: (ids: string[]) => void; verified: Record<string, boolean>; disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("tr");
    return candidates.filter((id) => !needle || siteName(id).toLocaleLowerCase("tr").includes(needle) || id.includes(needle));
  }, [candidates, query]);
  const unverified = candidates.filter((id) => !verified[id]);
  return <fieldset className="publish-options" disabled={disabled}>
    <legend>Yayın hedefi</legend>
    <div className="publish-radio-row">{(Object.keys(publishScopes) as PublishScope[]).map((id) => <label key={id}><input type="radio" checked={scope === id} onChange={() => {
      onScope(id);
      if (id === "current") onSelected(selected.slice(0, 1).length ? selected.slice(0, 1) : candidates.slice(0, 1));
      if (id === "all-connected") onSelected(candidates.filter((site) => verified[site]));
    }} />{publishScopes[id].label}</label>)}</div>
    <p className="publish-hint">{publishScopes[scope].description}</p>
    {scope === "current" && <label><span>Site</span><select value={selected[0] || ""} onChange={(event) => onSelected([event.target.value])}>{candidates.map((id) => <option key={id} value={id}>{siteName(id)}{verified[id] ? "" : " — bağlantı doğrulanmadı"}</option>)}</select></label>}
    {scope === "selected" && <>
      <label><span>Site ara</span><input type="search" placeholder="Site adı veya kimliği" value={query} onChange={(event) => setQuery(event.target.value)} /></label>
      <div className="publish-site-list">{visible.map((id) => <label key={id}><input type="checkbox" checked={selected.includes(id)} onChange={() => onSelected(selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id])} /><span>{siteName(id)}</span><em className={`target-state ${verified[id] ? "published" : "failed"}`}>{verified[id] ? "Bağlı" : "Doğrulanmadı"}</em></label>)}{!visible.length && <p className="publish-hint">Eşleşen site yok.</p>}</div>
      <div className="publish-radio-row"><button type="button" className="text-button" onClick={() => onSelected(candidates)}>Tümünü seç</button><button type="button" className="text-button" onClick={() => onSelected([])}>Seçimi temizle</button></div>
    </>}
    {scope === "all-connected" && unverified.length > 0 && <p className="publish-warning"><AlertTriangle size={15} />{unverified.map(siteName).join(", ")} doğrulanmadığı için atlanacak. Diğer sitelerde yayın devam eder.</p>}
  </fieldset>;
}

export type SummaryResult = { siteId: string; success: boolean; status?: string; detail?: string; skipped?: boolean };
export function PublishSummary({ title, placement, scheduleLabel, scope, siteIds, verified, busy, results, onConfirm, onClose }: {
  title: string; placement?: Placement; scheduleLabel: string; scope: PublishScope; siteIds: string[]; verified: Record<string, boolean>; busy: boolean; results?: SummaryResult[] | null; onConfirm: () => void; onClose: () => void;
}) {
  useEffect(() => {
    const handler = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); };
    document.addEventListener("keydown", handler); return () => document.removeEventListener("keydown", handler);
  }, [busy, onClose]);
  const targetLabel = scope === "current" ? "Yalnız bu site" : scope === "all-connected" ? `Tüm bağlı siteler (${siteIds.filter((id) => verified[id]).length})` : `${siteIds.length} seçili site`;
  return <div className="modal-layer confirmation-layer"><div className="modal-backdrop" /><section className="setup-dialog confirmation-dialog publish-summary" role="alertdialog" aria-modal="true" aria-labelledby="publish-summary-title">
    <h2 id="publish-summary-title">{results ? "Yayın sonucu" : "Yayın özeti"}</h2>
    <dl>
      <dt>Yayın</dt><dd>{title}</dd>
      {placement && <><dt>AI yayın stratejisi</dt><dd>✓ {publishStrategies[placement.strategy].label}</dd><dt>Yayın yeri</dt><dd>✓ {publishLocations[placement.location].label}{placement.servicePath ? ` · ${placement.servicePath}` : ""}{showsHomepageTeaser(placement) ? " + ana sayfa kısa tanıtım" : ""}</dd></>}
      <dt>Yayın zamanı</dt><dd>✓ {scheduleLabel}</dd>
      <dt>Yayın hedefi</dt><dd>✓ {targetLabel}</dd>
    </dl>
    {!results && <ul className="publish-summary-sites">{siteIds.map((id) => <li key={id} className={verified[id] ? "ok" : "warn"}>{verified[id] ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}{siteName(id)}{!verified[id] && <small>{scope === "all-connected" ? " — doğrulanmadı, atlanacak" : " — bağlantı doğrulanmadı, bu site başarısız olur; diğerleri devam eder"}</small>}</li>)}</ul>}
    {results && <ul className="publish-summary-sites">{results.map((result) => <li key={result.siteId} className={result.success ? "ok" : result.skipped ? "warn" : "fail"}>{result.success ? <CheckCircle2 size={15} /> : result.skipped ? <AlertTriangle size={15} /> : <XCircle size={15} />}<span>{siteName(result.siteId)}{!result.success && result.detail && <small>Neden: {result.detail}</small>}</span></li>)}</ul>}
    {placement && !results && <p className="publish-hint">Tam içerik yalnız {publishLocations[primaryLocation(placement)].label.toLocaleLowerCase("tr")} konumunda yayınlanır; aynı makale başka konuma kopyalanmaz.</p>}
    <div className="editor-actions">
      {results ? <button className="button primary" onClick={onClose}>Kapat</button> : <><button className="button secondary" disabled={busy} onClick={onClose}>Vazgeç</button><button className="button primary" disabled={busy || !siteIds.length} onClick={onConfirm}>{busy ? "Yayınlanıyor…" : "Onayla ve yayınla"}</button></>}
    </div>
  </section></div>;
}

export function scheduleLabelOf(mode: ScheduleMode, at: string) {
  if (mode === "now" || !at) return "Hemen";
  const date = new Date(at);
  return Number.isFinite(date.getTime()) ? `${date.toLocaleDateString("tr-TR")} ${date.toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit" })}` : "Hemen";
}

export function countdown(at: string, now = Date.now()) {
  const ms = Date.parse(at) - now;
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const minutes = Math.ceil(ms / 60000);
  const days = Math.floor(minutes / 1440); const hours = Math.floor((minutes % 1440) / 60); const mins = minutes % 60;
  return `${days ? `${days} gün ` : ""}${hours ? `${hours} sa ` : ""}${!days ? `${mins} dk ` : ""}kaldı`.trim();
}
