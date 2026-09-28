const test = require('node:test');
const assert = require('node:assert/strict');
const { Routes } = require('discord.js');
const { buildDeploymentPlan, deployCommands, parseDeploymentArgs, shouldAutoDeployCommands } = require('../deploy-commands');
const { createExtensionHost } = require('../src/extensions/extensionHost');

test('AUTO_DEPLOY_COMMANDS accepts only explicit enabled values', () => {
  for (const value of ['true', 'TRUE', ' true ']) assert.equal(shouldAutoDeployCommands({ AUTO_DEPLOY_COMMANDS: value }), true);
  for (const value of [undefined, '', '0', '1', 'false', 'yes', 'on']) {
    assert.equal(shouldAutoDeployCommands({ AUTO_DEPLOY_COMMANDS: value }), false);
  }
});

test('public-only CLI mode is explicit and rejects unknown arguments', () => {
  assert.deepEqual(parseDeploymentArgs([]), { publicOnly: false });
  assert.deepEqual(parseDeploymentArgs(['--public-only']), { publicOnly: true });
  assert.throws(() => parseDeploymentArgs(['--public-only', '--cleanup']), /Usage/);
});

test('explicit public-only deployment registers all games subcommands globally without loading private scope', async () => {
  const calls = [];
  const privatePath = process.env.XIAOJI_PRIVATE_EXTENSION_PATH;
  process.env.XIAOJI_PRIVATE_EXTENSION_PATH = 'synthetic-invalid-private-extension';
  try {
    const result = await deployCommands({
      publicOnly: true,
      token: 'synthetic-token',
      clientId: 'client-1',
      extensionHost: { getCommandDirectories() { throw new Error('private commands were loaded'); },
        getDeploymentTargets() { throw new Error('private targets were loaded'); } },
      rest: { get() { throw new Error('guild readback was attempted'); },
        async put(route, options) { calls.push({ route, body: options.body }); } },
    });
    assert.equal(result.publicOnly, true);
    assert.equal(result.privateCommandCount, 0);
    assert.equal(result.privateGuildCount, 0);
    assert.equal(result.cleanupCount, 0);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].route, Routes.applicationCommands('client-1'));
    const games = calls[0].body.find((command) => command.name === 'games');
    assert.ok(games);
    assert.deepEqual(games.options.map((option) => option.name), ['menu', 'resume', 'play']);
    assert.match(games.options.find((option) => option.name === 'play').description, /Discord/);
    await assert.rejects(deployCommands({ publicOnly: true, clientId: 'client-1', token: 'synthetic-token',
      cleanupGuildIds: ['synthetic-guild'], rest: { put() { throw new Error('must not mutate'); } } }), /cannot clean up guild/);
  } finally {
    if (privatePath === undefined) delete process.env.XIAOJI_PRIVATE_EXTENSION_PATH;
    else process.env.XIAOJI_PRIVATE_EXTENSION_PATH = privatePath;
  }
});

test('public-only deployment updates the global route and never requires a guild', async () => {
  const calls = [];
  const result = await deployCommands({
    token: 'synthetic-token',
    clientId: 'client-1',
    rest: { put: async (route, options) => calls.push({ route, body: options.body }) },
    extensionHost: createExtensionHost(),
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].route, Routes.applicationCommands('client-1'));
  assert.equal(calls[0].body.some((command) => command.name === 'set-welcome'), true);
  assert.equal(result.privateCommandCount, 0);
  assert.equal(result.privateGuildCount, 0);
});

test('dry run returns the deployment plan without touching REST', async () => {
  const result = await deployCommands({ clientId: 'client-1', dryRun: true, extensionHost: createExtensionHost() });
  assert.equal(result.dryRun, true);
  assert.equal(result.plan.length, 1);
  assert.equal(result.plan[0].kind, 'public-global');
});

test('legacy cleanup verifies this bot readback before any command mutation', async () => {
  const puts = [];
  const extensionHost = {
    getCommandDirectories: () => [],
    getDeploymentTargets: () => [{
      extensionId: 'legacy-extension',
      guildIds: [],
      cleanupGuildIds: ['legacy-guild'],
    }],
  };

  await assert.rejects(
    deployCommands({
      token: 'synthetic-token',
      clientId: 'client-1',
      extensionHost,
      rest: {
        get: async () => [{ id: 'foreign-command', application_id: 'another-client', name: 'legacy' }],
        put: async (route, options) => puts.push({ route, body: options.body }),
      },
    }),
    /does not belong to this bot/,
  );
  assert.deepEqual(puts, []);
});

test('legacy cleanup skips empty readback and never clears a currently scoped guild', async () => {
  const puts = [];
  const extensionHost = {
    getCommandDirectories: () => [],
    getDeploymentTargets: () => [{
      extensionId: 'scoped-extension',
      guildIds: [],
      cleanupGuildIds: ['empty-legacy-guild'],
    }],
  };
  const result = await deployCommands({
    token: 'synthetic-token',
    clientId: 'client-1',
    extensionHost,
    rest: {
      get: async () => [],
      put: async (route, options) => puts.push({ route, body: options.body }),
    },
  });
  assert.equal(result.cleanupCount, 1);
  assert.equal(puts.some((call) => call.route === Routes.applicationGuildCommands('client-1', 'empty-legacy-guild')), false);

  const plan = buildDeploymentPlan({
    clientId: 'client-1',
    publicCommands: [],
    privateCommandGroups: [{ guildIds: ['active-guild'], commands: [{ name: 'private-one' }] }],
    deploymentTargets: [{ guildIds: ['active-guild'], cleanupGuildIds: ['active-guild'] }],
    cleanupGuildIds: ['active-guild'],
  });
  assert.equal(plan.some((operation) => operation.kind === 'legacy-cleanup'), false);
});
