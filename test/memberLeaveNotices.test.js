'use strict';

// Someone leaves the owner's server: the Owner is told, at most three times in a fixed 7 x 24 hour
// window per member (src/systems/community/memberLeaveNotices.js), through the member-left event of
// the safety catalogue (src/events/guildMemberRemove.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  Client, ClientUser, Events, GatewayIntentBits, Partials, Status,
} = require('discord.js');
const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');
const {
  MEMBER_LEAVE_NOTICE_LIMITS,
  createMemberLeaveNotices,
  flushMemberLeaveNotices,
  getMemberLeaveNotices,
  setMemberLeaveNoticesForTests,
} = require('../src/systems/community/memberLeaveNotices');
const { SAFETY_EVENT_CODES, emitSafetyEvent, setSafetyEventHandler } = require('../src/platform/safetyEventCatalog');
const {
  captureDiscordEventContext,
  getHostOperationContext,
  runWithHostOperationContext,
} = require('../src/platform/hostOperationContext');
const {
  OWNER_EVENT_ACTION,
  buildFixedNotice,
  buildOperation,
} = require('../src/systems/safety/ownerSafetyNotifier');
const { getOwnerGuildId } = require('../src/utils/env');
const guildMemberRemove = require('../src/events/guildMemberRemove');

const MEMBER_LEFT = SAFETY_EVENT_CODES.OWNER_EVENT_MEMBER_LEFT;
const BOT_ID = '10000000000000001';
const OWNER_ID = '10000000000000002';
const OWNER_GUILD = '10000000000000301';
const OTHER_GUILD = '10000000000000302';
const MEMBER = '10000000000000401';
const DAY = 24 * 60 * 60_000;
const WINDOW = 7 * DAY;
const START = 1_700_000_000_000;

function snowflake(index, prefix = '5') {
  return `${prefix}${String(index).padStart(16, '0')}`;
}

function tempFile(t) {
  const root = makeRealTempDir('xiaoji-leave-notices-');
  t.after(() => removeRealTempDir(root));
  return path.join(root, 'leaveNotices.json');
}

function manualTimers() {
  const scheduled = [];
  return {
    setTimer(callback, delayMs) {
      const timer = { callback, delayMs, cleared: false, unref() { timer.unrefCalled = true; } };
      scheduled.push(timer);
      return timer;
    },
    clearTimer(timer) { timer.cleared = true; },
    active: () => scheduled.filter((timer) => !timer.cleared && !timer.fired),
    fire() {
      for (const timer of scheduled.filter((entry) => !entry.cleared && !entry.fired)) {
        timer.fired = true;
        timer.callback();
      }
    },
  };
}

// A set of windows with a clock, a notifier and a file the test controls.
function create(t, options = {}) {
  const clock = options.clock || { value: START };
  const timers = manualTimers();
  const lines = [];
  const emitted = [];
  const filePath = options.filePath || tempFile(t);
  const notices = createMemberLeaveNotices({
    filePath,
    now: () => clock.value,
    logger: { warn: (line) => lines.push(String(line)), info: (line) => lines.push(String(line)) },
    emit: (code, context) => { emitted.push({ code, context }); },
    ownerGuildId: () => OWNER_GUILD,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    ...options.overrides,
  });
  return { notices, clock, timers, lines, emitted, filePath };
}

function leaver({ guildId = OWNER_GUILD, id = MEMBER, bot = false, joined = START - 30 * DAY, nickname = '暱稱',
  username = 'leaver', globalName = '顯示名稱', memberCount = 41, guildName = '擁有者伺服器' } = {}) {
  return {
    id,
    joinedTimestamp: joined,
    displayName: nickname ?? globalName ?? username,
    guild: { id: guildId, name: guildName, memberCount },
    user: { id, bot, username, globalName },
  };
}

test('the first three leaves in a window are each handed to the notifier with the member\'s facts, the fourth is not', (t) => {
  const { notices, clock, emitted, lines } = create(t);
  const outcomes = [];
  for (let leave = 1; leave <= 4; leave += 1) {
    clock.value = START + (leave * 60 * 60_000);
    outcomes.push(notices.report(leaver()));
  }
  assert.deepEqual(outcomes.map(({ outcome, count }) => [outcome, count]),
    [['notified', 1], ['notified', 2], ['notified', 3], ['capped', 3]]);
  assert.equal(emitted.length, 3);
  assert.deepEqual(emitted[0], {
    code: MEMBER_LEFT,
    context: {
      at: START + 60 * 60_000,
      actorId: MEMBER,
      guildId: OWNER_GUILD,
      guildName: '擁有者伺服器',
      notice: {
        subjectId: MEMBER,
        subjectName: '暱稱',
        subjectUsername: 'leaver',
        joinedAtMs: START - 30 * DAY,
        leftAtMs: START + 60 * 60_000,
        memberCount: 41,
      },
    },
  });
  assert.deepEqual(emitted.map((entry) => entry.context.notice.leftAtMs),
    [1, 2, 3].map((leave) => START + (leave * 60 * 60_000)));
  assert.deepEqual(lines, ['[MEMBER_LEAVE] code=MEMBER_LEAVE_NOTICE_CAPPED skipped=0']);
  // Another member has a window of their own.
  assert.equal(notices.report(leaver({ id: snowflake(1) })).outcome, 'notified');
  assert.equal(emitted.length, 4);
});

