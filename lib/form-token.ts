import { createHmac } from "node:crypto";
export function formToken(id:string,siteId:string,expires:string) {return createHmac("sha256",process.env.PANEL_SESSION_SECRET || "unconfigured").update(`form:${id}:${siteId}:${expires}`).digest("hex");}
