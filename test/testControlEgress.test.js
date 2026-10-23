'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const { HTTPError, REST } = require('@discordjs/rest');
const { Client, DiscordjsError, DiscordjsErrorCodes, GatewayIntentBits } = require('discord.js');
const { Routes } = require('discord-api-types/v10');
const { WebSocketManager } = require('@discordjs/ws');
const { installEgressGuard } = require('../src/platform/egressGuard');
const { installProtectedRest } = require('../src/platform/protectedRest');
const { SYNTHETIC_EGRESS_SYMBOL, createTestControlEgress } = require('../src/platform/testControlEgress');
const { SYNTHETIC_REGISTRY_SYMBOL, loadTestControlPolicy, preflightTestIdentity } = require('../src/platform/testControlPolicy');
const { createTestControlStartupDiagnostics } = require('../src/platform/testControlStartupDiagnostics');
const { createReminderSystem } = require('../src/systems/schedule/reminders/reminderSystem');
const { IDS, createFixture } = require('./testControlSupport');

test('egress allows bound callbacks and allowed channels, but denies foreign and unknown mutations', async () => {
  const fixture = createFixture();
  try {
    const warnings = [];
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd(), logger: { warn: (value) => warnings.push(value) } });
    const egress = createTestControlEgress(policy, { now: () => 1000 });
    egress.bindInteraction({ id: IDS.interaction, token: 'synthetic-interaction-token', guildId: IDS.guild,
      channelId: IDS.channel, user: { id: IDS.actor } });
    assert.equal(egress.allowRequest({ method: 'POST', fullRoute: `/channels/${IDS.channel}/messages` }), true);
    assert.equal(egress.allowRequest({ method: 'POST', fullRoute: `/interactions/${IDS.interaction}/synthetic-interaction-token/callback` }), true);
    assert.equal(egress.allowRequest({ method: 'PATCH', fullRoute: `/webhooks/${IDS.app}/synthetic-interaction-token/messages/@original` }), true);
    assert.throws(() => egress.allowRequest({ method: 'POST', fullRoute: `/channels/${IDS.otherChannel}/messages` }),
      (error) => error.code === 'TEST_CHANNEL_EGRESS_DENIED');
    assert.throws(() => egress.allowRequest({ method: 'POST', fullRoute: '/users/@me/channels' }),
      (error) => error.code === 'TEST_DM_DENIED');
    assert.equal(egress.allowRequest({ method: 'GET', fullRoute: `/users/${IDS.actor}` }), true);
    assert.throws(() => egress.allowRequest({ method: 'GET', fullRoute: `/users/${IDS.otherGuild}` }),
      (error) => error.code === 'TEST_USER_READ_DENIED');
    assert.throws(() => egress.allowRequest({ method: 'POST', fullRoute: '/unknown/mutation' }),
      (error) => error.code === 'TEST_UNKNOWN_MUTATION_DENIED');
    assert.throws(() => egress.allowRequest({ method: 'POST', fullRoute: `/channels/${IDS.otherChannel}/messages` }));
    assert.equal(warnings.filter((line) => line.includes('TEST_CHANNEL_EGRESS_DENIED')).length, 1);
    assert.equal(warnings.some((line) => line.includes('synthetic-interaction-token')), false);
  } finally { fixture.cleanup(); }
});

test('a matching synthetic egress hook can return a local response after the normal test-control gate', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    globalThis[SYNTHETIC_REGISTRY_SYMBOL] = Object.freeze({ active: true, dataRoot: policy.dataRoot,
      expectedApplicationId: policy.expectedApplicationId, allowsActor: (id) => id === IDS.otherGuild });
    const calls = [];
    globalThis[SYNTHETIC_EGRESS_SYMBOL] = Object.freeze({ active: true, dataRoot: policy.dataRoot,
      expectedApplicationId: policy.expectedApplicationId,
      prepareRequest: (_options, context) => Object.freeze({ virtual: true, response: { local: true, route: context.route } }),
      afterResponse: (_response, context) => calls.push(context.virtual),
    });
    let transportCalls = 0;
    const rest = { request: async () => { transportCalls += 1; return { network: true }; } };
    createTestControlEgress(policy).install(rest);
    const value = await rest.request({ method: 'GET', fullRoute: `/users/${IDS.otherGuild}` });
    assert.deepEqual(value, { local: true, route: `/users/${IDS.otherGuild}` });
    assert.equal(transportCalls, 0);
    assert.deepEqual(calls, [true]);
  } finally {
    delete globalThis[SYNTHETIC_EGRESS_SYMBOL];
    delete globalThis[SYNTHETIC_REGISTRY_SYMBOL];
    fixture.cleanup();
  }
});

test('synthetic egress receives a bound interaction channel for webhook output budgeting', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const contexts = [];
    globalThis[SYNTHETIC_EGRESS_SYMBOL] = Object.freeze({ active: true, dataRoot: policy.dataRoot,
      expectedApplicationId: policy.expectedApplicationId,
      prepareRequest: (options, context) => { contexts.push(context); return { virtual: false, options }; },
    });
    const rest = { request: async () => ({ id: '999999999999999999', author: { id: IDS.app } }) };
    const egress = createTestControlEgress(policy);
    egress.bindInteraction({ id: IDS.interaction, token: 'synthetic-token', guildId: IDS.guild,
      channelId: IDS.channel, user: { id: IDS.actor } });
    egress.install(rest);
    await rest.request({ method: 'POST', fullRoute: `/webhooks/${IDS.app}/synthetic-token`, body: {} });
    assert.equal(contexts[0].outputChannelId, IDS.channel);
  } finally {
    delete globalThis[SYNTHETIC_EGRESS_SYMBOL];
    fixture.cleanup();
  }
});

