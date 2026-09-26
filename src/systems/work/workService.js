const { withCoinDatabase, withCoinTransaction } = require('../../services/coinDatabase');
const {
  CoinServiceError,
  TransactionType,
  ensureGuildSettings,
  ensurePlayer,
  insertAdminLog,
} = require('../../services/coinService');
const { mutateWalletWithApi } = require('../../services/coinWalletService');
const { grantRewardOnceV2, getRewardReceiptV2, grantRewardOnceV2WithApi, makeRewardKey } = require('../../services/featurePlatformService');
const { createRuntimeRewardCoordinator } = require('../../coordinators/rewardRuntime');
const {
  activatePrimaryJobWithApi,
  calculateGlobalPayrollWithApi,
  captureLegacyJobsForUserWithApi,
  completeWorkTaskWithApi,
  createGlobalPendingTaskWithApi,
  createGlobalWorkTaskWithApi,
  getActiveCycleForUser,
  hasOpenLegacyVenueWithApi,
  hasOpenPrimaryWaiterOrderWithApi,
  legacySettlementPeriodKey,
  mapPrimary,
  reviewPrimaryPenaltyAppealWithApi,
  selectPrimaryJobWithApi,
  verifySavedSnapshot,
} = require('../economy/workSystem');
const logger = require('../../utils/logger');
const { isBotOwner } = require('../../utils/ownerOnly');

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
    scope: 'legacy',
    guildId: row.guild_id,
    sourceGuildId: row.guild_id,
    triggerGuildId: row.guild_id,
    roleSyncEligible: row.status === JOB_STATUS.ACTIVE,
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

function mapPrimaryWorkView(row, cycle = null, triggerGuildId = null) {
  if (!row) return null;
  if (row.state === 'active' && (!cycle || cycle.status !== 'active' ||
      cycle.cycle_id !== row.next_cycle_id || cycle.user_id !== row.user_id)) {
    throw new CoinServiceError('PRIMARY_CYCLE_CONFLICT', '全域主職與有效週期不一致，暫停查詢。');
  }
  return {
    id: 'primary:' + row.next_cycle_id,
    scope: 'primary',
    globalCycleId: row.next_cycle_id,
    guildId: row.source_guild_id,
    sourceGuildId: row.source_guild_id,
    triggerGuildId,
    roleSyncEligible: false,
    userId: row.user_id,
    jobName: row.job_name,
    workDays: Number(row.work_days),
    status: row.state,
    startAt: row.effective_from || null,
    payAt: cycle?.ends_at || null,
    requestedAt: row.requested_at,
    notBeforeAt: row.not_before_at,
    effectiveUntil: row.effective_until || null,
    legacyJobId: row.legacy_job_id == null ? null : Number(row.legacy_job_id),
    settledAmount: cycle?.paid_amount == null ? null : Number(cycle.paid_amount),
    settledAt: cycle?.settled_at || null,
    createdAt: row.requested_at,
    updatedAt: row.updated_at,
  };
}

function getActivePrimaryCycleForRoleWithApi(api, {
  userId, cycleId, jobName, sourceGuildId, timestamp = new Date().toISOString(),
}) {
  const now = Date.parse(timestamp);
  if (!Number.isFinite(now)) return null;
  const primary = api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [userId]);
  if (!primary || primary.state !== 'active' || primary.next_cycle_id !== cycleId ||
      primary.job_name !== jobName || primary.source_guild_id !== sourceGuildId) return null;
  const cycle = api.get('SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ? AND user_id = ?',
    [cycleId, userId]);
  const startsAt = Date.parse(cycle?.starts_at);
  const endsAt = Date.parse(cycle?.ends_at);
  if (!cycle || cycle.status !== 'active' || cycle.user_id !== userId ||
      cycle.job_name !== jobName || cycle.source_guild_id !== sourceGuildId ||
      !Number.isFinite(startsAt) || !Number.isFinite(endsAt) ||
      startsAt > now || endsAt <= now) return null;
  return cycle;
}

function sortWorkStatusRows(rows, limit) {
  const priority = { active: 0, pending_legacy: 1, paid: 2, closed: 2, failed: 3 };
  return rows.sort((a, b) =>
    (priority[a.status] ?? 4) - (priority[b.status] ?? 4) ||
    String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')) ||
    String(b.id).localeCompare(String(a.id))
  ).slice(0, normalizeLimit(limit));
}

