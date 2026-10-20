'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const coin = require('../src/services/coinDatabase');

const COIN_MODULE = path.join(__dirname, '..', 'src', 'services', 'coinDatabase.js');

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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

// Records every call a durable write makes, without touching the disk.
function recordingFileSystem({ fsyncFailure = null, renameFailures = [] } = {}) {
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
    fsyncSync(descriptor) {
      calls.push(['fsync', descriptors.get(descriptor)]);
      if (fsyncFailure && descriptors.get(descriptor) === fsyncFailure) throw Object.assign(new Error('EIO'), { code: 'EIO' });
    },
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
  assert.match(registrations.welcome.updatedAt, /^\d{4}-\d{2}-\d{2}T/u);

  // A stale expectation writes nothing at all, not even the other update in the batch.
  const before = sha256File(dbPath);
  await assert.rejects(coin.writeSafetyLedgerRegistrations([
    { purposeId: 'welcome', expectedValue: welcome, value: JSON.stringify({ state: 'active' }) },
    { purposeId: 'word-chain.reaction', expectedValue: null, value: JSON.stringify({ state: 'active' }) },
  ]), (error) => error.code === 'SAFETY_REGISTRATION_CONFLICT');
  assert.equal(sha256File(dbPath), before);
  registrations = await coin.readSafetyLedgerRegistrations();
  assert.equal(registrations.welcome.value, welcome);
  assert.equal(registrations['word-chain.reaction'].value, chain);

  for (const updates of [
    [],
    [{ purposeId: 'welcome', expectedValue: welcome, value: 'x'.repeat(4_097) }],
    [{ purposeId: 'has space', expectedValue: null, value: '{}' }],
    [{ purposeId: 'welcome', expectedValue: welcome, value: '{}' }, { purposeId: 'welcome', expectedValue: welcome, value: '{}' }],
    [{ purposeId: 'welcome', expectedValue: 7, value: '{}' }],
  ]) {
    await assert.rejects(coin.writeSafetyLedgerRegistrations(updates), (error) => error.code === 'SAFETY_REGISTRATION_INVALID');
  }
  assert.equal(sha256File(dbPath), before);
  // The file on disk holds exactly what memory holds, and the schema did not move.
  const inspected = await coin.inspectSafetyRegistrationsFromFile(dbPath);
  assert.equal(inspected.schemaVersion, 24);
  assert.equal(inspected.registrations.welcome.value, welcome);
});

test('a durable write fsyncs the temporary file, renames it, then flushes the directory (POSIX order)', async () => {
  const SQL = await require('sql.js')({ locateFile: (name) => path.join(path.dirname(require.resolve('sql.js')), name) });
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  db.run('CREATE TABLE sample (value TEXT)');
  try {
    const target = path.join(os.tmpdir(), 'xiaoji-order', 'xiaoji.sqlite');
    const posix = recordingFileSystem();
    await coin.writeDatabaseFileDurably(target, db, { filesystem: posix, platform: 'linux' });
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

test('a registration write failing before the rename restores memory and leaves the file untouched', async (t) => {
  const { root, dbPath } = await freshCoinDatabase(t, 'restore');
  const original = JSON.stringify({ state: 'creating' });
  await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: original }]);
  const before = sha256File(dbPath);
  const failing = {
    ...fs,
    fsyncSync: () => { throw Object.assign(new Error('synthetic fsync failure'), { code: 'EIO' }); },
  };
  await assert.rejects(coin.writeSafetyLedgerRegistrations([
    { purposeId: 'welcome', expectedValue: original, value: JSON.stringify({ state: 'active' }) },
  ], { filesystem: failing }), (error) => error.code === 'SAFETY_REGISTRATION_WRITE_FAILED' &&
    /synthetic fsync failure/u.test(error.cause?.message));
  assert.equal(sha256File(dbPath), before);
  assert.equal(fs.existsSync(`${dbPath}.tmp`), false);
  assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, original);
  // The restored database keeps working and the next write starts from the old value.
  await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: original, value: '{"state":"active"}' }]);
  assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, '{"state":"active"}');
  assert.deepEqual(fs.readdirSync(root).sort(), ['xiaoji.sqlite']);
});

test('a registration write failing after the rename leaves the file one write ahead of memory, then converges',
  async (t) => {
    const { dbPath } = await freshCoinDatabase(t, 'after-rename');
    const original = JSON.stringify({ state: 'creating' });
    const next = JSON.stringify({ state: 'active' });
    await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: original }]);
    // POSIX order on any platform: the temporary file, its fsync, and the rename succeed;
    // only the directory flush fails.
    const directoryDescriptor = -42;
    const failingDirectory = {
      ...fs,
      openSync: (target, flags, ...rest) => (path.resolve(String(target)) === path.dirname(dbPath) && flags === 'r'
        ? directoryDescriptor : fs.openSync(target, flags, ...rest)),
      fsyncSync: (descriptor) => {
        if (descriptor === directoryDescriptor) throw Object.assign(new Error('synthetic directory fsync failure'), { code: 'EIO' });
        return fs.fsyncSync(descriptor);
      },
      closeSync: (descriptor) => (descriptor === directoryDescriptor ? undefined : fs.closeSync(descriptor)),
    };
    await assert.rejects(coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: original, value: next }],
      { filesystem: failingDirectory, platform: 'linux' }), (error) => error.code === 'SAFETY_REGISTRATION_WRITE_FAILED' &&
      /synthetic directory fsync failure/u.test(error.cause?.message));
    // The caller was told the write failed and memory holds the old value, while the file
    // already holds the new one.
    assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, original);
    assert.equal((await coin.inspectSafetyRegistrationsFromFile(dbPath)).registrations.welcome.value, next);
    assert.equal(fs.existsSync(`${dbPath}.tmp`), false);
    // Without a restart, the next write compares against memory and brings both together.
    const third = JSON.stringify({ state: 'active', n: 3 });
    await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: original, value: third }]);
    assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, third);
    assert.equal((await coin.inspectSafetyRegistrationsFromFile(dbPath)).registrations.welcome.value, third);
    // The same failure followed by a restart: the restarted process reads the newer value.
    const fourth = JSON.stringify({ state: 'active', n: 4 });
    await assert.rejects(coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: third, value: fourth }],
      { filesystem: failingDirectory, platform: 'linux' }), (error) => error.code === 'SAFETY_REGISTRATION_WRITE_FAILED');
    assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, third);
    coin.resetCoinDatabaseForTests();
    await coin.initializeCoinDatabase();
    assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, fourth);
  });

