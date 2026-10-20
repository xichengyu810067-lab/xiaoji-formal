'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { MockAgent, getGlobalDispatcher, setGlobalDispatcher } = require('undici');
const { ChannelType, Client, ClientUser, GatewayIntentBits, PermissionFlagsBits } = require('discord.js');

const { createSyntheticRest } = require('./fixtures/syntheticRest');
const { initializePublicLedgers, openPublicLedgers } = require('./fixtures/publicLedgers');
const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');
const { createEgressLimiter } = require('../src/platform/egressLimiter');
const { installEgressGuard } = require('../src/platform/egressGuard');
const logger = require('../src/utils/logger');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const { configurePublicEffectAdapter } = require('../src/platform/publicEffectAdapter');
const { PublicSideEffectRuntime } = require('../src/systems/safety/publicSideEffectRuntime');
const { WelcomeSideEffectRuntime } = require('../src/systems/safety/welcomeSideEffectRuntime');
const { initializePublicPurposeLedger, openPublicPurposeLedger } = require('../src/systems/safety/sideEffectLedger');
const { claimExtensionContextRunner } = require('../src/platform/extensionContext');
const { captureDiscordEventContext, runWithHostOperationContext } = require('../src/platform/hostOperationContext');
const { createWelcomeChannelLookup, handleGuildMemberWelcome } = require('../src/services/welcomeService');
const { createWelcomedMembers, setWelcomedMembersForTests } = require('../src/systems/community/welcomedMembers');

const BOT_ID = '10000000000000001';
const OWNER_ID = '10000000000000002';
const GUILD_ID = '10000000000000003';
const CHANNEL_ID = '10000000000000004';
const DELETED_CHANNEL_ID = '10000000000000005';
const CUTOVER_MS = 1_700_000_000_000;
const NOW_MS = CUTOVER_MS + (3 * 24 * 60 * 60 * 1_000);
const root = makeRealTempDir('xiaoji-raid-simulation-');
const auditPath = path.join(root, 'guildAudit.json');
const whitelistPath = path.join(root, 'inviterWhitelist.json');
const originalEnvironment = Object.freeze({
  audit: process.env.XIAOJI_AUDIT_DATA_PATH,
  whitelist: process.env.XIAOJI_INVITER_WHITELIST_PATH,
  owner: process.env.BOT_OWNER_ID,
});

process.env.XIAOJI_AUDIT_DATA_PATH = auditPath;
process.env.XIAOJI_INVITER_WHITELIST_PATH = whitelistPath;
process.env.BOT_OWNER_ID = OWNER_ID;
fs.writeFileSync(auditPath, '{}\n', 'utf8');
fs.writeFileSync(whitelistPath, '[]\n', 'utf8');

const extensionContextRunner = claimExtensionContextRunner();

