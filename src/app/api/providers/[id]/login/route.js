import { NextResponse } from "next/server";
import { getProviderConnectionById, updateProviderConnection } from "@/lib/localDb";
import { callWrapper } from "@/lib/docker/agyProvider";

export const dynamic = "force-dynamic";

const PROVIDER_ID = "antigravity-cli";

async function loadConnection(id) {
  const connection = await getProviderConnectionById(id);
  if (!connection || connection.provider !== PROVIDER_ID) return null;
  return connection;
}

// GET /api/providers/[id]/login — login state of the account's container
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await loadConnection(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    const state = await callWrapper(connection, "/auth/status");
    return NextResponse.json(state);
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Failed to read login state" },
      { status: error?.status || 500 },
    );
  }
}

// POST /api/providers/[id]/login — { action: "start" | "complete" | "status", input? }
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await loadConnection(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "status").trim();

    if (action === "start") {
      const state = await callWrapper(connection, "/auth/start", { method: "POST", timeoutMs: 90_000 });
      return NextResponse.json(state);
    }

    if (action === "status") {
      const state = await callWrapper(connection, "/auth/status");
      return NextResponse.json(state);
    }

    if (action === "complete") {
      const input = String(body?.input || "").trim();
      if (!input) {
        return NextResponse.json({ error: "Authorization code or callback URL is required" }, { status: 400 });
      }
      const result = await callWrapper(connection, "/auth/complete", {
        method: "POST",
        body: { input },
        timeoutMs: 180_000,
      });

      const loginAt = new Date().toISOString();
      const updated = await updateProviderConnection(id, {
        testStatus: result?.models?.length ? "active" : "unavailable",
        lastError: null,
        providerSpecificData: {
          ...(connection.providerSpecificData || {}),
          loginEmail: result?.email || connection.providerSpecificData?.loginEmail || null,
          loginAt,
          modelCount: Array.isArray(result?.models) ? result.models.length : 0,
        },
      });

      return NextResponse.json({
        ok: true,
        email: result?.email || null,
        models: result?.models || [],
        connection: { id: updated?.id || id, testStatus: updated?.testStatus || "active" },
      });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error?.message || "Login failed", code: error?.code || null },
      { status: error?.status || 500 },
    );
  }
}
