/**
 * Docker container lifecycle for the Antigravity CLI provider.
 *
 * One container per account:
 *   9router  --HTTP-->  127.0.0.1:<hostPort>  -->  agy-gateway  -->  agy  --> Google
 *
 * The container publishes a loopback-only port, keeps its HOME on a named
 * volume (so the OAuth session survives restarts) and receives the account's
 * proxy through env vars at create time (agy also makes background calls, so a
 * per-request proxy would not cover them).
 */
import crypto from "node:crypto";
import net from "node:net";
import { getDockerClient } from "./client.js";

export const AGY_WRAPPER_PORT = 8787;
export const AGY_IMAGE = process.env.AGY_IMAGE || "9router/agy-gateway";
export const AGY_IMAGE_TAG = process.env.AGY_IMAGE_TAG || "1.5.9";
export const DEFAULT_PORT_RANGE = [20800, 20999];

export const LABEL_MANAGED = "9router.managed";
export const LABEL_CONNECTION = "9router.connection";
export const LABEL_COMPONENT = "9router.component";
export const COMPONENT_VALUE = "agy-gateway";

export function agyImageRef(tag = AGY_IMAGE_TAG, image = AGY_IMAGE) {
  return `${image}:${tag}`;
}

export function containerNameFor(connectionId) {
  const short = String(connectionId || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "unknown";
  return `9router-agy-${short}`;
}

export function volumeNameFor(connectionId) {
  return containerNameFor(connectionId);
}

/**
 * Accept either a full proxy URL or the common `host:port:user:pass` form used
 * by proxy sellers. Returns "" for empty input.
 */
export function normalizeProxyUrl(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return "";
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) return raw;
  const parts = raw.split(":");
  if (parts.length === 4) {
    const [host, port, user, pass] = parts;
    if (!host || !port) return raw;
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`;
  }
  if (parts.length === 2) return `http://${raw}`;
  return raw;
}

export function parseMemoryBytes(value, fallback = 1024 * 1024 * 1024) {  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.floor(value);
  if (typeof value !== "string") return fallback;
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(b|k|kb|m|mb|g|gb)?$/);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2] || "b";
  const multiplier = unit.startsWith("g") ? 1024 ** 3 : unit.startsWith("m") ? 1024 ** 2 : unit.startsWith("k") ? 1024 : 1;
  return Math.max(1, Math.floor(amount * multiplier));
}

/**
 * Pure Docker create spec (exported for tests).
 */
