'use strict';

// The liveness record and the outage it finds: a stop nobody asked for that lasted ten minutes,
// or a connection that was gone as long. Each "process" below is one monitor with its own logger
// and heartbeat timer; one that is simply dropped stands for a process that crashed.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Client, GatewayIntentBits, Status, WebSocketShard } = require('discord.js');
const {
  WebSocketManager: GatewayManager,
  WebSocketShardEvents: GatewayEvents,
} = require('@discordjs/ws');
const { makeRealTempDir } = require('./support/realTempDir');
const { TEST_DATA_ROOT_MARKER } = require('../src/platform/testControlPolicy');
const {
  HEARTBEAT_MS,
  MAX_FILE_BYTES,
  MIN_OUTAGE_MS,
  PENDING_EXPIRES_MS,
  RESTORE_REPEAT_MS,
  STABLE_AFTER_READY_MS,
  STATE_FILE_NAME,
  createOutageMonitor,
  defaultGatewayHealthy,
  outageIdFor,
  parseStateText,
  restoreEvidenceOf,
  restoreSignsOf,
} = require('../src/systems/safety/outageMonitor');
const { STABLE_AFTER_READY_MS: GUARD_STABLE_MS } = require('../src/systems/safety/ownerDmStartGuard');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const BASE_MS = 1_800_000_000_000;
const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';

function capturingLogger() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(['info', String(line)]),
    warn: (line) => lines.push(['warn', String(line)]),
    error: (line) => lines.push(['error', String(line)]),
  };
}

function dataRoot(t) {
  const root = makeRealTempDir('xiaoji-outage-monitor-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function statePath(root) {
  return path.join(root, STATE_FILE_NAME);
}

function readState(root) {
  return JSON.parse(fs.readFileSync(statePath(root), 'utf8'));
}

// One process of the bot, as far as the monitor sees it. clock.value is the wall clock, and the
// monotonic clock too unless `mono` ({ value }) is given, which is how a test sets the wall clock
// without time passing; client.ready is what the injected health function (the client's isReady())
// answers. The health function of a real client is tested with a real client, below.
function startProcess(root, { clock = { value: BASE_MS }, mono = null, runtimeMode = 'production',
  env = { XIAOJI_DATA_ROOT: root }, begin = true, ...options } = {}) {
  const logger = capturingLogger();
  const intervals = [];
  const client = { ready: true, isReady() { return this.ready; } };
  const monitor = createOutageMonitor({
    runtimeMode,
    env,
    coinDbPath: path.join(root, 'xiaoji.sqlite'),
    logger,
    now: () => clock.value,
    monotonic: () => (mono ? mono.value : clock.value),
    gatewayHealthy: (candidate) => candidate.isReady(),
    setIntervalFn: (callback, ms) => {
      const timer = { callback, ms, cleared: false, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => { timer.cleared = true; },
    ...options,
  });
  const begun = begin ? monitor.begin() : null;
  return {
    monitor,
    begun,
    logger,
    clock,
    client,
    intervals,
    lines: () => logger.lines.map(([, line]) => line),
    ready(extra) { return monitor.noteReady(client, extra); },
    // One heartbeat, `ms` after the last thing that happened.
    async tickAfter(ms) {
      clock.value += ms;
      return monitor.tick();
    },
    // The clock moves `ms` on with a heartbeat every `step` (a minute, as in a running process;
    // a jump with none in between is a gap, which the monitor reads as a lost connection).
    async advance(ms, step = HEARTBEAT_MS) {
      let left = ms;
      while (left > 0) {
        const part = Math.min(step, left);
        clock.value += part;
        left -= part;
        await monitor.tick();
      }
    },
  };
}

// A run of a bot that was ready at `readyAt` and kept its heartbeat until `lastBeat`, and then
// ended with no signal.
async function crashedRun(root, { readyAt = BASE_MS, lastBeat = readyAt } = {}) {
  const run = startProcess(root, { clock: { value: readyAt } });
  run.ready();
  for (let at = readyAt + HEARTBEAT_MS; at <= lastBeat; at += HEARTBEAT_MS) {
    run.clock.value = at;
    await run.monitor.tick();
  }
  return run;
}

const DETECTED = (kind, minutes) => `[OUTAGE_MONITOR] code=OUTAGE_DETECTED kind=${kind} minutes=${minutes}`;

test('the numbers are the ones decided: a minute heartbeat, a ten minute outage, steady after ten minutes thirty seconds', () => {
  assert.equal(HEARTBEAT_MS, 60_000);
  assert.equal(MIN_OUTAGE_MS, 10 * MINUTE);
  assert.equal(STABLE_AFTER_READY_MS, GUARD_STABLE_MS + 30_000);
  assert.equal(GUARD_STABLE_MS, 10 * MINUTE);
  assert.equal(PENDING_EXPIRES_MS, 72 * HOUR);
  assert.equal(STATE_FILE_NAME, 'outage-state.json');
});

test('a normal stop (SIGINT or SIGTERM) is planned: whatever the gap, the next start tells nothing', async (t) => {
  const root = dataRoot(t);
  const first = startProcess(root);
  assert.deepEqual(first.begun, { mode: 'active', ready: false, previous: 'unknown', pending: false, stopped: false });
  first.ready();
  await first.tickAfter(5 * MINUTE);
  first.monitor.noteSignalStop();
  assert.deepEqual(readState(root).stop, { kind: 'signal', atMs: BASE_MS + 5 * MINUTE });
  // A day later, another start: nothing is an outage.
  const second = startProcess(root, { clock: { value: BASE_MS + 24 * HOUR } });
  assert.equal(second.begun.previous, 'planned');
  second.ready();
  assert.equal(second.monitor.status().pending, false);
  assert.equal(readState(root).pending, null);
  assert.deepEqual(readState(root).stop, { kind: 'running', atMs: BASE_MS + 24 * HOUR });
  assert.deepEqual(second.lines().filter((text) => text.includes('OUTAGE_DETECTED')), []);
});

test('the signal is written at once, and neither a later heartbeat nor the stop changes it back', async (t) => {
  const root = dataRoot(t);
  const run = startProcess(root);
  run.ready();
  const timer = run.intervals[0];
  run.clock.value += MINUTE;
  run.monitor.noteSignalStop();
  assert.equal(timer.cleared, true, 'the heartbeat is stopped');
  const written = fs.readFileSync(statePath(root), 'utf8');
  // A late heartbeat, the stop of index.js and a second signal all leave the record as it is.
  run.clock.value += MINUTE;
  await timer.callback();
  run.monitor.stop();
  run.monitor.noteSignalStop();
  assert.equal(fs.readFileSync(statePath(root), 'utf8'), written);
});

test('a crash is an outage from the last healthy moment to the next ready, and ten minutes is the line', async (t) => {
  for (const [gapMs, expected] of [[10 * MINUTE - 1, false], [10 * MINUTE, true], [10 * MINUTE + 1, true]]) {
    const root = dataRoot(t);
    // Ready at BASE_MS, heartbeat to BASE_MS + 3 min, then nothing: the process was killed.
    await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS + 3 * MINUTE });
    const readyAt = BASE_MS + 3 * MINUTE + gapMs;
    const next = startProcess(root, { clock: { value: readyAt - MINUTE } });
    assert.equal(next.begun.previous, 'unplanned', String(gapMs));
    next.clock.value = readyAt;
    next.ready();
    const { pending } = readState(root);
    if (!expected) {
      assert.equal(pending, null, `${gapMs}`);
      assert.deepEqual(next.lines().filter((text) => text.includes('OUTAGE_DETECTED')), []);
      continue;
    }
    assert.ok(pending, `${gapMs}`);
    assert.deepEqual([pending.startedAtMs, pending.endedAtMs, pending.kind, pending.owner, pending.recovery],
      [BASE_MS + 3 * MINUTE, readyAt, 'crash', 'none', []]);
    assert.equal(pending.id, outageIdFor(BASE_MS + 3 * MINUTE));
    assert.deepEqual(pending.guilds, {});
    assert.ok(next.lines().includes(DETECTED('crash', 10)), next.lines().join('\n'));
  }
});

test('starts that never became ready keep measuring from the last healthy moment', async (t) => {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS + 2 * MINUTE });
  // Three starts in a row die before ready, over an hour and a half.
  for (const at of [BASE_MS + 30 * MINUTE, BASE_MS + 60 * MINUTE, BASE_MS + 90 * MINUTE]) {
    const failed = startProcess(root, { clock: { value: at } });
    assert.equal(failed.begun.previous, 'unplanned');
    assert.equal(readState(root).lastHealthyAtMs, BASE_MS + 2 * MINUTE, 'not overwritten before ready');
    assert.equal(readState(root).readyAtMs, null);
  }
  const ready = startProcess(root, { clock: { value: BASE_MS + 100 * MINUTE } });
  ready.ready();
  const { pending, lastHealthyAtMs } = readState(root);
  assert.deepEqual([pending.startedAtMs, pending.endedAtMs, pending.kind], [BASE_MS + 2 * MINUTE, BASE_MS + 100 * MINUTE, 'crash']);
  assert.equal(lastHealthyAtMs, BASE_MS + 100 * MINUTE, 'ready is the first healthy moment of this run');
});

test('a restart storm is one pending outage: its start stays, its end moves, and a short gap extends it', async (t) => {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS });
  let readyAt = BASE_MS + 15 * MINUTE;
  const ids = new Set();
  // Five starts in a row, each ready for two minutes and then killed.
  for (let run = 0; run < 5; run += 1) {
    const started = startProcess(root, { clock: { value: readyAt } });
    assert.equal(started.begun.previous, 'unplanned');
    started.ready();
    started.clock.value = readyAt + 2 * MINUTE;
    await started.monitor.tick();
    const { pending } = readState(root);
    assert.equal(pending.startedAtMs, BASE_MS, `run ${run}`);
    assert.equal(pending.endedAtMs, readyAt, `run ${run}`);
    ids.add(pending.id);
    readyAt += 3 * MINUTE;
  }
  assert.equal(ids.size, 1, 'one outage, one identity');
  assert.deepEqual([...ids], [outageIdFor(BASE_MS)]);
});

test('a first start, and one after runs that were never healthy, have nothing to measure from', async (t) => {
  const root = dataRoot(t);
  // A first ever start: no record at all.
  const first = startProcess(root);
  assert.equal(first.begun.previous, 'unknown');
  assert.deepEqual(first.lines(), ['[OUTAGE_MONITOR] code=OUTAGE_PREVIOUS_ABSENT']);
  first.ready();
  await first.tickAfter(MINUTE);
  // It crashed before it was ever ready for an hour: a record with no healthy moment is unknown.
  fs.rmSync(statePath(root));
  const neverHealthy = startProcess(root, { clock: { value: BASE_MS } });
  const second = startProcess(root, { clock: { value: BASE_MS + HOUR } });
  assert.equal(neverHealthy.begun.previous, 'unknown');
  assert.equal(second.begun.previous, 'unknown');
  assert.deepEqual(second.lines(), ['[OUTAGE_MONITOR] code=OUTAGE_PREVIOUS_UNKNOWN reason=never-healthy']);
  second.clock.value = BASE_MS + 2 * HOUR;
  second.ready();
  assert.equal(readState(root).pending, null);
});

