'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  EgressRateLimitError,
  PROTECTED_GUILD_LIMITS,
  createEgressLimiter,
  policiesFor,
} = require('../src/platform/egressLimiter');

const IDS = Object.freeze({
  actor: '10000000000000001', channel: '10000000000000002', guild: '10000000000000003',
  recipient: '10000000000000004', target: '10000000000000005',
});

function interaction() {
  return { method: 'POST', fullRoute: '/interactions/one/two/callback', actorId: IDS.actor, channelId: IDS.channel,
    body: { type: 4, data: { content: 'ok' } } };
}

function consume(limiter, details) {
  const reservation = limiter.reserve(details);
  assert.equal(reservation.allowed, true);
  limiter.runWithReservation(reservation.reservation, () => limiter.admit(details));
  limiter.cancel(reservation.reservation);
}

test('egress limiter uses a reservation until the guard consumes it, then enforces the actor boundary', () => {
  let clock = 1_000;
  const limiter = createEgressLimiter({ now: () => clock });
  const request = interaction();
  const held = limiter.reserve(request);
  assert.equal(held.allowed, true);
  assert.deepEqual(limiter.snapshotForTests(), { attempts: {}, reservations: 1 });
  limiter.cancel(held.reservation);
  assert.deepEqual(limiter.snapshotForTests(), { attempts: {}, reservations: 0 });

  for (let index = 0; index < 10; index += 1) consume(limiter, request);
  const limited = limiter.reserve(request);
  assert.deepEqual(limited, { allowed: false, retryAfterMs: 10_000 });
  clock += 10_000;
  assert.equal(limiter.reserve(request).allowed, true);
});

test('egress limiter clears expired buckets from departed actor scopes', () => {
  let clock = 1_000;
  const limiter = createEgressLimiter({ now: () => clock });
  consume(limiter, interaction());
  clock += 10_000;
  consume(limiter, { ...interaction(), actorId: IDS.target });
  assert.deepEqual(limiter.snapshotForTests().attempts, { 'interaction-initial:10000000000000005': 1 });
});

test('egress limiter applies independent channel, DM recipient, and destructive-operation dimensions', () => {
  let clock = 10_000;
  const limiter = createEgressLimiter({ now: () => clock });
  const message = { method: 'POST', fullRoute: `/channels/${IDS.channel}/messages`, body: { content: 'ok' } };
  for (let index = 0; index < 20; index += 1) consume(limiter, message);
  assert.equal(limiter.reserve(message).allowed, false);

  const dm = { method: 'POST', fullRoute: '/users/@me/channels', body: { recipient_id: IDS.recipient } };
  for (let index = 0; index < 3; index += 1) consume(limiter, dm);
  assert.equal(limiter.reserve(dm).allowed, false);

  const kick = { method: 'DELETE', fullRoute: `/guilds/${IDS.guild}/members/${IDS.target}` };
  for (let index = 0; index < 5; index += 1) consume(limiter, kick);
  assert.equal(limiter.reserve(kick).allowed, false);
});

test('egress limiter shares one guild budget across private-extension member mutations', () => {
  const limiter = createEgressLimiter({ now: () => 10_000 });
  const mutations = [
    { method: 'PATCH', fullRoute: `/guilds/${IDS.guild}/members/${IDS.target}`, body: { communication_disabled_until: '2026-10-05T00:00:00.000Z' } },
    { method: 'PATCH', fullRoute: `/guilds/${IDS.guild}/members/${IDS.target}`, body: { roles: [] } },
    { method: 'PUT', fullRoute: `/guilds/${IDS.guild}/members/${IDS.target}/roles/${IDS.recipient}` },
    { method: 'DELETE', fullRoute: `/guilds/${IDS.guild}/members/${IDS.target}/roles/${IDS.recipient}` },
  ];
  for (const request of mutations) assert.equal(policiesFor(request)[0]?.id, 'member-removal');
  for (let index = 0; index < 5; index += 1) consume(limiter, mutations[index % mutations.length]);
  assert.equal(limiter.reserve(mutations[0]).allowed, false);
});

test('egress limiter limits unclassified private-extension management writes by guild', () => {
  const limiter = createEgressLimiter({ now: () => 10_000 });
  const request = {
    method: 'DELETE', fullRoute: `/guilds/${IDS.guild}/roles/${IDS.target}`,
    kind: 'private_write', privateExtension: true,
  };
  assert.equal(policiesFor(request)[0]?.id, 'private-mutation');
  for (let index = 0; index < 5; index += 1) consume(limiter, request);
  assert.equal(limiter.reserve(request).allowed, false);
});

test('bulk deletion cannot exceed Discord\'s 100-message request bound', () => {
  assert.throws(() => policiesFor({ method: 'POST', fullRoute: `/channels/${IDS.channel}/messages/bulk-delete`,
    body: { messages: Array.from({ length: 101 }, (_, index) => String(index)) } }),
  (error) => error instanceof EgressRateLimitError && error.code === 'EGRESS_BULK_DELETE_SIZE');
});

