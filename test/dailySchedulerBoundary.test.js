'use strict';

// The daily schedulers on a fake clock: no waiting for the real boundary. The real scheduler code runs with an
// injected clock and injected timers, the real tick runs against a synthetic database in a temporary directory,
// and only Discord is faked. Covered here:
//   - the topic is posted at the Taipei 00:00 boundary, the riddle at 10:00 and settled at 21:30;
//   - what a restart does when it finds the day already under way (catch-up rules);
//   - the grace window: a tick that runs up to 2 minutes after the start of the window (a real timer always runs a
//     little late) records "published"; only a later one records "published_late".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-daily-scheduler-'));
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.BOT_OWNER_ID = 'owner-user';

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
} = require('../src/services/coinDatabase');
const riddleService = require('../src/services/dailyRiddleService');
const discussionService = require('../src/services/dailyDiscussionService');
const { setGuildFeatureSetting } = require('../src/services/featurePlatformService');

const HOUR = 60 * 60 * 1000;
// A post within this long after the start of its window is on time (published); later it is published_late.
const GRACE_MS = 2 * 60 * 1000;
// Taipei is UTC+8, so Taipei 00:00 of 2026-09-30 is 2026-09-29T16:00:00Z.
const DISCUSSION_START = Date.parse('2026-09-29T16:00:00.000Z'); // discussion window of 2026-09-30 opens (Taipei 00:00)
const RIDDLE_START = Date.parse('2026-09-30T02:00:00.000Z'); // riddle window of 2026-09-30 opens (Taipei 10:00)
const RIDDLE_END = Date.parse('2026-09-30T13:30:00.000Z'); // riddle window of 2026-09-30 closes (Taipei 21:30)

let databaseCount = 0;
// Each case gets its own empty database, so that a tick of one case never touches the events of another.
async function freshDatabase() {
  resetCoinDatabaseForTests();
  databaseCount += 1;
  process.env.COIN_DB_PATH = path.join(root, `synthetic-${databaseCount}.sqlite`);
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
}

test.beforeEach(freshDatabase);

test.afterEach(() => {
  discussionService.stopDailyDiscussionScheduler({ clearTimeoutFn() {}, clearIntervalFn() {} });
  riddleService.stopDailyRiddleScheduler({ clearTimeoutFn() {}, clearIntervalFn() {} });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// A parent channel that keeps what it was sent and hands it back as its history, newest first. The thread keeps
// what was sent into it too (the riddle answer).
function createFixture(prefix) {
  const sent = [];
  const threadSent = [];
  const threadId = `${prefix}-thread`;
  const thread = {
    id: threadId,
    messages: { fetch: async () => [...threadSent].reverse() },
    async send(payload) {
      const message = { id: `${prefix}-answer-${threadSent.length + 1}`, payload, author: { id: 'bot' }, createdAt: new Date(), embeds: payload.embeds };
      threadSent.push(message);
      return message;
    },
  };
  const parentId = `${prefix}-parent`;
  const parent = {
    id: parentId,
    messages: { fetch: async () => [...sent].reverse() },
    async send(payload) {
      const message = {
        id: `${prefix}-announcement-${sent.length + 1}`,
        payload,
        author: { id: 'bot' },
        createdAt: new Date(),
        embeds: payload.embeds,
        async startThread() { return thread; },
      };
      sent.push(message);
      return message;
    },
  };
  const guildId = `${prefix}-guild`;
  const guild = {
    id: guildId,
    channels: {
      cache: new Map([[parentId, parent], [threadId, thread]]),
      fetch: async (id) => (id === parentId ? parent : id === threadId ? thread : null),
    },
  };
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([[guildId, guild]]) }, channels: { cache: new Map() } };
  return { client, sent, threadSent, guildId, parentId };
}

