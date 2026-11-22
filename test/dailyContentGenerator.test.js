'use strict';

// The daily riddle and discussion topic are written by Claude, one a day shared by every server. A piece that fails
// the checks, or a call that fails, is asked again up to three times; only then is the day's corpus entry used. What
// was decided for a day is written to the retained data folder at once, so a restart and the answer post find it, and
// Claude is asked at most once a day per kind. A fake Claude client and a temporary folder are used.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');
const {
  MAX_GENERATION_ATTEMPTS,
  checkRiddle,
  checkTopic,
  createDailyContentGenerator,
} = require('../src/systems/community/daily/dailyContentGenerator');
const { selectRiddleForDate } = require('../src/systems/community/daily/dailyRiddleCorpus');
const { selectDiscussionForDate, safetyReminder } = require('../src/systems/community/daily/dailyDiscussionCorpus');

const root = makeRealTempDir('xiaoji-daily-content-');
test.after(() => removeRealTempDir(root));

const RIDDLE = Object.freeze({ question: '什麼東西越洗越髒？', answer: '水', aliases: ['洗澡水', '水'], explanation: '用水洗東西，水會越來越髒。' });
const TOPIC = Object.freeze({ topic: '你最近學會的一個生活小技巧是什麼？它帶來了什麼改變？' });

const silentLogger = { info() {}, warn() {}, error() {} };
let fileCounter = 0;

function fakeClient(replies) {
  const calls = [];
  const queue = [...replies];
  return {
    calls,
    messages: {
      create: async (request) => {
        calls.push(request);
        const next = queue.shift();
        if (next instanceof Error) throw next;
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: typeof next === 'string' ? next : JSON.stringify(next) }] };
      },
    },
  };
}

function generator(client, { filePath = path.join(root, `content-${(fileCounter += 1)}.json`) } = {}) {
  return {
    filePath,
    instance: createDailyContentGenerator({
      filePath,
      logger: silentLogger,
      clientFactory: () => client,
      modelFactory: () => 'test-model',
      recordOutcome: (call) => call(),
      flushDelayMs: 0,
    }),
  };
}

test('a good riddle is used, written at once, and found again by its ID after a restart', async () => {
  const client = fakeClient([RIDDLE]);
  const { instance, filePath } = generator(client);
  const riddle = await instance.contentForDate('riddle', '2026-11-20');
  assert.deepEqual({ ...riddle }, {
    id: 'gr20261120', question: RIDDLE.question, canonicalAnswer: '水', acceptedAliases: ['洗澡水'],
    explanation: RIDDLE.explanation, generated: true,
  });
  assert.equal(client.calls.length, 1);
  // Nothing about a member or a server is sent: only the date.
  assert.equal(client.calls[0].messages[0].content, '日期：2026-11-20');
  assert.ok(fs.existsSync(filePath), 'written at once');

  const restarted = generator(fakeClient([]), { filePath }).instance;
  assert.deepEqual({ ...restarted.contentForId('riddle', 'gr20261120') }, { ...riddle });
  assert.deepEqual({ ...(await restarted.contentForDate('riddle', '2026-11-20')) }, { ...riddle });
});

test('every server gets the same piece, and Claude is asked once a day per kind', async () => {
  const client = fakeClient([RIDDLE, TOPIC]);
  const { instance } = generator(client);
  const riddles = await Promise.all([1, 2, 3].map(() => instance.contentForDate('riddle', '2026-11-21')));
  assert.equal(new Set(riddles.map((riddle) => riddle.id)).size, 1);
  const topic = await instance.contentForDate('discussion', '2026-11-21');
  assert.deepEqual({ ...topic }, { id: 'gd20261121', question: TOPIC.topic, safetyReminder, generated: true });
  await instance.contentForDate('discussion', '2026-11-21');
  assert.equal(client.calls.length, 2);
});

