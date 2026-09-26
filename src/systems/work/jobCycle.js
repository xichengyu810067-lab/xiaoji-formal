const { GLOBAL_RULE_VERSION, BASIC_RATIO } = require('./workRules');
const crypto = require('node:crypto');
const { CoinServiceError, ensureGuildSettings, ensurePlayer } = require('../../services/coinService');

const RULE_VERSION = 'legacy-v21';
const SNAPSHOT_KINDS = [
  ['task', 'SELECT * FROM coin_work_tasks WHERE job_id = ? ORDER BY id ASC'],
  ['penalty', 'SELECT * FROM coin_work_penalties WHERE job_id = ? ORDER BY id ASC'],
  ['appeal', 'SELECT a.* FROM coin_work_penalty_appeals a JOIN coin_work_penalties p ON p.id = a.penalty_id WHERE p.job_id = ? ORDER BY a.id ASC'],
  ['payroll', 'SELECT * FROM coin_payroll_history WHERE job_id = ? ORDER BY id ASC'],
];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function nextTaiwanPayBoundary(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  let boundary = new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), 14, 0, 0));
  if (boundary.getTime() <= now.getTime()) boundary = new Date(boundary.getTime() + 86_400_000);
  return boundary.toISOString();
}

function mapPrimary(row) {
  if (!row) return null;
  return {
    userId: row.user_id, jobName: row.job_name, workDays: Number(row.work_days),
    legacyJobId: row.legacy_job_id == null ? null : Number(row.legacy_job_id),
    sourceGuildId: row.source_guild_id, nextCycleId: row.next_cycle_id,
    requestedAt: row.requested_at, notBeforeAt: row.not_before_at,
    effectiveFrom: row.effective_from || null, effectiveUntil: row.effective_until || null,
    state: row.state,
  };
}

function snapshotItems(api, jobId) {
  const items = [];
  for (const [kind, sql] of SNAPSHOT_KINDS) {
    for (const row of api.all(sql, [jobId])) {
      const snapshotJson = JSON.stringify(row);
      items.push({ kind, id: Number(row.id), snapshotJson, sourceHash: sha256(snapshotJson) });
    }
  }
  return items;
}