// A clock and timers the test moves by hand. Every tick the scheduler starts is kept, so that the test can wait for it.
function createFakeScheduler(startMs, tickFor) {
  let currentMs = startMs;
  const timeouts = [];
  const intervals = [];
  const ticks = [];
  const options = {
    nowFn: () => new Date(currentMs),
    setTimeoutFn: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      timeouts.push(timer);
      return timer;
    },
    clearTimeoutFn: (timer) => { if (timer) timer.cleared = true; },
    setIntervalFn: (callback, delay) => {
      const timer = { callback, delay, cleared: false, unref() {} };
      intervals.push(timer);
      return timer;
    },
    clearIntervalFn: (timer) => { if (timer) timer.cleared = true; },
    tick: (client, { now }) => {
      const running = tickFor(client, { now });
      ticks.push(running);
      return running;
    },
  };
  const scheduler = {
    options,
    timeouts,
    intervals,
    // The boundary timer that is armed right now: the last one that was set and not cleared.
    armed() { return timeouts.filter((timer) => !timer.cleared).at(-1); },
    // The clock reaches `ms`, the armed boundary timer fires, and everything it started finishes.
    async fireBoundaryAt(ms) {
      const timer = scheduler.armed();
      assert.ok(timer, 'a boundary timer is armed');
      timer.cleared = true;
      currentMs = ms;
      timer.callback();
      await scheduler.idle();
    },
    // Waits for every tick the scheduler started and for what it does after the tick (arming the next timer).
    async idle() {
      await Promise.all(ticks);
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
  return scheduler;
}

const discussionTick = (guildId) => (client, { now }) =>
  discussionService.processDailyDiscussionTick(client, { now, guildId });
const riddleTick = (client, { now }) => riddleService.processDailyRiddleTick(client, { now });

async function enableDiscussion(fixture) {
  await setGuildFeatureSetting(fixture.guildId, discussionService.FEATURE_KEY, { enabled: true, channelId: fixture.parentId });
}

async function enableRiddle(fixture) {
  await setGuildFeatureSetting(fixture.guildId, riddleService.FEATURE_KEY, { enabled: true, channelId: fixture.parentId });
}

// Starts the real scheduler on the fake clock. The first tick runs at once, as it does at a restart.
async function startDiscussion(fixture, startMs) {
  const scheduler = createFakeScheduler(startMs, discussionTick(fixture.guildId));
  await discussionService.startDailyDiscussionScheduler(fixture.client, scheduler.options);
  return scheduler;
}

async function startRiddle(fixture, startMs) {
  const scheduler = createFakeScheduler(startMs, riddleTick);
  await riddleService.startDailyRiddleScheduler(fixture.client, scheduler.options);
  return scheduler;
}

const discussionStatus = async (fixture, localDate) => (await discussionService.getDailyDiscussionEvent(fixture.guildId, localDate))?.status ?? null;
const riddleStatus = async (fixture, localDate) => (await riddleService.getDailyRiddleEvent(fixture.guildId, localDate))?.status ?? null;

// ---- the boundaries ---------------------------------------------------------------------------------------------------

test('the discussion scheduler posts the new topic at the Taipei 00:00 boundary and settles the day that ended', async () => {
  const fixture = createFixture('boundary-discussion');
  await enableDiscussion(fixture);
  // 23:59 in Taipei on 2026-09-29: the restart tick finds that day open and posts it late.
  const scheduler = await startDiscussion(fixture, DISCUSSION_START - 60_000);

  assert.equal(await discussionStatus(fixture, '2026-09-29'), 'published_late');
  assert.equal(await discussionStatus(fixture, '2026-09-30'), null, 'the next day is not posted before its boundary');
  assert.equal(fixture.sent.length, 1);
  assert.equal(scheduler.armed().delay, 60_000, 'the boundary timer is set for exactly the next Taipei 00:00');
  assert.equal(scheduler.intervals.length, 1);
  assert.equal(scheduler.intervals[0].delay, discussionService.SCHEDULER_INTERVAL_MS, 'the watchdog runs every minute');

  await scheduler.fireBoundaryAt(DISCUSSION_START);

  assert.equal(await discussionStatus(fixture, '2026-09-29'), 'settled', 'the day that ended is settled by the boundary tick');
  assert.equal(await discussionStatus(fixture, '2026-09-30'), 'published', 'a tick exactly at the window start is on time');
  assert.equal(fixture.sent.length, 2, 'one topic for each day');
  assert.equal(scheduler.armed().delay, 24 * HOUR, 'the next boundary is the next Taipei 00:00');
});

test('the riddle scheduler posts at Taipei 10:00 and settles at 21:30', async () => {
  const fixture = createFixture('boundary-riddle');
  await enableRiddle(fixture);
  // 09:59 in Taipei: the restart tick finds the day not open yet.
  const scheduler = await startRiddle(fixture, RIDDLE_START - 60_000);

  assert.equal(await riddleStatus(fixture, '2026-09-30'), null);
  assert.equal(fixture.sent.length, 0);
  assert.equal(scheduler.armed().delay, 60_000, 'the boundary timer is set for exactly 10:00');

  await scheduler.fireBoundaryAt(RIDDLE_START);

  assert.equal(await riddleStatus(fixture, '2026-09-30'), 'published', 'a tick exactly at 10:00 is on time');
  assert.equal(fixture.sent.length, 1);
  assert.equal(fixture.threadSent.length, 0, 'no answer before 21:30');
  assert.equal(scheduler.armed().delay, RIDDLE_END - RIDDLE_START, 'the next boundary is 21:30');

  await scheduler.fireBoundaryAt(RIDDLE_END);

  assert.equal(await riddleStatus(fixture, '2026-09-30'), 'settled', 'the 21:30 boundary tick settles the riddle');
  assert.equal(fixture.threadSent.length, 1, 'the answer is posted once');
  assert.equal(fixture.sent.length, 1, 'nothing else is posted to the parent channel');
  assert.equal(scheduler.armed().delay, 2.5 * HOUR, 'the next boundary is Taipei 00:00');
});

// ---- what a restart does ---------------------------------------------------------------------------------------------

test('a restart posts the riddle between 10:00 and 21:30 (late after the 2-minute grace), records it missed from 21:30, and waits before 10:00', async () => {
  const cases = [
    // [label, restart time, status of the day, posts]
    ['09:59:59.999, before the window', RIDDLE_START - 1, null, 0],
    ['10:00:00.000, the window opens', RIDDLE_START, 'published', 1],
    ['10:02:00.000, the end of the grace', RIDDLE_START + GRACE_MS, 'published', 1],
    ['10:02:00.001, just past the grace', RIDDLE_START + GRACE_MS + 1, 'published_late', 1],
    ['15:00, inside the window',Date.parse('2026-09-30T07:00:00.000Z'), 'published_late', 1],
    // Not the very last millisecond: the time the post itself takes counts against the window, as the fence intends.
    ['21:29:55, the last seconds of the window', RIDDLE_END - 5000, 'published_late', 1],
    ['21:30:00.000, the window is closed', RIDDLE_END, 'missed', 0],
    ['23:00, long after the window', Date.parse('2026-09-30T15:00:00.000Z'), 'missed', 0],
  ];
  for (const [label, restartMs, expectedStatus, expectedPosts] of cases) {
    await freshDatabase();
    const fixture = createFixture('restart-riddle');
    await enableRiddle(fixture);
    const scheduler = await startRiddle(fixture, restartMs);

    assert.equal(await riddleStatus(fixture, '2026-09-30'), expectedStatus, `restart at ${label}`);
    assert.equal(fixture.sent.length, expectedPosts, `restart at ${label}: posts`);
    assert.equal(fixture.threadSent.length, 0, `restart at ${label}: no answer is posted by a catch-up`);
    riddleService.stopDailyRiddleScheduler(scheduler.options);
  }
});

test('a restart posts the discussion topic at any time of the day, once, late after the 2-minute grace', async () => {
  const cases = [
    ['00:00:00.001, just after midnight', DISCUSSION_START + 1, 'published'],
    ['00:02:00.000, the end of the grace', DISCUSSION_START + GRACE_MS, 'published'],
    ['00:02:00.001, just past the grace', DISCUSSION_START + GRACE_MS + 1, 'published_late'],
    ['12:00', Date.parse('2026-09-30T04:00:00.000Z'), 'published_late'],
    // Not the very last millisecond: the time the post itself takes counts against the window, as the fence intends.
    ['23:59:55, the last seconds of the day', DISCUSSION_START + 24 * HOUR - 5000, 'published_late'],
  ];
  for (const [label, restartMs, expectedStatus] of cases) {
    await freshDatabase();
    const fixture = createFixture('restart-discussion');
    await enableDiscussion(fixture);
    const scheduler = await startDiscussion(fixture, restartMs);

    assert.equal(await discussionStatus(fixture, '2026-09-30'), expectedStatus, `restart at ${label}`);
    assert.equal(fixture.sent.length, 1, `restart at ${label}: posts`);

    // The watchdog tick that follows must not post it again.
    scheduler.intervals[0].callback();
    await scheduler.idle();
    assert.equal(fixture.sent.length, 1, `restart at ${label}: the watchdog does not post again`);
    assert.equal(await discussionStatus(fixture, '2026-09-30'), expectedStatus, `restart at ${label}: status is unchanged`);
    discussionService.stopDailyDiscussionScheduler(scheduler.options);
  }
});

// ---- the grace window: a real timer is never exactly on the boundary --------------------------------------------------
//
// The boundary timer and the 60-second watchdog run a little after the exact start of the window. A post made within
// 2 minutes (120000 ms) after the start is recorded as "published"; only a later one is "published_late", which members
// read as 「已發布（比預定時間晚），進行中」. These tests pin that rule (it was "exactly on the start" before).

const LATE_OFFSETS = [0, 1, 5, 20, 500, 59_900, GRACE_MS, GRACE_MS + 1];
const EXPECTED_BY_OFFSET = {
  0: 'published',
  1: 'published',
  5: 'published',
  20: 'published',
  500: 'published',
  59_900: 'published',
  [GRACE_MS]: 'published',
  [GRACE_MS + 1]: 'published_late',
};

test('the grace window: a riddle posted by the boundary timer up to 2 minutes after 10:00 is published', async () => {
  const outcomes = {};
  for (const lateMs of LATE_OFFSETS) {
    await freshDatabase();
    const fixture = createFixture('late-riddle');
    await enableRiddle(fixture);
    const scheduler = await startRiddle(fixture, RIDDLE_START - 60_000);
    await scheduler.fireBoundaryAt(RIDDLE_START + lateMs);
    outcomes[lateMs] = await riddleStatus(fixture, '2026-09-30');
    assert.equal(fixture.sent.length, 1, `${lateMs} ms late: posted once`);
    riddleService.stopDailyRiddleScheduler(scheduler.options);
  }
  assert.deepEqual(outcomes, EXPECTED_BY_OFFSET);
});

test('the grace window: a discussion topic posted by the boundary timer up to 2 minutes after 00:00 is published', async () => {
  const outcomes = {};
  for (const lateMs of LATE_OFFSETS) {
    await freshDatabase();
    const fixture = createFixture('late-discussion');
    await enableDiscussion(fixture);
    const scheduler = await startDiscussion(fixture, DISCUSSION_START - 60_000);
    await scheduler.fireBoundaryAt(DISCUSSION_START + lateMs);
    outcomes[lateMs] = await discussionStatus(fixture, '2026-09-30');
    assert.equal(fixture.sent.length, 2, `${lateMs} ms late: one topic for each day`);
    discussionService.stopDailyDiscussionScheduler(scheduler.options);
  }
  assert.deepEqual(outcomes, EXPECTED_BY_OFFSET);
});

test('a timer that fires 1 ms early posts nothing and is re-armed for the missing millisecond', async () => {
  const fixture = createFixture('early-discussion');
  await enableDiscussion(fixture);
  const scheduler = await startDiscussion(fixture, DISCUSSION_START - 60_000);
  assert.equal(await discussionStatus(fixture, '2026-09-29'), 'published_late');

  await scheduler.fireBoundaryAt(DISCUSSION_START - 1);
  assert.equal(await discussionStatus(fixture, '2026-09-30'), null, 'an early tick does not post the next day');
  assert.equal(scheduler.armed().delay, 1, 'the scheduler asks for the missing millisecond');

  await scheduler.fireBoundaryAt(DISCUSSION_START);
  assert.equal(await discussionStatus(fixture, '2026-09-30'), 'published');
});
