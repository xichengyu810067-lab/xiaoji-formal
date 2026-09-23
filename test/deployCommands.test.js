const test = require('node:test');
const assert = require('node:assert/strict');
const { Routes } = require('discord.js');
const { deployCommands, shouldAutoDeployCommands } = require('../deploy-commands');
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
