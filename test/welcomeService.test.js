const test = require('node:test');
const assert = require('node:assert/strict');
const { ChannelType, PermissionFlagsBits } = require('discord.js');
const {
  WELCOME_CHANNEL_LOOKUP_COOLDOWN_MS,
  WELCOME_CHANNEL_LOOKUP_DEADLINE_MS,
  WELCOME_CHANNEL_RETRY_COOLDOWN_MS,
  canSendWelcome,
  createWelcomeChannelLookup,
  formatWelcomeMessage,
  handleGuildMemberWelcome,
} = require('../src/services/welcomeService');
const logger = require('../src/utils/logger');

const BOT_ID = '10000000000000001';
const GUILD_ID = '10000000000000002';
const MEMBER_ID = '10000000000000003';
const CHANNEL_ID = '10000000000000004';

function createPermissions(allowedPermissions) {
  const allowed = new Set(allowedPermissions);
  return { has: (permission) => allowed.has(permission) };
}

function createTextChannel(id, { allowed = true, position = 0 } = {}) {
  return {
    id,
    type: ChannelType.GuildText,
    rawPosition: position,
    isTextBased: () => true,
    permissionsFor: () => createPermissions(allowed
      ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]
      : [PermissionFlagsBits.ViewChannel]),
  };
}

function createMember({ channel = createTextChannel(CHANNEL_ID), systemChannel = null,
  fallbackChannels = [], bot = false, joinedTimestamp = 2_000 } = {}) {
  const botMember = { id: BOT_ID };
  return {
    id: MEMBER_ID,
    joinedTimestamp,
    user: { bot },
    client: { user: { id: BOT_ID } },
    toString: () => `<@${MEMBER_ID}>`,
    guild: {
      id: GUILD_ID,
      members: { me: botMember, fetchMe: async () => botMember },
      channels: {
        cache: new Map([[channel.id, channel], ...fallbackChannels.map((item) => [item.id, item])]),
        fetch: async (channelId) => channelId
          ? (channelId === channel.id ? channel : null)
          : new Map([[channel.id, channel], ...fallbackChannels.map((item) => [item.id, item])]),
      },
      systemChannel,
    },
  };
}

function protectedOptions(member, accepted = true) {
  const calls = [];
  return {
    calls,
    options: {
      runtime: { accept: (grant, effect) => { calls.push({ grant, effect }); return accepted; } },
      getContext: () => ({
        guildId: member.guild.id,
        memberId: member.id,
        joinedTimestamp: member.joinedTimestamp,
        publicEffectEventGrant: Object.freeze({ trusted: true }),
      }),
      issueGrant: () => Object.freeze({ authorized: true }),
    },
  };
}

test('formatWelcomeMessage mentions only the new member', () => {
  assert.equal(formatWelcomeMessage({ toString: () => `<@${MEMBER_ID}>` }),
    `歡迎 <@${MEMBER_ID}> 加入伺服器！小吉在這裡向你打招呼～`);
});

test('canSendWelcome requires text channel and send permissions, not a raw channel.send path', () => {
  const channel = createTextChannel(CHANNEL_ID);
  const botMember = { id: BOT_ID };
  assert.equal(canSendWelcome(channel, botMember), true);
  assert.equal(canSendWelcome(createTextChannel(CHANNEL_ID, { allowed: false }), botMember), false);
});

test('configured welcome becomes one exact protected REST effect', async () => {
  const member = createMember();
  const { options, calls } = protectedOptions(member);
  assert.equal(await handleGuildMemberWelcome(member, { ...options,
    config: { welcomeChannelId: CHANNEL_ID } }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].effect.route, `/channels/${CHANNEL_ID}/messages`);
  assert.deepEqual(calls[0].effect.body.allowed_mentions,
    { parse: [], users: [MEMBER_ID], roles: [], replied_user: false });
});

