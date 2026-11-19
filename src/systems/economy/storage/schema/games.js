// Game tables: game_*, discord_game_* and game_launch_receipts.
//
// Each constant is one run of statements of this family as it appears in the full schema text;
// schema/index.js puts the runs of every family back together in their original order, so the
// assembled SQL is exactly the text the coin database has always executed.

// Part of schemaSql: game_sessions, game_actions, game_rewards
const gameSessionTablesSql = `CREATE TABLE IF NOT EXISTS game_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  launch_token_hash TEXT NOT NULL UNIQUE,
  access_token_hash TEXT UNIQUE,
  launch_consumed_at TEXT,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  game_type TEXT NOT NULL CHECK (game_type IN ('tetris', 'number-match', 'sudoku')),
  difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'normal', 'complex', 'hard')),
  seed TEXT NOT NULL,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'failed')),
  action_count INTEGER NOT NULL DEFAULT 0 CHECK (action_count >= 0 AND action_count <= 500),
  score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 20000),
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0 AND reward_amount <= 1000),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS game_actions (
  session_id TEXT NOT NULL,
  action_index INTEGER NOT NULL CHECK (action_index >= 0 AND action_index < 500),
  action_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (session_id, action_index),
  FOREIGN KEY (session_id) REFERENCES game_sessions(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS game_rewards (
  session_id TEXT PRIMARY KEY NOT NULL,
  reward_key TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'no_reward')),
  amount INTEGER NOT NULL CHECK (amount >= 0 AND amount <= 1000),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES game_sessions(id) ON DELETE CASCADE
);`;

// Part of globalEconomyV22Sql: discord_game_sessions, discord_game_actions, discord_game_rewards
const discordGameTablesV22Sql = `CREATE TABLE IF NOT EXISTS discord_game_sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  source_guild_id TEXT NOT NULL,
  channel_id TEXT,
  message_id TEXT,
  game_type TEXT NOT NULL,
  difficulty TEXT,
  seed TEXT NOT NULL,
  state_json TEXT NOT NULL,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  action_count INTEGER NOT NULL DEFAULT 0 CHECK (action_count >= 0),
  score INTEGER NOT NULL DEFAULT 0,
  reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);
CREATE TABLE IF NOT EXISTS discord_game_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision > 0),
  interaction_id TEXT NOT NULL UNIQUE,
  action_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (session_id, revision),
  FOREIGN KEY (session_id) REFERENCES discord_game_sessions(id)
);
CREATE TABLE IF NOT EXISTS discord_game_rewards (
  session_id TEXT PRIMARY KEY,
  reward_key TEXT UNIQUE,
  status TEXT NOT NULL CHECK (status IN ('pending', 'granted', 'no_reward')),
  amount INTEGER NOT NULL CHECK (amount >= 0),
  receipt_id INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (session_id) REFERENCES discord_game_sessions(id)
);`;

// The v23 migration (idempotent game launches) creates this table.
const gameLaunchReceiptsV23Sql = `
CREATE TABLE IF NOT EXISTS game_launch_receipts (
  interaction_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  user_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

module.exports = {
  gameSessionTablesSql,
  discordGameTablesV22Sql,
  gameLaunchReceiptsV23Sql,
};
