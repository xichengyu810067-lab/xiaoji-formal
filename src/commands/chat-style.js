const { SlashCommandBuilder } = require('discord.js');
const {
  CHAT_STYLES,
  CHAT_STYLE_NAMES,
  getUserChatPreference,
  setUserChatPreference,
} = require('../services/chatStyleService');
const { replyEphemeral } = require('../utils/moderation');

function getCurrentDisplayName(interaction) {
  const userId = String(interaction.user?.id || '');
  for (const value of [interaction.member?.displayName, interaction.user?.globalName, interaction.user?.username]) {
    const displayName = String(value || '')
      .replace(/<@!?\d{17,20}>/g, '')
      .replace(/\b\d{17,20}\b/g, '')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80);
    if (displayName && displayName !== userId) return displayName;
  }
  return 'Discord 使用者';
}

const styleChoices = CHAT_STYLE_NAMES.map((style) => ({ name: CHAT_STYLES[style].label, value: style }));

module.exports = {
  data: new SlashCommandBuilder()
    .setName('chat-style')
    .setDescription('查看或變更小吉與你的對話風格')
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand.setName('current').setDescription('查看目前的對話風格'))
    .addSubcommand((subcommand) => subcommand
      .setName('set')
      .setDescription('永久變更你的跨伺服器對話風格')
      .addStringOption((option) => option
        .setName('style')
        .setDescription('選擇小吉的對話風格')
        .setRequired(true)
        .addChoices(...styleChoices))),

  async execute(interaction) {
    const displayName = getCurrentDisplayName(interaction);
    const action = interaction.options.getSubcommand();
    try {
      const preference = action === 'set'
        ? await setUserChatPreference(interaction.user.id, interaction.options.getString('style', true))
        : await getUserChatPreference(interaction.user.id);
      const label = CHAT_STYLES[preference.style].label;
      const message = action === 'set'
        ? `${displayName}，小吉已將你的對話風格設為「${label}」。之後在任何伺服器都會沿用，直到你再次更改。`
        : `${displayName}，你目前的對話風格是「${label}」。`;
      await replyEphemeral(interaction, message);
    } catch (error) {
      await replyEphemeral(interaction, '對話風格設定暫時無法讀寫，請稍後再試。');
    }
  },

  getCurrentDisplayName,
};
