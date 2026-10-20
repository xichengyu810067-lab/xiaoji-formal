const { SlashCommandBuilder } = require('discord.js');
const { dailyCheckin } = require('../services/coinService');
const { formatCoins, replyCoinError } = require('../utils/coinPresentation');

module.exports = {
  data: new SlashCommandBuilder().setName('daily').setDescription('每日簽到領取吉幣'),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '吉幣只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const result = await dailyCheckin(interaction.guildId, interaction.user.id);
      const bonusText = result.bonus > 0 ? `\n連續簽到獎勵：${formatCoins(result.bonus)}` : '';

      // The public reply names the member with a mention so the name is clickable, but it must not
      // ping them.
      await interaction.reply({
        content: [
          `${interaction.user} 簽到成功，今天獲得 ${formatCoins(result.earned)}。${bonusText}`,
          `目前餘額：${formatCoins(result.player.balance)}`,
          `連續簽到：${result.streak} 天`,
          `下次可簽到時間：${result.nextDailyAt}`,
        ].join('\n'),
        allowedMentions: { parse: [] },
      });
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
