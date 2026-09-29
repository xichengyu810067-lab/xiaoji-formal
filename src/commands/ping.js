const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('確認小吉目前在線'),

  async execute(interaction) {
    await interaction.reply({ content: 'Pong！小吉目前在線～' });
  },
};
