const { createHash, randomUUID } = require('node:crypto');
const { EmbedBuilder } = require('discord.js');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const { grantRewardOnce, setFeatureHealth } = require('./featurePlatformService');
const { corpusVersion, selectDiscussionForDate, topics } = require('./dailyDiscussionCorpus');
const { getNextTaipeiOccurrence, getTaipeiDateKey, getTaipeiDayRange } = require('../utils/taipeiClock');
const logger = require('../utils/logger');

const FEATURE_KEY = 'daily_discussion';
const EVENT_KIND = 'discussion';
const PARTICIPATION_REWARD = 30;
const MAX_EVENT_ATTEMPTS = 3;
const MAX_HISTORY_PAGES = 20;
const HISTORY_PAGE_SIZE = 100;
const SCHEDULER_INTERVAL_MS = 60_000;
const LEASE_MS = 15 * 60_000;
const graphemeSegmenter = new Intl.Segmenter('zh-TW', { granularity: 'grapheme' });
let schedulerState = null;

class DailyDiscussionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DailyDiscussionError';
    this.code = code;
  }
}

function requireId(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > 100) {
    throw new DailyDiscussionError('INVALID_ARGUMENT', `${name} is required.`);
  }
  return normalized;
}

function requireNow(now) {
  const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
  if (Number.isNaN(date.getTime())) throw new DailyDiscussionError('INVALID_ARGUMENT', 'now must be valid.');
  return date;
}

function topicForId(topicId) {
  const topic = topics.find((entry) => entry.id === topicId);
  if (!topic) throw new DailyDiscussionError('TOPIC_NOT_FOUND', 'The persisted topic id is not in the curated corpus.');
  return topic;
}

function getDiscussionWindow(localDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(localDate))) {
    throw new DailyDiscussionError('INVALID_LOCAL_DATE', 'localDate must use YYYY-MM-DD.');
  }
  const probe = new Date(Date.parse(`${localDate}T00:00:00.000Z`) - 8 * 60 * 60 * 1000);
  if (Number.isNaN(probe.getTime()) || getTaipeiDateKey(probe) !== localDate) {
    throw new DailyDiscussionError('INVALID_LOCAL_DATE', 'localDate is invalid.');
  }
  return getTaipeiDayRange(probe);
}

function getPreviousTaipeiDateKey(now = new Date()) {
  const current = getTaipeiDayRange(requireNow(now));
  return getTaipeiDateKey(new Date(current.start.getTime() - 1));
}

function isEligibleDiscussionMessage(content) {
  const normalized = String(content ?? '')
    .normalize('NFKC')
    .replace(/<@!?\d+>|<@&\d+>|<#\d+>|<a?:[A-Za-z0-9_]+:\d+>/g, ' ')
    .trim();
  const graphemes = Array.from(graphemeSegmenter.segment(normalized));
  const meaningful = Array.from(normalized.matchAll(/[\p{L}\p{N}]/gu), (match) => match[0]);
  if (!normalized || normalized.length > 2000 || graphemes.length < 4 || meaningful.length < 2) return false;
  if (/^(.{1,3})\1+$/u.test(meaningful.join(''))) return false;
  return true;
}

function stableMarker(kind, guildId, localDate, topicId) {
  const digest = createHash('sha256')
    .update(`${corpusVersion}|${kind}|${guildId}|${localDate}|${topicId}`, 'utf8')
    .digest('hex')
    .slice(0, 24);
  return `xiaoji-daily-discussion:${kind}:${digest}`;
}

function mapEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    eventKind: row.event_kind,
    localDate: row.local_date,
    topicId: row.riddle_id,
    parentChannelId: row.parent_channel_id,
    announcementMessageId: row.announcement_message_id || null,
    threadId: row.thread_id || null,
    status: row.status,
    windowStartAt: row.window_start_at,
    windowEndAt: row.window_end_at,
    publishMarker: row.publish_marker,
    settlementMarker: row.answer_marker,
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

async function getDailyDiscussionEvent(guildId, localDate = getTaipeiDateKey()) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  return withCoinDatabase((api) => mapEvent(api.get(
    'SELECT * FROM daily_events WHERE guild_id = ? AND event_kind = ? AND local_date = ?',
    [normalizedGuildId, EVENT_KIND, localDate]
  )));
}

