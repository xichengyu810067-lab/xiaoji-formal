'use strict';

// The life cycle of the protected side effects as index.js wires it: the bot identity, the
// bootstrap, arming at ready, the Owner notices, the status cards, and the stop. Real
// ledgers in temporary folders; no request reaches Discord.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { Events } = require('discord.js');
const { getHostOperationContext } = require('../src/platform/hostOperationContext');
const { registerEvents } = require('../src/handlers/registerEvents');
const { bootstrapSafetyLedgers } = require('../src/systems/safety/ledgerBootstrap');
const { HINTS, REPORTER_CODES, REPORTER_OPERATION } = require('../src/systems/safety/ledgerAlerts');
const { PURPOSE_IDS } = require('../src/systems/safety/ledgerLayout');
const { restoreSignsOf } = require('../src/systems/safety/outageMonitor');
const {
  GUARD_FILE_NAME,
  createOwnerDmStartGuard,
  writeGuardFile,
} = require('../src/systems/safety/ownerDmStartGuard');
const {
  IDENTITY_ATTEMPTS,
  createProtectedEffects,
  resolveBotIdentity,
} = require('../src/systems/safety/protectedEffects');
const { buildFeatureStatuses, buildPublicStatusSnapshot } = require('../src/services/publicStatusService');
const coinDatabase = require('../src/services/coinDatabase');
const { createReporter } = require('../src/platform/testControlPolicy');
const { parseSafeControlLine, safeControlLine } = require('../src/platform/testControlProtocol');
const {
  BOT_ID,
  DM_CHANNEL_ID,
  OTHER_APPLICATION_ID,
  OWNER_ID,
  capturingLogger,
  createLayout,
  createProcess,
  filesUnder,
  openCoinDatabase,
  ownerMessages,
  protectedCalls,
  recordingRest,
  registrations,
} = require('./fixtures/protectedEffectsHarness');

const FEATURES = ['welcome', 'word_chain', 'number_chain'];
const PURPOSE_NAMES = ['Owner 安全通知', '新人歡迎', '扣薪公告', '工作提醒（私訊準備）', '工作提醒（私訊）', '自動離群（休眠）',
  '文字接龍 ✅', '數字接龍 ✅'];

function routes(rest) {
  return protectedCalls(rest).map(([method, route]) => `${method} ${route}`);
}

function escalationCodes(source) {
  return source.getLedgerEscalations().map(({ purposeId, code, stage }) => `${purposeId}|${code}|${stage}`).sort();
}

// A text for the Owner: no Discord ID, no path, and never the data-root variable.
function assertFixedText(text) {
  assert.doesNotMatch(text, /\d{17,20}/u);
  assert.doesNotMatch(text, /[A-Za-z]:\\|[\\/](?:project|data|safety)[\\/]|\.sqlite/u);
  assert.equal(text.includes('XIAOJI_DATA_ROOT'), false);
}

test('the coin database outside the program folder, no XIAOJI_DATA_ROOT: eight ledgers beside it, armed at ready',
  async (t) => {
    const layout = createLayout(t, 'outside');
    await openCoinDatabase(layout, { fresh: true });
    const proc = createProcess(layout, { env: {} });
    const started = await proc.preflight();
    assert.equal(proc.protectedEffects.identity.source, 'token');
    assert.equal(started.ledgers.size, PURPOSE_IDS.length);
    assert.deepEqual([started.owner.enabled, started.welcome.enabled, started.public.disabled], [true, true, []]);
    // One LEDGER_CREATED line per purpose (README, 升級與資料位置 step 8).
    assert.deepEqual(proc.logger.lines.filter(([, line]) => line.includes('code=LEDGER_CREATED')),
      PURPOSE_IDS.map((purposeId) => ['info', `[SAFETY_LEDGER] purpose=${purposeId} code=LEDGER_CREATED`]));
    // Created in the coin database's folder (safety/, safety-witness/); nothing in the program folder.
    for (const purposeId of PURPOSE_IDS) {
      const paths = layout.paths(purposeId);
      assert.ok(fs.existsSync(paths.database) && fs.existsSync(paths.witness), purposeId);
    }
    assert.deepEqual(filesUnder(layout.project), []);
    // Before ready nothing is ready and nothing protected has been sent.
    assert.equal(proc.publicRuntime.isPurposeReady('work.penalty.announce'), false);
    assert.equal(proc.welcome.isReady(), false);
    assert.deepEqual(routes(proc.rest), []);

    await proc.ready();
    assert.equal(proc.publicRuntime.isPurposeReady('work.penalty.announce'), true);
    assert.equal(proc.welcome.isReady(), true);
    assert.equal(proc.owner.isReady(), true);
    // One merged creation notice reached the Owner, through the Owner ledger.
    const messages = ownerMessages(proc.rest);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].startsWith('小吉安全帳本通知（本次啟動）\n已建立：'));
    for (const name of PURPOSE_NAMES) assert.ok(messages[0].includes(name), name);
    assertFixedText(messages[0]);
    assert.deepEqual(routes(proc.rest), ['POST /users/@me/channels', `POST /channels/${DM_CHANNEL_ID}/messages`]);
    assert.deepEqual(FEATURES.map((key) => proc.protectedEffects.featureStatus(key)), [null, null, null]);

    // The stop writes lastSeen: the Owner ledger moved when the notice was sent.
    const counters = started.ledgers.get('owner-safety').identityCounters;
    assert.equal(await proc.stop(), 0);
    const owner = (await registrations())['owner-safety'];
    assert.deepEqual([owner.lastSeen.bootEpoch, owner.lastSeen.beginSeq, owner.lastSeen.chainHead],
      [counters.bootEpoch, counters.beginSeq, counters.chainHead]);
    for (const ledger of started.ledgers.values()) assert.equal(ledger.closed, true);
  });

