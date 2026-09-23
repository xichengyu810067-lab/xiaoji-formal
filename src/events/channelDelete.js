const { Events } = require('discord.js');
const { handleVoiceChannelDeleted } = require('../services/musicService');
const logger = require('../utils/logger');

module.exports = {
  name: Events.ChannelDelete,
  async execute(channel) {
    try {
      await handleVoiceChannelDeleted(channel);
    } catch (error) {
      logger.warn(`Music channel-delete lifecycle handling failed: ${error?.message || error}`);
    }
  },
};