test('unavailable candidates fall back before claim in deterministic order', async () => {
  const configured = createTextChannel(CHANNEL_ID, { allowed: false, position: 30 });
  const deniedSystem = createTextChannel('10000000000000005', { allowed: false });
  const later = createTextChannel('10000000000000006', { position: 20 });
  const first = createTextChannel('10000000000000007', { position: 1 });
  const member = createMember({ channel: configured, systemChannel: deniedSystem,
    fallbackChannels: [later, first] });
  const { options, calls } = protectedOptions(member);
  assert.equal(await handleGuildMemberWelcome(member, { ...options,
    config: { welcomeChannelId: CHANNEL_ID } }), true);
  assert.equal(calls[0].effect.target, first.id);
});

test('missing ledger/runtime cannot fall back to channel.send', async () => {
  let rawSends = 0;
  const channel = { ...createTextChannel(CHANNEL_ID), send: async () => { rawSends += 1; } };
  const member = createMember({ channel });
  const { options } = protectedOptions(member, false);
  assert.equal(await handleGuildMemberWelcome(member, { ...options,
    config: { welcomeChannelId: CHANNEL_ID } }), false);
  assert.equal(rawSends, 0);
});

test('no sendable candidate never asks the runtime to claim', async () => {
  const member = createMember({ channel: createTextChannel(CHANNEL_ID, { allowed: false }) });
  const { options, calls } = protectedOptions(member);
  assert.equal(await handleGuildMemberWelcome(member, { ...options,
    config: { welcomeChannelId: CHANNEL_ID } }), false);
  assert.equal(calls.length, 0);
});

test('missing trusted join context is rejected', async () => {
  const member = createMember();
  const { options, calls } = protectedOptions(member);
  options.getContext = () => null;
  assert.equal(await handleGuildMemberWelcome(member, { ...options,
    config: { welcomeChannelId: CHANNEL_ID } }), false);
  assert.equal(calls.length, 0);
});

test('bot members are ignored', async () => {
  const member = createMember({ bot: true });
  const { options, calls } = protectedOptions(member);
  assert.equal(await handleGuildMemberWelcome(member, { ...options,
    config: { welcomeChannelId: CHANNEL_ID } }), false);
  assert.equal(calls.length, 0);
});

const STORM_SIZE = 200;
const DELETED_CHANNEL_ID = '10000000000000008';
const FALLBACK_CHANNEL_ID = '10000000000000009';

// A guild whose channel manager answers like discord.js: an ID found in the cache is returned
// from it, and anything else is one request to Discord, counted here. What it fetches is added
// to the cache, as discord.js does; by default Discord lists the channels the cache started with.
function createStormGuild({ cached = [], listChannels = async () => cached, fetchChannel = null } = {}) {
  const requests = { list: 0, channel: [] };
  const cache = new Map(cached.map((channel) => [channel.id, channel]));
  const botMember = { id: BOT_ID };
  const guild = {
    id: GUILD_ID,
    members: { me: botMember, fetchMe: async () => botMember },
    systemChannel: null,
    channels: {
      cache,
      fetch: async (channelId) => {
        if (channelId) {
          if (cache.has(channelId)) return cache.get(channelId);
          requests.channel.push(channelId);
          if (!fetchChannel) throw Object.assign(new Error('Unknown Channel'), { status: 404 });
          const channel = await fetchChannel(channelId);
          cache.set(channel.id, channel);
          return channel;
        }
        requests.list += 1;
        const channels = await listChannels();
        for (const channel of channels) cache.set(channel.id, channel);
        return new Map(channels.map((channel) => [channel.id, channel]));
      },
    },
  };
  return { guild, requests };
}

// With reporter, skipped welcomes go to the test-control observation point (as in test-control
// mode); without it, to the log, which is collected here.
function createStorm(guild, t, { reporter = true } = {}) {
  // One queued line per accepted welcome; the counts below are what matters.
  t.mock.method(logger, 'info', () => {});
  const accepted = [];
  const denials = [];
  const warnings = [];
  if (!reporter) t.mock.method(logger, 'warn', (line) => { warnings.push(String(line)); });
  const client = {
    user: { id: BOT_ID },
    ...(reporter ? {
      testControlPolicy: { reporter: { deny: (code, operation) => denials.push(`${code}:${operation}`) } },
    } : {}),
  };
  const member = (index) => {
    const id = `2${String(index).padStart(16, '0')}`;
    return { id, joinedTimestamp: 2_000 + index, user: { bot: false }, client, toString: () => `<@${id}>`, guild };
  };
  const welcome = (index, options = {}) => {
    const joined = member(index);
    return handleGuildMemberWelcome(joined, {
      runtime: { accept: (grant, effect) => { accepted.push(effect); return true; } },
      getContext: () => ({
        guildId: joined.guild.id,
        memberId: joined.id,
        joinedTimestamp: joined.joinedTimestamp,
        publicEffectEventGrant: Object.freeze({ trusted: true }),
      }),
      issueGrant: () => Object.freeze({ authorized: true }),
      ...options,
    });
  };
  return { accepted, denials, warnings, welcome };
}