export function buildContainerSpec({
  connectionId,
  hostPort,
  image = agyImageRef(),
  gatewayToken,
  proxyUrl = "",
  memory = "256m",
  cpus = 1,
  pidsLimit = 256,
}) {
  if (!connectionId) throw new Error("connectionId is required");
  if (!hostPort) throw new Error("hostPort is required");
  if (!gatewayToken) throw new Error("gatewayToken is required");

  const env = [
    "HOME=/data",
    `PORT=${AGY_WRAPPER_PORT}`,
    `GATEWAY_TOKEN=${gatewayToken}`,
    "NODE_ENV=production",
    "NO_PROXY=localhost,127.0.0.1",
    "no_proxy=localhost,127.0.0.1",
  ];

  const proxy = normalizeProxyUrl(proxyUrl);
  if (proxy) {
    env.push(`HTTP_PROXY=${proxy}`, `HTTPS_PROXY=${proxy}`, `ALL_PROXY=${proxy}`);
  }

  return {
    Image: image,
    Hostname: containerNameFor(connectionId),
    Labels: {
      [LABEL_MANAGED]: "true",
      [LABEL_CONNECTION]: String(connectionId),
      [LABEL_COMPONENT]: COMPONENT_VALUE,
    },
    Env: env,
    ExposedPorts: { [`${AGY_WRAPPER_PORT}/tcp`]: {} },
    WorkingDir: "/data/work",
    Tty: false,
    OpenStdin: false,
    HostConfig: {
      Binds: [`${volumeNameFor(connectionId)}:/data`],
      PortBindings: {
        [`${AGY_WRAPPER_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: String(hostPort) }],
      },
      RestartPolicy: { Name: "unless-stopped", MaximumRetryCount: 0 },
      Memory: parseMemoryBytes(memory),
      NanoCpus: Math.max(100_000_000, Math.round((Number(cpus) || 1) * 1_000_000_000)),
      PidsLimit: Math.max(16, Math.floor(Number(pidsLimit) || 256)),
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges"],
      ReadonlyRootfs: true,
      Tmpfs: { "/tmp": "rw,noexec,nosuid,size=256m" },
      Init: true,
    },
  };
}

export function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.once("listening", () => server.close(() => resolve(true)));
    server.listen(port, host);
  });
}

export async function pickHostPort({ range = DEFAULT_PORT_RANGE, isFree = isPortFree, randomInt = crypto.randomInt } = {}) {
  const [start, end] = range;
  const span = Math.max(1, end - start + 1);
  const offset = randomInt(span);
  for (let i = 0; i < span; i += 1) {
    const port = start + ((offset + i) % span);
    if (await isFree(port)) return port;
  }
  throw new Error(`no free loopback port in ${start}-${end}`);
}

export function baseUrlForHostPort(hostPort) {
  return `http://127.0.0.1:${hostPort}/v1`;
}

export function generateGatewayToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export async function listManagedContainers(client = getDockerClient()) {
  return client.listContainers({
    all: true,
    filters: { label: [`${LABEL_MANAGED}=true`, `${LABEL_COMPONENT}=${COMPONENT_VALUE}`] },
  });
}

export async function findContainerForConnection(connectionId, client = getDockerClient()) {
  if (!connectionId) return null;
  const list = await client.listContainers({
    all: true,
    filters: { label: [`${LABEL_CONNECTION}=${connectionId}`] },
  });
  return list?.[0] || null;
}

export async function createAgyContainer({
  connectionId,
  hostPort,
  gatewayToken,
  proxyUrl = "",
  image = agyImageRef(),
  client = getDockerClient(),
  memory,
  cpus,
} = {}) {
  const name = containerNameFor(connectionId);
  // Ensure the image exists before removing the old container: a bad tag
  // should fail the update without taking the working container down.
  if (!(await client.imageExists(image))) {
    await client.pullImage(image);
  }

  const exists = await findContainerForConnection(connectionId, client);
  if (exists) {
    await client.removeContainer(exists.Id, { force: true });
  }

  const spec = buildContainerSpec({ connectionId, hostPort, image, gatewayToken, proxyUrl, memory, cpus });
  const created = await client.createContainer(name, spec);
  await client.startContainer(created.Id);
  return { id: created.Id, name, image, hostPort };
}

export async function recreateAgyContainer(options = {}) {
  return createAgyContainer(options);
}

export async function stopAgyContainer(connectionId, client = getDockerClient()) {
  const container = await findContainerForConnection(connectionId, client);
  if (!container) return null;
  await client.stopContainer(container.Id);
  return container.Id;
}

export async function startAgyContainer(connectionId, client = getDockerClient()) {
  const container = await findContainerForConnection(connectionId, client);
  if (!container) return null;
  await client.startContainer(container.Id);
  return container.Id;
}

export async function removeAgyContainer(connectionId, client = getDockerClient()) {
  const container = await findContainerForConnection(connectionId, client);
  if (!container) return false;
  await client.removeContainer(container.Id, { force: true });
  return true;
}

export async function containerLogsForConnection(connectionId, { tail = 200, client = getDockerClient() } = {}) {
  const container = await findContainerForConnection(connectionId, client);
  if (!container) return null;
  return client.containerLogs(container.Id, { tail });
}

/**
 * Poll the wrapper until it answers /health.
 */
export async function waitForHealth({
  baseUrl,
  token,
  timeoutMs = 60_000,
  intervalMs = 1_000,
  fetchImpl = fetch,
} = {}) {
  const started = Date.now();
  let lastError = "no response";
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetchImpl(`${baseUrl.replace(/\/v1$/, "")}/health`, {
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
    } catch (error) {
      lastError = error?.message || String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`agy-gateway did not become healthy in ${timeoutMs}ms: ${lastError}`);
}

/**
 * Remove containers whose connection no longer exists. Returns the ids removed.
 */
export async function reconcileManagedContainers({ connectionIds = [], client = getDockerClient() } = {}) {
  const alive = new Set(connectionIds.filter(Boolean));
  const containers = await listManagedContainers(client);
  const removed = [];
  for (const container of containers || []) {
    const connectionId = container?.Labels?.[LABEL_CONNECTION];
    if (!connectionId || alive.has(connectionId)) continue;
    await client.removeContainer(container.Id, { force: true });
    removed.push(container.Id);
  }
  return removed;
}