test('a verified extension in a protected guild draws on the protected-guild budgets, and nothing else does', () => {
  const route = (method, fullRoute, extra = {}) => ({ method, fullRoute, ...extra });
  const cases = [
    [route('PUT', `/guilds/${IDS.guild}/bans/${IDS.target}`), ['protected-member-sanction'], 'member-removal'],
    [route('DELETE', `/guilds/${IDS.guild}/bans/${IDS.target}`), ['protected-member-sanction'], 'member-removal'],
    [route('DELETE', `/guilds/${IDS.guild}/members/${IDS.target}`), ['protected-member-sanction'], 'member-removal'],
    [route('PATCH', `/guilds/${IDS.guild}/members/${IDS.target}`, { body: { communication_disabled_until: null } }),
      ['protected-member-sanction'], 'member-removal'],
    [route('PUT', `/guilds/${IDS.guild}/members/${IDS.target}/roles/${IDS.recipient}`),
      ['protected-member-role', 'protected-member-role-burst'], 'member-removal'],
    [route('DELETE', `/guilds/${IDS.guild}/members/${IDS.target}/roles/${IDS.recipient}`),
      ['protected-member-role', 'protected-member-role-burst'], 'member-removal'],
    [route('DELETE', `/channels/${IDS.channel}/messages/${IDS.target}`, { targetGuildId: IDS.guild }),
      ['protected-message-delete'], 'bulk-delete'],
    [route('POST', `/channels/${IDS.channel}/messages/bulk-delete`, { targetGuildId: IDS.guild, body: { messages: ['1', '2'] } }),
      ['protected-bulk-delete'], 'bulk-delete'],
    [route('DELETE', `/channels/${IDS.channel}`, { targetGuildId: IDS.guild }), ['protected-channel-delete'], 'channel-delete'],
    [route('POST', `/guilds/${IDS.guild}/channels`, { kind: 'private_write', privateExtension: true }),
      ['protected-channel-create'], 'private-mutation'],
    [route('POST', `/guilds/${IDS.guild}/roles`, { kind: 'private_write', privateExtension: true }),
      ['protected-private-mutation'], 'private-mutation'],
  ];
  for (const [details, protectedIds, defaultId] of cases) {
    const label = `${details.method} ${details.fullRoute}`;
    assert.deepEqual(policiesFor({ ...details, protectedGuildExtension: true }).map((item) => item.id), protectedIds, label);
    assert.deepEqual(policiesFor(details).map((item) => item.id), [defaultId], label);
    assert.deepEqual(policiesFor({ ...details, protectedGuildExtension: 'yes' }).map((item) => item.id), [defaultId], label);
  }
  // Scopes: the guild, except bulk deletion, which counts per channel.
  const scope = (details) => policiesFor({ ...details, protectedGuildExtension: true }).map((item) => item.scope);
  assert.deepEqual(scope(cases[6][0]), [IDS.guild]);
  assert.deepEqual(scope(cases[7][0]), [IDS.channel]);
  assert.deepEqual(scope(cases[4][0]), [IDS.guild, IDS.guild]);
  // A protected flag without a guild names no protected budget.
  assert.deepEqual(policiesFor({ method: 'DELETE', fullRoute: `/channels/${IDS.channel}`, protectedGuildExtension: true })
    .map((item) => item.id), ['channel-delete']);
  // Public output keeps its own budgets.
  assert.deepEqual(policiesFor({ method: 'POST', fullRoute: `/channels/${IDS.channel}/messages`, targetGuildId: IDS.guild,
    protectedGuildExtension: true, body: { content: 'ok' } }).map((item) => item.id), ['message-create']);
  assert.throws(() => policiesFor({ method: 'POST', fullRoute: `/channels/${IDS.channel}/messages/bulk-delete`,
    targetGuildId: IDS.guild, protectedGuildExtension: true, body: { messages: ['1'] } }),
  (error) => error instanceof EgressRateLimitError && error.code === 'EGRESS_BULK_DELETE_SIZE');
});

test('the protected-guild budgets keep their numbers and their counts survive the sweep of expired buckets', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(PROTECTED_GUILD_LIMITS).map(([name, limit]) => [name, [limit.maximum, limit.windowMs]])), {
    memberSanction: [30, 60 * 60 * 1_000],
    memberRole: [300, 60 * 60 * 1_000],
    memberRoleBurst: [30, 60 * 1_000],
    messageDelete: [200, 60 * 60 * 1_000],
    bulkDelete: [10, 10 * 60 * 1_000],
    channelDelete: [20, 24 * 60 * 60 * 1_000],
    channelCreate: [20, 24 * 60 * 60 * 1_000],
    privateMutation: [60, 60 * 60 * 1_000],
  });
  assert.ok(Object.isFrozen(PROTECTED_GUILD_LIMITS));
  let clock = 10_000;
  const limiter = createEgressLimiter({ now: () => clock });
  const channelDelete = { method: 'DELETE', fullRoute: `/channels/${IDS.channel}`, targetGuildId: IDS.guild, protectedGuildExtension: true };
  for (let index = 0; index < 20; index += 1) {
    consume(limiter, channelDelete);
    // Every entry sweeps expired buckets; a bucket the sweep did not know would be dropped here.
    consume(limiter, { ...interaction(), actorId: IDS.target });
    clock += 1_000;
  }
  assert.equal(limiter.snapshotForTests().attempts[`protected-channel-delete:${IDS.guild}`], 20);
  assert.equal(limiter.reserve(channelDelete).allowed, false);
});
