"use client";

import { useCallback, useEffect, useState } from "react";
import { readApiResponse } from "@/lib/client-api";
import { excludedProjects } from "@/lib/sites";
import type { Connection } from "@/lib/publications";
import { connectionMeta, connectorMeta, formatDateTime, liveStatusMeta, relativeTime } from "@/lib/status-labels";
import { requestApi } from "@/lib/client-api";

type VercelSummary = { projectId: string; liveStatus: string; statusDetail: string; framework: string | null; productionUrl: string | null; lastDeployAt: string | null; lastSyncAt: string | null; deploymentState: string | null };
type Entry = { siteId: string; siteName: string; project: string; domain: string; siteUrl: string; connection: Connection | null; snippet: string; vercel: VercelSummary | null };

export function ConnectionManager({ onNotice }: { onNotice: (value: string) => void }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<Set<string>>(() => new Set());
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/connections", { cache: "no-store" });
      const data = await readApiResponse(response) as { connections: Entry[]; error?: string };
      if (!response.ok) throw new Error(data.error || "Bağlantılar yüklenemedi.");
      setEntries(data.connections);
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : "Bağlantılar yüklenemedi.");
    }
  }, []);

  // Statuses stay live without a page refresh.
  useEffect(() => { void load(); const timer = setInterval(() => { void load(); setNow(Date.now()); }, 60_000); return () => clearInterval(timer); }, [load]);

  const mark = (siteId: string, on: boolean) => setBusy((current) => { const next = new Set(current); if (on) next.add(siteId); else next.delete(siteId); return next; });

  /** Verifies one site and updates its card as soon as the answer arrives. */
  async function verify(entry: Entry, quiet = false) {
    mark(entry.siteId, true);
    try {
      const response = await fetch("/api/connections", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ siteId: entry.siteId, siteUrl: entry.siteUrl }) });
      const data = await readApiResponse(response) as { connection: Connection; error?: string };
      if (!response.ok) throw new Error(data.error || "Doğrulama başarısız.");
      setEntries((current) => current.map((item) => item.siteId === entry.siteId ? { ...item, connection: data.connection, siteUrl: data.connection.site_url } : item));
      if (!quiet) onNotice(`${entry.siteName}: ${data.connection.detail}`);
      return data.connection.verified;
    } catch (error) {
      if (!quiet) onNotice(error instanceof Error ? error.message : "Doğrulama başarısız.");
      return false;
    } finally {
      mark(entry.siteId, false);
    }
  }

  /** Verify All: a full Vercel API sync (projects, domains, deployments) that re-verifies every linked site. Sites outside Vercel are checked directly. */
  async function verifyAll() {
    setBusy(new Set(entries.map((entry) => entry.siteId)));
    try {
      const overview = await requestApi<{ configured: boolean }>("/api/vercel");
      if (overview.configured) await requestApi("/api/vercel", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "sync", reason: "verify-all", full: true }) });
      const outside = overview.configured ? entries.filter((entry) => !entry.vercel) : entries;
      setBusy(new Set(outside.map((entry) => entry.siteId)));
      await Promise.all(outside.map((entry) => verify(entry, true)));
      await load();
      onNotice(overview.configured ? "Tüm siteler Vercel API üzerinden doğrulandı. Durumlar kartlarda." : "Tüm siteler doğrulandı. Vercel hesabı bağlanırsa doğrulama Vercel API ile otomatik yapılır.");
    } catch (error) { onNotice(error instanceof Error ? error.message : "Doğrulama tamamlanamadı."); }
    finally { setBusy(new Set()); }
  }

  return (
    <>
      <div className="manager-heading">
        <div>
          <span className="section-kicker">SITE CONNECTOR</span>
          <h1>Site bağlantıları</h1>
          <p>Vercel hesabındaki siteler Vercel API ile otomatik doğrulanır: deploy hazır ve domain erişilebilir olduğunda yayına açılır. Durumlar birkaç dakikada bir, her yayından önce ve günde bir kez kendiliğinden güncellenir.</p>
        </div>
        <div>
          <button className="button secondary" onClick={() => void load()}>Durumları yenile</button>
          <button className="button primary" disabled={busy.size > 0 || !entries.length} onClick={() => void verifyAll()}>{busy.size > 1 ? `Doğrulanıyor… (${busy.size})` : "Tümünü doğrula"}</button>
        </div>
      </div>

      {error && <div className="manager-error" role="alert">{error}</div>}

      <div className="connection-grid">
        {entries.map((entry) => {
          const meta = connectionMeta(entry.connection);
          const vercelMeta = entry.vercel ? liveStatusMeta[entry.vercel.liveStatus] : null;
          const connector = entry.connection?.connector;
          return (
            <article className="panel connection-card" key={entry.siteId}>
              <div className="manager-heading">
                <div>
                  <h2>{entry.siteName}</h2>
                  <p>{entry.project}</p>
                </div>
                <span className={`status-pill ${busy.has(entry.siteId) ? "busy" : meta.tone}`}><i />{busy.has(entry.siteId) ? "Kontrol ediliyor" : meta.label}</span>
                {connectorMeta(entry.connection?.connectorState) && <span className={`status-pill ${connectorMeta(entry.connection?.connectorState)!.tone}`}><i />{connectorMeta(entry.connection?.connectorState)!.label}</span>}
              </div>

              <p>{entry.connection?.detail || "Henüz bağlantı kontrolü yapılmadı."}</p>
              <dl className="connection-facts">
                <dt>Domain</dt><dd><a href={entry.siteUrl} target="_blank" rel="noreferrer">{entry.domain}</a></dd>
                <dt>Son görülme</dt><dd title={formatDateTime(entry.connection?.last_seen)}>{relativeTime(entry.connection?.last_seen, now)}</dd>
                <dt>Connector sürümü</dt><dd>{connector?.version ? `v${connector.version}` : entry.connection?.method === "widget" ? "widget.js" : "—"}</dd>
                <dt>Ortam</dt><dd>{connector?.environment || "—"}</dd>
                <dt>Son deploy</dt><dd>{formatDateTime(entry.vercel?.lastDeployAt || entry.connection?.deployment?.createdAt)}{entry.vercel?.deploymentState ? ` · ${entry.vercel.deploymentState}` : ""}</dd>
                <dt>Son senkron</dt><dd>{formatDateTime(entry.vercel?.lastSyncAt || entry.connection?.verified_at)}</dd>
                {vercelMeta && <><dt>Vercel</dt><dd><span className={`status-pill ${vercelMeta.tone}`}><i />{vercelMeta.label}</span>{entry.vercel?.framework ? ` · ${entry.vercel.framework}` : ""}</dd></>}
              </dl>

              {!entry.vercel && <label>
                Bağlantı kodunun eklendiği sayfa
                <input
                  type="url"
                  value={entry.siteUrl}
                  onChange={(event) => setEntries(entries.map((item) => item.siteId === entry.siteId ? { ...item, siteUrl: event.target.value } : item))}
                />
              </label>}

              <details>
                <summary>{entry.connection?.connectorState === "missing" ? "İçeriğin sitede görünmesi için yayın alanı ekle" : "Bağlantı kodunu göster"}</summary>
                <pre>{entry.snippet}</pre>
                <p>HTML sitelerde doğrudan ekle. Next.js sitelerde connectors/roistation kitini ve app/api/roistation/verify uç noktasını kullan; site otomatik algılanır.</p>
                <button
                  className="button secondary"
                  onClick={async () => {
                    try {
                      await navigator.clipboard.writeText(entry.snippet);
                      onNotice("Bağlantı kodu kopyalandı.");
                    } catch {
                      onNotice("Tarayıcı kopyalamaya izin vermedi; kodu elle seçip kopyala.");
                    }
                  }}
                >
                  Kodu kopyala
                </button>
              </details>

              <button className="button primary" disabled={busy.has(entry.siteId)} onClick={() => void verify(entry)}>
                {busy.has(entry.siteId) ? "Kontrol ediliyor..." : entry.vercel ? "Şimdi yeniden kontrol et" : "Bağlantıyı doğrula"}
              </button>
            </article>
          );
        })}
      </div>

      {excludedProjects.length > 0 && <section className="excluded-panel">
        <strong>Kapsam dışındaki projeler</strong>
        <p>Bu projelere hiçbir yayın veya silme işlemi gönderilmez ve otomatik bağlanmazlar. Vercel ekranından elle bağlanabilirler.</p>
        {excludedProjects.map((project) => <p key={project}><code>{project}</code></p>)}
      </section>}
    </>
  );
}
