const { Events } = require('discord.js');
const logger = require('../utils/logger');
const { getClientExtensionHost } = require('../extensions/extensionHost');
const { authorizeEvent } = require('../platform/testControlIngress');

module.exports = {
  name: Events.VoiceStateUpdate,
  async execute(oldState, newState) {
    const client = newState?.client || oldState?.client;
    if (!authorizeEvent(client, 'voiceStateUpdate', {
      guildId: newState?.guild?.id || oldState?.guild?.id,
      channelId: newState?.channelId || oldState?.channelId,
    })) return;
    try {
      await getClientExtensionHost(client).runHook('voiceStateUpdate', { oldState, newState });
    } catch (error) {
      logger.warn(`Private voice-state hook failed: ${error?.message || error}`);
    }
  },
};
