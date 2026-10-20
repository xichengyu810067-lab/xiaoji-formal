const { Events } = require('discord.js');
const { handleBlackjackButton } = require('../services/casinoService');
const { handlePollButton } = require('../services/pollService');
const { replyEphemeral } = require('../utils/moderation');
const { recordPublicInteraction } = require('../services/publicStatusService');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');
const { getBoardRuntime } = require('../systems/games/board/core/boardRuntimeRegistry');
const { getSoloRuntime } = require('../systems/games/soloRuntimeRegistry');
const { authorizeInteraction } = require('../platform/testControlIngress');

// An AutocompleteInteraction has no reply()/followUp(); the only valid answer is a suggestion list. The interaction
// may already be gone (Discord code 10062, "Unknown interaction") or answered. None of that may escape as an
// unhandled rejection, so a failed respond is swallowed and only its code is logged.
async function respondWithNoSuggestions(interaction, context) {
  try {
    await interaction.respond([]);
  } catch (error) {
    logger.warn(`${context}。code=${error?.code ?? error?.name ?? 'unknown'}`);
  }
}

module.exports = {
  name: Events.InteractionCreate,

  async execute(interaction) {
    if (!authorizeInteraction(interaction)) return;
    const extensionHost = getClientExtensionHost(interaction.client);
    const extensionGuard = await extensionHost.guardInteraction({
      interaction,
      commandName: interaction.commandName || null,
    });
    if (extensionGuard.handled) return;

    const extensionResult = await extensionHost.runHook('interactionCreate', { interaction }, { stopOnHandled: true });
    if (extensionResult.some((item) => item.result?.handled)) return;

    if (interaction.isButton() && interaction.customId?.startsWith('coin-admin|1|add|')) {
      const command = interaction.client.commands.get('coin-admin');
      if (!command?.handleComponent) {
        await replyEphemeral(interaction, '加幣面板暫時無法使用，請重新執行 /coin-admin add。');
        return;
      }
      try {
        await command.handleComponent(interaction);
        await recordPublicInteraction();
      } catch (error) {
        logger.error('/coin-admin component failed', error);
        await replyEphemeral(interaction, '加幣面板處理失敗，請稍後再試。');
      }
      return;
    }

    if ((interaction.isButton() || interaction.isModalSubmit() || interaction.isStringSelectMenu?.()) &&
      interaction.customId?.startsWith('solo|1|')) {
      await getSoloRuntime().handleInteraction(interaction);
      await recordPublicInteraction();
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

    if (interaction.isAutocomplete?.()) {
      const command = interaction.client.commands.get(interaction.commandName);
      if (!command?.autocomplete) {
        await respondWithNoSuggestions(interaction, '沒有自動完成處理器時的空清單回應失敗');
        return;
      }
      try {
        await extensionHost.runCommand(command, 'autocomplete', interaction);
      } catch (error) {
        logger.error(`/${interaction.commandName} autocomplete failed`, error);
        if (!interaction.responded) await respondWithNoSuggestions(interaction, '自動完成失敗後的空清單回應失敗');
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
      await extensionHost.runCommand(command, 'execute', interaction);
      await recordPublicInteraction();
    } catch (error) {
      logger.error(`/${interaction.commandName} failed`, error);
      await replyEphemeral(interaction, '指令執行失敗，請稍後再試。');
    }
  },
};
