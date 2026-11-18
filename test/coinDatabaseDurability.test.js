'use strict';

// The coin database file is held by one node:sqlite connection (EXCLUSIVE locking, WAL,
// synchronous=FULL): a COMMIT is the durable write, a crash keeps exactly the committed
// transactions, and no second process or connection can open the file. A file whose schema is
// behind is migrated in place only after a verified backup, and a migration that fails puts the
// backup back, so the original is byte-identical. A new database is built in memory and created
// exclusively ('wx'); its directory sync is the one write left that can escalate.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const coin = require('../src/systems/economy/storage/coinDatabase');
const logger = require('../src/utils/logger');
const coinDatabaseEscalations = require('../src/systems/economy/coinDatabaseEscalations');
const { LEDGER_ESCALATION_EXIT_CODE, settleLedgerShutdown } = require('../src/systems/safety/ledgerEscalation');

const COIN_MODULE = path.join(__dirname, '..', 'src', 'systems', 'economy', 'storage', 'coinDatabase.js');
const SIMULATE_DIRECTORY = process.platform === 'win32';
const STAMP = '2026-10-03T00:00:00.000Z';

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filePath) {
  return sha256(fs.readFileSync(filePath));
}

// The database file and its -wal, byte for byte (null when there is no -wal).
function filesState(dbPath) {
  return {
    main: sha256File(dbPath),
    wal: fs.existsSync(`${dbPath}-wal`) ? sha256File(`${dbPath}-wal`) : null,
  };
}

