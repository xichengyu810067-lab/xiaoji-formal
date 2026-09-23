const { Events } = require('discord.js');
const { handleBotVoiceStateUpdate } = require('../services/musicService');
const logger = require('../utils/logger');

module.exports = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    try {
      await handleBotVoiceStateUpdate(oldState, newState);
    } catch (error) {
      logger.warn(`Music voice-state lifecycle handling failed: ${error?.message || error}`);
    }
  },
};
