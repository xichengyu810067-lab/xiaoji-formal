const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  CoinServiceError,
  TransactionType,
  ensureGuildSettings,
  ensurePlayer,
  insertAdminLog,
} = require('./coinService');
const { mutateWalletWithApi } = require('./coinWalletService');
const logger = require('../utils/logger');

const JOB_TYPES = Object.freeze([
  {
    name: '會計師',
    salary: 500,
    rank: '正一品官員',
    roleName: '小吉會計師',
    reportChannelName: '會計師',
    description: '權管吉幣動向，需於每日 22:00 前彙整完畢並發布。',
  },
  {
    name: '老師',
    salary: 400,
    rank: '正二品官員',
    roleName: '小吉老師',
    reportChannelName: '老師',
    description: '權管學術交流。每日需分享 3 個不重複的新知識，學科不拘。',
  },
  {
    name: '翻譯官',
    salary: 300,
    rank: '正三品官員',
    roleName: '小吉翻譯官',
    reportChannelName: '翻譯官',
    externalServerBonus: 200,
    description:
      '權管翻譯外交事務。基本日薪 300 吉幣；每成功處理 1 個外部伺服器任務，額外加發 200 吉幣。',
  },
  {
    name: '小幫手',
    salary: 200,
    rank: '正四品官員',
    roleName: '小吉小幫手',
    reportChannelName: '小幫手',
    description: '權管本朝各種雜事。每日最多承接 3 件一般雜務，不包含其他職業的專職工作。',
  },
  {
    name: '清潔工',
    salary: 100,
    rank: '正五品官員',
    roleName: '小吉清潔工',
    reportChannelName: '清潔工',
    description: '權管本朝整潔。負責檢查指定頻道、回報洗版或錯頻訊息，維持頻道乾淨。',
  },
  {
    name: '迎賓員',
    salary: 50,
    rank: '正六品官員',
    roleName: '小吉迎賓員',
    reportChannelName: '迎賓員',
    description: '權管本朝接待。有新人時發送歡迎訊息；無新人時可透過簡單活絡聊天完成工作。',
  },
  {
    name: '廚師',
    salary: 70,
    rank: '正七品官員',
    roleName: '小吉廚師',
    reportChannelName: '廚師',
    description: '權管賭場餐廳餐點製作。被指派餐點後需親自送出製作過程。',
  },
  {
    name: '調酒師',
    salary: 60,
    rank: '正八品官員',
    roleName: '小吉調酒師',
    reportChannelName: '調酒師',
    description: '權管賭場吧檯飲品製作。被指派飲品後需親自送出製作過程。',
  },
  {
    name: '服務生',
    salary: 0,
    rank: '賭場服務人員',
    roleName: '小吉服務生',
    reportChannelName: '服務生',
    description: '負責賭場餐廳與吧檯送餐送酒。無底薪，收入來自使用者小費，最低小費 50 籌碼。',
  },
  {
    name: '制服服務生',
    salary: 0,
    rank: '賭場制服服務人員',
    roleName: '小吉制服服務生',
    reportChannelName: '服務生',
    description: '負責賭場餐廳與吧檯送餐送酒。無底薪，收入來自使用者小費，最低小費 100 籌碼。',
  },
]);

const JOB_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAID: 'paid',
  CANCELED: 'canceled',
  FAILED: 'failed',
});

const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
  DELETED: 'deleted',
  PAID: 'paid',
  COMPLETED: 'completed',
  SYSTEM_COMPLETED: 'system_completed',
  EXPIRED: 'expired',
  CANCELED: 'cancelled',
  NO_WORK_AVAILABLE: 'no_work_available',
});

const PenaltyStatus = Object.freeze({
  ACTIVE: 'active',
  CANCELED: 'canceled',
  APPEALED: 'appealed',
});

const AppealStatus = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  REJECTED: 'rejected',
});

const PAYROLL_STATUS = Object.freeze({
  PENDING: 'pending',
  PAID: 'paid',
  CANCELED: 'cancelled',
  FAILED: 'failed',
});

const MIN_WORK_DAYS = 1;
const MAX_WORK_DAYS = 30;
const PAY_TIME_LABEL = '22:00 (台灣時間)';
const WORK_REMINDER_HOURS = 10;
const WORK_AUTO_COMPLETE_HOURS = 24;
const APPEAL_WINDOW_DAYS = 14;
const MAX_DESCRIPTION_LENGTH = 1000;
const MAX_EXTERNAL_SERVER_COUNT = 30;
const BASIC_SALARY_RATIO = 0.75;
const VENUE_JOB_NAMES = Object.freeze(['廚師', '調酒師', '服務生', '制服服務生']);
const WAITER_JOB_NAMES = Object.freeze(['服務生', '制服服務生']);
const VALID_PAYROLL_TASK_STATUSES = Object.freeze([
  TASK_STATUS.PENDING,
  TASK_STATUS.APPROVED,
  TASK_STATUS.COMPLETED,
  TASK_STATUS.NO_WORK_AVAILABLE,
]);

function nowIso() {
  return new Date().toISOString();
}

function addHoursIso(dateInput, hours) {
  const date = new Date(dateInput);
  date.setTime(date.getTime() + hours * 60 * 60 * 1000);
  return date.toISOString();
}

function addDaysIso(dateInput, days) {
  const date = new Date(dateInput);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function getTaiwanDateParts(date = new Date()) {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = formatter.formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));

  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
  };
}

function getTaiwanDateLabel(date = new Date()) {
  const parts = getTaiwanDateParts(date);
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

function calculatePayTime(startDate, days) {
  const parts = getTaiwanDateParts(new Date(startDate));
  return new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days, 14, 0, 0)).toISOString();
}

function getJobType(jobName) {
  return JOB_TYPES.find((job) => job.name === jobName) || null;
}

function isVenueJobName(jobName) {
  return VENUE_JOB_NAMES.includes(jobName);
}

function isWaiterJobName(jobName) {
  return WAITER_JOB_NAMES.includes(jobName);
}

function normalizeWorkDays(days) {
  const workDays = Math.floor(Number(days));
  if (!Number.isSafeInteger(workDays) || workDays < MIN_WORK_DAYS || workDays > MAX_WORK_DAYS) {
    throw new CoinServiceError('INVALID_DAYS', `工作天數必須介於 ${MIN_WORK_DAYS} 到 ${MAX_WORK_DAYS} 天之間。`);
  }
  return workDays;
}

function insertJobWithCycle(api, { guildId, userId, jobType, workDays, startAt, payAt }) {
  const totalSalary = jobType.salary * workDays;

  api.run(
    `INSERT INTO coin_jobs (
      guild_id, user_id, job_name, job_role_id, daily_salary, work_days, total_salary,
      status, is_paid, start_at, pay_at, last_contribution_at, today_task_count,
      today_completed_task_count, no_work_available_today, payroll_status, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, 0, ?, ?, NULL, 0, 0, 0, ?, ?, ?)`,
    [
      guildId,
      userId,
      jobType.name,
      jobType.salary,
      workDays,
      totalSalary,
      JOB_STATUS.ACTIVE,
      startAt,
      payAt,
      PAYROLL_STATUS.PENDING,
      startAt,
      startAt,
    ]
  );

  const id = Number(api.get('SELECT last_insert_rowid() AS id').id);
  return mapJob(api.get('SELECT * FROM coin_jobs WHERE id = ?', [id]));
}

function mapJob(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    jobName: row.job_name,
    jobRoleId: row.job_role_id || null,
    dailySalary: Number(row.daily_salary),
    workDays: Number(row.work_days),
    totalSalary: Number(row.total_salary),
    status: row.status,
    isPaid: Boolean(row.is_paid),
    startAt: row.start_at,
    payAt: row.pay_at,
    actualPaidAt: row.actual_paid_at || null,
    lastContributionAt: row.last_contribution_at || null,
    lastReminderAt: row.last_reminder_at || null,
    todayTaskCount: Number(row.today_task_count || 0),
    todayCompletedTaskCount: Number(row.today_completed_task_count || 0),
    noWorkAvailableToday: Boolean(row.no_work_available_today),
    payrollStatus: row.payroll_status || PAYROLL_STATUS.PENDING,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row) {
  const attachmentUrls = parseJsonArray(row.attachment_urls);
  const externalServerIds = parseJsonArray(row.external_server_ids);

  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    jobId: row.job_id === null || row.job_id === undefined ? null : Number(row.job_id),
    jobName: row.job_name,
    taskType: row.task_type,
    status: row.status,
    description: row.description || '',
    attachmentUrls,
    expectedChannelId: row.expected_channel_id || null,
    expectedChannelName: row.expected_channel_name || null,
    messageId: row.message_id || null,
    externalServerCount: Number(row.external_server_count || externalServerIds.length || 0),
    externalServerIds,
    reviewedBy: row.reviewed_by || null,
    reviewReason: row.review_reason || null,
    isPaid: Boolean(row.is_paid),
    paidAt: row.paid_at || null,
    paidAmount: Number(row.paid_amount || 0),
    createdAt: row.created_at,
    dueAt: row.due_at,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at || row.created_at,
    deletedAt: row.deleted_at || null,
    reminderCount: Number(row.reminder_count || 0),
    lastReminderAt: row.last_reminder_at || null,
  };
}

