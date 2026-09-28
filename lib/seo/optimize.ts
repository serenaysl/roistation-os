import { ApiError } from "@/lib/errors";
import { revalidationConfigured } from "@/lib/publishing/revalidate";
import { sites } from "@/lib/sites";
import { ensureSiteRegistry } from "@/lib/site-registry";
import { businessProfile } from "@/lib/publishing/business";
import { projectForSite } from "@/lib/vercel/projects";
import { getVercelCredentials } from "@/lib/vercel/credentials";
import { upsertEnv } from "@/lib/vercel/api";
import { getGithubCredentials } from "@/lib/github/credentials";
import { getBranchHead, getCommitTree, getPull, getRepo, GithubError, listTree, openPullRequest, readFile } from "@/lib/github/api";
import { planFixes } from "@/lib/seo/fixes";
import { ignoredChecks, latestOptimizations, saveOptimization, scanHistory, updateOptimization, type OptimizationRecord } from "@/lib/seo/store";
import { checkDefinitions } from "@/lib/seo/checks";
import { masterOrigin } from "@/lib/verification";
import { eventKeyForSite, logEvents } from "@/lib/vercel/events";

/*
 * Optimize = latest live scan → planned repository changes → one commit on a new
 * branch → pull request. Vercel builds a preview for the PR; merging deploys to
 * production, the Vercel sync sees the new deployment and the SEO Center re-scans.
 */

