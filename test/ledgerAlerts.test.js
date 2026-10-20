'use strict';

// Ledger alerts: how a bootstrap report and later ledger events reach the
// Owner, the log, the status page, test-control, and the exit code. Nothing here touches
// a real ledger, the network, or Discord.

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  EMERGENCY_INTERVAL_MS,
  HINTS,
  MAX_NOTICE_BYTES,
  MAX_NOTICE_CHARACTERS,
  STAMP_FUTURE_TOLERANCE_MS,
  buildEmergencyNotice,
  buildStartupNotice,
  createLedgerAlerts,
  failedBootstrapReport,
  parseStamp,
} = require('../src/systems/safety/ledgerAlerts');
const {
  LEDGER_ESCALATION_EXIT_CODE,
  createLedgerEscalations,
  formatLedgerEscalation,
  settleLedgerShutdown,
} = require('../src/systems/safety/ledgerEscalation');
const { PURPOSE_IDS } = require('../src/systems/safety/ledgerLayout');
const { installEgressGuard } = require('../src/platform/egressGuard');
const { createEgressLimiter } = require('../src/platform/egressLimiter');
const { createSyntheticRest } = require('./fixtures/syntheticRest');

const OWNER_ID = '444444444444444444';
const CHANNEL_ID = '888888888888888888';
const MESSAGE_ID = '999999999999999999';
const CUTOVER_MS = Date.UTC(2026, 9, 3, 1, 2, 3);
const WALL_CLOCK = Date.UTC(2026, 9, 3, 12);
const CONFIRMATION = '0123abcd';

function purpose(purposeId, status, code, extra = {}) {
  return {
    purposeId,
    kind: purposeId === 'owner-safety' ? 'owner' : 'public',
    status,
    code,
    reason: null,
    notices: [],
    ledgerId: `xjl2-${purposeId.replace(/[^a-z0-9]+/gu, '-')}-${CONFIRMATION}0123456789abcdef01234567`,
    confirmationCode: CONFIRMATION,
    genesisMs: CUTOVER_MS,
    cutoverMs: CUTOVER_MS,
    created: false,
    escalate: status === 'failed',
    ...extra,
  };
}

function reportOf(purposes, extra = {}) {
  return { version: 1, protectedEffects: 'on', runtimeMode: 'production', startedAtMs: 0, finishedAtMs: 0,
    legacyVariables: [], lastSeen: 'written', purposes, ...extra };
}

// Every purpose ready; the Owner and automatic-leave ledgers have no cutover (0).
function allReady(extra = {}) {
  return PURPOSE_IDS.map((purposeId) => purpose(purposeId, 'ready', 'LEDGER_READY', {
    ...(['owner-safety', 'audit.guild.leave'].includes(purposeId) ? { cutoverMs: 0 } : {}),
    ...extra,
  }));
}

function capturingLogger() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(['info', String(line)]),
    warn: (line) => lines.push(['warn', String(line)]),
    error: (line) => lines.push(['error', String(line)]),
  };
}

function fakeNotifier({ ready = true, accept = true } = {}) {
  return {
    ready,
    notices: [],
    isReady() { return this.ready; },
    notifyLedgerEvent(notice) {
      this.notices.push(notice);
      return accept;
    },
  };
}

// Every step of an emergency DM lands in `events`, in order. A real REST, answered by the
// handler below; its calls stay readable as rest.calls.
function fakeRest(events, { failChannel = false } = {}) {
  const handlers = {
    calls: [],
    async post(route, options) {
      this.calls.push({ route, options });
      events.push(`post ${route}`);
      if (route === '/users/@me/channels') {
        if (failChannel) throw new Error('synthetic channel failure');
        return { id: CHANNEL_ID, type: 1, recipients: [{ id: OWNER_ID }] };
      }
      if (route === `/channels/${CHANNEL_ID}/messages`) return { id: MESSAGE_ID };
      throw new Error(`unexpected route ${route}`);
    },
  };
  return Object.assign(createSyntheticRest(handlers), { calls: handlers.calls });
}

// The coin_metadata stamp, in memory, with the same compare-and-set rule.
function fakeStamp(events, { value = null, readError = null, writeError = null } = {}) {
  const store = {
    value,
    reads: 0,
    writes: 0,
    async read() {
      store.reads += 1;
      events.push('stamp read');
      if (readError) throw readError;
      return store.value === null ? null : { value: store.value, updatedAt: '2026-10-03T00:00:00.000Z' };
    },
    async write(next, expectedValue) {
      store.writes += 1;
      events.push('stamp write');
      if (writeError) throw writeError;
      if (store.value !== expectedValue) throw Object.assign(new Error('conflict'), { code: 'SAFETY_ALERT_CONFLICT' });
      store.value = next;
      return { written: 1 };
    },
  };
  return store;
}

function alertsFor({ runtimeMode = 'production', logger = capturingLogger(), reporter = null, ownerId = OWNER_ID,
  clock = { value: WALL_CLOCK }, stamp, ownerDmGate = null } = {}) {
  return createLedgerAlerts({ runtimeMode, logger, reporter, ownerId, now: () => clock.value, stamp,
    emergencyTimeoutMs: 1_000, ownerDmGate });
}

function escalationKeys(alerts) {
  return alerts.getLedgerEscalations().map(({ purposeId, code, stage, reason }) =>
    `${purposeId}|${code}|${stage}|${reason || ''}`).sort();
}