function restoreEnvironment() {
  const entries = [
    ['XIAOJI_AUDIT_DATA_PATH', originalEnvironment.audit],
    ['XIAOJI_INVITER_WHITELIST_PATH', originalEnvironment.whitelist],
    ['BOT_OWNER_ID', originalEnvironment.owner],
  ];
  for (const [key, value] of entries) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

function snowflake(index, prefix = '9') {
  return `${prefix}${String(index).padStart(16, '0')}`;
}

function welcomeEffect(memberId) {
  return Object.freeze({
    purposeId: 'welcome',
    action: 'welcome-message.create',
    target: CHANNEL_ID,
    method: 'POST',
    route: `/channels/${CHANNEL_ID}/messages`,
    body: {
      content: `歡迎 <@${memberId}> 加入伺服器！小吉在這裡向你打招呼～`,
      allowed_mentions: { parse: [], users: [memberId], roles: [], replied_user: false },
    },
  });
}

function createGuardedRest() {
  const calls = [];
  const record = (method) => (route, { body }) => {
    calls.push(Object.freeze({ method, route, body }));
    return method === 'DELETE' ? undefined : { id: snowflake(calls.length, '8') };
  };
  const rest = createSyntheticRest({ post: record('POST'), put: record('PUT'), patch: record('PATCH'), delete: record('DELETE') });
  const limiter = createEgressLimiter({ now: () => NOW_MS });
  const guard = installEgressGuard(rest, {
    approvedReleaseTag: 'v1.1.2',
    privateGuildIds: [GUILD_ID],
    resolveChannelGuild: () => GUILD_ID,
  });
  guard.setAdmission((details) => limiter.admit(details));
  return Object.freeze({ calls, limiter, rest });
}

function createSlowWelcomeTransport() {
  let clock = NOW_MS;
  const calls = [];
  const rest = createSyntheticRest({
    post(route, { body }) {
      calls.push(Object.freeze({ method: 'POST', route, body }));
      clock += 31_000;
      return { id: snowflake(calls.length, '1') };
    },
  });
  const limiter = createEgressLimiter({ now: () => clock });
  const guard = installEgressGuard(rest, {
    approvedReleaseTag: 'v1.1.2',
    privateGuildIds: [GUILD_ID],
    resolveChannelGuild: () => GUILD_ID,
  });
  guard.setAdmission((details) => limiter.admit(details));
  return Object.freeze({ calls, limiter, rest });
}

function createRuntime(name, rest, limiter) {
  const authority = createPublicEffectAuthority();
  const ledgers = initializePublicLedgers({ root, name, botId: BOT_ID, cutover: CUTOVER_MS });
  const runtime = new PublicSideEffectRuntime({
    client: { rest },
    botId: BOT_ID,
    now: () => NOW_MS,
    effectAuthority: authority,
    egressLimiter: limiter,
  });
  const preflight = runtime.preflight({ ledgers: openPublicLedgers(ledgers, { botId: BOT_ID, now: () => NOW_MS }) });
  assert.deepEqual(preflight.disabled, []);
  runtime.arm();
  return Object.freeze({ authority, runtime });
}

function createWelcomeRuntime(name, rest, limiter) {
  const authority = createPublicEffectAuthority();
  const ledgerRoot = path.join(root, `${name}-ledger`);
  const witnessRoot = path.join(root, `${name}-witness`);
  fs.mkdirSync(ledgerRoot);
  fs.mkdirSync(witnessRoot);
  const initialized = initializePublicPurposeLedger({
    filePath: path.join(ledgerRoot, 'ledger.json'),
    continuityWitnessPath: path.join(witnessRoot, 'witness.json'),
    ledgerId: `welcome-${name}`,
    initializationId: `synthetic-${name}`,
    purposeIdentity: {
      purposeId: 'welcome',
      botId: BOT_ID,
      sourceNamespace: 'discord.guildMemberAdd',
      cutoverJoinedTimestampMs: CUTOVER_MS,
      freshSourceProofDigest: crypto.createHash('sha256').update(name).digest('hex'),
    },
    now: () => CUTOVER_MS,
  });
  const ledger = openPublicPurposeLedger({
    filePath: initialized.ledgerPath,
    expectedReceiptSha256: initialized.receiptSha256,
    expectedPurposeIdentity: { purposeId: 'welcome', botId: BOT_ID, sourceNamespace: 'discord.guildMemberAdd' },
    now: () => NOW_MS,
  });
  const runtime = new WelcomeSideEffectRuntime({
    client: { rest, egressLimiter: limiter },
    botId: BOT_ID,
    now: () => NOW_MS,
    effectAuthority: authority,
  });
  assert.deepEqual(runtime.preflight({ ledgers: new Map([['welcome', ledger]]) }),
    { enabled: true, code: 'WELCOME_LEDGER_READY' });
  runtime.arm();
  return Object.freeze({ authority, runtime });
}

const STORM_CHANNEL = Object.freeze({
  id: CHANNEL_ID, guild_id: GUILD_ID, type: ChannelType.GuildText, name: 'welcome', position: 0,
  permission_overwrites: [],
});

// The guarded REST of a welcome join storm: every read (a channel lookup) is counted and
// answered by channelRead; the welcome messages are recorded as in createGuardedRest.
function createJoinStormTransport(channelRead) {
  const reads = [];
  const calls = [];
  const rest = createSyntheticRest({
    get(route) {
      reads.push(route);
      return channelRead(route);
    },
    post(route, { body }) {
      calls.push(Object.freeze({ method: 'POST', route, body }));
      return { id: snowflake(calls.length, '8') };
    },
  });
  const limiter = createEgressLimiter({ now: () => NOW_MS });
  const guard = installEgressGuard(rest, {
    approvedReleaseTag: 'v1.1.2',
    privateGuildIds: [GUILD_ID],
    resolveChannelGuild: () => GUILD_ID,
  });
  guard.setAdmission((details) => limiter.admit(details));
  return Object.freeze({ calls, limiter, reads, rest });
}

// A discord.js guild built offline, as the Guilds intent delivers it, whose channel manager
// sends its requests through the guarded REST above.
function createJoinStormGuild(rest, cachedChannels) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0 } });
  client.rest = rest;
  const bot = { id: BOT_ID, username: 'xiaoji', discriminator: '0', bot: true };
  client.user = new ClientUser(client, bot);
  const guild = client.guilds._add({
    id: GUILD_ID,
    name: 'Synthetic raid guild',
    owner_id: OWNER_ID,
    roles: [{
      id: GUILD_ID, name: '@everyone', position: 0,
      permissions: String(PermissionFlagsBits.ViewChannel | PermissionFlagsBits.SendMessages),
    }],
    channels: cachedChannels,
    members: [{ user: bot, roles: [], joined_at: new Date(CUTOVER_MS).toISOString() }],
  });
  return Object.freeze({ client, guild });
}

