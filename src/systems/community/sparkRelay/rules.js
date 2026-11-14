'use strict';

// 星火接續 (spark relay): the rules, as pure functions over one round's document. Nothing here talks to Discord, the
// store or the model, so every rule can be tested on its own (test/sparkRelay.test.js).
//
// A round: any member opens it in a channel; members sign up with a button and give 1 to 7 topics of their own.
// When sign-up closes 小吉 shuffles the members into groups (planGroupSizes). In a group one member is on duty each
// day, in a random order starting the day after the grouping (Taipei dates), so a round lasts as many days as the
// group has members. The member on duty gets 2 to 6 small tasks the model writes from that member's own topics, and
// proves each with text or an image, which the model checks (at most 3 checks a task a day). A member who could not
// do it on the day has the 3 days after it as well: on duty on Monday, done before Friday 00:00. When every member
// of the group has done every task, each gets 500 coins at once; a member who runs out of time ends the group with
// no reward. In one server a member is in one sign-up or running group at a time.

const crypto = require('node:crypto');
const { TAIPEI_OFFSET_MINUTES, getTaipeiDateKey } = require('../../../utils/taipeiClock');

const DAY_MS = 24 * 60 * 60 * 1000;
const GROUP_SIZES = Object.freeze([4, 5, 6]);
const MIN_GROUP_SIZE = 2;
const MIN_TASKS = 2;
const MAX_TASKS = 6;
const MIN_TOPICS = 1;
const MAX_TOPICS = 7;
const MAX_TOPIC_LENGTH = 20;
// Days after the day on duty that still count (the day itself not included).
const GRACE_DAYS = 3;
const CHECKS_PER_TASK_PER_DAY = 3;
const REWARD_PER_MEMBER = 500;
const MAX_ENTRANTS = 60;
const DEFAULT_SIGNUP_HOURS = 24;
const MAX_SIGNUP_HOURS = 72;

// Round statuses: signup, running, finished, cancelled. Group statuses: running, completed, failed.
const ACTIVE_ROUND_STATUSES = Object.freeze(['signup', 'running']);

function randomIndex(max, random) {
  return random ? Math.floor(random() * max) : crypto.randomInt(max);
}

function shuffle(values, random) {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = randomIndex(index + 1, random);
    [copy[index], copy[other]] = [copy[other], copy[index]];
  }
  return copy;
}

// The group sizes for n members: { sizes, leftOut }. Every full group has the same size s (4, 5 or 6), chosen so the
// fewest members are left without a group; a remainder of 2 or more is a group of its own, a remainder of one is left
// out of this round. Ties: a size that divides n first, then the larger remainder group (the more even split), then
// the larger size. 7 → 4+3, 9 → 5+4, 12 → 6+6, 13 → 5+5+3. Two or three members are one group; fewer is no round.
function planGroupSizes(count) {
  const n = Number(count);
  if (!Number.isSafeInteger(n) || n < MIN_GROUP_SIZE) return null;
  if (n < GROUP_SIZES[0]) return { sizes: [n], leftOut: 0 };
  let best = null;
  for (const size of GROUP_SIZES) {
    const full = Math.floor(n / size);
    if (full < 1) continue;
    const remainder = n % size;
    const candidate = {
      size,
      full,
      remainder,
      leftOut: remainder === 1 ? 1 : 0,
      extraGroup: remainder >= MIN_GROUP_SIZE ? remainder : 0,
    };
    if (!best || better(candidate, best)) best = candidate;
  }
  const sizes = Array.from({ length: best.full }, () => best.size);
  if (best.extraGroup) sizes.push(best.extraGroup);
  return { sizes, leftOut: best.leftOut };
}

function better(a, b) {
  if (a.leftOut !== b.leftOut) return a.leftOut < b.leftOut;
  if ((a.remainder === 0) !== (b.remainder === 0)) return a.remainder === 0;
  if (a.extraGroup !== b.extraGroup) return a.extraGroup > b.extraGroup;
  return a.size > b.size;
}

function addDays(dateKey, days) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

// 00:00 Taipei of a date key, in ms.
function taipeiMidnightMs(dateKey) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  return Date.UTC(year, month - 1, day) - TAIPEI_OFFSET_MINUTES * 60 * 1000;
}