// A notice or DM text that leaks nothing: no snowflake, no confirmation code or ledger ID,
// no file path, and never the data-root variable.
function assertFixedText(text) {
  assert.doesNotMatch(text, /\d{17,20}/u);
  assert.equal(text.includes(CONFIRMATION), false);
  assert.equal(text.includes('xjl2-'), false);
  assert.doesNotMatch(text, /[A-Za-z]:\\|\/safety|\\safety|\.sqlite|\.json/u);
  assert.equal(text.includes('XIAOJI_DATA_ROOT'), false);
  assert.ok(Buffer.byteLength(text) <= MAX_NOTICE_BYTES && text.length <= MAX_NOTICE_CHARACTERS);
}

test('a start report is escalated at once, told to the Owner once after ready, and overrides the status page', async () => {
  const logger = capturingLogger();
  const events = [];
  const stamp = fakeStamp(events);
  const alerts = alertsFor({ logger, stamp });
  alerts.prepare(reportOf([
    purpose('owner-safety', 'ready', 'LEDGER_CREATED', { created: true, cutoverMs: 0 }),
    purpose('welcome', 'ready', 'LEDGER_CREATED', { created: true }),
    purpose('work.penalty.announce', 'failed', 'LEDGER_IN_USE', { reason: 'stopping' }),
    purpose('work.reminder.dm.prepare', 'ready', 'LEDGER_READY'),
    purpose('work.reminder.dm.send', 'ready', 'LEDGER_READY', { notices: ['LEDGER_REQUEST_NOT_CONSUMED'] }),
    purpose('audit.guild.leave', 'ready', 'LEDGER_READY', { notices: ['LEDGER_REQUEST_TEMP_IGNORED'] }),
    purpose('word-chain.reaction', 'failed', 'LEDGER_FILES_MISSING'),
    purpose('number-chain.reaction', 'ready', 'LEDGER_READY'),
  ], { lastSeen: 'failed' }));
  // Escalations are recorded and logged before anything else happens.
  assert.deepEqual(escalationKeys(alerts), [
    'all|LEDGER_LAST_SEEN_WRITE_FAILED|open|',
    'word-chain.reaction|LEDGER_FILES_MISSING|open|',
    'work.reminder.dm.send|LEDGER_REQUEST_NOT_CONSUMED|open|',
  ]);
  assert.equal(logger.lines.filter(([level, line]) => level === 'error' && line.includes('code=LEDGER_ESCALATION')).length, 3);
  // Waiting to stop for another process's lock is not an anomaly.
  assert.equal(alerts.getLedgerEscalations().some((entry) => entry.code === 'LEDGER_IN_USE'), false);
  assert.deepEqual(['welcome', 'word_chain', 'number_chain', 'unknown'].map((key) => alerts.featureStatus(key)),
    [null, 'broken', null, null]);

  const notifier = fakeNotifier();
  const rest = fakeRest(events);
  assert.deepEqual(await alerts.flush({ notifier, rest }), { owner: 1, emergency: 'none' });
  assert.equal(notifier.notices.length, 1);
  const [notice] = notifier.notices;
  assert.equal(notice.category, 'startup');
  assert.equal(notice.mergeScope, 'boot');
  assert.match(notice.key, /^[a-f0-9]{64}$/u);
  const { content } = notice;
  assert.ok(content.startsWith('小吉安全帳本通知（本次啟動）\n已建立：\n'));
  assert.ok(content.includes(`・新人歡迎（cutover <t:${Math.floor(CUTOVER_MS / 1_000)}:F>）`));
  assert.ok(content.includes('・Owner 安全通知（不套用 cutover）'));
  assert.ok(content.includes('已停用：\n・文字接龍 ✅（LEDGER_FILES_MISSING）'));
  assert.ok(content.includes('維運提示：\n・工作提醒（私訊）（LEDGER_REQUEST_NOT_CONSUMED）'));
  assert.ok(content.includes('・自動離群（休眠）（LEDGER_REQUEST_TEMP_IGNORED）'));
  assert.equal(content.includes('審核逾時離群'), false, 'the bot no longer reviews servers');
  assert.ok(content.includes('LEDGER_LAST_SEEN_WRITE_FAILED'));
  assert.ok(content.includes('npm run safety:ledger -- status'));
  assert.equal(content.includes('扣薪公告'), false);
  assertFixedText(content);
  // Nothing went outside the Owner ledger, and a second flush is refused.
  assert.deepEqual(events, []);
  await assert.rejects(alerts.flush({ notifier, rest }), /already flushed/u);
  // The escalations end an otherwise clean stop with the escalation exit code.
  const processRef = {};
  assert.equal(settleLedgerShutdown({ sources: [alerts], logger, processRef, exitCode: 0 }), LEDGER_ESCALATION_EXIT_CODE);
  assert.equal(processRef.exitCode, LEDGER_ESCALATION_EXIT_CODE);
});

test('a start that only created ledgers sends one quiet notice and escalates nothing', async () => {
  const alerts = alertsFor({ stamp: fakeStamp([]) });
  alerts.prepare(reportOf(allReady({ code: 'LEDGER_CREATED', created: true })));
  assert.deepEqual(alerts.getLedgerEscalations(), []);
  const notifier = fakeNotifier();
  assert.deepEqual(await alerts.flush({ notifier, rest: fakeRest([]) }), { owner: 1, emergency: 'none' });
  const { content } = notifier.notices[0];
  assert.ok(content.includes('已建立：\n・Owner 安全通知（不套用 cutover）'));
  assert.ok(content.includes('受保護功能已啟用；cutover 之前的事件不會補發。'));
  assert.equal(content.includes('已停用'), false);
  assertFixedText(content);
  assert.equal(settleLedgerShutdown({ sources: [alerts], logger: capturingLogger(), processRef: {}, exitCode: 0 }), 0);
  // A start with nothing to say sends nothing.
  const quiet = alertsFor({ stamp: fakeStamp([]) });
  quiet.prepare(reportOf(allReady()));
  const quietNotifier = fakeNotifier();
  assert.deepEqual(await quiet.flush({ notifier: quietNotifier, rest: fakeRest([]) }), { owner: 0, emergency: 'none' });
  assert.deepEqual(quietNotifier.notices, []);
});

