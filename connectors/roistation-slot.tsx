"use client";
// Copy into the target site's components folder. No secret is exposed here.
import { useEffect,useRef } from "react";
// location: "homepage" (default) | "service-page" (with path) | "footer". Omit for the previous behaviour.
export function RoistationSlot({siteId,masterUrl,location,path}:{siteId:string;masterUrl:string;location?:"homepage"|"service-page"|"footer";path?:string}) {
  const ref=useRef<HTMLIFrameElement>(null);const origin=new URL(masterUrl).origin;
  const query=location && location!=="homepage" ? `?location=${encodeURIComponent(location)}${location==="service-page" && path ? `&path=${encodeURIComponent(path)}` : ""}` : "";
  useEffect(()=>{const handler=(event:MessageEvent)=>{if(event.origin!==origin || event.source!==ref.current?.contentWindow || !event.data || event.data.type!=="roi-height" || event.data.siteId!==siteId) return;const height=Number(event.data.height);if(ref.current && Number.isFinite(height) && height>=0) ref.current.style.height=`${Math.min(height+(height ? 24 : 0),100000)}px`;};window.addEventListener("message",handler);return()=>window.removeEventListener("message",handler);},[origin,siteId]);
  return <div data-roistation-site={siteId}><iframe ref={ref} src={`${origin}/embed/${siteId}${query}`} title="Güncel içerikler ve iletişim formu" sandbox="allow-scripts allow-same-origin allow-forms allow-top-navigation-by-user-activation" style={{width:"100%",height:0,border:0,display:"block"}}/></div>;
}
export default RoistationSlot;
