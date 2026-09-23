const { Events } = require('discord.js');
const { handleGuildMemberWelcome } = require('../services/welcomeService');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');
const { isGuildApproved } = require('../services/auditService');

module.exports = {
  name: Events.GuildMemberAdd,

  async execute(member) {
    if (!member?.guild?.id || !isGuildApproved(member.guild.id)) return;

    try {
      await getClientExtensionHost(member.client).runHook('guildMemberAdd', { member });
    } catch (error) {
      logger.error('private member-add hook failed', error);
    }

    try {
      await handleGuildMemberWelcome(member);
    } catch (error) {
      logger.error('welcome handling failed', error);
    }
  },
};