test('the kill switch sends nothing, reads no stamp, escalates nothing, and shows maintenance', async () => {
  const events = [];
  const stamp = fakeStamp(events);
  const alerts = alertsFor({ stamp });
  alerts.prepare(reportOf(PURPOSE_IDS.map((purposeId) => purpose(purposeId, 'disabled', 'LEDGER_PROTECTED_EFFECTS_OFF')),
    { protectedEffects: 'off', lastSeen: 'skipped' }));
  assert.deepEqual(['welcome', 'word_chain', 'number_chain'].map((key) => alerts.featureStatus(key)),
    ['maintenance', 'maintenance', 'maintenance']);
  const notifier = fakeNotifier();
  const rest = fakeRest(events);
  assert.deepEqual(await alerts.flush({ notifier, rest }), { owner: 0, emergency: 'none' });
  assert.equal(await alerts.noteRuntimeDisabled('welcome', 'LEDGER_FAILED'), 'none');
  assert.equal(await alerts.noteBotMismatch(), 'none');
  assert.deepEqual(notifier.notices, []);
  assert.deepEqual(events, []);
  assert.equal(stamp.reads, 0);
  // A bot identity that differs still counts for the exit code; nothing else does.
  assert.deepEqual(escalationKeys(alerts), ['all|LEDGER_BOT_MISMATCH|open|']);
});

test('test-control gets fixed reporter codes and never a DM, emergency or not', async () => {
  const denied = [];
  const reporter = { deny: (code, operation) => denied.push(`${code}:${operation}`) };
  const events = [];
  const stamp = fakeStamp(events);
  const alerts = alertsFor({ runtimeMode: 'test-control', reporter, stamp });
  alerts.prepare(reportOf([
    purpose('owner-safety', 'disabled', 'LEDGER_POLICY_DISABLED'),
    purpose('welcome', 'ready', 'LEDGER_CREATED', { created: true }),
    purpose('work.penalty.announce', 'ready', 'LEDGER_READY', { notices: ['LEDGER_REQUEST_TEMP_IGNORED'] }),
    purpose('work.reminder.dm.prepare', 'disabled', 'LEDGER_POLICY_DISABLED'),
    purpose('work.reminder.dm.send', 'disabled', 'LEDGER_POLICY_DISABLED'),
    purpose('audit.guild.leave', 'disabled', 'LEDGER_POLICY_DISABLED'),
    purpose('word-chain.reaction', 'failed', 'LEDGER_ROLLBACK', { reason: 'database-behind' }),
    purpose('number-chain.reaction', 'ready', 'LEDGER_READY'),
  ], { runtimeMode: 'test-control' }));
  assert.deepEqual([...new Set(denied)].sort(), [
    'TEST_LEDGER_ANOMALY:ledger',
    'TEST_LEDGER_ESCALATION:ledger',
    'TEST_LEDGER_NOTICE:ledger',
    'TEST_LEDGER_POLICY_DISABLED:ledger',
  ]);
  assert.deepEqual(['welcome', 'word_chain', 'number_chain'].map((key) => alerts.featureStatus(key)),
    [null, 'broken', null]);
  const notifier = fakeNotifier();
  assert.deepEqual(await alerts.flush({ notifier, rest: fakeRest(events) }), { owner: 0, emergency: 'none' });
  assert.equal(await alerts.noteRuntimeDisabled('owner-safety', 'LEDGER_FAILED'), 'none');
  assert.equal(await alerts.noteBotMismatch(), 'none');
  assert.deepEqual(notifier.notices, []);
  assert.deepEqual(events, []);
  // The kill switch has its own code there.
  const offDenied = [];
  const off = alertsFor({ runtimeMode: 'test-control', reporter: { deny: (code) => offDenied.push(code) }, stamp });
  off.prepare(reportOf([], { protectedEffects: 'off' }));
  assert.deepEqual(offDenied, ['TEST_LEDGER_PROTECTED_EFFECTS_OFF']);
});

