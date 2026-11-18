const { getColumnNames, getRows, getTableDefinition, getTableNames, runSql } = require('../sqlHelpers');

// v12 (validated word chain) and v13 (safe number chain): the session table contracts, and the
// reconciliation of legacy guilds with more than one active session before the one-active-session
// unique indexes are created.
function reconcileWordChainActiveSessions(db) {
  const timestamp = new Date().toISOString();
  const retainedByGuild = new Map();
  const activeSessions = getRows(
    db,
    `SELECT id, guild_id, channel_id
     FROM text_chain_sessions
     WHERE status = 'active'
     ORDER BY guild_id ASC, updated_at DESC, id DESC`
  );

  for (const session of activeSessions) {
    if (!retainedByGuild.has(session.guild_id)) {
      retainedByGuild.set(session.guild_id, session);
      continue;
    }
    runSql(
      db,
      `UPDATE text_chain_sessions
       SET status = 'stopped', stopped_at = COALESCE(stopped_at, updated_at), revision = revision + 1
       WHERE id = ? AND status = 'active'`,
      [session.id]
    );
  }

  const guildIds = new Set([
    ...getRows(db, 'SELECT DISTINCT guild_id FROM text_chain_sessions').map((row) => row.guild_id),
    ...getRows(db, "SELECT guild_id FROM feature_guild_settings WHERE feature_key = 'word_chain'").map((row) => row.guild_id),
  ]);
  const existingSettings = new Map(
    getRows(
      db,
      "SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'word_chain'"
    ).map((setting) => [setting.guild_id, setting])
  );

  for (const guildId of guildIds) {
    const retained = retainedByGuild.get(guildId);
    const enabled = retained ? 1 : 0;
    const channelId = retained?.channel_id || null;
    const existing = existingSettings.get(guildId);
    if (existing && Number(existing.enabled) === enabled && (existing.channel_id || null) === channelId) {
      continue;
    }
    runSql(
      db,
      `INSERT INTO feature_guild_settings
        (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
       VALUES (?, 'word_chain', ?, ?, '{}', ?, ?)
       ON CONFLICT(guild_id, feature_key) DO UPDATE SET
         enabled = excluded.enabled, channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
      [guildId, enabled, channelId, timestamp, timestamp]
    );
  }
}

function migrateWordChainV12Contract(db) {
  if (!getTableNames(db).has('text_chain_sessions')) {
    return;
  }

  const columns = new Set(getColumnNames(db, 'text_chain_sessions'));
  const definition = getTableDefinition(db, 'text_chain_sessions');
  const hasCompletedStatus = definition.includes("check(statusin('active','stopped','completed'))");

  if (columns.has('completed_at') && hasCompletedStatus) {
    return;
  }

  db.exec(`
    CREATE TABLE text_chain_sessions_rebuild (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped', 'completed')),
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
    INSERT INTO text_chain_sessions_rebuild
      (id, guild_id, channel_id, status, current_word, last_word, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, completed_at)
    SELECT id, guild_id, channel_id,
      CASE WHEN status = 'active' THEN 'active' ELSE 'stopped' END,
      current_word, last_word, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, NULL
    FROM text_chain_sessions;
    DROP TABLE text_chain_sessions;
    ALTER TABLE text_chain_sessions_rebuild RENAME TO text_chain_sessions;
  `);
}

function reconcileNumberChainActiveSessions(db) {
  const timestamp = new Date().toISOString();
  const retainedByGuild = new Map();
  const activeSessions = getRows(
    db,
    `SELECT id, guild_id, channel_id
     FROM number_chain_sessions
     WHERE status = 'active'
     ORDER BY guild_id ASC, updated_at DESC, id DESC`
  );
  for (const session of activeSessions) {
    if (!retainedByGuild.has(session.guild_id)) {
      retainedByGuild.set(session.guild_id, session);
      continue;
    }
    runSql(
      db,
      `UPDATE number_chain_sessions
       SET status = 'stopped', stopped_at = COALESCE(stopped_at, updated_at), revision = revision + 1
       WHERE id = ? AND status = 'active'`,
      [session.id]
    );
  }

  const guildIds = new Set([
    ...getRows(db, 'SELECT DISTINCT guild_id FROM number_chain_sessions').map((row) => row.guild_id),
    ...getRows(db, "SELECT guild_id FROM feature_guild_settings WHERE feature_key = 'number_chain'").map((row) => row.guild_id),
  ]);
  const existingSettings = new Map(
    getRows(db, "SELECT guild_id, enabled, channel_id FROM feature_guild_settings WHERE feature_key = 'number_chain'")
      .map((setting) => [setting.guild_id, setting])
  );
  for (const guildId of guildIds) {
    const retained = retainedByGuild.get(guildId);
    const enabled = retained ? 1 : 0;
    const channelId = retained?.channel_id || null;
    const existing = existingSettings.get(guildId);
    if (existing && Number(existing.enabled) === enabled && (existing.channel_id || null) === channelId) continue;
    runSql(
      db,
      `INSERT INTO feature_guild_settings
        (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
       VALUES (?, 'number_chain', ?, ?, '{}', ?, ?)
       ON CONFLICT(guild_id, feature_key) DO UPDATE SET
         enabled = excluded.enabled, channel_id = excluded.channel_id, updated_at = excluded.updated_at`,
      [guildId, enabled, channelId, timestamp, timestamp]
    );
  }
}

function migrateNumberChainV13Contract(db) {
  if (!getTableNames(db).has('number_chain_sessions')) return;

  const columns = new Set(getColumnNames(db, 'number_chain_sessions'));
  const definition = getTableDefinition(db, 'number_chain_sessions');
  const currentColumns = [
    'id', 'guild_id', 'channel_id', 'status', 'expected_target', 'last_user_id', 'revision', 'started_by', 'stopped_by',
    'created_at', 'updated_at', 'stopped_at', 'completed_at',
  ];
  const legacyColumns = currentColumns.filter((column) => column !== 'completed_at');
  const hasCurrentStatus = definition.includes("check(statusin('active','stopped','completed'))");
  const hasLegacyStatus = definition.includes("check(statusin('active','stopped'))");
  const hasAll = (required) => required.every((column) => columns.has(column));
  if (hasAll(currentColumns) && hasCurrentStatus) return;
  if (!hasAll(legacyColumns) || !hasLegacyStatus) {
    throw new Error('number_chain_sessions has an incompatible legacy schema');
  }

  db.exec(`
    CREATE TABLE number_chain_sessions_rebuild (
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
    INSERT INTO number_chain_sessions_rebuild
      (id, guild_id, channel_id, status, expected_target, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, completed_at)
    SELECT id, guild_id, channel_id,
      CASE WHEN status = 'active' THEN 'active' ELSE 'stopped' END,
      expected_target, last_user_id, revision, started_by, stopped_by, created_at, updated_at, stopped_at, NULL
    FROM number_chain_sessions;
    DROP TABLE number_chain_sessions;
    ALTER TABLE number_chain_sessions_rebuild RENAME TO number_chain_sessions;
  `);
}

module.exports = {
  reconcileWordChainActiveSessions,
  migrateWordChainV12Contract,
  reconcileNumberChainActiveSessions,
  migrateNumberChainV13Contract,
};
