'use strict';

const crypto = require('node:crypto');
const { PermissionFlagsBits } = require('discord.js');
const { cachedBotMember } = require('../utils/botMember');
const { withCoinDatabase } = require('./coinDatabase');
const {
  claimFeatureOutbox,
  deadLetterFeatureOutbox,
  expireFeatureOutbox,
  markFeatureOutboxDelivered,
  markFeatureOutboxDeliveredByDedupe,
  retryFeatureOutbox,
} = require('./featurePlatformService');
const { getHostOperationContext } = require('../platform/hostOperationContext');
const {
  getPublicEffectRuntime,
  issueChainReactionGrant,
  issueStoredChainReactionGrant,
} = require('../platform/publicEffectAdapter');
const { snowflakeTimestamp } = require('../platform/publicEffectGrant');
const {
  consumeReactionSourceProof,
  proveReactionSourceWithApi,
  purposeFor,
} = require('../systems/safety/chainReactionFence');

const REACTION_EVENT_TYPE = 'discord_reaction';
const REACTION_EMOJI = '✅';
const MAX_REACTION_DELIVERY_ATTEMPTS = 5;
// A ✅ outbox event is kept at most this long after its message (snowflake time, judged on
// the reaction ledger's clock); an older one is closed as expired instead of reacting late.
const REACTION_OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// While the ✅ purpose is unavailable there is no ledger clock: events created this long ago
// on the wall clock are closed as expired instead, at most this many per run.
const UNAVAILABLE_EXPIRE_LIMIT = 25;
// Terminal reasons that only say this one event's source or scope is no longer valid. The
// feature's health is global (one word_chain or number_chain card for every guild), and none
// of these is a fault of the feature, so they close the event without marking it broken:
//   source_unproven    the source no longer proves the ✅ (its round moved on or ended, its
//                      fence changed, or its message is not after the cutover);
//   scope_unavailable  at dispatch, the bot cannot react in the channel (not in the guild, the
//                      channel is gone, a permission is missing);
//   scope_revoked      the same, found at the final authorization;
//   source_revoked     the final source proof failed (the round changed after the dispatch began);
//   effect_rejected_permission  Discord refused the ✅ for the guild or the channel (403: no
//                      access, a missing permission, a blocked reaction);
//   effect_rejected_not_found   Discord no longer has the message or the channel (404);
//   effect_rate_limited         Discord answered the ✅ itself with a rate limit (429).
// The first four are also what an attempt records in memory, and the effect_ ones are the
// result codes of the rejected row, so a later dispatch of the same event names the same
// reason. Any other refusal by Discord (a 400: the request itself is wrong) still marks the
// feature broken.
const HEALTH_NEUTRAL_REASONS = new Set(['source_unproven', 'scope_unavailable', 'scope_revoked', 'source_revoked',
  'effect_rejected_permission', 'effect_rejected_not_found', 'effect_rate_limited']);
const REVOCATION_CODES = new Set(['scope_revoked', 'source_revoked']);
const REASON_TOKEN = /^[a-z][a-z0-9_]{0,40}$/u;

function buildReactionEffect(featureKey, channelId, messageId) {
  return Object.freeze({
    purposeId: purposeFor(featureKey),
    action: 'chain-reaction.put',
    target: String(channelId),
    method: 'PUT',
    route: `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(REACTION_EMOJI)}/@me`,
    body: null,
  });
}

function buildReactionOutboxPayload(source) {
  const payload = {
    g: String(source.guildId),
    c: String(source.channelId),
    m: String(source.messageId),
    u: String(source.authorId),
    f: String(source.sourceFence),
  };
  if (![payload.g, payload.c, payload.m, payload.u].every((value) => /^\d{17,20}$/u.test(value)) ||
      !/^[a-f0-9]{64}$/u.test(payload.f) || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 300) {
    throw new Error('CHAIN_REACTION_OUTBOX_PAYLOAD_INVALID');
  }
  return Object.freeze(payload);
}

function parseReactionOutboxPayload(payload) {
  if (!payload || typeof payload !== 'object') return null;
  try {
    return buildReactionOutboxPayload({
      guildId: payload.g,
      channelId: payload.c,
      messageId: payload.m,
      authorId: payload.u,
      sourceFence: payload.f,
    });
  } catch {
    return null;
  }
}

function sourceFromPayload(payload) {
  return payload ? Object.freeze({ guildId: payload.g, channelId: payload.c,
    messageId: payload.m, authorId: payload.u, sourceFence: payload.f }) : null;
}

