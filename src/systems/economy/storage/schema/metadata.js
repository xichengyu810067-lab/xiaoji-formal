// Storage metadata: the coin_metadata key-value table (schema version, safety ledger registrations, safety alert stamps).
//
// Each constant is one run of statements of this family as it appears in the full schema text;
// schema/index.js puts the runs of every family back together in their original order, so the
// assembled SQL is exactly the text the coin database has always executed.

// Part of schemaSql: coin_metadata
const metadataTableSql = `CREATE TABLE IF NOT EXISTS coin_metadata (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;

module.exports = {
  metadataTableSql,
};