test('a record that cannot be read or trusted is unknown: nothing is told and one fixed line says so', async (t) => {
  const root = dataRoot(t);
  const file = statePath(root);
  const valid = JSON.parse((await (async () => {
    await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS + 2 * MINUTE });
    return fs.readFileSync(file, 'utf8');
  })()));
  for (const [label, text] of [
    ['not json', 'not json'],
    ['another schema', JSON.stringify({ ...valid, schema: 2 })],
    ['an extra key', JSON.stringify({ ...valid, extra: true })],
    ['a missing key', JSON.stringify({ ...valid, bootId: undefined })],
    ['a bad time', JSON.stringify({ ...valid, lastHealthyAtMs: -1 })],
    ['a bad stop', JSON.stringify({ ...valid, stop: { kind: 'maybe', atMs: 1 } })],
    ['a pending that does not match its id', JSON.stringify({ ...valid, pending: {
      id: 'a'.repeat(32), startedAtMs: 1, endedAtMs: 2, kind: 'crash', recovery: [], createdAtMs: 1, owner: 'none',
      guilds: {} } })],
    ['too large', `{"pad":"${'x'.repeat(MAX_FILE_BYTES)}"}`],
  ]) {
    fs.writeFileSync(file, text);
    const run = startProcess(root, { clock: { value: BASE_MS + HOUR } });
    assert.equal(run.begun.previous, 'unknown', label);
    assert.deepEqual(run.lines(), ['[OUTAGE_MONITOR] code=OUTAGE_PREVIOUS_INVALID'], label);
    run.ready();
    assert.equal(readState(root).pending, null, label);
    // The run overwrote it with a record of its own.
    assert.deepEqual(Object.keys(readState(root)).sort(),
      ['bootId', 'guildNoticeAtMs', 'lastHealthyAtMs', 'pending', 'readyAtMs', 'restoreSeen', 'schema', 'startedAtMs',
        'stop']);
  }
  // A name taken by a folder is never written over, and the run goes on.
  fs.rmSync(file);
  fs.mkdirSync(file);
  const folder = startProcess(root, { clock: { value: BASE_MS + 2 * HOUR } });
  assert.equal(folder.begun.previous, 'unknown');
  assert.ok(folder.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_PREVIOUS_INVALID'));
  assert.ok(folder.lines().some((text) => text.startsWith('[OUTAGE_MONITOR] code=OUTAGE_STATE_WRITE_FAILED stage=start')));
  assert.equal(fs.statSync(file).isDirectory(), true);
  assert.doesNotThrow(() => folder.ready());
});

test('a file that cannot be read (an I/O error) is unknown too, and the start goes on', (t) => {
  const root = dataRoot(t);
  const file = statePath(root);
  fs.writeFileSync(file, '{}');
  const failing = { ...fs, lstatSync: (target, ...rest) => {
    if (String(target) === file) throw Object.assign(new Error('synthetic'), { code: 'EIO' });
    return fs.lstatSync(target, ...rest);
  } };
  const run = startProcess(root, { filesystem: failing });
  assert.equal(run.begun.previous, 'unknown');
  assert.equal(run.begun.mode, 'active');
  assert.equal(run.lines()[0], '[OUTAGE_MONITOR] code=OUTAGE_PREVIOUS_UNREADABLE cause=EIO');
});

test('a temporary file left by a cut-off write is not read, and is replaced by the next write', async (t) => {
  const root = dataRoot(t);
  const file = statePath(root);
  fs.writeFileSync(`${file}.tmp`, JSON.stringify({ half: 'written' }));
  // Without a record, the leftover alone says nothing.
  const lonely = startProcess(root);
  assert.equal(lonely.begun.previous, 'unknown');
  assert.deepEqual(fs.readdirSync(root), [STATE_FILE_NAME]);
  lonely.ready();
  // With a record, the record decides and the leftover is replaced.
  fs.writeFileSync(`${file}.tmp`, 'half');
  const next = startProcess(root, { clock: { value: BASE_MS + 20 * MINUTE } });
  assert.equal(next.begun.previous, 'unplanned');
  assert.deepEqual(fs.readdirSync(root), [STATE_FILE_NAME]);
  // A name taken by a folder is refused and nothing is left behind.
  fs.rmSync(file);
  fs.mkdirSync(`${file}.tmp`);
  const blocked = startProcess(root);
  assert.ok(blocked.lines().some((text) => text.includes('OUTAGE_STATE_WRITE_FAILED stage=start cause=OUTAGE_STATE_FILE_INVALID')));
  assert.equal(fs.existsSync(file), false);
});

test('a clock set back is unknown: no outage and no sending', async (t) => {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS + 10 * HOUR, lastBeat: BASE_MS + 10 * HOUR + 2 * MINUTE });
  const run = startProcess(root, { clock: { value: BASE_MS } });
  assert.equal(run.begun.previous, 'unknown');
  assert.deepEqual(run.lines(), ['[OUTAGE_MONITOR] code=OUTAGE_CLOCK_BEHIND stage=start']);
  run.ready();
  assert.equal(readState(root).pending, null);
  // Within the tolerance of five minutes it is still a crash (a clock a little behind).
  const root2 = dataRoot(t);
  await crashedRun(root2, { readyAt: BASE_MS + 10 * HOUR, lastBeat: BASE_MS + 10 * HOUR });
  const near = startProcess(root2, { clock: { value: BASE_MS + 10 * HOUR - 5 * MINUTE } });
  assert.equal(near.begun.previous, 'unplanned');
});

test('the process lives but the gateway does not: ten minutes without a ready client is a connection outage', async (t) => {
  for (const [gapMs, expected] of [[10 * MINUTE - 1, false], [10 * MINUTE, true], [10 * MINUTE + 1, true]]) {
    const root = dataRoot(t);
    const run = startProcess(root);
    run.ready();
    assert.equal(run.intervals.length, 1);
    assert.equal(run.intervals[0].ms, HEARTBEAT_MS);
    // The last healthy heartbeat, then the gateway goes away; heartbeats while it is gone move nothing.
    await run.tickAfter(MINUTE);
    const lastHealthy = run.clock.value;
    run.client.ready = false;
    await run.tickAfter(4 * MINUTE);
    await run.tickAfter(4 * MINUTE);
    assert.equal(readState(root).lastHealthyAtMs, lastHealthy);
    assert.equal(readState(root).pending, null);
    // It comes back; the first heartbeat after that finds the gap.
    run.client.ready = true;
    run.clock.value = lastHealthy + gapMs;
    await run.monitor.tick();
    const { pending, lastHealthyAtMs } = readState(root);
    assert.equal(lastHealthyAtMs, lastHealthy + gapMs);
    if (!expected) {
      assert.equal(pending, null, `${gapMs}`);
      continue;
    }
    assert.deepEqual([pending.startedAtMs, pending.endedAtMs, pending.kind], [lastHealthy, lastHealthy + gapMs, 'connection']);
    assert.ok(run.lines().includes(DETECTED('connection', 10)), run.lines().join('\n'));
  }
});

test('a connection outage extends a pending crash instead of making a second outage', async (t) => {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS });
  const run = startProcess(root, { clock: { value: BASE_MS + 20 * MINUTE } });
  run.ready();
  const first = readState(root).pending;
  assert.deepEqual([first.startedAtMs, first.endedAtMs, first.kind], [BASE_MS, BASE_MS + 20 * MINUTE, 'crash']);
  run.client.ready = false;
  run.clock.value += 15 * MINUTE;
  await run.monitor.tick();
  run.client.ready = true;
  run.clock.value += MINUTE;
  await run.monitor.tick();
  const merged = readState(root).pending;
  assert.deepEqual([merged.id, merged.startedAtMs, merged.endedAtMs, merged.kind], [first.id, BASE_MS, run.clock.value, 'crash']);
});

test('the heartbeat only moves lastHealthyAtMs while the client is ready, and writes the file without touching a stop', async (t) => {
  const root = dataRoot(t);
  const run = startProcess(root);
  run.ready();
  const before = readState(root);
  assert.equal(before.readyAtMs, BASE_MS);
  assert.equal(before.lastHealthyAtMs, BASE_MS);
  await run.tickAfter(MINUTE);
  assert.equal(readState(root).lastHealthyAtMs, BASE_MS + MINUTE);
  run.client.ready = false;
  await run.tickAfter(MINUTE);
  assert.equal(readState(root).lastHealthyAtMs, BASE_MS + MINUTE);
  // Nothing else changed.
  const after = readState(root);
  assert.deepEqual({ ...after, lastHealthyAtMs: 0 }, { ...before, lastHealthyAtMs: 0 });
  // A client that is not ready at the first heartbeat after a start moves nothing either.
  assert.equal(run.intervals.length, 1);
});

test('test-control reads and writes nothing, whatever the data root, and starts no timer', async (t) => {
  const root = dataRoot(t);
  // Even with a production record next to it: five test-control runs that all fail.
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS + MINUTE });
  const before = fs.readFileSync(statePath(root));
  for (let run = 0; run < 5; run += 1) {
    const testControl = startProcess(root, { runtimeMode: 'test-control', clock: { value: BASE_MS + (run + 1) * HOUR } });
    assert.equal(testControl.begun.mode, 'inactive');
    testControl.ready();
    await testControl.tickAfter(MINUTE);
    testControl.monitor.noteSignalStop();
    testControl.monitor.stop();
    assert.deepEqual([testControl.intervals.length, testControl.lines()], [0, []]);
  }
  assert.deepEqual(fs.readFileSync(statePath(root)), before);
  assert.deepEqual(fs.readdirSync(root), [STATE_FILE_NAME]);
  // A test-control data root with no record gets none.
  const empty = dataRoot(t);
  const quiet = startProcess(empty, { runtimeMode: 'test-control' });
  quiet.ready();
  assert.deepEqual(fs.readdirSync(empty), []);
});

test('without a usable location the monitor is off, with one line, and writes nothing', (t) => {
  const root = dataRoot(t);
  const missing = path.join(root, 'missing');
  const absent = startProcess(root, { env: { XIAOJI_DATA_ROOT: missing } });
  assert.equal(absent.begun.mode, 'unavailable');
  assert.deepEqual(absent.lines(),
    ['[OUTAGE_MONITOR] code=OUTAGE_MONITOR_UNAVAILABLE cause=LEDGER_PATH_INVALID reason=base-missing']);
  absent.ready();
  absent.monitor.noteSignalStop();
  assert.deepEqual([absent.intervals.length, fs.existsSync(missing)], [0, false]);
  // Inside the program folder (as the default coin database is): refused.
  const inside = startProcess(root, { env: { XIAOJI_DATA_ROOT: __dirname } });
  assert.deepEqual(inside.lines(), ['[OUTAGE_MONITOR] code=OUTAGE_MONITOR_UNAVAILABLE cause=LEDGER_PATH_IN_PROJECT reason=base']);
  assert.equal(fs.existsSync(path.join(__dirname, STATE_FILE_NAME)), false);
  // A test-control data root is never used by a production start.
  fs.writeFileSync(path.join(root, TEST_DATA_ROOT_MARKER), '{}');
  const testRoot = startProcess(root);
  assert.equal(testRoot.begun.mode, 'unavailable');
  assert.deepEqual(fs.readdirSync(root), [TEST_DATA_ROOT_MARKER]);
});