// A fresh coin database in its own temporary folder. resetCoinDatabaseForTests() also drops a
// replaced file system, so a test replaces it only after this.
async function freshCoinDatabase(t, prefix, { create = true } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `xiaoji-coin-durability-${prefix}-`)));
  const previous = process.env.COIN_DB_PATH;
  process.env.COIN_DB_PATH = path.join(root, 'xiaoji.sqlite');
  coin.resetCoinDatabaseForTests();
  t.after(() => {
    coin.resetCoinDatabaseForTests();
    if (previous === undefined) delete process.env.COIN_DB_PATH;
    else process.env.COIN_DB_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  if (create) await coin.initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  return { root, dbPath: process.env.COIN_DB_PATH, directoryName: path.basename(root) };
}

function insertMarker(api, key, value = '1') {
  api.run('INSERT INTO coin_metadata (key, value, updated_at) VALUES (?, ?, ?)', [key, value, STAMP]);
}

async function memoryValue(key) {
  const row = await coin.withCoinDatabase((api) => api.get('SELECT value FROM coin_metadata WHERE key = ?', [key]));
  return row ? row.value : null;
}

// What the next start would read: a copy of the file and its -wal, opened on its own (SQLite
// replays the -wal), so the files themselves stay as they are.
function nextStartRows(dbPath, sql, params = []) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-coin-next-start-'));
  try {
    const copy = path.join(folder, 'copy.sqlite');
    fs.copyFileSync(dbPath, copy);
    if (fs.existsSync(`${dbPath}-wal`)) fs.copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
    const db = new DatabaseSync(copy);
    try {
      return db.prepare(sql).all(...params).map((row) => ({ ...row }));
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

function nextStartValue(dbPath, key) {
  return nextStartRows(dbPath, 'SELECT value FROM coin_metadata WHERE key = ?', [key])[0]?.value ?? null;
}

function schemaOf(db) {
  return db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name').all()
    .map((row) => ({ ...row }));
}

// Changes a closed database file with a plain connection; journal_mode=DELETE leaves it as the old
// engine (sql.js, until v1.3.x) wrote files: a rollback-journal header and nothing beside it.
function editClosedFile(dbPath, sql) {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    db.exec(sql);
  } finally {
    db.close();
  }
}

// A v23 database: the current one without the table v24 adds.
const BACK_TO_V23 = `DROP TABLE coin_admin_add_confirmations;
  UPDATE coin_metadata SET value = '23' WHERE key = 'schema_version';`;

function backups(root) {
  return fs.readdirSync(root).filter((name) => name.endsWith('.bak')).sort();
}

// Passes every call to the real file system and records the steps a durable write takes
// (paths reduced to base names). `fail` makes one step throw instead (a failing close still
// releases the real descriptor first); `renameFailures` lists error codes the next renames throw
// before one succeeds.
function recordingFileSystem({ directory = null, fail = null, renameFailures = [] } = {}) {
  const calls = [];
  const failures = [...renameFailures];
  const names = new Map();
  const closed = new Set();
  const SIMULATED_DIRECTORY = -7001;
  const failIfChosen = (step) => {
    if (fail && fail.step.length === step.length && fail.step.every((part, index) => part === step[index])) {
      throw Object.assign(new Error(`synthetic ${step[0]} failure`), { code: fail.code || 'EIO' });
    }
  };
  const record = (step) => {
    calls.push(step);
    return step;
  };
  const filesystem = {
    ...fs,
    mkdirSync(target, options) {
      failIfChosen(record(['mkdir', path.basename(String(target))]));
      return fs.mkdirSync(target, options);
    },
    openSync(target, flags, ...rest) {
      const name = path.basename(String(target));
      failIfChosen(record(['open', name, flags]));
      if (SIMULATE_DIRECTORY && directory && path.resolve(String(target)) === directory && flags === 'r') {
        names.set(SIMULATED_DIRECTORY, name);
        return SIMULATED_DIRECTORY;
      }
      const descriptor = fs.openSync(target, flags, ...rest);
      names.set(descriptor, name);
      closed.delete(descriptor);
      return descriptor;
    },
    writeSync(descriptor, ...rest) {
      failIfChosen(record(['write', names.get(descriptor)]));
      return fs.writeSync(descriptor, ...rest);
    },
    fsyncSync(descriptor) {
      failIfChosen(record(['fsync', names.get(descriptor)]));
      return descriptor === SIMULATED_DIRECTORY ? undefined : fs.fsyncSync(descriptor);
    },
    closeSync(descriptor) {
      const step = record(['close', names.get(descriptor)]);
      if (descriptor === SIMULATED_DIRECTORY) return failIfChosen(step);
      if (closed.has(descriptor)) throw Object.assign(new Error('already closed'), { code: 'EBADF' });
      closed.add(descriptor);
      fs.closeSync(descriptor);
      return failIfChosen(step);
    },
    renameSync(from, to) {
      const step = record(['rename', path.basename(String(from)), path.basename(String(to))]);
      const code = failures.shift();
      if (code) throw Object.assign(new Error(`synthetic rename ${code}`), { code });
      failIfChosen(step);
      return fs.renameSync(from, to);
    },
    unlinkSync(target) {
      record(['unlink', path.basename(String(target))]);
      return fs.unlinkSync(target);
    },
  };
  return { calls, filesystem, steps: () => calls.filter(([kind]) => kind !== 'write') };
}

function useFileSystem(recorder, platform, extra = {}) {
  coin.setCoinDatabaseDurabilityForTests({ filesystem: recorder.filesystem, platform, ...extra });
}

function captureCoinDatabaseLogs(t) {
  const lines = [];
  const original = { warn: logger.warn, error: logger.error };
  logger.warn = (message) => { lines.push(String(message)); };
  logger.error = (message) => { lines.push(String(message)); };
  t.after(() => Object.assign(logger, original));
  return lines;
}

// Runs a script in its own process against COIN_DB_PATH; the script gets the coin module as
// `coin`.
function runCoinProcess(dbPath, body) {
  const script = `const coin = require(process.argv[1]);\n(async () => {\n${body}\n})().catch((error) => {
    process.stdout.write('ERROR ' + error.message);
    process.exitCode = 1;
  });`;
  return spawnSync(process.execPath, ['-e', script, COIN_MODULE], {
    env: { ...process.env, COIN_DB_PATH: dbPath }, encoding: 'utf8', cwd: os.tmpdir(),
  });
}

test('the file is held by one connection: WAL, synchronous FULL, foreign keys on, and no second process or connection gets in',
  async (t) => {
    const { root, dbPath } = await freshCoinDatabase(t, 'connection');
    const settings = await coin.withCoinDatabase((api) => ({
      journal: api.get('PRAGMA journal_mode').journal_mode,
      synchronous: api.get('PRAGMA synchronous').synchronous,
      foreignKeys: api.get('PRAGMA foreign_keys').foreign_keys,
      locking: api.get('PRAGMA locking_mode').locking_mode,
    }));
    assert.deepEqual(settings, { journal: 'wal', synchronous: 2, foreignKeys: 1, locking: 'exclusive' });
    // A -wal and no shared-memory file while it is open.
    assert.deepEqual(fs.readdirSync(root).sort(), ['xiaoji.sqlite', 'xiaoji.sqlite-wal']);

    const other = runCoinProcess(dbPath, 'await coin.initializeCoinDatabase(); process.stdout.write("OPENED");');
    assert.equal(other.status, 1, other.stderr);
    assert.match(other.stdout, /^ERROR 吉幣資料庫正由另一個行程或連線使用/u);
    const sameProcess = new DatabaseSync(dbPath, { timeout: 0 });
    try {
      assert.throws(() => sameProcess.prepare('SELECT COUNT(*) AS count FROM coin_metadata').get(), /database is locked/u);
    } finally {
      sameProcess.close();
    }
    // The bot's own connection was never disturbed.
    await coin.withCoinTransaction((api) => insertMarker(api, 'still-mine'));
    assert.equal(await memoryValue('still-mine'), '1');
  });

test('a COMMIT is on disk when it returns, and a crash in the middle of the next transaction keeps only the committed one',
  async (t) => {
    const { dbPath } = await freshCoinDatabase(t, 'crash');
    coin.resetCoinDatabaseForTests();
    const crashed = runCoinProcess(dbPath, `
      await coin.withCoinTransaction((api) => api.run(
        "INSERT INTO coin_metadata (key, value, updated_at) VALUES ('committed', '1', '${STAMP}')"));
      await coin.withCoinDatabase((api) => api.run(
        "INSERT INTO coin_metadata (key, value, updated_at) VALUES ('autocommitted', '1', '${STAMP}')"));
      await coin.withCoinTransaction((api) => {
        api.run("INSERT INTO coin_metadata (key, value, updated_at) VALUES ('in-flight', '1', '${STAMP}')");
        api.run("UPDATE coin_metadata SET value = '2' WHERE key = 'committed'");
        process.kill(process.pid, 'SIGKILL');
      });
    `);
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr || crashed.stdout);
    // The crash left the -wal; the next start replays it.
    assert.equal(fs.existsSync(`${dbPath}-wal`), true);
    await coin.initializeCoinDatabase();
    assert.equal(await memoryValue('committed'), '1');
    assert.equal(await memoryValue('autocommitted'), '1');
    assert.equal(await memoryValue('in-flight'), null);
    assert.equal(await coin.withCoinDatabase((api) => api.get('PRAGMA integrity_check').integrity_check), 'ok');
  });

test('a transaction that throws, or whose COMMIT fails, writes nothing and leaves the database usable', async (t) => {
  const { dbPath } = await freshCoinDatabase(t, 'commit-fails');
  await coin.withCoinTransaction((api) => insertMarker(api, 'before'));
  const before = filesState(dbPath);

  await assert.rejects(coin.withCoinTransaction((api) => {
    insertMarker(api, 'thrown');
    throw new Error('synthetic work failure');
  }), /synthetic work failure/u);
  // A deferred foreign key is checked by the COMMIT itself, so the COMMIT fails.
  await assert.rejects(coin.withCoinTransaction((api) => {
    api.run('PRAGMA defer_foreign_keys = ON');
    insertMarker(api, 'commit-failed');
    api.run(`INSERT INTO game_actions (session_id, action_index, action_hash, state_json, created_at)
             VALUES ('no-such-session', 0, 'hash', '{}', ?)`, [STAMP]);
  }), (error) => error instanceof coin.CoinDatabaseError && error.message === '吉幣資料庫落盤失敗，交易已復原。' &&
    /FOREIGN KEY constraint failed/u.test(error.cause?.message));
  assert.deepEqual(filesState(dbPath), before, 'neither the file nor the -wal changed');
  assert.equal(await memoryValue('thrown'), null);
  assert.equal(await memoryValue('commit-failed'), null);
  assert.equal(await coin.withCoinDatabase((api) => api.db.isTransaction), false);
  // The next transaction goes through as usual, and is what the next start reads.
  await coin.withCoinTransaction((api) => insertMarker(api, 'after'));
  assert.equal(nextStartValue(dbPath, 'after'), '1');
  assert.equal(nextStartValue(dbPath, 'commit-failed'), null);
});

test('values are bound and read back as before: 32-bit integers as INTEGER, plain-object rows, multi-statement exec',
  async (t) => {
    await freshCoinDatabase(t, 'binding');
    const row = await coin.withCoinDatabase((api) => {
      api.run('CREATE TEMP TABLE binding_probe (text_value TEXT, any_value)');
      api.run('INSERT INTO binding_probe VALUES (?, ?)', [5, 2 ** 40]);
      api.run('INSERT INTO binding_probe VALUES (?, ?); INSERT INTO binding_probe VALUES (99, 99)', [true, 10n]);
      api.run("INSERT INTO binding_probe VALUES ('x', 1); INSERT INTO binding_probe VALUES ('y', 2)");
      return {
        rows: api.all('SELECT text_value, any_value, typeof(any_value) AS type FROM binding_probe ORDER BY rowid'),
        one: api.get('SELECT ? AS half, ? AS missing', [0.5]),
      };
    });
    assert.deepEqual(row.rows, [
      { text_value: '5', any_value: 2 ** 40, type: 'real' },
      { text_value: '1', any_value: '10', type: 'text' },
      { text_value: 'x', any_value: 1, type: 'integer' },
      { text_value: 'y', any_value: 2, type: 'integer' },
    ]);
    assert.equal(Object.getPrototypeOf(row.rows[0]), Object.prototype);
    assert.deepEqual(row.one, { half: 0.5, missing: null });
  });

test('a clean close checkpoints the -wal into the file and removes it; the file holds everything and opens again, also as the old engine wrote it',
  async (t) => {
    const { root, dbPath } = await freshCoinDatabase(t, 'close');
    await coin.withCoinTransaction((api) => insertMarker(api, 'closed-cleanly'));
    await coin.closeCoinDatabase();
    await coin.closeCoinDatabase();
    assert.deepEqual(fs.readdirSync(root), ['xiaoji.sqlite']);
    // Every later operation is refused instead of opening the file again.
    await assert.rejects(coin.withCoinDatabase((api) => api.get('SELECT 1 AS one')), /已關閉/u);
    await assert.rejects(coin.initializeCoinDatabase(), /已關閉/u);
    assert.deepEqual(fs.readdirSync(root), ['xiaoji.sqlite']);

    // The file alone holds everything: an in-memory copy of its bytes, with nothing beside it,
    // reads the last transaction. (The old engine, sql.js until v1.3.x, loaded the whole file into
    // memory the same way; it was checked to read a cleanly closed file when the engine changed.)
    const old = new DatabaseSync(':memory:');
    try {
      const bytes = fs.readFileSync(dbPath);
      bytes[18] = 1;
      bytes[19] = 1;
      old.deserialize(bytes);
      assert.equal(old.prepare("SELECT value FROM coin_metadata WHERE key = 'closed-cleanly'").get().value, '1');
      // A file as the old engine wrote it (its full export: a rollback-journal header, nothing
      // beside it) opens without a migration. serialize() of an in-memory database gives exactly
      // that format.
      old.prepare("INSERT INTO coin_metadata (key, value, updated_at) VALUES ('old-engine', '1', ?)").run(STAMP);
      const exported = Buffer.from(old.serialize());
      assert.deepEqual([exported[18], exported[19]], [1, 1]);
      fs.writeFileSync(dbPath, exported);
    } finally {
      old.close();
    }
    coin.resetCoinDatabaseForTests();
    await coin.initializeCoinDatabase();
    assert.equal(await memoryValue('old-engine'), '1');
    assert.equal(await memoryValue('closed-cleanly'), '1');
    assert.deepEqual(backups(root), [], 'a current schema needs no migration backup');
    assert.equal(fs.readFileSync(dbPath)[18], 2, 'the header now marks a WAL database');
  });

test('a database whose schema is behind is migrated in place after a verified backup; only the newest 3 backups stay',
  async (t) => {
    const { root, dbPath } = await freshCoinDatabase(t, 'migrate');
    const expectedSchema = await coin.withCoinDatabase((api) => schemaOf(api.db));
    await coin.withCoinTransaction((api) => insertMarker(api, 'kept-through-migration'));
    await coin.closeCoinDatabase();
    editClosedFile(dbPath, BACK_TO_V23);
    const original = fs.readFileSync(dbPath);
    // Older backups of this database, and one of another database in the same folder.
    const older = ['20250101T000000000Z', '20250201T000000000Z', '20250301T000000000Z']
      .map((stamp) => `xiaoji.sqlite.pre-v22-${stamp}.bak`);
    for (const name of [...older, 'other.sqlite.pre-v22-20240101T000000000Z.bak']) fs.writeFileSync(path.join(root, name), name);

    coin.resetCoinDatabaseForTests();
    const info = await coin.initializeCoinDatabase();
    assert.equal(info.schemaVersion, 24);
    assert.deepEqual(info.createdTables, ['coin_admin_add_confirmations']);
    assert.equal(await coin.withCoinDatabase((api) => coin.readCoinSchemaVersionWithApi(api)), 24);
    assert.equal(await memoryValue('kept-through-migration'), '1');
    assert.deepEqual(await coin.withCoinDatabase((api) => schemaOf(api.db)), expectedSchema);
    // After a migration the connection holds the file exclusively like any other open.
    const other = runCoinProcess(dbPath, 'await coin.initializeCoinDatabase(); process.stdout.write("OPENED");');
    assert.equal(other.status, 1, other.stderr);
    assert.match(other.stdout, /^ERROR 吉幣資料庫正由另一個行程或連線使用/u);

    const made = backups(root).filter((name) => /^xiaoji\.sqlite\.pre-v23-\d{8}T\d{9}Z\.bak$/u.test(name));
    assert.equal(made.length, 1);
    assert.ok(fs.readFileSync(path.join(root, made[0])).equals(original), 'the backup is the file before the migration');
    // The newest three of this database's backups stay; another database's backup is not touched.
    assert.deepEqual(backups(root), [...older.slice(1), made[0], 'other.sqlite.pre-v22-20240101T000000000Z.bak'].sort());
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false);

    // A database already current is opened without a backup and without rewriting schema_version.
    const versionRow = () => coin.withCoinDatabase((api) => api.get(
      "SELECT value, updated_at FROM coin_metadata WHERE key = 'schema_version'"));
    const stored = await versionRow();
    coin.resetCoinDatabaseForTests();
    await coin.initializeCoinDatabase();
    assert.deepEqual(await versionRow(), stored);
    assert.equal(backups(root).length, 4);
  });

