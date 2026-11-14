'use strict';

// 星火接續: what members and the clock do to a round, on top of the rules (rules.js), the store (store.js) and the
// model (judge.js). Discord is not touched here; sparkRelayDiscord.js shows the results.

const crypto = require('node:crypto');
const rules = require('./rules');
const judge = require('./judge');
const { getSparkRelayStore } = require('./store');
const { getAnthropicClient } = require('../../../services/aiService');
const { grantRewardOnce } = require('../../../services/featurePlatformService');
const { looksLikeInjectionAttempt, sanitizeUntrustedText } = require('../../conversation/disclosurePolicy');
const logger = require('../../../utils/logger');

const REWARD_SOURCE = 'spark-relay';
const REWARD_KIND = 'team_completion';
const MAX_WRITE_ATTEMPTS = 10;
const MAX_SUBMISSION_LENGTH = 1500;

class SparkRelayError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'SparkRelayError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new SparkRelayError(code, message);
}

function requireStore(store) {
  if (!store) fail('UNAVAILABLE', '星火接續目前沒有開啟（需要小吉的雲端資料庫）。');
  return store;
}

function isSparkRelayAvailable({ store = getSparkRelayStore(), client = getAnthropicClient() } = {}) {
  return Boolean(store && client);
}

// Reads, changes and writes back one round, again from the top when another write came first. change(round) returns
// { result, write }; write false leaves the round as it was.
async function mutateRound(store, roundId, now, change) {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const record = await store.get(roundId);
    if (!record) fail('NOT_FOUND', '找不到這一輪星火接續，可能已經結束了。');
    const { result, write = true } = await change(record.round);
    if (!write) return { result, round: record.round };
    if (await store.compareAndSet(record.round, record.version, now)) return { result, round: record.round };
    // Another write came first: wait a little (longer each time, at random) so the writers spread out.
    await new Promise((resolve) => setTimeout(resolve, crypto.randomInt(5, 25) * (attempt + 1)));
  }
  fail('BUSY', '大家同時在操作，請再試一次。');
}