/** checkIds: limit the pull request to these findings (per-issue Auto Fix). Omitted = every open finding. */
export async function optimizeSite(siteId: string, options: { checkIds?: string[] } = {}) {
  await ensureSiteRegistry();
  const site = sites.find((item) => item.id === siteId);
  if (!site) throw new ApiError("Kapsam dışı veya bilinmeyen site.");
  const [latest] = await scanHistory(siteId, 1);
  if (!latest) throw new ApiError("Önce bu site için analiz çalıştırın.", 409);
  const ignored = await ignoredChecks(siteId);
  // Only the selected (or all non-ignored) findings are planned; everything else is treated as resolved.
  const scan = { ...latest, checks: latest.checks.map((check) => (options.checkIds ? options.checkIds.includes(check.id) : !ignored.includes(check.id)) ? check : { ...check, status: "pass" as const }) };
  const project = await projectForSite(siteId, site.project);
  if (!project || project.archived) throw new ApiError("Site bir Vercel projesine bağlı değil; kod değişikliği için Vercel hesabını bağlayın.", 409);
  if (project.repository?.provider !== "github" || !project.repository.repo) throw new ApiError(`Vercel projesi (${project.name}) bir GitHub reposuna bağlı değil${project.repository?.provider ? ` (${project.repository.provider})` : ""}.`, 409);
  const github = await getGithubCredentials();
  if (!github) throw new ApiError("GitHub bağlı değil. Ayarlar → GitHub bölümünden erişim anahtarı ekleyin.", 409);

  const open = (await refreshOptimizations()).find((entry) => entry.siteId === siteId && entry.record.status === "open");
  if (open) throw new ApiError(`Bu site için açık bir optimizasyon PR'ı var: ${open.record.prUrl}. Önce birleştirin veya kapatın.`, 409);

  const repoName = project.repository.repo;
  try {
    const repo = await getRepo(github, repoName);
    if (repo.permissions && repo.permissions.push === false) throw new ApiError(`GitHub anahtarının ${repoName} reposuna yazma yetkisi yok.`, 403);
    const base = project.repository.branch || repo.default_branch;
    const baseSha = await getBranchHead(github, repoName, base);
    const tree = await listTree(github, repoName, await getCommitTree(github, repoName, baseSha));
    const cache = new Map<string, string | null>();
    const plan = await planFixes({
      scan, profile: businessProfile(siteId)!, origin: new URL(scan.url).origin,
      repo: { has: (file) => tree.paths.has(file), read: async (file) => { if (!tree.paths.has(file)) return null; if (!cache.has(file)) cache.set(file, await readFile(github, repoName, file, base)); return cache.get(file)!; } },
    });
    const now = new Date();
    const applied = plan.files.map((file) => ({ checkId: file.checkIds[0] || "", path: file.path, action: file.action, description: file.description }));
    if (!plan.files.length) {
      const record: OptimizationRecord = { siteId, createdAt: now.toISOString(), scanId: scan.id, status: "closed", repo: repoName, baseBranch: base, branch: "", prNumber: null, prUrl: null, applied: [], manual: plan.manual, env: [], updatedAt: now.toISOString() };
      await saveOptimization(record);
      return { record, message: plan.manual.length ? "Otomatik uygulanabilir düzeltme yok; yapılması gerekenler rapora eklendi." : "Düzeltilecek sorun bulunmadı." };
    }

    // Connector kit needs the site's ROIstation environment variables (set on the Vercel project).
    const env: OptimizationRecord["env"] = [];
    if (plan.installKit) {
      const vercel = await getVercelCredentials();
      const vars = [{ key: "ROISTATION_SITE_ID", value: siteId, type: "plain" as const }, { key: "ROISTATION_MASTER_URL", value: masterOrigin(), type: "plain" as const }, { key: "ROISTATION_SITE_NAME", value: site.name, type: "plain" as const },
        ...(revalidationConfigured() ? [{ key: "ROISTATION_REVALIDATE_SECRET", value: process.env.ROISTATION_REVALIDATE_SECRET!, type: "sensitive" as const }] : [])];
      if (!vercel) vars.forEach((item) => env.push({ key: item.key, ok: false, detail: "Vercel bağlı değil" }));
      else {
        try { await upsertEnv(vercel, project.projectId, vars.map((item) => ({ ...item, target: ["production", "preview"] }))); vars.forEach((item) => env.push({ key: item.key, ok: true })); }
        catch (error) { vars.forEach((item) => env.push({ key: item.key, ok: false, detail: error instanceof Error ? error.message : "yazılamadı" })); }
      }
    }

    const branch = `roistation/seo-${now.toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;
    const score = (value: number | null) => (value === null ? "—" : String(value));
    const body = [
      `ROIstation SEO & GEO optimizasyonu — **${site.name}**`, "",
      `Canlı tarama: ${scan.scannedAt} · SEO ${score(scan.scores.seo)} · GEO ${score(scan.scores.geo)} · Şema ${score(scan.scores.schema)} · Metadata ${score(scan.scores.metadata)} · Performans ${score(scan.scores.performance)}`, "",
      "### Bu PR'daki değişiklikler", ...plan.files.map((file) => `- \`${file.path}\` (${file.action === "create" ? "yeni" : "güncellendi"}): ${file.description} — ${file.checkIds.map((id) => checkDefinitions[id]?.label || id).join(", ")}`), "",
      ...(env.length ? ["### Vercel ortam değişkenleri", ...env.map((item) => `- ${item.key}: ${item.ok ? "ayarlandı" : `AYARLANAMADI (${item.detail})`}`), ""] : []),
      ...(plan.manual.length ? ["### Elle yapılması gerekenler (otomatik değiştirilmedi)", ...plan.manual.map((item) => `- **${checkDefinitions[item.checkId]?.label || item.checkId}**: ${item.description.replace(/\n/g, "\n  ")}`), ""] : []),
      "Birleştirildiğinde Vercel production deploy eder; ROIstation yeni deployu algılayıp siteyi otomatik yeniden tarar.",
    ].join("\n");
    const pr = await openPullRequest(github, { repo: repoName, base, branch, baseSha, files: plan.files.map((file) => ({ path: file.path, content: file.content })), message: `ROIstation SEO/GEO: ${plan.files.length} dosya`, title: `SEO & GEO optimizasyonu (${plan.files.length} düzeltme)`, body });
    const record: OptimizationRecord = { siteId, createdAt: now.toISOString(), scanId: scan.id, status: "open", repo: repoName, baseBranch: base, branch, prNumber: pr.number, prUrl: pr.url, applied, manual: plan.manual, env, updatedAt: now.toISOString() };
    await saveOptimization(record);
    await logEvents([{ key: eventKeyForSite(siteId, project.projectId), siteId, projectId: project.projectId, type: "seo-optimization-opened", message: `SEO/GEO optimizasyon PR'ı açıldı: ${pr.url}` }]);
    return { record, message: `PR #${pr.number} açıldı: ${plan.files.length} dosya. Vercel önizlemesini kontrol edip birleştirin; production deploy sonrası site otomatik yeniden taranır.` };
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof GithubError) throw new ApiError(error.message, error.status >= 500 ? 502 : error.status === 404 ? 404 : 409);
    throw error;
  }
}

/** Updates PR states (open → merged / closed). Never throws. */
export async function refreshOptimizations() {
  const entries = await latestOptimizations().catch(() => []);
  const github = entries.some((entry) => entry.record.status === "open" && entry.record.prNumber) ? await getGithubCredentials() : null;
  for (const entry of entries) {
    if (entry.record.status !== "open" || !entry.record.prNumber || !github) continue;
    try {
      const pull = await getPull(github, entry.record.repo, entry.record.prNumber);
      const status = pull.merged ? "merged" : pull.state === "closed" ? "closed" : "open";
      if (status !== entry.record.status) {
        const next = { ...entry.record, status, mergedAt: pull.merged_at, updatedAt: new Date().toISOString() } as OptimizationRecord;
        if (await updateOptimization(entry.pathname, entry.etag, next) === "replaced") entry.record = next;
      }
    } catch { /* keep last known state */ }
  }
  return entries;
}
