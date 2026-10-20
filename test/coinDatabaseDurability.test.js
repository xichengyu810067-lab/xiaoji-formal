'use strict';

// Every coin database write is durable (temporary file in the same directory, fsync, rename,
// directory fsync), and the file is rewritten only when memory differs from what was last
// written to it. The POSIX order is checked on every host: where the host itself is POSIX the
// directory is really opened read-only and fsynced; on Windows, which cannot open a
// directory, those three calls are simulated.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const coin = require('../src/services/coinDatabase');
const logger = require('../src/utils/logger');
const { ensureGuildSettings } = require('../src/systems/economy/coinService');
const coinDatabaseEscalations = require('../src/systems/economy/coinDatabaseEscalations');
const { LEDGER_ESCALATION_EXIT_CODE, settleLedgerShutdown } = require('../src/systems/safety/ledgerEscalation');

const COIN_MODULE = path.join(__dirname, '..', 'src', 'services', 'coinDatabase.js');
const GUILD_ID = '123456789012345678';
const NOTHING = (api) => api.get('SELECT 1 AS one');
const SIMULATE_DIRECTORY = process.platform === 'win32';

let sqlModule = null;
async function loadSql() {
  if (!sqlModule) {
    sqlModule = await require('sql.js')({ locateFile: (name) => path.join(path.dirname(require.resolve('sql.js')), name) });
  }
  return sqlModule;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// A fresh coin database in its own temporary folder. resetCoinDatabaseForTests() also drops
// a replaced file system, so a test replaces it only after this.
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

// Passes every call to the real file system and records the steps a durable write takes
// (paths reduced to base names; renames also keep their full paths). `fail` makes one step
// throw instead (a failing close still releases the real descriptor first);
// `renameFailures` lists error codes the next renames throw before one succeeds.
function recordingFileSystem({ directory = null, fail = null, renameFailures = [] } = {}) {
  const calls = [];
  const renames = [];
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
      renames.push([String(from), String(to)]);
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
  return { calls, renames, filesystem, steps: () => calls.filter(([kind]) => kind !== 'write') };
}

function useFileSystem(recorder, platform, extra = {}) {
  coin.setCoinDatabaseDurabilityForTests({ filesystem: recorder.filesystem, platform, ...extra });
}

function insertMarker(api, key, value = '1') {
  api.run('INSERT INTO coin_metadata (key, value, updated_at) VALUES (?, ?, ?)', [key, value, '2026-10-03T00:00:00.000Z']);
}

async function memoryValue(key) {
  const row = await coin.withCoinDatabase((api) => api.get('SELECT value FROM coin_metadata WHERE key = ?', [key]));
  return row ? row.value : null;
}

// The bytes memory would be written as. The export reopens the sql.js connection, so the
// foreign-key pragma is turned back on, as the module's own export does.
async function memoryBytes() {
  return coin.withCoinDatabase((api) => {
    try {
      return Buffer.from(api.db.export());
    } finally {
      api.db.run('PRAGMA foreign_keys = ON');
    }
  });
}

async function fileRow(dbPath, sql, params) {
  const SQL = await loadSql();
  const db = new SQL.Database(fs.readFileSync(dbPath));
  const statement = db.prepare(sql);
  try {
    statement.bind(params);
    return statement.step() ? statement.getAsObject() : null;
  } finally {
    statement.free();
    db.close();
  }
}

async function fileMetadata(dbPath, key) {
  const row = await fileRow(dbPath, 'SELECT value FROM coin_metadata WHERE key = ?', [key]);
  return row ? row.value : null;
}

async function assertFileMatchesMemory(dbPath, message = 'the file holds exactly what memory holds') {
  assert.ok(fs.readFileSync(dbPath).equals(await memoryBytes()), message);
}

function captureCoinDatabaseLogs(t) {
  const lines = [];
  const original = { warn: logger.warn, error: logger.error };
  logger.warn = (message) => { lines.push(String(message)); };
  logger.error = (message) => { lines.push(String(message)); };
  t.after(() => Object.assign(logger, original));
  return lines;
}

function expectedReplaceSteps(directoryName, platform) {
  return [
    ['mkdir', directoryName],
    ['open', 'xiaoji.sqlite.tmp', 'w'],
    ['fsync', 'xiaoji.sqlite.tmp'],
    ['close', 'xiaoji.sqlite.tmp'],
    ['rename', 'xiaoji.sqlite.tmp', 'xiaoji.sqlite'],
    ...(platform === 'win32'
      ? [['open', 'xiaoji.sqlite', 'r+'], ['fsync', 'xiaoji.sqlite'], ['close', 'xiaoji.sqlite']]
      : [['open', directoryName, 'r'], ['fsync', directoryName], ['close', directoryName]]),
  ];
}

test('every coin database write fsyncs a temporary file in the same directory, renames it, then syncs the directory',
  async (t) => {
    const { dbPath, directoryName } = await freshCoinDatabase(t, 'order');
    for (const platform of ['linux', 'win32']) {
      for (const [label, key, write] of [
        ['transaction', `order-${platform}-tx`, (key) => coin.withCoinTransaction((api) => insertMarker(api, key))],
      ]) {
        const recorder = recordingFileSystem({ directory: path.dirname(dbPath) });
        useFileSystem(recorder, platform);
        await write(key);
        coin.setCoinDatabaseDurabilityForTests(null);
        // fsync of the temporary file comes before the rename; on POSIX the directory is
        // opened read-only ('r', O_RDONLY) and fsynced after it.
        assert.deepEqual(recorder.steps(), expectedReplaceSteps(directoryName, platform), `${platform} ${label}`);
        assert.ok(recorder.calls.some(([kind]) => kind === 'write'), `${platform} ${label}`);
        // The temporary file sits next to the database file, so the rename is an atomic
        // replace within one directory (and one file system).
        assert.deepEqual(recorder.renames, [[`${dbPath}.tmp`, dbPath]]);
        assert.equal(path.dirname(recorder.renames[0][0]), path.dirname(recorder.renames[0][1]));
        assert.equal(await fileMetadata(dbPath, key), '1');
        await assertFileMatchesMemory(dbPath, `${platform} ${label}`);
      }
    }
  });

test('opening an existing database writes it back durably, and a new one is created in place without overwriting',
  async (t) => {
    const { root, dbPath, directoryName } = await freshCoinDatabase(t, 'open', { create: false });
    // A failure while creating removes the half-made file; initialization can then be retried.
    const failing = recordingFileSystem({ directory: root, fail: { step: ['fsync', 'xiaoji.sqlite'] } });
    useFileSystem(failing, 'linux');
    await assert.rejects(coin.initializeNewCoinDatabase({ expectedPath: dbPath }), /synthetic fsync failure/u);
    assert.deepEqual(fs.readdirSync(root), []);

    const created = recordingFileSystem({ directory: root });
    useFileSystem(created, 'linux');
    await coin.initializeNewCoinDatabase({ expectedPath: dbPath });
    assert.deepEqual(created.steps(), [
      ['mkdir', directoryName],
      ['open', 'xiaoji.sqlite', 'wx'],
      ['fsync', 'xiaoji.sqlite'],
      ['close', 'xiaoji.sqlite'],
      ['open', directoryName, 'r'],
      ['fsync', directoryName],
      ['close', directoryName],
    ]);
    await assertFileMatchesMemory(dbPath);

    // A start writes the existing database back through the same durable steps.
    coin.resetCoinDatabaseForTests();
    const reopened = recordingFileSystem({ directory: root });
    useFileSystem(reopened, 'linux');
    await coin.initializeCoinDatabase();
    assert.deepEqual(reopened.steps(), expectedReplaceSteps(directoryName, 'linux'));
    await assertFileMatchesMemory(dbPath);
    assert.deepEqual(fs.readdirSync(root), ['xiaoji.sqlite']);
  });

test('on Windows a scanner\'s EPERM/EBUSY on the rename is retried; when the retries run out the transaction is undone',
  async (t) => {
    const { root, dbPath } = await freshCoinDatabase(t, 'retry');
    const slept = [];
    const sleep = async (ms) => { slept.push(ms); };
    const transient = recordingFileSystem({ renameFailures: ['EPERM', 'EBUSY'] });
    useFileSystem(transient, 'win32', { sleep });
    await coin.withCoinTransaction((api) => insertMarker(api, 'retry-ok'));
    assert.equal(transient.calls.filter(([kind]) => kind === 'rename').length, 3);
    assert.deepEqual(slept, [25, 50]);
    assert.equal(await fileMetadata(dbPath, 'retry-ok'), '1');

    const before = sha256File(dbPath);
    slept.length = 0;
    const exhausted = recordingFileSystem({ renameFailures: Array(8).fill('EBUSY') });
    useFileSystem(exhausted, 'win32', { sleep });
    await assert.rejects(coin.withCoinTransaction((api) => insertMarker(api, 'retry-exhausted')),
      (error) => error instanceof coin.CoinDatabaseError && error.message === '吉幣資料庫落盤失敗，交易已復原。' &&
        error.cause?.code === 'EBUSY');
    assert.equal(exhausted.calls.filter(([kind]) => kind === 'rename').length, 8);
    assert.deepEqual(slept, [25, 50, 100, 200, 400, 800, 1000]);
    // The file is untouched, the temporary file is gone, and memory is back to its state
    // before the transaction.
    assert.equal(sha256File(dbPath), before);
    assert.deepEqual(fs.readdirSync(root), ['xiaoji.sqlite']);
    coin.setCoinDatabaseDurabilityForTests(null);
    assert.equal(await memoryValue('retry-exhausted'), null);
    assert.equal(await memoryValue('retry-ok'), '1');

    // On POSIX the same codes are real errors: one attempt, no retry.
    const denied = recordingFileSystem({ renameFailures: ['EACCES'] });
    useFileSystem(denied, 'linux', { sleep });
    await assert.rejects(coin.withCoinTransaction((api) => insertMarker(api, 'denied')),
      (error) => error.cause?.code === 'EACCES');
    assert.equal(denied.calls.filter(([kind]) => kind === 'rename').length, 1);
    coin.setCoinDatabaseDurabilityForTests(null);
    assert.equal(sha256File(dbPath), before);
    assert.equal(await memoryValue('denied'), null);
  });

test('a failure at any step up to the rename restores memory and leaves the database file untouched', async (t) => {
  const { root, dbPath, directoryName } = await freshCoinDatabase(t, 'steps');
  const steps = [
    ['mkdir', directoryName],
    ['open', 'xiaoji.sqlite.tmp', 'w'],
    ['write', 'xiaoji.sqlite.tmp'],
    ['fsync', 'xiaoji.sqlite.tmp'],
    ['close', 'xiaoji.sqlite.tmp'],
    ['rename', 'xiaoji.sqlite.tmp', 'xiaoji.sqlite'],
  ];
  for (const [index, step] of steps.entries()) {
    const label = step.join(' ');
    const key = `step-${index}`;
    const before = sha256File(dbPath);
    const recorder = recordingFileSystem({ directory: path.dirname(dbPath), fail: { step } });
    useFileSystem(recorder, 'linux');
    await assert.rejects(coin.withCoinTransaction((api) => insertMarker(api, key)),
      (error) => error instanceof coin.CoinDatabaseError && error.message === '吉幣資料庫落盤失敗，交易已復原。' &&
        error.cause?.message === `synthetic ${step[0]} failure`, label);
    coin.setCoinDatabaseDurabilityForTests(null);
    if (step[0] !== 'rename') assert.equal(recorder.calls.some(([kind]) => kind === 'rename'), false, label);
    assert.equal(sha256File(dbPath), before, label);
    assert.deepEqual(fs.readdirSync(root), ['xiaoji.sqlite'], label);
    assert.equal(await memoryValue(key), null, label);
    // The restored database keeps working, and the file follows memory again.
    await coin.withCoinTransaction((api) => insertMarker(api, `${key}-after`));
    assert.equal(await fileMetadata(dbPath, `${key}-after`), '1', label);
    assert.equal(await fileMetadata(dbPath, key), null, label);
    await assertFileMatchesMemory(dbPath, label);
  }
});

test('a directory fsync failing after the rename counts as committed: memory keeps the write and a fixed code is escalated',
  async (t) => {
    const { dbPath, directoryName } = await freshCoinDatabase(t, 'directory');
    const logs = captureCoinDatabaseLogs(t);
    const failing = recordingFileSystem({ directory: path.dirname(dbPath), fail: { step: ['fsync', directoryName] } });
    useFileSystem(failing, 'linux');
    const result = await coin.withCoinTransaction((api) => {
      insertMarker(api, 'after-rename');
      return 'committed';
    });
    assert.equal(result, 'committed');
    assert.deepEqual(failing.steps(), expectedReplaceSteps(directoryName, 'linux'));
    // Memory and the file hold the same write: nothing was rolled back.
    assert.equal(await memoryValue('after-rename'), '1');
    assert.equal(await fileMetadata(dbPath, 'after-rename'), '1');
    await assertFileMatchesMemory(dbPath);
    assert.deepEqual(coin.getLedgerEscalations(), [
      { purposeId: 'coin-database', code: 'COIN_DB_DIRECTORY_SYNC_FAILED', stage: 'runtime', reason: null },
    ]);
    assert.deepEqual(logs, [
      '[COIN_DB] code=COIN_DB_DIRECTORY_SYNC_FAILED stage=runtime errno=EIO',
      '[COIN_DB] code=COIN_DB_ESCALATION cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=runtime',
    ]);

    // The write is not confirmed durable, so the next operation writes and syncs again even
    // though it changes nothing; once that succeeds, an unchanged database is not written.
    const retry = recordingFileSystem({ directory: path.dirname(dbPath) });
    useFileSystem(retry, 'linux');
    await coin.withCoinTransaction(NOTHING);
    assert.deepEqual(retry.steps(), expectedReplaceSteps(directoryName, 'linux'));
    const quiet = recordingFileSystem({ directory: path.dirname(dbPath) });
    useFileSystem(quiet, 'linux');
    await coin.withCoinTransaction(NOTHING);
    assert.deepEqual(quiet.calls, []);

    // The same failure while opening the database lets the start continue, escalated as 'open'.
    coin.resetCoinDatabaseForTests();
    const atOpen = recordingFileSystem({ directory: path.dirname(dbPath), fail: { step: ['fsync', directoryName] } });
    useFileSystem(atOpen, 'linux');
    await coin.initializeCoinDatabase();
    assert.deepEqual(coin.getLedgerEscalations().map((entry) => entry.stage), ['open']);
    await assertFileMatchesMemory(dbPath);
  });

test('a file system that cannot sync a directory (EINVAL and the like) keeps the write with one warning', async (t) => {
  const { dbPath, directoryName } = await freshCoinDatabase(t, 'unsupported');
  const logs = captureCoinDatabaseLogs(t);
  for (const [index, code] of ['EINVAL', 'EINVAL', 'ENOTSUP'].entries()) {
    const recorder = recordingFileSystem({ directory: path.dirname(dbPath), fail: { step: ['fsync', directoryName], code } });
    useFileSystem(recorder, 'linux');
    await coin.withCoinTransaction((api) => insertMarker(api, `unsupported-${index}`));
    assert.deepEqual(recorder.steps(), expectedReplaceSteps(directoryName, 'linux'), code);
    assert.equal(await fileMetadata(dbPath, `unsupported-${index}`), '1', code);
  }
  // Committed, not escalated; one warning per code; an unchanged database is not rewritten.
  assert.deepEqual(coin.getLedgerEscalations(), []);
  assert.deepEqual(logs, [
    '[COIN_DB] code=COIN_DB_DIRECTORY_SYNC_UNSUPPORTED errno=EINVAL',
    '[COIN_DB] code=COIN_DB_DIRECTORY_SYNC_UNSUPPORTED errno=ENOTSUP',
  ]);
  const quiet = recordingFileSystem({ directory: path.dirname(dbPath), fail: { step: ['fsync', directoryName], code: 'EINVAL' } });
  useFileSystem(quiet, 'linux');
  await coin.withCoinTransaction(NOTHING);
  assert.deepEqual(quiet.calls, []);
  // A safety registration written there succeeds the same way instead of failing closed.
  coin.setCoinDatabaseDurabilityForTests(null);
  const einval = recordingFileSystem({ directory: path.dirname(dbPath), fail: { step: ['fsync', directoryName], code: 'EINVAL' } });
  const written = await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: '{"n":1}' }],
    { filesystem: einval.filesystem, platform: 'linux' });
  assert.equal(written.written, 1);
  assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, '{"n":1}');
  assert.equal((await coin.inspectSafetyRegistrationsFromFile(dbPath)).registrations.welcome.value, '{"n":1}');
  await assertFileMatchesMemory(dbPath);
});