async function createSourceProof(source, featureKey) {
  return withCoinDatabase((api) => proveReactionSourceWithApi(api, { featureKey, ...source }));
}

function hasReactionPermission(client, source) {
  const guild = client?.guilds?.cache?.get?.(source.guildId);
  const channel = guild?.channels?.cache?.get?.(source.channelId);
  // Synchronous, so a partial member of the bot (no roles) is no member at all here.
  const member = cachedBotMember(guild);
  if (!guild || !channel || !member || typeof channel.permissionsFor !== 'function') return false;
  const permissions = channel.permissionsFor(member);
  return Boolean(permissions?.has?.([
    PermissionFlagsBits.ViewChannel,
    PermissionFlagsBits.ReadMessageHistory,
    PermissionFlagsBits.AddReactions,
  ]));
}

// A terminal answer of the dispatch names why, when this event's scope or source stopped
// being valid: at this attempt's final authorization (revoked), or at an earlier attempt of
// the same event whose in-memory decision carries that code.
function withRevocationReason(result, revoked) {
  if (result?.kind !== 'terminal') return result;
  const recorded = result.operation?.resultCode;
  const reason = revoked || (REVOCATION_CODES.has(recorded) ? recorded : null);
  return reason ? Object.freeze({ ...result, reason }) : result;
}

async function dispatchChainReaction(client, featureKey, source, { eventGrant = null,
  permissionCheck = hasReactionPermission,
  beforeFinalAuthorization = null, afterBegin = null } = {}) {
  const runtime = getPublicEffectRuntime();
  if (!runtime?.isPurposeReady?.(purposeFor(featureKey))) return Object.freeze({ kind: 'unavailable' });
  // A test-control stop says nothing about the reaction: unavailable (retried), never terminal.
  if (client?.testControlRuntimeController?.isStopping?.()) return Object.freeze({ kind: 'unavailable' });
  // One guild's state (the bot gone, the channel gone, a permission missing) ends this event,
  // never the feature everywhere.
  if (!permissionCheck(client, source)) {
    return Object.freeze({ kind: 'terminal', basis: 'volatile', reason: 'scope_unavailable' });
  }
  const sourceProof = await createSourceProof(source, featureKey);
  if (!sourceProof) {
    // A ledger read that failed while proving the source disabled the purpose: that says
    // nothing about the source, so it is unavailable (retried later), never terminal.
    if (!runtime.isPurposeReady(purposeFor(featureKey))) return Object.freeze({ kind: 'unavailable' });
    // Otherwise the source itself no longer proves the ✅ (its round moved on or ended, its
    // fence changed, or its message is not after the cutover): a terminal computed from the
    // source, which says nothing about the feature's health.
    return Object.freeze({ kind: 'terminal', basis: 'computed', reason: 'source_unproven' });
  }
  const effect = buildReactionEffect(featureKey, source.channelId, source.messageId);
  const grant = eventGrant
    ? issueChainReactionGrant(eventGrant, { sourceProof, effect })
    : issueStoredChainReactionGrant(sourceProof, effect);
  // A grant that cannot be issued for a proven source breaks an invariant: a plain terminal,
  // which marks the feature broken.
  if (!grant) return Object.freeze({ kind: 'terminal' });
  let revoked = null;
  const result = await runtime.dispatch(grant, effect, {
    beforeAttempt: (begin) => withCoinDatabase(async (api) => {
      if (client?.testControlRuntimeController?.isStopping?.()) {
        throw Object.assign(new Error('CHAIN_REACTION_STOPPING'), { unavailable: true });
      }
      if (!permissionCheck(client, source)) {
        revoked = 'scope_revoked';
        throw Object.assign(new Error('CHAIN_REACTION_SCOPE_REVOKED'), {
          terminal: true,
          code: 'scope_revoked',
        });
      }
      const finalProof = proveReactionSourceWithApi(api, { featureKey, ...source });
      const finalRecord = consumeReactionSourceProof(finalProof);
      if (!finalRecord) {
        revoked = 'source_revoked';
        throw Object.assign(new Error('CHAIN_REACTION_REVOKED'), {
          terminal: true,
          code: 'source_revoked',
        });
      }
      if (typeof beforeFinalAuthorization === 'function') await beforeFinalAuthorization();
      begin();
      if (typeof afterBegin === 'function') await afterBegin();
    }),
  });
  return withRevocationReason(result, revoked);
}

