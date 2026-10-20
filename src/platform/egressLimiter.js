'use strict';

// A small in-process admission controller for Discord output.  It deliberately has no
// durable state: durable limits (automatic leaves and DM preparation) are counted by
// their side-effect ledgers instead; the in-process leave windows below only add the
// leaves that no ledger counts to the same cap.  Callers reserve before they claim durable work,
// then the egress guard consumes that reservation immediately before handing the request
// to discord.js.  A cancelled or expired reservation is never counted as output.

const { AsyncLocalStorage } = require('node:async_hooks');
const { routeSegments } = require('./discordRoute');

const storage = new AsyncLocalStorage();
const SNOWFLAKE = /^\d{17,20}$/u;
const RESERVATION_TTL_MS = 30_000;
const MINUTE_MS = 60 * 1_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

const LIMITS = Object.freeze({
  interactionInitial: Object.freeze({ id: 'interaction-initial', maximum: 10, windowMs: 10_000 }),
  messageCreate: Object.freeze({ id: 'message-create', maximum: 20, windowMs: 10_000 }),
  messageUpdate: Object.freeze({ id: 'message-update', maximum: 20, windowMs: 10_000 }),
  reaction: Object.freeze({ id: 'reaction', maximum: 10, windowMs: 10_000 }),
  dmRecipient: Object.freeze({ id: 'dm-recipient', maximum: 3, windowMs: 60 * 60 * 1_000 }),
  dmGlobal: Object.freeze({ id: 'dm-global', maximum: 30, windowMs: 60 * 60 * 1_000 }),
  memberRemoval: Object.freeze({ id: 'member-removal', maximum: 5, windowMs: 60 * 60 * 1_000 }),
  privateMutation: Object.freeze({ id: 'private-mutation', maximum: 5, windowMs: 60 * 60 * 1_000 }),
  bulkDelete: Object.freeze({ id: 'bulk-delete', maximum: 3, windowMs: 10 * 60 * 1_000 }),
  channelDelete: Object.freeze({ id: 'channel-delete', maximum: 2, windowMs: 24 * 60 * 60 * 1_000 }),
  // Every guild leave the bot makes, whoever starts it: an Owner command of a private extension
  // and the (dormant, since guilds are not reviewed) automatic leave of the public-effect runtime
  // share these windows, which repeat the automatic-leave cap of that runtime (3 an hour, 10 a day).
  guildLeaveHour: Object.freeze({ id: 'guild-leave-hour', maximum: 3, windowMs: 60 * 60 * 1_000 }),
  guildLeaveDay: Object.freeze({ id: 'guild-leave-day', maximum: 10, windowMs: 24 * 60 * 60 * 1_000 }),
});

// The budgets of the management a verified extension does in a protected guild (the egress guard
// marks such a request protectedGuildExtension). They are wide enough for the ordinary moderation and
// upkeep of those guilds and still bounded; every other request keeps the budgets above. Scopes are
// per guild, except bulk deletion, which is per channel.
const PROTECTED_GUILD_LIMITS = Object.freeze({
  // Bans, unbans, kicks, timeouts and any other change of a member itself.
  memberSanction: Object.freeze({ id: 'protected-member-sanction', maximum: 30, windowMs: HOUR_MS }),
  // Adding or removing one role of one member, a role sync included. The second window keeps a long
  // sync to a slow, steady pace: a burst over it is deferred instead of spending the hour at once.
  memberRole: Object.freeze({ id: 'protected-member-role', maximum: 300, windowMs: HOUR_MS }),
  memberRoleBurst: Object.freeze({ id: 'protected-member-role-burst', maximum: 30, windowMs: MINUTE_MS }),
  messageDelete: Object.freeze({ id: 'protected-message-delete', maximum: 200, windowMs: HOUR_MS }),
  bulkDelete: Object.freeze({ id: 'protected-bulk-delete', maximum: 10, windowMs: 10 * MINUTE_MS }),
  channelDelete: Object.freeze({ id: 'protected-channel-delete', maximum: 20, windowMs: DAY_MS }),
  channelCreate: Object.freeze({ id: 'protected-channel-create', maximum: 20, windowMs: DAY_MS }),
  // Every other write of the extension there.
  privateMutation: Object.freeze({ id: 'protected-private-mutation', maximum: 60, windowMs: HOUR_MS }),
});
const ALL_LIMITS = Object.freeze([...Object.values(LIMITS), ...Object.values(PROTECTED_GUILD_LIMITS)]);