test('a migration that fails puts the backup back: the original file is byte-identical and the start stops', async (t) => {
  const { root, dbPath } = await freshCoinDatabase(t, 'migration-fails');
  await coin.closeCoinDatabase();
  // The v24 migration meets a view where its table belongs and fails; before that the open has
  // already switched the file to WAL and recreated a missing table (committed writes).
  editClosedFile(dbPath, `${BACK_TO_V23}
    DROP TABLE coin_admin_logs;
    CREATE VIEW coin_admin_add_confirmations AS SELECT 1 AS operation_id;`);
  const original = fs.readFileSync(dbPath);
  assert.equal(original[18], 1);

  coin.resetCoinDatabaseForTests();
  await assert.rejects(coin.initializeCoinDatabase(),
    (error) => error instanceof coin.CoinDatabaseError && /加幣確認狀態結構升級失敗/u.test(error.message));
  assert.ok(fs.readFileSync(dbPath).equals(original), 'the file is exactly as it was');
  assert.deepEqual(fs.readdirSync(root).filter((name) => !name.endsWith('.bak')), ['xiaoji.sqlite']);
  const [backup] = backups(root);
  assert.ok(fs.readFileSync(path.join(root, backup)).equals(original));
  // Nothing is held open: a plain connection reads the restored file.
  const db = new DatabaseSync(dbPath);
  try {
    assert.equal(db.prepare("SELECT value FROM coin_metadata WHERE key = 'schema_version'").get().value, '23');
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'coin_admin_logs'").get(), undefined);
  } finally {
    db.close();
  }

  // When putting the backup back fails as well, the start stops with a fixed code naming the backup.
  coin.resetCoinDatabaseForTests();
  useFileSystem(recordingFileSystem({ directory: root, fail: { step: ['rename', 'xiaoji.sqlite.tmp', 'xiaoji.sqlite'] } }),
    process.platform);
  await assert.rejects(coin.initializeCoinDatabase(), (error) => error.code === 'COIN_DB_MIGRATION_RESTORE_FAILED' &&
    error.message.includes(error.backupFile) && /^xiaoji\.sqlite\.pre-v23-\d{8}T\d{9}Z\.bak$/u.test(error.backupFile));
  coin.setCoinDatabaseDurabilityForTests(null);
  assert.equal(fs.existsSync(`${dbPath}-wal`), false);
  assert.equal(fs.existsSync(`${dbPath}.tmp`), false);
  for (const name of backups(root)) assert.ok(fs.readFileSync(path.join(root, name)).equals(original), name);
});

