/**
 * Pure helpers for the agy-gateway wrapper (no I/O here, safe to unit test).
 */

export const DEFAULT_PREAMBLE =
  "Reply directly with only the answer. Do not greet or acknowledge this instruction.";

export const DEFAULT_MODE = "plan";

export function contentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "text") return part.text || "";
        if (part?.type === "image_url" || part?.type === "input_image") return "[image omitted]";
        return part?.text || "";
      })
      .join("\n")
      .trim();
  }
  if (content == null) return "";
  return String(content);
}

/**
 * Flatten an OpenAI chat history into the single prompt `agy -p` accepts.
 * agy is an agent, not a completion endpoint: a short preamble keeps output
 * clean (measured ~0.6s faster per turn on the VPS) and suppresses greetings.
 */
export function buildPrompt(messages = [], { preamble = DEFAULT_PREAMBLE } = {}) {
  const system = [];
  const turns = [];

  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message) continue;
    const role = message.role || "user";
    const text = contentToText(message.content);

    if (role === "system" || role === "developer") {
      if (text) system.push(text);
      continue;
    }
    if (role === "tool" || role === "function") {
      const label = message.name || message.tool_call_id || "tool";
      turns.push(`Tool result (${label}): ${text}`);
      continue;
    }
    if (role === "assistant") {
      const toolNames = Array.isArray(message.tool_calls)
        ? message.tool_calls.map((call) => call?.function?.name).filter(Boolean)
        : [];
      const line = [text, toolNames.length ? `[called tools: ${toolNames.join(", ")}]` : ""]
        .filter(Boolean)
        .join("\n");
      if (line) turns.push(`Assistant: ${line}`);
      continue;
    }
    if (text) turns.push(`User: ${text}`);
  }

  return [preamble, ...system, turns.join("\n\n")].filter(Boolean).join("\n\n").trim();
}

const MCP_SERVER_NAME = process.env.AGY_MCP_NAME || "ultrarouter";

// The CLI's own tools (shell/files/web) must never run inside the gateway
// container. Only the per-request MCP bridge is allowed; the client executes
// those tools on its own machine. Deny rules take precedence over
// --dangerously-skip-permissions (verified on agy 1.5.9).
export const AGY_PERMISSION_SETTINGS = Object.freeze({
  permissions: {
    allow: [`mcp(${MCP_SERVER_NAME}/*)`],
    deny: [
      "command(*)",
      "unsandboxed(*)",
      "read_file(*)",
      "write_file(*)",
      "read_url(*)",
      "execute_url(*)",
      "download_url(*)",
    ],
  },
});

export function buildChatArgs({
  model,
  prompt,
  mode = DEFAULT_MODE,
  printTimeoutSec = 0,
  allowTools = false,
} = {}) {
  if (!prompt) throw new Error("prompt is required");
  // Prompt travels on stdin as one stream-json user message. Passing it via
  // `-p` breaks on long conversations (spawn E2BIG: a single argv string is
  // capped at 128 KiB on Linux).
  const args = [
    "--input-format", "stream-json",
    "--output-format", "stream-json",
    "--print-timeout", `${printTimeoutSec}s`,
  ];
  if (model) args.push("--model", String(model));
  if (mode) args.push("--mode", String(mode));
  // Deny every built-in tool (shell, file, web). The only allowed tool family is
  // the local MCP bridge the client controls.
  args.push("--settings", JSON.stringify(AGY_PERMISSION_SETTINGS));
  // Print mode soft-denies tool confirmations; when the client sent tools we must
  // still auto-approve the MCP bridge. The deny rules above keep built-in tools
  // blocked even with this flag.
  if (allowTools) args.push("--dangerously-skip-permissions");
  // NOTE: --disable-slash-commands is deliberately NOT passed: combined with
  // --mode it makes the CLI print "warning: --mode plan has no effect..." on
  // stderr, which proxies surface as a request failure. The prompt always
  // starts with the preamble, so a leading "/" from the user cannot trigger a
  // slash command.
  return args;
}

export function buildUsageArgs() {
  // Slash commands must stay enabled for /usage.
  return ["-p", "/usage", "--output-format", "json"];
}

export function buildModelsArgs() {
  return ["models"];
}