function snapshotSetHash(items) {
  const sorted = [...items].sort((a, b) => (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || a.id - b.id);
  return sha256(JSON.stringify(sorted.map((item) => [item.kind, item.id, item.sourceHash])));
}

function verifySavedSnapshot(api, saved) {
  const rows = api.all(
    'SELECT item_kind, item_id, source_hash, snapshot_json FROM coin_work_legacy_snapshot_items WHERE job_id = ? ORDER BY item_kind, item_id',
    [saved.job_id]
  );
  const items = rows.map((row) => ({ kind: row.item_kind, id: Number(row.item_id), sourceHash: row.source_hash }));
  if (rows.length !== Number(saved.snapshot_item_count) ||
      snapshotSetHash(items) !== saved.cutover_state_hash ||
      rows.some((row) => sha256(row.snapshot_json) !== row.source_hash)) {
    throw new CoinServiceError('WORK_SNAPSHOT_CONFLICT', '舊工作快照無法核對，請人工處理。');
  }
  return saved;
}

function captureLegacyJobWithApi(api, job, jobTypes, timestamp) {
  const saved = api.get('SELECT * FROM coin_work_legacy_snapshots WHERE job_id = ?', [job.id]);
  if (saved) return verifySavedSnapshot(api, saved);
  const jobType = jobTypes.find((item) => item.name === job.job_name);
  if (!jobType) throw new CoinServiceError('UNKNOWN_LEGACY_JOB', '舊職業規則無法辨識，請人工處理。');
  const items = snapshotItems(api, job.id);
  const rules = {
    ruleVersion: RULE_VERSION, basicRatio: BASIC_RATIO,
    translatorBonus: Number(jobType.externalServerBonus || 0),
    venueBonus: 'completed-order-items-v21', salaryRequiresEffectiveWork: true,
  };
  const sql = [
    'INSERT INTO coin_work_legacy_snapshots',
    '(job_id,user_id,source_guild_id,job_name,job_role_id,daily_salary,work_days,total_salary,',
    'start_at,pay_at,status,is_paid,payroll_status,rule_version,rules_json,',
    'source_hash,cutover_state_hash,snapshot_item_count,created_at)',
    'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ].join(' ');
  api.run(sql, [
    job.id, job.user_id, job.guild_id, job.job_name, job.job_role_id || null,
    Number(job.daily_salary), Number(job.work_days), Number(job.total_salary),
    job.start_at, job.pay_at, job.status, Number(job.is_paid), job.payroll_status,
    RULE_VERSION, JSON.stringify(rules), sha256(JSON.stringify(job)), snapshotSetHash(items),
    items.length, timestamp,
  ]);
  for (const item of items) {
    api.run(
      'INSERT INTO coin_work_legacy_snapshot_items (job_id,item_kind,item_id,source_hash,snapshot_json,captured_at) VALUES (?,?,?,?,?,?)',
      [job.id, item.kind, item.id, item.sourceHash, item.snapshotJson, timestamp]
    );
  }
  return verifySavedSnapshot(api, api.get('SELECT * FROM coin_work_legacy_snapshots WHERE job_id = ?', [job.id]));
}

function captureLegacyJobsForUserWithApi(api, userId, jobTypes, timestamp = new Date().toISOString()) {
  const jobs = api.all(
    "SELECT * FROM coin_jobs WHERE user_id = ? AND status IN ('active', 'failed') AND is_paid = 0 ORDER BY id ASC",
    [userId]
  );
  return jobs.map((job) => captureLegacyJobWithApi(api, job, jobTypes, timestamp));
}

function selectPrimaryJobWithApi(api, { guildId, userId, jobName, workDays, jobTypes, timestamp = new Date().toISOString() }) {
  const settings = ensureGuildSettings(api, guildId);
  if (!settings.enabled) throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  const jobType = jobTypes.find((item) => item.name === jobName);
  if (!jobType) throw new CoinServiceError('INVALID_JOB', '找不到該職業。');
  if (!Number.isSafeInteger(workDays) || workDays < 1 || workDays > 30) {
    throw new CoinServiceError('INVALID_DAYS', '工作天數必須介於 1 到 30 天之間。');
  }
  ensurePlayer(api, guildId, userId);
  const existing = api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [userId]);
  if (existing && existing.state !== 'closed') {
    if (existing.state === 'pending_legacy' && existing.job_name === jobName &&
        Number(existing.work_days) === workDays && existing.source_guild_id === guildId) {
      return { ...mapPrimary(existing), alreadySelected: true };
    }
    throw new CoinServiceError('PRIMARY_JOB_EXISTS', '你已選擇下一期主職或已有進行中的主職。');
  }
  const snapshots = captureLegacyJobsForUserWithApi(api, userId, jobTypes, timestamp);
  const notBeforeAt = snapshots.reduce((latest, snapshot) => {
    if (!Number.isFinite(Date.parse(snapshot.pay_at))) {
      throw new CoinServiceError('INVALID_LEGACY_PAY_TIME', '舊工作發薪時間無法辨識，請人工處理。');
    }
    return snapshot.pay_at > latest ? snapshot.pay_at : latest;
  }, nextTaiwanPayBoundary(new Date(timestamp)));
  const nextCycleId = crypto.randomUUID();
  if (existing) {
    api.run(
      "UPDATE coin_primary_jobs_global SET job_name = ?, work_days = ?, legacy_job_id = ?, source_guild_id = ?, next_cycle_id = ?, requested_at = ?, not_before_at = ?, effective_from = NULL, effective_until = NULL, state = 'pending_legacy', updated_at = ? WHERE user_id = ? AND state = 'closed'",
      [
        jobName, workDays, snapshots.length === 1 ? snapshots[0].job_id : null,
        guildId, nextCycleId, timestamp, notBeforeAt, timestamp, userId,
      ]
    );
    if (Number(api.get('SELECT changes() AS count').count) !== 1) {
      throw new CoinServiceError('PRIMARY_JOB_CONFLICT', '主職狀態已變更，請重試。');
    }
  } else {
    const sql = [
      'INSERT INTO coin_primary_jobs_global',
      '(user_id,job_name,work_days,legacy_job_id,source_guild_id,next_cycle_id,',
      'requested_at,not_before_at,state,updated_at)',
      "VALUES (?,?,?,?,?,?,?,?,'pending_legacy',?)",
    ].join(' ');
    api.run(sql, [
      userId, jobName, workDays, snapshots.length === 1 ? snapshots[0].job_id : null,
      guildId, nextCycleId, timestamp, notBeforeAt, timestamp,
    ]);
  }
  return {
    ...mapPrimary(api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [userId])),
    legacyCount: snapshots.length, alreadySelected: false,
  };
}