async function claimDailyDiscussionEvent({ guildId, parentChannelId, localDate, now = new Date(), missed = false }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(parentChannelId, 'parentChannelId');
  const date = requireNow(now);
  const topic = selectDiscussionForDate(localDate);
  const window = getDiscussionWindow(localDate);
  const timestamp = date.toISOString();
  const leaseOwner = missed ? null : randomUUID();
  const leaseUntil = missed ? null : new Date(date.getTime() + LEASE_MS).toISOString();

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
        topic.id,
        normalizedChannelId,
        missed ? 'missed' : 'claimed',
        window.start.toISOString(),
        window.endExclusive.toISOString(),
        stableMarker('publish', normalizedGuildId, localDate, topic.id),
        stableMarker('settle', normalizedGuildId, localDate, topic.id),
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
    const event = mapEvent(api.get(
      'SELECT * FROM daily_events WHERE guild_id = ? AND event_kind = ? AND local_date = ?',
      [normalizedGuildId, EVENT_KIND, localDate]
    ));
    return { claimed: acquired, leaseOwner: acquired ? leaseOwner : null, event };
  });
}

function safeFailure(stage, error) {
  const code = String(error?.code || error?.status || error?.name || 'unknown')
    .replace(/[^A-Za-z0-9_-]/g, '')
    .slice(0, 60);
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
    const current = api.get('SELECT * FROM daily_events WHERE id = ? AND event_kind = ?', [eventId, EVENT_KIND]);
    if (!current) throw new DailyDiscussionError('EVENT_NOT_FOUND', 'Daily discussion event not found.');
    const ownerColumn = leaseKind === 'publish' ? 'publish_lease_owner' : leaseKind === 'settle' ? 'settle_lease_owner' : null;
    if (ownerColumn && current[ownerColumn] !== leaseOwner) return mapEvent(current);
    const attempts = Number(current.attempt_count) + 1;
    const nextStatus = terminal
      ? 'blocked'
      : attempts >= MAX_EVENT_ATTEMPTS
        ? (current.announcement_message_id ? 'blocked' : 'failed')
        : current.status;
    const clearLease = leaseKind === 'publish'
      ? ', publish_lease_owner = NULL, publish_lease_until = NULL'
      : leaseKind === 'settle'
        ? ', settle_lease_owner = NULL, settle_lease_until = NULL'
        : '';
    api.run(`UPDATE daily_events SET status = ?, attempt_count = ?, last_error = ?, updated_at = ?${clearLease}
             WHERE id = ? AND event_kind = ?`, [nextStatus, attempts, failure, timestamp, eventId, EVENT_KIND]);
    return mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [eventId]));
  });
  await setFeatureHealth(FEATURE_KEY, ['blocked', 'failed'].includes(event.status) ? 'broken' : 'maintenance', {
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
  if (!channel?.messages?.fetch) throw new DailyDiscussionError('READ_HISTORY_UNAVAILABLE', 'Message history is unavailable.');
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
  return guild?.channels?.cache?.get(channelId) ||
    (await guild?.channels?.fetch?.(channelId)) ||
    client?.channels?.cache?.get?.(channelId) ||
    (await client?.channels?.fetch?.(channelId)) ||
    null;
}

async function resolveAnnouncementThread(client, guild, announcementId) {
  try {
    return await resolveChannel(client, guild, announcementId);
  } catch (error) {
    if (error?.code === 10003 || error?.rawError?.code === 10003) return null;
    throw error;
  }
}

function buildDiscussionEmbed(event, topic) {
  return new EmbedBuilder()
    .setColor(0xf5a9c7)
    .setTitle('小吉每日議題討論')
    .setDescription(topic.question)
    .addFields(
      { name: '參加方式', value: '請到本訊息的討論串發表有實質內容的意見、討論或辯論；當日有效參與者可獲得 30 吉幣。' },
      { name: '安全提醒', value: topic.safetyReminder }
    )
    .setFooter({ text: event.publishMarker });
}

async function persistPublishedEvent(eventId, announcementMessageId, threadId, status, now, leaseOwner) {
  const timestamp = requireNow(now).toISOString();
  return withCoinTransaction((api) => {
    api.run(
      `UPDATE daily_events
       SET announcement_message_id = ?, thread_id = ?, status = ?, published_at = COALESCE(published_at, ?),
           publish_lease_owner = NULL, publish_lease_until = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND event_kind = ? AND status = 'claimed' AND publish_lease_owner = ?
         AND publish_lease_until > ? AND window_end_at > ?`,
      [announcementMessageId, threadId, status, timestamp, timestamp, eventId, EVENT_KIND, leaseOwner, timestamp, timestamp]
    );
    if (Number(api.get('SELECT changes() AS count')?.count || 0) !== 1) {
      throw new DailyDiscussionError('PUBLISH_LEASE_LOST', 'Daily discussion publish lease was lost.');
    }
    return mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [eventId]));
  });
}