function mapPayroll(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    jobId: Number(row.job_id),
    jobName: row.job_name,
    baseSalary: Number(row.base_salary),
    totalTasks: Number(row.total_tasks),
    completedTasks: Number(row.completed_tasks),
    payRatio: Number(row.pay_ratio),
    paidAmount: Number(row.paid_amount),
    reason: row.reason,
    createdAt: row.created_at,
  };
}

function mapPenalty(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    jobId: Number(row.job_id),
    jobName: row.job_name,
    taskId: row.task_id === null || row.task_id === undefined ? null : Number(row.task_id),
    sourceType: row.source_type,
    sourceId: row.source_id === null || row.source_id === undefined ? null : Number(row.source_id),
    sourceChannelId: row.source_channel_id || null,
    penaltyDate: row.penalty_date,
    dailySalary: Number(row.daily_salary || 0),
    penaltyAmount: Number(row.penalty_amount || 0),
    status: row.status,
    reason: row.reason || '',
    announcedAt: row.announced_at || null,
    announcementChannelId: row.announcement_channel_id || null,
    announcementMessageId: row.announcement_message_id || null,
    appealDeadlineAt: row.appeal_deadline_at,
    appliedAt: row.applied_at || null,
    refundedAt: row.refunded_at || null,
    resolvedBy: row.resolved_by || null,
    resolvedAt: row.resolved_at || null,
    resolutionReason: row.resolution_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAppeal(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    penaltyId: Number(row.penalty_id),
    reason: row.reason || '',
    status: row.status,
    reviewedBy: row.reviewed_by || null,
    reviewedAt: row.reviewed_at || null,
    reviewReason: row.review_reason || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeLimit(limit, fallback = 10, max = 25) {
  const value = Number(limit || fallback);

  if (!Number.isSafeInteger(value) || value <= 0) {
    return fallback;
  }

  return Math.min(value, max);
}

function normalizeDescription(value, fallback = '未提供內容') {
  return String(value || '').trim().slice(0, MAX_DESCRIPTION_LENGTH) || fallback;
}

function normalizeTaskType(value) {
  return String(value || 'work_report').trim().slice(0, 80) || 'work_report';
}

function parseJsonArray(value) {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(Boolean).map(String) : [];
  } catch {
    return [];
  }
}

function stringifyArray(values) {
  const normalized = Array.isArray(values) ? values.filter(Boolean).map(String) : [];
  return normalized.length ? JSON.stringify(normalized) : null;
}

function normalizeExternalServerIds(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].slice(0, MAX_EXTERNAL_SERVER_COUNT);
  }

  return [
    ...new Set(
      String(value || '')
        .split(/[\n,，、\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
    ),
  ].slice(0, MAX_EXTERNAL_SERVER_COUNT);
}

function normalizeExternalServerCount(value) {
  const count = Math.floor(Number(value || 0));

  if (!Number.isSafeInteger(count) || count < 0 || count > MAX_EXTERNAL_SERVER_COUNT) {
    throw new CoinServiceError(
      'INVALID_EXTERNAL_SERVER_COUNT',
      `外部伺服器數量必須介於 0 到 ${MAX_EXTERNAL_SERVER_COUNT} 之間。`
    );
  }

  return count;
}

function getExpectedChannelName(jobName) {
  return getJobType(jobName)?.reportChannelName || null;
}

function normalizeChannelName(value) {
  return String(value || '').trim().replace(/^#/, '').toLowerCase();
}

function assertCorrectReportChannel(jobName, channelName) {
  const expectedChannelName = getExpectedChannelName(jobName);

  if (!expectedChannelName || !channelName) {
    return;
  }

  if (normalizeChannelName(channelName) !== normalizeChannelName(expectedChannelName)) {
    throw new CoinServiceError(
      'WRONG_WORK_CHANNEL',
      `這份工作應該提交到 \`#${expectedChannelName}\`，請移至正確頻道後重新提交。`,
      { expectedChannelName }
    );
  }
}

function isLockedSubmission(row) {
  return Boolean(row?.is_paid) || row?.status === TASK_STATUS.PAID;
}

function insertWorkAuditLog(api, { guildId, operatorId, targetUserId, action, reason, details, createdAt }) {
  insertAdminLog(api, {
    guildId,
    operatorId: operatorId || 'unknown',
    targetUserId,
    action,
    reason: reason || action,
    details,
    createdAt: createdAt || nowIso(),
  });
}

function createWorkPenaltyWithApi(
  api,
  {
    guildId,
    userId,
    jobId,
    jobName,
    taskId = null,
    sourceType = 'work_task',
    sourceId = null,
    sourceChannelId = null,
    penaltyDate = null,
    amount = null,
    reason = '工作任務逾期未完成',
    createdAt = nowIso(),
  }
) {
  const jobRow = api.get('SELECT * FROM coin_jobs WHERE guild_id = ? AND id = ?', [guildId, jobId]);
  if (!jobRow) {
    return null;
  }

  const jobType = getJobType(jobName || jobRow.job_name);
  const dailySalary = Number(jobType?.salary ?? jobRow.daily_salary ?? 0);
  const penaltyAmount = Math.max(0, Math.min(amount === null ? dailySalary : Number(amount || 0), dailySalary));
  if (penaltyAmount <= 0) {
    return null;
  }

  const dateLabel = penaltyDate || getTaiwanDateLabel(new Date(createdAt));
  const existing = api.get(
    `SELECT *
     FROM coin_work_penalties
     WHERE guild_id = ?
       AND user_id = ?
       AND job_id = ?
       AND penalty_date = ?
       AND status IN (?, ?)
     ORDER BY id ASC
     LIMIT 1`,
    [guildId, userId, jobId, dateLabel, PenaltyStatus.ACTIVE, PenaltyStatus.APPEALED]
  );

  if (existing) {
    return mapPenalty(existing);
  }

  const appealDeadlineAt = addDaysIso(createdAt, APPEAL_WINDOW_DAYS);
  api.run(
    `INSERT INTO coin_work_penalties
      (
        guild_id, user_id, job_id, job_name, task_id, source_type, source_id, source_channel_id,
        penalty_date, daily_salary, penalty_amount, status, reason, appeal_deadline_at, created_at, updated_at
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      guildId,
      userId,
      jobId,
      jobName || jobRow.job_name,
      taskId,
      sourceType,
      sourceId,
      sourceChannelId,
      dateLabel,
      dailySalary,
      penaltyAmount,
      PenaltyStatus.ACTIVE,
      normalizeDescription(reason, '工作任務逾期未完成'),
      appealDeadlineAt,
      createdAt,
      createdAt,
    ]
  );

  const penaltyId = Number(api.get('SELECT last_insert_rowid() AS id').id);
  insertWorkAuditLog(api, {
    guildId,
    operatorId: 'system',
    targetUserId: userId,
    action: 'work:penalty-created',
    reason,
    details: { penaltyId, jobId, jobName: jobName || jobRow.job_name, penaltyAmount, taskId, sourceType, sourceId },
    createdAt,
  });

  return mapPenalty(api.get('SELECT * FROM coin_work_penalties WHERE id = ?', [penaltyId]));
}

function calculatePayrollForJob(api, jobRow) {
  const job = mapJob(jobRow);
  const jobType = getJobType(job.jobName);
  const currentDailySalary = jobType?.salary || job.dailySalary;
  const baseSalary = currentDailySalary * job.workDays;
  const validRows = api
    .all(
      `SELECT *
       FROM coin_work_tasks
       WHERE guild_id = ?
         AND job_id = ?
         AND completed_at IS NOT NULL
         AND status IN (${VALID_PAYROLL_TASK_STATUSES.map(() => '?').join(', ')})
         AND is_paid = 0
       ORDER BY created_at ASC, id ASC`,
      [job.guildId, job.id, ...VALID_PAYROLL_TASK_STATUSES]
    )
    .map(mapTask);
  const noWorkRows = validRows.filter((task) => task.status === TASK_STATUS.NO_WORK_AVAILABLE);
  const workRows = validRows.filter((task) => task.status !== TASK_STATUS.NO_WORK_AVAILABLE);
  const totalTasks = workRows.length;
  const completedTasks = totalTasks;
  const externalServerCount =
    job.jobName === '翻譯官'
      ? calculateTranslatorExternalServerCount(workRows)
      : 0;
  const externalServerBonus = jobType?.externalServerBonus || 0;
  const translatorExtraAmount = externalServerCount * externalServerBonus;
  const venueBonus = calculateVenueBonusForJob(api, job);
  const penalties = calculateActivePenaltiesForJob(api, job);
  const extraAmount = translatorExtraAmount + venueBonus.amount;

  if (totalTasks === 0) {
    if (noWorkRows.length > 0) {
      const basicSalaryAmount = Math.round(baseSalary * BASIC_SALARY_RATIO);
      const paidAmount = Math.max(0, basicSalaryAmount - penalties.amount);
      const penaltyReason =
        penalties.amount > 0 ? ` 逾期扣薪 ${penalties.penaltyIds.length} 筆，扣除 ${penalties.amount} 吉幣。` : '';

      return {
        job,
        baseSalary,
        totalTasks: noWorkRows.length,
        completedTasks: 0,
        externalServerCount: 0,
        extraAmount: 0,
        venueBonusAmount: 0,
        venueBonusItemIds: [],
        penaltyAmount: penalties.amount,
        penaltyIds: penalties.penaltyIds,
        payRatio: BASIC_SALARY_RATIO,
        paidAmount,
        payableTaskIds: noWorkRows.map((task) => task.id),
        reason: `已回報今天沒有可執行工作，發放 ${Math.round(BASIC_SALARY_RATIO * 100)}% 基本薪資：${baseSalary} x ${BASIC_SALARY_RATIO}。${penaltyReason}`.trim(),
        transactionType: TransactionType.BASIC_SALARY,
      };
    }

    return {
      job,
      baseSalary,
      totalTasks,
      completedTasks: 0,
      externalServerCount: 0,
      extraAmount: 0,
      venueBonusAmount: 0,
      venueBonusItemIds: [],
      penaltyAmount: penalties.amount,
      penaltyIds: penalties.penaltyIds,
      payRatio: 0,
      paidAmount: 0,
      payableTaskIds: [],
      reason: '尚未找到有效工作內容，因此本次不發薪。請先提交工作內容。',
      transactionType: TransactionType.BASIC_SALARY,
    };
  }

  const grossAmount = baseSalary + extraAmount;
  const paidAmount = Math.max(0, grossAmount - penalties.amount);
  const extraReason =
    job.jobName === '翻譯官'
      ? `翻譯官外部伺服器任務 ${externalServerCount} 個，加給 ${translatorExtraAmount} 吉幣。`
      : '';
  const venueReason = venueBonus.amount > 0 ? `場館訂單獎金 ${venueBonus.itemIds.length} 筆，加給 ${venueBonus.amount} 吉幣。` : '';
  const penaltyReason = penalties.amount > 0 ? `逾期扣薪 ${penalties.penaltyIds.length} 筆，扣除 ${penalties.amount} 吉幣。` : '';

  return {
    job,
    baseSalary,
    totalTasks,
    completedTasks,
    externalServerCount,
    extraAmount,
    venueBonusAmount: venueBonus.amount,
    venueBonusItemIds: venueBonus.itemIds,
    penaltyAmount: penalties.amount,
    penaltyIds: penalties.penaltyIds,
    payRatio: 1,
    paidAmount,
    payableTaskIds: validRows.map((task) => task.id),
    reason: [`有效提交 ${completedTasks} 筆，依新版職業日薪計算：${currentDailySalary} x ${job.workDays} 天。`, extraReason, venueReason, penaltyReason]
      .filter(Boolean)
      .join(' '),
    transactionType: TransactionType.WORK_SALARY,
  };
}

function calculateTranslatorExternalServerCount(tasks) {
  const uniqueByDate = new Set();
  let countWithoutIds = 0;

  for (const task of tasks) {
    const ids = task.externalServerIds || [];

    if (ids.length) {
      const dateLabel = getTaiwanDateLabel(new Date(task.createdAt));
      for (const id of ids) {
        uniqueByDate.add(`${dateLabel}:${id}`);
      }
      continue;
    }

    countWithoutIds += normalizeExternalServerCount(task.externalServerCount);
  }

  return uniqueByDate.size + countWithoutIds;
}

function calculateVenueBonusForJob(api, job) {
  if (!['廚師', '調酒師'].includes(job.jobName)) {
    return { amount: 0, itemIds: [] };
  }

  const rows = api.all(
    `SELECT id, bonus_amount
     FROM casino_venue_order_items
     WHERE guild_id = ?
       AND maker_user_id = ?
       AND maker_job_id = ?
       AND maker_is_npc = 0
       AND status = 'completed'
       AND bonus_paid = 0
       AND bonus_amount > 0
     ORDER BY completed_at ASC, id ASC`,
    [job.guildId, job.userId, job.id]
  );

  return {
    amount: rows.reduce((sum, row) => sum + Number(row.bonus_amount || 0), 0),
    itemIds: rows.map((row) => Number(row.id)),
  };
}

function calculateActivePenaltiesForJob(api, job) {
  const rows = api.all(
    `SELECT id, penalty_amount
     FROM coin_work_penalties
     WHERE guild_id = ?
       AND user_id = ?
       AND job_id = ?
       AND status = ?
       AND applied_at IS NULL
     ORDER BY created_at ASC, id ASC`,
    [job.guildId, job.userId, job.id, PenaltyStatus.ACTIVE]
  );

  return {
    amount: rows.reduce((sum, row) => sum + Number(row.penalty_amount || 0), 0),
    penaltyIds: rows.map((row) => Number(row.id)),
  };
}

async function listJobs() {
  return {
    jobs: JOB_TYPES,
    minDays: MIN_WORK_DAYS,
    maxDays: MAX_WORK_DAYS,
    payTime: PAY_TIME_LABEL,
  };
}

async function startJob(guildId, userId, jobName, days) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
    }

    const jobType = getJobType(jobName);
    if (!jobType) {
      throw new CoinServiceError('INVALID_JOB', '找不到該職業。');
    }

    const workDays = normalizeWorkDays(days);

    ensurePlayer(api, guildId, userId);
    const activeRows = api.all(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ? ORDER BY id ASC',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );
    const sameJob = activeRows.find((row) => row.job_name === jobType.name);

    if (sameJob) {
      throw new CoinServiceError('HAS_ACTIVE_JOB', '你目前已有相同職業的進行中工作。', {
        job: mapJob(sameJob),
      });
    }

    const timestamp = nowIso();
    let replacedJob = null;
    const startingVenueJob = isVenueJobName(jobType.name);
    const activeVenueRows = activeRows.filter((row) => isVenueJobName(row.job_name));
    const activeNonVenueRows = activeRows.filter((row) => !isVenueJobName(row.job_name));

    if (startingVenueJob) {
      if (activeNonVenueRows.length) {
        throw new CoinServiceError('VENUE_JOB_CONFLICT', '場館職業不能與一般職業同時進行，請先取消目前的一般職業。');
      }

      if (isWaiterJobName(jobType.name) && activeVenueRows.some((row) => isWaiterJobName(row.job_name))) {
        throw new CoinServiceError('WAITER_JOB_CONFLICT', '同一時間只能擔任一種服務生職業。');
      }

      const existingCycle = activeVenueRows[0] || null;
      if (existingCycle && Number(existingCycle.work_days) !== workDays) {
        throw new CoinServiceError('VENUE_JOB_CYCLE_MISMATCH', `你的場館職業週期目前是 ${existingCycle.work_days} 天，新職業也必須使用相同天數。`);
      }

      return insertJobWithCycle(api, {
        guildId,
        userId,
        jobType,
        workDays,
        startAt: existingCycle?.start_at || timestamp,
        payAt: existingCycle?.pay_at || calculatePayTime(timestamp, workDays),
      });
    }

    if (activeVenueRows.length) {
      throw new CoinServiceError('NON_VENUE_JOB_CONFLICT', '一般職業不能與場館多職業同時進行，請先取消場館職業。');
    }

    const existingJob = activeNonVenueRows[0] || null;
    if (existingJob) {
      replacedJob = mapJob(existingJob);
      api.run(
        'UPDATE coin_jobs SET status = ?, payroll_status = ?, updated_at = ? WHERE id = ?',
        [JOB_STATUS.CANCELED, PAYROLL_STATUS.CANCELED, timestamp, existingJob.id]
      );
      api.run(
        'UPDATE coin_work_tasks SET status = ? WHERE guild_id = ? AND job_id = ? AND status = ?',
        [TASK_STATUS.CANCELED, guildId, existingJob.id, TASK_STATUS.PENDING]
      );
    }

    const job = insertJobWithCycle(api, {
      guildId,
      userId,
      jobType,
      workDays,
      startAt: timestamp,
      payAt: calculatePayTime(timestamp, workDays),
    });
    job.replacedJob = replacedJob;
    return job;
  });
}

async function startVenueJobs(guildId, userId, { days, chef = false, bartender = false, waiter = 'none' } = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
    }

    const workDays = normalizeWorkDays(days);
    const selectedNames = [];
    if (chef) selectedNames.push('廚師');
    if (bartender) selectedNames.push('調酒師');
    if (waiter && waiter !== 'none') selectedNames.push(waiter);

    if (!selectedNames.length) {
      throw new CoinServiceError('NO_VENUE_JOB_SELECTED', '請至少選擇一個場館職業。');
    }

    if (selectedNames.some((name) => !VENUE_JOB_NAMES.includes(name))) {
      throw new CoinServiceError('INVALID_JOB', '場館職業選項不正確。');
    }

    ensurePlayer(api, guildId, userId);
    const activeRows = api.all(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ? ORDER BY id ASC',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );
    const activeNonVenueRows = activeRows.filter((row) => !isVenueJobName(row.job_name));
    if (activeNonVenueRows.length) {
      throw new CoinServiceError('VENUE_JOB_CONFLICT', '場館職業不能與一般職業同時進行，請先取消目前的一般職業。');
    }

    const activeVenueRows = activeRows.filter((row) => isVenueJobName(row.job_name));
    const existingCycle = activeVenueRows[0] || null;
    if (existingCycle && Number(existingCycle.work_days) !== workDays) {
      throw new CoinServiceError('VENUE_JOB_CYCLE_MISMATCH', `你的場館職業週期目前是 ${existingCycle.work_days} 天，新職業也必須使用相同天數。`);
    }

    const activeNames = new Set(activeVenueRows.map((row) => row.job_name));
    const activeWaiter = activeVenueRows.find((row) => isWaiterJobName(row.job_name));
    const selectedWaiter = selectedNames.find(isWaiterJobName);
    if (activeWaiter && selectedWaiter && activeWaiter.job_name !== selectedWaiter) {
      throw new CoinServiceError('WAITER_JOB_CONFLICT', '同一時間只能擔任一種服務生職業。');
    }

    const timestamp = nowIso();
    const cycle = {
      startAt: existingCycle?.start_at || timestamp,
      payAt: existingCycle?.pay_at || calculatePayTime(timestamp, workDays),
    };
    const createdJobs = [];
    const skippedJobs = [];

    for (const name of selectedNames) {
      if (activeNames.has(name)) {
        skippedJobs.push(mapJob(activeVenueRows.find((row) => row.job_name === name)));
        continue;
      }

      createdJobs.push(
        insertJobWithCycle(api, {
          guildId,
          userId,
          jobType: getJobType(name),
          workDays,
          startAt: cycle.startAt,
          payAt: cycle.payAt,
        })
      );
    }

    if (!createdJobs.length) {
      throw new CoinServiceError('HAS_ACTIVE_JOB', '你選擇的場館職業都已經在進行中。', {
        jobs: skippedJobs,
      });
    }

    return {
      jobs: createdJobs,
      skippedJobs,
      workDays,
      startAt: cycle.startAt,
      payAt: cycle.payAt,
    };
  });
}

async function getActiveJob(guildId, userId) {
  return withCoinDatabase((api) => {
    const row = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ? ORDER BY id ASC LIMIT 1',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );
    return row ? mapJob(row) : null;
  });
}

async function getActiveJobs(guildId, userId) {
  return withCoinDatabase((api) =>
    api
      .all(
        'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ? ORDER BY id ASC',
        [guildId, userId, JOB_STATUS.ACTIVE]
      )
      .map(mapJob)
  );
}

async function getWorkStatus(guildId, userId) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    ensurePlayer(api, guildId, userId);
    const activeJobs = api
      .all(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ? ORDER BY id ASC',
      [guildId, userId, JOB_STATUS.ACTIVE]
      )
      .map(mapJob);
    const latestPayroll = api.get(
      'SELECT * FROM coin_payroll_history WHERE guild_id = ? AND user_id = ? ORDER BY created_at DESC, id DESC LIMIT 1',
      [guildId, userId]
    );
    const tasks = api
      .all(
        `SELECT *
         FROM coin_work_tasks
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT 10`,
        [guildId, userId]
      )
      .map(mapTask);

    return {
      activeJob: activeJobs[0] || null,
      activeJobs,
      latestPayroll: latestPayroll ? mapPayroll(latestPayroll) : null,
      recentTasks: tasks,
    };
  });
}

async function getAllWorkStatuses(guildId, { limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    return api
      .all(
        `SELECT *
         FROM coin_jobs
         WHERE guild_id = ?
         ORDER BY
           CASE status WHEN 'active' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END,
           updated_at DESC,
           id DESC
         LIMIT ?`,
        [guildId, normalizeLimit(limit)]
      )
      .map(mapJob);
  });
}

async function cancelJob(guildId, userId) {
  return withCoinTransaction((api) => {
    const rows = api.all(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ? ORDER BY id ASC',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );

    if (!rows.length) {
      throw new CoinServiceError('NO_ACTIVE_JOB', '你目前沒有進行中的工作。');
    }

    const timestamp = nowIso();
    for (const row of rows) {
      api.run(
        'UPDATE coin_jobs SET status = ?, payroll_status = ?, updated_at = ? WHERE id = ?',
        [JOB_STATUS.CANCELED, PAYROLL_STATUS.CANCELED, timestamp, row.id]
      );
      api.run(
        'UPDATE coin_work_tasks SET status = ? WHERE guild_id = ? AND job_id = ? AND status = ?',
        [TASK_STATUS.CANCELED, guildId, row.id, TASK_STATUS.PENDING]
      );
    }

    const jobs = rows.map((row) => mapJob(api.get('SELECT * FROM coin_jobs WHERE id = ?', [row.id])));
    const primary = jobs[0];
    primary.cancelledJobs = jobs;
    return primary;
  });
}

async function reportWork(
  guildId,
  userId,
  {
    taskType = 'work_report',
    description = '',
    noWorkAvailable = false,
    attachmentUrls = [],
    channelId = null,
    channelName = null,
    messageId = null,
    externalServerCount = 0,
    externalServerIds = [],
  } = {}
) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
    }

    const jobRow = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ?',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );

    if (!jobRow) {
      throw new CoinServiceError('NO_ACTIVE_JOB', '你目前沒有進行中的工作。');
    }

    assertCorrectReportChannel(jobRow.job_name, channelName);

    const timestamp = nowIso();
    const status = noWorkAvailable ? TASK_STATUS.NO_WORK_AVAILABLE : TASK_STATUS.PENDING;
    const jobType = getJobType(jobRow.job_name);
    const normalizedExternalServerIds = normalizeExternalServerIds(externalServerIds);
    const normalizedExternalServerCount = normalizedExternalServerIds.length
      ? normalizedExternalServerIds.length
      : normalizeExternalServerCount(externalServerCount);

    if (normalizedExternalServerCount > 0 && jobRow.job_name !== '翻譯官') {
      throw new CoinServiceError('EXTERNAL_SERVER_ONLY_TRANSLATOR', '只有翻譯官工作可以填寫外部伺服器加給。');
    }

    const taskDescription = normalizeDescription(
      description,
      noWorkAvailable ? '回報目前沒有可執行的工作任務。' : '已回報工作產出。'
    );

    api.run(
      `INSERT INTO coin_work_tasks
        (
          guild_id, user_id, job_id, job_name, task_type, status, description,
          attachment_urls, expected_channel_id, expected_channel_name, message_id,
          external_server_count, external_server_ids, created_at, due_at, completed_at, updated_at
        )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guildId,
        userId,
        jobRow.id,
        jobRow.job_name,
        noWorkAvailable ? 'no_work_available' : normalizeTaskType(taskType),
        status,
        taskDescription,
        stringifyArray(attachmentUrls),
        channelId || null,
        jobType?.reportChannelName || null,
        messageId || null,
        normalizedExternalServerCount,
        stringifyArray(normalizedExternalServerIds),
        timestamp,
        addHoursIso(timestamp, WORK_REMINDER_HOURS),
        timestamp,
        timestamp,
      ]
    );
    api.run(
      `UPDATE coin_jobs
       SET last_contribution_at = ?,
           today_task_count = today_task_count + 1,
           today_completed_task_count = today_completed_task_count + ?,
           no_work_available_today = CASE WHEN ? = 1 THEN 1 ELSE no_work_available_today END,
           updated_at = ?
       WHERE id = ?`,
      [timestamp, noWorkAvailable ? 0 : 1, noWorkAvailable ? 1 : 0, timestamp, jobRow.id]
    );

    const taskId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    insertWorkAuditLog(api, {
      guildId,
      operatorId: userId,
      targetUserId: userId,
      action: 'work:submit',
      reason: '提交工作內容',
      details: {
        taskId,
        jobId: jobRow.id,
        jobName: jobRow.job_name,
        externalServerCount: normalizedExternalServerCount,
      },
      createdAt: timestamp,
    });

    return {
      job: mapJob(api.get('SELECT * FROM coin_jobs WHERE id = ?', [jobRow.id])),
      task: mapTask(api.get('SELECT * FROM coin_work_tasks WHERE id = ?', [taskId])),
    };
  });
}

