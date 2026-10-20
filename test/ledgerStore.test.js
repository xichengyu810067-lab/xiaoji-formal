'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const {
  ACCELERATED_RETENTION_MS,
  CAPACITY_RELIEF_INTERVAL_MS,
  DURABILITY_UNSAFE_NO_SYNC,
  RETENTION_MS,
  SCHEMA_VERSION,
  STATEMENT_SQL,
  WITNESS_SLOT_BYTES,
  createLedgerStore,
  inspectLedgerStore,
  openLedgerStore,
  readWitness,
  renameWithRetry,
  witnessIdentityDigest,
} = require('../src/systems/safety/ledgerStore');
const {
  PREPARE_RETRY_AFTER_MS,
  initializePublicPurposeLedger,
  initializeSideEffectLedger,
  openPublicPurposeLedger,
  openSideEffectLedger,
  pathsFor,
} = require('../src/systems/safety/sideEffectLedger');

const BOT_ID = '10000000000000001';
const OWNER_ID = '10000000000000002';
const GUILD_ID = '10000000000000003';
const CHANNEL_ID = '10000000000000004';
const PURPOSE = 'synthetic.purpose';
const DAY_MS = 24 * 60 * 60 * 1_000;
const HOLDER = path.join(__dirname, 'fixtures', 'ledgerStoreHolder.js');
const CHILD = path.join(__dirname, 'fixtures', 'ledgerBootstrapChild.js');
const QUARANTINE_HOLDER = path.join(__dirname, 'fixtures', 'ledgerQuarantineHolder.js');
const STORE_MODULE = path.join(__dirname, '..', 'src', 'systems', 'safety', 'ledgerStore.js');
const FACADE_MODULE = path.join(__dirname, '..', 'src', 'systems', 'safety', 'sideEffectLedger.js');

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Temporary root resolved to its real path (macOS tmpdir is behind /var -> /private/var).
// Deferred cleanups run newest-first before the root is removed.
function workspace(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `xiaoji-ledger-store-${prefix}-`)));
  const cleanups = [];
  t.after(() => {
    while (cleanups.length) {
      try { cleanups.pop()(); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { root, defer: (cleanup) => cleanups.push(cleanup) };
}

function layout(root, name = 'ledger') {
  const ledgerDirectory = path.join(root, `${name}-ledger`);
  const witnessDirectory = path.join(root, `${name}-witness`);
  fs.mkdirSync(ledgerDirectory);
  fs.mkdirSync(witnessDirectory);
  return {
    filePath: path.join(ledgerDirectory, 'ledger.sqlite'),
    witnessPath: path.join(witnessDirectory, 'ledger.witness'),
  };
}

function createStore(paths, { kind = 'public', cutoverMs = 0, genesisMs = 1_000, durability, ledgerId } = {}) {
  return createLedgerStore({
    filePath: paths.filePath,
    witnessPaths: [paths.witnessPath],
    kind,
    ledgerId: ledgerId || 'synthetic-ledger',
    botId: BOT_ID,
    ownerId: kind === 'owner' ? OWNER_ID : null,
    runtimeMode: 'production',
    genesisMs,
    cutoverMs,
    durability,
  });
}

function openStore(paths, { kind = 'public', clock, ...options } = {}) {
  return openLedgerStore({
    filePath: paths.filePath,
    witnessPaths: [paths.witnessPath],
    kind,
    expected: { botId: BOT_ID, ownerId: kind === 'owner' ? OWNER_ID : undefined, runtimeMode: 'production' },
    now: clock ? () => clock.value : undefined,
    ...options,
  });
}

// Copies of a closed ledger: the database file (no WAL exists after a clean close) and
// its witness, so tests can restore either one to an earlier point in time.
function snapshot(paths) {
  return { database: fs.readFileSync(paths.filePath), witness: fs.readFileSync(paths.witnessPath) };
}

function restore(paths, { database, witness }) {
  if (database) fs.writeFileSync(paths.filePath, database);
  if (witness) fs.writeFileSync(paths.witnessPath, witness);
}

function beginInput(index, { binding = {}, ...overrides } = {}) {
  const bindingJson = JSON.stringify({ operationId: `operation-${index}`, synthetic: index, ...binding });
  return {
    purposeId: PURPOSE,
    operationId: `operation-${index}`,
    sourceKey: `source:${index % 50}`,
    sourceTimeMs: null,
    bindingJson,
    bindingDigest: sha256(bindingJson),
    generation: 1,
    target: 'synthetic-target',
    mergeKey: `merge-${index}`,
    mergeWindowUntilMs: null,
    budgetCharged: false,
    budgetReservedAtMs: null,
    claimedAtMs: 1_000,
    ...overrides,
  };
}

function finishInput(index, overrides = {}) {
  return {
    purposeId: PURPOSE,
    operationId: `operation-${index}`,
    generation: 1,
    state: 'confirmed',
    resultCode: 'synthetic_confirmed',
    resultJson: null,
    ...overrides,
  };
}

function waitForLine(child, pattern, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`child did not report ${pattern}: ${output}`)), timeoutMs);
    child.stdout.on('data', (chunk) => {
      output += chunk;
      const match = pattern.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match);
      } else if (output.includes('ERROR')) {
        clearTimeout(timer);
        reject(new Error(`child failed: ${output.trim()}`));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited early with ${code}: ${output}`));
    });
  });
}

function capturingLogger() {
  const lines = [];
  return {
    lines,
    info: (message) => lines.push(['info', message]),
    warn: (message) => lines.push(['warn', message]),
    error: (message) => lines.push(['error', message]),
  };
}

// Write evidence that a call did not touch the ledger: commit and row-change counters,
// database and WAL size/mtime (stat only, so no descriptor disturbs SQLite's POSIX locks),
// and the witness bytes.
function writeFootprint(ledger, locations, witnessPaths) {
  const stats = ledger.getStoreStatsForTests();
  const fileState = (filePath) => {
    try {
      const stat = fs.statSync(filePath);
      return `${stat.size}:${stat.mtimeMs}`;
    } catch {
      return 'absent';
    }
  };
  return {
    commits: stats.commits,
    totalChanges: stats.totalChanges,
    beginSeq: stats.beginSeq,
    database: fileState(locations.ledgerPath),
    wal: fileState(locations.walPath),
    witnesses: witnessPaths.map((witnessPath) => sha256(fs.readFileSync(witnessPath))),
  };
}

function directConnection(filePath, options = {}) {
  const db = new DatabaseSync(filePath, options);
  // Match the store so no shared-memory index is created beside the ledger.
  db.exec('PRAGMA locking_mode = EXCLUSIVE');
  db.prepare('PRAGMA journal_mode = WAL').get();
  return db;
}

// A word-chain reaction ledger opened through the legacy facade.
function reactionLedger(root, name) {
  const paths = layout(root, name);
  const clock = { value: 2_000_000 };
  const initialized = initializePublicPurposeLedger({
    filePath: paths.filePath,
    continuityWitnessPath: paths.witnessPath,
    ledgerId: `word-chain-${name}`,
    initializationId: `synthetic-${name}`,
    purposeIdentity: { purposeId: 'word-chain.reaction', botId: BOT_ID, sourceNamespace: 'discord.messageCreate',
      cutoverSourceTimestampMs: 1_000_000, freshSourceProofDigest: sha256(`fresh-${name}`) },
    now: () => clock.value,
  });
  const open = (options = {}) => openPublicPurposeLedger({
    filePath: paths.filePath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedPurposeIdentity: { purposeId: 'word-chain.reaction', botId: BOT_ID, sourceNamespace: 'discord.messageCreate' },
    now: () => clock.value,
    ...options,
  });
  return { paths, initialized, open, marker: pathsFor(paths.filePath).retainedLockPath };
}

test('a format-2 ledger is one SQLite file with WAL, FULL sync, an exclusive lock, and no lock file', (t) => {
  const { root, defer } = workspace(t, 'format');
  const paths = layout(root);
  const created = createStore(paths);
  assert.equal(created.identity.kind, 'public');
  assert.deepEqual(fs.readdirSync(path.dirname(paths.filePath)), ['ledger.sqlite']);
  const store = openStore(paths);
  defer(() => store.close());
  assert.deepEqual(store.describeConnection(), {
    journalMode: 'wal',
    synchronous: 2,
    lockingMode: 'exclusive',
    recursiveTriggers: true,
    schemaWritesLocked: true,
  });
  assert.equal(store.identity.format, 2);
  assert.equal(store.identity.bootEpoch, 1);
  assert.equal(fs.existsSync(`${paths.filePath}-shm`), false);
  assert.throws(() => openStore(paths), (error) => error.code === 'LEDGER_IN_USE' && error.retryable === true);
  // The refused in-process open must not have released the lock (on POSIX, closing any
  // descriptor of the file would): another process is still turned away.
  const probe = spawnSync(process.execPath, ['-e', [
    'const [storeModule, filePath, witnessPath, botId] = process.argv.slice(1);',
    'try {',
    "  require(storeModule).openLedgerStore({ filePath, witnessPaths: [witnessPath], kind: 'public',",
    "    expected: { botId, runtimeMode: 'production' } }).close();",
    "  process.stdout.write('OPENED');",
    '} catch (error) { process.stdout.write(String(error.code)); }',
  ].join('\n'), STORE_MODULE, paths.filePath, paths.witnessPath, BOT_ID], { encoding: 'utf8' });
  assert.equal(probe.stdout, 'LEDGER_IN_USE', probe.stderr);
  store.close();
  assert.equal(fs.existsSync(`${paths.filePath}-wal`), false);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.filePath)), ['ledger.sqlite']);
});

test('a second process gets LEDGER_IN_USE, and a force-killed holder releases the ledger within 5 seconds',
  async (t) => {
    const { root, defer } = workspace(t, 'holder');
    const paths = layout(root);
    createStore(paths);
    const child = spawn(process.execPath, [HOLDER, paths.filePath, paths.witnessPath, 'begin'],
      { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise((resolve) => child.once('exit', resolve));
    defer(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
    await waitForLine(child, /READY/u);

    assert.throws(() => openStore(paths), (error) => error.code === 'LEDGER_IN_USE' && error.retryable === true);

    const killedAt = Date.now();
    child.kill('SIGKILL');
    let store = null;
    let lastError = null;
    while (!store && Date.now() - killedAt < 5_000) {
      try {
        store = openStore(paths);
      } catch (error) {
        if (error.code !== 'LEDGER_IN_USE') throw error;
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    const elapsedMs = Date.now() - killedAt;
    assert.ok(store, `ledger was not reopened within 5 seconds (${lastError?.code})`);
    defer(() => store.close());
    t.diagnostic(`reopened ${elapsedMs} ms after the holder was force-killed`);
    assert.ok(elapsedMs < 5_000);
    const held = store.getOperation('holder', 'held-operation');
    assert.equal(held.state, 'unknown');
    assert.equal(held.resultCode, 'restart_after_attempt');
    assert.equal(store.bootSummary.recoveredAttempted, 1);
    assert.equal(store.identity.bootEpoch, 2);
    await exited;
  });

// Plans SQLite chooses for the store's main lookups: each must go through an index (or the
// integer primary key), never a full table scan.
const EXPECTED_PLANS = Object.freeze({
  selectOperation: /USING INDEX sqlite_autoindex_operations_1 \(purpose_id=\? AND operation_id=\?\)/u,
  finishOperation: /USING INDEX sqlite_autoindex_operations_1 \(purpose_id=\? AND operation_id=\?\)/u,
  countOperations: /USING COVERING INDEX sqlite_autoindex_operations_1 \(purpose_id=\?\)/u,
  selectMerge: /USING INDEX operations_merge \(purpose_id=\? AND merge_key=\? AND merge_window_until_ms>\?\)/u,
  countBudget: /USING COVERING INDEX operations_budget \(purpose_id=\? AND target=\?/u,
  selectPrunable: /USING INDEX operations_retention \(finished_at_ms<\?\)/u,
  deletePrunable: /USING INTEGER PRIMARY KEY \(rowid=\?\)/u,
  recoverAttempted: /USING COVERING INDEX operations_attempted/u,
  selectWatermark: /USING INDEX sqlite_autoindex_watermarks_1 \(purpose_id=\? AND source_key=\?\)/u,
  raiseWatermark: /USING INDEX sqlite_autoindex_watermarks_1 \(purpose_id=\? AND source_key=\?\)/u,
  selectFence: /USING INDEX sqlite_autoindex_reaction_fences_1 \(purpose_id=\? AND guild_id=\?\)/u,
  updateFence: /USING INDEX sqlite_autoindex_reaction_fences_1 \(purpose_id=\? AND guild_id=\?\)/u,
  countFences: /USING COVERING INDEX sqlite_autoindex_reaction_fences_1 \(purpose_id=\?\)/u,
  countAttempts: /USING INDEX sqlite_autoindex_operations_1 \(purpose_id=\?\)/u,
  attemptedPresent: /operations_attempted/u,
});

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Timing on a shared machine is noisy (runs measured other test processes slowing the
// late windows to about 2.2 times the early ones), so the decisive check here is the
// query plan: every hot lookup must use its index. Timing only guards against obvious
// non-linear growth: each 1,000-operation window is summarized by its median, which
// ignores short stalls, and the median of the last three windows may not reach five
// times the median of the first three. A lost index turns each lookup into a scan of
// the whole table and grows far beyond that by 20,000 rows.
const GROWTH_WINDOW_OPERATIONS = 1_000;
const GROWTH_WINDOWS = 20;
const GROWTH_LIMIT = 5;

test('20,000 recorded operations keep every hot lookup on its index without non-linear growth', (t) => {
  const { root, defer } = workspace(t, 'growth');
  // Same SQL and witness writes as production, minus fsync, so disk-flush noise cannot
  // hide or fake growth in per-transition cost.
  const runner = (paths) => {
    const clock = { value: 10_000 };
    const store = openStore(paths, { clock, durability: DURABILITY_UNSAFE_NO_SYNC });
    let next = 0;
    // One operation: begin plus finish, in milliseconds.
    const record = () => {
      const index = next;
      next += 1;
      const input = beginInput(index, { sourceKey: `source:${index}`, sourceTimeMs: 5_000 + index,
        claimedAtMs: clock.value });
      const started = process.hrtime.bigint();
      store.begin(input);
      store.finish(finishInput(index, { resultJson: JSON.stringify({ index }) }));
      const finished = process.hrtime.bigint();
      clock.value += 1;
      return Number(finished - started) / 1e6;
    };
    return { store, record, count: () => next };
  };

  // Warm-up on a throwaway ledger, discarded, so JIT compilation and cold caches do not
  // inflate the first measured windows.
  const warmupPaths = layout(root, 'warmup');
  createStore(warmupPaths, { durability: DURABILITY_UNSAFE_NO_SYNC });
  const warmup = runner(warmupPaths);
  for (let count = 0; count < GROWTH_WINDOW_OPERATIONS; count += 1) warmup.record();
  warmup.store.close();

  const paths = layout(root, 'measured');
  createStore(paths, { durability: DURABILITY_UNSAFE_NO_SYNC });
  const measured = runner(paths);
  defer(() => measured.store.close());
  const windowMedians = [];
  for (let window = 0; window < GROWTH_WINDOWS; window += 1) {
    const durations = [];
    for (let count = 0; count < GROWTH_WINDOW_OPERATIONS; count += 1) durations.push(measured.record());
    windowMedians.push(median(durations));
  }
  assert.equal(measured.store.countOperations(PURPOSE), measured.count());
  const liveBytes = measured.store.usedBytes();

  // Deterministic: with the ledger populated, every main lookup the store prepares still
  // uses an index (or the integer primary key) and never scans a whole table.
  measured.store.close();
  const db = directConnection(paths.filePath);
  try {
    for (const [name, pattern] of Object.entries(EXPECTED_PLANS)) {
      const details = db.prepare(`EXPLAIN QUERY PLAN ${STATEMENT_SQL[name]}`).all().map((row) => row.detail);
      assert.ok(details.some((detail) => pattern.test(detail)), `${name}: ${details.join(' ; ')}`);
      assert.ok(!details.some((detail) => /^SCAN (operations|watermarks|reaction_fences)$/u.test(detail)),
        `${name} scans a whole table: ${details.join(' ; ')}`);
    }
  } finally {
    db.close();
  }

  const early = median(windowMedians.slice(0, 3));
  const late = median(windowMedians.slice(-3));
  t.diagnostic(`after a discarded ${GROWTH_WINDOW_OPERATIONS}-operation warm-up: window medians ` +
    `${windowMedians.map((value) => value.toFixed(4)).join(', ')} ms per operation; first three ` +
    `${early.toFixed(4)} ms, last three ${late.toFixed(4)} ms, ratio ${(late / early).toFixed(3)} ` +
    `(limit ${GROWTH_LIMIT}); ${liveBytes} live bytes`);
  assert.ok(late < early * GROWTH_LIMIT,
    `median per-operation cost grew from ${early} ms to ${late} ms across ${measured.count()} operations`);
});

test('full-durability transition latency on this machine is reported for review', (t) => {
  const { root, defer } = workspace(t, 'latency');
  const paths = layout(root);
  createStore(paths);
  const store = openStore(paths);
  defer(() => store.close());
  const begins = [];
  const finishes = [];
  for (let index = 0; index < 40; index += 1) {
    const started = process.hrtime.bigint();
    store.begin(beginInput(index));
    const begun = process.hrtime.bigint();
    store.finish(finishInput(index));
    begins.push(Number(begun - started) / 1e6);
    finishes.push(Number(process.hrtime.bigint() - begun) / 1e6);
  }
  const average = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  t.diagnostic(`full durability: begin ${average(begins).toFixed(2)} ms (commit + witness fsync), ` +
    `finish ${average(finishes).toFixed(2)} ms`);
  assert.ok(Number.isFinite(average(begins)) && Number.isFinite(average(finishes)));
});

test('200,000 pruned operations become monotonic watermarks; covered sources are terminal with zero writes',
  (t) => {
    const { root, defer } = workspace(t, 'retention');
    const paths = layout(root);
    const TOTAL_ROWS = 200_000;
    const API_ROWS = 2_000;
    const KEYS = 1_000;
    const base = 1_700_000_000_000;
    const sourceTime = (index) => base - TOTAL_ROWS + index;
    createStore(paths, { cutoverMs: 1_000, durability: DURABILITY_UNSAFE_NO_SYNC });
    const clock = { value: base };
    let store = openStore(paths, { clock, durability: DURABILITY_UNSAFE_NO_SYNC });
    for (let index = 0; index < API_ROWS; index += 1) {
      store.begin(beginInput(index, { sourceKey: `source:${index % KEYS}`, sourceTimeMs: sourceTime(index),
        claimedAtMs: clock.value }));
      store.finish(finishInput(index));
    }
    store.close();

    // Per-transition fsync makes 200,000 API writes far slower than 60 seconds, so the rest
    // is bulk-loaded through SQLite itself: rows are inserted as attempted and then moved to
    // a terminal state, exactly the path the schema triggers allow.
    const loadStarted = Date.now();
    const db = directConnection(paths.filePath);
    try {
      db.exec('BEGIN IMMEDIATE');
      const insert = db.prepare(`INSERT INTO operations (purpose_id, operation_id, source_key, source_time_ms,
        binding_digest, binding_json, state, generation, target, merge_key, merge_window_until_ms, budget_charged,
        budget_reserved_at_ms, boot_epoch, begin_seq, claimed_at_ms, attempted_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, 'attempted', 1, 'synthetic-target', ?, NULL, 0, NULL, 1, ?, ?, ?)`);
      for (let index = API_ROWS; index < TOTAL_ROWS; index += 1) {
        const bindingJson = `{"bulk":${index}}`;
        insert.run(PURPOSE, `operation-${index}`, `source:${index % KEYS}`, sourceTime(index), sha256(bindingJson),
          bindingJson, `merge-${index}`, index + 1, base, base);
      }
      db.prepare("UPDATE operations SET state = 'confirmed', finished_at_ms = attempted_at_ms, result_code = 'bulk' " +
        "WHERE state = 'attempted'").run();
      db.exec('COMMIT');
    } finally {
      db.close();
    }
    const loadMs = Date.now() - loadStarted;

    clock.value = base + RETENTION_MS + 1;
    const bootStarted = Date.now();
    store = openStore(paths, { clock, durability: DURABILITY_UNSAFE_NO_SYNC });
    defer(() => store.close());
    const bootMs = Date.now() - bootStarted;
    const pruneStarted = Date.now();
    const rest = store.prune();
    const pruneMs = Date.now() - pruneStarted;
    t.diagnostic(`bulk load ${loadMs} ms; boot pruned ${store.bootSummary.pruned} rows in ${bootMs} ms; ` +
      `explicit prune removed ${rest.pruned} rows in ${pruneMs} ms (${rest.batches} batches)`);
    assert.equal(store.bootSummary.pruned + rest.pruned, TOTAL_ROWS);
    assert.equal(rest.complete, true);
    assert.equal(store.countOperations(PURPOSE), 0);
    for (let key = 0; key < KEYS; key += 1) {
      assert.equal(store.getWatermark(PURPOSE, `source:${key}`), sourceTime(TOTAL_ROWS - KEYS + key));
    }

    const before = store.stats();
    for (const key of [0, 1, 499, 998, 999]) {
      const watermark = store.getWatermark(PURPOSE, `source:${key}`);
      const query = (sourceTimeMs) => store.inspectOperation({ purposeId: PURPOSE, operationId: `replayed-${key}`,
        sourceKey: `source:${key}`, sourceTimeMs });
      assert.deepEqual(query(watermark), { kind: 'terminal', reason: 'watermark', boundaryMs: watermark });
      assert.equal(query(watermark - 50_000).kind, 'terminal');
      assert.equal(query(watermark + 1).kind, 'absent');
      assert.deepEqual(query(1_000), { kind: 'terminal', reason: 'cutover', boundaryMs: 1_000 });
    }
    assert.throws(() => store.begin(beginInput(5, { sourceKey: 'source:5', sourceTimeMs: sourceTime(5),
      claimedAtMs: clock.value })), (error) => error.code === 'LEDGER_SOURCE_TERMINAL');
    assert.equal(store.failed, false);
    assert.deepEqual(store.stats(), before);
    assert.equal(store.prune().pruned, 0);
    assert.equal(store.getWatermark(PURPOSE, 'source:0'), sourceTime(TOTAL_ROWS - KEYS));
  });

test('an older database copy is LEDGER_ROLLBACK for boot_epoch and begin_seq regressions', (t) => {
  const { root } = workspace(t, 'rollback');
  const clock = { value: 10_000 };

  const epochPaths = layout(root, 'epoch');
  createStore(epochPaths);
  openStore(epochPaths, { clock }).close();
  const epochCopy = fs.readFileSync(epochPaths.filePath);
  openStore(epochPaths, { clock }).close();
  fs.writeFileSync(epochPaths.filePath, epochCopy);
  assert.throws(() => openStore(epochPaths, { clock }), (error) => error.code === 'LEDGER_ROLLBACK' &&
    error.detail.reason === 'database-behind' && error.detail.database.bootEpoch === 1 &&
    error.detail.witness.bootEpoch === 2);
  assert.equal(sha256(fs.readFileSync(epochPaths.filePath)), sha256(epochCopy));

  const sequencePaths = layout(root, 'sequence');
  createStore(sequencePaths);
  let store = openStore(sequencePaths, { clock });
  store.begin(beginInput(1));
  store.begin(beginInput(2));
  store.close();
  const sequenceCopy = fs.readFileSync(sequencePaths.filePath);
  store = openStore(sequencePaths, { clock });
  store.begin(beginInput(3));
  store.close();
  fs.writeFileSync(sequencePaths.filePath, sequenceCopy);
  // A writer with file access advances the restored copy's epoch by one chained step, so
  // only begin_seq remains behind the witness.
  const db = directConnection(sequencePaths.filePath);
  try {
    db.prepare(`UPDATE identity SET boot_epoch = boot_epoch + 1, chain_prev = chain_head,
      chain_head = ? WHERE singleton = 1`).run('f'.repeat(64));
  } finally {
    db.close();
  }
  assert.throws(() => openStore(sequencePaths, { clock }), (error) => error.code === 'LEDGER_ROLLBACK' &&
    error.detail.reason === 'database-behind' && error.detail.database.bootEpoch === 2 &&
    error.detail.database.beginSeq === 2 && error.detail.witness.beginSeq === 3);
});

test('a database and witness restored to different points in time are rejected', (t) => {
  const { root } = workspace(t, 'points');
  const clock = { value: 10_000 };
  const paths = layout(root);
  createStore(paths);
  let store = openStore(paths, { clock });
  store.begin(beginInput(1));
  store.close();
  const pointA = snapshot(paths);
  store = openStore(paths, { clock });
  store.begin(beginInput(2));
  store.begin(beginInput(3));
  store.close();
  const pointB = snapshot(paths);

  restore(paths, { database: pointA.database, witness: pointB.witness });
  assert.throws(() => openStore(paths, { clock }), (error) => error.code === 'LEDGER_ROLLBACK' &&
    error.detail.reason === 'database-behind');
  // The witness replaced by an older copy: the database is three steps ahead of it.
  restore(paths, { database: pointB.database, witness: pointA.witness });
  assert.throws(() => openStore(paths, { clock }), (error) => error.code === 'LEDGER_ROLLBACK' &&
    error.detail.reason === 'gap' && error.detail.database.beginSeq === 3 && error.detail.witness.beginSeq === 1);
  restore(paths, pointB);
  openStore(paths, { clock }).close();
});

test('a forked copy is rejected even when its counters match the witness', (t) => {
  const { root } = workspace(t, 'fork');
  const clock = { value: 10_000 };
  const paths = layout(root, 'original');
  createStore(paths);
  let store = openStore(paths, { clock });
  store.begin(beginInput(1));
  store.close();
  const base = snapshot(paths);
  store = openStore(paths, { clock });
  store.begin(beginInput(2));
  store.close();
  const original = snapshot(paths);

  // A copy of the same base continues elsewhere with a different operation.
  const forkPaths = layout(root, 'fork');
  restore(forkPaths, base);
  store = openStore(forkPaths, { clock });
  store.begin(beginInput(9));
  store.close();
  const fork = snapshot(forkPaths);

  restore(paths, { database: fork.database, witness: original.witness });
  assert.throws(() => openStore(paths, { clock }), (error) => error.code === 'LEDGER_ROLLBACK' &&
    error.detail.reason === 'fork' && error.detail.database.beginSeq === error.detail.witness.beginSeq &&
    error.detail.database.bootEpoch === error.detail.witness.bootEpoch);

  // One step further, the fork is ahead of the original witness yet still not its descendant.
  openStore(forkPaths, { clock }).close();
  restore(paths, { database: fs.readFileSync(forkPaths.filePath), witness: original.witness });
  assert.throws(() => openStore(paths, { clock }), (error) => error.code === 'LEDGER_ROLLBACK' &&
    error.detail.reason === 'fork' && error.detail.database.bootEpoch === error.detail.witness.bootEpoch + 1);
});

test('a witness exactly one step behind is an interrupted write: accepted and resynchronized before boot', (t) => {
  const { root } = workspace(t, 'one-behind');
  const clock = { value: 10_000 };
  const paths = layout(root);
  createStore(paths);
  const store = openStore(paths, { clock });
  store.begin(beginInput(1));
  // The witness is a plain file (not SQLite), so copying it while the ledger is open is safe.
  const witnessAfterFirstBegin = fs.readFileSync(paths.witnessPath);
  store.begin(beginInput(2));
  store.close();
  fs.writeFileSync(paths.witnessPath, witnessAfterFirstBegin);

  const reopened = openStore(paths, { clock });
  try {
    assert.equal(reopened.bootSummary.resynchronizedWitnesses, 1);
    const state = readWitness(paths.witnessPath, witnessIdentityDigest(reopened.identity)).state;
    assert.deepEqual({ bootEpoch: state.bootEpoch, beginSeq: state.beginSeq }, { bootEpoch: 2, beginSeq: 2 });
  } finally {
    reopened.close();
  }
});

test('repeated interrupted witness writes never accumulate into a rollback', (t) => {
  const { root } = workspace(t, 'accumulate');
  const clock = { value: 10_000 };
  const paths = layout(root);
  createStore(paths);
  let crashLabel = 'begin';
  const faultInjector = ({ label, phase }) => {
    if (label === crashLabel && phase === 'before-witness-write') throw new Error('synthetic lost witness write');
  };
  const store = openStore(paths, { clock, faultInjector });
  assert.throws(() => store.begin(beginInput(1)), (error) => error.code === 'LEDGER_PERSIST_FAILED');
  store.close();

  // The next open first brings the witness up to the database, then loses the boot write.
  crashLabel = 'boot';
  assert.throws(() => openStore(paths, { clock, faultInjector }), (error) => error.code === 'LEDGER_PERSIST_FAILED');

  // Without the resynchronization the witness would now be two steps behind.
  crashLabel = null;
  const reopened = openStore(paths, { clock });
  try {
    assert.equal(reopened.identity.bootEpoch, 3);
    assert.equal(reopened.getOperation(PURPOSE, 'operation-1').state, 'unknown');
  } finally {
    reopened.close();
  }
});

test('a torn witness slot falls back to the other slot; two torn slots or a foreign witness fail closed', (t) => {
  const { root } = workspace(t, 'witness');
  const paths = layout(root);
  createStore(paths);
  const clock = { value: 10_000 };
  let store = openStore(paths, { clock });
  store.begin(beginInput(1));
  const digest = witnessIdentityDigest(store.identity);
  store.close();
  // A torn write leaves the second half of the slot unwritten.
  const tear = (slotIndex) => {
    const bytes = fs.readFileSync(paths.witnessPath);
    bytes.fill(0, slotIndex * WITNESS_SLOT_BYTES + 128, (slotIndex + 1) * WITNESS_SLOT_BYTES);
    fs.writeFileSync(paths.witnessPath, bytes);
  };

  const newest = readWitness(paths.witnessPath, digest).newestSlot;
  tear(newest);
  assert.deepEqual(readWitness(paths.witnessPath, digest).tornSlots, [newest]);
  store = openStore(paths, { clock });
  assert.deepEqual(store.bootSummary.tornWitnessSlots, [[newest]]);
  assert.equal(store.getOperation(PURPOSE, 'operation-1').state, 'unknown');
  store.close();
  assert.deepEqual(readWitness(paths.witnessPath, digest).tornSlots, []);

  const older = 1 - readWitness(paths.witnessPath, digest).newestSlot;
  tear(older);
  store = openStore(paths, { clock });
  assert.deepEqual(store.bootSummary.tornWitnessSlots, [[older]]);
  store.close();

  tear(0);
  tear(1);
  assert.throws(() => openStore(paths, { clock }), (error) => error.code === 'LEDGER_WITNESS_INVALID');

  const foreignPaths = layout(root, 'foreign');
  createStore(foreignPaths, { ledgerId: 'another-ledger' });
  const victimPaths = layout(root, 'victim');
  createStore(victimPaths);
  fs.copyFileSync(foreignPaths.witnessPath, victimPaths.witnessPath);
  assert.throws(() => openStore(victimPaths, { clock }), (error) => error.code === 'LEDGER_WITNESS_INVALID');
});

test('a crash between the begin commit and its witness write recovers as unknown without a rollback alarm', (t) => {
  const { root } = workspace(t, 'witness-crash');
  const paths = layout(root);
  createStore(paths);
  const clock = { value: 10_000 };
  let crash = false;
  const store = openStore(paths, {
    clock,
    faultInjector: ({ label, phase }) => {
      if (crash && label === 'begin' && phase === 'before-witness-write') throw new Error('synthetic crash');
    },
  });
  crash = true;
  assert.throws(() => store.begin(beginInput(1)), (error) => error.code === 'LEDGER_PERSIST_FAILED');
  assert.equal(store.failed, true);
  assert.throws(() => store.begin(beginInput(2)), (error) => error.code === 'LEDGER_FAILED');
  store.close();
  const reopened = openStore(paths, { clock });
  try {
    assert.equal(reopened.getOperation(PURPOSE, 'operation-1').state, 'unknown');
    assert.equal(reopened.getOperation(PURPOSE, 'operation-2'), null);
  } finally {
    reopened.close();
  }
});

test('reaction fence open and close are sequenced, witnessed steps', (t) => {
  const { root } = workspace(t, 'fence-steps');
  const paths = layout(root);
  createStore(paths);
  const clock = { value: 10_000 };
  let store = openStore(paths, { clock });
  const digest = witnessIdentityDigest(store.identity);
  const witness = () => readWitness(paths.witnessPath, digest);
  const start = { beginSeq: store.identity.beginSeq, counter: witness().counter };
  store.putReactionFence({ purposeId: 'word-chain.reaction', guildId: GUILD_ID, generation: 1, channelId: CHANNEL_ID,
    sessionKey: 'word-chain.reaction|steps', sourceFence: sha256('fence-1') });
  assert.equal(store.identity.beginSeq, start.beginSeq + 1);
  assert.equal(witness().counter, start.counter + 1);
  assert.equal(witness().state.beginSeq, start.beginSeq + 1);
  store.close();
  const openFenceCopy = fs.readFileSync(paths.filePath);

  store = openStore(paths, { clock });
  const beforeClose = store.identity.beginSeq;
  store.closeReactionFence({ purposeId: 'word-chain.reaction', guildId: GUILD_ID, generation: 1 });
  assert.equal(store.identity.beginSeq, beforeClose + 1);
  assert.equal(witness().state.beginSeq, beforeClose + 1);
  assert.equal(store.getReactionFence('word-chain.reaction', GUILD_ID).open, false);
  store.close();

  // Restoring the copy with the fence still open is a rollback, never a reopened fence.
  fs.writeFileSync(paths.filePath, openFenceCopy);
  assert.throws(() => openStore(paths, { clock }), (error) => error.code === 'LEDGER_ROLLBACK');
});

test('junctions and symbolic links in ledger or witness paths are rejected', async (t) => {
  const { root, defer } = workspace(t, 'links');
  const realLedger = path.join(root, 'real-ledger');
  const realWitness = path.join(root, 'real-witness');
  fs.mkdirSync(realLedger);
  fs.mkdirSync(realWitness);
  const linked = (error) => error.code === 'LEDGER_PATH_LINKED';
  const base = { kind: 'public', ledgerId: 'linked-ledger', botId: BOT_ID, runtimeMode: 'production',
    genesisMs: 1_000, cutoverMs: 0 };
  const expected = { botId: BOT_ID, runtimeMode: 'production' };
  const realFile = path.join(realLedger, 'ledger.sqlite');
  const realWitnessFile = path.join(realWitness, 'ledger.witness');

  await t.test('junction', () => {
    const ledgerJunction = path.join(root, 'ledger-junction');
    const witnessJunction = path.join(root, 'witness-junction');
    const fileJunction = path.join(realLedger, 'junction.sqlite');
    fs.symlinkSync(realLedger, ledgerJunction, 'junction');
    defer(() => fs.unlinkSync(ledgerJunction));
    fs.symlinkSync(realWitness, witnessJunction, 'junction');
    defer(() => fs.unlinkSync(witnessJunction));

    assert.throws(() => createLedgerStore({ ...base, filePath: path.join(ledgerJunction, 'ledger.sqlite'),
      witnessPaths: [realWitnessFile] }), linked);
    assert.deepEqual(fs.readdirSync(realLedger), []);
    assert.throws(() => createLedgerStore({ ...base, filePath: realFile,
      witnessPaths: [path.join(witnessJunction, 'ledger.witness')] }), linked);
    assert.deepEqual(fs.readdirSync(realWitness), []);

    createLedgerStore({ ...base, filePath: realFile, witnessPaths: [realWitnessFile] });
    assert.throws(() => openLedgerStore({ kind: 'public', expected, filePath: path.join(ledgerJunction, 'ledger.sqlite'),
      witnessPaths: [realWitnessFile] }), linked);
    assert.throws(() => openLedgerStore({ kind: 'public', expected, filePath: realFile,
      witnessPaths: [path.join(witnessJunction, 'ledger.witness')] }), linked);
    fs.symlinkSync(realWitness, fileJunction, 'junction');
    defer(() => fs.unlinkSync(fileJunction));
    assert.throws(() => openLedgerStore({ kind: 'public', expected, filePath: fileJunction,
      witnessPaths: [realWitnessFile] }), linked);
    const store = openLedgerStore({ kind: 'public', expected, filePath: realFile, witnessPaths: [realWitnessFile] });
    store.close();
  });

  await t.test('symbolic link', (subtest) => {
    const fileLink = path.join(realLedger, 'symlink.sqlite');
    const witnessLink = path.join(realWitness, 'symlink.witness');
    try {
      fs.symlinkSync(realFile, fileLink, 'file');
    } catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        subtest.skip('Windows refused to create a file symbolic link (needs Developer Mode or ' +
          'SeCreateSymbolicLinkPrivilege); the junction cases above ran instead.');
        return;
      }
      throw error;
    }
    defer(() => fs.unlinkSync(fileLink));
    fs.symlinkSync(realWitnessFile, witnessLink, 'file');
    defer(() => fs.unlinkSync(witnessLink));
    assert.throws(() => openLedgerStore({ kind: 'public', expected, filePath: fileLink,
      witnessPaths: [realWitnessFile] }), linked);
    assert.throws(() => openLedgerStore({ kind: 'public', expected, filePath: realFile,
      witnessPaths: [witnessLink] }), linked);
  });
});

test('the database header is checked before SQLite touches the file', (t) => {
  const { root } = workspace(t, 'header');

  const emptyPaths = layout(root, 'empty');
  createStore(emptyPaths);
  fs.writeFileSync(emptyPaths.filePath, Buffer.alloc(0));
  assert.throws(() => openStore(emptyPaths), (error) => error.code === 'LEDGER_CORRUPT');
  assert.equal(fs.statSync(emptyPaths.filePath).size, 0);
  assert.equal(fs.existsSync(`${emptyPaths.filePath}-wal`), false);

  // A different SQLite database (rollback journal, no ledger application ID) is refused
  // without being converted to WAL.
  const foreignPaths = layout(root, 'foreign');
  createStore(foreignPaths);
  fs.unlinkSync(foreignPaths.filePath);
  const foreign = new DatabaseSync(foreignPaths.filePath);
  foreign.exec("CREATE TABLE notes (value TEXT); INSERT INTO notes VALUES ('keep me')");
  foreign.close();
  const before = fs.readFileSync(foreignPaths.filePath);
  assert.equal(before[18], 1);
  assert.throws(() => openStore(foreignPaths), (error) => error.code === 'LEDGER_FORMAT_UNKNOWN');
  const after = fs.readFileSync(foreignPaths.filePath);
  assert.equal(sha256(after), sha256(before));
  assert.equal(after[18], 1);
  assert.equal(fs.existsSync(`${foreignPaths.filePath}-wal`), false);

  // A ledger from an earlier schema revision is outdated, not corrupt, and stays untouched.
  assert.equal(SCHEMA_VERSION, 3);
  const outdatedPaths = layout(root, 'outdated');
  createStore(outdatedPaths);
  const outdatedDb = directConnection(outdatedPaths.filePath);
  try { outdatedDb.exec('PRAGMA user_version = 2'); } finally { outdatedDb.close(); }
  const outdated = fs.readFileSync(outdatedPaths.filePath);
  assert.equal(outdated.readUInt32BE(60), 2);
  assert.throws(() => openStore(outdatedPaths), (error) => error.code === 'LEDGER_FORMAT_OUTDATED' &&
    error.detail.found === 2 && error.detail.expected === 3);
  assert.equal(sha256(fs.readFileSync(outdatedPaths.filePath)), sha256(outdated));
  assert.equal(fs.existsSync(`${outdatedPaths.filePath}-wal`), false);
});

test('every sqlite_schema row must be expected, including sqlite_* objects', (t) => {
  const { root } = workspace(t, 'schema');

  const statPaths = layout(root, 'stat');
  createStore(statPaths);
  const statDb = directConnection(statPaths.filePath);
  try {
    statDb.exec('ANALYZE');
    assert.ok(statDb.prepare("SELECT 1 FROM sqlite_schema WHERE name = 'sqlite_stat1'").get());
  } finally {
    statDb.close();
  }
  assert.throws(() => openStore(statPaths), (error) => error.code === 'LEDGER_CORRUPT');

  const viewPaths = layout(root, 'view');
  createStore(viewPaths);
  const viewDb = directConnection(viewPaths.filePath);
  try { viewDb.exec('CREATE VIEW extra AS SELECT 1 AS value'); } finally { viewDb.close(); }
  assert.throws(() => openStore(viewPaths), (error) => error.code === 'LEDGER_CORRUPT');
});

test('a read that meets a corrupt page marks the store failed', (t) => {
  const { root, defer } = workspace(t, 'corrupt-read');
  const paths = layout(root);
  createStore(paths);
  const clock = { value: 10_000 };
  let store = openStore(paths, { clock });
  store.begin(beginInput(1, { mergeWindowUntilMs: 20_000 }));
  store.finish(finishInput(1));
  store.close();
  // Point one index at the identity table's page, as a damaged file could.
  const db = new DatabaseSync(paths.filePath, { defensive: false });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.prepare('PRAGMA journal_mode = WAL').get();
    db.exec('PRAGMA writable_schema = ON');
    db.exec("UPDATE sqlite_schema SET rootpage = (SELECT rootpage FROM sqlite_schema WHERE name = 'identity') " +
      "WHERE name = 'operations_merge'");
    db.exec('PRAGMA writable_schema = OFF');
  } finally {
    db.close();
  }
  store = openStore(paths, { clock });
  defer(() => store.close());
  assert.equal(store.failed, false);
  assert.throws(() => store.findMergeHolder({ purposeId: PURPOSE, mergeKey: 'merge-1', nowMs: 15_000 }),
    (error) => error.code === 'LEDGER_CORRUPT');
  assert.equal(store.failed, true);
  assert.throws(() => store.begin(beginInput(2)), (error) => error.code === 'LEDGER_FAILED');
});

test('store transitions are single transactions, conflicting bindings are rejected, and guards hold', (t) => {
  const { root, defer } = workspace(t, 'transitions');
  const paths = layout(root);
  createStore(paths);
  const clock = { value: 10_000 };
  const store = openStore(paths, { clock });
  defer(() => store.close());
  const digest = witnessIdentityDigest(store.identity);
  const witnessCounter = () => readWitness(paths.witnessPath, digest).counter;

  const start = store.stats();
  const counterBefore = witnessCounter();
  assert.equal(store.begin(beginInput(1)).state, 'attempted');
  assert.equal(store.stats().commits, start.commits + 1);
  assert.equal(witnessCounter(), counterBefore + 1);
  assert.throws(() => store.begin(beginInput(1, { binding: { changed: true } })),
    (error) => error.code === 'LEDGER_BINDING_CONFLICT');
  assert.throws(() => store.begin(beginInput(1)), (error) => error.code === 'LEDGER_TRANSITION_REJECTED');
  assert.throws(() => store.finish(finishInput(1, { generation: 2 })),
    (error) => error.code === 'LEDGER_TRANSITION_REJECTED');
  assert.equal(store.failed, false);
  const finished = store.finish(finishInput(1, { resultJson: '{"ok":true}' }));
  assert.equal(finished.state, 'confirmed');
  assert.deepEqual(finished.result, { ok: true });
  assert.equal(store.stats().commits, start.commits + 2);
  assert.equal(witnessCounter(), counterBefore + 1);
  assert.throws(() => store.finish(finishInput(1, { state: 'unknown' })),
    (error) => error.code === 'LEDGER_TRANSITION_REJECTED');

  const guarded = store.stats();
  assert.throws(() => store.withoutWrites(() => store.begin(beginInput(2))),
    (error) => error.code === 'LEDGER_WRITE_FORBIDDEN');
  assert.throws(() => store.withoutWrites(() => store.prune()), (error) => error.code === 'LEDGER_WRITE_FORBIDDEN');
  assert.deepEqual(store.stats(), guarded);

  const release = store.attachPurpose(PURPOSE);
  assert.throws(() => store.attachPurpose(PURPOSE), (error) => error.code === 'LEDGER_PURPOSE_IN_USE');
  release();
  store.attachPurpose(PURPOSE)();
  store.putReactionFence({ purposeId: 'word-chain.reaction', guildId: GUILD_ID, generation: 1, channelId: CHANNEL_ID,
    sessionKey: 'word-chain.reaction|replace', sourceFence: sha256('fence-replace') });
  store.begin(beginInput(3, { sourceKey: 'timed-source', sourceTimeMs: 5_000 }));
  store.finish(finishInput(3));
  store.begin(beginInput(4));
  store.close();

  const db = directConnection(paths.filePath);
  try {
    // Deleting is reserved for pruning: the row must be terminal, carry a source time,
    // and already be covered by its source's watermark.
    const deleteOperation = (index) => db.prepare('DELETE FROM operations WHERE operation_id = ?')
      .run(`operation-${index}`);
    assert.throws(() => deleteOperation(1), /covered by a watermark/u);
    assert.throws(() => deleteOperation(4), /covered by a watermark/u);
    assert.throws(() => deleteOperation(3), /covered by a watermark/u);
    db.prepare("INSERT INTO watermarks VALUES ('synthetic.purpose', 'timed-source', 4999, 1)").run();
    assert.throws(() => deleteOperation(3), /covered by a watermark/u);
    db.prepare("UPDATE watermarks SET watermark_ms = 5000 WHERE source_key = 'timed-source'").run();
    assert.equal(Number(deleteOperation(3).changes), 1);
    assert.throws(() => db.prepare("UPDATE operations SET state = 'unknown' WHERE operation_id = 'operation-1'").run(),
      /attempted to a terminal state/u);
    assert.throws(() => db.prepare('UPDATE identity SET begin_seq = 0').run(), /never decrease/u);
    assert.throws(() => db.prepare('UPDATE identity SET begin_seq = begin_seq + 2').run(), /one chained step/u);
    assert.throws(() => db.prepare('DELETE FROM identity').run(), /permanent/u);
    // REPLACE deletes the conflicting row before inserting; the insert guards refuse it
    // first, even on a connection without recursive triggers.
    assert.throws(() => db.prepare('INSERT OR REPLACE INTO identity SELECT * FROM identity').run(), /created once/u);
    assert.throws(() => db.prepare(`INSERT OR REPLACE INTO operations SELECT purpose_id, operation_id, source_key,
      source_time_ms, binding_digest, binding_json, 'attempted', generation, target, merge_key, merge_window_until_ms,
      budget_charged, budget_reserved_at_ms, boot_epoch, begin_seq, claimed_at_ms, attempted_at_ms, NULL, NULL, NULL,
      NULL FROM operations WHERE operation_id = 'operation-1'`).run(), /recorded once/u);
    db.prepare("INSERT INTO watermarks VALUES ('synthetic.purpose', 'source:1', 50, 1)").run();
    assert.throws(() => db.prepare("REPLACE INTO watermarks VALUES ('synthetic.purpose', 'source:1', 10, 2)").run(),
      /created once/u);
    assert.throws(() => db.prepare(`INSERT OR REPLACE INTO reaction_fences SELECT purpose_id, guild_id,
      generation + 1, 0, channel_id, session_key, source_fence, boot_epoch, begin_seq + 1, updated_at_ms
      FROM reaction_fences`).run(), /created once/u);
    assert.throws(() => db.prepare('UPDATE watermarks SET watermark_ms = 10').run(), /never decrease/u);
    assert.throws(() => db.prepare('DELETE FROM watermarks').run(), /permanent/u);
  } finally {
    db.close();
  }
});

test('defensive mode is in force on the store connection, and node:sqlite 24.21 honours the option', (t) => {
  const { root, defer } = workspace(t, 'defensive');
  const paths = layout(root);
  createStore(paths);
  const store = openStore(paths);
  defer(() => store.close());
  assert.equal(store.describeConnection().schemaWritesLocked, true);
  for (const [defensive, locked] of [[true, true], [false, false]]) {
    const db = new DatabaseSync(':memory:', { defensive });
    try {
      db.exec('CREATE TABLE sample (value INTEGER)');
      db.exec('PRAGMA writable_schema = ON');
      assert.equal(Number(db.prepare('PRAGMA writable_schema').get().writable_schema) === 0, locked);
      const rewrite = () => db.exec(
        "UPDATE sqlite_schema SET sql = 'CREATE TABLE sample (value INTEGER, extra INTEGER)' WHERE name = 'sample'"
      );
      if (locked) assert.throws(rewrite, /may not be modified/u);
      else rewrite();
    } finally {
      db.close();
    }
  }
});

test('the soft size limit prunes on a bounded, logged accelerated schedule, then refuses growth', (t) => {
  const { root, defer } = workspace(t, 'soft-limit');
  const paths = layout(root);
  createStore(paths, { durability: DURABILITY_UNSAFE_NO_SYNC });
  const clock = { value: 10 * DAY_MS };
  const logger = capturingLogger();
  const store = openStore(paths, { clock, durability: DURABILITY_UNSAFE_NO_SYNC, logger,
    acceleratedPruneMaxBatches: 1, pruneBatchRows: 100 });
  defer(() => store.close());
  for (let index = 0; index < 400; index += 1) {
    store.begin(beginInput(index, { sourceKey: `source:${index % 10}`, sourceTimeMs: DAY_MS + index,
      claimedAtMs: clock.value }));
    store.finish(finishInput(index));
  }
  store.begin(beginInput(1_000, { sourceKey: 'pending', sourceTimeMs: 2 * DAY_MS, claimedAtMs: clock.value }));

  clock.value += ACCELERATED_RETENTION_MS + 1;
  store.softLimitBytes = store.usedBytes() - 1;
  const relieved = store.begin(beginInput(1_001, { sourceKey: 'fresh', sourceTimeMs: clock.value,
    claimedAtMs: clock.value }));
  assert.equal(relieved.state, 'attempted');
  // Only one batch of 100 old rows was pruned, and the bounded relief was logged.
  assert.equal(store.countOperations(PURPOSE), 300 + 2);
  assert.equal(store.getWatermark(PURPOSE, 'source:3'), DAY_MS + 93);
  assert.ok(logger.lines.some(([level, line]) => level === 'warn' &&
    /code=LEDGER_ACCELERATED_PRUNE kind=public pruned=100 batches=1 complete=false/u.test(line)));

  store.softLimitBytes = 1;
  // Within ten minutes of the last relief the refusal is immediate: no second accelerated
  // prune and no warning, however often growth is attempted.
  const linesBeforeThrottle = logger.lines.length;
  const prunedBeforeThrottle = store.countOperations(PURPOSE);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    assert.throws(() => store.begin(beginInput(1_002, { sourceKey: 'fresh', sourceTimeMs: clock.value,
      claimedAtMs: clock.value })), (error) => error.code === 'LEDGER_CAPACITY_EXCEEDED' &&
      error.detail.throttled === true && error.retryable === false);
  }
  assert.equal(logger.lines.length, linesBeforeThrottle);
  assert.equal(store.countOperations(PURPOSE), prunedBeforeThrottle);
  clock.value += CAPACITY_RELIEF_INTERVAL_MS;
  assert.throws(() => store.begin(beginInput(1_002, { sourceKey: 'fresh', sourceTimeMs: clock.value,
    claimedAtMs: clock.value })), (error) => error.code === 'LEDGER_CAPACITY_EXCEEDED' && error.retryable === false &&
    error.detail.throttled === undefined);
  assert.ok(logger.lines.some(([level, line]) => level === 'warn' && line.includes('code=LEDGER_CAPACITY_EXCEEDED')));
  assert.equal(logger.lines.filter(([, line]) => line.includes('code=LEDGER_ACCELERATED_PRUNE')).length, 2);
  assert.equal(store.failed, false);
  assert.equal(store.getOperation(PURPOSE, 'operation-1002'), null);
  assert.equal(store.finish(finishInput(1_000)).state, 'confirmed');
  assert.equal(store.finish(finishInput(1_001, { state: 'not_sent' })).state, 'not_sent');
});

test('test-only durability and fault injection are refused outside the Node test runner', (t) => {
  const { root } = workspace(t, 'test-only');
  const paths = layout(root);
  createStore(paths);
  const ownerPath = path.join(root, 'owner-ledger.sqlite');
  const initialized = initializeSideEffectLedger({ filePath: ownerPath, ledgerId: 'test-only-owner',
    initializationId: 'synthetic-test-only', notificationIdentity: { botId: BOT_ID, ownerId: OWNER_ID } });
  const script = `
    const [storeModule, facadeModule, filePath, witnessPath, ownerPath, receipt, botId, ownerId] = process.argv.slice(1);
    const store = require(storeModule);
    const facade = require(facadeModule);
    const codeOf = (work) => {
      try { work(); return 'accepted'; } catch (error) { return error.storeCode ? error.code + '/' + error.storeCode : error.code; }
    };
    const expected = { botId, runtimeMode: 'production' };
    const results = {
      context: process.env.NODE_TEST_CONTEXT === undefined ? 'absent' : 'present',
      createUnsafe: codeOf(() => store.createLedgerStore({ filePath: filePath + '.unsafe', witnessPaths: [witnessPath + '.unsafe'],
        kind: 'public', ledgerId: 'unsafe', botId, runtimeMode: 'production', genesisMs: 1, cutoverMs: 0,
        durability: store.DURABILITY_UNSAFE_NO_SYNC })),
      openUnsafe: codeOf(() => store.openLedgerStore({ filePath, witnessPaths: [witnessPath], kind: 'public', expected,
        durability: store.DURABILITY_UNSAFE_NO_SYNC })),
      openInjector: codeOf(() => store.openLedgerStore({ filePath, witnessPaths: [witnessPath], kind: 'public', expected,
        faultInjector: () => {} })),
      facadeInjector: codeOf(() => facade.openSideEffectLedger({ filePath: ownerPath, expectedReceiptSha256: receipt,
        expectedIdentity: { botId, ownerId }, faultInjector: () => {} })),
    };
    const opened = store.openLedgerStore({ filePath, witnessPaths: [witnessPath], kind: 'public', expected });
    opened.close();
    results.openDefault = 'opened';
    process.stdout.write(JSON.stringify(results));
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['-e', script, STORE_MODULE, FACADE_MODULE, paths.filePath,
    paths.witnessPath, ownerPath, initialized.receiptSha256, BOT_ID, OWNER_ID], { env, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    context: 'absent',
    createUnsafe: 'LEDGER_INPUT_INVALID',
    openUnsafe: 'LEDGER_INPUT_INVALID',
    openInjector: 'LEDGER_INPUT_INVALID',
    facadeInjector: 'SIDE_EFFECT_CONFIGURATION_INVALID/LEDGER_INPUT_INVALID',
    openDefault: 'opened',
  });
  assert.equal(fs.existsSync(`${paths.filePath}.unsafe`), false);
});

