/**
 * agy-gateway — tiny OpenAI-compatible HTTP wrapper around the official
 * Antigravity CLI.
 *
 * One container per account; ultrarouter talks to this server over a loopback-only
 * published port. The wrapper never touches Google directly: it spawns `agy`
 * with the container's cached credentials.
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  buildChatArgs,
  buildModelsArgs,
  buildPrompt,
  buildUsageArgs,
  contentToText,
  mapAgyError,
  normalizeToolArguments,
  openAiChunk,
  openAiErrorBody,
  parseModelList,
  parseStreamEvent,
  parseUsageEnvelope,
  textDeltaFromEvent,
  toOpenAiUsage,
  usageFromEvent,
} from "./lib.mjs";

const PORT = Number(process.env.PORT) || 8787;
const TOKEN = process.env.GATEWAY_TOKEN || "";
const ALLOW_NO_AUTH = process.env.GATEWAY_ALLOW_NO_AUTH === "1";
const AGY_BIN = process.env.AGY_BIN || "agy";
const AGY_MODE = process.env.AGY_MODE || "plan";
const PRINT_TIMEOUT_SEC = Math.max(0, Number(process.env.AGY_PRINT_TIMEOUT_SEC) || 0);
const TURN_TIMEOUT_MS = Math.max(30_000, Number(process.env.AGY_TURN_TIMEOUT_MS) || 600_000);
const LOGIN_TIMEOUT_MS = Math.max(60_000, Number(process.env.AGY_LOGIN_TIMEOUT_MS) || 20 * 60_000);
const MODELS_CACHE_MS = Math.max(10_000, Number(process.env.AGY_MODELS_CACHE_MS) || 10 * 60_000);
const USAGE_CACHE_MS = Math.max(5_000, Number(process.env.AGY_USAGE_CACHE_MS) || 30_000);
const MAX_BODY_BYTES = 20 * 1024 * 1024;
const WORKDIR = process.env.AGY_WORKDIR || process.cwd();
const MCP_SERVER_NAME = process.env.AGY_MCP_NAME || "ultrarouter";

// Per-turn tool bridge state (Phase 4): activeTurn holds the current request's
// OpenAI tool schemas and any tool the CLI asked us to execute. The client runs
// the tool itself, so the turn ends and the call goes back as tool_calls.
let activeTurn = null;
let seededToolResults = new Map();
const toolCallNames = new Map(); // tool_call id → tool name

function log(level, message, extra) {
  const line = `[agy-gateway] ${level.toUpperCase()} ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`;
  if (level === "error") console.error(line);
  else console.log(line);
}

// ─── process helpers ──────────────────────────────────────────────────────────

/**
 * Spawn `agy` with the same unprivileged uid as the container.
 * `detached` gives the CLI its own process group so its clean-up signals cannot
 * reach the server's group.
 */
function spawnAgy(args, { stdio = ["ignore", "pipe", "pipe"], detached = true } = {}) {
  return spawn(AGY_BIN, args, { cwd: WORKDIR, env: process.env, stdio, detached });
}

function runProcess(args, { input = null, timeoutMs = 60_000 } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnAgy(args, {
        stdio: [input == null ? "ignore" : "pipe", "pipe", "pipe"],
      });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: error?.message || String(error) });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish({ code: null, stdout, stderr: `${stderr}\ncommand timed out after ${timeoutMs}ms`.trim(), timedOut: true });
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });
    child.stdin?.on("error", () => { /* ignore EPIPE */ });
    child.stdout?.on("error", () => { /* ignore */ });
    child.stderr?.on("error", () => { /* ignore */ });
    child.on("error", (error) => {
      finish({
        code: -1,
        stdout,
        stderr: error?.code === "ENOENT" ? `${AGY_BIN}: not found` : error?.message || String(error),
        notFound: error?.code === "ENOENT",
      });
    });
    child.on("close", (code) => finish({ code, stdout, stderr }));

    if (input != null) {
      child.stdin?.end(String(input));
    }
  });
}

