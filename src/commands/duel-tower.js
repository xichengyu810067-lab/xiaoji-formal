const { SlashCommandBuilder } = require('discord.js');
const {
  enterDuelTower,
  getDuelTowerHistory,
  getDuelTowerProfile,
  listOwnedBattleWeapons,
} = require('../services/casinoFacilityService');
const { MAX_CHIP_AMOUNT } = require('../services/chipService');
const { formatChips, replyCoinError } = require('../utils/coinPresentation');

function formatSignedChips(amount) {
  const numeric = Number(amount || 0);
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  return `${sign}${formatChips(Math.abs(numeric))}`;
}

function formatAutoTopUp(result) {
  return result.autoTopUpAmount > 0 ? `籌碼不足，已自動用吉幣兌換 ${formatChips(result.autoTopUpAmount)}。` : null;
}

function formatTimestamp(isoString) {
  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:R>`;
}

function formatWeaponLine(weapon) {
  return `#${weapon.itemId} **${weapon.itemName}** x${weapon.quantity}`;
}

function formatRunLine(run) {
  const status = run.status === 'win' ? '勝利' : run.status === 'draw' ? '平手' : '落敗';
  return [
    `#${run.id}`,
    `第 ${run.floor} 層`,
    status,
    run.weaponName,
    formatSignedChips(run.netAmount),
    formatTimestamp(run.createdAt),
  ].join('｜');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('duel-tower')
    .setDescription('使用吉幣商店武器挑戰賭場決鬥塔台')
    .addSubcommand((subcommand) => subcommand.setName('weapons').setDescription('查看自己可用的對戰技能道具'))
    .addSubcommand((subcommand) => subcommand.setName('profile').setDescription('查看自己的決鬥塔台進度'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('enter')
        .setDescription('挑戰決鬥塔台')
        .addStringOption((option) =>
          option.setName('weapon-item-id').setDescription('全域吉幣商店對戰技能道具 ID').setRequired(true).setMinLength(38).setMaxLength(38)
        )
        .addIntegerOption((option) =>
          option.setName('wager').setDescription('投入籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CHIP_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('查看自己的決鬥紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '決鬥塔台只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'weapons') {
        const weapons = await listOwnedBattleWeapons(interaction.guildId, interaction.user.id);
        await interaction.reply({
          content: weapons.length
            ? ['**決鬥塔台｜可用武器**', ...weapons.map(formatWeaponLine)].join('\n')
            : '你目前沒有可用的對戰技能道具。請先在吉幣商店購買類型為「對戰技能道具」的商品。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'profile') {
        const profile = await getDuelTowerProfile(interaction.guildId, interaction.user.id);
        await interaction.reply({
          content: [
            '**決鬥塔台｜個人進度**',
            `挑戰次數：${profile.total}`,
            `勝利：${profile.wins}`,
            `落敗：${profile.losses}`,
            `累計損益：${formatSignedChips(profile.netAmount)}`,
            `下一層：第 ${profile.nextFloor} 層`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'enter') {
        const result = await enterDuelTower(interaction.guildId, interaction.user.id, {
          weaponItemId: interaction.options.getString('weapon-item-id', true),
          wager: interaction.options.getInteger('wager', true),
        });
        const status = result.run.status === 'win' ? '勝利' : result.run.status === 'draw' ? '平手' : '落敗';
        await interaction.reply({
          content: [
            '**決鬥塔台｜挑戰結算**',
            `層數：第 ${result.run.floor} 層`,
            `對手：${result.run.opponentName}`,
            `武器：${result.run.weaponName}`,
            `結果：${status}`,
            `本次損益：${formatSignedChips(result.run.netAmount)}`,
            `籌碼餘額：${formatChips(result.balanceAfter)}`,
            formatAutoTopUp(result),
          ]
            .filter(Boolean)
            .join('\n'),
        });
        return;
      }

      if (subcommand === 'history') {
        const runs = await getDuelTowerHistory(interaction.guildId, interaction.user.id, {
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: runs.length ? ['**決鬥塔台｜挑戰紀錄**', ...runs.map(formatRunLine)].join('\n') : '目前沒有決鬥塔台紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '決鬥塔台剛剛執行失敗了，請稍後再試。');
    }
  },
};