test('a write that fails never stops the start, the ready or the heartbeat, and says so at most once in ten minutes', async (t) => {
  const root = dataRoot(t);
  const refusing = { ...fs, openSync: (target, ...rest) => {
    if (String(target).endsWith('.tmp')) throw Object.assign(new Error('synthetic'), { code: 'EACCES' });
    return fs.openSync(target, ...rest);
  } };
  const run = startProcess(root, { filesystem: refusing });
  assert.equal(run.begun.mode, 'active');
  assert.doesNotThrow(() => run.ready());
  for (let beat = 0; beat < 5; beat += 1) await run.tickAfter(MINUTE);
  const failures = run.lines().filter((text) => text.includes('OUTAGE_STATE_WRITE_FAILED'));
  assert.equal(failures.length, 1, failures.join('\n'));
  assert.match(failures[0], /^\[OUTAGE_MONITOR\] code=OUTAGE_STATE_WRITE_FAILED stage=start cause=EACCES$/u);
  await run.tickAfter(10 * MINUTE);
  assert.equal(run.lines().filter((text) => text.includes('OUTAGE_STATE_WRITE_FAILED')).length, 2);
  assert.equal(fs.existsSync(statePath(root)), false);
  assert.doesNotThrow(() => run.monitor.noteSignalStop());
});

test('restoreSignsOf takes only the signs of a restored backup, as fixed tokens', () => {
  const purpose = (extra) => ({ purposeId: 'welcome', kind: 'public', status: 'ready', code: 'LEDGER_READY', reason: null,
    notices: [], ...extra });
  const report = {
    version: 1,
    protectedEffects: 'on',
    purposes: [
      purpose({ status: 'failed', code: 'LEDGER_ROLLBACK', reason: 'database-behind' }),
      purpose({ purposeId: 'owner-safety', status: 'failed', code: 'LEDGER_ROLLBACK', reason: 'registration-fork' }),
      purpose({ purposeId: 'work.penalty.announce', status: 'failed', code: 'LEDGER_REGISTRATION_MISSING', reason: 'unregistered' }),
      purpose({ purposeId: 'audit.guild.leave', status: 'failed', code: 'LEDGER_FILES_MISSING', reason: 'all' }),
      purpose({ purposeId: 'word-chain.reaction', status: 'failed', code: 'LEDGER_PARTIAL', reason: null }),
      purpose({ purposeId: 'number-chain.reaction', notices: ['LEDGER_REINIT_APPLIED', 'LEDGER_TEMP_RETIRED'] }),
      purpose({ purposeId: 'work.reminder.dm.send', notices: ['LEDGER_REINIT_CONSUMED'] }),
    ],
  };
  assert.deepEqual(restoreSignsOf(report), [
    'LEDGER_FILES_MISSING:all',
    'LEDGER_PARTIAL',
    'LEDGER_REGISTRATION_MISSING:unregistered',
    'LEDGER_REINIT_APPLIED',
    'LEDGER_REINIT_CONSUMED',
    'LEDGER_ROLLBACK:database-behind',
    'LEDGER_ROLLBACK:registration-fork',
  ]);
  // The store's own LEDGER_MISSING, an ordinary failure, a path problem, and a ledger that is fine are no sign.
  for (const code of ['LEDGER_MISSING', 'LEDGER_CORRUPT', 'LEDGER_IN_USE', 'LEDGER_PATH_INVALID', 'LEDGER_BOOTSTRAP_FAILED']) {
    assert.deepEqual(restoreSignsOf({ ...report, purposes: [purpose({ status: 'failed', code })] }), [], code);
  }
  // A code that only looks like a sign, from a disabled or ready purpose, is none; nor is the kill switch.
  assert.deepEqual(restoreSignsOf({ ...report, purposes: [purpose({ status: 'ready', code: 'LEDGER_ROLLBACK' })] }), []);
  assert.deepEqual(restoreSignsOf({ ...report, protectedEffects: 'off' }), []);
  for (const bad of [null, undefined, 'x', { version: 2, purposes: [] }, { version: 1, purposes: 'x' }]) {
    assert.deepEqual(restoreSignsOf(bad), []);
  }
  assert.deepEqual(restoreSignsOf({ version: 1, protectedEffects: 'on', purposes: [
    purpose({ status: 'failed', code: 'LEDGER_ROLLBACK', reason: '<@everyone>' })] }), ['LEDGER_ROLLBACK']);
});

test('signs of a restore make a pending of their own kind, even without a gap, and join an outage that is waiting', async (t) => {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS + MINUTE });
  // A short gap, but the ledgers say a backup was restored.
  const restored = startProcess(root, { clock: { value: BASE_MS + 2 * MINUTE } });
  restored.ready({ recovery: ['LEDGER_ROLLBACK:database-behind'] });
  const { pending } = readState(root);
  assert.deepEqual([pending.kind, pending.recovery, pending.startedAtMs, pending.endedAtMs],
    ['restore', ['LEDGER_ROLLBACK:database-behind'], BASE_MS + 2 * MINUTE, BASE_MS + 2 * MINUTE]);
  assert.ok(restored.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_RESTORE_DETECTED signs=1'));
  // An outage after it gives the restore an interval and keeps its signs.
  const later = startProcess(root, { clock: { value: BASE_MS + 40 * MINUTE } });
  later.ready();
  const merged = readState(root).pending;
  assert.deepEqual([merged.kind, merged.recovery, merged.startedAtMs, merged.endedAtMs, merged.id],
    ['restore', ['LEDGER_ROLLBACK:database-behind'], BASE_MS + 2 * MINUTE, BASE_MS + 40 * MINUTE, outageIdFor(BASE_MS + 2 * MINUTE)]);
  // Signs found while a crash is waiting make it a restore, once each.
  const again = startProcess(root, { clock: { value: BASE_MS + 50 * MINUTE } });
  again.ready({ recovery: ['LEDGER_ROLLBACK:database-behind', 'LEDGER_PARTIAL'] });
  assert.deepEqual(readState(root).pending.recovery, ['LEDGER_PARTIAL', 'LEDGER_ROLLBACK:database-behind']);
});

test('the monitor accepts only what it wrote: a hostile record is unknown, a good one round-trips', () => {
  const good = {
    schema: 1, bootId: 'a'.repeat(32), startedAtMs: 5, readyAtMs: 6, lastHealthyAtMs: 7,
    stop: { kind: 'running', atMs: 5 },
    pending: { id: outageIdFor(1_000), startedAtMs: 1_000, endedAtMs: 2_000, kind: 'crash', recovery: ['LEDGER_PARTIAL'],
      createdAtMs: 2_000, owner: 'queued', guilds: { [GUILD_A]: 'sent', [GUILD_B]: 'skipped:no-channel' } },
    guildNoticeAtMs: { [GUILD_A]: 3_000 },
  };
  assert.ok(parseStateText(JSON.stringify(good)));
  assert.deepEqual(parseStateText(JSON.stringify(good)).pending.guilds, good.pending.guilds);
  const variants = [
    { ...good, pending: { ...good.pending, kind: 'other' } },
    { ...good, pending: { ...good.pending, owner: 'sent' } },
    { ...good, pending: { ...good.pending, recovery: ['not a code'] } },
    { ...good, pending: { ...good.pending, guilds: { abc: 'sent' } } },
    { ...good, pending: { ...good.pending, guilds: { [GUILD_A]: 'sent; <@everyone>' } } },
    { ...good, pending: { ...good.pending, endedAtMs: 10 } },
    { ...good, guildNoticeAtMs: { [GUILD_A]: -1 } },
    { ...good, guildNoticeAtMs: { 'not-a-guild': 1 } },
    { ...good, stop: { kind: 'signal', atMs: 1, more: 1 } },
  ];
  for (const variant of variants) assert.equal(parseStateText(JSON.stringify(variant)), null, JSON.stringify(variant).slice(0, 80));
});

// ---- The delivery side: when a pending outage may be handed to the one that tells it. ----

async function pendingProcess(t, options = {}) {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS });
  const run = startProcess(root, { clock: { value: BASE_MS + 30 * MINUTE }, ...options });
  const calls = [];
  const outcomes = [];
  run.monitor.attachDelivery(async (store) => {
    calls.push(store.pending());
    return outcomes.length ? outcomes.shift() : 'complete';
  });
  run.ready();
  return { root, run, calls, outcomes };
}

test('a pending outage is delivered once the process has been ready for ten minutes thirty seconds, not before', async (t) => {
  const { root, run, calls } = await pendingProcess(t);
  assert.ok(readState(root).pending);
  // The Owner DM start guard's ten minutes, and thirty seconds more.
  await run.advance(10 * MINUTE);
  assert.equal(calls.length, 0, 'ten minutes is not enough');
  await run.advance(STABLE_AFTER_READY_MS - 10 * MINUTE - 1);
  assert.equal(calls.length, 0, 'one millisecond short');
  assert.equal(run.clock.value, BASE_MS + 30 * MINUTE + STABLE_AFTER_READY_MS - 1);
  await run.advance(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, outageIdFor(BASE_MS));
  assert.equal(calls[0].announce, true);
  assert.equal(Object.isFrozen(calls[0]), true);
  // 'complete' ends the pending, in the file as well.
  assert.equal(readState(root).pending, null);
  await run.tickAfter(MINUTE);
  assert.equal(calls.length, 1);
});

test('nothing is delivered while the client is not ready, the start guard holds the Owner DMs back, or the kill switch is off', async (t) => {
  const gate = { allowed: false, allowsOwnerDm() { return this.allowed; } };
  const { root, run, calls } = await pendingProcess(t, { ownerDmGate: gate });
  // The guard still holds, well past the steady time: not delivered, not dropped.
  await run.advance(STABLE_AFTER_READY_MS + 5 * MINUTE);
  assert.equal(calls.length, 0);
  assert.ok(readState(root).pending);
  // The guard lets Owner DMs through: the next heartbeat delivers (no second wait, no duplicate).
  gate.allowed = true;
  run.client.ready = false;
  await run.advance(MINUTE);
  assert.equal(calls.length, 0, 'a client that is not ready');
  run.client.ready = true;
  await run.advance(MINUTE);
  assert.equal(calls.length, 1);
  assert.equal(readState(root).pending, null);

  // The kill switch: the pending is dropped with a line, nothing is delivered.
  const off = await pendingProcess(t, { protectedEffectsEnabled: () => false });
  await off.run.advance(MINUTE);
  assert.equal(off.calls.length, 0);
  assert.equal(readState(off.root).pending, null);
  assert.ok(off.run.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_NOTICE_DISABLED reason=protected-effects-off'));
});

test('a heartbeat that finds a gap of ten minutes starts the steady wait again', async (t) => {
  const { run, calls } = await pendingProcess(t);
  await run.advance(9 * MINUTE);
  // The process was frozen for twenty minutes (a suspended host): that is a gap, and an outage.
  run.clock.value += 20 * MINUTE;
  await run.monitor.tick();
  assert.equal(calls.length, 0);
  await run.advance(STABLE_AFTER_READY_MS - 1);
  assert.equal(calls.length, 0);
  await run.advance(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].endedAtMs, run.clock.value - STABLE_AFTER_READY_MS, 'the outage ended when the gap did');
});

