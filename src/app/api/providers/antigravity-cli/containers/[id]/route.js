import { NextResponse } from "next/server";
import {
  deleteProviderConnection,
  getProviderConnectionById,
  updateProviderConnection,
} from "@/lib/localDb";
import {
  agyImageRef,
  baseUrlForHostPort,
  containerLogsForConnection,
  containerNameFor,
  createAgyContainer,
  findContainerForConnection,
  removeAgyContainer,
  startAgyContainer,
  stopAgyContainer,
  waitForHealth,
} from "@/lib/docker/agyContainers.js";
import { callWrapper, resolveProxyForAccount } from "@/lib/docker/agyProvider.js";

export const dynamic = "force-dynamic";

const PROVIDER_ID = "antigravity-cli";

function isSuspended(connection) {
  return Number(connection?.errorCode) === 403
    || /AGY_ACCOUNT_DISABLED|violation of terms|terms of service|banned|account.*disabled|permission denied/i.test(
      String(connection?.lastError || "")
    );
}

async function loadConnection(id) {
  const connection = await getProviderConnectionById(id);
  if (!connection || connection.provider !== PROVIDER_ID) return null;
  return connection;
}

// GET /api/providers/antigravity-cli/containers/[id]?logs=1&tail=200
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    const connection = await loadConnection(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const url = new URL(request.url);
    const container = await findContainerForConnection(id).catch(() => null);

    if (url.searchParams.get("logs") === "1") {
      if (!container) return NextResponse.json({ error: "Container not found" }, { status: 404 });
      const tail = Math.min(2000, Math.max(10, Number(url.searchParams.get("tail")) || 200));
      const logs = await containerLogsForConnection(id, { tail });
      return NextResponse.json({ logs: logs || "" });
    }

    return NextResponse.json({
      connection: {
        id: connection.id,
        name: connection.name,
        isActive: connection.isActive,
        testStatus: connection.testStatus,
        lastError: connection.lastError || null,
        lastErrorAt: connection.lastErrorAt || null,
        errorCode: connection.errorCode || null,
        providerSpecificData: connection.providerSpecificData || {},
      },
      container: container
        ? {
          id: container.Id,
          name: container.Names?.[0]?.replace(/^\//, "") || null,
          state: container.State,
          status: container.Status,
        }
        : null,
    });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to read container" }, { status: 500 });
  }
}