test('the window is fixed: it lasts exactly 7 x 24 hours from the first leave, then the next leave opens a new one', (t) => {
  assert.equal(MEMBER_LEAVE_NOTICE_LIMITS.windowMs, WINDOW);
  assert.equal(MEMBER_LEAVE_NOTICE_LIMITS.maxNotices, 3);
  const { notices, clock, emitted } = create(t);
  for (const offset of [0, 1, 2]) {
    clock.value = START + offset;
    assert.equal(notices.report(leaver()).outcome, 'notified');
  }
  // One millisecond before the window ends it is still the same window: used up.
  clock.value = START + WINDOW - 1;
  assert.deepEqual(notices.report(leaver()), { outcome: 'capped', reason: 'window-used-up', count: 3 });
  assert.equal(emitted.length, 3);
  // Exactly 7 x 24 hours after the first leave a new window opens, and its first notice goes out.
  clock.value = START + WINDOW;
  assert.deepEqual(notices.report(leaver()), { outcome: 'notified', count: 1 });
  assert.equal(emitted.length, 4);
  assert.equal(emitted[3].context.notice.leftAtMs, START + WINDOW);
});

test('the window is not rolling: leaves inside it do not move its end', (t) => {
  const { notices, clock, emitted } = create(t);
  clock.value = START;
  notices.report(leaver());
  clock.value = START + WINDOW - 2 * 60_000;
  assert.deepEqual(notices.report(leaver()), { outcome: 'notified', count: 2 });
  // A rolling window would still be open (the last leave was 2 minutes before this one).
  clock.value = START + WINDOW + 60_000;
  assert.deepEqual(notices.report(leaver()), { outcome: 'notified', count: 1 });
  assert.equal(emitted.length, 3);
  // And it is not a calendar week: the new window starts at this leave, and lasts from it.
  clock.value = START + WINDOW + 60_000 + WINDOW - 1;
  assert.equal(notices.report(leaver()).count, 2);
  clock.value = START + WINDOW + 60_000 + WINDOW;
  assert.equal(notices.report(leaver()).count, 1);
});

test('a clock set back opens a new window instead of holding the counts of a window that has not begun', (t) => {
  const { notices, clock } = create(t);
  clock.value = START;
  for (let leave = 0; leave < 3; leave += 1) notices.report(leaver());
  assert.equal(notices.report(leaver()).outcome, 'capped');
  clock.value = START - DAY;
  assert.deepEqual(notices.report(leaver()), { outcome: 'notified', count: 1 });
});

test('only the owner\'s server counts, and not without a valid owner server ID', (t) => {
  const { notices, emitted } = create(t);
  assert.deepEqual(notices.report(leaver({ guildId: OTHER_GUILD })),
    { outcome: 'ignored', reason: 'not-owner-guild', count: 0 });
  assert.deepEqual(notices.report({ id: MEMBER, user: { id: MEMBER } }),
    { outcome: 'ignored', reason: 'not-owner-guild', count: 0 });
  assert.deepEqual(notices.report(null), { outcome: 'ignored', reason: 'not-owner-guild', count: 0 });
  assert.equal(emitted.length, 0);
  assert.equal(notices.stats().tracked, 0, 'a leave elsewhere opens no window');

  for (const value of [null, undefined, '', 'abc', '12345', 42, `${OWNER_GUILD}0000000`]) {
    const unset = create(t, { overrides: { ownerGuildId: () => value } });
    assert.equal(unset.notices.report(leaver()).outcome, 'ignored', String(value));
    assert.equal(unset.emitted.length, 0, String(value));
  }
  const throwing = create(t, { overrides: { ownerGuildId: () => { throw new Error('synthetic'); } } });
  assert.equal(throwing.notices.report(leaver()).outcome, 'ignored');
  assert.equal(throwing.emitted.length, 0);
});

test('a bot account is never reported, and an ID that is not a Discord ID opens no window', (t) => {
  const { notices, emitted } = create(t);
  assert.deepEqual(notices.report(leaver({ bot: true })), { outcome: 'ignored', reason: 'bot', count: 0 });
  for (const id of [undefined, null, 'member', 12345, '']) {
    assert.deepEqual(notices.report({ ...leaver(), id, user: { bot: false } }),
      { outcome: 'ignored', reason: 'invalid-id', count: 0 });
  }
  assert.equal(emitted.length, 0);
  assert.equal(notices.stats().tracked, 0);
});

test('a partial member (no join time, no names) is reported with the word for unknown and does not throw', (t) => {
  const { notices, emitted } = create(t);
  // What discord.js hands over for a member that was not cached: only the user, and the guild.
  const partial = { id: MEMBER, partial: true, joinedTimestamp: null, guild: { id: OWNER_GUILD }, user: { id: MEMBER } };
  assert.equal(notices.report(partial).outcome, 'notified');
  assert.deepEqual(emitted[0].context.notice, {
    subjectId: MEMBER, subjectName: '未知', subjectUsername: '未知', joinedAtMs: null, leftAtMs: START, memberCount: null,
  });
  assert.equal(emitted[0].context.guildName, '未知');

  // Getters that throw, and values of the wrong kind, are unknown too.
  const odd = {
    id: snowflake(2),
    get joinedTimestamp() { throw new Error('synthetic'); },
    get displayName() { throw new Error('synthetic'); },
    guild: { id: OWNER_GUILD, name: 42, memberCount: '41' },
    user: { id: snowflake(2), username: '   ', globalName: { toString: () => 'object' } },
  };
  assert.equal(notices.report(odd).outcome, 'notified');
  assert.deepEqual(emitted[1].context.notice, {
    subjectId: snowflake(2), subjectName: '未知', subjectUsername: '未知', joinedAtMs: null, leftAtMs: START, memberCount: null,
  });

  // The account name stands in for a display name that is missing.
  assert.equal(notices.report({ ...partial, id: snowflake(3), user: { id: snowflake(3), username: 'only-account' } }).outcome,
    'notified');
  assert.equal(emitted[2].context.notice.subjectName, 'only-account');
  assert.equal(emitted[2].context.notice.subjectUsername, 'only-account');
});