// 200 members join in 10 seconds, 20 at a time, each welcomed by the handler inside the
// trusted context the event dispatcher gives a guildMemberAdd.
async function runJoinStorm({ guild, welcome, config }) {
  let clock = 0;
  const channelLookup = createWelcomeChannelLookup({ now: () => clock });
  const results = [];
  for (let second = 0; second < 10; second += 1) {
    results.push(...await Promise.all(Array.from({ length: 20 }, (_, index) => {
      const number = (second * 20) + index;
      const member = guild.members._add({
        user: { id: snowflake(number, '6'), username: `synthetic-${number}`, discriminator: '0' },
        roles: [],
        joined_at: new Date(CUTOVER_MS + 1_000 + number).toISOString(),
      });
      const context = captureDiscordEventContext('guildMemberAdd', [member],
        { publicEffectAuthority: welcome.authority });
      return runWithHostOperationContext(context, () => handleGuildMemberWelcome(member,
        { config, runtime: welcome.runtime, channelLookup }));
    })));
    clock += 1_000;
  }
  await welcome.runtime.waitForIdleForTests();
  return results;
}

async function assertJoinStorm(name, { cachedChannels, channelRead, config, expectedReads }) {
  const transport = createJoinStormTransport(channelRead);
  const welcome = createWelcomeRuntime(name, transport.rest, transport.limiter);
  const { client, guild } = createJoinStormGuild(transport.rest, cachedChannels);
  try {
    const results = await runJoinStorm({ guild, welcome, config });
    assert.equal(results.length, 200);
    // The first 20 joins wait on the same lookup when there is one; each must still be welcomed
    // under its own trusted join context (the queue is empty then, so none is refused for room).
    assert.ok(results.slice(0, 20).every((result) => result === true));
    assert.equal(welcome.runtime.getStatsForTests().queueLength, 0);
    // The channel lookups of 200 joins: none while the cache holds what a welcome needs, and
    // one when it does not, never one per join.
    assert.deepEqual(transport.reads, expectedReads);
    // The welcomes themselves are bounded by the existing message limit, as before.
    assert.ok(results.filter(Boolean).length >= 20);
    assert.equal(transport.calls.length, 20);
    assert.equal(operationCount(welcome.runtime, 'welcome'), 20);
    assert.ok(transport.calls.every(({ route, body }) => route === `/channels/${CHANNEL_ID}/messages` &&
      body.allowed_mentions.parse.length === 0 && body.allowed_mentions.users.length === 1));
  } finally {
    await welcome.runtime.stop();
    await client.destroy();
  }
}

function operationCount(runtime, purposeId) {
  const ledger = runtime.slots ? runtime.slots.get(purposeId).ledger : runtime.ledger;
  return Object.keys(ledger.getSnapshotForTests().operations).length;
}

