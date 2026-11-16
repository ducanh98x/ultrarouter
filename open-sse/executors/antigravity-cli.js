import { BaseExecutor } from "./base.js";
import { PROVIDERS } from "../config/providers.js";

/**
 * AntigravityCliExecutor — relays OpenAI-compatible requests to the local
 * `agy-gateway` container that fronts the official Antigravity CLI.
 *
 * Why a dedicated executor: BaseExecutor only honours a per-connection
 * `providerSpecificData.baseUrl` for the `openai-compatible-*` and
 * `anthropic-compatible-*` prefixes. This provider is first-class, so it needs
 * its own URL resolution (one loopback port per account/container).
 */
export class AntigravityCliExecutor extends BaseExecutor {
  constructor() {
    super("antigravity-cli", PROVIDERS["antigravity-cli"] || { format: "openai" });
  }

  getBaseUrls(credentials = null) {
    const base = this._connectionBaseUrl(credentials);
    return base ? [base] : [];
  }

  _connectionBaseUrl(credentials) {
    const raw = credentials?.providerSpecificData?.baseUrl;
    return typeof raw === "string" ? raw.replace(/\/+$/, "") : "";
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    const base = this._connectionBaseUrl(credentials);
    if (!base) {
      throw new Error("antigravity-cli: connection has no baseUrl (container not provisioned)");
    }
    return `${base}/chat/completions`;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      "Accept": stream ? "text/event-stream" : "application/json",
    };
    if (credentials?.apiKey) headers["Authorization"] = `Bearer ${credentials.apiKey}`;
    if (credentials?.connectionId) headers["X-9R-Connection"] = String(credentials.connectionId);
    return headers;
  }

  // The wrapper owns prompt building and model flags; forward the OpenAI body as
  //-is so translators keep working, but never leak provider-only thinking fields.
  transformRequest(model, body, stream) {
    if (!body || typeof body !== "object") return body;
    const next = { ...body, model };
    delete next.reasoning_effort;
    delete next.thinking;
    delete next.thinkingConfig;
    if (stream !== true) delete next.stream_options;
    return next;
  }

  parseError(response, bodyText) {
    const fallback = super.parseError(response, bodyText);
    if (!bodyText) return fallback;
    try {
      const json = JSON.parse(bodyText);
      const err = json?.error || json;
      const code = err?.code && typeof err.code === "string" ? err.code : null;
      const message = err?.message || fallback.message;
      if (!code) return { ...fallback, message };
      return { ...fallback, message: `${code}: ${message}`, code };
    } catch {
      return fallback;
    }
  }
}

export default AntigravityCliExecutor;
