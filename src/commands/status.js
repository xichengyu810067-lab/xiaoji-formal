const { EmbedBuilder, SlashCommandBuilder } = require('discord.js');
const { getBotStatus } = require('../services/statusService');

module.exports = {
  data: new SlashCommandBuilder().setName('status').setDescription('顯示小吉目前狀態'),

  async execute(interaction) {
    const status = getBotStatus(interaction.client);
    const embed = new EmbedBuilder()
      .setColor(0x22c55e)
      .setTitle('小吉狀態')
      .addFields(
        { name: '目前狀態', value: status.online ? '小吉目前在線' : '狀態暫時無法確認', inline: true },
        { name: '公開版本', value: status.version, inline: true }
      );

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