function configuredChannelWarnings(storm, channelId) {
  return storm.warnings.filter((line) => line.startsWith(`Welcome channel ${channelId} `));
}

const neverAnswered = () => new Promise(() => {});

function manualClock() {
  let value = 0;
  return { now: () => value, advance: (ms) => { value += ms; } };
}

test('a join storm whose channels are cached asks Discord for no channel', async (t) => {
  const configured = createTextChannel(CHANNEL_ID, { position: 5 });
  const fallback = createTextChannel(FALLBACK_CHANNEL_ID, { position: 1 });
  const { guild, requests } = createStormGuild({ cached: [configured, fallback] });
  const storm = createStorm(guild, t);
  const configuredResults = await Promise.all(Array.from({ length: STORM_SIZE }, (_, index) =>
    storm.welcome(index, { config: { welcomeChannelId: CHANNEL_ID } })));
  const fallbackResults = await Promise.all(Array.from({ length: STORM_SIZE }, (_, index) =>
    storm.welcome(STORM_SIZE + index, { config: {} })));
  assert.deepEqual(requests, { list: 0, channel: [] });
  assert.ok([...configuredResults, ...fallbackResults].every(Boolean));
  assert.equal(storm.accepted.length, 2 * STORM_SIZE);
  assert.ok(storm.accepted.slice(0, STORM_SIZE).every((effect) => effect.target === CHANNEL_ID));
  assert.ok(storm.accepted.slice(STORM_SIZE).every((effect) => effect.target === FALLBACK_CHANNEL_ID));
  assert.deepEqual(storm.denials, []);
});

test('a join storm on an empty channel cache shares one channel-list request', async (t) => {
  let answer;
  const listed = new Promise((resolve) => { answer = resolve; });
  const fallback = createTextChannel(FALLBACK_CHANNEL_ID);
  const { guild, requests } = createStormGuild({ listChannels: () => listed });
  const storm = createStorm(guild, t);
  // The lookup the handler keeps for this client, not one handed in.
  const pending = Array.from({ length: STORM_SIZE }, (_, index) => storm.welcome(index, { config: {} }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests.list, 1);
  answer([fallback]);
  assert.ok((await Promise.all(pending)).every(Boolean));
  assert.ok((await Promise.all(Array.from({ length: 50 }, (_, index) =>
    storm.welcome(STORM_SIZE + index, { config: {} })))).every(Boolean));
  assert.equal(requests.list, 1);
  assert.equal(storm.accepted.length, STORM_SIZE + 50);
  assert.ok(storm.accepted.every((effect) => effect.target === FALLBACK_CHANNEL_ID));
});

test('a failed channel-list request is not repeated before its cooldown ends', async (t) => {
  const clock = manualClock();
  const channelLookup = createWelcomeChannelLookup({ now: clock.now });
  const { guild, requests } = createStormGuild({
    listChannels: async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); },
  });
  const storm = createStorm(guild, t);
  // 200 joins in 10 seconds.
  for (let index = 0; index < STORM_SIZE; index += 1) {
    assert.equal(await storm.welcome(index, { config: {}, channelLookup }), false);
    clock.advance(50);
  }
  assert.equal(requests.list, 1);
  clock.advance(WELCOME_CHANNEL_LOOKUP_COOLDOWN_MS - (STORM_SIZE * 50) - 1);
  assert.equal(await storm.welcome(STORM_SIZE, { config: {}, channelLookup }), false);
  assert.equal(requests.list, 1);
  clock.advance(1);
  assert.equal(await storm.welcome(STORM_SIZE + 1, { config: {}, channelLookup }), false);
  assert.equal(requests.list, 2);
  // Each skipped welcome is still reported once, as before.
  assert.equal(storm.denials.length, STORM_SIZE + 2);
  assert.ok(storm.denials.every((denial) => denial === 'TEST_WELCOME_UNAVAILABLE:welcome'));
  assert.equal(storm.accepted.length, 0);
});