test('the notice text for a partial member says unknown for each missing value', (t) => {
  const { notices } = create(t, { overrides: { emit: emitSafetyEvent } });
  let built = null;
  const restore = setSafetyEventHandler((value) => { built = value; });
  try {
    notices.report({ id: MEMBER, joinedTimestamp: null, guild: { id: OWNER_GUILD }, user: { id: MEMBER } });
  } finally {
    restore();
  }
  assert.equal(built.code, MEMBER_LEFT);
  const text = buildFixedNotice(built.code, { guildId: built.guildId, guildName: built.guildName, notice: built.notice });
  assert.equal(text,
    `小吉成員退出通知。固定代碼：OWNER_EVENT_MEMBER_LEFT；伺服器 ID：${OWNER_GUILD}；成員 ID：${MEMBER}；` +
    `退出時間：<t:${START / 1_000}:F>；加入時間：未知；成員數：未知；伺服器：「未知」；成員名稱：「未知」；成員帳號：「未知」`);
});

test('windows survive a restart: the count and the start are read back, expired windows are dropped', (t) => {
  const first = create(t);
  first.clock.value = START;
  first.notices.report(leaver());
  first.clock.value = START + DAY;
  first.notices.report(leaver());
  first.clock.value = START + 2 * DAY;
  first.notices.report(leaver({ id: snowflake(1) }));
  assert.equal(first.notices.flush(), true);
  const document = JSON.parse(fs.readFileSync(first.filePath, 'utf8'));
  assert.deepEqual(document, {
    schema: 1,
    windows: [[OWNER_GUILD, MEMBER, START, 2], [OWNER_GUILD, snowflake(1), START + 2 * DAY, 1]],
  });

  // A new process, 3 days after the first leave: the third leave is the last of the window, the fourth is not.
  const second = create(t, { filePath: first.filePath, clock: { value: START + 3 * DAY } });
  assert.equal(second.notices.stats().tracked, 2);
  assert.deepEqual(second.notices.report(leaver()), { outcome: 'notified', count: 3 });
  assert.deepEqual(second.notices.report(leaver()).outcome, 'capped');
  assert.equal(second.emitted.length, 1);

  // Another, after the first window has ended (7 days and a moment): that window is gone, the other is not.
  const third = create(t, { filePath: first.filePath, clock: { value: START + WINDOW } });
  assert.equal(third.notices.stats().tracked, 1);
  assert.deepEqual(third.notices.report(leaver()), { outcome: 'notified', count: 1 });
  assert.deepEqual(third.notices.report(leaver({ id: snowflake(1) })), { outcome: 'notified', count: 2 });
});

test('a window that has run out is not written back, and one that starts in the future (a clock set back) is', (t) => {
  const { notices, clock, filePath } = create(t);
  const written = () => JSON.parse(fs.readFileSync(filePath, 'utf8')).windows.map(([, memberId, startMs, count]) => [memberId, startMs, count]);
  clock.value = START;
  notices.report(leaver({ id: snowflake(1) }));
  clock.value = START + 2 * DAY;
  notices.report(leaver({ id: snowflake(2) }));
  clock.value = START + 3 * DAY;
  notices.report(leaver({ id: snowflake(3) }));
  // The first window ended 30 seconds ago. A leave inside an open window opens no new one, so nothing sweeps the old window out
  // of memory: it is the write that leaves it out.
  clock.value = START + WINDOW + 30_000;
  assert.deepEqual(notices.report(leaver({ id: snowflake(2) })), { outcome: 'notified', count: 2 });
  assert.equal(notices.stats().tracked, 3);
  assert.equal(notices.flush(), true);
  assert.deepEqual(written(), [[snowflake(2), START + 2 * DAY, 2], [snowflake(3), START + 3 * DAY, 1]]);

  // After a restart the file does not hold it either, and the others are read back.
  const restarted = create(t, { filePath, clock: { value: START + WINDOW + 60_000 } });
  assert.equal(restarted.notices.stats().tracked, 2);

  // A clock set back: the windows that begin after the clock have not run out, and are written as they are.
  clock.value = START + 2 * DAY + 1_000;
  assert.deepEqual(notices.report(leaver({ id: snowflake(2) })), { outcome: 'notified', count: 3 });
  assert.equal(notices.flush(), true);
  assert.deepEqual(written().map(([memberId]) => memberId), [snowflake(1), snowflake(2), snowflake(3)]);
});

test('writes are merged, go through a temporary file, and are flushed at the stop', (t) => {
  const renames = [];
  const filesystem = {
    ...fs,
    renameSync(from, to) { renames.push([path.basename(from), path.basename(to)]); return fs.renameSync(from, to); },
  };
  const { notices, timers, filePath, clock } = create(t, { overrides: { filesystem } });
  for (let index = 0; index < 60; index += 1) {
    clock.value = START + index;
    notices.report(leaver({ id: snowflake(index) }));
  }
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].unrefCalled, true);
  timers.fire();
  assert.deepEqual(renames, [['leaveNotices.json.tmp', 'leaveNotices.json']]);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).windows.length, 60);

  // A leave that is capped changes nothing, so nothing is scheduled; one that is counted is flushed at the stop.
  clock.value = START + 100;
  for (let leave = 0; leave < 3; leave += 1) notices.report(leaver({ id: snowflake(1) }));
  assert.equal(timers.active().length, 1);
  assert.equal(notices.flush(), true);
  assert.equal(timers.active().length, 0);
  assert.equal(renames.length, 2);
  notices.report(leaver({ id: snowflake(1) }));
  assert.equal(timers.active().length, 0, 'a capped leave schedules no write');
});