async function revalidatePublishLease(eventId, leaseOwner, now) {
  const timestamp = requireNow(now).toISOString();
  return withCoinDatabase((api) => {
    const event = mapEvent(api.get('SELECT * FROM daily_events WHERE id = ? AND event_kind = ?', [eventId, EVENT_KIND]));
    if (!event) throw new DailyDiscussionError('EVENT_NOT_FOUND', 'Daily discussion event not found.');
    if (event.windowEndAt <= timestamp) {
      throw new DailyDiscussionError('PUBLISH_WINDOW_CLOSED', 'Daily discussion publication window is closed.');
    }
    if (
      event.status !== 'claimed' ||
      event.publishLeaseOwner !== leaseOwner ||
      !event.publishLeaseUntil ||
      event.publishLeaseUntil <= timestamp
    ) {
      throw new DailyDiscussionError('PUBLISH_LEASE_LOST', 'Daily discussion publish lease was lost.');
    }
    return event;
  });
}

async function cleanupUnpersistedPublication(createdThread, createdAnnouncement) {
  for (const [target, label] of [[createdThread, 'thread'], [createdAnnouncement, 'announcement']]) {
    if (!target?.delete) continue;
    try {
      await target.delete('小吉每日議題發布在截止或失權後清理');
    } catch (error) {
      logger.warn(`每日議題未持久化 ${label} 清理失敗。`, error);
    }
  }
}

async function fenceClaimedDiscussionAtCutoff(
  eventId,
  now,
  { announcementMessageId = null, threadId = null } = {}
) {
  const timestamp = requireNow(now).toISOString();
  return withCoinTransaction((api) => {
    const observed = api.get('SELECT * FROM daily_events WHERE id = ? AND event_kind = ?', [eventId, EVENT_KIND]);
    if (!observed || observed.window_end_at > timestamp) {
      return { fenced: false, cleanupAuthorized: false, event: mapEvent(observed) };
    }
    const createdIdsWerePersisted = (
      (announcementMessageId && observed.announcement_message_id === announcementMessageId) ||
      (threadId && observed.thread_id === threadId)
    );
    if (createdIdsWerePersisted) {
      return { fenced: false, cleanupAuthorized: false, event: mapEvent(observed) };
    }
    if (observed.status !== 'claimed') {
      return {
        fenced: false,
        cleanupAuthorized: observed.status === 'missed' && Boolean(announcementMessageId || threadId),
        event: mapEvent(observed),
      };
    }
    api.run(
      `UPDATE daily_events
       SET status = 'missed', publish_lease_owner = NULL, publish_lease_until = NULL,
           last_error = 'publish_window_closed', updated_at = ?
       WHERE id = ? AND event_kind = ? AND status = 'claimed' AND window_end_at <= ?
         AND publish_lease_owner IS ? AND publish_lease_until IS ?
         AND announcement_message_id IS ? AND thread_id IS ?`,
      [
        timestamp,
        eventId,
        EVENT_KIND,
        timestamp,
        observed.publish_lease_owner,
        observed.publish_lease_until,
        observed.announcement_message_id,
        observed.thread_id,
      ]
    );
    const fenced = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    return {
      fenced,
      cleanupAuthorized: fenced && Boolean(announcementMessageId || threadId),
      event: mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [eventId])),
    };
  });
}

