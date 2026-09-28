// ROIstation connector — server component. Renders inside the site's own layout (header, footer,
// navigation, fonts, colors come from the site). Styles below only add spacing and use
// `inherit` / `currentColor`, so the page matches each site's existing design.
import type { RoistationBlock, RoistationPage } from "./client";

const jsonLd = (value: unknown) => JSON.stringify(value).replace(/</g, "\\u003c");
const formatDate = (value: string) => new Date(value).toLocaleDateString("tr-TR", { day: "numeric", month: "long", year: "numeric" });

function Block({ block }: { block: RoistationBlock }) {
  switch (block.type) {
    case "h2": return <h2 id={block.id}>{block.text}</h2>;
    case "h3": return <h3 id={block.id}>{block.text}</h3>;
    case "quote": return <blockquote><p>{block.text}</p></blockquote>;
    case "ul": return <ul>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ul>;
    case "ol": return <ol>{block.items.map((item, index) => <li key={index}>{item}</li>)}</ol>;
    default: return <p>{block.text}</p>;
  }
}

export function RoistationArticle({ page }: { page: RoistationPage }) {
  const { sections } = page;
  return <article className="roi-article" data-strategy={page.strategy}>
    <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd(page.jsonLd) }} />
    <nav aria-label="Sayfa konumu" className="roi-breadcrumb">
      <ol>{page.breadcrumbs.map((crumb, index) => <li key={crumb.url}>{index < page.breadcrumbs.length - 1 ? <a href={crumb.url}>{crumb.name}</a> : <span aria-current="page">{crumb.name}</span>}</li>)}</ol>
    </nav>
    <header className="roi-header">
      <p className="roi-eyebrow"><a href={page.archive.url}>{page.archive.name}</a></p>
      <h1>{page.h1}</h1>
      {page.summary && !sections.shortAnswer && <p className="roi-lead">{page.summary}</p>}
      <p className="roi-meta">
        <time dateTime={page.publishedAt}>{formatDate(page.publishedAt)}</time>
        {page.updatedAt.slice(0, 10) !== page.publishedAt.slice(0, 10) && <> · Güncellendi: <time dateTime={page.updatedAt}>{formatDate(page.updatedAt)}</time></>}
        {page.readingMinutes ? <> · {page.readingMinutes} dk okuma</> : null}
        {sections.areaServed ? <> · {sections.areaServed}</> : null}
      </p>
    </header>

    {sections.shortAnswer && <aside className="roi-box roi-answer" aria-label="Kısa cevap"><strong>Kısa cevap</strong><p>{sections.shortAnswer}</p></aside>}
    {sections.keyFacts?.length ? <aside className="roi-box" aria-label="Öne çıkan bilgiler"><strong>Öne çıkan bilgiler</strong><ul>{sections.keyFacts.map((fact, index) => <li key={index}>{fact}</li>)}</ul></aside> : null}
    {page.toc.length ? <nav className="roi-box roi-toc" aria-label="İçindekiler"><strong>İçindekiler</strong><ol>{page.toc.map((entry) => <li key={entry.id}><a href={`#${entry.id}`}>{entry.text}</a></li>)}</ol></nav> : null}

    <div className="roi-body">{page.blocks.map((block, index) => <Block key={index} block={block} />)}</div>

    {sections.nap && <aside className="roi-box roi-nap" aria-label="İletişim ve konum">
      <strong>{sections.nap.name}</strong>
      <dl>
        {sections.nap.address && <><dt>Adres</dt><dd>{sections.nap.address}</dd></>}
        {sections.nap.telephone && <><dt>Telefon</dt><dd><a href={`tel:${sections.nap.telephone.replace(/[^+\d]/g, "")}`}>{sections.nap.telephone}</a></dd></>}
        {sections.nap.email && <><dt>E-posta</dt><dd><a href={`mailto:${sections.nap.email}`}>{sections.nap.email}</a></dd></>}
        {sections.nap.openingHours?.length ? <><dt>Çalışma saatleri</dt><dd>{sections.nap.openingHours.join(" · ")}</dd></> : null}
      </dl>
      {sections.nap.directionsUrl && <a href={sections.nap.directionsUrl} rel="noopener" target="_blank">Yol tarifi al</a>}
    </aside>}

    <footer className="roi-links">
      {page.related.length > 0 && <section aria-labelledby="roi-related"><h2 id="roi-related">İlgili sayfalar</h2><ul>{page.related.map((item) => <li key={item.id}><a href={item.url}>{item.title}</a>{item.excerpt && <p>{item.excerpt}</p>}</li>)}</ul></section>}
      {page.relatedServices.length > 0 && <section aria-labelledby="roi-services"><h2 id="roi-services">Hizmetlerimiz</h2><ul>{page.relatedServices.map((item) => <li key={item.url}><a href={item.url}>{item.name}</a></li>)}</ul></section>}
      <p className="roi-back"><a href={page.homeUrl}>← Ana sayfaya dön</a> · <a href={page.archive.url}>Tüm {page.archive.name.toLocaleLowerCase("tr")} yazıları</a></p>
    </footer>
    <style>{articleCss}</style>
  </article>;
}