test('the coin database inside the program folder: every purpose fails closed, nothing is created, one emergency DM',
  async (t) => {
    const layout = createLayout(t, 'in-project', { inProject: true });
    await openCoinDatabase(layout, { fresh: true });
    const clock = { value: Date.UTC(2026, 9, 3, 12) };
    const proc = createProcess(layout, { alertNow: () => clock.value });
    const started = await proc.preflight();
    assert.equal(started.ledgers.size, 0);
    assert.deepEqual([started.owner.enabled, started.welcome.enabled, started.public.enabled], [false, false, []]);
    assert.deepEqual(filesUnder(layout.dataDir), ['xiaoji.sqlite']);
    assert.ok(proc.logger.lines.some(([, line]) =>
      line === '[SAFETY_LEDGER] purpose=welcome code=LEDGER_PATH_IN_PROJECT reason=base'));

    await proc.ready();
    const messages = ownerMessages(proc.rest);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].startsWith('小吉緊急安全提示'));
    assert.ok(messages[0].includes('LEDGER_PATH_IN_PROJECT'));
    assert.ok(messages[0].includes('COIN_DB_PATH'));
    assertFixedText(messages[0]);
    assert.deepEqual(routes(proc.rest), ['POST /users/@me/channels', `POST /channels/${DM_CHANNEL_ID}/messages`]);
    assert.deepEqual(FEATURES.map((key) => proc.protectedEffects.featureStatus(key)), ['broken', 'broken', 'broken']);
    assert.equal(await proc.stop(), 3);

    // A restart within six hours finds the stamp and sends nothing; still nothing created.
    clock.value += 5 * 60 * 60 * 1_000;
    await openCoinDatabase(layout);
    const again = createProcess(layout, { alertNow: () => clock.value });
    await again.preflight();
    await again.ready();
    assert.deepEqual(protectedCalls(again.rest), []);
    assert.equal(await again.stop(), 3);
    assert.deepEqual(filesUnder(layout.dataDir), ['xiaoji.sqlite']);
  });

// The Owner DM start guard of the fourth start after three that failed, with its count in its
// own folder outside the program folder.
function heldStartGuard(layout) {
  const base = path.join(layout.root, 'guard');
  fs.mkdirSync(base);
  writeGuardFile(path.join(base, GUARD_FILE_NAME), 3, 1);
  const timers = [];
  const guard = createOwnerDmStartGuard({ env: { XIAOJI_DATA_ROOT: base }, coinDbPath: path.join(base, 'xiaoji.sqlite'),
    logger: capturingLogger(), setTimer: (callback) => { timers.push(callback); return { unref() {} }; } });
  guard.begin();
  assert.equal(guard.allowsOwnerDm(), false);
  return { guard, succeed: () => { guard.noteReady(); timers[0](); } };
}

test('after three failed starts the ledger creation notice and the emergency DM are both held back; nothing is sent later',
  async (t) => {
    // A first start: the ledgers are created, but their creation notice is not sent.
    const layout = createLayout(t, 'guard-created');
    await openCoinDatabase(layout, { fresh: true });
    const held = heldStartGuard(layout);
    const proc = createProcess(layout, { env: {}, ownerDmGate: held.guard });
    const started = await proc.preflight();
    assert.equal(started.ledgers.size, PURPOSE_IDS.length);
    await proc.ready();
    assert.equal(proc.owner.isReady(), true, 'the Owner ledger itself is fine');
    assert.deepEqual(routes(proc.rest), [], 'no DM channel is prepared and nothing is sent');
    assert.deepEqual(proc.logger.lines.filter(([, line]) => line.includes('OWNER_DM_GUARD')),
      [['warn', '[OWNER_SAFETY] code=OWNER_DM_GUARD_BLOCKED kind=ledger-notice skipped=0']]);
    // The start succeeds: DMs resume, and the held-back notice stays unsent.
    held.succeed();
    await proc.owner.waitForIdleForTests();
    assert.deepEqual(routes(proc.rest), []);
    assert.equal(await proc.stop(), 0);

    // Every purpose failed closed (inside the program folder): the emergency DM is dropped too,
    // and its stamp is not taken, so the next start that may send tells the Owner.
    const inProject = createLayout(t, 'guard-emergency', { inProject: true });
    await openCoinDatabase(inProject, { fresh: true });
    const clock = { value: Date.UTC(2026, 9, 3, 12) };
    const heldAgain = heldStartGuard(inProject);
    const blocked = createProcess(inProject, { alertNow: () => clock.value, ownerDmGate: heldAgain.guard });
    await blocked.preflight();
    await blocked.ready();
    assert.deepEqual(protectedCalls(blocked.rest), []);
    assert.deepEqual(blocked.logger.lines.filter(([, line]) => line.includes('OWNER_DM_GUARD')),
      [['warn', '[SAFETY_LEDGER] code=OWNER_DM_GUARD_BLOCKED kind=emergency skipped=0']]);
    assert.equal(await blocked.stop(), 3, 'the escalation exit code does not depend on the DM');
    clock.value += 60 * 1_000;
    await openCoinDatabase(inProject);
    const next = createProcess(inProject, { alertNow: () => clock.value });
    await next.preflight();
    await next.ready();
    const messages = ownerMessages(next.rest);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].startsWith('小吉緊急安全提示'));
    assert.equal(await next.stop(), 3);
  });

test('the kill switch: no ledger is created or opened, no protected request, and maintenance cards', async (t) => {
  const layout = createLayout(t, 'kill-switch');
  await openCoinDatabase(layout, { fresh: true });
  for (const value of ['off', 'later']) {
    const proc = createProcess(layout, { env: { XIAOJI_PROTECTED_EFFECTS: value } });
    const started = await proc.preflight();
    assert.equal(started.ledgers.size, 0);
    await proc.ready();
    for (const purposeId of PURPOSE_IDS.filter((id) => !['owner-safety', 'welcome'].includes(id))) {
      assert.equal(proc.publicRuntime.isPurposeReady(purposeId), false, purposeId);
    }
    assert.equal(proc.welcome.isReady(), false);
    assert.equal(proc.owner.isReady(), false);
    assert.deepEqual(protectedCalls(proc.rest), []);
    assert.deepEqual(FEATURES.map((key) => proc.protectedEffects.featureStatus(key)),
      ['maintenance', 'maintenance', 'maintenance']);
    assert.equal(await proc.stop(), 0);
    assert.deepEqual(filesUnder(layout.dataDir), ['xiaoji.sqlite']);
    assert.deepEqual(await registrations(), {});
  }
});