async function publishDailyDiscussion(
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
    throw new DailyDiscussionError('PARENT_CHANNEL_UNAVAILABLE', 'Configured parent channel is unavailable.');
  }
  const topic = topicForId(event.topicId);
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
      throw new DailyDiscussionError('MARKER_HISTORY_INCOMPLETE', markerResult.reason || 'Publish marker history is incomplete.');
    }
    announcement = markerResult.message;
  }
  try {
    if (!announcement) {
      await revalidatePublishLease(event.id, normalizedLeaseOwner, operationNow());
      announcement = await channel.send({ embeds: [buildDiscussionEmbed(event, topic)], allowedMentions: { parse: [] } });
      createdAnnouncement = announcement;
      if (typeof afterPublishSend === 'function') await afterPublishSend(announcement);
      await revalidatePublishLease(event.id, normalizedLeaseOwner, operationNow());
    }

    let thread = event.threadId ? await resolveChannel(client, guild, event.threadId) : announcement.thread || null;
    if (!thread && announcement.id) thread = await resolveAnnouncementThread(client, guild, announcement.id);
    if (!thread) {
      await revalidatePublishLease(event.id, normalizedLeaseOwner, operationNow());
      if (typeof announcement.startThread !== 'function') {
        throw new DailyDiscussionError('CREATE_THREAD_UNAVAILABLE', 'Cannot create a public discussion thread.');
      }
      thread = await announcement.startThread({
        name: `每日議題 ${event.localDate}`,
        autoArchiveDuration: 1440,
        reason: '小吉每日議題討論',
      });
      createdThread = thread;
      if (typeof afterThreadCreate === 'function') await afterThreadCreate(thread);
    }
    if (!thread?.id) throw new DailyDiscussionError('THREAD_UNAVAILABLE', 'Discussion thread is unavailable.');

    const persistNow = operationNow();
    await revalidatePublishLease(event.id, normalizedLeaseOwner, persistNow);
    const status = date.getTime() > new Date(event.windowStartAt).getTime() ? 'published_late' : 'published';
    const persisted = await persistPublishedEvent(
      event.id,
      announcement.id,
      thread.id,
      status,
      persistNow,
      normalizedLeaseOwner
    );
    await setFeatureHealth(FEATURE_KEY, 'normal', { detail: null, now: persistNow });
    return persisted;
  } catch (error) {
    if (error?.code === 'PUBLISH_LEASE_LOST' || error?.code === 'PUBLISH_WINDOW_CLOSED') {
      const failureNow = operationNow();
      if (error.code === 'PUBLISH_WINDOW_CLOSED') {
        const cleanupAuthorization = await fenceClaimedDiscussionAtCutoff(event.id, failureNow, {
          announcementMessageId: createdAnnouncement?.id || null,
          threadId: createdThread?.id || null,
        });
        if (cleanupAuthorization.cleanupAuthorized) {
          await cleanupUnpersistedPublication(createdThread, createdAnnouncement);
        }
      }
      await setFeatureHealth(FEATURE_KEY, 'maintenance', { detail: error.code.toLowerCase(), now: failureNow });
    }
    throw error;
  }
}

async function recordDailyDiscussionMessage({
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
    const event = mapEvent(api.get(
      `SELECT * FROM daily_events
       WHERE guild_id = ? AND event_kind = ? AND thread_id = ?
       ORDER BY id DESC LIMIT 1`,
      [normalizedGuildId, EVENT_KIND, normalizedThreadId]
    ));
    if (!event) return { inDiscussionThread: false, recorded: false, eligible: false };
    const gatewayWritable = event.status === 'published' || event.status === 'published_late';
    const settlementWritable =
      event.status === 'settling' &&
      settlementLeaseOwner &&
      event.settleLeaseOwner === settlementLeaseOwner &&
      event.settleLeaseUntil > operationTimestamp;
    if (!gatewayWritable && !settlementWritable) {
      return { inDiscussionThread: true, recorded: false, eligible: false, event };
    }
    const createdMs = new Date(timestamp).getTime();
    if (createdMs < new Date(event.windowStartAt).getTime() || createdMs >= new Date(event.windowEndAt).getTime()) {
      return { inDiscussionThread: true, recorded: false, eligible: false, event };
    }
    const eligible = isEligibleDiscussionMessage(content);
    api.run(
      `INSERT INTO daily_event_messages
        (event_id, guild_id, thread_id, message_id, user_id, created_at, eligible, correct)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT(event_id, message_id) DO NOTHING`,
      [event.id, normalizedGuildId, normalizedThreadId, normalizedMessageId, normalizedUserId, timestamp, eligible ? 1 : 0]
    );
    const inserted = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    if (inserted && eligible) {
      api.run(
        `INSERT INTO daily_event_participants
          (event_id, guild_id, user_id, eligible, correct, participation_reward_status,
           correct_reward_status, created_at, updated_at)
         VALUES (?, ?, ?, 1, 0, 'pending', 'not_earned', ?, ?)
         ON CONFLICT(event_id, user_id) DO UPDATE SET eligible = 1, updated_at = excluded.updated_at`,
        [event.id, normalizedGuildId, normalizedUserId, timestamp, timestamp]
      );
    }
    return { inDiscussionThread: true, recorded: inserted, eligible, event };
  });
}

