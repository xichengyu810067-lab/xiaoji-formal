'use strict';

// An outage that ended, as index.js wires it: the liveness record, the ledger bootstrap's report,
// the Owner DM start guard, the real Owner notifier with its ledger, and the fixed public notice.
// Each "bot" below is one process (a monitor, the protected effects, the runtimes); one that is
// stopped without a signal stands for a crash. The REST records every request and never reaches
// Discord; the clock of the monitor is injected, and moved a minute at a time like a heartbeat.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  GUARD_FILE_NAME,
  createOwnerDmStartGuard,
  writeGuardFile,
} = require('../src/systems/safety/ownerDmStartGuard');
const {
  HEARTBEAT_MS,
  STABLE_AFTER_READY_MS,
  STATE_FILE_NAME,
  createOutageMonitor,
  restoreSignsOf,
} = require('../src/systems/safety/outageMonitor');
const { createOutageNotice, outageNoticeText } = require('../src/systems/safety/outageNotice');
const { failedBootstrapReport } = require('../src/systems/safety/ledgerAlerts');
const {
  DM_CHANNEL_ID,
  capturingLogger,
  createLayout,
  createProcess,
  filesUnder,
  openCoinDatabase,
  ownerMessages,
  recordingRest,
} = require('./fixtures/protectedEffectsHarness');

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const GUILD_A = '810000000000000001';
const GUILD_B = '810000000000000002';
const SYSTEM_A = '820000000000000001';
const SYSTEM_B = '820000000000000002';
const RECOVERY_HEADING = '小吉恢復營運通知';

function channel(id) {
  return { id, isTextBased: () => true, permissionsFor: () => ({ has: () => true }) };
}

function guild(id, systemChannelId, joinedTimestamp) {
  return { id, joinedTimestamp, available: true, channels: { cache: new Map() }, systemChannel: channel(systemChannelId),
    members: { me: { id: '10000000000000001', partial: false } } };
}

function recoveryMessages(rest) {
  return ownerMessages(rest).filter((text) => text.startsWith(RECOVERY_HEADING));
}

// Every message the bot posted to a server channel (not to the Owner).
function serverMessages(rest) {
  return rest.calls.filter(([method, route]) => method === 'POST' && /^\/channels\/\d+\/messages$/u.test(route) &&
    route !== `/channels/${DM_CHANNEL_ID}/messages`);
}

function createWorld(t, name) {
  const layout = createLayout(t, name);
  const clock = { value: Date.now() };
  // The bot was in both servers long before any outage this test makes.
  const joinedAt = clock.value - 30 * 24 * HOUR;
  const guilds = [guild(GUILD_A, SYSTEM_A, joinedAt), guild(GUILD_B, SYSTEM_B, joinedAt)];
  return { layout, clock, rest: recordingRest(), guilds, started: 0 };
}