test('denied delayed delivery is not marked delivered', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const egress = createTestControlEgress(policy);
    const filePath = path.join(fixture.root, 'delayed-reminder.json');
    fs.writeFileSync(filePath, JSON.stringify({ reminder: {
      schemaVersion: 1, guildId: IDS.guild, channelId: IDS.otherChannel,
      sourceGuildId: IDS.guild, deliveryGuildId: IDS.guild, deliveryChannelId: IDS.otherChannel,
      userId: IDS.actor, message: 'synthetic', createdAt: 1, remindAt: 2, status: 'pending', attemptCount: 0,
    } }));
    const channel = {
      guildId: IDS.guild, isTextBased: () => true,
      permissionsFor: () => ({ has: () => true }),
      async send() { egress.allowRequest({ method: 'POST', fullRoute: `/channels/${IDS.otherChannel}/messages` }); },
    };
    const member = { id: IDS.actor };
    const guild = { members: { me: { id: IDS.app }, fetch: async () => member } };
    const client = {
      user: { id: IDS.app }, guilds: { fetch: async () => guild }, channels: { fetch: async () => channel },
      testControlPolicy: policy,
    };
    const reminderSystem = createReminderSystem({ filePath });
    await reminderSystem.sendReminder(client, 'reminder');
    assert.equal(reminderSystem.readReminders().reminder.status, 'failed');
    assert.equal(reminderSystem.readReminders().reminder.deliveredAt, undefined);
  } finally { fixture.cleanup(); }
});

test('locked websocket SDK requests only the exact allowlisted gateway route', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const egress = createTestControlEgress(policy);
    const calls = [];
    const manager = new WebSocketManager({
      rest: {
        async get(fullRoute) {
          egress.allowRequest({ method: 'GET', fullRoute });
          calls.push(fullRoute);
          return {
            url: 'wss://synthetic.invalid',
            shards: 1,
            session_start_limit: { total: 1, remaining: 1, reset_after: 1, max_concurrency: 1 },
          };
        },
      },
    });
    await manager.fetchGatewayInformation();
    assert.deepEqual(calls, [Routes.gatewayBot()]);
    assert.equal(Routes.gatewayBot(), '/gateway/bot');
  } finally { fixture.cleanup(); }
});

test('unknown read diagnostics expose only fixed phase, route-family, and caller enums', () => {
  const fixture = createFixture();
  try {
    const warnings = [];
    const canaries = [
      'PRIVATE_VALUE_CANARY',
      'https://canary.invalid/private',
      'synthetic-token-canary',
      'authorization-header-canary',
      'synthetic-stack-canary',
    ];
    let stack = `Error\n at WebSocketManager.fetchGatewayInformation ` +
      `(C:/synthetic/node_modules/@discordjs/ws/dist/index.js:1404:1)\n${canaries.join(' ')}`;
    const policy = loadTestControlPolicy(fixture.env, {
      cwd: process.cwd(), logger: { warn: (value) => warnings.push(value) },
    });
    const egress = createTestControlEgress(policy, { captureStack: () => stack });
    egress.setDiagnosticPhase('login_wait_ready');
    const cases = [
      ['https://discord.com/api/v10/gateway/bot?private=PRIVATE_VALUE_CANARY', 'ABSOLUTE'],
      ['/api/v10/gateway/bot?private=synthetic-token-canary', 'API_PREFIX'],
      ['/gateway/bot/extra?private=authorization-header-canary', 'GATEWAY'],
      ['/applications/@me?private=synthetic-stack-canary', 'CURRENT_APPLICATION'],
      ['/users/@me/guilds?private=PRIVATE_VALUE_CANARY', 'USER_GUILDS'],
      ['/unlisted/PRIVATE_VALUE_CANARY', 'OTHER'],
    ];
    for (const [fullRoute] of cases) {
      assert.throws(() => egress.allowRequest({ method: 'GET', fullRoute }),
        (error) => error.code === 'TEST_UNKNOWN_READ_DENIED');
    }
    assert.deepEqual(warnings, cases.map(([, family]) =>
      `[TEST_CONTROL] code=TEST_EGRESS_GET_LOGIN_WAIT_READY_${family}_WS_GATEWAY ` +
      'operation=discord_rest_diagnostic'));
    const output = warnings.join('\n');
    for (const canary of canaries) assert.equal(output.includes(canary), false);
    assert.throws(() => egress.setDiagnosticPhase('not-a-phase'),
      (error) => error.code === 'TEST_DIAGNOSTIC_PHASE_INVALID');
  } finally { fixture.cleanup(); }
});

