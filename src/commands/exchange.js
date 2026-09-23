const { SlashCommandBuilder } = require('discord.js');
const { buyChips, cashoutChips, getChipBalance, getChipHistory, MAX_CHIP_AMOUNT } = require('../services/chipService');
const { getPlayerBalance } = require('../services/coinService');
const { formatChips, formatCoins, replyCoinError } = require('../utils/coinPresentation');

const ledgerTypeLabels = {
  buy: '手動買入籌碼',
  auto_top_up: '賭場自動補籌碼',
  cashout: '籌碼換回吉幣',
  bet: '賭場下注',
  payout: '賭場派彩',
  refund: '退款',
  loan_borrow: '貸幣借款',
  loan_repay: '貸幣還款',
};

function formatSignedChips(amount) {
  const numeric = Number(amount || 0);
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  return `${sign}${formatChips(Math.abs(numeric))}`;
}

function formatTimestamp(isoString) {
  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:R>`;
}

function formatHistoryRow(row) {
  const extra = row.entryType === 'cashout' ? `｜入帳 ${formatCoins(row.coinAmount)}｜手續費 ${formatChips(row.fee)}` : '';
  return [
    `#${row.id}`,
    ledgerTypeLabels[row.entryType] || row.entryType,
    formatSignedChips(row.amount),
    `${formatChips(row.balanceBefore)} -> ${formatChips(row.balanceAfter)}`,
    formatTimestamp(row.createdAt),
  ].join('｜') + extra;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('exchange')
    .setDescription('籌碼與吉幣兌換區')
    .addSubcommand((subcommand) => subcommand.setName('balance').setDescription('查看吉幣與籌碼餘額'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('buy-chips')
        .setDescription('使用吉幣 1:1 兌換籌碼')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('兌換籌碼數量').setRequired(true).setMinValue(1).setMaxValue(MAX_CHIP_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('cashout')
        .setDescription('將籌碼換回吉幣，會扣除手續費')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('換回吉幣的籌碼數量').setRequired(true).setMinValue(1).setMaxValue(MAX_CHIP_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('查看自己的籌碼流水')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '兌換區只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'balance') {
        const [player, chips] = await Promise.all([
          getPlayerBalance(interaction.guildId, interaction.user.id),
          getChipBalance(interaction.guildId, interaction.user.id),
        ]);
        await interaction.reply({
          content: [
            '**小吉兌換區｜餘額**',
            `吉幣錢包：${formatCoins(player.balance)}`,
            `賭場籌碼：${formatChips(chips.balance)}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'buy-chips') {
        const result = await buyChips(interaction.guildId, interaction.user.id, interaction.options.getInteger('amount', true));
        await interaction.reply({
          content: [
            '**小吉兌換區｜買入籌碼**',
            `已兌換：${formatChips(result.amount)}`,
            `吉幣餘額：${formatCoins(result.coinBalanceAfter)}`,
            `籌碼餘額：${formatChips(result.balanceAfter)}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'cashout') {
        const result = await cashoutChips(interaction.guildId, interaction.user.id, interaction.options.getInteger('amount', true));
        await interaction.reply({
          content: [
            '**小吉兌換區｜籌碼換回吉幣**',
            `扣除籌碼：${formatChips(result.amount)}`,
            `手續費：${formatChips(result.fee)}`,
            `吉幣入帳：${formatCoins(result.coinAmount)}`,
            `吉幣餘額：${formatCoins(result.coinBalanceAfter)}`,
            `籌碼餘額：${formatChips(result.balanceAfter)}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'history') {
        const rows = await getChipHistory(interaction.guildId, interaction.user.id, {
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: rows.length ? ['**小吉兌換區｜籌碼流水**', ...rows.map(formatHistoryRow)].join('\n') : '目前沒有籌碼流水。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '兌換區剛剛執行失敗了，請稍後再試。');
    }
  },
};