test('a configured bot ID that differs at ready: no ledger is created for it, every purpose stays off, one emergency DM',
  async (t) => {
    const layout = createLayout(t, 'bot-mismatch');
    await openCoinDatabase(layout, { fresh: true });
    // GET /users/@me keeps failing, so the configured application ID (another bot) stands in.
    const rest = recordingRest({ identityFailures: IDENTITY_ATTEMPTS });
    const proc = createProcess(layout, { rest, configuredClientId: OTHER_APPLICATION_ID, loggedInAs: BOT_ID });
    const started = await proc.preflight();
    assert.equal(rest.identityCalls, IDENTITY_ATTEMPTS);
    assert.deepEqual(proc.protectedEffects.identity, { botId: OTHER_APPLICATION_ID, source: 'configured' });
    assert.ok(proc.logger.lines.some(([level, line]) => level === 'warn' &&
      line === '[SAFETY_LEDGER] code=LEDGER_BOT_IDENTITY_FALLBACK source=configured'));
    // An ID only the configuration vouches for gets no ledger: nothing is created or registered.
    assert.equal(started.ledgers.size, 0);
    for (const purposeId of PURPOSE_IDS) {
      assert.ok(proc.logger.lines.some(([, line]) =>
        line === `[SAFETY_LEDGER] purpose=${purposeId} code=LEDGER_IDENTITY_UNVERIFIED reason=configured`), purposeId);
    }
    assert.deepEqual(filesUnder(layout.dataDir), ['xiaoji.sqlite']);
    assert.deepEqual(await registrations(), {});

    await proc.ready();
    for (const purposeId of PURPOSE_IDS.filter((id) => !['owner-safety', 'welcome'].includes(id))) {
      assert.equal(proc.publicRuntime.isPurposeReady(purposeId), false, purposeId);
    }
    assert.equal(proc.welcome.isReady(), false);
    assert.equal(proc.owner.isReady(), false);
    const messages = ownerMessages(rest);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].startsWith('小吉緊急安全提示'));
    assert.ok(messages[0].includes('LEDGER_BOT_MISMATCH'));
    assert.ok(messages[0].includes('LEDGER_IDENTITY_UNVERIFIED'));
    assertFixedText(messages[0]);
    assert.deepEqual(routes(rest), ['POST /users/@me/channels', `POST /channels/${DM_CHANNEL_ID}/messages`]);
    assert.deepEqual(FEATURES.map((key) => proc.protectedEffects.featureStatus(key)), ['broken', 'broken', 'broken']);
    assert.ok(escalationCodes(proc.protectedEffects).includes('all|LEDGER_BOT_MISMATCH|open'));
    assert.equal(await proc.stop(), 3);

    // The next start reads the bot ID with its token: the ledgers are created then, for the
    // right bot, and no reinit is needed.
    await openCoinDatabase(layout);
    const next = createProcess(layout, { configuredClientId: OTHER_APPLICATION_ID });
    const created = await next.preflight();
    assert.deepEqual(next.protectedEffects.identity, { botId: BOT_ID, source: 'token' });
    assert.equal(created.ledgers.size, PURPOSE_IDS.length);
    assert.ok(Object.values(await registrations()).every((registration) => registration.botId === BOT_ID));
    await next.ready();
    assert.deepEqual([next.owner.isReady(), next.welcome.isReady()], [true, true]);
    assert.equal(await next.stop(), 0);
  });

test('a configured bot ID opens the ledgers that already exist and never creates one', async (t) => {
  const layout = createLayout(t, 'configured-identity');
  await openCoinDatabase(layout, { fresh: true });
  // Nothing exists yet and GET /users/@me fails: the configured ID (this bot) stands in, and
  // no ledger is created for it.
  const unverified = createProcess(layout, { rest: recordingRest({ identityFailures: IDENTITY_ATTEMPTS }) });
  assert.equal((await unverified.preflight()).ledgers.size, 0);
  assert.deepEqual(unverified.protectedEffects.identity, { botId: BOT_ID, source: 'configured' });
  assert.deepEqual(await registrations(), {});
  await unverified.ready();
  // The Owner ledger does not exist either, so the emergency DM says it, with the fixed hint.
  const messages = ownerMessages(unverified.rest);
  assert.equal(messages.length, 1);
  assert.ok(messages[0].includes('LEDGER_IDENTITY_UNVERIFIED'));
  assert.ok(messages[0].includes(HINTS.LEDGER_IDENTITY_UNVERIFIED));
  assertFixedText(messages[0]);
  assert.equal(await unverified.stop(), 3);

  // A start that reads the ID with the token creates them.
  await openCoinDatabase(layout);
  const verified = createProcess(layout);
  assert.equal((await verified.preflight()).ledgers.size, PURPOSE_IDS.length);
  await verified.ready();
  assert.equal(await verified.stop(), 0);

  // A later start that cannot read it again opens them as they are.
  await openCoinDatabase(layout);
  const reopened = createProcess(layout, { rest: recordingRest({ identityFailures: IDENTITY_ATTEMPTS }) });
  assert.equal((await reopened.preflight()).ledgers.size, PURPOSE_IDS.length);
  assert.equal(reopened.logger.lines.filter(([, line]) => / code=LEDGER_READY$/u.test(line)).length, PURPOSE_IDS.length);
  await reopened.ready();
  assert.deepEqual([reopened.owner.isReady(), reopened.welcome.isReady()], [true, true]);
  assert.equal(reopened.publicRuntime.isPurposeReady('work.penalty.announce'), true);
  assert.equal(await reopened.stop(), 0);
});

