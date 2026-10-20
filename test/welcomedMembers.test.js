'use strict';

// A member is welcomed once per server: the record of who was welcomed (src/systems/community/
// welcomedMembers.js), the file under it (src/platform/retainedJsonFile.js), and the join event that
// uses it (src/events/guildMemberAdd.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');
const {
  WELCOMED_MEMBERS_LIMITS,
  WELCOMED_MEMBERS_MAX_GUILDS,
  createWelcomedMembers,
  flushWelcomedMembers,
  getWelcomedMembers,
  setWelcomedMembersForTests,
} = require('../src/systems/community/welcomedMembers');
const logger = require('../src/utils/logger');

const GUILD_A = '10000000000000101';
const GUILD_B = '10000000000000102';
const MEMBER = '10000000000000201';
const BOT_MEMBER = '10000000000000202';

function snowflake(index, prefix = '3') {
  return `${prefix}${String(index).padStart(16, '0')}`;
}

function tempFile(t, name = 'welcomedMembers.json') {
  const root = makeRealTempDir('xiaoji-welcomed-members-');
  t.after(() => removeRealTempDir(root));
  return path.join(root, name);
}

// A timer the test fires itself, so that "written a moment later" is something it can see.
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
    all: scheduled,
  };
}

function capturingLogger() {
  const lines = [];
  return { lines, warn: (line) => lines.push(String(line)), info: (line) => lines.push(String(line)), error() {} };
}

function ticking(start = 1_700_000_000_000, step = 1_000) {
  let value = start - step;
  return () => { value += step; return value; };
}

function create(t, options = {}) {
  const timers = manualTimers();
  const log = capturingLogger();
  const filePath = options.filePath || tempFile(t);
  const store = createWelcomedMembers({
    filePath, logger: log, now: ticking(), setTimer: timers.setTimer, clearTimer: timers.clearTimer, ...options,
  });
  return { store, timers, log, filePath };
}

function welcome(store, guildId, memberId) {
  const reservation = store.reserve(guildId, memberId);
  assert.equal(reservation.proceed, true, `${guildId}/${memberId} should be welcomed`);
  reservation.commit();
}

function readDocument(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('a member is welcomed once in a server, and every server counts on its own', (t) => {
  const { store } = create(t);
  const first = store.reserve(GUILD_A, MEMBER);
  assert.deepEqual([first.proceed, first.status], [true, 'reserved']);
  first.commit();
  for (let join = 0; join < 3; join += 1) {
    const again = store.reserve(GUILD_A, MEMBER);
    assert.deepEqual([again.proceed, again.status], [false, 'welcomed']);
  }
  const elsewhere = store.reserve(GUILD_B, MEMBER);
  assert.deepEqual([elsewhere.proceed, elsewhere.status], [true, 'reserved']);
  elsewhere.commit();
  assert.equal(store.has(GUILD_A, MEMBER), true);
  assert.equal(store.has(GUILD_B, MEMBER), true);
  assert.equal(store.has(GUILD_A, BOT_MEMBER), false);
});

test('a reservation is given back when the welcome was not accepted, so the next join is welcomed', (t) => {
  const { store, timers } = create(t);
  store.reserve(GUILD_A, MEMBER).release();
  assert.equal(store.has(GUILD_A, MEMBER), false);
  assert.equal(timers.active().length, 0, 'nothing is written for a release');
  const next = store.reserve(GUILD_A, MEMBER);
  assert.equal(next.proceed, true);
  next.release();
  next.commit();
  assert.equal(store.has(GUILD_A, MEMBER), false, 'a settled reservation cannot be settled again');
  assert.deepEqual(store.stats(), { guilds: 0, total: 0, reserved: 0, pendingWrite: false });
});

test('a join of a member who is being handled is not welcomed again, and the first one decides', (t) => {
  const { store } = create(t);
  const first = store.reserve(GUILD_A, MEMBER);
  const second = store.reserve(GUILD_A, MEMBER);
  assert.deepEqual([second.proceed, second.status], [false, 'pending']);
  // The same member in another server is a different reservation.
  assert.equal(store.reserve(GUILD_B, MEMBER).proceed, true);
  first.release();
  assert.equal(store.reserve(GUILD_A, MEMBER).proceed, true);
});

test('an ID that cannot be remembered is handled as before and never recorded', (t) => {
  const { store, timers } = create(t);
  for (const [guildId, memberId] of [['guild', MEMBER], [GUILD_A, 'member'], [undefined, MEMBER], [GUILD_A, null],
    [GUILD_A, 42]]) {
    const reservation = store.reserve(guildId, memberId);
    assert.deepEqual([reservation.proceed, reservation.status], [true, 'untracked']);
    reservation.commit();
  }
  assert.equal(store.stats().total, 0);
  assert.equal(timers.active().length, 0);
});

test('what was welcomed is remembered after a restart, and written once for many joins', (t) => {
  const renames = [];
  const filesystem = {
    ...fs,
    renameSync(from, to) { renames.push([path.basename(from), path.basename(to)]); return fs.renameSync(from, to); },
  };
  const { store, timers, filePath } = create(t, { filesystem });
  for (let index = 0; index < 50; index += 1) welcome(store, GUILD_A, snowflake(index));
  welcome(store, GUILD_B, MEMBER);
  // Nothing is on disk yet, and one timer (that does not keep the process alive) will write it all.
  assert.equal(fs.existsSync(filePath), false);
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].unrefCalled, true);
  assert.equal(timers.active()[0].delayMs, 2_000);
  assert.equal(store.stats().pendingWrite, true);
  timers.fire();
  assert.deepEqual(renames, [['welcomedMembers.json.tmp', 'welcomedMembers.json']]);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  const document = readDocument(filePath);
  assert.equal(document.schema, 1);
  assert.equal(document.guilds[GUILD_A].length, 50);
  assert.deepEqual(document.guilds[GUILD_B].map(([memberId]) => memberId), [MEMBER]);
  assert.equal(store.stats().pendingWrite, false);

  // A new process: a new store reads the same file.
  const restarted = create(t, { filePath }).store;
  assert.equal(restarted.has(GUILD_B, MEMBER), true);
  assert.deepEqual(restarted.reserve(GUILD_A, snowflake(7)).status, 'welcomed');
  assert.equal(restarted.reserve(GUILD_A, snowflake(51)).status, 'reserved');
  assert.equal(restarted.stats().total, 51);
});