test('a migration backup that cannot be written stops the start before anything is changed', async (t) => {
  const { root, dbPath, directoryName } = await freshCoinDatabase(t, 'backup-fails');
  await coin.closeCoinDatabase();
  editClosedFile(dbPath, BACK_TO_V23);
  const original = fs.readFileSync(dbPath);
  for (const [label, fail] of [
    ['temporary file fsync', (name) => ['fsync', `${name}.tmp`]],
    ['rename', (name) => ['rename', `${name}.tmp`, name]],
    ['directory fsync', () => ['fsync', directoryName]],
  ]) {
    coin.resetCoinDatabaseForTests();
    // The backup name holds the time of the write, so the failing step is matched by prefix.
    const recorder = recordingFileSystem({ directory: root });
    const filesystem = recorder.filesystem;
    const matches = (step) => {
      const backupName = recorder.calls.map((call) => call[1]).find((name) => /\.bak(\.tmp)?$/u.test(String(name)));
      if (!backupName) return false;
      const expected = fail(backupName.replace(/\.tmp$/u, ''));
      return expected.length === step.length && expected.every((part, index) => part === step[index]);
    };
    const failing = { ...filesystem };
    for (const method of ['fsyncSync', 'renameSync']) {
      failing[method] = (...args) => {
        const before = recorder.calls.length;
        const result = filesystem[method](...args);
        if (matches(recorder.calls[before])) throw Object.assign(new Error(`synthetic ${label} failure`), { code: 'EIO' });
        return result;
      };
    }
    coin.setCoinDatabaseDurabilityForTests({ filesystem: failing, platform: 'linux' });
    await assert.rejects(coin.initializeCoinDatabase(), (error) => error instanceof coin.CoinDatabaseError &&
      /備份失敗/u.test(error.message) && error.cause?.message === `synthetic ${label} failure`, label);
    coin.setCoinDatabaseDurabilityForTests(null);
    assert.ok(fs.readFileSync(dbPath).equals(original), label);
    assert.equal(fs.existsSync(`${dbPath}-wal`), false, label);
    assert.equal(fs.readdirSync(root).some((name) => name.endsWith('.tmp')), false, label);
  }
});