test('a bootstrap that rejects fails every purpose closed; the login goes on and the Owner gets an emergency DM',
  async (t) => {
    const layout = createLayout(t, 'bootstrap-rejects');
    await openCoinDatabase(layout, { fresh: true });
    const proc = createProcess(layout, { bootstrap: async () => { throw new Error('synthetic bootstrap failure'); } });
    const started = await proc.preflight();
    assert.equal(started.ledgers.size, 0);
    assert.ok(proc.logger.lines.some(([, line]) => line === '[SAFETY_LEDGER] code=LEDGER_BOOTSTRAP_FAILED stage=start'));
    await proc.ready();
    const messages = ownerMessages(proc.rest);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes('LEDGER_BOOTSTRAP_FAILED'));
    assertFixedText(messages[0]);
    assert.equal(await proc.stop(), 3);
  });

test('a delivered ledger a runtime refuses is told: the Owner\'s by one emergency DM with what was created, welcome in the start notice',
  async (t) => {
    // The Owner notifier refuses its ledger (it shares a reserved path), so only an emergency
    // DM can reach the Owner; it carries the start's creation notice as well.
    const layout = createLayout(t, 'owner-refused');
    await openCoinDatabase(layout, { fresh: true });
    const proc = createProcess(layout);
    const started = await proc.preflight({ reserve: [layout.paths('owner-safety').database] });
    assert.deepEqual(started.owner, { enabled: false, code: 'OWNER_SAFETY_LEDGER_UNAVAILABLE' });
    await proc.ready();
    const messages = ownerMessages(proc.rest);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].startsWith('小吉緊急安全提示'));
    assert.ok(messages[0].includes('停用的功能：Owner 安全通知'));
    assert.ok(messages[0].includes('代碼：OWNER_SAFETY_LEDGER_UNAVAILABLE'));
    assert.ok(messages[0].includes('本次啟動已建立的帳本（cutover 之前的事件不會補發）：'));
    for (const name of PURPOSE_NAMES) assert.ok(messages[0].includes(`・${name}（`), name);
    assertFixedText(messages[0]);
    // Every other purpose runs. The refused Owner ledger alone is escalated: once it is gone
    // only the emergency DM, at most one per 6 hours, can reach the Owner.
    assert.deepEqual([proc.owner.isReady(), proc.welcome.isReady(), proc.publicRuntime.isPurposeReady('work.penalty.announce')],
      [false, true, true]);
    assert.deepEqual(proc.owner.getLedgerEscalations().map(({ purposeId, code, stage }) => `${purposeId}|${code}|${stage}`),
      ['owner-safety|OWNER_SAFETY_LEDGER_UNAVAILABLE|open']);
    assert.equal(await proc.stop(), 3);

    // Welcome refused while the Owner ledger works: the start's one notice lists it.
    const second = createLayout(t, 'welcome-refused');
    await openCoinDatabase(second, { fresh: true });
    const other = createProcess(second);
    const otherStarted = await other.preflight({ reserve: [second.paths('welcome').database] });
    assert.deepEqual(otherStarted.welcome, { enabled: false, code: 'WELCOME_LEDGER_UNAVAILABLE' });
    await other.ready();
    const notices = ownerMessages(other.rest);
    assert.equal(notices.length, 1);
    assert.ok(notices[0].startsWith('小吉安全帳本通知（本次啟動）'));
    assert.ok(notices[0].includes('已停用：\n・新人歡迎（WELCOME_LEDGER_UNAVAILABLE）'));
    assertFixedText(notices[0]);
    assert.equal(other.protectedEffects.featureStatus('welcome'), 'broken');
    // Another purpose's refusal is told by DM and the status page only: no escalation.
    assert.deepEqual(other.welcome.getLedgerEscalations(), []);
    assert.equal(await other.stop(), 0);
  });

test('the stop is bounded: a lastSeen write that never settles ends at the deadline as an escalation', async (t) => {
  const layout = createLayout(t, 'stop-bounded');
  await openCoinDatabase(layout, { fresh: true });
  const proc = createProcess(layout, {
    stopDeadlineMs: 300,
    bootstrap: async (options) => {
      const result = await bootstrapSafetyLedgers(options);
      return { ...result, recordLastSeen: () => new Promise(() => {}) };
    },
  });
  const started = await proc.preflight();
  await proc.ready();
  const begun = performance.now();
  assert.equal(await proc.stop(), 3);
  assert.ok(performance.now() - begun < 5_000);
  assert.ok(escalationCodes(proc.protectedEffects).includes('all|LEDGER_LAST_SEEN_WRITE_FAILED|close'));
  for (const ledger of started.ledgers.values()) assert.equal(ledger.closed, true);
});

test('the stop deadline starts once the runtimes are quiet: a six-second send in flight leaves lastSeen its time',
  async (t) => {
    const layout = createLayout(t, 'stop-slow-quiesce');
    await openCoinDatabase(layout, { fresh: true });
    const proc = createProcess(layout, {
      // lastSeen takes a moment: a deadline the wait below had already used up would cut it off.
      bootstrap: async (options) => {
        const result = await bootstrapSafetyLedgers(options);
        return { ...result, recordLastSeen: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return result.recordLastSeen();
        } };
      },
    });
    const started = await proc.preflight();
    await proc.ready();
    // A send still in flight keeps the Owner notifier's quiesce waiting for six seconds,
    // longer than the whole five-second stop deadline (its stop() quiesces once more).
    const quiesce = proc.owner.quiesce.bind(proc.owner);
    let waited = false;
    proc.owner.quiesce = async () => {
      if (!waited) {
        waited = true;
        await new Promise((resolve) => setTimeout(resolve, 6_000));
      }
      return quiesce();
    };
    const counters = started.ledgers.get('owner-safety').identityCounters;
    const begun = performance.now();
    assert.equal(await proc.stop(), 0);
    assert.ok(performance.now() - begun >= 6_000);
    assert.equal(proc.logger.lines.some(([, line]) => line.includes('LEDGER_LAST_SEEN_WRITE_FAILED')), false);
    assert.deepEqual(escalationCodes(proc.protectedEffects), []);
    const owner = (await registrations())['owner-safety'];
    assert.deepEqual([owner.lastSeen.bootEpoch, owner.lastSeen.beginSeq, owner.lastSeen.chainHead],
      [counters.bootEpoch, counters.beginSeq, counters.chainHead]);
  });

