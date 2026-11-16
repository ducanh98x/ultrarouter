import { NextResponse } from "next/server";
import { buildAgyImage, detectDocker, ensureDocker, getAgyImageStatus } from "@/lib/docker/install.js";
import { reconcileManagedContainers } from "@/lib/docker/agyContainers.js";
import { getProviderConnections } from "@/lib/localDb";

export const dynamic = "force-dynamic";
export const maxDuration = 1800;

// GET /api/docker — is Docker installed / running / accessible?
export async function GET() {
  try {
    const status = await detectDocker();
    const gatewayImage = status.ready ? await getAgyImageStatus() : null;
    return NextResponse.json({ ...status, gatewayImage });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to detect Docker" }, { status: 500 });
  }
}

// POST /api/docker — { action?: "reconcile" | "build-image", autoInstall?: boolean, force?: boolean }
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

    if (body?.action === "build-image") {
      const result = await buildAgyImage({
        force: body?.force === true,
        tag: typeof body?.tag === "string" && body.tag.trim() ? body.tag.trim() : undefined,
      });
      const docker = await detectDocker();
      const gatewayImage = docker.ready ? await getAgyImageStatus({ tag: result.tag || undefined }) : null;
      return NextResponse.json({ ...result, docker, gatewayImage }, { status: result.ok ? 200 : 500 });
    }

    const status = await ensureDocker({ autoInstall: body?.autoInstall !== false });
    const gatewayImage = status.ready ? await getAgyImageStatus() : null;
    return NextResponse.json({ ...status, gatewayImage });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Docker setup failed" }, { status: 500 });
  }
}