test('on Windows a scanner\'s EPERM/EBUSY on the backup rename is retried; when the retries run out the start stops',
  async (t) => {
    const { root, dbPath } = await freshCoinDatabase(t, 'windows-retry');
    await coin.closeCoinDatabase();
    editClosedFile(dbPath, BACK_TO_V23);
    const original = fs.readFileSync(dbPath);
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };

    coin.resetCoinDatabaseForTests();
    useFileSystem(recordingFileSystem({ directory: root, renameFailures: Array(8).fill('EPERM') }), 'win32', { sleep });
    await assert.rejects(coin.initializeCoinDatabase(), (error) => /備份失敗/u.test(error.message) && error.cause?.code === 'EPERM');
    assert.deepEqual(sleeps, [25, 50, 100, 200, 400, 800, 1000]);
    assert.ok(fs.readFileSync(dbPath).equals(original));
    assert.deepEqual(backups(root), []);

    coin.resetCoinDatabaseForTests();
    sleeps.length = 0;
    useFileSystem(recordingFileSystem({ directory: root, renameFailures: ['EPERM', 'EBUSY'] }), 'win32', { sleep });
    await coin.initializeCoinDatabase();
    assert.deepEqual(sleeps, [25, 50]);
    assert.equal(backups(root).length, 1);
    assert.equal(await coin.withCoinDatabase((api) => coin.readCoinSchemaVersionWithApi(api)), 24);
  });

test('a -wal beside a database whose schema is behind (a migration that never finished) stops the start, untouched',
  async (t) => {
    const { root, dbPath } = await freshCoinDatabase(t, 'unfinished');
    await coin.closeCoinDatabase();
    editClosedFile(dbPath, BACK_TO_V23);
    // A process that wrote to the v23 file in WAL mode and was killed before it closed.
    const crashed = spawnSync(process.execPath, ['-e', `
      const { DatabaseSync } = require('node:sqlite');
      const db = new DatabaseSync(process.argv[1]);
      db.exec('PRAGMA locking_mode = EXCLUSIVE');
      db.exec('PRAGMA journal_mode = WAL');
      db.exec("INSERT INTO coin_metadata (key, value, updated_at) VALUES ('half-way', '1', '${STAMP}')");
      process.kill(process.pid, 'SIGKILL');
    `, dbPath], { encoding: 'utf8' });
    assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
    const before = filesState(dbPath);
    assert.notEqual(before.wal, null);

    coin.resetCoinDatabaseForTests();
    await assert.rejects(coin.initializeCoinDatabase(), /需要從 v23 升級，但旁邊還有 -wal/u);
    assert.deepEqual(filesState(dbPath), before);
    assert.deepEqual(fs.readdirSync(root).sort(), ['xiaoji.sqlite', 'xiaoji.sqlite-wal']);
  });

test('a database that is damaged, not SQLite, or from a newer version is refused and never written', async (t) => {
  const { dbPath } = await freshCoinDatabase(t, 'refused');
  await coin.closeCoinDatabase();
  editClosedFile(dbPath, "UPDATE coin_metadata SET value = '25' WHERE key = 'schema_version'");
  const before = sha256File(dbPath);
  coin.resetCoinDatabaseForTests();
  await assert.rejects(coin.initializeCoinDatabase(), /不支援的吉幣資料庫 schema 版本：25/u);
  assert.equal(sha256File(dbPath), before);
  assert.equal(fs.existsSync(`${dbPath}-wal`), false);

  for (const bytes of [Buffer.alloc(0), Buffer.from('not a database at all '.repeat(10))]) {
    fs.writeFileSync(dbPath, bytes);
    coin.resetCoinDatabaseForTests();
    await assert.rejects(coin.initializeCoinDatabase(), /吉幣資料庫讀取失敗，不會自動重建空資料庫/u);
    assert.ok(fs.readFileSync(dbPath).equals(bytes));
  }

  fs.rmSync(dbPath);
  coin.resetCoinDatabaseForTests();
  await assert.rejects(coin.initializeCoinDatabase(), /不存在；已停止啟動/u);
  assert.equal(fs.existsSync(dbPath), false);
});

