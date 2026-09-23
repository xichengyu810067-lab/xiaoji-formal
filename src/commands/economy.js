const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  getAllInventory,
  getAllPurchaseHistory,
  getAllTransactions,
  getCoinDatabaseStats,
  getInventory,
  getPurchaseHistory,
} = require('../services/coinService');
const {
  getAllBalanceSummaries,
  getBalanceSummary,
  getBankRates,
  getRateHistory,
  listFixedDeposits,
} = require('../services/bankService');
const {
  getAllWorkStatuses,
  getPayrollHistory,
  getWorkStatus,
  listWorkTasks,
} = require('../services/workService');
const { formatCoins, formatItemType, formatUser, replyCoinError } = require('../utils/coinPresentation');
const { ensureModerationAccess } = require('../utils/moderation');

const auditTypeChoices = [
  { name: '餘額與資產', value: 'balances' },
  { name: '購買紀錄', value: 'purchases' },
  { name: '定存紀錄', value: 'fixed' },
  { name: '擁有商品', value: 'inventory' },
  { name: '職業紀錄', value: 'work' },
  { name: '工作任務', value: 'tasks' },
  { name: '發薪紀錄', value: 'payroll' },
  { name: '交易紀錄', value: 'transactions' },
  { name: '利率紀錄', value: 'rates' },
];

function formatTimestamp(isoString) {
  if (!isoString) {
    return '無';
  }

  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:F> (<t:${timestamp}:R>)`;
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(3)}%`;
}

function compact(text, maxLength = 140) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  return value.length > maxLength ? `${value.slice(0, maxLength - 1)}…` : value;
}

function formatBalanceLine(summary, index = null, { includeUser = true } = {}) {
  return [
    index === null ? null : `${index}.`,
    includeUser ? `<@${summary.userId}>` : null,
    `錢包 ${formatCoins(summary.walletBalance)}`,
    `活存 ${formatCoins(summary.bankBalance)}`,
    `定存本金 ${formatCoins(summary.fixedPrincipal)}`,
    `定存利息 ${formatCoins(summary.fixedExpectedInterest)}`,
    `可領定存 ${formatCoins(summary.fixedClaimable)}`,
    `總資產 ${formatCoins(summary.totalAssets)}`,
  ]
    .filter(Boolean)
    .join('｜');
}

function formatFixedLine(deposit) {
  return [
    `#${deposit.id}`,
    `<@${deposit.userId}>`,
    `${formatCoins(deposit.principal)} / ${deposit.termDays} 天`,
    `利率 ${formatPercent(deposit.rate)}`,
    `利息 ${formatCoins(deposit.expectedInterest)}`,
    `狀態 ${deposit.displayStatus || deposit.status}`,
    `到期 ${formatTimestamp(deposit.maturityAt)}`,
  ].join('｜');
}

function formatPurchaseLine(purchase) {
  return [
    `#${purchase.id}`,
    `<@${purchase.userId}>`,
    `${purchase.itemName} x${purchase.quantity}`,
    formatCoins(purchase.totalPrice),
    formatItemType(purchase.itemType),
    purchase.status,
    purchase.expiresAt ? `期限 ${formatTimestamp(purchase.expiresAt)}` : '期限 無',
    formatTimestamp(purchase.createdAt),
  ].join('｜');
}

function formatInventoryLine(item) {
  return [
    `#${item.id}`,
    `<@${item.userId}>`,
    `${item.itemName} x${item.quantity}`,
    `商品 ID ${item.itemId}`,
    formatTimestamp(item.acquiredAt),
  ].join('｜');
}

function formatJobLine(job) {
  return [
    `#${job.id}`,
    `<@${job.userId}>`,
    job.jobName,
    job.status,
    `薪資 ${formatCoins(job.totalSalary)}`,
    `任務 ${job.todayCompletedTaskCount}/${job.todayTaskCount}`,
    `發薪 ${formatTimestamp(job.payAt)}`,
  ].join('｜');
}

function formatTaskLine(task) {
  return [
    `#${task.id}`,
    `<@${task.userId}>`,
    task.jobName,
    task.status,
    compact(task.description || task.taskType, 80),
    `建立 ${formatTimestamp(task.createdAt)}`,
  ].join('｜');
}

function formatPayrollLine(payroll) {
  return [
    `#${payroll.id}`,
    `<@${payroll.userId}>`,
    payroll.jobName,
    `發放 ${formatCoins(payroll.paidAmount)}`,
    `比例 ${(payroll.payRatio * 100).toFixed(1)}%`,
    `任務 ${payroll.completedTasks}/${payroll.totalTasks}`,
    formatTimestamp(payroll.createdAt),
    compact(payroll.reason, 80),
  ].join('｜');
}