test('the shared set is made on first use and flushed through the module function', (t) => {
  const { notices, filePath } = create(t);
  setMemberLeaveNoticesForTests(notices);
  t.after(() => setMemberLeaveNoticesForTests(null));
  assert.equal(getMemberLeaveNotices(), notices);
  notices.report(leaver());
  assert.equal(flushMemberLeaveNotices(), true);
  assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).windows.length, 1);
  setMemberLeaveNoticesForTests(null);
  assert.equal(flushMemberLeaveNotices(), true);
});

test('at most maxTracked windows are kept: expired ones go first, then the one that began earliest', (t) => {
  const { notices, clock, emitted } = create(t, { overrides: { limits: { maxTracked: 3 } } });
  // A opens first and uses its three notices up, then B and C open.
  clock.value = START;
  for (let leave = 0; leave < 3; leave += 1) notices.report(leaver({ id: snowflake(1) }));
  clock.value = START + 1_000;
  notices.report(leaver({ id: snowflake(2) }));
  clock.value = START + 2_000;
  notices.report(leaver({ id: snowflake(3) }));
  assert.equal(notices.stats().tracked, 3);
  assert.equal(notices.report(leaver({ id: snowflake(1) })).outcome, 'capped');
  // D arrives with nothing expired: the window that began earliest (A's) is forgotten.
  clock.value = START + 3_000;
  notices.report(leaver({ id: snowflake(4) }));
  assert.equal(notices.stats().tracked, 3);
  assert.deepEqual(notices.report(leaver({ id: snowflake(1) })), { outcome: 'notified', count: 1 });
  // B was forgotten for A in turn (A's new window is the newest), so B opens afresh as well.
  assert.deepEqual(notices.report(leaver({ id: snowflake(2) })).count, 1);
  assert.equal(emitted.length, 8);

  // With an expired window among them, that one goes and the live ones stay.
  const second = create(t, { overrides: { limits: { maxTracked: 2 } } });
  second.clock.value = START;
  second.notices.report(leaver({ id: snowflake(1) }));
  second.clock.value = START + DAY;
  second.notices.report(leaver({ id: snowflake(2) }));
  second.clock.value = START + WINDOW + 1;
  second.notices.report(leaver({ id: snowflake(3) }));
  assert.equal(second.notices.stats().tracked, 2);
  assert.deepEqual(second.notices.report(leaver({ id: snowflake(2) })), { outcome: 'notified', count: 2 });
});

test('a file with more windows than maxTracked keeps the newest', (t) => {
  const filePath = tempFile(t);
  fs.writeFileSync(filePath, JSON.stringify({
    schema: 1,
    windows: [
      [OWNER_GUILD, snowflake(1), START + 300, 1], [OWNER_GUILD, snowflake(2), START + 100, 1],
      [OWNER_GUILD, snowflake(3), START + 200, 1], [OWNER_GUILD, snowflake(4), START - WINDOW - 1, 1],
    ],
  }));
  const { notices } = create(t, { filePath, overrides: { limits: { maxTracked: 2 } }, clock: { value: START + 400 } });
  assert.equal(notices.stats().tracked, 2);
  assert.equal(notices.report(leaver({ id: snowflake(1) })).count, 2, 'the newest window was kept');
  assert.equal(notices.report(leaver({ id: snowflake(3) })).count, 2, 'and the one before it');
  assert.equal(notices.report(leaver({ id: snowflake(2) })).count, 1, 'the oldest was forgotten');
});

test('a file that is damaged or not the record starts empty with one fixed-code line, kept as .corrupt', (t) => {
  for (const content of ['not json {', '[]', JSON.stringify({ schema: 9, windows: [] }),
    JSON.stringify({ schema: 1, windows: {} })]) {
    const filePath = tempFile(t);
    fs.writeFileSync(filePath, content);
    const { notices, lines, emitted } = create(t, { filePath });
    assert.equal(notices.report(leaver()).outcome, 'notified', content);
    assert.deepEqual(lines, ['[RETAINED_DATA] code=MEMBER_LEAVE_NOTICES_FILE_INVALID kept=corrupt'], content);
    assert.equal(fs.readFileSync(`${filePath}.corrupt`, 'utf8'), content);
    assert.equal(emitted.length, 1);
    assert.equal(notices.flush(), true);
    assert.equal(JSON.parse(fs.readFileSync(filePath, 'utf8')).windows.length, 1);
  }
  // Entries that do not fit are dropped one by one (an ID of 16 digits is no Discord ID here).
  const filePath = tempFile(t);
  fs.writeFileSync(filePath, JSON.stringify({
    schema: 1,
    windows: [[OWNER_GUILD, MEMBER, START, 2], [OWNER_GUILD, 'x', START, 1], [OWNER_GUILD, MEMBER, START, 0], 'junk',
      [OWNER_GUILD, snowflake(1), 'now', 1], [OWNER_GUILD, '1'.repeat(16), START, 1]],
  }));
  const { notices } = create(t, { filePath });
  assert.equal(notices.stats().tracked, 1);
});

test('a file with more than twice maxTracked windows is not read, and is kept', (t) => {
  const filePath = tempFile(t);
  const content = JSON.stringify({
    schema: 1,
    windows: Array.from({ length: 7 }, (_, index) => [OWNER_GUILD, snowflake(index), START, 1]),
  });
  fs.writeFileSync(filePath, content);
  const { notices, lines } = create(t, { filePath, overrides: { limits: { maxTracked: 3 } } });
  assert.equal(notices.stats().tracked, 0);
  assert.deepEqual(lines, ['[RETAINED_DATA] code=MEMBER_LEAVE_NOTICES_FILE_INVALID kept=corrupt']);
  assert.equal(fs.readFileSync(`${filePath}.corrupt`, 'utf8'), content);
  // Twice maxTracked is still read, and the newest windows are kept.
  const sixPath = tempFile(t);
  fs.writeFileSync(sixPath, JSON.stringify({
    schema: 1,
    windows: Array.from({ length: 6 }, (_, index) => [OWNER_GUILD, snowflake(index), START + index, 1]),
  }));
  const six = create(t, { filePath: sixPath, overrides: { limits: { maxTracked: 3 } }, clock: { value: START + 10 } });
  assert.equal(six.notices.stats().tracked, 3);
  assert.equal(six.notices.report(leaver({ id: snowflake(5) })).count, 2);
  assert.equal(six.notices.report(leaver({ id: snowflake(0) })).count, 1);
});