test('caller diagnostics use a closed known-caller list and never change denial', () => {
  const fixture = createFixture();
  try {
    const warnings = [];
    let stack = '';
    const policy = loadTestControlPolicy(fixture.env, {
      cwd: process.cwd(), logger: { warn: (value) => warnings.push(value) },
    });
    const egress = createTestControlEgress(policy, { captureStack: () => stack });
    egress.setDiagnosticPhase('ready_entry');
    const cases = [
      ['at WebSocketManager.fetchGatewayInformation (C:/x/node_modules/@discordjs/ws/dist/index.js:1:1)', 'WS_GATEWAY'],
      ['at ClientApplication.fetch (C:/x/structures/ClientApplication.js:1:1)', 'CLIENT_APPLICATION'],
      ['at GuildManager.fetch (C:/x/managers/GuildManager.js:1:1)', 'GUILD_MANAGER'],
      ['at ChannelManager.fetch (C:/x/managers/ChannelManager.js:1:1)', 'CHANNEL_MANAGER'],
      ['at UserManager.fetch (C:/x/managers/UserManager.js:1:1)', 'USER_MANAGER'],
      ['at preflightTestIdentity (C:/x/platform/testControlPolicy.js:1:1)', 'TEST_CONTROL_PREFLIGHT'],
      ['at PRIVATE_VALUE_CANARY (https://canary.invalid/private:1:1)', 'UNKNOWN'],
    ];
    for (const [syntheticStack] of cases) {
      stack = syntheticStack;
      assert.throws(() => egress.allowRequest({ method: 'GET', fullRoute: '/applications/@me' }),
        (error) => error.code === 'TEST_UNKNOWN_READ_DENIED');
    }
    assert.deepEqual(warnings, cases.map(([, caller]) =>
      `[TEST_CONTROL] code=TEST_EGRESS_GET_READY_ENTRY_CURRENT_APPLICATION_${caller} ` +
      'operation=discord_rest_diagnostic'));
    const output = warnings.join('\n');
    for (const value of ['PRIVATE_VALUE_CANARY', 'canary.invalid', 'ClientApplication.js', 'testControlPolicy.js']) {
      assert.equal(output.includes(value), false);
    }
  } finally { fixture.cleanup(); }
});

test('exact identity reads stay allowed while nearby reads remain denied', () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const egress = createTestControlEgress(policy, { captureStack: () => '' });
    for (const fullRoute of ['/oauth2/applications/@me', '/users/@me', '/users/%40me',
      `/guilds/${IDS.guild}`, `/channels/${IDS.channel}`]) {
      assert.equal(egress.allowRequest({ method: 'GET', fullRoute }), true);
    }
    for (const fullRoute of ['/applications/@me', '/users/@me/guilds', '/gateway/bot/extra',
      '/users/%40me?synthetic=1', '/users/%40me/extra', '/prefix/users/%40me', '/users/%2540me',
      '/oauth2/applications/@me?synthetic=1', 'https://discord.com/api/v10/gateway/bot',
      '/api/v10/gateway/bot', '/unknown/read']) {
      assert.throws(() => egress.allowRequest({ method: 'GET', fullRoute }),
        (error) => error.code === 'TEST_UNKNOWN_READ_DENIED');
    }
    for (const fullRoute of ['/oauth2/applications/@me', '/users/%40me']) {
      assert.throws(() => egress.allowRequest({ method: 'POST', fullRoute }),
        (error) => error.code === 'TEST_UNKNOWN_MUTATION_DENIED');
    }
    const forgedContext = createTestControlEgress(policy, {
      captureStack: () => 'at preflightTestIdentity (C:/x/platform/testControlPolicy.js:1:1)',
    });
    forgedContext.setDiagnosticPhase('runtime_preflight');
    assert.throws(() => forgedContext.allowRequest({ method: 'GET', fullRoute: '/users/%40me/extra' }),
      (error) => error.code === 'TEST_UNKNOWN_READ_DENIED');
  } finally { fixture.cleanup(); }
});

test('locked REST get reaches synthetic transport through the installed exact identity guard', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0 } });
    const rest = client.rest;
    const expectedRoutes = [
      Routes.oauth2CurrentApplication(),
      Routes.user('@me'),
      ...[...policy.allowedGuildIds].map((id) => Routes.guild(id)),
      ...[...policy.allowedChannelIds].map((id) => Routes.channel(id)),
    ];
    const transportRoutes = [];
    const response = (body) => new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
    createTestControlEgress(policy).install(rest);
    rest.queueRequest = async (options) => {
      transportRoutes.push(options.fullRoute);
      if (options.fullRoute.startsWith('/channels/')) {
        return response({ id: IDS.channel, guild_id: IDS.guild });
      }
      if (options.fullRoute.startsWith('/guilds/')) return response({ id: IDS.guild });
      return response({ id: IDS.app });
    };

    assert.equal(client.rest, rest);
    assert.equal(Routes.user('@me'), '/users/%40me');
    assert.equal(await preflightTestIdentity({
      policy, rest, configuredClientId: IDS.app, Routes,
    }), true);
    assert.deepEqual(transportRoutes, expectedRoutes);
  } finally { fixture.cleanup(); }
});

