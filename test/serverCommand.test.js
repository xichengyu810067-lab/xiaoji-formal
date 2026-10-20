'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { buildTestDeploymentPlan, deployCommands } = require('../deploy-commands');
const helpCommand = require('../src/commands/help');
const serverCommand = require('../src/commands/server');
const { loadCommandData, loadCommands } = require('../src/loadCommands');
const { authorizeInteraction } = require('../src/platform/testControlIngress');
const { loadTestControlPolicy } = require('../src/platform/testControlPolicy');
const { IDS, createFixture } = require('./testControlSupport');

const CREATED_TIMESTAMP = Date.UTC(2024, 0, 2, 3, 4, 5);

function createInteraction(overrides = {}) {
  let replyPayload = null;
  const members = {};
  Object.defineProperty(members, 'cache', {
    get() { throw new Error('members.cache must not be read'); },
  });
  const guild = {
    id: IDS.guild,
    name: '小吉測試伺服器',
    memberCount: 42,
    createdTimestamp: CREATED_TIMESTAMP,
    ownerId: IDS.actor,
    members,
    fetchOwner() { throw new Error('fetchOwner must not be called'); },
  };
  const client = {};
  Object.defineProperty(client, 'guilds', {
    get() { throw new Error('cross-guild collection must not be read'); },
  });
  const interaction = {
    guild,
    guildId: IDS.guild,
    client,
    inGuild: () => true,
    async reply(payload) { replyPayload = payload; },
    ...overrides,
  };
  return { interaction, reply: () => replyPayload };
}

test('/server reports five current-guild facts without REST, cache counts, or mention notifications', async () => {
  const fixture = createInteraction();
  await serverCommand.execute(fixture.interaction);
  const payload = fixture.reply();
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.ephemeral, true);
  const embed = payload.embeds[0].toJSON();
  assert.equal(embed.title, '目前伺服器資訊');
  assert.deepEqual(embed.fields, [
    { name: '伺服器名稱', value: '小吉測試伺服器' },
    { name: '成員數', value: '42', inline: true },
    { name: '建立時間', value: `<t:${Math.floor(CREATED_TIMESTAMP / 1000)}:F>`, inline: true },
    { name: '伺服器擁有者', value: `<@${IDS.actor}>\nID：\`${IDS.actor}\`` },
    { name: '伺服器 ID', value: `\`${IDS.guild}\`` },
  ]);
});

test('/server tells a direct message that it only works in a server', async () => {
  const fixture = createInteraction({ guild: null, guildId: null, inGuild: () => false });
  await serverCommand.execute(fixture.interaction);
  const payload = fixture.reply();
  assert.equal(payload.content, '這個指令只能在伺服器內使用。');
  assert.equal(payload.ephemeral, true);
  assert.deepEqual(payload.allowedMentions, { parse: [] });
  assert.equal(payload.embeds, undefined);
  assert.equal(serverCommand.data.toJSON().dm_permission, false);
});

test('/server fails closed for mismatched guild and incomplete current-guild data', async () => {
  const cases = [
    { guildId: IDS.otherGuild },
    { guild: { id: IDS.guild, name: '', memberCount: 42, createdTimestamp: CREATED_TIMESTAMP,
      ownerId: IDS.actor } },
    { guild: { id: IDS.guild, name: '測試', memberCount: undefined,
      createdTimestamp: CREATED_TIMESTAMP, ownerId: IDS.actor } },
    { guild: { id: IDS.guild, name: '測試', memberCount: 42,
      createdTimestamp: undefined, ownerId: IDS.actor } },
    { guild: { id: IDS.guild, name: '測試', memberCount: 42,
      createdTimestamp: CREATED_TIMESTAMP, ownerId: undefined } },
  ];
  for (const overrides of cases) {
    const fixture = createInteraction(overrides);
    await serverCommand.execute(fixture.interaction);
    const payload = fixture.reply();
    assert.equal(payload.content,
      '小吉目前無法讀取這個伺服器的完整資訊，請在目前伺服器中重新使用 /server。');
    assert.equal(payload.ephemeral, true);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(JSON.stringify(payload).includes('undefined'), false);
    assert.equal(payload.embeds, undefined);
  }
});