async function addPendingTask(guildId, userId, { taskType = 'admin_task', description, dueHours = WORK_REMINDER_HOURS } = {}) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const jobRow = api.get(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ?',
      [guildId, userId, JOB_STATUS.ACTIVE]
    );

    if (!jobRow) {
      throw new CoinServiceError('NO_ACTIVE_JOB', '目標使用者目前沒有進行中的工作。');
    }

    const normalizedDueHours = Number(dueHours || WORK_REMINDER_HOURS);
    if (!Number.isSafeInteger(normalizedDueHours) || normalizedDueHours < 1 || normalizedDueHours > 72) {
      throw new CoinServiceError('INVALID_DUE_HOURS', '提醒時間必須介於 1 到 72 小時之間。');
    }

    const timestamp = nowIso();
    api.run(
      `INSERT INTO coin_work_tasks
        (guild_id, user_id, job_id, job_name, task_type, status, description, created_at, due_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guildId,
        userId,
        jobRow.id,
        jobRow.job_name,
        normalizeTaskType(taskType),
        TASK_STATUS.PENDING,
        normalizeDescription(description, '管理員指派的工作任務。'),
        timestamp,
        addHoursIso(timestamp, normalizedDueHours),
      ]
    );
    api.run(
      'UPDATE coin_jobs SET today_task_count = today_task_count + 1, updated_at = ? WHERE id = ?',
      [timestamp, jobRow.id]
    );

    const taskId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    return mapTask(api.get('SELECT * FROM coin_work_tasks WHERE id = ?', [taskId]));
  });
}

async function listWorkTasks(guildId, { userId = null, status = null, limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const params = [guildId];
    let where = 'WHERE guild_id = ?';

    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }

    if (status) {
      where += ' AND status = ?';
      params.push(status);
    }

    params.push(normalizeLimit(limit));
    return api
      .all(
        `SELECT *
         FROM coin_work_tasks
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        params
      )
      .map(mapTask);
  });
}

