import { describe, it, expect } from "vitest";
import {
  DEFAULT_PREAMBLE,
  buildChatArgs,
  buildPrompt,
  buildUsageArgs,
  mapAgyError,
  openAiChunk,
  parseModelList,
  parseUsageEnvelope,
  textDeltaFromEvent,
  toOpenAiUsage,
} from "../../docker/agy-gateway/lib.mjs";

describe("buildPrompt", () => {
  it("puts the preamble first and flattens roles", () => {
    const prompt = buildPrompt([
      { role: "system", content: "You are terse." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi" },
      { role: "tool", name: "Read", content: "file body" },
      { role: "user", content: [{ type: "text", text: "Next?" }] },
    ]);
    expect(prompt.startsWith(DEFAULT_PREAMBLE)).toBe(true);
    expect(prompt).toContain("You are terse.");
    expect(prompt).toContain("User: Hello");
    expect(prompt).toContain("Assistant: Hi");
    expect(prompt).toContain("Tool result (Read): file body");
    expect(prompt).toContain("User: Next?");
  });

  it("notes tool calls made by the assistant", () => {
    const prompt = buildPrompt([
      { role: "user", content: "read it" },
      { role: "assistant", content: "", tool_calls: [{ function: { name: "Read" } }] },
    ]);
    expect(prompt).toContain("[called tools: Read]");
  });

  it("can omit the preamble", () => {
    const prompt = buildPrompt([{ role: "user", content: "hi" }], { preamble: "" });
    expect(prompt).toBe("User: hi");
  });

  it("replaces images with a placeholder", () => {
    const prompt = buildPrompt([{ role: "user", content: [{ type: "image_url", image_url: { url: "data:x" } }] }]);
    expect(prompt).toContain("[image omitted]");
  });
});

describe("buildChatArgs", () => {
  it("uses stream-json stdin and never puts the prompt in argv", () => {
    const args = buildChatArgs({ model: "gemini-3.8-flash-low", prompt: "hi" });
    expect(args.slice(0, 2)).toEqual(["--input-format", "stream-json"]);
    expect(args).not.toContain("-p");
    expect(args).not.toContain("hi");
    expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    // The CLI warns when both are set; the prompt never starts with "/", so the
    // disable flag is unnecessary.
    expect(args).not.toContain("--disable-slash-commands");
    expect(args).not.toContain("--disable-telemetry");
    expect(args[args.indexOf("--model") + 1]).toBe("gemini-3.8-flash-low");
    expect(args[args.indexOf("--mode") + 1]).toBe("plan");
    expect(args).not.toContain("--dangerously-skip-permissions");
    const settingsIndex = args.indexOf("--settings");
    expect(settingsIndex).toBeGreaterThan(-1);
    const settings = JSON.parse(args[settingsIndex + 1]);
    expect(settings.permissions.allow).toContain("mcp(ultrarouter/*)");
    expect(settings.permissions.deny).toEqual(expect.arrayContaining([
      "command(*)", "read_file(*)", "write_file(*)", "read_url(*)",
    ]));
  });

  it("auto-approves tool calls only when the request has tools, and still denies built-ins", () => {
    const args = buildChatArgs({ model: "m", prompt: "hi", allowTools: true });
    expect(args).toContain("--dangerously-skip-permissions");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["command(*)", "read_file(*)"]));
  });

  it("keeps /usage able to use slash commands", () => {
    expect(buildUsageArgs()).toEqual(["-p", "/usage", "--output-format", "json"]);
  });

  it("requires a prompt", () => {
    expect(() => buildChatArgs({ model: "m" })).toThrow(/prompt/);
  });
});