test('waiting is tried again at the next heartbeat, idle keeps the pending and stops trying, and a failing delivery gives up', async (t) => {
  const { root, run, calls, outcomes } = await pendingProcess(t);
  outcomes.push('waiting', 'waiting', 'idle');
  await run.advance(STABLE_AFTER_READY_MS);
  assert.equal(calls.length, 1);
  await run.advance(2 * MINUTE);
  assert.equal(calls.length, 3);
  assert.ok(readState(root).pending, 'kept for a later start');
  await run.advance(3 * MINUTE);
  assert.equal(calls.length, 3, 'idle: no more tries in this process');

  const failing = await pendingProcess(t);
  failing.run.monitor.attachDelivery(async () => { throw Object.assign(new Error('synthetic'), { code: 'BOOM_CODE' }); });
  await failing.run.advance(STABLE_AFTER_READY_MS);
  await failing.run.advance(8 * MINUTE);
  const lines = failing.run.lines().filter((text) => text.includes('OUTAGE_NOTICE_FAILED'));
  assert.equal(lines.length, 5);
  assert.equal(lines[0], '[OUTAGE_MONITOR] code=OUTAGE_NOTICE_FAILED cause=BOOM_CODE');
  assert.ok(readState(failing.root).pending);
});

test('a pending that was not delivered 72 hours after it ended is dropped, at the start and while running', async (t) => {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS });
  const first = startProcess(root, { clock: { value: BASE_MS + 30 * MINUTE } });
  first.ready();
  const endedAt = readState(root).pending.endedAtMs;
  // A start 72 hours later (exactly) keeps it; one millisecond more drops it.
  const keeping = startProcess(root, { clock: { value: endedAt + 72 * HOUR } });
  assert.ok(readState(root).pending);
  assert.equal(keeping.begun.pending, true);
  const dropping = startProcess(root, { clock: { value: endedAt + 72 * HOUR + 1 } });
  assert.equal(dropping.begun.pending, false);
  assert.equal(readState(root).pending, null);
  assert.ok(dropping.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_PENDING_EXPIRED stage=start'));

  // While running: a process whose Owner DMs are held back for good never delivers it.
  const root2 = dataRoot(t);
  await crashedRun(root2, { readyAt: BASE_MS, lastBeat: BASE_MS });
  const held = startProcess(root2, { clock: { value: BASE_MS + 30 * MINUTE }, ownerDmGate: { allowsOwnerDm: () => false } });
  const delivered = [];
  held.monitor.attachDelivery(async () => { delivered.push(1); return 'complete'; });
  held.ready();
  // Nine minutes between heartbeats stays under the line of a lost connection.
  await held.advance(72 * HOUR, 9 * MINUTE);
  assert.equal(held.clock.value, BASE_MS + 30 * MINUTE + 72 * HOUR);
  assert.ok(readState(root2).pending, 'exactly 72 hours after its end it is still waiting');
  await held.advance(1);
  assert.equal(readState(root2).pending, null);
  assert.ok(held.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_PENDING_EXPIRED stage=run'));
  assert.deepEqual(delivered, []);
});

test('a pending that outlived a steady run is replaced by an outage that begins after it, and a short gap after it changes nothing', async (t) => {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS });
  const first = startProcess(root, { clock: { value: BASE_MS + 30 * MINUTE } });
  // The delivery could not do anything (idle): the pending is kept for a later start.
  first.monitor.attachDelivery(async () => 'idle');
  first.ready();
  await first.advance(STABLE_AFTER_READY_MS + 5 * MINUTE);
  const old = readState(root).pending;
  assert.deepEqual([old.startedAtMs, old.endedAtMs], [BASE_MS, BASE_MS + 30 * MINUTE]);
  const lastBeat = first.clock.value;

  // Killed after it was steady, and a new start only five minutes later: a restart. The pending is
  // neither extended nor made again.
  const short = startProcess(root, { clock: { value: lastBeat + 5 * MINUTE } });
  short.ready();
  assert.deepEqual(readState(root).pending, old);

  // A run that was steady and then killed, and a start 40 minutes later: another outage.
  const second = startProcess(root, { clock: { value: lastBeat + 10 * MINUTE } });
  second.ready();
  second.monitor.attachDelivery(async () => 'idle');
  await second.advance(STABLE_AFTER_READY_MS + 2 * MINUTE);
  const steadyBeat = second.clock.value;
  const next = startProcess(root, { clock: { value: steadyBeat + 40 * MINUTE } });
  next.ready();
  const fresh = readState(root).pending;
  assert.deepEqual([fresh.startedAtMs, fresh.endedAtMs, fresh.kind, fresh.owner, fresh.guilds],
    [steadyBeat, steadyBeat + 40 * MINUTE, 'crash', 'none', {}]);
  assert.notEqual(fresh.id, old.id);
  assert.ok(next.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_PENDING_SUPERSEDED stage=ready'));
});

test('a pending that was told in part is not hidden by a quick restart: the next outage replaces it', async (t) => {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS });
  const first = startProcess(root, { clock: { value: BASE_MS + 30 * MINUTE } });
  // The delivery ended one server's notice and could not tell the Owner.
  first.monitor.attachDelivery(async (store) => {
    store.settleGuild(GUILD_A, 'sent');
    return 'idle';
  });
  first.ready();
  await first.advance(STABLE_AFTER_READY_MS + MINUTE);
  const old = readState(root).pending;
  assert.deepEqual(old.guilds, { [GUILD_A]: 'sent' });
  const lastBeat = first.clock.value;

  // A restart a few minutes later that is killed at once (not steady), and then an outage of 35
  // minutes: it is not the old one's continuation, for the old one was told in part.
  const quick = startProcess(root, { clock: { value: lastBeat + 3 * MINUTE } });
  quick.ready();
  assert.equal(readState(root).pending.id, old.id, 'a short gap changes nothing');
  const later = startProcess(root, { clock: { value: lastBeat + 3 * MINUTE + 35 * MINUTE } });
  later.ready();
  const fresh = readState(root).pending;
  assert.notEqual(fresh.id, old.id);
  assert.deepEqual([fresh.startedAtMs, fresh.endedAtMs, fresh.guilds],
    [lastBeat + 3 * MINUTE, lastBeat + 38 * MINUTE, {}]);
});

test('an outage that comes before the wait of the last one was over is the same outage, however long each was', async (t) => {
  // The connection was lost for twelve minutes; it came back, and the process was killed three minutes
  // later, before it had been steady; the next start is twenty minutes after. One outage, from the
  // first moment to the last, and the delivery is told one outage.
  const root = dataRoot(t);
  const run = startProcess(root);
  run.ready();
  await run.advance(2 * MINUTE);
  const lastHealthy = run.clock.value;
  run.client.ready = false;
  await run.advance(12 * MINUTE);
  run.client.ready = true;
  await run.advance(MINUTE);
  const connection = readState(root).pending;
  assert.deepEqual([connection.kind, connection.startedAtMs], ['connection', lastHealthy]);
  await run.advance(2 * MINUTE);
  const killedAt = run.clock.value;
  const next = startProcess(root, { clock: { value: killedAt + 20 * MINUTE } });
  next.ready();
  const merged = readState(root).pending;
  assert.deepEqual([merged.id, merged.startedAtMs, merged.endedAtMs, merged.kind],
    [connection.id, lastHealthy, killedAt + 20 * MINUTE, 'connection']);
  assert.equal(next.lines().some((line) => line.includes('OUTAGE_PENDING_SUPERSEDED')), false);
});

