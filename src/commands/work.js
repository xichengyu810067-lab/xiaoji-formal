const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  JOB_TYPES,
  TASK_STATUS,
  addPendingTask,
  cancelJob,
  createWorkPenaltyAppeal,
  createPrimaryPenaltyAppeal,
  deleteWorkSubmission,
  editWorkSubmission,
  getActiveJobs,
  getAllWorkStatuses,
  getPayrollHistory,
  getPrimaryPayrollHistory,
  getWorkStatus,
  listWorkPenalties,
  listPrimaryPenalties,
  listPendingWorkSubmissions,
  listJobs,
  listWorkTasks,
  previewPayroll,
  processWorkReminders,
  reportWork,
  reviewWorkPenaltyAppeal,
  reviewPrimaryPenaltyAppeal,
  reviewWorkSubmission,
  startJob,
  startVenueJobs,
} = require('../services/workService');
const { formatCoins, formatUser, replyCoinError } = require('../utils/coinPresentation');
const { ensureModerationAccess } = require('../utils/moderation');
const { isBotOwner } = require('../utils/ownerOnly');
const { getClientExtensionHost } = require('../extensions/extensionHost');

async function runWorkRoleHook(client, hookName, payload, fallback = { ok: true, skipped: true, role: null, warnings: [] }) {
  const results = await getClientExtensionHost(client).runHook(`workRole.${hookName}`, payload);
  return results.find((item) => item.result !== undefined)?.result || fallback;
}

const taskStatusChoices = [
  { name: '待審核', value: TASK_STATUS.PENDING },
  { name: '已核准', value: TASK_STATUS.APPROVED },
  { name: '已駁回', value: TASK_STATUS.REJECTED },
  { name: '已刪除', value: TASK_STATUS.DELETED },
  { name: '已發薪', value: TASK_STATUS.PAID },
  { name: '已完成（舊紀錄）', value: TASK_STATUS.COMPLETED },
  { name: '小吉接手完成', value: TASK_STATUS.SYSTEM_COMPLETED },
  { name: '已逾期', value: TASK_STATUS.EXPIRED },
  { name: '已取消', value: TASK_STATUS.CANCELED },
  { name: '無工作可做', value: TASK_STATUS.NO_WORK_AVAILABLE },
];

function formatTimestamp(isoString) {
  if (!isoString) {
    return '無';
  }

  const timestamp = Math.floor(new Date(isoString).getTime() / 1000);
  return `<t:${timestamp}:F> (<t:${timestamp}:R>)`;
}

function formatPercent(value) {
  return `${(Number(value || 0) * 100).toFixed(1)}%`;
}

function statusLabel(status) {
  const labels = {
    active: '進行中',
    paid: '已發薪',
    canceled: '已取消',
    failed: '發薪失敗',
    pending: '待審核',
    approved: '已核准',
    rejected: '已駁回',
    deleted: '已刪除',
    completed: '已完成',
    system_completed: '小吉接手完成',
    expired: '已逾期',
    cancelled: '已取消',
    no_work_available: '無工作可做',
    pending_legacy: '等待舊工作結清',
    closed: '本期已結束',
  };

  return labels[status] || status || '未知';
}

function addOptionalUserLimitOptions(subcommand) {
  return subcommand
    .addUserOption((option) => option.setName('user').setDescription('要查詢的使用者'))
    .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25));
}

function addTaskStatusOption(subcommand) {
  return subcommand.addStringOption((option) =>
    option.setName('status').setDescription('任務狀態').addChoices(...taskStatusChoices)
  );
}

function formatRoleWarnings(warnings) {
  if (!warnings?.length) {
    return [];
  }

  return ['', '**身分組提醒**', ...warnings.map((warning) => `• ${warning}`)];
}