async function withNetworkBlocked(callback) {
  const previous = getGlobalDispatcher();
  const blocked = new MockAgent();
  blocked.disableNetConnect();
  setGlobalDispatcher(blocked);
  try {
    return await callback();
  } finally {
    setGlobalDispatcher(previous);
    await blocked.close();
  }
}

async function withMessageCreateFakes(state, callback) {
  const modules = [
    ['../src/services/mentionService', {
      handleMentionMessage: async () => { state.mentionCalls += 1; },
      isPublicPersistenceSuppressed: () => false,
    }],
    ['../src/services/messageFeatureRouter', { routeMessageFeatures: async () => ({ handled: false }) }],
    ['../src/services/memoryService', { recordPublicMessage: () => {} }],
    ['../src/services/publicStatusService', { recordPublicInteraction: async () => {} }],
    ['../src/extensions/extensionHost', { getClientExtensionHost: () => ({ runHook: async () => [] }) }],
    ['../src/systems/conversation/publicVisibility', { captureIngressVisibility: () => {} }],
  ];
  const eventPath = require.resolve('../src/events/messageCreate');
  const previousEvent = require.cache[eventPath];
  const replacements = modules.map(([request, replacement]) => {
    const resolved = require.resolve(request);
    const previous = require.cache[resolved] || null;
    const entry = new Module(resolved, module);
    entry.filename = resolved;
    entry.loaded = true;
    entry.exports = replacement;
    require.cache[resolved] = entry;
    return Object.freeze({ resolved, previous });
  });
  delete require.cache[eventPath];
  try {
    return await callback(require(eventPath));
  } finally {
    delete require.cache[eventPath];
    if (previousEvent) require.cache[eventPath] = previousEvent;
    for (const { resolved, previous } of replacements) {
      if (previous) require.cache[resolved] = previous;
      else delete require.cache[resolved];
    }
  }
}

function mentionMessage({ authorId, client, reply }) {
  return {
    id: snowflake(Number(authorId.slice(-4)), '7'),
    author: { id: authorId, bot: false, tag: `synthetic-${authorId}` },
    client,
    guildId: GUILD_ID,
    channelId: CHANNEL_ID,
    content: `<@${BOT_ID}> 測試`,
    mentions: { has: (id) => id === BOT_ID },
    reply,
  };
}