test('the hourly lastSeen refresh runs as an unref\'d background job, reports a failed write, and stops with the stop',
  async () => {
    const intervals = [];
    const cleared = [];
    const handle = { unrefs: 0, unref() { this.unrefs += 1; return this; } };
    const contexts = [];
    let failing = false;
    const logger = capturingLogger();
    const protectedEffects = createProtectedEffects({
      runtimeMode: 'production',
      logger,
      ownerId: OWNER_ID,
      resolveIdentity: async () => ({ botId: BOT_ID, source: 'token' }),
      bootstrap: async () => ({
        report: { version: 1, protectedEffects: 'on', lastSeen: 'written', purposes: [] },
        ledgers: new Map([['welcome', { purposeId: 'welcome', quarantined: false, close() {} }]]),
        recordLastSeen: async () => {
          contexts.push(getHostOperationContext()?.hostPurpose ?? null);
          if (failing) throw new Error('synthetic lastSeen failure');
          return { written: 1 };
        },
        close() {},
      }),
      lastSeenIntervalMs: 60_000,
      setIntervalFn: (callback, ms) => {
        intervals.push([callback, ms]);
        return handle;
      },
      clearIntervalFn: (timer) => cleared.push(timer),
    });
    await protectedEffects.start();
    assert.deepEqual(intervals.map(([, ms]) => ms), [60_000]);
    assert.equal(handle.unrefs, 1);
    // A refresh that writes runs in its own background job and reports nothing.
    await intervals[0][0]();
    assert.deepEqual(contexts, ['background.safety.ledger-last-seen']);
    assert.deepEqual(escalationCodes(protectedEffects), []);
    // A refresh that fails logs one warning and is escalated at stage runtime.
    failing = true;
    await intervals[0][0]();
    assert.deepEqual(logger.lines.filter(([, line]) => line.includes('LEDGER_LAST_SEEN_WRITE_FAILED')), [
      ['warn', '[SAFETY_LEDGER] code=LEDGER_LAST_SEEN_WRITE_FAILED stage=runtime'],
      ['error', '[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=all cause=LEDGER_LAST_SEEN_WRITE_FAILED stage=runtime'],
    ]);
    assert.deepEqual(escalationCodes(protectedEffects), ['all|LEDGER_LAST_SEEN_WRITE_FAILED|runtime']);
    // The stop clears the timer (and writes lastSeen itself); a refresh that still fires
    // afterwards writes nothing.
    failing = false;
    await protectedEffects.stop();
    assert.deepEqual(cleared, [handle]);
    const written = contexts.length;
    await intervals[0][0]();
    assert.equal(contexts.length, written);
  });

test('an identity read or a bootstrap report that throws is handled like a failed bootstrap; the start never rejects',
  async (t) => {
    // The identity read throws: every purpose fails closed without touching a file, the
    // login goes on, and the Owner hears it by emergency DM.
    const layout = createLayout(t, 'identity-throws');
    await openCoinDatabase(layout, { fresh: true });
    const proc = createProcess(layout, { resolveIdentity: async () => { throw new Error('synthetic identity failure'); } });
    assert.equal((await proc.preflight()).ledgers.size, 0);
    assert.deepEqual(proc.protectedEffects.identity, { botId: null, source: 'none' });
    assert.ok(proc.logger.lines.some(([, line]) => line === '[SAFETY_LEDGER] code=LEDGER_BOT_IDENTITY_UNAVAILABLE'));
    assert.ok(proc.logger.lines.some(([, line]) =>
      line === '[SAFETY_LEDGER] purpose=welcome code=LEDGER_IDENTITY_INVALID reason=bot'));
    assert.deepEqual(filesUnder(layout.dataDir), ['xiaoji.sqlite']);
    await proc.ready();
    const messages = ownerMessages(proc.rest);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].includes('LEDGER_IDENTITY_INVALID'));
    assert.equal(await proc.stop(), 3);

    // A report the alerts cannot classify: the delivered ledgers are closed, and every purpose
    // fails closed (or, with the kill switch set, is only disabled).
    for (const [env, expected, escalations] of [[{}, 'broken', PURPOSE_IDS.length], [{ XIAOJI_PROTECTED_EFFECTS: 'off' }, 'maintenance', 0]]) {
      const ledger = { purposeId: 'welcome', quarantined: false, closed: false, close() { this.closed = true; } };
      const logger = capturingLogger();
      const effects = createProtectedEffects({
        runtimeMode: 'production',
        env,
        logger,
        ownerId: OWNER_ID,
        resolveIdentity: async () => ({ botId: BOT_ID, source: 'token' }),
        bootstrap: async () => ({ report: { version: 2 }, ledgers: new Map([['welcome', ledger]]),
          recordLastSeen: async () => ({ written: 0 }), close: () => ledger.close() }),
      });
      const delivered = await effects.start();
      assert.equal(delivered.size, 0);
      assert.equal(ledger.closed, true);
      assert.ok(logger.lines.some(([, line]) => line === '[SAFETY_LEDGER] code=LEDGER_ALERTS_FAILED stage=prepare'));
      assert.deepEqual(FEATURES.map((key) => effects.featureStatus(key)), [expected, expected, expected]);
      assert.equal(effects.getLedgerEscalations().length, escalations);
      await effects.stop();
    }
  });

