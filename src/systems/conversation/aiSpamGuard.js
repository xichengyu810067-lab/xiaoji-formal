'use strict';

// The anti-spam gate of AI chat. Every message that asks 小吉 for a chat reply passes it first, before
// anything that costs: a model call, a provider guard slot, an archive row, conversation history,
// statistics, a reply or an Owner notice. A blocked message gets none of these. At most it gets one
// short fixed notice (see the notice rules below), sent like any other reply, through the egress
// guard and the output rate limit.
//
// It applies to everyone alike: the Owner, every guild (the private ones included) and every private
// extension. Nothing here reads who the author is or which guild it is beyond using the IDs as keys.
//
// All state is in memory only, so a restart forgets it. It is bounded: a capped number of members and
// channels, swept of what has expired, and evicted oldest first when full (a member who is cooling
// down is the last to be evicted).
//
// The turtle soup judge has a gate of its own (turtleSoupSpamGuard), with its own counts and wider
// limits: the meaningless and repeat rules are the same, but there is no channel limit, no cooldown and
// no notice here, because every judge answer is a private reply the game sends anyway.

const { createHash } = require('node:crypto');
const defaultLogger = require('../../utils/logger');
const { observe: defaultObserve } = require('../../platform/testControlObservation');
const { createFixedCodeLog } = require('./fixedCodeLog');

// Every threshold of the gate, in one place.
const AI_SPAM_LIMITS = Object.freeze({
  // One member in one guild (each direct-message channel counts as a guild of its own).
  userShortWindowMs: 60_000,
  userShortMaxRequests: 5,
  userLongWindowMs: 10 * 60_000,
  userLongMaxRequests: 20,
  // Everyone in one channel together, so members taking turns cannot flood it.
  channelWindowMs: 60_000,
  channelMaxRequests: 10,
  // The same or nearly the same words again: the third time within the window is blocked.
  repeatWindowMs: 10 * 60_000,
  repeatEarlierCopiesToBlock: 2,
  repeatHistorySize: 8,
  // A text this short after normalizing ("好", "嗯", "哈哈", "ok") is never a repeat; the rate limits still apply.
  repeatMinLength: 3,
  // "Nearly the same" compares this many characters at the beginning and at the end.
  repeatEndLength: 60,
  nearDuplicateMinLength: 6,
  nearDuplicateMinSimilarity: 0.9,
  nearDuplicateMinLengthRatio: 0.8,
  // Meaningless content: nothing but mentions, spaces, punctuation and emoji, or one character or one
  // short piece said over and over.
  inspectMaxLength: 2_000,
  singleCharacterRunToBlock: 6,
  shortUnitMaxLength: 4,
  shortUnitRepeatsToBlock: 4,
  questionOnlyMaxLength: 3,
  // Progressive cooldown: blocked this many times within the window starts the next step.
  strikeWindowMs: 10 * 60_000,
  strikesToCooldown: 3,
  cooldownStepsMs: Object.freeze([10 * 60_000, 30 * 60_000, 2 * 60 * 60_000]),
  // A member who has not been cooled down again this long after a cooldown ended starts from the first step.
  cooldownLevelResetMs: 24 * 60 * 60_000,
  // Notices: one per member per cooldown (or per window when not cooling down), one flood notice per
  // channel per window, and no more than a few notices of any kind in one channel per minute.
  userNoticeWindowMs: 10 * 60_000,
  // A bare mention (or a bare 小吉) is answered with a fixed line at most once per member per window.
  presenceReplyWindowMs: 10 * 60_000,
  channelFloodNoticeWindowMs: 5 * 60_000,
  channelNoticeWindowMs: 60_000,
  channelNoticeMaxPerWindow: 3,
  // Memory.
  maxTrackedUsers: 5_000,
  maxTrackedChannels: 2_000,
  sweepIntervalMs: 60_000,
  // One log line per code per interval; the lines left out are counted on the next one.
  logIntervalMs: 60_000,
});