test('deferred, merged, and budget-suppressed events cause zero ledger writes through the public API', (t) => {
  const { root, defer } = workspace(t, 'zero-write');
  const filePath = path.join(root, 'owner-ledger.sqlite');
  const clock = { value: 100_000 };
  const identity = { botId: BOT_ID, ownerId: OWNER_ID };
  const initialized = initializeSideEffectLedger({ filePath, ledgerId: 'zero-write-ledger',
    initializationId: 'synthetic-zero-write', notificationIdentity: identity, now: () => clock.value });
  const open = () => openSideEffectLedger({ filePath, expectedReceiptSha256: initialized.receiptSha256,
    expectedIdentity: identity, now: () => clock.value });
  const notice = (id, overrides = {}) => ({
    operationId: `notice-${id}`,
    sourceKey: 'discord.message:guild:111111111111111111',
    sourceEventId: `event-${id}`,
    hostPurpose: 'discord.message',
    scope: 'guild:111111111111111111',
    action: 'owner-safety-notification',
    target: OWNER_ID,
    budgetClass: 'owner-notice',
    mergeKey: `merge-${id}`,
    payload: { code: `SYNTHETIC_${id}` },
    ...overrides,
  });

  let ledger = open();
  const durable = notice('durable', { mergeKey: 'shared-merge' });
  const durableClaim = ledger.claim(durable);
  ledger.beginDispatch(durable, durableClaim.operation.generation);
  ledger.finish(durable.operationId, durableClaim.operation.generation, 'confirmed', 'synthetic_confirmed');

  const before = writeFootprint(ledger, initialized, [initialized.anchorPath]);
  const merged = ledger.claim(notice('merged', { mergeKey: 'shared-merge' }));
  const budget = ledger.claim(notice('budget', { mergeKey: 'budget-merge' }));
  const deferred = ledger.suppress(notice('deferred', { mergeKey: 'deferred-merge' }), 'queue_full');
  assert.equal(merged.operation.status, 'suppressed_merge');
  assert.equal(budget.operation.status, 'suppressed_budget');
  assert.equal(deferred.operation.status, 'suppressed_queue');
  assert.equal(ledger.claim(notice('merged', { mergeKey: 'shared-merge' })).kind, 'replay');
  assert.equal(ledger.verifyBinding(notice('budget', { mergeKey: 'budget-merge' })).status, 'suppressed_budget');
  assert.equal(ledger.getOperation('notice-deferred').durable, false);
  // Claims, leases, and every other pre-dispatch decision stay in memory as well.
  const unsent = notice('unsent', { budgetClass: 'none', mergeKey: 'unsent-merge' });
  const claimed = ledger.claim(unsent);
  ledger.renew(unsent.operationId, claimed.operation.generation);
  ledger.releasePreparation(unsent.operationId, claimed.operation.generation);
  clock.value += PREPARE_RETRY_AFTER_MS;
  const reclaimed = ledger.claim(unsent);
  ledger.finalizeClaim(unsent.operationId, reclaimed.operation.generation, 'cancelled_before_dispatch');
  ledger.finalizeUnattempted(notice('unavailable', { budgetClass: 'none', mergeKey: 'unavailable-merge' }));
  assert.deepEqual(writeFootprint(ledger, initialized, [initialized.anchorPath]), before);
  ledger.close();

  ledger = open();
  defer(() => ledger.close());
  assert.deepEqual(Object.keys(ledger.getSnapshotForTests().operations), ['notice-durable']);
});

