/*
 * Example: turning raw Vercel project / domain / deployment data into the deployment health
 * the panel shows, plus the change detection that feeds the per-project activity log.
 *
 * Demonstrates:
 *   - `summarize()`: a Vercel deployment reduced to id, URL, normalised state, times, branch and
 *     commit message (GitHub / GitLab / Bitbucket metadata),
 *   - `productionDomainOf()`: verified, non-redirect, non-branch domains; custom domains preferred
 *     over *.vercel.app and apex over www. No fallback URL is invented ("Missing Domain" instead),
 *   - env var change detection by hashing NAMES + targets only (values are never read),
 *   - the ROISTATION_DISABLED opt-out and built-in site matching by project name or domain,
 *   - `computeLiveStatus()`: strongest problem first (archived > opted out > deploying > failed >
 *     missing domain > domain offline > not registered > verification failed > connected),
 *   - the events the sync logs when a deployment, domain, framework, name or env set changes.
 *
 * Source: lib/vercel/sync.ts, lib/vercel/projects.ts (computeLiveStatus, record types),
 *         lib/vercel/api.ts (deploymentState, deploymentTime), lib/vercel/overview.ts (build queue)
 *
 * Differences from production: `syncVercel()` runs this per project under a create-only Blob
 * lock, writes each project record with compare-and-swap, probes connectors, re-verifies linked
 * sites and archives deleted projects. Here the per-project change detection is lifted out of
 * that loop into `projectEvents()`, and the built-in catalog is passed in as an argument.
 */

import { createHash } from "node:crypto";

export type VercelProject = { id: string; name: string; framework?: string | null; targets?: { production?: { id?: string; url?: string; alias?: string[]; readyState?: string; createdAt?: number } | null } | null };
export type VercelDomain = { name: string; verified?: boolean; redirect?: string | null; gitBranch?: string | null };
export type VercelDeployment = { uid: string; url?: string; state?: string; readyState?: string; created?: number; createdAt?: number; ready?: number; target?: string | null; meta?: Record<string, string> };
export type EnvMeta = { key: string; target: string[]; type: string };

export type DeploymentSummary = { id: string; url: string | null; state: string; createdAt: string | null; readyAt: string | null; target: string | null; branch?: string | null; commit?: string | null };
export type ConnectorInfo = { connected: boolean; siteId: string | null; siteName: string | null; version: string | null; environment: string | null; lastSeen: string | null; capabilities: string[] };
export type HealthChecks = { checkedAt: string; apiResponding: boolean; deploymentReady: boolean | null; latestDeploymentSuccessful: boolean | null; domainActive: boolean | null; sslValid: boolean | null; connectorReachable: boolean | null; publishEndpoint: boolean | null };
export type Compatibility = "connected" | "compatible" | "not-compatible";
export type LiveStatus = "connected" | "deploying" | "updating" | "connector-missing" | "deployment-failed" | "missing-domain" | "domain-offline" | "verification-failed" | "archived" | "not-connected" | "project-missing" | "auth-required" | "disabled";

/* ----------------------------------------------------------- lib/vercel/api.ts */

export const deploymentState = (deployment: VercelDeployment | null | undefined) => String(deployment?.state || deployment?.readyState || "").toUpperCase();
export const deploymentTime = (deployment: VercelDeployment | null | undefined) => deployment?.created ?? deployment?.createdAt ?? 0;

/* ---------------------------------------------------------- lib/vercel/sync.ts */

const iso = (ms: number | undefined | null) => (ms ? new Date(ms).toISOString() : null);
export function summarize(deployment: VercelDeployment | undefined): DeploymentSummary | null {
  if (!deployment) return null;
  return {
    id: deployment.uid, url: deployment.url ? `https://${deployment.url}` : null, state: deploymentState(deployment),
    createdAt: iso(deploymentTime(deployment)), readyAt: iso(deployment.ready), target: deployment.target ?? null,
    branch: deployment.meta?.githubCommitRef || deployment.meta?.gitlabCommitRef || deployment.meta?.bitbucketCommitRef || null,
    commit: (deployment.meta?.githubCommitMessage || deployment.meta?.gitlabCommitMessage || "").slice(0, 120) || null,
  };
}

export function productionDomainOf(project: VercelProject, domains: VercelDomain[]) {
  const live = domains.filter((domain) => domain.verified !== false && !domain.redirect && !domain.gitBranch).map((domain) => domain.name);
  const custom = live.filter((name) => !name.endsWith(".vercel.app"));
  // No fallback: a project without any production domain is reported as "Missing Domain".
  const preferred = custom.find((name) => !name.startsWith("www.")) || custom[0] || live[0] || project.targets?.production?.alias?.[0] || null;
  return { productionDomain: preferred, customDomains: custom };
}