// The turtle soup judge: the same meaningless and repeat rules, wider rate limits.
const TURTLE_SOUP_SPAM_LIMITS = Object.freeze({
  ...AI_SPAM_LIMITS,
  userShortMaxRequests: 6,
  userLongMaxRequests: 40,
});

const AI_SPAM_BLOCK_REASONS = Object.freeze({
  MEANINGLESS: 'meaningless',
  REPEAT: 'repeat',
  USER_RATE: 'user_rate',
  CHANNEL_FLOOD: 'channel_flood',
  COOLDOWN: 'cooldown',
  // Not a block of a request: a bare mention, answered with AI_SPAM_PRESENCE_REPLY instead of the model.
  PRESENCE: 'presence',
});

// Blocks that count toward a cooldown. A channel flood is everyone's doing, not the member's, and a
// block during a cooldown is already the consequence of one.
const STRIKE_REASONS = new Set([
  AI_SPAM_BLOCK_REASONS.MEANINGLESS,
  AI_SPAM_BLOCK_REASONS.REPEAT,
  AI_SPAM_BLOCK_REASONS.USER_RATE,
]);

// Fixed texts: no mention, no link, nothing the member wrote.
const AI_SPAM_NOTICES = Object.freeze({
  [AI_SPAM_BLOCK_REASONS.MEANINGLESS]: '小吉沒有看到可以回覆的文字，請直接說想聊的內容。',
  [AI_SPAM_BLOCK_REASONS.REPEAT]: '這句話剛剛已經說過了，小吉先不重複回覆。',
  [AI_SPAM_BLOCK_REASONS.USER_RATE]: '你找小吉的速度有點快，請稍等一下再說。',
  [AI_SPAM_BLOCK_REASONS.CHANNEL_FLOOD]: '這個頻道現在找小吉的訊息太多了，請大家稍等一下再試。',
});
const AI_SPAM_PRESENCE_REPLY = '我在，有什麼事嗎？';

const SNOWFLAKE = /^\d{1,20}$/u;

// Discord markup that is not words: custom emoji, user, role and channel mentions, command mentions,
// timestamps and @everyone/@here.
const DISCORD_MARKUP = /<a?:[\w~-]{1,32}:\d{1,20}>|<@[!&]?\d{1,20}>|<#\d{1,20}>|<\/[^<>\s:]{1,100}:\d{1,20}>|<t:-?\d{1,20}(?::[A-Za-z])?>|@(?:everyone|here)/giu;
const NOT_WORD = /[^\p{L}\p{N}]/gu;
// The arithmetic signs both checks keep (after NFKC, full-width signs are these ASCII ones; × ÷ − stay).
// "~" is deliberately not one of them: "哈哈哈～" is laughter, not a sum. A sum has a digit on both sides
// of a sign, so "-666666", "88888888+" and "666666 :-)" are not sums.
const SUM = /\p{Nd}\s*[+\-*\/=^%<>×÷−]\s*\p{Nd}/u;
// The repeat check keeps letters, digits, currency signs and arithmetic signs, so "1*1=?" and "1-1=?" stay
// different while spacing, punctuation and emoji cannot make the same words look new.
const NOT_REPEAT_KEY = /[^\p{L}\p{N}\p{Sc}+\-*\/=^%<>×÷−]/gu;
const SPACE_OR_FORMAT = /[\s\p{Cf}]/gu;
// Invisible characters (Hangul fillers, zero-width and format characters) do not make a repeat new, so the repeat key
// drops them: "幫<Hangul filler>我推薦…" is "幫我推薦…". Accents on a Latin letter are dropped too ("héllo" is
// "hello"), except the breve, horn, hook and dot below that make Vietnamese letters ("phở" is not "phố"); other
// marks keep words apart ("が" is not "か"). Only the repeat key reads the text this way.
const NOT_IN_REPEAT_KEY = /\p{Default_Ignorable_Code_Point}/gu;
const ACCENT_ON_LATIN_LETTER = /(?<=[A-Za-z])[\u{300}-\u{305}\u{307}\u{308}\u{30A}-\u{31A}\u{31C}-\u{322}\u{324}-\u{36F}]+/gu;
// After NFKC, full-width question and exclamation marks are the ASCII ones.
const QUESTION_ONLY = /^[?!]+$/u;

