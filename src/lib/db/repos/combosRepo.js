import { v4 as uuidv4 } from "uuid";
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";
import {
  buildMembersFromModels,
  comboMemberModelString,
  comboMembersToModels,
  normalizeComboKeyIds,
  normalizeComboMembers,
} from "@/shared/utils/comboMembers.js";

function rowToCombo(row) {
  if (!row) return null;
  const models = parseJson(row.models, []);
  let members = normalizeComboMembers(parseJson(row.members, []));
  // Legacy rows (and rows written by older clients) have no members column:
  // expand their models into default members so runtime sees one shape.
  if (members.length === 0) members = buildMembersFromModels(models);
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    models,
    members,
    keyIds: normalizeComboKeyIds(parseJson(row.keyIds, [])),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getCombos() {
  const db = await getAdapter();
  const rows = db.all(`SELECT * FROM combos ORDER BY createdAt ASC`);
  return rows.map(rowToCombo);
}

export async function getComboById(id) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
  return rowToCombo(row);
}

export async function getComboByName(name) {
  const db = await getAdapter();
  const row = db.get(`SELECT * FROM combos WHERE name = ?`, [name]);
  return rowToCombo(row);
}

export async function createCombo(data) {
  const db = await getAdapter();
  const now = new Date().toISOString();
  const members = normalizeComboMembers(data.members, { models: data.models || [] });
  const combo = {
    id: uuidv4(),
    name: data.name,
    kind: data.kind || null,
    models: comboMembersToModels(members),
    members,
    keyIds: normalizeComboKeyIds(data.keyIds),
    createdAt: now,
    updatedAt: now,
  };
  db.run(
    `INSERT INTO combos(id, name, kind, models, members, keyIds, createdAt, updatedAt) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      combo.id,
      combo.name,
      combo.kind,
      stringifyJson(combo.models),
      stringifyJson(combo.members),
      stringifyJson(combo.keyIds),
      combo.createdAt,
      combo.updatedAt,
    ]
  );
  return combo;
}

export async function updateCombo(id, data) {
  const db = await getAdapter();
  let result = null;
  db.transaction(() => {
    const row = db.get(`SELECT * FROM combos WHERE id = ?`, [id]);
    if (!row) return;
    const existing = rowToCombo(row);

    let nextMembers;
    if (data.members !== undefined) {
      // Members are authoritative; `models` is always derived from them.
      nextMembers = normalizeComboMembers(data.members, { models: data.models ?? existing.models });
    } else if (data.models !== undefined) {
      // Legacy client sent only models: keep the pinned account/fallback of any
      // member whose model string still exists.
      const previous = new Map(
        (existing.members || []).map((member) => [comboMemberModelString(member), member])
      );
      nextMembers = buildMembersFromModels(data.models).map((member) => {
        const prev = previous.get(comboMemberModelString(member));
        return prev
          ? { ...member, connectionId: prev.connectionId, accountFallback: prev.accountFallback }
          : member;
      });
    } else {
      nextMembers = existing.members || [];
    }

    const merged = {
      ...existing,
      ...data,
      models: comboMembersToModels(nextMembers),
      members: nextMembers,
      keyIds: data.keyIds !== undefined ? normalizeComboKeyIds(data.keyIds) : existing.keyIds,
      updatedAt: new Date().toISOString(),
    };
    db.run(
      `UPDATE combos SET name = ?, kind = ?, models = ?, members = ?, keyIds = ?, updatedAt = ? WHERE id = ?`,
      [
        merged.name,
        merged.kind,
        stringifyJson(merged.models || []),
        stringifyJson(merged.members || []),
        stringifyJson(merged.keyIds || []),
        merged.updatedAt,
        id,
      ]
    );
    result = merged;
  });
  return result;
}

export async function deleteCombo(id) {
  const db = await getAdapter();
  const res = db.run(`DELETE FROM combos WHERE id = ?`, [id]);
  return (res?.changes ?? 0) > 0;
}