test('a transaction that changes nothing writes nothing; a change made outside a transaction is written by the next one',
  async (t) => {
    const { dbPath, directoryName } = await freshCoinDatabase(t, 'skip');
    const recorder = recordingFileSystem({ directory: path.dirname(dbPath) });
    useFileSystem(recorder, 'linux');
    const before = sha256File(dbPath);
    const mtime = fs.statSync(dbPath).mtimeMs;
    await coin.withCoinTransaction(NOTHING);
    await coin.withCoinTransaction((api) => api.run(
      "INSERT INTO coin_metadata (key, value, updated_at) VALUES ('schema_version', 'x', 'y') ON CONFLICT(key) DO NOTHING"));
    assert.deepEqual(recorder.calls, []);
    assert.equal(sha256File(dbPath), before);
    assert.equal(fs.statSync(dbPath).mtimeMs, mtime);

    // ensureGuildSettings through withCoinDatabase changes memory only, as the work penalty
    // announcement does; the next transaction writes it although it changes nothing itself.
    const settings = await coin.withCoinDatabase((api) => ensureGuildSettings(api, GUILD_ID));
    assert.equal(settings.guildId, GUILD_ID);
    assert.deepEqual(recorder.calls, []);
    const sql = 'SELECT guild_id FROM coin_guild_settings WHERE guild_id = ?';
    assert.equal(await fileRow(dbPath, sql, [GUILD_ID]), null);
    await coin.withCoinTransaction(NOTHING);
    assert.deepEqual(recorder.steps(), expectedReplaceSteps(directoryName, 'linux'));
    assert.deepEqual(await fileRow(dbPath, sql, [GUILD_ID]), { guild_id: GUILD_ID });
    await assertFileMatchesMemory(dbPath);
  });

