import { describe, it, expect } from "vitest";
import { AntigravityCliExecutor } from "open-sse/executors/antigravity-cli.js";

const credentials = {
  apiKey: "gateway-token",
  connectionId: "conn-1",
  providerSpecificData: { baseUrl: "http://127.0.0.1:20801/v1/" },
};

describe("AntigravityCliExecutor", () => {
  it("builds the chat URL from the connection baseUrl", () => {
    const executor = new AntigravityCliExecutor();
    expect(executor.buildUrl("gemini-3.8-flash-low", true, 0, credentials)).toBe(
      "http://127.0.0.1:20801/v1/chat/completions",
    );
  });

  it("throws when the container has not been provisioned", () => {
    const executor = new AntigravityCliExecutor();
    expect(() => executor.buildUrl("gemini-3.8-flash-low", true, 0, { providerSpecificData: {} })).toThrow(
      /baseUrl/,
    );
  });

  it("sends the wrapper token, connection id and SSE accept header", () => {
    const headers = new AntigravityCliExecutor().buildHeaders(credentials, true);
    expect(headers.Authorization).toBe("Bearer gateway-token");
    expect(headers["X-9R-Connection"]).toBe("conn-1");
    expect(headers.Accept).toBe("text/event-stream");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  it("keeps the stable error code from the wrapper body", () => {
    const parsed = new AntigravityCliExecutor().parseError(
      { status: 403 },
      JSON.stringify({ error: { code: "AGY_ACCOUNT_DISABLED", message: "violation of Terms" } }),
    );
    expect(parsed.status).toBe(403);
    expect(parsed.code).toBe("AGY_ACCOUNT_DISABLED");
    expect(parsed.message).toContain("AGY_ACCOUNT_DISABLED");
    expect(parsed.message).toContain("violation of Terms");
  });

  it("falls back to the raw body when the error is not JSON", () => {
    const parsed = new AntigravityCliExecutor().parseError({ status: 502 }, "bad gateway");
    expect(parsed).toEqual({ status: 502, message: "bad gateway" });
  });

  it("strips provider-only thinking fields and stream_options on non-stream", () => {
    const out = new AntigravityCliExecutor().transformRequest(
      "gemini-3.8-flash-low",
      {
        model: "ignored",
        messages: [],
        reasoning_effort: "high",
        thinking: { type: "enabled" },
        thinkingConfig: {},
        stream_options: { include_usage: true },
      },
      false,
    );
    expect(out.model).toBe("gemini-3.8-flash-low");
    expect(out.reasoning_effort).toBeUndefined();
    expect(out.thinking).toBeUndefined();
    expect(out.thinkingConfig).toBeUndefined();
    expect(out.stream_options).toBeUndefined();
    expect(out.messages).toEqual([]);
  });
});
