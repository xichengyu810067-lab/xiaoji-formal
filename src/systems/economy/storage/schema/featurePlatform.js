// Feature platform tables: feature_* and the reward ledger (reward_grants, reward_grants_v2).
//
// Each constant is one run of statements of this family as it appears in the full schema text;
// schema/index.js puts the runs of every family back together in their original order, so the
// assembled SQL is exactly the text the coin database has always executed.

// Part of schemaSql: feature_guild_settings, feature_outbox, feature_outbox_dead_letters,
// reward_grants, feature_usage_daily, feature_health
const featureTablesSql = `CREATE TABLE IF NOT EXISTS feature_guild_settings (
  guild_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  channel_id TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, feature_key)
);

CREATE TABLE IF NOT EXISTS feature_outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'delivered')),
  available_at TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  claimed_by TEXT,
  claimed_at TEXT,
  lease_until TEXT,
  delivered_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, feature_key, event_type, dedupe_key)
);

CREATE TABLE IF NOT EXISTS feature_outbox_dead_letters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  original_event_id INTEGER NOT NULL UNIQUE,
  guild_id TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  event_type TEXT NOT NULL,
  dedupe_key TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  attempt_count INTEGER NOT NULL,
  last_error TEXT NOT NULL,
  dead_letter_reason TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS reward_grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reward_kind TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  metadata TEXT,
  transaction_id INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (guild_id, user_id, source_type, source_id, reward_kind)
);

CREATE TABLE IF NOT EXISTS feature_usage_daily (
  usage_date TEXT NOT NULL,
  feature_key TEXT NOT NULL,
  metric_key TEXT NOT NULL,
  usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (usage_date, feature_key, metric_key)
);

CREATE TABLE IF NOT EXISTS feature_health (
  feature_key TEXT PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('normal', 'maintenance', 'broken')),
  detail TEXT,
  updated_at TEXT NOT NULL
);`;

// Part of schemaSql: idx_feature_outbox_claim
const outboxIndexesSql = `CREATE INDEX IF NOT EXISTS idx_feature_outbox_claim
  ON feature_outbox (status, available_at, lease_until, id);`;

// Part of schemaSql: idx_reward_grants_source, idx_feature_usage_daily_feature
const rewardAndUsageIndexesSql = `CREATE INDEX IF NOT EXISTS idx_reward_grants_source
  ON reward_grants (guild_id, source_type, source_id, reward_kind);

CREATE INDEX IF NOT EXISTS idx_feature_usage_daily_feature
  ON feature_usage_daily (feature_key, usage_date DESC, metric_key);`;

// Part of globalEconomyV22Sql: reward_grants_v2
const rewardGrantsV2TableSql = `CREATE TABLE IF NOT EXISTS reward_grants_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reward_key TEXT NOT NULL UNIQUE,
  operation_id TEXT UNIQUE,
  kind TEXT NOT NULL,
  canonical_source_id TEXT NOT NULL,
  reward_kind TEXT NOT NULL,
  user_id TEXT NOT NULL,
  source_guild_id TEXT,
  amount INTEGER NOT NULL CHECK (amount > 0),
  payload_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  debt_offset INTEGER NOT NULL DEFAULT 0 CHECK (debt_offset >= 0),
  net_amount INTEGER NOT NULL DEFAULT 0 CHECK (net_amount >= 0),
  transaction_id INTEGER NOT NULL,
  legacy_grant_id INTEGER UNIQUE,
  created_at TEXT NOT NULL,
  UNIQUE (user_id, reward_key),
  FOREIGN KEY (user_id) REFERENCES coin_wallets(user_id),
  FOREIGN KEY (transaction_id) REFERENCES coin_transactions(id)
);`;

// Part of globalEconomyV22Sql: idx_reward_grants_v2_source
const rewardGrantsV2IndexesSql = `CREATE INDEX IF NOT EXISTS idx_reward_grants_v2_source
  ON reward_grants_v2 (kind, canonical_source_id, reward_kind, user_id);`;

module.exports = {
  featureTablesSql,
  outboxIndexesSql,
  rewardAndUsageIndexesSql,
  rewardGrantsV2TableSql,
  rewardGrantsV2IndexesSql,
};