test('flush writes what is waiting at once (the shutdown), and the waiting timer does nothing more', (t) => {
  const { store, timers, filePath } = create(t);
  welcome(store, GUILD_A, MEMBER);
  assert.equal(store.flush(), true);
  assert.equal(timers.active().length, 0);
  assert.deepEqual(readDocument(filePath).guilds[GUILD_A].map(([memberId]) => memberId), [MEMBER]);
  // Nothing pending: flushing again writes nothing and still reports success.
  fs.rmSync(filePath);
  assert.equal(store.flush(), true);
  assert.equal(fs.existsSync(filePath), false);
});

test('the shared registry is made on first use and flushed through the module function', (t) => {
  const { store, filePath } = create(t);
  setWelcomedMembersForTests(store);
  t.after(() => setWelcomedMembersForTests(null));
  assert.equal(getWelcomedMembers(), store);
  welcome(getWelcomedMembers(), GUILD_A, MEMBER);
  assert.equal(flushWelcomedMembers(), true);
  assert.equal(readDocument(filePath).guilds[GUILD_A].length, 1);
  setWelcomedMembersForTests(null);
  // With no registry made, there is nothing to flush.
  assert.equal(flushWelcomedMembers(), true);
});

test('caps: the oldest member of a full server goes first, and so does the oldest of everyone when the total is full', (t) => {
  assert.deepEqual({ ...WELCOMED_MEMBERS_LIMITS }, { maxPerGuild: 20_000, maxTotal: 50_000 });
  const { store } = create(t, { limits: { maxPerGuild: 3, maxTotal: 5 } });
  for (let index = 1; index <= 4; index += 1) welcome(store, GUILD_A, snowflake(index));
  // The first one was forgotten, so it may be welcomed once more; the other three are remembered.
  assert.equal(store.has(GUILD_A, snowflake(1)), false);
  assert.deepEqual([2, 3, 4].map((index) => store.has(GUILD_A, snowflake(index))), [true, true, true]);
  assert.deepEqual(store.stats(), { guilds: 1, total: 3, reserved: 0, pendingWrite: true });
  // Two more in another server fill the total (5); the third makes the oldest of all go.
  welcome(store, GUILD_B, snowflake(10));
  welcome(store, GUILD_B, snowflake(11));
  assert.equal(store.stats().total, 5);
  welcome(store, GUILD_B, snowflake(12));
  assert.equal(store.stats().total, 5);
  assert.equal(store.has(GUILD_A, snowflake(2)), false, 'the oldest remembered member of all');
  assert.equal(store.has(GUILD_A, snowflake(3)), true);
  assert.equal(store.has(GUILD_B, snowflake(12)), true);
  assert.equal(store.reserve(GUILD_A, snowflake(2)).status, 'reserved');
});

test('the record never holds more servers than a file of this module may, so a restart still reads what it wrote', (t) => {
  assert.equal(WELCOMED_MEMBERS_MAX_GUILDS, 1_000);
  const { store, filePath } = create(t);
  // The first server has five members and the others one each: the 1,001st server takes the first one's place with all of
  // its members, then the 1,002nd takes the second's, and so on.
  for (let member = 0; member < 5; member += 1) welcome(store, snowflake(0, '4'), snowflake(member));
  for (let index = 1; index < 1_200; index += 1) welcome(store, snowflake(index, '4'), MEMBER);
  assert.deepEqual(store.stats(), { guilds: 1_000, total: 1_000, reserved: 0, pendingWrite: true });
  assert.equal(store.has(snowflake(0, '4'), snowflake(0)), false, 'the oldest server with its members');
  assert.equal(store.has(snowflake(199, '4'), MEMBER), false);
  assert.equal(store.has(snowflake(200, '4'), MEMBER), true);
  assert.equal(store.has(snowflake(1_199, '4'), MEMBER), true);
  assert.equal(store.flush(), true);
  assert.equal(Object.keys(readDocument(filePath).guilds).length, 1_000);

  // The file is read back: not taken for a file that this module did not write, not put aside.
  const restarted = create(t, { filePath });
  assert.equal(restarted.store.stats().guilds, 1_000);
  assert.equal(restarted.store.has(snowflake(1_199, '4'), MEMBER), true);
  assert.equal(restarted.store.has(snowflake(199, '4'), MEMBER), false);
  assert.deepEqual(restarted.log.lines, []);
  assert.equal(fs.existsSync(`${filePath}.corrupt`), false);
  // A server that is remembered already takes no place, and a member of it is welcomed once.
  assert.equal(restarted.store.reserve(snowflake(500, '4'), MEMBER).status, 'welcomed');
  assert.equal(restarted.store.stats().guilds, 1_000);
});

