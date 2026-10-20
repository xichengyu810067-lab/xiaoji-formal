'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { createReminderSystem } = require('../src/systems/schedule/reminders/reminderSystem');

test('a user cannot create a 21st pending reminder', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-reminder-limit-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const timers = new Map();
  const system = createReminderSystem({ filePath: path.join(directory, 'reminders.json'), timers });
  system.initializeReminderStore();
  const client = {};
  for (let index = 0; index < 20; index += 1) {
    system.addReminder(client, system.createReminder({ guildId: 'guild', channelId: 'channel', userId: 'user',
      message: `提醒 ${index}`, durationMs: 60 * 60 * 1_000, now: 1_000 + index }));
  }
  assert.equal(system.listUserReminders({ userId: 'user' }).length, 20);
  assert.throws(() => system.addReminder(client, system.createReminder({ guildId: 'guild', channelId: 'channel', userId: 'user',
    message: '第 21 則', durationMs: 60 * 60 * 1_000, now: 2_000 })),
  (error) => error?.code === 'REMINDER_ACTIVE_LIMIT');
  assert.equal(system.listUserReminders({ userId: 'user' }).length, 20);
  for (const timer of timers.values()) clearTimeout(timer);
});

test('a full egress reservation keeps a reminder pending before it enters sending', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-reminder-defer-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const timers = new Map();
  const system = createReminderSystem({ filePath: path.join(directory, 'reminders.json'), timers });
  system.initializeReminderStore();
  const reminder = system.createReminder({ guildId: 'guild', channelId: 'channel', userId: 'user',
    message: '稍後提醒', durationMs: 60 * 60 * 1_000 });
  system.addReminder({}, reminder);
  let sent = 0;
  const channel = {
    guildId: 'guild', isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
    async send() { sent += 1; },
  };
  const client = {
    user: { id: 'bot' }, guilds: { fetch: async () => ({ members: { me: { id: 'bot' }, fetch: async () => ({ id: 'user' }) } }) },
    channels: { fetch: async () => channel },
    egressLimiter: { reserve: () => ({ allowed: false, retryAfterMs: 1_000 }) },
  };
  const result = await system.sendReminder(client, reminder.id);
  assert.equal(result.status, 'pending');
  assert.equal(result.attemptCount, 0);
  assert.equal(sent, 0);
  for (const timer of timers.values()) clearTimeout(timer);
});

const { createEgressLimiter, EgressRateLimitError } = require('../src/platform/egressLimiter');
const { installEgressGuard, isEgressRefusal } = require('../src/platform/egressGuard');
const { createSyntheticRest } = require('./fixtures/syntheticRest');

const REMINDER_CHANNEL_ID = '12345678901234567';
const UNCONFIRMED_REASON = '投遞結果未確認，請人工核對。';

