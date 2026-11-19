const fs = require('node:fs');
const path = require('node:path');
const logger = require('../../../utils/logger');
const { CoinDatabaseError } = require('./errors');
const { exportDatabase } = require('./sqlHelpers');

// ---------------------------------------------------------------------------
// Durable file writes of the coin database
// ---------------------------------------------------------------------------
// The open connection writes the database file itself (node:sqlite, WAL with
// synchronous=FULL): every COMMIT is the durable write, and no transaction comes through this
// module. What is left here are the few whole-file writes around it:
//
//   - A new database (initialization) is built in memory and created in place, exclusively
//     ('wx': never over an existing file), written, fsynced and closed, and the directory is
//     synced. A crash during that can leave an incomplete new file, which the next start
//     refuses, before anything was stored in it.
//   - Before a migration the file is copied to a backup, and after a failed migration the backup
//     is put back (see migrations/index.js). Both go through writeFileDurably: the bytes are
//     written to <target>.tmp in the same directory, fsynced and closed, then renamed over the
//     target (an atomic replace; a Windows scanner's EPERM/EBUSY/EACCES on the rename is
//     retried), and finally the directory is fsynced so the rename itself survives a power loss
//     (POSIX; Windows cannot open a directory, so the renamed file is flushed instead, as a best
//     effort). A crash or power loss during it leaves either the previous complete file or the
//     new one, never a partial file.
//
// A directory sync that fails after a new database was created cannot be undone: the database
// counts as created, a fixed code is logged and escalated (getLedgerEscalations, reported at the
// stop and by scripts/init-coin-db.js), and the start goes on. A backup or restore whose directory
// sync fails fails as a whole instead.

const COIN_DATABASE_ESCALATION_PURPOSE = 'coin-database';
const DIRECTORY_SYNC_FAILED = 'COIN_DB_DIRECTORY_SYNC_FAILED';
const DIRECTORY_SYNC_UNSUPPORTED = 'COIN_DB_DIRECTORY_SYNC_UNSUPPORTED';
// Answers meaning "this file system cannot sync a directory" rather than a failed sync: some
// network, FUSE and container file systems answer fsync on a directory with EINVAL or
// ENOTSUP/EOPNOTSUPP, and a platform without directory handles answers the open with EISDIR.
// Like SQLite, which treats its own directory sync as best effort, the write is then kept as
// it is and one warning is logged per process.
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set(['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EISDIR']);
const coinDatabaseEscalations = new Map();
const loggedDurabilityWarnings = new Set();
let durabilityForTests = null;

function defaultDurabilitySleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Per-call options first, then the test runner's replacement for every write, then the real
// file system.
function resolveDurability(options = {}) {
  const replaced = durabilityForTests || {};
  return {
    filesystem: options.filesystem ?? replaced.filesystem ?? fs,
    platform: options.platform ?? replaced.platform ?? process.platform,
    sleep: options.sleep ?? replaced.sleep ?? defaultDurabilitySleep,
  };
}

// Test hook: replaces the file system, platform and sleep of every whole-file write of this
// module (new database, migration backup and restore) until it is called with null or
// resetCoinDatabaseForTests() runs. Refused outside the Node test runner.
function setCoinDatabaseDurabilityForTests(options) {
  if (!(typeof process.env.NODE_TEST_CONTEXT === 'string' && process.env.NODE_TEST_CONTEXT.length > 0)) {
    throw new CoinDatabaseError('僅測試可替換吉幣資料庫的檔案系統。');
  }
  durabilityForTests = options ? Object.freeze({ ...options }) : null;
}

function durabilityErrorCode(error) {
  return String(error?.code || 'UNKNOWN').toUpperCase().replace(/[^A-Z0-9_]/gu, '').slice(0, 32) || 'UNKNOWN';
}

function warnOnce(line) {
  if (loggedDurabilityWarnings.has(line)) return;
  loggedDurabilityWarnings.add(line);
  logger.warn(line);
}

