import { scoreOf, type CheckResult } from "@/lib/seo/checks";

/*
 * Presentation model for the SEO & GEO Center: plain-language wording, business
 * impact, estimated effort and how each finding can be fixed. Scores themselves
 * always come from the scan (lib/seo/checks.ts); this file never invents values.
 */

export type Impact = "high" | "medium" | "low";
/** auto = ROIstation writes the fix (GitHub PR) · ai = content generated with ROIstation AI · guided = step-by-step guidance */
export type FixKind = "auto" | "ai" | "guided";
export type IssueMeta = { title: string; problem: string; benefit: string; impact: Impact; stars: 1 | 2 | 3 | 4 | 5; minutes: number; fix: FixKind; keywords: string };

export const issueCatalog: Record<string, IssueMeta> = {
  "http-status": { title: "Ana sayfa erişilebilirliği", problem: "Ana sayfa şu anda ziyaretçilere ve arama motorlarına açılmıyor.", benefit: "Erişilemeyen sayfalar arama sonuçlarından düşer; önce bu çözülmeli.", impact: "high", stars: 5, minutes: 15, fix: "guided", keywords: "http erişim sunucu ssl" },
  indexable: { title: "Google'da görünürlük", problem: "Sayfa arama motorlarına kendisini dizine eklememesini söylüyor.", benefit: "Bu ayar kaldırılana kadar site Google'da görünmez.", impact: "high", stars: 5, minutes: 5, fix: "guided", keywords: "noindex dizin index robots meta" },
  "robots-allows": { title: "Arama motoru erişimi", problem: "Tarayıcı yönergeleri siteyi arama motorlarına kapatıyor.", benefit: "Arama motorları sayfaları okuyabildiğinde site sıralamaya girebilir.", impact: "high", stars: 5, minutes: 5, fix: "guided", keywords: "robots disallow tarama" },
  sitemap: { title: "Site haritası", problem: "Site haritası eklenmesi önerilir.", benefit: "Site haritası tüm sayfaların arama motorlarınca hızla bulunmasını sağlar.", impact: "high", stars: 4, minutes: 3, fix: "auto", keywords: "sitemap xml site haritası" },
  "robots-txt": { title: "Tarayıcı yönergeleri", problem: "Tarayıcı yönergeleri (robots.txt) eklenebilir.", benefit: "Arama motorlarına hangi sayfaların taranacağını ve site haritasının yerini bildirir.", impact: "medium", stars: 3, minutes: 2, fix: "auto", keywords: "robots txt" },
  "sitemap-in-robots": { title: "Site haritası bildirimi", problem: "Site haritası tarayıcı yönergelerinde belirtilebilir.", benefit: "Tüm arama motorlarının site haritasını kendiliğinden bulmasını sağlar.", impact: "low", stars: 2, minutes: 1, fix: "auto", keywords: "sitemap robots" },
  "ai-crawlers": { title: "AI asistanlarına erişim", problem: "Bazı AI asistanları siteyi okuyamıyor.", benefit: "ChatGPT, Claude ve Perplexity siteyi okuyabildiğinde işletmenizi cevaplarında kaynak gösterebilir.", impact: "high", stars: 4, minutes: 3, fix: "guided", keywords: "gptbot claudebot perplexity ai robots" },
  crawlability: { title: "Taranabilirlik", problem: "Sayfalar arasındaki bağlantılar güçlendirilebilir.", benefit: "İyi bağlanmış sayfalar daha hızlı keşfedilir ve daha iyi sıralanır.", impact: "medium", stars: 3, minutes: 20, fix: "guided", keywords: "tarama bağlantı crawl" },
  title: { title: "Sayfa başlığı", problem: "Arama sonuçlarındaki başlık iyileştirilebilir.", benefit: "Açık ve markalı bir başlık tıklanma oranını doğrudan artırır.", impact: "high", stars: 4, minutes: 3, fix: "auto", keywords: "title başlık metadata meta" },
  "meta-description": { title: "Arama sonucu açıklaması", problem: "Arama sonuçlarında görünen özet metin eklenebilir.", benefit: "İyi bir açıklama, sonuçlarda sizi rakiplerden öne çıkarır.", impact: "medium", stars: 4, minutes: 3, fix: "auto", keywords: "meta description açıklama metadata" },
  canonical: { title: "Tercih edilen sayfa adresi", problem: "Sayfaların tercih edilen adresi belirtilebilir.", benefit: "Aynı içeriğin farklı adreslerde bölünmesini önler, sıralama gücünü tek adreste toplar.", impact: "medium", stars: 3, minutes: 2, fix: "auto", keywords: "canonical kanonik url metadata" },
  lang: { title: "Dil bilgisi", problem: "Sayfa dilinin belirtilmesi önerilir.", benefit: "Arama motorları ve AI asistanları içeriği doğru dilde sunar.", impact: "low", stars: 2, minutes: 1, fix: "auto", keywords: "lang dil html" },
  h1: { title: "Ana başlık", problem: "Her sayfaya konusunu anlatan tek bir ana başlık eklenmesi önerilir.", benefit: "Ana başlık, sayfanın neyle ilgili olduğunu ilk bakışta anlatır.", impact: "medium", stars: 3, minutes: 10, fix: "guided", keywords: "h1 başlık heading" },
  "heading-hierarchy": { title: "Başlık düzeni", problem: "Başlıkların sırası düzenlenebilir.", benefit: "Düzenli başlıklar içeriğin hem okuyucu hem AI tarafından kolay anlaşılmasını sağlar.", impact: "low", stars: 2, minutes: 10, fix: "guided", keywords: "başlık hiyerarşi h2 h3 heading" },
  "internal-links": { title: "İç bağlantılar", problem: "Sayfalar arasında daha fazla bağlantı önerilir.", benefit: "İç bağlantılar önemli sayfaların gücünü artırır.", impact: "medium", stars: 3, minutes: 15, fix: "guided", keywords: "iç bağlantı link" },
  "broken-links": { title: "Çalışmayan bağlantılar", problem: "Bazı bağlantılar çalışmıyor.", benefit: "Çalışan bağlantılar ziyaretçi kaybını ve tarama israfını önler.", impact: "high", stars: 4, minutes: 10, fix: "guided", keywords: "kırık bağlantı 404 broken link" },
  breadcrumbs: { title: "Sayfa konumu gösterimi", problem: "İç sayfalara konum gösterimi (breadcrumb) eklenebilir.", benefit: "Site yapısını arama sonuçlarında ve AI cevaplarında netleştirir.", impact: "low", stars: 2, minutes: 3, fix: "ai", keywords: "breadcrumb schema" },
  "schema-present": { title: "İşletme yapısal verisi", problem: "İşletmenizi tanıtan yapısal veri eklenebilir.", benefit: "Google ve AI asistanları işletmenizi yapısal veriyle doğru tanır ve öne çıkarır.", impact: "high", stars: 5, minutes: 3, fix: "auto", keywords: "schema json-ld yapısal veri structured" },
  "schema-valid": { title: "Yapısal veri doğruluğu", problem: "Bazı yapısal veri blokları okunamıyor.", benefit: "Okunamayan yapısal veri tamamen yok sayılır.", impact: "high", stars: 4, minutes: 10, fix: "guided", keywords: "schema json-ld geçerlilik structured" },
  "organization-schema": { title: "İşletme kimliği", problem: "İşletme yapısal verisi iyileştirilebilir.", benefit: "Marka adınız, web siteniz ve logonuz arama motorlarında tutarlı görünür.", impact: "high", stars: 4, minutes: 3, fix: "auto", keywords: "organization schema işletme" },
  "localbusiness-schema": { title: "Yerel işletme şeması", problem: "İşletme şeması yerel bilgilerle güçlendirilebilir.", benefit: "Google ve AI asistanları işletmenizi, konumunuzu ve hizmetlerinizi bu bilgiyle anlar.", impact: "high", stars: 5, minutes: 3, fix: "auto", keywords: "localbusiness restaurant schema yerel" },
  "faq-schema": { title: "Sık sorulan sorular", problem: "Sık sorulan sorular eklemek AI görünürlüğünü artırır.", benefit: "AI asistanları soru-cevap içeriğini doğrudan alıntılar.", impact: "medium", stars: 4, minutes: 2, fix: "ai", keywords: "faq sss soru schema" },
  "open-graph": { title: "Paylaşım önizlemesi", problem: "Sosyal medyadaki paylaşım görünümü iyileştirilebilir.", benefit: "Paylaşımlar başlık, açıklama ve görselle profesyonel görünür.", impact: "medium", stars: 3, minutes: 2, fix: "auto", keywords: "open graph og paylaşım sosyal metadata" },
  "twitter-card": { title: "X (Twitter) kartı", problem: "X paylaşımları için kart eklenebilir.", benefit: "Bağlantılar X'te zengin önizlemeyle görünür.", impact: "low", stars: 2, minutes: 1, fix: "auto", keywords: "twitter card x metadata" },
  "image-alt": { title: "Görsel açıklamaları", problem: "Bazı görsellerin açıklama metni eksik.", benefit: "Açıklamalar görselleri arama motorlarına ve ekran okuyuculara anlatır.", impact: "medium", stars: 3, minutes: 10, fix: "guided", keywords: "görsel alt image erişilebilirlik" },
  "performance-score": { title: "Genel performans", problem: "Sayfa hızı iyileştirilebilir.", benefit: "Hızlı sayfalar daha iyi sıralanır ve daha fazla dönüşüm getirir.", impact: "medium", stars: 4, minutes: 60, fix: "guided", keywords: "performans hız pagespeed lighthouse" },
  lcp: { title: "Yüklenme hızı", problem: "Ana içerik geç yükleniyor.", benefit: "Ana içeriğin 2,5 saniye içinde görünmesi Google'ın hız hedefidir.", impact: "high", stars: 4, minutes: 60, fix: "guided", keywords: "lcp hız core web vitals" },
  cls: { title: "Görsel kararlılık", problem: "Sayfa yüklenirken içerik kayıyor.", benefit: "Kararlı sayfalar kullanıcı deneyimini ve sıralamayı iyileştirir.", impact: "medium", stars: 3, minutes: 30, fix: "guided", keywords: "cls kayma core web vitals" },
  interactivity: { title: "Etkileşim hızı", problem: "Sayfa tıklamalara geç yanıt veriyor.", benefit: "Hızlı yanıt veren sayfalar daha akıcı hissettirir.", impact: "medium", stars: 3, minutes: 45, fix: "guided", keywords: "inp tbt etkileşim core web vitals" },
  "mobile-friendly": { title: "Mobil uyum", problem: "Sayfa mobil ekranlar için ayarlanmamış.", benefit: "Google siteleri mobil sürümüne göre sıralar.", impact: "high", stars: 5, minutes: 10, fix: "guided", keywords: "mobil viewport responsive" },
  "ai-readability": { title: "AI okunabilirliği", problem: "Metinler AI asistanları için daha anlaşılır hale getirilebilir.", benefit: "Kısa paragraflar, listeler ve yeterli içerik AI cevaplarında seçilme şansını artırır.", impact: "medium", stars: 4, minutes: 10, fix: "ai", keywords: "ai okunabilirlik içerik geo" },
  "question-headings": { title: "Soru-cevap yapısı", problem: "Soru biçimli başlıklar eklenebilir.", benefit: "Müşterilerin AI asistanlarına sorduğu sorularla eşleşir.", impact: "medium", stars: 3, minutes: 5, fix: "ai", keywords: "soru cevap başlık faq geo" },
  "llms-txt": { title: "AI rehber dosyası", problem: "AI asistanları için site özeti (llms.txt) eklenebilir.", benefit: "AI sistemlerine işletmenizi ve önemli sayfalarınızı tek dosyada tanıtır.", impact: "low", stars: 1, minutes: 1, fix: "auto", keywords: "llms txt ai" },
  "locality-signals": { title: "Yerel anahtar kelimeler", problem: "Hizmet bölgenizin içerikte daha net geçmesi önerilir.", benefit: "Yerel aramalarda ve 'yakınımdaki' sorularında görünürlüğü artırır.", impact: "high", stars: 4, minutes: 5, fix: "ai", keywords: "yerel konum şehir local geo" },
  "nap-schema": { title: "Adres ve telefon bilgisi", problem: "Adres ve telefon yapısal veriye eklenebilir.", benefit: "Yerel aramada güven sinyali verir, harita sonuçlarını destekler.", impact: "medium", stars: 4, minutes: 3, fix: "auto", keywords: "nap adres telefon yerel schema" },
  "gbp-consistency": { title: "Google İşletme Profili uyumu", problem: "Sitedeki iletişim bilgileri Google İşletme Profili ile aynı değil.", benefit: "Tutarlı bilgi, harita ve yerel sonuçlarda güveni artırır.", impact: "high", stars: 4, minutes: 5, fix: "guided", keywords: "google işletme profili gbp nap tutarlılık yerel" },
  "entity-links": { title: "Resmî profil bağlantıları", problem: "Sosyal medya ve harita profilleriniz yapısal veriye eklenebilir.", benefit: "AI asistanları markanızı doğru profillerle eşleştirir.", impact: "low", stars: 2, minutes: 3, fix: "guided", keywords: "sameas sosyal profil entity" },
};
const fallbackMeta = (check: CheckResult): IssueMeta => ({ title: check.label, problem: check.finding, benefit: check.explanation, impact: "low", stars: 1, minutes: 5, fix: "guided", keywords: check.id });
export const metaFor = (check: CheckResult) => issueCatalog[check.id] ?? fallbackMeta(check);

