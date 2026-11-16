/**
 * Antigravity CLI quota cache.
 *
 * The wrapper exposes `/v1/usage`, which runs `agy -p /usage --output-format
 * json` and returns buckets with stable ids:
 *   gemini-weekly / gemini-5h          → Gemini family
 *   3p-weekly / 3p-5h                  → Claude & GPT family
 *   gemini-argon-wtu-weekly            → Gemini 4 Argon family
 *
 * 9router caches them per connection and uses them to skip an exhausted account
 * before the request reaches the container.
 */
import * as log from "../utils/logger.js";

const MIN_REFRESH_MS = 60_000;
const FETCH_TIMEOUT_MS = 5_000;

const cache = new Map(); // connectionId → { at, quotas }
const lastAttempt = new Map(); // connectionId → ms

export function familyForBucket(bucketId) {
  const id = String(bucketId || "").toLowerCase();
  if (id.startsWith("gemini-argon")) return "gemini_argon";
  if (id.startsWith("3p-")) return "claude_gpt";
  if (id.startsWith("gemini-")) return "gemini";
  return null;
}

export function familyForModel(model) {
  const clean = String(model || "").toLowerCase();
  if (!clean) return null;
  if (clean.startsWith("claude-") || clean.startsWith("gpt-") || clean === "claude") return "claude_gpt";
  if (clean.includes("argon") || clean.includes("orchestrator")) return "gemini_argon";
  if (clean.startsWith("gemini-")) return "gemini";
  return null;
}

export function groupWindowsByFamily(windows = []) {
  const out = {};
  for (const window of windows) {
    const family = familyForBucket(window?.bucketId);
    if (!family) continue;
    if (!out[family]) out[family] = [];
    out[family].push(window);
  }
  return out;
}

export function getAgyQuotaCache() {
  return cache;
}

export function getCachedAgyQuota(connectionId) {
  return cache.get(connectionId)?.quotas || null;
}

/**
 * Most restrictive window for this model's family; an exhausted window wins.
 */
export function getAgyModelQuota(quotas, model) {
  const family = familyForModel(model);
  const windows = family ? quotas?.[family] : null;
  if (!Array.isArray(windows) || windows.length === 0) return null;

  const now = Date.now();
  const exhausted = windows.find(
    (window) =>
      Number(window.remainingPercentage ?? 100) <= 0 &&
      window.resetAt &&
      new Date(window.resetAt).getTime() > now,
  );
  if (exhausted) return { ...exhausted, family, remainingPercentage: 0 };

  return windows.reduce(
    (min, window) =>
      min == null || Number(window.remainingPercentage ?? 100) < Number(min.remainingPercentage ?? 100)
        ? window
        : min,
    null,
  );
}

const WINDOW_KEYS = {
  gemini: { weekly: "gemini_weekly", session: "gemini_session" },
  claude_gpt: { weekly: "claude_gpt_weekly", session: "claude_gpt_session" },
  gemini_argon: { weekly: "gemini_argon_weekly", session: "gemini_argon_session" },
};

const WINDOW_LABELS = {
  gemini_weekly: "Gemini — weekly",
  gemini_session: "Gemini — 5h",
  claude_gpt_weekly: "Claude & GPT — weekly",
  claude_gpt_session: "Claude & GPT — 5h",
  gemini_argon_weekly: "Gemini 4 Argon — weekly",
  gemini_argon_session: "Gemini 4 Argon — 5h",
};

/**
 * Shape the cached buckets like the `antigravity` provider's usage response so
 * the existing Quota Tracker parser renders them without a new branch.
 */
export function toAntigravityUsage(quotas) {
  const out = {};
  for (const [family, windows] of Object.entries(quotas || {})) {
    for (const window of windows || []) {
      const bucket = window?.window === "weekly" ? "weekly" : "session";
      const key = WINDOW_KEYS[family]?.[bucket];
      if (!key || out[key]) continue;
      const remainingPercentage = Number(window.remainingPercentage ?? 100);
      const total = 1000;
      const remaining = Math.round((remainingPercentage / 100) * total);
      out[key] = {
        used: total - remaining,
        total,
        remaining,
        remainingPercentage,
        resetAt: window.resetAt || null,
        displayName: WINDOW_LABELS[key] || key,
      };
    }
  }
  return { quotas: out, plan: null, message: null };
}

function wrapperRoot(baseUrl) {  return String(baseUrl || "").trim().replace(/\/v1\/?$/i, "").replace(/\/+$/, "");
}

/**
 * Fetch `/v1/usage` for one connection. Fail-open: returns the last cached
 * value when the container is down or the call times out.
 */
export async function refreshAgyQuota(connection, { force = false } = {}) {
  const id = connection?.id || connection?.connectionId;
  const root = wrapperRoot(connection?.providerSpecificData?.baseUrl);
  if (!id || !root) return null;

  const last = lastAttempt.get(id) || 0;
  if (!force && Date.now() - last < MIN_REFRESH_MS) {
    return cache.get(id)?.quotas || null;
  }
  lastAttempt.set(id, Date.now());

  try {
    const response = await fetch(`${root}/v1/usage`, {
      headers: connection.apiKey ? { Authorization: `Bearer ${connection.apiKey}` } : {},
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`usage HTTP ${response.status}`);
    const json = await response.json();
    const quotas = groupWindowsByFamily(json.windows || []);
    cache.set(id, { at: Date.now(), quotas });
    return quotas;
  } catch (error) {
    log.debug("AGY_QUOTA", `refresh failed for ${String(id).slice(0, 8)}: ${error?.message || error}`);
    return cache.get(id)?.quotas || null;
  }
}

/** Drop cached quota for a connection (delete / recreate). */
export function clearAgyQuota(connectionId) {
  cache.delete(connectionId);
  lastAttempt.delete(connectionId);
}
