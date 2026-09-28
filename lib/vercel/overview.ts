import { getVercelCredentials, storedAccountLabel } from "@/lib/vercel/credentials";
import { listProjectRecords, type DeploymentSummary } from "@/lib/vercel/projects";
import { getSyncState } from "@/lib/vercel/sync";
import { getVercelSettings } from "@/lib/vercel/settings";
import { recentEvents } from "@/lib/vercel/events";

const activeStates = new Set(["BUILDING", "QUEUED", "INITIALIZING"]);

/** Everything the Vercel Overview screen needs, read from stored records (no Vercel API call). */
export async function vercelOverview() {
  const credentials = await getVercelCredentials();
  const [records, syncState, settings, events, account] = await Promise.all([
    listProjectRecords(), getSyncState(), getVercelSettings(), recentEvents(40).catch(() => []), credentials?.source === "panel" ? storedAccountLabel() : Promise.resolve(null),
  ]);
  const live = records.filter((record) => !record.archived);
  const deployments = records.flatMap((record) => [record.latestProduction, record.latestPreview].filter((item): item is DeploymentSummary => Boolean(item)).map((deployment) => ({ ...deployment, projectId: record.projectId, projectName: record.name })))
    .sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
  return {
    configured: Boolean(credentials),
    source: credentials?.source ?? null,
    account: syncState?.account ?? account ?? (credentials?.source === "env" ? "VERCEL_TOKEN ortam değişkeni" : null),
    team: syncState?.team ?? null,
    teamId: credentials?.teamId ?? null,
    projectCount: syncState?.projectCount ?? records.filter((record) => !record.archived).length,
    lastSyncAt: syncState?.lastFullSyncAt ?? syncState?.lastSyncAt ?? null,
    lastDeploymentCheckAt: syncState?.lastDeploymentCheckAt ?? syncState?.lastSyncAt ?? null,
    syncState,
    settings,
    counts: {
      total: live.length,
      connected: live.filter((record) => record.liveStatus === "connected").length,
      compatible: live.filter((record) => !record.siteId && !record.excluded && record.compatibility !== "not-compatible").length,
      failed: live.filter((record) => record.liveStatus === "deployment-failed").length,
      awaiting: live.filter((record) => (record.siteId && ["verification-failed", "connector-missing", "updating"].includes(record.liveStatus)) || (record.pending && !record.siteId)).length,
      archived: records.length - live.length,
    },
    projects: records.sort((a, b) => Number(a.archived) - Number(b.archived) || Number(Boolean(b.siteId)) - Number(Boolean(a.siteId)) || a.name.localeCompare(b.name)),
    latestDeployments: deployments.slice(0, 12),
    queue: deployments.filter((deployment) => activeStates.has(deployment.state)),
    pending: live.filter((record) => record.pending && !record.siteId && !record.ignored).map((record) => ({ projectId: record.projectId, name: record.name, domain: record.productionDomain, connector: Boolean(record.connector?.connected) })),
    events,
  };
}