test('a configured channel missing from the cache is asked for once per cooldown and falls back', async (t) => {
  const clock = manualClock();
  const channelLookup = createWelcomeChannelLookup({ now: clock.now });
  const fallback = createTextChannel(FALLBACK_CHANNEL_ID);
  const { guild, requests } = createStormGuild({ cached: [fallback] });
  const storm = createStorm(guild, t);
  const config = { welcomeChannelId: DELETED_CHANNEL_ID };
  // 20 joins at a time, every second, for 10 seconds.
  for (let second = 0; second < 10; second += 1) {
    const results = await Promise.all(Array.from({ length: STORM_SIZE / 10 }, (_, index) =>
      storm.welcome((second * 20) + index, { config, channelLookup })));
    assert.ok(results.every(Boolean));
    clock.advance(1_000);
  }
  assert.deepEqual(requests.channel, [DELETED_CHANNEL_ID]);
  assert.equal(storm.accepted.length, STORM_SIZE);
  assert.ok(storm.accepted.every((effect) => effect.target === FALLBACK_CHANNEL_ID));
  // Every join still reports the missing configured channel before it falls back.
  assert.equal(storm.denials.length, STORM_SIZE);
  clock.advance(WELCOME_CHANNEL_LOOKUP_COOLDOWN_MS);
  assert.equal(await storm.welcome(STORM_SIZE, { config, channelLookup }), true);
  assert.deepEqual(requests.channel, [DELETED_CHANNEL_ID, DELETED_CHANNEL_ID]);
});

test('a configured channel the cache lacks but Discord has is fetched once, then read from the cache', async (t) => {
  const configured = createTextChannel(CHANNEL_ID);
  const { guild, requests } = createStormGuild({
    cached: [createTextChannel(FALLBACK_CHANNEL_ID)],
    fetchChannel: async () => configured,
  });
  const storm = createStorm(guild, t);
  const results = await Promise.all(Array.from({ length: STORM_SIZE }, (_, index) =>
    storm.welcome(index, { config: { welcomeChannelId: CHANNEL_ID } })));
  assert.ok(results.every(Boolean));
  assert.deepEqual(requests, { list: 0, channel: [CHANNEL_ID] });
  assert.ok(storm.accepted.every((effect) => effect.target === CHANNEL_ID));
  assert.deepEqual(storm.denials, []);
});

test('a configured channel lookup that fails for a passing reason retries after a short cooldown, not as deleted', async (t) => {
  const clock = manualClock();
  const channelLookup = createWelcomeChannelLookup({ now: clock.now });
  const { guild, requests } = createStormGuild({
    cached: [createTextChannel(FALLBACK_CHANNEL_ID)],
    fetchChannel: async () => { throw Object.assign(new Error('Service Unavailable'), { status: 503 }); },
  });
  const storm = createStorm(guild, t, { reporter: false });
  const config = { welcomeChannelId: CHANNEL_ID };
  // 20 joins at a time, every second, for 10 seconds.
  for (let second = 0; second < 10; second += 1) {
    const results = await Promise.all(Array.from({ length: STORM_SIZE / 10 }, (_, index) =>
      storm.welcome((second * 20) + index, { config, channelLookup })));
    assert.ok(results.every(Boolean));
    clock.advance(1_000);
  }
  // One request as the storm starts and one when the short cooldown ends, not one per join.
  assert.equal(WELCOME_CHANNEL_RETRY_COOLDOWN_MS, 5_000);
  assert.deepEqual(requests.channel, [CHANNEL_ID, CHANNEL_ID]);
  assert.ok(storm.accepted.every((effect) => effect.target === FALLBACK_CHANNEL_ID));
  const lines = configuredChannelWarnings(storm, CHANNEL_ID);
  assert.equal(lines.length, STORM_SIZE);
  assert.ok(lines.every((line) => line.includes('could not be looked up') && !line.includes('no longer exists')));
});

