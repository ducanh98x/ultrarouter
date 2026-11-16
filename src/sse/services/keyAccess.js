// Per-API-key access control for the /v1/* inference keys.
//
// Two modes per key: UNRESTRICTED (default) or RESTRICTED. Combo access is
// governed separately by the combo's own `keyIds` (empty = public to every
// key), which is authoritative: a key listed there may call the combo even
// when its own allow list does not name it, and a key whose allow list names
// the combo is still denied when `keyIds` does not list it. The key's allow
// list gates DIRECT model calls:
//
//   * a request that routes to a model is allowed iff its resolved
//     `providerId/model` equals the resolved `providerId/model` of a listed
//     model entry. So `cx/gpt-5`, `codex/gpt-5` and an alias that points there
//     are one target; a raw string that merely looks like a listed entry but
//     routes elsewhere (e.g. `MAIN` when the combo is `Main`) is not;
//   * search/fetch (provider IS the model) are allowed iff the resolved
//     provider id is listed.
//
// An allowed combo grants its members when they are reached THROUGH that combo
// (the check runs once, on the requested target, before combo expansion). It
// does not grant calling a member directly by name — that needs its own entry.
// The check runs before any credential lookup, so a denied request never
// touches a provider account.
import { getApiKeyByKey } from "@/lib/db/repos/apiKeysRepo.js";
import { getCombos } from "@/lib/db/repos/combosRepo.js";
import { getModelInfo, getComboModels } from "./model.js";
import { resolveProviderId } from "@/shared/constants/providers.js";
import { normalizeComboKeyIds } from "@/shared/utils/comboMembers.js";
import {
  KEY_ACCESS_COMBO_OWNER,
  KEY_ACCESS_PROVIDER_AS_MODEL_KINDS,
  keyAccessDeniedMessage,
} from "@/shared/constants/keyAccess.js";
import { errorResponse } from "open-sse/utils/error.js";
import { HTTP_STATUS } from "open-sse/config/runtimeConfig.js";
import * as log from "../utils/logger.js";

const lower = (s) => String(s).toLowerCase();
const canonicalModel = (provider, model) => lower(`${provider}/${model}`);

/**
 * The client key, read from the same places and in the same order as the
 * middleware (src/dashboardGuard.js) reads the key it authorizes a remote
 * /v1 call with: Bearer, x-api-key, x-goog-api-key, ?key=. Handlers' own
 * extractApiKey() only reads the first two, so using it here would let a
 * restricted key sent as x-goog-api-key look like "no key" (= unrestricted).
 */
export function extractClientApiKey(request) {
  const headers = request?.headers;
  if (!headers?.get) return null;
  const auth = headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7);
  const xApiKey = headers.get("x-api-key");
  if (xApiKey) return xApiKey;
  const googKey = headers.get("x-goog-api-key");
  if (googKey) return googKey;
  try {
    return new URL(request.url).searchParams.get("key") || null;
  } catch {
    return null;
  }
}

/**
 * Access context for the request's key. A known key always gets a context (it
 * may be unrestricted); keyIds scoping on combos needs the key id even when the
 * key has no allow list. Unknown/no key → null (= unrestricted local mode).
 */
export async function getKeyAccessContext(request) {
  const apiKey = extractClientApiKey(request);
  if (!apiKey) return null;
  const record = await getApiKeyByKey(apiKey);
  if (!record) return null;
  return {
    keyId: record.id,
    keyName: record.name || record.id,
    restricted: Boolean(record.access?.restricted),
    allow: record.access?.allow || [],
    _sets: null,
  };
}

// Resolve the allow list once per request: combo names/policies, resolved model
// ids, and resolved provider ids (for provider-as-model kinds).
async function getAllowSets(ctx) {
  if (ctx?._sets) return ctx._sets;
  const allCombos = await getCombos();
  const comboNames = new Set(allCombos.map((c) => lower(c.name)));
  // keyIds is authoritative for combo access: [] = public. Kept separately from
  // the key's own allow list, which still gates direct model calls.
  const comboPolicies = new Map(
    allCombos.map((c) => [lower(c.name), normalizeComboKeyIds(c.keyIds)])
  );
  const combos = new Set();
  const models = new Set();
  const providers = new Set();
  for (const entry of ctx?.allow || []) {
    const key = lower(entry);
    if (comboNames.has(key)) {
      combos.add(key);
      continue;
    }
    const info = await getModelInfo(entry);
    if (info?.provider && info.model) models.add(canonicalModel(info.provider, info.model));
    if (!entry.includes("/")) providers.add(lower(resolveProviderId(entry)));
  }
  const sets = { combos, models, providers, comboPolicies };
  if (ctx) ctx._sets = sets;
  return sets;
}

async function isModelStringAllowed(ctx, requested) {
  if (!ctx?.restricted) return true;
  const sets = await getAllowSets(ctx);
  const info = await getModelInfo(requested);
  // provider null ⇔ an existing combo with no members (routes nowhere).
  if (!info?.provider) return sets.combos.has(lower(requested));
  return sets.models.has(canonicalModel(info.provider, info.model));
}

