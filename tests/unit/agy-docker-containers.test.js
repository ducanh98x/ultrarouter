import { describe, it, expect } from "vitest";
import {
  AGY_WRAPPER_PORT,
  baseUrlForHostPort,
  buildContainerSpec,
  containerNameFor,
  normalizeProxyUrl,
  parseMemoryBytes,
  pickHostPort,
  volumeNameFor,
} from "@/lib/docker/agyContainers.js";
import { demuxDockerLogs, resolveDockerEndpoint } from "@/lib/docker/client.js";

describe("agy container naming", () => {
  it("uses the first 8 alphanumerics of the connection id", () => {
    expect(containerNameFor("1a2b3c4d-1111-2222-3333-444455556666")).toBe("9router-agy-1a2b3c4d");
    expect(containerNameFor("")).toBe("9router-agy-unknown");
    expect(volumeNameFor("1a2b3c4d-1111")).toBe("9router-agy-1a2b3c4d");
  });
});

describe("buildContainerSpec", () => {
  const base = {
    connectionId: "1a2b3c4d-1111-2222-3333-444455556666",
    hostPort: 20801,
    gatewayToken: "tok",
    image: "9router/agy-gateway:1.5.9",
  };

  it("publishes the wrapper port on loopback only", () => {
    const spec = buildContainerSpec(base);
    expect(spec.ExposedPorts).toEqual({ [`${AGY_WRAPPER_PORT}/tcp`]: {} });
    expect(spec.HostConfig.PortBindings[`${AGY_WRAPPER_PORT}/tcp`]).toEqual([
      { HostIp: "127.0.0.1", HostPort: "20801" },
    ]);
  });

  it("keeps HOME on a named volume and makes the rootfs read-only", () => {
    const spec = buildContainerSpec(base);
    expect(spec.HostConfig.Binds).toEqual(["9router-agy-1a2b3c4d:/data"]);
    expect(spec.Env).toContain("HOME=/data");
    expect(spec.HostConfig.ReadonlyRootfs).toBe(true);
    expect(spec.HostConfig.Tmpfs["/tmp"]).toContain("size=");
    expect(spec.WorkingDir).toBe("/data/work");
  });

  it("labels the container so reconcile can find it", () => {
    const spec = buildContainerSpec(base);
    expect(spec.Labels["9router.managed"]).toBe("true");
    expect(spec.Labels["9router.component"]).toBe("agy-gateway");
    expect(spec.Labels["9router.connection"]).toBe(base.connectionId);
  });

  it("injects the account proxy only when configured", () => {
    const withProxy = buildContainerSpec({ ...base, proxyUrl: "http://u:p@10.0.0.1:8080" });
    expect(withProxy.Env).toContain("HTTPS_PROXY=http://u:p@10.0.0.1:8080");
    expect(withProxy.Env).toContain("HTTP_PROXY=http://u:p@10.0.0.1:8080");
    expect(withProxy.Env).toContain("ALL_PROXY=http://u:p@10.0.0.1:8080");

    const direct = buildContainerSpec(base);
    expect(direct.Env.some((entry) => entry.startsWith("HTTPS_PROXY="))).toBe(false);
    expect(direct.Env).toContain("NO_PROXY=localhost,127.0.0.1");
  });

  it("normalizes the host:port:user:pass proxy form before injecting it", () => {
    const spec = buildContainerSpec({ ...base, proxyUrl: "14.178.215.121:14154:2a:2A123" });
    expect(spec.Env).toContain("HTTPS_PROXY=http://2a:2A123@14.178.215.121:14154");
  });

  it("applies resource limits and drops capabilities", () => {
    const spec = buildContainerSpec({ ...base, memory: "2g", cpus: 2, pidsLimit: 128 });
    expect(spec.HostConfig.Memory).toBe(2 * 1024 ** 3);
    expect(spec.HostConfig.NanoCpus).toBe(2_000_000_000);
    expect(spec.HostConfig.PidsLimit).toBe(128);
    expect(spec.HostConfig.CapDrop).toEqual(["ALL"]);
    expect(spec.HostConfig.SecurityOpt).toContain("no-new-privileges");
    expect(spec.HostConfig.RestartPolicy.Name).toBe("unless-stopped");
  });

  it("requires the identifying fields", () => {
    expect(() => buildContainerSpec({ ...base, connectionId: "" })).toThrow(/connectionId/);
    expect(() => buildContainerSpec({ ...base, hostPort: 0 })).toThrow(/hostPort/);
    expect(() => buildContainerSpec({ ...base, gatewayToken: "" })).toThrow(/gatewayToken/);
  });
});

describe("normalizeProxyUrl", () => {
  it("passes a full URL through unchanged", () => {
    expect(normalizeProxyUrl("http://u:p@1.2.3.4:8080")).toBe("http://u:p@1.2.3.4:8080");
  });

  it("converts host:port:user:pass", () => {
    expect(normalizeProxyUrl("14.178.215.121:14154:2a:2A123")).toBe(
      "http://2a:2A123@14.178.215.121:14154",
    );
  });

  it("converts bare host:port", () => {
    expect(normalizeProxyUrl("1.2.3.4:8080")).toBe("http://1.2.3.4:8080");
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeProxyUrl("")).toBe("");
    expect(normalizeProxyUrl(null)).toBe("");
  });
});

describe("helpers", () => {
  it("parses memory strings", () => {
    expect(parseMemoryBytes("1g")).toBe(1024 ** 3);
    expect(parseMemoryBytes("512m")).toBe(512 * 1024 ** 2);
    expect(parseMemoryBytes("1024")).toBe(1024);
    expect(parseMemoryBytes("nope")).toBe(1024 ** 3);
  });

  it("builds the loopback base URL", () => {
    expect(baseUrlForHostPort(20801)).toBe("http://127.0.0.1:20801/v1");
  });

  it("skips ports that are already taken", async () => {
    const taken = new Set([20800, 20801, 20802]);
    const port = await pickHostPort({
      range: [20800, 20805],
      isFree: async (candidate) => !taken.has(candidate),
      randomInt: () => 0,
    });
    expect(port).toBe(20803);
  });

  it("resolves the docker endpoint from DOCKER_HOST or the OS default", () => {
    expect(resolveDockerEndpoint({ DOCKER_HOST: "unix:///tmp/d.sock" }, "linux")).toEqual({
      socketPath: "/tmp/d.sock",
    });
    expect(resolveDockerEndpoint({ DOCKER_HOST: "tcp://10.0.0.5:2376" }, "linux")).toEqual({
      host: "10.0.0.5",
      port: 2376,
    });
    expect(resolveDockerEndpoint({}, "linux")).toEqual({ socketPath: "/var/run/docker.sock" });
    expect(resolveDockerEndpoint({}, "win32")).toEqual({ socketPath: "//./pipe/docker_engine" });
  });
});

describe("demuxDockerLogs", () => {
  function frame(stream, text) {
    const payload = Buffer.from(text, "utf8");
    const header = Buffer.alloc(8);
    header[0] = stream;
    header.writeUInt32BE(payload.length, 4);
    return Buffer.concat([header, payload]);
  }

  it("joins stdout and stderr frames in order", () => {
    const buffer = Buffer.concat([frame(1, "hello "), frame(2, "world\n")]);
    expect(demuxDockerLogs(buffer)).toBe("hello world\n");
  });

  it("returns plain text when the stream is not framed", () => {
    expect(demuxDockerLogs(Buffer.from("plain log line\n"))).toBe("plain log line\n");
  });
});