test('the oldest member of all is the one remembered first, however many others of a full server came and went since', (t) => {
  const { store } = create(t, { limits: { maxPerGuild: 3, maxTotal: 4 } });
  welcome(store, GUILD_A, snowflake(1));
  // A full server forgets its own oldest member for each new one; the oldest of all stays where it was.
  for (let index = 0; index < 5_000; index += 1) welcome(store, GUILD_B, snowflake(100 + index));
  assert.deepEqual(store.stats(), { guilds: 2, total: 4, reserved: 0, pendingWrite: true });
  assert.equal(store.has(GUILD_A, snowflake(1)), true);
  assert.deepEqual([4_997, 4_998, 4_999].map((index) => store.has(GUILD_B, snowflake(100 + index))), [true, true, true]);
  assert.equal(store.has(GUILD_B, snowflake(100 + 4_996)), false);
  // The total is full: a member of a third server makes the oldest of all go, the one remembered first.
  welcome(store, '10000000000000103', snowflake(9_999));
  assert.equal(store.has(GUILD_A, snowflake(1)), false);
  assert.equal(store.has(GUILD_B, snowflake(100 + 4_997)), true);
  assert.deepEqual(store.stats(), { guilds: 2, total: 4, reserved: 0, pendingWrite: true });
});

test('a file that holds more than the caps keeps the newest members', (t) => {
  const filePath = tempFile(t);
  fs.writeFileSync(filePath, JSON.stringify({
    schema: 1,
    guilds: {
      [GUILD_A]: [[snowflake(1), 500], [snowflake(2), 100], [snowflake(3), 300], [snowflake(4), 400]],
    },
  }));
  const { store } = create(t, { filePath, limits: { maxPerGuild: 2, maxTotal: 10 } });
  assert.deepEqual([1, 2, 3, 4].map((index) => store.has(GUILD_A, snowflake(index))), [true, false, false, true]);
});

test('a file that is damaged, or is not the record, starts empty with one fixed-code line and is kept as .corrupt', (t) => {
  const damaged = ['not json {', '[]', 'null', JSON.stringify({ schema: 2, guilds: {} }),
    JSON.stringify({ schema: 1, guilds: [] }), 'x'.repeat(64)];
  for (const content of damaged) {
    const filePath = tempFile(t);
    fs.writeFileSync(filePath, content);
    const { store, log } = create(t, { filePath });
    assert.equal(store.has(GUILD_A, MEMBER), false, content);
    assert.deepEqual(log.lines, ['[RETAINED_DATA] code=WELCOMED_MEMBERS_FILE_INVALID kept=corrupt'], content);
    // The damaged file was put aside, whole, before anything could replace it.
    assert.equal(fs.readFileSync(`${filePath}.corrupt`, 'utf8'), content);
    assert.equal(fs.existsSync(filePath), false);
    // It works from empty, and what it writes next is the new file.
    welcome(store, GUILD_A, MEMBER);
    assert.equal(store.flush(), true);
    assert.equal(readDocument(filePath).guilds[GUILD_A].length, 1);
    assert.equal(fs.readFileSync(`${filePath}.corrupt`, 'utf8'), content);
  }
  // Only the latest damaged file is kept.
  const filePath = tempFile(t);
  fs.writeFileSync(filePath, 'first damage');
  create(t, { filePath }).store.has(GUILD_A, MEMBER);
  fs.writeFileSync(filePath, 'second damage');
  create(t, { filePath }).store.has(GUILD_A, MEMBER);
  assert.equal(fs.readFileSync(`${filePath}.corrupt`, 'utf8'), 'second damage');
  // An entry that does not fit is dropped; the others are kept.
  const partly = tempFile(t);
  fs.writeFileSync(partly, JSON.stringify({
    schema: 1,
    guilds: { [GUILD_A]: [[MEMBER, 5], ['x', 6], [BOT_MEMBER, -1], 'junk', [snowflake(1), 'later']], oops: [[MEMBER, 1]] },
  }));
  const { store, log } = create(t, { filePath: partly });
  assert.equal(store.has(GUILD_A, MEMBER), true);
  assert.equal(store.stats().total, 1);
  assert.deepEqual(log.lines, []);
  assert.equal(fs.existsSync(`${partly}.corrupt`), false);
});

