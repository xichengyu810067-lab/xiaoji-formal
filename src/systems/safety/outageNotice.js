'use strict';

/*
 * What is told once an outage that nobody chose has ended and the bot has been steady again
 * (outageMonitor.js decides when; this module is the delivery it is handed).
 *
 * The public notice. In every server the bot was in before the outage began, one fixed message in
 * the server's welcome channel, or else its system channel; a server with neither, or where the
 * bot may not write in it, is skipped with a log line. There is deliberately no "first text
 * channel" fallback, which the welcome message has: this notice is no greeting, and a channel
 * chosen at random is worse than none.
 *   - The text is fixed in code (outageNoticeText): the length of the outage in whole minutes and
 *     nothing else. It carries no link, no mention and nothing a member or a server wrote, and
 *     it does not go through the AI conversation: this module loads none of it.
 *   - At most one per server in 24 hours (the time a notice was claimed is kept in the liveness
 *     record; a time more than 5 minutes ahead of the clock is not believed), and servers are
 *     at least 1.5 seconds apart.
 *   - Each send goes through the protected channel of client.rest (protectedRest.js): it reaches
 *     Discord once and never again, with no retry. It is not a ledger purpose and writes no
 *     ledger; the claim is the liveness record's: written, durably, at the network entry,
 *     after the egress limiter's and guard's admission, so a request refused locally writes
 *     nothing. An answer is kept as it came: sent, rejected (a 4xx, a 403 for a channel that
 *     cannot be written to), or unknown (5xx, timeout, connection). Nothing but a request that
 *     never left the bot, or Discord's own 429 (which means it took no effect), is tried again,
 *     at the next heartbeat and at most MAX_ATTEMPTS times for one server; a claim a crash left
 *     behind is unknown and is never sent again.
 *
 * The Owner's notice. One per outage, an OWNER_EVENT_RECOVERED event of the catalogue
 * (safetyEventCatalog.js), which the Owner notifier words from fixed fields (the start and the end
 * of the outage as Discord timestamps, and one of three fixed kinds: a crash, a lost connection, a
 * restored backup) and charges to its own budget (owner-outage). It is handed over inside a
 * background operation context whose source event is made from the outage's start, so the same
 * outage always has the same identity, however many starts it spans. The pending is marked as
 * handed over before the event is emitted, so a crash in between sends it once at most. It is a
 * separate notice from the start's ledger notice (ledgerAlerts.js); they are never merged. When
 * the Owner notifier cannot take it (its ledger is off, or the kill switch is), it is only logged
 * in this process and the pending is kept for a later start, until it expires.
 *
 * Events during the outage are not made up for, and nothing here collects them: the schedules
 * pick up from the database's state when they start, which is what the text says.
 */

const crypto = require('node:crypto');
const { PermissionFlagsBits, Routes } = require('discord.js');
const defaultLogger = require('../../utils/logger');
const { runWithHostOperationContext } = require('../../platform/hostOperationContext');
const { installProtectedRest } = require('../../platform/protectedRest');
const { SAFETY_EVENT_CODES, emitSafetyEvent } = require('../../platform/safetyEventCatalog');
const { cachedBotMember, resolveBotMember } = require('../../utils/botMember');

const NOTICE_LABEL = 'outage.notice';
const SEND_DEADLINE_MS = 15_000;
const GUILD_SPACING_MS = 1_500;
// How many times one server's notice may be held back (by the egress limit, a rate limit, or a bot
// member that could not be had) before it is given up for this outage.
const MAX_ATTEMPTS = 3;
const GUILD_NOTICE_INTERVAL_MS = 24 * 60 * 60 * 1_000;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;
const SNOWFLAKE = /^\d{17,20}$/u;
const NO_MENTIONS = Object.freeze({ parse: [], users: [], roles: [], replied_user: false });

// The one text of the public notice. minutes is the length of the outage in whole minutes.
function outageNoticeText(minutes) {
  const count = Number.isSafeInteger(minutes) && minutes > 0 ? minutes : 1;
  return `小吉剛才因為意外狀況暫停運作了約 ${count} 分鐘，現在已經恢復。停運期間發生的事件原則上不會補發，` +
    '已經排進排程的操作會照原本的規則接續處理。';
}

function outageMinutes(pending) {
  return Math.max(1, Math.round((pending.endedAtMs - pending.startedAtMs) / 60_000));
}

function defaultGetConfig(guildId) {
  // Loaded when first needed: the settings file is created on first read.
  return require('../../utils/guildConfig').getGuildConfig(guildId);
}

