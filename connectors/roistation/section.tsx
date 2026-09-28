// ROIstation connector — server-rendered in-page slot (SEO friendly alternative to the iframe widget).
// Homepage:      <RoistationSection />                      (only content explicitly published to the homepage + compact teasers)
// Service page:  <RoistationSection location="service-page" path="/hizmetler/dis-cephe" />
// Footer:        <RoistationSection location="footer" />   (place it directly above the contact section)
// Long text is always collapsible; teasers link to the full SEO page. Forms keep using widget.js / RoistationSlot.
import { getRoistationSlot } from "./client";

export async function RoistationSection({ location = "homepage", path, title }: { location?: "homepage" | "service-page" | "footer"; path?: string; title?: string }) {
  const items = await getRoistationSlot(location, path);
  if (!items.length) return null;
  return <section className="roi-section" aria-label={title || (location === "footer" ? "Ek bilgiler" : "Güncel içerikler")}>
    {title && <h2>{title}</h2>}
    {items.map((item) => item.display === "teaser" && item.teaser
      ? <article key={item.id} className="roi-teaser"><h3>{item.payload.title}</h3>{item.teaser.intro && <p>{item.teaser.intro}</p>}{item.teaser.highlights.length > 0 && <ul>{item.teaser.highlights.map((line) => <li key={line}>{line}</li>)}</ul>}<a className="roi-cta" href={item.teaser.url}>{item.teaser.cta} →</a></article>
      : <details key={item.id} className="roi-collapsible"><summary><strong>{item.payload.title}</strong>{item.payload.summary && <span>{item.payload.summary}</span>}</summary><div style={{ whiteSpace: "pre-wrap" }}>{item.payload.body}</div></details>)}
    <style>{`.roi-section{display:grid;gap:12px;margin:24px 0}.roi-teaser,.roi-collapsible{padding:16px 18px;border:1px solid color-mix(in srgb,currentColor 15%,transparent);border-radius:10px}.roi-teaser h3{margin:0 0 6px}.roi-teaser ul{margin:0 0 12px;padding-left:1.2em}.roi-cta{font-weight:600;color:inherit}.roi-collapsible summary{cursor:pointer;display:flex;flex-direction:column;gap:4px}.roi-collapsible summary span{opacity:.8;font-size:.95em}.roi-collapsible[open] summary{margin-bottom:10px}`}</style>
  </section>;
}
