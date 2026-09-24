const { Events } = require('discord.js');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');

module.exports = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    try {
      const client = newState?.client || oldState?.client;
      await getClientExtensionHost(client).runHook('voiceStateUpdate', { oldState, newState });
    } catch (error) {
      logger.warn(`Private voice-state hook failed: ${error?.message || error}`);
    }
  },
};