async function editWorkSubmission(
  guildId,
  actorUserId,
  submissionId,
  { description, attachmentUrls = null, externalServerCount = null, externalServerIds = null, canManage = false } = {}
) {
  return withCoinTransaction((api) => {
    const row = api.get('SELECT * FROM coin_work_tasks WHERE guild_id = ? AND id = ?', [guildId, submissionId]);

    if (!row) {
      throw new CoinServiceError('SUBMISSION_NOT_FOUND', '找不到這筆工作提交紀錄。');
    }

    if (row.user_id !== actorUserId && !canManage) {
      throw new CoinServiceError('NOT_OWN_SUBMISSION', '你只能修改自己的工作內容。');
    }

    if (isLockedSubmission(row)) {
      throw new CoinServiceError('SUBMISSION_ALREADY_PAID', '這筆工作已經發薪，不能再修改。如有特殊情況，請聯絡管理員。');
    }

    if (row.status === TASK_STATUS.DELETED) {
      throw new CoinServiceError('SUBMISSION_DELETED', '這筆工作已經刪除，請重新提交新的工作內容。');
    }

    const timestamp = nowIso();
    const updates = ['status = ?', 'updated_at = ?', 'reviewed_by = NULL', 'review_reason = NULL'];
    const params = [TASK_STATUS.PENDING, timestamp];

    if (description !== undefined && description !== null) {
      updates.push('description = ?');
      params.push(normalizeDescription(description));
    }

    if (attachmentUrls !== null) {
      updates.push('attachment_urls = ?');
      params.push(stringifyArray(attachmentUrls));
    }

    if (externalServerIds !== null || externalServerCount !== null) {
      const normalizedExternalServerIds = normalizeExternalServerIds(externalServerIds || []);
      const normalizedExternalServerCount = normalizedExternalServerIds.length
        ? normalizedExternalServerIds.length
        : normalizeExternalServerCount(externalServerCount || 0);

      if (normalizedExternalServerCount > 0 && row.job_name !== '翻譯官') {
        throw new CoinServiceError('EXTERNAL_SERVER_ONLY_TRANSLATOR', '只有翻譯官工作可以填寫外部伺服器加給。');
      }

      updates.push('external_server_count = ?', 'external_server_ids = ?');
      params.push(normalizedExternalServerCount, stringifyArray(normalizedExternalServerIds));
    }

    params.push(guildId, submissionId);
    api.run(`UPDATE coin_work_tasks SET ${updates.join(', ')} WHERE guild_id = ? AND id = ?`, params);

    insertWorkAuditLog(api, {
      guildId,
      operatorId: actorUserId,
      targetUserId: row.user_id,
      action: 'work:edit',
      reason: '修改工作內容',
      details: { submissionId, jobId: row.job_id, jobName: row.job_name },
      createdAt: timestamp,
    });

    return mapTask(api.get('SELECT * FROM coin_work_tasks WHERE guild_id = ? AND id = ?', [guildId, submissionId]));
  });
}