test('every kind of change is written by the next transaction: run, exec, prepare and step, schema and PRAGMA',
  async (t) => {
    const { dbPath } = await freshCoinDatabase(t, 'kinds');
    const changes = [
      ['api.run', (api) => insertMarker(api, 'kind-run')],
      ['db.run', (api) => api.db.run("UPDATE coin_metadata SET value = '2' WHERE key = 'kind-run'")],
      ['db.exec', (api) => api.db.exec(
        "INSERT INTO coin_metadata (key, value, updated_at) VALUES ('kind-exec', '1', '2026-10-03T00:00:00.000Z')")],
      ['prepare and step', (api) => {
        const statement = api.db.prepare("DELETE FROM coin_metadata WHERE key = 'kind-exec'");
        try {
          statement.step();
        } finally {
          statement.free();
        }
      }],
      ['CREATE TABLE', (api) => api.db.run('CREATE TABLE durability_probe (id INTEGER PRIMARY KEY)')],
      ['DROP TABLE', (api) => api.db.run('DROP TABLE durability_probe')],
      ['PRAGMA user_version', (api) => api.db.run('PRAGMA user_version = 7')],
    ];
    for (const [label, change] of changes) {
      const before = sha256File(dbPath);
      await coin.withCoinDatabase(change);
      assert.equal(sha256File(dbPath), before, `${label}: memory only until the next write`);
      await coin.withCoinTransaction(NOTHING);
      assert.notEqual(sha256File(dbPath), before, `${label}: written by the next transaction`);
      await assertFileMatchesMemory(dbPath, label);
    }
    assert.equal(await fileMetadata(dbPath, 'kind-run'), '2');
    assert.equal(await fileMetadata(dbPath, 'kind-exec'), null);
    assert.deepEqual(await fileRow(dbPath, 'PRAGMA user_version', []), { user_version: 7 });
  });

