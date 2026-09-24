require('dotenv').config({ quiet: true });

const { REST, Routes } = require('discord.js');
const { loadCommandData, loadPrivateCommandGroups } = require('./src/loadCommands');
const { loadPrivateExtensionHost } = require('./src/extensions/extensionHost');
const { getDiscordClientId, getDiscordToken, requireEnvValue } = require('./src/utils/env');

function shouldAutoDeployCommands(env = process.env) {
  return String(env.AUTO_DEPLOY_COMMANDS || '').trim().toLowerCase() === 'true';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildDeploymentPlan({
  clientId,
  publicCommands,
  privateCommands = [],
  privateCommandGroups = [],
  deploymentTargets,
  cleanupGuildIds = [],
}) {
  const groups = privateCommandGroups.length > 0
    ? privateCommandGroups
    : [{
        commandGroupId: 'legacy-private',
        guildIds: unique(deploymentTargets.flatMap((target) => target.guildIds)),
        commands: privateCommands,
      }];
  const commandsByGuild = new Map();
  for (const group of groups) {
    for (const guildId of unique(group.guildIds)) {
      if (!commandsByGuild.has(guildId)) commandsByGuild.set(guildId, new Map());
      const guildCommands = commandsByGuild.get(guildId);
      for (const command of group.commands || []) {
        if (guildCommands.has(command.name)) {
          throw new Error(`Multiple private command groups register /${command.name} in guild ${guildId}.`);
        }
        guildCommands.set(command.name, command);
      }
    }
  }
  const allowedGuildIds = [...commandsByGuild.keys()];
  const requestedCleanup = unique([
    ...cleanupGuildIds,
    ...deploymentTargets.flatMap((target) => target.cleanupGuildIds),
  ]).filter((guildId) => !allowedGuildIds.includes(guildId));

  return [
    { kind: 'public-global', route: Routes.applicationCommands(clientId), body: publicCommands },
    ...allowedGuildIds.map((guildId) => ({
      kind: 'private-guild',
      guildId,
      route: Routes.applicationGuildCommands(clientId, guildId),
      body: [...commandsByGuild.get(guildId).values()],
    })),
    ...requestedCleanup.map((guildId) => ({
      kind: 'legacy-cleanup',
      guildId,
      route: Routes.applicationGuildCommands(clientId, guildId),
      body: [],
      requiresReadback: true,
    })),
  ];
}

function assertCleanupReadback(commands, clientId, guildId) {
  if (!Array.isArray(commands)) {
    throw new Error(`Legacy cleanup readback is invalid for guild ${guildId}.`);
  }
  for (const command of commands) {
    if (String(command?.application_id || '') !== String(clientId)) {
      throw new Error(`Legacy cleanup readback does not belong to this bot in guild ${guildId}.`);
    }
  }
  return commands;
}

async function deployCommands({
  token = getDiscordToken(),
  clientId = getDiscordClientId(),
  rest,
  extensionHost = loadPrivateExtensionHost(),
  cleanupGuildIds = [],
  dryRun = false,
} = {}) {
  requireEnvValue('DISCORD_CLIENT_ID', clientId, ['CLIENT_ID']);
  if (!dryRun && !rest) requireEnvValue('DISCORD_TOKEN', token);

  const publicCommands = loadCommandData(undefined, { scope: 'public', extensionHost });
  const privateCommandGroups = loadPrivateCommandGroups(extensionHost);
  const privateCommands = privateCommandGroups.flatMap((group) => group.commands);
  const deploymentTargets = extensionHost.getDeploymentTargets();
  const plan = buildDeploymentPlan({
    clientId,
    publicCommands,
    privateCommands,
    privateCommandGroups,
    deploymentTargets,
    cleanupGuildIds,
  });

  if (!dryRun) {
    const restClient = rest || new REST({ version: '10' }).setToken(token);
    const cleanupReadbacks = new Map();
    for (const operation of plan.filter((item) => item.kind === 'legacy-cleanup')) {
      if (typeof restClient.get !== 'function') {
        throw new Error('Legacy cleanup requires Discord command readback before mutation.');
      }
      cleanupReadbacks.set(
        operation.guildId,
        assertCleanupReadback(await restClient.get(operation.route), clientId, operation.guildId),
      );
    }
    for (const operation of plan) {
      if (operation.kind === 'legacy-cleanup' && cleanupReadbacks.get(operation.guildId).length === 0) continue;
      await restClient.put(operation.route, { body: operation.body });
    }
  }

  return {
    dryRun,
    globalCount: publicCommands.length,
    privateCommandCount: privateCommands.length,
    privateGuildCount: plan.filter((item) => item.kind === 'private-guild').length,
    cleanupCount: plan.filter((item) => item.kind === 'legacy-cleanup').length,
    plan,
  };
}

if (require.main === module) {
  deployCommands().then((result) => {
    console.log(`Slash commands deployed: ${result.globalCount} public, ${result.privateCommandCount} private.`);
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}

module.exports = {
  buildDeploymentPlan,
  assertCleanupReadback,
  deployCommands,
  shouldAutoDeployCommands,
};
