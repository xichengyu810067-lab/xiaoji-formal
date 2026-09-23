const { createHash, randomUUID } = require('node:crypto');
const { EmbedBuilder } = require('discord.js');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const { grantRewardOnce, setFeatureHealth } = require('./featurePlatformService');
const { corpusVersion, riddles, selectRiddleForDate } = require('./dailyRiddleCorpus');
const { getNextTaipeiOccurrence, getTaipeiDateKey, getTaipeiMinuteOfDay } = require('../utils/taipeiClock');
const logger = require('../utils/logger');

const FEATURE_KEY = 'daily_riddle';
const EVENT_KIND = 'riddle';
const PUBLISH_MINUTE = 10 * 60;
const SETTLE_MINUTE = 21 * 60 + 30;
const PARTICIPATION_REWARD = 30;
const CORRECT_REWARD = 50;
const MAX_EVENT_ATTEMPTS = 3;
const MAX_HISTORY_PAGES = 20;
const HISTORY_PAGE_SIZE = 100;
const SCHEDULER_INTERVAL_MS = 60_000;
const LEASE_MS = 15 * 60_000;
const TAIPEI_BOUNDARY_MINUTES = Object.freeze([0, PUBLISH_MINUTE, SETTLE_MINUTE]);
const graphemeSegmenter = new Intl.Segmenter('zh-TW', { granularity: 'grapheme' });
let schedulerState = null;

class DailyRiddleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DailyRiddleError';
    this.code = code;
  }
}

function requireId(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 100) throw new DailyRiddleError('INVALID_ARGUMENT', `${name} is required.`);
  return normalized;
}

function requireNow(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(date.getTime())) throw new DailyRiddleError('INVALID_ARGUMENT', 'now must be valid.');
  return date;
}

function riddleForId(riddleId) {
  const riddle = riddles.find((entry) => entry.id === riddleId);
  if (!riddle) throw new DailyRiddleError('RIDDLE_NOT_FOUND', 'The persisted riddle id is not in the curated corpus.');
  return riddle;
}

function getRiddleWindow(localDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDate))) {
    throw new DailyRiddleError('INVALID_LOCAL_DATE', 'localDate must use YYYY-MM-DD.');
  }
  const midnightUtc = Date.parse(`${localDate}T00:00:00.000Z`) - 8 * 60 * 60 * 1000;
  if (!Number.isFinite(midnightUtc)) throw new DailyRiddleError('INVALID_LOCAL_DATE', 'localDate is invalid.');
  return {
    start: new Date(midnightUtc + PUBLISH_MINUTE * 60 * 1000),
    end: new Date(midnightUtc + SETTLE_MINUTE * 60 * 1000),
  };
}

function getRiddlePhase(now = new Date()) {
  const date = requireNow(now);
  const minute = getTaipeiMinuteOfDay(date);
  return minute < PUBLISH_MINUTE ? 'before' : minute < SETTLE_MINUTE ? 'open' : 'settlement';
}

