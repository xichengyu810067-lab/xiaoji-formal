// The coin database: one SQLite file at COIN_DB_PATH, held open by one node:sqlite connection
// while the bot runs (see connection.js: EXCLUSIVE locking, WAL, synchronous=FULL), so every
// COMMIT is a durable write of just the pages it changed. This module is the public storage module
// of the economy system and holds the open connection (state), the operation queue every call runs
// on and the transaction wrappers. The rest of the storage lives next to it:
//   errors.js               CoinDatabaseError
//   sqlHelpers.js           statement helpers and table, foreign key and integrity checks
//   connection.js           the node:sqlite connections: the file, a new database, read-only copies
//   durableFile.js          the whole-file writes (new database, migration backup), escalations
//   safetyRegistrations.js  the safety ledger registrations and safety alert stamps in coin_metadata
//   schema/                 the CREATE TABLE, INDEX and TRIGGER text of every table family
//   migrations/             the migrations v2 to v24, the upgrade sequence of an opened database
//                           and the in-place migration of the file after a verified backup
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const logger = require('../../../utils/logger');
const { CoinDatabaseError } = require('./errors');
const {
  assertForeignKeysEnabled, exportDatabase, getRow, getRows, getTableNames, runSql,
  verifyForeignKeyIntegrity, verifyIntegrity,
} = require('./sqlHelpers');
const {
  assertDatabaseHeader, enableDurableJournal, existingSidecars, isLockedError, lockedError, openCoinConnection,
  openMemoryCopy, openMemoryDatabase, peekStoredSchemaVersion, readStoppedDatabaseBytes, readStoredSchemaVersion,
} = require('./connection');
const {
  createDatabaseFileDurably, getLedgerEscalations, probeDirectorySync, resetDurabilityForTests,
  resolveDurability, setCoinDatabaseDurabilityForTests, syncDirectoryAfterWrite, writeDatabaseFileDurably,
} = require('./durableFile');
const {
  SAFETY_ALERT_KEY_PREFIX, SAFETY_LEDGER_KEY_PREFIX, createSafetyRegistrationStore,
} = require('./safetyRegistrations');
const { schemaVersion } = require('./schema');
const { upgradeCoinDatabase, upgradeCoinDatabaseInPlace, writeSchemaVersion } = require('./migrations');
const { verifyGlobalWalletV20Schema } = require('./migrations/v20GlobalWallet');
const { verifyGlobalEconomyV21Schema } = require('./migrations/v21GlobalEconomy');
const { inspectGlobalEconomyV22 } = require('./migrations/v22GlobalEconomy');

const rootPath = path.resolve(__dirname, '..', '..', '..', '..');
const defaultRelativeDbPath = path.join('data', 'xiaoji.sqlite');

let initializationPromise = null;
let state = null;
let operationQueue = Promise.resolve();
let allowCreateOnNextOpenForTests = false;
// Set by closeCoinDatabase: from then on every new operation is refused instead of opening the
// database again (resetCoinDatabaseForTests clears it).
let closed = false;

function getCoinDatabasePath() {
  const configuredPath = String(process.env.COIN_DB_PATH || '').trim();
  const databasePath = configuredPath || defaultRelativeDbPath;

  if (path.isAbsolute(databasePath)) {
    return path.normalize(databasePath);
  }

  return path.resolve(rootPath, databasePath);
}

function buildApi(db) {
  return {
    db,
    all: (sql, params) => getRows(db, sql, params),
    get: (sql, params) => getRow(db, sql, params),
    run: (sql, params) => runSql(db, sql, params),
  };
}