test('facade claims at or below the cutover or a pruned watermark are terminal without any write', (t) => {
  const { root, defer } = workspace(t, 'facade-watermark');
  const paths = layout(root);
  const clock = { value: 2_000_000 };
  const initialized = initializePublicPurposeLedger({
    filePath: paths.filePath,
    continuityWitnessPath: paths.witnessPath,
    ledgerId: 'welcome-watermark-ledger',
    initializationId: 'synthetic-watermark',
    purposeIdentity: { purposeId: 'welcome', botId: BOT_ID, sourceNamespace: 'discord.guildMemberAdd',
      cutoverJoinedTimestampMs: 1_000_000, freshSourceProofDigest: sha256('synthetic fresh source') },
    now: () => clock.value,
  });
  const open = () => openPublicPurposeLedger({ filePath: paths.filePath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedPurposeIdentity: { purposeId: 'welcome', botId: BOT_ID, sourceNamespace: 'discord.guildMemberAdd' },
    now: () => clock.value });
  const welcome = (memberId, sourceTimeMs) => ({
    operationId: `welcome-${memberId}`,
    sourceKey: 'welcome:guild:10000000000000003',
    sourceEventId: `event.${memberId}`,
    hostPurpose: 'discord.guildMemberAdd',
    scope: 'guild:10000000000000003',
    action: 'welcome-message.create',
    target: '10000000000000004',
    budgetClass: 'none',
    mergeKey: `welcome-${memberId}`,
    payload: { content: `welcome ${memberId}` },
    sourceTimeMs,
  });

  let ledger = open();
  const witnessPaths = [initialized.anchorPath, paths.witnessPath];
  let footprint = writeFootprint(ledger, initialized, witnessPaths);
  const early = ledger.claim(welcome('early', 1_000_000));
  assert.equal(early.kind, 'replay');
  assert.equal(early.operation.status, 'final');
  assert.equal(early.operation.resultCode, 'before_cutover');
  assert.deepEqual(writeFootprint(ledger, initialized, witnessPaths), footprint);
  const delivered = welcome('delivered', 1_500_000);
  const claimed = ledger.claim(delivered);
  ledger.beginDispatch(delivered, claimed.operation.generation);
  ledger.finish(delivered.operationId, claimed.operation.generation, 'confirmed', 'message_confirmed');
  ledger.close();

  clock.value += RETENTION_MS + DAY_MS;
  ledger = open();
  defer(() => ledger.close());
  assert.equal(ledger.getOperation(delivered.operationId), null);
  footprint = writeFootprint(ledger, initialized, witnessPaths);
  const replayed = ledger.claim(delivered);
  assert.equal(replayed.kind, 'replay');
  assert.equal(replayed.operation.status, 'final');
  assert.equal(replayed.operation.resultCode, 'source_watermark');
  assert.equal(ledger.verifyBinding(welcome('older', 1_400_000)).resultCode, 'source_watermark');
  assert.equal(ledger.claim(welcome('newer', 1_600_000)).kind, 'claimed');
  assert.deepEqual(writeFootprint(ledger, initialized, witnessPaths), footprint);
});