test('a rejected piece or a failed call is asked again, and the corpus is used only after three failures', async () => {
  const client = fakeClient([
    new Error('upstream 500'),
    { ...RIDDLE, question: '請看 https://example.com 回答' },
    RIDDLE,
  ]);
  const { instance } = generator(client);
  assert.equal((await instance.contentForDate('riddle', '2026-11-22')).id, 'gr20261122');
  assert.equal(client.calls.length, 3);

  const failing = fakeClient(Array.from({ length: MAX_GENERATION_ATTEMPTS }, () => 'not json'));
  const second = generator(failing).instance;
  const fallback = await second.contentForDate('riddle', '2026-11-23');
  assert.equal(fallback.id, selectRiddleForDate('2026-11-23').id);
  assert.equal(failing.calls.length, MAX_GENERATION_ATTEMPTS);
  // The day is decided: it is not asked again every minute.
  await second.contentForDate('riddle', '2026-11-23');
  assert.equal(failing.calls.length, MAX_GENERATION_ATTEMPTS);
});

test('without Claude the day\'s corpus entry is used and nothing is written', async () => {
  const { instance, filePath } = generator(null);
  assert.equal((await instance.contentForDate('riddle', '2026-11-24')).id, selectRiddleForDate('2026-11-24').id);
  assert.equal((await instance.contentForDate('discussion', '2026-11-24')).id, selectDiscussionForDate('2026-11-24').id);
  assert.equal(fs.existsSync(filePath), false);
  // Corpus IDs are always found; an unknown written ID is not.
  assert.equal(instance.contentForId('riddle', 'r001').id, 'r001');
  assert.equal(instance.contentForId('riddle', 'gr20990101'), null);
  assert.equal(instance.contentForId('discussion', 'nope'), null);
});

test('the riddle checks refuse links, mentions, markup, provider names, a given-away answer and repeats', () => {
  assert.ok(checkRiddle(RIDDLE).riddle);
  const refused = [
    [{ ...RIDDLE, question: '<@123> 猜猜看什麼東西越洗越髒？' }, 'content'],
    [{ ...RIDDLE, question: '@everyone 什麼東西越洗越髒？' }, 'content'],
    [{ ...RIDDLE, explanation: '詳見 discord.gg/abc 的說明。' }, 'content'],
    [{ ...RIDDLE, explanation: '這題由 Claude 出題，答案是水。' }, 'content'],
    [{ ...RIDDLE, question: '**什麼**東西越洗越髒？' }, 'content'],
    [{ ...RIDDLE, question: '水是什麼東西越洗越髒？' }, 'answer_in_question'],
    [{ ...RIDDLE, answer: '一個非常非常長而且根本不像答案的答案' }, 'length'],
    [{ ...RIDDLE, aliases: ['a', 'b', 'c', 'd', 'e', 'f'] }, 'length'],
    [{ ...RIDDLE, question: 'What gets dirtier?' }, 'language'],
    [{ ...RIDDLE, question: selectRiddleForDate('2026-01-01').question }, 'repeated'],
    [null, 'shape'],
    [['not', 'an', 'object'], 'shape'],
  ];
  for (const [raw, reason] of refused) assert.equal(checkRiddle(raw).reason, reason, JSON.stringify(raw));
  assert.equal(checkRiddle(RIDDLE, { recent: [RIDDLE.question] }).reason, 'repeated');
});

test('the topic checks want one open question in plain Chinese text', () => {
  assert.ok(checkTopic(TOPIC).topic);
  for (const [raw, reason] of [
    [{ topic: '說說你的看法。' }, 'length'],
    [{ topic: '你最喜歡哪一個 http://example.com 上的功能？' }, 'content'],
    [{ topic: 'What is your favourite small habit and why is it so?' }, 'language'],
    [{ topic: selectDiscussionForDate('2026-01-01').question }, 'repeated'],
  ]) assert.equal(checkTopic(raw).reason, reason, JSON.stringify(raw));
});

test('a damaged or foreign file is set aside and the day is decided again', async () => {
  const filePath = path.join(root, 'damaged.json');
  fs.writeFileSync(filePath, '{"version":1,"entries":[{"kind":"riddle","localDate":"2026-11-25","source":"claude","id":"gr20261125","question":"<@1>","canonicalAnswer":"x","acceptedAliases":[],"explanation":"y"}]}');
  const client = fakeClient([RIDDLE]);
  const { instance } = generator(client, { filePath });
  // The stored entry fails the checks, so it is not used.
  assert.equal(instance.contentForId('riddle', 'gr20261125'), null);
  assert.equal((await instance.contentForDate('riddle', '2026-11-25')).question, RIDDLE.question);
});