test('a configured channel Discord calls unknown is logged as gone and waits out the full cooldown', async (t) => {
  const clock = manualClock();
  const channelLookup = createWelcomeChannelLookup({ now: clock.now });
  const { guild, requests } = createStormGuild({
    cached: [createTextChannel(FALLBACK_CHANNEL_ID)],
    // Discord's Unknown Channel code, as discord.js reports it.
    fetchChannel: async () => { throw Object.assign(new Error('Unknown Channel'), { code: 10003 }); },
  });
  const storm = createStorm(guild, t, { reporter: false });
  const config = { welcomeChannelId: DELETED_CHANNEL_ID };
  assert.ok((await Promise.all(Array.from({ length: 20 }, (_, index) =>
    storm.welcome(index, { config, channelLookup })))).every(Boolean));
  clock.advance(WELCOME_CHANNEL_RETRY_COOLDOWN_MS);
  assert.equal(await storm.welcome(20, { config, channelLookup }), true);
  assert.deepEqual(requests.channel, [DELETED_CHANNEL_ID]);
  clock.advance(WELCOME_CHANNEL_LOOKUP_COOLDOWN_MS - WELCOME_CHANNEL_RETRY_COOLDOWN_MS);
  assert.equal(await storm.welcome(21, { config, channelLookup }), true);
  assert.deepEqual(requests.channel, [DELETED_CHANNEL_ID, DELETED_CHANNEL_ID]);
  const lines = configuredChannelWarnings(storm, DELETED_CHANNEL_ID);
  assert.equal(lines.length, 22);
  assert.ok(lines.every((line) => line.includes('no longer exists')));
});

test('a configured channel lookup with no answer ends at its deadline, so no join waits on it', async (t) => {
  const clock = manualClock();
  const channelLookup = createWelcomeChannelLookup({ now: clock.now, deadlineMs: 20 });
  const { guild, requests } = createStormGuild({
    cached: [createTextChannel(FALLBACK_CHANNEL_ID)],
    fetchChannel: neverAnswered,
  });
  const storm = createStorm(guild, t, { reporter: false });
  const config = { welcomeChannelId: CHANNEL_ID };
  assert.ok((await Promise.all(Array.from({ length: 20 }, (_, index) =>
    storm.welcome(index, { config, channelLookup })))).every(Boolean));
  assert.deepEqual(requests.channel, [CHANNEL_ID]);
  assert.ok(storm.accepted.every((effect) => effect.target === FALLBACK_CHANNEL_ID));
  // A missed deadline is a passing failure: its record is gone after the short cooldown, and
  // the next join asks again instead of waiting on the request that never ended.
  clock.advance(WELCOME_CHANNEL_RETRY_COOLDOWN_MS - 1);
  assert.equal(await storm.welcome(20, { config, channelLookup }), true);
  assert.equal(requests.channel.length, 1);
  clock.advance(1);
  assert.equal(await storm.welcome(21, { config, channelLookup }), true);
  assert.equal(requests.channel.length, 2);
  const lines = configuredChannelWarnings(storm, CHANNEL_ID);
  assert.equal(lines.length, 22);
  assert.ok(lines.every((line) => line.includes('could not be looked up')));
});

test('a channel-list request with no answer ends at its deadline and keeps the list cooldown', async (t) => {
  const clock = manualClock();
  const channelLookup = createWelcomeChannelLookup({ now: clock.now, deadlineMs: 20 });
  const { guild, requests } = createStormGuild({ listChannels: neverAnswered });
  const storm = createStorm(guild, t);
  const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    storm.welcome(index, { config: {}, channelLookup })));
  assert.ok(results.every((result) => result === false));
  assert.equal(requests.list, 1);
  clock.advance(WELCOME_CHANNEL_LOOKUP_COOLDOWN_MS - 1);
  assert.equal(await storm.welcome(20, { config: {}, channelLookup }), false);
  assert.equal(requests.list, 1);
  clock.advance(1);
  assert.equal(await storm.welcome(21, { config: {}, channelLookup }), false);
  assert.equal(requests.list, 2);
  assert.equal(storm.denials.length, 22);
});

