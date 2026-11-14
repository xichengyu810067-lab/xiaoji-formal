'use strict';

// The weekly memory report: the host's 168-hour schedule of the weeklyMemoryReport hook, the window it passes, what
// the memory gives for that window (every member, public or not), and what members and the policy are told.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startMemoryReportSchedule } = require('../src/systems/conversation/memoryReportSchedule');
const { MEMORY_REPORT_INTERVAL_MS } = require('../src/platform/memoryReportFile');
const memory = require('../src/systems/conversation/preferenceMemory');
const { CONSENT_REVISION, CONSENT_TEXT } = require('../src/systems/conversation/memoryConsent');

const ALICE = '300000000000000001';
const BOB = '300000000000000002';
const GUILD_A = '400000000000000001';
const GUILD_B = '400000000000000002';
const HOUR_MS = 60 * 60 * 1000;

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimer(fn, ms) {
      const timer = { fn, ms, cleared: false, unref() { this.unrefed = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimer(timer) {
      timer.cleared = true;
    },
    async fireLast() {
      const timer = timers.at(-1);
      await timer.fn();
      // Let the hook and the re-arm settle.
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

test('the report runs 168 hours after the start and every 168 hours after that, with consecutive windows', async () => {
  assert.equal(MEMORY_REPORT_INTERVAL_MS, 168 * HOUR_MS);
  let now = 1_000;
  const calls = [];
  const clock = fakeTimers();
  const schedule = startMemoryReportSchedule({
    runHook: async (name, window) => { calls.push({ name, ...window }); },
    now: () => now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  assert.equal(clock.timers.length, 1);
  assert.equal(clock.timers[0].ms, 168 * HOUR_MS, 'nothing runs at the start: the first report waits a full interval');
  assert.ok(clock.timers[0].unrefed, 'the timer does not keep a shutdown waiting');
  assert.equal(calls.length, 0);

  now += 168 * HOUR_MS;
  await clock.fireLast();
  now += 168 * HOUR_MS;
  await clock.fireLast();
  assert.deepEqual(calls, [
    { name: 'weeklyMemoryReport', since: 1_000, until: 1_000 + 168 * HOUR_MS },
    { name: 'weeklyMemoryReport', since: 1_000 + 168 * HOUR_MS, until: 1_000 + 336 * HOUR_MS },
  ]);
  assert.equal(clock.timers.length, 3);
  schedule.stop();
  assert.ok(clock.timers[2].cleared);
});

test('a failing hook is logged and the next report is still scheduled', async () => {
  const clock = fakeTimers();
  const warnings = [];
  startMemoryReportSchedule({
    runHook: async () => { throw Object.assign(new Error('boom'), { code: 'SYNTHETIC' }); },
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    logger: { warn: (line) => warnings.push(line) },
  });
  await clock.fireLast();
  assert.equal(clock.timers.length, 2);
  assert.match(warnings[0], /MEMORY_REPORT_HOOK_FAILED reason=SYNTHETIC/u);
});

test('the report window holds what every member added, public or private, and nothing outside it', async () => {
  const store = memory.createInMemoryMemoryStore();
  memory.configureMemoryStoreForTests(store);
  try {
    await memory.updateConsent(ALICE, { choice: 'public' });
    await memory.updateConsent(BOB, { choice: 'private' });
    await memory.rememberPreferences({ userId: ALICE, guildId: GUILD_A, entries: [{ category: 'food', preference: '喜歡拉麵' }], now: 50 });
    await memory.rememberPreferences({ userId: ALICE, guildId: GUILD_A, entries: [{ category: 'music', preference: '喜歡爵士樂' }], now: 150 });
    await memory.rememberPreferences({ userId: BOB, guildId: GUILD_B, entries: [{ category: 'game', preference: '喜歡下圍棋' }], now: 160 });
    for (const [id, userId, guildId, role, createdAt] of [
      ['1', BOB, GUILD_B, 'member', 99], ['2', BOB, GUILD_B, 'member', 100], ['2', BOB, GUILD_B, 'xiaoji', 120],
      ['3', ALICE, GUILD_A, 'member', 200],
    ]) {
      await store.addMessage({
        period: '2026-11', day: 1, userId, scope: userId === ALICE ? 'global' : `guild:${guildId}`, guildId,
        channelId: '500000000000000001', messageId: `60000000000000000${id}`, role, authorName: 'name', content: `訊息${id}${role}`,
        createdAt,
      });
    }
    const data = await memory.listMemoryAddedBetween({ since: 100, until: 200 });
    assert.deepEqual(data.preferences.map((row) => [row.userId, row.scope, row.value]), [
      [ALICE, 'global', '喜歡爵士樂'],
      [BOB, `guild:${GUILD_B}`, '喜歡下圍棋'],
    ]);
    assert.deepEqual(data.messages.map((row) => row.content), ['訊息2member', '訊息2xiaoji']);
    assert.equal(data.truncated, false);
    assert.equal((await memory.listMemoryAddedBetween({ since: 100, until: 200, limit: 2 })).truncated, true);
    await assert.rejects(memory.listMemoryAddedBetween({ since: 200, until: 100 }), RangeError);
    memory.configureMemoryStoreForTests(null);
    // With the memory off there is nothing to report.
    if (!memory.isMemoryConfigured()) assert.equal(await memory.listMemoryAddedBetween({ since: 0, until: 1 }), null);
  } finally {
    memory.configureMemoryStoreForTests(null);
  }
});

test('members are told about the weekly report once more, and the policy describes it in the same words everywhere', () => {
  assert.equal(CONSENT_REVISION, 3);
  assert.match(CONSENT_TEXT, /不論你選擇公開或不公開，小吉每 7 天會把這段期間新增的記憶/u);
  assert.match(CONSENT_TEXT, /私訊給開發者本人/u);
  const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
  const documents = [read('website/policies.html'), read('website/siteSupport.js')];
  if (fs.existsSync(path.join(__dirname, '..', 'xiaoji_privacy.md'))) documents.push(read('xiaoji_privacy.md'));
  for (const document of documents) {
    assert.match(document, /每週記憶報告/u);
    assert.match(document, /每 168 小時（7 天）/u);
    assert.match(document, /選擇公開或不公開聊天記憶，(?:你的|其)內容都會列入報告/u);
    assert.match(document, /重新啟動就重新起算/u);
    assert.doesNotMatch(document, /可以查看選擇公開的成員的記憶。/u, 'the old sentence said the developer saw public members only');
  }
});
