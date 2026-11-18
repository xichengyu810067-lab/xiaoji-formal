// What the daily riddle and the daily discussion share: both run one event a day for each guild that enabled the
// feature, kept in daily_events under their own event_kind, post it in the guild's channel with a thread under it,
// and find their own posts again by the footer when a post was sent but not yet recorded.
const { withCoinDatabase } = require('../../economy/storage/coinDatabase');
const { listEnabledFeatureChannelsWithApi } = require('../../../services/featurePlatformService');
const logger = require('../../../utils/logger');
const { runWithBackgroundContext } = require('../../../platform/hostOperationContext');

const MAX_HISTORY_PAGES = 20;
const HISTORY_PAGE_SIZE = 100;
const SCHEDULER_INTERVAL_MS = 60_000;
const graphemeSegmenter = new Intl.Segmenter('zh-TW', { granularity: 'grapheme' });

// The argument checks of one feature, throwing its own error class: makeError(code, message).
function createDailyEventKit({ makeError }) {
  function requireId(value, name) {
    const normalized = String(value || '').trim();
    if (!normalized || normalized.length > 100) throw makeError('INVALID_ARGUMENT', `${name} is required.`);
    return normalized;
  }

  function requireNow(now) {
    const date = now instanceof Date ? new Date(now.getTime()) : new Date(now);
    if (Number.isNaN(date.getTime())) throw makeError('INVALID_ARGUMENT', 'now must be valid.');
    return date;
  }

  // `markers` are the footers that tell a post of this event: the footer shown today and, for a post sent before the
  // footer was changed, the stable marker it carried then.
  async function findMarkedMessage(channel, markers, botUserId, { lowerBound, maxPages = MAX_HISTORY_PAGES } = {}) {
    const accepted = new Set([markers].flat());
    if (!channel?.messages?.fetch) throw makeError('READ_HISTORY_UNAVAILABLE', 'Message history is unavailable.');
    const lowerBoundMs = requireNow(lowerBound).getTime();
    let before;
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      const page = collectionValues(await channel.messages.fetch({ limit: HISTORY_PAGE_SIZE, ...(before ? { before } : {}) }));
      const match = page.find((message) => {
        const createdMs = new Date(message.createdAt || message.createdTimestamp).getTime();
        return createdMs >= lowerBoundMs && message?.author?.id === botUserId && accepted.has(messageFooter(message));
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

  return { findMarkedMessage, requireId, requireNow };
}

// The guilds that enabled the feature with a channel, those without an event for localDate first, each part by guild
// id, at most limit of them. guildId narrows it to one guild.
async function listEnabledDailyChannels({ featureKey, eventKind, localDate, limit, guildId = null }) {
  return withCoinDatabase((api) => {
    const settings = listEnabledFeatureChannelsWithApi(api, featureKey, { guildId });
    const withEvent = new Set(api.all(
      'SELECT guild_id FROM daily_events WHERE event_kind = ? AND local_date = ?',
      [eventKind, localDate]
    ).map((row) => row.guild_id));
    return [
      ...settings.filter((setting) => !withEvent.has(setting.guild_id)),
      ...settings.filter((setting) => withEvent.has(setting.guild_id)),
    ].slice(0, limit);
  });
}

// Inserts the event of the day, or takes over its publish lease once the previous holder's has run out. A missed
// event is recorded without a lease. Returns whether this call holds the event, and the stored row.
// event: { guildId, eventKind, localDate, contentId, parentChannelId, windowStartAt, windowEndAt, publishMarker,
// answerMarker }, all ISO strings or normalized ids.
function claimDailyEventWithApi(api, event, { missed, leaseOwner, leaseUntil, timestamp }) {
  api.run(
    `INSERT INTO daily_events
      (guild_id, event_kind, local_date, riddle_id, parent_channel_id, status,
       window_start_at, window_end_at, publish_marker, answer_marker,
       publish_lease_owner, publish_lease_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, event_kind, local_date) DO NOTHING`,
    [
      event.guildId,
      event.eventKind,
      event.localDate,
      event.contentId,
      event.parentChannelId,
      missed ? 'missed' : 'claimed',
      event.windowStartAt,
      event.windowEndAt,
      event.publishMarker,
      event.answerMarker,
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
      [leaseOwner, leaseUntil, timestamp, event.guildId, event.eventKind, event.localDate, timestamp]
    );
    acquired = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
  }
  const row = api.get('SELECT * FROM daily_events WHERE guild_id = ? AND event_kind = ? AND local_date = ?', [
    event.guildId,
    event.eventKind,
    event.localDate,
  ]);
  return { acquired, row };
}

function safeFailure(stage, error) {
  const code = String(error?.code || error?.status || error?.name || 'unknown').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 60);
  return `${stage}:${code || 'unknown'}`;
}

// Whether a message says something: at most 2000 characters, at least four characters and two letters or digits once
// mentions and custom emoji are left out, and not one to three characters repeated.
function isSubstantiveMessage(content) {
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

function collectionValues(collection) {
  if (!collection) return [];
  if (Array.isArray(collection)) return collection;
  if (typeof collection.values === 'function') return [...collection.values()];
  return Object.values(collection);
}

function messageFooter(message) {
  return message?.embeds?.[0]?.footer?.text || message?.embeds?.[0]?.data?.footer?.text || null;
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

// Deletes a thread and a post this run created but could not record. name is what members call the feature.
async function cleanupUnpersistedPublication(createdThread, createdAnnouncement, name) {
  for (const [target, label] of [[createdThread, 'thread'], [createdAnnouncement, 'announcement']]) {
    if (!target?.delete) continue;
    try {
      await target.delete(`小吉${name}發布在截止或失權後清理`);
    } catch (error) {
      logger.warn(`${name}未持久化 ${label} 清理失敗。`, error);
    }
  }
}

// A scheduler that runs tick once at start, again at each boundary (boundaryDelay(now) away) and every intervalMs as a
// watchdog, never two ticks at once, each in its own background context named contextName. name is what members call
// the feature; it names the log lines.
function createDailyScheduler({ contextName, name, boundaryDelay, defaultTick }) {
  let schedulerState = null;

  async function start(client, options = {}) {
    if (schedulerState) return schedulerState;
    const {
      nowFn = () => new Date(),
      setTimeoutFn = setTimeout,
      clearTimeoutFn = clearTimeout,
      setIntervalFn = setInterval,
      clearIntervalFn = clearInterval,
      intervalMs = SCHEDULER_INTERVAL_MS,
      tick = defaultTick,
    } = options;
    let tickRunning = false;
    // Every tick (the first one, boundary and watchdog runs) is its own background job run.
    const runTick = async () => {
      if (tickRunning) return;
      tickRunning = true;
      try {
        await runWithBackgroundContext(contextName, () => tick(client, { now: nowFn() }));
      } finally {
        tickRunning = false;
      }
    };
    await runTick();
    const scheduleBoundary = () => {
      const delay = boundaryDelay(nowFn());
      const boundaryTimer = setTimeoutFn(() => {
        void runTick()
          .catch((error) => logger.error(`${name}邊界排程執行失敗。`, error))
          .finally(() => {
            if (schedulerState) scheduleBoundary();
          });
      }, delay);
      boundaryTimer.unref?.();
      if (schedulerState) schedulerState.boundaryTimer = boundaryTimer;
      return boundaryTimer;
    };
    const watchdogTimer = setIntervalFn(() => {
      void runTick().catch((error) => logger.error(`${name}排程執行失敗。`, error));
    }, intervalMs);
    watchdogTimer.unref?.();
    schedulerState = { boundaryTimer: null, watchdogTimer, clearTimeoutFn, clearIntervalFn };
    schedulerState.boundaryTimer = scheduleBoundary();
    return schedulerState;
  }

  function stop(overrides = {}) {
    if (!schedulerState) return false;
    const state = schedulerState;
    schedulerState = null;
    (overrides.clearTimeoutFn || state.clearTimeoutFn)(state.boundaryTimer);
    (overrides.clearIntervalFn || state.clearIntervalFn)(state.watchdogTimer);
    return true;
  }

  return { start, stop };
}

module.exports = {
  HISTORY_PAGE_SIZE,
  MAX_HISTORY_PAGES,
  SCHEDULER_INTERVAL_MS,
  claimDailyEventWithApi,
  cleanupUnpersistedPublication,
  collectionValues,
  createDailyEventKit,
  createDailyScheduler,
  isSubstantiveMessage,
  listEnabledDailyChannels,
  resolveAnnouncementThread,
  resolveChannel,
  resolveGuild,
  safeFailure,
};
