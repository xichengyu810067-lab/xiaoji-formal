const { CoinServiceError, TransactionType } = require('../../services/coinService');
const { mutateWalletWithApi } = require('../../services/coinWalletService');
const { GLOBAL_RULE_VERSION, BASIC_RATIO } = require('./workRules');

const WAITER_JOB_NAMES = new Set(['服務生', '制服服務生']);

function hasOpenPrimaryWaiterOrderWithApi(api, cycle) {
  if (!WAITER_JOB_NAMES.has(cycle.job_name)) return false;
  return Boolean(api.get(
    "SELECT 1 AS found FROM casino_venue_orders WHERE waiter_global_cycle_id = ? AND waiter_user_id = ? AND tip_status = 'escrowed' LIMIT 1",
    [cycle.cycle_id, cycle.user_id]
  ));
}

function verifyPrimaryWaiterOrdersWithApi(api, cycle, validTasks) {
  if (!WAITER_JOB_NAMES.has(cycle.job_name)) return [];
  if (api.get(
    "SELECT 1 AS found FROM casino_venue_orders WHERE waiter_user_id = ? AND waiter_job_id IS NULL AND waiter_global_cycle_id IS NULL AND tip_amount > 0 AND tip_status IN ('escrowed','paid') LIMIT 1",
    [cycle.user_id]
  )) {
    throw new CoinServiceError('VENUE_WAITER_CYCLE_UNLINKED', '服務生訂單缺少本人主職週期歸屬，暫停發薪。');
  }
  const orders = api.all(
    'SELECT id,guild_id,waiter_user_id,waiter_job_id,waiter_job_name,tip_amount,tip_status FROM casino_venue_orders WHERE waiter_global_cycle_id = ? ORDER BY id',
    [cycle.cycle_id]
  );
  const byMessageId = new Map();
  const completedOrderIds = new Set();
  for (const order of orders) {
    if (order.waiter_user_id !== cycle.user_id || order.waiter_job_id != null ||
        order.waiter_job_name !== cycle.job_name || !Number.isSafeInteger(Number(order.tip_amount)) ||
        Number(order.tip_amount) <= 0 || !['paid', 'refunded'].includes(order.tip_status)) {
      throw new CoinServiceError('VENUE_WAITER_CYCLE_CONFLICT', '服務生訂單與主職或小費結算狀態不一致，暫停發薪。');
    }
    byMessageId.set('venue-order-' + order.id, order);
  }
  for (const task of validTasks) {
    if (task.task_type !== 'casino_venue_service') continue;
    const order = byMessageId.get(task.message_id);
    if (!order || order.guild_id !== task.guild_id || order.tip_status !== 'paid' ||
        task.user_id !== cycle.user_id || task.job_id != null ||
        task.job_name !== cycle.job_name || task.status !== 'completed') {
      throw new CoinServiceError('VENUE_WAITER_TASK_CONFLICT', '服務生任務與父訂單週期不一致，暫停發薪。');
    }
    completedOrderIds.add(Number(order.id));
  }
  if (orders.some((order) => order.tip_status === 'paid' &&
      !completedOrderIds.has(Number(order.id)))) {
    throw new CoinServiceError('VENUE_WAITER_TASK_MISSING', '已發小費的服務生訂單缺少本週期完成任務，暫停發薪。');
  }
  return orders.map((order) => Number(order.id));
}

