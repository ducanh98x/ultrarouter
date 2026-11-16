// Antigravity CLI — routes completions through the official `agy` binary running
// inside a Docker container (one container per account). Unlike the `antigravity`
// provider, nothing here impersonates the IDE: the CLI is the real client, so
// there is no request envelope spoofing, no tool renaming and no prompt rewriting.
//
// Transport is OpenAI-compatible because the container exposes a small wrapper
// (`docker/agy-gateway`) in front of `agy`. The executor resolves the per-connection
// `baseUrl` (host loopback port) instead of a registry-wide URL.
export default {
  id: "antigravity-cli",
  priority: 19,
  alias: "agc",
  aliases: ["agy", "antigravity-cli"],
  uiAlias: "agc",

  category: "oauth",
  authType: "oauth",
  serviceKinds: ["llm"],
  features: { usage: true, usageApikey: true },

  display: {
    name: "Antigravity CLI",
    icon: "terminal",
    color: "#F59E0B",
    textIcon: "AGY",
    website: "https://antigravity.google/docs/cli/reference",
    notice: {
      text: "Runs the official Antigravity CLI (`agy`) in a Docker container, one container per account. 9router only relays OpenAI-compatible requests to the container, so no IDE impersonation is involved. Requires Docker on the host.",
      signupUrl: "https://antigravity.google",
    },
  },

  transport: {
    format: "openai",
    // Per-connection baseUrl (127.0.0.1:<hostPort>); see executors/antigravity-cli.js.
    baseUrls: [],
    auth: { header: "Authorization", scheme: "bearer", combined: true },
    retry: {
      "429": { attempts: 2 },
      "500": { attempts: 2 },
      "502": { attempts: 2 },
      "503": { attempts: 2 },
    },
  },

  // The catalogue is account/plan dependent (`agy models` returns 6 ids on one
  // plan and 18 on another), so these are only seeds for the picker. The wrapper
  // serves the live list from `/v1/models` and any id is accepted.
  passthroughModels: true,
  models: [
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon (High)" },
    { id: "gemini-4-argon-medium", name: "Gemini 4 Argon (Medium)" },
    { id: "gemini-4-argon-low", name: "Gemini 4 Argon (Low)" },
    { id: "gemini-4-hydrogen-xhigh", name: "Gemini 4 Hydrogen (XHigh)" },
    { id: "gemini-4-hydrogen-high", name: "Gemini 4 Hydrogen (High)" },
    { id: "gemini-4-hydrogen-medium", name: "Gemini 4 Hydrogen (Medium)" },
    { id: "gemini-4-hydrogen-low", name: "Gemini 4 Hydrogen (Low)" },
    { id: "gemini-pro-orchestrator-g1-pro", name: "Orchestrator (Argon)" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
    { id: "gemini-3.8-flash-medium", name: "Gemini 3.8 Flash (Medium)" },
    { id: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
    { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
    { id: "claude-sonnet-5-5-medium", name: "Claude Sonnet 5.5 (Medium)" },
    { id: "claude-sonnet-5-5-low", name: "Claude Sonnet 5.5 (Low)" },
    { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
    { id: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Medium)" },
    { id: "claude-opus-5-5-low", name: "Claude Opus 5.5 (Low)" },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-4-6-thinking", name: "Claude Opus 4.6 (Thinking)" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
  ],
};
