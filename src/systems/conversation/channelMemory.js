'use strict';

// Channel memory: what members say in the servers 小吉 is in, so 小吉 remembers what was said in a channel ("你剛剛
//沒說完", "反擊你剛剛發的那三句") and what it knows about a member ("小吉你知道我是誰嗎").
//
// Who: only members who have chatted with 小吉 (they were shown the memory notice; preferenceMemory.js keeps that),
// and only while their memory is on (/memory off stops it). Direct messages are never kept.
// Where it is used follows the member's choice:
// - public: everything the member said in any server 小吉 is in is one memory, used wherever they talk to 小吉;
// - private (also before they choose): what they said in a server is used only in that server.
// What a channel said is used only in that channel.
//
// How much: 30 messages a day for each member. A day that is used up borrows from the next day (the next day then has
// less); a day that is not used up does not carry anything over. When the whole month is used up nothing more is kept
// until the next month. A month is at most 30 x its number of days (900 or 930 messages).
// When: a month and its days start at 12:00 noon Taipei time; on the 1st of each month at 12:00 the counts start again
// and everything of the month before is deleted.
//
// 小吉's own replies in a channel are kept too (they are not counted), so it knows what it said there. Everything is
// best effort: a store that is not configured or does not answer turns this off and the chat goes on.

const logger = require('../../utils/logger');
const {
  INTERNAL_DATA_REPLACEMENT,
  sanitizeAdmittedProviderData,
} = require('./disclosurePolicy');
const {
  getMemoryStore,
  normalizeConsent,
  readableScopes,
  withStoreTimeout,
  writableScope,
} = require('./preferenceMemory');

const DAILY_LIMIT = 30;
// Taipei is UTC+8 all year; a memory day and month start at 12:00 there, which is 04:00 UTC.
const PERIOD_START_OFFSET_MS = (8 - 12) * 60 * 60 * 1000;
const MAX_CONTENT_LENGTH = 300;
const MAX_NAME_LENGTH = 40;
// What one reply is given: the channel's recent conversation, and the member's own recent messages.
const CHANNEL_CONTEXT_MESSAGES = 20;
const OWN_CONTEXT_MESSAGES = 30;
// How long a member's choice is reused without asking the store again (most messages are from the same people).
const CONSENT_CACHE_MS = 5 * 60 * 1000;
const MAX_CACHED_CONSENTS = 5000;
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

const consentCache = new Map();
let lastSweepPeriod = null;
let lastSweepAt = 0;

// The memory month and day of a moment: { period: 'YYYY-MM', day: 1.., daysInMonth }. Days run noon to noon (Taipei).
function periodOf(now = Date.now()) {
  const shifted = new Date(now + PERIOD_START_OFFSET_MS);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth();
  return {
    period: `${year}-${String(month + 1).padStart(2, '0')}`,
    day: shifted.getUTCDate(),
    daysInMonth: new Date(Date.UTC(year, month + 1, 0)).getUTCDate(),
  };
}

// Whether one more message may be kept today. usage: [{ day, count }] of this month. A day starts with 30; what an
// earlier day took beyond its 30 is owed by the days after it; a day's unused part is lost; the month can lend no
// more than what its remaining days hold.
function quotaFor(usage, { day, daysInMonth }, dailyLimit = DAILY_LIMIT) {
  const counts = new Map(usage.map((entry) => [entry.day, entry.count]));
  let owed = 0;
  for (let earlier = 1; earlier < day; earlier += 1) owed = Math.max(0, owed + (counts.get(earlier) || 0) - dailyLimit);
  const today = counts.get(day) || 0;
  const remainingInMonth = dailyLimit * (daysInMonth - day + 1) - owed - today;
  const remainingToday = Math.max(0, dailyLimit - owed - today);
  return { allowed: remainingInMonth > 0, remainingToday, remainingInMonth: Math.max(0, remainingInMonth), usedToday: today };
}

function cleanText(value, maxLength) {
  const text = sanitizeAdmittedProviderData(String(value ?? '')).replace(/\s+/gu, ' ').trim();
  if (!text || text === INTERNAL_DATA_REPLACEMENT) return '';
  return text.slice(0, maxLength);
}

function displayNameOf(message) {
  return cleanText(message.member?.displayName || message.author?.globalName || message.author?.username || '成員',
    MAX_NAME_LENGTH) || '成員';
}

// The member's choice, or null when they never chatted with 小吉 (never shown the memory notice) or stopped memory.
async function consentFor(store, userId, now) {
  const cached = consentCache.get(userId);
  if (cached && now - cached.at < CONSENT_CACHE_MS) return cached.consent;
  const stored = await store.getConsent(userId);
  const consent = stored && stored.promptedAt !== null && stored.promptedAt !== undefined
    ? normalizeConsent(stored) : null;
  const usable = consent && consent.collecting ? consent : null;
  if (consentCache.size >= MAX_CACHED_CONSENTS) consentCache.delete(consentCache.keys().next().value);
  consentCache.set(userId, { consent: usable, at: now });
  return usable;
}

// Called when a member's choice changes (/memory, the notice buttons), so the next message follows it at once.
function forgetCachedConsent(userId) {
  consentCache.delete(userId);
}

