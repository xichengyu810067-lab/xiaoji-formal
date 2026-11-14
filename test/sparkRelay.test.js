'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const rules = require('../src/systems/community/sparkRelay/rules');
const judge = require('../src/systems/community/sparkRelay/judge');
const service = require('../src/systems/community/sparkRelay/service');
const { createMemoryStore } = require('../src/systems/community/sparkRelay/memoryStore');
const { buildPanel, buildRoster, parseCustomId } = require('../src/systems/community/sparkRelay/discord');
const { featureRewardReason } = require('../src/systems/economy/transactionReasons');

const GUILD = '10000000000000001';
const CHANNEL = '10000000000000002';
const users = Array.from({ length: 20 }, (_, index) => String(20000000000000000n + BigInt(index)));
// 2026-11-16 (Monday) 12:00 Taipei.
const MONDAY_NOON = Date.UTC(2026, 10, 16, 4, 0, 0);
const HOUR = 60 * 60 * 1000;

function sequenceRandom() {
  let state = 7;
  return () => {
    state = (state * 48271) % 2147483647;
    return state / 2147483647;
  };
}

function fakeJudge({ verdicts = [] } = {}) {
  const calls = { generate: [], check: [] };
  return {
    calls,
    async generateTasks(input) {
      calls.generate.push(input);
      return { ok: true, tasks: Array.from({ length: input.count }, (_, index) => `任務 ${index + 1}：${input.topics[0]}`) };
    },
    async checkSubmission(input) {
      calls.check.push(input);
      return verdicts.length ? verdicts.shift() : { ok: true, passed: true, feedback: '很棒！' };
    },
  };
}

test('group sizes follow the fewest-left-out rule, with the even split on ties', () => {
  const sizes = (n) => rules.planGroupSizes(n);
  assert.equal(sizes(0), null);
  assert.equal(sizes(1), null);
  assert.deepEqual(sizes(2), { sizes: [2], leftOut: 0 });
  assert.deepEqual(sizes(3), { sizes: [3], leftOut: 0 });
  assert.deepEqual(sizes(4), { sizes: [4], leftOut: 0 });
  assert.deepEqual(sizes(5), { sizes: [5], leftOut: 0 });
  assert.deepEqual(sizes(6), { sizes: [6], leftOut: 0 });
  assert.deepEqual(sizes(7), { sizes: [4, 3], leftOut: 0 });
  assert.deepEqual(sizes(9), { sizes: [5, 4], leftOut: 0 });
  assert.deepEqual(sizes(12), { sizes: [6, 6], leftOut: 0 });
  // The user's own example: 4 and 6 leave one member out, 5 does not.
  assert.deepEqual(sizes(13), { sizes: [5, 5, 3], leftOut: 0 });
  // 4, 5 and 6 all leave one member out.
  assert.deepEqual(sizes(61), { sizes: Array(10).fill(6), leftOut: 1 });
  for (let n = 2; n <= rules.MAX_ENTRANTS; n += 1) {
    const plan = sizes(n);
    assert.equal(plan.sizes.reduce((sum, size) => sum + size, 0) + plan.leftOut, n, `n=${n}`);
    assert.ok(plan.sizes.every((size) => size >= 2 && size <= 6), `n=${n}`);
  }
});

test('topics: 1 to 7, split on commas and new lines, without repeats', () => {
  assert.deepEqual(rules.parseTopics('烘焙, 貓咪、吉他\n烘焙'), { ok: true, topics: ['烘焙', '貓咪', '吉他'] });
  assert.deepEqual(rules.parseTopics(' , '), { ok: false, reason: 'empty' });
  assert.deepEqual(rules.parseTopics('a,b,c,d,e,f,g,h'), { ok: false, reason: 'too_many' });
  assert.deepEqual(rules.parseTopics('一'.repeat(21)), { ok: false, reason: 'too_long' });
  assert.throws(() => service.acceptTopics('https://example.com'), { code: 'INVALID_TOPICS' });
  assert.throws(() => service.acceptTopics('<@123>'), { code: 'INVALID_TOPICS' });
});

test('a turn on Monday may be finished until Friday 00:00 Taipei, not after', () => {
  const deadline = rules.turnDeadlineMs('2026-11-16');
  assert.equal(new Date(deadline).toISOString(), '2026-11-19T16:00:00.000Z');
  const turn = { day: '2026-11-16', doneAt: null };
  assert.equal(rules.turnState(turn, rules.taipeiMidnightMs('2026-11-16') - 1), 'upcoming');
  assert.equal(rules.turnState(turn, rules.taipeiMidnightMs('2026-11-16')), 'open');
  assert.equal(rules.turnState(turn, deadline - 1), 'open');
  assert.equal(rules.turnState(turn, deadline), 'expired');
});

