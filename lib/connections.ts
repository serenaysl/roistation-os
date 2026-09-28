import { verifySite } from "@/lib/verification";
import type { Connection } from "@/lib/publications";
export { masterOrigin } from "@/lib/verification";
import { masterOrigin } from "@/lib/verification";

export function widgetSnippet(siteId:string) { return `<div data-roistation-site="${siteId}"></div>\n<script src="${masterOrigin()}/widget.js" defer></script>`; }

/** Kept for existing callers: verifies with the unified engine (connector endpoint, widget code, Vercel deployment). */
export async function verifyConnection(siteId:string,siteUrl:string):Promise<Connection> {
  return verifySite(siteId,{siteUrl,reason:"manual"});
}