test('loader and serialized deployment data contain exactly one public /server', () => {
  const commands = loadCommands();
  const serialized = loadCommandData();
  assert.equal(commands.has('server'), true);
  assert.equal(commands.get('server'), serverCommand);
  assert.equal([...commands.keys()].filter((name) => name === 'server').length, 1);
  assert.equal(serialized.filter((command) => command.name === 'server').length, 1);
  assert.equal(serialized.find((command) => command.name === 'server').description,
    '顯示目前伺服器資訊');
});

test('/help and public command documentation list /server once', async () => {
  let reply = null;
  await helpCommand.execute({ async reply(payload) { reply = payload; } });
  const helpText = reply.embeds[0].toJSON().fields.map((field) => field.value).join('\n');
  assert.equal((helpText.match(/`\/server`/gu) || []).length, 1);
  const documentation = fs.readFileSync(path.join(__dirname, '..', 'docs', 'COMMANDS.md'), 'utf8');
  assert.equal((documentation.match(/`\/server`/gu) || []).length, 1);
});

test('test-control deploy includes /server only when explicitly allowlisted and stays test-guild-only', async () => {
  for (const allowed of ['ping', 'ping,help']) {
    const fixture = createFixture({ XIAOJI_TEST_ALLOWED_COMMANDS: allowed });
    try {
      const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
      const plan = buildTestDeploymentPlan({ policy, publicCommands: loadCommandData() });
      assert.equal(plan[0].body.some((command) => command.name === 'server'), false);
    } finally { fixture.cleanup(); }
  }

  const fixture = createFixture({ XIAOJI_TEST_ALLOWED_COMMANDS: 'server' });
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const plan = buildTestDeploymentPlan({ policy, publicCommands: loadCommandData() });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].kind, 'test-guild');
    assert.equal(plan[0].guildId, IDS.guild);
    assert.deepEqual(plan[0].body.map((command) => command.name), ['server']);
    assert.equal(plan[0].route.endsWith(`/applications/${IDS.app}/commands`), false);

    const result = await deployCommands({
      token: 'synthetic-token',
      clientId: IDS.app,
      dryRun: true,
      testControl: true,
      testControlPolicy: policy,
      protectedGuildIds: null,
    });
    assert.equal(result.globalCount, 0);
    assert.equal(result.privateCommandCount, 0);
    assert.equal(result.privateGuildCount, 0);
    assert.equal(result.testGuildCount, 1);
    assert.equal(result.plan.every((operation) => operation.kind === 'test-guild'), true);
  } finally { fixture.cleanup(); }
});

test('/server does not loosen existing actor, channel, or guild ingress checks', () => {
  const fixture = createFixture({ XIAOJI_TEST_ALLOWED_COMMANDS: 'server' });
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    let bound = 0;
    const client = { testControlPolicy: policy, testControlEgress: { bindInteraction() { bound += 1; } } };
    const interaction = {
      client,
      id: IDS.interaction,
      token: 'synthetic-token',
      guildId: IDS.guild,
      channelId: IDS.channel,
      user: { id: IDS.actor },
      commandName: 'server',
      isChatInputCommand: () => true,
      isAutocomplete: () => false,
    };
    assert.equal(authorizeInteraction(interaction), true);
    assert.equal(bound, 1);
    assert.equal(authorizeInteraction({ ...interaction, user: { id: IDS.formal } }), false);
    assert.equal(authorizeInteraction({ ...interaction, channelId: IDS.otherChannel }), false);
    assert.equal(authorizeInteraction({ ...interaction, guildId: IDS.otherGuild }), false);
    assert.equal(bound, 1);
  } finally { fixture.cleanup(); }
});