function mapTask(row) {
  const attachmentUrls = parseJsonArray(row.attachment_urls);
  const externalServerIds = parseJsonArray(row.external_server_ids);

  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    jobId: row.job_id === null || row.job_id === undefined ? null : Number(row.job_id),
    globalCycleId: row.global_cycle_id || null,
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

function calculatePayrollForJob(api, jobRow, snapshot) {
  const job = mapJob(jobRow);
  if (!snapshot || snapshot.job_id !== job.id || snapshot.user_id !== job.userId ||
      snapshot.source_guild_id !== job.guildId || snapshot.rule_version !== 'legacy-v21') {
    throw new CoinServiceError('WORK_SNAPSHOT_REQUIRED', '舊工作薪資規則未固定，暫停結算。');
  }
  const rules = JSON.parse(snapshot.rules_json);
  const currentDailySalary = Number(snapshot.daily_salary);
  const baseSalary = currentDailySalary * Number(snapshot.work_days);
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
  const externalServerBonus = Number(rules.translatorBonus || 0);
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

async function captureLegacyJobBatch({ afterUserId = '', limit = 50 } = {}) {
  const batchSize = Math.min(Math.max(Number(limit) || 50, 1), 100);
  return withCoinTransaction((api) => {
    const users = api.all(
      "SELECT DISTINCT user_id FROM coin_jobs WHERE user_id > ? AND status IN ('active', 'failed') AND is_paid = 0 ORDER BY user_id ASC LIMIT ?",
      [afterUserId, batchSize]
    );
    let snapshotCount = 0;
    for (const user of users) {
      snapshotCount += captureLegacyJobsForUserWithApi(api, user.user_id, JOB_TYPES).length;
    }
    return {
      users: users.length,
      snapshots: snapshotCount,
      nextUserId: users.length === batchSize ? users[users.length - 1].user_id : null,
    };
  });
}

async function startJob(guildId, userId, jobName, days) {
  return withCoinTransaction((api) => selectPrimaryJobWithApi(api, {
    guildId, userId, jobName, workDays: normalizeWorkDays(days), jobTypes: JOB_TYPES,
  }));
}

async function startVenueJobs(guildId, userId, { days, chef = false, bartender = false, waiter = 'none' } = {}) {
  const selected = [
    chef ? '廚師' : null,
    bartender ? '調酒師' : null,
    waiter !== 'none' ? waiter : null,
  ].filter(Boolean);
  if (selected.length !== 1 || !VENUE_JOB_NAMES.includes(selected[0])) {
    throw new CoinServiceError('ONE_PRIMARY_JOB_REQUIRED', '每人只能選擇一種主職，請從場館職業中選一種。');
  }
  return startJob(guildId, userId, selected[0], days);
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
  return withCoinDatabase((api) => {
    const legacy = api.all(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ? ORDER BY id ASC',
      [guildId, userId, JOB_STATUS.ACTIVE]
    ).map(mapJob);
    const primary = api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [userId]);
    if (primary?.state !== 'active') return legacy;
    const cycle = api.get('SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ? AND user_id = ?',
      [primary.next_cycle_id, userId]);
    return [mapPrimaryWorkView(primary, cycle, guildId), ...legacy];
  });
}

async function getWorkStatus(guildId, userId) {
  return withCoinDatabase((api) => {
    const activeJobs = api
      .all(
      'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND status = ? ORDER BY id ASC',
      [guildId, userId, JOB_STATUS.ACTIVE]
      )
      .map(mapJob);
    const primaryRow = api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [userId]);
    const primary = mapPrimary(primaryRow);
    const primaryCycle = primaryRow ? api.get(
      'SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ? AND user_id = ?',
      [primaryRow.next_cycle_id, userId]
    ) : null;
    const currentCyclePayroll = primaryCycle ? api.get(
      'SELECT paid_amount, settled_at FROM coin_primary_cycle_payroll WHERE cycle_id = ?',
      [primaryCycle.cycle_id]
    ) : null;
    const primaryStatusView = mapPrimaryWorkView(primaryRow, primaryCycle ? {
      ...primaryCycle,
      paid_amount: currentCyclePayroll?.paid_amount ?? null,
      settled_at: currentCyclePayroll?.settled_at || null,
    } : null, guildId);
    const activeCycle = primary?.state === 'active' ? primaryCycle : null;
    const activePrimaryJob = primaryRow?.state === 'active'
      ? primaryStatusView : null;
    const latestPrimaryPayroll = api.get(
      'SELECT p.*, c.job_name, c.ends_at FROM coin_primary_cycle_payroll p JOIN coin_primary_job_cycles c ON c.cycle_id = p.cycle_id WHERE p.user_id = ? ORDER BY p.settled_at DESC LIMIT 1',
      [userId]
    );
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
      activeJob: activePrimaryJob || activeJobs[0] || null,
      activeJobs,
      activePrimaryJob,
      primaryStatusView,
      primary,
      activeCycle,
      latestPayroll: latestPayroll ? mapPayroll(latestPayroll) : null,
      latestPrimaryPayroll: latestPrimaryPayroll ? {
        cycleId: latestPrimaryPayroll.cycle_id,
        jobName: latestPrimaryPayroll.job_name,
        paidAmount: Number(latestPrimaryPayroll.paid_amount),
        grossAmount: Number(latestPrimaryPayroll.gross_amount),
        settledAt: latestPrimaryPayroll.settled_at,
      } : null,
      recentTasks: tasks,
    };
  });
}