// The join event itself (src/events/guildMemberAdd.js) in front of the real welcome handler and the real
// welcome runtime: the once-only record must leave a storm of different members as bounded as it was,
// and must keep a second wave of the same members from being welcomed again. Only the handler's guild
// config and channel lookup are handed in, as runJoinStorm does, so no data file of the project is read.
test('300 different members joining through the event are welcomed once each within the queue and rate limits, and again by no one', async () => {
  const originalLog = { info: logger.info, warn: logger.warn };
  logger.info = () => {};
  // Members the full queue could not take are logged one by one by the handler; the test counts them instead.
  logger.warn = () => {};
  const transport = createJoinStormTransport((route) => { throw new Error(`Unexpected synthetic read ${route}`); });
  const welcome = createWelcomeRuntime('storm-once', transport.rest, transport.limiter);
  const { client, guild } = createJoinStormGuild(transport.rest, [STORM_CHANNEL]);
  client.welcomeSideEffectRuntime = welcome.runtime;
  client.extensionHost = { runHook: async () => [] };
  const store = createWelcomedMembers({
    filePath: path.join(root, 'welcomed-storm.json'),
    now: () => NOW_MS,
    limits: { maxPerGuild: 1_000, maxTotal: 1_000 },
  });
  setWelcomedMembersForTests(store);

  const answers = [];
  const channelLookup = createWelcomeChannelLookup({ now: () => 0 });
  const stubs = [
    ['../src/services/welcomeService', {
      handleGuildMemberWelcome: async (member) => {
        const accepted = await handleGuildMemberWelcome(member,
          { config: { welcomeChannelId: CHANNEL_ID }, runtime: welcome.runtime, channelLookup });
        answers.push([member.id, accepted]);
        return accepted;
      },
    }],
    // This file holds the extension context runner, so the extension host is not loaded here.
    ['../src/extensions/extensionHost', { getClientExtensionHost: () => ({ runHook: async () => [] }) }],
  ];
  const eventPath = require.resolve('../src/events/guildMemberAdd');
  const previousEvent = require.cache[eventPath];
  const replacements = stubs.map(([request, replacement]) => {
    const resolved = require.resolve(request);
    const previous = require.cache[resolved] || null;
    const entry = new Module(resolved, module);
    entry.filename = resolved;
    entry.loaded = true;
    entry.exports = replacement;
    require.cache[resolved] = entry;
    return Object.freeze({ resolved, previous });
  });
  delete require.cache[eventPath];
  try {
    const event = require(eventPath);
    const wave = async (joinedOffset) => {
      for (let second = 0; second < 15; second += 1) {
        await Promise.all(Array.from({ length: 20 }, (_, index) => {
          const number = (second * 20) + index;
          const member = guild.members._add({
            user: { id: snowflake(number, '6'), username: `synthetic-${number}`, discriminator: '0' },
            roles: [],
            joined_at: new Date(CUTOVER_MS + joinedOffset + number).toISOString(),
          });
          const context = captureDiscordEventContext('guildMemberAdd', [member],
            { publicEffectAuthority: welcome.authority });
          return runWithHostOperationContext(context, () => event.execute(member));
        }));
      }
      await welcome.runtime.waitForIdleForTests();
    };

    await wave(1_000);
    const first = answers.splice(0);
    assert.equal(first.length, 300, 'every join asked for a welcome once');
    assert.equal(new Set(first.map(([id]) => id)).size, 300);
    const accepted = new Set(first.filter(([, result]) => result === true).map(([id]) => id));
    assert.ok(accepted.size >= 20 && accepted.size <= 300);
    // What was accepted is remembered, and only that.
    for (const [id, result] of first) assert.equal(store.has(GUILD_ID, id), result === true, id);
    assert.equal(store.stats().total, accepted.size);
    // The sends are still bounded by the existing message limit, one welcome for one accepted member.
    assert.equal(transport.calls.length, 20);
    assert.equal(operationCount(welcome.runtime, 'welcome'), 20);
    assert.ok(transport.calls.every(({ route, body }) => route === `/channels/${CHANNEL_ID}/messages` &&
      body.allowed_mentions.parse.length === 0 && body.allowed_mentions.users.length === 1));
    assert.equal(welcome.runtime.getStatsForTests().queueLength, 0);

    // The same 300 join again, each with a new join time: no one who was accepted is asked for again.
    await wave(1_000_000);
    const second = answers.splice(0);
    assert.equal(second.some(([id]) => accepted.has(id)), false);
    assert.equal(second.length, 300 - accepted.size);
    assert.equal(transport.calls.length, 20, 'the rate limit holds across both waves');
    assert.equal(operationCount(welcome.runtime, 'welcome'), 20);
  } finally {
    delete require.cache[eventPath];
    if (previousEvent) require.cache[eventPath] = previousEvent;
    for (const { resolved, previous } of replacements) {
      if (previous) require.cache[resolved] = previous;
      else delete require.cache[resolved];
    }
    setWelcomedMembersForTests(null);
    store.flush();
    await welcome.runtime.stop();
    await client.destroy();
    Object.assign(logger, originalLog);
  }
});