// The topics a member typed, cleaned: links, mentions and instructions to 小吉 are refused.
function acceptTopics(input) {
  const parsed = rules.parseTopics(sanitizeUntrustedText(input));
  if (!parsed.ok) {
    const messages = {
      empty: `請至少填 ${rules.MIN_TOPICS} 個主題。`,
      too_many: `主題最多 ${rules.MAX_TOPICS} 個。`,
      too_long: `每個主題最多 ${rules.MAX_TOPIC_LENGTH} 個字。`,
    };
    fail('INVALID_TOPICS', messages[parsed.reason]);
  }
  for (const topic of parsed.topics) {
    if (/https?:|www\.|discord\.gg|<[@#&]|@everyone|@here|\d{6,}/iu.test(topic) || looksLikeInjectionAttempt(topic)) {
      fail('INVALID_TOPICS', `主題「${topic.slice(0, rules.MAX_TOPIC_LENGTH)}」不能用，請只寫興趣主題（不要放連結、標記或指令）。`);
    }
  }
  return parsed.topics;
}

async function findHeldRound(store, guildId, userId, exceptRoundId = null) {
  const records = await store.listActive(guildId);
  return records.find(({ round }) => round.id !== exceptRoundId && rules.holdsMember(round, userId))?.round || null;
}

async function openRound({ guildId, channelId, hostId, signupHours, now = Date.now() }, { store = getSparkRelayStore() } = {}) {
  requireStore(store);
  const active = await store.listActive(guildId);
  if (active.some(({ round }) => round.status === 'signup' && round.channelId === String(channelId))) {
    fail('CHANNEL_BUSY', '這個頻道已經有一輪星火接續在報名中，請先用那一輪的面板報名。');
  }
  const round = rules.createRound({ id: crypto.randomUUID(), guildId, channelId, hostId, now, signupHours });
  await store.create(round, now);
  return round;
}

async function setPanelMessage(roundId, messageId, { store = getSparkRelayStore(), now = Date.now() } = {}) {
  return mutateRound(requireStore(store), roundId, now, (round) => {
    round.panelMessageId = String(messageId);
    return { result: true };
  });
}

async function joinRound({ roundId, guildId, userId, topicsInput, now = Date.now() }, { store = getSparkRelayStore() } = {}) {
  requireStore(store);
  const topics = acceptTopics(topicsInput);
  if (await findHeldRound(store, guildId, userId, roundId)) {
    fail('ALREADY_IN_ROUND', '你在這個伺服器已經參加了另一輪星火接續，那一輪結束後才能再報名。');
  }
  return mutateRound(store, roundId, now, (round) => {
    if (round.guildId !== String(guildId)) fail('NOT_FOUND', '找不到這一輪星火接續。');
    const added = rules.addEntrant(round, { userId, topics, now });
    if (!added.ok) fail(added.reason === 'full' ? 'FULL' : 'CLOSED',
      added.reason === 'full' ? `這一輪已經滿 ${rules.MAX_ENTRANTS} 人了。` : '這一輪已經截止報名了。');
    return { result: { updated: added.updated, count: round.entrants.length, topics } };
  });
}

async function leaveRound({ roundId, userId, now = Date.now() }, { store = getSparkRelayStore() } = {}) {
  return mutateRound(requireStore(store), roundId, now, (round) => {
    const removed = rules.removeEntrant(round, userId);
    if (!removed.ok) fail(removed.reason === 'closed' ? 'CLOSED' : 'NOT_JOINED',
      removed.reason === 'closed' ? '這一輪已經截止報名了。' : '你還沒有報名這一輪。');
    return { result: { count: round.entrants.length } };
  });
}

// Closes sign-up now (the host's 開始分組, or the clock when sign-up time is up). { formed, round }.
async function closeSignup({ roundId, userId = null, now = Date.now(), random } = {}, { store = getSparkRelayStore() } = {}) {
  return mutateRound(requireStore(store), roundId, now, (round) => {
    if (userId && round.hostId !== String(userId)) fail('NOT_HOST', '只有開這一輪的人可以提早開始分組。');
    if (round.status !== 'signup') return { result: { formed: false, already: true }, write: false };
    const formed = rules.formGroups(round, { now, random });
    return { result: { formed: formed.ok } };
  });
}

async function cancelRound({ roundId, userId, now = Date.now() }, { store = getSparkRelayStore() } = {}) {
  return mutateRound(requireStore(store), roundId, now, (round) => {
    if (round.hostId !== String(userId)) fail('NOT_HOST', '只有開這一輪的人可以取消。');
    if (round.status !== 'signup') fail('CLOSED', '已經分組的星火接續不能取消。');
    round.status = 'cancelled';
    round.finishedAt = now;
    return { result: true };
  });
}

async function setGroupThread(roundId, groupIndex, threadId, { store = getSparkRelayStore(), now = Date.now() } = {}) {
  return mutateRound(requireStore(store), roundId, now, (round) => {
    const group = round.groups[groupIndex];
    if (!group || group.threadId) return { result: false, write: false };
    group.threadId = String(threadId);
    return { result: true };
  });
}

// The member's place in a running group of this guild: { round, group, turn, state } or null.
async function findMemberPlace({ guildId, userId, now = Date.now() }, { store = getSparkRelayStore() } = {}) {
  requireStore(store);
  const records = await store.listActive(guildId);
  for (const { round } of records) {
    if (round.status !== 'running') continue;
    const place = rules.findMemberTurn(round, String(userId));
    if (place && place.group.status === 'running') return { round, ...place, state: rules.turnState(place.turn, now) };
  }
  for (const { round } of records) {
    if (round.status === 'signup' && round.entrants.some((entrant) => entrant.userId === String(userId))) {
      return { round, group: null, turn: null, state: 'signup' };
    }
  }
  return null;
}

function requireOpenTurn(place) {
  if (!place) fail('NO_TURN', '你目前沒有進行中的星火接續。');
  if (place.state === 'signup') fail('NO_TURN', '你報名的那一輪還在報名中，分組後就會排出輪值日。');
  if (place.state === 'upcoming') fail('NOT_YET', `還沒輪到你喔，你的輪值日是 ${place.turn.day}。`);
  if (place.state === 'expired') fail('EXPIRED', '你的補做期限已經過了。');
  return place;
}

const MODEL_UNAVAILABLE = {
  not_configured: '小吉的 AI 目前沒有設定，暫時無法出題或驗收。',
  guild_quota: '這個伺服器今天的 AI 額度用完了，請明天再試。',
  refusal: '小吉這次沒辦法處理，請換個說法或稍後再試。',
  unreadable: '小吉這次沒有整理好，請稍後再試一次。',
  failed: '小吉暫時連不上 AI，請稍後再試。',
};

// The tasks of the member's open turn, written by the model the first time they are asked for.
async function getTurnTasks({ guildId, userId, now = Date.now() }, { store = getSparkRelayStore(), judgeImpl = judge } = {}) {
  const place = await findMemberPlace({ guildId, userId, now }, { store });
  if (place?.state === 'done') return place;
  requireOpenTurn(place);
  if (place.turn.tasks) return place;
  const generated = await judgeImpl.generateTasks({ guildId, topics: place.turn.topics, count: place.turn.taskCount });
  if (!generated.ok) fail('MODEL_UNAVAILABLE', MODEL_UNAVAILABLE[generated.reason] || MODEL_UNAVAILABLE.failed);
  const { round } = await mutateRound(store, place.round.id, now, (current) => {
    const found = rules.findMemberTurn(current, String(userId));
    if (!found || found.turn.tasks) return { result: false, write: false };
    rules.setTurnTasks(found.turn, generated.tasks);
    return { result: true };
  });
  const found = rules.findMemberTurn(round, String(userId));
  return { round, ...found, state: rules.turnState(found.turn, now) };
}

// Checks one hand-in. { passed, feedback, task, turnDone, groupCompleted, round, group, turn, remainingChecks, reward }.
async function submitTask({ guildId, userId, taskNumber, text = '', image = null, now = Date.now() }, {
  store = getSparkRelayStore(),
  judgeImpl = judge,
  grantReward = grantRewardOnce,
} = {}) {
  const submission = String(text || '').trim().slice(0, MAX_SUBMISSION_LENGTH);
  if (!submission && !image) fail('EMPTY', '請寫一段文字或附一張圖片來證明完成。');
  const place = requireOpenTurn(await findMemberPlace({ guildId, userId, now }, { store }));
  if (place.state === 'done') fail('DONE', '你這一輪的任務都完成了！');
  if (!place.turn.tasks) fail('NO_TASKS', '請先用 /spark-relay tasks 領取今天的任務。');
  const index = Number(taskNumber) - 1;
  if (!Number.isInteger(index) || !place.turn.tasks[index]) fail('NO_TASK', `任務編號是 1 到 ${place.turn.tasks.length}。`);
  if (place.turn.tasks[index].passedAt) fail('ALREADY_PASSED', `第 ${index + 1} 件已經完成了。`);

  // Takes one of the day's checks first, so three quick hand-ins cannot all slip past the limit.
  const reserved = await mutateRound(store, place.round.id, now, (round) => {
    const found = rules.findMemberTurn(round, String(userId));
    const task = found?.turn.tasks?.[index];
    if (!task || task.passedAt || found.group.status !== 'running') fail('CLOSED', '這件任務已經不能再交了。');
    if (!rules.reserveCheck(task, now)) {
      fail('CHECK_LIMIT', `第 ${index + 1} 件今天已經送驗 ${rules.CHECKS_PER_TASK_PER_DAY} 次了，明天再試（記得在期限內）。`);
    }
    return { result: rules.CHECKS_PER_TASK_PER_DAY - task.checks.count };
  });
  const taskText = place.turn.tasks[index].text;
  const verdict = await judgeImpl.checkSubmission({ guildId, task: taskText, submission, image });
  if (!verdict.ok) {
    await mutateRound(store, place.round.id, now, (round) => {
      const task = rules.findMemberTurn(round, String(userId))?.turn.tasks?.[index];
      if (!task) return { result: false, write: false };
      rules.releaseCheck(task, now);
      return { result: true };
    }).catch(() => {});
    fail('MODEL_UNAVAILABLE', MODEL_UNAVAILABLE[verdict.reason] || MODEL_UNAVAILABLE.failed);
  }
  if (!verdict.passed) {
    return { passed: false, feedback: verdict.feedback, task: taskText, taskNumber: index + 1,
      remainingChecks: reserved.result, round: place.round, group: place.group, turn: place.turn };
  }
  const passed = await mutateRound(store, place.round.id, now, (round) => {
    const found = rules.findMemberTurn(round, String(userId));
    if (!found || found.group.status !== 'running') fail('CLOSED', '這一組已經結束了。');
    return { result: { ...rules.passTask(found.group, found.turn, index, now), groupIndex: found.group.index } };
  });
  const found = rules.findMemberTurn(passed.round, String(userId));
  let reward = null;
  if (passed.result.groupCompleted) {
    reward = await settleGroupReward(passed.round.id, passed.result.groupIndex, { store, grantReward, now });
  }
  return { passed: true, feedback: verdict.feedback, task: taskText, taskNumber: index + 1, ...passed.result,
    round: passed.round, group: found.group, turn: found.turn, reward };
}

// Pays every member of a completed group once (the reward receipts make a second run pay nobody twice).
// { status: granted | coin_disabled | pending }.
async function settleGroupReward(roundId, groupIndex, { store = getSparkRelayStore(), grantReward = grantRewardOnce, now = Date.now() } = {}) {
  const record = await store.get(roundId);
  const group = record?.round.groups[groupIndex];
  if (!group || group.status !== 'completed' || group.reward?.status !== 'pending') return { status: group?.reward?.status || null };
  let status = 'granted';
  const granted = [];
  for (const turn of group.turns) {
    try {
      await grantReward(record.round.guildId, turn.userId, REWARD_SOURCE, `${roundId}:${groupIndex}`, REWARD_KIND,
        rules.REWARD_PER_MEMBER, { roundId, groupIndex });
      granted.push(turn.userId);
    } catch (error) {
      if (error?.code === 'COIN_DISABLED') {
        status = 'coin_disabled';
        break;
      }
      status = 'pending';
      logger.warn(`[SPARK_RELAY] code=SPARK_RELAY_REWARD_FAILED reason=${String(error?.code || error?.name || 'unknown').slice(0, 60)}`);
    }
  }
  await mutateRound(store, roundId, now, (round) => {
    const current = round.groups[groupIndex];
    if (current.reward?.status !== 'pending') return { result: false, write: false };
    current.reward = { status, granted };
    rules.settleRound(round, now);
    return { result: true };
  });
  return { status, granted };
}

// One run of the clock (every few minutes): closes sign-ups whose time is up, announces the day's turns, ends groups
// whose member ran out of time, retries rewards that could not be paid and finishes rounds. Returns what Discord
// should show: { formed: [round], cancelled: [round], announcements: [{ round, group, turn }],
// failures: [{ round, group, turn }], rewards: [{ round, group, status }] }.
async function runSparkRelayClock({ now = Date.now(), random } = {}, { store = getSparkRelayStore(), grantReward = grantRewardOnce } = {}) {
  const report = { formed: [], cancelled: [], announcements: [], failures: [], rewards: [] };
  if (!store) return report;
  for (const { round: listed } of await store.listActive()) {
    try {
      if (listed.status === 'signup' && now >= listed.signupEndsAt) {
        const closed = await closeSignup({ roundId: listed.id, now, random }, { store });
        if (closed.result.formed) report.formed.push(closed.round);
        else if (closed.round.status === 'cancelled') report.cancelled.push(closed.round);
        continue;
      }
      if (listed.status !== 'running') continue;
      const changed = await mutateRound(store, listed.id, now, (round) => {
        const failures = rules.expireGroups(round, now);
        const announcements = rules.dueAnnouncements(round, now);
        const finished = rules.settleRound(round, now);
        return {
          result: {
            failures: failures.map(({ group, turn }) => ({ groupIndex: group.index, userId: turn.userId })),
            announcements: announcements.map(({ group, turn }) => ({ groupIndex: group.index, userId: turn.userId })),
          },
          write: failures.length > 0 || announcements.length > 0 || finished,
        };
      });
      const pick = ({ groupIndex, userId }) => {
        const group = changed.round.groups[groupIndex];
        return { round: changed.round, group, turn: group.turns.find((turn) => turn.userId === userId) };
      };
      report.failures.push(...changed.result.failures.map(pick));
      report.announcements.push(...changed.result.announcements.map(pick));
      for (const group of changed.round.groups) {
        if (group.status === 'completed' && group.reward?.status === 'pending') {
          const reward = await settleGroupReward(listed.id, group.index, { store, grantReward, now });
          report.rewards.push({ round: changed.round, group, status: reward.status });
        }
      }
    } catch (error) {
      logger.warn(`[SPARK_RELAY] code=SPARK_RELAY_CLOCK_FAILED reason=${String(error?.code || error?.name || 'unknown').slice(0, 60)}`);
    }
  }
  await store.prune?.(now);
  return report;
}

module.exports = {
  MAX_SUBMISSION_LENGTH,
  REWARD_KIND,
  REWARD_SOURCE,
  SparkRelayError,
  acceptTopics,
  cancelRound,
  closeSignup,
  findMemberPlace,
  getTurnTasks,
  isSparkRelayAvailable,
  joinRound,
  leaveRound,
  openRound,
  runSparkRelayClock,
  setGroupThread,
  setPanelMessage,
  settleGroupReward,
  submitTask,
};