function createSendHarness(t, { send, limiter = createEgressLimiter() }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-reminder-send-'));
  const timers = new Map();
  t.after(() => {
    for (const timer of timers.values()) clearTimeout(timer);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const filePath = path.join(directory, 'reminders.json');
  const system = createReminderSystem({ filePath, timers });
  system.initializeReminderStore();
  const reminder = system.createReminder({ guildId: 'guild', channelId: REMINDER_CHANNEL_ID, userId: 'user',
    message: '稍後提醒', durationMs: 60 * 60 * 1_000 });
  system.addReminder({}, reminder);
  // Drop the timer addReminder armed, so a timer present later was armed by the send path itself.
  clearTimeout(timers.get(reminder.id));
  timers.delete(reminder.id);
  const state = { sendCalls: 0 };
  const channel = {
    guildId: 'guild', isTextBased: () => true, permissionsFor: () => ({ has: () => true }),
    async send(payload) { state.sendCalls += 1; return send(payload); },
  };
  const client = {
    user: { id: 'bot' },
    guilds: { fetch: async () => ({ members: { me: { id: 'bot' }, fetch: async () => ({ id: 'user' }) } }) },
    channels: { fetch: async () => channel },
    egressLimiter: limiter,
  };
  return {
    system, client, limiter, timers, state, reminderId: reminder.id, lockPath: filePath + '.lock',
    stored: () => system.readReminders()[reminder.id],
  };
}

async function realEgressRefusal() {
  const guildId = '23456789012345678';
  const rest = createSyntheticRest({ patch() {} });
  installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2', privateGuildIds: [guildId] });
  try {
    await rest.request({ method: 'PATCH', fullRoute: `/guilds/${guildId}/members/${REMINDER_CHANNEL_ID}`, body: { roles: [] } });
  } catch (error) {
    assert.equal(isEgressRefusal(error), true);
    return error;
  }
  throw assert.fail('The egress guard did not refuse the request.');
}

test('a reminder whose sending mark cannot be written does not keep the egress reservation', async (t) => {
  const harness = createSendHarness(t, { send: async () => assert.fail('nothing may be sent') });
  // A writer holding the lock makes every write of the reminder file fail.
  fs.writeFileSync(harness.lockPath, '');

  await assert.rejects(() => harness.system.sendReminder(harness.client, harness.reminderId), { code: 'EEXIST' });

  assert.equal(harness.limiter.snapshotForTests().reservations, 0);
  assert.equal(harness.state.sendCalls, 0);
  fs.unlinkSync(harness.lockPath);
  assert.equal(harness.stored().status, 'pending');
  assert.equal(harness.stored().attemptCount, 0);
});

for (const [name, makeError, expectedDelayMs] of [
  ['a rate limit that turns up at send time', () => new EgressRateLimitError('rate_limited', { retryAfterMs: 5_000 }), 5_000],
  ['an expired reservation at send time', () => new EgressRateLimitError('reservation_expired'), 60_000],
]) {
  test(`${name} puts the reminder back to pending without counting an attempt`, async (t) => {
    const harness = createSendHarness(t, { send: async () => { throw makeError(); } });
    const before = Date.now();

    const result = await harness.system.sendReminder(harness.client, harness.reminderId);
    const after = Date.now();

    assert.equal(harness.state.sendCalls, 1);
    for (const record of [result, harness.stored()]) {
      assert.equal(record.status, 'pending');
      assert.equal(record.attemptCount, 0);
      assert.ok(record.nextAttemptAt >= before + expectedDelayMs && record.nextAttemptAt <= after + expectedDelayMs,
        `nextAttemptAt ${record.nextAttemptAt} is not about ${expectedDelayMs} ms away`);
    }
    assert.equal(harness.timers.has(harness.reminderId), true, 'the next attempt must be scheduled');
    assert.equal(harness.limiter.snapshotForTests().reservations, 0);
  });
}

test('an egress refusal at send time retries a bounded number of times and then fails with a clear reason', async (t) => {
  const refusal = await realEgressRefusal();
  const harness = createSendHarness(t, { send: async () => { throw refusal; } });
  // The scheduler's timer has fired when it calls sendReminder, so it is gone by then.
  const fire = () => {
    clearTimeout(harness.timers.get(harness.reminderId));
    harness.timers.delete(harness.reminderId);
    return harness.system.sendReminder(harness.client, harness.reminderId);
  };

  const first = await fire();
  assert.deepEqual([first.status, first.attemptCount], ['pending', 1]);
  assert.ok(first.nextAttemptAt > Date.now());
  assert.equal(harness.timers.has(harness.reminderId), true);

  const second = await fire();
  assert.deepEqual([second.status, second.attemptCount], ['pending', 2]);

  const third = await fire();
  assert.deepEqual([third.status, third.attemptCount], ['failed', 3]);
  assert.notEqual(third.failureReason, UNCONFIRMED_REASON, 'a refused request is known not to have been sent');
  assert.equal(harness.timers.has(harness.reminderId), false);

  assert.equal(await fire(), null);
  assert.equal(harness.state.sendCalls, 3);
  assert.equal(harness.limiter.snapshotForTests().reservations, 0);
});

test('an error that may have reached Discord still leaves the reminder failed and unconfirmed', async (t) => {
  const harness = createSendHarness(t, { send: async () => { throw new Error('socket closed'); } });

  const result = await harness.system.sendReminder(harness.client, harness.reminderId);

  assert.equal(result.status, 'failed');
  assert.equal(result.failureReason, UNCONFIRMED_REASON);
  assert.equal(harness.stored().status, 'failed');
  assert.equal(harness.timers.has(harness.reminderId), false);
  assert.equal(harness.limiter.snapshotForTests().reservations, 0);
});

const DAY = 86_400_000;

function finishedRecord(id, { userId = 'user', status, at, timed = true }) {
  return {
    id, schemaVersion: 1, guildId: 'guild', channelId: REMINDER_CHANNEL_ID, userId, message: '舊提醒',
    createdAt: at - 1_000, remindAt: at - 500, status, attemptCount: 1,
    ...(timed ? { [status === 'delivered' ? 'deliveredAt' : 'failedAt']: at } : {}),
  };
}

function seededSystem(t, records) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-reminder-retention-'));
  const timers = new Map();
  t.after(() => {
    for (const timer of timers.values()) clearTimeout(timer);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const system = createReminderSystem({ filePath: path.join(directory, 'reminders.json'), timers });
  system.initializeReminderStore();
  system.writeReminders(Object.fromEntries(records.map((record) => [record.id, record])));
  const addPending = (userId = 'user') => system.addReminder({}, system.createReminder({
    guildId: 'guild', channelId: REMINDER_CHANNEL_ID, userId, message: '新提醒', durationMs: 60 * 60 * 1_000,
  }));
  return { system, addPending };
}

test('a write drops delivered and failed reminders older than 7 days and keeps the rest', (t) => {
  const now = Date.now();
  const { system, addPending } = seededSystem(t, [
    finishedRecord('delivered-old', { status: 'delivered', at: now - 8 * DAY }),
    finishedRecord('failed-old', { status: 'failed', at: now - 8 * DAY }),
    finishedRecord('delivered-recent', { status: 'delivered', at: now - 6 * DAY }),
    finishedRecord('failed-recent', { status: 'failed', at: now - 6 * DAY }),
    finishedRecord('other-user-old', { userId: 'other', status: 'delivered', at: now - 9 * DAY }),
    finishedRecord('still-pending', { status: 'pending', at: now - 30 * DAY, timed: false }),
    finishedRecord('still-sending', { status: 'sending', at: now - 30 * DAY, timed: false }),
  ]);

  const added = addPending();
  assert.deepEqual(Object.keys(system.readReminders()).sort(), [
    added.id, 'delivered-recent', 'failed-recent', 'still-pending', 'still-sending',
  ].sort());
});

test('one user keeps only the 50 most recent delivered or failed reminders', (t) => {
  const now = Date.now();
  const { system, addPending } = seededSystem(t, [
    ...Array.from({ length: 40 }, (_, index) => finishedRecord(`delivered-${index}`, {
      status: 'delivered', at: now - 60_000 - index * 1_000,
    })),
    ...Array.from({ length: 30 }, (_, index) => finishedRecord(`failed-${index}`, {
      status: 'failed', at: now - 100_000 - index * 1_000,
    })),
    ...Array.from({ length: 5 }, (_, index) => finishedRecord(`other-${index}`, {
      userId: 'other', status: 'delivered', at: now - 200_000 - index * 1_000,
    })),
  ]);

  addPending();
  const stored = system.readReminders();
  const finished = Object.values(stored).filter((record) => record.userId === 'user' &&
    (record.status === 'delivered' || record.status === 'failed'));
  assert.equal(finished.length, 50);
  assert.ok(stored['delivered-39'], 'every delivered reminder is newer than the failed ones');
  assert.ok(stored['failed-9'], 'the 10 newest failed reminders fill the rest');
  assert.equal(stored['failed-10'], undefined);
  assert.equal(Object.values(stored).filter((record) => record.userId === 'other').length, 5);
});

test('a failed reminder with no recorded time is timed from the write that sees it, not dropped', (t) => {
  const now = Date.now();
  const { system, addPending } = seededSystem(t, [
    finishedRecord('legacy-failed', { status: 'failed', at: now - 40 * DAY, timed: false }),
    finishedRecord('legacy-delivered', { status: 'delivered', at: now - 40 * DAY, timed: false }),
  ]);

  addPending();
  const stored = system.readReminders();
  assert.ok(stored['legacy-failed'].failedAt >= now);
  assert.ok(stored['legacy-delivered'].deliveredAt >= now);
});

test('a reminder that fails records when it failed, and a delivery drops finished reminders past 7 days', async (t) => {
  const failing = createSendHarness(t, { send: async () => { throw new Error('socket closed'); } });
  const before = Date.now();
  await failing.system.sendReminder(failing.client, failing.reminderId);
  const failedAt = failing.stored().failedAt;
  assert.ok(failedAt >= before && failedAt <= Date.now());

  const delivering = createSendHarness(t, { send: async () => {} });
  delivering.system.writeReminders({
    ...delivering.system.readReminders(),
    'finished-old': finishedRecord('finished-old', { status: 'failed', at: before - 8 * DAY }),
  });
  await delivering.system.sendReminder(delivering.client, delivering.reminderId);
  assert.equal(delivering.stored().status, 'delivered');
  assert.equal(delivering.system.readReminders()['finished-old'], undefined);
});