async function deleteWorkSubmission(
  guildId,
  actorUserId,
  submissionId,
  { reason = '使用者刪除工作內容', canManage = false } = {}
) {
  return withCoinTransaction((api) => {
    const row = api.get('SELECT * FROM coin_work_tasks WHERE guild_id = ? AND id = ?', [guildId, submissionId]);

    if (!row) {
      throw new CoinServiceError('SUBMISSION_NOT_FOUND', '找不到這筆工作提交紀錄。');
    }

    if (row.user_id !== actorUserId && !canManage) {
      throw new CoinServiceError('NOT_OWN_SUBMISSION', '你只能刪除自己的工作內容。');
    }

    if (isLockedSubmission(row)) {
      throw new CoinServiceError('SUBMISSION_ALREADY_PAID', '這筆工作已經發薪，不能再刪除。如有特殊情況，請聯絡管理員。');
    }

    const timestamp = nowIso();
    api.run(
      `UPDATE coin_work_tasks
       SET status = ?, deleted_at = ?, updated_at = ?, review_reason = ?
       WHERE guild_id = ? AND id = ?`,
      [TASK_STATUS.DELETED, timestamp, timestamp, normalizeDescription(reason, '刪除工作內容'), guildId, submissionId]
    );

    insertWorkAuditLog(api, {
      guildId,
      operatorId: actorUserId,
      targetUserId: row.user_id,
      action: 'work:delete',
      reason,
      details: { submissionId, jobId: row.job_id, jobName: row.job_name },
      createdAt: timestamp,
    });

    return mapTask(api.get('SELECT * FROM coin_work_tasks WHERE guild_id = ? AND id = ?', [guildId, submissionId]));
  });
}