test('an anomaly the Owner ledger cannot carry sends one emergency DM, and only after the stamp is durable', async () => {
  const events = [];
  const stamp = fakeStamp(events);
  const clock = { value: WALL_CLOCK };
  const logger = capturingLogger();
  // The data root is inside the project: every purpose fails closed, the Owner's too.
  const alerts = alertsFor({ stamp, clock, logger });
  alerts.prepare(reportOf(PURPOSE_IDS.map((purposeId) => purpose(purposeId, 'failed', 'LEDGER_PATH_IN_PROJECT',
    { reason: 'base', ledgerId: null, confirmationCode: null }))));
  const notifier = fakeNotifier({ ready: false });
  const rest = fakeRest(events);
  assert.deepEqual(await alerts.flush({ notifier, rest }), { owner: 0, emergency: 'sent' });
  assert.deepEqual(notifier.notices, []);
  assert.deepEqual(events, ['stamp read', 'stamp write', 'post /users/@me/channels', `post /channels/${CHANNEL_ID}/messages`]);
  assert.deepEqual(rest.calls[0].options.body, { recipient_id: OWNER_ID });
  const { content, allowed_mentions: mentions } = rest.calls[1].options.body;
  assert.deepEqual(mentions.parse, []);
  assert.ok(content.startsWith('小吉緊急安全提示'));
  assert.ok(content.includes('LEDGER_PATH_IN_PROJECT'));
  assert.ok(content.includes(HINTS.LEDGER_PATH_IN_PROJECT));
  assert.ok(content.includes('COIN_DB_PATH'));
  assert.ok(content.includes('6 小時內不會重複提醒'));
  assertFixedText(content);
  assert.deepEqual(parseStamp({ value: stamp.value }), { sentAtMs: WALL_CLOCK });
  assert.ok(logger.lines.some(([, line]) => line.includes('LEDGER_EMERGENCY_NOTICE_SENT')));

  // A restart within 6 hours finds the stamp and sends nothing.
  clock.value = WALL_CLOCK + EMERGENCY_INTERVAL_MS - 1;
  const restarted = alertsFor({ stamp, clock });
  restarted.prepare(reportOf(PURPOSE_IDS.map((purposeId) => purpose(purposeId, 'failed', 'LEDGER_PATH_IN_PROJECT'))));
  events.length = 0;
  assert.deepEqual(await restarted.flush({ notifier, rest: fakeRest(events) }), { owner: 0, emergency: 'suppressed' });
  assert.deepEqual(events, ['stamp read']);
  // Six hours later the next start tells the Owner again.
  clock.value = WALL_CLOCK + EMERGENCY_INTERVAL_MS;
  const later = alertsFor({ stamp, clock });
  later.prepare(reportOf(PURPOSE_IDS.map((purposeId) => purpose(purposeId, 'failed', 'LEDGER_PATH_IN_PROJECT'))));
  events.length = 0;
  assert.equal((await later.flush({ notifier, rest: fakeRest(events) })).emergency, 'sent');
  assert.deepEqual(events.slice(0, 2), ['stamp read', 'stamp write']);
});

test('a stamp that cannot be read or trusted sends nothing and is escalated; a failed stamp write sends nothing',
  async () => {
    const failedStart = () => reportOf([purpose('owner-safety', 'failed', 'LEDGER_FILES_MISSING'),
      ...PURPOSE_IDS.filter((id) => id !== 'owner-safety').map((id) => purpose(id, 'ready', 'LEDGER_READY'))]);
    for (const [label, options, expected, code] of [
      ['unreadable', { readError: new Error('synthetic read failure') }, 'stamp-unreadable', 'LEDGER_ALERT_STAMP_UNREADABLE'],
      ['corrupt', { value: '{"schema":1,"sentAtMs":"soon"}' }, 'stamp-invalid', 'LEDGER_ALERT_STAMP_INVALID'],
      ['extra field', { value: '{"schema":1,"sentAtMs":1,"by":"x"}' }, 'stamp-invalid', 'LEDGER_ALERT_STAMP_INVALID'],
      ['write failed', { writeError: new Error('synthetic write failure') }, 'stamp-write-failed', 'LEDGER_ALERT_STAMP_WRITE_FAILED'],
    ]) {
      const events = [];
      const alerts = alertsFor({ stamp: fakeStamp(events, options) });
      alerts.prepare(failedStart());
      assert.equal((await alerts.flush({ notifier: fakeNotifier({ ready: false }), rest: fakeRest(events) })).emergency,
        expected, label);
      assert.equal(events.some((event) => event.startsWith('post ')), false, label);
      assert.ok(alerts.getLedgerEscalations().some((entry) => entry.code === code), label);
    }
    // A stamp changed by someone else between the read and the write is a failed write.
    const events = [];
    const stamp = fakeStamp(events);
    const read = stamp.read;
    stamp.read = async () => {
      const result = await read();
      stamp.value = JSON.stringify({ schema: 1, sentAtMs: 1 });
      return result;
    };
    const raced = alertsFor({ stamp });
    raced.prepare(failedStart());
    assert.equal((await raced.flush({ notifier: fakeNotifier({ ready: false }), rest: fakeRest(events) })).emergency,
      'stamp-write-failed');
    assert.equal(events.some((event) => event.startsWith('post ')), false);
  });

test('a failed emergency send is not retried before the next window', async () => {
  const events = [];
  const stamp = fakeStamp(events);
  const clock = { value: WALL_CLOCK };
  const alerts = alertsFor({ stamp, clock });
  alerts.prepare(reportOf([purpose('owner-safety', 'failed', 'LEDGER_ROLLBACK', { reason: 'gap' }),
    ...PURPOSE_IDS.filter((id) => id !== 'owner-safety').map((id) => purpose(id, 'ready', 'LEDGER_READY'))]));
  assert.equal((await alerts.flush({ notifier: fakeNotifier({ ready: false }), rest: fakeRest(events, { failChannel: true }) }))
    .emergency, 'failed');
  assert.deepEqual(events, ['stamp read', 'stamp write', 'post /users/@me/channels']);
  // A later anomaly in the same process waits for the window, without reading the stamp.
  events.length = 0;
  clock.value += 60_000;
  assert.equal(await alerts.noteRuntimeDisabled('welcome', 'LEDGER_FAILED'), 'suppressed');
  assert.deepEqual(events, []);
});

