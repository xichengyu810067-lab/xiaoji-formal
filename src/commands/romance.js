const { SlashCommandBuilder } = require('discord.js');
const {
  getUserRomancePreference,
  setUserRomancePreference,
} = require('../services/romanceModeService');
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

module.exports = {
  data: new SlashCommandBuilder()
    .setName('romance')
    .setDescription('管理小吉與你的跨伺服器文字戀愛模式')
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand
      .setName('start')
      .setDescription('明確同意開啟親暱、甜蜜且安全的文字戀愛語氣'))
    .addSubcommand((subcommand) => subcommand.setName('stop').setDescription('立即關閉文字戀愛語氣'))
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查看目前文字戀愛模式狀態')),

  async execute(interaction) {
    const displayName = getCurrentDisplayName(interaction);
    const action = interaction.options.getSubcommand();
    try {
      const preference = action === 'start'
        ? await setUserRomancePreference(interaction.user.id, true)
        : action === 'stop'
          ? await setUserRomancePreference(interaction.user.id, false)
          : await getUserRomancePreference(interaction.user.id);
      const message = action === 'start'
        ? `${displayName}，文字戀愛模式已開啟。小吉會用親暱、甜蜜且輕微曖昧的虛構語氣陪你聊天，同時尊重你的自主與界線。這項設定會跨伺服器保留，直到你關閉。`
        : action === 'stop'
          ? `${displayName}，文字戀愛模式已立即關閉；小吉會恢復你原本選擇的對話風格。`
          : `${displayName}，你的文字戀愛模式目前為「${preference.enabled ? '已開啟' : '已關閉'}」。`;
      await replyEphemeral(interaction, message);
    } catch (error) {
      await replyEphemeral(interaction, '文字戀愛模式設定暫時無法讀寫，請稍後再試。');
    }
  },

  getCurrentDisplayName,
};
