const path = require('node:path');
const crypto = require('node:crypto');
const logger = require('../../../../utils/logger');
const { CoinDatabaseError } = require('../errors');
const {
  addColumnIfMissing, getRow, getRows, getTableNames, requireColumns, runSql, verifyForeignKeyIntegrity, verifyIntegrity,
} = require('../sqlHelpers');
const { resolveDurability, writeFileDurably } = require('../durableFile');
const { enableDurableJournal } = require('../connection');
const {
  coinAdminAddConfirmationsV24Sql,
  gameLaunchReceiptsV23Sql,
  globalWalletRevisionIndexSql,
  numberChainActiveSessionIndexSql,
  schemaSql,
  schemaVersion,
  wordChainActiveSessionIndexSql,
} = require('../schema');
const { verifyFeaturePlatformSchema } = require('./featurePlatformSchema');
const {
  migrateNumberChainV13Contract,
  migrateWordChainV12Contract,
  reconcileNumberChainActiveSessions,
  reconcileWordChainActiveSessions,
} = require('./v12v13Chains');
const { migrateDailyRiddleV15Contract } = require('./v15DailyRiddle');
const { migrateGameSessionsV18Bounds } = require('./v18GameSessions');
const { migrateGlobalWalletV20, verifyGlobalWalletV20Schema } = require('./v20GlobalWallet');
const { migrateGlobalEconomyV21, verifyGlobalEconomyV21Schema } = require('./v21GlobalEconomy');
const { migrateGlobalEconomyV22, verifyGlobalEconomyV22Schema } = require('./v22GlobalEconomy');
const { removeStaleWebGameHealthRows } = require('./staleGameHealthCleanup');