test('a whole round: sign-up, groups, one member a day, checks, and 500 coins each when the group is done', async () => {
  const store = createMemoryStore();
  const judgeImpl = fakeJudge({ verdicts: [{ ok: true, passed: false, feedback: '還缺心得。' }] });
  const grants = [];
  const grantReward = async (...args) => {
    grants.push(args);
    return { alreadyGranted: false };
  };
  // Opened on Saturday at noon: sign-up closes on Sunday at noon.
  const round = await service.openRound({ guildId: GUILD, channelId: CHANNEL, hostId: users[0], now: MONDAY_NOON - 48 * HOUR }, { store });
  await assert.rejects(service.openRound({ guildId: GUILD, channelId: CHANNEL, hostId: users[1], now: MONDAY_NOON - 48 * HOUR }, { store }),
    { code: 'CHANNEL_BUSY' });
  for (const userId of users.slice(0, 4)) {
    await service.joinRound({ roundId: round.id, guildId: GUILD, userId, topicsInput: '烘焙，貓咪', now: MONDAY_NOON - 47 * HOUR }, { store });
  }
  // Changing one's topics is not a second sign-up.
  const again = await service.joinRound({ roundId: round.id, guildId: GUILD, userId: users[0], topicsInput: '吉他', now: MONDAY_NOON - 47 * HOUR }, { store });
  assert.equal(again.result.updated, true);
  assert.equal(again.result.count, 4);
  await assert.rejects(service.closeSignup({ roundId: round.id, userId: users[1], now: MONDAY_NOON - 46 * HOUR }, { store }), { code: 'NOT_HOST' });

  // The clock closes sign-up when its time is up (not before); day one is the next Taipei date.
  const early = await service.runSparkRelayClock({ now: MONDAY_NOON - 24 * HOUR - 1 }, { store, grantReward });
  assert.equal(early.formed.length, 0);
  const report = await service.runSparkRelayClock({ now: MONDAY_NOON - 24 * HOUR, random: sequenceRandom() }, { store, grantReward });
  assert.equal(report.formed.length, 1);
  const formed = report.formed[0];
  assert.equal(formed.groups.length, 1);
  const group = formed.groups[0];
  assert.deepEqual(group.turns.map((turn) => turn.day), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
  assert.ok(group.turns.every((turn) => turn.taskCount >= 2 && turn.taskCount <= 6));
  const panel = buildPanel(formed);
  assert.match(panel.content, /分成 1 組/u);
  assert.match(buildRoster(group), /星火接續 第 1 組/u);

  // A member already in this round cannot sign up for another in the same server.
  const other = await service.openRound({ guildId: GUILD, channelId: '10000000000000009', hostId: users[9], now: MONDAY_NOON }, { store });
  await assert.rejects(service.joinRound({ roundId: other.id, guildId: GUILD, userId: group.turns[0].userId, topicsInput: '書', now: MONDAY_NOON }, { store }),
    { code: 'ALREADY_IN_ROUND' });

  // The second member's day has not come.
  await assert.rejects(service.getTurnTasks({ guildId: GUILD, userId: group.turns[1].userId, now: MONDAY_NOON }, { store, judgeImpl }),
    { code: 'NOT_YET' });

  // Each member does their tasks on their own day; the first one fails one check before passing.
  let finalResult = null;
  for (const [position, turn] of group.turns.entries()) {
    const now = rules.taipeiMidnightMs(turn.day) + 20 * HOUR;
    const clock = await service.runSparkRelayClock({ now }, { store, grantReward });
    assert.deepEqual(clock.announcements.map((item) => item.turn.userId), [turn.userId]);
    const place = await service.getTurnTasks({ guildId: GUILD, userId: turn.userId, now }, { store, judgeImpl });
    assert.equal(place.turn.tasks.length, turn.taskCount);
    for (let index = 0; index < turn.taskCount; index += 1) {
      if (position === 0 && index === 0) {
        const failed = await service.submitTask({ guildId: GUILD, userId: turn.userId, taskNumber: 1, text: '完成了', now },
          { store, judgeImpl, grantReward });
        assert.equal(failed.passed, false);
        assert.equal(failed.remainingChecks, 2);
      }
      finalResult = await service.submitTask({ guildId: GUILD, userId: turn.userId, taskNumber: index + 1, text: '我做了一份手寫清單', now },
        { store, judgeImpl, grantReward });
      assert.equal(finalResult.passed, true);
    }
    assert.equal(finalResult.turnDone, true);
  }
  assert.equal(finalResult.groupCompleted, true);
  assert.equal(finalResult.reward.status, 'granted');
  assert.equal(grants.length, 4);
  for (const args of grants) {
    assert.deepEqual(args.slice(2, 6), ['spark-relay', `${round.id}:0`, 'team_completion', 500]);
  }
  assert.equal(featureRewardReason('team_completion'), '星火接續團隊獎勵');
  // Each turn's tasks were written once, from that member's own topics.
  assert.equal(judgeImpl.calls.generate.length, 4);
  const stored = await store.get(round.id);
  assert.equal(stored.round.status, 'finished');
  // The members are free again.
  const later = await service.openRound({ guildId: GUILD, channelId: CHANNEL, hostId: users[9], now: MONDAY_NOON + 96 * HOUR }, { store });
  await service.joinRound({ roundId: later.id, guildId: GUILD, userId: group.turns[0].userId, topicsInput: '書', now: MONDAY_NOON + 96 * HOUR }, { store });
});

test('a member who runs out of time ends the group without a reward', async () => {
  const store = createMemoryStore();
  const grants = [];
  const grantReward = async (...args) => grants.push(args);
  const round = await service.openRound({ guildId: GUILD, channelId: CHANNEL, hostId: users[0], now: MONDAY_NOON - 24 * HOUR }, { store });
  for (const userId of users.slice(0, 2)) {
    await service.joinRound({ roundId: round.id, guildId: GUILD, userId, topicsInput: '畫畫', now: MONDAY_NOON - 23 * HOUR }, { store });
  }
  const closed = await service.closeSignup({ roundId: round.id, userId: users[0], now: MONDAY_NOON - 22 * HOUR }, { store });
  assert.equal(closed.result.formed, true);
  const [first] = closed.round.groups[0].turns;
  const stillTime = await service.runSparkRelayClock({ now: rules.turnDeadlineMs(first.day) - 1 }, { store, grantReward });
  assert.equal(stillTime.failures.length, 0);
  const late = await service.runSparkRelayClock({ now: rules.turnDeadlineMs(first.day) }, { store, grantReward });
  assert.equal(late.failures.length, 1);
  assert.equal(late.failures[0].turn.userId, first.userId);
  assert.equal(grants.length, 0);
  assert.equal((await store.get(round.id)).round.status, 'finished');
});

test('three checks a task a day; a check the model could not answer is given back', async () => {
  const store = createMemoryStore();
  const judgeImpl = fakeJudge({
    verdicts: [
      { ok: false, reason: 'failed' },
      { ok: true, passed: false, feedback: '不夠' },
      { ok: true, passed: false, feedback: '不夠' },
      { ok: true, passed: false, feedback: '不夠' },
    ],
  });
  const round = await service.openRound({ guildId: GUILD, channelId: CHANNEL, hostId: users[0], now: MONDAY_NOON - 24 * HOUR }, { store });
  for (const userId of users.slice(0, 2)) {
    await service.joinRound({ roundId: round.id, guildId: GUILD, userId, topicsInput: '散步', now: MONDAY_NOON - 23 * HOUR }, { store });
  }
  const closed = await service.closeSignup({ roundId: round.id, userId: users[0], now: MONDAY_NOON - 22 * HOUR }, { store });
  const [first] = closed.round.groups[0].turns;
  const now = rules.taipeiMidnightMs(first.day) + HOUR;
  await assert.rejects(service.submitTask({ guildId: GUILD, userId: first.userId, taskNumber: 1, text: 'x', now }, { store, judgeImpl }),
    { code: 'NO_TASKS' });
  await service.getTurnTasks({ guildId: GUILD, userId: first.userId, now }, { store, judgeImpl });
  await assert.rejects(service.submitTask({ guildId: GUILD, userId: first.userId, taskNumber: 1, text: 'x', now }, { store, judgeImpl }),
    { code: 'MODEL_UNAVAILABLE' });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const result = await service.submitTask({ guildId: GUILD, userId: first.userId, taskNumber: 1, text: 'x', now }, { store, judgeImpl });
    assert.equal(result.remainingChecks, 2 - attempt);
  }
  await assert.rejects(service.submitTask({ guildId: GUILD, userId: first.userId, taskNumber: 1, text: 'x', now }, { store, judgeImpl }),
    { code: 'CHECK_LIMIT' });
  // The next day the checks are back.
  const tomorrow = await service.submitTask({ guildId: GUILD, userId: first.userId, taskNumber: 1, text: 'x', now: now + 24 * HOUR },
    { store, judgeImpl });
  assert.equal(tomorrow.passed, true);
  await assert.rejects(service.submitTask({ guildId: GUILD, userId: first.userId, taskNumber: 9, text: 'x', now }, { store, judgeImpl }),
    { code: 'NO_TASK' });
  await assert.rejects(service.submitTask({ guildId: GUILD, userId: first.userId, taskNumber: 2, now }, { store, judgeImpl }),
    { code: 'EMPTY' });
});

