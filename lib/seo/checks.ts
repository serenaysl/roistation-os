/*
 * SEO & GEO check catalogue. Every score shown in the panel is computed from these
 * checks, which are evaluated against the live site (HTML, robots.txt, sitemap.xml,
 * llms.txt, internal links) and Google PageSpeed Insights. Nothing is estimated.
 *
 * Scoring: pass = 1, warn = 0.5, fail = 0, skip = excluded (could not be measured or
 * not applicable). Score = Σ(weight × value) / Σ(weight) over the measured checks.
 */

export type CheckStatus = "pass" | "warn" | "fail" | "skip";
export type Category = "technical" | "metadata" | "structure" | "links" | "schema" | "social" | "media" | "performance" | "ai" | "local";
export type Dimension = "seo" | "geo" | "both";
export type Priority = "high" | "medium" | "low";

export type CheckDefinition = { id: string; label: string; category: Category; dimension: Dimension; weight: number; explanation: string; fix: string };
export type CheckResult = { id: string; label: string; category: Category; dimension: Dimension; weight: number; status: CheckStatus; priority: Priority; finding: string; explanation: string; fix: string; evidence?: string[] };

const defs: CheckDefinition[] = [
  { id: "http-status", label: "Ana sayfa erişilebilir", category: "technical", dimension: "both", weight: 10, explanation: "Arama motorları ve AI tarayıcıları yalnız 200 yanıtı veren sayfaları dizine ekler.", fix: "Sunucu/deploy hatasını giderin; ana sayfanın 200 döndürdüğünden emin olun." },
  { id: "indexable", label: "Dizine eklenebilir (noindex yok)", category: "technical", dimension: "both", weight: 10, explanation: "meta robots veya X-Robots-Tag içindeki noindex, sayfanın arama sonuçlarından tamamen çıkmasına neden olur.", fix: "Canlı ortamda noindex etiketini ve X-Robots-Tag başlığını kaldırın." },
  { id: "robots-txt", label: "robots.txt", category: "technical", dimension: "seo", weight: 4, explanation: "robots.txt tarayıcılara hangi yolların taranabileceğini ve sitemap adresini bildirir.", fix: "Kök dizinde robots.txt yayınlayın (Next.js: app/robots.ts) ve Sitemap satırı ekleyin." },
  { id: "robots-allows", label: "robots.txt siteyi engellemiyor", category: "technical", dimension: "seo", weight: 8, explanation: "Googlebot veya tüm botlar için Disallow: / sitenin taranmasını engeller.", fix: "Genel Disallow kuralını kaldırın; yalnız gizli yolları engelleyin." },
  { id: "ai-crawlers", label: "AI tarayıcılarına açık", category: "technical", dimension: "geo", weight: 6, explanation: "GPTBot, ClaudeBot, PerplexityBot ve Google-Extended engellenirse site AI cevaplarında kaynak olarak kullanılamaz.", fix: "robots.txt içinde bu botlar için Disallow: / kuralını kaldırın (bilinçli tercih değilse)." },
  { id: "sitemap", label: "sitemap.xml", category: "technical", dimension: "seo", weight: 6, explanation: "Sitemap, tüm önemli sayfaların hızlı keşfedilmesini sağlar.", fix: "sitemap.xml yayınlayın (Next.js: app/sitemap.ts) ve tüm kanonik URL'leri listeleyin." },
  { id: "sitemap-in-robots", label: "Sitemap robots.txt'de bildirilmiş", category: "technical", dimension: "seo", weight: 2, explanation: "robots.txt içindeki Sitemap satırı tüm arama motorlarının sitemap'i bulmasını sağlar.", fix: "robots.txt dosyasına 'Sitemap: https://alanadiniz/sitemap.xml' ekleyin." },
  { id: "crawlability", label: "Taranabilirlik", category: "technical", dimension: "seo", weight: 5, explanation: "Sayfalar birbirine HTML bağlantılarıyla bağlı değilse tarayıcılar içeriği bulamaz.", fix: "Ana sayfadan önemli sayfalara normal <a href> bağlantıları verin; JavaScript'e bağımlı gezinmeden kaçının." },
  { id: "title", label: "Meta başlık", category: "metadata", dimension: "seo", weight: 8, explanation: "Başlık, arama sonucunda görünen ana metindir; 10–65 karakter arası olmalıdır.", fix: "Her sayfaya benzersiz, marka ve ana hizmeti içeren 30–60 karakterlik bir <title> ekleyin." },
  { id: "meta-description", label: "Meta açıklama", category: "metadata", dimension: "seo", weight: 6, explanation: "Açıklama, arama sonucundaki özet metindir ve tıklama oranını etkiler (50–160 karakter).", fix: "Sayfayı özetleyen, 120–155 karakterlik benzersiz bir meta description ekleyin." },
  { id: "canonical", label: "Canonical etiketi", category: "metadata", dimension: "seo", weight: 6, explanation: "Canonical, kopya URL'lerin (www, parametreler) tek bir adreste birleşmesini sağlar.", fix: "Her sayfaya kendi mutlak adresini gösteren tek bir <link rel=\"canonical\"> ekleyin." },
  { id: "lang", label: "Dil bildirimi", category: "metadata", dimension: "both", weight: 2, explanation: "<html lang> içeriğin dilini arama motorlarına ve AI modellerine bildirir.", fix: "<html lang=\"tr\"> ekleyin." },
  { id: "h1", label: "H1 başlığı", category: "structure", dimension: "seo", weight: 6, explanation: "Her sayfada sayfanın konusunu anlatan tek bir H1 olmalıdır.", fix: "Sayfaya tek bir, ana konuyu anlatan <h1> ekleyin; diğer başlıkları H2/H3 yapın." },
  { id: "heading-hierarchy", label: "Başlık hiyerarşisi", category: "structure", dimension: "both", weight: 3, explanation: "Atlanan başlık seviyeleri (H2'den H4'e) içerik yapısının makinece anlaşılmasını zorlaştırır.", fix: "Başlıkları sırayla kullanın: H1 → H2 → H3." },
  { id: "internal-links", label: "İç bağlantılar", category: "links", dimension: "seo", weight: 4, explanation: "İç bağlantılar sayfa otoritesini dağıtır ve keşfi kolaylaştırır.", fix: "Ana sayfadan hizmet, iletişim ve içerik sayfalarına açıklayıcı bağlantı metinleriyle bağlantı verin." },
  { id: "broken-links", label: "Kırık iç bağlantılar", category: "links", dimension: "seo", weight: 6, explanation: "404 veren bağlantılar tarama bütçesini harcar ve kullanıcı deneyimini bozar.", fix: "Listelenen bağlantıları düzeltin veya 301 yönlendirme ekleyin." },
  { id: "breadcrumbs", label: "Breadcrumb", category: "links", dimension: "seo", weight: 3, explanation: "Breadcrumb ve BreadcrumbList şeması site hiyerarşisini arama sonuçlarında gösterir.", fix: "İç sayfalara breadcrumb navigasyonu ve BreadcrumbList JSON-LD ekleyin." },
  { id: "schema-present", label: "Schema.org yapısal veri", category: "schema", dimension: "both", weight: 6, explanation: "Yapısal veri, işletmeyi ve içeriği arama motorlarına ve AI sistemlerine makine okunur biçimde tanıtır.", fix: "JSON-LD ile Organization/LocalBusiness ve sayfa türüne uygun şema ekleyin." },
  { id: "schema-valid", label: "Yapısal veri geçerliliği", category: "schema", dimension: "both", weight: 5, explanation: "Hatalı JSON-LD tamamen yok sayılır.", fix: "JSON-LD bloklarını geçerli JSON yapın; @context ve @type alanlarını ekleyin." },
  { id: "organization-schema", label: "Organization şeması", category: "schema", dimension: "both", weight: 4, explanation: "Organization/LocalBusiness düğümü marka varlığını (entity) tanımlar.", fix: "name, url, logo ve sameAs alanlarıyla Organization veya LocalBusiness JSON-LD ekleyin." },
  { id: "localbusiness-schema", label: "LocalBusiness şeması", category: "local", dimension: "geo", weight: 6, explanation: "Yerel işletmeler için adres, telefon ve çalışma saatleri içeren LocalBusiness (ör. Restaurant) yerel aramada ve AI cevaplarında belirleyicidir.", fix: "Uygun alt türle (Restaurant, MedicalBusiness…) LocalBusiness JSON-LD ekleyin; adres ve telefonu Google İşletme Profili ile birebir yazın." },
  { id: "faq-schema", label: "FAQ şeması", category: "schema", dimension: "geo", weight: 4, explanation: "Soru-cevap içeriği ve FAQPage şeması AI asistanlarının doğrudan alıntılayabileceği yapıdır.", fix: "Sık sorulan soruları içeren bir bölüm ve FAQPage JSON-LD ekleyin (ROIstation SEO+GEO stratejisi bunu otomatik üretir)." },
  { id: "open-graph", label: "Open Graph", category: "social", dimension: "seo", weight: 4, explanation: "og:title, og:description, og:image ve og:url paylaşım önizlemelerini belirler.", fix: "Eksik og: etiketlerini ekleyin; og:image için en az 1200×630 görsel kullanın." },
  { id: "twitter-card", label: "Twitter Card", category: "social", dimension: "seo", weight: 2, explanation: "twitter:card etiketi X/Twitter paylaşım görünümünü belirler.", fix: "<meta name=\"twitter:card\" content=\"summary_large_image\"> ekleyin." },
  { id: "image-alt", label: "Görsel alt metinleri", category: "media", dimension: "seo", weight: 4, explanation: "Alt metin, görselleri arama motorlarına ve ekran okuyuculara anlatır.", fix: "Listelenen görsellere içeriği anlatan alt metin ekleyin; dekoratif görsellerde alt=\"\" kullanın." },
  { id: "performance-score", label: "Performans puanı (Lighthouse)", category: "performance", dimension: "seo", weight: 6, explanation: "Google PageSpeed Insights mobil performans puanı.", fix: "Görselleri optimize edin (next/image, WebP/AVIF), kullanılmayan JavaScript'i azaltın, fontları önceden yükleyin." },
  { id: "lcp", label: "Largest Contentful Paint", category: "performance", dimension: "seo", weight: 5, explanation: "Ana içeriğin yüklenme süresi; iyi değer ≤ 2,5 sn.", fix: "LCP görselini priority/preload ile yükleyin, sunucu yanıt süresini kısaltın, render engelleyen kaynakları azaltın." },
  { id: "cls", label: "Cumulative Layout Shift", category: "performance", dimension: "seo", weight: 3, explanation: "Sayfa yüklenirken kayma; iyi değer ≤ 0,1.", fix: "Görsel ve reklam alanlarına sabit boyut verin; font yüklemede size-adjust kullanın." },
  { id: "interactivity", label: "Etkileşim (INP / TBT)", category: "performance", dimension: "seo", weight: 3, explanation: "Gerçek kullanıcı INP (≤ 200 ms) veya laboratuvar Total Blocking Time (≤ 200 ms).", fix: "Uzun JavaScript görevlerini bölün, üçüncü taraf betikleri erteleyin." },
  { id: "mobile-friendly", label: "Mobil uyumluluk", category: "performance", dimension: "seo", weight: 5, explanation: "width=device-width viewport ve mobil uyumlu düzen mobil öncelikli dizinleme için gereklidir.", fix: "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"> ekleyin." },
  { id: "ai-readability", label: "AI okunabilirliği", category: "ai", dimension: "geo", weight: 6, explanation: "Yeterli metin, kısa cümleler, listeler ve net paragraflar AI modellerinin içeriği doğru özetlemesini sağlar.", fix: "Ana sayfaya en az 300 kelimelik açıklayıcı metin ekleyin; cümleleri kısa tutun, listeler ve alt başlıklar kullanın." },
  { id: "question-headings", label: "Soru-cevap yapısı", category: "ai", dimension: "geo", weight: 3, explanation: "Soru biçimli başlıklar, kullanıcıların AI asistanlarına sorduğu sorularla eşleşir.", fix: "Müşterilerin sık sorduğu soruları başlık yapın ve altında kısa, net cevap verin." },
  { id: "llms-txt", label: "llms.txt", category: "ai", dimension: "geo", weight: 2, explanation: "llms.txt, AI sistemlerine sitenin özetini ve önemli sayfalarını sunan yeni bir standarttır.", fix: "Kök dizine işletme özeti ve önemli bağlantıları içeren /llms.txt ekleyin." },
  { id: "locality-signals", label: "Yerel sinyaller", category: "local", dimension: "geo", weight: 5, explanation: "Hizmet verilen şehir/ilçenin başlık, H1 ve metinde geçmesi yerel ve AI aramalarında eşleşmeyi güçlendirir.", fix: "Başlık, H1 ve ana metinde hizmet bölgesini (ör. ilçe, il) doğal biçimde belirtin." },
  { id: "nap-schema", label: "Adres ve telefon (NAP)", category: "local", dimension: "geo", weight: 4, explanation: "LocalBusiness şemasında adres ve telefon, yerel aramada güven sinyalidir.", fix: "LocalBusiness şemasına address (PostalAddress) ve telephone ekleyin." },
  { id: "gbp-consistency", label: "Google İşletme Profili tutarlılığı", category: "local", dimension: "geo", weight: 4, explanation: "Sitedeki telefon ve adres, Google İşletme Profili ile birebir aynı olmalıdır (NAP tutarlılığı).", fix: "Şemadaki ve sayfadaki telefon/adres bilgisini SITE_BUSINESS_JSON'daki (Google İşletme Profili) bilgiyle aynı yazın." },
  { id: "entity-links", label: "Varlık bağlantıları (sameAs)", category: "local", dimension: "geo", weight: 3, explanation: "sameAs ile Instagram, Google Maps, Wikipedia gibi resmî profillere bağlantı AI modellerinin markayı doğru eşleştirmesini sağlar.", fix: "Organization/LocalBusiness şemasına resmî profillerin adreslerini sameAs dizisi olarak ekleyin." },
];

export const checkDefinitions: Record<string, CheckDefinition> = Object.fromEntries(defs.map((def) => [def.id, def]));

export function result(id: string, status: CheckStatus, finding: string, evidence?: string[]): CheckResult {
  const def = checkDefinitions[id];
  const critical = id === "http-status" || id === "indexable" || id === "robots-allows" || id === "sitemap";
  const priority: Priority = status === "pass" || status === "skip" ? "low" : critical || def.weight >= 6 ? (status === "fail" ? "high" : "medium") : def.weight >= 4 ? "medium" : "low";
  return { ...def, status, priority, finding, ...(evidence?.length ? { evidence: evidence.slice(0, 25) } : {}) };
}

const value = (status: CheckStatus) => (status === "pass" ? 1 : status === "warn" ? 0.5 : 0);

/** Weighted score (0–100) over measured checks; null when nothing in the selection could be measured. */
export function scoreOf(checks: CheckResult[], filter: (check: CheckResult) => boolean): number | null {
  const measured = checks.filter((check) => check.status !== "skip" && filter(check));
  const total = measured.reduce((sum, check) => sum + check.weight, 0);
  if (!total) return null;
  return Math.round((measured.reduce((sum, check) => sum + check.weight * value(check.status), 0) / total) * 100);
}