test('channel lookups share one request per key in flight and keep separate cooldowns per key', async () => {
  assert.equal(WELCOME_CHANNEL_LOOKUP_DEADLINE_MS, 15_000);
  const clock = manualClock();
  const lookup = createWelcomeChannelLookup({ now: clock.now });
  const cooldown = () => 1_000;
  const started = [];
  const request = (key) => () => { started.push(key); return key; };
  const first = await Promise.all([lookup.run('a', request('a'), cooldown), lookup.run('a', request('a'), cooldown),
    lookup.run('b', request('b'), cooldown)]);
  assert.deepEqual(first.map((outcome) => outcome.value), ['a', 'a', 'b']);
  assert.deepEqual(started, ['a', 'b']);
  assert.deepEqual(await lookup.run('a', request('a'), cooldown), { throttled: true, error: null });
  clock.advance(1_000);
  assert.deepEqual(await lookup.run('a', request('a'), cooldown), { value: 'a' });
  assert.deepEqual(started, ['a', 'b', 'a']);
  // A request that throws at once is a failed request: run() itself never rejects, and the
  // cooldown after it is the one chosen for that failure.
  clock.advance(1_000);
  const refused = new Error('refused');
  const cooldownFor = (error) => (error === refused ? 3_000 : 1_000);
  const failed = await lookup.run('c', () => { throw refused; }, cooldownFor);
  assert.equal(failed.error, refused);
  clock.advance(2_999);
  const throttled = await lookup.run('c', request('c'), cooldownFor);
  assert.equal(throttled.throttled, true);
  assert.equal(throttled.error, refused);
  clock.advance(1);
  assert.deepEqual(await lookup.run('c', request('c'), cooldownFor), { value: 'c' });
});

// The client keeps GuildMember partials, so `guild.members.me` is a partial member of the bot (no roles)
// when the bot is not cached, not null: its permissions are those of @everyone. The welcome asks for the
// whole member (src/utils/botMember.js) before it decides which channel the bot can write in.
test('a partial bot member from the cache is replaced by the fetched one before the channel is chosen', async () => {
  const asked = [];
  const channel = {
    ...createTextChannel(CHANNEL_ID),
    permissionsFor(botMember) {
      asked.push(botMember.tag);
      return createPermissions(botMember.tag === 'fetched'
        ? [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] : []);
    },
  };
  const member = createMember({ channel });
  let fetched = 0;
  member.guild.members = {
    me: { id: BOT_ID, partial: true, tag: 'partial' },
    fetchMe: async () => { fetched += 1; return { id: BOT_ID, partial: false, tag: 'fetched' }; },
  };
  const { options, calls } = protectedOptions(member);
  assert.equal(await handleGuildMemberWelcome(member, { ...options, config: { welcomeChannelId: CHANNEL_ID } }), true);
  assert.equal(fetched, 1);
  assert.deepEqual(asked, ['fetched']);
  assert.equal(calls.length, 1);

  // A whole member in the cache is used without a fetch; a bot member that cannot be had gives no welcome.
  const cachedMember = createMember({ channel });
  cachedMember.guild.members = {
    me: { id: BOT_ID, tag: 'fetched' },
    fetchMe: async () => assert.fail('a whole cached member is not fetched'),
  };
  const cached = protectedOptions(cachedMember);
  assert.equal(await handleGuildMemberWelcome(cachedMember, { ...cached.options,
    config: { welcomeChannelId: CHANNEL_ID } }), true);

  const missing = createMember({ channel });
  missing.guild.members = {
    me: { id: BOT_ID, partial: true, tag: 'partial' },
    fetchMe: async () => { throw new Error('synthetic failure'); },
  };
  const none = protectedOptions(missing);
  const originalWarn = logger.warn;
  logger.warn = () => {};
  try {
    assert.equal(await handleGuildMemberWelcome(missing, { ...none.options,
      config: { welcomeChannelId: CHANNEL_ID } }), false);
  } finally {
    logger.warn = originalWarn;
  }
  assert.equal(none.calls.length, 0);
});