class EgressRateLimitError extends Error {
  constructor(reason = 'rate_limited', { retryAfterMs = 0, terminal = false } = {}) {
    super('The Discord request was deferred by the egress rate limit.');
    this.name = 'EgressRateLimitError';
    this.code = `EGRESS_${String(reason).toUpperCase()}`;
    this.deferred = !terminal;
    this.terminal = terminal;
    this.retryAfterMs = Math.max(0, Number.isSafeInteger(retryAfterMs) ? retryAfterMs : 0);
  }
}

function snowflake(value) {
  const normalized = typeof value === 'string' ? value : '';
  return SNOWFLAKE.test(normalized) ? normalized : null;
}

function asRouteParts(details = {}) {
  if (Array.isArray(details.segments)) return details.segments;
  const route = typeof details.fullRoute === 'string'
    ? details.fullRoute : typeof details.route === 'string' ? `/${details.route}` : null;
  return routeSegments(route);
}

function methodOf(details) {
  return String(details?.method || '').toUpperCase();
}

function equal(parts, ...expected) {
  return parts?.length === expected.length && expected.every((part, index) => part === '*' || parts[index] === part);
}

function channelScope(details, parts) {
  return snowflake(details?.channelId) || snowflake(parts?.[0] === 'channels' ? parts[1] : null) ||
    snowflake(details?.contextChannelId) || null;
}

function guildScope(details, parts) {
  return snowflake(details?.targetGuildId) || snowflake(parts?.[0] === 'guilds' ? parts[1] : null) || null;
}

function policy(limit, scope) {
  return Object.freeze({ ...limit, scope: String(scope) });
}

