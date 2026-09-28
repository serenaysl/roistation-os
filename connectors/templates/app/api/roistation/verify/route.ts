// Copy to the site as app/api/roistation/verify/route.ts.
// The Master Panel (and its Vercel auto-discovery) calls this to detect and verify the connector.
// Public and read-only: it exposes no secrets, only whether the site is configured for ROIstation.
import { ROISTATION_CAPABILITIES, ROISTATION_CONNECTOR_VERSION } from "@/components/roistation/version";

export const dynamic = "force-dynamic";

export function GET() {
  const siteId = process.env.ROISTATION_SITE_ID || "";
  const masterUrl = process.env.ROISTATION_MASTER_URL || "";
  const connected = /^[a-z0-9-]{2,60}$/.test(siteId) && /^https:\/\//.test(masterUrl);
  return Response.json({
    connected,
    siteId: siteId || null,
    siteName: process.env.ROISTATION_SITE_NAME || null,
    version: ROISTATION_CONNECTOR_VERSION,
    lastSeen: new Date().toISOString(),
    environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "production",
    capabilities: connected ? ROISTATION_CAPABILITIES : [],
    revalidate: Boolean(process.env.ROISTATION_REVALIDATE_SECRET),
  }, { headers: { "Cache-Control": "no-store" } });
}