// The moment a turn's time is up: 00:00 Taipei of the fourth day after the day on duty.
function turnDeadlineMs(dayKey) {
  return taipeiMidnightMs(addDays(dayKey, GRACE_DAYS + 1));
}

// The topics a member typed: split on commas, Chinese commas, 、, semicolons and new lines; trimmed, without repeats.
// { ok: true, topics } or { ok: false, reason }. The caller cleans each topic further (sparkRelayService).
function parseTopics(input) {
  const topics = [];
  for (const raw of String(input || '').split(/[,，、;；\n\r]+/u)) {
    const topic = raw.replace(/\s+/gu, ' ').trim();
    if (!topic || topics.includes(topic)) continue;
    if ([...topic].length > MAX_TOPIC_LENGTH) return { ok: false, reason: 'too_long' };
    topics.push(topic);
  }
  if (topics.length < MIN_TOPICS) return { ok: false, reason: 'empty' };
  if (topics.length > MAX_TOPICS) return { ok: false, reason: 'too_many' };
  return { ok: true, topics };
}

function createRound({ id, guildId, channelId, hostId, now, signupHours = DEFAULT_SIGNUP_HOURS }) {
  const hours = Math.min(MAX_SIGNUP_HOURS, Math.max(1, Math.floor(Number(signupHours) || DEFAULT_SIGNUP_HOURS)));
  return {
    id,
    guildId: String(guildId),
    channelId: String(channelId),
    panelMessageId: null,
    hostId: String(hostId),
    status: 'signup',
    createdAt: now,
    signupEndsAt: now + hours * 60 * 60 * 1000,
    entrants: [],
    leftOut: [],
    groups: [],
    finishedAt: null,
  };
}

function isActiveRound(round) {
  return ACTIVE_ROUND_STATUSES.includes(round?.status);
}

// Whether the member is taken in this round: signed up while it is open, or in a group still running.
function holdsMember(round, userId) {
  if (round.status === 'signup') return round.entrants.some((entrant) => entrant.userId === userId);
  if (round.status !== 'running') return false;
  return round.groups.some((group) => group.status === 'running' && group.turns.some((turn) => turn.userId === userId));
}

function addEntrant(round, { userId, topics, now }) {
  if (round.status !== 'signup') return { ok: false, reason: 'closed' };
  const existing = round.entrants.find((entrant) => entrant.userId === userId);
  if (existing) {
    existing.topics = topics;
    return { ok: true, updated: true };
  }
  if (round.entrants.length >= MAX_ENTRANTS) return { ok: false, reason: 'full' };
  round.entrants.push({ userId, topics, joinedAt: now });
  return { ok: true, updated: false };
}

function removeEntrant(round, userId) {
  if (round.status !== 'signup') return { ok: false, reason: 'closed' };
  const before = round.entrants.length;
  round.entrants = round.entrants.filter((entrant) => entrant.userId !== userId);
  return before === round.entrants.length ? { ok: false, reason: 'not_joined' } : { ok: true };
}

// Closes sign-up: shuffles the members into groups, the day order of each group and how many tasks each turn has.
function formGroups(round, { now, random } = {}) {
  if (round.status !== 'signup') return { ok: false, reason: 'closed' };
  const plan = planGroupSizes(round.entrants.length);
  if (!plan) {
    round.status = 'cancelled';
    round.finishedAt = now;
    return { ok: false, reason: 'too_few' };
  }
  const shuffled = shuffle(round.entrants, random);
  const startDay = addDays(getTaipeiDateKey(new Date(now)), 1);
  let offset = 0;
  round.groups = plan.sizes.map((size, index) => {
    const members = shuffled.slice(offset, offset + size);
    offset += size;
    return {
      index,
      threadId: null,
      status: 'running',
      startDay,
      reward: null,
      endedAt: null,
      turns: members.map((member, position) => ({
        userId: member.userId,
        topics: member.topics,
        day: addDays(startDay, position),
        taskCount: MIN_TASKS + randomIndex(MAX_TASKS - MIN_TASKS + 1, random),
        tasks: null,
        doneAt: null,
        announced: false,
      })),
    };
  });
  round.leftOut = shuffled.slice(offset).map((member) => member.userId);
  round.status = 'running';
  return { ok: true, groups: round.groups, leftOut: round.leftOut };
}