async function reviewWorkSubmission(guildId, reviewerId, submissionId, { action, reason = '' } = {}) {
  return withCoinTransaction((api) => {
    const row = api.get('SELECT * FROM coin_work_tasks WHERE guild_id = ? AND id = ?', [guildId, submissionId]);

    if (!row) {
      throw new CoinServiceError('SUBMISSION_NOT_FOUND', '找不到這筆工作提交紀錄。');
    }

    if (isLockedSubmission(row)) {
      throw new CoinServiceError('SUBMISSION_ALREADY_PAID', '這筆工作已經發薪，不能再審核。');
    }

    if (row.status === TASK_STATUS.DELETED) {
      throw new CoinServiceError('SUBMISSION_DELETED', '這筆工作已被刪除，不能再審核。');
    }

    const nextStatus = action === TASK_STATUS.APPROVED ? TASK_STATUS.APPROVED : TASK_STATUS.REJECTED;
    const timestamp = nowIso();
    api.run(
      `UPDATE coin_work_tasks
       SET status = ?, reviewed_by = ?, review_reason = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [nextStatus, reviewerId, normalizeDescription(reason, nextStatus === TASK_STATUS.APPROVED ? '審核通過' : '審核駁回'), timestamp, guildId, submissionId]
    );

    insertWorkAuditLog(api, {
      guildId,
      operatorId: reviewerId,
      targetUserId: row.user_id,
      action: nextStatus === TASK_STATUS.APPROVED ? 'work:approve' : 'work:reject',
      reason: reason || (nextStatus === TASK_STATUS.APPROVED ? '審核通過' : '審核駁回'),
      details: { submissionId, jobId: row.job_id, jobName: row.job_name },
      createdAt: timestamp,
    });

    return mapTask(api.get('SELECT * FROM coin_work_tasks WHERE guild_id = ? AND id = ?', [guildId, submissionId]));
  });
}

async function listPendingWorkSubmissions(guildId, { limit = 10 } = {}) {
  return listWorkTasks(guildId, { status: TASK_STATUS.PENDING, limit });
}

async function previewPayroll(guildId, { userId = null, limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const params = [guildId];
    let where = 'WHERE guild_id = ? AND status = ? AND is_paid = 0';
    params.push(JOB_STATUS.ACTIVE);

    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }

    params.push(normalizeLimit(limit));
    return api
      .all(
        `SELECT *
         FROM coin_jobs
         ${where}
         ORDER BY pay_at ASC, id ASC
         LIMIT ?`,
        params
      )
      .map((row) => calculatePayrollForJob(api, row));
  });
}

async function getPayrollHistory(guildId, { userId = null, limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const params = [guildId];
    let where = 'WHERE guild_id = ?';

    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }

    params.push(normalizeLimit(limit));
    return api
      .all(
        `SELECT *
         FROM coin_payroll_history
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        params
      )
      .map(mapPayroll);
  });
}

async function listWorkPenalties(guildId, { userId = null, limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const params = [guildId];
    let where = 'WHERE guild_id = ?';
    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }
    params.push(normalizeLimit(limit));
    return api
      .all(`SELECT * FROM coin_work_penalties ${where} ORDER BY created_at DESC, id DESC LIMIT ?`, params)
      .map(mapPenalty);
  });
}

async function createWorkPenaltyAppeal(guildId, userId, penaltyId, { reason = '' } = {}) {
  return withCoinTransaction((api) => {
    const id = Number(penaltyId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new CoinServiceError('INVALID_PENALTY_ID', '扣薪 ID 不正確。');
    }

    const penaltyRow = api.get('SELECT * FROM coin_work_penalties WHERE guild_id = ? AND id = ?', [guildId, id]);
    if (!penaltyRow) {
      throw new CoinServiceError('PENALTY_NOT_FOUND', '找不到這筆扣薪紀錄。');
    }

    const penalty = mapPenalty(penaltyRow);
    if (penalty.userId !== userId) {
      throw new CoinServiceError('PENALTY_NOT_OWNED', '你只能申訴自己的扣薪紀錄。');
    }

    if (penalty.status !== PenaltyStatus.ACTIVE) {
      throw new CoinServiceError('PENALTY_NOT_APPEALABLE', '這筆扣薪紀錄目前不能申訴。');
    }

    if (new Date(penalty.appealDeadlineAt).getTime() < Date.now()) {
      throw new CoinServiceError('PENALTY_APPEAL_EXPIRED', '這筆扣薪紀錄已超過 14 天申訴期限。');
    }

    const existingAppeal = api.get(
      'SELECT * FROM coin_work_penalty_appeals WHERE guild_id = ? AND penalty_id = ? AND status = ? ORDER BY id DESC LIMIT 1',
      [guildId, id, AppealStatus.PENDING]
    );
    if (existingAppeal) {
      throw new CoinServiceError('PENALTY_APPEAL_EXISTS', '這筆扣薪已有待審核申訴。');
    }

    const timestamp = nowIso();
    api.run(
      `INSERT INTO coin_work_penalty_appeals
        (guild_id, user_id, penalty_id, reason, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [guildId, userId, id, normalizeDescription(reason, '未提供申訴事由'), AppealStatus.PENDING, timestamp, timestamp]
    );
    const appealId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    insertWorkAuditLog(api, {
      guildId,
      operatorId: userId,
      targetUserId: userId,
      action: 'work:penalty-appeal',
      reason,
      details: { penaltyId: id, appealId },
      createdAt: timestamp,
    });

    return {
      penalty,
      appeal: mapAppeal(api.get('SELECT * FROM coin_work_penalty_appeals WHERE id = ?', [appealId])),
    };
  });
}

async function reviewWorkPenaltyAppeal(guildId, reviewerId, appealId, { action, reason = '' } = {}) {
  return withCoinTransaction((api) => {
    const id = Number(appealId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new CoinServiceError('INVALID_APPEAL_ID', '申訴 ID 不正確。');
    }

    const appealRow = api.get('SELECT * FROM coin_work_penalty_appeals WHERE guild_id = ? AND id = ?', [guildId, id]);
    if (!appealRow) {
      throw new CoinServiceError('APPEAL_NOT_FOUND', '找不到這筆申訴。');
    }

    const appeal = mapAppeal(appealRow);
    if (appeal.status !== AppealStatus.PENDING) {
      throw new CoinServiceError('APPEAL_ALREADY_REVIEWED', '這筆申訴已經審核過。');
    }

    const penaltyRow = api.get('SELECT * FROM coin_work_penalties WHERE guild_id = ? AND id = ?', [guildId, appeal.penaltyId]);
    if (!penaltyRow) {
      throw new CoinServiceError('PENALTY_NOT_FOUND', '找不到申訴對應的扣薪紀錄。');
    }

    const approve = action === AppealStatus.APPROVED;
    const timestamp = nowIso();
    api.run(
      `UPDATE coin_work_penalty_appeals
       SET status = ?, reviewed_by = ?, reviewed_at = ?, review_reason = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [approve ? AppealStatus.APPROVED : AppealStatus.REJECTED, reviewerId, timestamp, normalizeDescription(reason, approve ? '申訴通過' : '申訴駁回'), timestamp, guildId, id]
    );

    let refund = null;
    if (approve) {
      const penalty = mapPenalty(penaltyRow);
      api.run(
        `UPDATE coin_work_penalties
         SET status = ?, resolved_by = ?, resolved_at = ?, resolution_reason = ?, updated_at = ?
         WHERE guild_id = ? AND id = ?`,
        [PenaltyStatus.CANCELED, reviewerId, timestamp, normalizeDescription(reason, '申訴通過，取消扣薪。'), timestamp, guildId, penalty.id]
      );

      if (penalty.appliedAt && !penalty.refundedAt && penalty.penaltyAmount > 0) {
        const player = ensurePlayer(api, guildId, penalty.userId);
        const after = player.balance + penalty.penaltyAmount;
        mutateWalletWithApi(api, {
          guildId,
          userId: penalty.userId,
          type: TransactionType.WORK_PENALTY_REFUND,
          balanceDelta: penalty.penaltyAmount,
          totalEarnedDelta: penalty.penaltyAmount,
          operatorId: reviewerId,
          reason: `扣薪申訴通過，退還扣薪 #${penalty.id}`,
          metadata: { penaltyId: penalty.id, appealId: id },
          createdAt: timestamp,
        });
        api.run(
          'UPDATE coin_work_penalties SET refunded_at = ?, updated_at = ? WHERE guild_id = ? AND id = ?',
          [timestamp, timestamp, guildId, penalty.id]
        );
        refund = { amount: penalty.penaltyAmount, before: player.balance, after };
      }
    }

    insertWorkAuditLog(api, {
      guildId,
      operatorId: reviewerId,
      targetUserId: appeal.userId,
      action: approve ? 'work:appeal-approved' : 'work:appeal-rejected',
      reason,
      details: { appealId: id, penaltyId: appeal.penaltyId, refund },
      createdAt: timestamp,
    });

    return {
      appeal: mapAppeal(api.get('SELECT * FROM coin_work_penalty_appeals WHERE guild_id = ? AND id = ?', [guildId, id])),
      penalty: mapPenalty(api.get('SELECT * FROM coin_work_penalties WHERE guild_id = ? AND id = ?', [guildId, appeal.penaltyId])),
      refund,
    };
  });
}

async function updateJobRoleId(guildId, jobId, roleId) {
  return withCoinTransaction((api) => {
    const timestamp = nowIso();
    api.run(
      'UPDATE coin_jobs SET job_role_id = ?, updated_at = ? WHERE guild_id = ? AND id = ?',
      [roleId || null, timestamp, guildId, jobId]
    );
  });
}

