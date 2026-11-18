const logger = require('../../../../utils/logger');
const { getColumnNames, getRow, getTableDefinition, getTableNames, verifyIntegrity } = require('../sqlHelpers');

// v15: daily riddle leases and private message records.
function assertDailyEventLinks(db) {
  const orphanMessage = getRow(
    db,
    `SELECT message.id
     FROM daily_event_messages AS message
     LEFT JOIN daily_events AS event ON event.id = message.event_id
     WHERE event.id IS NULL LIMIT 1`
  );
  const orphanParticipant = getRow(
    db,
    `SELECT participant.event_id
     FROM daily_event_participants AS participant
     LEFT JOIN daily_events AS event ON event.id = participant.event_id
     WHERE event.id IS NULL LIMIT 1`
  );
  if (orphanMessage || orphanParticipant) {
    throw new Error('daily riddle records contain an orphaned event reference');
  }
  const foreignKeyFailure = getRow(db, 'PRAGMA foreign_key_check');
  if (foreignKeyFailure) throw new Error('daily riddle records fail foreign key validation');
}

function migrateDailyRiddleV15Contract(db) {
  const eventColumnsV14 = [
    'id', 'guild_id', 'event_kind', 'local_date', 'riddle_id', 'parent_channel_id', 'announcement_message_id',
    'thread_id', 'answer_message_id', 'status', 'window_start_at', 'window_end_at', 'publish_marker', 'answer_marker',
    'published_at', 'history_reconciled_at', 'settled_at', 'attempt_count', 'last_error', 'created_at', 'updated_at',
  ];
  const eventColumnsV15 = [
    ...eventColumnsV14.slice(0, 18),
    'publish_lease_owner', 'publish_lease_until', 'settle_lease_owner', 'settle_lease_until',
    ...eventColumnsV14.slice(18),
  ];
  const messageColumnsV14 = [
    'id', 'event_id', 'guild_id', 'thread_id', 'message_id', 'user_id', 'created_at', 'content_hash', 'eligible', 'correct',
  ];
  const messageColumnsV15 = messageColumnsV14.filter((column) => column !== 'content_hash');
  const participantColumns = [
    'event_id', 'guild_id', 'user_id', 'eligible', 'correct', 'participation_reward_status', 'correct_reward_status',
    'created_at', 'updated_at',
  ];
  const exactColumns = (tableName, expected) => {
    const actual = getColumnNames(db, tableName);
    return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
  };
  if (!exactColumns('daily_event_participants', participantColumns)) {
    throw new Error('daily_event_participants has an incompatible schema');
  }

  const eventDefinition = getTableDefinition(db, 'daily_events');
  const messageDefinition = getTableDefinition(db, 'daily_event_messages');
  const currentShape =
    exactColumns('daily_events', eventColumnsV15) &&
    exactColumns('daily_event_messages', messageColumnsV15) &&
    eventDefinition.includes("check(statusin('claimed','published','published_late','settling','rewarding','settled','blocked','missed','failed'))") &&
    !messageDefinition.includes('content_hash');
  if (currentShape) {
    assertDailyEventLinks(db);
    return false;
  }

  const legacyShape =
    exactColumns('daily_events', eventColumnsV14) &&
    exactColumns('daily_event_messages', messageColumnsV14) &&
    eventDefinition.includes("check(statusin('claimed','published','published_late','settling','settled','blocked','missed','failed'))") &&
    messageDefinition.includes('content_hashtextnotnull') &&
    messageDefinition.includes('check(length(content_hash)=64');
  if (!legacyShape) throw new Error('daily riddle tables have an incompatible v14 schema');
  assertDailyEventLinks(db);
  for (const tableName of ['daily_events_v15_rebuild', 'daily_event_messages_v15_rebuild']) {
    if (getTableNames(db).has(tableName)) throw new Error(`unexpected migration table already exists: ${tableName}`);
  }

  const before = {
    events: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_events').count),
    messages: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_messages').count),
    participants: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_participants').count),
  };
  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    db.exec(`
      CREATE TABLE daily_events_v15_rebuild (
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
      CREATE TABLE daily_event_messages_v15_rebuild (
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
      INSERT INTO daily_events_v15_rebuild
        (id, guild_id, event_kind, local_date, riddle_id, parent_channel_id, announcement_message_id, thread_id,
         answer_message_id, status, window_start_at, window_end_at, publish_marker, answer_marker, published_at,
         history_reconciled_at, settled_at, attempt_count, publish_lease_owner, publish_lease_until,
         settle_lease_owner, settle_lease_until, last_error, created_at, updated_at)
      SELECT id, guild_id, event_kind, local_date, riddle_id, parent_channel_id, announcement_message_id, thread_id,
         answer_message_id, status, window_start_at, window_end_at, publish_marker, answer_marker, published_at,
         history_reconciled_at, settled_at, attempt_count, NULL, NULL, NULL, NULL, last_error, created_at, updated_at
      FROM daily_events;
      INSERT INTO daily_event_messages_v15_rebuild
        (id, event_id, guild_id, thread_id, message_id, user_id, created_at, eligible, correct)
      SELECT id, event_id, guild_id, thread_id, message_id, user_id, created_at, eligible, correct
      FROM daily_event_messages;
      DROP TABLE daily_event_messages;
      DROP TABLE daily_events;
      ALTER TABLE daily_events_v15_rebuild RENAME TO daily_events;
      ALTER TABLE daily_event_messages_v15_rebuild RENAME TO daily_event_messages;
    `);
    const after = {
      events: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_events').count),
      messages: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_messages').count),
      participants: Number(getRow(db, 'SELECT COUNT(*) AS count FROM daily_event_participants').count),
    };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('daily riddle migration row counts changed');
    assertDailyEventLinks(db);
    verifyIntegrity(db);
    db.exec('COMMIT');
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try {
        db.exec('ROLLBACK');
      } catch (rollbackError) {
        logger.error('Daily riddle v15 migration rollback failed', rollbackError);
      }
    }
    throw error;
  }
}

module.exports = {
  migrateDailyRiddleV15Contract,
};
