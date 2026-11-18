'use strict';

// The safety ledger registrations and safety alert stamps in coin_metadata: every write is a
// compare-and-set whose read, comparison and write run in one BEGIN IMMEDIATE transaction, and
// its COMMIT is the durable write. A conflict or a failed write leaves nothing behind.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const coin = require('../src/systems/economy/storage/coinDatabase');

const COIN_MODULE = path.join(__dirname, '..', 'src', 'systems', 'economy', 'storage', 'coinDatabase.js');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// The database file and its -wal, byte for byte (null when there is no -wal).
function filesState(dbPath) {
  return {
    main: sha256File(dbPath),
    wal: fs.existsSync(`${dbPath}-wal`) ? sha256File(`${dbPath}-wal`) : null,
  };
}

async function freshCoinDatabase(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `xiaoji-coin-registration-${prefix}-`)));
  const previous = process.env.COIN_DB_PATH;
  process.env.COIN_DB_PATH = path.join(root, 'xiaoji.sqlite');
  coin.resetCoinDatabaseForTests();
  t.after(() => {
    coin.resetCoinDatabaseForTests();
    if (previous === undefined) delete process.env.COIN_DB_PATH;
    else process.env.COIN_DB_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  await coin.initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  return { root, dbPath: process.env.COIN_DB_PATH };
}

// What the next start would read: a copy of the file and its -wal, opened on its own.
function nextStartValue(dbPath, key) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-coin-registration-next-'));
  try {
    const copy = path.join(folder, 'copy.sqlite');
    fs.copyFileSync(dbPath, copy);
    if (fs.existsSync(`${dbPath}-wal`)) fs.copyFileSync(`${dbPath}-wal`, `${copy}-wal`);
    const db = new DatabaseSync(copy);
    try {
      return db.prepare('SELECT value FROM coin_metadata WHERE key = ?').get(key)?.value ?? null;
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

// A trigger on this connection only (TEMP: never in the file) that makes the upsert of one key fail.
async function failWritesOf(key) {
  await coin.withCoinDatabase((api) => api.run(`CREATE TEMP TRIGGER synthetic_write_failure
    BEFORE INSERT ON main.coin_metadata WHEN NEW.key = '${key}'
    BEGIN SELECT RAISE(ABORT, 'synthetic write failure'); END`));
  return () => coin.withCoinDatabase((api) => api.run('DROP TRIGGER temp.synthetic_write_failure'));
}

// Records every call a durable write makes, without touching the disk.
function recordingFileSystem({ renameFailures = [] } = {}) {
  const calls = [];
  let nextDescriptor = 100;
  const descriptors = new Map();
  const failures = [...renameFailures];
  return {
    calls,
    openSync(target, flags) {
      const descriptor = nextDescriptor;
      nextDescriptor += 1;
      descriptors.set(descriptor, path.basename(target));
      calls.push(['open', path.basename(target), flags]);
      return descriptor;
    },
    writeSync(descriptor, buffer, offset, length) {
      calls.push(['write', descriptors.get(descriptor)]);
      return length;
    },
    fsyncSync(descriptor) { calls.push(['fsync', descriptors.get(descriptor)]); },
    closeSync(descriptor) { calls.push(['close', descriptors.get(descriptor)]); },
    renameSync(from, to) {
      calls.push(['rename', path.basename(from), path.basename(to)]);
      const failure = failures.shift();
      if (failure) throw Object.assign(new Error(failure), { code: failure });
    },
    existsSync() { return false; },
    unlinkSync(target) { calls.push(['unlink', path.basename(target)]); },
  };
}

test('safety ledger registrations live in coin_metadata and are written only by compare-and-set', async (t) => {
  const { dbPath } = await freshCoinDatabase(t, 'cas');
  assert.deepEqual(await coin.readSafetyLedgerRegistrations(), {});
  const welcome = JSON.stringify({ state: 'creating', n: 1 });
  const chain = JSON.stringify({ state: 'creating', n: 2 });
  const written = await coin.writeSafetyLedgerRegistrations([
    { purposeId: 'welcome', expectedValue: null, value: welcome },
    { purposeId: 'word-chain.reaction', expectedValue: null, value: chain },
  ]);
  assert.equal(written.written, 2);
  let registrations = await coin.readSafetyLedgerRegistrations();
  assert.deepEqual(Object.keys(registrations), ['welcome', 'word-chain.reaction']);
  assert.equal(registrations.welcome.value, welcome);
  assert.equal(registrations.welcome.updatedAt, written.updatedAt);
  assert.match(registrations.welcome.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);

  // A stale expectation writes nothing at all, not even the other update in the batch.
  const before = filesState(dbPath);
  await assert.rejects(coin.writeSafetyLedgerRegistrations([
    { purposeId: 'word-chain.reaction', expectedValue: chain, value: JSON.stringify({ state: 'active' }) },
    { purposeId: 'welcome', expectedValue: null, value: JSON.stringify({ state: 'active' }) },
  ]), (error) => error.code === 'SAFETY_REGISTRATION_CONFLICT');
  assert.deepEqual(filesState(dbPath), before);
  registrations = await coin.readSafetyLedgerRegistrations();
  assert.equal(registrations.welcome.value, welcome);
  assert.equal(registrations['word-chain.reaction'].value, chain);
  assert.equal(await coin.withCoinDatabase((api) => api.db.isTransaction), false);

  for (const updates of [
    [],
    [{ purposeId: 'welcome', expectedValue: welcome, value: 'x'.repeat(4_097) }],
    [{ purposeId: 'has space', expectedValue: null, value: '{}' }],
    [{ purposeId: 'welcome', expectedValue: welcome, value: '{}' }, { purposeId: 'welcome', expectedValue: welcome, value: '{}' }],
    [{ purposeId: 'welcome', expectedValue: 7, value: '{}' }],
  ]) {
    await assert.rejects(coin.writeSafetyLedgerRegistrations(updates), (error) => error.code === 'SAFETY_REGISTRATION_INVALID');
  }
  assert.deepEqual(filesState(dbPath), before);
  // After a clean stop the file alone holds exactly that, and the schema did not move.
  await coin.closeCoinDatabase();
  const inspected = await coin.inspectSafetyRegistrationsFromFile(dbPath);
  assert.equal(inspected.schemaVersion, 24);
  assert.equal(inspected.registrations.welcome.value, welcome);
  assert.equal(inspected.registrations['word-chain.reaction'].value, chain);
});

test('two writes that both expect the value they read: the first wins, the second is a conflict', async (t) => {
  await freshCoinDatabase(t, 'race');
  const [first, second] = await Promise.allSettled([
    coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: '{"by":"first"}' }]),
    coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: '{"by":"second"}' }]),
  ]);
  assert.equal(first.status, 'fulfilled');
  assert.equal(second.status, 'rejected');
  assert.equal(second.reason.code, 'SAFETY_REGISTRATION_CONFLICT');
  assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, '{"by":"first"}');
});

