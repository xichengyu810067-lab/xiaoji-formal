const test = require('node:test');
const assert = require('node:assert/strict');
const { Routes } = require('discord.js');
const { buildDeploymentPlan, deployCommands, shouldAutoDeployCommands } = require('../deploy-commands');
const { createExtensionHost } = require('../src/extensions/extensionHost');

test('AUTO_DEPLOY_COMMANDS accepts only explicit enabled values', () => {
  for (const value of ['true', 'TRUE', ' true ']) assert.equal(shouldAutoDeployCommands({ AUTO_DEPLOY_COMMANDS: value }), true);
  for (const value of [undefined, '', '0', '1', 'false', 'yes', 'on']) {
    assert.equal(shouldAutoDeployCommands({ AUTO_DEPLOY_COMMANDS: value }), false);
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
