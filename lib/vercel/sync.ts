import { createHash } from "node:crypto";
import { blobPaths, createJson, deleteJson, isRecord, mapLimit, overwriteJson, readJson } from "@/lib/blob-store";
import { ApiError } from "@/lib/errors";
import { baseSites, excludedProjects, sites } from "@/lib/sites";
import { ensureSiteRegistry, importVercelSite, listSiteRecords, setSiteArchived } from "@/lib/site-registry";
import { probeConnector, verifySite } from "@/lib/verification";
import { getVercelCredentials } from "@/lib/vercel/credentials";
import { deploymentState, deploymentTime, getAccount, listDeployments, listDomains, listEnvMetadata, listProjects, VercelApiError, type VercelDeployment, type VercelProject } from "@/lib/vercel/api";
import { computeLiveStatus, getProjectRecord, listProjectRecords, upsertProjectRecord, type DeploymentSummary, type VercelProjectRecord } from "@/lib/vercel/projects";
import { getVercelSettings, updateVercelSettings } from "@/lib/vercel/settings";
import { eventKeyForSite, logEvents, pruneEvents, type ProjectEvent } from "@/lib/vercel/events";

/*
 * Vercel discovery + synchronisation. Runs:
 *   - when the account is connected,   - while the panel is open (deployments every 2 min, full every 10 min),
 *   - after every publish (panel),     - daily via Vercel Cron (/api/cron/vercel-sync),
 *   - on Vercel deployment/project webhooks (optional, /api/vercel/webhook).
 * A create-only lock object prevents overlapping runs across instances.
 */

export type SyncState = { status: "ok" | "auth-required" | "error" | "not-configured"; lastSyncAt: string | null; lastSuccessAt: string | null; error: string | null; projectCount: number; reason: string | null; durationMs: number | null;
  /** Last full sync (domains, env names, connector probes) and last deployment status check (every run). */
  lastFullSyncAt?: string | null; lastDeploymentCheckAt?: string | null; account?: string | null; team?: string | null };
const parseSyncState = (value: unknown): SyncState | null => isRecord(value) && typeof value.status === "string" ? value as unknown as SyncState : null;
export async function getSyncState(): Promise<SyncState | null> {
  try { return (await readJson(blobPaths.vercelSyncState, parseSyncState))?.value ?? null; } catch { return null; }
}

const LOCK_MS = 90_000;
const PROBE_DEADLINE_MS = 38_000;
const parseLock = (value: unknown) => isRecord(value) && typeof value.expiresAt === "number" ? value as { expiresAt: number } : null;

async function acquireLock() {
  const lock = { expiresAt: Date.now() + LOCK_MS };
  if (await createJson(blobPaths.vercelSyncLock, lock) === "created") return true;
  const current = await readJson(blobPaths.vercelSyncLock, parseLock).catch(() => null);
  if (current && current.value.expiresAt > Date.now()) return false;
  await deleteJson(blobPaths.vercelSyncLock).catch(() => undefined);
  return await createJson(blobPaths.vercelSyncLock, lock) === "created";
}

const iso = (ms: number | undefined | null) => (ms ? new Date(ms).toISOString() : null);
function summarize(deployment: VercelDeployment | undefined): DeploymentSummary | null {
  if (!deployment) return null;
  return {
    id: deployment.uid, url: deployment.url ? `https://${deployment.url}` : null, state: deploymentState(deployment),
    createdAt: iso(deploymentTime(deployment)), readyAt: iso(deployment.ready), target: deployment.target ?? null,
    branch: deployment.meta?.githubCommitRef || deployment.meta?.gitlabCommitRef || deployment.meta?.bitbucketCommitRef || null,
    commit: (deployment.meta?.githubCommitMessage || deployment.meta?.gitlabCommitMessage || "").slice(0, 120) || null,
  };
}

