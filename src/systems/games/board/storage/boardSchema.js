const BOARD_SCHEMA_VERSION = 1;

const BOARD_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS board_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  message_id TEXT,
  game_key TEXT NOT NULL CHECK (game_key IN ('turtle-soup', 'chess', 'gomoku', 'go', 'checkers', 'xiangqi')),
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_board_sessions_active_channel
  ON board_sessions (guild_id, channel_id)
  WHERE status IN ('lobby', 'active');

CREATE INDEX IF NOT EXISTS idx_board_sessions_recovery
  ON board_sessions (status, expires_at, updated_at);

CREATE TABLE IF NOT EXISTS board_actions (
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1 AND revision <= 9007199254740991),
  interaction_id TEXT,
  actor_id TEXT,
  action_json TEXT NOT NULL,
  events_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, revision),
  FOREIGN KEY (session_id) REFERENCES board_sessions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_board_actions_interaction
  ON board_actions (interaction_id)
  WHERE interaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS board_interactions (
  interaction_id TEXT PRIMARY KEY NOT NULL,
  request_digest TEXT NOT NULL,
  session_id TEXT NOT NULL,
  session_revision INTEGER NOT NULL CHECK (session_revision >= 0 AND session_revision <= 9007199254740991),
  session_snapshot_json TEXT NOT NULL,
  events_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES board_sessions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_board_interactions_session
  ON board_interactions (session_id, session_revision);
`;

function installBoardSchema(api) {
  if (!api || typeof api.run !== 'function') throw new TypeError('A coinDatabase-compatible API is required.');
  api.run(BOARD_SCHEMA_SQL);
}

module.exports = { BOARD_SCHEMA_SQL, BOARD_SCHEMA_VERSION, installBoardSchema };