export function RoistationArchive({ title, pages }: { title: string; pages: { id: string; url: string; title: string; excerpt: string; publishedAt: string }[] }) {
  return <section className="roi-article roi-archive">
    <header className="roi-header"><h1>{title}</h1></header>
    {pages.length ? <ul>{pages.map((page) => <li key={page.id}><h2><a href={page.url}>{page.title}</a></h2><p className="roi-meta"><time dateTime={page.publishedAt}>{formatDate(page.publishedAt)}</time></p>{page.excerpt && <p>{page.excerpt}</p>}</li>)}</ul> : <p>Henüz yayın yok.</p>}
    <style>{articleCss}</style>
  </section>;
}

const articleCss = `
.roi-article{max-width:760px;margin:0 auto;padding:clamp(24px,5vw,56px) 16px;line-height:1.7;color:inherit;font:inherit}
.roi-article h1{line-height:1.2;margin:.2em 0 .4em}
.roi-article h2{line-height:1.3;margin:1.8em 0 .5em}
.roi-article h3{line-height:1.35;margin:1.4em 0 .4em}
.roi-article a{color:inherit;text-underline-offset:3px}
.roi-breadcrumb ol{list-style:none;display:flex;flex-wrap:wrap;gap:6px;padding:0;margin:0 0 16px;font-size:.875em;opacity:.8}
.roi-breadcrumb li+li:before{content:"›";margin-right:6px}
.roi-eyebrow{margin:0;font-size:.85em;letter-spacing:.04em;text-transform:uppercase;opacity:.75}
.roi-lead{font-size:1.15em;opacity:.9}
.roi-meta{font-size:.875em;opacity:.7;margin:.5em 0 0}
.roi-box{margin:24px 0;padding:16px 20px;border:1px solid color-mix(in srgb,currentColor 18%,transparent);border-radius:10px}
.roi-box>strong{display:block;margin-bottom:6px}
.roi-box ul,.roi-box ol{margin:0;padding-left:1.2em}
.roi-nap dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:8px 0}
.roi-nap dt{opacity:.7}.roi-nap dd{margin:0}
.roi-body blockquote{margin:1.2em 0;padding-left:16px;border-left:3px solid color-mix(in srgb,currentColor 25%,transparent)}
.roi-links{margin-top:48px;padding-top:24px;border-top:1px solid color-mix(in srgb,currentColor 15%,transparent)}
.roi-links ul{padding-left:1.2em}.roi-links li p{margin:.2em 0 .8em;opacity:.8;font-size:.95em}
.roi-archive ul{list-style:none;padding:0}.roi-archive li{padding:18px 0;border-bottom:1px solid color-mix(in srgb,currentColor 12%,transparent)}.roi-archive h2{margin:0}
`;
