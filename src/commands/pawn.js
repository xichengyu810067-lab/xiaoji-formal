const { SlashCommandBuilder } = require('discord.js');
const {
  listPawnRecords,
  pawnLuxuryItem,
  quotePawnItem,
  redeemPawnRecord,
} = require('../services/luxuryService');
const { formatCoins, replyCoinError } = require('../utils/coinPresentation');

function formatTimestamp(isoString) {
  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:R>`;
}

function formatPawnRecord(record) {
  return [
    `#${record.id} ${record.itemName} x${record.quantity}`,
    `剩餘可贖回：${record.remainingQuantity}`,
    `當入單價：${formatCoins(record.pawnUnitPrice)}｜當鋪入帳：${formatCoins(record.payoutAmount)}`,
    `已贖回：${record.redeemedQuantity}｜已支付：${formatCoins(record.redeemedAmount)}｜狀態：${record.status}｜${formatTimestamp(record.createdAt)}`,
  ].join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('pawn')
    .setDescription('奢侈品當鋪')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('quote')
        .setDescription('試算當掉奢侈品可拿到多少吉幣')
        .addStringOption((option) => option.setName('item-id').setDescription('全域奢侈品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
        .addIntegerOption((option) => option.setName('quantity').setDescription('當鋪數量').setMinValue(1).setMaxValue(99))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('sell')
        .setDescription('當掉自己的奢侈品，取得目前標價 80% 吉幣')
        .addStringOption((option) => option.setName('item-id').setDescription('全域奢侈品 ID').setRequired(true).setMinLength(38).setMaxLength(38))
        .addIntegerOption((option) => option.setName('quantity').setDescription('當鋪數量').setMinValue(1).setMaxValue(99))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('active')
        .setDescription('查看尚可贖回的當鋪紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('redeem')
        .setDescription('贖回當鋪中的奢侈品，價格使用商品歷史最高標價')
        .addIntegerOption((option) => option.setName('record-id').setDescription('當鋪紀錄 ID').setRequired(true).setMinValue(1))
        .addIntegerOption((option) => option.setName('quantity').setDescription('贖回數量').setMinValue(1).setMaxValue(99))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('查看自己的當鋪紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '當鋪只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'quote') {
        const result = await quotePawnItem(
          interaction.guildId,
          interaction.user.id,
          interaction.options.getString('item-id', true),
          interaction.options.getInteger('quantity') || 1
        );
        await interaction.reply({
          content: [
            '**小吉當鋪｜估價**',
            `商品：${result.item.name} x${result.quantity}`,
            `目前標價：${formatCoins(result.pawnUnitPrice)}`,
            `當鋪可入帳：${formatCoins(result.payoutAmount)}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'sell') {
        const result = await pawnLuxuryItem(
          interaction.guildId,
          interaction.user.id,
          interaction.options.getString('item-id', true),
          interaction.options.getInteger('quantity') || 1
        );
        await interaction.reply({
          content: [
            '**小吉當鋪｜已當入**',
            `商品：${result.item.name} x${result.quantity}`,
            `吉幣入帳：${formatCoins(result.payoutAmount)}`,
            `吉幣餘額：${formatCoins(result.after)}`,
            `當鋪紀錄：#${result.record.id}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'active' || subcommand === 'history') {
        const rows = await listPawnRecords(interaction.guildId, interaction.user.id, {
          activeOnly: subcommand === 'active',
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: rows.length
            ? [`**小吉當鋪｜${subcommand === 'active' ? '可贖回紀錄' : '歷史紀錄'}**`, ...rows.map(formatPawnRecord)].join('\n\n')
            : subcommand === 'active'
              ? '目前沒有可贖回的當鋪紀錄。'
              : '目前沒有當鋪紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'redeem') {
        const result = await redeemPawnRecord(
          interaction.guildId,
          interaction.user.id,
          interaction.options.getInteger('record-id', true),
          interaction.options.getInteger('quantity') || 1
        );
        await interaction.reply({
          content: [
            '**小吉當鋪｜已贖回**',
            `商品：${result.item.name} x${result.quantity}`,
            `歷史最高單價：${formatCoins(result.redeemUnitPrice)}`,
            `支付金額：${formatCoins(result.totalPrice)}`,
            `吉幣餘額：${formatCoins(result.after)}`,
            `剩餘可贖回：${result.record.remainingQuantity}`,
          ].join('\n'),
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '當鋪剛剛執行失敗了，請稍後再試。');
    }
  },
};