function calculateGlobalPayrollWithApi(api, cycle) {
  const salary = JSON.parse(cycle.salary_snapshot_json || '{}');
  if (salary.version !== GLOBAL_RULE_VERSION ||
      !Number.isSafeInteger(Number(salary.dailySalary)) || Number(salary.dailySalary) < 0 ||
      salary.basicRatio !== BASIC_RATIO ||
      !Number.isSafeInteger(Number(salary.translatorBonus)) || Number(salary.translatorBonus) < 0 ||
      !Number.isSafeInteger(Number(cycle.work_days))) {
    throw new CoinServiceError('GLOBAL_SALARY_RULE_UNKNOWN', '新主職薪資規則無法辨識，暫停結算。');
  }
  const validTasks = api.all(
    "SELECT * FROM coin_work_tasks WHERE global_cycle_id = ? AND completed_at IS NOT NULL AND status IN ('pending','approved','completed','no_work_available') AND is_paid = 0 ORDER BY created_at,id",
    [cycle.cycle_id]
  );
  const noWork = validTasks.filter((task) => task.status === 'no_work_available');
  const work = validTasks.filter((task) => task.status !== 'no_work_available');
  const waiterOrderIds = verifyPrimaryWaiterOrdersWithApi(api, cycle, validTasks);
  const baseSalary = Number(salary.dailySalary) * Number(cycle.work_days);
  const externalIds = new Set();
  let externalCountWithoutIds = 0;
  if (cycle.job_name === '翻譯官') {
    for (const task of work) {
      let ids;
      try { ids = task.external_server_ids ? JSON.parse(task.external_server_ids) : []; }
      catch { throw new CoinServiceError('EXTERNAL_TASK_DATA_INVALID', '翻譯任務資料無法核對，暫停結算。'); }
      if (!Array.isArray(ids)) throw new CoinServiceError('EXTERNAL_TASK_DATA_INVALID', '翻譯任務資料無法核對，暫停結算。');
      const reportedCount = Number(task.external_server_count || 0);
      if (!Number.isSafeInteger(reportedCount) || reportedCount < 0 ||
          ids.some((id) => typeof id !== 'string' || !id.trim()) ||
          (ids.length && reportedCount !== ids.length)) {
        throw new CoinServiceError('EXTERNAL_TASK_DATA_INVALID', '翻譯任務資料無法核對，暫停結算。');
      }
      if (ids.length) {
        const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(task.created_at));
        for (const id of ids) externalIds.add(date + ':' + String(id));
      } else {
        externalCountWithoutIds += reportedCount;
      }
    }
  }
  const externalServerCount = externalIds.size + externalCountWithoutIds;
  const externalBonus = externalServerCount * Number(salary.translatorBonus || 0);
  if (['廚師', '調酒師'].includes(cycle.job_name) && api.get(
    "SELECT 1 AS found FROM casino_venue_order_items WHERE maker_user_id = ? AND maker_is_npc = 0 AND status = 'completed' AND bonus_paid = 0 AND global_cycle_id IS NULL AND completed_at >= ? AND completed_at <= ? LIMIT 1",
    [cycle.user_id, cycle.starts_at, cycle.ends_at]
  )) {
    throw new CoinServiceError('VENUE_CYCLE_UNLINKED', '場館訂單缺少主職週期歸屬，暫停發薪。');
  }
  const venueRows = ['廚師', '調酒師'].includes(cycle.job_name) ? api.all(
    "SELECT id,bonus_amount FROM casino_venue_order_items WHERE global_cycle_id = ? AND maker_user_id = ? AND maker_is_npc = 0 AND status = 'completed' AND bonus_paid = 0 AND bonus_amount > 0 ORDER BY completed_at,id",
    [cycle.cycle_id, cycle.user_id]
  ) : [];
  const venueBonus = venueRows.reduce((sum, row) => sum + Number(row.bonus_amount), 0);
  const penalties = api.all(
    "SELECT id,amount FROM coin_primary_cycle_penalties WHERE cycle_id = ? AND user_id = ? AND status = 'active' AND applied_at IS NULL ORDER BY id",
    [cycle.cycle_id, cycle.user_id]
  );
  const penaltyAmount = penalties.reduce((sum, row) => sum + Number(row.amount), 0);
  if (venueRows.some((row) => !Number.isSafeInteger(Number(row.bonus_amount)) || Number(row.bonus_amount) <= 0) ||
      penalties.some((row) => !Number.isSafeInteger(Number(row.amount)) || Number(row.amount) < 0)) {
    throw new CoinServiceError('GLOBAL_PAYROLL_DATA_INVALID', '主職加給或扣款資料無法核對，暫停結算。');
  }
  const hasWork = work.length > 0 || venueRows.length > 0;
  const payRatio = hasWork ? 1 : noWork.length ? BASIC_RATIO : 0;
  const grossAmount = hasWork ? baseSalary + externalBonus + venueBonus
    : noWork.length ? Math.round(baseSalary * payRatio) : 0;
  const paidAmount = Math.max(0, grossAmount - penaltyAmount);
  if (![baseSalary, externalBonus, venueBonus, penaltyAmount, paidAmount].every(Number.isSafeInteger)) {
    throw new CoinServiceError('GLOBAL_PAYROLL_OVERFLOW', '新主職薪資超出安全範圍，暫停結算。');
  }
  return {
    baseSalary, grossAmount, paidAmount, payRatio, totalTasks: validTasks.length,
    completedTasks: work.length, externalServerCount, externalBonus, venueBonus,
    penaltyAmount, taskIds: validTasks.map((task) => Number(task.id)), waiterOrderIds,
    venueItemIds: venueRows.map((row) => Number(row.id)),
    penaltyIds: penalties.map((row) => Number(row.id)),
    reason: hasWork ? '有效工作依固定日薪與已核加給結算。'
      : noWork.length ? '已回報無可執行工作，依固定比例發薪。'
        : '沒有有效工作或無工作回報，本期薪資為零。',
  };
}