function legacySettlementPeriodKey(snapshot) {
  return snapshot.pay_at;
}

function hasOpenLegacyVenueWithApi(api, jobId) {
  const maker = api.get(
    "SELECT 1 AS found FROM casino_venue_order_items WHERE maker_job_id = ? AND status = 'pending' LIMIT 1",
    [jobId]
  );
  const waiter = api.get(
    "SELECT 1 AS found FROM casino_venue_orders WHERE waiter_job_id = ? AND tip_status = 'escrowed' LIMIT 1",
    [jobId]
  );
  return Boolean(maker || waiter);
}

function legacyReadyForActivation(api, snapshot, now) {
  verifySavedSnapshot(api, snapshot);
  const job = api.get('SELECT * FROM coin_jobs WHERE id = ?', [snapshot.job_id]);
  if (!job || job.user_id !== snapshot.user_id || job.guild_id !== snapshot.source_guild_id ||
      job.status === 'active') return false;
  const settlement = api.get(
    'SELECT * FROM coin_work_legacy_settlements WHERE job_id = ? AND period_key = ? AND user_id = ?',
    [snapshot.job_id, legacySettlementPeriodKey(snapshot), snapshot.user_id]
  );
  if (!settlement || !['granted', 'legacy_paid'].includes(settlement.status)) return false;
  if (hasOpenLegacyVenueWithApi(api, snapshot.job_id)) return false;
  if (api.get(
    "SELECT 1 AS found FROM casino_venue_order_items WHERE maker_job_id = ? AND status = 'completed' AND bonus_paid = 0 AND bonus_amount > 0 LIMIT 1",
    [snapshot.job_id]
  )) return false;
  if (api.get(
    "SELECT 1 AS found FROM coin_work_tasks WHERE job_id = ? AND status = 'pending' AND completed_at IS NULL LIMIT 1",
    [snapshot.job_id]
  )) return false;
  if (api.get(
    "SELECT 1 AS found FROM coin_work_penalty_appeals a JOIN coin_work_penalties p ON p.id = a.penalty_id WHERE p.job_id = ? AND a.status = 'pending' LIMIT 1",
    [snapshot.job_id]
  )) return false;
  if (api.get(
    "SELECT 1 AS found FROM coin_work_penalties WHERE job_id = ? AND status = 'active' AND (applied_at IS NULL OR appeal_deadline_at > ?) LIMIT 1",
    [snapshot.job_id, now]
  )) return false;
  return true;
}

function activatePrimaryJobWithApi(api, { userId, jobTypes, calculatePayTime, timestamp = new Date().toISOString() }) {
  const primary = api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [userId]);
  if (!primary || primary.state !== 'pending_legacy' || primary.not_before_at > timestamp) return null;
  const snapshots = api.all('SELECT * FROM coin_work_legacy_snapshots WHERE user_id = ? ORDER BY job_id ASC', [userId]);
  if (snapshots.some((snapshot) => !legacyReadyForActivation(api, snapshot, timestamp))) return null;
  const jobType = jobTypes.find((item) => item.name === primary.job_name);
  if (!jobType) throw new CoinServiceError('INVALID_JOB', '主職規則無法辨識，請人工處理。');
  const endsAt = calculatePayTime(timestamp, Number(primary.work_days));
  const salarySnapshot = {
    version: GLOBAL_RULE_VERSION, dailySalary: Number(jobType.salary),
    basicRatio: BASIC_RATIO, translatorBonus: Number(jobType.externalServerBonus || 0),
  };
  const insertSql = [
    'INSERT INTO coin_primary_job_cycles',
    '(cycle_id,user_id,job_name,work_days,source_guild_id,starts_at,ends_at,',
    'salary_rule_version,salary_snapshot_json,status,created_at,updated_at)',
    "VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)",
  ].join(' ');
  api.run(insertSql, [
    primary.next_cycle_id, userId, primary.job_name, Number(primary.work_days),
    primary.source_guild_id, timestamp, endsAt, GLOBAL_RULE_VERSION,
    JSON.stringify(salarySnapshot), timestamp, timestamp,
  ]);
  api.run(
    "UPDATE coin_primary_jobs_global SET state = 'active', effective_from = ?, effective_until = ?, updated_at = ? WHERE user_id = ? AND state = 'pending_legacy' AND next_cycle_id = ?",
    [timestamp, endsAt, timestamp, userId, primary.next_cycle_id]
  );
  if (Number(api.get('SELECT changes() AS count').count) !== 1) {
    throw new CoinServiceError('PRIMARY_JOB_CONFLICT', '主職狀態已變更，請重試。');
  }
  return {
    ...mapPrimary(api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [userId])),
    cycleId: primary.next_cycle_id,
  };
}