// POST /api/providers/antigravity-cli/containers/[id]
// { action: "update" | "recreate" | "start" | "stop" | "restart" | "wait-healthy" }
export async function POST(request, { params }) {
  try {
    const { id } = await params;
    const connection = await loadConnection(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    const body = await request.json().catch(() => ({}));
    const action = String(body?.action || "").trim();
    const data = connection.providerSpecificData || {};

    // Rename and/or change the proxy pool. A proxy change is applied by
    // recreating the container (the proxy lives in the container env), while
    // the named /data volume keeps the login.
    if (action === "update") {
      const nextName = typeof body?.name === "string" ? body.name.trim() : connection.name;
      if (!nextName) {
        return NextResponse.json({ error: "Connection name is required" }, { status: 400 });
      }
      const nextProxyPoolId =
        body?.proxyPoolId !== undefined ? body.proxyPoolId || null : data.proxyPoolId || null;
      const proxyChanged = String(nextProxyPoolId || "") !== String(data.proxyPoolId || "");
      const nextMemory = body?.memory !== undefined ? String(body.memory).trim() || "256m" : data.memory || "256m";
      const nextCpus = body?.cpus !== undefined ? Math.max(0.1, Number(body.cpus) || 1) : data.cpus || 1;
      const nextImageTag = body?.imageTag !== undefined
        ? String(body.imageTag).trim()
        : data.imageTag || String(data.image || agyImageRef()).split(":").pop();
      const nextImage = agyImageRef(nextImageTag);
      const imageChanged = nextImage !== (data.image || agyImageRef());
      const resourcesChanged = nextMemory !== (data.memory || "256m")
        || Number(nextCpus) !== Number(data.cpus || 1);
      const needsRecreate = proxyChanged || resourcesChanged || imageChanged;

      if (!needsRecreate) {
        await updateProviderConnection(id, { name: nextName });
        return NextResponse.json({ ok: true, action, recreated: false });
      }

      const hostPort = Number(data.hostPort);
      if (!hostPort) {
        await updateProviderConnection(id, {
          name: nextName,
          providerSpecificData: {
            ...data,
            memory: nextMemory,
            cpus: nextCpus,
            image: nextImage,
            imageTag: nextImageTag,
          },
        });
        return NextResponse.json({ ok: true, action, recreated: false });
      }

      const { proxyUrl } = await resolveProxyForAccount(nextProxyPoolId);
      const image = nextImage;
      const created = await createAgyContainer({
        connectionId: id,
        hostPort,
        gatewayToken: connection.apiKey,
        proxyUrl,
        image,
        memory: nextMemory,
        cpus: nextCpus,
      });

      const baseUrl = baseUrlForHostPort(hostPort);
      let health = null;
      let healthError = null;
      try {
        health = await waitForHealth({ baseUrl, token: connection.apiKey, timeoutMs: 90_000 });
      } catch (error) {
        healthError = error?.message || String(error);
      }

      await updateProviderConnection(id, {
        name: nextName,
        testStatus: isSuspended(connection) ? "unavailable" : health?.authOk ? "active" : "unavailable",
        lastError: isSuspended(connection)
          ? connection.lastError
          : healthError || (health?.authOk ? null : "agy is not signed in yet — open Login"),
        errorCode: isSuspended(connection) ? connection.errorCode || 403 : null,
        lastErrorAt: isSuspended(connection) ? connection.lastErrorAt || new Date().toISOString() : null,
        providerSpecificData: {
          ...data,
          baseUrl,
          containerId: created.id,
          containerName: containerNameFor(id),
          image,
          imageTag: nextImageTag,
          proxyPoolId: nextProxyPoolId,
          desiredProxyUrl: proxyUrl,
          appliedProxyUrl: proxyUrl,
          memory: nextMemory,
          cpus: nextCpus,
          agyVersion: health?.agyVersion || data.agyVersion || null,
        },
      });

      return NextResponse.json({ ok: true, action, recreated: true, health, baseUrl });
    }

    if (action === "stop") {
      const stopped = await stopAgyContainer(id);
      return NextResponse.json({ ok: Boolean(stopped), action });
    }

    if (action === "start") {
      const started = await startAgyContainer(id);
      return NextResponse.json({ ok: Boolean(started), action });
    }

    if (action === "restart") {
      await stopAgyContainer(id);
      await startAgyContainer(id);
      return NextResponse.json({ ok: true, action });
    }

    if (action === "recreate") {
      const hostPort = Number(body?.hostPort) || Number(data.hostPort);
      if (!hostPort) {
        return NextResponse.json({ error: "Connection has no hostPort to reuse" }, { status: 400 });
      }
      const { proxyUrl } = await resolveProxyForAccount(
        body?.proxyPoolId !== undefined ? body.proxyPoolId : data.proxyPoolId,
      );
      const image = body?.imageTag ? agyImageRef(String(body.imageTag)) : (data.image || agyImageRef());

      const created = await createAgyContainer({
        connectionId: id,
        hostPort,
        gatewayToken: connection.apiKey,
        proxyUrl,
        image,
        memory: body?.memory || data.memory || "256m",
        cpus: body?.cpus || data.cpus || 1,
      });

      const baseUrl = baseUrlForHostPort(hostPort);
      let health = null;
      let healthError = null;
      try {
        health = await waitForHealth({ baseUrl, token: connection.apiKey, timeoutMs: 90_000 });
      } catch (error) {
        healthError = error?.message || String(error);
      }

      const updated = await updateProviderConnection(id, {
        testStatus: isSuspended(connection) ? "unavailable" : health?.authOk ? "active" : "unavailable",
        lastError: isSuspended(connection)
          ? connection.lastError
          : healthError || (health?.authOk ? null : "agy is not signed in yet — open Login"),
        errorCode: isSuspended(connection) ? connection.errorCode || 403 : null,
        lastErrorAt: isSuspended(connection) ? connection.lastErrorAt || new Date().toISOString() : null,
        providerSpecificData: {
          ...data,
          baseUrl,
          hostPort,
          containerId: created.id,
          containerName: containerNameFor(id),
          image,
          appliedProxyUrl: proxyUrl,
          desiredProxyUrl: proxyUrl,
          proxyPoolId: body?.proxyPoolId !== undefined ? body.proxyPoolId : data.proxyPoolId || null,
          memory: body?.memory || data.memory || "256m",
          cpus: body?.cpus || data.cpus || 1,
          agyVersion: health?.agyVersion || data.agyVersion || null,
        },
      });

      return NextResponse.json({ ok: true, action, health, connection: updated?.id || id, baseUrl });
    }

    if (action === "test") {
      // A real completion, not just /health: /health only proves the wrapper
      // runs and a token file exists. A banned/revoked account can still show
      // authOk:true, so the only reliable check is an actual model call.
      let model = typeof body?.model === "string" ? body.model.trim() : "";
      try {
        if (!model) {
          const models = await callWrapper(connection, "/v1/models", { timeoutMs: 20_000 });
          model = models?.data?.[0]?.id || "";
        }
        if (!model) {
          await updateProviderConnection(id, {
            testStatus: "unavailable",
            lastError: "No model available to test",
            lastErrorAt: new Date().toISOString(),
            errorCode: null,
          });
          return NextResponse.json({ ok: false, status: 409, error: "No model available to test" });
        }

        const result = await callWrapper(connection, "/v1/chat/completions", {
          method: "POST",
          body: {
            model,
            messages: [{ role: "user", content: "ping" }],
            stream: false,
          },
          timeoutMs: 90_000,
        });

        await updateProviderConnection(id, {
          testStatus: "active",
          lastError: null,
          lastErrorAt: null,
          errorCode: null,
        });
        return NextResponse.json({ ok: true, status: 200, model, result });
      } catch (error) {
        const status = Number(error?.status) || 502;
        const message = error?.message || "Account test failed";
        await updateProviderConnection(id, {
          testStatus: "unavailable",
          lastError: message,
          lastErrorAt: new Date().toISOString(),
          errorCode: status,
        });
        return NextResponse.json({ ok: false, status, error: message, code: error?.code || null, model: model || null });
      }
    }

    if (action === "wait-healthy") {
      const baseUrl = data.baseUrl || (data.hostPort ? baseUrlForHostPort(data.hostPort) : "");
      if (!baseUrl) return NextResponse.json({ error: "Connection has no container yet" }, { status: 409 });
      const health = await waitForHealth({ baseUrl, token: connection.apiKey, timeoutMs: 90_000 });
      await updateProviderConnection(id, {
        testStatus: health?.authOk ? "active" : "unavailable",
        lastError: health?.authOk ? null : "agy is not signed in yet — open Login",
      });
      return NextResponse.json({ ok: true, health });
    }

    return NextResponse.json({ error: `Unknown action: ${action}` }, { status: 400 });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Container action failed" }, { status: error?.status || 500 });
  }
}

// DELETE /api/providers/antigravity-cli/containers/[id]
export async function DELETE(request, { params }) {
  try {
    const { id } = await params;
    const connection = await loadConnection(id);
    if (!connection) return NextResponse.json({ error: "Connection not found" }, { status: 404 });

    await removeAgyContainer(id).catch(() => false);
    await deleteProviderConnection(id);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error?.message || "Failed to delete container" }, { status: 500 });
  }
}