test('a new database is built in memory and created in place exclusively, then its directory is synced', async (t) => {
  const { root, dbPath, directoryName } = await freshCoinDatabase(t, 'create', { create: false });
  for (const platform of ['linux', 'win32']) {
    coin.resetCoinDatabaseForTests();
    fs.rmSync(dbPath, { force: true });
    const recorder = recordingFileSystem({ directory: root });
    useFileSystem(recorder, platform);
    const info = await coin.initializeNewCoinDatabase({ expectedPath: dbPath });
    assert.equal(info.createdDatabase, true, platform);
    assert.ok(info.createdTables.includes('coin_admin_add_confirmations'), platform);
    assert.deepEqual(recorder.steps(), [
      ['mkdir', directoryName],
      ['open', 'xiaoji.sqlite', 'wx'],
      ['fsync', 'xiaoji.sqlite'],
      ['close', 'xiaoji.sqlite'],
      ...(platform === 'win32'
        ? [['open', 'xiaoji.sqlite', 'r+'], ['fsync', 'xiaoji.sqlite'], ['close', 'xiaoji.sqlite']]
        : [['open', directoryName, 'r'], ['fsync', directoryName], ['close', directoryName]]),
    ], platform);
    coin.setCoinDatabaseDurabilityForTests(null);
    // Transactions never come through the whole-file writes.
    const quiet = recordingFileSystem({ directory: root });
    useFileSystem(quiet, platform);
    await coin.withCoinTransaction((api) => insertMarker(api, `created-${platform}`));
    assert.deepEqual(quiet.calls, [], platform);
    coin.setCoinDatabaseDurabilityForTests(null);
  }
  // Never over an existing file.
  coin.resetCoinDatabaseForTests();
  const before = sha256File(dbPath);
  await assert.rejects(coin.initializeNewCoinDatabase({ expectedPath: dbPath }), /來源不存在/u);
  assert.equal(sha256File(dbPath), before);
});

test('a new database whose close fails leaves nothing behind, closing each descriptor at most once', async (t) => {
  const { root, dbPath, directoryName } = await freshCoinDatabase(t, 'close-once', { create: false });
  const creating = recordingFileSystem({ directory: root, fail: { step: ['close', 'xiaoji.sqlite'] } });
  useFileSystem(creating, 'linux');
  await assert.rejects(coin.initializeNewCoinDatabase({ expectedPath: dbPath }), /synthetic close failure/u);
  coin.setCoinDatabaseDurabilityForTests(null);
  assert.equal(creating.calls.filter(([kind, name]) => kind === 'close' && name === 'xiaoji.sqlite').length, 1);
  assert.equal(creating.calls.some(([kind, name]) => kind === 'open' && name === directoryName), false);
  assert.deepEqual(fs.readdirSync(root), []);
});

test('the directory sync of a new database: open, fsync or close failing is escalated; EOPNOTSUPP and EISDIR count as unsupported',
  async (t) => {
    const { root, dbPath, directoryName } = await freshCoinDatabase(t, 'directory-steps', { create: false });
    const logs = captureCoinDatabaseLogs(t);
    const cases = [
      { step: ['open', directoryName, 'r'], code: 'EACCES', expected: 'failed', closes: 0 },
      { step: ['fsync', directoryName], code: 'EIO', expected: 'failed', closes: 1 },
      { step: ['close', directoryName], code: 'EIO', expected: 'failed', closes: 1 },
      { step: ['fsync', directoryName], code: 'EOPNOTSUPP', expected: 'unsupported', closes: 1 },
      { step: ['open', directoryName, 'r'], code: 'EISDIR', expected: 'unsupported', closes: 0 },
    ];
    for (const { step, code, expected, closes } of cases) {
      const label = `${step[0]} ${code}`;
      coin.resetCoinDatabaseForTests();
      fs.rmSync(dbPath, { force: true });
      logs.length = 0;
      const recorder = recordingFileSystem({ directory: root, fail: { step, code } });
      useFileSystem(recorder, 'linux');
      // The database stands either way.
      await coin.initializeNewCoinDatabase({ expectedPath: dbPath });
      coin.setCoinDatabaseDurabilityForTests(null);
      assert.equal(recorder.calls.filter(([kind, name]) => kind === 'close' && name === directoryName).length, closes, label);
      await coin.withCoinTransaction((api) => insertMarker(api, 'stands'));
      if (expected === 'failed') {
        assert.deepEqual(logs, [
          `[COIN_DB] code=COIN_DB_DIRECTORY_SYNC_FAILED stage=open errno=${code}`,
          '[COIN_DB] code=COIN_DB_ESCALATION cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=open',
        ], label);
        assert.deepEqual(coin.getLedgerEscalations().map((entry) => entry.code), ['COIN_DB_DIRECTORY_SYNC_FAILED'], label);
      } else {
        assert.deepEqual(logs, [`[COIN_DB] code=COIN_DB_DIRECTORY_SYNC_UNSUPPORTED errno=${code}`], label);
        assert.deepEqual(coin.getLedgerEscalations(), [], label);
      }
    }
  });

