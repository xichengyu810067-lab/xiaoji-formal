// Community tables: text_chain_*, number_chain_* and daily_event*.
//
// Each constant is one run of statements of this family as it appears in the full schema text;
// schema/index.js puts the runs of every family back together in their original order, so the
// assembled SQL is exactly the text the coin database has always executed.

// Part of schemaSql: text_chain_sessions, text_chain_entries, number_chain_sessions,
// number_chain_entries, daily_events, daily_event_messages, daily_event_participants
const chainAndDailyEventTablesSql = `CREATE TABLE IF NOT EXISTS text_chain_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
  corpus_version TEXT NOT NULL DEFAULT '2026.09.03-1',
  current_word TEXT NOT NULL,
  last_word TEXT NOT NULL,
  last_user_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  started_by TEXT NOT NULL,
  stopped_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS text_chain_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  word TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (message_id)
);

CREATE TABLE IF NOT EXISTS number_chain_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
  expected_target INTEGER NOT NULL CHECK (expected_target >= 1 AND expected_target <= 9007199254740991),
  last_user_id TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  started_by TEXT NOT NULL,
  stopped_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  stopped_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS number_chain_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL,
  expression TEXT NOT NULL,
  result INTEGER NOT NULL CHECK (result >= 1 AND result <= 9007199254740991),
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS daily_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  event_kind TEXT NOT NULL CHECK (event_kind IN ('riddle', 'discussion')),
  local_date TEXT NOT NULL,
  riddle_id TEXT,
  parent_channel_id TEXT NOT NULL,
  announcement_message_id TEXT,
  thread_id TEXT,
  answer_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'claimed' CHECK (status IN ('claimed', 'published', 'published_late', 'settling', 'rewarding', 'settled', 'blocked', 'missed', 'failed')),
  window_start_at TEXT NOT NULL,
  window_end_at TEXT NOT NULL,
  publish_marker TEXT NOT NULL,
  answer_marker TEXT NOT NULL,
  published_at TEXT,
  history_reconciled_at TEXT,
  settled_at TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  publish_lease_owner TEXT,
  publish_lease_until TEXT,
  settle_lease_owner TEXT,
  settle_lease_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, event_kind, local_date)
);

CREATE TABLE IF NOT EXISTS daily_event_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
  correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
  UNIQUE (event_id, message_id)
);

CREATE TABLE IF NOT EXISTS daily_event_participants (
  event_id INTEGER NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  eligible INTEGER NOT NULL DEFAULT 0 CHECK (eligible IN (0, 1)),
  correct INTEGER NOT NULL DEFAULT 0 CHECK (correct IN (0, 1)),
  participation_reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (participation_reward_status IN ('pending', 'granted')),
  correct_reward_status TEXT NOT NULL DEFAULT 'pending' CHECK (correct_reward_status IN ('pending', 'granted', 'not_earned')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_id, user_id)
);`;

// Part of schemaSql: idx_text_chain_sessions_active, idx_text_chain_entries_session_word,
// idx_number_chain_sessions_active, idx_number_chain_entries_session_result, idx_daily_events_due
const chainAndDailyEventIndexesSql = `CREATE INDEX IF NOT EXISTS idx_text_chain_sessions_active
  ON text_chain_sessions (guild_id, channel_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_text_chain_entries_session_word
  ON text_chain_entries (session_id, word);

CREATE INDEX IF NOT EXISTS idx_number_chain_sessions_active
  ON number_chain_sessions (guild_id, channel_id, status, id DESC);

CREATE INDEX IF NOT EXISTS idx_number_chain_entries_session_result
  ON number_chain_entries (session_id, result);

CREATE INDEX IF NOT EXISTS idx_daily_events_due
  ON daily_events (status, window_end_at, guild_id, id);`;

// Part of schemaSql: idx_daily_event_messages_window, idx_daily_event_participants_reward
const dailyEventMessageIndexesSql = `CREATE INDEX IF NOT EXISTS idx_daily_event_messages_window
  ON daily_event_messages (event_id, created_at, message_id);

CREATE INDEX IF NOT EXISTS idx_daily_event_participants_reward
  ON daily_event_participants (event_id, eligible, correct, user_id);`;

// Created after the v12 word chain contract migration has reconciled legacy active sessions.
const wordChainActiveSessionIndexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_text_chain_one_active_guild
  ON text_chain_sessions (guild_id)
  WHERE status = 'active';
`;

// Created after the v13 number chain contract migration has reconciled legacy active sessions.
const numberChainActiveSessionIndexSql = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_number_chain_one_active_guild
  ON number_chain_sessions (guild_id)
  WHERE status = 'active';
`;

module.exports = {
  chainAndDailyEventTablesSql,
  chainAndDailyEventIndexesSql,
  dailyEventMessageIndexesSql,
  wordChainActiveSessionIndexSql,
  numberChainActiveSessionIndexSql,
};