function stateOf(world) {
  const file = path.join(world.layout.dataDir, STATE_FILE_NAME);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

// One process of the bot. gateway.up is what client.isReady() answers.
// ledgerClock: the ledgers (and so the Owner notice budgets of their durable counts) read the test's
// clock, so notices hours apart in the test are hours apart for them too.
async function startBot(world, { runtimeMode = 'production', env = {}, ownerDmGate = null, bootstrap = null,
  gateway = { up: true }, ledgerClock = false } = {}) {
  await openCoinDatabase(world.layout, { fresh: world.started === 0 });
  world.started += 1;
  const proc = createProcess(world.layout, { env, rest: world.rest, ownerDmGate, ...(bootstrap ? { bootstrap } : {}),
    ...(ledgerClock ? { bootstrapOptions: { now: () => world.clock.value } } : {}) });
  proc.client.guilds = { cache: new Map(world.guilds.map((item) => [item.id, item])) };
  proc.client.isReady = () => gateway.up;
  const monitor = createOutageMonitor({
    runtimeMode,
    env: { ...env, XIAOJI_DATA_ROOT: world.layout.dataDir },
    coinDbPath: world.layout.coinDbPath,
    projectRoot: world.layout.project,
    logger: proc.logger,
    now: () => world.clock.value,
    monotonic: () => world.clock.value,
    gatewayHealthy: (candidate) => candidate.isReady(),
    ownerDmGate,
    setIntervalFn: () => ({ unref() {} }),
    clearIntervalFn() {},
  });
  // index.js: the monitor begins first, the bootstrap runs in the preflight, the notice is attached
  // with the Owner notifier, and ClientReady hands over what the bootstrap found.
  monitor.begin();
  await proc.preflight();
  await proc.ready();
  const notice = createOutageNotice({ client: proc.client, ownerNotifier: proc.owner, logger: proc.logger,
    getConfig: () => ({ welcomeChannelId: null }), sleep: async () => {} });
  monitor.attachDelivery(notice.deliver);
  monitor.noteReady(proc.client, { bootReport: proc.protectedEffects.bootReport });
  return {
    proc,
    monitor,
    gateway,
    // The clock moves on with a heartbeat each `step`; the Owner's DM is waited for.
    async advance(ms, step = HEARTBEAT_MS) {
      for (let left = ms; left > 0;) {
        const part = Math.min(step, left);
        world.clock.value += part;
        left -= part;
        await monitor.tick();
        await proc.owner.waitForIdleForTests();
      }
    },
    // No signal: the record still says running.
    async crash() {
      await proc.stop();
    },
    // SIGTERM: the record is written first, then the stop.
    async terminate() {
      monitor.noteSignalStop();
      monitor.stop();
      await proc.stop();
    },
  };
}

test('a crash that lasted 25 minutes: nothing before the steady time, then one Owner notice and one notice per server', async (t) => {
  const world = createWorld(t, 'recovery-crash');
  const first = await startBot(world);
  await first.advance(3 * MINUTE);
  const lastHealthy = world.clock.value;
  await first.crash();
  world.clock.value += 25 * MINUTE;
  const readyAt = world.clock.value;
  const second = await startBot(world);
  assert.equal(stateOf(world).pending.startedAtMs, lastHealthy);
  assert.equal(stateOf(world).pending.endedAtMs, readyAt);
  assert.equal(stateOf(world).pending.owner, 'none');

  // Ten minutes after ready is not enough; thirty seconds more is.
  await second.advance(10 * MINUTE);
  assert.deepEqual(recoveryMessages(world.rest), []);
  assert.deepEqual(serverMessages(world.rest), []);
  await second.advance(STABLE_AFTER_READY_MS - 10 * MINUTE - 1);
  assert.deepEqual(recoveryMessages(world.rest), []);
  await second.advance(1);
  const minutes = Math.round((readyAt - lastHealthy) / MINUTE);
  assert.deepEqual(recoveryMessages(world.rest), [
    `小吉恢復營運通知。固定代碼：OWNER_EVENT_RECOVERED；停運開始：<t:${Math.floor(lastHealthy / 1_000)}:F>；` +
    `恢復時間：<t:${Math.floor(readyAt / 1_000)}:F>；類型：程式異常結束後重新啟動`]);
  const posted = serverMessages(world.rest);
  assert.deepEqual(posted.map(([, route]) => route).sort(),
    [`/channels/${SYSTEM_A}/messages`, `/channels/${SYSTEM_B}/messages`]);
  for (const [, , body] of posted) {
    assert.deepEqual(body, { content: outageNoticeText(minutes), allowed_mentions: { parse: [], users: [], roles: [],
      replied_user: false } });
  }
  assert.equal(stateOf(world).pending, null, 'told, so no longer waiting');
  // Nothing again, however long it runs on.
  await second.advance(20 * MINUTE);
  assert.equal(recoveryMessages(world.rest).length, 1);
  assert.equal(serverMessages(world.rest).length, 2);
  // The ledger's own notice of the start is a separate message, never merged with this one.
  assert.ok(ownerMessages(world.rest).some((text) => text.startsWith('小吉安全帳本通知')));
  await second.terminate();
});

test('a normal stop (SIGTERM) is not an outage: the next start tells nobody, however long the gap', async (t) => {
  const world = createWorld(t, 'recovery-planned');
  const first = await startBot(world);
  await first.advance(5 * MINUTE);
  await first.terminate();
  assert.equal(stateOf(world).stop.kind, 'signal');
  world.clock.value += 3 * 24 * HOUR;
  const second = await startBot(world);
  await second.advance(STABLE_AFTER_READY_MS + 5 * MINUTE);
  assert.deepEqual(recoveryMessages(world.rest), []);
  assert.deepEqual(serverMessages(world.rest), []);
  assert.equal(stateOf(world).pending, null);
  await second.terminate();
});

test('a restart storm is one outage: nothing is told before a start is steady, then one round', async (t) => {
  const world = createWorld(t, 'recovery-storm');
  const first = await startBot(world);
  await first.advance(MINUTE);
  const lastHealthy = world.clock.value;
  await first.crash();
  world.clock.value += 15 * MINUTE;
  // Five starts in a row, each up for two minutes and then gone.
  for (let run = 0; run < 5; run += 1) {
    const bot = await startBot(world);
    await bot.advance(2 * MINUTE);
    assert.deepEqual(recoveryMessages(world.rest), [], `run ${run}`);
    assert.deepEqual(serverMessages(world.rest), [], `run ${run}`);
    await bot.crash();
    world.clock.value += MINUTE;
  }
  const steady = await startBot(world);
  assert.equal(stateOf(world).pending.startedAtMs, lastHealthy, 'one outage, from the last healthy moment');
  assert.equal(stateOf(world).pending.owner, 'none');
  await steady.advance(10 * MINUTE);
  assert.deepEqual(recoveryMessages(world.rest), []);
  assert.deepEqual(serverMessages(world.rest), []);
  await steady.advance(MINUTE);
  assert.equal(recoveryMessages(world.rest).length, 1);
  assert.equal(serverMessages(world.rest).length, 2);
  await steady.advance(30 * MINUTE);
  assert.equal(recoveryMessages(world.rest).length, 1);
  assert.equal(serverMessages(world.rest).length, 2);
  await steady.terminate();
});

// The Owner DM start guard of a start that follows three that failed, with its count in its own
// folder outside the program folder, as the harness's other tests have it.
function heldStartGuard(world) {
  const base = path.join(world.layout.root, 'guard');
  fs.mkdirSync(base, { recursive: true });
  writeGuardFile(path.join(base, GUARD_FILE_NAME), 3, 1);
  const timers = [];
  const guard = createOwnerDmStartGuard({ env: { XIAOJI_DATA_ROOT: base }, coinDbPath: path.join(base, 'xiaoji.sqlite'),
    logger: capturingLogger(), setTimer: (callback) => { timers.push(callback); return { unref() {} }; } });
  guard.begin();
  assert.equal(guard.allowsOwnerDm(), false);
  return { guard, succeed: () => { guard.noteReady(); timers[0](); } };
}

test('after three failed starts nothing is sent until the guard lets Owner DMs through, and then once', async (t) => {
  const world = createWorld(t, 'recovery-guard');
  const first = await startBot(world);
  await first.advance(2 * MINUTE);
  await first.crash();
  world.clock.value += 20 * MINUTE;
  const held = heldStartGuard(world);
  const bot = await startBot(world, { ownerDmGate: held.guard });
  assert.equal(stateOf(world).pending.owner, 'none');
  // Long past the steady time, with the guard still holding: nothing, and the pending is kept.
  await bot.advance(STABLE_AFTER_READY_MS + 15 * MINUTE);
  assert.deepEqual(recoveryMessages(world.rest), []);
  assert.deepEqual(serverMessages(world.rest), []);
  assert.ok(stateOf(world).pending);
  // The start succeeds (ten quiet minutes after ready): the next heartbeat delivers, once.
  held.succeed();
  await bot.advance(MINUTE);
  assert.equal(recoveryMessages(world.rest).length, 1);
  assert.equal(serverMessages(world.rest).length, 2);
  await bot.advance(20 * MINUTE);
  assert.equal(recoveryMessages(world.rest).length, 1);
  assert.equal(serverMessages(world.rest).length, 2);
  await bot.terminate();
});

test('the process lives but the gateway was gone for twelve minutes: a connection outage, told once the connection is steady', async (t) => {
  const world = createWorld(t, 'recovery-gateway');
  const bot = await startBot(world);
  await bot.advance(2 * MINUTE);
  const lastHealthy = world.clock.value;
  bot.gateway.up = false;
  await bot.advance(12 * MINUTE);
  assert.equal(stateOf(world).lastHealthyAtMs, lastHealthy, 'not moved while the client was not ready');
  assert.equal(stateOf(world).pending, null);
  bot.gateway.up = true;
  await bot.advance(MINUTE);
  const found = stateOf(world).pending;
  assert.deepEqual([found.kind, found.startedAtMs, found.endedAtMs], ['connection', lastHealthy, world.clock.value]);
  assert.deepEqual(recoveryMessages(world.rest), []);
  await bot.advance(STABLE_AFTER_READY_MS);
  const messages = recoveryMessages(world.rest);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].endsWith('類型：與 Discord 連線中斷後恢復'));
  assert.equal(serverMessages(world.rest).length, 2);
  await bot.terminate();
});