// A directory fsync that failed after a new database was created: logged with a fixed code
// (never a path) and recorded as an escalation in the shape of src/systems/safety/ledgerEscalation.js,
// so the shutdown can report it like the ledgers' own (getLedgerEscalations).
function reportDirectorySyncFailure(stage, error) {
  warnOnce(`[COIN_DB] code=${DIRECTORY_SYNC_FAILED} stage=${stage} errno=${durabilityErrorCode(error)}`);
  if (coinDatabaseEscalations.has(stage)) return;
  coinDatabaseEscalations.set(stage, Object.freeze({
    purposeId: COIN_DATABASE_ESCALATION_PURPOSE, code: DIRECTORY_SYNC_FAILED, stage, reason: null,
  }));
  logger.error(`[COIN_DB] code=COIN_DB_ESCALATION cause=${DIRECTORY_SYNC_FAILED} stage=${stage}`);
}

function getLedgerEscalations() {
  return Object.freeze([...coinDatabaseEscalations.values()]);
}

// Syncs the directory after a new database file was created. Returns false when that failed:
// the file still stands, but it is not confirmed durable.
function syncDirectoryAfterWrite(dbPath, durability, stage) {
  try {
    syncDatabaseDirectory(dbPath, durability);
    return true;
  } catch (error) {
    reportDirectorySyncFailure(stage, error);
    return false;
  }
}

const DATABASE_RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameDatabaseFileWithRetry(filesystem, from, to, platform, sleep) {
  let delay = 25;
  for (let attempt = 1; ; attempt += 1) {
    try {
      filesystem.renameSync(from, to);
      return;
    } catch (error) {
      if (platform !== 'win32' || !DATABASE_RENAME_RETRY_CODES.has(error?.code) || attempt >= 8) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 1_000);
    }
  }
}

function displayPath(filePath) {
  return process.env.XIAOJI_RUNTIME_MODE === 'test-control' ? '[test-data]' : filePath;
}