test('a connection outage after a delivery that went idle is another outage, not a continuation of it', async (t) => {
  const { root, run, calls, outcomes } = await pendingProcess(t);
  outcomes.push('idle');
  await run.advance(STABLE_AFTER_READY_MS);
  assert.equal(calls.length, 1);
  const old = readState(root).pending;
  run.client.ready = false;
  await run.advance(12 * MINUTE);
  run.client.ready = true;
  await run.advance(MINUTE);
  const fresh = readState(root).pending;
  assert.notEqual(fresh.id, old.id);
  assert.deepEqual([fresh.kind, fresh.owner, fresh.guilds], ['connection', 'none', {}]);
  assert.ok(run.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_PENDING_SUPERSEDED stage=heartbeat'));
  // It is delivered again, once it is steady.
  await run.advance(STABLE_AFTER_READY_MS);
  assert.equal(calls.length, 2);
  assert.equal(calls[1].id, fresh.id);
});

test('the store: a claim is written before anything is sent, a release gives the time back, and statuses end once', async (t) => {
  const { root, run } = await pendingProcess(t);
  const { store } = run.monitor;
  assert.equal(store.lastNoticeAtMs(GUILD_A), null);
  assert.equal(store.claimGuild('not-a-guild', BASE_MS), false);
  assert.equal(store.claimGuild(GUILD_A, BASE_MS + HOUR), true);
  assert.equal(readState(root).pending.guilds[GUILD_A], 'claimed');
  assert.equal(readState(root).guildNoticeAtMs[GUILD_A], BASE_MS + HOUR);
  assert.equal(store.lastNoticeAtMs(GUILD_A), BASE_MS + HOUR);
  assert.equal(store.claimGuild(GUILD_A, BASE_MS + HOUR), false, 'one claim per server per outage');
  // A claim that did not reach Discord is given back, with the earlier time (none).
  assert.equal(store.releaseGuild(GUILD_A), true);
  assert.equal(readState(root).pending.guilds[GUILD_A], undefined);
  assert.equal(store.lastNoticeAtMs(GUILD_A), null);
  assert.equal(store.releaseGuild(GUILD_A), false);
  // One that did reach it ends with its answer, once.
  assert.equal(store.claimGuild(GUILD_A, BASE_MS + HOUR), true);
  assert.equal(store.settleGuild(GUILD_A, 'sent'), true);
  assert.equal(store.settleGuild(GUILD_A, 'unknown'), false);
  assert.equal(store.releaseGuild(GUILD_A), false, 'a settled status is never given back');
  assert.equal(readState(root).pending.guilds[GUILD_A], 'sent');
  assert.equal(store.settleGuild(GUILD_B, 'skipped:no-channel'), true);
  assert.equal(store.settleGuild(GUILD_B, 'claimed'), false);
  assert.equal(store.settleGuild(GUILD_B, 'skipped:<@everyone>'), false);
  // The Owner notice is recorded before it is handed over, and only once.
  assert.equal(store.markOwnerQueued(), true);
  assert.equal(readState(root).pending.owner, 'queued');
  assert.equal(store.markOwnerQueued(), false);
});

test('a claim that cannot be written is refused, so nothing is sent; one left claimed by a crash is unknown at the next start', async (t) => {
  const { root, run } = await pendingProcess(t);
  assert.equal(run.monitor.store.claimGuild(GUILD_A, BASE_MS + HOUR), true);
  // The process dies here. The next start finds the claim and takes it for unknown.
  const next = startProcess(root, { clock: { value: BASE_MS + 2 * HOUR } });
  assert.equal(readState(root).pending.guilds[GUILD_A], 'unknown');
  assert.ok(next.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_NOTICE_CLAIM_UNSETTLED guilds=1'));
  assert.equal(next.monitor.store.claimGuild(GUILD_A, BASE_MS + 2 * HOUR), false);
  assert.equal(next.monitor.store.lastNoticeAtMs(GUILD_A), BASE_MS + HOUR);

  const refusing = { ...fs, openSync: (target, ...rest) => {
    if (String(target).endsWith('.tmp')) throw Object.assign(new Error('synthetic'), { code: 'EIO' });
    return fs.openSync(target, ...rest);
  } };
  const blocked = startProcess(root, { clock: { value: BASE_MS + 3 * HOUR }, filesystem: refusing });
  assert.equal(blocked.monitor.store.claimGuild(GUILD_B, BASE_MS + 3 * HOUR), false);
  assert.equal(blocked.monitor.store.lastNoticeAtMs(GUILD_B), null);
  assert.equal(blocked.monitor.store.pending().guilds[GUILD_B], undefined);
  assert.equal(blocked.monitor.store.markOwnerQueued(), false);
  assert.equal(blocked.monitor.store.pending().owner, 'none');
});

test('a pending holds at most 200 servers, and a claim beyond that is refused', async (t) => {
  const { run } = await pendingProcess(t);
  const { store } = run.monitor;
  const at = BASE_MS + HOUR;
  for (let index = 0; index < 205; index += 1) {
    store.settleGuild(String(300_000_000_000_000_000n + BigInt(index)), 'skipped:recent');
  }
  assert.equal(Object.keys(store.pending().guilds).length, 200, 'the pending holds at most 200 servers');
  assert.equal(store.claimGuild('999999999999999999', at), false, 'a new server beyond the cap is refused');
  assert.equal(store.claimGuild(GUILD_A, at), false, 'the cap counts every status');
});

test('the memory of notices is kept 48 hours and 200 servers, newest first', async (t) => {
  const root = dataRoot(t);
  const notices = {};
  for (let index = 0; index < 200; index += 1) {
    notices[String(300_000_000_000_000_000n + BigInt(index))] = BASE_MS + index;
  }
  const record = {
    schema: 1, bootId: 'b'.repeat(32), startedAtMs: BASE_MS, readyAtMs: BASE_MS, lastHealthyAtMs: BASE_MS,
    stop: { kind: 'signal', atMs: BASE_MS },
    pending: { id: outageIdFor(BASE_MS - HOUR), startedAtMs: BASE_MS - HOUR, endedAtMs: BASE_MS, kind: 'crash', recovery: [],
      createdAtMs: BASE_MS, owner: 'none', guilds: {} },
    guildNoticeAtMs: { ...notices, [GUILD_B]: BASE_MS - 10 * HOUR },
  };
  // 201 entries are not a record this module wrote.
  fs.writeFileSync(statePath(root), JSON.stringify(record));
  assert.equal(startProcess(root).begun.previous, 'unknown');
  delete record.guildNoticeAtMs[GUILD_B];
  fs.writeFileSync(statePath(root), JSON.stringify(record));
  const run = startProcess(root, { clock: { value: BASE_MS + 2 * HOUR } });
  assert.equal(run.begun.previous, 'planned');
  assert.equal(Object.keys(readState(root).guildNoticeAtMs).length, 200);
  // A claim takes a place and the oldest one goes.
  assert.equal(run.monitor.store.claimGuild(GUILD_A, BASE_MS + 2 * HOUR), true);
  const after = readState(root).guildNoticeAtMs;
  assert.equal(Object.keys(after).length, 200);
  assert.equal(after[GUILD_A], BASE_MS + 2 * HOUR);
  assert.equal(Object.hasOwn(after, String(300_000_000_000_000_000n)), false, 'the oldest is forgotten');
  // 48 hours: an entry exactly that old is kept, one millisecond older is not.
  const keeping = startProcess(root, { clock: { value: BASE_MS + 48 * HOUR } });
  assert.equal(Object.hasOwn(readState(root).guildNoticeAtMs, String(300_000_000_000_000_000n + 1n)), true);
  assert.equal(keeping.begun.mode, 'active');
  startProcess(root, { clock: { value: BASE_MS + 48 * HOUR + 2 } });
  const left = readState(root).guildNoticeAtMs;
  assert.equal(Object.hasOwn(left, String(300_000_000_000_000_000n + 1n)), false);
  assert.equal(left[GUILD_A], BASE_MS + 2 * HOUR);
});

// ---- The gateway: what a real discord.js client says when a shard loses its connection. ----

// A real Client (never logged in) with a real WebSocketShard of discord.js and a real gateway manager of
// @discordjs/ws behind it, wired as discord.js wires them when it connects. Emitting the gateway
// manager's events runs discord.js's own handlers, which is what moves the shard's status.
function realClient(t) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  const manager = client.ws;
  const shard = new WebSocketShard(manager, 0);
  manager.shards.set(0, shard);
  manager.totalShards = 1;
  manager._ws = new GatewayManager({ token: 'x'.repeat(30), intents: GatewayIntentBits.Guilds, rest: client.rest });
  manager.attachEvents();
  shard.status = Status.Ready;
  manager.status = Status.Ready;
  t.after(() => { try { void client.destroy(); } catch {} });
  const emit = (event, data) => manager._ws.emit(event, { shardId: 0, ...data });
  return {
    client,
    manager,
    shard,
    // The shard's connection closes (code 1006, abnormal) and discord.js starts to reconnect.
    lose: () => emit(GatewayEvents.Closed, { code: 1006 }),
    // The gateway greets again and the session is resumed (or, with no session, identified).
    hello: () => emit(GatewayEvents.Hello, {}),
    resume: () => emit(GatewayEvents.Resumed, {}),
    fatal: () => emit(GatewayEvents.Closed, { code: 4004 }),
  };
}

test('a real client whose shard lost its connection still says isReady(): the health judged is the shard\'s', (t) => {
  const real = realClient(t);
  assert.equal(real.client.isReady(), true);
  assert.equal(defaultGatewayHealthy(real.client), true);
  // The connection closes: discord.js leaves isReady() true and moves only the shard.
  real.lose();
  assert.equal(real.client.isReady(), true, 'isReady() never says it');
  assert.equal(real.shard.status, Status.Connecting);
  assert.equal(defaultGatewayHealthy(real.client), false);
  // It greets again with no session to resume (identifying), and then the session resumes.
  real.hello();
  assert.equal(real.shard.status, Status.Identifying);
  assert.equal(defaultGatewayHealthy(real.client), false);
  real.resume();
  assert.equal(real.shard.status, Status.Ready);
  assert.equal(defaultGatewayHealthy(real.client), true);
  // An unrecoverable close, and a client that was destroyed.
  real.fatal();
  assert.equal(real.shard.status, Status.Disconnected);
  assert.equal(defaultGatewayHealthy(real.client), false);
  real.shard.status = Status.Ready;
  assert.equal(defaultGatewayHealthy(real.client), true);
  real.manager.destroyed = true;
  assert.equal(real.client.isReady(), false);
  assert.equal(defaultGatewayHealthy(real.client), false);
  real.manager.destroyed = false;
  // Not logged in yet, and a ready client that shows no shard at all: not healthy.
  assert.equal(defaultGatewayHealthy(new Client({ intents: [GatewayIntentBits.Guilds] })), false);
  real.manager.shards.clear();
  assert.equal(real.client.isReady(), true);
  assert.equal(defaultGatewayHealthy(real.client), false);
  // One shard of several that is not Ready is enough.
  const second = new WebSocketShard(real.manager, 1);
  second.status = Status.Ready;
  real.manager.shards.set(0, real.shard);
  real.manager.shards.set(1, second);
  assert.equal(defaultGatewayHealthy(real.client), true);
  second.status = Status.Resuming;
  assert.equal(defaultGatewayHealthy(real.client), false);
  // A client that is not a discord.js client (no ws) can only be judged by isReady().
  assert.equal(defaultGatewayHealthy({ isReady: () => true }), true);
  assert.equal(defaultGatewayHealthy({ isReady: () => false }), false);
  assert.equal(defaultGatewayHealthy(null), false);
});

test('a shard that lost its connection for twelve minutes makes a connection outage on a real client, which isReady() alone would miss', async (t) => {
  for (const [label, health] of [['the gateway health', defaultGatewayHealthy], ['isReady() alone', (client) => client.isReady()]]) {
    const root = dataRoot(t);
    const real = realClient(t);
    const run = startProcess(root, { gatewayHealthy: health });
    run.monitor.noteReady(real.client);
    await run.advance(2 * MINUTE);
    const lastHealthy = run.clock.value;
    real.lose();
    await run.advance(12 * MINUTE);
    assert.equal(readState(root).lastHealthyAtMs, label === 'isReady() alone' ? run.clock.value : lastHealthy,
      `${label}: lastHealthyAtMs`);
    real.hello();
    real.resume();
    await run.advance(MINUTE);
    const { pending } = readState(root);
    if (label === 'isReady() alone') {
      // The old judgement: nothing is seen, so a lost connection is never an outage.
      assert.equal(pending, null);
      continue;
    }
    assert.deepEqual([pending.kind, pending.startedAtMs, pending.endedAtMs], ['connection', lastHealthy, run.clock.value]);
    assert.ok(run.lines().includes(DETECTED('connection', 13)), run.lines().join('\n'));
  }
});

test('a real client that loses its connection is not delivered to, and a short loss is no outage', async (t) => {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS });
  const real = realClient(t);
  const run = startProcess(root, { clock: { value: BASE_MS + 30 * MINUTE }, gatewayHealthy: defaultGatewayHealthy });
  const calls = [];
  run.monitor.attachDelivery(async (store) => { calls.push(store.pending()); return 'complete'; });
  run.monitor.noteReady(real.client);
  // A loss that is nine minutes from the last healthy heartbeat to the first one after it is no outage
  // of its own, and does not move the end of the one that is waiting.
  await run.advance(MINUTE);
  real.lose();
  await run.advance(8 * MINUTE);
  real.hello();
  real.resume();
  await run.advance(MINUTE);
  assert.equal(readState(root).pending.endedAtMs, BASE_MS + 30 * MINUTE, 'not extended');
  assert.equal(calls.length, 0);
  // Not delivered while the shard is down, though the wait is over; delivered at the first heartbeat
  // after it is back (a loss of three minutes is no outage, so the wait is not started again).
  real.lose();
  await run.advance(2 * MINUTE);
  assert.equal(run.clock.value, BASE_MS + 30 * MINUTE + 12 * MINUTE);
  assert.equal(calls.length, 0);
  real.hello();
  real.resume();
  await run.advance(MINUTE);
  assert.equal(calls.length, 1);
});