test('the file-system hook of the whole-file writes is refused outside the Node test runner', () => {
  const script = `
    const coin = require(process.argv[1]);
    try {
      coin.setCoinDatabaseDurabilityForTests({ filesystem: require('node:fs') });
      process.stdout.write('accepted');
    } catch (error) {
      process.stdout.write(error.name);
    }
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.COIN_DB_PATH;
  const result = spawnSync(process.execPath, ['-e', script, COIN_MODULE], { env, encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(result.stdout, 'CoinDatabaseError', result.stderr);
});

const ESCALATION_LINE =
  '[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=coin-database cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=open';

async function createWithFailingDirectorySync(dbPath) {
  coin.resetCoinDatabaseForTests();
  fs.rmSync(dbPath, { force: true });
  useFileSystem(recordingFileSystem({ directory: path.dirname(dbPath), fail: { step: ['fsync', path.basename(path.dirname(dbPath))] } }),
    'linux');
  try {
    await coin.initializeNewCoinDatabase({ expectedPath: dbPath });
  } finally {
    coin.setCoinDatabaseDurabilityForTests(null);
  }
}

test('a coin database escalation is reported once and ends the stop with exit code 3', async (t) => {
  const { dbPath } = await freshCoinDatabase(t, 'shutdown', { create: false });
  captureCoinDatabaseLogs(t);
  const reported = [];
  const reportLogger = { error: (line) => reported.push(line) };
  await createWithFailingDirectorySync(dbPath);
  const stop = {};
  assert.equal(settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger: reportLogger, processRef: stop, exitCode: 0 }),
    LEDGER_ESCALATION_EXIT_CODE);
  assert.equal(stop.exitCode, 3);
  // The last report of the stop prints nothing again but keeps the code.
  assert.equal(settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger: reportLogger, processRef: stop }), 3);
  assert.deepEqual(reported, [ESCALATION_LINE]);
  // A failure code set earlier is kept.
  const crashed = { exitCode: 1 };
  assert.equal(settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger: reportLogger, processRef: crashed }), 1);
  // A fresh database starts afresh.
  await createWithFailingDirectorySync(dbPath);
  reported.length = 0;
  assert.equal(settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger: reportLogger, processRef: {}, exitCode: 0 }), 3);
  assert.deepEqual(reported, [ESCALATION_LINE]);
});

test('index.js closes the coin database after every later stop step and reports the escalations in every stop path', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8').replace(/\r\n/gu, '\n');
  // Loaded with the other modules at start, never during a stop.
  assert.match(source, /^const coinDatabaseEscalations = require\('\.\/systems\/economy\/coinDatabaseEscalations'\);$/mu);
  assert.equal((source.match(/require\('\.\/systems\/economy\/coinDatabaseEscalations'\)/gu) || []).length, 1);
  const calls = source.match(/settleLedgerShutdown\(\{\s*sources: \[[^\]]*\][^)]*\)/gu) || [];
  assert.equal(calls.length, 3, source);
  // The stop and the failed start report it with the ledgers …
  const withLedgers = calls.filter((call) => call.includes('publicSideEffectRuntime'));
  assert.equal(withLedgers.length, 2, calls.join('\n'));
  for (const call of withLedgers) {
    assert.match(call, /sources: \[publicSideEffectRuntime, welcomeSideEffectRuntime, ownerSafetyNotifier, protectedEffects,\s*coinDatabaseEscalations\]/u, call);
  }
  assert.equal(calls.filter((call) => /sources: \[coinDatabaseEscalations\]/u.test(call)).length, 1, calls.join('\n'));
  // … and the stop closes the database and reports it alone once more, after every later step, right before it exits.
  const start = source.indexOf('async function shutdown(');
  const shutdown = source.slice(start, source.indexOf('\n}\n', start));
  assert.equal((shutdown.match(/closeCoinDatabase\(\)/gu) || []).length, 1, shutdown);
  const close = shutdown.indexOf('await coinDatabaseEscalations.closeCoinDatabase();');
  const last = shutdown.lastIndexOf('settleLedgerShutdown({');
  assert.ok(close > shutdown.indexOf('await boardRuntime.stopLifecycle();'), shutdown);
  assert.ok(close > shutdown.indexOf('client.destroy();'), shutdown);
  assert.ok(close > shutdown.indexOf('await protectedEffects.stop();'), shutdown);
  assert.ok(last > close, shutdown);
  assert.match(shutdown, /let stepFailed = false;\s*try \{\s*await boardRuntime\.stopLifecycle\(\);/u);
  const later = shutdown.slice(shutdown.lastIndexOf('try {', shutdown.indexOf('await boardRuntime.stopLifecycle();')));
  assert.match(later, new RegExp('^try \\{\\s*await boardRuntime\\.stopLifecycle\\(\\);[\\s\\S]*' +
    'testControlRuntimeController\\.dispose\\(\\);\\s*\\} catch \\(error\\) \\{\\s*stepFailed = true;\\s*' +
    'const cause = [^\\n]*\\n\\s*logger\\.error\\(`\\[SHUTDOWN\\] code=SHUTDOWN_STEP_FAILED cause=\\$\\{cause\\}`\\);' +
    // The member records are written first thing in this finally, then the coin database is closed (a failed
    // close is one fixed line and a failed stop), so a step that threw can skip neither.
    '\\s*\\} finally \\{\\s*flushMemberRecords\\(\\);\\s*(?://[^\\n]*\\s*)*try \\{\\s*' +
    'await coinDatabaseEscalations\\.closeCoinDatabase\\(\\);\\s*\\} catch \\{\\s*stepFailed = true;\\s*' +
    'logger\\.error\\(\'\\[SHUTDOWN\\] code=COIN_DB_CLOSE_FAILED\'\\);\\s*\\}\\s*(?://[^\\n]*\\s*)*try \\{\\s*' +
    'settleLedgerShutdown\\(\\{ sources: \\[coinDatabaseEscalations\\], logger, processRef: process \\}\\);' +
    '\\s*\\} finally \\{\\s*if \\(stepFailed && !process\\.exitCode\\) process\\.exitCode = 1;' +
    '\\s*process\\.exit\\(process\\.exitCode\\);\\s*\\}\\s*\\}\\s*$', 'u'), later);
});

test('init-coin-db closes the new database cleanly, and ends with exit code 3 when its directory sync failed', (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-coin-init-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }));
  const script = path.join(__dirname, '..', 'scripts', 'init-coin-db.js');
  // The script runs in its own process; failDirectory replaces its file system first (the test
  // runner's context is inherited, so the hook is allowed there).
  const run = (dbPath, failDirectory) => spawnSync(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    if (${failDirectory}) {
      const coin = require(${JSON.stringify(COIN_MODULE)});
      const directory = path.dirname(process.env.COIN_DB_PATH);
      const descriptor = -77;
      coin.setCoinDatabaseDurabilityForTests({ platform: 'linux', filesystem: { ...fs,
        openSync: (target, flags, ...rest) => (path.resolve(String(target)) === directory && flags === 'r'
          ? descriptor : fs.openSync(target, flags, ...rest)),
        fsyncSync: (fd) => {
          if (fd === descriptor) throw Object.assign(new Error('synthetic directory fsync failure'), { code: 'EIO' });
          return fs.fsyncSync(fd);
        },
        closeSync: (fd) => (fd === descriptor ? undefined : fs.closeSync(fd)) } });
    }
    process.argv = [process.execPath, ${JSON.stringify(script)}, process.env.COIN_DB_PATH];
    require(${JSON.stringify(script)});
  `], { env: { ...process.env, COIN_DB_PATH: dbPath }, encoding: 'utf8', cwd: root });

  const cleanPath = path.join(root, 'clean', 'xiaoji.sqlite');
  const clean = run(cleanPath, false);
  assert.equal(clean.status, 0, clean.stderr);
  assert.match(clean.stdout, /吉幣資料庫已初次建立/u);
  assert.doesNotMatch(clean.stderr, /LEDGER_ESCALATION/u);
  assert.deepEqual(fs.readdirSync(path.dirname(cleanPath)), ['xiaoji.sqlite']);

  const failingPath = path.join(root, 'failing', 'xiaoji.sqlite');
  const failing = run(failingPath, true);
  assert.equal(failing.status, 3, failing.stderr);
  assert.match(failing.stdout, /吉幣資料庫已初次建立/u);
  assert.match(failing.stderr,
    /^\[SIDE_EFFECT_LEDGER\] code=LEDGER_ESCALATION purpose=coin-database cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=open$/mu);
  assert.ok(fs.existsSync(failingPath));
});