// The returned policies are also the canonical reservation identity.  Do not silently
// invent an actor: a missing interaction actor falls back to a single shared scope, so
// malformed callers cannot bypass the cap by omitting identity data.
function policiesFor(details = {}) {
  const parts = asRouteParts(details);
  const method = methodOf(details);
  if (!parts || !method) return Object.freeze([]);
  const body = details.body && typeof details.body === 'object' ? details.body : null;
  const channelId = channelScope(details, parts);
  const guildId = guildScope(details, parts);
  // The guard sets protectedGuildExtension only when the target guild is protected, so it names one.
  const protectedGuild = details.protectedGuildExtension === true && guildId ? guildId : null;

  if (method === 'POST' && equal(parts, 'interactions', '*', '*', 'callback')) {
    // Discord type 7 is an in-place component update, not an initial response.
    if (Number(body?.type) === 7) return Object.freeze([policy(LIMITS.messageUpdate, channelId || 'unknown')]);
    return Object.freeze([policy(LIMITS.interactionInitial, snowflake(details.actorId) || 'unknown')]);
  }

  if (method === 'POST' && equal(parts, 'users', '@me', 'channels')) {
    const recipient = snowflake(body?.recipient_id) || 'unknown';
    return Object.freeze([policy(LIMITS.dmGlobal, 'all'), policy(LIMITS.dmRecipient, recipient)]);
  }

  if (parts[0] === 'channels' && method === 'POST' && equal(parts, 'channels', '*', 'messages', 'bulk-delete')) {
    const messages = body?.messages;
    if (!Array.isArray(messages) || messages.length < 2 || messages.length > 100) {
      throw new EgressRateLimitError('bulk_delete_size', { terminal: true });
    }
    return Object.freeze([policy(protectedGuild ? PROTECTED_GUILD_LIMITS.bulkDelete : LIMITS.bulkDelete, channelId || 'unknown')]);
  }

  if (method === 'DELETE' && equal(parts, 'users', '@me', 'guilds', '*')) {
    return Object.freeze([policy(LIMITS.guildLeaveHour, 'all'), policy(LIMITS.guildLeaveDay, 'all')]);
  }

  if (method === 'DELETE' && equal(parts, 'channels', '*')) {
    return Object.freeze([policy(protectedGuild ? PROTECTED_GUILD_LIMITS.channelDelete : LIMITS.channelDelete, guildId || 'unknown')]);
  }

  if (method === 'DELETE' && equal(parts, 'channels', '*', 'messages', '*')) {
    if (protectedGuild) return Object.freeze([policy(PROTECTED_GUILD_LIMITS.messageDelete, protectedGuild)]);
    return Object.freeze([policy(LIMITS.bulkDelete, channelId || 'unknown')]);
  }

  // Private extensions do not declare granular moderation capabilities.  Outside a protected
  // guild every member mutation therefore shares the conservative guild-wide moderator-operation
  // budget: kicks, bans, timeouts, role changes, and other member PATCH operations. In a protected
  // guild role changes and sanctions have budgets of their own.
  const memberRole = (method === 'PUT' || method === 'DELETE') && equal(parts, 'guilds', '*', 'members', '*', 'roles', '*');
  const memberSanction = (method === 'DELETE' && equal(parts, 'guilds', '*', 'members', '*')) ||
    (method === 'PATCH' && equal(parts, 'guilds', '*', 'members', '*')) ||
    ((method === 'PUT' || method === 'DELETE') && equal(parts, 'guilds', '*', 'bans', '*'));
  if (memberRole && protectedGuild) {
    return Object.freeze([
      policy(PROTECTED_GUILD_LIMITS.memberRole, protectedGuild), policy(PROTECTED_GUILD_LIMITS.memberRoleBurst, protectedGuild),
    ]);
  }
  if (memberSanction && protectedGuild) return Object.freeze([policy(PROTECTED_GUILD_LIMITS.memberSanction, protectedGuild)]);
  if (memberRole || memberSanction) return Object.freeze([policy(LIMITS.memberRemoval, guildId || 'unknown')]);

  if (protectedGuild && method === 'POST' && equal(parts, 'guilds', '*', 'channels')) {
    return Object.freeze([policy(PROTECTED_GUILD_LIMITS.channelCreate, protectedGuild)]);
  }

  if (method === 'PUT' || method === 'DELETE') {
    if (parts[0] === 'channels' && parts[2] === 'messages' && parts[4] === 'reactions' && parts.at(-1) === '@me') {
      return Object.freeze([policy(LIMITS.reaction, channelId || 'unknown')]);
    }
  }

  if ((method === 'PATCH' && parts[0] === 'channels' && parts[2] === 'messages') ||
      (parts[0] === 'webhooks' && parts[3] === 'messages' && ['PATCH', 'DELETE'].includes(method))) {
    return Object.freeze([policy(LIMITS.messageUpdate, channelId || `webhook:${parts[1] || 'unknown'}`)]);
  }

  if ((method === 'POST' && equal(parts, 'channels', '*', 'messages')) ||
      (method === 'POST' && equal(parts, 'webhooks', '*', '*'))) {
    return Object.freeze([policy(LIMITS.messageCreate, channelId || `webhook:${parts[1] || 'unknown'}`)]);
  }

  // "private_write" is the egress guard's deny-by-default bucket.  A verified
  // extension may enter it for a protected guild, but it has no granular capability
  // declaration.  Any mutation not on the explicit public-output routes above must
  // consequently use this conservative shared guild budget; otherwise new Discord
  // management endpoints (role, permission, integration, etc.) would be an unlimited
  // bypass until each route was manually added here.
  if (details.privateExtension === true && details.kind === 'private_write') {
    if (protectedGuild) return Object.freeze([policy(PROTECTED_GUILD_LIMITS.privateMutation, protectedGuild)]);
    return Object.freeze([policy(LIMITS.privateMutation, guildId || 'unknown')]);
  }
  return Object.freeze([]);
}

function identityFor(policies) {
  return policies.map((item) => `${item.id}:${item.scope}`).sort().join('|');
}

function isEgressRateLimitError(error) {
  return error instanceof EgressRateLimitError || error?.code === 'EGRESS_RATE_LIMITED';
}

