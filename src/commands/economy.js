const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  getAllInventory,
  getAllPurchaseHistory,
  getAllTransactions,
  getCoinDatabaseStats,
  readInventory,
} = require('../services/coinService');
const {
  getAllBalanceSummaries,
  getBankRates,
  getRateHistory,
  listFixedDeposits,
  readBalanceSummary,
} = require('../services/bankService');
const {
  getAllWorkStatuses,
  getPayrollHistory,
  getWorkStatus,
  listWorkTasks,
} = require('../services/workService');
const {
  formatCoins,
  formatFixedDepositStatus,
  formatItemType,
  formatPurchaseStatus,
  formatRateKey,
  formatSourceGuild,
  formatTransactionReason,
  formatTransactionType,
  formatUser,
  formatWorkStatus,
  isForeignPrimaryJob,
  isPrimaryPayrollVisibleTo,
  replyCoinError,
} = require('../utils/coinPresentation');
const { ensureModerationAccess } = require('../utils/moderation');
const { reportInteractionSecurityAlert } = require('../utils/securityAlert');
const { clipText, fitListText, fitReplyText, listRows, omittedLine } = require('../utils/replyLengthGuard');

const NOT_A_MEMBER_MESSAGE = '只能查詢目前在此伺服器的成員。';

// An administrator asking for the data of somebody who is not in this server: refused, and reported to the Owner as
// a request for personal or other-server data (one fixed notice per guild and hour).
function notAMember(interaction) {
  reportInteractionSecurityAlert('personal-data', interaction);
  return NOT_A_MEMBER_MESSAGE;
}
// What a note under a list says when the list is for every member: the user option narrows it to one.
const AUDIT_USER_HINT = '可用 user 選項指定成員後再查';
// The longest a reason or a description is shown in an audit line before a long list shortens it further.
const AUDIT_TEXT_LIMIT = 80;
// These record types are one person's global data (wallet and bank, fixed deposits, inventory), so a lookup of
// one user is only for a member of this server. The other types are already limited to this server's own rows.
const MEMBER_ONLY_AUDIT_TYPES = new Set(['balances', 'fixed', 'inventory']);

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
    `狀態 ${formatFixedDepositStatus(deposit.displayStatus || deposit.status)}`,
    `到期 ${formatTimestamp(deposit.maturityAt)}`,
  ].join('｜');
}

// The line formatters take textLimit, how many characters the free text of the line (an item name, a description or
// a reason) may take. A long list passes a number to shorten every line; without it the line is shown as stored.
function formatPurchaseLine(purchase, { textLimit = Infinity } = {}) {
  return [
    `#${purchase.id}`,
    `<@${purchase.userId}>`,
    `${clipText(purchase.itemName, textLimit)} x${purchase.quantity}`,
    formatCoins(purchase.totalPrice),
    formatItemType(purchase.itemType),
    formatPurchaseStatus(purchase.status),
    purchase.expiresAt ? `期限 ${formatTimestamp(purchase.expiresAt)}` : '期限 無',
    formatTimestamp(purchase.createdAt),
  ].join('｜');
}

function formatInventoryLine(item, { textLimit = Infinity } = {}) {
  return [
    `#${item.id}`,
    `<@${item.userId}>`,
    `${clipText(item.itemName, textLimit)} x${item.quantity}`,
    `商品 ID ${item.itemId}`,
    formatTimestamp(item.acquiredAt),
  ].join('｜');
}

// guildId is the server the command ran in: a primary job chosen in another server does not show that server's ID.
function formatJobLine(job, guildId) {
  if (job.scope === 'primary') {
    return [
      `<@${job.userId}>`, '全域主職', job.jobName,
      job.status === 'pending_legacy' ? '等待舊工作結清' : job.status === 'active' ? '進行中' : '已結束',
      `來源群 ${formatSourceGuild(job.sourceGuildId, guildId)}`,
      job.settledAmount == null ? '薪資尚未結算' : `實際發放 ${formatCoins(job.settledAmount)}`,
      job.payAt ? `本期結束 ${formatTimestamp(job.payAt)}` : null,
    ].filter(Boolean).join('｜');
  }
  return [
    `#${job.id}`,
    `<@${job.userId}>`,
    job.jobName,
    formatWorkStatus(job.status),
    `薪資 ${formatCoins(job.totalSalary)}`,
    `任務 ${job.todayCompletedTaskCount}/${job.todayTaskCount}`,
    `發薪 ${formatTimestamp(job.payAt)}`,
  ].join('｜');
}