test('a file with more servers or members than a file of this module can hold is not read, and is kept', (t) => {
  const tooManyGuilds = {};
  for (let index = 0; index < 1_001; index += 1) tooManyGuilds[snowflake(index, '4')] = [[MEMBER, 1]];
  const tooManyMembers = { [GUILD_A]: Array.from({ length: 11 }, (_, index) => [snowflake(index), index + 1]) };
  for (const [document, limits] of [[tooManyGuilds, {}], [tooManyMembers, { maxPerGuild: 5, maxTotal: 5 }]]) {
    const filePath = tempFile(t);
    const content = JSON.stringify({ schema: 1, guilds: document });
    fs.writeFileSync(filePath, content);
    const { store, log } = create(t, { filePath, limits });
    assert.equal(store.stats().total, 0);
    assert.deepEqual(log.lines, ['[RETAINED_DATA] code=WELCOMED_MEMBERS_FILE_INVALID kept=corrupt']);
    assert.equal(fs.readFileSync(`${filePath}.corrupt`, 'utf8'), content);
  }
  // Up to twice the total cap is still read (and the caps keep the newest).
  const filePath = tempFile(t);
  fs.writeFileSync(filePath, JSON.stringify({
    schema: 1, guilds: { [GUILD_A]: Array.from({ length: 10 }, (_, index) => [snowflake(index), index + 1]) },
  }));
  const { store, log } = create(t, { filePath, limits: { maxPerGuild: 5, maxTotal: 5 } });
  assert.deepEqual([store.stats().total, log.lines.length], [5, 0]);
  assert.equal(store.has(GUILD_A, snowflake(9)), true);
  assert.equal(store.has(GUILD_A, snowflake(0)), false);
});

test('a file that is too large, a folder in its place, or one that cannot be read starts empty', (t) => {
  const large = tempFile(t);
  fs.writeFileSync(large, JSON.stringify({ schema: 1, guilds: {} }));
  const tooLarge = create(t, { filePath: large, maxBytes: 4 });
  assert.equal(tooLarge.store.stats().total, 0);
  assert.deepEqual(tooLarge.log.lines, ['[RETAINED_DATA] code=WELCOMED_MEMBERS_FILE_INVALID kept=corrupt']);
  assert.equal(fs.existsSync(`${large}.corrupt`), true);

  const folder = tempFile(t);
  fs.mkdirSync(folder);
  const inPlace = create(t, { filePath: folder });
  assert.equal(inPlace.store.has(GUILD_A, MEMBER), false);
  assert.deepEqual(inPlace.log.lines, ['[RETAINED_DATA] code=WELCOMED_MEMBERS_FILE_INVALID']);
  // A folder is never replaced by the write, nor put aside.
  welcome(inPlace.store, GUILD_A, MEMBER);
  assert.equal(inPlace.store.flush(), false);
  assert.equal(fs.statSync(folder).isDirectory(), true);
  assert.equal(fs.existsSync(`${folder}.corrupt`), false);

  const unreadable = tempFile(t);
  const pauses = [];
  fs.writeFileSync(unreadable, JSON.stringify({ schema: 1, guilds: {} }));
  const refusing = create(t, {
    filePath: unreadable,
    pause: (ms) => pauses.push(ms),
    filesystem: { ...fs, readFileSync() { throw Object.assign(new Error('denied'), { code: 'EACCES' }); } },
  });
  assert.equal(refusing.store.has(GUILD_A, MEMBER), false);
  assert.deepEqual(refusing.log.lines, ['[RETAINED_DATA] code=WELCOMED_MEMBERS_FILE_UNREADABLE cause=EACCES']);
  // It was tried three more times, waiting a little longer each time.
  assert.deepEqual(pauses, [25, 50, 100]);
});

// A file that is busy for a moment (a scanner, a backup program) must not be taken for an empty one:
// the next write would replace the whole history with one member.
function filesystemBusy(busyReads) {
  const state = { busyReads, reads: 0 };
  return {
    state,
    filesystem: {
      ...fs,
      readFileSync(...args) {
        state.reads += 1;
        if (state.busyReads === Infinity || state.reads <= state.busyReads) {
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        return fs.readFileSync(...args);
      },
    },
  };
}

function history(filePath, count) {
  fs.writeFileSync(filePath, JSON.stringify({
    schema: 1, guilds: { [GUILD_A]: Array.from({ length: count }, (_, index) => [snowflake(index), 1_000 + index]) },
  }));
}

test('a read that fails for a moment is retried, and the history is not taken for an empty file', (t) => {
  const filePath = tempFile(t);
  history(filePath, 1_000);
  const pauses = [];
  const { state, filesystem } = filesystemBusy(2);
  const { store, log } = create(t, { filePath, filesystem, pause: (ms) => pauses.push(ms) });
  assert.equal(store.stats().total, 1_000);
  assert.equal(store.has(GUILD_A, snowflake(999)), true);
  assert.deepEqual([state.reads, pauses, log.lines], [3, [25, 50], []]);
  welcome(store, GUILD_A, MEMBER);
  assert.equal(store.flush(), true);
  assert.equal(readDocument(filePath).guilds[GUILD_A].length, 1_001);
});

test('a file that stays unreadable is not overwritten; it is read again before the write and merged', (t) => {
  const filePath = tempFile(t);
  history(filePath, 1_000);
  const before = fs.readFileSync(filePath, 'utf8');
  const { state, filesystem } = filesystemBusy(Infinity);
  const { store, log, timers } = create(t, { filePath, filesystem, pause: () => {} });
  // Memory starts empty for now; the join that follows is welcomed (the history cannot be asked).
  assert.equal(store.reserve(GUILD_A, snowflake(5)).status, 'reserved');
  welcome(store, GUILD_A, MEMBER);
  assert.equal(store.flush(), false, 'nothing could be written');
  assert.equal(fs.readFileSync(filePath, 'utf8'), before, 'the history on disk is untouched');
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  assert.equal(store.stats().pendingWrite, true);
  assert.deepEqual(log.lines, [
    '[RETAINED_DATA] code=WELCOMED_MEMBERS_FILE_UNREADABLE cause=EBUSY',
    '[RETAINED_DATA] code=WELCOMED_MEMBERS_WRITE_DEFERRED',
  ]);
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].delayMs, 30_000);
  // It keeps failing: still untouched.
  timers.fire();
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);

  // The file can be read again: the history and what was learned meanwhile are written together.
  state.busyReads = 0;
  state.reads = 0;
  timers.fire();
  assert.equal(store.stats().pendingWrite, false);
  const merged = readDocument(filePath).guilds[GUILD_A].map(([memberId]) => memberId);
  assert.equal(merged.length, 1_001);
  assert.equal(merged.at(-1), MEMBER, 'the member of the meantime is the newest');
  assert.equal(merged.includes(snowflake(0)), true);
  assert.equal(store.has(GUILD_A, snowflake(999)), true);
});

