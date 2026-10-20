const { SlashCommandBuilder } = require('discord.js');
const {
  getDuelTowerHistory,
  getDuelTowerProfile,
  listOwnedBattleWeapons,
} = require('../services/casinoFacilityService');
const { executeDuelTowerGame, formatSignedChips } = require('../systems/casino/discord/duelTowerLaunch');
const { replyCoinError } = require('../utils/coinPresentation');
const { clipText, fitListText, omittedLine } = require('../utils/replyLengthGuard');

function formatTimestamp(isoString) {
  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:R>`;
}

// textLimit is how many characters the weapon name may take when a long list has to be shortened.
function formatWeaponLine(weapon, { textLimit = Infinity } = {}) {
  return `#${weapon.itemId} **${clipText(weapon.itemName, textLimit)}** x${weapon.quantity}`;
}

function formatRunLine(run, { textLimit = Infinity } = {}) {
  const status = run.status === 'win' ? '勝利' : run.status === 'draw' ? '平手' : '落敗';
  return [
    `#${run.id}`,
    `第 ${run.floor} 層`,
    status,
    clipText(run.weaponName, textLimit),
    formatSignedChips(run.netAmount),
    formatTimestamp(run.createdAt),
  ].join('｜');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('duel-tower')
    .setDescription('決鬥塔台的武器、進度與紀錄；開局請用 /board start')
    .addSubcommand((subcommand) => subcommand.setName('weapons').setDescription('查看自己可用的對戰技能道具'))
    .addSubcommand((subcommand) => subcommand.setName('profile').setDescription('查看自己的決鬥塔台進度'))
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
            ? fitListText({
              header: '**決鬥塔台｜可用武器**',
              items: weapons,
              render: (weapon, { textLimit }) => formatWeaponLine(weapon, { textLimit }),
              note: (count) => omittedLine(count, { unit: '種武器' }),
            })
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

      if (subcommand === 'history') {
        const runs = await getDuelTowerHistory(interaction.guildId, interaction.user.id, {
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: runs.length
            ? fitListText({
              header: '**決鬥塔台｜挑戰紀錄**',
              items: runs,
              render: (run, { textLimit }) => formatRunLine(run, { textLimit }),
              note: (count) => omittedLine(count, { unit: '筆挑戰紀錄' }),
            })
            : '目前沒有決鬥塔台紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '決鬥塔台剛剛執行失敗了，請稍後再試。');
    }
  },
  // Compatibility export: the launcher lives in src/systems/casino/discord/duelTowerLaunch.js.
  executeDuelTowerGame,
};