test('stopping rejects even formerly allowed reads before any new egress', () => {
  const fixture = createFixture();
  try {
    const warnings = [];
    const policy = loadTestControlPolicy(fixture.env, {
      cwd: process.cwd(), logger: { warn: (value) => warnings.push(value) },
    });
    const egress = createTestControlEgress(policy, { isStopping: () => true });
    assert.throws(() => egress.allowRequest({ method: 'GET', fullRoute: '/gateway/bot' }),
      (error) => error.code === 'TEST_STOPPING_EGRESS_DENIED');
    assert.deepEqual(warnings, [
      '[TEST_CONTROL] code=TEST_STOPPING_EGRESS_DENIED operation=discord_rest',
    ]);
  } finally { fixture.cleanup(); }
});

test('installed egress observes fixed lower REST failures and advances only after gateway REST success', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const phases = [];
    const failures = [];
    let mode = 'success';
    const rest = {
      async request() {
        if (mode === 'failure') throw new HTTPError(503, 'PRIVATE_CANARY', 'GET',
          'https://private.invalid', { files: [], body: null });
        return { ok: true };
      },
    };
    const egress = createTestControlEgress(policy, {
      startupDiagnostics: {
        currentPhase: () => 'LOGIN_REST',
        enterPhase: (phase) => phases.push(phase),
        reportFailure: (error) => failures.push(error),
      },
    });
    egress.install(rest);
    assert.deepEqual(await rest.request({ method: 'GET', fullRoute: '/gateway/bot' }), { ok: true });
    assert.deepEqual(phases, ['LOGIN_GATEWAY']);
    mode = 'failure';
    await assert.rejects(() => rest.request({ method: 'GET', fullRoute: `/guilds/${IDS.guild}` }));
    assert.equal(failures.length, 1);
    assert.equal(failures[0] instanceof HTTPError, true);
    assert.deepEqual(phases, ['LOGIN_GATEWAY']);
  } finally { fixture.cleanup(); }
});

test('installed egress reports an original unknown GET denial without reaching lower transport', async () => {
  const fixture = createFixture();
  try {
    const warnings = [];
    const failures = [];
    let lowerCalls = 0;
    const policy = loadTestControlPolicy(fixture.env, {
      cwd: process.cwd(), logger: { warn: (line) => warnings.push(line) },
    });
    const rest = { async request() { lowerCalls += 1; } };
    createTestControlEgress(policy, {
      captureStack: () => '',
      startupDiagnostics: { reportFailure: (error) => failures.push(error.code) },
    }).install(rest);
    await assert.rejects(() => rest.request({ method: 'GET', fullRoute: '/unknown/PRIVATE_CANARY' }),
      (error) => error.code === 'TEST_UNKNOWN_READ_DENIED');
    assert.equal(lowerCalls, 0);
    assert.deepEqual(failures, ['TEST_UNKNOWN_READ_DENIED']);
    assert.deepEqual(warnings, [
      '[TEST_CONTROL] code=TEST_EGRESS_GET_IDENTITY_PREFLIGHT_OTHER_UNKNOWN ' +
      'operation=discord_rest_diagnostic',
    ]);
    assert.equal(warnings.join('\n').includes('PRIVATE_CANARY'), false);
  } finally { fixture.cleanup(); }
});

const BACKSLASH = String.fromCharCode(92);
// IIS-style %uXXXX escapes for ".", "/" and "\", including a second encoding layer.
const IIS_UNICODE_ROUTES = Object.freeze([
  `/channels/${IDS.channel}/%u002e%u002e/${IDS.otherChannel}/messages`,
  `/channels/${IDS.channel}/%U002E%U002E/${IDS.otherChannel}/messages`,
  `/channels/${IDS.channel}%u002f..%u002f${IDS.otherChannel}/messages`,
  `/channels/${IDS.channel}%u005c..%u005c${IDS.otherChannel}/messages`,
  `/channels/${IDS.channel}/%25u002e%25u002e/${IDS.otherChannel}/messages`,
]);
// 5- and 6-byte overlong UTF-8 forms of "." and "/", including a second encoding layer.
const FIVE_AND_SIX_BYTE_OVERLONG_ROUTES = Object.freeze([
  `/channels/${IDS.channel}/%f8%80%80%80%ae%f8%80%80%80%ae/${IDS.otherChannel}/messages`,
  `/channels/${IDS.channel}/%fc%80%80%80%80%ae%fc%80%80%80%80%ae/${IDS.otherChannel}/messages`,
  `/channels/${IDS.channel}%f8%80%80%80%af..%f8%80%80%80%af${IDS.otherChannel}/messages`,
  `/channels/${IDS.channel}%FC%80%80%80%80%AF..%FC%80%80%80%80%AF${IDS.otherChannel}/messages`,
  `/channels/${IDS.channel}/%25fc%2580%2580%2580%2580%25ae%25fc%2580%2580%2580%2580%25ae/${IDS.otherChannel}/messages`,
]);