function formatJobBlock(job, { includeUser = false } = {}) {
  if (!job) {
    return '目前沒有進行中的工作。';
  }

  const jobType = JOB_TYPES.find((item) => item.name === job.jobName);

  if (job.scope === 'primary') {
    return [
      includeUser ? `使用者：<@${job.userId}>` : null,
      `全域主職：${job.jobName}`,
      includeUser ? `週期 ID：${job.globalCycleId}` : null,
      includeUser ? `選擇來源群 ID：${job.sourceGuildId}` : null,
      `天數：${job.workDays} 天`,
      `狀態：${statusLabel(job.status)}`,
      job.status === 'pending_legacy' ? `最早生效：${formatTimestamp(job.notBeforeAt)}` : null,
      job.startAt ? `生效時間：${formatTimestamp(job.startAt)}` : null,
      job.payAt ? `本期結束：${formatTimestamp(job.payAt)}` : null,
      job.settledAmount == null ? '本期薪資：尚未結算' : `實際發放：${formatCoins(job.settledAmount)}`,
      '角色同步：由私有擴充核對',
    ].filter(Boolean).join('\n');
  }

  return [
    includeUser ? `使用者：<@${job.userId}>` : null,
    `職業：${job.jobName}`,
    jobType?.rank ? `官階：${jobType.rank}` : null,
    jobType?.reportChannelName ? `回報頻道：#${jobType.reportChannelName}` : null,
    `天數：${job.workDays} 天`,
    `每日薪水：${formatCoins(job.dailySalary)}`,
    `預計總薪水：${formatCoins(job.totalSalary)}`,
    `開始時間：${formatTimestamp(job.startAt)}`,
    `預計發薪：${formatTimestamp(job.payAt)}`,
    `狀態：${statusLabel(job.status)}`,
    `任務數：${job.todayTaskCount}，已完成：${job.todayCompletedTaskCount}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function formatTaskLine(task) {
  return [
    `#${task.id}`,
    `<@${task.userId}>`,
    task.jobName,
    statusLabel(task.status),
    task.description || task.taskType,
    task.expectedChannelName ? `頻道 #${task.expectedChannelName}` : null,
    task.externalServerCount ? `外部伺服器 ${task.externalServerCount}` : null,
    task.attachmentUrls?.length ? `附件 ${task.attachmentUrls.length}` : null,
    task.paidAt ? `發薪 ${formatTimestamp(task.paidAt)}` : null,
    `建立 ${formatTimestamp(task.createdAt)}`,
    task.updatedAt && task.updatedAt !== task.createdAt ? `更新 ${formatTimestamp(task.updatedAt)}` : null,
  ]
    .filter(Boolean)
    .join('｜');
}

function formatPayrollLine(payroll) {
  return [
    `#${payroll.id}`,
    `<@${payroll.userId}>`,
    payroll.jobName,
    `發放 ${formatCoins(payroll.paidAmount)}`,
    `比例 ${formatPercent(payroll.payRatio)}`,
    `任務 ${payroll.completedTasks}/${payroll.totalTasks}`,
    formatTimestamp(payroll.createdAt),
    payroll.reason,
  ].join('｜');
}

function formatPayrollPreviewLine(item) {
  return [
    `<@${item.job.userId}>`,
    item.job.jobName,
    `預估 ${formatCoins(item.paidAmount)} / ${formatCoins(item.baseSalary || item.job.totalSalary)}`,
    `比例 ${formatPercent(item.payRatio)}`,
    `有效提交 ${item.completedTasks}/${item.totalTasks}`,
    item.externalServerCount ? `外部伺服器 ${item.externalServerCount}` : null,
    `發薪 ${formatTimestamp(item.job.payAt)}`,
    item.reason,
  ]
    .filter(Boolean)
    .join('｜');
}

function formatJobListBlock(jobs) {
  if (!jobs?.length) {
    return '目前沒有進行中的工作。';
  }

  return jobs.map((job) => formatJobBlock(job)).join('\n\n');
}

function formatPenaltyLine(penalty) {
  return [
    `#${penalty.id}`,
    `<@${penalty.userId}>`,
    penalty.jobName,
    `扣薪 ${formatCoins(penalty.penaltyAmount)}`,
    `狀態 ${statusLabel(penalty.status)}`,
    `申訴期限 ${formatTimestamp(penalty.appealDeadlineAt)}`,
    penalty.appliedAt ? `已套用 ${formatTimestamp(penalty.appliedAt)}` : '尚未套用',
    penalty.reason,
  ].join('｜');
}

async function ensureAdmin(interaction) {
  return ensureModerationAccess(interaction, {
    userPermission: PermissionFlagsBits.Administrator,
    userPermissionName: 'Administrator',
  });
}

function canManageWorkSubmission(interaction) {
  return Boolean(
    isBotOwner(interaction.user.id) ||
      interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)
  );
}

function getSubmissionContext(interaction) {
  const proof = interaction.options.getAttachment?.('proof') || null;

  return {
    channelId: interaction.channelId || null,
    channelName: interaction.channel?.name || null,
    messageId: interaction.id || null,
    attachmentUrls: proof?.url ? [proof.url] : [],
  };
}