test('a registration write is on disk when it returns, and survives a crash right after it', async (t) => {
  const { dbPath } = await freshCoinDatabase(t, 'durable');
  await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: '{"n":1}' }]);
  assert.equal(nextStartValue(dbPath, 'safety_ledger:welcome'), '{"n":1}');

  coin.resetCoinDatabaseForTests();
  const crashed = spawnSync(process.execPath, ['-e', `
    const coin = require(process.argv[1]);
    coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: '{"n":1}', value: '{"n":2}' }])
      .then(() => coin.writeSafetyAlertStamp('owner-emergency', { value: '{"schema":1}', expectedValue: null }))
      .then(() => process.kill(process.pid, 'SIGKILL'));
  `, COIN_MODULE], { env: { ...process.env, COIN_DB_PATH: dbPath }, encoding: 'utf8', cwd: os.tmpdir() });
  assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
  assert.equal(fs.existsSync(`${dbPath}-wal`), true);
  await coin.initializeCoinDatabase();
  assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, '{"n":2}');
  assert.equal((await coin.readSafetyAlertStamp('owner-emergency')).value, '{"schema":1}');
});

test('a registration write that fails inside its transaction writes nothing, not even the rest of its batch',
  async (t) => {
    const { dbPath } = await freshCoinDatabase(t, 'write-fails');
    const original = JSON.stringify({ state: 'creating' });
    await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: original }]);
    const before = filesState(dbPath);
    const restore = await failWritesOf('safety_ledger:word-chain.reaction');
    await assert.rejects(coin.writeSafetyLedgerRegistrations([
      { purposeId: 'welcome', expectedValue: original, value: JSON.stringify({ state: 'active' }) },
      { purposeId: 'word-chain.reaction', expectedValue: null, value: JSON.stringify({ state: 'creating' }) },
    ]), (error) => error.code === 'SAFETY_REGISTRATION_WRITE_FAILED' && error.message === '安全帳本登記寫入失敗。' &&
      /synthetic write failure/u.test(error.cause?.message));
    assert.deepEqual(filesState(dbPath), before);
    assert.deepEqual(Object.keys(await coin.readSafetyLedgerRegistrations()), ['welcome']);
    assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, original);
    assert.equal(await coin.withCoinDatabase((api) => api.db.isTransaction), false);
    // The database keeps working and the next write starts from the old value.
    await restore();
    await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: original, value: '{"state":"active"}' }]);
    assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, '{"state":"active"}');
    assert.equal(nextStartValue(dbPath, 'safety_ledger:welcome'), '{"state":"active"}');
  });