function formatTransactionLine(transaction) {
  return [
    `#${transaction.id}`,
    `<@${transaction.userId}>`,
    transaction.type,
    formatCoins(transaction.amount),
    `${formatCoins(transaction.balanceBefore)} -> ${formatCoins(transaction.balanceAfter)}`,
    compact(transaction.reason, 80),
    formatTimestamp(transaction.createdAt),
  ].join('｜');
}

function formatRateLine(rate) {
  return [
    `#${rate.id}`,
    rate.rateKey,
    rate.termDays ? `${rate.termDays} 天` : '活存',
    `${formatPercent(rate.oldRate)} -> ${formatPercent(rate.newRate)}`,
    `操作者 <@${rate.operatorId}>`,
    rate.isEvent ? `活動到 ${formatTimestamp(rate.eventEndsAt)}` : '常態利率',
    compact(rate.reason, 80),
    formatTimestamp(rate.createdAt),
  ].join('｜');
}

function formatRateSummary(rates) {
  return [
    `活存日利率：${formatPercent(rates.demandRate)}`,
    ...Object.entries(rates.fixedRates).map(([term, rate]) => `定存 ${term} 天：${formatPercent(rate)}`),
    rates.activeEvents.length
      ? `活動利率：${rates.activeEvents.map((event) => `${event.rateKey} ${formatPercent(event.rate)} 到 ${formatTimestamp(event.eventEndsAt)}`).join('；')}`
      : '活動利率：無',
  ];
}

async function ensureAdmin(interaction) {
  return ensureModerationAccess(interaction, {
    userPermission: PermissionFlagsBits.Administrator,
    userPermissionName: 'Administrator',
  });
}

async function buildUserReport(interaction, user) {
  const [summary, fixed, purchases, inventory, work, payroll] = await Promise.all([
    getBalanceSummary(interaction.guildId, user.id),
    listFixedDeposits(interaction.guildId, { userId: user.id, includeClosed: true, limit: 25 }),
    getPurchaseHistory(interaction.guildId, user.id, { limit: 10 }),
    getInventory(interaction.guildId, user.id),
    getWorkStatus(interaction.guildId, user.id),
    getPayrollHistory(interaction.guildId, { userId: user.id, limit: 5 }),
  ]);
  const fixedOpen = fixed.filter((deposit) => ['active', 'matured'].includes(deposit.displayStatus || deposit.status)).length;
  const fixedClosed = fixed.length - fixedOpen;

  return [
    `**${formatUser(user)} 經濟資料**`,
    formatBalanceLine(summary, null, { includeUser: false }),
    `定存數量：${fixed.length} 筆（未結束 ${fixedOpen}，已結束 ${fixedClosed}）`,
    `購買紀錄：最近 ${purchases.length} 筆`,
    `擁有商品：${inventory.length} 種`,
    work.activeJob ? `目前職業：${work.activeJob.jobName}，任務 ${work.activeJob.todayCompletedTaskCount}/${work.activeJob.todayTaskCount}` : '目前職業：無',
    payroll.length ? `最近發薪：${formatCoins(payroll[0].paidAmount)}，${formatTimestamp(payroll[0].createdAt)}` : '最近發薪：無',
    '',
    '**最近購買**',
    purchases.length ? purchases.slice(0, 5).map(formatPurchaseLine).join('\n') : '無',
    '',
    '**擁有商品**',
    inventory.length ? inventory.slice(0, 8).map(formatInventoryLine).join('\n') : '無',
    '',
    '**定存紀錄**',
    fixed.length ? fixed.slice(0, 8).map(formatFixedLine).join('\n') : '無',
  ].join('\n');
}

