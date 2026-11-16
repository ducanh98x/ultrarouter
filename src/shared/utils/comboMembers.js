// Combo v2 helpers: members carry an optional pinned provider account and an
// account-fallback policy; keyIds scope which API keys may use the combo.
// Pure functions only — shared by the DB repo, the API routes and the UI.

export const ACCOUNT_FALLBACK_NEXT_ACCOUNT = "next-account";
export const ACCOUNT_FALLBACK_NEXT_MEMBER = "next-member";
export const ACCOUNT_FALLBACK_VALUES = Object.freeze([
  ACCOUNT_FALLBACK_NEXT_ACCOUNT,
  ACCOUNT_FALLBACK_NEXT_MEMBER,
]);

export function normalizeAccountFallback(value, fallback = ACCOUNT_FALLBACK_NEXT_ACCOUNT) {
  return ACCOUNT_FALLBACK_VALUES.includes(value) ? value : fallback;
}

/** `provider/model` → { provider, model }. A bare string has an empty provider. */
export function parseComboModelString(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { provider: "", model: "" };
  const slash = raw.indexOf("/");
  if (slash <= 0) return { provider: "", model: raw };
  return { provider: raw.slice(0, slash), model: raw.slice(slash + 1) };
}

/** Member → canonical `provider/model` string (bare model when provider is empty). */
export function comboMemberModelString(member) {
  const model = String(member?.model ?? "").trim();
  if (!model) return "";
  const provider = String(member?.provider ?? "").trim();
  if (provider) return `${provider}/${model}`;
  return model;
}

/**
 * Normalize stored/API member input. Unknown fields are dropped; order is kept;
 * duplicate model strings are collapsed (the first one wins). When no members
 * are supplied, legacy `models` strings are expanded into default members.
 */
export function normalizeComboMembers(input, { models = [] } = {}) {
  const source = Array.isArray(input) ? input : [];
  const out = [];
  const seen = new Set();

  const push = (value) => {
    const model = String(value?.model ?? "").trim();
    if (!model) return;
    const provider = String(value?.provider ?? "").trim();
    const modelString = provider ? `${provider}/${model}` : model;
    if (seen.has(modelString)) return;
    seen.add(modelString);
    out.push({
      provider,
      model,
      connectionId: typeof value?.connectionId === "string" && value.connectionId.trim()
        ? value.connectionId.trim()
        : null,
      accountFallback: normalizeAccountFallback(value?.accountFallback),
      enabled: value?.enabled !== false,
    });
  };

  if (source.length > 0) {
    for (const entry of source) {
      if (!entry || typeof entry !== "object") continue;
      const parsed = parseComboModelString(entry.model);
      push({
        provider: entry.provider || parsed.provider,
        model: parsed.provider ? parsed.model : entry.model,
        connectionId: entry.connectionId,
        accountFallback: entry.accountFallback,
        enabled: entry.enabled,
      });
    }
    return out;
  }

  for (const modelString of Array.isArray(models) ? models : []) {
    const parsed = parseComboModelString(modelString);
    push({ provider: parsed.provider, model: parsed.model });
  }
  return out;
}

/** Legacy `models: string[]` → default members (auto account). */
export function buildMembersFromModels(models) {
  return normalizeComboMembers(null, { models });
}

/** Flatten enabled members to the `models` array kept for backward compatibility. */
export function comboMembersToModels(members) {
  return (Array.isArray(members) ? members : [])
    .filter((member) => member?.enabled !== false)
    .map(comboMemberModelString)
    .filter(Boolean);
}

/** API key id list: strings only, trimmed, de-duplicated; [] = public. */
export function normalizeComboKeyIds(input) {
  if (!Array.isArray(input)) return [];
  const seen = new Set();
  const out = [];
  for (const item of input) {
    if (typeof item !== "string") continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** True when the key may use the combo: empty keyIds = public. */
export function comboAllowsKey(keyIds, keyId) {
  const ids = normalizeComboKeyIds(keyIds);
  if (ids.length === 0) return true;
  return Boolean(keyId) && ids.includes(keyId);
}
