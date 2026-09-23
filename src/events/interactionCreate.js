const { Events } = require('discord.js');
const { handleBlackjackButton } = require('../services/casinoService');
const { handlePollButton } = require('../services/pollService');
const { replyEphemeral } = require('../utils/moderation');
const { isGuildApproved } = require('../services/auditService');
const { isBotOwner } = require('../utils/ownerOnly');
const { recordPublicInteraction } = require('../services/publicStatusService');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');
const { getBoardRuntime } = require('../games/boardRuntimeRegistry');

const AUDIT_PENDING_MESSAGE = '小吉在這個伺服器尚未通過機器人擁有者的審核，暫時無法提供服務。請耐心等待批准。';

module.exports = {
  name: Events.InteractionCreate,

  async execute(interaction) {
    const extensionHost = getClientExtensionHost(interaction.client);
    const extensionGuard = await extensionHost.guardInteraction({
      interaction,
      commandName: interaction.commandName || null,
    });
    if (extensionGuard.handled) return;

    const extensionResult = await extensionHost.runHook('interactionCreate', { interaction }, { stopOnHandled: true });
    if (extensionResult.some((item) => item.result?.handled)) return;

    const isOwner = isBotOwner(interaction.user.id);

    if (interaction.guildId && !isOwner && !isGuildApproved(interaction.guildId)) {
      await replyEphemeral(interaction, AUDIT_PENDING_MESSAGE);
      return;
    }

    if ((interaction.isButton() || interaction.isModalSubmit()) && interaction.customId?.startsWith('board|')) {
      await getBoardRuntime().handleInteraction(interaction);
      await recordPublicInteraction();
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('casino:blackjack:')) {
      try {
        await handleBlackjackButton(interaction);
        await recordPublicInteraction();
      } catch (error) {
        logger.error('blackjack button handling failed', error);
        await replyEphemeral(interaction, '21點處理失敗，請稍後再試。');
      }
      return;
    }

    if (interaction.isButton() && interaction.customId.startsWith('poll:')) {
      try {
        await handlePollButton(interaction);
        await recordPublicInteraction();
      } catch (error) {
        logger.error('poll button handling failed', error);
        await replyEphemeral(interaction, '投票處理失敗，請稍後再試。');
      }
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = interaction.client.commands.get(interaction.commandName);

    if (!command) {
      await replyEphemeral(interaction, '找不到這個指令，請重新部署 slash commands。');
      return;
    }

    try {
      logger.info(`[COMMAND_REPLY] executing /${interaction.commandName}`);
      await command.execute(interaction);
      await recordPublicInteraction();
    } catch (error) {
      logger.error(`/${interaction.commandName} failed`, error);
      await replyEphemeral(interaction, '指令執行失敗，請稍後再試。');
    }
  },
};
