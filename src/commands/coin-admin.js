const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  adjustPlayerBalance,
  getTransactions,
  resetPlayerData,
  setGuildEconomyEnabled,
} = require('../services/coinService');
const { ensureBotOwner } = require('../utils/ownerOnly');
const { ensureModerationAccess } = require('../utils/moderation');
const { formatCoins, formatUser, replyCoinError } = require('../utils/coinPresentation');

function addUserAmountReasonOptions(subcommand, amountDescription, minValue = 1) {
  return subcommand
    .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
    .addIntegerOption((option) =>
      option.setName('amount').setDescription(amountDescription).setRequired(true).setMinValue(minValue)
    )
    .addStringOption((option) =>
      option.setName('reason').setDescription('操作原因').setRequired(true).setMaxLength(300)
    );
}

function formatAdminResult(actionLabel, target, result, reason) {
  return [
    `${actionLabel}完成。`,
    `目標：${formatUser(target)}`,
    `原本餘額：${formatCoins(result.before)}`,
    `變動：${formatCoins(result.amount)}`,
    `最新餘額：${formatCoins(result.after)}`,
    `原因：${reason}`,
  ].join('\n');
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('coin-admin')
    .setDescription('管理吉幣系統（全域錢包變更限小吉擁有者）')
    .addSubcommand((subcommand) =>
      addUserAmountReasonOptions(subcommand.setName('add').setDescription('替使用者增加全域吉幣（限 owner）'), '增加數量').setName('add')
    )
    .addSubcommand((subcommand) =>
      addUserAmountReasonOptions(subcommand.setName('remove').setDescription('扣除使用者全域吉幣（限 owner）'), '扣除數量').setName('remove')
    )
    .addSubcommand((subcommand) =>
      addUserAmountReasonOptions(subcommand.setName('set').setDescription('設定使用者全域吉幣餘額（限 owner）'), '新的餘額', 0).setName('set')
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('history')
        .setDescription('查詢使用者最近吉幣交易紀錄')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('reset-user')
        .setDescription('重置單一使用者吉幣資料，限 owner')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
        .addStringOption((option) =>
          option.setName('confirm').setDescription('請輸入 RESET 才會執行').setRequired(true).setMaxLength(20)
        )
        .addStringOption((option) => option.setName('reason').setDescription('操作原因').setMaxLength(300))
    )
    .addSubcommand((subcommand) => subcommand.setName('enable').setDescription('啟用目前伺服器吉幣系統'))
    .addSubcommand((subcommand) => subcommand.setName('disable').setDescription('停用目前伺服器吉幣系統')),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '吉幣管理只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (['add', 'remove', 'set', 'reset-user'].includes(subcommand)) {
        if (!(await ensureBotOwner(interaction))) {
          return;
        }
      } else {
        const access = await ensureModerationAccess(interaction, {
          userPermission: PermissionFlagsBits.Administrator,
          userPermissionName: 'Administrator',
        });

        if (!access.ok) {
          return;
        }
      }

      if (['add', 'remove', 'set'].includes(subcommand)) {
        const target = interaction.options.getUser('user', true);
        const amount = interaction.options.getInteger('amount', true);
        const reason = interaction.options.getString('reason', true);
        const result = await adjustPlayerBalance(interaction.guildId, target.id, {
          action: subcommand,
          amount,
          operatorId: interaction.user.id,
          reason,
        });
        const label = subcommand === 'add' ? '加幣' : subcommand === 'remove' ? '扣幣' : '設定餘額';

        await interaction.reply({
          content: formatAdminResult(label, target, result, reason),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'history') {
        const target = interaction.options.getUser('user', true);
        const limit = interaction.options.getInteger('limit') || 10;
        const transactions = await getTransactions(interaction.guildId, target.id, { limit });

        if (transactions.length === 0) {
          await interaction.reply({ content: `${formatUser(target)} 目前沒有吉幣交易紀錄。`, ephemeral: true });
          return;
        }

        const lines = transactions.map((transaction) => {
          const timestamp = Math.floor(new Date(transaction.createdAt).getTime() / 1000);
          return `#${transaction.id} <t:${timestamp}:R> ${transaction.type} ${formatCoins(transaction.amount)}：${formatCoins(transaction.balanceBefore)} -> ${formatCoins(transaction.balanceAfter)}｜${transaction.reason}`;
        });

        await interaction.reply({
          content: [`**${formatUser(target)} 最近交易紀錄**`, ...lines].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'reset-user') {
        const confirm = interaction.options.getString('confirm', true);

        if (confirm !== 'RESET') {
          await interaction.reply({ content: '未輸入 RESET，重置已取消。', ephemeral: true });
          return;
        }

        const target = interaction.options.getUser('user', true);
        const reason = interaction.options.getString('reason') || 'owner 重置使用者吉幣資料';
        const result = await resetPlayerData(interaction.guildId, target.id, {
          operatorId: interaction.user.id,
          reason,
        });

        await interaction.reply({
          content: [
            '使用者全域吉幣錢包、一般債務、簽到與一般商店庫存紀錄已重置。',
            `目標：${formatUser(target)}`,
            `原本餘額：${formatCoins(result.before)}`,
            `最新餘額：${formatCoins(result.after)}`,
            `原因：${reason}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'enable' || subcommand === 'disable') {
        const enabled = subcommand === 'enable';
        const settings = await setGuildEconomyEnabled(interaction.guildId, enabled, { operatorId: interaction.user.id });

        await interaction.reply({
          content: `目前伺服器吉幣系統已${settings.enabled ? '啟用' : '停用'}。`,
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