test('an emergency DM the local egress limit holds back keeps the 6-hour window for a later try', async () => {
  const events = [];
  const stamp = fakeStamp(events);
  const clock = { value: WALL_CLOCK };
  const logger = capturingLogger();
  const alerts = alertsFor({ stamp, clock, logger });
  alerts.prepare(reportOf([purpose('owner-safety', 'failed', 'LEDGER_ROLLBACK', { reason: 'gap' }),
    ...PURPOSE_IDS.filter((id) => id !== 'owner-safety').map((id) => purpose(id, 'ready', 'LEDGER_READY'))]));
  // The bot's own egress guard and limiter, as index.js installs them. Three DM channels to the Owner
  // this hour already use up the limit for one recipient (3 an hour).
  const rest = fakeRest(events);
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
  const limiter = createEgressLimiter({ now: () => clock.value });
  guard.setAdmission((details) => limiter.admit(details));
  for (let index = 0; index < 3; index += 1) {
    limiter.admit({ method: 'POST', fullRoute: '/users/@me/channels', body: { recipient_id: OWNER_ID } });
  }
  const notifier = fakeNotifier({ ready: false });
  assert.equal((await alerts.flush({ notifier, rest })).emergency, 'not-sent');
  // Nothing reached Discord, and the stamp no longer holds the window.
  assert.deepEqual(events, ['stamp read', 'stamp write', 'stamp write']);
  assert.deepEqual(parseStamp({ value: stamp.value }), { sentAtMs: 0 });
  assert.ok(logger.lines.some(([, line]) => line === '[SAFETY_LEDGER] code=LEDGER_EMERGENCY_NOTICE_NOT_SENT'));
  // Before the limit has room again, a later anomaly waits too, without reading the stamp.
  events.length = 0;
  clock.value += 60_000;
  assert.equal(await alerts.noteRuntimeDisabled('welcome', 'LEDGER_FAILED'), 'deferred');
  assert.deepEqual(events, []);
  // Then the next anomaly sends one DM that still carries the first one.
  clock.value = WALL_CLOCK + 60 * 60_000 + 1;
  assert.equal(await alerts.noteRuntimeDisabled('word-chain.reaction', 'LEDGER_FAILED'), 'sent');
  assert.deepEqual(events, ['stamp read', 'stamp write', 'post /users/@me/channels', `post /channels/${CHANNEL_ID}/messages`]);
  const content = rest.calls.at(-1).options.body.content;
  assert.ok(content.includes('LEDGER_ROLLBACK') && content.includes('LEDGER_FAILED'));
  assert.ok(content.includes('新人歡迎') && content.includes('文字接龍'));
  assertFixedText(content);
  assert.deepEqual(parseStamp({ value: stamp.value }), { sentAtMs: clock.value });
  // A DM that was sent holds the window as before.
  events.length = 0;
  clock.value += 60_000;
  assert.equal(await alerts.noteRuntimeDisabled('number-chain.reaction', 'LEDGER_FAILED'), 'suppressed');
  assert.deepEqual(events, []);
});

test('an emergency DM held back before the network gives back the stamp it found, and a release that fails keeps the window',
  async () => {
    const failedOwner = () => reportOf([purpose('owner-safety', 'failed', 'LEDGER_FILES_MISSING'),
      ...PURPOSE_IDS.filter((id) => id !== 'owner-safety').map((id) => purpose(id, 'ready', 'LEDGER_READY'))]);
    const refusingRest = (events) => {
      const rest = fakeRest(events);
      const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
      guard.setAdmission(() => {
        throw Object.assign(new Error('synthetic local refusal'), { code: 'EGRESS_RATE_LIMITED', retryAfterMs: 0 });
      });
      return rest;
    };
    // A stamp from a DM 7 hours ago is written back as it was.
    const previous = JSON.stringify({ schema: 1, sentAtMs: WALL_CLOCK - 7 * 60 * 60_000 });
    const events = [];
    const stamp = fakeStamp(events, { value: previous });
    const alerts = alertsFor({ stamp });
    alerts.prepare(failedOwner());
    assert.equal((await alerts.flush({ notifier: fakeNotifier({ ready: false }), rest: refusingRest(events) })).emergency,
      'not-sent');
    assert.equal(stamp.value, previous);
    assert.equal(events.some((event) => event.startsWith('post ')), false);

    // The stamp changed by someone else meanwhile: it is left alone, so the window holds.
    const raceEvents = [];
    const raced = fakeStamp(raceEvents);
    const write = raced.write;
    raced.write = async (next, expected) => {
      const result = await write(next, expected);
      if (raced.writes === 1) raced.value = JSON.stringify({ schema: 1, sentAtMs: WALL_CLOCK + 1 });
      return result;
    };
    const logger = capturingLogger();
    const racedAlerts = alertsFor({ stamp: raced, logger });
    racedAlerts.prepare(failedOwner());
    assert.equal((await racedAlerts.flush({ notifier: fakeNotifier({ ready: false }), rest: refusingRest(raceEvents) }))
      .emergency, 'not-sent');
    assert.deepEqual(parseStamp({ value: raced.value }), { sentAtMs: WALL_CLOCK + 1 });
    assert.ok(logger.lines.some(([, line]) => line === '[SAFETY_LEDGER] code=LEDGER_ALERT_STAMP_RELEASE_FAILED'));
  });