function busyReads(count) {
  const state = { remaining: count, reads: 0 };
  return {
    state,
    filesystem: {
      ...fs,
      readFileSync(...args) {
        state.reads += 1;
        if (state.remaining > 0) {
          if (state.remaining !== Infinity) state.remaining -= 1;
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        return fs.readFileSync(...args);
      },
    },
  };
}

test('windows are not forgotten when the file is busy for a moment, and not overwritten while it cannot be read', (t) => {
  const filePath = tempFile(t);
  const stored = {
    schema: 1,
    windows: [[OWNER_GUILD, MEMBER, START, 2], [OWNER_GUILD, snowflake(1), START + 1_000, 3]],
  };
  fs.writeFileSync(filePath, JSON.stringify(stored));

  // Busy for a moment: read again, and the history is there.
  const brief = busyReads(2);
  const pauses = [];
  const first = create(t, {
    filePath, overrides: { filesystem: brief.filesystem, pause: (ms) => pauses.push(ms) }, clock: { value: START + 2_000 },
  });
  assert.deepEqual(first.notices.report(leaver()), { outcome: 'notified', count: 3 });
  assert.equal(first.notices.report(leaver({ id: snowflake(1) })).outcome, 'capped');
  assert.deepEqual([pauses, first.lines.filter((line) => line.includes('UNREADABLE'))], [[25, 50], []]);

  // Busy for good: the file is left as it is, the windows opened meanwhile wait, and are merged once it
  // can be read: the count of a window that was in the file adds up, and the start is the file's.
  const before = fs.readFileSync(filePath, 'utf8');
  const stuck = busyReads(Infinity);
  const second = create(t, {
    filePath, overrides: { filesystem: stuck.filesystem, pause: () => {} }, clock: { value: START + 3_000 },
  });
  assert.deepEqual(second.notices.report(leaver()), { outcome: 'notified', count: 1 });
  assert.deepEqual(second.notices.report(leaver({ id: snowflake(9) })), { outcome: 'notified', count: 1 });
  assert.equal(second.notices.flush(), false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before, 'nothing replaced the history');
  assert.deepEqual(second.lines.filter((line) => !line.includes('UNREADABLE')),
    ['[RETAINED_DATA] code=MEMBER_LEAVE_NOTICES_WRITE_DEFERRED']);
  stuck.state.remaining = 0;
  assert.equal(second.notices.flush(), true);
  const written = JSON.parse(fs.readFileSync(filePath, 'utf8')).windows;
  assert.deepEqual(written, [
    [OWNER_GUILD, MEMBER, START, 3],
    [OWNER_GUILD, snowflake(1), START + 1_000, 3],
    [OWNER_GUILD, snowflake(9), START + 3_000, 1],
  ]);
  assert.equal(second.notices.report(leaver()).outcome, 'capped');
});

test('the leave is counted before it is handed over, and a notifier that fails neither stops it nor is retried', (t) => {
  const failing = create(t, { overrides: { emit: () => { throw new Error('synthetic notifier failure'); } } });
  assert.deepEqual(failing.notices.report(leaver()), { outcome: 'notified', count: 1 });
  assert.deepEqual(failing.notices.report(leaver()), { outcome: 'notified', count: 2 });
  assert.deepEqual(failing.notices.report(leaver()), { outcome: 'notified', count: 3 });
  assert.equal(failing.notices.report(leaver()).outcome, 'capped');
  assert.deepEqual(failing.lines.filter((line) => line.includes('HANDOVER_FAILED')).length, 3);

  // The catalogue's own handler throwing is swallowed there, and the leave is still counted.
  const restore = setSafetyEventHandler(() => { throw new Error('synthetic handler failure'); });
  try {
    const real = create(t, { overrides: { emit: emitSafetyEvent } });
    assert.equal(real.notices.report(leaver()).outcome, 'notified');
    assert.equal(real.notices.report(leaver()).count, 2);
  } finally {
    restore();
  }
});

test('a notice that was left out is logged once a minute with the number left out since', (t) => {
  const { notices, clock, lines } = create(t);
  for (let leave = 0; leave < 3; leave += 1) notices.report(leaver());
  for (let leave = 0; leave < 5; leave += 1) {
    clock.value += 1_000;
    notices.report(leaver());
  }
  clock.value += 60_000;
  notices.report(leaver());
  assert.deepEqual(lines, [
    '[MEMBER_LEAVE] code=MEMBER_LEAVE_NOTICE_CAPPED skipped=0',
    '[MEMBER_LEAVE] code=MEMBER_LEAVE_NOTICE_CAPPED skipped=4',
  ]);
});

test('invalid limits are refused', () => {
  for (const limits of [{ windowMs: 0 }, { maxNotices: -1 }, { maxTracked: 1.5 }, { logIntervalMs: '60' }]) {
    assert.throws(() => createMemberLeaveNotices({ limits }), TypeError, JSON.stringify(limits));
  }
});

test('getOwnerGuildId is one Discord ID of 16 to 22 digits, and anything else is not set', () => {
  const saved = process.env.XIAOJI_OWNER_GUILD_ID;
  try {
    const read = (value) => {
      if (value === undefined) delete process.env.XIAOJI_OWNER_GUILD_ID;
      else process.env.XIAOJI_OWNER_GUILD_ID = value;
      return getOwnerGuildId();
    };
    assert.equal(read(undefined), null);
    assert.equal(read(''), null);
    assert.equal(read('   '), null);
    assert.equal(read(OWNER_GUILD), OWNER_GUILD);
    assert.equal(read(`  ${OWNER_GUILD} `), OWNER_GUILD);
    assert.equal(read('1'.repeat(16)), '1'.repeat(16));
    assert.equal(read('1'.repeat(22)), '1'.repeat(22));
    for (const bad of ['1'.repeat(15), '1'.repeat(23), 'guild', `${OWNER_GUILD}x`, `${OWNER_GUILD},${OTHER_GUILD}`,
      `<${OWNER_GUILD}>`, '-1000000000000000', '1.000000000000000e17']) {
      assert.equal(read(bad), null, bad);
    }
  } finally {
    if (saved === undefined) delete process.env.XIAOJI_OWNER_GUILD_ID;
    else process.env.XIAOJI_OWNER_GUILD_ID = saved;
  }
});

// ---- the event, with discord.js's own partial member ---------------------------------------------

function offlineClient(partials) {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers], rest: { retries: 0 },
    ...(partials ? { partials } : {}),
  });
  client.user = new ClientUser(client, { id: BOT_ID, username: 'xiaoji', discriminator: '0', bot: true });
  client.guilds._add({
    id: OWNER_GUILD, name: 'Synthetic owner guild', owner_id: OWNER_ID, member_count: 3,
    roles: [{ id: OWNER_GUILD, name: '@everyone', position: 0, permissions: '0' }], channels: [], members: [],
  });
  client.guilds._add({
    id: OTHER_GUILD, name: 'Synthetic other guild', owner_id: OWNER_ID, member_count: 3,
    roles: [{ id: OTHER_GUILD, name: '@everyone', position: 0, permissions: '0' }], channels: [], members: [],
  });
  return client;
}