function productionDomainOf(project: VercelProject, domains: { name: string; verified?: boolean; redirect?: string | null; gitBranch?: string | null }[]) {
  const live = domains.filter((domain) => domain.verified !== false && !domain.redirect && !domain.gitBranch).map((domain) => domain.name);
  const custom = live.filter((name) => !name.endsWith(".vercel.app"));
  // No fallback: a project without any production domain is reported as "Missing Domain".
  const preferred = custom.find((name) => !name.startsWith("www.")) || custom[0] || live[0] || project.targets?.production?.alias?.[0] || null;
  return { productionDomain: preferred, customDomains: custom };
}

type SyncSummary = { state: SyncState; discovered: number; imported: string[]; archived: string[]; restored: string[]; pending: string[]; skipped?: "running" | "not-configured" };

/** Matches a project to an existing built-in site by Vercel project name or by domain (keeps ids, publications, connections). */
function builtInSiteFor(name: string, domains: (string | null | undefined)[] = []) {
  const hosts = new Set(domains.filter(Boolean).map((domain) => String(domain).replace(/^www\./, "")));
  return baseSites.find((site) => site.project === name)?.id ?? baseSites.find((site) => hosts.has(site.domain.replace(/^www\./, "")))?.id ?? null;
}
/** A project opts out of ROIstation with a ROISTATION_DISABLED environment variable (name only is read). */
const disabledByEnv = (envKeys: { key: string }[]) => envKeys.some((env) => env.key === "ROISTATION_DISABLED");

/**
 * full=true  : projects + domains + env names + deployments + connector probes + account (every 10 min, connect, cron)
 * full=false : projects + deployments only, re-verifying sites whose deployment changed (every 2 min while the panel is open)
 */
