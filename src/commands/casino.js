const { SlashCommandBuilder } = require('discord.js');
const {
  MAX_CASINO_AMOUNT,
  borrowCasinoLoan,
  getCasinoLoanStatus,
  listCasinoHistory,
  repayCasinoLoan,
} = require('../services/casinoService');
const { executeCasinoGame, formatAutoTopUp, formatSignedChips } = require('../systems/casino/discord/casinoLaunch');
const { formatChips, formatCoins, formatLoanStatus, replyCoinError } = require('../utils/coinPresentation');
const { fitListText, omittedLine } = require('../utils/replyLengthGuard');

const ledgerTypeLabels = {
  game_win: '遊戲獲勝',
  game_loss: '遊戲落敗',
  game_push: '遊戲平手',
  loan_borrow: '貸幣借款',
  loan_repay: '貸幣還款',
  loan_interest: '貸幣利息',
  blackjack_refund: '21 點逾時退還',
};

function formatSignedCoins(amount) {
  const numeric = Number(amount || 0);
  const sign = numeric > 0 ? '+' : numeric < 0 ? '-' : '';
  return `${sign}${formatCoins(Math.abs(numeric))}`;
}

function formatTimestamp(isoString) {
  if (!isoString) {
    return '未知';
  }

  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:F>`;
}

function formatLoan(loan) {
  if (!loan) {
    return '目前沒有賭場借款。';
  }

  return [
    `借款編號：${loan.id}`,
    `本金：${formatCoins(loan.principalAmount)}`,
    `目前債務：${formatCoins(loan.currentDebtAmount)}`,
    `狀態：${formatLoanStatus(loan.status)}`,
  ].join('\n');
}

function formatHistoryRow(row) {
  const targetId = row.gameId ? `遊戲 #${row.gameId}` : row.loanId ? `借款 #${row.loanId}` : '系統';
  return [
    `#${row.id}`,
    ledgerTypeLabels[row.entryType] || row.entryType,
    targetId,
    row.currency === 'coin' ? formatSignedCoins(row.amount) : formatSignedChips(row.amount),
    formatTimestamp(row.createdAt),
  ].join('｜');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('casino')
    .setDescription('賭場借款與紀錄；開局請用 /board start')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('loan-borrow')
        .setDescription('從貸幣兌換區借入籌碼')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('借款籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('loan-repay')
        .setDescription('償還賭場貸幣借款')
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('還款籌碼').setRequired(true).setMinValue(1).setMaxValue(MAX_CASINO_AMOUNT)
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('loan-status').setDescription('查看自己的賭場借款狀態'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('查看自己的賭場紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('顯示筆數').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '賭場功能只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      const guildId = interaction.guildId;
      const userId = interaction.user.id;

      if (subcommand === 'loan-borrow') {
        const result = await borrowCasinoLoan(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
        });
        await interaction.reply({
          content: [
            '**小吉賭場｜貸幣兌換區借款**',
            `已借入：${formatChips(result.borrowedAmount)}`,
            `籌碼餘額：${formatChips(result.balanceAfter)}`,
            formatLoan(result.loan),
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'loan-repay') {
        const result = await repayCasinoLoan(guildId, userId, {
          amount: interaction.options.getInteger('amount', true),
        });
        await interaction.reply({
          content: [
            '**小吉賭場｜貸幣兌換區還款**',
            `已還款：${formatChips(result.repaymentAmount)}`,
            `籌碼餘額：${formatChips(result.balanceAfter)}`,
            formatAutoTopUp(result),
            formatLoan(result.loan),
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'loan-status') {
        const result = await getCasinoLoanStatus(guildId, userId);
        await interaction.reply({
          content: [
            '**小吉賭場｜借款狀態**',
            `籌碼餘額：${formatChips(result.chipBalance)}`,
            formatLoan(result.loan),
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'history') {
        const rows = await listCasinoHistory(guildId, userId, {
          limit: interaction.options.getInteger('limit') || 10,
        });
        await interaction.reply({
          content: rows.length
            ? fitListText({
              header: '**小吉賭場｜紀錄**',
              items: rows,
              render: (row) => formatHistoryRow(row),
              note: (count) => omittedLine(count, { unit: '筆賭場紀錄' }),
            })
            : '目前沒有賭場紀錄。',
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '小吉賭場剛剛執行失敗了，請稍後再試。');
    }
  },
  // Compatibility export: the launcher lives in src/systems/casino/discord/casinoLaunch.js.
  executeCasinoGame,
};