test('a failed fence write quarantines the ledger at once, and quarantine() does so on request', (t) => {
  const { root } = workspace(t, 'quarantine');
  const reaction = reactionLedger(root, 'fence-fault');
  let failFenceClose = false;
  const ledger = reaction.open({
    faultInjector: ({ label, phase }) => {
      if (failFenceClose && label === 'close-reaction-fence' && phase === 'before-ledger-write') {
        throw new Error('synthetic fence fault');
      }
    },
  });
  // A plain rejection (invalid input) leaves the ledger usable and unquarantined.
  assert.throws(() => ledger.openReactionFence({ guildId: 'invalid', channelId: CHANNEL_ID, sessionKey: 'x' }),
    (error) => error.code === 'SIDE_EFFECT_FENCE_INVALID');
  assert.equal(ledger.quarantined, false);
  const opened = ledger.openReactionFence({ guildId: GUILD_ID, channelId: CHANNEL_ID,
    sessionKey: 'word-chain.reaction|quarantine' });
  failFenceClose = true;
  assert.throws(() => ledger.closeReactionFence(GUILD_ID, { generation: opened.fence.generation }),
    /synthetic fence fault/u);
  // The marker exists before stop() or close() runs.
  assert.equal(fs.existsSync(reaction.marker), true);
  assert.equal(ledger.quarantined, true);
  assert.equal(ledger.failed, true);
  assert.throws(() => ledger.getReactionFence(GUILD_ID), (error) => error.code === 'SIDE_EFFECT_LEDGER_QUARANTINED');
  ledger.close();
  assert.throws(() => reaction.open(), (error) => error.code === 'SIDE_EFFECT_LEDGER_QUARANTINED');

  const requested = reactionLedger(root, 'requested');
  const handle = requested.open();
  assert.deepEqual(handle.quarantine('synthetic_review'), { kind: 'quarantined', reason: 'synthetic_review' });
  assert.equal(fs.existsSync(requested.marker), true);
  assert.equal(JSON.parse(fs.readFileSync(requested.marker, 'utf8')).reason, 'synthetic_review');
  // A repeated request finds the marker already present and still succeeds.
  assert.deepEqual(handle.quarantine('synthetic_review'), { kind: 'quarantined', reason: 'synthetic_review' });
  handle.close();
  assert.throws(() => requested.open(), (error) => error.code === 'SIDE_EFFECT_LEDGER_QUARANTINED');

  // An invalid reason never stops the quarantine: the default reason is used instead.
  for (const [name, reason] of [['spaces', 'not a valid reason!'], ['object', { reason: 'x' }], ['long', 'x'.repeat(65)]]) {
    const invalid = reactionLedger(root, `invalid-${name}`);
    const ledger = invalid.open();
    assert.deepEqual(ledger.quarantine(reason), { kind: 'quarantined', reason: 'retained-by-runtime' });
    assert.equal(ledger.quarantined, true);
    assert.equal(JSON.parse(fs.readFileSync(invalid.marker, 'utf8')).reason, 'retained-by-runtime');
    ledger.close();
    assert.throws(() => invalid.open(), (error) => error.code === 'SIDE_EFFECT_LEDGER_QUARANTINED');
  }
});