function nonCanonicalRoutes() {
  const allowedChannel = `/channels/${IDS.channel}`;
  const other = IDS.otherChannel;
  return [
    ['POST', `${allowedChannel}/../${other}/messages`],
    ['POST', `${allowedChannel}/messages/../../${other}/messages`],
    ['POST', `${allowedChannel}/./messages`],
    ['POST', `${allowedChannel}/%2e%2e/${other}/messages`],
    ['POST', `${allowedChannel}/%2E%2E/${other}/messages`],
    ['POST', `${allowedChannel}/.%2e/${other}/messages`],
    ['POST', `${allowedChannel}/%2e./${other}/messages`],
    ['POST', `${allowedChannel}/%2e/messages`],
    ['POST', `${allowedChannel}%2F..%2F${other}/messages`],
    ['POST', `${allowedChannel}%2f..%2f${other}/messages`],
    ['POST', `${allowedChannel}/messages%2Fx`],
    ['POST', `${allowedChannel}${BACKSLASH}..${BACKSLASH}${other}/messages`],
    ['POST', `${allowedChannel}/..${BACKSLASH}${other}/messages`],
    ['POST', `${allowedChannel}%5C..%5C${other}/messages`],
    ['POST', `${allowedChannel}%5c..%5c${other}/messages`],
    ['POST', `${allowedChannel}/%252e%252e/${other}/messages`],
    ['POST', `${allowedChannel}/%252E%252E/${other}/messages`],
    ['POST', `${allowedChannel}%252F..%252F${other}/messages`],
    ['POST', `${allowedChannel}%255C..%255C${other}/messages`],
    ['POST', `${allowedChannel}/%25252e%25252e/${other}/messages`],
    ['POST', `${allowedChannel}/%25%32%65%25%32%65/${other}/messages`],
    ['POST', `${allowedChannel}%25%32%66..%25%32%66${other}/messages`],
    ['POST', `${allowedChannel}/%c0%ae%c0%ae/${other}/messages`],
    ['POST', `${allowedChannel}%c0%af..%c0%af${other}/messages`],
    ['POST', `${allowedChannel}%c1%9c..%c1%9c${other}/messages`],
    ['POST', `${allowedChannel}/%e0%80%ae%e0%80%ae/${other}/messages`],
    ['POST', `${allowedChannel}/%f0%80%80%ae%f0%80%80%ae/${other}/messages`],
    ['POST', `${allowedChannel}/%25c0%25ae%25c0%25ae/${other}/messages`],
    ...IIS_UNICODE_ROUTES.map((fullRoute) => ['POST', fullRoute]),
    ...FIVE_AND_SIX_BYTE_OVERLONG_ROUTES.map((fullRoute) => ['POST', fullRoute]),
    ['PUT', `${allowedChannel}/messages/${IDS.interaction}/reactions/#/@me`],
    ['POST', `${allowedChannel}/.\t./${other}/messages`],
    ['POST', `${allowedChannel}/.\n./${other}/messages`],
    ['POST', `${allowedChannel}/.\r./${other}/messages`],
    ['POST', `${allowedChannel}#/../${other}/messages`],
    ['POST', `${allowedChannel}/messages?x=1#/../${other}`],
    ['GET', `/guilds/${IDS.guild}/../${IDS.otherGuild}`],
    ['GET', `/guilds/${IDS.guild}/%2e%2e/${IDS.otherGuild}/channels`],
    ['GET', `/users/${IDS.actor}/../${IDS.otherGuild}`],
    ['GET', '/gateway/bot/../../users/@me/guilds'],
    ['POST', `/interactions/${IDS.interaction}/synthetic-interaction-token/callback/../../../../channels/${other}/messages`],
    ['PATCH', `/webhooks/${IDS.app}/synthetic-interaction-token/../../../channels/${other}/messages/1`],
    ['PUT', `/applications/${IDS.app}/guilds/${IDS.guild}/commands/../../../commands`],
  ];
}

test('URL parsing used by the REST transport rewrites traversal routes to another target', () => {
  const base = 'https://discord.com/api/v10';
  const target = `/api/v10/channels/${IDS.otherChannel}/messages`;
  for (const fullRoute of [
    `/channels/${IDS.channel}/../${IDS.otherChannel}/messages`,
    `/channels/${IDS.channel}/%2e%2e/${IDS.otherChannel}/messages`,
    `/channels/${IDS.channel}/.%2E/${IDS.otherChannel}/messages`,
    `/channels/${IDS.channel}${BACKSLASH}..${BACKSLASH}${IDS.otherChannel}/messages`,
    `/channels/${IDS.channel}/.\t./${IDS.otherChannel}/messages`,
  ]) {
    assert.equal(new URL(`${base}${fullRoute}`).pathname, target, JSON.stringify(fullRoute));
  }
});

test('egress rejects every non-canonical route with one fixed code before any allow decision', () => {
  const fixture = createFixture();
  try {
    const warnings = [];
    const policy = loadTestControlPolicy(fixture.env, {
      cwd: process.cwd(), logger: { warn: (value) => warnings.push(value) },
    });
    const egress = createTestControlEgress(policy, { now: () => 1000, captureStack: () => '' });
    egress.bindInteraction({ id: IDS.interaction, token: 'synthetic-interaction-token', guildId: IDS.guild,
      channelId: IDS.channel, user: { id: IDS.actor } });
    for (const [method, fullRoute] of nonCanonicalRoutes()) {
      assert.throws(() => egress.allowRequest({ method, fullRoute }),
        (error) => error.code === 'TEST_ROUTE_NORMALIZATION_DENIED', JSON.stringify(fullRoute));
    }
    assert.deepEqual(warnings, ['[TEST_CONTROL] code=TEST_ROUTE_NORMALIZATION_DENIED operation=discord_rest']);
    assert.equal(policy.reporter.count('TEST_ROUTE_NORMALIZATION_DENIED', 'discord_rest'),
      nonCanonicalRoutes().length);
  } finally { fixture.cleanup(); }
});