export const impactLabel: Record<Impact, string> = { high: "Yüksek etki", medium: "Orta etki", low: "Düşük etki" };
export const fixKindLabel: Record<FixKind, string> = { auto: "Otomatik düzeltme", ai: "AI ile üretilebilir", guided: "Rehberli düzeltme" };
const impactRank: Record<Impact, number> = { high: 0, medium: 1, low: 2 };

/** Highest business impact first: impact, stars, failing before warning, then quickest fix. */
export function sortByImpact(checks: CheckResult[]) {
  return [...checks].sort((a, b) => { const ma = metaFor(a), mb = metaFor(b); return impactRank[ma.impact] - impactRank[mb.impact] || mb.stars - ma.stars || (a.status === "fail" ? -1 : 0) - (b.status === "fail" ? -1 : 0) || ma.minutes - mb.minutes; });
}

/* ------------------------------------------------------------------ health */

export type HealthTone = "good" | "warning" | "serious" | "critical" | "none";
export type Health = { label: string; tone: HealthTone };
/** Critical is reserved for access problems only (see CRITICAL_CHECKS in the scanner). */
export function healthOf(score: number | null, critical: number): Health {
  if (critical > 0) return { label: "Kritik", tone: "critical" };
  if (score === null) return { label: "Taranmadı", tone: "none" };
  if (score >= 90) return { label: "Mükemmel", tone: "good" };
  if (score >= 80) return { label: "Çok iyi", tone: "good" };
  if (score >= 70) return { label: "Optimizasyon önerilir", tone: "warning" };
  if (score >= 50) return { label: "İyileştirme gerekli", tone: "serious" };
  return { label: "Dikkat gerekli", tone: "serious" };
}
export const overallScore = (seo: number | null, geo: number | null) => (seo === null && geo === null ? null : seo === null ? geo : geo === null ? seo : Math.round((seo + geo) / 2));
export const scoreTone = (score: number | null): HealthTone => (score === null ? "none" : score >= 80 ? "good" : score >= 70 ? "warning" : score >= 50 ? "serious" : "critical");