test('index.js sets the token before the identity read and prepends the ready check before every ready handler',
  async (t) => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
    // Production sets the token as the first step of start(), before the preflight that reads
    // the identity; test-control sets it at load, right after installing its egress guard.
    const start = source.slice(source.indexOf('async function start() {'));
    const tokenAt = start.indexOf('if (!testControlPolicy) client.rest.setToken(token);');
    assert.ok(tokenAt > 0 && tokenAt < start.indexOf('bootstrapLedgers: () => protectedEffects.start()'));
    assert.ok(start.slice(0, tokenAt).split('\n').filter((line) => !line.trim().startsWith('//')).length <= 2);
    const egressAt = source.indexOf('client.testControlEgress.install(client.rest);');
    assert.ok(egressAt > 0 && source.indexOf('client.rest.setToken(token);', egressAt) > egressAt);
    // The ready check is prepended after the event files are registered.
    const registeredAt = source.indexOf('registerEvents(client,');
    const prependedAt = source.indexOf('client.prependOnceListener(Events.ClientReady, (readyClient) => {');
    assert.ok(registeredAt > 0 && prependedAt > registeredAt);
    assert.match(source.slice(prependedAt, prependedAt + 160), /\n {2}protectedEffects\.onClientReady\(readyClient\);\n\}\);/u);

    // The same wiring on a real EventEmitter with the real registerEvents: the prepended
    // check arms the runtimes first and synchronously, so a registered ready handler only
    // runs once they are armed.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-ready-order-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    fs.writeFileSync(path.join(directory, 'ready.js'), `'use strict';\nmodule.exports = { name: ${JSON.stringify(Events.ClientReady)},
  once: true, execute(client) { client.order.push('ready.js'); } };\n`);
    const client = new EventEmitter();
    client.order = [];
    client.user = { id: BOT_ID };
    const runtime = { arm() { client.order.push('armed'); }, disableAll() { client.order.push('disabled'); },
      quiesce: async () => {}, stop: async () => {} };
    const effects = createProtectedEffects({
      runtimeMode: 'production',
      logger: capturingLogger(),
      ownerId: OWNER_ID,
      resolveIdentity: async () => ({ botId: BOT_ID, source: 'token' }),
      bootstrap: async () => ({ report: { version: 1, protectedEffects: 'on', lastSeen: 'skipped', purposes: [] },
        ledgers: new Map(), recordLastSeen: async () => ({ written: 0 }), close() {} }),
    });
    effects.attachRuntimes({ welcome: runtime });
    await effects.start();
    registerEvents(client, directory);
    client.prependOnceListener(Events.ClientReady, (readyClient) => {
      effects.onClientReady(readyClient);
    });
    client.emit(Events.ClientReady, client);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(client.order, ['armed', 'ready.js']);
    await effects.stop();
  });

test('a quarantine that reached none of its places is waited for at the stop, then escalated', async () => {
  let settleFlag;
  const flag = new Promise((resolve) => { settleFlag = resolve; });
  const ledger = {
    purposeId: 'welcome',
    quarantined: true,
    closed: false,
    get quarantineFlag() { return flag; },
    quarantinePersistence: Object.freeze({ marker: false, stamp: false, registration: false }),
    close() { this.closed = true; },
  };
  const runtime = { quiesce: async () => {}, stop: async () => {}, arm() {}, disableAll() {} };
  const protectedEffects = createProtectedEffects({
    runtimeMode: 'production',
    logger: capturingLogger(),
    ownerId: '10000000000000009',
    stopDeadlineMs: 2_000,
    resolveIdentity: async () => ({ botId: BOT_ID, source: 'token' }),
    bootstrap: async () => ({
      report: { version: 1, protectedEffects: 'on', lastSeen: 'written', purposes: [] },
      ledgers: new Map([['welcome', ledger]]),
      recordLastSeen: async () => ({ written: 0 }),
      close: () => ledger.close(),
    }),
  });
  protectedEffects.attachRuntimes({ welcome: runtime });
  await protectedEffects.start();
  const stopping = protectedEffects.stop();
  let stopped = false;
  stopping.then(() => { stopped = true; });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(stopped, false, 'the stop waits for the quarantine flag');
  settleFlag(false);
  await stopping;
  assert.equal(ledger.closed, true);
  assert.deepEqual(escalationCodes(protectedEffects), ['welcome|LEDGER_QUARANTINE_UNPERSISTED|close']);
});

test('GET /users/@me: retried only for transient failures, within ten seconds, then the configured ID', async () => {
  const configured = OTHER_APPLICATION_ID;
  const run = async (rest, { configuredClientId = configured, monotonic, sleep = async () => {} } = {}) => {
    const logger = capturingLogger();
    const identity = await resolveBotIdentity({ rest, configuredClientId, logger, sleep,
      ...(monotonic ? { monotonic } : {}) });
    return { identity, lines: logger.lines.map(([level, line]) => `${level} ${line}`) };
  };
  // Two transient failures, then the bot user.
  let rest = recordingRest({ identityFailures: 2 });
  let outcome = await run(rest);
  assert.deepEqual([outcome.identity, rest.identityCalls], [{ botId: BOT_ID, source: 'token' }, 3]);
  assert.deepEqual(outcome.lines, ['warn [SAFETY_LEDGER] code=LEDGER_CLIENT_ID_DIFFERS']);
  // Three transient failures: the configured ID, with one log line.
  rest = recordingRest({ identityFailures: 3 });
  outcome = await run(rest);
  assert.deepEqual([outcome.identity, rest.identityCalls], [{ botId: configured, source: 'configured' }, 3]);
  assert.deepEqual(outcome.lines, ['warn [SAFETY_LEDGER] code=LEDGER_BOT_IDENTITY_FALLBACK source=configured']);
  // A refusal (401) is not retried.
  rest = recordingRest({ identityFailures: 3, identityStatus: 401 });
  outcome = await run(rest);
  assert.deepEqual([outcome.identity.source, rest.identityCalls], ['configured', 1]);
  // The ten-second budget ends the retries, whatever is left of the three attempts.
  let clock = 0;
  rest = recordingRest({ identityFailures: 3 });
  outcome = await run(rest, { monotonic: () => clock, sleep: async (ms) => { clock += ms + 9_000; } });
  assert.deepEqual([outcome.identity.source, rest.identityCalls], ['configured', 2]);
  // Neither the bot user nor a configured ID: nothing to bind ledgers to.
  rest = recordingRest({ identityFailures: 3 });
  outcome = await run(rest, { configuredClientId: null });
  assert.deepEqual(outcome.identity, { botId: null, source: 'none' });
  assert.deepEqual(outcome.lines, ['error [SAFETY_LEDGER] code=LEDGER_BOT_IDENTITY_UNAVAILABLE']);
});

test('every reporter code of the ledgers passes the launcher protocol; others do not', () => {
  assert.equal(REPORTER_OPERATION, 'ledger');
  const lines = [];
  const reporter = createReporter({ warn: (line) => lines.push(line) });
  for (const code of REPORTER_CODES) {
    const expected = `[TEST_CONTROL] code=${code} operation=ledger`;
    assert.equal(safeControlLine(code, 'ledger'), expected, code);
    reporter.deny(code, 'ledger');
    assert.equal(parseSafeControlLine(lines.at(-1)), expected, code);
  }
  assert.equal(safeControlLine('TEST_LEDGER_UNLISTED', 'ledger'), null);
  assert.equal(safeControlLine('TEST_LEDGER_ANOMALY', 'ledgers'), null);
  // ledgerAlerts.js gives the reporter no other code.
  const source = fs.readFileSync(require.resolve('../src/systems/safety/ledgerAlerts'), 'utf8');
  const used = [...new Set([...source.matchAll(/report\('(TEST_[A-Z_]+)'\)/gu)].map((match) => match[1]))].sort();
  assert.deepEqual(used, [...REPORTER_CODES].sort());
});

test('the status cards follow the protected side effects only where they would be normal', async () => {
  const statuses = { welcome: 'broken', word_chain: 'maintenance' };
  const client = {
    isReady: () => true,
    commands: new Map(['set-welcome', 'board', 'word-chain', 'number-chain', 'remind', 'calendar', 'poll', 'weather',
      'coins', 'daily', 'economy', 'daily-riddle', 'daily-discussion', 'chat-style', 'romance'].map((name) => [name, {}])),
    protectedEffects: { featureStatus: (key) => statuses[key] || null },
  };
  const byKey = (features) => Object.fromEntries(features.map((feature) => [feature.key, feature.status]));
  let cards = byKey(buildFeatureStatuses(client, []));
  assert.deepEqual([cards.core_chat, cards.welcome, cards.word_chain, cards.number_chain],
    ['normal', 'broken', 'maintenance', 'normal']);
  // A card already lowered by its own health keeps that status.
  cards = byKey(buildFeatureStatuses(client, [{ featureKey: 'word_chain', status: 'broken', updatedAt: null }]));
  assert.equal(cards.word_chain, 'broken');
  // A provider that throws changes nothing.
  cards = byKey(buildFeatureStatuses({ ...client, protectedEffects: { featureStatus: () => { throw new Error('x'); } } }, []));
  assert.deepEqual([cards.welcome, cards.word_chain], ['normal', 'normal']);
  // A broken welcome makes the bot degraded, never an outage.
  const snapshot = await buildPublicStatusSnapshot(client, { healthReader: async () => [], usageReader: async () => [] });
  assert.equal(snapshot.bot.status, 'degraded');
});

// One ordinary coin database write whose directory fsync fails after the rename (the POSIX
// order, simulated on every host): the write stands, and it is escalated. Later writes (the
// stop's lastSeen) use the real file system again.
async function writeWithFailingDirectorySync(coinDbPath, key) {
  const directory = path.dirname(coinDbPath);
  const directoryDescriptor = -4242;
  const failingDirectory = {
    ...fs,
    openSync: (target, flags, ...rest) => (path.resolve(String(target)) === directory && flags === 'r'
      ? directoryDescriptor : fs.openSync(target, flags, ...rest)),
    fsyncSync: (descriptor) => {
      if (descriptor === directoryDescriptor) throw Object.assign(new Error('synthetic directory fsync failure'), { code: 'EIO' });
      return fs.fsyncSync(descriptor);
    },
    closeSync: (descriptor) => (descriptor === directoryDescriptor ? undefined : fs.closeSync(descriptor)),
  };
  coinDatabase.setCoinDatabaseDurabilityForTests({ filesystem: failingDirectory, platform: 'linux' });
  try {
    await coinDatabase.withCoinTransaction((api) => api.run(
      'INSERT INTO coin_metadata (key, value, updated_at) VALUES (?, ?, ?)', [key, '1', '2026-10-03T00:00:00.000Z']));
  } finally {
    coinDatabase.setCoinDatabaseDurabilityForTests(null);
  }
}

const COIN_DB_ESCALATION_LINE = ['error', '[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=coin-database ' +
  'cause=COIN_DB_DIRECTORY_SYNC_FAILED stage=runtime'];

test('a coin database write whose directory sync failed ends the stop with exit code 3 and its escalation', async (t) => {
  const layout = createLayout(t, 'coin-db-escalation');
  await openCoinDatabase(layout, { fresh: true });
  const proc = createProcess(layout, { env: {} });
  const started = await proc.preflight();
  await proc.ready();
  await writeWithFailingDirectorySync(layout.coinDbPath, 'escalation_probe');
  // Reported with the ledgers' escalations, and not again by the last report before the exit.
  assert.equal(await proc.stop(), 3);
  assert.deepEqual(proc.logger.lines.filter(([, line]) => line.includes('code=LEDGER_ESCALATION')), [
    COIN_DB_ESCALATION_LINE,
  ]);
  // The stop itself completed (every ledger closed, the registrations in the file), and the
  // probe write was never rolled back.
  for (const ledger of started.ledgers.values()) assert.equal(ledger.closed, true);
  const inFile = await coinDatabase.inspectSafetyRegistrationsFromFile(layout.coinDbPath);
  assert.equal(Object.keys(inFile.registrations).length > 0, true);
  assert.equal(await coinDatabase.withCoinDatabase((api) => api.get(
    "SELECT value FROM coin_metadata WHERE key = 'escalation_probe'")?.value), '1');
});

test('a coin database write that fails during the later stop steps still ends the stop with exit code 3, reported once',
  async (t) => {
    const layout = createLayout(t, 'coin-db-late-escalation');
    await openCoinDatabase(layout, { fresh: true });
    const proc = createProcess(layout, { env: {} });
    await proc.preflight();
    await proc.ready();
    // Nothing is pending when the ledgers are reported; the board lifecycle's stop (standing in:
    // laterSteps) then writes to the coin database and its directory fsync fails.
    let reportedBeforeLaterSteps = null;
    const exitCode = await proc.stop({ laterSteps: async () => {
      reportedBeforeLaterSteps = proc.logger.lines.filter(([, line]) => line.includes('code=LEDGER_ESCALATION')).length;
      await writeWithFailingDirectorySync(layout.coinDbPath, 'late_probe');
      // A second failure in the same stage is the same escalation.
      await writeWithFailingDirectorySync(layout.coinDbPath, 'late_probe_again');
    } });
    assert.equal(reportedBeforeLaterSteps, 0);
    assert.equal(exitCode, 3);
    assert.deepEqual(proc.logger.lines.filter(([, line]) => line.includes('code=LEDGER_ESCALATION')), [
      COIN_DB_ESCALATION_LINE,
    ]);
  });

test('a later stop step that throws is logged once; the stop still makes its last report and exits non-zero',
  async (t) => {
    const throwing = (code) => async () => { throw Object.assign(new Error('synthetic stop step failure'), { code }); };
    const shutdownLines = (proc) => proc.logger.lines.filter(([, line]) => line.startsWith('[SHUTDOWN]'));

    // An otherwise clean stop whose later step throws exits with 1, so a service manager (and
    // test-control, which hides the log line) still sees that the stop failed.
    const clean = createLayout(t, 'later-step-throws');
    await openCoinDatabase(clean, { fresh: true });
    const quiet = createProcess(clean, { env: {} });
    await quiet.preflight();
    await quiet.ready();
    assert.equal(await quiet.stop({ laterSteps: throwing('EBOARD') }), 1);
    assert.deepEqual(shutdownLines(quiet), [['error', '[SHUTDOWN] code=SHUTDOWN_STEP_FAILED cause=EBOARD']]);
    assert.deepEqual(quiet.logger.lines.filter(([, line]) => line.includes('code=LEDGER_ESCALATION')), []);

    // A later step that escalates and then throws: the last report still runs, exit code 3.
    const late = createLayout(t, 'later-step-escalates-then-throws');
    await openCoinDatabase(late, { fresh: true });
    const proc = createProcess(late, { env: {} });
    await proc.preflight();
    await proc.ready();
    assert.equal(await proc.stop({ laterSteps: async () => {
      await writeWithFailingDirectorySync(late.coinDbPath, 'late_then_throw');
      await throwing('EBOARD')();
    } }), 3);
    assert.deepEqual(shutdownLines(proc), [['error', '[SHUTDOWN] code=SHUTDOWN_STEP_FAILED cause=EBOARD']]);
    assert.deepEqual(proc.logger.lines.filter(([, line]) => line.includes('code=LEDGER_ESCALATION')), [
      COIN_DB_ESCALATION_LINE,
    ]);
  });

test('bootReport is the bootstrap report the alerts were prepared from, and the failed report when there was none', async (t) => {
  const layout = createLayout(t, 'boot-report');
  await openCoinDatabase(layout, { fresh: true });
  const proc = createProcess(layout, { env: {} });
  assert.equal(proc.protectedEffects.bootReport, null, 'nothing before start');
  await proc.preflight();
  const report = proc.protectedEffects.bootReport;
  assert.equal(report.version, 1);
  assert.deepEqual(report.purposes.map((item) => item.purposeId).sort(), [...PURPOSE_IDS].sort());
  assert.deepEqual([...new Set(report.purposes.map((item) => item.status))], ['ready']);
  await proc.stop();

  // A bootstrap that throws: every purpose failed closed, with a code that is no sign of a restore.
  const broken = createLayout(t, 'boot-report-failed');
  await openCoinDatabase(broken, { fresh: true });
  const failing = createProcess(broken, { env: {}, bootstrap: async () => { throw new Error('synthetic'); } });
  await failing.preflight();
  const failed = failing.protectedEffects.bootReport;
  assert.equal(failed.version, 1);
  assert.deepEqual([...new Set(failed.purposes.map((item) => item.code))], ['LEDGER_BOOTSTRAP_FAILED']);
  assert.deepEqual(restoreSignsOf(failed), []);

  // A report that cannot be read is replaced by the failed one, the same as for the alerts.
  const odd = createLayout(t, 'boot-report-odd');
  await openCoinDatabase(odd, { fresh: true });
  const closed = [];
  const unreadable = createProcess(odd, { env: {}, bootstrap: async () => ({ report: { version: 99 },
    ledgers: new Map(), recordLastSeen: async () => ({ written: 0 }), close() { closed.push(1); } }) });
  await unreadable.preflight();
  assert.deepEqual([unreadable.protectedEffects.bootReport.version,
    unreadable.protectedEffects.bootReport.purposes[0].code], [1, 'LEDGER_BOOTSTRAP_FAILED']);
  assert.deepEqual(closed, [1]);
});