function formatTaskLine(task, { textLimit = Infinity } = {}) {
  return [
    `#${task.id}`,
    `<@${task.userId}>`,
    task.jobName,
    formatWorkStatus(task.status),
    compact(task.description || task.taskType, Math.min(AUDIT_TEXT_LIMIT, textLimit)),
    `建立 ${formatTimestamp(task.createdAt)}`,
  ].join('｜');
}

function formatPayrollLine(payroll, { textLimit = Infinity } = {}) {
  return [
    `#${payroll.id}`,
    `<@${payroll.userId}>`,
    payroll.jobName,
    `發放 ${formatCoins(payroll.paidAmount)}`,
    `比例 ${(payroll.payRatio * 100).toFixed(1)}%`,
    `任務 ${payroll.completedTasks}/${payroll.totalTasks}`,
    formatTimestamp(payroll.createdAt),
    compact(payroll.reason, Math.min(AUDIT_TEXT_LIMIT, textLimit)),
  ].join('｜');
}

function formatTransactionLine(transaction, { textLimit = Infinity } = {}) {
  return [
    `#${transaction.id}`,
    `<@${transaction.userId}>`,
    formatTransactionType(transaction.type),
    formatCoins(transaction.amount),
    `${formatCoins(transaction.balanceBefore)} -> ${formatCoins(transaction.balanceAfter)}`,
    compact(formatTransactionReason(transaction.reason), Math.min(AUDIT_TEXT_LIMIT, textLimit)),
    formatTimestamp(transaction.createdAt),
  ].join('｜');
}

function formatRateLine(rate, { textLimit = Infinity } = {}) {
  return [
    `#${rate.id}`,
    formatRateKey(rate.rateKey),
    `${formatPercent(rate.oldRate)} -> ${formatPercent(rate.newRate)}`,
    `操作者 <@${rate.operatorId}>`,
    rate.isEvent ? `活動到 ${formatTimestamp(rate.eventEndsAt)}` : '常態利率',
    compact(formatTransactionReason(rate.reason), Math.min(AUDIT_TEXT_LIMIT, textLimit)),
    formatTimestamp(rate.createdAt),
  ].join('｜');
}

