const { SlashCommandBuilder } = require('discord.js');
const { getLeaderboard } = require('../services/coinService');
const { formatCoins, replyCoinError } = require('../utils/coinPresentation');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('查看目前伺服器的吉幣排行榜')
    .addIntegerOption((option) => option.setName('page').setDescription('頁數').setMinValue(1)),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '排行榜只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const page = interaction.options.getInteger('page') || 1;
      const leaderboard = await getLeaderboard(interaction.guildId, { page, limit: 25 });
      const visiblePlayers = [];

      for (const player of leaderboard.players) {
        const user = await interaction.client.users.fetch(player.userId).catch(() => null);

        if (user?.bot) {
          continue;
        }

        visiblePlayers.push({ player, user });

        if (visiblePlayers.length >= 10) {
          break;
        }
      }

      if (visiblePlayers.length === 0) {
        await interaction.reply({ content: '目前還沒有吉幣排行榜資料。', ephemeral: true });
        return;
      }

      const startRank = (page - 1) * 10 + 1;
      const lines = visiblePlayers.map(({ player, user }, index) => {
        const name = user ? `${user}` : `<@${player.userId}>`;
        return `${startRank + index}. ${name} - ${formatCoins(player.balance)}（連續 ${player.dailyStreak} 天）`;
      });

      await interaction.reply({
        content: [`**${interaction.guild.name} 吉幣排行榜**`, ...lines].join('\n'),
      });
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
