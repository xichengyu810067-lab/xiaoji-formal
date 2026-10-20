'use strict';

// /daily and /leaderboard answer in public and name members with mentions, so the names are
// clickable. Nobody may be notified: not the member who checked in, not anyone on a board. Each
// reply is built by the real command against an isolated coin database, then resolved the way
// discord.js resolves it and sent through the egress guard to a synthetic transport, which shows
// the allowed_mentions Discord would really receive.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { MessagePayload, Options, Routes } = require('discord.js');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-public-mentions-'));
process.env.COIN_DB_PATH = path.join(root, 'public-mentions.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

const dailyCommand = require('../src/commands/daily');
const leaderboardCommand = require('../src/commands/leaderboard');
const { initializeNewCoinDatabase, resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const { adjustPlayerBalance } = require('../src/services/coinService');
const { installEgressGuard } = require('../src/platform/egressGuard');
const { createEgressLimiter } = require('../src/platform/egressLimiter');
const { createSyntheticRest } = require('./fixtures/syntheticRest');

const GUILD_ID = '23456789012345678';
const MEMBER_ID = '67890123456789012';
const OTHER_MEMBER_ID = '67890123456789013';
const INTERACTION_ID = '56789012345678901';
const APPLICATION_ID = '45678901234567890';
const NO_PINGS = { parse: [] };
// discord.js only reads client options while it resolves a payload; the bot sets no default.
const TARGET = Object.freeze({ client: Object.freeze({ options: Options.createDefault() }) });

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  for (const [userId, amount] of [[MEMBER_ID, 900], [OTHER_MEMBER_ID, 500]]) {
    await adjustPlayerBalance(GUILD_ID, userId, {
      action: 'add', amount, operatorId: 'fixture-admin', reason: 'mention fixture',
    });
  }
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const userOf = (id) => ({ id, bot: false, toString: () => `<@${id}>` });

function interactionFor(commandName, { type = null } = {}) {
  const calls = [];
  const interaction = {
    commandName,
    guildId: GUILD_ID,
    guild: { id: GUILD_ID, name: 'Mention Guild' },
    user: userOf(MEMBER_ID),
    replied: false,
    deferred: false,
    inGuild: () => true,
    client: { users: { fetch: async (id) => userOf(id) } },
    options: {
      getString: (name) => (name === 'type' ? type : null),
      getInteger: () => null,
    },
    async reply(payload) { calls.push({ name: 'reply', payload }); interaction.replied = true; },
    async deferReply(payload) { calls.push({ name: 'deferReply', payload }); interaction.deferred = true; },
    async editReply(payload) { calls.push({ name: 'editReply', payload }); interaction.replied = true; },
    async followUp(payload) { calls.push({ name: 'followUp', payload }); },
  };
  return { interaction, calls };
}

// Sends a reply payload as the initial interaction response, or an edit payload as the edit of
// the deferred response, through the egress guard, and returns the allowed_mentions delivered.
async function delivered(payload, { asEdit = false } = {}) {
  const received = [];
  const record = (route, request) => {
    received.push(request.body);
    return { id: '34567890123456789' };
  };
  const rest = createSyntheticRest({ post: record, patch: record });
  const guard = installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2', resolveChannelGuild: () => GUILD_ID });
  const limiter = createEgressLimiter();
  guard.setAdmission((details) => limiter.admit(details));
  const { body } = await MessagePayload.create(TARGET, payload).resolveBody().resolveFiles();
  if (asEdit) {
    await rest.patch(Routes.webhookMessage(APPLICATION_ID, 'synthetic-token', '@original'), { body, auth: false });
  } else {
    await rest.post(Routes.interactionCallback(INTERACTION_ID, 'synthetic-token'), { body: { type: 4, data: body }, auth: false });
  }
  assert.equal(received.length, 1);
  return asEdit ? received[0].allowed_mentions : received[0].data.allowed_mentions;
}

// Discord notifies a mentioned user only when allowed_mentions parses users or lists that user.
function assertNobodyPinged(mentions, userIds) {
  assert.ok(mentions, 'allowed_mentions is sent');
  assert.equal((mentions.parse || []).includes('users'), false, JSON.stringify(mentions));
  for (const userId of userIds) assert.equal((mentions.users || []).includes(userId), false, userId);
  assert.notEqual(mentions.replied_user, true);
}

test('/daily answers in public, names the member, and does not ping them', async () => {
  const { interaction, calls } = interactionFor('daily');
  await dailyCommand.execute(interaction);
  assert.deepEqual(calls.map(({ name }) => name), ['reply']);
  const { payload } = calls[0];
  assert.match(payload.content, new RegExp(`^<@${MEMBER_ID}> 簽到成功，今天獲得 `, 'u'));
  assert.equal(payload.ephemeral, undefined);
  assert.deepEqual(payload.allowedMentions, NO_PINGS);
  assertNobodyPinged(await delivered(payload), [MEMBER_ID]);
});

test('/leaderboard coins and assets boards name members and ping nobody', async () => {
  const coins = interactionFor('leaderboard', { type: 'coins' });
  await leaderboardCommand.execute(coins.interaction);
  const coinReply = coins.calls.find(({ name }) => name === 'reply').payload;
  assert.ok(coinReply.content.includes(`<@${MEMBER_ID}>`) && coinReply.content.includes(`<@${OTHER_MEMBER_ID}>`));
  assert.deepEqual(coinReply.allowedMentions, NO_PINGS);
  assertNobodyPinged(await delivered(coinReply), [MEMBER_ID, OTHER_MEMBER_ID]);

  const assets = interactionFor('leaderboard', { type: 'assets' });
  await leaderboardCommand.execute(assets.interaction);
  const assetsEdit = assets.calls.find(({ name }) => name === 'editReply').payload;
  assert.ok(assetsEdit.content.includes(`<@${MEMBER_ID}>`) && assetsEdit.content.includes(`<@${OTHER_MEMBER_ID}>`));
  assert.deepEqual(assetsEdit.allowedMentions, NO_PINGS);
  assertNobodyPinged(await delivered(assetsEdit, { asEdit: true }), [MEMBER_ID, OTHER_MEMBER_ID]);
});

// The egress guard removes @everyone and role pings, but it keeps the user pings a payload asks
// for. So it is the commands' own allowedMentions that keeps these public replies silent.
test('the egress guard keeps a user ping a payload asks for, so the command setting is what matters', async () => {
  const mentions = await delivered({ content: `<@${MEMBER_ID}> 簽到成功`, allowedMentions: { parse: ['users'] } });
  assert.deepEqual(mentions.parse, ['users']);
});