// Writes the bytes to <target>.tmp in the same directory (a temporary file left by an earlier
// crash is simply truncated), fsyncs and closes it, and renames it over the target, retrying a
// Windows scanner's EPERM/EBUSY/EACCES on the rename. Any failure removes the temporary file
// and leaves the target untouched. Every descriptor is closed at most once: a close that fails
// is never repeated, since the number may already belong to another file.
async function replaceDatabaseFile(targetPath, bytes, { filesystem, platform, sleep }) {
  const tempPath = `${targetPath}.tmp`;
  let descriptor;
  try {
    descriptor = filesystem.openSync(tempPath, 'w');
    let offset = 0;
    while (offset < bytes.length) {
      offset += filesystem.writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    filesystem.fsyncSync(descriptor);
    const written = descriptor;
    descriptor = undefined;
    filesystem.closeSync(written);
    await renameDatabaseFileWithRetry(filesystem, tempPath, targetPath, platform, sleep);
  } catch (error) {
    if (descriptor !== undefined) {
      try { filesystem.closeSync(descriptor); } catch {}
    }
    try {
      if (filesystem.existsSync(tempPath)) filesystem.unlinkSync(tempPath);
    } catch (cleanupError) {
      logger.error(`吉幣資料庫暫存檔清理失敗：${displayPath(tempPath)}`, cleanupError);
    }
    throw error;
  }
}

// The whole durable replace of one file (backup, restore): replaceDatabaseFile, then the
// directory sync, failing as a whole also after the rename.
async function writeFileDurably(targetPath, bytes, options = {}) {
  const durability = resolveDurability(options);
  await replaceDatabaseFile(targetPath, bytes, durability);
  syncDatabaseDirectory(targetPath, durability);
}

// A new database file (initialization) is created in place and exclusively ('wx': never
// over an existing file), written, fsynced and closed. A failure removes the file it created.
function createDatabaseFileDurably(dbPath, bytes, { filesystem }) {
  filesystem.mkdirSync(path.dirname(dbPath), { recursive: true });
  const descriptor = filesystem.openSync(dbPath, 'wx');
  let closed = false;
  try {
    let offset = 0;
    while (offset < bytes.length) {
      offset += filesystem.writeSync(descriptor, bytes, offset, bytes.length - offset);
    }
    filesystem.fsyncSync(descriptor);
    closed = true;
    filesystem.closeSync(descriptor);
  } catch (error) {
    if (!closed) {
      try { filesystem.closeSync(descriptor); } catch {}
    }
    try {
      filesystem.unlinkSync(dbPath);
    } catch (cleanupError) {
      logger.error(`吉幣資料庫新檔清理失敗：${displayPath(dbPath)}`, cleanupError);
    }
    throw error;
  }
}

// One POSIX directory sync: open the directory read-only (O_RDONLY), fsync it, and close it
// exactly once. Returns the first error (opening or syncing first, else closing), or null.
// Nothing is written.
function syncDirectoryOnce(directory, filesystem) {
  let descriptor;
  let failure = null;
  try {
    descriptor = filesystem.openSync(directory, 'r');
    filesystem.fsyncSync(descriptor);
  } catch (error) {
    failure = error;
  }
  if (descriptor !== undefined) {
    try {
      filesystem.closeSync(descriptor);
    } catch (error) {
      failure ??= error;
    }
  }
  return failure;
}

// Makes a rename (or a creation) itself durable: on POSIX the directory is synced once
// (syncDirectoryOnce), and a failure throws; a close that fails counts as a failed sync. Windows
// cannot open a directory, so the file is flushed instead, as a best effort (NTFS journals the
// rename itself). A file system that cannot sync a directory at all is treated the same way,
// with one warning (DIRECTORY_SYNC_UNSUPPORTED_CODES).
function syncDatabaseDirectory(filePath, { filesystem, platform }) {
  if (platform === 'win32') {
    let fileDescriptor;
    try {
      fileDescriptor = filesystem.openSync(filePath, 'r+');
      filesystem.fsyncSync(fileDescriptor);
    } catch {
      // Best effort: NTFS journals the rename itself.
    } finally {
      if (fileDescriptor !== undefined) {
        try { filesystem.closeSync(fileDescriptor); } catch {}
      }
    }
    return;
  }
  const failure = syncDirectoryOnce(path.dirname(filePath), filesystem);
  if (!failure) return;
  if (!DIRECTORY_SYNC_UNSUPPORTED_CODES.has(failure?.code)) throw failure;
  warnOnce(`[COIN_DB] code=${DIRECTORY_SYNC_UNSUPPORTED} errno=${durabilityErrorCode(failure)}`);
}

// Read-only check for the status of scripts/safety-ledger.js: whether a folder's file system
// syncs a directory the way the coin database's whole-file writes need it, judged exactly as a
// write would judge it. 'ok', 'unsupported' (a file system that cannot sync a directory; the
// write would go on with one warning), 'failed' (the write would fail or escalate), or
// 'not-applicable' (Windows, which has no directory sync). The folder is opened, fsynced and
// closed; nothing is written. errno is a fixed code, never a path.
function probeDirectorySync(directory, { filesystem = fs, platform = process.platform } = {}) {
  if (platform === 'win32') return Object.freeze({ result: 'not-applicable', errno: null });
  const failure = syncDirectoryOnce(directory, filesystem);
  if (!failure) return Object.freeze({ result: 'ok', errno: null });
  return Object.freeze({
    result: DIRECTORY_SYNC_UNSUPPORTED_CODES.has(failure?.code) ? 'unsupported' : 'failed',
    errno: durabilityErrorCode(failure),
  });
}

// The whole durable write of a database object (its serialized bytes) to a file, failing as a
// whole, also after the rename. Returns the bytes it wrote. Kept for tests of the write order.
async function writeDatabaseFileDurably(dbPath, db, options = {}) {
  const exported = exportDatabase(db);
  await writeFileDurably(dbPath, exported, options);
  return exported;
}

// Test hook for resetCoinDatabaseForTests: forgets the test durability options, the escalations and
// the warnings already logged.
function resetDurabilityForTests() {
  durabilityForTests = null;
  coinDatabaseEscalations.clear();
  loggedDurabilityWarnings.clear();
}

module.exports = {
  resolveDurability,
  setCoinDatabaseDurabilityForTests,
  getLedgerEscalations,
  syncDirectoryAfterWrite,
  replaceDatabaseFile,
  writeFileDurably,
  createDatabaseFileDurably,
  syncDatabaseDirectory,
  probeDirectorySync,
  writeDatabaseFileDurably,
  resetDurabilityForTests,
};