// ─── caches ───────────────────────────────────────────────────────────────────

let modelsCache = { at: 0, models: null };
let usageCache = { at: 0, data: null };
let versionCache = null;

async function getModels({ force = false } = {}) {
  if (!force && modelsCache.models && Date.now() - modelsCache.at < MODELS_CACHE_MS) {
    return modelsCache.models;
  }
  const result = await runProcess(buildModelsArgs(), { timeoutMs: 60_000 });
  const models = parseModelList(result.stdout);
  if (models.length === 0) {
    const error = new Error(result.stderr.trim() || "agy models returned no models (not signed in?)");
    error.stderr = result.stderr;
    throw error;
  }
  modelsCache = { at: Date.now(), models };
  return models;
}

async function getVersion() {
  if (versionCache) return versionCache;
  const result = await runProcess(["--version"], { timeoutMs: 20_000 });
  versionCache = (result.stdout || result.stderr || "").trim().split("\n")[0] || null;
  return versionCache;
}

async function getUsage({ force = false } = {}) {
  if (!force && usageCache.data && Date.now() - usageCache.at < USAGE_CACHE_MS) {
    return usageCache.data;
  }
  const result = await runProcess(buildUsageArgs(), { timeoutMs: 60_000 });
  const envelope = (() => {
    try { return JSON.parse(result.stdout); } catch { return null; }
  })();
  if (!envelope) {
    throw new Error(result.stderr.trim() || "agy /usage returned invalid JSON");
  }
  const data = { ...parseUsageEnvelope(envelope), fetchedAt: new Date().toISOString() };
  usageCache = { at: Date.now(), data };
  return data;
}

// ─── login (relay) ────────────────────────────────────────────────────────────

let login = null;
const GOOGLE_URL_RE = /https:\/\/accounts\.google\.com\/o\/oauth2\/auth\?[^\s"'<>]+/;

function loginState() {
  if (!login) return { pending: false, loginId: null, url: null, done: false };
  return { pending: !login.done, loginId: login.id, url: login.url, done: login.done };
}

function startLogin() {
  if (login && !login.done) return loginState();

  const id = crypto.randomUUID();
  const child = spawnAgy(["acp", "--login"], {
    stdio: ["pipe", "pipe", "pipe"],
    detached: true,
  });

  const entry = { id, child, url: null, done: false, startedAt: Date.now(), output: "" };
  login = entry;

  let buffer = "";
  let settled = false;
  const timer = setTimeout(() => {
    if (entry.done) return;
    entry.done = true;
    try { child.kill("SIGKILL"); } catch { /* ignore */ }
    log("warn", "login timed out");
  }, LOGIN_TIMEOUT_MS);

  const handleChunk = (chunk) => {
    const text = chunk.toString();
    entry.output = (entry.output + text).slice(-8000);
    if (entry.url) return;
    buffer = (buffer + text).slice(-16000);
    const match = buffer.match(GOOGLE_URL_RE);
    if (match) entry.url = match[0];
  };

  child.stdout?.on("data", handleChunk);
  child.stderr?.on("data", handleChunk);

  // A killed login process emits EPIPE/ERR_STREAM errors on its pipes. Without a
  // listener those become unhandled 'error' events and crash the whole gateway.
  child.stdin?.on("error", () => { /* login died; handled via close */ });
  child.stdout?.on("error", () => { /* ignore */ });
  child.stderr?.on("error", () => { /* ignore */ });

  child.on("error", (error) => {
    entry.done = true;
    entry.error = error?.code === "ENOENT" ? `${AGY_BIN}: not found` : error?.message || String(error);
    clearTimeout(timer);
  });

  child.on("close", (code) => {
    entry.exitCode = code;
    entry.done = true;
    clearTimeout(timer);
    log("info", "login process exited", { code });
  });

  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = setInterval(() => {
      if (entry.url) {
        clearInterval(poll);
        resolve({ loginId: id, url: entry.url });
        return;
      }
      if (entry.done || entry.error) {
        clearInterval(poll);
        reject(new Error(entry.error || `agy login exited before printing a URL: ${entry.output.slice(-400)}`));
        return;
      }
      if (Date.now() - started > 60_000) {
        clearInterval(poll);
        reject(new Error("agy login did not print an authorization URL in 60s"));
      }
    }, 150);
  });
}

