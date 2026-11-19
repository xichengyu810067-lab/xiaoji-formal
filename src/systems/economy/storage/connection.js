// The node:sqlite connections of the coin database: the one connection that holds the file while
// the bot runs, the in-memory database a new file is built in, and the read-only in-memory copies
// the tools inspect. Nothing here holds state.
//
// The file is opened like the side-effect ledgers (src/systems/safety/ledgerStore.js): never
// created by SQLite (mode=rw), locking_mode=EXCLUSIVE before the first WAL access (no shared
// memory index, no -shm file, and no second process or connection can open the file while it is
// held), journal_mode=WAL, synchronous=FULL (every COMMIT is on disk when it returns) and
// foreign_keys=ON, each read back and refused when it does not hold. While the connection is open
// a <db>-wal file lies beside the database; a clean close checkpoints it into the file and removes
// it, and after a crash SQLite replays it at the next open, keeping exactly the committed
// transactions.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { pathToFileURL } = require('node:url');
const { CoinDatabaseError } = require('./errors');
const { getRow, getTableNames } = require('./sqlHelpers');

const CONNECTION_OPTIONS = Object.freeze({
  timeout: 0,
  enableDoubleQuotedStringLiterals: false,
  allowExtension: false,
  defensive: true,
});
const SQLITE_HEADER = 'SQLite format 3\0';
// The files SQLite keeps beside a database it has open or did not close cleanly.
const SIDECAR_SUFFIXES = Object.freeze(['-wal', '-journal']);

function setPragma(db, assignment, name, expected) {
  db.exec(`PRAGMA ${assignment}`);
  const actual = db.prepare(`PRAGMA ${name}`).get()?.[name];
  if (String(actual).toLowerCase() !== String(expected)) {
    throw new CoinDatabaseError(`吉幣資料庫無法設定 ${name}（得到 ${actual}）；已停止啟動。`);
  }
}

function isLockedError(error) {
  const primary = Number(error?.errcode) & 0xff;
  return primary === 5 || primary === 6;
}

function lockedError(error) {
  return new CoinDatabaseError('吉幣資料庫正由另一個行程或連線使用（小吉可能已在執行）；已停止啟動。', error);
}

// Opens the database file (it must exist) in EXCLUSIVE locking mode. Nothing is written yet: the
// open sequence reads and checks the file first, takes the migration backup when one is needed,
// and only then calls enableDurableJournal.
function openCoinConnection(dbPath) {
  const url = pathToFileURL(dbPath);
  url.searchParams.set('mode', 'rw');
  const db = new DatabaseSync(url, CONNECTION_OPTIONS);
  try {
    // EXCLUSIVE must precede the first WAL access so no shared-memory index is created.
    setPragma(db, 'locking_mode = EXCLUSIVE', 'locking_mode', 'exclusive');
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

// Switches the open connection to WAL with synchronous=FULL and foreign keys on, and takes the
// write lock, which EXCLUSIVE mode then holds until the connection closes. The first time a file
// written by the old engine (sql.js) is opened, this changes only the journal mode bytes of its
// header (SQLite's own atomic write; no data moves).
function enableDurableJournal(db) {
  try {
    setPragma(db, 'journal_mode = WAL', 'journal_mode', 'wal');
    setPragma(db, 'synchronous = FULL', 'synchronous', 2);
    setPragma(db, 'foreign_keys = ON', 'foreign_keys', 1);
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
  } catch (error) {
    if (isLockedError(error)) throw lockedError(error);
    throw error;
  }
}

// An empty in-memory database with the same connection settings, foreign keys on: a new
// database file is built in it before the file is created.
function openMemoryDatabase() {
  const db = new DatabaseSync(':memory:', CONNECTION_OPTIONS);
  try {
    setPragma(db, 'foreign_keys = ON', 'foreign_keys', 1);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

function hasSqliteHeader(bytes) {
  return bytes.length >= 100 && bytes.subarray(0, 16).toString('binary') === SQLITE_HEADER;
}

// The first 100 bytes of the file, refused unless they are a SQLite header (an empty file would
// otherwise open as an empty database).
function assertDatabaseHeader(dbPath) {
  const descriptor = fs.openSync(dbPath, 'r');
  try {
    const header = Buffer.alloc(100);
    const read = fs.readSync(descriptor, header, 0, 100, 0);
    if (!hasSqliteHeader(header.subarray(0, read))) {
      throw new Error('SQLite source file is empty or has an invalid header');
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

function existingSidecars(dbPath) {
  return SIDECAR_SUFFIXES.filter((suffix) => fs.existsSync(`${dbPath}${suffix}`));
}

// The schema_version stored in coin_metadata ({ value, raw }); value 0 when there is no
// coin_metadata or no version.
function readStoredSchemaVersion(db) {
  if (!getTableNames(db).has('coin_metadata')) return { value: 0, raw: null };
  const row = getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'");
  return { value: row ? Number(row.value) : 0, raw: row?.value ?? null };
}

// The version a database left with a -wal or -journal holds once SQLite has replayed it, read
// from a copy in a temporary folder, so the file and its sidecars stay exactly as they are (a
// connection on the file itself would checkpoint the WAL into it when it closes).
function peekStoredSchemaVersion(dbPath, sidecars) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-coin-peek-'));
  try {
    const copy = path.join(folder, 'coin.sqlite');
    fs.copyFileSync(dbPath, copy);
    for (const suffix of sidecars) fs.copyFileSync(`${dbPath}${suffix}`, `${copy}${suffix}`);
    const db = openCoinConnection(copy);
    try {
      return readStoredSchemaVersion(db);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

// A read-only in-memory copy of a stopped bot's database file, for the tools that inspect it
// (the safety registrations, the v22 dry run). The file is read once and never written; nothing
// is created beside it. A <db>-wal beside the file means the bot is still running or was not
// stopped cleanly, so the file alone is not the whole database: refused.
function readStoppedDatabaseBytes(dbPath) {
  if (existingSidecars(dbPath).includes('-wal')) {
    throw new CoinDatabaseError('小吉還在執行或上次沒有正常關閉，請先正常停止（吉幣資料庫旁邊還有 -wal 檔）。');
  }
  const bytes = fs.readFileSync(dbPath);
  if (!hasSqliteHeader(bytes)) throw new CoinDatabaseError('吉幣資料庫檔案不是 SQLite 資料庫。');
  return bytes;
}

function openMemoryCopy(bytes) {
  // Bytes 18 and 19 of the header are the file format versions; 2 marks a WAL database, which an
  // in-memory database cannot open. The copy is marked as a rollback-journal database instead;
  // the pages are the same.
  const copy = Buffer.from(bytes);
  if (copy[18] === 2) copy[18] = 1;
  if (copy[19] === 2) copy[19] = 1;
  const db = new DatabaseSync(':memory:', CONNECTION_OPTIONS);
  try {
    db.deserialize(copy);
    setPragma(db, 'foreign_keys = ON', 'foreign_keys', 1);
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw error;
  }
}

module.exports = {
  assertDatabaseHeader,
  enableDurableJournal,
  existingSidecars,
  isLockedError,
  lockedError,
  openCoinConnection,
  openMemoryCopy,
  openMemoryDatabase,
  peekStoredSchemaVersion,
  readStoppedDatabaseBytes,
  readStoredSchemaVersion,
};
