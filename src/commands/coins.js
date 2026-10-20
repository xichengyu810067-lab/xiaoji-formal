const { SlashCommandBuilder } = require('discord.js');
const { getPlayerBalance } = require('../services/coinService');
const { formatCoins, formatUser, replyCoinError } = require('../utils/coinPresentation');

// /coins answers about the caller only. It takes no user option: the wallet is one account shared by every server,
// so looking somebody else up would show a person's money to a server that has nothing to do with them. The
// owner-only lookup command is the one place that reads another account.
module.exports = {
  data: new SlashCommandBuilder()
    .setName('coins')
    .setDescription('查詢自己的吉幣餘額'),

  async execute(interaction) {
    const resolveDisplayUser = async (guild, user) => {
      if (!guild?.members) return user;
      const cachedMember = guild.members.cache?.get?.(user.id);
      if (cachedMember?.displayName) {
        return { ...user, displayName: cachedMember.displayName };
      }

      if (typeof guild.members.fetch !== 'function') return user;

      try {
        const member = await guild.members.fetch(user.id);
        if (member?.displayName) {
          return { ...user, displayName: member.displayName };
        }
      } catch (error) {
        // 如果成員不存在或權限不足，保留使用者本身資料，並在格式化時走安全 fallback
      }

      return user;
    };

    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '吉幣只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const user = interaction.user;
      const displayTarget = await resolveDisplayUser(interaction.guild, user);
      // Looking at one's own balance files one under this guild, as every coin command does.
      const player = await getPlayerBalance(interaction.guildId, user.id);

      await interaction.reply({
        content: [
          `**${formatUser(displayTarget)} 的吉幣資料**`,
          `目前餘額：${formatCoins(player.balance)}`,
          `連續簽到：${player.dailyStreak} 天`,
          `最近簽到：${player.lastDailyDate || '尚未簽到'}`,
          player.debtAmount > 0 ? `待抵欠款：${formatCoins(player.debtAmount)}` : null,
          `累積取得：${formatCoins(player.totalEarned)}`,
          `累積花費：${formatCoins(player.totalSpent)}`,
        ].filter(Boolean).join('\n'),
        ephemeral: true,
      });
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