function completeLogin(input) {
  return new Promise((resolve, reject) => {
    if (!login || login.done) {
      reject(new Error("no login in progress"));
      return;
    }
    const entry = login;
    const value = String(input || "").trim();
    if (!value) {
      reject(new Error("authorization code or callback URL is required"));
      return;
    }
    try {
      entry.child.stdin.write(`${value}\n`);
    } catch (error) {
      reject(new Error(`cannot write to agy login: ${error.message}`));
      return;
    }

    const started = Date.now();
    const poll = setInterval(async () => {
      if (!entry.done) {
        if (Date.now() - started > 120_000) {
          clearInterval(poll);
          reject(new Error("agy login did not finish in 120s"));
        }
        return;
      }
      clearInterval(poll);
      if (entry.exitCode !== 0) {
        reject(new Error(entry.error || `agy login failed (exit ${entry.exitCode}): ${entry.output.slice(-400)}`));
        return;
      }
      try {
        const models = await getModels({ force: true });
        resolve({ email: extractEmail(entry.output), models });
      } catch (error) {
        reject(new Error(`login exited but agy is not usable: ${error.message}`));
      }
    }, 300);
  });
}

function extractEmail(output) {
  const match = String(output || "").match(/[\w.+-]+@[\w-]+\.[\w.-]+/);
  return match ? match[0] : null;
}

// ─── tool bridge (MCP) ───────────────────────────────────────────────────────

function toMcpTools(tools = []) {
  return (Array.isArray(tools) ? tools : [])
    .map((tool) => {
      const fn = tool?.function || tool;
      if (!fn?.name) return null;
      return {
        name: fn.name,
        description: fn.description || "",
        inputSchema: fn.parameters || { type: "object", properties: {} },
      };
    })
    .filter(Boolean);
}

function collectSeededToolResults(messages = []) {
  const seeded = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.role !== "tool") continue;
    const name = message.name || toolCallNames.get(message.tool_call_id);
    if (!name) continue;
    const text = contentToText(message.content);
    if (text) seeded.set(name, text);
  }
  return seeded;
}

function toolCallPayload(calls) {
  return calls.map((call, index) => ({
    index,
    id: call.id,
    type: "function",
    function: {
      name: call.name,
      arguments: JSON.stringify(call.arguments || {}),
    },
  }));
}

/**
 * Minimal MCP server over HTTP. agy registers it with `agy mcp add`, lists the
 * current request's tools, and calls a tool when it wants the client to act.
 * The handler answers "pending", ends the turn, and the caller emits OpenAI
 * tool_calls so the client can execute the tool and send the result back.
 */