test('a restored backup is the Owner\'s matter: its signs make a restore notice, and no server hears of it', async (t) => {
  const world = createWorld(t, 'recovery-restore');
  const first = await startBot(world, { ledgerClock: true });
  await first.advance(MINUTE);
  await first.terminate();
  const paths = world.layout.paths('welcome');
  const copy = { database: fs.readFileSync(paths.database), anchor: fs.readFileSync(paths.anchor),
    witness: fs.readFileSync(paths.witness) };
  // Another run moves the ledger on (and the registration with it); then the older copy comes back.
  world.clock.value += HOUR;
  const second = await startBot(world, { ledgerClock: true });
  await second.advance(MINUTE);
  await second.terminate();
  for (const role of Object.keys(copy)) fs.writeFileSync(paths[role], copy[role]);

  world.clock.value += HOUR;
  const third = await startBot(world, { ledgerClock: true });
  const report = third.proc.protectedEffects.bootReport;
  assert.deepEqual(restoreSignsOf(report), ['LEDGER_ROLLBACK:registration-ahead']);
  const pending = stateOf(world).pending;
  assert.deepEqual([pending.kind, pending.recovery, pending.startedAtMs === pending.endedAtMs],
    ['restore', ['LEDGER_ROLLBACK:registration-ahead'], true], 'no gap: a restore alone');
  await third.advance(STABLE_AFTER_READY_MS);
  const messages = recoveryMessages(world.rest);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].endsWith('類型：手動還原後恢復'), messages[0]);
  // The public hears nothing, and the Owner's text carries no code or path.
  assert.deepEqual(serverMessages(world.rest), []);
  assert.doesNotMatch(messages[0], /LEDGER|sqlite|[A-Za-z]:\\/u);
  await third.terminate();

  // The signs stay (the ledger stays failed closed until reinit), so every later start shows them
  // again: planned or not, it is the same event, and the Owner is told once.
  for (let index = 0; index < 5; index += 1) {
    world.clock.value += HOUR;
    const later = await startBot(world, { ledgerClock: true });
    assert.deepEqual(restoreSignsOf(later.proc.protectedEffects.bootReport), ['LEDGER_ROLLBACK:registration-ahead']);
    await later.advance(STABLE_AFTER_READY_MS + MINUTE);
    await later.terminate();
  }
  assert.equal(recoveryMessages(world.rest).length, 1, 'five more starts, no more notices');
  assert.deepEqual(serverMessages(world.rest), []);
  assert.equal(stateOf(world).restoreSeen.keys.length, 1);
});