test('runtime events: a notice per purpose through the Owner ledger; the Owner purpose and a bot mismatch by emergency DM',
  async () => {
    const events = [];
    const stamp = fakeStamp(events);
    const clock = { value: WALL_CLOCK };
    const alerts = alertsFor({ stamp, clock });
    alerts.prepare(reportOf(allReady()));
    // A purpose turned off before ready (a refused ledger, say) waits for the flush and is
    // told in the start's one notice, where the Owner-notice budget cannot drop it.
    assert.equal(await alerts.noteRuntimeDisabled('welcome', 'LEDGER_QUARANTINED'), 'pending');
    const notifier = fakeNotifier();
    const rest = fakeRest(events);
    assert.deepEqual(await alerts.flush({ notifier, rest }), { owner: 1, emergency: 'none' });
    assert.deepEqual(notifier.notices.map(({ category, mergeScope }) => [category, mergeScope]), [['startup', 'boot']]);
    assert.ok(notifier.notices[0].content.includes('已停用：\n・新人歡迎（LEDGER_QUARANTINED）'));
    assertFixedText(notifier.notices[0].content);
    // Each purpose is told once; the status card follows it.
    assert.equal(await alerts.noteRuntimeDisabled('word-chain.reaction', 'REACTION_FENCE_OPEN_FAILED'), 'queued');
    assert.equal(await alerts.noteRuntimeDisabled('word-chain.reaction', 'LEDGER_FAILED'), 'none');
    assert.deepEqual(['welcome', 'word_chain', 'number_chain'].map((key) => alerts.featureStatus(key)),
      ['broken', 'broken', null]);
    assert.equal(notifier.notices.length, 2);
    assert.deepEqual(events, []);
    // The Owner purpose itself cannot be told through its own ledger.
    notifier.ready = false;
    assert.equal(await alerts.noteRuntimeDisabled('owner-safety', 'LEDGER_FAILED'), 'sent');
    assert.equal(notifier.notices.length, 2);
    const emergency = rest.calls.at(-1).options.body.content;
    assert.ok(emergency.includes('Owner 安全通知'));
    assert.ok(emergency.includes('LEDGER_FAILED'));
    assertFixedText(emergency);

    // A bot identity that differs at ready: every status card is broken and only the
    // emergency path is used, even with a ready Owner ledger.
    const mismatchEvents = [];
    const mismatch = alertsFor({ stamp: fakeStamp(mismatchEvents), clock });
    mismatch.prepare(reportOf(allReady()));
    assert.equal(await mismatch.noteBotMismatch(), 'pending');
    const readyNotifier = fakeNotifier();
    const mismatchRest = fakeRest(mismatchEvents);
    assert.deepEqual(await mismatch.flush({ notifier: readyNotifier, rest: mismatchRest }), { owner: 0, emergency: 'sent' });
    assert.deepEqual(readyNotifier.notices, []);
    assert.ok(mismatchRest.calls.at(-1).options.body.content.includes(HINTS.LEDGER_BOT_MISMATCH));
    assert.deepEqual(['welcome', 'word_chain', 'number_chain'].map((key) => mismatch.featureStatus(key)),
      ['broken', 'broken', 'broken']);
    assert.deepEqual(escalationKeys(mismatch), ['all|LEDGER_BOT_MISMATCH|open|']);
  });

test('stop-time events are escalated but never sent, and a stop clears the status overrides', async () => {
  const events = [];
  const alerts = alertsFor({ stamp: fakeStamp(events) });
  alerts.prepare(reportOf([purpose('welcome', 'failed', 'LEDGER_PARTIAL'),
    ...PURPOSE_IDS.filter((id) => id !== 'welcome').map((id) => purpose(id, 'ready', 'LEDGER_READY'))]));
  const notifier = fakeNotifier();
  await alerts.flush({ notifier, rest: fakeRest(events) });
  assert.equal(alerts.featureStatus('welcome'), 'broken');
  alerts.beginStop();
  assert.equal(alerts.featureStatus('welcome'), null);
  alerts.noteLastSeenFailed('close');
  alerts.noteQuarantineUnpersisted('word-chain.reaction');
  assert.equal(await alerts.noteRuntimeDisabled('number-chain.reaction', 'LEDGER_FAILED'), 'none');
  assert.equal(await alerts.noteBotMismatch(), 'none');
  assert.equal(notifier.notices.length, 1);
  assert.deepEqual(events, []);
  assert.deepEqual(escalationKeys(alerts), [
    'all|LEDGER_BOT_MISMATCH|open|',
    'all|LEDGER_LAST_SEEN_WRITE_FAILED|close|',
    'welcome|LEDGER_PARTIAL|open|',
    'word-chain.reaction|LEDGER_QUARANTINE_UNPERSISTED|close|',
  ]);
});

test('the emergency DM needs a valid Owner ID and a REST client', async () => {
  for (const [ownerId, withRest] of [['', true], ['not-an-id', true], [OWNER_ID, false]]) {
    const events = [];
    const logger = capturingLogger();
    const alerts = alertsFor({ ownerId, logger, stamp: fakeStamp(events) });
    alerts.prepare(failedBootstrapReport());
    assert.equal((await alerts.flush({ notifier: null, rest: withRest ? fakeRest(events) : null })).emergency,
      'unavailable');
    assert.deepEqual(events, []);
    assert.ok(logger.lines.some(([, line]) => line.includes('LEDGER_EMERGENCY_NOTICE_UNAVAILABLE')));
  }
});

