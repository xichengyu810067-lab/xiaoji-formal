// Conversation tables: user_chat_preferences and user_romance_preferences.
//
// Each constant is one run of statements of this family as it appears in the full schema text;
// schema/index.js puts the runs of every family back together in their original order, so the
// assembled SQL is exactly the text the coin database has always executed.

// Part of schemaSql: user_chat_preferences, user_romance_preferences
const preferenceTablesSql = `CREATE TABLE IF NOT EXISTS user_chat_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  style TEXT NOT NULL DEFAULT 'cute' CHECK (style IN ('cute', 'mature_sister', 'ceo', 'cold', 'tsundere', 'yandere')),
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_romance_preferences (
  user_id TEXT PRIMARY KEY NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  started_at TEXT,
  updated_at TEXT NOT NULL
);`;

module.exports = {
  preferenceTablesSql,
};
