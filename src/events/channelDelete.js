const { Events } = require('discord.js');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');
const { authorizeEvent } = require('../platform/testControlIngress');

module.exports = {
  name: Events.ChannelDelete,
  async execute(channel) {
    if (!authorizeEvent(channel?.client, 'channelDelete', { guildId: channel?.guildId, channelId: channel?.id })) return;
    try {
      await getClientExtensionHost(channel?.client).runHook('channelDelete', { channel });
    } catch (error) {
      logger.warn(`Private channel-delete hook failed: ${error?.message || error}`);
    }
  },
};