function handleMcpRequest(res, message) {
  const { id, method, params } = message || {};
  const reply = (result) => sendJson(res, 200, { jsonrpc: "2.0", id, result });
  const fail = (code, text) => sendJson(res, 200, { jsonrpc: "2.0", id, error: { code, message: text } });

  if (!method) return sendJson(res, 202, {});

  if (method === "initialize") {
    return reply({
      protocolVersion: params?.protocolVersion || "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: "1.0.0" },
    });
  }

  if (method === "notifications/initialized") {
    res.writeHead(202);
    res.end();
    return;
  }

  if (method === "ping") return reply({});

  if (method === "tools/list") {
    return reply({ tools: toMcpTools(activeTurn?.tools || []) });
  }

  if (method === "tools/call") {
    log("info", "mcp tools/call", { params: JSON.stringify(params || {}).slice(0, 500) });
    const rawName = String(params?.name || "");
    const knownNames = (activeTurn?.tools || [])
      .map((tool) => tool?.function?.name || tool?.name)
      .filter(Boolean);
    const name = knownNames.find((candidate) => rawName === candidate || rawName.endsWith(`_${candidate}`) || rawName.endsWith(candidate)) || rawName;

    const seeded = seededToolResults.get(name);
    if (seeded !== undefined) {
      seededToolResults.delete(name);
      return reply({ content: [{ type: "text", text: String(seeded) }] });
    }

    if (activeTurn) {
      const callId = `call_${crypto.randomUUID()}`;
      const toolDef = (activeTurn.tools || []).find((tool) => {
        const toolName = tool?.function?.name || tool?.name;
        return toolName === name;
      });
      const args = normalizeToolArguments(toolDef, params?.arguments || {});
      activeTurn.toolCalls.push({ id: callId, name, arguments: args });
      toolCallNames.set(callId, name);
      log("info", "tool call requested by CLI", { name: rawName, resolved: name, arguments: JSON.stringify(args).slice(0, 500) });
      // Stop the turn: the client must execute the tool before the model can
      // continue. 50ms lets the MCP response flush first.
      setTimeout(() => {
        try { activeTurn?.child?.kill("SIGKILL"); } catch { /* ignore */ }
      }, 50).unref();
    }

    return reply({ content: [{ type: "text", text: "(waiting for client tool result)" }] });
  }

  return fail(-32601, `method not found: ${method}`);
}

async function registerMcpServer() {
  try {
    const url = `http://127.0.0.1:${PORT}/v1/mcp`;
    const result = await runProcess(
      ["mcp", "add", "-H", `Authorization: Bearer ${TOKEN}`, MCP_SERVER_NAME, url],
      { timeoutMs: 30_000 },
    );
    log("info", "mcp registration", { code: result.code, detail: (result.stderr || "").slice(0, 200) });
  } catch (error) {
    log("warn", "mcp registration failed", { error: error?.message || String(error) });
  }
}

// ─── chat turn ────────────────────────────────────────────────────────────────