async function sendWorkReminder(client, row) {
  if (!client) {
    return false;
  }

  const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
  if (!guild) {
    return false;
  }

  const member = await guild.members.fetch(row.user_id).catch(() => null);
  const actionHint = String(row.task_type || '').startsWith('casino_venue_')
    ? '你有尚未完成的場館任務，請盡快使用對應的 `/casino-venue` 指令完成。'
    : '請使用 `/work submit` 提交工作內容與證明，或使用 `/work report mode:no-work-available` 回報目前沒有可執行工作。';
  const message = [
    `你在 **${guild.name}** 的小吉工作 **${row.job_name}** 還有待完成任務。`,
    `任務 #${row.id}：${row.description || row.task_type}`,
    actionHint,
  ].join('\n');

  if (member) {
    const sent = await member.send(message).then(() => true).catch(() => false);
    if (sent) {
      return true;
    }
  }

  const channel = guild.systemChannel || guild.channels.cache.find((candidate) => candidate?.isTextBased?.());
  if (!channel?.isTextBased?.()) {
    return false;
  }

  return channel
    .send({
      content: `${member || `<@${row.user_id}>`} ${message}`,
      allowedMentions: { users: [row.user_id] },
    })
    .then(() => true)
    .catch(() => false);
}

async function sendWorkPenaltyAnnouncement(client, penalty) {
  if (!client || penalty.announcedAt) {
    return false;
  }

  const guild = await client.guilds.fetch(penalty.guildId).catch(() => null);
  if (!guild) {
    return false;
  }

  const settings = await withCoinDatabase((api) => ensureGuildSettings(api, penalty.guildId)).catch(() => null);
  const channelIds = [
    settings?.announcementChannelId,
    penalty.sourceChannelId,
    guild.systemChannelId,
  ].filter(Boolean);
  let channel = null;

  for (const channelId of channelIds) {
    channel = await guild.channels.fetch(channelId).catch(() => null);
    if (channel?.isTextBased?.()) {
      break;
    }
  }

  if (!channel?.isTextBased?.()) {
    channel = guild.channels.cache.find((candidate) => candidate?.isTextBased?.()) || null;
  }

  if (!channel?.isTextBased?.()) {
    return false;
  }

  const message = await channel
    .send({
      content: [
        `**小吉工作扣薪公告 #${penalty.id}**`,
        `當事人：<@${penalty.userId}>`,
        `職業：${penalty.jobName}`,
        `扣薪金額：${penalty.penaltyAmount.toLocaleString('zh-TW')} 吉幣`,
        `原因：${penalty.reason}`,
        `申訴期限：<t:${Math.floor(new Date(penalty.appealDeadlineAt).getTime() / 1000)}:F>`,
        `如需申訴，請使用 \`/work appeal penalty-id:${penalty.id} reason:申訴事由\`。`,
      ].join('\n'),
      allowedMentions: { users: [penalty.userId], roles: [] },
    })
    .catch((error) => {
      logger.warn(`發送工作扣薪公告失敗：penalty=${penalty.id}`, error);
      return null;
    });

  if (!message) {
    return false;
  }

  await withCoinTransaction((api) => {
    const timestamp = nowIso();
    api.run(
      `UPDATE coin_work_penalties
       SET announced_at = ?, announcement_channel_id = ?, announcement_message_id = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [timestamp, channel.id, message.id, timestamp, penalty.guildId, penalty.id]
    );
  });

  return true;
}

async function processWorkPenaltyAnnouncements(client, { guildId = null, limit = 10 } = {}) {
  const rows = await withCoinDatabase((api) => {
    const params = [PenaltyStatus.ACTIVE];
    let where = 'WHERE status = ? AND announced_at IS NULL';
    if (guildId) {
      where += ' AND guild_id = ?';
      params.push(guildId);
    }
    params.push(normalizeLimit(limit, 10, 25));
    return api
      .all(`SELECT * FROM coin_work_penalties ${where} ORDER BY created_at ASC, id ASC LIMIT ?`, params)
      .map(mapPenalty);
  });

  let announced = 0;
  for (const penalty of rows) {
    if (await sendWorkPenaltyAnnouncement(client, penalty)) {
      announced++;
    }
  }

  return { checked: rows.length, announced };
}

async function processWorkReminders(client, { guildId = null, force = false } = {}) {
  const now = nowIso();
  const cutoff = addHoursIso(now, -WORK_REMINDER_HOURS);
  const params = [TASK_STATUS.PENDING, JOB_STATUS.ACTIVE];
  let guildFilter = '';

  if (guildId) {
    guildFilter = 'AND t.guild_id = ?';
    params.push(guildId);
  }

  params.push(force ? 1 : 0, now, force ? 1 : 0, cutoff, force ? 1 : 0, cutoff);
  const rows = await withCoinDatabase((api) =>
    api.all(
      `SELECT t.*, j.last_contribution_at AS job_last_contribution_at, j.last_reminder_at AS job_last_reminder_at
       FROM coin_work_tasks t
       JOIN coin_jobs j ON j.id = t.job_id
       WHERE t.status = ?
         AND t.completed_at IS NULL
         AND j.status = ?
         ${guildFilter}
         AND (? = 1 OR t.due_at <= ?)
         AND (? = 1 OR j.last_contribution_at IS NULL OR j.last_contribution_at <= ?)
         AND (? = 1 OR j.last_reminder_at IS NULL OR j.last_reminder_at <= ?)
       ORDER BY t.due_at ASC
       LIMIT 25`,
      params
    )
  );

  let reminded = 0;

  for (const row of rows) {
    const sent = await sendWorkReminder(client, row);

    await withCoinTransaction((api) => {
      const timestamp = nowIso();
      api.run(
        `UPDATE coin_work_tasks
         SET reminder_count = reminder_count + 1, last_reminder_at = ?
         WHERE id = ?`,
        [timestamp, row.id]
      );
      api.run('UPDATE coin_jobs SET last_reminder_at = ?, updated_at = ? WHERE id = ?', [
        timestamp,
        timestamp,
        row.job_id,
      ]);
    });

    if (sent) {
      reminded++;
    }
  }

  return { checked: rows.length, reminded };
}

async function processExpiredWorkTasks(client = null, { guildId = null, date = new Date() } = {}) {
  const cutoff = new Date(date.getTime() - WORK_AUTO_COMPLETE_HOURS * 60 * 60 * 1000).toISOString();
  const params = [TASK_STATUS.PENDING, JOB_STATUS.ACTIVE, cutoff, 'casino_venue_%'];
  let guildFilter = '';

  if (guildId) {
    guildFilter = 'AND t.guild_id = ?';
    params.push(guildId);
  }

  const rows = await withCoinDatabase((api) =>
    api.all(
      `SELECT t.*, j.daily_salary AS job_daily_salary
       FROM coin_work_tasks t
       JOIN coin_jobs j ON j.id = t.job_id
       WHERE t.status = ?
         AND t.completed_at IS NULL
         AND j.status = ?
         AND t.created_at <= ?
         AND t.task_type NOT LIKE ?
         ${guildFilter}
       ORDER BY t.created_at ASC, t.id ASC
       LIMIT 50`,
      params
    )
  );

  let completedBySystem = 0;
  let penaltiesCreated = 0;

  for (const row of rows) {
    const result = await withCoinTransaction((api) => {
      const current = api.get(
        `SELECT t.*, j.daily_salary AS job_daily_salary
         FROM coin_work_tasks t
         JOIN coin_jobs j ON j.id = t.job_id
         WHERE t.guild_id = ? AND t.id = ? AND t.status = ? AND t.completed_at IS NULL`,
        [row.guild_id, row.id, TASK_STATUS.PENDING]
      );

      if (!current) {
        return { completed: false, penalty: null };
      }

      const timestamp = nowIso(date);
      api.run(
        `UPDATE coin_work_tasks
         SET status = ?, completed_at = ?, review_reason = ?, updated_at = ?
         WHERE guild_id = ? AND id = ?`,
        [TASK_STATUS.SYSTEM_COMPLETED, timestamp, '逾期 24 小時未完成，由小吉系統接手完成。', timestamp, current.guild_id, current.id]
      );
      const penalty = createWorkPenaltyWithApi(api, {
        guildId: current.guild_id,
        userId: current.user_id,
        jobId: Number(current.job_id),
        jobName: current.job_name,
        taskId: Number(current.id),
        sourceType: 'work_task',
        sourceId: Number(current.id),
        sourceChannelId: current.expected_channel_id || null,
        penaltyDate: getTaiwanDateLabel(new Date(current.created_at)),
        amount: Number(current.job_daily_salary || 0),
        reason: `工作任務 #${current.id} 逾期 24 小時未完成，由小吉接手，扣除當日薪水。`,
        createdAt: timestamp,
      });

      insertWorkAuditLog(api, {
        guildId: current.guild_id,
        operatorId: 'system',
        targetUserId: current.user_id,
        action: 'work:system-completed',
        reason: '工作任務逾期由小吉系統接手完成',
        details: { taskId: Number(current.id), jobId: Number(current.job_id), penaltyId: penalty?.id || null },
        createdAt: timestamp,
      });

      return { completed: true, penalty };
    });

    if (result.completed) {
      completedBySystem++;
    }
    if (result.penalty) {
      penaltiesCreated++;
    }
  }

  const announcements = client ? await processWorkPenaltyAnnouncements(client, { guildId }) : { checked: 0, announced: 0 };
  return { checked: rows.length, completedBySystem, penaltiesCreated, announcements };
}