function defaultSleep(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function canSend(channel, botMember) {
  if (!channel?.id || !channel.isTextBased?.()) return false;
  const permissions = channel.permissionsFor?.(botMember);
  return Boolean(permissions?.has(PermissionFlagsBits.ViewChannel) && permissions?.has(PermissionFlagsBits.SendMessages));
}

function errorToken(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return /^[A-Z][A-Z0-9_]{1,63}$/u.test(code) ? code : 'UNEXPECTED_ERROR';
}

// The fixed background job of the Owner's notice, and the source event of one outage: made from
// the outage's start (the pending's id), so it never changes while the outage is the same.
const OWNER_NOTICE_JOB = 'safety.outage-notice';

function ownerSourceEventId(pendingId) {
  return `outage:${crypto.createHash('sha256').update(`outage-owner-v1:${pendingId}`).digest('hex').slice(0, 32)}`;
}

// ownerNotifier is the Owner notifier (isReady()); null means this process has none to tell, in
// which case the Owner's notice is not part of the delivery at all.
//
// isEligible(guild) is the one place that may keep a server out of the public notice besides the
// rules above; every server is eligible by default (guilds are not reviewed). A predicate that
// throws counts as not eligible.
function createOutageNotice({
  client,
  ownerNotifier = null,
  isEligible = () => true,
  logger = defaultLogger,
  getConfig = defaultGetConfig,
  installRest = installProtectedRest,
  sleep = defaultSleep,
  spacingMs = GUILD_SPACING_MS,
  maxAttempts = MAX_ATTEMPTS,
  deadlineMs = SEND_DEADLINE_MS,
} = {}) {
  if (!client) throw new TypeError('A client is required.');
  // How often each server's notice was held back in this process.
  const attempts = new Map();
  let protectedRest = null;
  // The Owner notifier could not take the notice: not tried again in this process.
  let ownerUnavailable = false;

  const info = (code, detail = '') => {
    try { logger?.info?.(`[OUTAGE_NOTICE] code=${code}${detail}`); } catch {}
  };
  const warn = (code, detail = '') => {
    try { logger?.warn?.(`[OUTAGE_NOTICE] code=${code}${detail}`); } catch {}
  };

  function skip(store, guildId, reason) {
    store.settleGuild(guildId, `skipped:${reason}`);
    info('OUTAGE_NOTICE_SKIPPED', ` guild=${guildId} reason=${reason}`);
    return 'done';
  }

  // Held back for this heartbeat; the third time ends the server's notice for this outage.
  function hold(store, guildId, reason, detail = '') {
    const count = (attempts.get(guildId) || 0) + 1;
    attempts.set(guildId, count);
    if (count >= maxAttempts) return skip(store, guildId, 'retry-limit');
    info('OUTAGE_NOTICE_DEFERRED', ` guild=${guildId} reason=${reason} attempt=${count}${detail}`);
    return 'deferred';
  }

  // The channel the notice goes to: the welcome channel the server set, else its system channel.
  function pickChannel(guild, botMember) {
    const candidates = [];
    let configuredId = null;
    try {
      const value = getConfig(guild.id)?.welcomeChannelId;
      configuredId = typeof value === 'string' && SNOWFLAKE.test(value) ? value : null;
    } catch {
      configuredId = null;
    }
    if (configuredId) {
      const configured = guild.channels?.cache?.get?.(configuredId);
      if (configured) candidates.push(configured);
    }
    let system = null;
    try { system = guild.systemChannel ?? null; } catch { system = null; }
    if (system && !candidates.some((channel) => channel.id === system.id)) candidates.push(system);
    if (!candidates.length) return { channel: null, reason: 'no-channel' };
    const usable = candidates.find((channel) => canSend(channel, botMember));
    return usable ? { channel: usable, reason: null } : { channel: null, reason: 'no-permission' };
  }

  // The one request, admitted by the egress limiter first (reserve: a request it would refuse
  // never claims anything) and claimed at the network entry. Returns { held } for a request
  // the limiter held back, or { sent, claimed }.
  async function send(store, guild, channel, text) {
    const request = { method: 'POST', fullRoute: Routes.channelMessages(channel.id),
      body: { content: text, allowed_mentions: NO_MENTIONS } };
    const limiter = client.egressLimiter;
    let reservation = null;
    if (limiter && typeof limiter.reserve === 'function') {
      const reserved = limiter.reserve(request);
      if (!reserved.allowed) return { held: true, retryAfterMs: reserved.retryAfterMs };
      reservation = reserved.reservation;
    }
    let claimed = false;
    // Runs at the network entry (protectedRest.js), outside the protected context: stopped, or
    // a claim that cannot be written, sends nothing.
    const enterNetwork = () => {
      if (store.isStopping()) throw Object.assign(new Error('OUTAGE_NOTICE_STOPPING'), { unavailable: true });
      const at = store.now();
      if (at === null || !store.claimGuild(guild.id, at)) {
        throw Object.assign(new Error('OUTAGE_NOTICE_CLAIM_FAILED'), { claimFailed: true });
      }
      claimed = true;
    };
    const run = () => protectedRest.send(request, { deadlineMs, label: NOTICE_LABEL, onNetworkEntry: enterNetwork });
    try {
      const sent = reservation && typeof limiter.runWithReservation === 'function'
        ? await limiter.runWithReservation(reservation, run) : await run();
      return { sent, claimed };
    } finally {
      if (reservation) limiter.cancel?.(reservation);
    }
  }

  // One server: 'done' (its notice ended: sent or skipped), 'deferred' (try again at the next
  // heartbeat) or 'halt' (nothing more can be sent in this process).
  async function handleGuild({ store, pending, guild, text, pace }) {
    const guildId = guild.id;
    const at = store.now();
    if (at === null) return 'halt';
    // Only the servers the bot was in before the outage began: a later join was never told of
    // anything, and one left meanwhile is not in the cache at all.
    const joinedAtMs = guild.joinedTimestamp;
    if (!Number.isSafeInteger(joinedAtMs) || joinedAtMs <= 0) return skip(store, guildId, 'join-unknown');
    if (joinedAtMs >= pending.startedAtMs) return skip(store, guildId, 'joined-later');
    let eligible = false;
    try { eligible = isEligible(guild) === true; } catch { eligible = false; }
    if (!eligible) return skip(store, guildId, 'not-eligible');
    if (guild.available === false) return hold(store, guildId, 'unavailable');
    const last = store.lastNoticeAtMs(guildId);
    if (last !== null && last <= at + CLOCK_TOLERANCE_MS && at - last < GUILD_NOTICE_INTERVAL_MS) {
      return skip(store, guildId, 'recent');
    }
    const botMember = cachedBotMember(guild) ?? await resolveBotMember(guild);
    if (!botMember) return hold(store, guildId, 'bot-member');
    const { channel, reason } = pickChannel(guild, botMember);
    if (!channel) return skip(store, guildId, reason);

    await pace.before();
    let outcome;
    try {
      outcome = await send(store, guild, channel, text);
    } catch (error) {
      // Before the network (the limiter threw): nothing was claimed.
      warn('OUTAGE_NOTICE_FAILED', ` guild=${guildId} cause=${errorToken(error)}`);
      return hold(store, guildId, 'send-error');
    }
    if (outcome.held) return hold(store, guildId, 'egress-limited', ` retryAfterMs=${outcome.retryAfterMs ?? 0}`);
    const { sent, claimed } = outcome;
    if (claimed) pace.entered();
    if (!claimed) {
      // Nothing reached the network and nothing was written.
      if (sent.reason === 'entry_failed') {
        if (sent.entryError?.claimFailed === true) {
          warn('OUTAGE_NOTICE_STATE_UNWRITABLE', ` guild=${guildId}`);
        }
        return 'halt';
      }
      if (sent.kind === 'not_sent' && sent.terminal === true) return skip(store, guildId, 'refused');
      return hold(store, guildId, `not-sent-${sent.reason || 'unknown'}`);
    }
    if (sent.kind === 'confirmed') {
      store.settleGuild(guildId, 'sent');
      info('OUTAGE_NOTICE_SENT', ` guild=${guildId}`);
      return 'done';
    }
    if (sent.kind === 'rejected' && sent.reason === 'rate_limited') {
      // Discord's own 429: the message took no effect, so the claim is given back.
      store.releaseGuild(guildId);
      return hold(store, guildId, 'rate-limited', ` retryAfterMs=${sent.retryAfterMs ?? 0}`);
    }
    if (sent.kind === 'rejected') {
      store.settleGuild(guildId, 'rejected');
      warn('OUTAGE_NOTICE_REJECTED', ` guild=${guildId} status=${Number.isInteger(sent.httpStatus) ? sent.httpStatus : 0}`);
      return 'done';
    }
    if (sent.kind === 'not_sent') {
      // Cannot follow a claim (the claim is made at the network entry); given back to be safe.
      store.releaseGuild(guildId);
      return hold(store, guildId, `not-sent-${sent.reason || 'unknown'}`);
    }
    store.settleGuild(guildId, 'unknown');
    warn('OUTAGE_NOTICE_UNKNOWN', ` guild=${guildId} reason=${typeof sent.reason === 'string' ? sent.reason : 'unknown'}`);
    return 'done';
  }

  // The servers, in ID order: 'done' (every server has its end), 'waiting' (a server was held
  // back), or 'halt' (nothing more can be sent in this process).
  async function announce(store, pending) {
    const text = outageNoticeText(outageMinutes(pending));
    const guilds = [...(client.guilds?.cache?.values?.() || [])]
      .filter((guild) => SNOWFLAKE.test(String(guild?.id)))
      .sort((left, right) => (BigInt(left.id) < BigInt(right.id) ? -1 : 1));
    let waiting = false;
    let enteredBefore = false;
    const pace = {
      // At least spacingMs between two servers that were sent to.
      async before() {
        if (enteredBefore) await sleep(spacingMs);
      },
      entered() {
        enteredBefore = true;
      },
    };
    for (const guild of guilds) {
      if (store.isStopping()) return 'waiting';
      if (Object.hasOwn(pending.guilds, guild.id)) continue;
      let result;
      try {
        result = await handleGuild({ store, pending, guild, text, pace });
      } catch (error) {
        // A fault after a claim leaves the answer unknown; before one, the server is held back.
        warn('OUTAGE_NOTICE_FAILED', ` guild=${guild.id} cause=${errorToken(error)}`);
        const current = store.pending();
        if (current?.guilds?.[guild.id] === 'claimed') {
          store.settleGuild(guild.id, 'unknown');
          result = 'done';
        } else {
          result = hold(store, guild.id, 'unexpected');
        }
      }
      if (result === 'halt') return 'halt';
      if (result === 'deferred') waiting = true;
    }
    return waiting ? 'waiting' : 'done';
  }

  // Hands the outage to the Owner notifier as one OWNER_EVENT_RECOVERED event. true once it is
  // handed over (or was before); false when the notifier cannot take it.
  function notifyOwner(store, pending) {
    if (ownerNotifier === null || pending.owner !== 'none') return true;
    if (ownerUnavailable) return false;
    let ready = false;
    try { ready = ownerNotifier.isReady?.() === true; } catch { ready = false; }
    if (!ready) {
      ownerUnavailable = true;
      warn('OUTAGE_OWNER_NOTICE_UNAVAILABLE', ' reason=notifier');
      return false;
    }
    // Recorded before the event is emitted: at most once, even across a crash.
    if (!store.markOwnerQueued()) {
      ownerUnavailable = true;
      warn('OUTAGE_OWNER_NOTICE_UNAVAILABLE', ' reason=state');
      return false;
    }
    const at = store.now();
    const botId = String(client.user?.id || '');
    const context = {
      sourceEventId: ownerSourceEventId(pending.id),
      hostPurpose: `background.${OWNER_NOTICE_JOB}`,
      scope: `background:${OWNER_NOTICE_JOB}`,
      ...(SNOWFLAKE.test(botId) ? { actorId: botId } : {}),
      startedAtMs: at,
    };
    try {
      runWithHostOperationContext(context, () => emitSafetyEvent(SAFETY_EVENT_CODES.OWNER_EVENT_RECOVERED, {
        at,
        actorId: SNOWFLAKE.test(botId) ? botId : null,
        notice: { outageStartedAtMs: pending.startedAtMs, outageEndedAtMs: pending.endedAtMs, outageKind: pending.kind },
      }));
      info('OUTAGE_OWNER_NOTICE_HANDED', ` kind=${pending.kind}`);
    } catch (error) {
      warn('OUTAGE_OWNER_NOTICE_FAILED', ` cause=${errorToken(error)}`);
    }
    return true;
  }

  // The delivery outageMonitor.attachDelivery() takes: 'complete' (everything that could be told
  // was), 'waiting' (a server was held back: try again at the next heartbeat) or 'idle' (nothing
  // more in this process; the pending stays for a later start when the Owner could not be told).
  async function deliver(store) {
    const pending = store.pending();
    if (!pending) return 'complete';
    const ownerDone = notifyOwner(store, pending);
    if (pending.announce) {
      if (!protectedRest) {
        try {
          protectedRest = installRest(client.rest);
        } catch (error) {
          warn('OUTAGE_NOTICE_UNAVAILABLE', ` cause=${errorToken(error)}`);
          return 'idle';
        }
      }
      const result = await announce(store, pending);
      if (result === 'halt') return 'idle';
      if (result === 'waiting') return 'waiting';
    }
    return ownerDone ? 'complete' : 'idle';
  }

  return Object.freeze({ deliver });
}

module.exports = {
  CLOCK_TOLERANCE_MS,
  GUILD_NOTICE_INTERVAL_MS,
  GUILD_SPACING_MS,
  MAX_ATTEMPTS,
  NOTICE_LABEL,
  OWNER_NOTICE_JOB,
  createOutageNotice,
  outageMinutes,
  outageNoticeText,
  ownerSourceEventId,
};
