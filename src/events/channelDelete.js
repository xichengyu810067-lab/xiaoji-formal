const { Events } = require('discord.js');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');

module.exports = {
  name: Events.ChannelDelete,
  async execute(channel) {
    try {
      await getClientExtensionHost(channel?.client).runHook('channelDelete', { channel });
    } catch (error) {
      logger.warn(`Private channel-delete hook failed: ${error?.message || error}`);
    }
  },
};