async function handleDailyDiscussionMessage(message) {
  if (!message?.guildId || !message?.channelId || !message?.author?.id || message.author.bot || message.webhookId || message.system) {
    return false;
  }
  const result = await recordDailyDiscussionMessage({
    guildId: message.guildId,
    threadId: message.channelId,
    messageId: message.id,
    userId: message.author.id,
    content: message.content,
    createdAt: message.createdAt || message.createdTimestamp || new Date(),
  });
  if (!result.inDiscussionThread) return false;
  const explicitlyMentioned = Boolean(message.client?.user?.id && message.mentions?.has?.(message.client.user.id));
  return !explicitlyMentioned;
}

async function reconcileDiscussionHistory(event, thread, { maxPages = MAX_HISTORY_PAGES, leaseOwner, now = new Date() } = {}) {
  if (!thread?.messages?.fetch) return { complete: false, reason: 'history_unavailable', messages: 0 };
  const startMs = new Date(event.windowStartAt).getTime();
  const endMs = new Date(event.windowEndAt).getTime();
  let before;
  let recorded = 0;

  try {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = collectionValues(await thread.messages.fetch({
        limit: HISTORY_PAGE_SIZE,
        ...(before ? { before } : {}),
      }));
      for (const message of page) {
        const createdAt = message.createdAt || message.createdTimestamp;
        const createdMs = new Date(createdAt).getTime();
        if (
          message?.author?.bot ||
          message?.webhookId ||
          message?.system ||
          !message?.author?.id ||
          !Number.isFinite(createdMs) ||
          createdMs < startMs ||
          createdMs >= endMs
        ) continue;
        const result = await recordDailyDiscussionMessage({
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
      const timestamps = page
        .map((message) => new Date(message.createdAt || message.createdTimestamp).getTime())
        .filter(Number.isFinite);
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

async function claimDailyDiscussionSettlement(eventId, now = new Date()) {
  const date = requireNow(now);
  const leaseOwner = randomUUID();
  const leaseUntil = new Date(date.getTime() + LEASE_MS).toISOString();
  const timestamp = date.toISOString();
  return withCoinTransaction((api) => {
    api.run(
      `UPDATE daily_events
       SET status = CASE WHEN status = 'rewarding' THEN 'rewarding' ELSE 'settling' END,
           settle_lease_owner = ?, settle_lease_until = ?, updated_at = ?
       WHERE id = ? AND event_kind = ? AND window_end_at <= ?
         AND (
           status IN ('published', 'published_late') OR
           (status IN ('settling', 'rewarding') AND (settle_lease_owner IS NULL OR settle_lease_until <= ?))
         )`,
      [leaseOwner, leaseUntil, timestamp, eventId, EVENT_KIND, timestamp, timestamp]
    );
    const claimed = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    return {
      claimed,
      leaseOwner: claimed ? leaseOwner : null,
      event: mapEvent(api.get('SELECT * FROM daily_events WHERE id = ? AND event_kind = ?', [eventId, EVENT_KIND])),
    };
  });
}

async function freezeDailyDiscussionParticipants(eventId, leaseOwner, now) {
  const timestamp = requireNow(now).toISOString();
  return withCoinTransaction((api) => {
    api.run(
      `UPDATE daily_events
       SET status = 'rewarding', history_reconciled_at = ?, updated_at = ?
       WHERE id = ? AND event_kind = ? AND status = 'settling'
         AND settle_lease_owner = ? AND settle_lease_until > ?`,
      [timestamp, timestamp, eventId, EVENT_KIND, leaseOwner, timestamp]
    );
    if (Number(api.get('SELECT changes() AS count')?.count || 0) !== 1) {
      throw new DailyDiscussionError('SETTLE_LEASE_LOST', 'Daily discussion settlement lease was lost before freeze.');
    }
    return mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [eventId]));
  });
}

async function grantDiscussionRewards(event, now, { afterRewardGrant = null } = {}) {
  const participants = await withCoinDatabase((api) => api.all(
    'SELECT * FROM daily_event_participants WHERE event_id = ? AND eligible = 1 ORDER BY user_id',
    [event.id]
  ));
  for (const participant of participants) {
    const result = await grantRewardOnce(
      event.guildId,
      participant.user_id,
      FEATURE_KEY,
      String(event.id),
      'participation',
      PARTICIPATION_REWARD,
      { localDate: event.localDate, corpusVersion }
    );
    if (typeof afterRewardGrant === 'function') {
      await afterRewardGrant({ participant, rewardKind: 'participation', result });
    }
    await withCoinTransaction((api) => api.run(
      `UPDATE daily_event_participants
       SET participation_reward_status = 'granted', updated_at = ?
       WHERE event_id = ? AND user_id = ?`,
      [requireNow(now).toISOString(), event.id, participant.user_id]
    ));
  }
  return participants.length;
}

async function settleDailyDiscussion(
  client,
  event,
  { now = new Date(), leaseOwner, afterRewardGrant = null, maxHistoryPages = MAX_HISTORY_PAGES } = {}
) {
  const date = requireNow(now);
  const normalizedLeaseOwner = requireId(leaseOwner, 'leaseOwner');
  let settling = event;
  if (
    !['settling', 'rewarding'].includes(settling?.status) ||
    settling.settleLeaseOwner !== normalizedLeaseOwner ||
    new Date(settling.settleLeaseUntil).getTime() <= date.getTime()
  ) {
    throw new DailyDiscussionError('SETTLE_LEASE_LOST', 'Daily discussion settlement lease is not held.');
  }
  const guild = await resolveGuild(client, settling.guildId);
  const thread = await resolveChannel(client, guild, settling.threadId);
  if (!guild || !thread?.messages?.fetch) {
    throw new DailyDiscussionError('THREAD_UNAVAILABLE', 'Discussion thread is unavailable for settlement.');
  }
  if (settling.status === 'settling') {
    const history = await reconcileDiscussionHistory(settling, thread, {
      maxPages: maxHistoryPages,
      leaseOwner: normalizedLeaseOwner,
      now: date,
    });
    if (!history.complete) {
      const error = new DailyDiscussionError('HISTORY_INCOMPLETE', history.reason || 'Discussion history is incomplete.');
      await setEventFailure(settling.id, 'history_incomplete', error, {
        terminal: true,
        now: date,
        leaseKind: 'settle',
        leaseOwner: normalizedLeaseOwner,
      });
      return { settled: false, blocked: true, reason: history.reason, rewarded: 0 };
    }
    settling = await freezeDailyDiscussionParticipants(settling.id, normalizedLeaseOwner, date);
  }

  const economyEnabled = await withCoinTransaction((api) => {
    const timestamp = date.toISOString();
    api.run(
      `INSERT INTO coin_guild_settings (guild_id, created_at, updated_at)
       VALUES (?, ?, ?) ON CONFLICT(guild_id) DO NOTHING`,
      [settling.guildId, timestamp, timestamp]
    );
    return Number(api.get('SELECT enabled FROM coin_guild_settings WHERE guild_id = ?', [settling.guildId])?.enabled) === 1;
  });
  if (!economyEnabled) {
    const error = new DailyDiscussionError('COIN_DISABLED', 'Guild coin system is disabled.');
    await setEventFailure(settling.id, 'reward_preflight', error, {
      terminal: true,
      now: date,
      leaseKind: 'settle',
      leaseOwner: normalizedLeaseOwner,
    });
    return { settled: false, blocked: true, reason: 'coin_disabled', rewarded: 0 };
  }

  const rewarded = await grantDiscussionRewards(settling, date, { afterRewardGrant });
  const timestamp = date.toISOString();
  settling = await withCoinTransaction((api) => {
    api.run(
      `UPDATE daily_events
       SET status = 'settled', settled_at = ?, settle_lease_owner = NULL, settle_lease_until = NULL,
           last_error = NULL, updated_at = ?
       WHERE id = ? AND event_kind = ? AND status = 'rewarding'
         AND settle_lease_owner = ? AND settle_lease_until > ?`,
      [timestamp, timestamp, settling.id, EVENT_KIND, normalizedLeaseOwner, timestamp]
    );
    if (Number(api.get('SELECT changes() AS count')?.count || 0) !== 1) {
      throw new DailyDiscussionError('SETTLE_LEASE_LOST', 'Daily discussion settlement lease was lost before completion.');
    }
    return mapEvent(api.get('SELECT * FROM daily_events WHERE id = ?', [settling.id]));
  });
  await setFeatureHealth(FEATURE_KEY, 'normal', { detail: null, now: date });
  return { settled: true, blocked: false, rewarded, event: settling };
}

async function listEnabledDiscussionSettings(localDate, limit, guildId = null) {
  const params = [EVENT_KIND, localDate, FEATURE_KEY];
  const guildFilter = guildId ? ' AND settings.guild_id = ?' : '';
  if (guildId) params.push(requireId(guildId, 'guildId'));
  params.push(limit);
  return withCoinDatabase((api) => api.all(
    `SELECT settings.guild_id, settings.channel_id, settings.updated_at
     FROM feature_guild_settings AS settings
     LEFT JOIN daily_events AS event
       ON event.guild_id = settings.guild_id AND event.event_kind = ? AND event.local_date = ?
     WHERE settings.feature_key = ? AND settings.enabled = 1 AND settings.channel_id IS NOT NULL${guildFilter}
     ORDER BY CASE WHEN event.id IS NULL THEN 0 ELSE 1 END, settings.guild_id
     LIMIT ?`,
    params
  ));
}

async function listDueDiscussionEvents(now, limit, guildId = null) {
  const params = [EVENT_KIND, requireNow(now).toISOString()];
  const guildFilter = guildId ? ' AND guild_id = ?' : '';
  if (guildId) params.push(requireId(guildId, 'guildId'));
  params.push(limit);
  return withCoinDatabase((api) => api.all(
    `SELECT * FROM daily_events
     WHERE event_kind = ? AND window_end_at <= ?${guildFilter}
       AND status IN ('claimed', 'published', 'published_late', 'settling', 'rewarding')
     ORDER BY window_end_at, id LIMIT ?`,
    params
  ).map(mapEvent));
}

async function processDueDiscussionEvents(client, date, maxGuilds, hooks, guildId, summary) {
  const dueEvents = await listDueDiscussionEvents(date, maxGuilds, guildId);
  for (const event of dueEvents) {
    if (event.status === 'claimed') {
      const fenced = await fenceClaimedDiscussionAtCutoff(event.id, date);
      if (fenced.fenced) summary.missed += 1;
      continue;
    }
    const claim = await claimDailyDiscussionSettlement(event.id, date);
    if (!claim.claimed) continue;
    try {
      const result = await settleDailyDiscussion(client, claim.event, {
        now: date,
        leaseOwner: claim.leaseOwner,
        ...hooks,
      });
      if (result.settled) summary.settled += 1;
      if (result.blocked) summary.blocked += 1;
    } catch (error) {
      const failed = await setEventFailure(event.id, 'settle', error, {
        now: date,
        leaseKind: 'settle',
        leaseOwner: claim.leaseOwner,
      });
      if (failed.status === 'blocked') summary.blocked += 1;
      else summary.failed += 1;
      logger.warn('每日議題結算失敗，將依有界次數重試。', error);
    }
  }
}

async function ensurePreviousDiscussionClosed(setting, currentWindow, date, summary) {
  const previousDate = getPreviousTaipeiDateKey(date);
  let previous = await getDailyDiscussionEvent(setting.guild_id, previousDate);
  if (!previous) {
    const settingUpdatedAt = new Date(setting.updated_at).getTime();
    if (Number.isFinite(settingUpdatedAt) && settingUpdatedAt < currentWindow.start.getTime()) {
      const missed = await claimDailyDiscussionEvent({
        guildId: setting.guild_id,
        parentChannelId: setting.channel_id,
        localDate: previousDate,
        now: date,
        missed: true,
      });
      previous = missed.event;
      if (missed.claimed) summary.missed += 1;
    } else {
      return true;
    }
  }
  return previous.status === 'settled' || previous.status === 'missed';
}

async function processDailyDiscussionTick(
  client,
  { now = new Date(), maxGuilds = 100, guildId = null, hooks = {} } = {}
) {
  const date = requireNow(now);
  const localDate = getTaipeiDateKey(date);
  const currentWindow = getDiscussionWindow(localDate);
  const summary = { localDate, claimed: 0, published: 0, missed: 0, settled: 0, blocked: 0, failed: 0, deferred: 0 };

  await processDueDiscussionEvents(client, date, maxGuilds, hooks, guildId, summary);
  const settings = await listEnabledDiscussionSettings(localDate, maxGuilds, guildId);
  for (const setting of settings) {
    if (!(await ensurePreviousDiscussionClosed(setting, currentWindow, date, summary))) {
      summary.deferred += 1;
      continue;
    }
    const claimed = await claimDailyDiscussionEvent({
      guildId: setting.guild_id,
      parentChannelId: setting.channel_id,
      localDate,
      now: date,
    });
    if (claimed.claimed) summary.claimed += 1;
    if (!claimed.claimed) continue;
    try {
      await publishDailyDiscussion(client, claimed.event, { now: date, leaseOwner: claimed.leaseOwner, ...hooks });
      summary.published += 1;
    } catch (error) {
      const failed = await setEventFailure(claimed.event.id, 'publish', error, {
        terminal: error?.code === 'MARKER_HISTORY_INCOMPLETE',
        now: date,
        leaseKind: 'publish',
        leaseOwner: claimed.leaseOwner,
      });
      if (failed.status === 'failed') summary.failed += 1;
      logger.warn('每日議題發布失敗，將依有界次數重試。', error);
    }
  }
  return summary;
}

function getNextDiscussionBoundaryDelay(now = new Date()) {
  const date = requireNow(now);
  return getNextTaipeiOccurrence(0, 0, date).getTime() - date.getTime();
}

async function startDailyDiscussionScheduler(client, options = {}) {
  if (schedulerState) return schedulerState;
  const {
    nowFn = () => new Date(),
    setTimeoutFn = setTimeout,
    clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval,
    clearIntervalFn = clearInterval,
    intervalMs = SCHEDULER_INTERVAL_MS,
    tick = processDailyDiscussionTick,
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
    const timer = setTimeoutFn(() => {
      void runTick()
        .catch((error) => logger.error('每日議題邊界排程執行失敗。', error))
        .finally(() => {
          if (schedulerState) scheduleBoundary();
        });
    }, getNextDiscussionBoundaryDelay(nowFn()));
    timer.unref?.();
    if (schedulerState) schedulerState.boundaryTimer = timer;
    return timer;
  };
  const watchdogTimer = setIntervalFn(() => {
    void runTick().catch((error) => logger.error('每日議題排程執行失敗。', error));
  }, intervalMs);
  watchdogTimer.unref?.();
  schedulerState = { boundaryTimer: null, watchdogTimer, clearTimeoutFn, clearIntervalFn };
  schedulerState.boundaryTimer = scheduleBoundary();
  return schedulerState;
}

function stopDailyDiscussionScheduler(overrides = {}) {
  if (!schedulerState) return false;
  const state = schedulerState;
  schedulerState = null;
  (overrides.clearTimeoutFn || state.clearTimeoutFn)(state.boundaryTimer);
  (overrides.clearIntervalFn || state.clearIntervalFn)(state.watchdogTimer);
  return true;
}

module.exports = {
  DailyDiscussionError,
  FEATURE_KEY,
  PARTICIPATION_REWARD,
  SCHEDULER_INTERVAL_MS,
  buildDiscussionEmbed,
  claimDailyDiscussionEvent,
  claimDailyDiscussionSettlement,
  getDailyDiscussionEvent,
  getDiscussionWindow,
  getNextDiscussionBoundaryDelay,
  getPreviousTaipeiDateKey,
  handleDailyDiscussionMessage,
  isEligibleDiscussionMessage,
  processDailyDiscussionTick,
  publishDailyDiscussion,
  reconcileDiscussionHistory,
  recordDailyDiscussionMessage,
  settleDailyDiscussion,
  startDailyDiscussionScheduler,
  stopDailyDiscussionScheduler,
};