function prepareText(value, limits = AI_SPAM_LIMITS) {
  return String(value ?? '').slice(0, limits.inspectMaxLength).normalize('NFKC').toLowerCase()
    .replace(DISCORD_MARKUP, ' ');
}

function isShortUnitRepeat(characters, limits) {
  for (let unit = 1; unit <= limits.shortUnitMaxLength; unit += 1) {
    if (characters.length < unit * 2) return false;
    let periodic = true;
    for (let index = unit; index < characters.length; index += 1) {
      if (characters[index] !== characters[index - unit]) {
        periodic = false;
        break;
      }
    }
    if (!periodic) continue;
    // The shortest unit the text repeats decides, so "哈哈哈哈" is one character four times.
    const needed = unit === 1 ? limits.singleCharacterRunToBlock : unit * limits.shortUnitRepeatsToBlock;
    return characters.length >= needed;
  }
  return false;
}

// 'empty' when nothing but mentions, spaces, punctuation and emoji is left (one to three question marks
// excepted: "？" is a question); 'repeated' when the words are one character or one short piece over and
// over; null otherwise. A sum is never 'repeated': a text with a digit on both sides of an arithmetic sign
// ("111×111=?", "1212+1212") is left alone, while digits alone ("666666", "88888888") are not.
function classifyMeaningless(value, limits = AI_SPAM_LIMITS) {
  const prepared = prepareText(value, limits);
  const words = prepared.replace(NOT_WORD, '');
  if (!words) {
    const bare = prepared.replace(SPACE_OR_FORMAT, '');
    const question = bare.length > 0 && bare.length <= limits.questionOnlyMaxLength &&
      QUESTION_ONLY.test(bare) && bare.includes('?');
    return question ? null : 'empty';
  }
  if (SUM.test(prepared)) return null;
  return isShortUnitRepeat(Array.from(words), limits) ? 'repeated' : null;
}

// Only mentions, spaces, punctuation or emoji after 小吉 (one to three question marks excepted, which ask
// something): a call for 小吉's attention, not a request for the model.
function isBareCall(value, limits = AI_SPAM_LIMITS) {
  return classifyMeaningless(value, limits) === 'empty';
}

// What the repeat check compares. The whole normalized text is compared by its hash; "nearly the same"
// looks at its beginning and its end, so two long messages that differ only at one end are different.
function repeatKey(value, limits = AI_SPAM_LIMITS) {
  const prepared = prepareText(value, limits).replace(NOT_IN_REPEAT_KEY, '').normalize('NFD')
    .replace(ACCENT_ON_LATIN_LETTER, '').normalize('NFC');
  const normalized = prepared.replace(NOT_REPEAT_KEY, '') || prepared.replace(SPACE_OR_FORMAT, '');
  const characters = Array.from(normalized);
  return Object.freeze({
    hash: createHash('sha256').update(normalized).digest('hex').slice(0, 32),
    head: characters.slice(0, limits.repeatEndLength).join(''),
    tail: characters.slice(-limits.repeatEndLength).join(''),
    length: characters.length,
  });
}

function bigrams(text) {
  const characters = Array.from(text);
  const grams = new Set();
  for (let index = 1; index < characters.length; index += 1) grams.add(characters[index - 1] + characters[index]);
  return grams;
}