test('after a registration write fails past the rename, the next transaction writes memory back even if it changes nothing',
  async (t) => {
    const { dbPath, directoryName } = await freshCoinDatabase(t, 'registration');
    const original = JSON.stringify({ state: 'creating' });
    await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: original }]);
    const failing = recordingFileSystem({ directory: path.dirname(dbPath), fail: { step: ['fsync', directoryName] } });
    await assert.rejects(coin.writeSafetyLedgerRegistrations(
      [{ purposeId: 'welcome', expectedValue: original, value: JSON.stringify({ state: 'active' }) }],
      { filesystem: failing.filesystem, platform: 'linux' }), (error) => error.code === 'SAFETY_REGISTRATION_WRITE_FAILED');
    // Unchanged registration rule: memory went back, the file is one write ahead.
    assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, original);
    assert.notEqual((await coin.inspectSafetyRegistrationsFromFile(dbPath)).registrations.welcome.value, original);
    // A transaction that changes nothing still writes memory back.
    await coin.withCoinTransaction(NOTHING);
    assert.equal((await coin.inspectSafetyRegistrationsFromFile(dbPath)).registrations.welcome.value, original);
    await assertFileMatchesMemory(dbPath);
  });

test('the file-system hook of coin database writes is refused outside the Node test runner', () => {
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
  '[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=coin-database cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=runtime';

async function failOneDirectorySync(dbPath, directoryName, key) {
  useFileSystem(recordingFileSystem({ directory: path.dirname(dbPath), fail: { step: ['fsync', directoryName] } }), 'linux');
  try {
    await coin.withCoinTransaction((api) => insertMarker(api, key));
  } finally {
    coin.setCoinDatabaseDurabilityForTests(null);
  }
}

test('a coin database escalation is reported once and ends the stop with exit code 3, also when it comes late',
  async (t) => {
    const { dbPath, directoryName } = await freshCoinDatabase(t, 'shutdown');
    captureCoinDatabaseLogs(t);
    const reported = [];
    const logger = { error: (line) => reported.push(line) };
    // A clean first report, then a failure during the later stop steps: the last report of the
    // coin database alone still turns the clean code into the escalation code.
    const late = {};
    assert.equal(settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger, processRef: late, exitCode: 0 }), 0);
    assert.equal(late.exitCode, 0);
    await failOneDirectorySync(dbPath, directoryName, 'during-later-steps');
    assert.equal(settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger, processRef: late }),
      LEDGER_ESCALATION_EXIT_CODE);
    assert.equal(late.exitCode, 3);
    assert.deepEqual(reported, [ESCALATION_LINE]);
    // Reported already: a later report prints nothing again but keeps the code, and another
    // failure in the same stage is the same escalation.
    await failOneDirectorySync(dbPath, directoryName, 'again');
    assert.equal(settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger, processRef: late }), 3);
    assert.deepEqual(reported, [ESCALATION_LINE]);
    // A failure code set earlier is kept.
    const crashed = { exitCode: 1 };
    assert.equal(settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger, processRef: crashed }), 1);

    // A fresh database starts afresh: the same failure before the first report is printed by
    // that report, and the last one adds nothing.
    coin.resetCoinDatabaseForTests();
    await coin.initializeCoinDatabase();
    await failOneDirectorySync(dbPath, directoryName, 'before-stop');
    reported.length = 0;
    const early = {};
    assert.equal(settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger, processRef: early, exitCode: 0 }), 3);
    assert.equal(settleLedgerShutdown({ sources: [coinDatabaseEscalations], logger, processRef: early }), 3);
    assert.deepEqual(reported, [ESCALATION_LINE]);
  });