export function keyAccessDeniedResponse(ctx, requested) {
  log.warn("AUTH", `key-access: key "${ctx?.keyName || "anonymous"}" denied "${requested}"`);
  return errorResponse(HTTP_STATUS.FORBIDDEN, keyAccessDeniedMessage(requested));
}

/**
 * Gate for endpoints whose `model` may be a combo or a model (chat, image, tts).
 * Call with the requested string BEFORE combo expansion.
 * @returns {Promise<Response|null>} a 403 Response, or null when allowed.
 */
export async function enforceKeyAccess(ctx, requested) {
  if (typeof requested !== "string" || !requested) {
    return ctx ? keyAccessDeniedResponse(ctx, String(requested ?? "")) : null;
  }
  const sets = await getAllowSets(ctx);

  // Combo: keyIds is the only authority. Empty list = public; a listed key can
  // call it even when its own allow list does not name the combo. getComboModels
  // is routing's own exact lookup, so a case variant that routes to a DIRECT
  // model is not mistaken for the combo here.
  const comboModels = await getComboModels(requested);
  if (comboModels) {
    const keyIds = sets.comboPolicies.get(lower(requested)) || [];
    if (keyIds.length === 0) return null;
    return ctx && keyIds.includes(ctx.keyId) ? null : keyAccessDeniedResponse(ctx, requested);
  }

  if (!ctx || !ctx.restricted) return null;
  return (await isModelStringAllowed(ctx, requested)) ? null : keyAccessDeniedResponse(ctx, requested);
}

/**
 * Gate for endpoints that resolve a single provider/model themselves
 * (embeddings, stt, systemone, video, Gemini-native TTS). A missing model
 * (e.g. a multipart video body we do not parse) is denied for restricted keys:
 * an unverifiable target is not an allowed one.
 */
export async function enforceKeyAccessResolved(ctx, requested, provider, model) {
  if (!ctx || !ctx.restricted) return null;
  const label = requested || (provider ? `${provider}/${model ?? ""}` : "");
  if (!provider || !model) return keyAccessDeniedResponse(ctx, label);
  const sets = await getAllowSets(ctx);
  return sets.models.has(canonicalModel(provider, model)) ? null : keyAccessDeniedResponse(ctx, label);
}

/**
 * Gate for search/fetch, where the provider IS the model.
 * @param {string[]|null} comboModels - routing's own combo resolution for `requested`
 */
export async function enforceKeyAccessProvider(ctx, requested, comboModels) {
  if (typeof requested !== "string" || !requested) {
    return ctx ? keyAccessDeniedResponse(ctx, String(requested ?? "")) : null;
  }
  const sets = await getAllowSets(ctx);
  if (comboModels) {
    const keyIds = sets.comboPolicies.get(lower(requested)) || [];
    if (keyIds.length === 0) return null;
    return ctx && keyIds.includes(ctx.keyId) ? null : keyAccessDeniedResponse(ctx, requested);
  }
  if (!ctx || !ctx.restricted) return null;
  const allowed = sets.providers.has(lower(resolveProviderId(requested)));
  return allowed ? null : keyAccessDeniedResponse(ctx, requested);
}

/**
 * Capacity-adapter models are appended by the gateway, not chosen by the
 * client. For a restricted key keep only the adapter models the key may call
 * directly; the original targets (already gated) are always kept. Dropping a
 * model just shortens the fallback list, so combo failover is unaffected.
 */
export async function filterAdapterModels(ctx, augmented, original) {
  if (!ctx || !ctx.restricted || !Array.isArray(augmented)) return augmented;
  const keep = new Set(original || []);
  const out = [];
  for (const m of augmented) {
    if (keep.has(m) || await isModelStringAllowed(ctx, m)) out.push(m);
    else log.info("AUTH", `key-access: key "${ctx.keyName}" skips adapter model "${m}" (not allowed)`);
  }
  return out;
}

/** /v1/models: a key sees only the combos/models it may call. */
export async function filterModelsListForKey(ctx, list) {
  if (!ctx || !Array.isArray(list)) return list;
  const sets = await getAllowSets(ctx);
  const out = [];
  let changed = false;
  for (const entry of list) {
    if (!entry?.id) {
      changed = true;
      continue;
    }
    if (entry.owned_by === KEY_ACCESS_COMBO_OWNER) {
      const keyIds = sets.comboPolicies.get(lower(entry.id));
      if (!keyIds || keyIds.length === 0 || keyIds.includes(ctx.keyId)) out.push(entry);
      else changed = true;
      continue;
    }
    const info = await getModelInfo(entry.id);
    if (!info?.provider) {
      changed = true;
      continue;
    }
    if (!ctx.restricted) {
      out.push(entry);
      continue;
    }
    if (KEY_ACCESS_PROVIDER_AS_MODEL_KINDS.includes(entry.kind)) {
      if (sets.providers.has(lower(info.provider))) out.push(entry);
      else changed = true;
      continue;
    }
    if (sets.models.has(canonicalModel(info.provider, info.model))) out.push(entry);
    else changed = true;
  }
  return changed ? out : list;
}
