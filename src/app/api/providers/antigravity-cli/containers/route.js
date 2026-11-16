import { NextResponse } from "next/server";
import {
  createProviderConnection,
  createProxyPool,
  getProviderConnections,
  updateProviderConnection,
} from "@/lib/localDb";
import {
  AGY_IMAGE,
  AGY_IMAGE_TAG,
  agyImageRef,
  baseUrlForHostPort,
  containerNameFor,
  createAgyContainer,
  listManagedContainers,
  normalizeProxyUrl,
  pickHostPort,
  reconcileManagedContainers,
  waitForHealth,
  generateGatewayToken,
  LABEL_CONNECTION,
} from "@/lib/docker/agyContainers.js";
import { resolveProxyForAccount, wrapperRoot } from "@/lib/docker/agyProvider.js";
import { ensureDocker } from "@/lib/docker/install.js";

export const dynamic = "force-dynamic";

const PROVIDER_ID = "antigravity-cli";

async function listModels(baseUrl, token) {
  try {
    const root = wrapperRoot(baseUrl);
    const response = await fetch(`${root}/v1/models`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return [];
    const json = await response.json();
    return (json?.data || []).map((model) => ({ id: model.id, name: model.name || model.id }));
  } catch {
    return [];
  }
}

// GET /api/providers/antigravity-cli/containers
export async function GET() {
  try {
    const connections = await getProviderConnections({ provider: PROVIDER_ID });
    let containers = [];
    try {
      // Adopt/cleanup on page load: removes containers whose connection was deleted.
      await reconcileManagedContainers({ connectionIds: connections.map((connection) => connection.id) });
      containers = await listManagedContainers();
    } catch {
      containers = [];
    }
    const byConnection = new Map(
      (containers || []).map((container) => [container?.Labels?.[LABEL_CONNECTION], container]),
    );

    return NextResponse.json({
      connections: connections.map((connection) => {
        const container = byConnection.get(connection.id);
        return {
          id: connection.id,
          name: connection.name,
          isActive: connection.isActive,
          testStatus: connection.testStatus,
          lastError: connection.lastError || null,
          lastErrorAt: connection.lastErrorAt || null,
          errorCode: connection.errorCode || null,
          providerSpecificData: {
            baseUrl: connection.providerSpecificData?.baseUrl || null,
            hostPort: connection.providerSpecificData?.hostPort || null,
            containerName: connection.providerSpecificData?.containerName || null,
            image: connection.providerSpecificData?.image || null,
            proxyPoolId: connection.providerSpecificData?.proxyPoolId || null,
            loginEmail: connection.providerSpecificData?.loginEmail || null,
            loginAt: connection.providerSpecificData?.loginAt || null,
            memory: connection.providerSpecificData?.memory || null,
            cpus: connection.providerSpecificData?.cpus || null,
          },
          container: container
            ? {
              id: container.Id,
              name: container.Names?.[0]?.replace(/^\//, "") || null,
              state: container.State,
              status: container.Status,
            }
            : null,
        };
      }),
      containerCount: containers.length,
    });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to list containers" }, { status: 500 });
  }
}

// POST /api/providers/antigravity-cli/containers
// { name, proxyPoolId?, imageTag?, memory?, cpus?, hostPort? }
export async function POST(request) {
  let connection = null;
  try {
    const body = await request.json().catch(() => ({}));
    const name = String(body?.name || "").trim();
    if (!name) {
      return NextResponse.json({ error: "Connection name is required" }, { status: 400 });
    }

    const docker = await ensureDocker({ autoInstall: body?.autoInstall !== false });
    if (!docker.ready) {
      return NextResponse.json(
        {
          error: docker.error || "Docker is not ready",
          docker,
        },
        { status: 409 },
      );
    }

    // Accept a raw proxy (`http://u:p@host:port` or `host:port:user:pass`) and
    // materialise it as a proxy pool so the connection keeps one source of truth.
    let proxyPoolId = body?.proxyPoolId || null;
    if (!proxyPoolId && typeof body?.proxy === "string" && body.proxy.trim()) {
      const pool = await createProxyPool({
        name: `${name} proxy`,
        proxyUrl: normalizeProxyUrl(body.proxy),
        type: "http",
      });
      proxyPoolId = pool.id;
    }

    const { proxyUrl } = await resolveProxyForAccount(proxyPoolId);
    const gatewayToken = generateGatewayToken();
    const hostPort = Number(body?.hostPort) || (await pickHostPort());
    const imageTag = String(body?.imageTag || AGY_IMAGE_TAG);
    const image = agyImageRef(imageTag, AGY_IMAGE);

    connection = await createProviderConnection({
      provider: PROVIDER_ID,
      authType: "oauth",
      name,
      apiKey: gatewayToken,
      priority: body?.priority,
      isActive: true,
      testStatus: "unknown",
      providerSpecificData: {
        hostPort,
        image,
        imageTag,
        proxyPoolId,
        desiredProxyUrl: proxyUrl,
        appliedProxyUrl: proxyUrl,
        memory: body?.memory || "256m",
        cpus: body?.cpus || 1,
      },
    });

    const created = await createAgyContainer({
      connectionId: connection.id,
      hostPort,
      gatewayToken,
      proxyUrl,
      image,
      memory: body?.memory || "256m",
      cpus: body?.cpus || 1,
    });

    const baseUrl = baseUrlForHostPort(hostPort);
    let health = null;
    let healthError = null;
    try {
      health = await waitForHealth({ baseUrl, token: gatewayToken, timeoutMs: 90_000 });
    } catch (error) {
      healthError = error?.message || String(error);
    }

    const models = health?.authOk ? await listModels(baseUrl, gatewayToken) : [];

    const updated = await updateProviderConnection(connection.id, {
      testStatus: health?.authOk ? "active" : "unavailable",
      lastError: healthError || (health?.authOk ? null : "agy is not signed in yet — open Login"),
      providerSpecificData: {
        ...(connection.providerSpecificData || {}),
        baseUrl,
        hostPort,
        containerId: created.id,
        containerName: containerNameFor(connection.id),
        image,
        imageTag,
        proxyPoolId,
        appliedProxyUrl: proxyUrl,
        agyVersion: health?.agyVersion || null,
        modelCount: models.length,
      },
    });

    return NextResponse.json(
      {
        connection: {
          id: updated.id,
          name: updated.name,
          baseUrl,
          hostPort,
          containerId: created.id,
          image,
          testStatus: updated.testStatus,
          lastError: updated.lastError || null,
        },
        health,
        models,
        docker: { ready: true, version: docker.version || null },
      },
      { status: 201 },
    );
  } catch (error) {
    // If the container could not be created, do not leave a dead connection behind.
    if (connection?.id) {
      try {
        await updateProviderConnection(connection.id, {
          isActive: false,
          testStatus: "unavailable",
          lastError: error?.message || "Container creation failed",
        });
      } catch {
        // ignore
      }
    }
    return NextResponse.json(
      { error: error?.message || "Failed to create container", connectionId: connection?.id || null },
      { status: error?.status || 500 },
    );
  }
}