function createEgressLimiter({ now = () => Date.now(), reservationTtlMs = RESERVATION_TTL_MS } = {}) {
  if (typeof now !== 'function') throw new TypeError('Egress limiter clock must be a function.');
  if (!Number.isSafeInteger(reservationTtlMs) || reservationTtlMs < 1) throw new TypeError('Egress reservation TTL is invalid.');
  const attempts = new Map();
  const reservations = new Map();
  let nextId = 0;

  function currentNow() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('Egress limiter clock returned an invalid value.');
    return value;
  }

  function bucketFor(item) {
    return `${item.id}:${item.scope}`;
  }

  function pruneAttempts(item, at) {
    const key = bucketFor(item);
    const values = attempts.get(key) || [];
    const kept = values.filter((value) => value > at - item.windowMs);
    if (kept.length) attempts.set(key, kept); else attempts.delete(key);
    return kept;
  }

  function limitForBucket(key) {
    return ALL_LIMITS.find((limit) => key.startsWith(`${limit.id}:`)) || null;
  }

  // Individual buckets are tiny, but an attacker can create many distinct actor or
  // channel scopes.  Sweep expired buckets whenever the limiter is entered so that
  // historical scopes cannot turn into unbounded process memory.
  function pruneAllAttempts(at) {
    for (const [key, values] of attempts) {
      const limit = limitForBucket(key);
      const kept = limit ? values.filter((value) => value > at - limit.windowMs) : [];
      if (kept.length) attempts.set(key, kept); else attempts.delete(key);
    }
  }

  function release(id) {
    reservations.delete(id);
  }

  function pruneReservations(at) {
    for (const [id, value] of reservations) if (value.expiresAt <= at) release(id);
  }

  function holdsFor(item, at) {
    const key = bucketFor(item);
    return [...reservations.values()].filter((value) => value.policies.some((policy) => bucketFor(policy) === key) &&
      value.expiresAt > at).length;
  }

  function blockedRetryAfter(item, at) {
    const releases = [
      ...pruneAttempts(item, at).map((value) => value + item.windowMs),
      ...[...reservations.values()].filter((value) => value.policies.some((policy) => bucketFor(policy) === bucketFor(item)))
        .map((value) => value.expiresAt),
    ].sort((left, right) => left - right);
    const position = releases.length - item.maximum;
    return Math.max(0, (releases[Math.max(0, position)] ?? at) - at);
  }

  function reserve(details = {}) {
    const at = currentNow();
    pruneReservations(at);
    pruneAllAttempts(at);
    const policies = policiesFor(details);
    const blocked = policies.map((item) => ({ item, count: pruneAttempts(item, at).length + holdsFor(item, at) }))
      .filter(({ item, count }) => count >= item.maximum);
    if (blocked.length) {
      return Object.freeze({ allowed: false, retryAfterMs: Math.max(...blocked.map(({ item }) => blockedRetryAfter(item, at))) });
    }
    const id = `egress-${++nextId}`;
    const record = Object.freeze({ id, policies, identity: identityFor(policies), expiresAt: at + reservationTtlMs });
    if (policies.length) reservations.set(id, record);
    return Object.freeze({ allowed: true, reservation: record });
  }

  function consume(reservation) {
    const at = currentNow();
    pruneReservations(at);
    pruneAllAttempts(at);
    if (!reservation?.policies?.length) return;
    const held = reservations.get(reservation.id);
    if (!held || held.identity !== reservation.identity) throw new EgressRateLimitError('reservation_expired');
    for (const item of held.policies) {
      if (pruneAttempts(item, at).length >= item.maximum) {
        release(held.id);
        throw new EgressRateLimitError('rate_limited', { retryAfterMs: blockedRetryAfter(item, at) });
      }
    }
    release(held.id);
    for (const item of held.policies) {
      const key = bucketFor(item);
      const values = attempts.get(key) || [];
      values.push(at);
      attempts.set(key, values);
    }
  }

  function cancel(reservation) {
    if (reservation?.id) release(reservation.id);
  }

  function admit(details = {}) {
    const policies = policiesFor(details);
    const active = storage.getStore();
    if (active && active.identity === identityFor(policies)) return consume(active);
    const result = reserve(details);
    if (!result.allowed) throw new EgressRateLimitError('rate_limited', result);
    try { return consume(result.reservation); } finally { cancel(result.reservation); }
  }

  function runWithReservation(reservation, operation) {
    if (typeof operation !== 'function') throw new TypeError('Egress reservation callback is required.');
    return storage.run(reservation || null, operation);
  }

  function snapshotForTests() {
    const at = currentNow();
    pruneReservations(at);
    pruneAllAttempts(at);
    return Object.freeze({
      attempts: Object.freeze(Object.fromEntries([...attempts.entries()].map(([key, values]) => [key, values.length]))),
      reservations: reservations.size,
    });
  }

  return Object.freeze({ admit, cancel, reserve, runWithReservation, snapshotForTests });
}

module.exports = {
  EgressRateLimitError,
  LIMITS,
  PROTECTED_GUILD_LIMITS,
  createEgressLimiter,
  isEgressRateLimitError,
  policiesFor,
};
