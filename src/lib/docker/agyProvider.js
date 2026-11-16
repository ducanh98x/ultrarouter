/**
 * Shared helpers for the Antigravity CLI provider routes.
 */
import { getProxyPoolById } from "@/lib/localDb";
import { agyImageRef, normalizeProxyUrl } from "./agyContainers.js";

/** `http://127.0.0.1:20801/v1` → `http://127.0.0.1:20801` */
export function wrapperRoot(baseUrl) {
  const value = String(baseUrl || "").trim();
  if (!value) return "";
  return value.replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
}

export async function resolveProxyForAccount(proxyPoolId) {
  if (!proxyPoolId) return { proxyUrl: "", proxyPool: null };
  const pool = await getProxyPoolById(proxyPoolId);
  if (!pool) {
    const error = new Error("Proxy pool not found");
    error.status = 400;
    throw error;
  }
  return { proxyUrl: normalizeProxyUrl(pool.proxyUrl), proxyPool: pool };
}

export function containerFields(connection) {
  const data = connection?.providerSpecificData || {};
  return {
    containerName: data.containerName || null,
    containerId: data.containerId || null,
    hostPort: data.hostPort || null,
    baseUrl: data.baseUrl || null,
    image: data.image || agyImageRef(),
  };
}

/**
 * Call the wrapper that runs inside the account's container.
 */
export async function callWrapper(connection, pathname, { method = "GET", body = null, timeoutMs = 90_000 } = {}) {
  const root = wrapperRoot(connection?.providerSpecificData?.baseUrl);
  if (!root) {
    const error = new Error("connection has no container yet (missing baseUrl)");
    error.status = 409;
    throw error;
  }
  const headers = { "Content-Type": "application/json" };
  if (connection.apiKey) headers.Authorization = `Bearer ${connection.apiKey}`;

  const response = await fetch(`${root}${pathname}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!response.ok) {
    const error = new Error(json?.error?.message || text || `wrapper HTTP ${response.status}`);
    error.status = response.status;
    error.code = json?.error?.code || null;
    error.body = json;
    throw error;
  }
  return json;
}