test('too few members cancel the round; the host can cancel during sign-up', async () => {
  const store = createMemoryStore();
  const round = await service.openRound({ guildId: GUILD, channelId: CHANNEL, hostId: users[0], now: MONDAY_NOON }, { store });
  await service.joinRound({ roundId: round.id, guildId: GUILD, userId: users[1], topicsInput: '音樂', now: MONDAY_NOON }, { store });
  const report = await service.runSparkRelayClock({ now: MONDAY_NOON + 25 * HOUR }, { store });
  assert.equal(report.cancelled.length, 1);
  assert.match(buildPanel(report.cancelled[0]).content, /不足 2 人/u);

  const second = await service.openRound({ guildId: GUILD, channelId: CHANNEL, hostId: users[0], now: MONDAY_NOON }, { store });
  await assert.rejects(service.cancelRound({ roundId: second.id, userId: users[1], now: MONDAY_NOON }, { store }), { code: 'NOT_HOST' });
  await service.cancelRound({ roundId: second.id, userId: users[0], now: MONDAY_NOON }, { store });
  assert.equal((await store.get(second.id)).round.status, 'cancelled');
});

test('two writes at once never overwrite each other', async () => {
  const store = createMemoryStore();
  const round = await service.openRound({ guildId: GUILD, channelId: CHANNEL, hostId: users[0], now: MONDAY_NOON }, { store });
  await Promise.all(users.slice(0, 10).map((userId) =>
    service.joinRound({ roundId: round.id, guildId: GUILD, userId, topicsInput: '電影', now: MONDAY_NOON }, { store })));
  assert.equal((await store.get(round.id)).round.entrants.length, 10);
});