// The gateway's GUILD_MEMBER_REMOVE, through discord.js's own action: the event it emits (none, for a
// member that is not cached and a client that keeps no partials) is listened to by the caller.
function removeFromGuild(client, guildId, user) {
  client.actions.GuildMemberRemove.handle({ guild_id: guildId, user }, { status: Status.Ready });
}

// The member discord.js hands the listener for that leave (partial when it was not cached).
function memberLeaving(client, guildId, user) {
  let member = null;
  const listener = (value) => { member = value; };
  client.once(Events.GuildMemberRemove, listener);
  removeFromGuild(client, guildId, user);
  client.off(Events.GuildMemberRemove, listener);
  return member;
}

const USER = Object.freeze({ id: MEMBER, username: 'leaver', discriminator: '0', global_name: '顯示名稱', bot: false });

test('with Partials.GuildMember discord.js emits the leave of a member it never cached, and without it nothing', async () => {
  for (const [partials, expected] of [[[Partials.GuildMember], 1], [undefined, 0]]) {
    const client = offlineClient(partials);
    const seen = [];
    client.on(Events.GuildMemberRemove, (member) => seen.push(member));
    removeFromGuild(client, OWNER_GUILD, USER);
    assert.equal(seen.length, expected);
    if (expected) {
      const [member] = seen;
      assert.equal(member.partial, true);
      assert.equal(member.joinedTimestamp, null);
      assert.equal(member.id, MEMBER);
      assert.equal(member.guild.id, OWNER_GUILD);
      assert.equal(member.user.username, 'leaver');
      assert.equal(member.displayName, '顯示名稱');
      // It is not left in the cache.
      assert.equal(client.guilds.cache.get(OWNER_GUILD).members.cache.has(MEMBER), false);
    }
    await client.destroy();
  }
});

const INDEX_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8').replace(/\r\n/gu, '\n');

test('src/index.js keeps GuildMember partials on the client', () => {
  assert.match(INDEX_SOURCE, /^\s+Partials,$/mu, 'Partials is taken from discord.js');
  const client = INDEX_SOURCE.slice(INDEX_SOURCE.indexOf('new Client({'),
    INDEX_SOURCE.indexOf('client.testControlPolicy = testControlPolicy;'));
  assert.match(client, /partials: \[Partials\.GuildMember\],/u);
  assert.match(client, /GatewayIntentBits\.GuildMembers/u);
});

// The stop of src/index.js, as written there, run against recorders: the function itself is taken out of
// the source (from flushMemberRecords to the end of shutdown), so what is tested is the code that runs.
function shutdownFrom(source, dependencies) {
  const start = source.indexOf('function flushMemberRecords()');
  const end = source.indexOf('\n}\n', source.indexOf('async function shutdown(')) + 3;
  assert.ok(start > 0 && end > start);
  return new Function('dependencies', `with (dependencies) { ${source.slice(start, end)}\nreturn shutdown; }`)(dependencies);
}

function stopRecorder({ failing = null } = {}) {
  const events = [];
  const step = (name) => async () => {
    events.push(name);
    if (failing === name) throw new Error(`synthetic failure of ${name}`);
  };
  const processStub = { exitCode: undefined, exit(code) { events.push(`exit:${code}`); } };
  const dependencies = {
    logger: { info() {}, warn(line) { events.push(`warn:${line}`); }, error(line) { events.push(`error:${String(line).split(' ')[1] || line}`); } },
    flushWelcomedMembers() { events.push('flush:welcomed'); },
    flushMemberLeaveNotices() { events.push('flush:leaves'); },
    outageMonitor: { stop() { events.push('outageMonitor.stop'); } },
    protectedEffects: { stop: step('protectedEffects.stop') },
    settleLedgerShutdown() { events.push('settle'); },
    publicSideEffectRuntime: {},
    welcomeSideEffectRuntime: {},
    ownerSafetyNotifier: {},
    coinDatabaseEscalations: {},
    boardRuntime: { stopLifecycle: step('boardRuntime.stopLifecycle') },
    stopReleaseAnnouncementScheduler: step('stopReleaseAnnouncementScheduler'),
    extensionHost: { runHook: step('extensionHost.shutdown') },
    stopGameServer: async () => { events.push('stopGameServer'); },
    stopPublicStatusServer: async () => { events.push('stopPublicStatusServer'); },
    stopStatusSnapshotPublisher() { events.push('stopStatusSnapshotPublisher'); },
    client: { destroy() { events.push('client.destroy'); } },
    testControlPolicy: null,
    testControlRuntimeController: { dispose() { events.push('dispose'); } },
    process: processStub,
  };
  return { events, dependencies, processStub };
}