// The upgrade sequence of an opened database whose integrity was already checked: refuses an
// unsupported or damaged version, creates the missing tables (schemaSql), runs every migration the
// stored version still needs (v2 to v24, then the contract migrations that run on every open) and
// verifies the result. On failure it throws a CoinDatabaseError (and may already have closed db).
// It works on whatever db is: the in-memory database a new file is built in, or the open file
// itself, which upgradeCoinDatabaseInPlace below backs up first when the version is behind.
// Returns the names of the tables that existed before the schema was created.
function upgradeCoinDatabase(db, { existed, sourceSha256 }) {
  const beforeTables = getTableNames(db);
  const preBootstrapVersionRow = beforeTables.has('coin_metadata')
    ? getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'")
    : null;
  const preBootstrapVersion = preBootstrapVersionRow ? Number(preBootstrapVersionRow.value) : 0;

  if (!Number.isInteger(preBootstrapVersion) || preBootstrapVersion < 0 || preBootstrapVersion > schemaVersion) {
    db.close();
    throw new CoinDatabaseError(`不支援的吉幣資料庫 schema 版本：${preBootstrapVersionRow?.value ?? 'unknown'}`);
  }
  if (preBootstrapVersion >= 20) {
    try {
      verifyGlobalWalletV20Schema(db);
      if (preBootstrapVersion >= 21) verifyGlobalEconomyV21Schema(db);
      if (preBootstrapVersion >= 22) verifyGlobalEconomyV22Schema(db);
      if (preBootstrapVersion >= 24) requireColumns(db, 'coin_admin_add_confirmations', [
        'operation_id', 'mode', 'actor_user_id', 'guild_id', 'target_user_id', 'role_id',
        'campaign_id', 'preview_token', 'amount', 'reason', 'expires_at', 'payload_hash',
        'status', 'result_json', 'created_at', 'updated_at',
      ]);
    } catch (error) {
      db.close();
      throw new CoinDatabaseError('吉幣資料庫 v20 結構不完整、不支援，或 v21/v22 全域經濟契約損壞；已停止啟動避免建立第二份權威資料。', error);
    }
  }

  try {
    db.exec(schemaSql);
  } catch (error) {
    db.close();
    logger.error('Coin database schema bootstrap failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  // Simple migration for version 2 (Bank System)
  const currentVersionRow = getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'");
  const currentVersion = currentVersionRow ? Number(currentVersionRow.value) : 0;

  if (!Number.isInteger(currentVersion) || currentVersion < 0 || currentVersion > schemaVersion) {
    db.close();
    throw new CoinDatabaseError(`不支援的吉幣資料庫 schema 版本：${currentVersionRow?.value ?? 'unknown'}`);
  }

  if (currentVersion < 2) {
    logger.info('正在執行資料庫遷移至版本 2 (銀行系統)...');
    try {
      // SQLite doesn't support multiple columns in one ALTER TABLE, and might fail if columns already exist.
      // We check if the column exists by trying to select it or using pragma table_info.
      const columns = getRows(db, "PRAGMA table_info(coin_players)").map(c => c.name);
      
      if (!columns.includes('bank_balance')) {
        runSql(db, "ALTER TABLE coin_players ADD COLUMN bank_balance INTEGER NOT NULL DEFAULT 0");
      }
      if (!columns.includes('bank_interest_accrued')) {
        runSql(db, "ALTER TABLE coin_players ADD COLUMN bank_interest_accrued REAL NOT NULL DEFAULT 0");
      }
      if (!columns.includes('last_interest_date')) {
        runSql(db, "ALTER TABLE coin_players ADD COLUMN last_interest_date TEXT");
      }
      logger.info('資料庫遷移至版本 2 完成。');
    } catch (error) {
      logger.error('資料庫遷移至版本 2 失敗。', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 3) {
    logger.info('Migrating coin database schema to version 3 (fixed deposits, rates, work tasks).');
    try {
      addColumnIfMissing(db, 'coin_purchases', 'item_type', "TEXT NOT NULL DEFAULT 'collectible'");
      addColumnIfMissing(db, 'coin_purchases', 'status', "TEXT NOT NULL DEFAULT 'active'");
      addColumnIfMissing(db, 'coin_purchases', 'expires_at', 'TEXT');

      addColumnIfMissing(db, 'coin_jobs', 'job_role_id', 'TEXT');
      addColumnIfMissing(db, 'coin_jobs', 'last_contribution_at', 'TEXT');
      addColumnIfMissing(db, 'coin_jobs', 'last_reminder_at', 'TEXT');
      addColumnIfMissing(db, 'coin_jobs', 'today_task_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_jobs', 'today_completed_task_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_jobs', 'no_work_available_today', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_jobs', 'payroll_status', "TEXT NOT NULL DEFAULT 'pending'");
    } catch (error) {
      logger.error('Coin database schema v3 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 4) {
    logger.info('Migrating coin database schema to version 4 (editable work submissions and payroll safety).');
    try {
      addColumnIfMissing(db, 'coin_work_tasks', 'attachment_urls', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'expected_channel_id', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'expected_channel_name', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'message_id', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'external_server_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_work_tasks', 'external_server_ids', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'reviewed_by', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'review_reason', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'is_paid', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_work_tasks', 'paid_at', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'paid_amount', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'coin_work_tasks', 'updated_at', 'TEXT');
      addColumnIfMissing(db, 'coin_work_tasks', 'deleted_at', 'TEXT');
    } catch (error) {
      logger.error('Coin database schema v4 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 5) {
    logger.info('Migrating coin database schema to version 5 (casino games and loans).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v5 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 6) {
    logger.info('Migrating coin database schema to version 6 (casino debt controls).');
    try {
      addColumnIfMissing(db, 'casino_loans', 'relief_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'casino_loans', 'relief_updated_by', 'TEXT');
      addColumnIfMissing(db, 'casino_loans', 'relief_updated_at', 'TEXT');
    } catch (error) {
      logger.error('Coin database schema v6 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 7) {
    logger.info('Migrating coin database schema to version 7 (casino venue services).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v7 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 8) {
    logger.info('Migrating coin database schema to version 8 (chips, luxury shop, pawn shop).');
    try {
      db.exec(schemaSql);
      addColumnIfMissing(db, 'casino_games', 'currency', "TEXT NOT NULL DEFAULT 'coin'");
      addColumnIfMissing(db, 'casino_blackjack_sessions', 'currency', "TEXT NOT NULL DEFAULT 'coin'");
      addColumnIfMissing(db, 'casino_ledger', 'currency', "TEXT NOT NULL DEFAULT 'coin'");

      const itemsWithoutHistory = getRows(
        db,
        `SELECT id, guild_id, price, created_by, created_at
         FROM luxury_items
         WHERE NOT EXISTS (
           SELECT 1
           FROM luxury_price_history
           WHERE luxury_price_history.guild_id = luxury_items.guild_id
             AND luxury_price_history.item_id = luxury_items.id
         )`
      );

      for (const item of itemsWithoutHistory) {
        runSql(
          db,
          `INSERT INTO luxury_price_history (guild_id, item_id, price, changed_by, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
          [item.guild_id, item.id, item.price, item.created_by || null, 'initial price migration', item.created_at || new Date().toISOString()]
        );
      }
    } catch (error) {
      logger.error('Coin database schema v8 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 9) {
    logger.info('Migrating coin database schema to version 9 (venue waiters and work penalties).');
    try {
      db.exec(schemaSql);
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_user_id', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_job_id', 'INTEGER');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_job_name', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_assigned_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'waiter_due_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_amount', 'INTEGER NOT NULL DEFAULT 0');
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_status', "TEXT NOT NULL DEFAULT 'none'");
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_paid_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'tip_refunded_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'served_at', 'TEXT');
      addColumnIfMissing(db, 'casino_venue_orders', 'served_by', 'TEXT');
    } catch (error) {
      logger.error('Coin database schema v9 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 10) {
    logger.info('Migrating coin database schema to version 10 (casino lodging and duel tower).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v10 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 11) {
    logger.info('Migrating coin database schema to version 11 (community feature platform foundation).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v11 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 12) {
    logger.info('Migrating coin database schema to version 12 (validated word chain).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v12 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 13) {
    logger.info('Migrating coin database schema to version 13 (safe number chain).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v13 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 14) {
    logger.info('Migrating coin database schema to version 14 (daily riddle events).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v14 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 15) {
    logger.info('Migrating coin database schema to version 15 (daily riddle leases and private message records).');
    try {
      migrateDailyRiddleV15Contract(db);
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v15 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 16) {
    logger.info('Migrating coin database schema to version 16 (global user chat preferences).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v16 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 17) {
    logger.info('Migrating coin database schema to version 17 (global romance preferences).');
    try {
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v17 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 18) {
    logger.info('Migrating coin database schema to version 18 (server-authoritative games).');
    try { db.exec(schemaSql); }
    catch (error) {
      logger.error('Coin database schema v18 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 19) {
    logger.info('Migrating coin database schema to version 19 (official GitHub release announcements).');
    try { db.exec(schemaSql); }
    catch (error) {
      logger.error('Coin database schema v19 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
    }
  }

  if (currentVersion < 20) {
    logger.info('Migrating coin database schema to version 20 (global spendable wallets).');
    try {
      migrateGlobalWalletV20(db, currentVersion);
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v20 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫 v20 全域錢包升級失敗，原始資料不會被覆寫。', error);
    }
  }

  if (currentVersion < 21) {
    logger.info('Migrating coin database schema to version 21 (global daily, stores, and debt).');
    try {
      migrateGlobalEconomyV21(db, currentVersion);
      db.exec(schemaSql);
    } catch (error) {
      logger.error('Coin database schema v21 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫 v21 全域經濟升級失敗，原始資料不會被覆寫。', error);
    }
  }

  if (currentVersion < 22) {
    try {
      const reviewedV21Source = existed && preBootstrapVersion === 21;
      migrateGlobalEconomyV22(db, {
        expectedSourceSha256: reviewedV21Source ? process.env.COIN_V22_EXPECTED_SOURCE_SHA256 || null : null,
        requireExpectedSource: reviewedV21Source,
        sourceSha256: reviewedV21Source ? sourceSha256 : null,
      });
    } catch (error) {
      db.close();
      logger.error('Coin database schema v22 migration failed', error);
      throw new CoinDatabaseError('吉幣資料庫 v22 全域銀行與籌碼升級未完成，原始資料不會被覆寫。', error);
    }
  }

  if (currentVersion < 23) {
    logger.info('Migrating coin database schema to version 23 (idempotent game launches).');
    try {
      db.exec(gameLaunchReceiptsV23Sql);
      requireColumns(db, 'game_launch_receipts', [
        'interaction_id', 'kind', 'user_id', 'guild_id', 'channel_id', 'payload_hash', 'result_json', 'created_at',
      ]);
    } catch (error) {
      db.close();
      logger.error('Coin database schema v23 migration failed', error);
      throw new CoinDatabaseError('遊戲開局防重結構升級失敗，原始資料不會被覆寫。', error);
    }
  }

  if (currentVersion < 24) {
    logger.info('Migrating coin database schema to version 24 (persistent coin admin confirmations).');
    let transactionStarted = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;
      db.exec(coinAdminAddConfirmationsV24Sql);
      requireColumns(db, 'coin_admin_add_confirmations', [
        'operation_id', 'mode', 'actor_user_id', 'guild_id', 'target_user_id', 'role_id',
        'campaign_id', 'preview_token', 'amount', 'reason', 'expires_at', 'payload_hash',
        'status', 'result_json', 'created_at', 'updated_at',
      ]);
      db.exec('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) db.exec('ROLLBACK');
      db.close();
      logger.error('Coin database schema v24 migration failed', error);
      throw new CoinDatabaseError('加幣確認狀態結構升級失敗，原始資料不會被覆寫。', error);
    }
  }

  try {
    db.exec(globalWalletRevisionIndexSql);
  } catch (error) {
    logger.error('Coin database global wallet revision index creation failed', error);
    throw new CoinDatabaseError('吉幣資料庫 v20 全域錢包索引建立失敗，原始資料不會被覆寫。', error);
  }

  try {
    migrateGameSessionsV18Bounds(db);
    db.exec(schemaSql);
  } catch (error) {
    logger.error('Coin database schema v18 game bounds migration failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  try {
    migrateWordChainV12Contract(db);
    // Rows created before corpus pinning keep the original 313-word rules.
    addColumnIfMissing(db, 'text_chain_sessions', 'corpus_version', "TEXT NOT NULL DEFAULT '2026.09.03-1'");
    reconcileWordChainActiveSessions(db);
    // Recreate v12 indexes after a legacy session-table rebuild only after
    // multiple legacy active sessions have been deterministically reconciled.
    db.exec(schemaSql);
    db.exec(wordChainActiveSessionIndexSql);
  } catch (error) {
    logger.error('Coin database schema v12 word-chain contract migration failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  try {
    migrateNumberChainV13Contract(db);
    reconcileNumberChainActiveSessions(db);
    // The partial index is deliberately last so legacy multi-active rows can
    // be retained and reconciled before SQLite enforces the invariant.
    db.exec(schemaSql);
    db.exec(numberChainActiveSessionIndexSql);
  } catch (error) {
    logger.error('Coin database schema v13 number-chain contract migration failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  // Not a versioned migration: the stale health rows of the retired web game server are deleted on
  // whichever open finds them, so the schema version (and a rollback to the release before) stays.
  try {
    const removed = removeStaleWebGameHealthRows(db);
    if (removed > 0) logger.info(`Removed ${removed} stale web game server health row(s).`);
  } catch (error) {
    logger.error('Coin database stale game health cleanup failed', error);
    throw new CoinDatabaseError('吉幣資料庫升級失敗，已停止啟動避免破壞資料。', error);
  }

  try {
    verifyFeaturePlatformSchema(db);
    verifyGlobalWalletV20Schema(db);
    verifyGlobalEconomyV21Schema(db);
    verifyGlobalEconomyV22Schema(db);
    requireColumns(db, 'game_launch_receipts', [
      'interaction_id', 'kind', 'user_id', 'guild_id', 'channel_id', 'payload_hash', 'result_json', 'created_at',
    ]);
    requireColumns(db, 'coin_admin_add_confirmations', [
      'operation_id', 'mode', 'actor_user_id', 'guild_id', 'target_user_id', 'role_id',
      'campaign_id', 'preview_token', 'amount', 'reason', 'expires_at', 'payload_hash',
      'status', 'result_json', 'created_at', 'updated_at',
    ]);
  } catch (error) {
    db.close();
    logger.error('Coin database global economy schema verification failed', error);
    throw new CoinDatabaseError('吉幣資料庫 v20–v24 結構驗證失敗；已停止啟動避免破壞資料。', error);
  }

  return beforeTables;
}

// Records the current schema version in coin_metadata, unless it is already stored (so an open
// that needs no migration writes nothing here).
function writeSchemaVersion(db, now) {
  const stored = getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'");
  if (stored && String(stored.value) === String(schemaVersion)) return false;
  runSql(
    db,
    `INSERT INTO coin_metadata (key, value, updated_at)
     VALUES ('schema_version', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [String(schemaVersion), now]
  );
  return true;
}

// ---------------------------------------------------------------------------
// Migrating the file in place, after a verified backup
// ---------------------------------------------------------------------------
// A file whose schema_version is behind is migrated in place, on the connection that then stays
// open, never without a backup:
//   1. The open sequence (coinDatabase.js) has already refused the file when a -wal or -journal
//      lay beside it, opened it in EXCLUSIVE mode and checked it; nothing has been written yet.
//   2. The file is read and hashed (SHA-256) and written to <db>.pre-v<old>-<UTC>.bak: a
//      temporary file in the same folder, fsync, rename, directory sync (writeFileDurably). The
//      backup is read back and its hash compared, and only the newest MIGRATION_BACKUPS_KEPT of
//      these backups are kept.
//   3. The file's hash is checked again, then the connection switches to WAL and the migrations
//      run (upgradeCoinDatabase), followed by schema_version, an integrity check and a foreign key
//      check.
//   4. When anything in 3 fails, the connection is closed, the -wal (whatever it still holds) is
//      removed, and the backup is put back the same durable way; the file's hash must then equal
//      the hash taken in 2, and the original error is thrown. If putting the backup back fails
//      too, COIN_DB_MIGRATION_RESTORE_FAILED is thrown, naming the backup file.
const MIGRATION_BACKUPS_KEPT = 3;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function migrationBackupPattern(dbPath) {
  return new RegExp(`^${escapeRegExp(path.basename(dbPath))}\\.pre-v\\d+-(\\d{8}T\\d{9}Z)\\.bak$`, 'u');
}

function migrationBackupPath(dbPath, fromVersion, at = new Date()) {
  const stamp = at.toISOString().replace(/[-:.]/gu, '');
  return `${dbPath}.pre-v${fromVersion}-${stamp}.bak`;
}

// Removes all but the newest MIGRATION_BACKUPS_KEPT backups of this database (by the time in
// their names). A failure only warns: the migration itself is already safe.
function pruneMigrationBackups(dbPath, { filesystem }) {
  try {
    const pattern = migrationBackupPattern(dbPath);
    const backups = filesystem.readdirSync(path.dirname(dbPath))
      .map((name) => ({ name, stamp: pattern.exec(name)?.[1] }))
      .filter((entry) => entry.stamp)
      .sort((left, right) => (left.stamp < right.stamp ? 1 : left.stamp > right.stamp ? -1 : 0));
    for (const { name } of backups.slice(MIGRATION_BACKUPS_KEPT)) {
      filesystem.unlinkSync(path.join(path.dirname(dbPath), name));
    }
  } catch (error) {
    logger.warn(`[COIN_DB] code=COIN_DB_BACKUP_PRUNE_FAILED errno=${String(error?.code || 'UNKNOWN').slice(0, 32)}`);
  }
}

async function writeMigrationBackup(dbPath, fromVersion, durability) {
  const sourceBytes = durability.filesystem.readFileSync(dbPath);
  const sourceSha256 = sha256(sourceBytes);
  const backupPath = migrationBackupPath(dbPath, fromVersion);
  await writeFileDurably(backupPath, sourceBytes, durability);
  if (sha256(durability.filesystem.readFileSync(backupPath)) !== sourceSha256) {
    throw new Error('the migration backup does not read back as written');
  }
  pruneMigrationBackups(dbPath, durability);
  return { backupPath, sourceSha256 };
}

function removeSidecars(dbPath, filesystem) {
  for (const suffix of ['-wal', '-shm', '-journal']) {
    if (filesystem.existsSync(`${dbPath}${suffix}`)) filesystem.unlinkSync(`${dbPath}${suffix}`);
  }
}

async function restoreMigrationBackup(db, dbPath, { backupPath, sourceSha256 }, durability) {
  try {
    if (db.isOpen) db.close();
  } catch (closeError) {
    logger.error('吉幣資料庫遷移失敗後關閉連線失敗。', closeError);
  }
  try {
    // The -wal goes first: left beside the restored file, it would be replayed into it.
    removeSidecars(dbPath, durability.filesystem);
    const backupBytes = durability.filesystem.readFileSync(backupPath);
    if (sha256(backupBytes) !== sourceSha256) throw new Error('the migration backup changed');
    await writeFileDurably(dbPath, backupBytes, durability);
    if (sha256(durability.filesystem.readFileSync(dbPath)) !== sourceSha256) {
      throw new Error('the restored database does not match the backup');
    }
  } catch (restoreError) {
    const error = new CoinDatabaseError(
      `吉幣資料庫遷移失敗，且無法自動從備份還原；已停止啟動。請手動用備份檔 ${path.basename(backupPath)} 還原。`,
      restoreError);
    error.code = 'COIN_DB_MIGRATION_RESTORE_FAILED';
    error.backupFile = path.basename(backupPath);
    throw error;
  }
}

// Backs up and migrates the file in place (see above). The caller has closed its own connection
// to dbPath first: on POSIX, closing any descriptor of a file drops every lock this process holds
// on it, so the file is read for the backup and the hash check only while no SQLite connection is
// open on it, and openConnection(dbPath) opens it again (EXCLUSIVE) afterwards. Nothing is written
// before that connection exists, so a failure to open it (another process took the file in
// between, for example) leaves the file as it was and restores nothing. Returns
// { db, beforeTables, sourceSha256, backupPath }, db open and in WAL mode.
async function upgradeCoinDatabaseInPlace({ dbPath, fromVersion, now, openConnection }) {
  const durability = resolveDurability();
  let backup;
  try {
    backup = await writeMigrationBackup(dbPath, fromVersion, durability);
    if (sha256(durability.filesystem.readFileSync(dbPath)) !== backup.sourceSha256) {
      throw new CoinDatabaseError('吉幣來源資料庫在載入期間已變更，已停止遷移避免覆蓋。');
    }
  } catch (error) {
    if (error instanceof CoinDatabaseError) throw error;
    throw new CoinDatabaseError('吉幣資料庫遷移前的備份失敗，原始檔案未改動；已停止啟動。', error);
  }
  logger.info(`吉幣資料庫遷移前備份：${path.basename(backup.backupPath)}（schema v${fromVersion}）`);
  const db = openConnection(dbPath);
  try {
    enableDurableJournal(db);
    const beforeTables = upgradeCoinDatabase(db, { existed: true, sourceSha256: backup.sourceSha256 });
    writeSchemaVersion(db, now);
    verifyIntegrity(db);
    verifyForeignKeyIntegrity(db);
    return { db, beforeTables, sourceSha256: backup.sourceSha256, backupPath: backup.backupPath };
  } catch (error) {
    await restoreMigrationBackup(db, dbPath, backup, durability);
    logger.error(`吉幣資料庫遷移失敗，已從備份還原原始檔案：${path.basename(backup.backupPath)}`);
    throw error instanceof CoinDatabaseError
      ? error : new CoinDatabaseError('吉幣資料庫升級失敗，已從遷移前備份還原原始檔案。', error);
  }
}

module.exports = {
  MIGRATION_BACKUPS_KEPT,
  migrationBackupPath,
  upgradeCoinDatabase,
  upgradeCoinDatabaseInPlace,
  writeSchemaVersion,
};
