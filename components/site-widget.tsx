"use client";
import { useEffect,useState } from "react";
import { readApiResponse } from "@/lib/client-api";
import type { Payload } from "@/lib/publications";
// display/teaser are optional so older feeds (and forms) render exactly as before.
type Item={id:string;kind:"content"|"form";payload:Payload;display?:"collapsible"|"teaser";teaser?:{intro:string;highlights:string[];url:string;cta:string}};
export function SiteWidget({siteId,location="",path="",initialItems,initialError=""}:{siteId:string;location?:string;path?:string;initialItems:Item[];initialError?:string}) {
  const query=`siteId=${encodeURIComponent(siteId)}${location ? `&location=${encodeURIComponent(location)}` : ""}${path ? `&path=${encodeURIComponent(path)}` : ""}`;
  const [items,setItems]=useState(initialItems);const [error,setError]=useState(initialError);
  useEffect(()=>{let stopped=false;const poll=async()=>{try {const response=await fetch(`/api/site-content?${query}`,{cache:"no-store"});const data=await readApiResponse(response) as {items:Item[];error?:string};if(!response.ok) throw new Error(data.error || "Yayın alanı yüklenemedi.");if(!stopped) {setItems(data.items);setError("");}} catch {if(!stopped) {setItems([]);setError("Yayın alanı geçici olarak yüklenemiyor.");}}};const timer=setInterval(()=>void poll(),15000);return()=>{stopped=true;clearInterval(timer);};},[query]);
  useEffect(()=>{const send=()=>window.parent.postMessage({type:"roi-height",siteId,height:document.querySelector(".public-widget")?.scrollHeight || 0},"*");const observer=new ResizeObserver(send);const root=document.querySelector(".public-widget");if(root) observer.observe(root);send();return()=>observer.disconnect();},[siteId,items]);
  return <div className="public-widget">{error && <p role="alert">{error}</p>}{items.map(item=>item.display==="teaser" && item.teaser ? <TeaserItem key={item.id} item={item}/> : item.display==="collapsible" ? <CollapsibleItem key={item.id} item={item}/> : <article className="public-item" key={item.id}><h2>{item.payload.title}</h2>{item.payload.summary && <p>{item.payload.summary}</p>}<div className="public-body">{item.payload.body}</div>{item.kind==="form" && <PublishedForm item={item} siteId={siteId}/>}</article>)}</div>;
}
// Compact homepage section: intro, highlights and a link to the full SEO page (opens in the site, not the iframe).
function TeaserItem({item}:{item:Item}) {
  const teaser=item.teaser!;
  return <article className="public-item public-teaser"><h2>{item.payload.title}</h2>{teaser.intro && <p>{teaser.intro}</p>}{teaser.highlights.length>0 && <ul>{teaser.highlights.map(line=><li key={line}>{line}</li>)}</ul>}<a className="public-cta" href={teaser.url} target="_top">{teaser.cta} →</a></article>;
}
// Long text stays folded so homepage, service pages and footers never become a wall of text.
function CollapsibleItem({item}:{item:Item}) {
  return <article className="public-item public-collapsible"><details><summary><span>{item.payload.title}</span>{item.payload.summary && <small>{item.payload.summary}</small>}</summary><div className="public-body">{item.payload.body}</div></details></article>;
}
function PublishedForm({item,siteId}:{item:Item;siteId:string}) {
  const [notice,setNotice]=useState("");const [busy,setBusy]=useState(false);const [submissionId,setSubmissionId]=useState<string|null>(null);
  return <form className="public-form" onSubmit={async event=>{event.preventDefault();const form=event.currentTarget;const values=new FormData(form);setBusy(true);setNotice("");try {
    const tokenResponse=await fetch(`/api/form-token?id=${item.id}&siteId=${siteId}`,{cache:"no-store"});const tokenData=await readApiResponse(tokenResponse) as {token:string;error?:string};if(!tokenResponse.ok) throw new Error(tokenData.error || "Form güvenlik anahtarı alınamadı.");
    const answers=Object.fromEntries((item.payload.fields || []).map(field=>[field.id,values.get(field.id) || ""]));const id=submissionId || crypto.randomUUID();setSubmissionId(id);
    const response=await fetch("/api/submissions",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({id,publicationId:item.id,siteId,token:tokenData.token,answers,consent:values.get("roi_consent")==="on",website:values.get("roi_website")})});const data=await readApiResponse(response) as {error?:string};if(!response.ok) throw new Error(data.error || "Gönderim tamamlanamadı.");form.reset();setSubmissionId(null);setNotice("Talebin kaydedildi. Teşekkür ederiz.");
  } catch(error) {setNotice(error instanceof Error ? error.message : "Gönderim tamamlanamadı.");} finally {setBusy(false);}}}>{item.payload.fields?.map(field=><label key={field.id}>{field.label}{field.required ? " *" : ""}{field.type==="textarea" ? <textarea name={field.id} required={field.required} maxLength={4000}/> : <input type={field.type} name={field.id} required={field.required} maxLength={4000}/>}</label>)}<label className="honeypot" aria-hidden="true">Website<input name="roi_website" tabIndex={-1} autoComplete="off"/></label><label className="public-consent"><input type="checkbox" name="roi_consent" required/>{item.payload.consentText}</label><button type="submit" disabled={busy}>{busy ? "Gönderiliyor…" : "Gönder"}</button>{notice && <p role="status">{notice}</p>}</form>;
}