test('a real outage after the same signs were told is told as itself, with its own budget', async (t) => {
  const world = createWorld(t, 'recovery-restore-then-crash');
  const first = await startBot(world, { ledgerClock: true });
  await first.advance(MINUTE);
  await first.terminate();
  const paths = world.layout.paths('welcome');
  const copy = { database: fs.readFileSync(paths.database), anchor: fs.readFileSync(paths.anchor),
    witness: fs.readFileSync(paths.witness) };
  world.clock.value += HOUR;
  const second = await startBot(world, { ledgerClock: true });
  await second.advance(MINUTE);
  await second.terminate();
  for (const role of Object.keys(copy)) fs.writeFileSync(paths[role], copy[role]);

  world.clock.value += HOUR;
  const third = await startBot(world, { ledgerClock: true });
  await third.advance(STABLE_AFTER_READY_MS);
  assert.equal(recoveryMessages(world.rest).length, 1);
  await third.crash();
  // A crash that lasts 40 minutes: the signs are the same and are not told again; the outage is.
  world.clock.value += 40 * MINUTE;
  const fourth = await startBot(world, { ledgerClock: true });
  assert.equal(stateOf(world).pending.kind, 'crash');
  assert.deepEqual(stateOf(world).pending.recovery, []);
  await fourth.advance(STABLE_AFTER_READY_MS);
  const messages = recoveryMessages(world.rest);
  assert.equal(messages.length, 2);
  assert.ok(messages[0].endsWith('類型：手動還原後恢復'));
  assert.ok(messages[1].endsWith('類型：程式異常結束後重新啟動'));
  assert.equal(serverMessages(world.rest).length, 2);
  await fourth.terminate();
});