test('the stop writes both records first and again at the end, so a failing step cannot skip it', async () => {
  // The structure: one helper that flushes both, each in a try of its own, called before the first step and in the last
  // finally.
  assert.match(INDEX_SOURCE, /function flushMemberRecords\(\) \{\n {2}try \{ flushWelcomedMembers\(\); \} catch \{ noteMemberRecordsFlushFailed\(\); \}\n {2}try \{ flushMemberLeaveNotices\(\); \} catch \{ noteMemberRecordsFlushFailed\(\); \}\n\}/u);
  assert.equal(INDEX_SOURCE.split('flushMemberRecords();').length - 1, 2);
  assert.equal(INDEX_SOURCE.split('flushWelcomedMembers()').length - 1, 1, 'called only by the helper');

  const clean = stopRecorder();
  await shutdownFrom(INDEX_SOURCE, clean.dependencies)('SIGTERM');
  const flushes = clean.events.flatMap((event, index) => (event === 'flush:welcomed' ? [index] : []));
  assert.equal(flushes.length, 2);
  assert.ok(flushes[0] < clean.events.indexOf('protectedEffects.stop'));
  assert.ok(flushes[1] > clean.events.indexOf('client.destroy'));
  assert.ok(flushes[1] < clean.events.lastIndexOf('settle'));
  assert.deepEqual(clean.events.filter((event) => event === 'flush:leaves').length, 2);
  assert.equal(clean.events.at(-1), 'exit:undefined');

  // A step that throws (the private shutdown hook, the board lifecycle) is logged and the stop goes on;
  // the late flush still runs, before the last report and the exit, and the stop exits non-zero.
  for (const failing of ['extensionHost.shutdown', 'boardRuntime.stopLifecycle', 'stopReleaseAnnouncementScheduler']) {
    const run = stopRecorder({ failing });
    await shutdownFrom(INDEX_SOURCE, run.dependencies)('SIGTERM');
    const late = run.events.lastIndexOf('flush:welcomed');
    assert.ok(late > run.events.indexOf(failing), failing);
    assert.ok(late < run.events.lastIndexOf('settle'), failing);
    assert.equal(run.events.at(-1), 'exit:1', failing);
    assert.equal(run.events.filter((event) => event === 'flush:leaves').length, 2, failing);
  }
});

test('a record that throws when it is flushed does not skip the other one, the ledger reports or the exit', async () => {
  for (const [throwing, other] of [['flushWelcomedMembers', 'flush:leaves'], ['flushMemberLeaveNotices', 'flush:welcomed']]) {
    const run = stopRecorder();
    run.dependencies[throwing] = () => {
      run.events.push(`threw:${throwing}`);
      throw new Error('synthetic flush failure');
    };
    await shutdownFrom(INDEX_SOURCE, run.dependencies)('SIGTERM');
    // Both flushes are tried twice (before the first step and in the last finally), whichever of them fails.
    assert.equal(run.events.filter((event) => event === `threw:${throwing}`).length, 2, throwing);
    assert.equal(run.events.filter((event) => event === other).length, 2, throwing);
    // The stop goes on: the runtimes are stopped, both ledger reports are made, and the process exits.
    assert.ok(run.events.indexOf('protectedEffects.stop') > run.events.indexOf(`threw:${throwing}`), throwing);
    assert.equal(run.events.filter((event) => event === 'settle').length, 2, throwing);
    assert.equal(run.events.filter((event) => event.startsWith('error:')).length, 0, throwing);
    // Each failed flush leaves one fixed line, a warning, with no path, ID or error text.
    assert.deepEqual(run.events.filter((event) => event.startsWith('warn:')),
      Array(2).fill('warn:[SHUTDOWN] code=MEMBER_RECORDS_FLUSH_FAILED'), throwing);
    assert.equal(run.events.at(-1), 'exit:undefined', throwing);
  }
  // A logger that fails does not keep the stop from going on either.
  const mute = stopRecorder();
  mute.dependencies.flushWelcomedMembers = () => { throw new Error('synthetic flush failure'); };
  mute.dependencies.logger.warn = () => { throw new Error('synthetic logger failure'); };
  await shutdownFrom(INDEX_SOURCE, mute.dependencies)('SIGTERM');
  assert.equal(mute.events.filter((event) => event === 'settle').length, 2);
  assert.equal(mute.events.at(-1), 'exit:undefined');
});

async function runLeave(client, member, { policy = null } = {}) {
  const emitted = [];
  const restore = setSafetyEventHandler((event) => {
    emitted.push({ event, context: getHostOperationContext() });
  });
  try {
    client.testControlPolicy = policy;
    const context = captureDiscordEventContext(Events.GuildMemberRemove, [member], { now: () => START });
    await runWithHostOperationContext(context, () => guildMemberRemove.execute(member));
  } finally {
    restore();
  }
  return emitted;
}

