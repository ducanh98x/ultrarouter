// Combo v2: members (per-member account pin + fallback policy) and keyIds
// (which API keys may call the combo; [] = public). Both are additive columns.
// syncSchemaFromTables() also picks them up; this migration stamps the change
// and keeps the versioned chain in step with older databases.
function addColumnIfMissing(db, table, column, definition) {
  const columns = db.all(`PRAGMA table_info(${table})`);
  // A very old DB may predate the table (or the fixture only declares some
  // tables). syncSchemaFromTables() creates it with the current columns later.
  if (columns.length === 0) return;
  if (!columns.some((entry) => entry.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export default {
  version: 2,
  name: "combo-members-and-key-ids",
  up(db) {
    addColumnIfMissing(db, "combos", "members", "TEXT");
    addColumnIfMissing(db, "combos", "keyIds", "TEXT");
  },
};