test('a member who is in the unreadable file and was welcomed meanwhile is kept once, with the earlier time', (t) => {
  const filePath = tempFile(t);
  const later = 9_000_000_000_000;
  // MEMBER was welcomed long before this process ran; snowflake(5) at a time after the clock of this test.
  fs.writeFileSync(filePath, JSON.stringify({
    schema: 1, guilds: { [GUILD_A]: [[MEMBER, 1_000], [snowflake(5), later]] },
  }));
  const { state, filesystem } = filesystemBusy(Infinity);
  const { store, timers } = create(t, { filePath, filesystem, pause: () => {} });
  welcome(store, GUILD_A, MEMBER);
  welcome(store, GUILD_A, snowflake(5));
  assert.equal(store.flush(), false);
  state.busyReads = 0;
  state.reads = 0;
  timers.fire();
  const written = readDocument(filePath).guilds[GUILD_A];
  assert.equal(written.length, 2, 'each member once');
  const times = Object.fromEntries(written);
  assert.equal(times[MEMBER], 1_000, 'the file had the earlier time');
  assert.ok(times[snowflake(5)] >= 1_700_000_000_000 && times[snowflake(5)] < later, 'the process had the earlier time');
  // They are written oldest first.
  assert.deepEqual(written.map(([memberId]) => memberId), [MEMBER, snowflake(5)]);
});

test('a write that was blocked goes ahead when the file turns out to be gone or damaged', (t) => {
  for (const [label, after] of [['gone', (filePath) => fs.rmSync(filePath)],
    ['damaged', (filePath) => fs.writeFileSync(filePath, 'not json')]]) {
    const filePath = tempFile(t);
    history(filePath, 3);
    const { state, filesystem } = filesystemBusy(Infinity);
    const { store, timers } = create(t, { filePath, filesystem, pause: () => {} });
    welcome(store, GUILD_A, MEMBER);
    assert.equal(store.flush(), false, label);
    after(filePath);
    state.busyReads = 0;
    state.reads = 0;
    timers.fire();
    assert.deepEqual(readDocument(filePath).guilds[GUILD_A].map(([memberId]) => memberId), [MEMBER], label);
  }
});