export async function syncVercel(reason: string, options: { full?: boolean } = {}): Promise<SyncSummary> {
  const full = options.full !== false;
  const started = Date.now();
  const credentials = await getVercelCredentials();
  const emptyState: SyncState = { status: "not-configured", lastSyncAt: new Date().toISOString(), lastSuccessAt: null, error: null, projectCount: 0, reason, durationMs: 0 };
  if (!credentials) return { state: emptyState, discovered: 0, imported: [], archived: [], restored: [], pending: [], skipped: "not-configured" };
  if (!await acquireLock()) {
    const state = await getSyncState();
    return { state: state ?? emptyState, discovered: 0, imported: [], archived: [], restored: [], pending: [], skipped: "running" };
  }
  const previousState = await getSyncState();
  try {
    let projects: VercelProject[];
    try { projects = await listProjects(credentials); }
    catch (error) {
      const auth = error instanceof VercelApiError && error.kind === "auth";
      if (auth) {
        const records = await listProjectRecords();
        await mapLimit(records.filter((record) => !record.archived), 8, (record) => upsertProjectRecord(record.projectId, (current) => ({ ...(current ?? record), liveStatus: "auth-required", statusDetail: "Vercel erişim anahtarı geçersiz; Vercel bağlantısını yenile." })).catch(() => undefined));
      }
      const state: SyncState = { ...previousState, status: auth ? "auth-required" : "error", lastSyncAt: new Date().toISOString(), lastSuccessAt: previousState?.lastSuccessAt ?? null, error: error instanceof Error ? error.message : "Vercel projeleri okunamadı.", projectCount: previousState?.projectCount ?? 0, reason, durationMs: Date.now() - started };
      await overwriteJson(blobPaths.vercelSyncState, state, { cacheControlMaxAge: 0 });
      return { state, discovered: 0, imported: [], archived: [], restored: [], pending: [] };
    }

    await ensureSiteRegistry(true);
    const [records, siteRecords, settings] = await Promise.all([listProjectRecords(), listSiteRecords(), getVercelSettings()]);
    const byId = new Map(records.map((record) => [record.projectId, record]));
    const seen = new Set(projects.map((project) => project.id));
    const events: (Omit<ProjectEvent, "at">)[] = [];
    const restored: string[] = []; const archived: string[] = [];

    const synced = await mapLimit(projects, 6, async (project) => {
      const previous = byId.get(project.id) ?? null;
      const needsFull = full || !previous;
      const [domainsResult, deploymentsResult, envResult] = await Promise.allSettled([needsFull ? listDomains(credentials, project.id) : Promise.reject(new Error("light")), listDeployments(credentials, project.id, 10), needsFull ? listEnvMetadata(credentials, project.id) : Promise.reject(new Error("light"))]);
      const domains = domainsResult.status === "fulfilled" ? domainsResult.value : null;
      const deployments = deploymentsResult.status === "fulfilled" ? deploymentsResult.value : null;
      const envs = envResult.status === "fulfilled" ? envResult.value : null;
      const { productionDomain, customDomains } = domains ? productionDomainOf(project, domains) : { productionDomain: previous?.productionDomain ?? null, customDomains: previous?.customDomains ?? [] };
      const production = deployments?.filter((item) => item.target === "production") ?? [];
      const latestProduction = deployments ? summarize(production[0]) : previous?.latestProduction ?? null;
      const currentProduction = project.targets?.production?.id ? { id: project.targets.production.id, url: project.targets.production.url ? `https://${project.targets.production.url}` : null, state: String(project.targets.production.readyState || "READY").toUpperCase(), createdAt: iso(project.targets.production.createdAt), readyAt: null, target: "production" } : previous?.currentProduction ?? null;
      const latestPreview = deployments ? summarize(deployments.find((item) => item.target !== "production")) : previous?.latestPreview ?? null;
      const lastSuccess = production.find((item) => deploymentState(item) === "READY");
      const envKeys = envs ? envs.map(({ key, target, type }) => ({ key, target, type })) : previous?.envKeys ?? [];
      const envHash = envs ? createHash("sha256").update(envKeys.map((env) => `${env.key}:${[...env.target].sort().join(",")}`).sort().join("|")).digest("hex").slice(0, 16) : previous?.envHash ?? null;
      const excluded = excludedProjects.includes(project.name);
      const disabled = disabledByEnv(envKeys);
      const siteRecord = siteRecords.find((record) => record.vercelProjectId === project.id);
      const siteId = previous?.siteId ?? siteRecord?.id ?? builtInSiteFor(project.name, [productionDomain, ...customDomains]);
      const now = new Date().toISOString();

      let draft: VercelProjectRecord = {
        projectId: project.id, name: project.name, framework: project.framework ?? null, rootDirectory: project.rootDirectory ?? null,
        productionDomain, customDomains, productionUrl: productionDomain ? `https://${productionDomain}` : null, previewUrl: latestPreview?.url ?? null,
        repository: project.link ? { provider: project.link.type ?? null, repo: project.link.org && project.link.repo ? `${project.link.org}/${project.link.repo}` : project.link.repo || project.link.projectName || null, branch: project.link.productionBranch ?? null } : null,
        envKeys, envHash, latestProduction, currentProduction, latestPreview,
        lastSuccessfulDeployAt: iso(lastSuccess ? deploymentTime(lastSuccess) : null) ?? previous?.lastSuccessfulDeployAt ?? null,
        lastDeployAt: latestProduction?.createdAt ?? previous?.lastDeployAt ?? null,
        // Every project in the connected account is ROIstation-ready unless it explicitly opts out.
        compatibility: disabled ? "not-compatible" : previous?.connector?.connected ? "connected" : "compatible",
        connector: previous?.connector ?? null, health: previous?.health ?? null, liveStatus: previous?.liveStatus ?? "not-connected", statusDetail: previous?.statusDetail ?? "",
        siteId, excluded, ignored: previous?.ignored ?? settings.ignoredProjects.includes(project.id), pending: previous?.pending ?? false,
        archived: false, archivedAt: null, firstSeenAt: previous?.firstSeenAt ?? now, lastSyncAt: now,
      };

      // Connector detection for projects not yet linked (linked ones are fully verified below).
      if (!siteId && needsFull && Date.now() - started < PROBE_DEADLINE_MS && draft.productionUrl) {
        const hosts = new Set([productionDomain, ...customDomains, `${project.name}.vercel.app`].filter((host): host is string => Boolean(host)));
        const probe = await probeConnector(draft.productionUrl, hosts, null).catch(() => null);
        const reachable = probe ? probe.kind !== "not-verified" || probe.reason === "not-found" || probe.reason === "invalid-json" || probe.reason === "http" : null;
        draft.connector = probe && probe.kind !== "not-verified" ? probe.info : null;
        draft.health = { checkedAt: now, apiResponding: true, deploymentReady: latestProduction ? latestProduction.state === "READY" : null, latestDeploymentSuccessful: latestProduction ? latestProduction.state === "READY" : null, domainActive: reachable, sslValid: probe && probe.kind === "not-verified" && probe.reason === "tls" ? false : reachable ? true : null, connectorReachable: probe ? probe.kind !== "not-verified" : null, publishEndpoint: probe?.kind === "connected" };
        if (probe?.kind === "connected" && !disabled) draft.compatibility = "connected";
      }
      const live = computeLiveStatus(draft, null);
      draft = { ...draft, liveStatus: live.status, statusDetail: live.detail };

      // Change detection -> activity log.
      const key = eventKeyForSite(siteId ?? project.id, project.id);
      if (!previous) events.push({ key, projectId: project.id, siteId: siteId ?? undefined, type: "project-detected", message: `Yeni Vercel projesi algılandı: ${project.name}` });
      else {
        if (previous.archived) { events.push({ key, projectId: project.id, type: "project-restored", message: `${project.name} Vercel'de yeniden bulundu; geri yüklendi.` }); restored.push(project.id); }
        if (previous.name !== project.name) events.push({ key, projectId: project.id, type: "project-renamed", message: `${previous.name} → ${project.name}` });
        if (previous.productionDomain !== productionDomain || previous.customDomains.join(",") !== customDomains.join(",")) events.push({ key, projectId: project.id, type: "domain-changed", message: `Domain: ${productionDomain}` });
        if (previous.framework !== draft.framework) events.push({ key, projectId: project.id, type: "framework-changed", message: `Framework: ${previous.framework || "—"} → ${draft.framework || "—"}` });
        if (previous.envHash && envHash && previous.envHash !== envHash) events.push({ key, projectId: project.id, type: "environment-updated", message: "Ortam değişkeni adları/hedefleri değişti (değerler okunmaz)." });
        if (latestProduction && previous.latestProduction?.id !== latestProduction.id) events.push({ key, projectId: project.id, type: latestProduction.state === "READY" ? "deployment-completed" : latestProduction.state === "ERROR" ? "deployment-failed" : "deployment-started", message: `${project.name}: production deploy ${latestProduction.state.toLowerCase()}${latestProduction.commit ? ` — ${latestProduction.commit}` : ""}` });
        else if (latestProduction && previous.latestProduction?.state !== latestProduction.state && ["READY", "ERROR"].includes(latestProduction.state)) events.push({ key, projectId: project.id, type: latestProduction.state === "READY" ? "deployment-completed" : "deployment-failed", message: `${project.name}: production deploy ${latestProduction.state.toLowerCase()}` });
        if (!siteId && !previous.connector?.connected && draft.connector?.connected) events.push({ key, projectId: project.id, type: "connector-installed", message: `${project.name}: ROIstation connector algılandı${draft.connector.version ? ` (v${draft.connector.version})` : ""}.` });
      }

      const record = await upsertProjectRecord(project.id, (current) => ({ ...draft, siteId: current?.siteId ?? draft.siteId, ignored: current?.ignored ?? draft.ignored, pending: current?.pending ?? draft.pending, connector: siteId ? current?.connector ?? draft.connector : draft.connector, health: siteId ? current?.health ?? draft.health : draft.health }));
      if (previous?.archived && siteRecord?.archived) await setSiteArchived(siteRecord.id, false).catch(() => undefined);

      // Linked projects: full verification (deployment gate + connector endpoint / widget code + domain/SSL).
      const deploymentChanged = previous?.latestProduction?.id !== record.latestProduction?.id || previous?.latestProduction?.state !== record.latestProduction?.state || previous?.productionDomain !== record.productionDomain;
      const stale = !record.health?.checkedAt || Date.now() - Date.parse(record.health.checkedAt) > 10 * 60_000;
      if (record.siteId && sites.some((site) => site.id === record.siteId) && (full || deploymentChanged || stale) && Date.now() - started < PROBE_DEADLINE_MS) {
        const connectorBefore = record.connector;
        const connection = await verifySite(record.siteId, { project: record, skipVercel: true, reason: `sync:${reason}` }).catch(() => null);
        if (connection?.connector && connectorBefore?.version && connection.connector.version && connectorBefore.version !== connection.connector.version) events.push({ key, projectId: project.id, siteId: record.siteId, type: "connector-updated", message: `Connector v${connectorBefore.version} → v${connection.connector.version}` });
        if (connection?.connector?.connected && !connectorBefore?.connected) events.push({ key, projectId: project.id, siteId: record.siteId, type: "connector-installed", message: `${project.name}: connector doğrulandı.` });
        if (connectorBefore?.connected && connection && !connection.connector?.connected) events.push({ key, projectId: project.id, siteId: record.siteId, type: "connector-removed", message: `${project.name}: connector artık yanıt vermiyor.` });
      }
      return record;
    });

    // Projects deleted from Vercel: archive (never delete publications, forms or history).
    for (const record of records) {
      if (seen.has(record.projectId) || record.archived) continue;
      await upsertProjectRecord(record.projectId, (current) => ({ ...(current ?? record), archived: true, archivedAt: new Date().toISOString(), liveStatus: "archived", statusDetail: "Proje Vercel hesabında bulunamadı; yayınlar ve geçmiş korunuyor." }));
      const siteRecord = siteRecords.find((site) => site.vercelProjectId === record.projectId);
      if (siteRecord && !siteRecord.archived) await setSiteArchived(siteRecord.id, true, "Vercel projesi silindi").catch(() => undefined);
      events.push({ key: eventKeyForSite(record.siteId ?? record.projectId, record.projectId), projectId: record.projectId, type: "project-archived", message: `${record.name} Vercel'de bulunamadı; arşivlendi (yayınlar korunuyor).` });
      archived.push(record.projectId);
    }

    // Auto-connect policy.
    const imported: string[] = []; const pending: string[] = [];
    for (const record of synced) {
      // Auto-registration: every project of the connected account, except excluded / opted-out / ignored ones.
      if (record.siteId || record.excluded || record.ignored || record.archived || record.compatibility === "not-compatible") continue;
      const connectorPresent = Boolean(record.connector?.connected);
      if (settings.autoConnect === "auto" || (settings.autoConnect === "ask" && connectorPresent)) {
        try { await connectProject(record.projectId, "auto"); imported.push(record.projectId); } catch (error) { console.error("[vercel] auto import failed", record.name, error); }
      } else if (settings.autoConnect === "ask" && !record.pending) {
        await upsertProjectRecord(record.projectId, (current) => ({ ...(current ?? record), pending: true }));
        pending.push(record.projectId);
      }
    }

    await logEvents(events);
    if (Math.random() < 0.1) await mapLimit(synced.slice(0, 50), 4, (record) => pruneEvents(record.projectId).catch(() => undefined));
    let account = previousState?.account ?? null; let team = previousState?.team ?? null;
    if (full || !account) { try { const info = await getAccount(credentials); account = info.user; team = info.team; } catch { /* keep previous */ } }
    const finished = new Date().toISOString();
    const state: SyncState = { status: "ok", lastSyncAt: finished, lastSuccessAt: finished, error: null, projectCount: projects.length, reason, durationMs: Date.now() - started, lastFullSyncAt: full ? finished : previousState?.lastFullSyncAt ?? null, lastDeploymentCheckAt: finished, account, team };
    await overwriteJson(blobPaths.vercelSyncState, state, { cacheControlMaxAge: 0 });
    return { state, discovered: projects.length, imported, archived, restored, pending };
  } finally {
    await deleteJson(blobPaths.vercelSyncLock).catch(() => undefined);
  }
}