// Deletes the months before this one, at most once an hour and at once when a new month starts.
async function sweepOldMonths(store, now) {
  const { period } = periodOf(now);
  if (period === lastSweepPeriod && now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepPeriod = period;
  lastSweepAt = now;
  await store.deleteMessagesBefore(period);
}

function logFailure(error) {
  logger.warn(`[CHANNEL_MEMORY] code=CHANNEL_MEMORY_UNAVAILABLE reason=${String(error?.code || error?.name || 'unknown').slice(0, 60)}`);
}

// Keeps one server message of a member who chats with 小吉, within their quota. Returns whether it was kept.
async function recordMemberMessage(message, { now = Date.now() } = {}) {
  const store = getMemoryStore();
  if (!store || !message?.guildId || !message.channelId || !message.id || message.author?.bot) return false;
  const userId = message.author?.id;
  const content = cleanText(message.content, MAX_CONTENT_LENGTH);
  if (!userId || !content) return false;
  try {
    return await withStoreTimeout(async () => {
      await sweepOldMonths(store, now);
      const consent = await consentFor(store, userId, now);
      if (!consent) return false;
      const when = periodOf(now);
      if (!quotaFor(await store.usageByDay(userId, when.period), when).allowed) return false;
      return store.addMessage({
        period: when.period,
        day: when.day,
        userId,
        scope: writableScope(consent, message.guildId),
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: message.id,
        role: 'member',
        authorName: displayNameOf(message),
        content,
        createdAt: now,
      });
    });
  } catch (error) {
    logFailure(error);
    return false;
  }
}

// Keeps 小吉's reply in a server channel (not counted), so later replies there know what it said.
async function recordXiaojiReply({ message, replyMessageId, text, now = Date.now() } = {}) {
  const store = getMemoryStore();
  const userId = message?.author?.id;
  if (!store || !message?.guildId || !message.channelId || !userId) return false;
  const content = cleanText(text, MAX_CONTENT_LENGTH);
  if (!content) return false;
  try {
    return await withStoreTimeout(async () => {
      const consent = await consentFor(store, userId, now);
      if (!consent) return false;
      const when = periodOf(now);
      return store.addMessage({
        period: when.period,
        day: when.day,
        userId,
        scope: writableScope(consent, message.guildId),
        guildId: message.guildId,
        channelId: message.channelId,
        messageId: String(replyMessageId || `reply-to-${message.id}`),
        role: 'xiaoji',
        authorName: '小吉',
        content,
        createdAt: now,
      });
    });
  } catch (error) {
    logFailure(error);
    return false;
  }
}

// What one reply may use: { channelConversation: [{ speaker, text, fromXiaoji, self }], ownMessages: [text] }.
// The current message is left out (it is the request itself). Empty in direct messages and when anything fails.
async function loadChannelMemory({ message, now = Date.now() } = {}) {
  const empty = { channelConversation: [], ownMessages: [] };
  const store = getMemoryStore();
  const userId = message?.author?.id;
  if (!store || !message?.guildId || !message.channelId || !userId) return empty;
  try {
    return await withStoreTimeout(async () => {
      const { period } = periodOf(now);
      const consent = await consentFor(store, userId, now);
      const channelRows = await store.listChannelMessages(message.guildId, message.channelId, period, CHANNEL_CONTEXT_MESSAGES + 1);
      const ownRows = consent
        ? await store.listOwnMessages(userId, readableScopes(consent, message.guildId), period, OWN_CONTEXT_MESSAGES + 1)
        : [];
      const notCurrent = (row) => row.messageId !== message.id;
      return {
        channelConversation: channelRows.filter((row) => row.role === 'xiaoji' || notCurrent(row))
          .slice(-CHANNEL_CONTEXT_MESSAGES)
          .map((row) => ({
            speaker: row.role === 'xiaoji' ? '小吉' : row.authorName,
            text: row.content,
            fromXiaoji: row.role === 'xiaoji',
            self: row.role === 'member' && row.userId === userId,
          })),
        ownMessages: ownRows.filter(notCurrent).slice(-OWN_CONTEXT_MESSAGES).map((row) => row.content),
      };
    });
  } catch (error) {
    logFailure(error);
    return empty;
  }
}

// For /memory: how many of the member's messages this month holds, and what is left today and this month.
async function describeOwnUsage(userId, { now = Date.now() } = {}) {
  const store = getMemoryStore();
  if (!store || !userId) return null;
  return withStoreTimeout(async () => {
    const when = periodOf(now);
    const [kept, usage] = await Promise.all([store.countOwnMessages(userId, when.period), store.usageByDay(userId, when.period)]);
    return { kept, ...quotaFor(usage, when), period: when.period };
  });
}

async function forgetOwnMessages(userId) {
  const store = getMemoryStore();
  if (!store || !userId) return 0;
  return withStoreTimeout(() => store.deleteOwnMessages(userId));
}

function resetChannelMemoryForTests() {
  consentCache.clear();
  lastSweepPeriod = null;
  lastSweepAt = 0;
}

module.exports = {
  CHANNEL_CONTEXT_MESSAGES,
  DAILY_LIMIT,
  MAX_CONTENT_LENGTH,
  OWN_CONTEXT_MESSAGES,
  describeOwnUsage,
  forgetCachedConsent,
  forgetOwnMessages,
  loadChannelMemory,
  periodOf,
  quotaFor,
  recordMemberMessage,
  recordXiaojiReply,
  resetChannelMemoryForTests,
};