// The schema version is storage metadata. Callers that need it while using an existing
// database callback receive it through this read port instead of naming coin_metadata.
function readCoinSchemaVersionWithApi(api) {
  return Number(api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'")?.value);
}

const activeTransactionApis = new WeakMap();
// Reminder-source proof deliberately supports the read-only database wrapper. Keep
// that narrower than the transaction-only capability used by penalty sources.
const activeWorkReminderReadApis = new WeakMap();

function readActiveWorkPenaltySource(api, { guildId, penaltyId, createdAt } = {}) {
  const context = activeTransactionApis.get(api);
  if (!context?.active || !state?.db || context.db !== state.db) return null;
  const row = getRow(
    context.db,
    `SELECT id, guild_id, user_id, job_name, penalty_amount, status, reason, announced_at,
            appeal_deadline_at, created_at
       FROM coin_work_penalties
      WHERE guild_id = ? AND id = ? AND created_at = ?`,
    [String(guildId || ''), Number(penaltyId), String(createdAt || '')]
  );
  return row ? Object.freeze({ ...row }) : null;
}

// Work reminder timestamps must name their offset with a trailing Z or ±HH:MM. A value
// without one would be read in the host's local time zone, so it never matches (fail
// closed). The reminder accounting module normalizes with this same function.
const ZONED_WORK_REMINDER_TIMESTAMP = /(?:Z|[+-]\d{2}:\d{2})$/u;

function normalizeWorkReminderTimestamp(value) {
  if (typeof value !== 'string' || !ZONED_WORK_REMINDER_TIMESTAMP.test(value)) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function readActiveWorkReminderSource(api, {
  guildId, userId, taskId, createdAt, scope, parentId,
} = {}) {
  const context = activeWorkReminderReadApis.get(api) || activeTransactionApis.get(api);
  if (!context?.active || !state?.db || context.db !== state.db) return null;
  const task = getRow(
    context.db,
    `SELECT id, guild_id, user_id, job_id, global_cycle_id, task_type, status, description,
            due_at, completed_at, reminder_count, last_reminder_at, created_at, updated_at
       FROM coin_work_tasks
      WHERE id = ? AND guild_id = ? AND user_id = ?`,
    [Number(taskId), String(guildId || ''), String(userId || '')]
  );
  // Reminder sources carry a normalized created_at, while older rows may store another
  // timestamp spelling. Compare the same normalized instant; a real mismatch fails closed.
  const expectedCreatedAt = normalizeWorkReminderTimestamp(createdAt);
  if (!task || !expectedCreatedAt || normalizeWorkReminderTimestamp(task.created_at) !== expectedCreatedAt) return null;
  if (scope === 'legacy') {
    if (!Number.isSafeInteger(Number(parentId)) || Number(task.job_id) !== Number(parentId) || task.global_cycle_id) return null;
    const parent = getRow(
      context.db,
      `SELECT id, guild_id, user_id, status, last_contribution_at, last_reminder_at, updated_at
         FROM coin_jobs WHERE id = ? AND guild_id = ? AND user_id = ?`,
      [Number(parentId), String(guildId || ''), String(userId || '')]
    );
    return parent ? Object.freeze({ scope, task: Object.freeze({ ...task }), parent: Object.freeze({ ...parent }) }) : null;
  }
  if (scope === 'global') {
    if (!String(parentId || '') || task.global_cycle_id !== String(parentId) || task.job_id != null) return null;
    const parent = getRow(
      context.db,
      `SELECT cycle_id, user_id, source_guild_id, status, starts_at, ends_at, updated_at
         FROM coin_primary_job_cycles WHERE cycle_id = ? AND user_id = ?`,
      [String(parentId), String(userId || '')]
    );
    return parent ? Object.freeze({ scope, task: Object.freeze({ ...task }), parent: Object.freeze({ ...parent }) }) : null;
  }
  return null;
}

function displayPath(dbPath) {
  return process.env.XIAOJI_RUNTIME_MODE === 'test-control' ? '[test-data]' : dbPath;
}

function closeQuietly(db) {
  try {
    if (db?.isOpen) db.close();
  } catch (error) {
    logger.error('吉幣資料庫連線關閉失敗。', error);
  }
}

function assertSupportedVersion({ value, raw }) {
  if (!Number.isInteger(value) || value < 0 || value > schemaVersion) {
    throw new CoinDatabaseError(`不支援的吉幣資料庫 schema 版本：${raw ?? 'unknown'}`);
  }
}

// A new database is built in memory (every table, every migration, schema_version) and its
// bytes are created at dbPath exclusively ('wx'), so an existing file is never overwritten.
// Returns the names of the tables it created.
function createNewDatabaseFile(dbPath, now) {
  let memory;
  let bytes;
  let createdTables;
  try {
    memory = openMemoryDatabase();
    verifyIntegrity(memory);
    verifyForeignKeyIntegrity(memory);
    const beforeTables = upgradeCoinDatabase(memory, { existed: false, sourceSha256: null });
    writeSchemaVersion(memory, now);
    verifyForeignKeyIntegrity(memory);
    createdTables = [...getTableNames(memory)].filter((name) => !beforeTables.has(name));
    bytes = exportDatabase(memory);
  } finally {
    closeQuietly(memory);
  }
  const durability = resolveDurability();
  createDatabaseFileDurably(dbPath, bytes, durability);
  // The file stands even when the directory sync after it failed (escalated, see durableFile.js).
  syncDirectoryAfterWrite(dbPath, durability, 'open');
  return createdTables;
}

// The open sequence of an existing file (see connection.js for the connection and
// migrations/index.js for the in-place migration):
//   1. The header must be SQLite's. A -wal or -journal beside the file is left by a bot that did
//      not stop cleanly: when the version it holds is current, SQLite replays it below; when the
//      version is behind (a migration that never finished), the start stops, since a migration
//      needs a file that is complete on its own.
//   2. The file is opened in EXCLUSIVE mode and its integrity and foreign keys are checked before
//      anything is written.
//   3. A version that is behind is migrated in place after a verified backup
//      (upgradeCoinDatabaseInPlace). A current one switches the connection to WAL and runs the
//      upgrade sequence, whose contract checks change nothing on a healthy database;
//      schema_version is written only when it differs.
async function openExistingDatabase(dbPath, now) {
  try {
    assertDatabaseHeader(dbPath);
  } catch (error) {
    logger.error(`吉幣資料庫讀取失敗，已停止載入：${displayPath(dbPath)}`, error);
    throw new CoinDatabaseError('吉幣資料庫讀取失敗，不會自動重建空資料庫。', error);
  }
  const sidecars = existingSidecars(dbPath);
  if (sidecars.length > 0) {
    let peeked;
    try {
      peeked = peekStoredSchemaVersion(dbPath, sidecars);
    } catch (error) {
      if (isLockedError(error)) throw lockedError(error);
      logger.error(`吉幣資料庫讀取失敗，已停止載入：${displayPath(dbPath)}`, error);
      throw new CoinDatabaseError('吉幣資料庫讀取失敗，不會自動重建空資料庫。', error);
    }
    assertSupportedVersion(peeked);
    if (peeked.value < schemaVersion) {
      throw new CoinDatabaseError(`吉幣資料庫需要從 v${peeked.value} 升級，但旁邊還有 ${sidecars.join('、')} 檔（上次沒有正常關閉，或升級中途停止）；已停止啟動。請先用能開它的版本正常停機，或從最新的遷移前備份（.bak）還原。`);
    }
  }

  let db;
  let storedVersion;
  try {
    db = openCoinConnection(dbPath);
    verifyIntegrity(db);
    verifyForeignKeyIntegrity(db);
    storedVersion = readStoredSchemaVersion(db);
  } catch (error) {
    closeQuietly(db);
    if (isLockedError(error)) throw lockedError(error);
    logger.error(`吉幣資料庫完整性檢查失敗，已停止載入：${displayPath(dbPath)}`, error);
    throw new CoinDatabaseError('吉幣資料庫完整性檢查失敗，不會覆寫原始檔案。', error);
  }
  try {
    assertSupportedVersion(storedVersion);
  } catch (error) {
    closeQuietly(db);
    throw error;
  }

  if (storedVersion.value < schemaVersion) {
    // Closed before the backup reads the file: closing any descriptor of it would otherwise drop
    // this connection's EXCLUSIVE lock (POSIX), see upgradeCoinDatabaseInPlace.
    closeQuietly(db);
    let migrated;
    try {
      migrated = await upgradeCoinDatabaseInPlace({
        dbPath, fromVersion: storedVersion.value, now, openConnection: openCoinConnection,
      });
    } catch (error) {
      if (isLockedError(error)) throw lockedError(error);
      if (error instanceof CoinDatabaseError) throw error;
      throw new CoinDatabaseError('吉幣資料庫升級時無法重新開啟檔案，原始檔案未改動；已停止啟動。', error);
    }
    return { db: migrated.db, beforeTables: migrated.beforeTables, migratedFrom: storedVersion.value };
  }
  try {
    enableDurableJournal(db);
    const beforeTables = upgradeCoinDatabase(db, { existed: true, sourceSha256: null });
    writeSchemaVersion(db, now);
    verifyForeignKeyIntegrity(db);
    return { db, beforeTables, migratedFrom: null };
  } catch (error) {
    closeQuietly(db);
    throw error;
  }
}

async function createOrOpenDatabase({ allowNewDatabase = false } = {}) {
  const dbPath = getCoinDatabasePath();
  const existed = fs.existsSync(dbPath);
  if (!existed && !allowNewDatabase) {
    throw new CoinDatabaseError('已選用的吉幣資料庫不存在；已停止啟動。新安裝須明確執行初始化，不能自動建立空庫。');
  }
  const now = new Date().toISOString();
  let createdTables = [];
  if (!existed) {
    try {
      createdTables = createNewDatabaseFile(dbPath, now);
    } catch (error) {
      if (error instanceof CoinDatabaseError) throw error;
      logger.error(`吉幣資料庫建立失敗：${displayPath(dbPath)}`, error);
      throw error;
    }
  }
  const opened = await openExistingDatabase(dbPath, now);
  if (existed) createdTables = [...getTableNames(opened.db)].filter((name) => !opened.beforeTables.has(name));

  const info = {
    path: dbPath,
    existed,
    createdDatabase: !existed,
    createdTables,
    schemaVersion,
    initializedAt: now,
  };

  state = {
    db: opened.db,
    info,
    lastSavedAt: now,
  };

  logger.info(`吉幣資料庫路徑：${displayPath(dbPath)}`);
  logger.info(`吉幣資料庫已存在：${existed ? '是' : '否'}`);
  logger.info(`吉幣資料庫新建：${!existed ? '是' : '否'}`);
  if (opened.migratedFrom !== null) logger.info(`吉幣資料庫已從 schema v${opened.migratedFrom} 升級到 v${schemaVersion}。`);
  logger.info(`吉幣資料表建立：${createdTables.length ? createdTables.join(', ') : '沒有缺少的資料表'}`);
  logger.info('吉幣系統資料庫載入成功。');

  return info;
}

function closedError() {
  return new CoinDatabaseError('吉幣資料庫已關閉（小吉正在停止），不再接受新的操作。');
}

async function initializeCoinDatabase() {
  if (closed) throw closedError();
  if (state) {
    assertForeignKeysEnabled(state.db);
    return state.info;
  }

  if (!initializationPromise) {
    const allowNewDatabase = allowCreateOnNextOpenForTests;
    allowCreateOnNextOpenForTests = false;
    initializationPromise = createOrOpenDatabase({ allowNewDatabase }).catch((error) => {
      initializationPromise = null;
      throw error;
    });
  }

  return initializationPromise;
}

async function initializeNewCoinDatabase({ expectedPath = getCoinDatabasePath() } = {}) {
  const activePath = path.resolve(getCoinDatabasePath());
  if (closed || path.resolve(expectedPath) !== activePath || fs.existsSync(activePath) || state || initializationPromise) {
    throw new CoinDatabaseError('初裝初始化要求目前所選資料庫路徑完全一致、來源不存在，且尚未開啟。');
  }
  initializationPromise = createOrOpenDatabase({ allowNewDatabase: true }).catch((error) => {
    initializationPromise = null;
    throw error;
  });
  return initializationPromise;
}

// Every call runs on one operation queue, in order. A write made here outside a transaction
// (ensureGuildSettings, say) commits on its own, statement by statement, and is on disk when it
// returns.
async function withCoinDatabase(work) {
  if (closed) return Promise.reject(closedError());
  const runOperation = async () => {
    await initializeCoinDatabase();
    const api = buildApi(state.db);
    // Source proofs are read-only facts. Mark this short-lived API as active for the
    // source readers without opening a write transaction.
    const readContext = { active: true, db: state.db };
    activeWorkReminderReadApis.set(api, readContext);
    try {
      return await work(api);
    } finally {
      readContext.active = false;
      activeWorkReminderReadApis.delete(api);
    }
  };

  const queuedOperation = operationQueue.then(runOperation, runOperation);
  operationQueue = queuedOperation.catch(() => {});
  return queuedOperation;
}

// Rolls back the transaction of the open connection, if one is still open (a COMMIT that failed
// may or may not have ended it).
function rollbackOpenTransaction(db, label) {
  if (!db?.isOpen || !db.isTransaction) return;
  try {
    db.exec('ROLLBACK');
  } catch (rollbackError) {
    logger.error(`${label} rollback 失敗。`, rollbackError);
  }
}

// BEGIN IMMEDIATE, work(api), COMMIT on the operation queue; anything that throws (work itself
// or the COMMIT) rolls the transaction back and is rethrown. The COMMIT is the durable write
// (WAL, synchronous=FULL): when it returns the transaction is on disk, and when it fails nothing
// of it is.
async function withCoinTransaction(work) {
  return withCoinDatabase(async (api) => {
    let transactionStarted = false;
    let transactionContext = null;
    const { db } = state;

    try {
      api.run('BEGIN IMMEDIATE');
      transactionStarted = true;
      transactionContext = { active: true, db };
      activeTransactionApis.set(api, transactionContext);
      let result;
      try {
        result = await work(api);
      } finally {
        transactionContext.active = false;
        activeTransactionApis.delete(api);
      }
      try {
        api.run('COMMIT');
      } catch (commitError) {
        // Nothing of the transaction reached the file; it is rolled back below.
        throw new CoinDatabaseError('吉幣資料庫落盤失敗，交易已復原。', commitError);
      }
      transactionStarted = false;
      state.lastSavedAt = new Date().toISOString();
      return result;
    } catch (error) {
      if (transactionContext) transactionContext.active = false;
      activeTransactionApis.delete(api);
      if (transactionStarted) rollbackOpenTransaction(db, '吉幣資料庫交易');
      throw error;
    }
  });
}

// Compare-and-set of coin_metadata entries ({ key, value }) in one BEGIN IMMEDIATE transaction:
// check(api) runs first and throws to refuse (that error is rethrown as it is, nothing written),
// then every entry is upserted and the transaction committed. Any other failure rolls back and
// throws failure(error). Returns the updated_at the entries were given.
async function commitCoinMetadata(api, entries, { check, failure }) {
  const { db } = state;
  const updatedAt = new Date().toISOString();
  api.run('BEGIN IMMEDIATE');
  try {
    check(api);
  } catch (error) {
    rollbackOpenTransaction(db, '安全帳本登記');
    throw error;
  }
  try {
    for (const entry of entries) {
      api.run(
        `INSERT INTO coin_metadata (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        [entry.key, entry.value, updatedAt]
      );
    }
    api.run('COMMIT');
  } catch (error) {
    rollbackOpenTransaction(db, '安全帳本登記');
    throw failure(error);
  }
  state.lastSavedAt = updatedAt;
  return updatedAt;
}

const {
  readSafetyLedgerRegistrations,
  writeSafetyLedgerRegistrations,
  readSafetyAlertStamp,
  writeSafetyAlertStamp,
  inspectSafetyRegistrationsFromFile,
} = createSafetyRegistrationStore({ withCoinDatabase, commitCoinMetadata });

async function getCoinDatabaseInfo() {
  await initializeCoinDatabase();

  return {
    ...state.info,
    lastSavedAt: state.lastSavedAt,
    exists: fs.existsSync(state.info.path),
  };
}

// Read-only, for the v22 release check: runs the v22 plan on an in-memory copy of a stopped
// bot's database file (connection.js: refused while a -wal lies beside it). The file is never
// written.
async function dryRunGlobalEconomyV22({ dbPath = getCoinDatabasePath(), now = new Date() } = {}) {
  const absolutePath = path.resolve(dbPath);
  if (!fs.existsSync(absolutePath)) throw new CoinDatabaseError('來源吉幣資料庫不存在，不能以空資料庫預演。');
  let db;
  try {
    const sourceBytes = readStoppedDatabaseBytes(absolutePath);
    const sourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
    db = openMemoryCopy(sourceBytes);
    verifyIntegrity(db);
    verifyForeignKeyIntegrity(db);
    const version = Number(getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'")?.value);
    if (version !== 21) throw new Error(`v22 dry run requires schema v21, received ${version}`);
    verifyGlobalWalletV20Schema(db);
    verifyGlobalEconomyV21Schema(db);
    return inspectGlobalEconomyV22(db, now, sourceSha256);
  } catch (error) {
    throw new CoinDatabaseError('吉幣資料庫 v22 預演失敗；來源未改動。', error);
  } finally {
    if (db) db.close();
  }
}

// A consistent, standalone copy of the open database at targetPath (which must not exist yet),
// taken on the operation queue between transactions (VACUUM INTO), fsynced and checked with
// PRAGMA quick_check. For the backups of a running bot. Returns { path, bytes, sha256 }.
async function snapshotCoinDatabase(targetPath) {
  if (!path.isAbsolute(String(targetPath || ''))) throw new CoinDatabaseError('吉幣資料庫快照路徑必須是絕對路徑。');
  const target = path.resolve(targetPath);
  return withCoinDatabase((api) => {
    if (target === path.resolve(state.info.path) || fs.existsSync(target)) {
      throw new CoinDatabaseError('吉幣資料庫快照的目標檔案已存在，不會覆寫。');
    }
    try {
      api.db.prepare('VACUUM INTO ?').run(target);
      const descriptor = fs.openSync(target, 'r+');
      try {
        fs.fsyncSync(descriptor);
      } finally {
        fs.closeSync(descriptor);
      }
      const bytes = fs.readFileSync(target);
      const copy = openMemoryCopy(bytes);
      try {
        const result = copy.prepare('PRAGMA quick_check').all().map((row) => row.quick_check);
        if (result.length !== 1 || result[0] !== 'ok') throw new Error(`quick_check: ${result.join('; ')}`);
      } finally {
        copy.close();
      }
      return Object.freeze({
        path: target,
        bytes: bytes.length,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
      });
    } catch (error) {
      fs.rmSync(target, { force: true });
      throw new CoinDatabaseError('吉幣資料庫快照失敗。', error);
    }
  });
}

// True while this process holds the database open and has not begun closing it; with dbPath,
// only when that is the file it holds (the same path, or the same real path). Read-only: it never
// opens the database or the file. A backup taken in this process uses snapshotCoinDatabase while
// this is true, and otherwise reads the file the way it reads any SQLite file it does not hold.
// (While the database is held, nothing in this process may open the file itself: on POSIX systems
// closing any descriptor of a file drops every lock the process holds on it, SQLite's exclusive
// lock included.)
function isCoinDatabaseOpen(dbPath = null) {
  if (closed || !state?.db?.isOpen) return false;
  if (dbPath == null) return true;
  const requested = path.resolve(String(dbPath));
  const held = path.resolve(state.info.path);
  if (requested === held) return true;
  try {
    return fs.realpathSync(requested) === fs.realpathSync(held);
  } catch {
    return false;
  }
}

const SQLITE_SIDECARS = Object.freeze(['-wal', '-shm', '-journal']);

function checkpointLockedError(cause = null) {
  return new CoinDatabaseError('吉幣資料庫正由另一個行程使用（database is locked）：小吉可能還在執行。請先正常停止小吉，再執行一次。', cause);
}

// For a downgrade to a version before this storage (sql.js), which reads only one self-contained
// rollback-journal file: opens the file of a stopped bot (it must exist; it is never created) in
// EXCLUSIVE mode, which replays a -wal a crash left beside it, checks its integrity, checkpoints
// the WAL into the file (TRUNCATE), switches it to journal_mode=DELETE, checks it again and closes
// it, then confirms nothing is left beside it. Nothing else changes. Refused while the database is
// held, here or by another process (database is locked). Returns { path, schemaVersion,
// sidecarsBefore, journalModeBefore, bytes, sha256 }.
function checkpointCoinDatabaseFile(dbPath) {
  const absolutePath = path.resolve(String(dbPath || ''));
  if (isCoinDatabaseOpen(absolutePath)) throw checkpointLockedError();
  if (!fs.existsSync(absolutePath)) throw new CoinDatabaseError('吉幣資料庫不存在；不會建立新的資料庫。');
  try {
    assertDatabaseHeader(absolutePath);
  } catch (error) {
    throw new CoinDatabaseError('吉幣資料庫檔案不是 SQLite 資料庫，或檔頭損壞；沒有改動。', error);
  }
  const sidecarsBefore = SQLITE_SIDECARS.filter((suffix) => fs.existsSync(`${absolutePath}${suffix}`));
  const header = Buffer.alloc(20);
  const descriptor = fs.openSync(absolutePath, 'r');
  try {
    fs.readSync(descriptor, header, 0, 20, 0);
  } finally {
    fs.closeSync(descriptor);
  }
  const journalModeBefore = header[18] === 2 && header[19] === 2 ? 'wal' : 'delete';
  let db;
  let schemaVersionValue;
  try {
    db = openCoinConnection(absolutePath);
    verifyIntegrity(db);
    schemaVersionValue = readStoredSchemaVersion(db).value;
    const checkpoint = getRow(db, 'PRAGMA wal_checkpoint(TRUNCATE)');
    if (Number(checkpoint?.busy) !== 0) throw new Error('WAL checkpoint did not complete');
    runSql(db, 'PRAGMA journal_mode = DELETE');
    const mode = String(getRow(db, 'PRAGMA journal_mode')?.journal_mode || '').toLowerCase();
    if (mode !== 'delete') throw new Error(`journal_mode stayed ${mode || 'unknown'}`);
    verifyIntegrity(db);
    db.close();
  } catch (error) {
    closeQuietly(db);
    if (isLockedError(error)) throw checkpointLockedError(error);
    throw new CoinDatabaseError('吉幣資料庫無法整理成單一檔案（完整性檢查或 WAL 合併失敗）；請保留所有檔案並查明原因。', error);
  }
  const left = SQLITE_SIDECARS.filter((suffix) => fs.existsSync(`${absolutePath}${suffix}`));
  if (left.length) {
    throw new CoinDatabaseError(`吉幣資料庫關閉後旁邊仍有 ${left.join('、')} 檔；請保留所有檔案並查明原因。`);
  }
  const bytes = fs.readFileSync(absolutePath);
  return Object.freeze({
    path: absolutePath,
    schemaVersion: schemaVersionValue,
    sidecarsBefore: Object.freeze(sidecarsBefore),
    journalModeBefore,
    bytes: bytes.length,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  });
}

// Closes the database at the stop: refuses every new operation, waits for the queued ones,
// then closes the connection, which checkpoints the -wal into the file and removes it. Safe to
// call more than once, and when the database was never opened.
async function closeCoinDatabase() {
  closed = true;
  if (initializationPromise) {
    try {
      await initializationPromise;
    } catch {
      // A failed open left nothing to close.
    }
  }
  await operationQueue;
  if (!state?.db) return;
  const { db } = state;
  state = null;
  initializationPromise = null;
  db.close();
  logger.info('吉幣資料庫已關閉。');
}

function resetCoinDatabaseForTests({ allowCreateOnNextOpen = false } = {}) {
  closeQuietly(state?.db);

  state = null;
  initializationPromise = null;
  operationQueue = Promise.resolve();
  closed = false;
  allowCreateOnNextOpenForTests = allowCreateOnNextOpen === true;
  resetDurabilityForTests();
}

module.exports = {
  CoinDatabaseError,
  SAFETY_ALERT_KEY_PREFIX,
  SAFETY_LEDGER_KEY_PREFIX,
  checkpointCoinDatabaseFile,
  closeCoinDatabase,
  dryRunGlobalEconomyV22,
  getCoinDatabaseInfo,
  getCoinDatabasePath,
  getLedgerEscalations,
  initializeCoinDatabase,
  initializeNewCoinDatabase,
  inspectSafetyRegistrationsFromFile,
  isCoinDatabaseOpen,
  normalizeWorkReminderTimestamp,
  probeDirectorySync,
  readCoinSchemaVersionWithApi,
  readActiveWorkReminderSource,
  readActiveWorkPenaltySource,
  readSafetyAlertStamp,
  readSafetyLedgerRegistrations,
  resetCoinDatabaseForTests,
  setCoinDatabaseDurabilityForTests,
  snapshotCoinDatabase,
  withCoinDatabase,
  withCoinTransaction,
  writeDatabaseFileDurably,
  writeSafetyAlertStamp,
  writeSafetyLedgerRegistrations,
};