/** One-click connect: registers the project as a site (or links a built-in one) and verifies it. */
export async function connectProject(projectId: string, by: "user" | "auto" = "user") {
  const record = await getProjectRecord(projectId);
  if (!record) throw new ApiError("Vercel projesi bulunamadı. Önce senkronize et.", 404);
  if (record.archived) throw new ApiError("Proje Vercel'de bulunamadı; arşivde.", 409);
  if (by === "auto" && record.excluded) throw new ApiError("Kapsam dışı proje otomatik bağlanmaz.");
  const builtIn = builtInSiteFor(record.name, [record.productionDomain, ...record.customDomains]);
  if (record.compatibility === "not-compatible") throw new ApiError("Bu proje ROISTATION_DISABLED ile ROIstation'ı kapatmış.", 409);
  const siteId = record.siteId && sites.some((site) => site.id === record.siteId) ? record.siteId : builtIn ?? await importVercelSite({ preferredId: record.connector?.siteId, name: record.name, project: record.name, domain: record.productionDomain || `${record.name}.vercel.app`, framework: record.framework, vercelProjectId: record.projectId });
  const linked = await upsertProjectRecord(projectId, (current) => ({ ...(current ?? record), siteId, pending: false, ignored: false }));
  if (by === "user" || !record.siteId) await updateVercelSettings((settings) => ({ ...settings, ignoredProjects: settings.ignoredProjects.filter((id) => id !== projectId) })).catch(() => undefined);
  const key = eventKeyForSite(siteId, projectId);
  await logEvents([{ key, projectId, siteId, type: "project-imported", message: `${record.name} ${by === "auto" ? "otomatik olarak " : ""}ROIstation'a eklendi (site: ${siteId}).` }]);
  const connection = await verifySite(siteId, { project: linked, reason: "connect" }).catch((error) => { console.error("[vercel] verification after connect failed", error); return null; });
  if (connection?.verified) await logEvents([{ key, projectId, siteId, type: "project-connected", message: `${record.name} yayına hazır.` }]);
  return { siteId, connection };
}