// ---- The wall clock: a clock that was set is not an outage. ----

test('a wall clock set forward three hours while the connection held is logged, not an outage', async (t) => {
  const root = dataRoot(t);
  const mono = { value: 5_000_000 };
  const run = startProcess(root, { mono });
  run.ready();
  // A minute of the monotonic clock passes while the wall clock jumps three hours.
  run.clock.value += 3 * HOUR;
  mono.value += MINUTE;
  await run.monitor.tick();
  assert.equal(readState(root).pending, null);
  assert.equal(readState(root).lastHealthyAtMs, run.clock.value, 're-based on the new clock');
  // How much more the wall clock moved than the monotonic one: three hours less the minute that passed.
  assert.ok(run.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_CLOCK_JUMP seconds=10740'), run.lines().join('\n'));
  // Later beats are ordinary again, and a delivery's wait is not shortened by the jump.
  run.clock.value += MINUTE;
  mono.value += MINUTE;
  await run.monitor.tick();
  assert.equal(readState(root).pending, null);
  assert.equal(run.lines().filter((line) => line.includes('OUTAGE_CLOCK_JUMP')).length, 1);
});

test('a wall clock set back three hours and then restored is no outage either', async (t) => {
  const root = dataRoot(t);
  const mono = { value: 5_000_000 };
  const run = startProcess(root, { mono });
  run.ready();
  run.clock.value -= 3 * HOUR;
  mono.value += MINUTE;
  await run.monitor.tick();
  assert.ok(run.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_CLOCK_BEHIND stage=heartbeat'));
  // The clock is put right: three hours and a minute on the wall clock, a minute on the real one.
  run.clock.value += 3 * HOUR + MINUTE;
  mono.value += MINUTE;
  await run.monitor.tick();
  assert.equal(readState(root).pending, null);
  assert.ok(run.lines().some((line) => line.startsWith('[OUTAGE_MONITOR] code=OUTAGE_CLOCK_JUMP')));
});

test('a process that really stopped for twelve minutes is an outage whatever the wall clock says; a suspended host is not one', async (t) => {
  // The monotonic clock says twelve minutes passed: an outage, even if the wall clock was set back meanwhile.
  const root = dataRoot(t);
  const mono = { value: 5_000_000 };
  const blocked = startProcess(root, { mono });
  blocked.ready();
  const lastHealthy = blocked.clock.value;
  mono.value += 12 * MINUTE;
  blocked.clock.value += MINUTE;
  await blocked.monitor.tick();
  const found = readState(root).pending;
  assert.deepEqual([found.kind, found.startedAtMs], ['connection', lastHealthy + MINUTE - 12 * MINUTE]);
  assert.equal(found.endedAtMs - found.startedAtMs, 12 * MINUTE);

  // A host that slept three hours does not move the monotonic clock: it is not an outage, even if the
  // connection was seen lost for a minute when it woke (the wall clock cannot say a sleep from a
  // clock that was set, so it is only logged).
  const root2 = dataRoot(t);
  const mono2 = { value: 5_000_000 };
  const slept = startProcess(root2, { mono: mono2 });
  slept.ready();
  slept.clock.value += 3 * HOUR;
  mono2.value += MINUTE;
  slept.client.ready = false;
  await slept.monitor.tick();
  slept.client.ready = true;
  slept.clock.value += MINUTE;
  mono2.value += MINUTE;
  await slept.monitor.tick();
  assert.equal(readState(root2).pending, null);
  assert.ok(slept.lines().some((line) => line.startsWith('[OUTAGE_MONITOR] code=OUTAGE_CLOCK_JUMP')));
});

test('a connection lost for thirteen minutes while the wall clock jumped three hours is thirteen minutes, not three hours', async (t) => {
  const root = dataRoot(t);
  const mono = { value: 5_000_000 };
  const run = startProcess(root, { mono });
  run.ready();
  run.clock.value += MINUTE;
  mono.value += MINUTE;
  await run.monitor.tick();
  // Twelve minutes with the shard down, with a time service setting the clock forward in the middle.
  run.client.ready = false;
  for (let beat = 0; beat < 12; beat += 1) {
    run.clock.value += MINUTE;
    mono.value += MINUTE;
    if (beat === 6) run.clock.value += 3 * HOUR;
    await run.monitor.tick();
  }
  run.client.ready = true;
  run.clock.value += MINUTE;
  mono.value += MINUTE;
  await run.monitor.tick();
  const { pending } = readState(root);
  assert.equal(pending.kind, 'connection');
  assert.equal(pending.endedAtMs - pending.startedAtMs, 13 * MINUTE, 'what the monotonic clock says');
  assert.equal(pending.endedAtMs, run.clock.value);
  assert.ok(run.lines().includes(DETECTED('connection', 13)), run.lines().join('\n'));
});

test('a connection that was down for two minutes while the wall clock jumped three hours is no outage', async (t) => {
  const root = dataRoot(t);
  const mono = { value: 5_000_000 };
  const run = startProcess(root, { mono });
  run.ready();
  run.client.ready = false;
  run.clock.value += MINUTE;
  mono.value += MINUTE;
  await run.monitor.tick();
  run.clock.value += MINUTE + 3 * HOUR;
  mono.value += MINUTE;
  await run.monitor.tick();
  run.client.ready = true;
  run.clock.value += MINUTE;
  mono.value += MINUTE;
  await run.monitor.tick();
  assert.equal(readState(root).pending, null);
  assert.ok(run.lines().some((line) => line.startsWith('[OUTAGE_MONITOR] code=OUTAGE_CLOCK_JUMP')));
  assert.equal(run.lines().some((line) => line.includes('OUTAGE_DETECTED')), false);
});

test('the wait before a delivery is measured on the monotonic clock', async (t) => {
  const root = dataRoot(t);
  await crashedRun(root, { readyAt: BASE_MS, lastBeat: BASE_MS });
  const mono = { value: 9_000_000 };
  const run = startProcess(root, { clock: { value: BASE_MS + 30 * MINUTE }, mono });
  const calls = [];
  run.monitor.attachDelivery(async (store) => { calls.push(store.pending()); return 'complete'; });
  run.ready();
  // The wall clock is set forward a day; two minutes pass on the monotonic one.
  run.clock.value += 24 * HOUR;
  mono.value += 2 * MINUTE;
  await run.monitor.tick();
  assert.equal(calls.length, 0);
  // Only the monotonic clock reaching the wait delivers.
  mono.value += STABLE_AFTER_READY_MS - 2 * MINUTE - 1;
  run.clock.value += STABLE_AFTER_READY_MS - 2 * MINUTE - 1;
  await run.monitor.tick();
  assert.equal(calls.length, 0);
  mono.value += 1;
  run.clock.value += 1;
  await run.monitor.tick();
  assert.equal(calls.length, 1);
});

// ---- A restored backup: the same signs at every start are one event. ----

function restoreReport({ failures = [['welcome', 'LEDGER_ROLLBACK', 'registration-ahead']], reinit = [] } = {}) {
  return {
    version: 1,
    protectedEffects: 'on',
    purposes: [
      ...failures.map(([purposeId, code, reason]) => ({ purposeId, status: 'failed', code, reason: reason ?? null,
        notices: [], ledgerId: null })),
      ...reinit.map(([purposeId, notice, ledgerId]) => ({ purposeId, status: 'ready', code: 'LEDGER_READY', reason: null,
        notices: [notice], ledgerId })),
    ],
  };
}

// A run that is ready with the report, stays up for the whole wait (its delivery completes) and ends
// the way it is told to: killed, or by SIGINT.
async function restoreRun(root, at, report, { signal = false } = {}) {
  const run = startProcess(root, { clock: { value: at } });
  const told = [];
  run.monitor.attachDelivery(async (store) => { told.push(store.pending()); return 'complete'; });
  run.ready({ bootReport: report });
  await run.advance(STABLE_AFTER_READY_MS + MINUTE);
  if (signal) run.monitor.noteSignalStop();
  return { run, told };
}

test('the same signs of a restored backup at every start are told once, planned restarts included', async (t) => {
  const root = dataRoot(t);
  const report = restoreReport();
  let at = BASE_MS;
  const all = [];
  for (let index = 0; index < 5; index += 1) {
    const { run, told } = await restoreRun(root, at, report, { signal: index % 2 === 0 });
    all.push(...told);
    at = run.clock.value + 5 * MINUTE;
  }
  assert.equal(all.length, 1, 'one event for five starts');
  assert.deepEqual([all[0].kind, all[0].recovery], ['restore', ['LEDGER_ROLLBACK:registration-ahead']]);
  assert.deepEqual(readState(root).restoreSeen, { atMs: BASE_MS, keys: restoreEvidenceOf(report).keys });
  assert.equal(readState(root).restoreSeen.keys.length, 1);

  // A sign that was not there before is told at once, with every sign the start has.
  const wider = restoreReport({ failures: [['welcome', 'LEDGER_ROLLBACK', 'registration-ahead'],
    ['audit.guild.leave', 'LEDGER_FILES_MISSING', 'all']] });
  const second = await restoreRun(root, at, wider);
  assert.equal(second.told.length, 1);
  assert.deepEqual(second.told[0].recovery, ['LEDGER_FILES_MISSING:all', 'LEDGER_ROLLBACK:registration-ahead']);
  at = second.run.clock.value + 5 * MINUTE;

  // A different one in place of those, the same: told. A smaller set than before is not new.
  const smaller = await restoreRun(root, at, report);
  assert.equal(smaller.told.length, 0);
  assert.equal(smaller.run.lines().some((line) => line.includes('OUTAGE_RESTORE_REPEATED')), true);
  at = smaller.run.clock.value + 5 * MINUTE;
  const other = await restoreRun(root, at, restoreReport({ failures: [['welcome', 'LEDGER_PARTIAL', 'active']] }));
  assert.equal(other.told.length, 1);
});

test('a set of signs told a week ago is told again, and one told a millisecond short of a week ago is not', async (t) => {
  assert.equal(RESTORE_REPEAT_MS, 7 * 24 * HOUR);
  const report = restoreReport();
  for (const [after, expected] of [[RESTORE_REPEAT_MS - 1, 0], [RESTORE_REPEAT_MS, 1], [RESTORE_REPEAT_MS + 1, 1]]) {
    const root = dataRoot(t);
    const first = await restoreRun(root, BASE_MS, report, { signal: true });
    assert.equal(first.told.length, 1);
    // The next start is `after` ms after the first told it (its ready is when it was told).
    const next = startProcess(root, { clock: { value: BASE_MS + after } });
    const told = [];
    next.monitor.attachDelivery(async (store) => { told.push(store.pending()); return 'complete'; });
    next.ready({ bootReport: report });
    await next.advance(STABLE_AFTER_READY_MS + MINUTE);
    assert.equal(told.length, expected, String(after));
  }
});

test('a reinit is one event however many starts show its notice; another reinit is another; a crash is its own', async (t) => {
  const root = dataRoot(t);
  const applied = restoreReport({ failures: [], reinit: [['welcome', 'LEDGER_REINIT_APPLIED', 'xjl2-aaaa']] });
  const consumed = restoreReport({ failures: [], reinit: [['welcome', 'LEDGER_REINIT_CONSUMED', 'xjl2-aaaa']] });
  const again = restoreReport({ failures: [], reinit: [['welcome', 'LEDGER_REINIT_APPLIED', 'xjl2-bbbb']] });
  let at = BASE_MS;
  const first = await restoreRun(root, at, applied);
  assert.equal(first.told.length, 1);
  assert.deepEqual(first.told[0].recovery, ['LEDGER_REINIT_APPLIED']);
  at = first.run.clock.value + 5 * MINUTE;
  const second = await restoreRun(root, at, consumed);
  assert.equal(second.told.length, 0, 'the same reinit seen consumed');
  at = second.run.clock.value + 5 * MINUTE;
  const third = await restoreRun(root, at, again);
  assert.equal(third.told.length, 1, 'a second reinit of the purpose');
  at = third.run.clock.value + 5 * MINUTE;

  // A real outage while the same signs are still there: its own pending, of its own kind, told with
  // its own budget; the repeated signs add nothing.
  const sameSigns = restoreReport();
  const warm = await restoreRun(root, at, sameSigns);
  assert.equal(warm.told.length, 1, 'the signs are new at this point');
  at = warm.run.clock.value;
  const crashed = startProcess(root, { clock: { value: at + 30 * MINUTE } });
  const told = [];
  crashed.monitor.attachDelivery(async (store) => { told.push(store.pending()); return 'complete'; });
  crashed.ready({ bootReport: sameSigns });
  await crashed.advance(STABLE_AFTER_READY_MS + MINUTE);
  assert.equal(told.length, 1);
  assert.deepEqual([told[0].kind, told[0].recovery, told[0].announce], ['crash', [], true]);
});

test('a record written before restoreSeen existed is read, and keeps its strict keys', (t) => {
  const root = dataRoot(t);
  const legacy = {
    schema: 1, bootId: 'c'.repeat(32), startedAtMs: BASE_MS, readyAtMs: BASE_MS, lastHealthyAtMs: BASE_MS,
    stop: { kind: 'signal', atMs: BASE_MS }, pending: null, guildNoticeAtMs: {},
  };
  fs.writeFileSync(statePath(root), JSON.stringify(legacy));
  const run = startProcess(root, { clock: { value: BASE_MS + HOUR } });
  assert.equal(run.begun.previous, 'planned');
  assert.equal(readState(root).restoreSeen, null, 'written back with the field');
  const parsed = parseStateText(JSON.stringify(legacy));
  assert.ok(parsed);
  assert.equal(parsed.restoreSeen, null);
  for (const bad of [{ restoreSeen: { atMs: 1, keys: ['not a key'] } }, { restoreSeen: { atMs: -1, keys: [] } },
    { restoreSeen: { atMs: 1, keys: [], extra: 1 } }, { restoreSeen: 'x' }, { other: 1 }]) {
    assert.equal(parseStateText(JSON.stringify({ ...legacy, ...bad })), null, JSON.stringify(bad));
  }
  assert.ok(parseStateText(JSON.stringify({ ...legacy, restoreSeen: { atMs: 5, keys: ['LEDGER_PARTIAL'] } })));
  // A failure's key is its sign and a digest of the purpose; a sign alone is what the pending records.
  const evidence = restoreEvidenceOf(restoreReport());
  assert.deepEqual(evidence.signs, ['LEDGER_ROLLBACK:registration-ahead']);
  assert.match(evidence.keys[0], /^LEDGER_ROLLBACK:registration-ahead#[a-f0-9]{8}$/u);
});

test('a restore that did not reach the Owner is told after the outage that replaces it, or after it expired', async (t) => {
  const root = dataRoot(t);
  const report = restoreReport();
  const signs = ['LEDGER_ROLLBACK:registration-ahead'];
  // First start: the Owner cannot be told (the delivery is idle and hands nothing over), so the restore
  // stays pending with the Owner not told, and its signs are remembered.
  const first = startProcess(root, { clock: { value: BASE_MS } });
  first.monitor.attachDelivery(async () => 'idle');
  first.ready({ bootReport: report });
  await first.advance(STABLE_AFTER_READY_MS + 5 * MINUTE);
  const old = readState(root).pending;
  assert.deepEqual([old.kind, old.owner, old.recovery], ['restore', 'none', signs]);
  assert.ok(readState(root).restoreSeen);
  const lastBeat = first.clock.value;

  // It is killed and the next start is twenty minutes later, with the Owner back and the same signs:
  // the outage replaces the pending, and the signs are told with it, not held back as repeated.
  const second = startProcess(root, { clock: { value: lastBeat + 20 * MINUTE } });
  const told = [];
  second.monitor.attachDelivery(async (store) => { told.push(store.pending()); return 'complete'; });
  second.ready({ bootReport: report });
  assert.ok(second.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_PENDING_SUPERSEDED stage=ready'));
  assert.equal(second.lines().some((line) => line.includes('OUTAGE_RESTORE_REPEATED')), false);
  const fresh = readState(root).pending;
  assert.notEqual(fresh.id, old.id);
  assert.deepEqual([fresh.kind, fresh.recovery, fresh.startedAtMs, fresh.endedAtMs],
    ['restore', signs, lastBeat, lastBeat + 20 * MINUTE]);
  await second.advance(STABLE_AFTER_READY_MS + MINUTE);
  assert.equal(told.length, 1);
  assert.deepEqual([told[0].kind, told[0].recovery, told[0].announce], ['restore', signs, true]);

  // A restore that expired before it reached the Owner is forgotten the same way.
  const other = dataRoot(t);
  const lonely = startProcess(other, { clock: { value: BASE_MS } });
  lonely.monitor.attachDelivery(async () => 'idle');
  lonely.ready({ bootReport: report });
  await lonely.advance(STABLE_AFTER_READY_MS + MINUTE);
  const pendingAt = readState(other).pending.endedAtMs;
  lonely.monitor.noteSignalStop();
  const late = startProcess(other, { clock: { value: pendingAt + PENDING_EXPIRES_MS + 1 } });
  const toldLate = [];
  late.monitor.attachDelivery(async (store) => { toldLate.push(store.pending()); return 'complete'; });
  assert.ok(late.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_PENDING_EXPIRED stage=start'));
  assert.equal(readState(other).restoreSeen, null);
  late.ready({ bootReport: report });
  await late.advance(STABLE_AFTER_READY_MS + MINUTE);
  assert.equal(toldLate.length, 1);

  // One that reached the Owner is not forgotten: the same signs are not told again.
  const handed = dataRoot(t);
  const done = startProcess(handed, { clock: { value: BASE_MS } });
  done.monitor.attachDelivery(async (store) => { store.markOwnerQueued(); return 'idle'; });
  done.ready({ bootReport: report });
  await done.advance(STABLE_AFTER_READY_MS + MINUTE);
  const doneBeat = done.clock.value;
  const after = startProcess(handed, { clock: { value: doneBeat + 20 * MINUTE } });
  after.ready({ bootReport: report });
  assert.ok(after.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_PENDING_SUPERSEDED stage=ready'));
  assert.ok(after.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_RESTORE_REPEATED signs=1'));
  assert.deepEqual(readState(handed).pending.recovery, []);
});

test('the same code of another purpose is another sign, and a key from before the purpose was part of it is just another key', async (t) => {
  const root = dataRoot(t);
  const one = restoreReport({ failures: [['welcome', 'LEDGER_FILES_MISSING', 'all']] });
  const two = restoreReport({ failures: [['welcome', 'LEDGER_FILES_MISSING', 'all'],
    ['work.reminder.dm.send', 'LEDGER_FILES_MISSING', 'all']] });
  // The signs of the two reports are the same; their keys are not.
  assert.deepEqual(restoreSignsOf(one), restoreSignsOf(two));
  assert.equal(restoreEvidenceOf(one).keys.length, 1);
  assert.equal(restoreEvidenceOf(two).keys.length, 2);
  assert.notEqual(restoreEvidenceOf(one).keys[0].split('#')[1],
    restoreEvidenceOf(two).keys.find((key) => key !== restoreEvidenceOf(one).keys[0]).split('#')[1]);
  for (const key of restoreEvidenceOf(two).keys) assert.match(key, /^LEDGER_FILES_MISSING:all#[a-f0-9]{8}$/u);
  const first = await restoreRun(root, BASE_MS, one);
  assert.equal(first.told.length, 1);
  const second = await restoreRun(root, first.run.clock.value + 5 * MINUTE, two);
  assert.equal(second.told.length, 1, 'a second purpose with the same code');
  const third = await restoreRun(root, second.run.clock.value + 5 * MINUTE, two);
  assert.equal(third.told.length, 0);

  // A record from before keys carried the purpose: its key matches nothing, so the set is told once
  // more (and then remembered with the new keys).
  const legacy = dataRoot(t);
  fs.writeFileSync(statePath(legacy), JSON.stringify({
    schema: 1, bootId: 'e'.repeat(32), startedAtMs: BASE_MS, readyAtMs: BASE_MS, lastHealthyAtMs: BASE_MS,
    stop: { kind: 'signal', atMs: BASE_MS }, pending: null, guildNoticeAtMs: {},
    restoreSeen: { atMs: BASE_MS, keys: ['LEDGER_FILES_MISSING:all'] },
  }));
  const again = await restoreRun(legacy, BASE_MS + HOUR, one);
  assert.equal(again.told.length, 1);
  const next = await restoreRun(legacy, again.run.clock.value + 5 * MINUTE, one);
  assert.equal(next.told.length, 0);
});

function writeRestoreSeen(root, restoreSeen) {
  fs.writeFileSync(statePath(root), JSON.stringify({
    schema: 1, bootId: 'd'.repeat(32), startedAtMs: BASE_MS, readyAtMs: BASE_MS, lastHealthyAtMs: BASE_MS,
    stop: { kind: 'signal', atMs: BASE_MS }, pending: null, guildNoticeAtMs: {}, restoreSeen,
  }));
}

test('a set told at a time far ahead of the clock is not believed, and five minutes ahead still is', async (t) => {
  const report = restoreReport();
  const keys = restoreEvidenceOf(report).keys;
  const at = BASE_MS + HOUR;
  for (const [seenAt, expected, label] of [
    [at + 100 * 365 * 24 * HOUR, 1, 'a hundred years ahead'],
    [at + 5 * MINUTE + 1, 1, 'one millisecond past the tolerance'],
    [at + 5 * MINUTE, 0, 'exactly the tolerance'],
    [at - HOUR, 0, 'an hour ago'],
    [at - RESTORE_REPEAT_MS + 1, 0, 'a millisecond short of a week ago'],
    [at - RESTORE_REPEAT_MS, 1, 'a week ago'],
  ]) {
    const root = dataRoot(t);
    writeRestoreSeen(root, { atMs: seenAt, keys });
    const result = await restoreRun(root, at, report);
    assert.equal(result.told.length, expected, label);
  }
});

test('at most 16 keys are remembered, and a record with more is not one this module wrote', async (t) => {
  const keys = Array.from({ length: 17 }, (_, index) => `LEDGER_SIGN_${String.fromCharCode(65 + index)}`);
  const base = {
    schema: 1, bootId: 'f'.repeat(32), startedAtMs: BASE_MS, readyAtMs: BASE_MS, lastHealthyAtMs: BASE_MS,
    stop: { kind: 'signal', atMs: BASE_MS }, pending: null, guildNoticeAtMs: {},
  };
  assert.ok(parseStateText(JSON.stringify({ ...base, restoreSeen: { atMs: BASE_MS, keys: keys.slice(0, 16) } })));
  assert.equal(parseStateText(JSON.stringify({ ...base, restoreSeen: { atMs: BASE_MS, keys } })), null);
  // More signs than that at one start: eight are recorded in the pending, sixteen remembered.
  const root = dataRoot(t);
  const run = startProcess(root, { clock: { value: BASE_MS } });
  run.ready({ recovery: keys });
  const seen = readState(root).restoreSeen;
  assert.equal(seen.keys.length, 16);
  assert.equal(readState(root).pending.recovery.length, 8);
});

test('a connection outage replaces a pending that was told in part even while its delivery is still waiting', async (t) => {
  const { root, run } = await pendingProcess(t);
  // The delivery ends one server's notice and asks to be tried again at the next heartbeat.
  run.monitor.attachDelivery(async (store) => {
    store.settleGuild(GUILD_A, 'sent');
    return 'waiting';
  });
  await run.advance(STABLE_AFTER_READY_MS);
  const told = readState(root).pending;
  assert.deepEqual(told.guilds, { [GUILD_A]: 'sent' });
  // The connection goes away for twelve minutes.
  run.client.ready = false;
  await run.advance(12 * MINUTE);
  run.client.ready = true;
  await run.advance(MINUTE);
  const fresh = readState(root).pending;
  assert.notEqual(fresh.id, told.id);
  assert.deepEqual([fresh.kind, fresh.guilds], ['connection', {}]);
  assert.ok(run.lines().includes('[OUTAGE_MONITOR] code=OUTAGE_PENDING_SUPERSEDED stage=heartbeat'));
});

// index.js reads the record before anything else can fail, notes ready once from a prepended
// listener, writes a signal stop synchronously before the stop begins, and stops the heartbeat
// first thing in shutdown().
test('index.js begins the monitor after the guard, notes ready and signal stops, and stops it first', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8').replace(/\r\n/gu, '\n');
  const guardBegin = source.indexOf('ownerDmStartGuard.begin();');
  const begin = source.indexOf('outageMonitor.begin();');
  assert.ok(guardBegin > 0 && begin > guardBegin);
  for (const later of ["require('discord.js')", 'new Client({', 'async function start() {',
    "requireEnvValue('DISCORD_TOKEN', token);"]) {
    assert.ok(begin < source.indexOf(later), later);
  }
  assert.equal(source.split('outageMonitor.begin()').length, 2, 'begun once');
  assert.match(source, /createOutageMonitor\(\{\n {2}runtimeMode: testControlRuntimeController\.active \? 'test-control' : 'production',\n {2}ownerDmGate: ownerDmStartGuard,\n\}\);/u);

  // Ready: prepended after the event files are registered, once, and before the ready check.
  const ready = '\nclient.prependOnceListener(Events.ClientReady, () =>\n' +
    '  outageMonitor.noteReady(client, { bootReport: protectedEffects.bootReport }));\n';
  const readyAt = source.indexOf(ready);
  assert.ok(readyAt > source.indexOf('registerEvents(client,'));
  assert.ok(readyAt < source.indexOf('client.prependOnceListener(Events.ClientReady, (readyClient) => {'));
  assert.equal(source.split('outageMonitor.noteReady(').length, 2, 'registered once');
  // The notice is handed to the monitor once, with the Owner notifier and without the AI.
  assert.equal(source.split('outageMonitor.attachDelivery(').length, 2);
  assert.match(source, /outageMonitor\.attachDelivery\(createOutageNotice\(\{ client, ownerNotifier: ownerSafetyNotifier, logger \}\)\.deliver\);/u);
  // The ledger bootstrap report is handed over for its signs of a restored backup.
  assert.equal(source.includes('outageMonitor.noteReady(client, { bootReport: protectedEffects.bootReport })'), true);

  // Signals: written before the stop, by the two signal handlers only.
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const handler = source.slice(source.indexOf(`process.on('${signal}', () => {`));
    assert.match(handler, new RegExp(String.raw`^process\.on\('${signal}', \(\) => \{` + String.raw`\n[^}]*\n {4}outageMonitor\.noteSignalStop\(\);` +
      String.raw`\n {4}void shutdown\('${signal}'\);`, 'u'));
  }
  assert.equal(source.split('outageMonitor.noteSignalStop()').length, 5);

  // The stop: first thing, before any step that can wait, and a failed start is no signal.
  const shutdown = source.slice(source.indexOf('async function shutdown('), source.indexOf('testControlRuntimeController.bindShutdown('));
  assert.match(shutdown, /shutdownStarted = true;\n(?: {2}\/\/[^\n]*\n)* {2}outageMonitor\.stop\(\);\n/u);
  assert.ok(shutdown.indexOf('outageMonitor.stop();') < shutdown.indexOf('flushMemberRecords();'));
  assert.ok(shutdown.indexOf('outageMonitor.stop();') < shutdown.indexOf('await protectedEffects.stop();'));
  assert.equal(shutdown.includes('noteSignalStop'), false);
  assert.equal(source.slice(source.indexOf('start().catch(')).includes('outageMonitor'), false);
});

// The code of index.js that registers the stop handlers, taken out of the source and run against a fake
// process, so what is tested is the code that runs.
function indexBlock(source, from, untilMarker) {
  const start = source.indexOf(from);
  assert.ok(start > 0, from);
  const end = source.indexOf(untilMarker, start) + untilMarker.length;
  assert.ok(end > start, untilMarker);
  return source.slice(start, end);
}

function runBlock(code, dependencies, returns = '') {
  return new Function('dependencies', `with (dependencies) { ${code}\nreturn { ${returns} }; }`)(dependencies);
}

// What this pins is the code, not a signal: Node calls a signal listener only when the event loop turns, and
// the modules load without it turning, so the early function does not run in the loading window (its being a
// listener is what holds a signal there for the real handlers, which replace it before the loop first turns).
// A signal cannot be sent to a process on Windows either, so the body is run against a fake process.
test('the handler that stands in while the modules load is registered before they do and writes a stop down; on Windows the console window and Ctrl-Break are stops', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8').replace(/\r\n/gu, '\n');
  // Registered right after the record is read, before the heavy modules are loaded.
  const earlyAt = source.indexOf('const earlyStop = () => {');
  assert.ok(earlyAt > source.indexOf('outageMonitor.begin();'));
  assert.ok(earlyAt < source.indexOf("require('discord.js')"));
  assert.ok(earlyAt < source.indexOf('async function start() {'));
  const early = indexBlock(source, 'const STOP_SIGNALS =', '  for (const signal of STOP_SIGNALS) process.on(signal, earlyStop);\n}\n');

  const fakeProcess = (platform, active) => {
    const handlers = new Map();
    const events = [];
    const dependencies = {
      process: { platform, on(signal, handler) { handlers.set(signal, handler); }, exit(code) { events.push(`exit:${code}`); } },
      testControlRuntimeController: { active },
      ownerDmStartGuard: { noteSignalStop() { events.push('guard'); } },
      outageMonitor: { noteSignalStop() { events.push('monitor'); } },
    };
    return { handlers, events, ...runBlock(early, dependencies, 'STOP_SIGNALS, earlyStop') };
  };
  const windows = fakeProcess('win32', false);
  assert.deepEqual([...windows.handlers.keys()], ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);
  assert.deepEqual(windows.STOP_SIGNALS, ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK']);
  // Each writes the guard and the record, in that order, and ends the process with 0 (a stop asked for).
  for (const signal of windows.handlers.keys()) {
    windows.events.length = 0;
    windows.handlers.get(signal)();
    assert.deepEqual(windows.events, ['guard', 'monitor', 'exit:0'], signal);
  }
  const linux = fakeProcess('linux', false);
  assert.deepEqual([...linux.handlers.keys()], ['SIGINT', 'SIGTERM']);
  // Test-control has its own stop: nothing is registered.
  assert.deepEqual([...fakeProcess('win32', true).handlers.keys()], []);

  // The real handlers take the early one's place, and the Windows ones come after SIGTERM's.
  const removeAt = source.indexOf('for (const signal of STOP_SIGNALS) process.removeListener(signal, earlyStop);');
  assert.ok(removeAt > source.indexOf('async function shutdown('));
  assert.ok(removeAt < source.indexOf("process.on('SIGINT', () => {"));
  const windowsBlock = indexBlock(source, "if (process.platform === 'win32' && !testControlPolicy) {", '\n}\n');
  const realHandlers = (platform, policy) => {
    const handlers = new Map();
    const events = [];
    const dependencies = {
      process: { platform, on(signal, handler) { handlers.set(signal, handler); } },
      testControlPolicy: policy,
      ownerDmStartGuard: { noteSignalStop() { events.push('guard'); } },
      outageMonitor: { noteSignalStop() { events.push('monitor'); } },
      shutdown(signal) { events.push(`shutdown:${signal}`); return Promise.resolve(); },
    };
    runBlock(windowsBlock, dependencies);
    return { handlers, events };
  };
  const real = realHandlers('win32', null);
  assert.deepEqual([...real.handlers.keys()], ['SIGHUP', 'SIGBREAK']);
  for (const signal of real.handlers.keys()) {
    real.events.length = 0;
    real.handlers.get(signal)();
    // The record is written before the stop begins.
    assert.deepEqual(real.events, ['guard', 'monitor', `shutdown:${signal}`], signal);
  }
  assert.deepEqual([...realHandlers('linux', null).handlers.keys()], []);
  assert.deepEqual([...realHandlers('win32', {}).handlers.keys()], [], 'test-control keeps the default');
});