test('a merge that throws leaves the file as it is, with a code of its own, and is tried again at the next write', (t) => {
  const { createRetainedJsonFile } = require('../src/platform/retainedJsonFile');
  const filePath = tempFile(t);
  fs.writeFileSync(filePath, JSON.stringify({ schema: 1, guilds: {} }));
  const before = fs.readFileSync(filePath, 'utf8');
  const { state, filesystem } = filesystemBusy(Infinity);
  const timers = manualTimers();
  const log = capturingLogger();
  const file = createRetainedJsonFile({
    name: 'SAMPLE', resolvePath: () => filePath, logger: log, filesystem, pause: () => {},
    setTimer: timers.setTimer, clearTimer: timers.clearTimer,
  });
  let failing = true;
  let merges = 0;
  const loaded = file.load((value) => value, { merge() { merges += 1; if (failing) throw new Error('synthetic merge failure'); } });
  assert.equal(loaded.state, 'unreadable');
  file.markDirty(() => ({ learned: 'meanwhile' }));
  // The file can be read now, but what was learned cannot be merged into it: nothing is written.
  state.busyReads = 0;
  state.reads = 0;
  assert.equal(file.flush(), false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(file.blocked, true);
  assert.deepEqual(log.lines, [
    '[RETAINED_DATA] code=SAMPLE_FILE_UNREADABLE cause=EBUSY',
    '[RETAINED_DATA] code=SAMPLE_FILE_MERGE_FAILED',
    '[RETAINED_DATA] code=SAMPLE_WRITE_DEFERRED',
  ]);
  assert.equal(timers.active().length, 1);
  assert.equal(timers.active()[0].delayMs, 30_000);
  // The next write merges again, and goes ahead once the merge works.
  failing = false;
  timers.fire();
  assert.equal(merges, 2);
  assert.equal(file.blocked, false);
  assert.deepEqual(readDocument(filePath), { learned: 'meanwhile' });
});

test('a write that stops short is finished or fails, and a half-written file never replaces the good one', (t) => {
  const filePath = tempFile(t);
  history(filePath, 3);
  const good = fs.readFileSync(filePath, 'utf8');

  // Each write call takes a few bytes only: the rest is written by the next calls.
  const dribbling = create(t, {
    filePath,
    filesystem: {
      ...fs,
      writeSync(descriptor, buffer, offset, length) { return fs.writeSync(descriptor, buffer, offset, Math.min(length, 7)); },
    },
  });
  welcome(dribbling.store, GUILD_A, MEMBER);
  assert.equal(dribbling.store.flush(), true);
  assert.equal(readDocument(filePath).guilds[GUILD_A].length, 4);

  // A write that takes nothing is a failure; the earlier file stays and no temporary file is left.
  const before = fs.readFileSync(filePath, 'utf8');
  assert.notEqual(before, good);
  const stalled = create(t, {
    filePath,
    filesystem: { ...fs, writeSync() { return 0; } },
  });
  welcome(stalled.store, GUILD_A, snowflake(77));
  assert.equal(stalled.store.flush(), false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
  assert.deepEqual(stalled.log.lines, ['[RETAINED_DATA] code=WELCOMED_MEMBERS_WRITE_FAILED cause=RETAINED_JSON_SHORT_WRITE']);
  assert.equal(stalled.store.stats().pendingWrite, true);

  // A write that says it took everything, and left less in the file, is caught by the size check.
  const lying = create(t, {
    filePath,
    filesystem: {
      ...fs,
      writeSync(descriptor, buffer, offset, length) {
        fs.writeSync(descriptor, buffer, offset, Math.max(1, length - 10));
        return length;
      },
    },
  });
  welcome(lying.store, GUILD_A, snowflake(78));
  assert.equal(lying.store.flush(), false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), before);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false);
});

