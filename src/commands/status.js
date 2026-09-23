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
        { name: 'Uptime', value: status.uptime, inline: true },
        {
          name: 'Memory',
          value: `RSS ${status.memoryUsage.rss}\nHeap ${status.memoryUsage.heapUsed} / ${status.memoryUsage.heapTotal}`,
          inline: true,
        },
        { name: '伺服器數', value: String(status.guildCount), inline: true },
        { name: '指令數', value: String(status.commandCount), inline: true },
        { name: '版本號', value: status.version, inline: true },
        { name: '最近啟動時間', value: `<t:${Math.floor(status.startedAt.getTime() / 1000)}:F>`, inline: false }
      )
      .setTimestamp(new Date());

    await interaction.reply({ embeds: [embed], ephemeral: true });
  },
};
