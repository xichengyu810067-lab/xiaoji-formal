require('dotenv').config({ quiet: true });

const { Client, GatewayIntentBits } = require('discord.js');
const { deployCommands, shouldAutoDeployCommands } = require('../deploy-commands');
const { loadCommands } = require('./loadCommands');
const { loadPrivateExtensionHost } = require('./extensions/extensionHost');
const { configureBoardRuntime } = require('./games/boardRuntimeRegistry');
const { createBoardDiscordRuntime } = require('./games/discord/boardDiscordRuntime');
const { registerEvents } = require('./handlers/registerEvents');
const { getBotOwnerId, getDiscordToken, requireEnvValue } = require('./utils/env');
const logger = require('./utils/logger');
const { stopPublicStatusServer } = require('./services/publicStatusServer');
const { stopStatusSnapshotPublisher } = require('./services/statusSnapshotPublisher');
const { stopGameServer } = require('./services/gameServer');

const token = getDiscordToken();
const ownerId = getBotOwnerId();
const extensionHost = loadPrivateExtensionHost();

requireEnvValue('DISCORD_TOKEN', token);
requireEnvValue('BOT_OWNER_ID', ownerId, ['OWNER_ID']);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.MessageContent,
  ],
});

const boardRuntime = configureBoardRuntime(createBoardDiscordRuntime({
  client,
  privateCorpusRoot: process.env.TURTLE_SOUP_CORPUS_ROOT || null,
}));

client.extensionHost = extensionHost;
client.boardRuntime = boardRuntime;
client.commands = loadCommands(undefined, { extensionHost });
registerEvents(client);

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection', reason);
});

process.on('uncaughtException', (error) => {
  logger.error('Uncaught exception', error);
  process.exitCode = 1;
});

let shutdownStarted = false;
async function shutdown(signal) {
  if (shutdownStarted) return;
  shutdownStarted = true;
  logger.info(`收到 ${signal}，正在關閉小吉。`);
  await boardRuntime.stopLifecycle();
  await extensionHost.runHook('shutdown', { client, signal });
  await stopGameServer().catch(() => {
    logger.warn('[GAME_SERVER] Server shutdown failed.');
  });
  await stopPublicStatusServer().catch(() => {
    logger.warn('[PUBLIC_STATUS] Server shutdown failed.');
  });
  stopStatusSnapshotPublisher();
  client.destroy();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

async function start() {
  if (shouldAutoDeployCommands()) {
    logger.info('AUTO_DEPLOY_COMMANDS 已啟用，登入前部署 Slash Commands。');
    await deployCommands({ extensionHost });
  }

  await client.login(token);
}

start().catch((error) => {
  logger.error('小吉啟動失敗。', error);
  process.exitCode = 1;
});