test('a data folder that cannot be resolved is a store that starts empty and writes nothing, never an error', (t) => {
  const timers = manualTimers();
  const log = capturingLogger();
  // The default resolver (retainedDataFile) refuses a test-control run that has no absolute data root.
  const saved = { mode: process.env.XIAOJI_RUNTIME_MODE, root: process.env.XIAOJI_TEST_DATA_ROOT };
  process.env.XIAOJI_RUNTIME_MODE = 'test-control';
  delete process.env.XIAOJI_TEST_DATA_ROOT;
  try {
    const store = createWelcomedMembers({
      now: ticking(), logger: log, setTimer: timers.setTimer, clearTimer: timers.clearTimer,
    });
    welcome(store, GUILD_A, MEMBER);
    assert.equal(store.has(GUILD_A, MEMBER), true);
    assert.equal(store.flush(), false);
    assert.deepEqual(log.lines, [
      '[RETAINED_DATA] code=WELCOMED_MEMBERS_FILE_UNREADABLE cause=UNEXPECTED_ERROR',
      '[RETAINED_DATA] code=WELCOMED_MEMBERS_WRITE_DEFERRED',
    ]);
  } finally {
    for (const [name, value] of [['XIAOJI_RUNTIME_MODE', saved.mode], ['XIAOJI_TEST_DATA_ROOT', saved.root]]) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test('a write that fails is kept pending and tried again later', (t) => {
  const filePath = tempFile(t);
  let failures = 2;
  const filesystem = {
    ...fs,
    renameSync(from, to) {
      if (failures > 0) {
        failures -= 1;
        throw Object.assign(new Error('disk'), { code: 'EIO' });
      }
      return fs.renameSync(from, to);
    },
  };
  const failing = create(t, { filePath, filesystem });
  welcome(failing.store, GUILD_A, MEMBER);
  assert.equal(failing.store.flush(), false);
  assert.equal(failing.store.has(GUILD_A, MEMBER), true, 'memory still holds it');
  assert.equal(failing.store.stats().pendingWrite, true);
  assert.deepEqual(failing.log.lines, ['[RETAINED_DATA] code=WELCOMED_MEMBERS_WRITE_FAILED cause=EIO']);
  assert.equal(failing.timers.active().length, 1);
  assert.equal(failing.timers.active()[0].delayMs, 30_000);
  assert.equal(fs.existsSync(`${filePath}.tmp`), false, 'no temporary file is left behind');
  // The retry fails once more (the log line is held to one a minute), then succeeds.
  failing.timers.fire();
  assert.equal(failing.store.stats().pendingWrite, true);
  failing.timers.fire();
  assert.equal(failing.store.stats().pendingWrite, false);
  assert.equal(readDocument(filePath).guilds[GUILD_A].length, 1);
});

test('a rename that Windows refuses for a moment is retried before the write counts as failed', (t) => {
  const pauses = [];
  let refusals = 2;
  const filesystem = {
    ...fs,
    renameSync(from, to) {
      if (refusals > 0) {
        refusals -= 1;
        throw Object.assign(new Error('busy'), { code: 'EPERM' });
      }
      return fs.renameSync(from, to);
    },
  };
  const { store, filePath, log } = create(t, { filesystem, platform: 'win32', pause: (ms) => pauses.push(ms) });
  welcome(store, GUILD_A, MEMBER);
  assert.equal(store.flush(), true);
  assert.deepEqual(pauses, [20, 40]);
  assert.deepEqual(log.lines, []);
  assert.equal(readDocument(filePath).guilds[GUILD_A].length, 1);

  // On another platform the same refusal is a failure at once.
  refusals = 1;
  const other = create(t, { filesystem, platform: 'linux', pause: () => assert.fail('no pause') });
  welcome(other.store, GUILD_A, MEMBER);
  assert.equal(other.store.flush(), false);
});

test('log lines carry a fixed code and a cause code only: no path, ID or content', (t) => {
  const filePath = tempFile(t);
  fs.writeFileSync(filePath, `{"schema":1,"guilds":{"${GUILD_A}":[["${MEMBER}",1]]}`);
  const { store, log } = create(t, {
    filePath,
    filesystem: { ...fs, renameSync() { throw Object.assign(new Error(`cannot write ${filePath}`), { code: 'EIO' }); } },
  });
  welcome(store, GUILD_A, MEMBER);
  store.flush();
  assert.ok(log.lines.length >= 2);
  for (const line of log.lines) {
    assert.match(line, /^\[RETAINED_DATA\] code=WELCOMED_MEMBERS_[A-Z_]+( cause=[A-Z_]+)?$/u);
    assert.equal(line.includes(path.basename(filePath)), false);
    assert.equal(line.includes(MEMBER), false);
  }
});

test('invalid limits are refused', () => {
  for (const limits of [{ maxPerGuild: 0 }, { maxTotal: -1 }, { maxPerGuild: 1.5 }, { maxTotal: '5' }]) {
    assert.throws(() => createWelcomedMembers({ limits }), TypeError, JSON.stringify(limits));
  }
});

// ---- the join event ------------------------------------------------------------------------------

const EVENT_PATH = require.resolve('../src/events/guildMemberAdd');

// Loads the join event with the welcome handler replaced, and gives the callback its `execute`. The
// modules are put back afterwards.
async function withJoinEvent({ welcomeHandler }, callback) {
  const replaced = [
    ['../src/services/welcomeService', { handleGuildMemberWelcome: welcomeHandler }],
  ].map(([request, replacement]) => {
    const resolved = require.resolve(request);
    const previous = require.cache[resolved] || null;
    const entry = new Module(resolved, module);
    entry.filename = resolved;
    entry.loaded = true;
    entry.exports = replacement;
    require.cache[resolved] = entry;
    return { resolved, previous };
  });
  const previousEvent = require.cache[EVENT_PATH];
  delete require.cache[EVENT_PATH];
  try {
    return await callback(require(EVENT_PATH));
  } finally {
    delete require.cache[EVENT_PATH];
    if (previousEvent) require.cache[EVENT_PATH] = previousEvent;
    for (const { resolved, previous } of replaced) {
      if (previous) require.cache[resolved] = previous;
      else delete require.cache[resolved];
    }
  }
}

function joinedMember({ guildId = GUILD_A, id = MEMBER, bot = false, hooks = [], hookFailure = null } = {}) {
  return {
    id,
    guild: { id: guildId },
    user: { bot },
    joinedTimestamp: 1_700_000_000_000,
    client: {
      extensionHost: {
        async runHook(name, payload) {
          hooks.push({ name, memberId: payload.member.id });
          if (hookFailure) throw hookFailure;
        },
      },
    },
  };
}

async function quietly(callback) {
  const original = { info: logger.info, warn: logger.warn, error: logger.error };
  logger.info = () => {};
  logger.warn = () => {};
  logger.error = () => {};
  try {
    return await callback();
  } finally {
    Object.assign(logger, original);
  }
}

function useRegistry(t, options = {}) {
  const state = create(t, options);
  setWelcomedMembersForTests(state.store);
  t.after(() => setWelcomedMembersForTests(null));
  return state;
}

test('join, leave and join again welcomes once; the private hook still runs for the second join', async (t) => {
  useRegistry(t);
  const calls = [];
  const hooks = [];
  await quietly(() => withJoinEvent({
    welcomeHandler: async (member) => { calls.push(member.id); return true; },
  }, async (event) => {
    const member = joinedMember({ hooks });
    await event.execute(member);
    // Leaves and joins again (a new join time, the same ID).
    await event.execute({ ...member, joinedTimestamp: member.joinedTimestamp + 86_400_000 });
    await event.execute(member);
  }));
  assert.deepEqual(calls, [MEMBER]);
  assert.deepEqual(hooks.map((entry) => entry.name), ['guildMemberAdd', 'guildMemberAdd', 'guildMemberAdd']);
});

test('after a restart the same member is still not welcomed again', async (t) => {
  const first = useRegistry(t);
  const calls = [];
  const handler = async (member) => { calls.push(`${member.guild.id}/${member.id}`); return true; };
  await quietly(() => withJoinEvent({ welcomeHandler: handler }, async (event) => {
    await event.execute(joinedMember());
  }));
  assert.equal(first.store.flush(), true);

  // A new process: a new registry on the same file.
  const second = create(t, { filePath: first.filePath });
  setWelcomedMembersForTests(second.store);
  await quietly(() => withJoinEvent({ welcomeHandler: handler }, async (event) => {
    await event.execute(joinedMember());
    await event.execute(joinedMember({ guildId: GUILD_B }));
  }));
  assert.deepEqual(calls, [`${GUILD_A}/${MEMBER}`, `${GUILD_B}/${MEMBER}`]);
});

test('a welcome that was not accepted is given back, so the next join is welcomed', async (t) => {
  const { store } = useRegistry(t);
  const answers = [false, 'queued-late', true];
  const calls = [];
  await quietly(() => withJoinEvent({
    welcomeHandler: async (member) => { calls.push(member.id); return answers.shift(); },
  }, async (event) => {
    await event.execute(joinedMember());
    assert.equal(store.has(GUILD_A, MEMBER), false);
    // Only a real true keeps it: anything else (even a truthy value) is not "accepted".
    await event.execute(joinedMember());
    assert.equal(store.has(GUILD_A, MEMBER), false);
    await event.execute(joinedMember());
    assert.equal(store.has(GUILD_A, MEMBER), true);
    await event.execute(joinedMember());
  }));
  assert.equal(calls.length, 3);
});

test('a welcome that throws gives the reservation back and does not stop the event', async (t) => {
  const { store } = useRegistry(t);
  let attempts = 0;
  await quietly(() => withJoinEvent({
    welcomeHandler: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('synthetic failure');
      return true;
    },
  }, async (event) => {
    await event.execute(joinedMember());
    assert.equal(store.has(GUILD_A, MEMBER), false);
    await event.execute(joinedMember());
  }));
  assert.equal(attempts, 2);
  assert.equal(store.has(GUILD_A, MEMBER), true);
});

test('two joins of one member at once are handled once; if that one fails, the next join is welcomed', async (t) => {
  const { store } = useRegistry(t);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const calls = [];
  await quietly(() => withJoinEvent({
    welcomeHandler: async (member) => {
      calls.push(member.id);
      await gate;
      return false;
    },
  }, async (event) => {
    const first = event.execute(joinedMember());
    // Let the first reach its welcome (past the private hook) before the second starts.
    await new Promise((resolve) => setImmediate(resolve));
    const second = event.execute(joinedMember());
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(store.stats().reserved, 1);
    release();
    await Promise.all([first, second]);
    assert.equal(store.stats().reserved, 0);
    assert.equal(store.has(GUILD_A, MEMBER), false);
    await event.execute(joinedMember());
  }));
  assert.equal(calls.length, 2, 'the second of two simultaneous joins did not ask for a welcome');
});

test('a bot is not welcomed and not remembered; a join that names no guild gets nothing', async (t) => {
  const { store } = useRegistry(t);
  const calls = [];
  const hooks = [];
  await quietly(() => withJoinEvent({
    welcomeHandler: async (member) => { calls.push(member.user.bot); return false; },
  }, async (event) => {
    await event.execute(joinedMember({ id: BOT_MEMBER, bot: true, hooks }));
    await event.execute(joinedMember({ id: BOT_MEMBER, bot: true, hooks }));
  }));
  // The handler still sees a bot (and ignores it, as before), but nothing is remembered.
  assert.deepEqual(calls, [true, true]);
  assert.deepEqual(store.stats(), { guilds: 0, total: 0, reserved: 0, pendingWrite: false });

  const refused = [];
  const hooksRefused = [];
  await quietly(() => withJoinEvent({
    welcomeHandler: async (member) => { refused.push(member.id); return true; },
  }, async (event) => {
    await event.execute(joinedMember({ guildId: null, hooks: hooksRefused }));
  }));
  assert.deepEqual([refused, hooksRefused], [[], []]);
  assert.equal(store.has(GUILD_A, MEMBER), false);
});

test('a private hook that fails does not stop the welcome, and a record that fails does not stop it either', async (t) => {
  useRegistry(t);
  const calls = [];
  await quietly(() => withJoinEvent({
    welcomeHandler: async (member) => { calls.push(member.id); return true; },
  }, async (event) => {
    await event.execute(joinedMember({ hookFailure: new Error('synthetic hook failure') }));
  }));
  assert.deepEqual(calls, [MEMBER]);

  // A registry that throws is not a reason to leave the member unwelcomed.
  setWelcomedMembersForTests({ reserve() { throw new Error('synthetic record failure'); } });
  const more = [];
  await quietly(() => withJoinEvent({
    welcomeHandler: async (member) => { more.push(member.id); return true; },
  }, async (event) => {
    await event.execute(joinedMember({ id: snowflake(9) }));
  }));
  assert.deepEqual(more, [snowflake(9)]);
});

test('300 different members are each welcomed once, and a second wave of them is welcomed by no one', async (t) => {
  const { store } = useRegistry(t, { limits: { maxPerGuild: 1_000, maxTotal: 1_000 } });
  const welcomed = [];
  await quietly(() => withJoinEvent({
    welcomeHandler: async (member) => { welcomed.push(member.id); return true; },
  }, async (event) => {
    const wave = () => Promise.all(Array.from({ length: 300 }, (_, index) =>
      event.execute(joinedMember({ id: snowflake(index, '6') }))));
    await wave();
    await wave();
  }));
  assert.equal(welcomed.length, 300);
  assert.equal(new Set(welcomed).size, 300);
  assert.equal(store.stats().total, 300);
});