test('local synthetic raid simulation keeps output bounded, durable deferrals empty, and networking blocked', async () => {
  const originalInfo = logger.info;
  logger.info = () => {};
  try {
    await withNetworkBlocked(async () => {
      const welcomeTransport = createGuardedRest();
      const welcome = createWelcomeRuntime('raid-welcome', welcomeTransport.rest, welcomeTransport.limiter);
      try {
        const accepted = Array.from({ length: 500 }, (_, index) => {
          const memberId = snowflake(index, '6');
          const eventGrant = welcome.authority.captureGuildMemberAdd({
            botId: BOT_ID,
            guildId: GUILD_ID,
            memberId,
            joinedTimestamp: CUTOVER_MS + index + 1,
          });
          const effect = welcomeEffect(memberId);
          return welcome.runtime.accept(welcome.authority.issueEffect(eventGrant, effect), effect);
        });
        assert.equal(accepted.filter(Boolean).length, 128);
        assert.equal(accepted.filter((value) => !value).length, 372);
        await welcome.runtime.waitForIdleForTests();
        assert.equal(welcomeTransport.calls.length, 20);
        assert.equal(operationCount(welcome.runtime, 'welcome'), 20);
        assert.ok(welcomeTransport.calls.every(({ body }) => !body.allowed_mentions.parse.includes('everyone')));
      } finally {
        await welcome.runtime.stop();
      }

      const slowTransport = createSlowWelcomeTransport();
      const slowWelcome = createWelcomeRuntime('raid-welcome-slow', slowTransport.rest, slowTransport.limiter);
      try {
        for (let index = 0; index < 3; index += 1) {
          const memberId = snowflake(index, '1');
          const eventGrant = slowWelcome.authority.captureGuildMemberAdd({
            botId: BOT_ID,
            guildId: GUILD_ID,
            memberId,
            joinedTimestamp: CUTOVER_MS + 10_000 + index,
          });
          const effect = welcomeEffect(memberId);
          assert.equal(slowWelcome.runtime.accept(slowWelcome.authority.issueEffect(eventGrant, effect), effect), true);
        }
        await slowWelcome.runtime.waitForIdleForTests();
        assert.equal(slowTransport.calls.length, 3);
        assert.equal(operationCount(slowWelcome.runtime, 'welcome'), 3);
        assert.equal(slowTransport.limiter.snapshotForTests().reservations, 0);
      } finally {
        await slowWelcome.runtime.stop();
      }

      const originalWarn = logger.warn;
      const warnings = [];
      logger.warn = (line) => { warnings.push(String(line)); };
      try {
        const unexpectedRead = (route) => { throw new Error(`Unexpected synthetic read ${route}`); };
        await assertJoinStorm('storm-cached', {
          cachedChannels: [STORM_CHANNEL],
          channelRead: unexpectedRead,
          config: { welcomeChannelId: CHANNEL_ID },
          expectedReads: [],
        });
        await assertJoinStorm('storm-empty-cache', {
          cachedChannels: [],
          channelRead: (route) => {
            if (route === `/guilds/${GUILD_ID}/channels`) return [STORM_CHANNEL];
            return unexpectedRead(route);
          },
          config: {},
          expectedReads: [`/guilds/${GUILD_ID}/channels`],
        });
        await assertJoinStorm('storm-deleted-configured', {
          cachedChannels: [STORM_CHANNEL],
          channelRead: (route) => {
            if (route === `/channels/${DELETED_CHANNEL_ID}`) {
              throw Object.assign(new Error('Unknown Channel'), { status: 404, code: 10003 });
            }
            return unexpectedRead(route);
          },
          config: { welcomeChannelId: DELETED_CHANNEL_ID },
          expectedReads: [`/channels/${DELETED_CHANNEL_ID}`],
        });
        // Each join of the last storm still says that the configured channel is gone.
        assert.equal(warnings.filter((line) => line.includes(`Welcome channel ${DELETED_CHANNEL_ID}`)).length, 200);
      } finally {
        logger.warn = originalWarn;
      }

      const mentionTransport = createGuardedRest();
      const mentionState = { mentionCalls: 0 };
      await withMessageCreateFakes(mentionState, async (listener) => {
        const client = { user: { id: BOT_ID } };
        const reply = async (content) => mentionTransport.rest.request({
          method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`, body: { content },
        });
        for (let index = 0; index < 199; index += 1) {
          await listener.execute(mentionMessage({ authorId: snowflake(index, '5'), client, reply }));
        }
        await listener.execute(mentionMessage({ authorId: OWNER_ID, client, reply }));
      });
      // A guild with no record is served like any other: every mention goes to the mention handler (whose own
      // guards bound the answers), and the event itself sends nothing in its place.
      assert.equal(mentionTransport.calls.length, 0);
      assert.equal(mentionState.mentionCalls, 200);

      const reminderTransport = createGuardedRest();
      const reminderOutcomes = await Promise.all(Array.from({ length: 100 }, async (_, index) => {
        try {
          await reminderTransport.rest.request({
            method: 'POST', fullRoute: '/users/@me/channels', body: { recipient_id: snowflake(index, '4') },
          });
          return 'sent';
        } catch (error) {
          assert.equal(error?.code, 'EGRESS_RATE_LIMITED');
          return 'deferred';
        }
      }));
      assert.equal(reminderOutcomes.filter((result) => result === 'sent').length, 30);
      assert.equal(reminderOutcomes.filter((result) => result === 'deferred').length, 70);
      assert.equal(reminderTransport.calls.length, 30);

      const roleTransport = createGuardedRest();
      const roleOutcomes = await Promise.all(Array.from({ length: 1_000 }, async (_, index) => {
        try {
          await extensionContextRunner.run({
            extensionId: 'synthetic-extension', entry: 'command', name: 'synthetic.sync', sourceGuildId: GUILD_ID,
          }, () => roleTransport.rest.request({
            method: 'PATCH', fullRoute: `/guilds/${GUILD_ID}/members/${snowflake(index, '3')}`, body: { roles: [] },
          }));
          return 'sent';
        } catch (error) {
          assert.equal(error?.code, 'EGRESS_RATE_LIMITED');
          return 'deferred';
        }
      }));
      // A member PATCH replaces the whole member (its role list included), so in a protected guild it
      // draws on the member-sanction budget of 30 an hour.
      assert.equal(roleOutcomes.filter((result) => result === 'sent').length, 30);
      assert.equal(roleOutcomes.filter((result) => result === 'deferred').length, 970);
      assert.equal(roleTransport.calls.length, 30);

      // Adding single roles: 300 an hour, but never more than 30 in a minute, so a burst stops at 30.
      const roleAddTransport = createGuardedRest();
      const roleAddOutcomes = await Promise.all(Array.from({ length: 1_000 }, async (_, index) => {
        try {
          await extensionContextRunner.run({
            extensionId: 'synthetic-extension', entry: 'hook', name: 'synthetic.sync', sourceGuildId: GUILD_ID,
          }, () => roleAddTransport.rest.request({
            method: 'PUT', fullRoute: `/guilds/${GUILD_ID}/members/${snowflake(index, '3')}/roles/${snowflake(1, '7')}`,
          }));
          return 'sent';
        } catch (error) {
          assert.equal(error?.code, 'EGRESS_RATE_LIMITED');
          return 'deferred';
        }
      }));
      assert.equal(roleAddOutcomes.filter((result) => result === 'sent').length, 30);
      assert.equal(roleAddOutcomes.filter((result) => result === 'deferred').length, 970);
      assert.equal(roleAddTransport.calls.length, 30);

      // Guilds are not reviewed, so no code path leaves one on its own: the grant issuer has no way to
      // mint a leave grant. (An Owner's extension command leaving a guild is the other, separate path.)
      assert.deepEqual(Object.keys(createPublicEffectAuthority().createIssuer()).sort(),
        ['issueChainReaction', 'issuePenalty', 'issueStoredChainReaction', 'issueWorkReminder']);

      const contentTransport = createGuardedRest();
      await contentTransport.rest.request({
        method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
        body: {
          content: '提醒 @everyone https://evil.example/reminder',
          allowed_mentions: { parse: ['users', 'everyone', 'roles'], roles: [GUILD_ID], users: [OWNER_ID] },
          poll: { question: { text: '投票 https://[::1]/' }, answers: [{ poll_media: { text: '選項 https://evil.example/' } }] },
        },
      });
      await contentTransport.rest.request({
        method: 'POST', fullRoute: `/channels/${CHANNEL_ID}/messages`,
        body: { content: '工作提醒 @here https://evil.example/work', allowed_mentions: { parse: ['everyone'] } },
      });
      assert.equal(contentTransport.calls.length, 2);
      for (const { body } of contentTransport.calls) {
        assert.equal(JSON.stringify(body).includes('https://'), false);
        assert.equal(body.allowed_mentions.parse.includes('everyone'), false);
        assert.equal(body.allowed_mentions.parse.includes('roles'), false);
      }
    });
  } finally {
    logger.info = originalInfo;
    configurePublicEffectAdapter();
    restoreEnvironment();
    removeRealTempDir(root);
  }
});