function getExternalServerInput(interaction) {
  return {
    externalServerCount: interaction.options.getInteger('external-servers') || 0,
    externalServerIds: interaction.options.getString('external-server-ids') || '',
  };
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('work')
    .setDescription('小吉工作賺取吉幣系統')
    .addSubcommand((subcommand) => subcommand.setName('list').setDescription('顯示所有可選職業與薪水'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start')
        .setDescription('選擇下一期唯一主職')
        .addStringOption((option) =>
          option
            .setName('job')
            .setDescription('職業名稱')
            .setRequired(true)
            .addChoices(...JOB_TYPES.map((job) => ({ name: `${job.name} (日薪 ${job.salary})`, value: job.name })))
        )
        .addIntegerOption((option) =>
          option.setName('days').setDescription('工作天數 (1-30 天)').setRequired(true).setMinValue(1).setMaxValue(30)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('start-venue')
        .setDescription('選擇一種場館主職')
        .addIntegerOption((option) =>
          option.setName('days').setDescription('共同工作天數 (1-30 天)').setRequired(true).setMinValue(1).setMaxValue(30)
        )
        .addBooleanOption((option) => option.setName('chef').setDescription('是否擔任廚師'))
        .addBooleanOption((option) => option.setName('bartender').setDescription('是否擔任調酒師'))
        .addStringOption((option) =>
          option
            .setName('waiter')
            .setDescription('服務生職業')
            .addChoices(
              { name: '不擔任服務生', value: 'none' },
              { name: '服務生', value: '服務生' },
              { name: '制服服務生', value: '制服服務生' }
            )
        )
    )
    .addSubcommand((subcommand) => subcommand.setName('status').setDescription('查詢自己目前進行中的工作'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status-user')
        .setDescription('管理員查詢指定使用者工作狀態')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('status-all')
        .setDescription('管理員查詢伺服器工作紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) => subcommand.setName('cancel').setDescription('查詢舊工作取消限制'))
    .addSubcommand((subcommand) =>
      subcommand
        .setName('submit')
        .setDescription('提交今日工作內容與證明')
        .addStringOption((option) => option.setName('content').setDescription('工作內容').setRequired(true).setMaxLength(1000))
        .addAttachmentOption((option) => option.setName('proof').setDescription('截圖或附件證明'))
        .addIntegerOption((option) => option.setName('task-id').setDescription('要完成的待辦 ID').setMinValue(1))
        .addStringOption((option) => option.setName('task-type').setDescription('任務類型，例如公告、翻譯、整理').setMaxLength(80))
        .addIntegerOption((option) =>
          option.setName('external-servers').setDescription('翻譯官外部伺服器任務數').setMinValue(0).setMaxValue(30)
        )
        .addStringOption((option) =>
          option.setName('external-server-ids').setDescription('翻譯官外部伺服器 ID 或名稱，逗號分隔').setMaxLength(500)
        )
    )
    .addSubcommand((subcommand) =>
      addTaskStatusOption(
        subcommand
          .setName('submissions')
          .setDescription('查看自己的工作提交紀錄')
          .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
      )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('edit')
        .setDescription('修改自己的工作提交內容')
        .addIntegerOption((option) => option.setName('submission-id').setDescription('提交紀錄 ID').setRequired(true).setMinValue(1))
        .addStringOption((option) => option.setName('content').setDescription('新的工作內容').setRequired(true).setMaxLength(1000))
        .addAttachmentOption((option) => option.setName('proof').setDescription('新的截圖或附件證明'))
        .addIntegerOption((option) =>
          option.setName('external-servers').setDescription('翻譯官外部伺服器任務數').setMinValue(0).setMaxValue(30)
        )
        .addStringOption((option) =>
          option.setName('external-server-ids').setDescription('翻譯官外部伺服器 ID 或名稱，逗號分隔').setMaxLength(500)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('delete')
        .setDescription('刪除一筆工作提交紀錄')
        .addIntegerOption((option) => option.setName('submission-id').setDescription('提交紀錄 ID').setRequired(true).setMinValue(1))
        .addStringOption((option) => option.setName('reason').setDescription('刪除原因').setMaxLength(300))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('report')
        .setDescription('回報工作產出或回報目前沒有可執行工作')
        .addStringOption((option) =>
          option
            .setName('mode')
            .setDescription('回報類型')
            .addChoices(
              { name: '完成工作', value: 'completed' },
              { name: '目前沒有可執行工作', value: 'no-work-available' }
            )
        )
        .addStringOption((option) => option.setName('task-type').setDescription('任務類型，例如公告、翻譯、整理').setMaxLength(80))
        .addStringOption((option) => option.setName('description').setDescription('工作內容摘要').setMaxLength(500))
        .addAttachmentOption((option) => option.setName('proof').setDescription('截圖或附件證明'))
        .addIntegerOption((option) => option.setName('task-id').setDescription('要完成的待辦 ID').setMinValue(1))
        .addIntegerOption((option) =>
          option.setName('external-servers').setDescription('翻譯官外部伺服器任務數').setMinValue(0).setMaxValue(30)
        )
        .addStringOption((option) =>
          option.setName('external-server-ids').setDescription('翻譯官外部伺服器 ID 或名稱，逗號分隔').setMaxLength(500)
        )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('task-add')
        .setDescription('管理員指派一筆待完成工作任務')
        .addUserOption((option) => option.setName('user').setDescription('目標使用者').setRequired(true))
        .addStringOption((option) => option.setName('description').setDescription('任務內容').setRequired(true).setMaxLength(500))
        .addStringOption((option) => option.setName('task-type').setDescription('任務類型').setMaxLength(80))
        .addIntegerOption((option) =>
          option.setName('due-hours').setDescription('幾小時後提醒，預設 10').setMinValue(1).setMaxValue(72)
        )
    )
    .addSubcommand((subcommand) =>
      addTaskStatusOption(
        subcommand
          .setName('tasks')
          .setDescription('查詢自己的工作任務紀錄')
          .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
      )
    )
    .addSubcommand((subcommand) =>
      addTaskStatusOption(
        addOptionalUserLimitOptions(subcommand.setName('tasks-all').setDescription('管理員查詢工作任務紀錄'))
      )
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('pending')
        .setDescription('管理員查看待審核工作提交')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('review')
        .setDescription('管理員核准或駁回工作提交')
        .addIntegerOption((option) => option.setName('submission-id').setDescription('提交紀錄 ID').setRequired(true).setMinValue(1))
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('審核動作')
            .setRequired(true)
            .addChoices(
              { name: '核准', value: TASK_STATUS.APPROVED },
              { name: '駁回', value: TASK_STATUS.REJECTED }
            )
        )
        .addStringOption((option) => option.setName('reason').setDescription('審核原因').setMaxLength(300))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('admin-remind')
        .setDescription('管理員手動檢查並發送工作提醒')
        .addBooleanOption((option) => option.setName('force').setDescription('是否忽略 10 小時間隔直接提醒'))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('role-sync')
        .setDescription('同步工作職業身分組')
        .addUserOption((option) => option.setName('user').setDescription('只同步指定使用者'))
    )
    .addSubcommand((subcommand) =>
      addOptionalUserLimitOptions(subcommand.setName('payroll-preview').setDescription('管理員預覽目前工作發薪結果'))
    )
    .addSubcommand((subcommand) =>
      addOptionalUserLimitOptions(subcommand.setName('payroll-history').setDescription('管理員查詢工作發薪紀錄'))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('payroll')
        .setDescription('查看自己的工作發薪紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('penalties')
        .setDescription('查看自己的扣薪紀錄')
        .addIntegerOption((option) => option.setName('limit').setDescription('筆數，預設 10').setMinValue(1).setMaxValue(25))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('appeal')
        .setDescription('申訴一筆扣薪紀錄')
        .addStringOption((option) => option.setName('scope').setDescription('扣薪類型').setRequired(true)
          .addChoices({ name: '舊工作', value: 'legacy' }, { name: '全域主職', value: 'primary' }))
        .addIntegerOption((option) => option.setName('penalty-id').setDescription('扣薪 ID').setRequired(true).setMinValue(1))
        .addStringOption((option) => option.setName('reason').setDescription('申訴事由').setRequired(true).setMaxLength(1000))
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName('appeal-review')
        .setDescription('擁有者審核扣薪申訴')
        .addStringOption((option) => option.setName('scope').setDescription('申訴類型').setRequired(true)
          .addChoices({ name: '舊工作', value: 'legacy' }, { name: '全域主職', value: 'primary' }))
        .addIntegerOption((option) => option.setName('appeal-id').setDescription('申訴 ID').setRequired(true).setMinValue(1))
        .addStringOption((option) =>
          option
            .setName('action')
            .setDescription('審核結果')
            .setRequired(true)
            .addChoices({ name: '通過', value: 'approved' }, { name: '駁回', value: 'rejected' })
        )
        .addStringOption((option) => option.setName('reason').setDescription('審核原因').setMaxLength(500))
    ),

  async execute(interaction) {
    try {
      if (!interaction.inGuild()) {
        await interaction.reply({ content: '工作系統只能在伺服器內使用。', ephemeral: true });
        return;
      }

      const subcommand = interaction.options.getSubcommand();
      const adminSubcommands = new Set([
        'status-user',
        'status-all',
        'task-add',
        'tasks-all',
        'pending',
        'review',
        'admin-remind',
        'role-sync',
        'payroll-preview',
        'payroll-history',
      ]);

      if (adminSubcommands.has(subcommand)) {
        const access = await ensureAdmin(interaction);
        if (!access.ok) {
          return;
        }
      }

      if (subcommand === 'list') {
        const info = await listJobs();
        const lines = info.jobs.map((job) =>
          [
            `• **${job.name}**｜${job.rank}｜每日 ${formatCoins(job.salary)}｜回報 #${job.reportChannelName}`,
            `  ${job.description}`,
          ].join('\n')
        );

        await interaction.reply({
          content: [
            '**小吉職業清單**',
            ...lines,
            '',
            `• 最短工作天數：${info.minDays} 天`,
            `• 最長工作天數：${info.maxDays} 天`,
            `• 發薪時間：${info.payTime}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'start' || subcommand === 'start-venue') {
        await interaction.deferReply({ ephemeral: true });
        const days = interaction.options.getInteger('days', true);
        const selection = subcommand === 'start'
          ? await startJob(interaction.guildId, interaction.user.id, interaction.options.getString('job', true), days)
          : await startVenueJobs(interaction.guildId, interaction.user.id, {
            days,
            chef: interaction.options.getBoolean('chef') || false,
            bartender: interaction.options.getBoolean('bartender') || false,
            waiter: interaction.options.getString('waiter') || 'none',
          });
        await interaction.editReply({
          content: [
            selection.alreadySelected ? '你已選擇這份下一期主職。' : '已記錄下一期主職選擇。',
            '職業：' + selection.jobName,
            '天數：' + selection.workDays + ' 天',
            '舊工作仍依原群、原規則處理；全部結清後才會啟動新週期。',
            '最早生效：' + formatTimestamp(selection.notBeforeAt),
            '選擇本身不建立新工作或變更身分組。',
          ].join('\n'),
        });
        return;
      }
      if (subcommand === 'status') {
        const status = await getWorkStatus(interaction.guildId, interaction.user.id);

        await interaction.reply({
          content: [
            '**目前工作狀態**',
            status.primaryStatusView ? formatJobBlock(status.primaryStatusView) : null,
            status.activeJobs?.length
              ? formatJobListBlock(status.activeJobs)
              : status.primaryStatusView ? null : '目前沒有進行中的工作。',
            status.latestPayroll ? ['', '**最近發薪紀錄**', formatPayrollLine(status.latestPayroll)].join('\n') : null,
            status.latestPrimaryPayroll ? ['', '**最近主職實際發薪**',
              status.latestPrimaryPayroll.jobName + '｜' + formatCoins(status.latestPrimaryPayroll.paidAmount) +
              '｜' + formatTimestamp(status.latestPrimaryPayroll.settledAt)].join('\n') : null,
            status.recentTasks.length ? ['', '**最近任務**', ...status.recentTasks.slice(0, 5).map(formatTaskLine)].join('\n') : null,
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'status-user') {
        const user = interaction.options.getUser('user', true);
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          await interaction.reply({ content: '只能查詢目前在此伺服器的成員。', ephemeral: true });
          return;
        }
        const status = await getWorkStatus(interaction.guildId, user.id);

        await interaction.reply({
          content: [
            `**${formatUser(user)} 的工作狀態**`,
            status.primaryStatusView ? formatJobBlock(status.primaryStatusView) : null,
            status.activeJobs?.length ? formatJobListBlock(status.activeJobs) : null,
            !status.primaryStatusView && !status.activeJobs?.length ? '目前沒有進行中的工作。' : null,
            status.latestPayroll ? ['', '**最近發薪紀錄**', formatPayrollLine(status.latestPayroll)].join('\n') : null,
            status.latestPrimaryPayroll ? ['', '**最近主職實際發薪**',
              status.latestPrimaryPayroll.jobName + '｜' + formatCoins(status.latestPrimaryPayroll.paidAmount) +
              '｜' + formatTimestamp(status.latestPrimaryPayroll.settledAt)].join('\n') : null,
            status.recentTasks.length ? ['', '**最近任務**', ...status.recentTasks.slice(0, 8).map(formatTaskLine)].join('\n') : null,
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'status-all') {
        const limit = interaction.options.getInteger('limit') || 10;
        const members = await interaction.guild.members.fetch().catch(() => null);
        if (!members || Number.isSafeInteger(interaction.guild.memberCount) &&
            members.size < interaction.guild.memberCount) {
          await interaction.reply({ content: '目前無法核對本群成員，已暫停全域工作總覽。', ephemeral: true });
          return;
        }
        const jobs = await getAllWorkStatuses(interaction.guildId, {
          limit, visibleUserIds: members.keys(),
        });
        const lines = jobs.map((job) => formatJobBlock(job, { includeUser: true }).replaceAll('\n', '｜'));

        await interaction.reply({
          content: jobs.length ? ['**本群舊工作及目前本群成員的全域主職**', ...lines].join('\n') : '目前沒有工作紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'cancel') {
        await interaction.deferReply({ ephemeral: true });
        const job = await cancelJob(interaction.guildId, interaction.user.id);
        const member = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        const roleResult = member
          ? await runWorkRoleHook(interaction.client, 'removeJobRolesForMember', { member })
          : { warnings: ['找不到你的成員資料，無法移除職業身分組。'] };

        await interaction.editReply({
          content: [
            `你已取消 **${(job.cancelledJobs || [job]).map((item) => item.jobName).join('、')}** 的工作。取消後將不會發放任何薪水。`,
            ...formatRoleWarnings(roleResult.warnings),
          ].join('\n'),
        });
        return;
      }

      if (subcommand === 'submit') {
        const result = await reportWork(interaction.guildId, interaction.user.id, {
          taskId: interaction.options.getInteger('task-id'),
          taskType: interaction.options.getString('task-type') || 'work_submit',
          description: interaction.options.getString('content', true),
          ...getSubmissionContext(interaction),
          ...getExternalServerInput(interaction),
        });

        await interaction.reply({
          content: [
            '已收到你的工作內容，狀態為待審核。你可以在發薪前修改或刪除這筆提交。',
            `提交 ID：#${result.task.id}`,
            `職業：${result.job.jobName}`,
            `回報頻道：#${result.task.expectedChannelName || result.job.jobName}`,
            result.task.externalServerCount ? `外部伺服器任務：${result.task.externalServerCount}` : null,
          ]
            .filter(Boolean)
            .join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'submissions') {
        const status = interaction.options.getString('status');
        const limit = interaction.options.getInteger('limit') || 10;
        const tasks = await listWorkTasks(interaction.guildId, {
          userId: interaction.user.id,
          status,
          limit,
        });

        await interaction.reply({
          content: tasks.length ? ['**你的工作提交紀錄**', ...tasks.map(formatTaskLine)].join('\n') : '目前沒有工作提交紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'edit') {
        const task = await editWorkSubmission(interaction.guildId, interaction.user.id, interaction.options.getInteger('submission-id', true), {
          description: interaction.options.getString('content', true),
          attachmentUrls: getSubmissionContext(interaction).attachmentUrls,
          ...getExternalServerInput(interaction),
          canManage: canManageWorkSubmission(interaction),
        });

        await interaction.reply({
          content: [
            '已更新你的工作內容，這筆紀錄已重新進入待審核狀態。',
            formatTaskLine(task),
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'delete') {
        const task = await deleteWorkSubmission(
          interaction.guildId,
          interaction.user.id,
          interaction.options.getInteger('submission-id', true),
          {
            reason: interaction.options.getString('reason') || '使用者刪除工作內容',
            canManage: canManageWorkSubmission(interaction),
          }
        );

        await interaction.reply({
          content: [
            task.userId === interaction.user.id
              ? '已刪除你的工作內容。這筆紀錄不會列入發薪計算。'
              : '已刪除該使用者的工作內容。這筆紀錄不會列入發薪計算。',
            formatTaskLine(task),
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'report') {
        const mode = interaction.options.getString('mode') || 'completed';
        const result = await reportWork(interaction.guildId, interaction.user.id, {
          taskId: interaction.options.getInteger('task-id'),
          taskType: interaction.options.getString('task-type') || 'work_report',
          description: interaction.options.getString('description') || '',
          noWorkAvailable: mode === 'no-work-available',
          ...getSubmissionContext(interaction),
          ...getExternalServerInput(interaction),
        });

        await interaction.reply({
          content: [
            mode === 'no-work-available'
              ? '已記錄：目前沒有可執行工作。'
              : '已收到你的工作內容，狀態為待審核。你可以在發薪前修改或刪除這筆提交。',
            `職業：${result.job.jobName}`,
            `任務：#${result.task.id} ${statusLabel(result.task.status)}`,
            `內容：${result.task.description}`,
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'task-add') {
        const user = interaction.options.getUser('user', true);
        const task = await addPendingTask(interaction.guildId, user.id, {
          description: interaction.options.getString('description', true),
          taskType: interaction.options.getString('task-type') || 'admin_task',
          dueHours: interaction.options.getInteger('due-hours') || 10,
        });

        await interaction.reply({
          content: ['工作任務已指派。', formatTaskLine(task)].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'tasks' || subcommand === 'tasks-all') {
        const user = subcommand === 'tasks-all' ? interaction.options.getUser('user') : interaction.user;
        const status = interaction.options.getString('status');
        const limit = interaction.options.getInteger('limit') || 10;
        const tasks = await listWorkTasks(interaction.guildId, {
          userId: user?.id || null,
          status,
          limit,
        });

        await interaction.reply({
          content: tasks.length ? ['**工作任務紀錄**', ...tasks.map(formatTaskLine)].join('\n') : '目前沒有符合條件的工作任務紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'pending') {
        const limit = interaction.options.getInteger('limit') || 10;
        const tasks = await listPendingWorkSubmissions(interaction.guildId, { limit });

        await interaction.reply({
          content: tasks.length
            ? ['**待審核工作提交**', ...tasks.map(formatTaskLine)].join('\n')
            : '目前沒有待審核的工作提交。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'review') {
        const action = interaction.options.getString('action', true);
        const task = await reviewWorkSubmission(interaction.guildId, interaction.user.id, interaction.options.getInteger('submission-id', true), {
          action,
          reason: interaction.options.getString('reason') || '',
        });

        await interaction.reply({
          content: [
            action === TASK_STATUS.APPROVED ? '已核准這筆工作提交。' : '已駁回這筆工作提交。',
            formatTaskLine(task),
          ].join('\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'admin-remind') {
        await interaction.deferReply({ ephemeral: true });
        const force = interaction.options.getBoolean('force') || false;
        const result = await processWorkReminders(interaction.client, { guildId: interaction.guildId, force });

        await interaction.editReply(`提醒檢查完成：檢查 ${result.checked} 筆，成功送出 ${result.reminded} 筆。`);
        return;
      }

      if (subcommand === 'role-sync') {
        await interaction.deferReply({ ephemeral: true });
        const user = interaction.options.getUser('user');

        if (user) {
          const member = await interaction.guild.members.fetch(user.id).catch(() => null);
          if (!member) {
            await interaction.editReply(`找不到 ${formatUser(user)} 的伺服器成員資料。`);
            return;
          }
          const jobs = await getActiveJobs(interaction.guildId, user.id);
          if (!jobs.length) {
            await interaction.editReply(`${formatUser(user)} 目前沒有進行中的工作。`);
            return;
          }
          const legacyJobs = jobs.filter((job) => job.scope === 'legacy' &&
            job.roleSyncEligible && job.sourceGuildId === interaction.guildId);
          const primaryJob = jobs.find((job) => job.scope === 'primary');

          const results = [];
          for (const job of legacyJobs) {
            results.push(await runWorkRoleHook(interaction.client, 'syncJobRoleForMember', {
              member,
              jobName: job.jobName,
              options: {
                jobId: job.id,
                sourceGuildId: job.sourceGuildId,
                triggerGuildId: interaction.guildId,
              },
            }));
          }
          if (primaryJob?.status === 'active' && primaryJob.sourceGuildId === interaction.guildId) {
            results.push(await runWorkRoleHook(interaction.client, 'syncPrimaryJobRoleForMember', {
              member,
              jobName: primaryJob.jobName,
              options: { cycleId: primaryJob.globalCycleId, sourceGuildId: primaryJob.sourceGuildId },
            }));
          }
          const warnings = results.flatMap((result) => result.warnings || []);
          await interaction.editReply([
            results.length ? `${formatUser(user)} 的職業身分組同步檢查完成。` : '沒有可同步的來源群職業身分組。',
            legacyJobs.length ? `原群職業：${legacyJobs.map((job) => job.jobName).join('、')}` : null,
            primaryJob ? `全域主職：${primaryJob.jobName}；僅來源群可核對角色同步。` : null,
            ...formatRoleWarnings(warnings),
          ].filter(Boolean).join('\n'));
          return;
        }

        const result = await runWorkRoleHook(interaction.client, 'syncAllJobRoles', { guild: interaction.guild }, {
          total: 0,
          synced: 0,
          warnings: [],
          skipped: true,
        });
        await interaction.editReply([
          `工作身分組同步完成：${result.synced}/${result.total}`,
          result.cleaned ? `已清理結束週期角色：${result.cleaned}` : null,
          ...formatRoleWarnings(result.warnings.slice(0, 10)),
        ].filter(Boolean).join('\n'));
        return;
      }

      if (subcommand === 'payroll-preview') {
        const user = interaction.options.getUser('user');
        const limit = interaction.options.getInteger('limit') || 10;
        const items = await previewPayroll(interaction.guildId, { userId: user?.id || null, limit });

        await interaction.reply({
          content: items.length ? ['**工作發薪預覽**', ...items.map(formatPayrollPreviewLine)].join('\n') : '目前沒有可預覽的工作發薪資料。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'payroll-history') {
        const user = interaction.options.getUser('user');
        const limit = interaction.options.getInteger('limit') || 10;
        const history = await getPayrollHistory(interaction.guildId, { userId: user?.id || null, limit });

        await interaction.reply({
          content: history.length ? ['**工作發薪紀錄**', ...history.map(formatPayrollLine)].join('\n') : '目前沒有工作發薪紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'payroll') {
        const limit = interaction.options.getInteger('limit') || 10;
        const [history, preview, primaryHistory] = await Promise.all([
          getPayrollHistory(interaction.guildId, { userId: interaction.user.id, limit }),
          previewPayroll(interaction.guildId, { userId: interaction.user.id, limit: 3 }),
          getPrimaryPayrollHistory(interaction.user.id, { limit }),
        ]);

        await interaction.reply({
          content: [
            primaryHistory.length
              ? ['**全域主職結算**', ...primaryHistory.map((item) =>
                item.jobName + '｜發放 ' + formatCoins(item.paidAmount) +
                '｜比例 ' + formatPercent(item.payRatio) +
                '｜' + formatTimestamp(item.settledAt) + '｜' + item.reason
              )].join('\n')
              : '**全域主職結算**\n目前沒有結算紀錄。',
            preview.length ? ['**待發薪預覽**', ...preview.map(formatPayrollPreviewLine)].join('\n') : '**待發薪預覽**\n目前沒有待發薪工作。',
            history.length ? ['**最近發薪紀錄**', ...history.map(formatPayrollLine)].join('\n') : '**最近發薪紀錄**\n目前沒有發薪紀錄。',
          ].join('\n\n'),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'penalties') {
        const limit = interaction.options.getInteger('limit') || 10;
        const [legacy, primary] = await Promise.all([
          listWorkPenalties(interaction.guildId, { userId: interaction.user.id, limit }),
          listPrimaryPenalties(interaction.user.id, { limit }),
        ]);
        const lines = [
          legacy.length ? ['**原群扣薪**', ...legacy.map(formatPenaltyLine)].join('\n') : null,
          primary.length ? ['**全域主職扣薪**', ...primary.map((item) =>
            '#' + item.id + '｜扣薪 ' + formatCoins(item.amount) +
            '｜狀態 ' + statusLabel(item.status) +
            '｜申訴期限 ' + formatTimestamp(item.appealDeadline) +
            '｜' + item.reason
          )].join('\n') : null,
        ].filter(Boolean);
        await interaction.reply({ content: lines.length ? lines.join('\n\n') : '目前沒有扣薪紀錄。', ephemeral: true });
        return;
      }

      if (subcommand === 'appeal') {
        const scope = interaction.options.getString('scope', true);
        const penaltyId = interaction.options.getInteger('penalty-id', true);
        const reason = interaction.options.getString('reason', true);
        const result = scope === 'primary'
          ? await createPrimaryPenaltyAppeal(interaction.user.id, penaltyId, { reason })
          : await createWorkPenaltyAppeal(interaction.guildId, interaction.user.id, penaltyId, { reason });
        const appealId = scope === 'primary' ? result.appealId : result.appeal.id;
        await interaction.reply({
          content: '已送出' + (scope === 'primary' ? '全域主職' : '原群工作') +
            '扣薪申訴 #' + appealId + '，請等待擁有者審核。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'appeal-review') {
        if (!isBotOwner(interaction.user.id)) {
          await interaction.reply({ content: '只有小吉擁有者可以審核扣薪申訴。', ephemeral: true });
          return;
        }
        const scope = interaction.options.getString('scope', true);
        const appealId = interaction.options.getInteger('appeal-id', true);
        const review = {
          action: interaction.options.getString('action', true),
          reason: interaction.options.getString('reason') || '',
        };
        const result = scope === 'primary'
          ? await reviewPrimaryPenaltyAppeal(interaction.user.id, appealId, review)
          : await reviewWorkPenaltyAppeal(interaction.guildId, interaction.user.id, appealId, review);
        const status = scope === 'primary' ? result.status : result.appeal.status;
        await interaction.reply({
          content: '申訴 #' + appealId + ' 已' + (status === 'approved' ? '通過' : '駁回') + '。' +
            (result.refund ? ' 已補發：' + formatCoins(result.refund.grossAmount || result.refund.amount) : ''),
          ephemeral: true,
        });
        return;
      }    } catch (error) {
      await replyCoinError(interaction, error);
    }
  },
};
