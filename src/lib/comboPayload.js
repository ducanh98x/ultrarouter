// Combo v2 API validation: a member's pinned account must exist and belong to
// the member's provider; every keyIds entry must name a real API key. Pure shape
// normalization lives in shared/utils/comboMembers.js.
import { getApiKeys, getProviderConnectionById } from "@/lib/localDb";
import { resolveProviderId } from "@/shared/constants/providers";

export async function validateComboReferences({
  members = [],
  keyIds = [],
  allowMissingKeyIds = [],
  allowMissingConnectionIds = [],
} = {}) {
  const toleratedConnections = new Set(allowMissingConnectionIds);
  for (const member of members) {
    if (!member?.model) return "Every combo member needs a model";
    if (!member.connectionId) continue;
    const connection = await getProviderConnectionById(member.connectionId);
    if (!connection) {
      if (toleratedConnections.has(member.connectionId)) continue;
      return `Account not found: ${member.connectionId}`;
    }
    if (member.provider && connection.provider !== resolveProviderId(member.provider)) {
      return `Account "${connection.name || connection.id}" does not belong to provider ${member.provider}`;
    }
  }

  if (keyIds.length > 0) {
    const keys = await getApiKeys();
    const known = new Set(keys.map((key) => key.id));
    // A key deleted after the combo was saved leaves a stale id in keyIds.
    // Keep those (the combo simply grants nothing to a missing key) but reject
    // a client trying to add an id that never existed.
    const tolerated = new Set(allowMissingKeyIds);
    const missing = keyIds.find((id) => !known.has(id) && !tolerated.has(id));
    if (missing) return `API key not found: ${missing}`;
  }

  return null;
}