function calculatePrimaryPenaltyRefundAmount(payroll, penalty, priorAppliedAmount) {
  const gross = Number(payroll?.gross_amount);
  const paid = Number(payroll?.paid_amount);
  const amount = Number(penalty?.amount);
  const prior = Number(priorAppliedAmount);
  if (![gross, paid, amount, prior].every(Number.isSafeInteger) ||
      gross < 0 || paid < 0 || paid > gross || amount < 0 || prior < 0) {
    throw new CoinServiceError('PRIMARY_REFUND_CONFLICT', '實際扣薪金額無法核對，暫停退款。');
  }
  return Math.min(amount, Math.max(0, gross - paid - prior));
}

function refundPrimaryPenaltyWithApi(api, { cycle, penalty, appealId, reviewerId, amount, timestamp }) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new CoinServiceError('PRIMARY_REFUND_CONFLICT', '實際退款金額無法核對。');
  }
  return mutateWalletWithApi(api, {
    guildId: cycle.source_guild_id, userId: penalty.user_id,
    type: TransactionType.WORK_PENALTY_REFUND,
    balanceDelta: amount, totalEarnedDelta: amount,
    operatorId: reviewerId,
    reason: '主職扣薪申訴通過，退還實扣薪資 #' + penalty.id,
    metadata: { primaryCycleId: cycle.cycle_id, penaltyId: penalty.id, appealId },
    createdAt: timestamp,
  });
}

function reviewPrimaryPenaltyAppealWithApi(api, {
  reviewerId, appealId, action, reason = '', timestamp = new Date().toISOString(),
  refundWithApi = refundPrimaryPenaltyWithApi,
}) {
  const id = Number(appealId);
  if (!Number.isSafeInteger(id) || id <= 0 || !['approved', 'rejected'].includes(action)) {
    throw new CoinServiceError('INVALID_APPEAL', '申訴編號或處理方式不正確。');
  }
  const appeal = api.get('SELECT * FROM coin_primary_cycle_penalty_appeals WHERE id = ?', [id]);
  if (!appeal || appeal.status !== 'pending') {
    throw new CoinServiceError('APPEAL_NOT_PENDING', '找不到待審的主職申訴。');
  }
  const penalty = api.get('SELECT * FROM coin_primary_cycle_penalties WHERE id = ?', [appeal.penalty_id]);
  const cycle = penalty ? api.get('SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ?', [penalty.cycle_id]) : null;
  if (!penalty || !cycle || penalty.user_id !== appeal.user_id) {
    throw new CoinServiceError('PENALTY_NOT_FOUND', '主職申訴來源無法核對，請人工處理。');
  }
  api.run(
    'UPDATE coin_primary_cycle_penalty_appeals SET status = ?, review_by = ?, review_reason = ?, reviewed_at = ? WHERE id = ? AND status = ?',
    [action, reviewerId, String(reason || '').trim().slice(0, 1000) || (action === 'approved' ? '申訴通過' : '申訴駁回'), timestamp, id, 'pending']
  );
  if (Number(api.get('SELECT changes() AS count').count) !== 1) {
    throw new CoinServiceError('APPEAL_CONFLICT', '申訴狀態已變更，請重試。');
  }
  let refund = null;
  if (action === 'approved') {
    api.run(
      "UPDATE coin_primary_cycle_penalties SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'active'",
      [timestamp, penalty.id]
    );
    if (Number(api.get('SELECT changes() AS count').count) !== 1) {
      throw new CoinServiceError('PENALTY_CONFLICT', '扣薪狀態已變更，請重試。');
    }
    if (penalty.applied_at && !penalty.refunded_at) {
      const payroll = api.get('SELECT * FROM coin_primary_cycle_payroll WHERE cycle_id = ?', [cycle.cycle_id]);
      if (!payroll) throw new CoinServiceError('PRIMARY_PAYROLL_REQUIRED', '扣薪已有套用紀錄但缺少發薪收據，暫停退款。');
      const prior = api.get(
        'SELECT COALESCE(SUM(amount),0) AS amount FROM coin_primary_cycle_penalties WHERE cycle_id = ? AND id < ? AND applied_at IS NOT NULL',
        [cycle.cycle_id, penalty.id]
      );
      const refundable = calculatePrimaryPenaltyRefundAmount(payroll, penalty, prior.amount);
      if (refundable > 0) {
        refund = refundWithApi(api, {
          cycle, penalty, appealId: id, reviewerId, amount: refundable, timestamp,
        });
      }
      api.run('UPDATE coin_primary_cycle_penalties SET refunded_at = ?, updated_at = ? WHERE id = ?',
        [timestamp, timestamp, penalty.id]);
    }
  }
  return { appealId: id, penaltyId: Number(penalty.id), status: action, refund };
}

module.exports = {
  calculateGlobalPayrollWithApi, calculatePrimaryPenaltyRefundAmount,
  refundPrimaryPenaltyWithApi, reviewPrimaryPenaltyAppealWithApi,
  hasOpenPrimaryWaiterOrderWithApi, verifyPrimaryWaiterOrdersWithApi,
};
