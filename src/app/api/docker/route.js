import { NextResponse } from "next/server";
import { detectDocker, ensureDocker } from "@/lib/docker/install.js";
import { reconcileManagedContainers } from "@/lib/docker/agyContainers.js";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";

// GET /api/docker — is Docker installed / running / accessible?
export async function GET() {
  try {
    const status = await detectDocker();
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to detect Docker" }, { status: 500 });
  }
}

// POST /api/docker — { action?: "reconcile", autoInstall?: boolean } → detect, optionally install.
export async function POST(request) {
  try {
    const body = await request.json().catch(() => ({}));

    if (body?.action === "reconcile") {
      const connections = await getProviderConnections({ provider: "antigravity-cli" });
      const removed = await reconcileManagedContainers({
        connectionIds: connections.map((connection) => connection.id),
      });
      return NextResponse.json({ ok: true, removed });
    }

    const status = await ensureDocker({ autoInstall: body?.autoInstall !== false });
    return NextResponse.json(status);
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Docker setup failed" }, { status: 500 });
  }
}