test('canonical routes keep their previous allow and deny decisions', () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd(), logger: { warn() {} } });
    const egress = createTestControlEgress(policy, { now: () => 1000, captureStack: () => '' });
    egress.bindInteraction({ id: IDS.interaction, token: 'synthetic-interaction-token', guildId: IDS.guild,
      channelId: IDS.channel, user: { id: IDS.actor } });
    for (const [method, fullRoute] of [
      ['PUT', `/channels/${IDS.channel}/messages/${IDS.interaction}/reactions/%E2%9C%85/@me`],
      ['PUT', `/channels/${IDS.channel}/messages/${IDS.interaction}/reactions/%F0%9F%8E%89/@me`],
      ['PUT', `/channels/${IDS.channel}/messages/${IDS.interaction}/reactions/%E0%A4%85/@me`],
      ['PUT', `/channels/${IDS.channel}/messages/${IDS.interaction}/reactions/custom_name:${IDS.actor}/@me`],
      ['POST', `/channels/${IDS.channel}/messages?synthetic=1`],
      ['PATCH', `/webhooks/${IDS.app}/synthetic-interaction-token/messages/@original`],
      ['GET', '/users/%40me'],
    ]) {
      assert.equal(egress.allowRequest({ method, fullRoute }), true, fullRoute);
    }
    for (const [method, fullRoute, code] of [
      ['POST', `/channels/${IDS.otherChannel}/messages`, 'TEST_CHANNEL_EGRESS_DENIED'],
      ['GET', '/users/%2540me', 'TEST_UNKNOWN_READ_DENIED'],
      ['GET', '/channels..', 'TEST_UNKNOWN_READ_DENIED'],
      ['PUT', `/applications/${IDS.app}/commands`, 'TEST_GLOBAL_COMMAND_DENIED'],
    ]) {
      assert.throws(() => egress.allowRequest({ method, fullRoute }), (error) => error.code === code, fullRoute);
    }
  } finally { fixture.cleanup(); }
});

function createBoundEgress() {
  const fixture = createFixture();
  const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd(), logger: { warn() {} } });
  const egress = createTestControlEgress(policy, { now: () => 1000, captureStack: () => '' });
  return { fixture, egress };
}

test('an encoded keycap number-sign reaction is allowed while a raw # stays denied', () => {
  const { fixture, egress } = createBoundEgress();
  try {
    const keycap = encodeURIComponent(String.fromCodePoint(0x23, 0xFE0F, 0x20E3));
    assert.equal(keycap, '%23%EF%B8%8F%E2%83%A3');
    const reaction = `/channels/${IDS.channel}/messages/${IDS.interaction}/reactions/${keycap}/@me`;
    assert.equal(egress.allowRequest({ method: 'PUT', fullRoute: reaction }), true);
    assert.equal(egress.allowRequest({ method: 'DELETE', fullRoute: reaction }), true);
    for (const fullRoute of [
      `/channels/${IDS.channel}/messages/${IDS.interaction}/reactions/#/@me`,
      `/channels/${IDS.channel}/messages#fragment`,
      `/channels/${IDS.channel}/messages?after=1#fragment`,
    ]) {
      assert.throws(() => egress.allowRequest({ method: 'PUT', fullRoute }),
        (error) => error.code === 'TEST_ROUTE_NORMALIZATION_DENIED', fullRoute);
    }
  } finally { fixture.cleanup(); }
});

test('IIS-style %uXXXX escapes are denied even though URL parsing keeps them', () => {
  const { fixture, egress } = createBoundEgress();
  try {
    for (const fullRoute of IIS_UNICODE_ROUTES) {
      assert.equal(new URL(`https://discord.com/api/v10${fullRoute}`).pathname, `/api/v10${fullRoute}`);
      assert.throws(() => egress.allowRequest({ method: 'POST', fullRoute }),
        (error) => error.code === 'TEST_ROUTE_NORMALIZATION_DENIED', fullRoute);
    }
  } finally { fixture.cleanup(); }
});

test('5- and 6-byte overlong UTF-8 forms are denied while valid multibyte emoji stay allowed', () => {
  const { fixture, egress } = createBoundEgress();
  try {
    for (const fullRoute of FIVE_AND_SIX_BYTE_OVERLONG_ROUTES) {
      assert.throws(() => egress.allowRequest({ method: 'POST', fullRoute }),
        (error) => error.code === 'TEST_ROUTE_NORMALIZATION_DENIED', fullRoute);
    }
    for (const emoji of ['%F0%9F%8E%89', '%F4%8F%BF%BF', '%EF%B8%8F']) {
      assert.equal(egress.allowRequest({ method: 'PUT',
        fullRoute: `/channels/${IDS.channel}/messages/${IDS.interaction}/reactions/${emoji}/@me` }), true, emoji);
    }
  } finally { fixture.cleanup(); }
});

