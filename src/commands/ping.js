const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('查看小吉的回應速度'),

  async execute(interaction) {
    const sent = await interaction.reply({
      content: '小吉正在量測延遲...',
      fetchReply: true,
    });

    const roundTrip = sent.createdTimestamp - interaction.createdTimestamp;
    const websocket = Math.round(interaction.client.ws.ping);

    await interaction.editReply(`Pong! 往返延遲 ${roundTrip}ms，WebSocket ${websocket}ms。`);
  },
};