test('the file-system hook of registration writes is refused outside the Node test runner', () => {
  const script = `
    const coin = require(process.argv[1]);
    coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: '{}' }],
      { filesystem: require('node:fs') }).then(() => process.stdout.write('accepted'),
      (error) => process.stdout.write(String(error.code)));
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.COIN_DB_PATH;
  const result = spawnSync(process.execPath, ['-e', script, COIN_MODULE], { env, encoding: 'utf8',
    cwd: os.tmpdir() });
  assert.equal(result.stdout, 'SAFETY_REGISTRATION_INVALID', result.stderr);
});

test('the read-only registration inspection never writes the coin database file', async (t) => {
  const { dbPath } = await freshCoinDatabase(t, 'inspect');
  await coin.writeSafetyLedgerRegistrations([{ purposeId: 'audit.guild.leave', expectedValue: null, value: '{"a":1}' }]);
  const stat = fs.statSync(dbPath);
  const before = sha256File(dbPath);
  const inspected = await coin.inspectSafetyRegistrationsFromFile(dbPath);
  assert.equal(inspected.sha256, before);
  assert.deepEqual(Object.keys(inspected.registrations), ['audit.guild.leave']);
  assert.equal(sha256File(dbPath), before);
  assert.equal(fs.statSync(dbPath).mtimeMs, stat.mtimeMs);
  await assert.rejects(coin.inspectSafetyRegistrationsFromFile('relative.sqlite'), /絕對路徑/u);
  const notDatabase = `${dbPath}.txt`;
  fs.writeFileSync(notDatabase, 'not sqlite'.repeat(20));
  await assert.rejects(coin.inspectSafetyRegistrationsFromFile(notDatabase), /SQLite/u);
});

test('ordinary coin database writes are durable as well, and one that changes nothing syncs nothing', async (t) => {
  await freshCoinDatabase(t, 'ordinary');
  let fsyncCalls = 0;
  const original = fs.fsyncSync;
  fs.fsyncSync = (...args) => {
    fsyncCalls += 1;
    return original(...args);
  };
  try {
    await coin.withCoinTransaction((api) => {
      api.run("INSERT INTO coin_metadata (key, value, updated_at) VALUES ('synthetic_marker', '1', '2026-10-03T00:00:00.000Z')");
    });
    assert.ok(fsyncCalls >= 1);
    const afterOrdinary = fsyncCalls;
    await coin.withCoinTransaction((api) => api.get('SELECT 1 AS one'));
    assert.equal(fsyncCalls, afterOrdinary);
    await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: null, value: '{}' }]);
    assert.ok(fsyncCalls > afterOrdinary);
  } finally {
    fs.fsyncSync = original;
  }
});

test('safety alert stamps are compare-and-set, durable, and kept apart from the registrations', async (t) => {
  const { root, dbPath } = await freshCoinDatabase(t, 'alert-stamp');
  const first = JSON.stringify({ schema: 1, sentAtMs: 1 });
  assert.equal(await coin.readSafetyAlertStamp('owner-emergency'), null);
  await coin.writeSafetyAlertStamp('owner-emergency', { value: first, expectedValue: null });
  assert.equal((await coin.readSafetyAlertStamp('owner-emergency')).value, first);
  // A value written by someone else since the read is never overwritten.
  await assert.rejects(coin.writeSafetyAlertStamp('owner-emergency', { value: '{"schema":1,"sentAtMs":2}', expectedValue: null }),
    (error) => error.code === 'SAFETY_ALERT_CONFLICT');
  // It is not a registration, in memory or in the file.
  assert.deepEqual(await coin.readSafetyLedgerRegistrations(), {});
  assert.deepEqual((await coin.inspectSafetyRegistrationsFromFile(dbPath)).registrations, {});
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
  // A write failing before the rename restores memory and leaves the file untouched.
  const before = sha256File(dbPath);
  const failing = {
    ...fs,
    fsyncSync: () => { throw Object.assign(new Error('synthetic fsync failure'), { code: 'EIO' }); },
  };
  await assert.rejects(coin.writeSafetyAlertStamp('owner-emergency',
    { value: '{"schema":1,"sentAtMs":3}', expectedValue: first }, { filesystem: failing }),
  (error) => error.code === 'SAFETY_ALERT_WRITE_FAILED' && /synthetic fsync failure/u.test(error.cause?.message));
  assert.equal(sha256File(dbPath), before);
  assert.equal(fs.existsSync(`${dbPath}.tmp`), false);
  assert.equal((await coin.readSafetyAlertStamp('owner-emergency')).value, first);
  assert.deepEqual(fs.readdirSync(root).sort(), ['xiaoji.sqlite']);
});
