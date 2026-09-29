const { SlashCommandBuilder } = require('discord.js');
const packageJson = require('../../package.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('about')
    .setDescription('顯示小吉的公開資訊'),

  async execute(interaction) {
    await interaction.reply({
      content: `小吉 v${packageJson.version}\n提供聊天、日常工具、社群互動與遊戲。使用 /help 查看公開功能。\n公開版本資訊：https://github.com/xichengyu810067-lab/xiaoji-formal/releases`,
      ephemeral: true,
    });
  },
};