function similarity(left, right) {
  const a = bigrams(left);
  const b = bigrams(right);
  if (a.size + b.size === 0) return left === right ? 1 : 0;
  let shared = 0;
  for (const gram of a) if (b.has(gram)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

function isNearDuplicate(left, right, limits = AI_SPAM_LIMITS) {
  if (left.hash === right.hash) return true;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if (shorter < limits.nearDuplicateMinLength || shorter / longer < limits.nearDuplicateMinLengthRatio) return false;
  // Both ends must be nearly the same (a text no longer than an end is its own beginning and end).
  return similarity(left.head, right.head) >= limits.nearDuplicateMinSimilarity &&
    similarity(left.tail, right.tail) >= limits.nearDuplicateMinSimilarity;
}

function formatDuration(ms) {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  return minutes % 60 === 0 ? `${minutes / 60} 小時` : `${minutes} 分鐘`;
}

function cooldownStartedNotice(durationMs) {
  return `短時間內被擋下太多次，你的 AI 對話暫停 ${formatDuration(durationMs)}。`;
}

function cooldownNotice(remainingMs) {
  return `你的 AI 對話暫停中，約 ${formatDuration(remainingMs)}後恢復。`;
}

function safeId(value) {
  const text = value === null || value === undefined ? '' : String(value);
  return SNOWFLAKE.test(text) ? text : 'unknown';
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`AI spam guard ${name} must be a positive integer.`);
  return value;
}

function normalizeLimits(overrides = {}) {
  const merged = { ...AI_SPAM_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(merged)) {
    if (name === 'cooldownStepsMs') continue;
    if (name === 'nearDuplicateMinSimilarity' || name === 'nearDuplicateMinLengthRatio') {
      if (!(typeof value === 'number' && value > 0 && value <= 1)) throw new TypeError(`AI spam guard ${name} is invalid.`);
      continue;
    }
    positiveInteger(value, name);
  }
  if (!Array.isArray(merged.cooldownStepsMs) || merged.cooldownStepsMs.length === 0) {
    throw new TypeError('AI spam guard cooldownStepsMs must list at least one step.');
  }
  merged.cooldownStepsMs.forEach((step) => positiveInteger(step, 'cooldown step'));
  return Object.freeze({ ...merged, cooldownStepsMs: Object.freeze([...merged.cooldownStepsMs]) });
}

function within(times, now, windowMs) {
  return times.filter((at) => now - at < windowMs);
}

class AiSpamGuard {
  // `channelFlood`, `cooldowns` and `notices` switch off the channel limit, the progressive cooldown and
  // the notices (the turtle soup judge uses none of them). `codePrefix` names the log codes
  // (<prefix>_BLOCKED, <prefix>_COOLDOWN_STARTED, <prefix>_NOTICE_FAILED) and the test-control
  // observations (TEST_OBS_<prefix>_*); `logPrefix` starts each log line.
  constructor({
    limits = {}, now = () => Date.now(), logger = defaultLogger, observe = defaultObserve,
    channelFlood = true, cooldowns = true, notices = true, codePrefix = 'AI_SPAM', logPrefix = '[AI_SPAM]',
  } = {}) {
    this.limits = normalizeLimits(limits);
    this.now = now;
    this.observe = observe;
    this.channelFlood = Boolean(channelFlood);
    this.cooldowns = Boolean(cooldowns);
    this.notices = Boolean(notices);
    this.codePrefix = codePrefix;
    this.logPrefix = logPrefix;
    this.codeLog = createFixedCodeLog({ intervalMs: this.limits.logIntervalMs, now: () => this.currentTime(), logger });
    this.users = new Map();
    this.channels = new Map();
    this.lastSweepAt = null;
  }

  currentTime() {
    const value = Number(this.now());
    if (!Number.isFinite(value)) throw new TypeError('AI spam guard clock returned an invalid time.');
    return value;
  }

  // The member's and the channel's state for one request. A sweep runs before either is looked up, never
  // in between: a sweep forgets idle states, and the state of this very request is idle until it is counted.
  states({ guildId = null, channelId, userId }, now) {
    const guildKey = guildId === null || guildId === undefined ? 'dm' : String(guildId);
    const userKey = `${guildKey}\u0000${String(userId ?? '')}`;
    const channelKey = String(channelId ?? '');
    const full = (!this.users.has(userKey) && this.users.size >= this.limits.maxTrackedUsers) ||
      (this.tracksChannels() && !this.channels.has(channelKey) && this.channels.size >= this.limits.maxTrackedChannels);
    if (full || this.lastSweepAt === null || now - this.lastSweepAt >= this.limits.sweepIntervalMs) this.sweep(now);
    return {
      user: this.userState(userKey, now),
      channel: this.tracksChannels() ? this.channelState(channelKey, now) : null,
      guildKey,
    };
  }

  // Channels are kept for the channel limit and for the per-channel cap on notices.
  tracksChannels() {
    return this.channelFlood || this.notices;
  }

  // Decides one AI request. `explicit` is true when the member addressed 小吉 (a mention, a message
  // starting with 小吉, or a reply to 小吉) and false for a message that only continues a conversation.
  // Only explicit requests count toward a cooldown or get a notice: a continuing message may not have
  // been meant for 小吉 at all. `topic` only scopes the repeat check (the turtle soup judge passes the
  // kind, so a guess is never a repeat of a question with the same words); the limits are shared.
  // `hasAttachment` is true when the message carries a file or image: that is content, so a message with no
  // meaningful text is not "meaningless"; every rate limit still counts it.
  evaluate({ guildId = null, channelId, userId, text, explicit = true, topic = '', hasAttachment = false } = {}) {
    const now = this.currentTime();
    const { user, channel, guildKey } = this.states({ guildId, channelId, userId }, now);
    const context = { guildKey, channelId, userId, explicit: Boolean(explicit) };

    if (now < user.cooldownUntil) return this.block(AI_SPAM_BLOCK_REASONS.COOLDOWN, user, channel, context, now);
    if (!hasAttachment && classifyMeaningless(text, this.limits)) {
      return this.block(AI_SPAM_BLOCK_REASONS.MEANINGLESS, user, channel, context, now);
    }

    const key = repeatKey(text, this.limits);
    const checksRepeat = key.length >= this.limits.repeatMinLength;
    user.recent = user.recent.filter((entry) => now - entry.at < this.limits.repeatWindowMs);
    const copies = checksRepeat ? user.recent
      .filter((entry) => entry.topic === topic && isNearDuplicate(entry.key, key, this.limits)).length : 0;
    if (copies >= this.limits.repeatEarlierCopiesToBlock) {
      return this.block(AI_SPAM_BLOCK_REASONS.REPEAT, user, channel, context, now);
    }

    user.admitted = within(user.admitted, now, this.limits.userLongWindowMs);
    const shortCount = user.admitted.filter((at) => now - at < this.limits.userShortWindowMs).length;
    if (shortCount >= this.limits.userShortMaxRequests || user.admitted.length >= this.limits.userLongMaxRequests) {
      return this.block(AI_SPAM_BLOCK_REASONS.USER_RATE, user, channel, context, now);
    }

    if (this.channelFlood) {
      channel.admitted = within(channel.admitted, now, this.limits.channelWindowMs);
      if (channel.admitted.length >= this.limits.channelMaxRequests) {
        return this.block(AI_SPAM_BLOCK_REASONS.CHANNEL_FLOOD, user, channel, context, now);
      }
    }

    user.admitted.push(now);
    let ticket = null;
    if (checksRepeat) {
      const entry = Object.freeze({ key, topic, at: now });
      user.recent.push(entry);
      if (user.recent.length > this.limits.repeatHistorySize) user.recent.splice(0, user.recent.length - this.limits.repeatHistorySize);
      ticket = Object.freeze({ user, entry });
    }
    if (this.channelFlood) channel.admitted.push(now);
    return Object.freeze({ allowed: true, ticket });
  }

  // Takes an admitted request back out of the repeat history when it got no answer after all (the model
  // failed, the 3-second cooldown, the guild quota or the provider guard held it back), so that sending it
  // again is not a repeat. It still counts toward the rate limits.
  forgetRepeat(ticket) {
    if (!ticket?.user || !ticket.entry) return;
    const index = ticket.user.recent.indexOf(ticket.entry);
    if (index >= 0) ticket.user.recent.splice(index, 1);
  }

  // A bare mention, or a message that is only 小吉: not a request for the model and never counted
  // against the member. It is answered with AI_SPAM_PRESENCE_REPLY at most once per member per window
  // (within the channel's cap on notices) and otherwise ignored; during a cooldown it is treated as the
  // cooldown says, still without counting against the member.
  evaluatePresence({ guildId = null, channelId, userId } = {}) {
    const now = this.currentTime();
    const { user, channel, guildKey } = this.states({ guildId, channelId, userId }, now);
    if (now < user.cooldownUntil) {
      return this.block(AI_SPAM_BLOCK_REASONS.COOLDOWN, user, channel, { guildKey, channelId, userId, explicit: true }, now);
    }
    let notice = null;
    if (this.notices && now >= user.presenceUntil && this.takeChannelNotice(channel, now)) {
      user.presenceUntil = now + this.limits.presenceReplyWindowMs;
      notice = AI_SPAM_PRESENCE_REPLY;
    }
    this.observe(`TEST_OBS_${this.codePrefix}_PRESENCE`);
    return Object.freeze({ allowed: false, reason: AI_SPAM_BLOCK_REASONS.PRESENCE, notice, cooldownStarted: false });
  }

  block(reason, user, channel, context, now) {
    let cooldownStarted = false;
    if (this.cooldowns && context.explicit && STRIKE_REASONS.has(reason)) {
      user.strikes = within(user.strikes, now, this.limits.strikeWindowMs);
      user.strikes.push(now);
      if (user.strikes.length >= this.limits.strikesToCooldown) {
        this.startCooldown(user, context, now);
        cooldownStarted = true;
      }
    }

    let notice = null;
    if (this.notices && context.explicit) {
      if (reason === AI_SPAM_BLOCK_REASONS.CHANNEL_FLOOD) {
        if (now >= channel.floodNoticeUntil && this.takeChannelNotice(channel, now)) {
          channel.floodNoticeUntil = now + this.limits.channelFloodNoticeWindowMs;
          notice = AI_SPAM_NOTICES[reason];
        }
      } else if (now >= user.noticeUntil && this.takeChannelNotice(channel, now)) {
        const cooling = now < user.cooldownUntil;
        user.noticeUntil = cooling ? user.cooldownUntil : now + this.limits.userNoticeWindowMs;
        if (cooldownStarted) notice = cooldownStartedNotice(user.cooldownUntil - now);
        else if (cooling) notice = cooldownNotice(user.cooldownUntil - now);
        else notice = AI_SPAM_NOTICES[reason];
      }
    }

    this.observe(`TEST_OBS_${this.codePrefix}_BLOCKED`);
    this.observe(`TEST_OBS_${this.codePrefix}_${reason.toUpperCase()}`);
    if (notice) this.observe(`TEST_OBS_${this.codePrefix}_NOTICE`);
    const code = `${this.codePrefix}_BLOCKED`;
    this.codeLog.write(`${code}:${reason}`, 'info', `${this.logPrefix} code=${code} reason=${reason}`);
    return Object.freeze({ allowed: false, reason, notice, cooldownStarted });
  }

  startCooldown(user, context, now) {
    if (user.level > 0 && now >= user.levelExpiresAt) user.level = 0;
    user.level = Math.min(user.level + 1, this.limits.cooldownStepsMs.length);
    const durationMs = this.limits.cooldownStepsMs[user.level - 1];
    user.cooldownUntil = now + durationMs;
    user.levelExpiresAt = user.cooldownUntil + this.limits.cooldownLevelResetMs;
    user.strikes = [];
    // A new cooldown is a new notice period: the member is told once that it started.
    user.noticeUntil = 0;
    const code = `${this.codePrefix}_COOLDOWN_STARTED`;
    this.observe(`TEST_OBS_${code}`);
    this.codeLog.write(code, 'warn',
      `${this.logPrefix} code=${code} level=${user.level} minutes=${Math.round(durationMs / 60_000)} ` +
      `guild=${context.guildKey === 'dm' ? 'dm' : safeId(context.guildKey)} user=${safeId(context.userId)}`);
  }

  takeChannelNotice(channel, now) {
    channel.notices = within(channel.notices, now, this.limits.channelNoticeWindowMs);
    if (channel.notices.length >= this.limits.channelNoticeMaxPerWindow) return false;
    channel.notices.push(now);
    return true;
  }

  // A notice that could not be sent is only logged, under the same throttle as everything else.
  reportNoticeFailure() {
    const code = `${this.codePrefix}_NOTICE_FAILED`;
    this.codeLog.write(code, 'warn', `${this.logPrefix} code=${code}`);
  }

  userState(key, now) {
    let state = this.users.get(key);
    if (!state) {
      while (this.users.size >= this.limits.maxTrackedUsers) this.evictUser(now);
      state = {
        admitted: [], recent: [], strikes: [], level: 0, cooldownUntil: 0, levelExpiresAt: 0, noticeUntil: 0,
        presenceUntil: 0, lastSeenAt: now,
      };
      this.users.set(key, state);
    }
    state.lastSeenAt = now;
    return state;
  }

  channelState(key, now) {
    let state = this.channels.get(key);
    if (!state) {
      while (this.channels.size >= this.limits.maxTrackedChannels) {
        let oldest = null;
        for (const [channelKey, channel] of this.channels) {
          if (!oldest || channel.lastSeenAt < oldest.channel.lastSeenAt) oldest = { channelKey, channel };
        }
        this.channels.delete(oldest.channelKey);
      }
      state = { admitted: [], notices: [], floodNoticeUntil: 0, lastSeenAt: now };
      this.channels.set(key, state);
    }
    state.lastSeenAt = now;
    return state;
  }

  // The member to forget when the map is full: one with no cooldown and no cooldown level first, then one
  // with no running cooldown, and only then the cooldown that ends soonest. Oldest first within each.
  evictUser(now) {
    let victim = null;
    for (const [key, state] of this.users) {
      const rank = now < state.cooldownUntil ? 2 : state.level > 0 && now < state.levelExpiresAt ? 1 : 0;
      const order = rank === 2 ? state.cooldownUntil : state.lastSeenAt;
      if (!victim || rank < victim.rank || (rank === victim.rank && order < victim.order)) victim = { key, rank, order };
    }
    if (victim) this.users.delete(victim.key);
  }

  sweep(now) {
    this.lastSweepAt = now;
    for (const [key, state] of this.users) {
      state.admitted = within(state.admitted, now, this.limits.userLongWindowMs);
      state.recent = state.recent.filter((entry) => now - entry.at < this.limits.repeatWindowMs);
      state.strikes = within(state.strikes, now, this.limits.strikeWindowMs);
      if (state.level > 0 && now >= state.levelExpiresAt) state.level = 0;
      const idle = state.admitted.length === 0 && state.recent.length === 0 && state.strikes.length === 0 &&
        state.level === 0 && now >= state.cooldownUntil && now >= state.noticeUntil && now >= state.presenceUntil;
      if (idle) this.users.delete(key);
    }
    for (const [key, state] of this.channels) {
      state.admitted = within(state.admitted, now, this.limits.channelWindowMs);
      state.notices = within(state.notices, now, this.limits.channelNoticeWindowMs);
      if (state.admitted.length === 0 && state.notices.length === 0 && now >= state.floodNoticeUntil) this.channels.delete(key);
    }
  }

  resetForTests() {
    this.users.clear();
    this.channels.clear();
    this.codeLog.clear();
    this.lastSweepAt = null;
  }

  getStatsForTests() {
    return Object.freeze({ trackedUsers: this.users.size, trackedChannels: this.channels.size });
  }
}

const aiSpamGuard = new AiSpamGuard();
const turtleSoupSpamGuard = new AiSpamGuard({
  limits: TURTLE_SOUP_SPAM_LIMITS,
  channelFlood: false,
  cooldowns: false,
  notices: false,
  codePrefix: 'TURTLE_SOUP_SPAM',
  logPrefix: '[TURTLE_SOUP]',
});

module.exports = {
  AI_SPAM_BLOCK_REASONS,
  AI_SPAM_LIMITS,
  AI_SPAM_NOTICES,
  AI_SPAM_PRESENCE_REPLY,
  AiSpamGuard,
  TURTLE_SOUP_SPAM_LIMITS,
  aiSpamGuard,
  classifyMeaningless,
  isBareCall,
  isNearDuplicate,
  repeatKey,
  turtleSoupSpamGuard,
};