/** Matches a project to an existing built-in site by Vercel project name or by domain (keeps ids, publications, connections). */
export function builtInSiteFor(baseSites: { id: string; project: string; domain: string }[], name: string, domains: (string | null | undefined)[] = []) {
  const hosts = new Set(domains.filter(Boolean).map((domain) => String(domain).replace(/^www\./, "")));
  return baseSites.find((site) => site.project === name)?.id ?? baseSites.find((site) => hosts.has(site.domain.replace(/^www\./, "")))?.id ?? null;
}
/** A project opts out of ROIstation with a ROISTATION_DISABLED environment variable (name only is read). */
export const disabledByEnv = (envKeys: { key: string }[]) => envKeys.some((env) => env.key === "ROISTATION_DISABLED");
/** Same expression as the sync: names + sorted targets, sorted, hashed. Values are never part of it. */
export const envHashOf = (envKeys: EnvMeta[]) => createHash("sha256").update(envKeys.map((env) => `${env.key}:${[...env.target].sort().join(",")}`).sort().join("|")).digest("hex").slice(0, 16);

/** The deployment fields the sync derives for one project from its latest 10 deployments. */
export function deploymentFields(project: VercelProject, deployments: VercelDeployment[]) {
  const production = deployments.filter((item) => item.target === "production");
  const latestProduction = summarize(production[0]);
  const currentProduction = project.targets?.production?.id ? { id: project.targets.production.id, url: project.targets.production.url ? `https://${project.targets.production.url}` : null, state: String(project.targets.production.readyState || "READY").toUpperCase(), createdAt: iso(project.targets.production.createdAt), readyAt: null, target: "production" } : null;
  const latestPreview = summarize(deployments.find((item) => item.target !== "production"));
  const lastSuccess = production.find((item) => deploymentState(item) === "READY");
  return { latestProduction, currentProduction, latestPreview, lastSuccessfulDeployAt: iso(lastSuccess ? deploymentTime(lastSuccess) : null), lastDeployAt: latestProduction?.createdAt ?? null };
}

/* ------------------------------------------------------ lib/vercel/projects.ts */

type StatusInput = { archived: boolean; latestProduction: DeploymentSummary | null; health: HealthChecks | null; siteId: string | null; connector: ConnectorInfo | null; compatibility: Compatibility; productionDomain: string | null };

/**
 * Live status from Vercel, strongest problem first:
 * archived > opted out > deploying > failed > missing domain > domain offline > not registered > connected.
 * Vercel ownership + Ready deployment + reachable domain = Connected/Verified. A missing
 * connector does not block publishing; it is reported separately (connector badge).
 */
export function computeLiveStatus(record: StatusInput, connectionVerified: boolean | null): { status: LiveStatus; detail: string } {
  if (record.archived) return { status: "archived", detail: "Proje Vercel hesabında bulunamadı; yayınlar ve geçmiş korunuyor." };
  if (record.compatibility === "not-compatible") return { status: "disabled", detail: "Proje ROISTATION_DISABLED ile ROIstation'ı kapatmış." };
  const state = record.latestProduction?.state || "";
  if (["BUILDING", "QUEUED", "INITIALIZING"].includes(state)) return { status: "deploying", detail: "Production deploy sürüyor." };
  if (state === "ERROR") return { status: "deployment-failed", detail: "Son production deploy başarısız oldu." };
  if (!record.latestProduction) return { status: "missing-domain", detail: "Henüz production deploy yok; ilk deploydan sonra otomatik bağlanır." };
  if (!record.productionDomain) return { status: "missing-domain", detail: "Projenin production domaini yok. Vercel'de domain ekleyince otomatik bağlanır." };
  if (record.health?.domainActive === false) return { status: "domain-offline", detail: record.health.sslValid === false ? "Production domain SSL sertifikası geçersiz." : "Production domain yanıt vermiyor." };
  if (!record.siteId) return { status: "not-connected", detail: "ROIstation'a kaydedilmedi." };
  if (connectionVerified === false) return { status: "verification-failed", detail: "Doğrulama tamamlanamadı; bir sonraki kontrolde tekrar denenir." };
  const connector = record.connector?.connected ? "Connector kurulu." : "Connector yok: içerik sitede görünmesi için yayın alanı (kit/widget) gerekir; yayın yine de alınır.";
  return { status: "connected", detail: `Vercel doğrulandı: deploy hazır, domain erişilebilir. ${connector}` };
}

/* ------------------------------------------- change detection (sync loop body) */

export type ProjectSnapshot = { name: string; framework: string | null; productionDomain: string | null; customDomains: string[]; envHash: string | null; latestProduction: DeploymentSummary | null; archived?: boolean };
export type ProjectEvent = { type: string; message: string };

