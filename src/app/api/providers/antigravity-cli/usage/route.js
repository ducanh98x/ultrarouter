import { NextResponse } from "next/server";
import { getProviderConnectionById } from "@/lib/localDb";
import { getCachedAgyQuota, refreshAgyQuota } from "@/sse/services/agyQuota.js";

export const dynamic = "force-dynamic";

// GET /api/providers/antigravity-cli/usage?connectionId=<id>&force=1
export async function GET(request) {
  try {
    const url = new URL(request.url);
    const connectionId = url.searchParams.get("connectionId");
    const force = url.searchParams.get("force") === "1";
    if (!connectionId) {
      return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
    }

    const connection = await getProviderConnectionById(connectionId);
    if (!connection || connection.provider !== "antigravity-cli") {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    const cached = getCachedAgyQuota(connectionId);
    const quotas = !cached || force
      ? await refreshAgyQuota({ ...connection, id: connectionId }, { force })
      : cached;

    return NextResponse.json({
      connectionId,
      quotas: quotas || {},
      cached: Boolean(cached),
      at: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to read quota" }, { status: 500 });
  }
}