async function getAllWorkStatuses(guildId, { limit = 10, visibleUserIds = null } = {}) {
  if (!visibleUserIds) {
    throw new CoinServiceError('WORK_VISIBILITY_REQUIRED', '全域工作總覽須先核對目前的伺服器成員名單。');
  }
  return withCoinDatabase((api) => {
    const legacy = api.all(
        `SELECT *
         FROM coin_jobs
         WHERE guild_id = ?
         ORDER BY
           CASE status WHEN 'active' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END,
           updated_at DESC,
           id DESC
         LIMIT ?`,
        [guildId, normalizeLimit(limit)]
      ).map(mapJob);
    const visible = new Set(visibleUserIds);
    const primaryRows = api.all(
      `SELECT p.*, c.cycle_id AS cycle_cycle_id, c.user_id AS cycle_user_id,
              c.status AS cycle_status, c.ends_at AS cycle_ends_at,
              pay.paid_amount AS cycle_paid_amount, pay.settled_at AS cycle_settled_at
       FROM coin_primary_jobs_global p
       LEFT JOIN coin_primary_job_cycles c ON c.cycle_id = p.next_cycle_id
       LEFT JOIN coin_primary_cycle_payroll pay ON pay.cycle_id = c.cycle_id
       ORDER BY p.updated_at DESC, p.user_id ASC`
    );
    const primary = primaryRows
      .filter((row) => visible.has(row.user_id))
      .map((row) => mapPrimaryWorkView(row, row.cycle_cycle_id ? {
        cycle_id: row.cycle_cycle_id, user_id: row.cycle_user_id,
        status: row.cycle_status, ends_at: row.cycle_ends_at,
        paid_amount: row.cycle_paid_amount, settled_at: row.cycle_settled_at,
      } : null, guildId));
    return sortWorkStatusRows([...legacy, ...primary], limit);
  });
}