test('a durable whole-file write fsyncs the temporary file, renames it, then flushes the directory (POSIX order)', async () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sample (value TEXT)');
  try {
    const target = path.join(os.tmpdir(), 'xiaoji-order', 'xiaoji.sqlite');
    const posix = recordingFileSystem();
    const written = await coin.writeDatabaseFileDurably(target, db, { filesystem: posix, platform: 'linux' });
    assert.ok(written.subarray(0, 16).equals(Buffer.from('SQLite format 3\0', 'binary')));
    assert.deepEqual(posix.calls.filter(([kind]) => kind !== 'write'), [
      ['open', 'xiaoji.sqlite.tmp', 'w'],
      ['fsync', 'xiaoji.sqlite.tmp'],
      ['close', 'xiaoji.sqlite.tmp'],
      ['rename', 'xiaoji.sqlite.tmp', 'xiaoji.sqlite'],
      ['open', 'xiaoji-order', 'r'],
      ['fsync', 'xiaoji-order'],
      ['close', 'xiaoji-order'],
    ]);
    assert.ok(posix.calls.some(([kind]) => kind === 'write'));

    // Windows cannot flush a directory: the renamed file is flushed instead, and a
    // scanner's transient EPERM/EBUSY on the rename is retried without blocking.
    const windows = recordingFileSystem({ renameFailures: ['EPERM', 'EBUSY'] });
    const slept = [];
    await coin.writeDatabaseFileDurably(target, db, { filesystem: windows, platform: 'win32',
      sleep: async (ms) => { slept.push(ms); } });
    assert.deepEqual(windows.calls.filter(([kind]) => kind !== 'write'), [
      ['open', 'xiaoji.sqlite.tmp', 'w'],
      ['fsync', 'xiaoji.sqlite.tmp'],
      ['close', 'xiaoji.sqlite.tmp'],
      ['rename', 'xiaoji.sqlite.tmp', 'xiaoji.sqlite'],
      ['rename', 'xiaoji.sqlite.tmp', 'xiaoji.sqlite'],
      ['rename', 'xiaoji.sqlite.tmp', 'xiaoji.sqlite'],
      ['open', 'xiaoji.sqlite', 'r+'],
      ['fsync', 'xiaoji.sqlite'],
      ['close', 'xiaoji.sqlite'],
    ]);
    assert.deepEqual(slept, [25, 50]);
    // On POSIX the same codes are real permission errors and are not retried.
    const denied = recordingFileSystem({ renameFailures: ['EACCES'] });
    await assert.rejects(coin.writeDatabaseFileDurably(target, db, { filesystem: denied, platform: 'linux' }),
      (error) => error.code === 'EACCES');
    assert.equal(denied.calls.filter(([kind]) => kind === 'rename').length, 1);
  } finally {
    db.close();
  }
});

