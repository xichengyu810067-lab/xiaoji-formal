const { PermissionFlagsBits, SlashCommandBuilder } = require('discord.js');
const {
  JOB_TYPES,
  RESIGNATION_UNAVAILABLE_MESSAGE,
  TASK_STATUS,
  addPendingTask,
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
const {
  formatCoins,
  formatSourceGuild,
  formatUser,
  formatWorkStatus: statusLabel,
  isForeignPrimaryJob,
  isPrimaryPayrollVisibleTo,
  replyCoinError,
} = require('../utils/coinPresentation');
const { ensureModerationAccess } = require('../utils/moderation');
const { reportInteractionSecurityAlert } = require('../utils/securityAlert');
const { isBotOwner } = require('../utils/ownerOnly');
const { clipText, fitListText, fitReplyText, listRows, omittedLine } = require('../utils/replyLengthGuard');
const { workRoleCoordinator } = require('../coordinators/workRoleCoordinator');

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

// roleSync says whether an extension syncs the primary job's role. Without one the core syncs no job role, so the
// block says nothing about it. guildId is the server the command ran in: a primary job chosen in another server is
// shown as coming from "其他伺服器", without that server's ID.
function formatJobBlock(job, { includeUser = false, roleSync = false, guildId = null } = {}) {
  if (!job) {
    return '目前沒有進行中的工作。';
  }

  const jobType = JOB_TYPES.find((item) => item.name === job.jobName);

  if (job.scope === 'primary') {
    const fromThisServer = Boolean(job.sourceGuildId) && job.sourceGuildId === guildId;

    return [
      includeUser ? `使用者：<@${job.userId}>` : null,
      `全域主職：${job.jobName}`,
      includeUser ? `週期 ID：${job.globalCycleId}` : null,
      includeUser ? `選擇來源群${fromThisServer ? ' ID' : ''}：${formatSourceGuild(job.sourceGuildId, guildId)}` : null,
      `天數：${job.workDays} 天`,
      `狀態：${statusLabel(job.status)}`,
      job.status === 'pending_legacy' ? `最早生效：${formatTimestamp(job.notBeforeAt)}` : null,
      job.startAt ? `生效時間：${formatTimestamp(job.startAt)}` : null,
      job.payAt ? `本期結束：${formatTimestamp(job.payAt)}` : null,
      job.settledAmount == null ? '本期薪資：尚未結算' : `實際發放：${formatCoins(job.settledAmount)}`,
      roleSync ? '角色同步：由管理功能核對' : null,
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

// The line formatters take textLimit, how many characters the free text of the line (a task, a reason) may take. A
// long list passes a number to shorten every line; without it the line is shown as stored.
function formatTaskLine(task, { textLimit = Infinity } = {}) {
  return [
    `#${task.id}`,
    `<@${task.userId}>`,
    task.jobName,
    statusLabel(task.status),
    clipText(task.description || task.taskType, textLimit),
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

function formatPayrollLine(payroll, { textLimit = Infinity } = {}) {
  return [
    `#${payroll.id}`,
    `<@${payroll.userId}>`,
    payroll.jobName,
    `發放 ${formatCoins(payroll.paidAmount)}`,
    `比例 ${formatPercent(payroll.payRatio)}`,
    `任務 ${payroll.completedTasks}/${payroll.totalTasks}`,
    formatTimestamp(payroll.createdAt),
    clipText(payroll.reason, textLimit),
  ].join('｜');
}

function formatPayrollPreviewLine(item, { textLimit = Infinity } = {}) {
  return [
    `<@${item.job.userId}>`,
    item.job.jobName,
    `預估 ${formatCoins(item.paidAmount)} / ${formatCoins(item.baseSalary || item.job.totalSalary)}`,
    `比例 ${formatPercent(item.payRatio)}`,
    `有效提交 ${item.completedTasks}/${item.totalTasks}`,
    item.externalServerCount ? `外部伺服器 ${item.externalServerCount}` : null,
    `發薪 ${formatTimestamp(item.job.payAt)}`,
    clipText(item.reason, textLimit),
  ]
    .filter(Boolean)
    .join('｜');
}

// The global primary job's settlements, shown in /work payroll.
function formatPrimarySettlementLine(item, { textLimit = Infinity } = {}) {
  return item.jobName + '｜發放 ' + formatCoins(item.paidAmount) +
    '｜比例 ' + formatPercent(item.payRatio) +
    '｜' + formatTimestamp(item.settledAt) + '｜' + clipText(item.reason, textLimit);
}

function primaryRoleSync(interaction) {
  return workRoleCoordinator.hasWorkRoleHook(interaction.client, 'syncPrimaryJobRoleForMember');
}

function formatJobListBlock(jobs) {
  if (!jobs?.length) {
    return '目前沒有進行中的工作。';
  }

  return jobs.map((job) => formatJobBlock(job)).join('\n\n');
}

function formatPenaltyLine(penalty, { textLimit = Infinity } = {}) {
  return [
    `#${penalty.id}`,
    `<@${penalty.userId}>`,
    penalty.jobName,
    `扣薪 ${formatCoins(penalty.penaltyAmount)}`,
    `狀態 ${statusLabel(penalty.status)}`,
    `申訴期限 ${formatTimestamp(penalty.appealDeadlineAt)}`,
    penalty.appliedAt ? `已套用 ${formatTimestamp(penalty.appliedAt)}` : '尚未套用',
    clipText(penalty.reason, textLimit),
  ].join('｜');
}

// The global primary job's penalties, shown in /work penalties.
function formatPrimaryPenaltyLine(item, { textLimit = Infinity } = {}) {
  return '#' + item.id + '｜扣薪 ' + formatCoins(item.amount) +
    '｜狀態 ' + statusLabel(item.status) +
    '｜申訴期限 ' + formatTimestamp(item.appealDeadline) +
    '｜' + clipText(item.reason, textLimit);
}

// The reply of a list command: one line for every row under a heading. A task or a reason can be long, so when the
// lines do not fit one message the free text is shortened, and the last rows are left out with a line that says how
// many and how to narrow the list.
function rowsReply(heading, rows, render, { unit, hint = '' }) {
  return fitListText({
    header: heading,
    items: rows,
    render: (row, { textLimit }) => render(row, { textLimit }),
    note: (count) => omittedLine(count, { unit, hint }),
  });
}

// The lines of one list inside a reply that holds several; `cut` is what fitReplyText gave the reply being built.
function sectionRows(rows, render, cut, { unit, hint = '' }) {
  return listRows(rows, (row, { textLimit }) => render(row, { textLimit }), {
    textLimit: cut.textLimit,
    rowLimit: cut.rowLimit,
    note: (count) => omittedLine(count, { unit, hint }),
  });
}

// /work status and /work status-user: the jobs, the latest payrolls and the latest tasks of one member. The job
// blocks stay as they are; a task is the part that can be long. viewerGuildId is set when an administrator looks at
// another member: the global primary job (and its payroll) of that member is then left out when it was chosen in
// another server, so this server learns nothing about it.
function workStatusText({ heading, status, roleSync, recentTaskCount, unit = '筆任務', viewerGuildId = null }) {
  const recentTasks = status.recentTasks.slice(0, recentTaskCount);
  const primaryHidden = Boolean(viewerGuildId) && isForeignPrimaryJob(status.primaryStatusView, viewerGuildId);
  const primaryView = primaryHidden ? null : status.primaryStatusView;
  // The latest pay of a primary job is shown to another member's viewer only when its cycle was started in this server.
  const primaryPayroll = !viewerGuildId || isPrimaryPayrollVisibleTo(status.latestPrimaryPayroll, viewerGuildId)
    ? status.latestPrimaryPayroll : null;
  return fitReplyText((cut) => [
    heading,
    primaryView
      ? formatJobBlock(primaryView, { roleSync }) : null,
    status.activeJobs?.length
      ? formatJobListBlock(status.activeJobs)
      : primaryView ? null : primaryHidden ? '本伺服器沒有進行中的工作。' : '目前沒有進行中的工作。',
    status.latestPayroll
      ? ['', '**最近發薪紀錄**', formatPayrollLine(status.latestPayroll, { textLimit: cut.textLimit })].join('\n') : null,
    primaryPayroll ? ['', '**最近主職實際發薪**',
      primaryPayroll.jobName + '｜' + formatCoins(primaryPayroll.paidAmount) +
      '｜' + formatTimestamp(primaryPayroll.settledAt)].join('\n') : null,
    status.recentTasks.length
      ? ['', '**最近任務**', ...sectionRows(recentTasks, formatTaskLine, cut, {
        unit,
        hint: '可用 /work submissions 或 /work tasks 查看',
      })].join('\n')
      : null,
  ]
    .filter(Boolean)
    .join('\n'), { maxRows: recentTasks.length });
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
    .addSubcommand((subcommand) => subcommand.setName('cancel').setDescription('說明：目前不開放辭職，工作期滿後自動結算'))
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
        .addBooleanOption((option) => option.setName('force').setDescription('是否忽略 10 小時間隔直接提醒（結果不明後的冷卻仍然有效）'))
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
          content: workStatusText({
            heading: '**目前工作狀態**',
            status,
            roleSync: primaryRoleSync(interaction),
            recentTaskCount: 5,
          }),
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'status-user') {
        const user = interaction.options.getUser('user', true);
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          reportInteractionSecurityAlert('personal-data', interaction);
          await interaction.reply({ content: '只能查詢目前在此伺服器的成員。', ephemeral: true });
          return;
        }
        const status = await getWorkStatus(interaction.guildId, user.id);

        await interaction.reply({
          content: workStatusText({
            heading: `**${formatUser(user)} 的工作狀態**`,
            status,
            roleSync: primaryRoleSync(interaction),
            recentTaskCount: 8,
            viewerGuildId: interaction.guildId,
          }),
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
        // A member's global primary job chosen in another server is not shown to this one.
        const jobs = (await getAllWorkStatuses(interaction.guildId, {
          limit, visibleUserIds: members.keys(),
        })).filter((job) => !isForeignPrimaryJob(job, interaction.guildId));
        const roleSync = primaryRoleSync(interaction);

        await interaction.reply({
          content: jobs.length
            ? rowsReply(
              '**本群舊工作及目前本群成員的全域主職**',
              jobs,
              (job) => formatJobBlock(job, { includeUser: true, roleSync, guildId: interaction.guildId }).replaceAll('\n', '｜'),
              { unit: '筆工作紀錄' }
            )
            : '目前沒有工作紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'cancel') {
        // Resigning is not offered.  The command answers with the refusal itself (the same text
        // cancelJob refuses with); nothing is changed and no job role is touched.
        await interaction.reply({ content: RESIGNATION_UNAVAILABLE_MESSAGE, ephemeral: true });
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
          content: tasks.length
            ? rowsReply('**你的工作提交紀錄**', tasks, formatTaskLine, { unit: '筆提交紀錄', hint: '可用 status 選項縮小範圍' })
            : '目前沒有工作提交紀錄。',
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
        // A task is a duty with a deadline and a salary penalty, so it is only for a member of this server, like
        // status-user and role-sync. Somebody outside could never finish it in this server.
        const member = await interaction.guild.members.fetch(user.id).catch(() => null);
        if (!member) {
          await interaction.reply({ content: '只能指派工作任務給目前在此伺服器的成員。', ephemeral: true });
          return;
        }
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
          content: tasks.length
            ? rowsReply('**工作任務紀錄**', tasks, formatTaskLine, { unit: '筆任務紀錄', hint: '可用 status 選項縮小範圍' })
            : '目前沒有符合條件的工作任務紀錄。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'pending') {
        const limit = interaction.options.getInteger('limit') || 10;
        const tasks = await listPendingWorkSubmissions(interaction.guildId, { limit });

        await interaction.reply({
          content: tasks.length
            ? rowsReply('**待審核工作提交**', tasks, formatTaskLine, { unit: '筆待審核提交', hint: '審核完前面的提交後才會顯示' })
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

        if (result.busy) {
          await interaction.editReply('工作提醒正在處理中，請稍後再試。');
          return;
        }
        await interaction.editReply([
          !result.guardDisabled ? `提醒檢查完成：檢查 ${result.checked} 筆，成功送出 ${result.reminded} 筆。`
            : result.reminded ? `工作提醒防護目前未啟用：本次只送出 ${result.reminded} 筆，其餘提醒未送出。`
              : '工作提醒防護目前未啟用，未送出任何提醒。',
          result.failed ? `另有 ${result.failed} 項處理失敗，部分提醒可能已送出，詳情已記錄在本機 log。` : null,
          result.deferred ? `另有 ${result.deferred} 筆因先前失敗暫緩，可改用 force 重試。` : null,
        ].filter(Boolean).join('\n'));
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
          // A global primary job chosen in another server is not shown to this one: it counts as no job here.
          const jobs = (await getActiveJobs(interaction.guildId, user.id))
            .filter((job) => !isForeignPrimaryJob(job, interaction.guildId));
          if (!jobs.length) {
            await interaction.editReply(`${formatUser(user)} 目前沒有進行中的工作。`);
            return;
          }
          const legacyJobs = jobs.filter((job) => job.scope === 'legacy' &&
            job.roleSyncEligible && job.sourceGuildId === interaction.guildId);
          const primaryJob = jobs.find((job) => job.scope === 'primary');

          const results = [];
          for (const job of legacyJobs) {
            results.push(await workRoleCoordinator.runWorkRoleHook(interaction.client, 'syncJobRoleForMember', {
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
            results.push(await workRoleCoordinator.runWorkRoleHook(interaction.client, 'syncPrimaryJobRoleForMember', {
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

        const result = await workRoleCoordinator.runWorkRoleHook(interaction.client, 'syncAllJobRoles', { guild: interaction.guild }, {
          total: 0,
          synced: 0,
          warnings: [],
          skipped: true,
        });
        // An extension that stops the run early (the request boundary deferred a role change for its budget, or the guild's
        // role queue was full) says so with rateLimited and, for a full queue, queueFull. Then not every role was synced,
        // so the title must not claim the sync is complete. The reason is already the first of its warnings.
        const paused = result.rateLimited === true || result.queueFull === true;
        await interaction.editReply([
          `${paused ? '工作身分組同步已暫停，尚未全部完成' : '工作身分組同步完成'}：${result.synced}/${result.total}`,
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
          content: items.length
            ? rowsReply('**工作發薪預覽**', items, formatPayrollPreviewLine, { unit: '筆發薪預覽', hint: '可用 user 選項指定成員' })
            : '目前沒有可預覽的工作發薪資料。',
          ephemeral: true,
        });
        return;
      }

      if (subcommand === 'payroll-history') {
        const user = interaction.options.getUser('user');
        const limit = interaction.options.getInteger('limit') || 10;
        const history = await getPayrollHistory(interaction.guildId, { userId: user?.id || null, limit });

        await interaction.reply({
          content: history.length
            ? rowsReply('**工作發薪紀錄**', history, formatPayrollLine, { unit: '筆發薪紀錄', hint: '可用 user 選項指定成員' })
            : '目前沒有工作發薪紀錄。',
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

        // Three lists in one message. When they do not fit, the reasons are shortened and each list shows fewer rows,
        // with a line under it that says how many were left out.
        await interaction.reply({
          content: fitReplyText((cut) => [
            primaryHistory.length
              ? ['**全域主職結算**', ...sectionRows(primaryHistory, formatPrimarySettlementLine, cut, { unit: '筆主職結算' })].join('\n')
              : '**全域主職結算**\n目前沒有結算紀錄。',
            preview.length
              ? ['**待發薪預覽**', ...sectionRows(preview, formatPayrollPreviewLine, cut, { unit: '筆發薪預覽' })].join('\n')
              : '**待發薪預覽**\n目前沒有待發薪工作。',
            history.length
              ? ['**最近發薪紀錄**', ...sectionRows(history, formatPayrollLine, cut, { unit: '筆發薪紀錄' })].join('\n')
              : '**最近發薪紀錄**\n目前沒有發薪紀錄。',
          ].join('\n\n'), { maxRows: Math.max(primaryHistory.length, preview.length, history.length) }),
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
        // Two lists in one message. A reason can be long, so when they do not fit the reasons are shortened and each
        // list shows fewer rows, with a line under it that says how many were left out.
        const content = legacy.length || primary.length
          ? fitReplyText((cut) => [
            legacy.length ? ['**原群扣薪**', ...sectionRows(legacy, formatPenaltyLine, cut, { unit: '筆扣薪紀錄' })].join('\n') : null,
            primary.length
              ? ['**全域主職扣薪**', ...sectionRows(primary, formatPrimaryPenaltyLine, cut, { unit: '筆扣薪紀錄' })].join('\n')
              : null,
          ].filter(Boolean).join('\n\n'), { maxRows: Math.max(legacy.length, primary.length) })
          : '目前沒有扣薪紀錄。';
        await interaction.reply({ content, ephemeral: true });
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
