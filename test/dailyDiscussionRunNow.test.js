'use strict';

// What /daily-discussion run-now tells an administrator. When the schedule already posted today's topic, the
// command used to answer "發布 0", as if nothing had been posted. These tests run the real command and the real
// tick against a synthetic database in a temporary directory, with fake Discord objects only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ChannelType, PermissionFlagsBits } = require('discord.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-daily-runnow-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.BOT_OWNER_ID = 'owner-user';

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
} = require('../src/services/coinDatabase');
const discussionService = require('../src/services/dailyDiscussionService');
const { setGuildFeatureSetting } = require('../src/services/featurePlatformService');
const command = require('../src/commands/daily-discussion');

const LOCAL_DATE = '2026-09-30';
// Taipei 09:00 on LOCAL_DATE, inside the day window of the discussion.
const NOW = new Date('2026-09-30T01:00:00.000Z');

test.before(async () => {
  resetCoinDatabaseForTests();
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// A parent channel that keeps what it was sent and hands it back as its history, newest first.
function createFixture(prefix) {
  const sent = [];
  const threadId = `${prefix}-thread`;
  const thread = { id: threadId, messages: { fetch: async () => [] }, send: async () => ({ id: `${prefix}-answer` }) };
  const parentId = `${prefix}-parent`;
  const parent = {
    id: parentId,
    type: ChannelType.GuildText,
    permissionsFor: () => ({ has: () => true }),
    messages: { fetch: async () => [...sent].reverse() },
    async send(payload) {
      const message = {
        id: `${prefix}-announcement-${sent.length + 1}`,
        payload,
        author: { id: 'bot' },
        createdAt: NOW,
        embeds: payload.embeds,
        async startThread() { return thread; },
      };
      sent.push(message);
      return message;
    },
  };
  const guildId = `${prefix}-guild`;
  const botMember = { id: 'bot', permissions: { has: () => true } };
  const guild = {
    id: guildId,
    channels: {
      cache: new Map([[parentId, parent], [threadId, thread]]),
      fetch: async (id) => (id === parentId ? parent : id === threadId ? thread : null),
    },
    members: { me: botMember, fetchMe: async () => botMember, fetch: async (id) => ({ id }) },
  };
  const client = { user: { id: 'bot' }, guilds: { cache: new Map([[guildId, guild]]) }, channels: { cache: new Map() } };
  return { client, guild, sent, guildId, parentId };
}

// An administrator running /daily-discussion run-now (or another subcommand) in that guild.
function createInteraction(fixture, subcommand = 'run-now') {
  const replies = [];
  const interaction = {
    commandName: 'daily-discussion',
    guildId: fixture.guildId,
    guild: fixture.guild,
    client: fixture.client,
    user: { id: 'synthetic-administrator' },
    memberPermissions: { has: (flag) => flag === PermissionFlagsBits.Administrator },
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: { getSubcommand: () => subcommand },
    async reply(payload) { replies.push(payload); interaction.replied = true; },
    async followUp(payload) { replies.push(payload); },
  };
  return { interaction, replies };
}

async function enable(fixture) {
  await setGuildFeatureSetting(fixture.guildId, discussionService.FEATURE_KEY, {
    enabled: true,
    channelId: fixture.parentId,
  });
}

// The command reads the clock itself (new Date()), so the clock is fixed for the duration of one test.
async function runNow(t, fixture) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const { interaction, replies } = createInteraction(fixture);
  await command.execute(interaction);
  assert.equal(replies.length, 1, `run-now answers once: ${JSON.stringify(replies)}`);
  assert.equal(replies[0].ephemeral, true);
  return replies[0].content;
}

test('run-now after the schedule already posted today says the topic is posted, not "發布 0"', async (t) => {
  const fixture = createFixture('runnow-after-tick');
  await enable(fixture);
  const first = await discussionService.processDailyDiscussionTick(fixture.client, { now: NOW, guildId: fixture.guildId });
  assert.equal(first.published, 1);
  assert.equal(fixture.sent.length, 1);

  const content = await runNow(t, fixture);

  assert.match(content, /已發布/u);
  assert.match(content, /排程已先處理/u);
  assert.doesNotMatch(content, /發布 0/u);
  assert.equal(fixture.sent.length, 1, 'run-now must not post the topic a second time');
});

test('two ticks at the same moment publish once and the second one reports that it was skipped', async () => {
  const fixture = createFixture('runnow-race');
  await enable(fixture);

  const results = await Promise.all([
    discussionService.processDailyDiscussionTick(fixture.client, { now: NOW, guildId: fixture.guildId }),
    discussionService.processDailyDiscussionTick(fixture.client, { now: NOW, guildId: fixture.guildId }),
  ]);

  assert.equal(results.reduce((sum, result) => sum + result.published, 0), 1, 'exactly one tick publishes');
  assert.equal(results.reduce((sum, result) => sum + result.skipped, 0), 1, 'the other tick reports it was skipped');
  assert.equal(fixture.sent.length, 1, 'only one topic is posted');
  const event = await discussionService.getDailyDiscussionEvent(fixture.guildId, LOCAL_DATE);
  assert.match(event.status, /^published/u);
});

test('run-now while another run is still publishing says it is publishing and points to status', async (t) => {
  const fixture = createFixture('runnow-claimed');
  await enable(fixture);
  const claim = await discussionService.claimDailyDiscussionEvent({
    guildId: fixture.guildId, parentChannelId: fixture.parentId, localDate: LOCAL_DATE, now: NOW,
  });
  assert.equal(claim.claimed, true);

  const content = await runNow(t, fixture);

  assert.match(content, /發布中/u);
  assert.match(content, /status/u);
  assert.doesNotMatch(content, /發布 0/u);
  assert.equal(fixture.sent.length, 0, 'run-now must not post while the other run holds the lease');
});

test('run-now with nobody else in the way still posts the topic and reports "發布 1"', async (t) => {
  const fixture = createFixture('runnow-alone');
  await enable(fixture);

  const content = await runNow(t, fixture);

  assert.match(content, /發布 1、結算 0、延後 0/u);
  assert.equal(fixture.sent.length, 1);
  const event = await discussionService.getDailyDiscussionEvent(fixture.guildId, LOCAL_DATE);
  assert.match(event.status, /^published/u);
});

test('run-now whose publish failed keeps the plain count text, not "already posted"', async (t) => {
  const fixture = createFixture('runnow-nothing');
  // The channel refuses the post, so the tick claims the event but publishes nothing.
  await setGuildFeatureSetting(fixture.guildId, discussionService.FEATURE_KEY, { enabled: true, channelId: fixture.parentId });
  fixture.guild.channels.cache.get(fixture.parentId).send = async () => { throw Object.assign(new Error('synthetic send failure'), { code: 50013 }); };
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'error', () => {});

  const content = await runNow(t, fixture);

  assert.match(content, /發布 0、結算 0、延後 0/u, 'a failed publish is not reported as already posted');
  assert.equal(fixture.sent.length, 0);
});