function normalizeDailyRiddleAnswer(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('zh-TW')
    .replace(/^(?:答案(?:是|為)?|我猜(?:是)?|答)\s*[:：]?\s*/u, '')
    .replace(/[\s,，.。!！?？:：;；'"「」『』()（）【】\-—_]+/gu, '');
}

function isCorrectDailyRiddleAnswer(content, riddle) {
  const normalized = normalizeDailyRiddleAnswer(content);
  if (!normalized) return false;
  return [riddle.canonicalAnswer, ...riddle.acceptedAliases].some(
    (answer) => normalizeDailyRiddleAnswer(answer) === normalized
  );
}

function isEligibleRiddleMessage(content, riddle = null) {
  if (riddle && isCorrectDailyRiddleAnswer(content, riddle)) return true;
  const normalized = String(content ?? '')
    .normalize('NFKC')
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>|<a?:[A-Za-z0-9_]+:\d+>/g, ' ')
    .trim();
  const graphemes = Array.from(graphemeSegmenter.segment(normalized));
  const meaningful = Array.from(normalized.matchAll(/[\p{L}\p{N}]/gu), (match) => match[0]);
  if (!normalized || normalized.length > 2000 || graphemes.length < 4 || meaningful.length < 2) return false;
  const meaningfulText = meaningful.join('');
  if (/^(.{1,3})\1+$/u.test(meaningfulText)) return false;
  return true;
}

function stableMarker(kind, guildId, localDate, riddleId) {
  const digest = createHash('sha256')
    .update(`${corpusVersion}|${kind}|${guildId}|${localDate}|${riddleId}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `xiaoji-daily-riddle:${kind}:${digest}`;
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    eventKind: row.event_kind,
    localDate: row.local_date,
    riddleId: row.riddle_id,
    parentChannelId: row.parent_channel_id,
    announcementMessageId: row.announcement_message_id || null,
    threadId: row.thread_id || null,
    answerMessageId: row.answer_message_id || null,
    status: row.status,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    publishMarker: row.publish_marker,
    answerMarker: row.answer_marker,
    publishedAt: row.published_at || null,
    historyReconciledAt: row.history_reconciled_at || null,
    settledAt: row.settled_at || null,
    attemptCount: Number(row.attempt_count),
    publishLeaseOwner: row.publish_lease_owner || null,
    publishLeaseUntil: row.publish_lease_until || null,
    settleLeaseOwner: row.settle_lease_owner || null,
    settleLeaseUntil: row.settle_lease_until || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function getDailyRiddleEvent(guildId, localDate = getTaipeiDateKey()) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  return withCoinDatabase((api) =>
    mapEvent(
      api.get('SELECT * FROM daily_events WHERE guild_id = ? AND event_kind = ? AND local_date = ?', [
        normalizedGuildId,
        EVENT_KIND,
        localDate,
      ])
    )
  );
}

async function claimDailyRiddleEvent({ guildId, parentChannelId, localDate, now = new Date(), missed = false }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(parentChannelId, 'parentChannelId');
  const date = requireNow(now);
  const riddle = selectRiddleForDate(localDate);
  const window = getRiddleWindow(localDate);
  const timestamp = date.toISOString();
  const leaseOwner = missed ? null : randomUUID();
  const leaseUntil = missed ? null : new Date(date.getTime() + LEASE_MS).toISOString();
  const publishMarker = stableMarker('publish', normalizedGuildId, localDate, riddle.id);
  const answerMarker = stableMarker('answer', normalizedGuildId, localDate, riddle.id);

  return withCoinTransaction((api) => {
    api.run(
      `INSERT INTO daily_events
        (guild_id, event_kind, local_date, riddle_id, parent_channel_id, status,
         window_start_at, window_end_at, publish_marker, answer_marker,
         publish_lease_owner, publish_lease_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, event_kind, local_date) DO NOTHING`,
      [
        normalizedGuildId,
        EVENT_KIND,
        localDate,
        riddle.id,
        normalizedChannelId,
        missed ? 'missed' : 'claimed',
        window.start.toISOString(),
        window.end.toISOString(),
        publishMarker,
        answerMarker,
        leaseOwner,
        leaseUntil,
        timestamp,
        timestamp,
      ]
    );
    let acquired = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    if (!acquired && !missed) {
      api.run(
        `UPDATE daily_events
         SET publish_lease_owner = ?, publish_lease_until = ?, updated_at = ?
         WHERE guild_id = ? AND event_kind = ? AND local_date = ? AND status = 'claimed'
           AND (publish_lease_owner IS NULL OR publish_lease_until <= ?)`,
        [leaseOwner, leaseUntil, timestamp, normalizedGuildId, EVENT_KIND, localDate, timestamp]
      );
      acquired = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    }
    const row = api.get('SELECT * FROM daily_events WHERE guild_id = ? AND event_kind = ? AND local_date = ?', [
      normalizedGuildId,
      EVENT_KIND,
      localDate,
    ]);
    return { claimed: acquired, leaseOwner: acquired ? leaseOwner : null, event: mapEvent(row) };
  });
}

function safeFailure(stage, error) {
  const code = String(error?.code || error?.status || error?.name || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
  return `${stage}:${code || 'unknown'}`;
}

async function setEventFailure(
  eventId,
  stage,
  error,
  { terminal = false, now = new Date(), leaseKind = null, leaseOwner = null } = {}
) {
  const timestamp = requireNow(now).toISOString();
  const failure = safeFailure(stage, error);
  const event = await withCoinTransaction((api) => {
    const current = api.get('SELECT * FROM daily_events WHERE id = ?', [eventId]);
    if (!current) throw new DailyRiddleError('EVENT_NOT_FOUND', 'Daily event not found.');
    const ownerColumn = leaseKind === 'publish' ? 'publish_lease_owner' : leaseKind === 'settle' ? 'settle_lease_owner' : null;
    if (ownerColumn && current[ownerColumn] !== leaseOwner) return mapEvent(current);
    const attempts = Number(current.attempt_count) + 1;
    const status = terminal ? 'blocked' : attempts >= MAX_EVENT_ATTEMPTS ? (current.announcement_message_id ? 'blocked' : 'failed') : current.status;
    const clearLease = leaseKind === 'publish'
      ? ', publish_lease_owner = NULL, publish_lease_until = NULL'
      : leaseKind === 'settle'
        ? ', settle_lease_owner = NULL, settle_lease_until = NULL'
        : '';
    api.run(`UPDATE daily_events SET status = ?, attempt_count = ?, last_error = ?, updated_at = ?${clearLease} WHERE id = ?`, [
      status, attempts, failure, timestamp, eventId,
    ]);
    return mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [eventId]));
  });
  await setFeatureHealth(FEATURE_KEY, event.status === 'blocked' || event.status === 'failed' ? 'broken' : 'maintenance', {
    detail: failure,
    now,
  });
  return event;
}

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === 'function') return [...collection.values()];
  return Object.values(collection);
}

function messageFooter(message) {
  return message?.embeds?.[0]?.footer?.text || message?.embeds?.[0]?.data?.footer?.text || null;
}

async function findMarkedMessage(channel, marker, botUserId, { lowerBound, maxPages = MAX_HISTORY_PAGES } = {}) {
  if (!channel?.messages?.fetch) throw new DailyRiddleError('READ_HISTORY_UNAVAILABLE', 'Message history is unavailable.');
  const lowerBoundMs = requireNow(lowerBound).getTime();
  let before;
  for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
    const page = collectionValues(await channel.messages.fetch({ limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) }));
    const match = page.find((message) => {
      const createdMs = new Date(message.createdAt || message.createdTimestamp).getTime();
      return createdMs >= lowerBoundMs && message?.author?.id === botUserId && messageFooter(message) === marker;
    });
    if (match) return { complete: true, message: match, reason: null };
    if (page.length < HISTORY_PAGE_SIZE) return { complete: true, message: null, reason: null };
    const timestamps = page
      .map((message) => new Date(message.createdAt || message.createdTimestamp).getTime())
      .filter(Number.isFinite);
    if (timestamps.length === 0) return { complete: false, message: null, reason: 'invalid_marker_timestamp' };
    if (Math.min(...timestamps) < lowerBoundMs) return { complete: true, message: null, reason: null };
    before = page.at(-1)?.id;
    if (!before) return { complete: false, message: null, reason: 'invalid_marker_cursor' };
  }
  return { complete: false, message: null, reason: 'marker_page_limit' };
}

async function resolveGuild(client, guildId) {
  return client?.guilds?.cache?.get(guildId) || (await client?.guilds?.fetch?.(guildId)) || null;
}

async function resolveChannel(client, guild, channelId) {
  return (
    guild?.channels?.cache?.get(channelId) ||
    (await guild?.channels?.fetch?.(channelId)) ||
    client?.channels?.cache?.get?.(channelId) ||
    (await client?.channels?.fetch?.(channelId)) ||
    null
  );
}

async function resolveAnnouncementThread(client, guild, announcementId) {
  try {
    return await resolveChannel(client, guild, announcementId);
  } catch (error) {
    if (error?.code === 10003 || error?.rawError?.code === 10003) return null;
    throw error;
  }
}

function buildQuestionEmbed(event, riddle) {
  return new EmbedBuilder()
    .setColor(0xff9ecb)
    .setTitle('小吉每日猜謎')
    .setDescription(riddle.question)
    .addFields({ name: '參加方式', value: '請到本訊息的討論串回答或討論。公布答案前的有效參與可獲得 30 吉幣，答對再加 50 吉幣。' })
    .setFooter({ text: event.publishMarker });
}

function buildAnswerEmbed(event, riddle) {
  return new EmbedBuilder()
    .setColor(0x8ed7c6)
    .setTitle('小吉每日猜謎答案')
    .setDescription(`標準答案：**${riddle.canonicalAnswer}**`)
    .addFields({ name: '解說', value: riddle.explanation })
    .setFooter({ text: event.answerMarker });
}

async function persistPublishedEvent(eventId, announcementMessageId, threadId, status, now, leaseOwner) {
  const timestamp = requireNow(now).toISOString();
  return withCoinTransaction((api) => {
    api.run(
      `UPDATE daily_events
       SET announcement_message_id = ?, thread_id = ?, status = ?, published_at = COALESCE(published_at, ?),
           publish_lease_owner = NULL, publish_lease_until = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'claimed' AND publish_lease_owner = ?
         AND publish_lease_until > ? AND window_end_at > ?`,
      [announcementMessageId, threadId, status, timestamp, timestamp, eventId, leaseOwner, timestamp, timestamp]
    );
    if (Number(api.get('SELECT changes() AS count')?.count || 0) !== 1) {
      throw new DailyRiddleError('PUBLISH_LEASE_LOST', 'Daily riddle publish lease was lost.');
    }
    return mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [eventId]));
  });
}

async function revalidatePublishLease(eventId, leaseOwner, now) {
  const timestamp = requireNow(now).toISOString();
  return withCoinDatabase((api) => {
    const row = api.get('SELECT * FROM daily_events WHERE id = ?', [eventId]);
    if (!row) throw new DailyRiddleError('EVENT_NOT_FOUND', 'Daily riddle event not found.');
    const event = mapEvent(row);
    if (event.windowEndAt <= timestamp) {
      throw new DailyRiddleError('PUBLISH_WINDOW_CLOSED', 'Daily riddle publication window is closed.');
    }
    if (
      event.status !== 'claimed' ||
      event.publishLeaseOwner !== leaseOwner ||
      !event.publishLeaseUntil ||
      event.publishLeaseUntil <= timestamp
    ) {
      throw new DailyRiddleError('PUBLISH_LEASE_LOST', 'Daily riddle publish lease was lost.');
    }
    return event;
  });
}

async function cleanupUnpersistedPublication(createdThread, createdAnnouncement) {
  for (const [target, label] of [[createdThread, 'thread'], [createdAnnouncement, 'announcement']]) {
    if (!target?.delete) continue;
    try {
      await target.delete('小吉每日猜謎發布在截止或失權後清理');
    } catch (error) {
      logger.warn(`每日猜謎未持久化 ${label} 清理失敗。`, error);
    }
  }
}

async function publishDailyRiddle(
  client,
  event,
  {
    now = new Date(),
    nowFn = null,
    leaseOwner,
    afterPublishSend = null,
    afterThreadCreate = null,
    maxMarkerPages = MAX_HISTORY_PAGES,
  } = {}
) {
  const date = requireNow(now);
  const normalizedLeaseOwner = requireId(leaseOwner, 'leaseOwner');
  const wallClockStart = Date.now();
  const operationNow = () => requireNow(
    typeof nowFn === 'function' ? nowFn() : new Date(date.getTime() + (Date.now() - wallClockStart))
  );
  await revalidatePublishLease(event.id, normalizedLeaseOwner, operationNow());
  const guild = await resolveGuild(client, event.guildId);
  const channel = await resolveChannel(client, guild, event.parentChannelId);
  if (!guild || !channel?.send || !channel?.messages?.fetch) {
    throw new DailyRiddleError('PARENT_CHANNEL_UNAVAILABLE', 'Configured parent channel is unavailable.');
  }
  const riddle = riddleForId(event.riddleId);
  let createdAnnouncement = null;
  let createdThread = null;
  let announcement = event.announcementMessageId
    ? await channel.messages.fetch(event.announcementMessageId).catch(() => null)
    : null;
  if (!announcement) {
    const markerResult = await findMarkedMessage(channel, event.publishMarker, client.user.id, {
      lowerBound: event.createdAt,
      maxPages: maxMarkerPages,
    });
    if (!markerResult.complete) {
      throw new DailyRiddleError('MARKER_HISTORY_INCOMPLETE', markerResult.reason || 'Publish marker history is incomplete.');
    }
    announcement = markerResult.message;
  }
  try {
    if (!announcement) {
      await revalidatePublishLease(event.id, normalizedLeaseOwner, operationNow());
      announcement = await channel.send({ embeds: [buildQuestionEmbed(event, riddle)], allowedMentions: { parse: [] } });
      createdAnnouncement = announcement;
      if (typeof afterPublishSend === 'function') await afterPublishSend(announcement);
      await revalidatePublishLease(event.id, normalizedLeaseOwner, operationNow());
    }

    let thread = event.threadId ? await resolveChannel(client, guild, event.threadId) : announcement.thread || null;
    if (!thread && announcement.id) thread = await resolveAnnouncementThread(client, guild, announcement.id);
    if (!thread) {
      await revalidatePublishLease(event.id, normalizedLeaseOwner, operationNow());
      if (typeof announcement.startThread !== 'function') {
        throw new DailyRiddleError('CREATE_THREAD_UNAVAILABLE', 'Cannot create a public riddle thread.');
      }
      thread = await announcement.startThread({
        name: `每日猜謎 ${event.localDate}`,
        autoArchiveDuration: 1440,
        reason: '小吉每日猜謎',
      });
      createdThread = thread;
      if (typeof afterThreadCreate === 'function') await afterThreadCreate(thread);
    }
    if (!thread?.id) throw new DailyRiddleError('THREAD_UNAVAILABLE', 'Riddle thread is unavailable.');

    const persistNow = operationNow();
    await revalidatePublishLease(event.id, normalizedLeaseOwner, persistNow);
    const status = date.getTime() > new Date(event.windowStartAt).getTime() ? 'published_late' : 'published';
    const persisted = await persistPublishedEvent(
      event.id, announcement.id, thread.id, status, persistNow, normalizedLeaseOwner
    );
    await setFeatureHealth(FEATURE_KEY, 'normal', { detail: null, now: persistNow });
    return persisted;
  } catch (error) {
    if (error?.code === 'PUBLISH_LEASE_LOST' || error?.code === 'PUBLISH_WINDOW_CLOSED') {
      await cleanupUnpersistedPublication(createdThread, createdAnnouncement);
      const failureNow = operationNow();
      if (error.code === 'PUBLISH_WINDOW_CLOSED') {
        await fenceClaimedEventAtCutoff(event.id, failureNow);
      }
      await setFeatureHealth(FEATURE_KEY, 'maintenance', {
        detail: error.code.toLowerCase(),
        now: failureNow,
      });
    }
    throw error;
  }
}

async function recordDailyRiddleMessage({
  guildId,
  threadId,
  messageId,
  userId,
  content,
  createdAt = new Date(),
  settlementLeaseOwner = null,
  operationNow = new Date(),
}) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedThreadId = requireId(threadId, 'threadId');
  const normalizedMessageId = requireId(messageId, 'messageId');
  const normalizedUserId = requireId(userId, 'userId');
  const timestamp = requireNow(createdAt).toISOString();
  const operationTimestamp = requireNow(operationNow).toISOString();

  return withCoinTransaction((api) => {
    const row = api.get(
      `SELECT * FROM daily_events
       WHERE guild_id = ? AND event_kind = ? AND thread_id = ?
       ORDER BY id DESC LIMIT 1`,
      [normalizedGuildId, EVENT_KIND, normalizedThreadId]
    );
    if (!row) return { inRiddleThread: false, recorded: false, eligible: false, correct: false };
    const event = mapEvent(row);
    const gatewayWritable = event.status === 'published' || event.status === 'published_late';
    const settlementWritable =
      event.status === 'settling' &&
      settlementLeaseOwner &&
      event.settleLeaseOwner === settlementLeaseOwner &&
      event.settleLeaseUntil > operationTimestamp;
    if (!gatewayWritable && !settlementWritable) {
      return { inRiddleThread: true, recorded: false, eligible: false, correct: false, event };
    }
    const createdMs = new Date(timestamp).getTime();
    if (createdMs < new Date(event.windowStartAt).getTime() || createdMs >= new Date(event.windowEndAt).getTime()) {
      return { inRiddleThread: true, recorded: false, eligible: false, correct: false, event };
    }
    const riddle = riddleForId(event.riddleId);
    const correct = isCorrectDailyRiddleAnswer(content, riddle);
    const eligible = correct || isEligibleRiddleMessage(content, riddle);
    api.run(
      `INSERT INTO daily_event_messages
        (event_id, guild_id, thread_id, message_id, user_id, created_at, eligible, correct)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(event_id, message_id) DO NOTHING`,
      [event.id, normalizedGuildId, normalizedThreadId, normalizedMessageId, normalizedUserId, timestamp, eligible ? 1 : 0, correct ? 1 : 0]
    );
    const inserted = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    if (inserted && eligible) {
      api.run(
        `INSERT INTO daily_event_participants
          (event_id, guild_id, user_id, eligible, correct, participation_reward_status, correct_reward_status, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, 'pending', ?, ?, ?)
         ON CONFLICT(event_id, user_id) DO UPDATE SET
           eligible = 1,
           correct = MAX(daily_event_participants.correct, excluded.correct),
           correct_reward_status = CASE
             WHEN excluded.correct = 1 AND daily_event_participants.correct_reward_status = 'not_earned' THEN 'pending'
             ELSE daily_event_participants.correct_reward_status
           END,
           updated_at = excluded.updated_at`,
        [event.id, normalizedGuildId, normalizedUserId, correct ? 1 : 0, correct ? 'pending' : 'not_earned', timestamp, timestamp]
      );
    }
    return { inRiddleThread: true, recorded: inserted, eligible, correct, event };
  });
}

async function handleDailyRiddleMessage(message) {
  const result = await recordDailyRiddleMessage({
    guildId: message.guildId,
    threadId: message.channelId,
    messageId: message.id,
    userId: message.author.id,
    content: message.content,
    createdAt: message.createdAt || message.createdTimestamp || new Date(),
  });
  if (!result.inRiddleThread) return false;
  const explicitlyMentioned = Boolean(message.client?.user?.id && message.mentions?.has?.(message.client.user.id));
  return !explicitlyMentioned;
}

async function reconcileRiddleHistory(event, thread, { maxPages = MAX_HISTORY_PAGES, leaseOwner, now = new Date() } = {}) {
  if (!thread?.messages?.fetch) return { complete: false, reason: 'history_unavailable', messages: 0 };
  const startMs = new Date(event.windowStartAt).getTime();
  const endMs = new Date(event.windowEndAt).getTime();
  let before;
  let recorded = 0;

  try {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = collectionValues(
        await thread.messages.fetch({ limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) })
      );
      for (const message of page) {
        const createdAt = message.createdAt || message.createdTimestamp;
        const createdMs = new Date(createdAt).getTime();
        if (
          message?.author?.bot ||
          !message?.author?.id ||
          !Number.isFinite(createdMs) ||
          createdMs < startMs ||
          createdMs >= endMs
        ) {
          continue;
        }
        const result = await recordDailyRiddleMessage({
          guildId: event.guildId,
          threadId: event.threadId,
          messageId: message.id,
          userId: message.author.id,
          content: message.content,
          createdAt,
          settlementLeaseOwner: leaseOwner,
          operationNow: now,
        });
        if (result.recorded) recorded += 1;
      }
      if (page.length < HISTORY_PAGE_SIZE) return { complete: true, reason: null, messages: recorded };
      const timestamps = page.map((message) => new Date(message.createdAt || message.createdTimestamp).getTime()).filter(Number.isFinite);
      if (timestamps.length === 0) return { complete: false, reason: 'invalid_history_timestamp', messages: recorded };
      if (Math.min(...timestamps) <= startMs) return { complete: true, reason: null, messages: recorded };
      before = page.at(-1)?.id;
      if (!before) return { complete: false, reason: 'invalid_history_cursor', messages: recorded };
    }
  } catch (error) {
    return { complete: false, reason: safeFailure('history', error), messages: recorded };
  }
  return { complete: false, reason: 'history_page_limit', messages: recorded };
}

async function claimDailyRiddleSettlement(eventId, now) {
  const date = requireNow(now);
  const leaseOwner = randomUUID();
  const leaseUntil = new Date(date.getTime() + LEASE_MS).toISOString();
  const timestamp = date.toISOString();
  return withCoinTransaction((api) => {
    api.run(
      `UPDATE daily_events
       SET status = CASE WHEN status = 'rewarding' THEN 'rewarding' ELSE 'settling' END,
           settle_lease_owner = ?, settle_lease_until = ?, updated_at = ?
       WHERE id = ?
         AND (
           status IN ('published', 'published_late') OR
           (status IN ('settling', 'rewarding') AND (settle_lease_owner IS NULL OR settle_lease_until <= ?))
         )`,
      [leaseOwner, leaseUntil, timestamp, eventId, timestamp]
    );
    const claimed = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    return {
      claimed,
      leaseOwner: claimed ? leaseOwner : null,
      event: mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [eventId])),
    };
  });
}

async function freezeDailyRiddleParticipants(eventId, leaseOwner, now) {
  const timestamp = requireNow(now).toISOString();
  return withCoinTransaction((api) => {
    api.run(
      `UPDATE daily_events
       SET status = 'rewarding', history_reconciled_at = ?, updated_at = ?
       WHERE id = ? AND status = 'settling' AND settle_lease_owner = ? AND settle_lease_until > ?`,
      [timestamp, timestamp, eventId, leaseOwner, timestamp]
    );
    if (Number(api.get('SELECT changes() AS count')?.count || 0) !== 1) {
      throw new DailyRiddleError('SETTLE_LEASE_LOST', 'Daily riddle settlement lease was lost before freeze.');
    }
    return mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [eventId]));
  });
}

async function persistAnswerMessage(eventId, messageId, now, leaseOwner) {
  const timestamp = requireNow(now).toISOString();
  return withCoinTransaction((api) => {
    api.run(`UPDATE daily_events SET answer_message_id = ?, updated_at = ?
             WHERE id = ? AND status = 'rewarding' AND settle_lease_owner = ? AND settle_lease_until > ?`, [
      requireId(messageId, 'messageId'),
      timestamp,
      eventId,
      leaseOwner,
      timestamp,
    ]);
    if (Number(api.get('SELECT changes() AS count')?.count || 0) !== 1) {
      throw new DailyRiddleError('SETTLE_LEASE_LOST', 'Daily riddle settlement lease was lost before answer persistence.');
    }
    return mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [eventId]));
  });
}

async function grantRiddleRewards(event, now, { afterRewardGrant = null } = {}) {
  const participants = await withCoinDatabase((api) =>
    api.all('SELECT * FROM daily_event_participants WHERE event_id = ? AND eligible = 1 ORDER BY user_id', [event.id])
  );
  for (const participant of participants) {
    const participation = await grantRewardOnce(event.guildId, participant.user_id, FEATURE_KEY, String(event.id), 'participation', PARTICIPATION_REWARD, {
      localDate: event.localDate,
      corpusVersion,
    });
    if (typeof afterRewardGrant === 'function') {
      await afterRewardGrant({ participant, rewardKind: 'participation', result: participation });
    }
    await withCoinTransaction((api) =>
      api.run(
        "UPDATE daily_event_participants SET participation_reward_status = 'granted', updated_at = ? WHERE event_id = ? AND user_id = ?",
        [requireNow(now).toISOString(), event.id, participant.user_id]
      )
    );
    if (Number(participant.correct) === 1) {
      const correct = await grantRewardOnce(event.guildId, participant.user_id, FEATURE_KEY, String(event.id), 'correct_answer', CORRECT_REWARD, {
        localDate: event.localDate,
        corpusVersion,
      });
      if (typeof afterRewardGrant === 'function') {
        await afterRewardGrant({ participant, rewardKind: 'correct_answer', result: correct });
      }
      await withCoinTransaction((api) =>
        api.run(
          "UPDATE daily_event_participants SET correct_reward_status = 'granted', updated_at = ? WHERE event_id = ? AND user_id = ?",
          [requireNow(now).toISOString(), event.id, participant.user_id]
        )
      );
    }
  }
  return participants.length;
}

async function settleDailyRiddle(
  client,
  event,
  {
    now = new Date(),
    leaseOwner,
    afterAnswerSend = null,
    afterRewardGrant = null,
    maxHistoryPages,
    maxMarkerPages = MAX_HISTORY_PAGES,
  } = {}
) {
  const date = requireNow(now);
  const normalizedLeaseOwner = requireId(leaseOwner, 'leaseOwner');
  let settling = event;
  if (
    !['settling', 'rewarding'].includes(settling.status) ||
    settling.settleLeaseOwner !== normalizedLeaseOwner ||
    new Date(settling.settleLeaseUntil).getTime() <= date.getTime()
  ) {
    throw new DailyRiddleError('SETTLE_LEASE_LOST', 'Daily riddle settlement lease is not held.');
  }
  const guild = await resolveGuild(client, settling.guildId);
  const thread = await resolveChannel(client, guild, settling.threadId);
  if (!guild || !thread?.send || !thread?.messages?.fetch) {
    throw new DailyRiddleError('THREAD_UNAVAILABLE', 'Riddle thread is unavailable for settlement.');
  }
  if (settling.status === 'settling') {
    const history = await reconcileRiddleHistory(settling, thread, {
      maxPages: maxHistoryPages || MAX_HISTORY_PAGES,
      leaseOwner: normalizedLeaseOwner,
      now: date,
    });
    if (!history.complete) {
      const error = new DailyRiddleError('HISTORY_INCOMPLETE', history.reason || 'Riddle history is incomplete.');
      await setEventFailure(settling.id, 'history_incomplete', error, {
        terminal: true,
        now: date,
        leaseKind: 'settle',
        leaseOwner: normalizedLeaseOwner,
      });
      return { settled: false, blocked: true, reason: history.reason, rewarded: 0 };
    }
    settling = await freezeDailyRiddleParticipants(settling.id, normalizedLeaseOwner, date);
  }

  const economyEnabled = await withCoinTransaction((api) => {
    const timestamp = date.toISOString();
    api.run(
      `INSERT INTO coin_guild_settings (guild_id, created_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(guild_id) DO NOTHING`,
      [settling.guildId, timestamp, timestamp]
    );
    return Number(api.get('SELECT enabled FROM coin_guild_settings WHERE guild_id = ?', [settling.guildId])?.enabled) === 1;
  });
  if (!economyEnabled) {
    const error = new DailyRiddleError('COIN_DISABLED', 'Guild coin system is disabled.');
    await setEventFailure(settling.id, 'reward_preflight', error, {
      terminal: true,
      now: date,
      leaseKind: 'settle',
      leaseOwner: normalizedLeaseOwner,
    });
    return { settled: false, blocked: true, reason: 'coin_disabled', rewarded: 0 };
  }

  const riddle = riddleForId(settling.riddleId);
  let answerMessage = settling.answerMessageId
    ? await thread.messages.fetch(settling.answerMessageId).catch(() => null)
    : null;
  if (!answerMessage) {
    const markerResult = await findMarkedMessage(thread, settling.answerMarker, client.user.id, {
      lowerBound: settling.windowEndAt,
      maxPages: maxMarkerPages,
    });
    if (!markerResult.complete) {
      const error = new DailyRiddleError('MARKER_HISTORY_INCOMPLETE', markerResult.reason || 'Answer marker history is incomplete.');
      await setEventFailure(settling.id, 'answer_marker_incomplete', error, {
        terminal: true,
        now: date,
        leaseKind: 'settle',
        leaseOwner: normalizedLeaseOwner,
      });
      return { settled: false, blocked: true, reason: markerResult.reason, rewarded: 0 };
    }
    answerMessage = markerResult.message;
  }
  if (!answerMessage) {
    answerMessage = await thread.send({ embeds: [buildAnswerEmbed(settling, riddle)], allowedMentions: { parse: [] } });
    if (typeof afterAnswerSend === 'function') await afterAnswerSend(answerMessage);
  }
  settling = await persistAnswerMessage(settling.id, answerMessage.id, date, normalizedLeaseOwner);
  const rewarded = await grantRiddleRewards(settling, date, { afterRewardGrant });
  const timestamp = date.toISOString();
  settling = await withCoinTransaction((api) => {
    api.run(
      `UPDATE daily_events
       SET status = 'settled', settled_at = ?, settle_lease_owner = NULL, settle_lease_until = NULL,
           last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'rewarding' AND settle_lease_owner = ? AND settle_lease_until > ?`,
      [timestamp, timestamp, settling.id, normalizedLeaseOwner, timestamp]
    );
    if (Number(api.get('SELECT changes() AS count')?.count || 0) !== 1) {
      throw new DailyRiddleError('SETTLE_LEASE_LOST', 'Daily riddle settlement lease was lost before completion.');
    }
    return mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [settling.id]));
  });
  await setFeatureHealth(FEATURE_KEY, 'normal', { detail: null, now: date });
  return { settled: true, blocked: false, rewarded, event: settling };
}

async function listEnabledRiddleSettings(localDate, limit) {
  return withCoinDatabase((api) =>
    api.all(
      `SELECT settings.guild_id, settings.channel_id
       FROM feature_guild_settings AS settings
       LEFT JOIN daily_events AS event
         ON event.guild_id = settings.guild_id AND event.event_kind = ? AND event.local_date = ?
       WHERE settings.feature_key = ? AND settings.enabled = 1 AND settings.channel_id IS NOT NULL
       ORDER BY CASE WHEN event.id IS NULL THEN 0 ELSE 1 END, settings.guild_id
       LIMIT ?`,
      [EVENT_KIND, localDate, FEATURE_KEY, limit]
    )
  );
}

async function listDueRiddleEvents(now, limit) {
  return withCoinDatabase((api) =>
    api
      .all(
        `SELECT * FROM daily_events
         WHERE event_kind = ? AND status IN ('published', 'published_late', 'settling', 'rewarding') AND window_end_at <= ?
         ORDER BY window_end_at, id LIMIT ?`,
        [EVENT_KIND, requireNow(now).toISOString(), limit]
      )
      .map(mapEvent)
  );
}

async function fenceClaimedEventAtCutoff(eventId, now) {
  const timestamp = requireNow(now).toISOString();
  return withCoinTransaction((api) => {
    const observed = api.get('SELECT * FROM daily_events WHERE id = ?', [eventId]);
    if (!observed || observed.status !== 'claimed' || observed.window_end_at > timestamp) {
      return { fenced: false, event: mapEvent(observed) };
    }
    api.run(
      `UPDATE daily_events
       SET status = 'missed', publish_lease_owner = NULL, publish_lease_until = NULL,
           last_error = 'publish_window_closed', updated_at = ?
       WHERE id = ? AND status = 'claimed' AND window_end_at <= ?
         AND publish_lease_owner IS ? AND publish_lease_until IS ?`,
      [timestamp, eventId, timestamp, observed.publish_lease_owner, observed.publish_lease_until]
    );
    const fenced = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    return { fenced, event: mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [eventId])) };
  });
}

async function processDailyRiddleTick(client, { now = new Date(), maxGuilds = 100, hooks = {} } = {}) {
  const date = requireNow(now);
  const localDate = getTaipeiDateKey(date);
  const phase = getRiddlePhase(date);
  const summary = { phase, claimed: 0, published: 0, missed: 0, settled: 0, blocked: 0, failed: 0 };
  const settings = phase === 'before' ? [] : await listEnabledRiddleSettings(localDate, maxGuilds);

  if (phase === 'open') {
    for (const setting of settings) {
      const claimed = await claimDailyRiddleEvent({
        guildId: setting.guild_id,
        parentChannelId: setting.channel_id,
        localDate,
        now: date,
      });
      if (claimed.claimed) summary.claimed += 1;
      if (!claimed.claimed) continue;
      try {
        await publishDailyRiddle(client, claimed.event, { now: date, leaseOwner: claimed.leaseOwner, ...hooks });
        summary.published += 1;
      } catch (error) {
        const failed = await setEventFailure(claimed.event.id, 'publish', error, {
          terminal: error?.code === 'MARKER_HISTORY_INCOMPLETE',
          now: date,
          leaseKind: 'publish',
          leaseOwner: claimed.leaseOwner,
        });
        if (failed.status === 'failed') summary.failed += 1;
        logger.warn('每日猜謎發布失敗，將依有界次數重試。', error);
      }
    }
  }

  if (phase === 'settlement') {
    for (const setting of settings) {
      const claimed = await claimDailyRiddleEvent({
        guildId: setting.guild_id,
        parentChannelId: setting.channel_id,
        localDate,
        now: date,
        missed: true,
      });
      if (claimed.claimed) summary.missed += 1;
      else if (claimed.event.status === 'claimed') {
        const fenced = await fenceClaimedEventAtCutoff(claimed.event.id, date);
        if (fenced.fenced) summary.missed += 1;
      }
    }
  }

  const dueEvents = await listDueRiddleEvents(date, maxGuilds);
  for (const event of dueEvents) {
    const settlementClaim = await claimDailyRiddleSettlement(event.id, date);
    if (!settlementClaim.claimed) continue;
    try {
      const result = await settleDailyRiddle(client, settlementClaim.event, {
        now: date,
        leaseOwner: settlementClaim.leaseOwner,
        ...hooks,
      });
      if (result.settled) summary.settled += 1;
      if (result.blocked) summary.blocked += 1;
    } catch (error) {
      const failed = await setEventFailure(event.id, 'settle', error, {
        now: date,
        leaseKind: 'settle',
        leaseOwner: settlementClaim.leaseOwner,
      });
      if (failed.status === 'blocked') summary.blocked += 1;
      else summary.failed += 1;
      logger.warn('每日猜謎結算失敗，將依有界次數重試。', error);
    }
  }
  return summary;
}

function getNextRiddleBoundaryDelay(now = new Date()) {
  const date = requireNow(now);
  return Math.min(
    ...TAIPEI_BOUNDARY_MINUTES.map((minute) =>
      getNextTaipeiOccurrence(Math.floor(minute / 60), minute % 60, date).getTime() - date.getTime()
    )
  );
}

async function startDailyRiddleScheduler(client, options = {}) {
  if (schedulerState) return schedulerState;
  const {
    nowFn = () => new Date(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    intervalMs = SCHEDULER_INTERVAL_MS,
    tick = processDailyRiddleTick,
  } = options;
  let tickRunning = false;
  const runTick = async () => {
    if (tickRunning) return;
    tickRunning = true;
    try {
      await tick(client, { now: nowFn() });
    } finally {
      tickRunning = false;
    }
  };
  await runTick();
  const scheduleBoundary = () => {
    const delay = getNextRiddleBoundaryDelay(nowFn());
    const boundaryTimer = setTimeoutFn(() => {
      void runTick()
        .catch((error) => logger.error('每日猜謎邊界排程執行失敗。', error))
        .finally(() => {
          if (schedulerState) scheduleBoundary();
        });
    }, delay);
    boundaryTimer.unref?.();
    if (schedulerState) schedulerState.boundaryTimer = boundaryTimer;
    return boundaryTimer;
  };
  const watchdogTimer = setIntervalFn(() => {
    void runTick().catch((error) => logger.error('每日猜謎排程執行失敗。', error));
  }, intervalMs);
  watchdogTimer.unref?.();
  schedulerState = {
    boundaryTimer: null,
    watchdogTimer,
    clearTimeoutFn,
    clearIntervalFn,
  };
  schedulerState.boundaryTimer = scheduleBoundary();
  return schedulerState;
}

function stopDailyRiddleScheduler(overrides = {}) {
  if (!schedulerState) return false;
  const state = schedulerState;
  schedulerState = null;
  (overrides.clearTimeoutFn || state.clearTimeoutFn)(state.boundaryTimer);
  (overrides.clearIntervalFn || state.clearIntervalFn)(state.watchdogTimer);
  return true;
}

module.exports = {
  CORRECT_REWARD,
  DailyRiddleError,
  FEATURE_KEY,
  MAX_EVENT_ATTEMPTS,
  PARTICIPATION_REWARD,
  PUBLISH_MINUTE,
  SCHEDULER_INTERVAL_MS,
  SETTLE_MINUTE,
  buildAnswerEmbed,
  buildQuestionEmbed,
  claimDailyRiddleEvent,
  claimDailyRiddleSettlement,
  getDailyRiddleEvent,
  getNextRiddleBoundaryDelay,
  getRiddlePhase,
  getRiddleWindow,
  handleDailyRiddleMessage,
  isCorrectDailyRiddleAnswer,
  isEligibleRiddleMessage,
  normalizeDailyRiddleAnswer,
  processDailyRiddleTick,
  publishDailyRiddle,
  reconcileRiddleHistory,
  recordDailyRiddleMessage,
  settleDailyRiddle,
  startDailyRiddleScheduler,
  stopDailyRiddleScheduler,
};