test('the leave event tells the Owner through the catalogue, with a context the notifier accepts', async (t) => {
  const { notices } = create(t, { overrides: { emit: emitSafetyEvent } });
  setMemberLeaveNoticesForTests(notices);
  t.after(() => setMemberLeaveNoticesForTests(null));
  const client = offlineClient([Partials.GuildMember]);
  t.after(() => client.destroy());
  const member = memberLeaving(client, OWNER_GUILD, USER);
  assert.ok(member?.partial);

  const emitted = await runLeave(client, member);
  assert.equal(guildMemberRemove.name, 'guildMemberRemove');
  assert.equal(emitted.length, 1);
  const [{ event, context }] = emitted;
  assert.equal(event.code, MEMBER_LEFT);
  assert.equal(event.category, 'member-leave');
  assert.equal(event.guildId, OWNER_GUILD);
  assert.equal(event.guildName, 'Synthetic owner guild');
  assert.deepEqual({ ...event.notice }, {
    subjectId: MEMBER, subjectName: '顯示名稱', subjectUsername: 'leaver', joinedAtMs: null, leftAtMs: START,
    memberCount: 2, inviterId: null, outageStartedAtMs: null, outageEndedAtMs: null, outageKind: null, alertKind: null,
  });
  // The context the event ran in is the one a leave gets, and the notifier builds its operation from it.
  assert.deepEqual({ ...context }, {
    sourceEventId: `${OWNER_GUILD}.${MEMBER}.${START}`,
    guildId: OWNER_GUILD,
    actorId: BOT_ID,
    hostPurpose: 'discord.guildMemberRemove',
    scope: `guild:${OWNER_GUILD}`,
  });
  const operation = buildOperation(event, context, OWNER_ID);
  assert.ok(operation, 'the notifier takes the event');
  assert.equal(operation.action, OWNER_EVENT_ACTION);
  assert.equal(operation.budgetClass, 'owner-member-leave');
  assert.equal(operation.target, `${OWNER_ID}:member-leave`);
  assert.equal(operation.mergeKey, `owner-leave-v1:${OWNER_GUILD}:${MEMBER}`);
  assert.equal(operation.sourceKey, `discord.guildMemberRemove:guild:${OWNER_GUILD}:actor:${BOT_ID}`);
  assert.equal(operation.sourceTimeMs, START);
  assert.match(operation.payload.content, new RegExp(`^小吉成員退出通知。固定代碼：OWNER_EVENT_MEMBER_LEFT；伺服器 ID：${OWNER_GUILD}；成員 ID：${MEMBER}；`, 'u'));
  assert.deepEqual(operation.payload.allowed_mentions, { parse: [], users: [], roles: [], replied_user: false });
});

test('the leave event reports nothing for another server, a bot, or when the owner server is not set', async (t) => {
  const { notices, emitted: handedOver } = create(t, { overrides: { emit: emitSafetyEvent } });
  setMemberLeaveNoticesForTests(notices);
  t.after(() => setMemberLeaveNoticesForTests(null));
  const client = offlineClient([Partials.GuildMember]);
  t.after(() => client.destroy());
  const elsewhere = memberLeaving(client, OTHER_GUILD, USER);
  const robot = memberLeaving(client, OWNER_GUILD, { ...USER, id: snowflake(7), bot: true });
  assert.deepEqual(await runLeave(client, elsewhere), []);
  assert.deepEqual(await runLeave(client, robot), []);
  assert.equal(handedOver.length, 0);
  assert.equal(notices.stats().tracked, 0);

  // The owner server is read from the environment, and when it is not set nothing is reported.
  const fromEnvironment = create(t, { overrides: { emit: emitSafetyEvent, ownerGuildId: getOwnerGuildId } });
  setMemberLeaveNoticesForTests(fromEnvironment.notices);
  const saved = process.env.XIAOJI_OWNER_GUILD_ID;
  try {
    delete process.env.XIAOJI_OWNER_GUILD_ID;
    const ordinary = memberLeaving(client, OWNER_GUILD, USER);
    assert.deepEqual(await runLeave(client, ordinary), []);
    assert.equal(fromEnvironment.notices.stats().tracked, 0);
    process.env.XIAOJI_OWNER_GUILD_ID = OWNER_GUILD;
    assert.equal((await runLeave(client, ordinary)).length, 1);
    process.env.XIAOJI_OWNER_GUILD_ID = OTHER_GUILD;
    const later = memberLeaving(client, OWNER_GUILD, { ...USER, id: snowflake(9) });
    assert.deepEqual(await runLeave(client, later), []);
  } finally {
    if (saved === undefined) delete process.env.XIAOJI_OWNER_GUILD_ID;
    else process.env.XIAOJI_OWNER_GUILD_ID = saved;
  }
});

test('under test-control the leave event passes the ingress check first and is turned away without the event allowed', async (t) => {
  const { notices } = create(t, { overrides: { emit: emitSafetyEvent } });
  setMemberLeaveNoticesForTests(notices);
  t.after(() => setMemberLeaveNoticesForTests(null));
  const client = offlineClient([Partials.GuildMember]);
  t.after(() => client.destroy());
  const member = memberLeaving(client, OWNER_GUILD, USER);
  const denied = [];
  const policy = (allowed) => ({
    allowsEvent: (name) => allowed.includes(name),
    allowsGuild: () => true,
    allowsChannel: () => true,
    reporter: { deny: (code, operation) => denied.push([code, operation]) },
  });
  assert.deepEqual(await runLeave(client, member, { policy: policy([]) }), []);
  assert.deepEqual(denied, [['TEST_EVENT_DENIED', 'event_ingress']]);
  assert.equal(notices.stats().tracked, 0, 'a denied event opens no window');
  const allowed = await runLeave(client, member, { policy: policy(['guildMemberRemove']) });
  assert.equal(allowed.length, 1);
  assert.deepEqual(denied.length, 1);
});
