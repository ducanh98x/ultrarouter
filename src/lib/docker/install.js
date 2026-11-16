/**
 * Docker bootstrap for the Antigravity CLI provider.
 *
 * ultrarouter runs directly on the host, so it can install and drive a local Docker
 * daemon. Everything here is idempotent and never reboots the machine; when an
 * automatic install is not possible it returns the exact commands the user can
 * paste into a shell.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { platform, userInfo } from "node:os";
import { getDockerClient } from "./client.js";
import { AGY_IMAGE, AGY_IMAGE_TAG, agyImageRef } from "./agyContainers.js";

export const DOCKER_SETUP_COMMANDS = [
  "sudo apt-get update",
  "sudo apt-get install -y docker.io",
  "sudo systemctl enable --now docker",
  "sudo usermod -aG docker $USER",
  "# then restart ultrarouter (or log out and back in) so the docker group applies",
];

export function runCommand(command, args = [], { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      done({ ok: false, code: null, stdout, stderr: `${stderr}\ncommand timed out after ${timeoutMs}ms`.trim(), command, timedOut: true });
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      done({
        ok: false,
        code: null,
        stdout,
        stderr: error?.code === "ENOENT" ? `${command}: not found` : error?.message || String(error),
        command,
        notFound: error?.code === "ENOENT",
      });
    });

    child.on("exit", (code) => {
      clearTimeout(timer);
      done({ ok: code === 0, code, stdout, stderr, command });
    });
  });
}

function isPermissionError(message) {
  return /permission denied|eacces|eperm/i.test(String(message || ""));
}

function isDaemonMissing(message) {
  return /cannot connect|no such file or directory|enoent|is the docker daemon running|connection refused/i.test(
    String(message || ""),
  );
}

/**
 * Detect Docker binary, daemon and socket permissions.
 * @param {{ client?: object, osPlatform?: string, run?: Function }} [deps]
 */
export async function detectDocker(deps = {}) {
  const osPlatform = deps.osPlatform || platform();
  const run = deps.run || runCommand;
  const client = deps.client || getDockerClient();

  const binary = await run("docker", ["--version"], { timeoutMs: 15_000 });
  const installed = binary.ok;
  const binaryVersion = installed ? String(binary.stdout || "").trim() : null;

  if (!installed) {
    return {
      ready: false,
      installed: false,
      daemonRunning: false,
      permissionOk: false,
      platform: osPlatform,
      version: null,
      error: binary.notFound ? "docker binary not found" : binary.stderr || "docker --version failed",
      manualCommands: DOCKER_SETUP_COMMANDS,
    };
  }

  let version = null;
  try {
    const info = await client.version();
    version = info?.Version || null;
    return {
      ready: true,
      installed: true,
      daemonRunning: true,
      permissionOk: true,
      platform: osPlatform,
      binaryVersion,
      version,
      error: null,
    };
  } catch (error) {
    const message = error?.message || String(error);
    const permissionOk = !isPermissionError(message);
    return {
      ready: false,
      installed: true,
      daemonRunning: !isDaemonMissing(message),
      permissionOk,
      platform: osPlatform,
      binaryVersion,
      version: null,
      error: permissionOk
        ? `cannot reach the Docker daemon: ${message}`
        : `no permission for the Docker socket: ${message}`,
      manualCommands: DOCKER_SETUP_COMMANDS,
    };
  }
}

/**
 * Install + enable Docker on Ubuntu/Debian. Never reboots, never prompts.
 * @returns {Promise<{ok: boolean, steps: object[], reason?: string}>}
 */
export async function installDocker(deps = {}) {
  const osPlatform = deps.osPlatform || platform();
  const run = deps.run || runCommand;
  const isRoot = deps.isRoot ?? (typeof process.getuid === "function" ? process.getuid() === 0 : false);
  const sudo = deps.sudo !== false && !isRoot;

  if (osPlatform !== "linux") {
    return {
      ok: false,
      reason: "automatic install is only supported on Linux (Ubuntu/Debian)",
      steps: [],
      manualCommands: DOCKER_SETUP_COMMANDS,
    };
  }

  const steps = [];
  const exec = async (label, argv, timeoutMs = 300_000) => {
    const [command, ...args] = sudo ? ["sudo", "-n", ...argv] : argv;
    const result = await run(command, args, { timeoutMs });
    steps.push({ label, ok: result.ok, stderr: result.ok ? "" : result.stderr?.slice(0, 500) || "" });
    return result.ok;
  };

  if (!(await exec("apt-get update", ["apt-get", "update"]))) {
    return { ok: false, reason: "apt-get update failed", steps, manualCommands: DOCKER_SETUP_COMMANDS };
  }
  if (!(await exec("apt-get install docker.io", ["apt-get", "install", "-y", "docker.io"]))) {
    return { ok: false, reason: "apt-get install docker.io failed", steps, manualCommands: DOCKER_SETUP_COMMANDS };
  }

  // systemctl may be absent in containers; treat as non-fatal and let detection decide.
  await exec("systemctl enable --now docker", ["systemctl", "enable", "--now", "docker"]);

  if (!isRoot) {
    let user = "unknown";
    try { user = userInfo().username || user; } catch { /* ignore */ }
    if (user && user !== "root") {
      await exec("usermod -aG docker", ["usermod", "-aG", "docker", user]);
    }
  }

  const requiredOk = steps
    .filter((s) => s.label !== "systemctl enable --now docker" && s.label !== "usermod -aG docker")
    .every((s) => s.ok);
  return { ok: requiredOk, steps };
}