async function dispatchImmediateChainReaction(client, featureKey, source, checks = {}) {
  const context = getHostOperationContext();
  const result = await dispatchChainReaction(client, featureKey, source, {
    eventGrant: context?.sourceEventId === source.messageId ? context.publicEffectEventGrant : null,
    ...checks,
  });
  if (result.kind === 'confirmed') {
    await markFeatureOutboxDeliveredByDedupe({
      guildId: source.guildId,
      featureKey,
      eventType: REACTION_EVENT_TYPE,
      dedupeKey: `reaction:${source.messageId}`,
      now: new Date(),
    });
  }
  return result;
}

function getRetryDelay(attemptCount) {
  return Math.min(5 * 60 * 1000, 15_000 * 2 ** Math.min(4, Math.max(0, Number(attemptCount) - 1)));
}

// Whether a ✅ event is older than REACTION_OUTBOX_MAX_AGE_MS on the reaction ledger's clock;
// false when the clock cannot be read (the dispatch then answers unavailable).
function reactionExpired(source, featureKey) {
  const ledgerNow = getPublicEffectRuntime()?.getObservedNow?.(purposeFor(featureKey));
  const sentAt = snowflakeTimestamp(source?.messageId);
  return Number.isSafeInteger(ledgerNow) && Number.isSafeInteger(sentAt) && ledgerNow - sentAt > REACTION_OUTBOX_MAX_AGE_MS;
}

// Zero-write view, on the reaction ledger, of the one ✅ an event asks for (the identity its
// dispatch binds); unavailable when there is no ready purpose to ask.
function inspectReaction(featureKey, source) {
  const runtime = getPublicEffectRuntime();
  if (typeof runtime?.inspectSource !== 'function') return Object.freeze({ kind: 'unavailable' });
  return runtime.inspectSource({
    purposeId: purposeFor(featureKey),
    botId: runtime.botId,
    featureKey,
    guildId: source.guildId,
    channelId: source.channelId,
    messageId: source.messageId,
    sourceTimestampMs: snowflakeTimestamp(source.messageId),
  });
}