test('index.js loads the coin database escalations once and reports them in every stop path, even after a failing step', () => {
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
  // … and the stop reports it alone once more, after every later step, right before it exits.
  const start = source.indexOf('async function shutdown(');
  const shutdown = source.slice(start, source.indexOf('\n}\n', start));
  const last = shutdown.lastIndexOf('settleLedgerShutdown({');
  assert.ok(last > shutdown.indexOf('await boardRuntime.stopLifecycle();'), shutdown);
  assert.ok(last > shutdown.indexOf('client.destroy();'), shutdown);
  assert.match(shutdown.slice(last), new RegExp('^settleLedgerShutdown\\(\\{ sources: \\[coinDatabaseEscalations\\], ' +
    'logger, processRef: process \\}\\);\\s*\\} finally \\{\\s*if \\(stepFailed && !process\\.exitCode\\) ' +
    'process\\.exitCode = 1;\\s*process\\.exit\\(process\\.exitCode\\);\\s*\\}\\s*\\}\\s*$', 'u'));
  // The later steps sit in a try whose catch logs one fixed line and marks the stop failed, and
  // whose finally makes that last report and then exits, non-zero after a failed step, so a step
  // that throws can neither skip them, hang the process, nor end it with 0.
  assert.match(shutdown, /let stepFailed = false;\s*try \{\s*await boardRuntime\.stopLifecycle\(\);/u);
  const later = shutdown.slice(shutdown.lastIndexOf('try {', shutdown.indexOf('await boardRuntime.stopLifecycle();')));
  assert.match(later, new RegExp('^try \\{\\s*await boardRuntime\\.stopLifecycle\\(\\);[\\s\\S]*' +
    'testControlRuntimeController\\.dispose\\(\\);\\s*\\} catch \\(error\\) \\{\\s*stepFailed = true;\\s*' +
    'const cause = [^\\n]*\\n\\s*logger\\.error\\(`\\[SHUTDOWN\\] code=SHUTDOWN_STEP_FAILED cause=\\$\\{cause\\}`\\);' +
    // The records of who was welcomed and of the leave notices are written first thing in this finally, so
    // a step that threw (a private shutdown hook, say) cannot skip it.
    '\\s*\\} finally \\{\\s*flushMemberRecords\\(\\);\\s*(?://[^\\n]*\\s*)*try \\{\\s*' +
    'settleLedgerShutdown\\(\\{ sources: \\[coinDatabaseEscalations\\], logger, processRef: process \\}\\);' +
    '\\s*\\} finally \\{\\s*if \\(stepFailed && !process\\.exitCode\\) process\\.exitCode = 1;' +
    '\\s*process\\.exit\\(process\\.exitCode\\);\\s*\\}\\s*\\}\\s*$', 'u'), later);
});

test('a close that fails is never repeated: the temporary file and a new database file are closed at most once',
  async (t) => {
    const { root, dbPath, directoryName } = await freshCoinDatabase(t, 'close-once');
    const before = sha256File(dbPath);
    const failing = recordingFileSystem({ directory: path.dirname(dbPath), fail: { step: ['close', 'xiaoji.sqlite.tmp'] } });
    useFileSystem(failing, 'linux');
    await assert.rejects(coin.withCoinTransaction((api) => insertMarker(api, 'close-once')),
      (error) => error instanceof coin.CoinDatabaseError && error.cause?.message === 'synthetic close failure');
    coin.setCoinDatabaseDurabilityForTests(null);
    assert.equal(failing.calls.filter(([kind, name]) => kind === 'close' && name === 'xiaoji.sqlite.tmp').length, 1);
    assert.equal(failing.calls.some(([kind]) => kind === 'rename'), false);
    assert.equal(sha256File(dbPath), before);
    assert.deepEqual(fs.readdirSync(root), ['xiaoji.sqlite']);
    assert.equal(await memoryValue('close-once'), null);

    // A new database whose close fails: the creation fails and leaves nothing behind.
    coin.resetCoinDatabaseForTests();
    fs.rmSync(dbPath);
    const creating = recordingFileSystem({ directory: root, fail: { step: ['close', 'xiaoji.sqlite'] } });
    useFileSystem(creating, 'linux');
    await assert.rejects(coin.initializeNewCoinDatabase({ expectedPath: dbPath }), /synthetic close failure/u);
    coin.setCoinDatabaseDurabilityForTests(null);
    assert.equal(creating.calls.filter(([kind, name]) => kind === 'close' && name === 'xiaoji.sqlite').length, 1);
    assert.equal(creating.calls.some(([kind, name]) => kind === 'open' && name === directoryName), false);
    assert.deepEqual(fs.readdirSync(root), []);
  });

test('the directory sync: open, fsync or close failing is escalated; EOPNOTSUPP and EISDIR count as unsupported',
  async (t) => {
    const { dbPath, directoryName } = await freshCoinDatabase(t, 'directory-steps');
    const logs = captureCoinDatabaseLogs(t);
    const cases = [
      { step: ['open', directoryName, 'r'], code: 'EACCES', expected: 'failed', closes: 0 },
      { step: ['fsync', directoryName], code: 'EIO', expected: 'failed', closes: 1 },
      { step: ['close', directoryName], code: 'EIO', expected: 'failed', closes: 1 },
      { step: ['fsync', directoryName], code: 'EOPNOTSUPP', expected: 'unsupported', closes: 1 },
      { step: ['open', directoryName, 'r'], code: 'EISDIR', expected: 'unsupported', closes: 0 },
    ];
    for (const [index, { step, code, expected, closes }] of cases.entries()) {
      const label = `${step[0]} ${code}`;
      coin.resetCoinDatabaseForTests();
      await coin.initializeCoinDatabase();
      logs.length = 0;
      const recorder = recordingFileSystem({ directory: path.dirname(dbPath), fail: { step, code } });
      useFileSystem(recorder, 'linux');
      // The write stands either way: memory and file both hold it.
      await coin.withCoinTransaction((api) => insertMarker(api, `directory-${index}`));
      assert.equal(recorder.calls.filter(([kind, name]) => kind === 'close' && name === directoryName).length, closes, label);
      assert.equal(await memoryValue(`directory-${index}`), '1', label);
      assert.equal(await fileMetadata(dbPath, `directory-${index}`), '1', label);
      // A failure is escalated and leaves the write unconfirmed (the next operation writes
      // again); an unsupported file system warns once and the write counts as done.
      const quiet = recordingFileSystem({ directory: path.dirname(dbPath) });
      useFileSystem(quiet, 'linux');
      await coin.withCoinTransaction(NOTHING);
      if (expected === 'failed') {
        assert.deepEqual(logs, [
          `[COIN_DB] code=COIN_DB_DIRECTORY_SYNC_FAILED stage=runtime errno=${code}`,
          '[COIN_DB] code=COIN_DB_ESCALATION cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=runtime',
        ], label);
        assert.deepEqual(coin.getLedgerEscalations().map((entry) => entry.code), ['COIN_DB_DIRECTORY_SYNC_FAILED'], label);
        assert.ok(quiet.calls.some(([kind]) => kind === 'rename'), label);
      } else {
        assert.deepEqual(logs, [`[COIN_DB] code=COIN_DB_DIRECTORY_SYNC_UNSUPPORTED errno=${code}`], label);
        assert.deepEqual(coin.getLedgerEscalations(), [], label);
        assert.deepEqual(quiet.calls, [], label);
      }
      coin.setCoinDatabaseDurabilityForTests(null);
    }
  });

test('a safety registration write that runs out of space fails, before or after the rename', async (t) => {
  const { dbPath, directoryName } = await freshCoinDatabase(t, 'enospc');
  const original = JSON.stringify({ state: 'creating' });
  await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: original }]);
  for (const step of [['write', 'xiaoji.sqlite.tmp'], ['fsync', 'xiaoji.sqlite.tmp'], ['fsync', directoryName]]) {
    const label = step.join(' ');
    const failing = recordingFileSystem({ directory: path.dirname(dbPath), fail: { step, code: 'ENOSPC' } });
    await assert.rejects(coin.writeSafetyLedgerRegistrations(
      [{ purposeId: 'welcome', expectedValue: original, value: JSON.stringify({ state: 'active', step: label }) }],
      { filesystem: failing.filesystem, platform: 'linux' }),
    (error) => error.code === 'SAFETY_REGISTRATION_WRITE_FAILED' && error.cause?.code === 'ENOSPC', label);
    // Memory is back to the old value; ENOSPC is never taken for an unsupported file system.
    assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, original, label);
    const inFile = (await coin.inspectSafetyRegistrationsFromFile(dbPath)).registrations.welcome.value;
    if (step[1] === directoryName) assert.equal(JSON.parse(inFile).step, label);
    else assert.equal(inFile, original, label);
    assert.equal(fs.existsSync(`${dbPath}.tmp`), false, label);
  }
  assert.deepEqual(coin.getLedgerEscalations(), []);
});