function getActiveCycleForUser(api, userId, timestamp = new Date().toISOString()) {
  const primary = api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [userId]);
  if (!primary || primary.state !== 'active') return null;
  const cycle = api.get(
    "SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ? AND user_id = ? AND status = 'active'",
    [primary.next_cycle_id, userId]
  );
  if (!cycle || cycle.ends_at <= timestamp) return null;
  return cycle;
}

function completeLegacyTaskWithApi(api, {
  guildId, userId, taskId, description, channelName = null, attachmentUrls = [],
  timestamp = new Date().toISOString(),
}) {
  const row = api.get(
    'SELECT * FROM coin_work_tasks WHERE id = ? AND guild_id = ? AND user_id = ?',
    [taskId, guildId, userId]
  );
  if (!row || row.job_id == null || row.global_cycle_id) {
    throw new CoinServiceError('LEGACY_TASK_NOT_FOUND', '找不到這筆原群待辦。');
  }
  const initial = api.get(
    "SELECT snapshot_json FROM coin_work_legacy_snapshot_items WHERE job_id = ? AND item_kind = 'task' AND item_id = ?",
    [row.job_id, taskId]
  );
  if (!initial) throw new CoinServiceError('LEGACY_TASK_NOT_FROZEN', '這筆任務不是切換前待辦，不能補造新義務。');
  if (row.expected_channel_name &&
      (!channelName || String(channelName).replace(/^#/, '').toLowerCase() !== row.expected_channel_name.toLowerCase())) {
    throw new CoinServiceError('WRONG_WORK_CHANNEL', '請到原指定的工作回報頻道完成待辦。');
  }
  const frozen = JSON.parse(initial.snapshot_json);
  if (frozen.status !== 'pending' || frozen.completed_at || row.status !== 'pending' || row.completed_at || row.is_paid) {
    throw new CoinServiceError('LEGACY_TASK_NOT_PENDING', '這筆原群待辦已完成或無法再提交。');
  }
  api.run(
    'UPDATE coin_work_tasks SET description = ?, attachment_urls = ?, completed_at = ?, updated_at = ? WHERE id = ? AND guild_id = ? AND status = ? AND completed_at IS NULL',
    [
      String(description || '').trim().slice(0, 1000) || row.description,
      attachmentUrls.length ? JSON.stringify(attachmentUrls.map(String)) : row.attachment_urls,
      timestamp, timestamp, taskId, guildId, 'pending',
    ]
  );
  if (Number(api.get('SELECT changes() AS count').count) !== 1) {
    throw new CoinServiceError('LEGACY_TASK_CONFLICT', '原群待辦狀態已變更，請重試。');
  }
  return api.get('SELECT * FROM coin_work_tasks WHERE id = ?', [taskId]);
}

function completePrimaryTaskWithApi(api, {
  guildId, userId, taskId, description, channelId = null, channelName = null,
  messageId = null, attachmentUrls = [], externalServerCount = 0, externalServerIds = [],
  timestamp = new Date().toISOString(),
}) {
  const row = api.get(
    'SELECT * FROM coin_work_tasks WHERE id = ? AND guild_id = ? AND user_id = ?',
    [taskId, guildId, userId]
  );
  if (!row || !row.global_cycle_id || row.job_id != null) {
    throw new CoinServiceError('PRIMARY_TASK_NOT_FOUND', '找不到這筆主職待辦。');
  }
  if (String(row.task_type || '').startsWith('casino_venue_')) {
    throw new CoinServiceError('VENUE_TASK_REQUIRES_ORDER', '場館待辦須透過原場館訂單流程完成。');
  }
  const primary = api.get('SELECT * FROM coin_primary_jobs_global WHERE user_id = ?', [userId]);
  const cycle = api.get('SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ? AND user_id = ?',
    [row.global_cycle_id, userId]);
  if (!primary || primary.state !== 'active' || primary.next_cycle_id !== row.global_cycle_id ||
      !cycle || cycle.status !== 'active' || cycle.job_name !== row.job_name) {
    throw new CoinServiceError('PRIMARY_TASK_CYCLE_CONFLICT', '主職待辦與有效週期不一致，暫停提交。');
  }
  if (row.status !== 'pending' || row.completed_at || row.is_paid) {
    throw new CoinServiceError('PRIMARY_TASK_NOT_PENDING', '這筆主職待辦已完成或不能再提交。');
  }
  const createdAt = Date.parse(row.created_at);
  const submittedAt = Date.parse(timestamp);
  const cycleStartsAt = Date.parse(cycle.starts_at);
  const cycleEndsAt = Date.parse(cycle.ends_at);
  if (!Number.isFinite(createdAt) || !Number.isFinite(cycleStartsAt) ||
      !Number.isFinite(cycleEndsAt) || createdAt < cycleStartsAt || createdAt >= cycleEndsAt) {
    throw new CoinServiceError('PRIMARY_TASK_CYCLE_CONFLICT', '主職待辦建立時間與週期不一致，暫停提交。');
  }
  if (!Number.isFinite(submittedAt) || submittedAt < createdAt ||
      submittedAt >= createdAt + 86_400_000) {
    throw new CoinServiceError('PRIMARY_TASK_EXPIRED', '這筆主職待辦已超過 24 小時提交期限。');
  }
  if (row.expected_channel_id && row.expected_channel_id !== channelId ||
      row.expected_channel_name && (!channelName ||
        String(channelName).replace(/^#/, '').toLowerCase() !== row.expected_channel_name.toLowerCase())) {
    throw new CoinServiceError('WRONG_WORK_CHANNEL', '請到原指定的工作回報頻道完成待辦。');
  }
  if (externalServerCount > 0 && cycle.job_name !== '翻譯官') {
    throw new CoinServiceError('EXTERNAL_SERVER_ONLY_TRANSLATOR', '只有翻譯官可填外部任務加給。');
  }
  api.run(
    "UPDATE coin_work_tasks SET description = ?, attachment_urls = ?, expected_channel_id = ?, message_id = ?, external_server_count = ?, external_server_ids = ?, completed_at = ?, updated_at = ? WHERE id = ? AND guild_id = ? AND user_id = ? AND global_cycle_id = ? AND job_id IS NULL AND status = 'pending' AND completed_at IS NULL AND is_paid = 0",
    [
      String(description || '').trim().slice(0, 1000) || row.description,
      attachmentUrls.length ? JSON.stringify(attachmentUrls.map(String)) : row.attachment_urls,
      row.expected_channel_id || channelId, messageId || row.message_id,
      externalServerCount, externalServerIds.length ? JSON.stringify(externalServerIds.map(String)) : null,
      timestamp, timestamp, taskId, guildId, userId, row.global_cycle_id,
    ]
  );
  if (Number(api.get('SELECT changes() AS count').count) !== 1) {
    throw new CoinServiceError('PRIMARY_TASK_CONFLICT', '主職待辦狀態已變更，請重試。');
  }
  return { task: api.get('SELECT * FROM coin_work_tasks WHERE id = ?', [taskId]), cycle };
}

function completeWorkTaskWithApi(api, input) {
  const row = api.get(
    'SELECT job_id,global_cycle_id FROM coin_work_tasks WHERE id = ? AND guild_id = ? AND user_id = ?',
    [input.taskId, input.guildId, input.userId]
  );
  if (!row) throw new CoinServiceError('WORK_TASK_NOT_FOUND', '找不到這筆屬於你的原群待辦。');
  if (row.global_cycle_id && row.job_id == null) {
    return { ...completePrimaryTaskWithApi(api, input), scope: 'primary' };
  }
  if (row.job_id != null && !row.global_cycle_id) {
    return { task: completeLegacyTaskWithApi(api, input), scope: 'legacy' };
  }
  throw new CoinServiceError('WORK_TASK_SCOPE_CONFLICT', '工作待辦來源無法核對，暫停提交。');
}

function createGlobalWorkTaskWithApi(api, {
  guildId, userId, description, taskType = 'work_report', noWorkAvailable = false,
  channelId = null, channelName = null, messageId = null, attachmentUrls = [],
  externalServerCount = 0, externalServerIds = [], jobTypes, timestamp = new Date().toISOString(),
}) {
  const settings = ensureGuildSettings(api, guildId);
  if (!settings.enabled) throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  const cycle = getActiveCycleForUser(api, userId, timestamp);
  if (!cycle) throw new CoinServiceError('NO_ACTIVE_PRIMARY_JOB', '目前沒有可提交的新一期主職。');
  const jobType = jobTypes.find((item) => item.name === cycle.job_name);
  if (!jobType) throw new CoinServiceError('INVALID_JOB', '主職規則無法辨識，請人工處理。');
  if (jobType.reportChannelName &&
      (!channelName || String(channelName).replace(/^#/, '').toLowerCase() !== jobType.reportChannelName.toLowerCase())) {
    throw new CoinServiceError('WRONG_WORK_CHANNEL', '請到原指定的工作回報頻道提交。');
  }
  if (externalServerCount > 0 && cycle.job_name !== '翻譯官') {
    throw new CoinServiceError('EXTERNAL_SERVER_ONLY_TRANSLATOR', '只有翻譯官可填外部任務加給。');
  }
  if (noWorkAvailable && !String(description || '').trim()) description = '回報目前沒有可執行的工作任務。';
  const sql = [
    'INSERT INTO coin_work_tasks',
    '(guild_id,user_id,job_id,global_cycle_id,job_name,task_type,status,description,',
    'attachment_urls,expected_channel_id,expected_channel_name,message_id,',
    'external_server_count,external_server_ids,created_at,due_at,completed_at,updated_at)',
    'VALUES (?,?,NULL,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
  ].join(' ');
  api.run(sql, [
    guildId, userId, cycle.cycle_id, cycle.job_name,
    noWorkAvailable ? 'no_work_available' : String(taskType).slice(0, 80),
    noWorkAvailable ? 'no_work_available' : 'pending',
    String(description || '').trim().slice(0, 1000) || '已回報工作產出。',
    attachmentUrls.length ? JSON.stringify(attachmentUrls.map(String)) : null,
    channelId, jobType.reportChannelName || null, messageId,
    externalServerCount, externalServerIds.length ? JSON.stringify(externalServerIds.map(String)) : null,
    timestamp, timestamp, timestamp, timestamp,
  ]);
  const taskId = Number(api.get('SELECT last_insert_rowid() AS id').id);
  return { cycle, task: api.get('SELECT * FROM coin_work_tasks WHERE id = ?', [taskId]) };
}

function createGlobalPendingTaskWithApi(api, {
  guildId, userId, description, taskType = 'admin_task', dueHours = 10,
  jobTypes, timestamp = new Date().toISOString(),
}) {
  const settings = ensureGuildSettings(api, guildId);
  if (!settings.enabled) throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  const cycle = getActiveCycleForUser(api, userId, timestamp);
  if (!cycle) throw new CoinServiceError('WORK_CUTOVER_FROZEN', '舊工作不得新增義務；新主職尚未生效。');
  if (!Number.isSafeInteger(dueHours) || dueHours < 1 || dueHours > 72) {
    throw new CoinServiceError('INVALID_DUE_HOURS', '提醒時間必須介於 1 到 72 小時之間。');
  }
  const jobType = jobTypes.find((item) => item.name === cycle.job_name);
  if (!jobType) throw new CoinServiceError('INVALID_JOB', '主職規則無法辨識，請人工處理。');
  const dueAt = new Date(Date.parse(timestamp) + dueHours * 3_600_000).toISOString();
  const sql = [
    'INSERT INTO coin_work_tasks',
    '(guild_id,user_id,job_id,global_cycle_id,job_name,task_type,status,description,',
    'expected_channel_name,created_at,due_at,updated_at)',
    "VALUES (?,?,NULL,?,?,?,'pending',?,?,?,?,?)",
  ].join(' ');
  api.run(sql, [
    guildId, userId, cycle.cycle_id, cycle.job_name, String(taskType).slice(0, 80),
    String(description || '').trim().slice(0, 1000), jobType.reportChannelName || null,
    timestamp, dueAt, timestamp,
  ]);
  return api.get('SELECT * FROM coin_work_tasks WHERE id = ?', [Number(api.get('SELECT last_insert_rowid() AS id').id)]);
}

module.exports = {
  activatePrimaryJobWithApi, captureLegacyJobsForUserWithApi, completeLegacyTaskWithApi,
  completePrimaryTaskWithApi, completeWorkTaskWithApi,
  createGlobalPendingTaskWithApi, createGlobalWorkTaskWithApi, getActiveCycleForUser,
  hasOpenLegacyVenueWithApi, legacySettlementPeriodKey, mapPrimary,
  nextTaiwanPayBoundary, selectPrimaryJobWithApi, verifySavedSnapshot,
};
