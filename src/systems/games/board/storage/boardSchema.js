const { GAME_KEYS } = require('../core/contracts');

// Version 2 lets board_sessions accept every key in GAME_KEYS (werewolf joined in version 2). The CHECK list is built
// from GAME_KEYS, and a stored table whose CHECK misses a key is rebuilt in place, so adding a game never needs a
// hand-written migration.
const BOARD_SCHEMA_VERSION = 2;

const GAME_KEY_CHECK = GAME_KEYS.map((key) => `'${key}'`).join(', ');

function sessionsTableSql(name, ifNotExists = false) {
  return `
CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  game_key TEXT NOT NULL CHECK (game_key IN (${GAME_KEY_CHECK})),
  rules_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('lobby', 'active', 'completed', 'cancelled', 'expired')),
  host_id TEXT NOT NULL,
  players_json TEXT NOT NULL,
  rules_json TEXT NOT NULL,
  seed TEXT NOT NULL,
  state_json TEXT,
  turn_json TEXT,
  outcome_json TEXT,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0 AND revision <= 9007199254740991),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_progress_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT
);`;
}

function actionsTableSql(name, sessionsTable, ifNotExists = false) {
  return `
CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  interaction_id TEXT,
  actor_id TEXT,
  action_json TEXT NOT NULL,
  events_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, revision),
  FOREIGN KEY (session_id) REFERENCES ${sessionsTable}(id) ON DELETE CASCADE
);`;
}

function interactionsTableSql(name, sessionsTable, ifNotExists = false) {
  return `
CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${name} (
  interaction_id TEXT PRIMARY KEY NOT NULL,
  request_digest TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_revision INTEGER NOT NULL CHECK (session_revision >= 0 AND session_revision <= 9007199254740991),
  session_snapshot_json TEXT NOT NULL,
  events_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES ${sessionsTable}(id) ON DELETE CASCADE
);`;
}

const BOARD_INDEX_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_board_sessions_active_channel
  ON board_sessions (guild_id, channel_id)
  WHERE status IN ('lobby', 'active');

CREATE INDEX IF NOT EXISTS idx_board_sessions_recovery
  ON board_sessions (status, expires_at, updated_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_board_actions_interaction
  ON board_actions (interaction_id)
  WHERE interaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_board_interactions_session
  ON board_interactions (session_id, session_revision);
`;

const BOARD_SCHEMA_SQL = [
  sessionsTableSql('board_sessions', true),
  actionsTableSql('board_actions', 'board_sessions', true),
  interactionsTableSql('board_interactions', 'board_sessions', true),
  BOARD_INDEX_SQL,
].join('\n');

const BOARD_TABLES = Object.freeze(['board_sessions', 'board_actions', 'board_interactions']);

function sessionsTableAcceptsEveryGame(api) {
  const row = api.get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'board_sessions'");
  const sql = String(row?.sql || '');
  return GAME_KEYS.every((key) => sql.includes(`'${key}'`));
}

function countRows(api) {
  return BOARD_TABLES.map((table) => Number(api.get(`SELECT COUNT(*) AS count FROM ${table}`).count));
}

// SQLite cannot change a CHECK constraint, so the three board tables are copied into new tables, the old ones are
// dropped (children first, so no cascade runs) and the copies take their names. Runs inside the caller's transaction;
// a row-count mismatch throws and rolls the whole rebuild back.
function rebuildBoardTables(api) {
  const before = countRows(api);
  api.run([
    sessionsTableSql('board_sessions_rebuild'),
    actionsTableSql('board_actions_rebuild', 'board_sessions_rebuild'),
    interactionsTableSql('board_interactions_rebuild', 'board_sessions_rebuild'),
    'INSERT INTO board_sessions_rebuild SELECT * FROM board_sessions;',
    'INSERT INTO board_actions_rebuild SELECT * FROM board_actions;',
    'INSERT INTO board_interactions_rebuild SELECT * FROM board_interactions;',
    'DROP TABLE board_interactions;',
    'DROP TABLE board_actions;',
    'DROP TABLE board_sessions;',
    'ALTER TABLE board_sessions_rebuild RENAME TO board_sessions;',
    'ALTER TABLE board_actions_rebuild RENAME TO board_actions;',
    'ALTER TABLE board_interactions_rebuild RENAME TO board_interactions;',
  ].join('\n'));
  api.run(BOARD_INDEX_SQL);
  const after = countRows(api);
  if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('board table rebuild changed row counts');
  if (!sessionsTableAcceptsEveryGame(api)) throw new Error('board table rebuild did not widen the game list');
}

function installBoardSchema(api) {
  if (!api || typeof api.run !== 'function' || typeof api.get !== 'function') {
    throw new TypeError('A coinDatabase-compatible API is required.');
  }
  api.run(BOARD_SCHEMA_SQL);
  if (!sessionsTableAcceptsEveryGame(api)) rebuildBoardTables(api);
}

module.exports = { BOARD_SCHEMA_SQL, BOARD_SCHEMA_VERSION, installBoardSchema };