test('a temporary file left by an earlier crash is overwritten by the next write and never left behind', async (t) => {
  const { root, dbPath } = await freshCoinDatabase(t, 'leftover');
  fs.writeFileSync(`${dbPath}.tmp`, 'half a database from a crash');
  await coin.withCoinTransaction((api) => insertMarker(api, 'after-crash'));
  assert.deepEqual(fs.readdirSync(root), ['xiaoji.sqlite']);
  assert.equal(await fileMetadata(dbPath, 'after-crash'), '1');
  await assertFileMatchesMemory(dbPath);
  // The same at a start: the write-back replaces a leftover beside the database.
  coin.resetCoinDatabaseForTests();
  fs.writeFileSync(`${dbPath}.tmp`, 'another leftover');
  await coin.initializeCoinDatabase();
  assert.deepEqual(fs.readdirSync(root), ['xiaoji.sqlite']);
  assert.equal(await fileMetadata(dbPath, 'after-crash'), '1');
  await assertFileMatchesMemory(dbPath);
});

test('repeated directory sync failures are logged and escalated once', async (t) => {
  const { dbPath, directoryName } = await freshCoinDatabase(t, 'repeated');
  const logs = captureCoinDatabaseLogs(t);
  for (let index = 0; index < 3; index += 1) await failOneDirectorySync(dbPath, directoryName, `repeat-${index}`);
  assert.deepEqual(logs, [
    '[COIN_DB] code=COIN_DB_DIRECTORY_SYNC_FAILED stage=runtime errno=EIO',
    '[COIN_DB] code=COIN_DB_ESCALATION cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=runtime',
  ]);
  assert.deepEqual(coin.getLedgerEscalations().map((entry) => entry.stage), ['runtime']);
  for (let index = 0; index < 3; index += 1) assert.equal(await fileMetadata(dbPath, `repeat-${index}`), '1');
});

test('init-coin-db ends with exit code 3 when the directory sync of the new database failed', (t) => {
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

  const failingPath = path.join(root, 'failing', 'xiaoji.sqlite');
  const failing = run(failingPath, true);
  assert.equal(failing.status, 3, failing.stderr);
  assert.match(failing.stdout, /吉幣資料庫已初次建立/u);
  assert.match(failing.stderr,
    /^\[SIDE_EFFECT_LEDGER\] code=LEDGER_ESCALATION purpose=coin-database cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=open$/mu);
  assert.ok(fs.existsSync(failingPath));
});
