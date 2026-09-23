const { Events } = require('discord.js');
const { handleMentionMessage, isPublicPersistenceSuppressed } = require('../services/mentionService');
const { routeMessageFeatures } = require('../services/messageFeatureRouter');
const { recordPublicMessage } = require('../services/memoryService');
const { isGuildApproved } = require('../services/auditService');
const { isBotOwner } = require('../utils/ownerOnly');
const { recordPublicInteraction } = require('../services/publicStatusService');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');

module.exports = {
  name: Events.MessageCreate,

  async execute(message) {
    if (
      !message?.author ||
      message.author.bot ||
      message.author.id === message.client.user?.id ||
      message.webhookId ||
      message.system
    ) {
      return;
    }

    // Audit Check
    if (message.guildId && !isBotOwner(message.author.id)) {
      if (!isGuildApproved(message.guildId)) {
        // Only reply if mentioned to avoid spam
        if (message.mentions.has(message.client.user.id)) {
          await message.reply('小吉在這個伺服器尚未通過機器人擁有者的審核，暫時無法提供服務。請耐心等待批准。');
        }
        return;
      }
    }

    try {
      const extensionResults = await getClientExtensionHost(message.client).runHook(
        'messageCreate',
        { message },
        { stopOnHandled: true }
      );
      if (extensionResults.some((item) => item.result?.handled)) return;
    } catch (error) {
      logger.error('private message hook failed', error);
    }

    try {
      const featureResult = await routeMessageFeatures(message);
      if (featureResult.handled) {
        await recordPublicInteraction();
        return;
      }
    } catch (error) {
      logger.error('message feature routing failed', error);
    }

    let mentionResult;
    try {
      mentionResult = await handleMentionMessage(message);
    } catch (error) {
      logger.error('mention message handling failed', error);
    }

    if (isPublicPersistenceSuppressed(mentionResult)) return;

    try {
      recordPublicMessage(message);
    } catch (error) {
      logger.error('public memory recording failed', error);
    }
  },
};