test('installed egress stops non-canonical routes before the real REST transport builds a request', async () => {
  const fixture = createFixture();
  try {
    const failures = [];
    const urls = [];
    const makeRequest = async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify({ id: IDS.interaction }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    };
    const traversal = `/channels/${IDS.channel}/%2e%2e/${IDS.otherChannel}/messages`;
    const unguarded = new REST({ retries: 0, makeRequest }).setToken('synthetic-token');
    await unguarded.post(traversal, { body: {} });
    assert.equal(new URL(urls[0]).pathname, `/api/v10/channels/${IDS.otherChannel}/messages`);

    urls.length = 0;
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd(), logger: { warn() {} } });
    const rest = new REST({ retries: 0, makeRequest }).setToken('synthetic-token');
    createTestControlEgress(policy, {
      startupDiagnostics: { reportFailure: (error) => failures.push(error.code) },
    }).install(rest);
    for (const [method, fullRoute] of nonCanonicalRoutes()) {
      await assert.rejects(() => rest.request({ method, fullRoute, body: {} }),
        (error) => error.code === 'TEST_ROUTE_NORMALIZATION_DENIED', JSON.stringify(fullRoute));
    }
    assert.deepEqual(urls, []);
    assert.equal(failures.length, nonCanonicalRoutes().length);
    assert.equal(failures.every((code) => code === 'TEST_ROUTE_NORMALIZATION_DENIED'), true);
    await rest.post(`/channels/${IDS.channel}/messages`, { body: {} });
    assert.deepEqual(urls.map((url) => new URL(url).pathname), [`/api/v10/channels/${IDS.channel}/messages`]);
  } finally { fixture.cleanup(); }
});

test('gateway REST 401 defers to the trusted Discord TokenInvalid classification', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const lines = [];
    const diagnostics = createTestControlStartupDiagnostics({
      active: true,
      stderr: { write: (line) => lines.push(String(line).trim()) },
    });
    diagnostics.configureTrustedTypes({
      DiscordjsError,
      HTTPError,
      tokenInvalidCode: DiscordjsErrorCodes.TokenInvalid,
    });
    diagnostics.enterPhase('LOGIN_REST');
    const rest = {
      async request() {
        throw new HTTPError(401, 'PRIVATE_CANARY', 'GET', 'https://private.invalid',
          { files: [], body: null });
      },
    };
    createTestControlEgress(policy, { startupDiagnostics: diagnostics }).install(rest);
    await assert.rejects(() => rest.request({ method: 'GET', fullRoute: '/gateway/bot' }));
    assert.equal(diagnostics.firstFailure(), null);
    diagnostics.reportFailure(new DiscordjsError(DiscordjsErrorCodes.TokenInvalid));
    assert.equal(diagnostics.firstFailure(), 'TEST_STARTUP_LOGIN_TOKEN_INVALID');
    assert.equal(lines.at(-1),
      '[TEST_CONTROL] code=TEST_STARTUP_LOGIN_TOKEN_INVALID operation=startup_diagnostic');
    assert.equal(lines.join('\n').includes('PRIVATE_CANARY'), false);
    assert.equal(lines.join('\n').includes('private.invalid'), false);
  } finally { fixture.cleanup(); }
});

test('in the order the bot installs them, test-control, the egress guard and protected delivery still reach the transport',
  async () => {
    const fixture = createFixture();
    try {
      const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
      // A synthetic egress hook that forwards a copy of each request, as the live-test one does.
      globalThis[SYNTHETIC_EGRESS_SYMBOL] = Object.freeze({ active: true, dataRoot: policy.dataRoot,
        expectedApplicationId: policy.expectedApplicationId,
        prepareRequest: (options) => Object.freeze({ virtual: false, options: { ...options } }),
      });
      const sent = [];
      const rest = new REST({
        retries: 0,
        async makeRequest(url, init) {
          sent.push([init.method, url]);
          return new Response(JSON.stringify({ id: '999999999999999999' }), {
            status: 200, headers: { 'content-type': 'application/json' },
          });
        },
      }).setToken('synthetic-token');
      createTestControlEgress(policy).install(rest);
      installEgressGuard(rest, { approvedReleaseTag: 'v1.1.2' });
      const channel = installProtectedRest(rest);
      const route = `/channels/${IDS.channel}/messages`;
      await rest.post(route, { body: { content: 'reply' } });
      const outcome = await channel.send({ method: 'POST', fullRoute: route, body: { content: 'notice' } }, { deadlineMs: 5_000 });
      assert.equal(outcome.kind, 'confirmed');
      await assert.rejects(() => rest.queueRequest({ method: 'POST', fullRoute: route, body: { content: 'unchecked' } }), TypeError);
      const url = `https://discord.com/api/v10${route}`;
      assert.deepEqual(sent, [['POST', url], ['POST', url]]);
    } finally {
      delete globalThis[SYNTHETIC_EGRESS_SYMBOL];
      fixture.cleanup();
    }
  });

// Threads the test bot opens in an allowed channel (/student) are in scope for the rest of the run; nothing else is.
const THREAD = '999999999999999991';
const OTHER_THREAD = '999999999999999992';

function threadFixture() {
  const fixture = createFixture({ XIAOJI_TEST_ALLOWED_MESSAGE_FEATURES: 'word_chain' });
  const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
  const answers = [];
  const rest = { request: async () => answers.shift() };
  createTestControlEgress(policy).install(rest);
  return { fixture, policy, rest, answers };
}