describe("parseModelList", () => {
  it("ignores the progress line and parses tab-separated rows", () => {
    const stdout = [
      "Fetching available models...",
      "gemini-3.8-flash-low\tGemini 3.8 Flash (Low)",
      "claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)",
      "gpt-oss-120b-medium",
      "",
    ].join("\n");
    expect(parseModelList(stdout)).toEqual([
      { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
      { id: "gpt-oss-120b-medium", name: "gpt-oss-120b-medium" },
    ]);
  });

  it("drops free-form lines", () => {
    expect(parseModelList("Some warning\nmodel-a\tModel A")).toEqual([{ id: "model-a", name: "Model A" }]);
  });
});

describe("stream events", () => {
  it("extracts text deltas only from agent_response steps", () => {
    expect(
      textDeltaFromEvent({
        event: "step_update",
        step_update: { step_type: "agent_response", state: "ACTIVE", text_delta: "ok" },
      }),
    ).toBe("ok");
    expect(
      textDeltaFromEvent({
        event: "step_update",
        step_update: { step_type: "user_input", text_delta: "ok" },
      }),
    ).toBe("");
  });

  it("converts agy usage to OpenAI usage", () => {
    expect(
      toOpenAiUsage({ input_tokens: 10, output_tokens: 2, total_tokens: 12, cache_read_tokens: 3, thinking_tokens: 1 }),
    ).toEqual({
      prompt_tokens: 10,
      completion_tokens: 2,
      total_tokens: 12,
      prompt_tokens_details: { cached_tokens: 3 },
      completion_tokens_details: { reasoning_tokens: 1 },
    });
  });

  it("builds an OpenAI chunk", () => {
    const chunk = openAiChunk({ id: "chatcmpl-1", model: "m", delta: { content: "hi" } });
    expect(chunk.object).toBe("chat.completion.chunk");
    expect(chunk.choices[0]).toEqual({ index: 0, delta: { content: "hi" }, finish_reason: null });
  });
});

describe("parseUsageEnvelope", () => {
  it("flattens buckets and keeps stable ids", () => {
    const usage = parseUsageEnvelope({
      response: "text",
      command: {
        data: {
          groups: [
            {
              name: "Gemini Models",
              buckets: [
                { id: "gemini-weekly", name: "Weekly", window: "weekly", remaining_fraction: 0.5, reset_time: "2026-11-21T09:27:05Z" },
                { id: "gemini-5h", name: "Five Hour", window: "5h", remaining_fraction: 1, reset_time: "2026-11-16T07:50:47Z" },
              ],
            },
          ],
        },
      },
    });
    expect(usage.windows).toHaveLength(2);
    expect(usage.windows[0]).toMatchObject({
      bucketId: "gemini-weekly",
      group: "Gemini Models",
      window: "weekly",
      remainingPercentage: 50,
      resetAt: "2026-11-21T09:27:05Z",
    });
    expect(usage.text).toBe("text");
  });

  it("tolerates a missing command envelope", () => {
    expect(parseUsageEnvelope({})).toEqual({ windows: [], description: null, text: null });
  });
});

describe("mapAgyError", () => {
  it("maps the ToS ban to 403 AGY_ACCOUNT_DISABLED and forbids retries", () => {
    const stderr =
      'AGY_ERROR: {"short_error":"PERMISSION_DENIED (code 403): This service has been disabled in this account for violation of Terms of Service.","status":"PERMISSION_DENIED","error_code":403,"retryable":false,"error_id":"abc-1"}';
    const mapped = mapAgyError({ stderr, result: null });
    expect(mapped.status).toBe(403);
    expect(mapped.code).toBe("AGY_ACCOUNT_DISABLED");
    expect(mapped.retryable).toBe(false);
    expect(mapped.errorId).toBe("abc-1");
  });

  it("keeps 429 retryable", () => {
    const mapped = mapAgyError({
      stderr: 'AGY_ERROR: {"short_error":"quota","error_code":429,"retryable":true}',
    });
    expect(mapped.status).toBe(429);
    expect(mapped.code).toBe("AGY_RATE_LIMITED");
    expect(mapped.retryable).toBe(true);
  });

  it("falls back to 502 for an unknown failure", () => {
    const mapped = mapAgyError({ stderr: "segfault", result: { status: "ERROR", error: "boom" } });
    expect(mapped.status).toBe(502);
    expect(mapped.code).toBe("AGY_ERROR");
    expect(mapped.message).toBe("boom");
  });

  it("never surfaces a CLI warning as the error message", () => {
    const mapped = mapAgyError({
      stderr: "warning: --mode plan has no effect while slash command expansion is disabled.\n",
      result: null,
    });
    expect(mapped.message).toBe("agy failed without an error message");
  });
});