function runTurn({ model, prompt, onDelta, signal, allowTools = false }) {
  return new Promise((resolve) => {
    const args = buildChatArgs({
      model,
      prompt,
      mode: AGY_MODE,
      printTimeoutSec: PRINT_TIMEOUT_SEC,
      allowTools,
    });

    let child;
    try {
      child = spawnAgy(args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, text: "", stderr: error?.message || String(error), usage: null, result: null });
      return;
    }

    if (activeTurn) activeTurn.child = child;

    // Send the prompt on stdin (never argv): long histories otherwise hit
    // Linux's 128 KiB per-argument limit and spawn fails with E2BIG.
    try {
      child.stdin?.on("error", () => { /* turn/close handler reports the failure */ });
      child.stdin?.write(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);
      child.stdin?.end();
    } catch (error) {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve({ ok: false, text: "", stderr: `cannot write prompt to agy stdin: ${error?.message || error}`, usage: null, result: null });
      return;
    }

    if (process.env.AGY_DEBUG_SPAWN === "1") {
      try {
        const comm = fs.readFileSync(`/proc/${child.pid}/comm`, "utf8").trim();
        const stat = fs.readFileSync(`/proc/${child.pid}/stat`, "utf8").split(" ");
        log("info", "spawned", { serverPid: process.pid, childPid: child.pid, comm, ppid: stat[3] });
      } catch { /* ignore */ }
      setTimeout(() => {
        try {
          const status = fs.readFileSync(`/proc/${child.pid}/status`, "utf8");
          const uid = /^Uid:\s+(.*)$/m.exec(status)?.[1] || null;
          const cap = /^CapEff:\s+(.*)$/m.exec(status)?.[1] || null;
          const comm = fs.readFileSync(`/proc/${child.pid}/comm`, "utf8").trim();
          log("info", "spawn-check", { pid: child.pid, comm, uid, cap });
        } catch { /* ignore */ }
      }, 900).unref();
    }

    let stdoutBuffer = "";
    let stderr = "";
    let text = "";
    let usage = null;
    let result = null;
    let settled = false;
    let aborted = false;

    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idleTimer);
      signal?.removeEventListener?.("abort", onAbort);
      resolve({ ...payload, toolCalls: activeTurn ? [...activeTurn.toolCalls] : [] });
    };

    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      finish({ ok: false, text, stderr: `${stderr}\nturn timed out after ${TURN_TIMEOUT_MS}ms`.trim(), usage, result });
    }, TURN_TIMEOUT_MS);

    const onAbort = () => {
      aborted = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    };
    if (signal?.aborted) onAbort();
    signal?.addEventListener?.("abort", onAbort, { once: true });

    // If the CLI stalls without producing a result, kill it after 5 min idle.
    let idleTimer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, 5 * 60_000);
    const bumpIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
      }, 5 * 60_000);
    };

    child.stdout?.on("data", (chunk) => {
      bumpIdle();
      stdoutBuffer += chunk.toString();
      let index;
      while ((index = stdoutBuffer.indexOf("\n")) >= 0) {
        const line = stdoutBuffer.slice(0, index);
        stdoutBuffer = stdoutBuffer.slice(index + 1);
        const event = parseStreamEvent(line);
        if (!event) continue;
        if (event.event === "step_update") {
          const delta = textDeltaFromEvent(event);
          if (delta) {
            text += delta;
            onDelta?.(delta);
          }
          const stepUsage = usageFromEvent(event);
          if (stepUsage) usage = stepUsage;
        } else if (event.event === "result") {
          result = event.result || null;
          if (result?.response && !text) {
            text = result.response;
            onDelta?.(text);
          }
          const resultUsage = usageFromEvent(event);
          if (resultUsage) usage = resultUsage;
        }
      }
    });

    child.stderr?.on("data", (chunk) => {
      bumpIdle();
      stderr += chunk.toString();
    });

    // Same EPIPE guard as the login path: a killed turn must not take the server down.
    child.stdout?.on("error", () => { /* ignore */ });
    child.stderr?.on("error", () => { /* ignore */ });

    child.on("error", (error) => {
      finish({
        ok: false,
        text,
        stderr: error?.code === "ENOENT" ? `${AGY_BIN}: not found` : error?.message || String(error),
        usage,
        result,
      });
    });

    child.on("close", (code) => {
      const hasError = Boolean(result && result.status === "ERROR") || /AGY_ERROR:/.test(stderr) || code !== 0;
      finish({ ok: !hasError && Boolean(text), empty: !hasError && !text, text, stderr, usage, result, aborted, code });
    });
  });
}

// ─── HTTP plumbing ────────────────────────────────────────────────────────────

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

function sendError(res, status, code, message, extra = {}) {
  sendJson(res, status, {
    error: { message, type: "agy_error", code, ...extra },
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (error) {
        reject(new Error(`invalid JSON body: ${error.message}`));
      }
    });
    req.on("error", reject);
  });
}

function authorized(req) {
  if (!TOKEN) return ALLOW_NO_AUTH;
  const header = String(req.headers.authorization || "");
  const value = header.startsWith("Bearer ") ? header.slice(7) : "";
  const given = Buffer.from(value);
  const expected = Buffer.from(TOKEN);
  return given.length === expected.length && crypto.timingSafeEqual(given, expected);
}

let serialChain = Promise.resolve();
function serialize(task) {
  const run = serialChain.then(task, task);
  serialChain = run.catch(() => {});
  return run;
}

function sseWrite(res, payload) {
  res.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
}