async function cancelJob() {
  throw new CoinServiceError(
    'WORK_CUTOVER_CANCEL_REVIEW',
    '舊工作與已賺取薪資須先按原規則結清；目前不能取消或清除原工作。'
  );
}
async function reportWork(
  guildId,
  userId,
  {
    taskId = null,
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
    if (taskId != null) {
      if (!Number.isSafeInteger(Number(taskId)) || Number(taskId) <= 0 || noWorkAvailable) {
        throw new CoinServiceError('INVALID_LEGACY_TASK', '待辦 ID 不正確。');
      }
      const normalizedExternalServerIds = normalizeExternalServerIds(externalServerIds);
      const normalizedExternalServerCount = normalizedExternalServerIds.length
        ? normalizedExternalServerIds.length : normalizeExternalServerCount(externalServerCount);
      const completed = completeWorkTaskWithApi(api, {
        guildId, userId, taskId: Number(taskId), description,
        channelId, channelName, messageId, attachmentUrls,
        externalServerCount: normalizedExternalServerCount,
        externalServerIds: normalizedExternalServerIds,
      });
      const row = completed.task;
      return {
        job: completed.scope === 'legacy'
          ? mapJob(api.get('SELECT * FROM coin_jobs WHERE id = ?', [row.job_id]))
          : { id: null, globalCycleId: completed.cycle.cycle_id,
            jobName: completed.cycle.job_name, workDays: Number(completed.cycle.work_days),
            guildId: completed.cycle.source_guild_id, userId },
        task: mapTask(row), legacyCompletion: completed.scope === 'legacy',
      };
    }
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
    }
    const primary = api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [userId]);
    if (!primary || primary.state !== 'active') {
      throw new CoinServiceError(
        'WORK_CUTOVER_FROZEN',
        '切換期間不能新增工作回報；可用待辦 ID 完成切換前已有的任務。'
      );
    }
    const normalizedExternalServerIds = normalizeExternalServerIds(externalServerIds);
    const normalizedExternalServerCount = normalizedExternalServerIds.length
      ? normalizedExternalServerIds.length : normalizeExternalServerCount(externalServerCount);
    const result = createGlobalWorkTaskWithApi(api, {
      guildId, userId, description, taskType, noWorkAvailable, attachmentUrls,
      channelId, channelName, messageId,
      externalServerCount: normalizedExternalServerCount,
      externalServerIds: normalizedExternalServerIds, jobTypes: JOB_TYPES,
    });
    return {
      job: {
        id: null, globalCycleId: result.cycle.cycle_id, jobName: result.cycle.job_name,
        workDays: Number(result.cycle.work_days), guildId: result.cycle.source_guild_id, userId,
      },
      task: mapTask(result.task), legacyCompletion: false,
    };
  });
}
async function addPendingTask(guildId, userId, { taskType = 'admin_task', description, dueHours = WORK_REMINDER_HOURS } = {}) {
  return withCoinTransaction((api) => mapTask(createGlobalPendingTaskWithApi(api, {
    guildId, userId, taskType, description, dueHours: Number(dueHours), jobTypes: JOB_TYPES,
  })));
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
    if (row.global_cycle_id && !row.completed_at) {
      throw new CoinServiceError('PRIMARY_TASK_NOT_COMPLETED', '指派的主職待辦須先用 task-id 完成，才能修改提交內容。');
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
    if (row.global_cycle_id && !row.completed_at) {
      throw new CoinServiceError('PRIMARY_TASK_NOT_COMPLETED', '指派的主職待辦尚未完成，不能刪除以免遺失義務。');
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
    if (row.global_cycle_id && !row.completed_at) {
      throw new CoinServiceError('PRIMARY_TASK_NOT_COMPLETED', '指派的主職待辦尚未完成，不能審核。');
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

async function getPrimaryPayrollHistory(userId, { limit = 10 } = {}) {
  return withCoinDatabase((api) => api.all(
    'SELECT p.*, c.job_name, c.starts_at, c.ends_at FROM coin_primary_cycle_payroll p JOIN coin_primary_job_cycles c ON c.cycle_id = p.cycle_id WHERE p.user_id = ? ORDER BY p.settled_at DESC LIMIT ?',
    [userId, normalizeLimit(limit)]
  ).map((row) => ({
    cycleId: row.cycle_id, jobName: row.job_name, grossAmount: Number(row.gross_amount),
    paidAmount: Number(row.paid_amount), payRatio: Number(row.pay_ratio),
    reason: row.settlement_reason, settledAt: row.settled_at,
  })));
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

async function listPrimaryPenalties(userId, { limit = 10 } = {}) {
  return withCoinDatabase((api) => api.all(
    'SELECT p.* FROM coin_primary_cycle_penalties p WHERE p.user_id = ? ORDER BY p.created_at DESC,p.id DESC LIMIT ?',
    [userId, normalizeLimit(limit)]
  ).map((row) => ({
    id: Number(row.id), cycleId: row.cycle_id, taskId: Number(row.task_id),
    amount: Number(row.amount), status: row.status, reason: row.reason,
    appealDeadline: row.appeal_deadline, appliedAt: row.applied_at || null,
  })));
}

async function createPrimaryPenaltyAppeal(userId, penaltyId, { reason = '' } = {}) {
  return withCoinTransaction((api) => {
    const id = Number(penaltyId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new CoinServiceError('INVALID_PENALTY_ID', '扣薪 ID 不正確。');
    }
    const penalty = api.get('SELECT * FROM coin_primary_cycle_penalties WHERE id = ? AND user_id = ?', [id, userId]);
    if (!penalty) throw new CoinServiceError('PENALTY_NOT_FOUND', '找不到你的主職扣薪紀錄。');
    if (penalty.status !== 'active' || penalty.appeal_deadline < nowIso()) {
      throw new CoinServiceError('PENALTY_NOT_APPEALABLE', '這筆主職扣薪目前不能申訴。');
    }
    if (api.get(
      "SELECT 1 AS found FROM coin_primary_cycle_penalty_appeals WHERE penalty_id = ? AND status = 'pending' LIMIT 1",
      [id]
    )) throw new CoinServiceError('PENALTY_APPEAL_EXISTS', '這筆扣薪已有待審申訴。');
    const timestamp = nowIso();
    api.run(
      "INSERT INTO coin_primary_cycle_penalty_appeals (penalty_id,user_id,reason,status,created_at) VALUES (?,?,?,'pending',?)",
      [id, userId, normalizeDescription(reason, '未提供申訴事由'), timestamp]
    );
    const appealId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    return { appealId, penaltyId: id };
  });
}

async function reviewPrimaryPenaltyAppeal(reviewerId, appealId, { action, reason = '' } = {}) {
  if (!isBotOwner(reviewerId)) {
    throw new CoinServiceError('OWNER_REQUIRED', '只有小吉擁有者可審核主職扣薪申訴。');
  }
  return withCoinTransaction((api) => reviewPrimaryPenaltyAppealWithApi(api, {
    reviewerId, appealId, action, reason, timestamp: nowIso(),
  }));
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
  if (!client) return false;
  const guild = await client.guilds.fetch(row.guild_id).catch(() => null);
  const member = guild ? await guild.members.fetch(row.user_id).catch(() => null) : null;
  if (!member) return false;
  const actionHint = String(row.task_type || '').startsWith('casino_venue_')
    ? '你有尚未完成的場館任務，請用對應場館指令處理。'
    : '請使用 /work submit 的 task-id 完成這筆待辦。';
  const message = [
    '你有一筆小吉工作待辦。',
    '任務 #' + row.id + '：' + (row.description || row.task_type),
    actionHint,
  ].join('\n');
  return member.send({ content: message, allowedMentions: { parse: [] } })
    .then(() => true).catch(() => false);
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
         AND t.reminder_count < 3
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

  const globalParams = [now, cutoff];
  const globalGuildFilter = guildId ? 'AND t.guild_id = ?' : '';
  if (guildId) globalParams.push(guildId);
  const globalRows = await withCoinDatabase((api) => api.all(
    "SELECT t.* FROM coin_work_tasks t JOIN coin_primary_job_cycles c ON c.cycle_id = t.global_cycle_id WHERE t.status = 'pending' AND t.completed_at IS NULL AND t.reminder_count < 3 AND c.status = 'active' AND t.due_at <= ? AND (t.last_reminder_at IS NULL OR t.last_reminder_at <= ?) " +
      globalGuildFilter + ' ORDER BY t.due_at,t.id LIMIT 25',
    globalParams
  ));
  for (const row of globalRows) {
    const sent = await sendWorkReminder(client, row);
    await withCoinTransaction((api) => api.run(
      "UPDATE coin_work_tasks SET reminder_count = reminder_count + 1, last_reminder_at = ?, updated_at = ? WHERE id = ? AND global_cycle_id = ? AND status = 'pending' AND completed_at IS NULL AND reminder_count < 3",
      [nowIso(), nowIso(), row.id, row.global_cycle_id]
    ));
    if (sent) reminded++;
  }
  return { checked: rows.length + globalRows.length, reminded };
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

  const primary = await processExpiredPrimaryTasks({ guildId, date });
  const announcements = client ? await processWorkPenaltyAnnouncements(client, { guildId }) : { checked: 0, announced: 0 };
  return { checked: rows.length, completedBySystem, penaltiesCreated, primary, announcements };
}

async function processExpiredPrimaryTasks({ guildId = null, date = new Date() } = {}) {
  const cutoff = new Date(date.getTime() - WORK_AUTO_COMPLETE_HOURS * 3_600_000).toISOString();
  const params = [cutoff];
  const guildFilter = guildId ? 'AND t.guild_id = ?' : '';
  if (guildId) params.push(guildId);
  const rows = await withCoinDatabase((api) => api.all(
    "SELECT t.id FROM coin_work_tasks t JOIN coin_primary_job_cycles c ON c.cycle_id = t.global_cycle_id WHERE t.status = 'pending' AND t.completed_at IS NULL AND t.created_at <= ? AND c.status = 'active' " +
      guildFilter + ' ORDER BY t.created_at,t.id LIMIT 50',
    params
  ));
  let completed = 0;
  let penalties = 0;
  for (const row of rows) {
    try {
      const result = await withCoinTransaction((api) => {
        const task = api.get(
          "SELECT t.*, c.salary_snapshot_json, c.status AS cycle_status FROM coin_work_tasks t JOIN coin_primary_job_cycles c ON c.cycle_id = t.global_cycle_id WHERE t.id = ? AND t.status = 'pending' AND t.completed_at IS NULL",
          [row.id]
        );
        if (!task || task.cycle_status !== 'active') return null;
        const timestamp = date.toISOString();
        api.run(
          "UPDATE coin_work_tasks SET status = 'system_completed', completed_at = ?, review_reason = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND completed_at IS NULL",
          [timestamp, '逾期 24 小時未完成，由系統接手。', timestamp, task.id]
        );
        if (Number(api.get('SELECT changes() AS count').count) !== 1) return null;
        const salary = JSON.parse(task.salary_snapshot_json);
        const amount = Number(salary.dailySalary);
        if (!Number.isSafeInteger(amount) || amount < 0) {
          throw new CoinServiceError('GLOBAL_SALARY_RULE_UNKNOWN', '新主職日薪無法核對，暫停逾期處理。');
        }
        if (amount > 0 && !api.get(
          'SELECT 1 AS found FROM coin_primary_cycle_penalties WHERE cycle_id = ? AND task_id = ? LIMIT 1',
          [task.global_cycle_id, task.id]
        )) {
          api.run(
            "INSERT INTO coin_primary_cycle_penalties (cycle_id,user_id,task_id,amount,status,reason,appeal_deadline,created_at,updated_at) VALUES (?,?,?,?,'active',?,?,?,?)",
            [
              task.global_cycle_id, task.user_id, task.id, amount,
              '工作任務逾期 24 小時未完成，由系統接手。',
              addDaysIso(timestamp, APPEAL_WINDOW_DAYS), timestamp, timestamp,
            ]
          );
        }
        return { penalized: amount > 0 };
      });
      if (result) {
        completed++;
        if (result.penalized) penalties++;
      }
    } catch (error) {
      logger.error('全域主職逾期任務處理失敗：task=' + row.id, error);
    }
  }
  return { checked: rows.length, completed, penalties };
}

async function runPrimaryRoleCleanupAfterCommit(client, { cycleId, userId, sourceGuildId },
  { runHook = null } = {}) {
  if (!client) return { skipped: true };
  const invoke = runHook || ((name, payload) => {
    const { getClientExtensionHost } = require('../../extensions/extensionHost');
    return getClientExtensionHost(client).runHook(name, payload);
  });
  const results = await invoke('workRole.clearPrimaryJobRoleForMember', {
    client, cycleId, userId, sourceGuildId,
  });
  const result = results.find((item) => item.result !== undefined)?.result;
  return result || { skipped: true };
}

async function processDuePrimaryCycles(client = null) {
  const timestamp = nowIso();
  const dueCycles = await withCoinDatabase((api) => api.all(
    "SELECT cycle_id FROM coin_primary_job_cycles WHERE status = 'active' AND ends_at <= ? ORDER BY ends_at ASC LIMIT 50",
    [timestamp]
  ));
  let settled = 0;
  let failed = 0;
  let roleCleanupFailed = 0;
  for (const due of dueCycles) {
    try {
      const result = await withCoinTransaction((api) => {
        const cycle = api.get(
          "SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ? AND status = 'active'",
          [due.cycle_id]
        );
        if (!cycle) return null;
        const primary = api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [cycle.user_id]);
        if (!primary || primary.state !== 'active' || primary.next_cycle_id !== cycle.cycle_id) {
          throw new CoinServiceError('PRIMARY_CYCLE_CONFLICT', '主職與週期不一致，暫停結算。');
        }
        if (api.get('SELECT 1 AS found FROM coin_primary_cycle_payroll WHERE cycle_id = ?', [cycle.cycle_id])) {
          throw new CoinServiceError('PRIMARY_PAYROLL_CONFLICT', '本期已有結算收據但仍為進行中，請人工對帳。');
        }
        if (api.get(
          "SELECT 1 AS found FROM coin_work_tasks WHERE global_cycle_id = ? AND status = 'pending' AND completed_at IS NULL LIMIT 1",
          [cycle.cycle_id]
        )) return null;
        if (hasOpenPrimaryWaiterOrderWithApi(api, cycle)) return null;
        if (['廚師', '調酒師'].includes(cycle.job_name) && api.get(
          "SELECT 1 AS found FROM casino_venue_order_items WHERE global_cycle_id = ? AND status = 'pending' LIMIT 1",
          [cycle.cycle_id]
        )) return null;
        const calculated = calculateGlobalPayrollWithApi(api, cycle);
        if (typeof makeRewardKey !== 'function' || typeof grantRewardOnceV2 !== 'function' ||
            typeof getRewardReceiptV2 !== 'function' || typeof grantRewardOnceV2WithApi !== 'function') {
          throw new CoinServiceError('WORK_REWARD_API_REQUIRED', '全域結算介面尚未就緒，暫停發薪。');
        }
        const canonicalSourceId = 'primary:' + cycle.cycle_id;
        const rewardKey = makeRewardKey({
          kind: 'work-settlement', canonicalSourceId, rewardKind: 'salary', userId: cycle.user_id,
        });
        let transactionId = null;
        if (calculated.paidAmount > 0) {
          const grant = createRuntimeRewardCoordinator().grantInTransaction(api, {
            kind: 'work-settlement', canonicalSourceId, rewardKind: 'salary',
            userId: cycle.user_id, sourceGuildId: cycle.source_guild_id,
            amount: calculated.paidAmount, operationId: 'work-settlement:primary:' + cycle.cycle_id,
          });
          if (grant.alreadyGranted || grant.receipt.rewardKey !== rewardKey ||
              grant.receipt.amount !== calculated.paidAmount) {
            throw new CoinServiceError('PRIMARY_REWARD_CONFLICT', '主職發幣收據與結算金額不符，請人工對帳。');
          }
          transactionId = grant.receipt.transactionId;
        }
        api.run(
          'INSERT INTO coin_primary_cycle_payroll (cycle_id,user_id,source_guild_id,gross_amount,paid_amount,pay_ratio,settlement_reason,reward_key,transaction_id,settled_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [
            cycle.cycle_id, cycle.user_id, cycle.source_guild_id,
            calculated.grossAmount, calculated.paidAmount, calculated.payRatio,
            calculated.reason, rewardKey, transactionId, timestamp,
          ]
        );
        for (const taskId of calculated.taskIds) {
          api.run(
            "UPDATE coin_work_tasks SET status = 'paid', is_paid = 1, paid_at = ?, paid_amount = 0, updated_at = ? WHERE id = ? AND global_cycle_id = ?",
            [timestamp, timestamp, taskId, cycle.cycle_id]
          );
        }
        for (const itemId of calculated.venueItemIds) {
          api.run(
            'UPDATE casino_venue_order_items SET bonus_paid = 1, updated_at = ? WHERE id = ? AND global_cycle_id = ?',
            [timestamp, itemId, cycle.cycle_id]
          );
        }
        for (const penaltyId of calculated.penaltyIds) {
          api.run(
            "UPDATE coin_primary_cycle_penalties SET applied_at = ?, updated_at = ? WHERE id = ? AND cycle_id = ? AND status = 'active'",
            [timestamp, timestamp, penaltyId, cycle.cycle_id]
          );
        }
        api.run(
          "UPDATE coin_primary_job_cycles SET status = 'settled', reward_key = ?, updated_at = ? WHERE cycle_id = ? AND status = 'active'",
          [rewardKey, timestamp, cycle.cycle_id]
        );
        if (Number(api.get('SELECT changes() AS count').count) !== 1) {
          throw new CoinServiceError('PRIMARY_CYCLE_CONFLICT', '主職週期狀態已變更，暫停結算。');
        }
        api.run(
          "UPDATE coin_primary_jobs_global SET state = 'closed', effective_until = ?, updated_at = ? WHERE user_id = ? AND state = 'active' AND next_cycle_id = ?",
          [timestamp, timestamp, cycle.user_id, cycle.cycle_id]
        );
        if (Number(api.get('SELECT changes() AS count').count) !== 1) {
          throw new CoinServiceError('PRIMARY_JOB_CONFLICT', '主職狀態已變更，暫停結算。');
        }
        return { calculated, cycleId: cycle.cycle_id,
          userId: cycle.user_id, sourceGuildId: cycle.source_guild_id };
      });
      if (result) {
        settled++;
        try {
          const cleanup = await runPrimaryRoleCleanupAfterCommit(client, result);
          if (cleanup.ok === false) {
            roleCleanupFailed++;
            logger.warn('全域主職已結算，但角色清理仍需核對：cycle=' + result.cycleId,
              cleanup.warnings);
          }
        } catch (error) {
          roleCleanupFailed++;
          logger.warn('全域主職已結算，但角色清理失敗：cycle=' + result.cycleId, error);
        }
      }
    } catch (error) {
      logger.error('全域主職結算失敗，保留原週期：cycle=' + due.cycle_id, error);
      failed++;
    }
  }
  return { checked: dueCycles.length, settled, failed, roleCleanupFailed };
}

async function processPrimaryJobActivations() {
  const timestamp = nowIso();
  const users = await withCoinDatabase((api) => api.all(
    "SELECT user_id FROM coin_primary_jobs_global WHERE state = 'pending_legacy' AND not_before_at <= ? ORDER BY not_before_at ASC LIMIT 50",
    [timestamp]
  ));
  let activated = 0;
  for (const row of users) {
    try {
      const result = await withCoinTransaction((api) => activatePrimaryJobWithApi(api, {
        userId: row.user_id, jobTypes: JOB_TYPES, calculatePayTime, timestamp,
      }));
      if (result) activated++;
    } catch (error) {
      logger.error('啟動全域主職失敗，保留待審：user=' + row.user_id, error);
    }
  }
  return { checked: users.length, activated };
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
    const primaryExpired = await processExpiredPrimaryTasks();
    const primaryCycles = await processDuePrimaryCycles(client);
    const activations = await processPrimaryJobActivations();
    return { processed: 0, success: 0, fail: 0, primaryExpired, primaryCycles, activations };
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
        if (hasOpenLegacyVenueWithApi(api, job.id)) {
          throw new CoinServiceError('WORK_VENUE_PENDING', '舊場館訂單或小費尚未結清，暫緩原職發薪。');
        }

        const timestamp = nowIso();
        api.run(
          `UPDATE coin_work_tasks
           SET status = ?
           WHERE guild_id = ? AND job_id = ? AND status = ? AND completed_at IS NULL`,
          [TASK_STATUS.EXPIRED, job.guildId, job.id, TASK_STATUS.PENDING]
        );

        const snapshot = api.get('SELECT * FROM coin_work_legacy_snapshots WHERE job_id = ?', [job.id]);
        if (!snapshot) throw new CoinServiceError('WORK_SNAPSHOT_REQUIRED', '舊工作尚未建立固定快照，暫停發薪。');
        verifySavedSnapshot(api, snapshot);
        if (api.get('SELECT 1 AS found FROM coin_payroll_history WHERE job_id = ? LIMIT 1', [job.id])) {
          throw new CoinServiceError('WORK_PRIOR_PAYROLL_CONFLICT', '舊工作已有發薪紀錄但仍待結算，請人工對帳。');
        }
        const periodKey = legacySettlementPeriodKey(snapshot);
        if (api.get(
          'SELECT 1 AS found FROM coin_work_legacy_settlements WHERE job_id = ? AND period_key = ? AND user_id = ?',
          [job.id, periodKey, job.userId]
        )) {
          throw new CoinServiceError('WORK_SETTLEMENT_CONFLICT', '舊工作已有結算收據但工作仍未關閉，請人工對帳。');
        }
        const calculated = calculatePayrollForJob(api, currentJob, snapshot);
        if (typeof makeRewardKey !== 'function' || typeof grantRewardOnceV2 !== 'function' ||
            typeof getRewardReceiptV2 !== 'function' || typeof grantRewardOnceV2WithApi !== 'function') {
          throw new CoinServiceError('WORK_REWARD_API_REQUIRED', '全域結算介面尚未就緒，暫停發薪。');
        }
        const canonicalSourceId = 'legacy:' + job.id + ':' + periodKey;
        const rewardKey = makeRewardKey({
          kind: 'work-settlement', canonicalSourceId, rewardKind: 'salary', userId: job.userId,
        });
        let transactionId = null;
        if (calculated.paidAmount > 0) {
          const grant = createRuntimeRewardCoordinator().grantInTransaction(api, {
            kind: 'work-settlement', canonicalSourceId, rewardKind: 'salary',
            userId: job.userId, sourceGuildId: job.guildId, amount: calculated.paidAmount,
            operationId: 'work-settlement:' + job.id + ':' + periodKey + ':' + job.userId,
          });
          if (grant.alreadyGranted || grant.receipt.rewardKey !== rewardKey ||
              grant.receipt.amount !== calculated.paidAmount) {
            throw new CoinServiceError('WORK_REWARD_CONFLICT', '工作發幣收據與固定結算內容不符，請人工對帳。');
          }
          transactionId = grant.receipt.transactionId;
        }
        api.run(
          'INSERT INTO coin_work_legacy_settlements (job_id,period_key,user_id,source_guild_id,reward_key,amount,status,transaction_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)',
          [job.id, periodKey, job.userId, job.guildId, rewardKey,
            calculated.paidAmount, 'granted', transactionId, timestamp, timestamp]
        );
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

        api.run(
          'UPDATE coin_jobs SET status = ?, is_paid = ?, actual_paid_at = ?, payroll_status = ?, updated_at = ? WHERE id = ?',
          [
            JOB_STATUS.PAID,
            1,
            timestamp,
            PAYROLL_STATUS.PAID,
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
          const { getClientExtensionHost } = require('../../extensions/extensionHost');
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


    }
  }

  logger.info(`發薪完成：成功 ${successCount} 筆，失敗 ${failCount} 筆。`);
  const primaryExpired = await processExpiredPrimaryTasks();
  const primaryCycles = await processDuePrimaryCycles(client);
  const activations = await processPrimaryJobActivations();
  return { processed: dueJobs.length, success: successCount, fail: failCount, primaryExpired, primaryCycles, activations };
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
  captureLegacyJobBatch,
  cancelJob,
  createWorkPenaltyAppeal,
  createWorkPenaltyWithApi,
  deleteWorkSubmission,
  editWorkSubmission,
  getActiveJob,
  getActiveJobs,
  getActivePrimaryCycleForRoleWithApi,
  getAllWorkStatuses,
  getPayrollHistory,
  getPrimaryPayrollHistory,
  getWorkStatus,
  isVenueJobName,
  isWaiterJobName,
  listPendingWorkSubmissions,
  listWorkPenalties,
  listPrimaryPenalties,
  listJobs,
  listWorkTasks,
  previewPayroll,
  processDueJobs,
  processDuePrimaryCycles,
  runPrimaryRoleCleanupAfterCommit,
  processPrimaryJobActivations,
  processExpiredWorkTasks,
  processExpiredPrimaryTasks,
  processWorkPenaltyAnnouncements,
  processWorkReminders,
  reportWork,
  reviewWorkPenaltyAppeal,
  createPrimaryPenaltyAppeal,
  reviewPrimaryPenaltyAppeal,
  reviewWorkSubmission,
  startJob,
  startVenueJobs,
  updateJobRoleId,
};
