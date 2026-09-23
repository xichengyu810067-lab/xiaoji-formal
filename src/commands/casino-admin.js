const { SlashCommandBuilder } = require('discord.js');
const {
  applyCasinoLoanRelief,
  collectCasinoDebt,
  getCasinoDebtStatus,
} = require('../services/casinoService');
const { formatChips, formatCoins, formatUser, replyCoinError } = require('../utils/coinPresentation');
const { ensureBotOwner } = require('../utils/ownerOnly');

function formatPercent(rate) {
  return `${(Number(rate || 0) * 100).toFixed(3)}%`;
}

function formatDebtStatus(target, status) {
  const loanLines = status.loan
    ? [
        `借款編號：#${status.loan.id}`,
        `本金累計：${formatCoins(status.loan.principalAmount)}`,
        `目前債務：${formatCoins(status.loan.currentDebtAmount)}`,
        `有效日利率：${formatPercent(status.loan.interestRate)}`,
        `降息次數：${status.loan.reliefCount}`,
        `上次計息日期：${status.loan.lastInterestDate}`,
        `狀態：${status.loan.status}`,
      ]
    : ['目前沒有 active 賭場借款。'];

  return [
    '**賭場內部債務狀態**',
    `目標：${formatUser(target)}`,
    ...loanLines,
    `籌碼：${formatChips(status.chipBalance)}`,
    `錢包：${formatCoins(status.walletBalance)}`,
    `活存：${formatCoins(status.bankBalance)}`,
    `可徵收上限：${formatCoins(status.maxCollectableAmount)}`,
    `定存本金：${formatCoins(status.fixedPrincipal)}`,
    `定存預估利息：${formatCoins(status.fixedExpectedInterest)}`,
    `已到期可領定存：${formatCoins(status.fixedClaimable)}`,
  ].join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('casino-admin')
    .setDescription('Owner-only casino operations')
    .addSubcommand((subcommand) =>
      subcommand
        .setName('debt-status')
        .setDescription('查看玩家賭場內部債務狀態')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('relief-apply')
        .setDescription('套用一次賭場貸幣降息')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
        .addStringOption((option) =>
          option.setName('reason').setDescription('操作原因').setRequired(true).setMaxLength(300)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('collect')
        .setDescription('強制徵收錢包與活存償還賭場債務')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
        .addIntegerOption((option) =>
          option.setName('amount').setDescription('徵收金額').setRequired(true).setMinValue(1)
        )
        .addStringOption((option) =>
          option.setName('reason').setDescription('操作原因').setRequired(true).setMaxLength(300)
        )
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '賭場內部管理只能在伺服器內使用。', ephemeral: true });
        return;
      }

      if (!(await ensureBotOwner(interaction))) {
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      const target = interaction.options.getUser('user', true);

      if (subcommand === 'debt-status') {
        const status = await getCasinoDebtStatus(interaction.guildId, target.id);
        await interaction.reply({
          content: formatDebtStatus(target, status),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'relief-apply') {
        const reason = interaction.options.getString('reason', true);
        const result = await applyCasinoLoanRelief(interaction.guildId, target.id, {
          operatorId: interaction.user.id,
          reason,
        });

        await interaction.reply({
          content: [
            '**賭場貸幣降息已套用**',
            `目標：${formatUser(target)}`,
            `借款編號：#${result.loan.id}`,
            `原日利率：${formatPercent(result.oldRate)}`,
            `新日利率：${formatPercent(result.newRate)}`,
            `降息次數：${result.reliefCount}`,
            `目前債務：${formatCoins(result.loan.currentDebtAmount)}`,
            `原因：${reason}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'collect') {
        const amount = interaction.options.getInteger('amount', true);
        const reason = interaction.options.getString('reason', true);
        const result = await collectCasinoDebt(interaction.guildId, target.id, {
          amount,
          operatorId: interaction.user.id,
          reason,
        });

        await interaction.reply({
          content: [
            '**賭場貸幣徵收已完成**',
            `目標：${formatUser(target)}`,
            `請求徵收：${formatCoins(result.requestedAmount)}`,
            `實際徵收：${formatCoins(result.collectionAmount)}`,
            `錢包徵收：${formatCoins(result.walletCollected)}（${formatCoins(result.walletBefore)} -> ${formatCoins(result.walletAfter)}）`,
            `活存徵收：${formatCoins(result.bankCollected)}（${formatCoins(result.bankBefore)} -> ${formatCoins(result.bankAfter)}）`,
            `債務：${formatCoins(result.debtBefore)} -> ${formatCoins(result.debtAfter)}`,
            '定存未動用。',
            `原因：${reason}`,
          ].join('\n'),
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error, '賭場內部管理執行失敗，請稍後再試。');
    }
  },
};