async function handleChat(req, res, body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  if (messages.length === 0) {
    sendError(res, 400, "AGY_BAD_REQUEST", "messages[] is required");
    return;
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  const prompt = buildPrompt(messages, {
    preamble: typeof body.agy_preamble === "string" ? body.agy_preamble : undefined,
  });
  const id = `chatcmpl-${crypto.randomUUID()}`;
  const created = Math.floor(Date.now() / 1000);
  const stream = body.stream === true;

  const abort = new AbortController();
  let clientGone = false;
  req.on("close", () => {
    clientGone = true;
    abort.abort();
  });

  await serialize(async () => {
    if (stream) {
      let started = false;
      // Do not send headers until there is something to stream. A banned or
      // logged-out account fails the turn before its first token; sending a
      // 200 + role chunk first would make ultrarouter see an empty stream instead
      // of the real 403, so it could not mark the account or fail over.
      const startStream = () => {
        if (started) return;
        started = true;
        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        sseWrite(res, openAiChunk({ id, model, delta: { role: "assistant" } }));
      };

      activeTurn = { tools: Array.isArray(body?.tools) ? body.tools : [], toolCalls: [], child: null };
      seededToolResults = collectSeededToolResults(messages);

      const turn = await runTurn({
        model,
        prompt,
        signal: abort.signal,
        allowTools: Array.isArray(body?.tools) && body.tools.length > 0,
        onDelta: (delta) => {
          if (clientGone) return;
          startStream();
          sseWrite(res, openAiChunk({ id, model, delta: { content: delta } }));
        },
      });
      activeTurn = null;

      if (clientGone) return;

      const toolCalls = turn.toolCalls || [];
      if (toolCalls.length > 0) {
        startStream();
        sseWrite(res, openAiChunk({ id, model, delta: { tool_calls: toolCallPayload(toolCalls) } }));
        const finalTool = openAiChunk({ id, model, delta: {}, finishReason: "tool_calls" });
        if (turn.usage) finalTool.usage = turn.usage;
        sseWrite(res, finalTool);
        sseWrite(res, "[DONE]");
        res.end();
        return;
      }

      if (!turn.ok) {
        const mapped = turn.empty
          ? {
              status: 502,
              code: "AGY_EMPTY_RESPONSE",
              message: "agy returned no text for this turn. Client tool calls are not bridged yet (Phase 4).",
              retryable: false,
              errorId: null,
            }
          : mapAgyError({ stderr: turn.stderr, result: turn.result });
        log("warn", "turn failed", {
          code: mapped.code,
          status: mapped.status,
          errorId: mapped.errorId,
          message: mapped.message,
          stderr: String(turn.stderr || "").slice(-1000),
        });
        if (!started) {
          sendJson(res, mapped.status, openAiErrorBody(mapped));
          return;
        }
        sseWrite(res, openAiErrorBody(mapped));
        sseWrite(res, "[DONE]");
        res.end();
        return;
      }

      startStream();
      const finalChunk = openAiChunk({ id, model, delta: {}, finishReason: "stop" });
      if (turn.usage) finalChunk.usage = turn.usage;
      sseWrite(res, finalChunk);
      sseWrite(res, "[DONE]");
      res.end();
      return;
    }

    activeTurn = { tools: Array.isArray(body?.tools) ? body.tools : [], toolCalls: [], child: null };
    seededToolResults = collectSeededToolResults(messages);

    const turn = await runTurn({
      model,
      prompt,
      signal: abort.signal,
      allowTools: Array.isArray(body?.tools) && body.tools.length > 0,
    });
    activeTurn = null;
    if (clientGone) return;

    const toolCalls = turn.toolCalls || [];
    if (toolCalls.length > 0) {
      sendJson(res, 200, {
        id,
        object: "chat.completion",
        created,
        model,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: null, tool_calls: toolCallPayload(toolCalls) },
            finish_reason: "tool_calls",
          },
        ],
        usage: turn.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      });
      return;
    }

    if (!turn.ok) {
      const mapped = turn.empty
        ? {
            status: 502,
            code: "AGY_EMPTY_RESPONSE",
            message: "agy returned no text for this turn. Client tool calls are not bridged yet (Phase 4).",
            retryable: false,
            errorId: null,
          }
        : mapAgyError({ stderr: turn.stderr, result: turn.result });
      log("warn", "turn failed", {
        code: mapped.code,
        status: mapped.status,
        errorId: mapped.errorId,
        message: mapped.message,
        stderr: String(turn.stderr || "").slice(-1000),
      });
      sendJson(res, mapped.status, openAiErrorBody(mapped));
      return;
    }

    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: turn.text },
          finish_reason: "stop",
        },
      ],
      usage: turn.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    });
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (url.pathname === "/health") {
      const version = await getVersion().catch(() => null);
      let authOk = false;
      let models = [];
      try {
        models = await getModels();
        authOk = models.length > 0;
      } catch {
        authOk = false;
      }
      sendJson(res, 200, {
        ok: true,
        service: "agy-gateway",
        agyVersion: version,
        authOk,
        modelCount: models.length,
        pendingLogin: Boolean(login && !login.done && login.url),
        workdir: WORKDIR,
        uptimeSec: Math.round(process.uptime()),
      });
      return;
    }

    if (!authorized(req)) {
      sendError(res, 401, "AGY_UNAUTHORIZED", "missing or invalid gateway token");
      return;
    }

    try {
      if (req.method === "POST" && url.pathname === "/v1/mcp") {
        const body = await readBody(req);
        handleMcpRequest(res, body);
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/models") {
        const models = await getModels();
        sendJson(res, 200, {
          object: "list",
          data: models.map((model) => ({
            id: model.id,
            object: "model",
            created: 0,
            owned_by: "antigravity-cli",
            name: model.name,
          })),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/v1/usage") {
        const usage = await getUsage({ force: url.searchParams.get("force") === "1" });
        sendJson(res, 200, usage);
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = await readBody(req);
        await handleChat(req, res, body);
        return;
      }

      if (req.method === "POST" && url.pathname === "/auth/start") {
        const state = startLogin();
        sendJson(res, 200, await state);
        return;
      }

      if (req.method === "POST" && url.pathname === "/auth/complete") {
        const body = await readBody(req);
        const result = await completeLogin(body?.input);
        sendJson(res, 200, { ok: true, email: result.email, models: result.models });
        return;
      }

      if (req.method === "GET" && url.pathname === "/auth/status") {
        sendJson(res, 200, loginState());
        return;
      }

      sendError(res, 404, "AGY_NOT_FOUND", `no route for ${req.method} ${url.pathname}`);
    } catch (error) {
      log("error", "request failed", { path: url.pathname, error: error?.message || String(error) });
      if (!res.headersSent) {
        sendError(res, 502, "AGY_INTERNAL", error?.message || String(error));
      } else {
        try { res.end(); } catch { /* ignore */ }
      }
    }
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  if (!TOKEN && !ALLOW_NO_AUTH) {
    log("error", "GATEWAY_TOKEN is required (set GATEWAY_ALLOW_NO_AUTH=1 only for local dev)");
    process.exit(1);
  }
  const server = createServer();
  server.timeout = 0;
  server.headersTimeout = 0;
  server.requestTimeout = 0;
  server.listen(PORT, "0.0.0.0", () => {
    log("info", `listening on :${PORT}`, { agyBin: AGY_BIN, mode: AGY_MODE, workdir: WORKDIR });
    // Register (or refresh) the tool-bridge MCP server inside agy's config.
    registerMcpServer();
  });
  const shutdown = (signal = "signal") => {
    log("warn", `received ${signal}, shutting down`);
    try { login?.child?.kill("SIGKILL"); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // Terminal hangup from a CLI child's process-group clean-up must not stop the proxy.
  process.on("SIGHUP", () => log("warn", "ignored SIGHUP"));
}