test('a snapshot of the open database is a consistent standalone file, taken between transactions', async (t) => {
  const { root, dbPath } = await freshCoinDatabase(t, 'snapshot');
  await coin.withCoinTransaction((api) => insertMarker(api, 'in-snapshot'));
  const target = path.join(root, 'snapshots', 'coin-snapshot.sqlite');
  fs.mkdirSync(path.dirname(target));
  // Queued behind a transaction that is still running: the snapshot waits for its COMMIT.
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const running = coin.withCoinTransaction(async (api) => {
    insertMarker(api, 'queued-before');
    await gate;
  });
  const snapshot = coin.snapshotCoinDatabase(target);
  release();
  await running;
  const result = await snapshot;
  assert.equal(result.path, target);
  assert.equal(result.sha256, sha256File(target));
  assert.deepEqual(fs.readdirSync(path.dirname(target)), ['coin-snapshot.sqlite']);
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.equal(copy.prepare("SELECT value FROM coin_metadata WHERE key = 'in-snapshot'").get().value, '1');
    assert.equal(copy.prepare("SELECT value FROM coin_metadata WHERE key = 'queued-before'").get().value, '1');
  } finally {
    copy.close();
  }
  await assert.rejects(coin.snapshotCoinDatabase(target), /已存在/u);
  await assert.rejects(coin.snapshotCoinDatabase(dbPath), /已存在/u);
  await assert.rejects(coin.snapshotCoinDatabase('relative.sqlite'), /絕對路徑/u);
  // The database itself is still open and in use.
  await coin.withCoinTransaction((api) => insertMarker(api, 'after-snapshot'));
  assert.equal(nextStartValue(dbPath, 'after-snapshot'), '1');
});

test('the stopped-database readers use an in-memory copy and refuse while a -wal lies beside the file', async (t) => {
  const { root, dbPath } = await freshCoinDatabase(t, 'readers');
  await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: '{"a":1}' }]);
  await assert.rejects(coin.inspectSafetyRegistrationsFromFile(dbPath), /小吉還在執行或上次沒有正常關閉/u);
  await assert.rejects(coin.dryRunGlobalEconomyV22({ dbPath }),
    (error) => /v22 預演失敗/u.test(error.message) && /小吉還在執行/u.test(error.cause?.message));
  await coin.closeCoinDatabase();
  const before = sha256File(dbPath);
  const inspected = await coin.inspectSafetyRegistrationsFromFile(dbPath);
  assert.equal(inspected.sha256, before);
  assert.equal(inspected.schemaVersion, 24);
  assert.equal(inspected.registrations.welcome.value, '{"a":1}');
  await assert.rejects(coin.dryRunGlobalEconomyV22({ dbPath }), (error) => /requires schema v21, received 24/u.test(error.cause?.message));
  assert.equal(sha256File(dbPath), before);
  assert.deepEqual(fs.readdirSync(root), ['xiaoji.sqlite']);
});
