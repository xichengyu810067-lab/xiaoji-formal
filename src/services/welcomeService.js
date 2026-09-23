const { ChannelType, PermissionFlagsBits } = require('discord.js');
const { getGuildConfig } = require('../utils/guildConfig');
const logger = require('../utils/logger');

function formatWelcomeMessage(member) {
  return `歡迎 ${member} 加入伺服器！小吉在這裡向你打招呼～`;
}

async function fetchBotMember(guild) {
  return guild.members.me || guild.members.fetchMe();
}

function canSendWelcome(channel, botMember) {
  if (!channel?.isTextBased?.() || typeof channel.send !== 'function') {
    return false;
  }

  const permissions = channel.permissionsFor?.(botMember);

  return Boolean(
    permissions?.has(PermissionFlagsBits.ViewChannel) &&
      permissions?.has(PermissionFlagsBits.SendMessages)
  );
}

async function handleGuildMemberWelcome(member, options = {}) {
  if (!member?.guild || member.user?.bot) {
    return false;
  }

  const config = options.config || getGuildConfig(member.guild.id);
  const botMember = await fetchBotMember(member.guild).catch(() => null);
  if (!botMember) {
    logger.warn(`Welcome skipped in guild ${member.guild.id}: bot member unavailable`);
    return false;
  }

  const candidates = [];
  const seen = new Set();
  const addCandidate = (channel, source) => {
    if (channel?.id && !seen.has(channel.id)) {
      seen.add(channel.id);
      candidates.push({ channel, source });
    }
  };

  if (config.welcomeChannelId) {
    const configured = await member.guild.channels.fetch(config.welcomeChannelId).catch(() => null);
    if (!configured) {
      logger.warn(`Welcome channel ${config.welcomeChannelId} no longer exists in guild ${member.guild.id}; using fallback`);
    }
    addCandidate(configured, 'configured');
  }

  addCandidate(member.guild.systemChannel, 'system');

  let allChannels = member.guild.channels.cache;
  try {
    allChannels = (await member.guild.channels.fetch()) || allChannels;
  } catch (error) {
    logger.warn(`Welcome channel list fetch failed in guild ${member.guild.id}: ${error?.message || error}`);
  }

  const regularTextChannels = [...(allChannels?.values?.() || [])]
    .filter((channel) => channel?.type === ChannelType.GuildText)
    .sort((left, right) => (left.rawPosition ?? left.position ?? 0) - (right.rawPosition ?? right.position ?? 0));
  for (const channel of regularTextChannels) addCandidate(channel, 'first-text');

  for (const { channel, source } of candidates) {
    if (!canSendWelcome(channel, botMember)) {
      logger.warn(`Welcome candidate ${channel.id} (${source}) lacks permissions in guild ${member.guild.id}`);
      continue;
    }

    try {
      await channel.send({
        content: formatWelcomeMessage(member),
        allowedMentions: { parse: [], users: [member.id], roles: [], repliedUser: false },
      });
      logger.info(`[Welcome] guild=${member.guild.id} channel=${channel.id} source=${source}`);
      return true;
    } catch (error) {
      logger.warn(`Welcome send failed for ${channel.id} (${source}) in guild ${member.guild.id}: ${error?.message || error}`);
    }
  }

  logger.warn(`Welcome skipped in guild ${member.guild.id}: no sendable text channel`);
  return false;
}

module.exports = {
  canSendWelcome,
  formatWelcomeMessage,
  handleGuildMemberWelcome,
};