test('the model answers are read strictly and cleaned', () => {
  assert.deepEqual(judge.parseTasks('{"tasks": ["寫三句心得", "畫一隻貓"]}', 2), ['寫三句心得', '畫一隻貓']);
  assert.equal(judge.parseTasks('{"tasks": ["寫三句心得"]}', 2), null);
  assert.equal(judge.parseTasks('{"tasks": ["看 https://example.com", "畫一隻貓"]}', 2), null);
  assert.equal(judge.parseTasks('not json', 2), null);
  assert.deepEqual(judge.parseVerdict('{"passed": true, "feedback": "做得好"}'), { passed: true, feedback: '做得好' });
  assert.deepEqual(judge.parseVerdict('{"passed": false, "feedback": "<@1> 再試"}'), { passed: false, feedback: judge.DEFAULT_FAIL_FEEDBACK });
  assert.equal(judge.parseVerdict('{"passed": "yes"}'), null);
});

test('the model is asked with topics and hand-ins as data, and an image costs more quota', async () => {
  const requests = [];
  const quota = [];
  const client = {
    messages: {
      async create(request) {
        requests.push(request);
        return { content: [{ type: 'text', text: request.system === judge.TASK_PROMPT ? '{"tasks":["寫一首短詩","列三本書"]}' : '{"passed":true,"feedback":"好"}' }] };
      },
    },
  };
  const consumeQuota = (_guildId, amount) => {
    quota.push(amount);
    return { ok: true };
  };
  const tasks = await judge.generateTasks({ guildId: GUILD, topics: ['閱讀'], count: 2 }, { client, model: 'm', consumeQuota });
  assert.deepEqual(tasks, { ok: true, tasks: ['寫一首短詩', '列三本書'] });
  assert.deepEqual(JSON.parse(requests[0].messages[0].content), { topics: ['閱讀'], count: 2 });
  const verdict = await judge.checkSubmission({ guildId: GUILD, task: '寫一首短詩', submission: '詩', image: { mediaType: 'image/png', data: 'AA==' } },
    { client, model: 'm', consumeQuota });
  assert.equal(verdict.passed, true);
  assert.equal(requests[1].messages[0].content[0].type, 'image');
  assert.deepEqual(quota, [1, 11]);
  assert.deepEqual(await judge.generateTasks({ guildId: GUILD, topics: ['x'], count: 2 }, { client: null }), { ok: false, reason: 'not_configured' });
  assert.deepEqual(await judge.checkSubmission({ guildId: GUILD, task: 't', submission: 's' },
    { client, model: 'm', consumeQuota: () => ({ ok: false }) }), { ok: false, reason: 'guild_quota' });
});

test('custom ids carry the round and the action only', () => {
  assert.deepEqual(parseCustomId('spark|1|join|abc'), { action: 'join', roundId: 'abc' });
  assert.equal(parseCustomId('spark|2|join|abc'), null);
  assert.equal(parseCustomId('poll:1'), null);
});
