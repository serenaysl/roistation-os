import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin";
import { apiFailure } from "@/lib/database";
import { storageConfigured,storageHealth } from "@/lib/storage";
import { listConnections } from "@/lib/connection-storage";

export async function GET(request:Request) {
  try {await requireAdmin(request);} catch(error) {return apiFailure(error);}
  let storageReady=false;let connectedSites=0;
  if(storageConfigured()) {try {await storageHealth();storageReady=true;connectedSites=(await listConnections()).filter(row=>row.verified).length;} catch {storageReady=false;}}
  const anthropicConnected = Boolean(process.env.ANTHROPIC_API_KEY);
  const openaiConnected = Boolean(process.env.OPENAI_API_KEY);

  return NextResponse.json({
    anthropic: {
      connected: anthropicConnected,
      model: process.env.ANTHROPIC_MODEL || "claude-sonnet-5",
    },
    openai: {
      connected: openaiConnected,
      model: process.env.OPENAI_MODEL || "gpt-5.2",
    },
    activeProvider: anthropicConnected ? "anthropic" : openaiConnected ? "openai" : "demo",
    storageProvider:"vercel-blob-private",storageConfigured:storageConfigured(),storageReady,connectedSites,
  });
}