function formatRateSummary(rates) {
  return [
    `活存日利率：${formatPercent(rates.demandRate)}`,
    ...Object.entries(rates.fixedRates).map(([term, rate]) => `定存 ${term} 天：${formatPercent(rate)}`),
    rates.activeEvents.length
      ? `活動利率：${rates.activeEvents.map((event) => `${formatRateKey(event.rateKey)} ${formatPercent(event.rate)} 到 ${formatTimestamp(event.eventEndsAt)}`).join('；')}`
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
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  if (!member) return notAMember(interaction);
  // Looking at somebody must not file them under this guild, so the balance and inventory are read-only reads,
  // and the purchases are the ones made in this server, like the purchase audit.
  const [summary, fixed, purchases, inventory, work, payroll] = await Promise.all([
    readBalanceSummary(interaction.guildId, user.id),
    listFixedDeposits(interaction.guildId, { userId: user.id, includeClosed: true, limit: 25 }),
    getAllPurchaseHistory(interaction.guildId, { userId: user.id, limit: 10 }),
    readInventory(interaction.guildId, user.id),
    getWorkStatus(interaction.guildId, user.id),
    getPayrollHistory(interaction.guildId, { userId: user.id, limit: 5 }),
  ]);
  const fixedOpen = fixed.filter((deposit) => ['active', 'matured'].includes(deposit.displayStatus || deposit.status)).length;
  const fixedClosed = fixed.length - fixedOpen;
  // A global primary job chosen in another server is left out whole, with its payroll: this server must not learn
  // what job the member holds elsewhere.
  const primaryHidden = isForeignPrimaryJob(work.primaryStatusView, interaction.guildId);
  const activePrimary = primaryHidden ? null : work.activePrimaryJob;
  const primaryPayroll = isPrimaryPayrollVisibleTo(work.latestPrimaryPayroll, interaction.guildId)
    ? work.latestPrimaryPayroll : null;
  const currentJob = primaryHidden ? work.activeJobs?.[0] || null : work.activeJob;

  // The three lists at the end (purchases, owned items, fixed deposits) are what makes this report long. When the
  // report does not fit one message, item names are shortened and then each list shows fewer rows, with a line that
  // says how many were left out and where the full list is.
  const section = (rows, shown, render, { textLimit, rowLimit }, unit, auditType) => (rows.length
    ? listRows(rows.slice(0, shown), (row, cut) => render(row, { textLimit: cut.textLimit }), {
      textLimit,
      rowLimit,
      totalCount: rows.length,
      note: (count) => omittedLine(count, { unit, hint: `可用 /economy audit 的${auditType}類型查看` }),
    })
    : ['無']);

  return fitReplyText((limits) => [
    `**${formatUser(user)} 經濟資料**`,
    formatBalanceLine(summary, null, { includeUser: false }),
    `定存數量：${fixed.length} 筆（未結束 ${fixedOpen}，已結束 ${fixedClosed}）`,
    `購買紀錄：最近 ${purchases.length} 筆`,
    `擁有商品：${inventory.length} 種`,
    activePrimary
      ? `目前全域主職：${activePrimary.jobName}，來源群 ${formatSourceGuild(activePrimary.sourceGuildId, interaction.guildId)}`
      : currentJob ? `目前職業：${currentJob.jobName}，任務 ${currentJob.todayCompletedTaskCount}/${currentJob.todayTaskCount}`
        : primaryHidden ? '本伺服器沒有進行中的工作。'
          : work.primaryStatusView?.status === 'pending_legacy'
            ? `下一期全域主職：${work.primaryStatusView.jobName}，等待舊工作結清`
            : '目前職業：無',
    payroll.length ? `最近發薪：${formatCoins(payroll[0].paidAmount)}，${formatTimestamp(payroll[0].createdAt)}` : '最近發薪：無',
    primaryPayroll ? `最近主職實際發薪：${formatCoins(primaryPayroll.paidAmount)}，${formatTimestamp(primaryPayroll.settledAt)}` : null,
    '',
    '**最近購買**',
    ...section(purchases, 5, formatPurchaseLine, limits, '筆購買紀錄', '購買紀錄'),
    '',
    '**擁有商品**',
    ...section(inventory, 8, formatInventoryLine, limits, '種商品', '擁有商品'),
    '',
    '**定存紀錄**',
    ...section(fixed, 8, formatFixedLine, limits, '筆定存', '定存紀錄'),
  ].join('\n'), { maxRows: 8 });
}

async function buildAuditReport(interaction, type, user, limit) {
  if (user && MEMBER_ONLY_AUDIT_TYPES.has(type)) {
    const member = await interaction.guild.members.fetch(user.id).catch(() => null);
    if (!member) return notAMember(interaction);
  }

  // One line per row under a heading. When the lines do not fit one message the free text in them is shortened and
  // then the last rows are left out with a line that says how many; with a user the list is already one member's.
  const listed = (heading, rows, render, unit) => fitListText({
    header: heading,
    items: rows,
    render,
    note: (count) => omittedLine(count, { unit, hint: user ? '' : AUDIT_USER_HINT }),
  });

  if (type === 'balances') {
    const rows = user
      ? [await readBalanceSummary(interaction.guildId, user.id)]
      : await getAllBalanceSummaries(interaction.guildId, { limit });
    return rows.length
      ? listed('**餘額與資產紀錄**', rows, (row, { index }) => formatBalanceLine(row, user ? null : index + 1), '筆餘額資料')
      : '沒有餘額資料。';
  }

  if (type === 'purchases') {
    const rows = await getAllPurchaseHistory(interaction.guildId, { userId: user?.id || null, limit });
    return rows.length
      ? listed('**購買紀錄**', rows, (row, { textLimit }) => formatPurchaseLine(row, { textLimit }), '筆購買紀錄')
      : '沒有購買紀錄。';
  }

  if (type === 'fixed') {
    const rows = await listFixedDeposits(interaction.guildId, { userId: user?.id || null, includeClosed: true, limit });
    return rows.length ? listed('**定存紀錄**', rows, (row) => formatFixedLine(row), '筆定存') : '沒有定存紀錄。';
  }

  if (type === 'inventory') {
    const rows = await getAllInventory(interaction.guildId, { userId: user?.id || null, limit });
    return rows.length
      ? listed('**擁有商品紀錄**', rows, (row, { textLimit }) => formatInventoryLine(row, { textLimit }), '筆擁有商品紀錄')
      : '沒有擁有商品紀錄。';
  }

  if (type === 'work') {
    if (user) {
      const member = await interaction.guild.members.fetch(user.id).catch(() => null);
      if (!member) return notAMember(interaction);
      const status = await getWorkStatus(interaction.guildId, user.id);
      // A global primary job chosen in another server is left out whole.
      const primaryHidden = isForeignPrimaryJob(status.primaryStatusView, interaction.guildId);
      const primaryView = primaryHidden ? null : status.primaryStatusView;
      return fitReplyText(({ textLimit, rowLimit }) => [
        `**${formatUser(user)} 職業紀錄**`,
        primaryView ? formatJobLine(primaryView, interaction.guildId) : null,
        status.activeJobs.length ? status.activeJobs.map((job) => formatJobLine(job, interaction.guildId)).join('\n') : null,
        !primaryView && !status.activeJobs.length
          ? (primaryHidden ? '本伺服器沒有進行中的工作。' : '目前沒有進行中的工作。') : null,
        status.recentTasks.length
          ? ['', '**最近工作任務**', ...listRows(status.recentTasks, (task, cut) => formatTaskLine(task, { textLimit: cut.textLimit }), {
            textLimit,
            rowLimit,
            note: (count) => omittedLine(count, { unit: '筆任務', hint: '可用 /economy audit 的工作任務類型查看' }),
          })].join('\n')
          : null,
      ].filter(Boolean).join('\n'), { maxRows: status.recentTasks.length });
    }

    const members = await interaction.guild.members.fetch().catch(() => null);
    if (!members || Number.isSafeInteger(interaction.guild.memberCount) &&
        members.size < interaction.guild.memberCount) {
      return '目前無法核對本群完整成員名單，已暫停全域工作總覽。';
    }
    // A member's global primary job chosen in another server is not shown to this one.
    const rows = (await getAllWorkStatuses(interaction.guildId, {
      limit, visibleUserIds: members.keys(),
    })).filter((job) => !isForeignPrimaryJob(job, interaction.guildId));
    return rows.length
      ? listed('**本群舊工作及目前本群成員的全域主職**', rows, (job) => formatJobLine(job, interaction.guildId), '筆職業紀錄')
      : '沒有職業紀錄。';
  }

  if (type === 'tasks') {
    const rows = await listWorkTasks(interaction.guildId, { userId: user?.id || null, limit });
    return rows.length
      ? listed('**工作任務紀錄**', rows, (row, { textLimit }) => formatTaskLine(row, { textLimit }), '筆工作任務紀錄')
      : '沒有工作任務紀錄。';
  }

  if (type === 'payroll') {
    const rows = await getPayrollHistory(interaction.guildId, { userId: user?.id || null, limit });
    return rows.length
      ? listed('**發薪紀錄**', rows, (row, { textLimit }) => formatPayrollLine(row, { textLimit }), '筆發薪紀錄')
      : '沒有發薪紀錄。';
  }

  if (type === 'transactions') {
    const rows = await getAllTransactions(interaction.guildId, { userId: user?.id || null, limit });
    return rows.length
      ? listed('**交易紀錄**', rows, (row, { textLimit }) => formatTransactionLine(row, { textLimit }), '筆交易紀錄')
      : '沒有交易紀錄。';
  }

  if (type === 'rates') {
    // The rate history is the server's, not a member's: the user option does not narrow it, so there is no hint.
    const rows = await getRateHistory(interaction.guildId, { limit });
    return rows.length
      ? fitListText({
        header: '**利率調整紀錄**',
        items: rows,
        render: (row, { textLimit }) => formatRateLine(row, { textLimit }),
        note: (count) => omittedLine(count, { unit: '筆利率調整紀錄' }),
      })
      : '沒有利率調整紀錄。';
  }

  return '未知的查詢類型。';
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('economy')
    .setDescription('吉幣經濟總覽與紀錄查詢')
    // Hides the command from members without Administrator. The check in execute stays the real guard.
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    // default_member_permissions does not apply in DMs, so a command that is only for servers is kept out of them.
    .setDMPermission(false)
    .addSubcommand((subcommand) => subcommand.setName('overview').setDescription('管理員查看經濟系統總覽'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('user')
        .setDescription('管理員查看指定使用者完整經濟資料')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
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

      // Every /economy subcommand is for administrators; the member leaderboard is /leaderboard.
      const access = await ensureAdmin(interaction);
      if (!access.ok) {
        return;
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

      if (subcommand === 'audit') {
        const type = interaction.options.getString('type', true);
        const user = interaction.options.getUser('user');
        const limit = interaction.options.getInteger('limit') || 10;

        await interaction.reply({
          content: await buildAuditReport(interaction, type, user, limit),
          ephemeral: true,
        });
        return;
      }

      // Nothing above matched. A client that cached the removed /economy leaderboard can still send
      // it, and an interaction left unanswered shows "The application did not respond". Only
      // administrators get this far (the check above refuses everyone else), so tell them privately
      // where the board moved.
      await interaction.reply({
        content: subcommand === 'leaderboard'
          ? '/economy leaderboard 已移除，請改用 /leaderboard type:assets 查看總資產排行榜。'
          : '找不到這個子指令，請重新整理 Discord 後再試。',
        ephemeral: true,
      });
    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
