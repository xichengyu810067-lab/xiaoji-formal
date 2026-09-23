require('dotenv').config({ quiet: true });

const { REST, Routes } = require('discord.js');
const { loadCommandData } = require('./src/loadCommands');
const { loadPrivateExtensionHost } = require('./src/extensions/extensionHost');
const { getDiscordClientId, getDiscordToken, requireEnvValue } = require('./src/utils/env');

function shouldAutoDeployCommands(env = process.env) {
  return String(env.AUTO_DEPLOY_COMMANDS || '').trim().toLowerCase() === 'true';
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function buildDeploymentPlan({ clientId, publicCommands, privateCommands, deploymentTargets, cleanupGuildIds = [] }) {
  const allowedGuildIds = unique(deploymentTargets.flatMap((target) => target.guildIds));
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
      body: privateCommands,
    })),
    ...requestedCleanup.map((guildId) => ({
      kind: 'legacy-cleanup',
      guildId,
      route: Routes.applicationGuildCommands(clientId, guildId),
      body: [],
    })),
  ];
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
  const privateCommands = loadCommandData(undefined, { scope: 'private', extensionHost });
  const deploymentTargets = extensionHost.getDeploymentTargets();
  const plan = buildDeploymentPlan({ clientId, publicCommands, privateCommands, deploymentTargets, cleanupGuildIds });

  if (!dryRun) {
    const restClient = rest || new REST({ version: '10' }).setToken(token);
    for (const operation of plan) await restClient.put(operation.route, { body: operation.body });
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
  deployCommands,
  shouldAutoDeployCommands,
};