function findMemberTurn(round, userId) {
  for (const group of round.groups) {
    const turn = group.turns.find((item) => item.userId === userId);
    if (turn) return { group, turn };
  }
  return null;
}

// Where a turn stands at `now`: upcoming (before its day), open, done or expired.
function turnState(turn, now) {
  if (turn.doneAt) return 'done';
  if (now >= turnDeadlineMs(turn.day)) return 'expired';
  if (now < taipeiMidnightMs(turn.day)) return 'upcoming';
  return 'open';
}

function setTurnTasks(turn, texts) {
  if (turn.tasks) return false;
  turn.tasks = texts.map((text) => ({ text, passedAt: null, checks: { day: null, count: 0 } }));
  return true;
}

// Takes one of the day's checks of a task; false when the 3 are used.
function reserveCheck(task, now) {
  const day = getTaipeiDateKey(new Date(now));
  if (task.checks.day !== day) task.checks = { day, count: 0 };
  if (task.checks.count >= CHECKS_PER_TASK_PER_DAY) return false;
  task.checks.count += 1;
  return true;
}

// Gives a check back when the model could not answer (it was not a verdict).
function releaseCheck(task, now) {
  const day = getTaipeiDateKey(new Date(now));
  if (task.checks.day === day && task.checks.count > 0) task.checks.count -= 1;
}

// Marks a task passed; the turn is done when all its tasks are, and the group completed when all its turns are.
// Returns { turnDone, groupCompleted }.
function passTask(group, turn, taskIndex, now) {
  const task = turn.tasks?.[taskIndex];
  if (!task || task.passedAt) return { turnDone: Boolean(turn.doneAt), groupCompleted: group.status === 'completed' };
  task.passedAt = now;
  if (turn.tasks.every((item) => item.passedAt)) turn.doneAt = now;
  if (group.status === 'running' && group.turns.every((item) => item.doneAt)) {
    group.status = 'completed';
    group.endedAt = now;
    group.reward = { status: 'pending', granted: [] };
  }
  return { turnDone: Boolean(turn.doneAt), groupCompleted: group.status === 'completed' };
}

// The groups a run of the clock fails: a turn not done when its time is up ends its group without a reward.
function expireGroups(round, now) {
  const failed = [];
  for (const group of round.groups) {
    if (group.status !== 'running') continue;
    const late = group.turns.find((turn) => turnState(turn, now) === 'expired');
    if (!late) continue;
    group.status = 'failed';
    group.endedAt = now;
    group.failedUserId = late.userId;
    failed.push({ group, turn: late });
  }
  return failed;
}

// The turns whose day has come and that were not announced yet; they are marked announced.
function dueAnnouncements(round, now) {
  const due = [];
  for (const group of round.groups) {
    if (group.status !== 'running') continue;
    for (const turn of group.turns) {
      if (turn.announced || turn.doneAt || turnState(turn, now) !== 'open') continue;
      turn.announced = true;
      due.push({ group, turn });
    }
  }
  return due;
}

// A running round is finished once none of its groups runs and every reward was settled.
function settleRound(round, now) {
  if (round.status !== 'running') return false;
  const open = round.groups.some((group) => group.status === 'running' ||
    (group.status === 'completed' && group.reward?.status === 'pending'));
  if (open) return false;
  round.status = 'finished';
  round.finishedAt = now;
  return true;
}

module.exports = {
  CHECKS_PER_TASK_PER_DAY,
  DAY_MS,
  DEFAULT_SIGNUP_HOURS,
  GRACE_DAYS,
  MAX_ENTRANTS,
  MAX_SIGNUP_HOURS,
  MAX_TASKS,
  MAX_TOPICS,
  MAX_TOPIC_LENGTH,
  MIN_TASKS,
  MIN_TOPICS,
  REWARD_PER_MEMBER,
  addDays,
  addEntrant,
  createRound,
  dueAnnouncements,
  expireGroups,
  findMemberTurn,
  formGroups,
  holdsMember,
  isActiveRound,
  parseTopics,
  passTask,
  planGroupSizes,
  releaseCheck,
  removeEntrant,
  reserveCheck,
  setTurnTasks,
  settleRound,
  shuffle,
  taipeiMidnightMs,
  turnDeadlineMs,
  turnState,
};
