// Optional server-rendered content reader; copy into the target Next.js site.
// Returns only content published to the given in-page location (default: homepage).
// Full SEO pages / blog posts: use connectors/roistation (RoistationArticle + templates).
type ContentItem={id:string;kind:string;payload:{title:string;body:string;summary?:string;metaTitle?:string;metaDescription?:string};display?:"collapsible"|"teaser";teaser?:{intro:string;highlights:string[];url:string;cta:string}};
export async function getRoistationContent(masterUrl:string,siteId:string,location:"homepage"|"service-page"|"footer"="homepage",path?:string):Promise<ContentItem[]> {
  const url=new URL("/api/site-content",new URL(masterUrl).origin);url.searchParams.set("siteId",siteId);if(location!=="homepage") url.searchParams.set("location",location);if(path) url.searchParams.set("path",path);
  const response=await fetch(url,{cache:"no-store",signal:AbortSignal.timeout(10000)});
  if(!response.ok) return [];const {items}=await response.json();return items.filter((item:ContentItem)=>item.kind==="content");
}
export async function RoistationContent({masterUrl,siteId,location="homepage",path}:{masterUrl:string;siteId:string;location?:"homepage"|"service-page"|"footer";path?:string}) {
  const items=await getRoistationContent(masterUrl,siteId,location,path);
  return <section aria-label="Güncel içerikler">{items.map(item=>item.display==="teaser" && item.teaser
    ? <article key={item.id}><h2>{item.payload.title}</h2><p>{item.teaser.intro}</p>{item.teaser.highlights.length>0 && <ul>{item.teaser.highlights.map(line=><li key={line}>{line}</li>)}</ul>}<a href={item.teaser.url}>{item.teaser.cta} →</a></article>
    : <details key={item.id}><summary><strong>{item.payload.title}</strong>{item.payload.summary && <span> — {item.payload.summary}</span>}</summary><div style={{whiteSpace:"pre-wrap"}}>{item.payload.body}</div></details>)}</section>;
}