export function projectEvents(previous: ProjectSnapshot | null, next: ProjectSnapshot): ProjectEvent[] {
  const events: ProjectEvent[] = [];
  const { latestProduction, productionDomain, customDomains, envHash } = next;
  if (!previous) { events.push({ type: "project-detected", message: `Yeni Vercel projesi algılandı: ${next.name}` }); return events; }
  if (previous.archived) events.push({ type: "project-restored", message: `${next.name} Vercel'de yeniden bulundu; geri yüklendi.` });
  if (previous.name !== next.name) events.push({ type: "project-renamed", message: `${previous.name} → ${next.name}` });
  if (previous.productionDomain !== productionDomain || previous.customDomains.join(",") !== customDomains.join(",")) events.push({ type: "domain-changed", message: `Domain: ${productionDomain}` });
  if (previous.framework !== next.framework) events.push({ type: "framework-changed", message: `Framework: ${previous.framework || "—"} → ${next.framework || "—"}` });
  if (previous.envHash && envHash && previous.envHash !== envHash) events.push({ type: "environment-updated", message: "Ortam değişkeni adları/hedefleri değişti (değerler okunmaz)." });
  if (latestProduction && previous.latestProduction?.id !== latestProduction.id) events.push({ type: latestProduction.state === "READY" ? "deployment-completed" : latestProduction.state === "ERROR" ? "deployment-failed" : "deployment-started", message: `${next.name}: production deploy ${latestProduction.state.toLowerCase()}${latestProduction.commit ? ` — ${latestProduction.commit}` : ""}` });
  else if (latestProduction && previous.latestProduction?.state !== latestProduction.state && ["READY", "ERROR"].includes(latestProduction.state)) events.push({ type: latestProduction.state === "READY" ? "deployment-completed" : "deployment-failed", message: `${next.name}: production deploy ${latestProduction.state.toLowerCase()}` });
  return events;
}

/* --------------------------------------------------------- lib/vercel/overview.ts */

const activeStates = new Set(["BUILDING", "QUEUED", "INITIALIZING"]);
/** Build queue shown on the Vercel overview: deployments still in progress. */
export const buildQueue = (deployments: DeploymentSummary[]) => deployments.filter((deployment) => activeStates.has(deployment.state));

/* ------------------------------------------------------------------ demo */

export function demo() {
  const project: VercelProject = { id: "prj_demo_zeytinlik", name: "zeytinlik-restoran", framework: "nextjs", targets: { production: { id: "dpl_demo_1", url: "zeytinlik-restoran-demo.vercel.app", readyState: "READY", createdAt: 1767225600000 } } };
  const domains: VercelDomain[] = [{ name: "zeytinlik-restoran.vercel.app", verified: true }, { name: "www.zeytinlik.example", verified: true, redirect: "zeytinlik.example" }, { name: "zeytinlik.example", verified: true }];
  const deployments: VercelDeployment[] = [
    { uid: "dpl_demo_2", url: "zeytinlik-restoran-demo-2.vercel.app", readyState: "ERROR", created: 1767312000000, target: "production", meta: { githubCommitRef: "main", githubCommitMessage: "Menü sayfası güncellendi" } },
    { uid: "dpl_demo_1", url: "zeytinlik-restoran-demo.vercel.app", readyState: "READY", created: 1767225600000, ready: 1767225660000, target: "production" },
    { uid: "dpl_demo_p1", url: "zeytinlik-restoran-git-menu.vercel.app", readyState: "BUILDING", created: 1767313000000, target: null },
  ];
  const envs: EnvMeta[] = [{ key: "ROISTATION_SITE_ID", target: ["production", "preview"], type: "plain" }];
  const { productionDomain, customDomains } = productionDomainOf(project, domains);
  const fields = deploymentFields(project, deployments);
  const previous: ProjectSnapshot = { name: "zeytinlik-restoran", framework: "nextjs", productionDomain: "zeytinlik-restoran.vercel.app", customDomains: [], envHash: envHashOf([]), latestProduction: summarize(deployments[1]) };
  const next: ProjectSnapshot = { name: project.name, framework: project.framework ?? null, productionDomain, customDomains, envHash: envHashOf(envs), latestProduction: fields.latestProduction };
  const siteId = builtInSiteFor([{ id: "zeytinlik-restoran", project: "zeytinlik-restoran", domain: "zeytinlik.example" }], project.name, [productionDomain, ...customDomains]);
  return {
    productionDomain, customDomains, siteId, disabled: disabledByEnv(envs), ...fields,
    liveStatus: computeLiveStatus({ archived: false, compatibility: "compatible", latestProduction: fields.latestProduction, health: null, siteId, connector: null, productionDomain }, null),
    events: projectEvents(previous, next),
    queue: buildQueue([fields.latestProduction, fields.latestPreview].filter((item): item is DeploymentSummary => Boolean(item))),
  };
}

if (/deployment\.ts$/.test(process.argv[1] ?? "")) console.log(JSON.stringify(demo(), null, 2));
