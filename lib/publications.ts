import type { Placement } from "@/lib/publishing/definitions";
export type Field = { id: string; label: string; type: "text" | "email" | "tel" | "textarea"; required: boolean };
export type Payload = { title: string; body: string; summary?: string; metaTitle?: string; metaDescription?: string; fields?: Field[]; consentText?: string };
export type TargetState = "draft" | "published" | "scheduled" | "withdrawn" | "deleted" | "failed";
// slug: URL slug on the target site for page locations (SEO page / blog). Optional for backward compatibility.
export type Target = { status: TargetState; payload: Payload | null; detail?: string; scheduledAt?: string | null; slug?: string };
export type PublicationEvent = { at: string; action: string; siteIds: string[]; detail?: string };
// placement: where and how content is published. Missing on legacy rows -> resolvePlacement() defaults to an SEO page.
export type Publication = { id: string; title: string; kind: "content" | "form"; createdAt: string; updatedAt: string; targets: Record<string, Target>; events: PublicationEvent[]; placement?: Placement };
export type PublicationRow = { id: string; version: number; document: Publication };
export type ConnectionStatus = "connected" | "connected-widget" | "not-connected" | "not-verified" | "deploying" | "deployment-failed" | "missing-domain" | "domain-offline" | "project-missing";
// Fields after `detail` are optional: connection records written by earlier versions stay valid.
export type Connection = {
  site_id: string; site_url: string; verified: boolean; verified_at: string; detail: string;
  status?: ConnectionStatus;
  method?: "vercel" | "endpoint" | "widget" | null;
  /** Whether the site renders ROIstation content: connector kit endpoint, widget code, or neither. */
  connectorState?: "installed" | "widget" | "missing";
  connector?: { connected: boolean; siteId: string | null; siteName: string | null; version: string | null; environment: string | null; lastSeen: string | null; capabilities: string[] } | null;
  last_seen?: string | null;
  deployment?: { state: string; createdAt: string | null; readyAt: string | null; url: string | null } | null;
  checks?: { deploymentReady: boolean | null; domainActive: boolean | null; sslValid: boolean | null; connectorReachable: boolean | null; publishEndpoint: boolean | null };
};
export type Submission = {id:string;publication_id:string;site_id:string;answers:Record<string,string>;consent_at:string;consent_text:string;created_at:string};
export const statusLabels: Record<TargetState, string> = { draft: "Taslak", published: "Yayında", scheduled: "Planlı", withdrawn: "Yayından kaldırıldı", deleted: "Silindi", failed: "Başarısız" };
export function effectiveStatus(target: Target): TargetState {
  return target.status === "scheduled" && target.scheduledAt && Date.parse(target.scheduledAt) <= Date.now() ? "published" : target.status;
}