export function parseJsonLine(line) {
  const trimmed = String(line || "").trim();
  if (!trimmed || trimmed[0] !== "{") return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function parseStreamEvent(line) {
  return parseJsonLine(line);
}

export function textDeltaFromEvent(event) {
  const update = event?.step_update;
  if (!update) return "";
  if (update.step_type !== "agent_response") return "";
  return typeof update.text_delta === "string" ? update.text_delta : "";
}

export function thinkingDeltaFromEvent(event) {
  const update = event?.step_update;
  if (!update) return "";
  if (update.step_type !== "thinking" && update.step_type !== "agent_thinking") return "";
  if (typeof update.thinking_delta === "string") return update.thinking_delta;
  return "";
}

export function usageFromEvent(event) {
  const usage = event?.step_update?.usage || event?.result?.usage;
  if (!usage || typeof usage !== "object") return null;
  return toOpenAiUsage(usage);
}

export function toOpenAiUsage(usage) {
  if (!usage || typeof usage !== "object") return null;
  const prompt = Number(usage.input_tokens) || 0;
  const completion = Number(usage.output_tokens) || 0;
  const total = Number(usage.total_tokens) || prompt + completion;
  return {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: total,
    prompt_tokens_details: { cached_tokens: Number(usage.cache_read_tokens) || 0 },
    completion_tokens_details: { reasoning_tokens: Number(usage.thinking_tokens) || 0 },
  };
}

/**
 * `agy models` prints "Fetching available models..." plus tab-separated
 * "<id>\t<Name>" lines.
 */
export function parseModelList(stdout) {
  const models = [];
  const seen = new Set();
  for (const raw of String(stdout || "").split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (!line.trim() || /fetching available models/i.test(line)) continue;
    const [idPart, ...rest] = line.split("\t");
    const id = String(idPart || "").trim();
    if (!id || !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const name = rest.join(" ").trim() || id;
    models.push({ id, name });
  }
  return models;
}

/**
 * Normalise `agy -p /usage --output-format json` into flat windows.
 * Bucket ids are stable; group names change with the account plan.
 */
export function parseUsageEnvelope(envelope) {
  const groups = envelope?.command?.data?.groups;
  const windows = [];
  if (Array.isArray(groups)) {
    for (const group of groups) {
      for (const bucket of group?.buckets || []) {
        const fraction = Number(bucket?.remaining_fraction);
        windows.push({
          bucketId: bucket?.id || null,
          group: group?.name || null,
          label: bucket?.name || null,
          window: bucket?.window || null,
          remainingPercentage: Number.isFinite(fraction)
            ? Math.round(fraction * 1000) / 10
            : null,
          resetAt: bucket?.reset_time || null,
          description: bucket?.description || null,
        });
      }
    }
  }
  return {
    windows,
    description: envelope?.command?.data?.description || null,
    text: envelope?.response || null,
  };
}

/**
 * Map an `AGY_ERROR: {...}` stderr payload to an HTTP status + stable code.
 * 403 + retryable:false + "disabled"/"violation" means the account is banned and
 * must never be retried (the caller marks the connection suspended).
 */
export function mapAgyError({ stderr = "", result = null } = {}) {
  const match = String(stderr || "").match(/AGY_ERROR:\s*(\{[\s\S]*\})/);
  let payload = null;
  if (match) {
    try {
      payload = JSON.parse(match[1]);
    } catch {
      payload = null;
    }
  }

  const stderrLines = String(stderr || "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !/^warning:/i.test(line));

  const message =
    payload?.short_error ||
    result?.error ||
    stderrLines[0] ||
    "agy failed without an error message";

  const rawCode = Number(payload?.error_code);
  const disabled = /violation of Terms|service has been disabled|account.*(disabled|suspended)/i.test(message);

  let code = "AGY_ERROR";
  if (disabled) code = "AGY_ACCOUNT_DISABLED";
  else if (rawCode === 429) code = "AGY_RATE_LIMITED";
  else if (rawCode === 401) code = "AGY_UNAUTHORIZED";
  else if (rawCode === 403) code = "AGY_FORBIDDEN";

  let status = 502;
  if (disabled) status = 403;
  else if (rawCode >= 400 && rawCode < 600) status = rawCode;

  return {
    status,
    code,
    message,
    retryable: payload?.retryable === true,
    errorId: payload?.error_id || null,
  };
}

export function openAiErrorBody(mapped) {
  return {
    error: {
      message: mapped.message,
      type: "agy_error",
      code: mapped.code,
      error_id: mapped.errorId || undefined,
      retryable: mapped.retryable,
    },
  };
}

export function openAiChunk({ id, model, delta = {}, finishReason = null }) {
  return {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
}