test('a quarantine marker that cannot be written is logged, thrown, recorded, and keeps the ledger disabled',
  (t) => {
    const { root } = workspace(t, 'quarantine-fault');
    const logger = capturingLogger();
    const persistFailures = () => logger.lines.filter(([level, line]) => level === 'error' &&
      line.includes('code=SIDE_EFFECT_QUARANTINE_PERSIST_FAILED')).length;

    const explicit = reactionLedger(root, 'explicit');
    const ledger = explicit.open({
      logger,
      faultInjector: ({ label, phase }) => {
        if (label === 'quarantine' && phase === 'before-quarantine-write') throw new Error('synthetic marker fault');
      },
    });
    assert.throws(() => ledger.quarantine('synthetic_review'), (error) =>
      error.code === 'SIDE_EFFECT_QUARANTINE_PERSIST_FAILED' && /synthetic marker fault/u.test(error.cause?.message));
    assert.equal(ledger.quarantined, true);
    assert.equal(ledger.failed, true);
    assert.match(String(ledger.quarantineFailure?.message), /synthetic marker fault/u);
    assert.throws(() => ledger.openReactionFence({ guildId: GUILD_ID, channelId: CHANNEL_ID, sessionKey: 'x' }),
      (error) => error.code === 'SIDE_EFFECT_LEDGER_QUARANTINED');
    assert.equal(persistFailures(), 1);
    // The log names the ledger and the cause, without any file path.
    const logged = logger.lines.find(([level, line]) => level === 'error' &&
      line.includes('code=SIDE_EFFECT_QUARANTINE_PERSIST_FAILED'))[1];
    assert.match(logged, /ledgerId=word-chain-explicit /u);
    assert.match(logged, /cause=synthetic_marker_fault$/u);
    assert.doesNotMatch(logged, /[\\/]/u);
    // close() retries the marker as a backup; the second failure is logged, not thrown.
    ledger.close();
    assert.equal(persistFailures(), 2);
    assert.equal(fs.existsSync(explicit.marker), false);

    const automatic = reactionLedger(root, 'automatic');
    let failing = false;
    const handle = automatic.open({
      logger,
      faultInjector: ({ label, phase }) => {
        if (failing && ((label === 'close-reaction-fence' && phase === 'before-ledger-write') ||
            (label === 'quarantine' && phase === 'before-quarantine-write'))) {
          throw new Error(`synthetic ${label} fault`);
        }
      },
    });
    const opened = handle.openReactionFence({ guildId: GUILD_ID, channelId: CHANNEL_ID,
      sessionKey: 'word-chain.reaction|automatic' });
    failing = true;
    assert.throws(() => handle.closeReactionFence(GUILD_ID, { generation: opened.fence.generation }), (error) =>
      /synthetic close-reaction-fence fault/u.test(error.message) &&
      error.quarantineError?.code === 'SIDE_EFFECT_QUARANTINE_PERSIST_FAILED');
    assert.equal(handle.quarantined, true);
    assert.equal(persistFailures(), 3);
    handle.close();
  });

