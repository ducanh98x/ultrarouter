/**
 * Minimal Docker Engine API client.
 *
 * 9router runs directly on the host, so it talks to the local daemon over the
 * unix socket (`/var/run/docker.sock`) or, on Windows dev machines, the named
 * pipe. `DOCKER_HOST` overrides both (unix://, npipe://, tcp://).
 *
 * Only the endpoints the Antigravity CLI provider needs are implemented; no
 * external dependency is added.
 */
import http from "node:http";
import { platform } from "node:os";

export const DOCKER_UNIX_SOCKET = "/var/run/docker.sock";
export const DOCKER_WINDOWS_PIPE = "//./pipe/docker_engine";

export function resolveDockerEndpoint(env = process.env, osPlatform = platform()) {
  const host = env?.DOCKER_HOST;
  if (typeof host === "string" && host.trim()) {
    const value = host.trim();
    if (value.startsWith("unix://")) return { socketPath: value.slice("unix://".length) };
    if (value.startsWith("npipe://")) return { socketPath: value.slice("npipe://".length) };
    if (value.startsWith("tcp://") || value.startsWith("http://")) {
      const url = new URL(value.replace(/^tcp:\/\//, "http://"));
      return { host: url.hostname, port: Number(url.port || 2375) };
    }
  }
  return osPlatform === "win32"
    ? { socketPath: DOCKER_WINDOWS_PIPE }
    : { socketPath: DOCKER_UNIX_SOCKET };
}

function parseDockerError(text) {
  if (!text) return "";
  try {
    const json = JSON.parse(text);
    return json?.message || "";
  } catch {
    return "";
  }
}

/**
 * Demultiplex Docker's raw log stream.
 * Frame = [stream:1][padding:3][size:4 big-endian][payload:size]
 * Falls back to plain text when the payload is not framed (TTY containers).
 */
export function demuxDockerLogs(buffer) {
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || "");
  if (buf.length === 0) return "";
  // Heuristic: a framed stream starts with 0x00/0x01/0x02 and 3 zero bytes.
  const looksFramed = buf.length >= 8 && buf[0] <= 2 && buf[1] === 0 && buf[2] === 0 && buf[3] === 0;
  if (!looksFramed) return buf.toString("utf8");

  let offset = 0;
  const out = [];
  while (offset + 8 <= buf.length) {
    const size = buf.readUInt32BE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > buf.length) break;
    out.push(buf.subarray(start, end).toString("utf8"));
    offset = end;
  }
  if (offset < buf.length) out.push(buf.subarray(offset).toString("utf8"));
  return out.join("");
}

export class DockerClient {
  constructor(endpoint = resolveDockerEndpoint()) {
    this.endpoint = endpoint;
  }

  _rawRequest(method, pathname, { body = null, timeoutMs = 30_000, headers = {} } = {}) {
    return new Promise((resolve, reject) => {
      const payload = body === null ? null : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
      const req = http.request(
        {
          method,
          path: pathname,
          ...this.endpoint,
          headers: {
            "Content-Type": "application/json",
            ...(payload ? { "Content-Length": payload.length } : {}),
            ...headers,
          },
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode, buffer: Buffer.concat(chunks) }));
          res.on("error", reject);
        },
      );
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`Docker API timeout after ${timeoutMs}ms (${method} ${pathname})`));
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }

  async _request(method, pathname, options = {}) {
    const { status, buffer } = await this._rawRequest(method, pathname, options);
    const text = buffer.toString("utf8");
    if (status >= 200 && status < 300) return { status, text };
    const message = parseDockerError(text) || text.slice(0, 300) || `HTTP ${status}`;
    const error = new Error(message);
    error.status = status;
    error.body = text;
    throw error;
  }

  async _json(method, pathname, options) {
    const { text } = await this._request(method, pathname, options);
    if (!text) return null;
    return JSON.parse(text);
  }

  async ping() {
    const { status, buffer } = await this._rawRequest("GET", "/_ping", { timeoutMs: 5_000 });
    return status === 200 && buffer.toString("utf8").trim() === "OK";
  }

  async version() {
    return this._json("GET", "/version", { timeoutMs: 10_000 });
  }

  async listContainers({ all = true, filters = null } = {}) {
    const params = new URLSearchParams({ all: all ? "1" : "0" });
    if (filters) params.set("filters", JSON.stringify(filters));
    return this._json("GET", `/containers/json?${params.toString()}`);
  }

  async inspectContainer(id) {
    try {
      return await this._json("GET", `/containers/${encodeURIComponent(id)}/json`);
    } catch (error) {
      if (error.status === 404) return null;
      throw error;
    }
  }

  async createContainer(name, spec) {
    return this._json("POST", `/containers/create?name=${encodeURIComponent(name)}`, { body: spec });
  }

  async startContainer(id) {
    try {
      await this._request("POST", `/containers/${encodeURIComponent(id)}/start`);
    } catch (error) {
      // 304 = already started
      if (error.status !== 304) throw error;
    }
  }

  async stopContainer(id, timeoutSec = 10) {
    try {
      await this._request("POST", `/containers/${encodeURIComponent(id)}/stop?t=${timeoutSec}`, { timeoutMs: 60_000 });
    } catch (error) {
      if (error.status !== 304 && error.status !== 404) throw error;
    }
  }

  async removeContainer(id, { force = true, volumes = true } = {}) {
    try {
      await this._request(
        "DELETE",
        `/containers/${encodeURIComponent(id)}?force=${force ? 1 : 0}&v=${volumes ? 1 : 0}`,
        { timeoutMs: 60_000 },
      );
    } catch (error) {
      if (error.status !== 404) throw error;
    }
  }

  async containerLogs(id, { tail = 200, timestamps = false } = {}) {
    const params = new URLSearchParams({
      stdout: "1",
      stderr: "1",
      tail: String(tail),
      timestamps: timestamps ? "1" : "0",
    });
    const { buffer } = await this._rawRequest(
      "GET",
      `/containers/${encodeURIComponent(id)}/logs?${params.toString()}`,
      { timeoutMs: 20_000 },
    );
    return demuxDockerLogs(buffer);
  }

  async imageExists(image) {
    try {
      await this._request("GET", `/images/${encodeURIComponent(image)}/json`, { timeoutMs: 10_000 });
      return true;
    } catch (error) {
      if (error.status === 404) return false;
      throw error;
    }
  }

  async pullImage(image, { onProgress = null, timeoutMs = 10 * 60_000 } = {}) {
    const separator = image.lastIndexOf(":");
    const fromImage = separator > 0 && !image.slice(separator + 1).includes("/") ? image.slice(0, separator) : image;
    const tag = separator > 0 && fromImage !== image ? image.slice(separator + 1) : "latest";
    const params = new URLSearchParams({ fromImage, tag });
    const { status, buffer } = await this._rawRequest("POST", `/images/create?${params.toString()}`, {
      timeoutMs,
      headers: { "X-Registry-Auth": "" },
    });
    const text = buffer.toString("utf8");
    if (status >= 300) {
      throw new Error(parseDockerError(text) || `Docker pull failed with HTTP ${status}`);
    }
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (event?.error) throw new Error(event.error);
      onProgress?.(event);
    }
    return true;
  }
}

let sharedClient = null;

export function getDockerClient() {
  if (!sharedClient) sharedClient = new DockerClient();
  return sharedClient;
}

export function setDockerClientForTests(client) {
  sharedClient = client;
  return sharedClient;
}