/**
 * Detect, then optionally install when missing.
 */
export async function ensureDocker({ autoInstall = false, ...deps } = {}) {
  const first = await detectDocker(deps);
  if (first.ready) return first;

  if (!autoInstall) {
    return { ...first, installedNow: false };
  }

  const install = await installDocker(deps);
  const after = await detectDocker(deps);
  return {
    ...after,
    installedNow: install.ok && after.installed,
    installSteps: install.steps,
    installReason: install.reason || null,
  };
}

/**
 * Find the agy-gateway Docker build context in the usual layouts:
 * repo checkout, `.next/standalone` runtime, and the published CLI package.
 */
export function resolveAgyBuildContext() {
  const candidates = [
    process.env.ULTRAROUTER_DOCKER_CONTEXT,
    process.env.ULTRAROUTER_ROOT
      ? path.join(process.env.ULTRAROUTER_ROOT, "docker", "agy-gateway")
      : null,
    path.join(process.cwd(), "docker", "agy-gateway"),
    path.join(process.cwd(), "..", "docker", "agy-gateway"),
    path.join(process.cwd(), "..", "..", "docker", "agy-gateway"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(path.join(candidate, "Dockerfile"))) return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

function tailText(value, max = 4000) {
  const text = String(value || "");
  return text.length > max ? text.slice(-max) : text;
}

/**
 * Image status for the Docker card. Never throws: a missing daemon should not
 * break the page.
 */
export async function getAgyImageStatus({ tag = AGY_IMAGE_TAG, image = AGY_IMAGE, client } = {}) {
  const ref = agyImageRef(tag, image);
  const context = resolveAgyBuildContext();
  const manualCommand = `docker build -t ${ref} ${context || "/opt/ultrarouter/docker/agy-gateway"}`;
  try {
    const dockerClient = client || getDockerClient();
    const exists = await dockerClient.imageExists(ref);
    return { ref, image, tag, exists, buildable: Boolean(context), context, manualCommand };
  } catch (error) {
    return {
      ref,
      image,
      tag,
      exists: false,
      buildable: Boolean(context),
      context,
      manualCommand,
      error: error?.message || String(error),
    };
  }
}

let activeImageBuild = null;

async function runAgyImageBuild({ tag, image, force, run, client }) {
  const ref = agyImageRef(tag, image);
  const context = resolveAgyBuildContext();
  const manualCommand = `docker build -t ${ref} ${context || "/opt/ultrarouter/docker/agy-gateway"}`;

  if (!context) {
    return {
      ok: false,
      ref,
      tag,
      image,
      context: null,
      error: "Docker build context not found. Run the build on the host or set ULTRAROUTER_DOCKER_CONTEXT.",
      manualCommand,
    };
  }

  try {
    const dockerClient = client || getDockerClient();
    if (!force && (await dockerClient.imageExists(ref))) {
      return { ok: true, skipped: true, ref, tag, image, context, manualCommand, message: "Gateway image already exists." };
    }
  } catch {
    // Fall through to the build; docker build reports the real daemon error.
  }

  const startedAt = Date.now();
  const result = await run("docker", ["build", "-t", ref, context], { timeoutMs: 30 * 60_000 });
  return {
    ok: result.ok,
    ref,
    tag,
    image,
    context,
    manualCommand,
    durationMs: Date.now() - startedAt,
    stdout: tailText(result.stdout),
    stderr: tailText(result.stderr),
    error: result.ok ? null : result.timedOut ? "Docker build timed out" : tailText(result.stderr) || "Docker build failed",
  };
}

/**
 * Build the agy-gateway image locally. Concurrent callers share one build so a
 * double click cannot start two Docker builds.
 */
export function buildAgyImage({ tag = AGY_IMAGE_TAG, image = AGY_IMAGE, force = false, run = runCommand, client } = {}) {
  if (activeImageBuild) return activeImageBuild;
  activeImageBuild = runAgyImageBuild({ tag, image, force, run, client }).finally(() => {
    activeImageBuild = null;
  });
  return activeImageBuild;
}