/* -------------------------------------------------------------- categories */

export type CategoryDef = { key: string; label: string; description: string; checks: string[] };
export const categoryDefs: CategoryDef[] = [
  { key: "metadata", label: "Metadata", description: "Başlık, açıklama, tercih edilen adres ve paylaşım önizlemeleri.", checks: ["title", "meta-description", "canonical", "open-graph", "twitter-card"] },
  { key: "technical", label: "Teknik", description: "Erişilebilirlik, dizine eklenme, tarayıcı yönergeleri, site haritası ve bağlantı sağlığı.", checks: ["http-status", "indexable", "robots-txt", "robots-allows", "sitemap", "sitemap-in-robots", "crawlability", "broken-links"] },
  { key: "content", label: "İçerik", description: "Başlık yapısı, iç bağlantılar ve sayfa konumu gösterimi.", checks: ["h1", "heading-hierarchy", "internal-links", "breadcrumbs"] },
  { key: "local", label: "Yerel SEO", description: "Yerel işletme şeması, hizmet bölgesi, adres/telefon ve Google İşletme Profili uyumu.", checks: ["localbusiness-schema", "locality-signals", "nap-schema", "gbp-consistency"] },
  { key: "performance", label: "Performans", description: "Google PageSpeed Insights mobil puanı ve Core Web Vitals.", checks: ["performance-score", "lcp", "cls", "interactivity"] },
  { key: "accessibility", label: "Erişilebilirlik", description: "Görsel açıklamaları, dil bilgisi, başlık düzeni ve mobil uyum.", checks: ["image-alt", "lang", "heading-hierarchy", "mobile-friendly"] },
  { key: "structured", label: "Yapısal veri", description: "Schema.org işletme, SSS ve konum verileri ile doğrulukları.", checks: ["schema-present", "schema-valid", "organization-schema", "localbusiness-schema", "faq-schema", "breadcrumbs"] },
  { key: "ai", label: "AI hazırlığı", description: "AI asistanlarının siteyi okuyup kaynak gösterebilmesi: erişim, okunabilirlik, soru-cevap, llms.txt.", checks: ["ai-crawlers", "ai-readability", "question-headings", "faq-schema", "llms-txt", "entity-links"] },
];
/** Category score from the scan's own checks; performance uses the PageSpeed score. Null = not measured yet. */
export function categoryScore(def: CategoryDef, checks: CheckResult[], performance: number | null) {
  if (def.key === "performance") return performance;
  return scoreOf(checks, (check) => def.checks.includes(check.id));
}