test('a thread the test bot opens in an allowed channel joins the scope for egress and ingress', async () => {
  const { fixture, policy, rest, answers } = threadFixture();
  try {
    const { authorizeMessage } = require('../src/platform/testControlIngress');
    assert.throws(() => createTestControlEgress(policy).allowRequest({ method: 'POST', fullRoute: `/channels/${THREAD}/messages` }),
      (error) => error.code === 'TEST_CHANNEL_EGRESS_DENIED');
    answers.push({ id: THREAD, parent_id: IDS.channel, guild_id: IDS.guild, owner_id: IDS.app, type: 11 });
    await rest.request({ method: 'POST', fullRoute: `/channels/${IDS.channel}/messages/${IDS.interaction}/threads` });
    assert.equal(policy.allowsChannel(THREAD), true);
    assert.equal(createTestControlEgress(policy).allowRequest({ method: 'POST', fullRoute: `/channels/${THREAD}/messages` }), true);
    const client = { testControlPolicy: policy, user: { id: IDS.app } };
    assert.equal(authorizeMessage({ client, guildId: IDS.guild, channelId: THREAD, author: { id: IDS.actor },
      mentions: { has: () => false } }).allowed, true);
    // A thread opened on its own (no starter message) is recorded the same way.
    answers.push({ id: OTHER_THREAD, parent_id: IDS.channel, guild_id: IDS.guild, owner_id: IDS.app, type: 11 });
    await rest.request({ method: 'POST', fullRoute: `/channels/${IDS.channel}/threads` });
    assert.equal(policy.allowsChannel(OTHER_THREAD), true);
  } finally { fixture.cleanup(); }
});

test('a thread someone else owns, a parent that does not match, or a read of a thread object stays out of scope', async () => {
  const { fixture, policy, rest, answers } = threadFixture();
  try {
    answers.push({ id: THREAD, parent_id: IDS.channel, guild_id: IDS.guild, owner_id: IDS.actor });
    await rest.request({ method: 'POST', fullRoute: `/channels/${IDS.channel}/threads` });
    answers.push({ id: THREAD, parent_id: IDS.otherChannel, guild_id: IDS.guild, owner_id: IDS.app });
    await rest.request({ method: 'POST', fullRoute: `/channels/${IDS.channel}/threads` });
    answers.push({ id: THREAD, parent_id: IDS.channel, guild_id: IDS.otherGuild, owner_id: IDS.app });
    await rest.request({ method: 'POST', fullRoute: `/channels/${IDS.channel}/threads` });
    answers.push({ id: THREAD, parent_id: IDS.channel, guild_id: IDS.guild, owner_id: IDS.app });
    await rest.request({ method: 'GET', fullRoute: `/channels/${IDS.channel}/threads` }).catch(() => {});
    assert.equal(policy.allowsChannel(THREAD), false);
    // A thread in a channel that is not allowed is refused before any request.
    await assert.rejects(rest.request({ method: 'POST', fullRoute: `/channels/${IDS.otherChannel}/threads` }),
      (error) => error.code === 'TEST_CHANNEL_EGRESS_DENIED');
    // A thread of a thread is not a thread of an allowed channel.
    answers.push({ id: OTHER_THREAD, parent_id: THREAD, guild_id: IDS.guild, owner_id: IDS.app });
    await rest.request({ method: 'POST', fullRoute: `/channels/${IDS.channel}/threads` });
    assert.equal(policy.allowsChannel(OTHER_THREAD), false);
  } finally { fixture.cleanup(); }
});

test('only the first test egress can add own threads, and the policy object itself cannot', () => {
  const fixture = createFixture();
  try {
    const { claimOwnThreadRecorder } = require('../src/platform/testControlPolicy');
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    assert.equal('rememberOwnThread' in policy, false);
    createTestControlEgress(policy);
    assert.equal(claimOwnThreadRecorder(policy), null);
  } finally { fixture.cleanup(); }
});

test('one run keeps at most 50 own threads, and a new thread past that is refused before Discord opens it', () => {
  const fixture = createFixture();
  try {
    const { claimOwnThreadRecorder } = require('../src/platform/testControlPolicy');
    const warnings = [];
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd(), logger: { warn: (value) => warnings.push(value) } });
    const record = claimOwnThreadRecorder(policy);
    const id = (index) => String(900000000000000000n + BigInt(index));
    for (let index = 0; index < 50; index += 1) {
      assert.equal(record({ threadId: id(index), parentId: IDS.channel, guildId: IDS.guild, ownerId: IDS.app }), true);
    }
    assert.equal(record({ threadId: id(50), parentId: IDS.channel, guildId: IDS.guild, ownerId: IDS.app }), false);
    assert.equal(policy.allowsChannel(id(50)), false);
    assert.ok(warnings.some((line) => line.includes('TEST_OWN_THREAD_LIMIT')));
    // Recording one that is already in scope again is fine.
    assert.equal(record({ threadId: id(0), parentId: IDS.channel, guildId: IDS.guild, ownerId: IDS.app }), true);
    const egress = createTestControlEgress(policy);
    assert.throws(() => egress.allowRequest({ method: 'POST', fullRoute: `/channels/${IDS.channel}/threads` }),
      (error) => error.code === 'TEST_OWN_THREAD_LIMIT');
    assert.equal(egress.allowRequest({ method: 'POST', fullRoute: `/channels/${IDS.channel}/messages` }), true);
  } finally { fixture.cleanup(); }
});
