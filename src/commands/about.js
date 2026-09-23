const { SlashCommandBuilder } = require('discord.js');
const packageJson = require('../../package.json');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('about')
    .setDescription('顯示小吉的專案資訊'),

  async execute(interaction) {
    await interaction.reply({
      content: `小吉 Discord Bot v${packageJson.version}\n使用 discord.js 建立，支援 slash commands。`,
      ephemeral: true,
    });
  },
};