test('while the start guard holds Owner DMs back, an emergency DM due is dropped: no stamp, nothing sent then or later',
  async () => {
    const events = [];
    const stamp = fakeStamp(events);
    const logger = capturingLogger();
    const gate = { open: false, allowsOwnerDm() { return this.open; } };
    const clock = { value: WALL_CLOCK };
    const alerts = alertsFor({ stamp, logger, clock, ownerDmGate: gate });
    alerts.prepare(reportOf(PURPOSE_IDS.map((purposeId) => purpose(purposeId, 'failed', 'LEDGER_PATH_IN_PROJECT',
      { reason: 'base', ledgerId: null, confirmationCode: null }))));
    const rest = fakeRest(events);
    assert.deepEqual(await alerts.flush({ notifier: fakeNotifier({ ready: false }), rest }),
      { owner: 0, emergency: 'start-guard' });
    assert.equal(await alerts.noteBotMismatch(), 'start-guard');
    assert.deepEqual(events, [], 'no stamp is read or written and no request is made');
    assert.equal(stamp.value, null);
    // One line a minute, with the number left out since the last one.
    const guardLines = () => logger.lines.filter(([, line]) => line.includes('OWNER_DM_GUARD'));
    assert.deepEqual(guardLines(), [['warn', '[SAFETY_LEDGER] code=OWNER_DM_GUARD_BLOCKED kind=emergency skipped=0']]);
    clock.value += 60_000;
    assert.equal(await alerts.noteRuntimeDisabled('number-chain.reaction', 'SIDE_EFFECT_FILE_CORRUPT'), 'start-guard');
    assert.deepEqual(guardLines().at(-1), ['warn', '[SAFETY_LEDGER] code=OWNER_DM_GUARD_BLOCKED kind=emergency skipped=1']);
    assert.equal(guardLines().length, 2);
    // Escalations (the exit code) do not depend on the DM.
    assert.equal(escalationKeys(alerts).length, PURPOSE_IDS.length + 1);

    // Once the start succeeded, a new anomaly is sent alone: what was held back is not.
    gate.open = true;
    assert.equal(await alerts.noteRuntimeDisabled('welcome', 'SIDE_EFFECT_FILE_CORRUPT'), 'sent');
    const content = rest.calls.at(-1).options.body.content;
    assert.ok(content.includes('SIDE_EFFECT_FILE_CORRUPT'));
    assert.equal(content.includes('LEDGER_PATH_IN_PROJECT'), false);
    assert.equal(content.includes('LEDGER_BOT_MISMATCH'), false);
    assert.deepEqual(events.slice(0, 2), ['stamp read', 'stamp write']);

    // A gate that cannot answer holds the DM back as well.
    const failing = alertsFor({ stamp: fakeStamp([]), ownerDmGate: { allowsOwnerDm() { throw new Error('synthetic'); } } });
    failing.prepare(failedBootstrapReport());
    assert.equal((await failing.flush({ notifier: null, rest: fakeRest([]) })).emergency, 'start-guard');
  });

test('a bootstrap that failed as a whole fails every purpose closed and reaches the Owner by emergency DM', async () => {
  const report = failedBootstrapReport({ runtimeMode: 'production', nowMs: WALL_CLOCK });
  assert.deepEqual(report.purposes.map((item) => [item.purposeId, item.status, item.code]),
    PURPOSE_IDS.map((purposeId) => [purposeId, 'failed', 'LEDGER_BOOTSTRAP_FAILED']));
  const events = [];
  const alerts = alertsFor({ stamp: fakeStamp(events) });
  alerts.prepare(report);
  assert.equal(alerts.getLedgerEscalations().length, PURPOSE_IDS.length);
  const rest = fakeRest(events);
  assert.equal((await alerts.flush({ notifier: fakeNotifier({ ready: false }), rest })).emergency, 'sent');
  const content = rest.calls.at(-1).options.body.content;
  assert.ok(content.includes('LEDGER_BOOTSTRAP_FAILED'));
  assert.ok(content.includes('npm run safety:ledger -- status'));
  assertFixedText(content);
});

test('long notices are cut item by item to fit the Owner ledger binding and Discord', () => {
  const many = Array.from({ length: 200 }, (_, index) => ({ purposeId: PURPOSE_IDS[index % PURPOSE_IDS.length],
    code: `LEDGER_SYNTHETIC_${index}`, reason: null }));
  const notice = buildStartupNotice({ created: [], anomalies: many, notices: [], lastSeenFailed: false });
  assert.ok(notice.content.includes('・Owner 安全通知（LEDGER_SYNTHETIC_0）'));
  assert.ok(notice.content.includes('…（其餘項目略）'));
  assert.equal(notice.content.includes('LEDGER_SYNTHETIC_199'), false);
  assertFixedText(notice.content);
  const emergency = buildEmergencyNotice({ purposeIds: PURPOSE_IDS, codes: many.map((item) => item.code) });
  assert.ok(emergency.includes('LEDGER_SYNTHETIC_9、…'));
  assertFixedText(emergency);
});

test('an escalation is seen once, at the moment it is recorded, whatever its observer does', () => {
  const seen = [];
  const escalations = createLedgerEscalations({ onRecord: (entry) => {
    seen.push(entry);
    throw new Error('a failing observer changes nothing');
  } });
  escalations.record('all', 'LEDGER_BOT_MISMATCH', 'open');
  escalations.record('all', 'LEDGER_BOT_MISMATCH', 'open');
  escalations.record('welcome', 'not a code', 'open');
  escalations.record('welcome', 'LEDGER_FAILED', 'later');
  escalations.record('welcome', 'LEDGER_ROLLBACK', 'open', 'Not A Reason');
  assert.deepEqual(seen, [
    { purposeId: 'all', code: 'LEDGER_BOT_MISMATCH', stage: 'open', reason: null },
    { purposeId: 'welcome', code: 'LEDGER_ROLLBACK', stage: 'open', reason: null },
  ]);
  assert.equal(escalations.list().length, 2);
  assert.equal(formatLedgerEscalation({ purposeId: 'welcome', code: 'LEDGER_ROLLBACK', stage: 'open', reason: 'gap' }),
    '[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=welcome cause=LEDGER_ROLLBACK stage=open reason=gap');
});