test('a crash before stop() still leaves the ledger quarantined after restart', async (t) => {
  const { root, defer } = workspace(t, 'quarantine-crash');
  const reaction = reactionLedger(root, 'crash');
  const child = spawn(process.execPath, [QUARANTINE_HOLDER, reaction.paths.filePath, reaction.initialized.receiptSha256,
    BOT_ID, GUILD_ID, CHANNEL_ID], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  defer(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const [, quarantined] = await waitForLine(child, /QUARANTINED (true|false)/u);
  assert.equal(quarantined, 'true');
  assert.equal(fs.existsSync(reaction.marker), true);
  child.kill('SIGKILL');
  await exited;
  assert.throws(() => reaction.open(), (error) => error.code === 'SIDE_EFFECT_LEDGER_QUARANTINED');
});

test('node:sqlite loads without an ExperimentalWarning on the pinned Node 24.21 runtime', () => {
  assert.match(process.version, /^v24\.21\.\d+$/u);
  const result = spawnSync(process.execPath, ['-e', [
    "const { DatabaseSync } = require('node:sqlite');",
    "const db = new DatabaseSync(':memory:');",
    "db.exec('PRAGMA journal_mode = WAL');",
    'db.close();',
    'setTimeout(() => {}, 50);',
  ].join(' ')], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.doesNotMatch(result.stderr, /ExperimentalWarning|experimental/iu);
  assert.equal(result.stderr, '');
});

// ---------------------------------------------------------------------------
// Decisions, attempt counts, registration continuity, inspection, and paths.
// ---------------------------------------------------------------------------

function decisionInput(index, overrides = {}) {
  return { ...beginInput(index), resultCode: 'never_sent', ...overrides };
}

// Store-level write evidence: commit and change counters, step counters, and the bytes of
// every witness (the database is only stat-ed while it is open).
function storeFootprint(store, witnessPaths) {
  const stats = store.stats();
  return {
    commits: stats.commits,
    totalChanges: stats.totalChanges,
    bootEpoch: stats.bootEpoch,
    beginSeq: stats.beginSeq,
    witnesses: witnessPaths.map((witnessPath) => sha256(fs.readFileSync(witnessPath))),
  };
}

function twoWitnessLayout(root, name = 'ledger') {
  const paths = layout(root, name);
  const secondDirectory = path.join(root, `${name}-witness-2`);
  fs.mkdirSync(secondDirectory);
  return { ...paths, secondWitnessPath: path.join(secondDirectory, 'ledger.witness') };
}

test('a decision is one sequenced step: attempted then not_sent in one transaction, witnessed before it returns',
  (t) => {
    const { root, defer } = workspace(t, 'decide');
    const paths = layout(root);
    createStore(paths, { cutoverMs: 5_000 });
    const clock = { value: 10_000 };
    const phases = [];
    const store = openStore(paths, { clock, faultInjector: ({ label, phase }) => { if (label === 'decide') phases.push(phase); } });
    defer(() => store.close());
    const digest = witnessIdentityDigest(store.identity);
    const witnessBefore = readWitness(paths.witnessPath, digest);
    const before = store.identity;
    const decided = store.recordDecision(decisionInput(1, { resultJson: JSON.stringify({ why: 'cap' }),
      sourceTimeMs: 6_000 }));
    assert.equal(decided.kind, 'recorded');
    assert.equal(decided.operation.state, 'not_sent');
    assert.equal(decided.operation.resultCode, 'never_sent');
    assert.deepEqual(decided.operation.result, { why: 'cap' });
    assert.equal(decided.operation.finishedAtMs, 10_000);
    assert.equal(decided.operation.beginSeq, before.beginSeq + 1);
    // The witness already holds the decision's step when recordDecision returns.
    assert.deepEqual(phases, ['before-commit', 'before-witness-write']);
    const witnessAfter = readWitness(paths.witnessPath, digest);
    assert.equal(witnessAfter.counter, witnessBefore.counter + 1);
    assert.equal(witnessAfter.state.beginSeq, before.beginSeq + 1);
    assert.equal(witnessAfter.state.chainHead, store.identity.chainHead);
    assert.equal(store.identity.chainPrev, before.chainHead);

    // An existing row, a conflicting binding, or a terminal source writes nothing.
    const footprint = storeFootprint(store, [paths.witnessPath]);
    const existing = store.recordDecision(decisionInput(1, { sourceTimeMs: 6_000 }));
    assert.equal(existing.kind, 'existing');
    assert.equal(existing.operation.state, 'not_sent');
    assert.throws(() => store.recordDecision(decisionInput(1, { sourceTimeMs: 6_000,
      bindingJson: '{"other":true}', bindingDigest: sha256('{"other":true}') })),
    (error) => error.code === 'LEDGER_BINDING_CONFLICT');
    const terminal = store.recordDecision(decisionInput(2, { sourceTimeMs: 5_000 }));
    assert.deepEqual(terminal, { kind: 'terminal', reason: 'cutover', boundaryMs: 5_000 });
    assert.deepEqual(storeFootprint(store, [paths.witnessPath]), footprint);
    assert.equal(store.getOperation(PURPOSE, 'operation-2'), null);
    // A decided operation can never begin.
    assert.throws(() => store.begin(beginInput(1, { sourceTimeMs: 6_000 })),
      (error) => error.code === 'LEDGER_TRANSITION_REJECTED');
    assert.equal(store.failed, false);
  });

test('a crash around a decision never loses an acted-on step and never raises a false rollback', async (t) => {
  const { root } = workspace(t, 'decide-crash');
  const clock = { value: 10_000 };

  // Before the commit: nothing was written.
  const before = twoWitnessLayout(root, 'before');
  createLedgerStore({ filePath: before.filePath, witnessPaths: [before.witnessPath, before.secondWitnessPath],
    kind: 'public', ledgerId: 'before-commit', botId: BOT_ID, runtimeMode: 'production', genesisMs: 1_000, cutoverMs: 0 });
  const openBefore = (options = {}) => openLedgerStore({ filePath: before.filePath,
    witnessPaths: [before.witnessPath, before.secondWitnessPath], kind: 'public',
    expected: { botId: BOT_ID, runtimeMode: 'production' }, now: () => clock.value, ...options });
  let store = openBefore({ faultInjector: ({ label, phase }) => {
    if (label === 'decide' && phase === 'before-commit') throw new Error('synthetic crash before commit');
  } });
  const sequence = store.identity.beginSeq;
  assert.throws(() => store.recordDecision(decisionInput(1)), (error) => error.code === 'LEDGER_PERSIST_FAILED');
  assert.equal(store.failed, true);
  store.close();
  store = openBefore();
  assert.equal(store.getOperation(PURPOSE, 'operation-1'), null);
  assert.equal(store.identity.beginSeq, sequence);
  store.close();

  // After the commit, before any witness: the decision stays, one step ahead, accepted.
  const after = twoWitnessLayout(root, 'after');
  createLedgerStore({ filePath: after.filePath, witnessPaths: [after.witnessPath, after.secondWitnessPath],
    kind: 'public', ledgerId: 'after-commit', botId: BOT_ID, runtimeMode: 'production', genesisMs: 1_000, cutoverMs: 0 });
  const openAfter = (options = {}) => openLedgerStore({ filePath: after.filePath,
    witnessPaths: [after.witnessPath, after.secondWitnessPath], kind: 'public',
    expected: { botId: BOT_ID, runtimeMode: 'production' }, now: () => clock.value, ...options });
  let writes = 0;
  store = openAfter({ faultInjector: ({ label, phase }) => {
    if (label === 'decide' && phase === 'before-witness-write') {
      writes += 1;
      // Only the second witness misses the write: the first one is already current.
      if (writes === 2) throw new Error('synthetic witness I/O failure');
    }
  } });
  assert.throws(() => store.recordDecision(decisionInput(1)), (error) => error.code === 'LEDGER_PERSIST_FAILED');
  assert.equal(store.failed, true);
  assert.throws(() => store.recordDecision(decisionInput(2)), (error) => error.code === 'LEDGER_FAILED');
  store.close();
  store = openAfter();
  try {
    assert.equal(store.getOperation(PURPOSE, 'operation-1').state, 'not_sent');
    assert.equal(store.bootSummary.recoveredAttempted, 0);
    assert.equal(store.bootSummary.resynchronizedWitnesses, 1);
    assert.equal(store.recordDecision(decisionInput(1)).kind, 'existing');
  } finally {
    store.close();
  }

  // A real crash (the process is killed between the commit and the witness write).
  const killed = layout(root, 'killed');
  createStore(killed);
  const child = spawn(process.execPath, [CHILD, JSON.stringify({ mode: 'decide-crash', filePath: killed.filePath,
    witnessPaths: [killed.witnessPath], botId: BOT_ID })], { stdio: ['ignore', 'pipe', 'inherit'] });
  let output = '';
  child.stdout.on('data', (chunk) => { output += chunk; });
  await new Promise((resolve) => child.once('exit', resolve));
  assert.match(output, /DECIDING/u);
  assert.doesNotMatch(output, /DECIDED_UNEXPECTEDLY|ERROR/u);
  assert.equal(fs.existsSync(`${killed.filePath}-wal`), true);
  store = openStore(killed, { clock });
  try {
    assert.equal(store.getOperation('synthetic.purpose', 'crash-decision').state, 'not_sent');
    assert.equal(store.bootSummary.quickCheck, 'ok');
    assert.equal(store.bootSummary.resynchronizedWitnesses, 1);
  } finally {
    store.close();
  }
});

test('attempt counts include every row that may have reached the network and never a decision', (t) => {
  const { root, defer } = workspace(t, 'count-attempts');
  const paths = layout(root);
  createStore(paths);
  const clock = { value: 100_000 };
  const store = openStore(paths, { clock });
  defer(() => store.close());
  store.begin(beginInput(1, { claimedAtMs: clock.value }));
  store.finish(finishInput(1, { state: 'confirmed' }));
  clock.value = 200_000;
  store.begin(beginInput(2, { claimedAtMs: clock.value }));
  store.finish(finishInput(2, { state: 'rejected' }));
  store.begin(beginInput(3, { claimedAtMs: clock.value }));
  store.finish(finishInput(3, { state: 'unknown' }));
  store.begin(beginInput(4, { claimedAtMs: clock.value }));
  store.recordDecision(decisionInput(5));
  store.begin(beginInput(6, { claimedAtMs: clock.value }));
  store.finish(finishInput(6, { state: 'not_sent' }));
  const footprint = storeFootprint(store, [paths.witnessPath]);
  assert.equal(store.countAttemptsSince({ purposeId: PURPOSE, sinceMs: 0 }), 4);
  assert.equal(store.countAttemptsSince({ purposeId: PURPOSE, sinceMs: 100_000 }), 3);
  assert.equal(store.countAttemptsSince({ purposeId: PURPOSE, sinceMs: 200_000 }), 0);
  assert.equal(store.countAttemptsSince({ purposeId: 'other.purpose', sinceMs: 0 }), 0);
  assert.throws(() => store.countAttemptsSince({ purposeId: PURPOSE, sinceMs: -1 }),
    (error) => error.code === 'LEDGER_INPUT_INVALID');
  assert.deepEqual(storeFootprint(store, [paths.witnessPath]), footprint);
  // Counted from the ledger, so the count survives a restart.
  store.close();
  const reopened = openStore(paths, { clock });
  defer(() => reopened.close());
  assert.equal(reopened.countAttemptsSince({ purposeId: PURPOSE, sinceMs: 0 }), 4);
});

test('a WAL left by a crash is quick-checked before anything is trusted; a damaged page fails closed', async (t) => {
  const { root, defer } = workspace(t, 'quick-check');
  const paths = layout(root);
  createStore(paths);
  let store = openStore(paths);
  assert.equal(store.bootSummary.quickCheck, null);
  store.close();
  const child = spawn(process.execPath, [HOLDER, paths.filePath, paths.witnessPath, 'begin'],
    { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  defer(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await waitForLine(child, /READY/u);
  child.kill('SIGKILL');
  await exited;
  assert.equal(fs.existsSync(`${paths.filePath}-wal`), true);
  store = openStore(paths);
  assert.equal(store.bootSummary.quickCheck, 'ok');
  store.close();

  // An index pointing at the wrong page passes the schema check but not quick_check.
  const damaged = layout(root, 'damaged');
  createStore(damaged);
  store = openStore(damaged, { clock: { value: 10_000 } });
  store.begin(beginInput(1, { mergeWindowUntilMs: 20_000 }));
  store.finish(finishInput(1));
  store.close();
  const db = new DatabaseSync(damaged.filePath, { defensive: false });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.prepare('PRAGMA journal_mode = WAL').get();
    db.exec('PRAGMA writable_schema = ON');
    db.exec("UPDATE sqlite_schema SET rootpage = (SELECT rootpage FROM sqlite_schema WHERE name = 'identity') " +
      "WHERE name = 'operations_merge'");
    db.exec('PRAGMA writable_schema = OFF');
  } finally {
    db.close();
  }
  const witnessBytes = fs.readFileSync(damaged.witnessPath);
  // Without a WAL the damage is only found by a later read (see the corrupt-read test);
  // an empty WAL, as an unclean close can leave, makes the open check every page first.
  fs.writeFileSync(`${damaged.filePath}-wal`, Buffer.alloc(0));
  assert.throws(() => openStore(damaged), (error) => error.code === 'LEDGER_CORRUPT' &&
    error.detail?.reason === 'quick-check');
  assert.deepEqual(fs.readFileSync(damaged.witnessPath), witnessBytes);
});

test('LEDGER_IN_USE tells a second open in this process from a lock held by another process', async (t) => {
  const { root, defer } = workspace(t, 'in-use-reason');
  const paths = layout(root);
  createStore(paths);
  const store = openStore(paths);
  assert.throws(() => openStore(paths), (error) => error.code === 'LEDGER_IN_USE' &&
    error.detail.reason === 'same-process');
  store.close();
  const child = spawn(process.execPath, [CHILD, JSON.stringify({ mode: 'hold', filePath: paths.filePath,
    witnessPaths: [paths.witnessPath], kind: 'public', botId: BOT_ID, runtimeMode: 'production', holdMs: 0 })],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  defer(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await waitForLine(child, /READY/u);
  assert.throws(() => openStore(paths), (error) => error.code === 'LEDGER_IN_USE' && error.detail.reason === 'locked' &&
    error.retryable === true);
  child.kill('SIGKILL');
  await exited;
});

test('the last recorded state (notBefore) may lag the ledger but never lead it', (t) => {
  const { root } = workspace(t, 'not-before');
  const paths = layout(root);
  createStore(paths);
  const clock = { value: 10_000 };
  let store = openStore(paths, { clock });
  store.begin(beginInput(1));
  const recorded = store.identityCounters;
  store.close();
  const openWith = (notBefore, expected = {}) => openLedgerStore({ filePath: paths.filePath,
    witnessPaths: [paths.witnessPath], kind: 'public', now: () => clock.value,
    expected: { botId: BOT_ID, runtimeMode: 'production', notBefore, ...expected } });
  // Equal (no step since it was recorded) and behind (the record lags) are both accepted.
  store = openWith({ bootEpoch: recorded.bootEpoch, beginSeq: recorded.beginSeq, chainHead: recorded.chainHead });
  const later = store.identityCounters;
  store.close();
  store = openWith({ bootEpoch: recorded.bootEpoch, beginSeq: recorded.beginSeq, chainHead: recorded.chainHead });
  store.close();
  const files = () => [sha256(fs.readFileSync(paths.filePath)), sha256(fs.readFileSync(paths.witnessPath))];
  const unchanged = files();
  const refused = (notBefore, reason) => assert.throws(() => openWith(notBefore), (error) =>
    error.code === 'LEDGER_ROLLBACK' && error.detail.reason === reason);
  refused({ bootEpoch: later.bootEpoch + 5, beginSeq: later.beginSeq, chainHead: later.chainHead }, 'registration-ahead');
  refused({ bootEpoch: later.bootEpoch, beginSeq: later.beginSeq + 1, chainHead: later.chainHead }, 'registration-ahead');
  const current = readWitness(paths.witnessPath, witnessIdentityDigest(createdIdentity(paths))).state;
  refused({ bootEpoch: current.bootEpoch, beginSeq: current.beginSeq, chainHead: 'f'.repeat(64) }, 'registration-fork');
  // A refused open wrote nothing.
  assert.deepEqual(files(), unchanged);
  assert.throws(() => openWith({ bootEpoch: -1, beginSeq: 0, chainHead: 'f'.repeat(64) }),
    (error) => error.code === 'LEDGER_INPUT_INVALID');
  // Each identity field that differs is named.
  const mismatch = (expected, reason, kind = 'public') => assert.throws(() => openLedgerStore({
    filePath: paths.filePath, witnessPaths: [paths.witnessPath], kind, now: () => clock.value,
    expected: { botId: BOT_ID, runtimeMode: 'production', ...expected } }), (error) =>
    error.code === 'LEDGER_IDENTITY_MISMATCH' && error.detail.reason === reason);
  mismatch({ ownerId: OWNER_ID }, 'kind', 'owner');
  mismatch({ ledgerId: 'another-ledger' }, 'ledger-id');
  mismatch({ botId: '10000000000000009' }, 'bot');
  mismatch({ ownerId: OWNER_ID }, 'owner');
  mismatch({ runtimeMode: 'test-control' }, 'runtime-mode');
  mismatch({ cutoverMs: 1 }, 'cutover');
  mismatch({ genesisMs: 999 }, 'genesis');
  assert.deepEqual(files(), unchanged);
});

// The identity a test ledger was created with (createStore defaults).
function createdIdentity() {
  return { ledgerId: 'synthetic-ledger', kind: 'public', genesisMs: 1_000 };
}

test('identityCounters is read from memory only and follows every step', (t) => {
  const { root, defer } = workspace(t, 'counters');
  const paths = layout(root);
  createStore(paths);
  const store = openStore(paths, { clock: { value: 10_000 } });
  defer(() => store.close());
  const reads = [];
  const originals = { readFileSync: fs.readFileSync, openSync: fs.openSync, readSync: fs.readSync };
  for (const name of Object.keys(originals)) {
    fs[name] = (...args) => {
      reads.push(name);
      return originals[name](...args);
    };
  }
  let counters;
  try {
    counters = store.identityCounters;
  } finally {
    Object.assign(fs, originals);
  }
  assert.deepEqual(reads, []);
  assert.deepEqual(counters, { bootEpoch: 1, beginSeq: 0, chainHead: store.identity.chainHead,
    highWaterMs: store.identity.highWaterMs });
  assert.ok(Object.isFrozen(counters));
  store.begin(beginInput(1));
  assert.equal(store.identityCounters.beginSeq, 1);
  assert.equal(store.identityCounters.chainHead, readWitness(paths.witnessPath,
    witnessIdentityDigest(store.identity)).state.chainHead);
});

test('the read-only inspection changes neither the ledger nor its witnesses and reports every finding', async (t) => {
  const { root, defer } = workspace(t, 'inspect');
  const paths = layout(root);
  createStore(paths);
  const clock = { value: 10_000 };
  let store = openStore(paths, { clock });
  const unusedReport = inspectLedgerStore({ filePath: paths.filePath, witnessPaths: [paths.witnessPath] });
  assert.equal(unusedReport.inUse, 'same-process');
  assert.deepEqual(unusedReport.problems, ['in-use']);
  store.begin(beginInput(1, { binding: { action: 'dm-channel.prepare' } }));
  store.finish(finishInput(1));
  store.recordDecision(decisionInput(2));
  // An action named like an inherited property is counted as its own entry.
  store.begin(beginInput(3, { binding: { action: 'constructor' } }));
  store.finish(finishInput(3));
  const recorded = store.identityCounters;
  store.close();
  const before = { database: fs.readFileSync(paths.filePath), witness: fs.readFileSync(paths.witnessPath) };
  const report = inspectLedgerStore({ filePath: paths.filePath, witnessPaths: [paths.witnessPath],
    notBefore: { bootEpoch: recorded.bootEpoch, beginSeq: recorded.beginSeq, chainHead: recorded.chainHead } });
  assert.deepEqual(report.problems, []);
  assert.equal(report.inUse, null);
  assert.equal(report.header, 'ok');
  assert.equal(report.schema, 'ok');
  assert.equal(report.integrity, 'ok');
  assert.equal(report.registration, 'ok');
  assert.equal(report.neverUsed, false);
  assert.equal(report.neverOpened, false);
  assert.deepEqual(report.rows.byState, { confirmed: 2, not_sent: 1 });
  // Counted by the binding's action and state; a row without an action is left out.
  assert.deepEqual(JSON.parse(JSON.stringify(report.rows.byAction)),
    { 'dm-channel.prepare': { confirmed: 1 }, constructor: { confirmed: 1 } });
  assert.equal(typeof Object.prototype.constructor.confirmed, 'undefined');
  assert.equal(report.rows.digestFailures, 0);
  assert.equal(report.witnesses[0].continuity, 'ok');
  assert.deepEqual(report.witnesses[0].tornSlots, []);
  assert.equal(report.database.walPresent, false);
  // Nothing was booted, recovered, pruned, or resynchronized.
  assert.ok(before.database.equals(fs.readFileSync(paths.filePath)));
  assert.ok(before.witness.equals(fs.readFileSync(paths.witnessPath)));
  store = openStore(paths, { clock });
  assert.equal(store.identity.bootEpoch, recorded.bootEpoch + 1);
  store.close();

  const fresh = layout(root, 'fresh');
  createStore(fresh);
  const freshReport = inspectLedgerStore({ filePath: fresh.filePath, witnessPaths: [fresh.witnessPath] });
  assert.equal(freshReport.neverUsed, true);
  assert.equal(freshReport.neverOpened, true);
  assert.equal(inspectLedgerStore({ filePath: fresh.filePath, witnessPaths: [fresh.witnessPath],
    notBefore: { bootEpoch: 3, beginSeq: 0, chainHead: 'a'.repeat(64) } }).registration, 'registration-ahead');
  const missing = inspectLedgerStore({ filePath: path.join(root, 'none.sqlite'), witnessPaths: [] });
  assert.deepEqual(missing.problems, ['database-missing']);

  // Another process holding the ledger: reported as in use, nothing else is read.
  const child = spawn(process.execPath, [CHILD, JSON.stringify({ mode: 'hold', filePath: paths.filePath,
    witnessPaths: [paths.witnessPath], kind: 'public', botId: BOT_ID, runtimeMode: 'production', holdMs: 0 })],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  defer(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  await waitForLine(child, /READY/u);
  const held = inspectLedgerStore({ filePath: paths.filePath, witnessPaths: [paths.witnessPath] });
  assert.equal(held.inUse, 'locked');
  assert.equal(held.integrity, null);
  child.kill('SIGKILL');
  await exited;

  // A damaged row digest and a torn witness are findings, not exceptions.
  const tampered = layout(root, 'tampered');
  createStore(tampered);
  store = openStore(tampered, { clock });
  store.begin(beginInput(1));
  store.close();
  const db = directConnection(tampered.filePath);
  try {
    // A writer with file access can drop a trigger, change a row, and restore the trigger.
    const trigger = db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'operations_terminal_once'").get().sql;
    db.exec('DROP TRIGGER operations_terminal_once');
    db.prepare("UPDATE operations SET binding_json = '{\"forged\":true}' WHERE operation_id = 'operation-1'").run();
    db.exec(trigger);
  } finally {
    db.close();
  }
  const bytes = fs.readFileSync(tampered.witnessPath);
  bytes.fill(0, 128, WITNESS_SLOT_BYTES * 2);
  fs.writeFileSync(tampered.witnessPath, bytes);
  const tamperedReport = inspectLedgerStore({ filePath: tampered.filePath, witnessPaths: [tampered.witnessPath] });
  assert.equal(tamperedReport.schema, 'ok');
  assert.equal(tamperedReport.rows.digestFailures, 1);
  assert.ok(tamperedReport.problems.includes('row-digest'));
  assert.ok(tamperedReport.problems.includes('witness-torn'));
});

test('UNC and device paths are refused by the store before any file is touched', (t) => {
  const { root } = workspace(t, 'store-remote');
  const paths = layout(root);
  // Mixed separators become UNC paths only once Windows resolves them.
  const mixed = process.platform === 'win32' ? ['/\\server\\share\\ledger.sqlite', '\\/server/share/ledger.sqlite'] : [];
  const remote = ['\\\\localhost\\c$\\ledger.sqlite', '//server/share/ledger.sqlite', '\\\\?\\C:\\ledger.sqlite',
    '\\\\.\\C:\\ledger.sqlite', ...mixed];
  const touched = [];
  const originals = { lstatSync: fs.lstatSync, openSync: fs.openSync, realpathSync: fs.realpathSync };
  for (const name of Object.keys(originals)) {
    fs[name] = function spy(target, ...rest) {
      if (/server|localhost|\\\\[?.]\\/u.test(String(target))) touched.push([name, String(target)]);
      return originals[name].call(this, target, ...rest);
    };
  }
  fs.realpathSync.native = originals.realpathSync.native;
  t.after(() => Object.assign(fs, originals));
  for (const value of remote) {
    assert.throws(() => createLedgerStore({ filePath: value, witnessPaths: [paths.witnessPath], kind: 'public',
      ledgerId: 'remote', botId: BOT_ID, runtimeMode: 'production', genesisMs: 1, cutoverMs: 0 }),
    (error) => error.code === 'LEDGER_PATH_REMOTE', value);
    assert.throws(() => createLedgerStore({ filePath: paths.filePath, witnessPaths: [value], kind: 'public',
      ledgerId: 'remote', botId: BOT_ID, runtimeMode: 'production', genesisMs: 1, cutoverMs: 0 }),
    (error) => error.code === 'LEDGER_PATH_REMOTE', value);
    assert.throws(() => openLedgerStore({ filePath: value, witnessPaths: [paths.witnessPath], kind: 'public',
      expected: { botId: BOT_ID, runtimeMode: 'production' } }), (error) => error.code === 'LEDGER_PATH_REMOTE', value);
    assert.throws(() => inspectLedgerStore({ filePath: value }), (error) => error.code === 'LEDGER_PATH_REMOTE', value);
  }
  Object.assign(fs, originals);
  assert.deepEqual(touched, []);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.filePath)), []);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.witnessPath)), []);
});

test('attempted rows the last holder never finished make the open quick-check even without a WAL', (t) => {
  const { root } = workspace(t, 'quick-check-attempted');
  const clock = { value: 10_000 };
  // A clean ledger with an unfinished attempt (as after a crash whose WAL an operator
  // inspection already merged): checked, then recovered as unknown.
  const clean = layout(root, 'clean');
  createStore(clean);
  let store = openStore(clean, { clock });
  store.begin(beginInput(1));
  store.close();
  assert.equal(fs.existsSync(`${clean.filePath}-wal`), false);
  store = openStore(clean, { clock });
  assert.deepEqual([store.bootSummary.quickCheck, store.bootSummary.quickCheckTrigger], ['ok', 'attempted']);
  assert.equal(store.getOperation(PURPOSE, 'operation-1').state, 'unknown');
  store.close();
  store = openStore(clean, { clock });
  assert.deepEqual([store.bootSummary.quickCheck, store.bootSummary.quickCheckTrigger], [null, null]);
  store.close();

  // The same unfinished attempt over a damaged index page: refused before anything is
  // written, and the files are left as they were.
  const damaged = layout(root, 'damaged');
  createStore(damaged);
  store = openStore(damaged, { clock });
  store.begin(beginInput(1, { mergeWindowUntilMs: 20_000 }));
  store.finish(finishInput(1));
  store.begin(beginInput(2));
  store.close();
  const db = new DatabaseSync(damaged.filePath, { defensive: false });
  try {
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    db.prepare('PRAGMA journal_mode = WAL').get();
    db.exec('PRAGMA writable_schema = ON');
    db.exec("UPDATE sqlite_schema SET rootpage = (SELECT rootpage FROM sqlite_schema WHERE name = 'identity') " +
      "WHERE name = 'operations_merge'");
    db.exec('PRAGMA writable_schema = OFF');
  } finally {
    db.close();
  }
  const before = [sha256(fs.readFileSync(damaged.filePath)), sha256(fs.readFileSync(damaged.witnessPath))];
  assert.equal(fs.existsSync(`${damaged.filePath}-wal`), false);
  assert.throws(() => openStore(damaged, { clock }), (error) => error.code === 'LEDGER_CORRUPT' &&
    error.detail?.reason === 'quick-check');
  assert.deepEqual([sha256(fs.readFileSync(damaged.filePath)), sha256(fs.readFileSync(damaged.witnessPath))], before);
});

test('fault injection while creating a ledger is accepted only inside the test runner', (t) => {
  const { root } = workspace(t, 'create-injector');
  const paths = layout(root);
  const script = `
    const [storeModule, filePath, witnessPath, botId] = process.argv.slice(1);
    try {
      require(storeModule).createLedgerStore({ filePath, witnessPaths: [witnessPath], kind: 'public', ledgerId: 'x',
        botId, runtimeMode: 'production', genesisMs: 1, cutoverMs: 0, faultInjector: () => {} });
      process.stdout.write('accepted');
    } catch (error) { process.stdout.write(String(error.code)); }
  `;
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['-e', script, STORE_MODULE, paths.filePath, paths.witnessPath, BOT_ID],
    { env, encoding: 'utf8' });
  assert.equal(result.stdout, 'LEDGER_INPUT_INVALID', result.stderr);
  assert.deepEqual(fs.readdirSync(path.dirname(paths.filePath)), []);
  // Inside the runner the phases are reported, and a failure leaves the database without witnesses.
  const phases = [];
  assert.throws(() => createLedgerStore({ filePath: paths.filePath, witnessPaths: [paths.witnessPath], kind: 'public',
    ledgerId: 'x', botId: BOT_ID, runtimeMode: 'production', genesisMs: 1, cutoverMs: 0,
    faultInjector: ({ label, phase }) => {
      phases.push(`${label}:${phase}`);
      if (phase === 'after-database') throw new Error('synthetic crash');
    } }), (error) => error.code === 'LEDGER_PERSIST_FAILED');
  assert.deepEqual(phases, ['create:after-database']);
  assert.equal(fs.existsSync(paths.filePath), true);
  assert.equal(fs.existsSync(paths.witnessPath), false);
});

test('renameWithRetry backs off on Windows sharing refusals, then succeeds or gives up with both names untouched',
  async (t) => {
    const { root, defer } = workspace(t, 'rename-retry');
    const from = path.join(root, 'staged.bin');
    const to = path.join(root, 'final.bin');
    const refusal = (code) => Object.assign(new Error(`synthetic ${code}`), { code });
    const sleeps = [];
    const sleep = async (ms) => { sleeps.push(ms); };

    // Two refusals, then the real rename: three attempts, waits doubling from 25 ms.
    fs.writeFileSync(from, 'payload');
    let calls = 0;
    const attempts = await renameWithRetry(from, to, { platform: 'win32', sleep, rename: (source, target) => {
      calls += 1;
      if (calls === 1) throw refusal('EPERM');
      if (calls === 2) throw refusal('EBUSY');
      fs.renameSync(source, target);
    } });
    assert.equal(attempts, 3);
    assert.deepEqual(sleeps, [25, 50]);
    assert.equal(fs.existsSync(from), false);
    assert.equal(fs.readFileSync(to, 'utf8'), 'payload');

    // Refused every time: the last refusal is thrown after the limit, waits capped at one second.
    fs.writeFileSync(from, 'second');
    sleeps.length = 0;
    let refused = 0;
    await assert.rejects(renameWithRetry(from, path.join(root, 'other.bin'), { platform: 'win32', sleep,
      rename: () => { refused += 1; throw refusal('EACCES'); } }), (error) => error.code === 'EACCES');
    assert.equal(refused, 8);
    assert.deepEqual(sleeps, [25, 50, 100, 200, 400, 800, 1_000]);
    assert.equal(fs.readFileSync(from, 'utf8'), 'second');
    assert.equal(fs.existsSync(path.join(root, 'other.bin')), false);

    // Other platforms and other codes fail at once, without waiting.
    sleeps.length = 0;
    for (const [platform, code] of [['linux', 'EPERM'], ['darwin', 'EBUSY'], ['win32', 'ENOENT'], ['win32', 'EEXIST']]) {
      let tries = 0;
      await assert.rejects(renameWithRetry(from, to, { platform, sleep,
        rename: () => { tries += 1; throw refusal(code); } }), (error) => error.code === code);
      assert.equal(tries, 1, `${platform} ${code}`);
    }
    assert.deepEqual(sleeps, []);

    // A real file held open by SQLite cannot be renamed on Windows: every retry is refused and
    // both names stay exactly as they were; once released, the same call succeeds.
    if (process.platform === 'win32') {
      const held = path.join(root, 'held.sqlite');
      const target = path.join(root, 'held-final.sqlite');
      const setup = new DatabaseSync(held);
      setup.exec('CREATE TABLE t (x)');
      setup.close();
      const before = fs.readFileSync(held);
      const holder = new DatabaseSync(held);
      defer(() => holder.close());
      sleeps.length = 0;
      await assert.rejects(renameWithRetry(held, target, { sleep, attempts: 3 }),
        (error) => ['EBUSY', 'EPERM', 'EACCES'].includes(error.code));
      assert.deepEqual(sleeps, [25, 50]);
      assert.deepEqual(fs.readFileSync(held), before);
      assert.equal(fs.existsSync(target), false);
      holder.close();
      assert.equal(await renameWithRetry(held, target, { sleep }), 1);
      assert.deepEqual(fs.readFileSync(target), before);
    }
  });