async function processDueJobs(client = null) {
  const now = nowIso();
  const dueJobs = await withCoinDatabase((api) =>
    api.all('SELECT * FROM coin_jobs WHERE status = ? AND is_paid = 0 AND pay_at <= ?', [
      JOB_STATUS.ACTIVE,
      now,
    ])
  );

  if (dueJobs.length === 0) {
    return { processed: 0, success: 0, fail: 0 };
  }

  logger.info(`正在處理 ${dueJobs.length} 筆到期工作發薪...`);
  let successCount = 0;
  let failCount = 0;

  for (const jobRow of dueJobs) {
    const job = mapJob(jobRow);

    try {
      const payroll = await withCoinTransaction((api) => {
        const currentJob = api.get(
          'SELECT * FROM coin_jobs WHERE id = ? AND status = ? AND is_paid = 0',
          [job.id, JOB_STATUS.ACTIVE]
        );
        if (!currentJob) {
          return null;
        }

        const timestamp = nowIso();
        api.run(
          `UPDATE coin_work_tasks
           SET status = ?
           WHERE guild_id = ? AND job_id = ? AND status = ? AND completed_at IS NULL`,
          [TASK_STATUS.EXPIRED, job.guildId, job.id, TASK_STATUS.PENDING]
        );

        const calculated = calculatePayrollForJob(api, currentJob);
        const player = ensurePlayer(api, job.guildId, job.userId);
        const after = player.balance + calculated.paidAmount;

        if (calculated.paidAmount > 0) {
          mutateWalletWithApi(api, {
            guildId: job.guildId,
            userId: job.userId,
            type: calculated.transactionType,
            balanceDelta: calculated.paidAmount,
            totalEarnedDelta: calculated.paidAmount,
            operatorId: 'system',
            reason: `工作薪資：${job.jobName}，工作 ${job.workDays} 天。${calculated.reason}`,
            metadata: {
              jobId: job.id,
              jobName: job.jobName,
              workDays: job.workDays,
              totalTasks: calculated.totalTasks,
              completedTasks: calculated.completedTasks,
              payRatio: calculated.payRatio,
              externalServerCount: calculated.externalServerCount,
              extraAmount: calculated.extraAmount,
              venueBonusAmount: calculated.venueBonusAmount,
              venueBonusItemIds: calculated.venueBonusItemIds,
              penaltyAmount: calculated.penaltyAmount,
              penaltyIds: calculated.penaltyIds,
            },
            createdAt: timestamp,
          });
        }

        api.run(
          `INSERT INTO coin_payroll_history
            (guild_id, user_id, job_id, job_name, base_salary, total_tasks, completed_tasks, pay_ratio, paid_amount, reason, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            job.guildId,
            job.userId,
            job.id,
            job.jobName,
            calculated.baseSalary,
            calculated.totalTasks,
            calculated.completedTasks,
            calculated.payRatio,
            calculated.paidAmount,
            calculated.reason,
            timestamp,
          ]
        );

        for (const taskId of calculated.payableTaskIds) {
          api.run(
            `UPDATE coin_work_tasks
             SET status = ?, is_paid = 1, paid_at = ?, paid_amount = ?, updated_at = ?
             WHERE guild_id = ? AND id = ?`,
            [TASK_STATUS.PAID, timestamp, calculated.paidAmount, timestamp, job.guildId, taskId]
          );
        }

        for (const orderItemId of calculated.venueBonusItemIds) {
          api.run(
            `UPDATE casino_venue_order_items
             SET bonus_paid = 1, updated_at = ?
             WHERE guild_id = ? AND id = ?`,
            [timestamp, job.guildId, orderItemId]
          );
        }

        for (const penaltyId of calculated.penaltyIds || []) {
          api.run(
            `UPDATE coin_work_penalties
             SET applied_at = ?, updated_at = ?
             WHERE guild_id = ? AND id = ? AND status = ?`,
            [timestamp, timestamp, job.guildId, penaltyId, PenaltyStatus.ACTIVE]
          );
        }

        insertWorkAuditLog(api, {
          guildId: job.guildId,
          operatorId: 'system',
          targetUserId: job.userId,
          action: calculated.paidAmount > 0 ? 'work:payroll-paid' : 'work:payroll-skipped',
          reason: calculated.reason,
          details: {
            jobId: job.id,
            jobName: job.jobName,
            paidAmount: calculated.paidAmount,
            payableTaskIds: calculated.payableTaskIds,
            externalServerCount: calculated.externalServerCount,
            venueBonusAmount: calculated.venueBonusAmount,
            venueBonusItemIds: calculated.venueBonusItemIds,
            penaltyAmount: calculated.penaltyAmount,
            penaltyIds: calculated.penaltyIds,
          },
          createdAt: timestamp,
        });

        const payrollSucceeded = calculated.completedTasks > 0 || calculated.paidAmount > 0;
        api.run(
          'UPDATE coin_jobs SET status = ?, is_paid = ?, actual_paid_at = ?, payroll_status = ?, updated_at = ? WHERE id = ?',
          [
            payrollSucceeded ? JOB_STATUS.PAID : JOB_STATUS.FAILED,
            payrollSucceeded ? 1 : 0,
            timestamp,
            payrollSucceeded ? PAYROLL_STATUS.PAID : PAYROLL_STATUS.FAILED,
            timestamp,
            job.id,
          ]
        );

        return calculated;
      });

      if (client && payroll) {
        const guild = await client.guilds.fetch(job.guildId).catch(() => null);
        const member = guild ? await guild.members.fetch(job.userId).catch(() => null) : null;
        if (member) {
          const { getClientExtensionHost } = require('../extensions/extensionHost');
          await getClientExtensionHost(client).runHook('workRole.removeJobRoleForMember', {
            member,
            jobName: job.jobName,
          }).catch((error) => {
            logger.warn(`發薪後移除工作身分組失敗：job=${job.id}`, error);
          });
        }
      }

      successCount++;
    } catch (error) {
      logger.error(`發放工作薪資失敗 (JobID: ${job.id})`, error);
      failCount++;

      try {
        await withCoinTransaction((api) => {
          const timestamp = nowIso();
          api.run('UPDATE coin_jobs SET status = ?, payroll_status = ?, updated_at = ? WHERE id = ?', [
            JOB_STATUS.FAILED,
            PAYROLL_STATUS.FAILED,
            timestamp,
            job.id,
          ]);
        });
      } catch (updateError) {
        logger.error(`標記工作發薪失敗狀態也失敗 (JobID: ${job.id})`, updateError);
      }
    }
  }

  logger.info(`發薪完成：成功 ${successCount} 筆，失敗 ${failCount} 筆。`);
  return { processed: dueJobs.length, success: successCount, fail: failCount };
}

module.exports = {
  APPEAL_WINDOW_DAYS,
  AppealStatus,
  BASIC_SALARY_RATIO,
  JOB_STATUS,
  JOB_TYPES,
  PAYROLL_STATUS,
  PenaltyStatus,
  TASK_STATUS,
  VENUE_JOB_NAMES,
  WAITER_JOB_NAMES,
  addPendingTask,
  cancelJob,
  createWorkPenaltyAppeal,
  createWorkPenaltyWithApi,
  deleteWorkSubmission,
  editWorkSubmission,
  getActiveJob,
  getActiveJobs,
  getAllWorkStatuses,
  getPayrollHistory,
  getWorkStatus,
  isVenueJobName,
  isWaiterJobName,
  listPendingWorkSubmissions,
  listWorkPenalties,
  listJobs,
  listWorkTasks,
  previewPayroll,
  processDueJobs,
  processExpiredWorkTasks,
  processWorkPenaltyAnnouncements,
  processWorkReminders,
  reportWork,
  reviewWorkPenaltyAppeal,
  reviewWorkSubmission,
  startJob,
  startVenueJobs,
  updateJobRoleId,
};