// While the reaction purpose is unavailable (or the test-control runtime is stopping) no
// event is claimed, so no attempt is counted and nothing is dead-lettered; an event that
// meets that state after its claim is given back without counting. An event is closed as
// expired only once its message is more than a day old: on the ledger clock, after a
// zero-write look at the ledger (a ✅ it already confirmed is marked delivered instead), or,
// while the purpose is unavailable, on the wall clock (a bounded number per run; a stop
// writes nothing). An expired event, or one whose source or scope is no longer valid or
// that Discord refused for its guild, its message, or a rate limit (HEALTH_NEUTRAL_REASONS),
// never marks the feature broken.
async function processChainReactionOutbox(client, featureKey, {
  workerId = `${featureKey}-reaction:${process.pid}:${crypto.randomUUID()}`,
  limit = 20,
  claim = claimFeatureOutbox,
  markDelivered = markFeatureOutboxDelivered,
  retry = retryFeatureOutbox,
  deadLetter = deadLetterFeatureOutbox,
  expire = expireFeatureOutbox,
  permissionCheck = hasReactionPermission,
  now = () => new Date(),
} = {}) {
  const summary = { claimed: 0, delivered: 0, retried: 0, terminal: 0 };
  const stopping = Boolean(client?.testControlRuntimeController?.isStopping?.());
  if (stopping || !getPublicEffectRuntime()?.isPurposeReady?.(purposeFor(featureKey))) {
    const unavailable = { ...summary, unavailable: true };
    if (!stopping) {
      const current = now();
      const { expired } = await expire({ featureKey, eventType: REACTION_EVENT_TYPE,
        createdBefore: new Date(current.getTime() - REACTION_OUTBOX_MAX_AGE_MS), reason: 'expired',
        error: 'reaction_expired_unavailable', limit: UNAVAILABLE_EXPIRE_LIMIT, now: current });
      if (expired > 0) unavailable.expired = expired;
    }
    return unavailable;
  }
  const events = await claim({ workerId, eventType: REACTION_EVENT_TYPE, featureKey, limit, now: now() });
  summary.claimed = events.length;
  for (const event of events) {
    const payload = parseReactionOutboxPayload(event.payload);
    const source = sourceFromPayload(payload);
    let outcome;
    try {
      const matches = event.featureKey === featureKey && event.guildId === source?.guildId;
      if (matches && reactionExpired(source, featureKey)) {
        const view = inspectReaction(featureKey, source);
        if (view.kind === 'confirmed') {
          const delivered = await markDelivered(event.id, { workerId, now: now() });
          if (delivered.updated) summary.delivered += 1;
          continue;
        }
        if (view.kind === 'unavailable') {
          const retried = await retry(event.id, { workerId, error: new Error('reaction_unavailable'),
            delayMs: getRetryDelay(event.attemptCount), now: now(), uncounted: true });
          if (retried.updated) summary.retried += 1;
          continue;
        }
        const expired = await deadLetter(event.id, { workerId,
          error: new Error('reaction_expired'), reason: 'expired', now: now(), affectsHealth: false });
        if (expired.updated) {
          summary.terminal += 1;
          summary.expired = (summary.expired || 0) + 1;
        }
        continue;
      }
      outcome = matches
        ? await dispatchChainReaction(client, featureKey, source, { permissionCheck })
        : { kind: 'terminal' };
      if (outcome.kind === 'confirmed') {
        const delivered = await markDelivered(event.id, { workerId, now: now() });
        if (delivered.updated) summary.delivered += 1;
        continue;
      }
      if (outcome.kind === 'unknown' || outcome.kind === 'terminal') {
        // A terminal that only says this event's source or scope is no longer valid, or that
        // Discord refused this one ✅ (computed from the source, or one of
        // HEALTH_NEUTRAL_REASONS), is closed without marking the feature broken, under a reason
        // that names why (reaction_<reason>), so a dead letter shows whether it touched the
        // feature's health. An unknown result and every other terminal (reaction_unknown,
        // reaction_terminal) still mark it.
        const neutral = outcome.kind === 'terminal' &&
          (outcome.basis === 'computed' || HEALTH_NEUTRAL_REASONS.has(outcome.reason));
        const reason = neutral
          ? `reaction_${REASON_TOKEN.test(String(outcome.reason || '')) ? outcome.reason : 'computed'}`
          : `reaction_${outcome.kind}`;
        const terminal = await deadLetter(event.id, { workerId, error: new Error(reason), reason, now: now(),
          affectsHealth: !neutral });
        if (terminal.updated) summary.terminal += 1;
        continue;
      }
      if (outcome.kind === 'unavailable') {
        // The purpose became unavailable, or a stop began, during this batch: the claim is
        // given back without counting, and the event waits for an available purpose.
        const retried = await retry(event.id, { workerId, error: new Error('reaction_unavailable'),
          delayMs: getRetryDelay(event.attemptCount), now: now(), uncounted: true });
        if (retried.updated) summary.retried += 1;
        continue;
      }
      if (outcome.kind === 'deferred') {
        // An egress reservation was refused before this ✅ could reach Discord.  This is
        // back-pressure, not a delivery failure, so it must not consume retry budget.
        const current = now();
        const until = Number.isSafeInteger(outcome.retryNotBeforeMs)
          ? Math.max(0, outcome.retryNotBeforeMs - current.getTime())
          : Number.isSafeInteger(outcome.retryAfterMs) ? outcome.retryAfterMs : 0;
        const retried = await retry(event.id, { workerId, error: new Error('reaction_deferred'),
          delayMs: Math.max(getRetryDelay(event.attemptCount), until), now: current, uncounted: true });
        if (retried.updated) summary.retried += 1;
        continue;
      }
      // Only answers from an available purpose (retryable, in flight) count toward the limit.
      if (event.attemptCount >= MAX_REACTION_DELIVERY_ATTEMPTS) {
        const terminal = await deadLetter(event.id, { workerId,
          error: new Error(`reaction_${outcome.kind}`), reason: 'max_attempts', now: now() });
        if (terminal.updated) summary.terminal += 1;
        continue;
      }
      const retried = await retry(event.id, { workerId, error: new Error(`reaction_${outcome.kind}`),
        delayMs: getRetryDelay(event.attemptCount), now: now() });
      if (retried.updated) summary.retried += 1;
    } catch (error) {
      if (event.attemptCount >= MAX_REACTION_DELIVERY_ATTEMPTS) {
        await deadLetter(event.id, { workerId, error, reason: 'max_attempts', now: now() });
        summary.terminal += 1;
      } else {
        const retried = await retry(event.id, { workerId, error,
          delayMs: getRetryDelay(event.attemptCount), now: now() });
        if (retried.updated) summary.retried += 1;
      }
    }
  }
  return summary;
}

module.exports = {
  MAX_REACTION_DELIVERY_ATTEMPTS,
  REACTION_EMOJI,
  REACTION_EVENT_TYPE,
  REACTION_OUTBOX_MAX_AGE_MS,
  UNAVAILABLE_EXPIRE_LIMIT,
  buildReactionEffect,
  buildReactionOutboxPayload,
  dispatchChainReaction,
  dispatchImmediateChainReaction,
  getRetryDelay,
  hasReactionPermission,
  parseReactionOutboxPayload,
  processChainReactionOutbox,
};