export async function ignoreProject(projectId: string) {
  const record = await getProjectRecord(projectId);
  if (!record) throw new ApiError("Vercel projesi bulunamadı.", 404);
  await updateVercelSettings((settings) => ({ ...settings, ignoredProjects: [...new Set([...settings.ignoredProjects, projectId])] }));
  await upsertProjectRecord(projectId, (current) => ({ ...(current ?? record), ignored: true, pending: false }));
  await logEvents([{ key: eventKeyForSite(record.siteId ?? projectId, projectId), projectId, type: "project-ignored", message: `${record.name} yok sayıldı; otomatik bağlanmaz.` }]);
}

/** Imports every compatible, not-yet-connected, in-scope project. */
export async function importAllCompatible() {
  const records = await listProjectRecords();
  const candidates = records.filter((record) => !record.siteId && !record.archived && !record.excluded && record.compatibility !== "not-compatible");
  const results = await mapLimit(candidates, 4, async (record) => {
    try { const { siteId, connection } = await connectProject(record.projectId, "user"); return { projectId: record.projectId, name: record.name, siteId, verified: Boolean(connection?.verified) }; }
    catch (error) { return { projectId: record.projectId, name: record.name, siteId: null, verified: false, error: error instanceof Error ? error.message : "İçe aktarılamadı." }; }
  });
  return results;
}

