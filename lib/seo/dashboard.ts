import { sites } from "@/lib/sites";
import { ensureSiteRegistry } from "@/lib/site-registry";
import { listProjectRecords } from "@/lib/vercel/projects";
import { getGithubCredentials } from "@/lib/github/credentials";
import { ignoredChecks, readScan, saveScan, scanIndex, summarizeScan, type ScanSummary } from "@/lib/seo/store";
import { CRITICAL_CHECKS } from "@/lib/seo/scanner";
import { checkDefinitions } from "@/lib/seo/checks";
import { criticalText, metaFor } from "@/lib/seo/presentation";
import { refreshOptimizations } from "@/lib/seo/optimize";
import { scanSite } from "@/lib/seo/scanner";
import { eventKeyForSite, logEvents } from "@/lib/vercel/events";
import { mapLimit } from "@/lib/blob-store";

/** Scans one site, stores the result in history and logs it. */
export async function runScan(siteId: string, reason: string) {
  const scan = await scanSite(siteId, reason);
  await saveScan(scan);
  const site = sites.find((item) => item.id === siteId);
  await logEvents([{ key: eventKeyForSite(siteId, site?.vercelProjectId), siteId, projectId: site?.vercelProjectId, type: "seo-scan-completed", message: `${scan.siteName}: SEO ${scan.scores.seo ?? "—"} · GEO ${scan.scores.geo ?? "—"} · ${scan.issues} sorun (${reason}).` }]);
  return scan;
}

const average = (values: (number | null | undefined)[]) => { const list = values.filter((value): value is number => typeof value === "number"); return list.length ? Math.round(list.reduce((a, b) => a + b, 0) / list.length) : null; };

/** Everything the SEO & GEO Center shows — only stored scan results, never sample data. */
export async function seoDashboard() {
  await ensureSiteRegistry();
  const [index, projects, optimizations, github] = await Promise.all([scanIndex(), listProjectRecords().catch(() => []), refreshOptimizations(), getGithubCredentials().catch(() => null)]);
  const rows = await mapLimit(sites, 6, async (site) => {
    const paths = index.get(site.id) || [];
    const [latestScan, previousScan, ignored] = await Promise.all([paths[0] ? readScan(paths[0]) : null, paths[1] ? readScan(paths[1]) : null, ignoredChecks(site.id)]);
    const open = latestScan?.checks.filter((check) => (check.status === "fail" || check.status === "warn") && !ignored.includes(check.id)) ?? [];
    const critical = latestScan?.checks.filter((check) => check.status === "fail" && CRITICAL_CHECKS.includes(check.id)).map((check) => criticalText[check.id] || checkDefinitions[check.id]?.label || check.id) ?? [];
    const project = projects.find((record) => record.siteId === site.id) || projects.find((record) => record.name === site.project) || null;
    const latest: ScanSummary | null = latestScan ? summarizeScan(latestScan) : null;
    const liveDeployment = project && !project.archived && project.latestProduction?.state === "READY" ? project.latestProduction.id : null;
    const optimization = optimizations.find((entry) => entry.siteId === site.id)?.record ?? null;
    return {
      siteId: site.id, name: site.name, domain: site.domain, color: site.color, initials: site.initials,
      origin: latestScan ? new URL(latestScan.url).origin : `https://${site.domain}`,
      improvements: open.length, autoFixable: open.filter((check) => metaFor(check).fix !== "guided").length, ignored: ignored.length, criticalReasons: critical,
      latest, previous: previousScan ? summarizeScan(previousScan) : null, scans: paths.length,
      deployment: project?.latestProduction ? { id: project.latestProduction.id, state: project.latestProduction.state, createdAt: project.latestProduction.createdAt } : null,
      rescanNeeded: Boolean(latest && liveDeployment && latest.deploymentId !== liveDeployment),
      repository: project?.repository?.repo ? { provider: project.repository.provider, repo: project.repository.repo, branch: project.repository.branch } : null,
      optimization: optimization ? { status: optimization.status, prUrl: optimization.prUrl, prNumber: optimization.prNumber, createdAt: optimization.createdAt, mergedAt: optimization.mergedAt ?? null, applied: optimization.applied.length, manual: optimization.manual.length } : null,
    };
  });
  const scanned = rows.filter((row) => row.latest);
  return {
    sites: rows,
    totals: scanned.length ? {
      scanned: scanned.length,
      seo: average(scanned.map((row) => row.latest!.scores.seo)), geo: average(scanned.map((row) => row.latest!.scores.geo)),
      schema: average(scanned.map((row) => row.latest!.scores.schema)), metadata: average(scanned.map((row) => row.latest!.scores.metadata)),
      performance: average(scanned.map((row) => row.latest!.scores.performance)),
      issues: scanned.reduce((sum, row) => sum + row.improvements, 0),
      autoFixable: scanned.reduce((sum, row) => sum + row.autoFixable, 0),
      lastScanAt: scanned.map((row) => row.latest!.scannedAt).sort().at(-1) ?? null,
    } : null,
    github: { configured: Boolean(github), source: github?.source ?? null, login: github?.login ?? null },
    pageSpeedKey: Boolean(process.env.PAGESPEED_API_KEY),
  };
}