async function buildAuditReport(interaction, type, user, limit) {
  if (type === 'balances') {
    const rows = user
      ? [await getBalanceSummary(interaction.guildId, user.id)]
      : await getAllBalanceSummaries(interaction.guildId, { limit });
    return rows.length ? ['**餘額與資產紀錄**', ...rows.map((row, index) => formatBalanceLine(row, user ? null : index + 1))].join('\n') : '沒有餘額資料。';
  }

  if (type === 'purchases') {
    const rows = await getAllPurchaseHistory(interaction.guildId, { userId: user?.id || null, limit });
    return rows.length ? ['**購買紀錄**', ...rows.map(formatPurchaseLine)].join('\n') : '沒有購買紀錄。';
  }

  if (type === 'fixed') {
    const rows = await listFixedDeposits(interaction.guildId, { userId: user?.id || null, includeClosed: true, limit });
    return rows.length ? ['**定存紀錄**', ...rows.map(formatFixedLine)].join('\n') : '沒有定存紀錄。';
  }

  if (type === 'inventory') {
    const rows = await getAllInventory(interaction.guildId, { userId: user?.id || null, limit });
    return rows.length ? ['**擁有商品紀錄**', ...rows.map(formatInventoryLine)].join('\n') : '沒有擁有商品紀錄。';
  }

  if (type === 'work') {
    if (user) {
      const status = await getWorkStatus(interaction.guildId, user.id);
      const lines = [
        `**${formatUser(user)} 職業紀錄**`,
        status.activeJob ? formatJobLine(status.activeJob) : '目前沒有進行中的工作。',
        status.recentTasks.length ? ['', '**最近工作任務**', ...status.recentTasks.map(formatTaskLine)].join('\n') : null,
      ].filter(Boolean);
      return lines.join('\n');
    }

    const rows = await getAllWorkStatuses(interaction.guildId, { limit });
    return rows.length ? ['**職業紀錄**', ...rows.map(formatJobLine)].join('\n') : '沒有職業紀錄。';
  }

  if (type === 'tasks') {
    const rows = await listWorkTasks(interaction.guildId, { userId: user?.id || null, limit });
    return rows.length ? ['**工作任務紀錄**', ...rows.map(formatTaskLine)].join('\n') : '沒有工作任務紀錄。';
  }

  if (type === 'payroll') {
    const rows = await getPayrollHistory(interaction.guildId, { userId: user?.id || null, limit });
    return rows.length ? ['**發薪紀錄**', ...rows.map(formatPayrollLine)].join('\n') : '沒有發薪紀錄。';
  }

  if (type === 'transactions') {
    const rows = await getAllTransactions(interaction.guildId, { userId: user?.id || null, limit });
    return rows.length ? ['**交易紀錄**', ...rows.map(formatTransactionLine)].join('\n') : '沒有交易紀錄。';
  }

  if (type === 'rates') {
    const rows = await getRateHistory(interaction.guildId, { limit });
    return rows.length ? ['**利率調整紀錄**', ...rows.map(formatRateLine)].join('\n') : '沒有利率調整紀錄。';
  }

  return '未知的查詢類型。';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('economy')
    .setDescription('吉幣經濟總覽與紀錄查詢')
    .addSubcommand((subcommand) => subcommand.setName('overview').setDescription('管理員查看經濟系統總覽'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('user')
        .setDescription('管理員查看指定使用者完整經濟資料')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('leaderboard')
        .setDescription('查看總資產排行榜')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('audit')
        .setDescription('管理員依類型查詢經濟紀錄')
        .addStringOption((option) => option.setName('type').setDescription('紀錄類型').setRequired(true).addChoices(...auditTypeChoices))
        .addUserOption((option) => option.setName('user').setDescription('限制指定使用者'))
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '經濟資料只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();

      if (subcommand !== 'leaderboard') {
        const access = await ensureAdmin(interaction);
        if (!access.ok) {
          return;
        }
      }

      if (subcommand === 'overview') {
        const [stats, rates, balances] = await Promise.all([
          getCoinDatabaseStats(interaction.guildId),
          getBankRates(interaction.guildId),
          getAllBalanceSummaries(interaction.guildId, { limit: 5 }),
        ]);
        const totalAssets = balances.reduce((sum, row) => sum + row.totalAssets, 0);

        await interaction.reply({
          content: [
            `**${interaction.guild.name} 經濟系統總覽**`,
            `玩家數：${stats.players}`,
            `商店商品數：${stats.shopItems}`,
            `購買紀錄數：${stats.purchases}`,
            `交易紀錄數：${stats.transactions}`,
            `前 ${balances.length} 名總資產合計：${formatCoins(totalAssets)}`,
            '',
            '**目前利率**',
            ...formatRateSummary(rates),
            '',
            '**資產前 5 名**',
            balances.length ? balances.map((row, index) => formatBalanceLine(row, index + 1)).join('\n') : '無',
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'user') {
        const user = interaction.options.getUser('user', true);
        await interaction.reply({
          content: await buildUserReport(interaction, user),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'leaderboard') {
        const limit = interaction.options.getInteger('limit') || 10;
        const balances = await getAllBalanceSummaries(interaction.guildId, { limit });

        await interaction.reply({
          content: balances.length
            ? [`**${interaction.guild.name} 總資產排行榜**`, ...balances.map((row, index) => formatBalanceLine(row, index + 1))].join('\n')
            : '目前沒有經濟資料。',
        });
        return;
      }

      if (subcommand === 'audit') {
        const type = interaction.options.getString('type', true);
        const user = interaction.options.getUser('user');
        const limit = interaction.options.getInteger('limit') || 10;

        await interaction.reply({
          content: await buildAuditReport(interaction, type, user, limit),
          ephemeral: true,
        });
      }
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