/* ------------------------------------------------------------- projection */

export const isOpen = (check: CheckResult) => check.status === "fail" || check.status === "warn";
/**
 * Projected scores if every automatically fixable / AI-generatable finding is resolved.
 * Computed with the same scoring as the scan; ignored findings are excluded.
 */
export function projection(checks: CheckResult[], ignored: string[] = []) {
  const fixable = checks.filter((check) => isOpen(check) && !ignored.includes(check.id) && metaFor(check).fix !== "guided");
  const after = checks.map((check) => (fixable.includes(check) ? { ...check, status: "pass" as const } : check));
  const seoNow = scoreOf(checks, (c) => c.dimension !== "geo"), geoNow = scoreOf(checks, (c) => c.dimension !== "seo");
  const seoAfter = scoreOf(after, (c) => c.dimension !== "geo"), geoAfter = scoreOf(after, (c) => c.dimension !== "seo");
  const lost = checks.filter((check) => isOpen(check) && !ignored.includes(check.id)).reduce((sum, check) => sum + check.weight * (check.status === "fail" ? 1 : 0.5), 0);
  const recovered = fixable.reduce((sum, check) => sum + check.weight * (check.status === "fail" ? 1 : 0.5), 0);
  const ratio = lost ? recovered / lost : 1;
  return {
    fixable, seo: { now: seoNow, after: seoAfter }, geo: { now: geoNow, after: geoAfter },
    minutes: fixable.reduce((sum, check) => sum + metaFor(check).minutes, 0),
    confidence: ratio >= 0.7 ? "Çok yüksek" : ratio >= 0.4 ? "Yüksek" : ratio > 0 ? "Orta" : "—",
  };
}