test('the read-only registration inspection never writes the coin database file and creates nothing beside it',
  async (t) => {
    const { root, dbPath } = await freshCoinDatabase(t, 'inspect');
    await coin.writeSafetyLedgerRegistrations([{ purposeId: 'audit.guild.leave', expectedValue: null, value: '{"a":1}' }]);
    // While the bot holds the database the file alone is not the whole of it: refused.
    await assert.rejects(coin.inspectSafetyRegistrationsFromFile(dbPath), /請先正常停止/u);
    await coin.closeCoinDatabase();
    const stat = fs.statSync(dbPath);
    const before = sha256File(dbPath);
    const inspected = await coin.inspectSafetyRegistrationsFromFile(dbPath);
    assert.equal(inspected.sha256, before);
    assert.deepEqual(Object.keys(inspected.registrations), ['audit.guild.leave']);
    assert.equal(sha256File(dbPath), before);
    assert.equal(fs.statSync(dbPath).mtimeMs, stat.mtimeMs);
    assert.deepEqual(fs.readdirSync(root), ['xiaoji.sqlite']);
    await assert.rejects(coin.inspectSafetyRegistrationsFromFile('relative.sqlite'), /絕對路徑/u);
    const notDatabase = `${dbPath}.txt`;
    fs.writeFileSync(notDatabase, 'not sqlite'.repeat(20));
    await assert.rejects(coin.inspectSafetyRegistrationsFromFile(notDatabase), /SQLite/u);
  });

test('safety alert stamps are compare-and-set, durable, and kept apart from the registrations', async (t) => {
  const { root, dbPath } = await freshCoinDatabase(t, 'alert-stamp');
  const first = JSON.stringify({ schema: 1, sentAtMs: 1 });
  assert.equal(await coin.readSafetyAlertStamp('owner-emergency'), null);
  await coin.writeSafetyAlertStamp('owner-emergency', { value: first, expectedValue: null });
  assert.equal((await coin.readSafetyAlertStamp('owner-emergency')).value, first);
  assert.equal(nextStartValue(dbPath, 'safety_alert:owner-emergency'), first);
  // A value written by someone else since the read is never overwritten.
  const before = filesState(dbPath);
  await assert.rejects(coin.writeSafetyAlertStamp('owner-emergency', { value: '{"schema":1,"sentAtMs":2}', expectedValue: null }),
    (error) => error.code === 'SAFETY_ALERT_CONFLICT');
  assert.deepEqual(filesState(dbPath), before);
  // It is not a registration.
  assert.deepEqual(await coin.readSafetyLedgerRegistrations(), {});
  // A new process reads it back from the file.
  coin.resetCoinDatabaseForTests();
  await coin.initializeCoinDatabase();
  assert.equal((await coin.readSafetyAlertStamp('owner-emergency')).value, first);
  // Names and values are checked before anything is read or written.
  for (const name of ['', 'Owner', 'owner emergency', 'x'.repeat(65), 'safety_ledger:welcome', null]) {
    await assert.rejects(coin.readSafetyAlertStamp(name), (error) => error.code === 'SAFETY_ALERT_INVALID', String(name));
  }
  for (const value of ['', null, 'x'.repeat(1_025)]) {
    await assert.rejects(coin.writeSafetyAlertStamp('owner-emergency', { value, expectedValue: first }),
      (error) => error.code === 'SAFETY_ALERT_INVALID');
  }
  // A write that fails inside its transaction writes nothing.
  const unchanged = filesState(dbPath);
  const restore = await failWritesOf('safety_alert:owner-emergency');
  await assert.rejects(coin.writeSafetyAlertStamp('owner-emergency', { value: '{"schema":1,"sentAtMs":3}', expectedValue: first }),
    (error) => error.code === 'SAFETY_ALERT_WRITE_FAILED' && /synthetic write failure/u.test(error.cause?.message));
  await restore();
  assert.deepEqual(filesState(dbPath), unchanged);
  assert.equal((await coin.readSafetyAlertStamp('owner-emergency')).value, first);
  await coin.closeCoinDatabase();
  assert.deepEqual((await coin.inspectSafetyRegistrationsFromFile(dbPath)).registrations, {});
  assert.deepEqual(fs.readdirSync(root).sort(), ['xiaoji.sqlite']);
});