test('an Owner ledger refused before ready: one emergency DM, which also lists what the start created', async () => {
  const events = [];
  const stamp = fakeStamp(events);
  const alerts = alertsFor({ stamp });
  alerts.prepare(reportOf(allReady({ code: 'LEDGER_CREATED', created: true })));
  // The Owner notifier's preflight refused the delivered Owner ledger.
  assert.equal(await alerts.noteRuntimeDisabled('owner-safety', 'OWNER_SAFETY_LEDGER_UNAVAILABLE'), 'pending');
  const notifier = fakeNotifier({ ready: false });
  const rest = fakeRest(events);
  assert.deepEqual(await alerts.flush({ notifier, rest }), { owner: 0, emergency: 'sent' });
  assert.deepEqual(notifier.notices, []);
  assert.deepEqual(events, ['stamp read', 'stamp write', 'post /users/@me/channels', `post /channels/${CHANNEL_ID}/messages`]);
  const content = rest.calls.at(-1).options.body.content;
  assert.ok(content.startsWith('小吉緊急安全提示'));
  assert.ok(content.includes('停用的功能：Owner 安全通知'));
  assert.ok(content.includes('代碼：OWNER_SAFETY_LEDGER_UNAVAILABLE'));
  assert.ok(content.includes('本次啟動已建立的帳本（cutover 之前的事件不會補發）：'));
  assert.ok(content.includes(`・新人歡迎（cutover <t:${Math.floor(CUTOVER_MS / 1_000)}:F>）`));
  assert.ok(content.includes('・自動離群（休眠）（不套用 cutover）'));
  assertFixedText(content);
  assert.equal(alerts.featureStatus('welcome'), null);
});

test('an emergency stamp more than five minutes ahead of the clock holds nothing back', async () => {
  for (const [label, sentAtMs, expected] of [
    ['at the tolerance', WALL_CLOCK + STAMP_FUTURE_TOLERANCE_MS, 'suppressed'],
    ['past the tolerance', WALL_CLOCK + STAMP_FUTURE_TOLERANCE_MS + 1, 'sent'],
  ]) {
    const events = [];
    const logger = capturingLogger();
    const stamp = fakeStamp(events, { value: JSON.stringify({ schema: 1, sentAtMs }) });
    const alerts = alertsFor({ stamp, logger });
    alerts.prepare(failedBootstrapReport({ nowMs: WALL_CLOCK }));
    assert.equal((await alerts.flush({ notifier: fakeNotifier({ ready: false }), rest: fakeRest(events) })).emergency,
      expected, label);
    const future = logger.lines.filter(([, line]) => line === '[SAFETY_LEDGER] code=LEDGER_ALERT_STAMP_FUTURE');
    if (expected === 'sent') {
      // Overwritten with the same compare-and-set, then sent; one fixed code says why.
      assert.deepEqual(events, ['stamp read', 'stamp write', 'post /users/@me/channels', `post /channels/${CHANNEL_ID}/messages`]);
      assert.deepEqual(parseStamp({ value: stamp.value }), { sentAtMs: WALL_CLOCK });
      assert.equal(future.length, 1, label);
    } else {
      assert.deepEqual(events, ['stamp read'], label);
      assert.equal(future.length, 0, label);
    }
    assert.equal(alerts.getLedgerEscalations().some((entry) => entry.code.startsWith('LEDGER_ALERT_STAMP')), false, label);
  }

  // The clock set back by an hour after a DM: the in-process time and the stamp are both
  // ahead of it, so the next anomaly is told at once.
  const events = [];
  const clock = { value: WALL_CLOCK };
  const stamp = fakeStamp(events);
  const alerts = alertsFor({ stamp, clock });
  alerts.prepare(failedBootstrapReport({ nowMs: WALL_CLOCK }));
  assert.equal((await alerts.flush({ notifier: fakeNotifier({ ready: false }), rest: fakeRest(events) })).emergency, 'sent');
  clock.value = WALL_CLOCK - 60 * 60_000;
  events.length = 0;
  assert.equal(await alerts.noteBotMismatch(), 'sent');
  assert.deepEqual(events.slice(0, 2), ['stamp read', 'stamp write']);
  assert.deepEqual(parseStamp({ value: stamp.value }), { sentAtMs: WALL_CLOCK - 60 * 60_000 });
});

test('an emergency DM whose request never answers ends at its timeout and is not retried', async () => {
  const events = [];
  const logger = capturingLogger();
  const alerts = createLedgerAlerts({ runtimeMode: 'production', logger, ownerId: OWNER_ID, now: () => WALL_CLOCK,
    stamp: fakeStamp(events), emergencyTimeoutMs: 150 });
  alerts.prepare(failedBootstrapReport({ nowMs: WALL_CLOCK }));
  const rest = createSyntheticRest({ post: async (route) => { events.push(`post ${route}`); return new Promise(() => {}); } });
  const begun = performance.now();
  assert.equal((await alerts.flush({ notifier: null, rest })).emergency, 'failed');
  assert.ok(performance.now() - begun < 5_000);
  assert.deepEqual(events, ['stamp read', 'stamp write', 'post /users/@me/channels']);
  assert.ok(logger.lines.some(([, line]) => line === '[SAFETY_LEDGER] code=LEDGER_EMERGENCY_NOTICE_FAILED'));
});
