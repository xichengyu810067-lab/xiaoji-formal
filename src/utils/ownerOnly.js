const logger = require('./logger');
const { getBotOwnerId } = require('./env');

const OWNER_DENIED_MESSAGE = '你沒有權限使用這個指令。';

function isBotOwner(userId) {
  const ownerId = getBotOwnerId();
  if (!ownerId || !userId) {
    return false;
  }
  return String(userId).trim() === ownerId;
}

async function ensureBotOwner(interaction) {
  if (isBotOwner(interaction.user?.id)) {
    return true;
  }

  logger.warn(`[PERMISSION_BLOCK] User ${interaction.user.tag} (${interaction.user.id}) denied access to owner-only command /${interaction.commandName}`);
  const payload = { content: OWNER_DENIED_MESSAGE, ephemeral: true };

  if (interaction.replied || interaction.deferred) {
    await interaction.followUp(payload);
  } else {
    await interaction.reply(payload);
  }

  return false;
}

module.exports = {
  OWNER_DENIED_MESSAGE,
  ensureBotOwner,
  getBotOwnerId,
  isBotOwner,
};