test('the kill switch off sends nothing, and test-control reads and writes nothing and sends nothing', async (t) => {
  // XIAOJI_PROTECTED_EFFECTS=off: no ledger, no Owner notice and no server notice; the pending is dropped.
  const off = createWorld(t, 'recovery-off');
  const env = { XIAOJI_PROTECTED_EFFECTS: 'off' };
  const first = await startBot(off, { env });
  await first.advance(2 * MINUTE);
  await first.crash();
  off.clock.value += 30 * MINUTE;
  const second = await startBot(off, { env });
  await second.advance(STABLE_AFTER_READY_MS + 5 * MINUTE);
  assert.deepEqual(off.rest.calls.filter(([method]) => method !== 'GET'), []);
  assert.equal(stateOf(off).pending, null);
  assert.ok(second.proc.logger.lines.some(([, line]) => line === '[OUTAGE_MONITOR] code=OUTAGE_NOTICE_DISABLED reason=protected-effects-off'));
  await second.crash();

  // test-control: the monitor is off, so no file of its own appears and no request is made.
  const control = createWorld(t, 'recovery-test-control');
  const run1 = await startBot(control, { runtimeMode: 'test-control' });
  await run1.advance(2 * MINUTE);
  await run1.crash();
  control.clock.value += 30 * MINUTE;
  const run2 = await startBot(control, { runtimeMode: 'test-control' });
  await run2.advance(STABLE_AFTER_READY_MS + 5 * MINUTE);
  assert.deepEqual(filesUnder(control.layout.dataDir).filter((file) => file.includes('outage')), []);
  assert.deepEqual(recoveryMessages(control.rest), []);
  assert.deepEqual(serverMessages(control.rest), []);
  assert.equal(run2.monitor.status().mode, 'inactive');
  await run2.crash();
});

test('when the Owner notifier cannot take the notice it is only logged, the servers are still told, and the pending waits for a later start', async (t) => {
  const world = createWorld(t, 'recovery-owner-off');
  const first = await startBot(world);
  await first.advance(2 * MINUTE);
  await first.crash();
  world.clock.value += 20 * MINUTE;
  // The Owner ledger could not be had in this start: no ledger at all.
  const noLedgers = async () => ({
    report: failedBootstrapReport({ runtimeMode: 'production' }),
    ledgers: new Map(),
    recordLastSeen: async () => ({ written: 0 }),
    close() {},
  });
  const second = await startBot(world, { bootstrap: noLedgers });
  assert.equal(second.proc.owner.isReady(), false);
  await second.advance(STABLE_AFTER_READY_MS + 3 * MINUTE);
  assert.deepEqual(recoveryMessages(world.rest), []);
  // The only Owner DM is the ledger's own emergency DM about the failed bootstrap; it says nothing of
  // the outage, and none is made for the outage.
  const emergencies = ownerMessages(world.rest).filter((text) => text.startsWith('小吉緊急'));
  assert.equal(emergencies.length, 1);
  assert.doesNotMatch(emergencies[0], /停運|恢復營運/u);
  assert.equal(serverMessages(world.rest).length, 2, 'the notice to the servers does not need the Owner ledger');
  assert.equal(second.proc.logger.lines.filter(([, line]) => line.includes('OUTAGE_OWNER_NOTICE_UNAVAILABLE')).length, 1);
  assert.equal(stateOf(world).pending.owner, 'none');
  await second.crash();

  // A later start, with the Owner ledger back, hands it over; the servers are not told again.
  world.clock.value += 5 * MINUTE;
  const third = await startBot(world);
  await third.advance(STABLE_AFTER_READY_MS);
  assert.equal(recoveryMessages(world.rest).length, 1);
  assert.equal(serverMessages(world.rest).length, 2);
  assert.equal(stateOf(world).pending, null);
  await third.terminate();
});