/** Plain-language analysis written from the scan data (deterministic; no invented facts). */
export function analysisText(checks: CheckResult[], performance: number | null, critical: number) {
  const scored = categoryDefs.map((def) => ({ def, score: categoryScore(def, checks, performance) })).filter((item) => item.score !== null) as { def: CategoryDef; score: number }[];
  const technical = scored.find((item) => item.def.key === "technical")?.score ?? null;
  const weakest = [...scored].sort((a, b) => a.score - b.score)[0];
  const strongest = [...scored].sort((a, b) => b.score - a.score)[0];
  const open = checks.filter(isOpen);
  const lines: string[] = [];
  if (critical) lines.push("Sitenin erişim veya dizine eklenme sorunu var; bu çözülene kadar diğer iyileştirmelerin etkisi sınırlı kalır.");
  else if (technical !== null && technical >= 90) lines.push("Siteniz teknik olarak güçlü.");
  else if (technical !== null) lines.push("Teknik altyapıda birkaç iyileştirme alanı var.");
  if (weakest && strongest && weakest.def.key !== strongest.def.key && weakest.score < 80) lines.push(`Eksiklerin çoğu ${weakest.def.label} alanında; en güçlü alan ${strongest.def.label}.`);
  const auto = open.filter((check) => metaFor(check).fix !== "guided").length;
  if (open.length) lines.push(`${open.length} iyileştirmenin ${auto} tanesi otomatik düzeltme veya AI ile üretilecek içerikle, onayınızla uygulanabilir.`);
  else lines.push("Ölçülen tüm kontroller başarılı.");
  return lines;
}

/** Plain-language reason for a Critical status (never the check's pass label). */
export const criticalText: Record<string, string> = {
  "http-status": "Ana sayfaya erişilemiyor", indexable: "Site Google'a kapalı (noindex)", "robots-allows": "Tarayıcı yönergeleri siteyi engelliyor", sitemap: "Site haritası bulunamadı",
};

/** Pages a finding applies to: URLs from the evidence, otherwise the whole site. */
export function affectedPages(check: CheckResult) {
  const urls = (check.evidence || []).map((item) => item.match(/^(https?:\/\/[^\s]+|\/[^\s:→]*)/)?.[1]).filter((value): value is string => Boolean(value));
  const unique = [...new Set(urls.map((url) => { try { return new URL(url, "https://x").pathname; } catch { return url; } }))];
  return unique.length ? unique : null;
}
