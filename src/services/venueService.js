const { readCoinSchemaVersionWithApi, withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  CoinServiceError,
  ensureGuildSettings,
  ensurePlayer,
  getLocalDate,
  insertAdminLog,
} = require('./coinService');
const {
  ChipLedgerType,
  creditChipsWithApi,
  debitChipsForCasinoWithApi,
} = require('./chipService');
const {
  WAITER_JOB_NAMES,
  createWorkPenaltyWithApi,
} = require('./workService');
const { getActiveCycleForUser, verifySavedSnapshot } = require('../systems/work/jobCycle');
// Work-table SQL lives in the work system; these ports run inside this
// file's own coin transactions.
const {
  cancelPendingLegacyWaiterTasksWithApi,
  cancelWaiterTaskForCancelledOrderWithApi,
  closeOverdueMakerTaskWithApi,
  closeWaiterTaskForTipRefundWithApi,
  findUnsnapshottedLegacyJobWithApi,
  getActiveJobCycleWithApi,
  getActiveJobRowWithApi,
  getAssignedJobRowWithApi,
  getFrozenLegacyTaskSnapshotWithApi,
  getGuildJobRowWithApi,
  getLeastBusyLegacyMakerJobWithApi,
  getLegacyJobSnapshotWithApi,
  insertCompletedLegacyVenueWorkTaskWithApi,
  insertPendingVenueWorkTaskWithApi,
  listActiveWaiterJobRowsWithApi,
  listGlobalMakerCyclesByLoadWithApi,
  listLegacyJobSnapshotsWithApi,
  listPendingVenueWorkTasksWithApi,
  markVenueWorkTaskCanceledWithApi,
  markVenueWorkTaskCompletedWithApi,
  recordLegacyVenueTaskCompletionWithApi,
} = require('../systems/work/venueTasks');
// Venue item counts for the least-busy maker ranking of venueTasks, and the orders the 24-hour
// sweep closes.
const { countMakerItemsInWindowWithApi, listVenueSweepDueOrdersWithApi } = require('../systems/casino/venueOrders');

function isGlobalWorkSchema(api) {
  return readCoinSchemaVersionWithApi(api) >= 22;
}

const VenueItemType = Object.freeze({
  MEAL: 'meal',
  DRINK: 'drink',
});

const VenueOrderStatus = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

const VenueOrderItemStatus = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
});

const VENUE_JOB_BY_TYPE = Object.freeze({
  [VenueItemType.MEAL]: '廚師',
  [VenueItemType.DRINK]: '調酒師',
});

const VENUE_BONUS_THRESHOLD = 10;
const VENUE_BONUS_AMOUNT = 20;
const WAITER_TIP_MINIMUMS = Object.freeze({
  服務生: 50,
  制服服務生: 100,
});
const ORDER_RATE_LIMIT_PER_MINUTE = 10;
const NPC_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const REMINDER_TIMEOUT_MS = 10 * 60 * 60 * 1000;
const MAX_STEP_LENGTH = 1000;
const MAX_NAME_LENGTH = 80;

const DEFAULT_MENU = Object.freeze([
  {
    itemType: VenueItemType.MEAL,
    name: '小吉炒飯',
    steps: '熱鍋下油炒香蔥花\n加入白飯與配料拌炒\n淋上醬油調味\n盛盤後撒上海苔粉',
  },
  {
    itemType: VenueItemType.MEAL,
    name: '皇家牛排',
    steps: '將牛排兩面撒鹽與黑胡椒\n熱鍋煎至表面焦香\n加入奶油與香草淋油\n靜置後切片擺盤',
  },
  {
    itemType: VenueItemType.MEAL,
    name: '招牌拉麵',
    steps: '煮滾高湯並調整鹹度\n麵條煮至彈牙\n放入叉燒與配菜\n淋上香油後上桌',
  },
  {
    itemType: VenueItemType.DRINK,
    name: '星光氣泡飲',
    steps: '杯中加入冰塊與莓果糖漿\n倒入氣泡水\n輕輕攪拌保留氣泡\n用薄荷葉裝飾',
  },
  {
    itemType: VenueItemType.DRINK,
    name: '翡翠檸檬茶',
    steps: '泡好綠茶並冷卻\n加入檸檬汁與糖漿\n搖盪至均勻冰鎮\n倒入杯中加檸檬片',
  },
  {
    itemType: VenueItemType.DRINK,
    name: '午夜無酒精調飲',
    steps: '杯中加入藍柑橘糖漿\n倒入葡萄汁與檸檬汁\n加冰搖盪\n濾入杯中並放上櫻桃',
  },
]);

function nowIso(date = new Date()) {
  return date.toISOString();
}

function normalizeItemType(itemType) {
  const value = String(itemType || '').trim().toLowerCase();

  if (!Object.values(VenueItemType).includes(value)) {
    throw new CoinServiceError('INVALID_VENUE_ITEM_TYPE', '場館項目類型只能是 meal 或 drink。');
  }

  return value;
}

function normalizeName(name) {
  const value = String(name || '').trim().replace(/\s+/g, ' ');

  if (!value || value.length > MAX_NAME_LENGTH) {
    throw new CoinServiceError('INVALID_VENUE_ITEM_NAME', `名稱必須是 1 到 ${MAX_NAME_LENGTH} 個字。`);
  }

  return value;
}

function splitSteps(steps) {
  return String(steps || '')
    .split(/\r?\n|[;；]/)
    .map((step) => step.trim())
    .filter(Boolean);
}

function normalizeSteps(steps) {
  const value = String(steps || '').trim();
  const parts = splitSteps(value);

  if (!parts.length || value.length > MAX_STEP_LENGTH) {
    throw new CoinServiceError('INVALID_VENUE_STEPS', `製作方式必須是 1 到 ${MAX_STEP_LENGTH} 個字。`);
  }

  return parts.join('\n');
}

function getTaiwanDayRange(date = new Date()) {
  const label = getLocalDate(date);
  const start = new Date(`${label}T00:00:00+08:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return {
    label,
    startIso: start.toISOString(),
    endIso: end.toISOString(),
  };
}

function mapMenuItem(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    itemType: row.item_type,
    name: row.name,
    steps: row.steps,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deleted: Boolean(row.deleted),
    deletedBy: row.deleted_by || null,
    deletedAt: row.deleted_at || null,
    deleteReason: row.delete_reason || null,
  };
}

function mapOrder(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    customerId: row.customer_id,
    channelId: row.channel_id || null,
    waiterUserId: row.waiter_user_id || null,
    waiterJobId: row.waiter_job_id === null || row.waiter_job_id === undefined ? null : Number(row.waiter_job_id),
    waiterJobName: row.waiter_job_name || null,
    waiterGlobalCycleId: row.waiter_global_cycle_id || null,
    waiterAssignedAt: row.waiter_assigned_at || null,
    waiterDueAt: row.waiter_due_at || null,
    tipAmount: Number(row.tip_amount || 0),
    tipStatus: row.tip_status || 'none',
    tipPaidAt: row.tip_paid_at || null,
    tipRefundedAt: row.tip_refunded_at || null,
    servedAt: row.served_at || null,
    servedBy: row.served_by || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrderItem(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    orderId: Number(row.order_id),
    itemType: row.item_type,
    menuItemId: row.menu_item_id === null || row.menu_item_id === undefined ? null : Number(row.menu_item_id),
    itemName: row.item_name,
    standardSteps: row.standard_steps,
    makerUserId: row.maker_user_id || null,
    makerJobId: row.maker_job_id === null || row.maker_job_id === undefined ? null : Number(row.maker_job_id),
    makerJobName: row.maker_job_name || null,
    globalCycleId: row.global_cycle_id || null,
    makerIsNpc: Boolean(row.maker_is_npc),
    status: row.status,
    actualSteps: row.actual_steps || null,
    serviceDate: row.service_date || null,
    bonusAmount: Number(row.bonus_amount || 0),
    bonusPaid: Boolean(row.bonus_paid),
    completionMessageId: row.completion_message_id || null,
    createdAt: row.created_at,
    assignedAt: row.assigned_at || null,
    completedAt: row.completed_at || null,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at || null,
    cancelledBy: row.cancelled_by || null,
    cancelReason: row.cancel_reason || null,
  };
}

function ensureEconomyEnabled(api, guildId) {
  const settings = ensureGuildSettings(api, guildId);

  if (!settings.enabled) {
    throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  }

  return settings;
}

function ensureDefaultVenueMenu(api, guildId) {
  const timestamp = nowIso();

  for (const item of DEFAULT_MENU) {
    const existing = api.get(
      "SELECT id FROM casino_venue_menu WHERE guild_id = ? AND item_type = ? AND name = ? AND created_by = 'system' LIMIT 1",
      [guildId, item.itemType, item.name]
    );

    if (existing) {
      continue;
    }

    api.run(
      `INSERT INTO casino_venue_menu
        (guild_id, item_type, name, steps, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'system', ?, ?)`,
      [guildId, item.itemType, item.name, item.steps, timestamp, timestamp]
    );
  }
}

function getMenuItem(api, guildId, itemId, itemType = null) {
  const row = api.get('SELECT * FROM casino_venue_menu WHERE guild_id = ? AND id = ? AND deleted = 0', [guildId, itemId]);

  if (!row) {
    throw new CoinServiceError('VENUE_MENU_ITEM_NOT_FOUND', '找不到這個餐飲項目。');
  }

  if (itemType && row.item_type !== itemType) {
    throw new CoinServiceError('VENUE_MENU_TYPE_MISMATCH', '餐點與飲料選項不相符。');
  }

  return mapMenuItem(row);
}

function ensureMakerJob(api, guildId, userId, itemType) {
  const jobName = VENUE_JOB_BY_TYPE[itemType];
  const row = getActiveJobRowWithApi(api, guildId, userId, jobName);

  if (!row) {
    throw new CoinServiceError(
      'VENUE_MAKER_JOB_REQUIRED',
      itemType === VenueItemType.MEAL ? '餐點只能指定目前在職的廚師。' : '飲料只能指定目前在職的調酒師。'
    );
  }

  return row;
}

// Pre-v22 only: the user's active guild-scoped waiter job, the uniform waiter first.
function ensureWaiterJob(api, guildId, userId) {
  const [row] = listActiveWaiterJobRowsWithApi(api, guildId, userId, WAITER_JOB_NAMES);

  if (!row) {
    throw new CoinServiceError('VENUE_WAITER_JOB_REQUIRED', '點餐必須指定目前在職的服務生或制服服務生。');
  }

  return row;
}

function ensureVenueCutoverReady(api) {
  if (findUnsnapshottedLegacyJobWithApi(api)) {
    throw new CoinServiceError('VENUE_LEGACY_SNAPSHOT_REQUIRED', '舊工作快照尚未完成，暫停新增場館任務。');
  }
  for (const snapshot of listLegacyJobSnapshotsWithApi(api)) {
    verifySavedSnapshot(api, snapshot);
  }
}

function requireVerifiedVenueMember(membership, guildId, userId, { completeRoster = false } = {}) {
  if (membership?.guildId !== guildId || !Array.isArray(membership.verifiedUserIds) ||
      !membership.verifiedUserIds.includes(userId) ||
      (completeRoster && membership.rosterComplete !== true)) {
    throw new CoinServiceError('VENUE_MEMBERSHIP_UNVERIFIED', '無法核實場館工作人員是否在此伺服器。');
  }
}

function ensureGlobalVenueJob(api, guildId, userId, jobNames, timestamp, membership) {
  requireVerifiedVenueMember(membership, guildId, userId);
  const cycle = getActiveCycleForUser(api, userId, timestamp);
  if (!cycle || !jobNames.includes(cycle.job_name) || cycle.starts_at > timestamp) {
    throw new CoinServiceError('VENUE_PRIMARY_JOB_REQUIRED', '指定人員目前沒有符合場館工作的全域主職。');
  }
  return cycle;
}

function getLeastBusyGlobalMaker(api, guildId, itemType, timestamp, membership) {
  if (membership?.guildId !== guildId || membership.rosterComplete !== true ||
      !Array.isArray(membership.verifiedUserIds)) {
    throw new CoinServiceError('VENUE_MEMBERSHIP_UNVERIFIED', '自動指派需要完整且已核實的伺服器成員名單。');
  }
  const visible = new Set(membership.verifiedUserIds);
  const range = getTaiwanDayRange(new Date(timestamp));
  const cycles = listGlobalMakerCyclesByLoadWithApi(api, {
    jobName: VENUE_JOB_BY_TYPE[itemType],
    timestamp,
    makerLoads: countMakerItemsInWindowWithApi(api, {
      guildId,
      itemType,
      startIso: range.startIso,
      endIso: range.endIso,
    }),
  });
  return cycles.find((cycle) => visible.has(cycle.user_id)) || null;
}

function normalizeTipAmount(amount, waiterJobName) {
  const tipAmount = Number(amount);
  if (!Number.isSafeInteger(tipAmount) || tipAmount <= 0) {
    throw new CoinServiceError('INVALID_VENUE_TIP', '小費必須是正整數籌碼。');
  }

  const minimum = WAITER_TIP_MINIMUMS[waiterJobName] || WAITER_TIP_MINIMUMS.服務生;
  if (tipAmount < minimum) {
    throw new CoinServiceError('VENUE_TIP_TOO_SMALL', `${waiterJobName} 最低小費為 ${minimum.toLocaleString('zh-TW')} 籌碼。`);
  }

  return tipAmount;
}

function getPendingVenueWorkTask(api, { guildId, userId, jobId = null, globalCycleId = null, taskType, messageId }) {
  const globalSchema = isGlobalWorkSchema(api);
  const rows = listPendingVenueWorkTasksWithApi(api, { guildId, userId, jobId, globalCycleId, taskType, messageId, globalSchema });
  if (rows.length > 1) throw new CoinServiceError('VENUE_TASK_CONFLICT', '場館原始待辦不只一筆，暫停處理。');
  const row = rows[0] || null;
  if (row && globalSchema && jobId != null) {
    const snapshot = getLegacyJobSnapshotWithApi(api, jobId);
    if (!snapshot) throw new CoinServiceError('VENUE_LEGACY_SNAPSHOT_REQUIRED', '原場館待辦缺少舊工作快照。');
    verifySavedSnapshot(api, snapshot);
    const frozen = getFrozenLegacyTaskSnapshotWithApi(api, jobId, row.id);
    if (!frozen || JSON.parse(frozen.snapshot_json).status !== 'pending') {
      throw new CoinServiceError('VENUE_LEGACY_TASK_NOT_FROZEN', '原場館待辦未列入切換快照。');
    }
  }
  return row;
}

function completePendingVenueWorkTask(api, { guildId, userId, jobId = null, globalCycleId = null, taskType, messageId, description, completedAt }) {
  const row = getPendingVenueWorkTask(api, { guildId, userId, jobId, globalCycleId, taskType, messageId });

  if (!row) {
    return null;
  }

  if (markVenueWorkTaskCompletedWithApi(api, { guildId, taskId: row.id, description, completedAt }) !== 1) {
    throw new CoinServiceError('VENUE_TASK_CONFLICT', '場館待辦狀態已變更，暫停完成。');
  }
  if (jobId != null) {
    recordLegacyVenueTaskCompletionWithApi(api, { jobId, completedAt });
  }

  return Number(row.id);
}

// The operation that cancels the original task, as its refusal messages name it.
const VENUE_TASK_CANCEL_ACTIONS = Object.freeze({
  reassign: '改派',
  cancel: '取消',
});

function cancelPendingVenueWorkTask(api, assignment, timestamp, action) {
  const actionLabel = VENUE_TASK_CANCEL_ACTIONS[action];
  if (!actionLabel) throw new TypeError(`cancelPendingVenueWorkTask requires a known action, got ${String(action)}.`);
  const row = getPendingVenueWorkTask(api, assignment);
  if (!row) throw new CoinServiceError('VENUE_TASK_MISSING', `原場館待辦無法核對，暫停${actionLabel}。`);
  if (markVenueWorkTaskCanceledWithApi(api, { taskId: row.id, timestamp }) !== 1) {
    throw new CoinServiceError('VENUE_TASK_CONFLICT', `原場館待辦狀態已變更，暫停${actionLabel}。`);
  }
}

function getLeastBusyMaker(api, guildId, itemType, date = new Date()) {
  const jobName = VENUE_JOB_BY_TYPE[itemType];
  const range = getTaiwanDayRange(date);

  return getLeastBusyLegacyMakerJobWithApi(api, {
    guildId,
    jobName,
    makerLoads: countMakerItemsInWindowWithApi(api, {
      guildId,
      itemType,
      startIso: range.startIso,
      endIso: range.endIso,
    }),
  });
}

function countRecentOrders(api, guildId, customerId, date = new Date()) {
  const cutoff = new Date(date.getTime() - 60 * 1000).toISOString();
  return Number(
    api.get(
      `SELECT COUNT(*) AS count
       FROM casino_venue_orders
       WHERE guild_id = ? AND customer_id = ? AND created_at >= ?`,
      [guildId, customerId, cutoff]
    )?.count || 0
  );
}

function calculateBonusAmount(api, guildId, itemType, serviceDate) {
  const completedBefore = Number(
    api.get(
      `SELECT COUNT(*) AS count
       FROM casino_venue_order_items
       WHERE guild_id = ?
         AND item_type = ?
         AND status = ?
         AND service_date = ?`,
      [guildId, itemType, VenueOrderItemStatus.COMPLETED, serviceDate]
    )?.count || 0
  );

  return completedBefore >= VENUE_BONUS_THRESHOLD ? VENUE_BONUS_AMOUNT : 0;
}

function updateOrderStatus(api, orderId) {
  const rows = api.all('SELECT status FROM casino_venue_order_items WHERE order_id = ?', [orderId]);
  const hasPending = rows.some((row) => row.status === VenueOrderItemStatus.PENDING);
  const hasCompleted = rows.some((row) => row.status === VenueOrderItemStatus.COMPLETED);
  const status = hasPending
    ? VenueOrderStatus.PENDING
    : hasCompleted
      ? VenueOrderStatus.COMPLETED
      : VenueOrderStatus.CANCELLED;
  const timestamp = nowIso();

  api.run('UPDATE casino_venue_orders SET status = ?, updated_at = ? WHERE id = ?', [status, timestamp, orderId]);
  return status;
}

function getOrderItems(api, guildId, orderId) {
  return api
    .all('SELECT * FROM casino_venue_order_items WHERE guild_id = ? AND order_id = ? ORDER BY id ASC', [guildId, orderId])
    .map(mapOrderItem);
}

// Chip-ledger reasons of the 24-hour refund, by the cause closeWaiterTaskForTipRefundWithApi
// takes.
const OVERDUE_TIP_REFUND_REASONS = Object.freeze({
  waiter_overdue: (orderId) => `場館訂單 #${orderId} 服務生逾期未送達，退還小費。`,
  maker_overdue: (orderId) => `場館訂單 #${orderId} 餐飲製作逾期由小吉接手，退還小費。`,
});

function hasEscrowedTip(order) {
  return order.tipStatus === 'escrowed' && order.tipAmount > 0;
}

function changedOneRow(api) {
  return Number(api.get('SELECT changes() AS count').count) === 1;
}

// Both refunds below first move the order out of 'escrowed' with a guarded update and credit
// the customer only when that update changed the row, so one tip is refunded at most once even
// when the caller holds an outdated order row.
function creditTipRefund(api, order, { reason, timestamp }) {
  return creditChipsWithApi(api, order.guildId, order.customerId, order.tipAmount, {
    entryType: ChipLedgerType.TIP_REFUND,
    reason,
    metadata: { orderId: order.id, waiterUserId: order.waiterUserId },
    timestamp,
  });
}

// The 24-hour sweep closes an unserved order: the system finishes it (served_by 'system'), the
// escrowed tip goes back to the customer and the waiter task is closed with the cause, which is
// 'maker_overdue' when NPC staff had to make an item, else 'waiter_overdue'.  Returns the
// credit, or null when the tip is not escrowed.
function refundOverdueOrderTip(api, orderRow, { cause, timestamp }) {
  const order = mapOrder(orderRow);
  if (!hasEscrowedTip(order)) return null;
  const reason = OVERDUE_TIP_REFUND_REASONS[cause];
  if (!reason) throw new TypeError(`refundOverdueOrderTip requires a known cause, got ${String(cause)}.`);
  api.run(
    `UPDATE casino_venue_orders
     SET tip_status = 'refunded', tip_refunded_at = ?, served_at = COALESCE(served_at, ?), served_by = COALESCE(served_by, 'system'), updated_at = ?
     WHERE guild_id = ? AND id = ? AND tip_status = 'escrowed'`,
    [timestamp, timestamp, timestamp, order.guildId, order.id]
  );
  if (!changedOneRow(api)) return null;
  const refund = creditTipRefund(api, order, { reason: reason(order.id), timestamp });
  closeWaiterTaskForTipRefundWithApi(api, { guildId: order.guildId, orderId: order.id, timestamp, cause });
  return refund;
}

// A cancelled order: nothing was served, so served_at and served_by stay empty; the escrowed tip
// goes back to the customer and the waiter task is cancelled.  Returns the credit, or null when
// the tip is not escrowed.
function refundCancelledOrderTip(api, orderRow, { timestamp }) {
  const order = mapOrder(orderRow);
  if (!hasEscrowedTip(order)) return null;
  api.run(
    `UPDATE casino_venue_orders
     SET tip_status = 'refunded', tip_refunded_at = ?, updated_at = ?
     WHERE guild_id = ? AND id = ? AND tip_status = 'escrowed'`,
    [timestamp, timestamp, order.guildId, order.id]
  );
  if (!changedOneRow(api)) return null;
  const refund = creditTipRefund(api, order, { reason: `場館訂單 #${order.id} 已取消，退還小費。`, timestamp });
  cancelWaiterTaskForCancelledOrderWithApi(api, { guildId: order.guildId, orderId: order.id, timestamp });
  return refund;
}

// Whether NPC staff made an item of this order because its maker was 24 hours late.  Items that
// NPC staff made when the order was placed (no maker available) have no maker_user_id.
function hasItemTakenOverFromLateMaker(api, guildId, orderId) {
  return Boolean(api.get(
    `SELECT 1 AS found
     FROM casino_venue_order_items
     WHERE guild_id = ? AND order_id = ? AND maker_is_npc = 1 AND maker_user_id IS NOT NULL
     LIMIT 1`,
    [guildId, orderId]
  ));
}

function payoutOrderTip(api, orderRow, { timestamp = nowIso() } = {}) {
  const order = mapOrder(orderRow);
  if (order.tipStatus !== 'escrowed' || order.tipAmount <= 0) {
    throw new CoinServiceError('VENUE_TIP_NOT_ESCROWED', '這筆訂單目前沒有可領取的小費。');
  }

  const payout = creditChipsWithApi(api, order.guildId, order.waiterUserId, order.tipAmount, {
    entryType: ChipLedgerType.TIP_PAYOUT,
    reason: `場館訂單 #${order.id} 服務生小費`,
    metadata: { orderId: order.id, customerId: order.customerId },
    timestamp,
  });
  api.run(
    `UPDATE casino_venue_orders
     SET tip_status = 'paid', tip_paid_at = ?, served_at = ?, served_by = ?, updated_at = ?
     WHERE guild_id = ? AND id = ?`,
    [timestamp, timestamp, order.waiterUserId, timestamp, order.guildId, order.id]
  );
  const taskId = completePendingVenueWorkTask(api, {
    guildId: order.guildId,
    userId: order.waiterUserId,
    jobId: order.waiterJobId,
    globalCycleId: order.waiterGlobalCycleId,
    taskType: 'casino_venue_service',
    messageId: `venue-order-${order.id}`,
    description: `訂單 #${order.id} 已送達，收到小費 ${order.tipAmount} 籌碼。`,
    completedAt: timestamp,
  });
  if (isGlobalWorkSchema(api) && !taskId) {
    throw new CoinServiceError('VENUE_TASK_MISSING', '服務生原始待辦無法核對，暫停發放小費。');
  }

  return { payout, taskId };
}

// The job a venue:make admin log names: a guild-scoped job row by its id; a primary cycle row,
// which has no id column, by jobId null and its cycle id.
function makerJobAttribution(makerJobRow) {
  return makerJobRow.cycle_id
    ? { jobId: null, globalCycleId: makerJobRow.cycle_id }
    : { jobId: makerJobRow.id };
}

function insertVenueWorkTask(api, item, makerJobRow, actualSteps, timestamp) {
  const taskType = item.itemType === VenueItemType.MEAL ? 'casino_venue_meal' : 'casino_venue_drink';
  const description = `${item.itemName} 製作完成\n${normalizeSteps(actualSteps)}`;
  const existingTaskId = completePendingVenueWorkTask(api, {
    guildId: item.guildId,
    userId: item.makerUserId,
    jobId: item.makerJobId,
    globalCycleId: item.globalCycleId,
    taskType,
    messageId: `venue-item-${item.id}`,
    description,
    completedAt: timestamp,
  });

  if (existingTaskId) {
    insertAdminLog(api, {
      guildId: item.guildId,
      operatorId: item.makerUserId,
      targetUserId: item.makerUserId,
      action: 'venue:make',
      reason: '完成餐飲製作',
      details: {
        orderId: item.orderId,
        orderItemId: item.id,
        itemType: item.itemType,
        itemName: item.itemName,
        ...makerJobAttribution(makerJobRow),
        taskId: existingTaskId,
      },
      createdAt: timestamp,
    });
    return existingTaskId;
  }

  if (isGlobalWorkSchema(api)) {
    throw new CoinServiceError('VENUE_TASK_MISSING', '製作者原始待辦無法核對，暫停完成。');
  }

  const taskId = insertCompletedLegacyVenueWorkTaskWithApi(api, {
    guildId: item.guildId,
    makerUserId: item.makerUserId,
    makerJobRow,
    taskType,
    description,
    timestamp,
  });
  insertAdminLog(api, {
    guildId: item.guildId,
    operatorId: item.makerUserId,
    targetUserId: item.makerUserId,
    action: 'venue:make',
    reason: '完成餐飲製作',
    details: {
      orderId: item.orderId,
      orderItemId: item.id,
      itemType: item.itemType,
      itemName: item.itemName,
      ...makerJobAttribution(makerJobRow),
      taskId,
    },
    createdAt: timestamp,
  });

  return taskId;
}

function insertOrderItem(api, orderId, menuItem, makerRow, { guildId, date, forceNpc = false, channelId = null } = {}) {
  const timestamp = nowIso(date);
  const serviceDate = forceNpc ? getLocalDate(date) : null;
  const makerIsNpc = forceNpc || !makerRow;
  const status = makerIsNpc ? VenueOrderItemStatus.COMPLETED : VenueOrderItemStatus.PENDING;
  const globalSchema = isGlobalWorkSchema(api);

  api.run(
    `INSERT INTO casino_venue_order_items
      (
        guild_id, order_id, item_type, menu_item_id, item_name, standard_steps,
        maker_user_id, maker_job_id, ${globalSchema ? 'global_cycle_id,' : ''} maker_job_name, maker_is_npc, status, actual_steps,
        service_date, bonus_amount, created_at, assigned_at, completed_at, updated_at
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${globalSchema ? '?, ' : ''}?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      guildId,
      orderId,
      menuItem.itemType,
      menuItem.id,
      menuItem.name,
      menuItem.steps,
      makerRow?.user_id || null,
      makerRow?.cycle_id ? null : makerRow?.id || null,
      ...(globalSchema ? [makerRow?.cycle_id || null] : []),
      makerRow?.job_name || VENUE_JOB_BY_TYPE[menuItem.itemType],
      makerIsNpc ? 1 : 0,
      status,
      makerIsNpc ? menuItem.steps : null,
      serviceDate,
      timestamp,
      timestamp,
      makerIsNpc ? timestamp : null,
      timestamp,
    ]
  );

  const itemId = Number(api.get('SELECT last_insert_rowid() AS id').id);
  if (!makerIsNpc && makerRow) {
    const taskType = menuItem.itemType === VenueItemType.MEAL ? 'casino_venue_meal' : 'casino_venue_drink';
    insertPendingVenueWorkTaskWithApi(api, {
      guildId,
      userId: makerRow.user_id,
      jobRow: makerRow,
      taskType,
      description: `訂單 #${orderId}｜${menuItem.name} 待製作`,
      createdAt: timestamp,
      dueAt: new Date(new Date(timestamp).getTime() + REMINDER_TIMEOUT_MS).toISOString(),
      channelId,
      messageId: `venue-item-${itemId}`,
      globalSchema,
    });
  }
  return mapOrderItem(api.get('SELECT * FROM casino_venue_order_items WHERE id = ?', [itemId]));
}

function listVenueMenu(guildId, { itemType = null } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    ensureDefaultVenueMenu(api, guildId);
    const normalizedType = itemType ? normalizeItemType(itemType) : null;
    const rows = normalizedType
      ? api.all(
          'SELECT * FROM casino_venue_menu WHERE guild_id = ? AND item_type = ? AND deleted = 0 ORDER BY id ASC',
          [guildId, normalizedType]
        )
      : api.all('SELECT * FROM casino_venue_menu WHERE guild_id = ? AND deleted = 0 ORDER BY item_type ASC, id ASC', [
          guildId,
        ]);

    return rows.map(mapMenuItem);
  });
}

function addVenueMenuItem(guildId, { itemType, name, steps, createdBy } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    const normalizedType = normalizeItemType(itemType);
    const normalizedName = normalizeName(name);
    const normalizedSteps = normalizeSteps(steps);
    const timestamp = nowIso();

    api.run(
      `INSERT INTO casino_venue_menu
        (guild_id, item_type, name, steps, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [guildId, normalizedType, normalizedName, normalizedSteps, createdBy || 'unknown', timestamp, timestamp]
    );
    const itemId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    return mapMenuItem(api.get('SELECT * FROM casino_venue_menu WHERE id = ?', [itemId]));
  });
}

function deleteVenueMenuItem(guildId, itemId, { operatorId, reason = '' } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    const id = Number(itemId);

    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new CoinServiceError('INVALID_VENUE_MENU_ID', '菜單項目 ID 不正確。');
    }

    const item = getMenuItem(api, guildId, id);
    const timestamp = nowIso();
    api.run(
      `UPDATE casino_venue_menu
       SET deleted = 1, deleted_by = ?, deleted_at = ?, delete_reason = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [operatorId || null, timestamp, reason || '管理員刪除菜單項目', timestamp, guildId, id]
    );
    insertAdminLog(api, {
      guildId,
      operatorId,
      targetUserId: item.createdBy,
      action: 'venue:delete-menu',
      reason,
      details: { itemId: id, itemType: item.itemType, name: item.name },
      createdAt: timestamp,
    });

    return mapMenuItem(api.get('SELECT * FROM casino_venue_menu WHERE guild_id = ? AND id = ?', [guildId, id]));
  });
}

function createVenueOrder(
  guildId,
  customerId,
  { mealId = null, drinkId = null, chefId = null, bartenderId = null, waiterId = null, tipAmount = null, channelId = null, date = new Date(), membership = null } = {}
) {
  return withCoinTransaction((api) => {
    const globalSchema = isGlobalWorkSchema(api);
    if (globalSchema) ensureVenueCutoverReady(api);
    ensureEconomyEnabled(api, guildId);
    ensurePlayer(api, guildId, customerId);
    ensureDefaultVenueMenu(api, guildId);

    if (!mealId && !drinkId) {
      throw new CoinServiceError('VENUE_ORDER_EMPTY', '一次下單至少要選一個餐點或一杯飲料。');
    }

    if (chefId && !mealId) {
      throw new CoinServiceError('VENUE_CHEF_WITHOUT_MEAL', '指定廚師時必須同時選擇餐點。');
    }

    if (bartenderId && !drinkId) {
      throw new CoinServiceError('VENUE_BARTENDER_WITHOUT_DRINK', '指定調酒師時必須同時選擇飲料。');
    }

    if (!waiterId) {
      throw new CoinServiceError('VENUE_WAITER_REQUIRED', '點餐必須指定服務生。');
    }

    if (countRecentOrders(api, guildId, customerId, date) >= ORDER_RATE_LIMIT_PER_MINUTE) {
      throw new CoinServiceError('VENUE_ORDER_RATE_LIMIT', '你 1 分鐘內最多只能下 10 次單，請稍後再試。');
    }

    const meal = mealId ? getMenuItem(api, guildId, Number(mealId), VenueItemType.MEAL) : null;
    const drink = drinkId ? getMenuItem(api, guildId, Number(drinkId), VenueItemType.DRINK) : null;
    const timestamp = nowIso(date);
    const waiterJob = globalSchema
      ? ensureGlobalVenueJob(api, guildId, waiterId, WAITER_JOB_NAMES, timestamp, membership)
      : ensureWaiterJob(api, guildId, waiterId);
    const normalizedTip = normalizeTipAmount(tipAmount, waiterJob.job_name);
    const waiterDueAt = new Date(new Date(timestamp).getTime() + NPC_TIMEOUT_MS).toISOString();

    const tipDebit = debitChipsForCasinoWithApi(api, guildId, customerId, normalizedTip, {
      entryType: ChipLedgerType.TIP_ESCROW,
      reason: '場館訂單服務生小費保管',
      topUpReason: '場館小費自動補足籌碼',
      metadata: { waiterId, waiterJobName: waiterJob.job_name },
      timestamp,
    });

    api.run(
      `INSERT INTO casino_venue_orders (
        guild_id, customer_id, channel_id, waiter_user_id, waiter_job_id, ${globalSchema ? 'waiter_global_cycle_id,' : ''} waiter_job_name,
        waiter_assigned_at, waiter_due_at, tip_amount, tip_status, status, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ${globalSchema ? '?, ' : ''}?, ?, ?, ?, 'escrowed', ?, ?, ?)`,
      [
        guildId,
        customerId,
        channelId || null,
        waiterId,
        globalSchema ? null : waiterJob.id,
        ...(globalSchema ? [waiterJob.cycle_id] : []),
        waiterJob.job_name,
        timestamp,
        waiterDueAt,
        normalizedTip,
        VenueOrderStatus.PENDING,
        timestamp,
        timestamp,
      ]
    );
    const orderId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    const items = [];

    insertPendingVenueWorkTaskWithApi(api, {
      guildId,
      userId: waiterId,
      jobRow: waiterJob,
      taskType: 'casino_venue_service',
      description: `訂單 #${orderId} 待送達，小費 ${normalizedTip} 籌碼。`,
      createdAt: timestamp,
      dueAt: new Date(new Date(timestamp).getTime() + REMINDER_TIMEOUT_MS).toISOString(),
      channelId,
      messageId: `venue-order-${orderId}`,
      globalSchema,
    });

    if (meal) {
      const maker = globalSchema
        ? chefId
          ? ensureGlobalVenueJob(api, guildId, chefId, [VENUE_JOB_BY_TYPE[VenueItemType.MEAL]], timestamp, membership)
          : getLeastBusyGlobalMaker(api, guildId, VenueItemType.MEAL, timestamp, membership)
        : chefId ? ensureMakerJob(api, guildId, chefId, VenueItemType.MEAL) : getLeastBusyMaker(api, guildId, VenueItemType.MEAL, date);
      items.push(insertOrderItem(api, orderId, meal, maker, { guildId, date, forceNpc: !maker, channelId }));
    }

    if (drink) {
      const maker = globalSchema
        ? bartenderId
          ? ensureGlobalVenueJob(api, guildId, bartenderId, [VENUE_JOB_BY_TYPE[VenueItemType.DRINK]], timestamp, membership)
          : getLeastBusyGlobalMaker(api, guildId, VenueItemType.DRINK, timestamp, membership)
        : bartenderId ? ensureMakerJob(api, guildId, bartenderId, VenueItemType.DRINK)
          : getLeastBusyMaker(api, guildId, VenueItemType.DRINK, date);
      items.push(insertOrderItem(api, orderId, drink, maker, { guildId, date, forceNpc: !maker, channelId }));
    }

    updateOrderStatus(api, orderId);
    const order = mapOrder(api.get('SELECT * FROM casino_venue_orders WHERE id = ?', [orderId]));

    return { order, items, tipDebit };
  });
}

function getVenueRecipe(guildId, userId, orderItemId) {
  return withCoinDatabase((api) => {
    const row = api.get('SELECT * FROM casino_venue_order_items WHERE guild_id = ? AND id = ?', [guildId, orderItemId]);

    if (!row) {
      throw new CoinServiceError('VENUE_ORDER_ITEM_NOT_FOUND', '找不到這筆待製作項目。');
    }

    const item = mapOrderItem(row);

    if (item.makerIsNpc || item.makerUserId !== userId) {
      throw new CoinServiceError('VENUE_RECIPE_OWNER_ONLY', '只有被指派的製作者可以查詢這筆製作方式。');
    }

    return item;
  });
}

function completeVenueOrderItem(guildId, userId, orderItemId, { steps, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const globalSchema = isGlobalWorkSchema(api);
    ensureEconomyEnabled(api, guildId);
    const row = api.get('SELECT * FROM casino_venue_order_items WHERE guild_id = ? AND id = ?', [guildId, orderItemId]);

    if (!row) {
      throw new CoinServiceError('VENUE_ORDER_ITEM_NOT_FOUND', '找不到這筆待製作項目。');
    }

    const item = mapOrderItem(row);

    if (item.status !== VenueOrderItemStatus.PENDING) {
      throw new CoinServiceError('VENUE_ORDER_ITEM_NOT_PENDING', '這筆項目已經不是待製作狀態。');
    }

    if (item.makerIsNpc || item.makerUserId !== userId) {
      throw new CoinServiceError('VENUE_MAKE_OWNER_ONLY', '只有被指派的製作者可以完成這筆項目。');
    }

    const makerJob = globalSchema
      ? item.globalCycleId
        ? getActiveJobCycleWithApi(api, { cycleId: item.globalCycleId, userId, jobName: VENUE_JOB_BY_TYPE[item.itemType] })
        : item.makerJobId
          ? getAssignedJobRowWithApi(api, {
            jobId: item.makerJobId, guildId, userId, jobName: VENUE_JOB_BY_TYPE[item.itemType],
          })
          : null
      : ensureMakerJob(api, guildId, userId, item.itemType);
    if (!makerJob) throw new CoinServiceError('VENUE_MAKER_ASSIGNMENT_CONFLICT', '製作者原始工作歸屬無法核對。');
    const normalizedSteps = normalizeSteps(steps);
    const timestamp = nowIso(date);
    const serviceDate = getLocalDate(date);
    const bonusAmount = calculateBonusAmount(api, guildId, item.itemType, serviceDate);
    const taskId = insertVenueWorkTask(api, item, makerJob, normalizedSteps, timestamp);

    api.run(
      `UPDATE casino_venue_order_items
       SET ${globalSchema ? '' : 'maker_job_id = ?, maker_job_name = ?, '}status = ?, actual_steps = ?, service_date = ?,
           bonus_amount = ?, completed_at = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [
        ...(globalSchema ? [] : [makerJob.id, makerJob.job_name]),
        VenueOrderItemStatus.COMPLETED,
        normalizedSteps,
        serviceDate,
        bonusAmount,
        timestamp,
        timestamp,
        guildId,
        item.id,
      ]
    );
    updateOrderStatus(api, item.orderId);

    return {
      item: mapOrderItem(api.get('SELECT * FROM casino_venue_order_items WHERE guild_id = ? AND id = ?', [guildId, item.id])),
      order: mapOrder(api.get('SELECT * FROM casino_venue_orders WHERE guild_id = ? AND id = ?', [guildId, item.orderId])),
      taskId,
    };
  });
}

function serveVenueOrder(guildId, userId, orderId, { date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const globalSchema = isGlobalWorkSchema(api);
    ensureEconomyEnabled(api, guildId);
    const id = Number(orderId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new CoinServiceError('INVALID_VENUE_ORDER_ID', '訂單 ID 不正確。');
    }

    const row = api.get('SELECT * FROM casino_venue_orders WHERE guild_id = ? AND id = ?', [guildId, id]);
    if (!row) {
      throw new CoinServiceError('VENUE_ORDER_NOT_FOUND', '找不到這筆訂單。');
    }

    const order = mapOrder(row);
    if (order.waiterUserId !== userId) {
      throw new CoinServiceError('VENUE_SERVE_OWNER_ONLY', '只有被指定的服務生可以送達這筆訂單。');
    }

    if (order.servedAt) {
      throw new CoinServiceError('VENUE_ORDER_ALREADY_SERVED', '這筆訂單已經送達。');
    }

    if (globalSchema) {
      const original = order.waiterGlobalCycleId
        ? getActiveJobCycleWithApi(api, { cycleId: order.waiterGlobalCycleId, userId, jobName: order.waiterJobName })
        : order.waiterJobId
          ? getAssignedJobRowWithApi(api, { jobId: order.waiterJobId, guildId, userId, jobName: order.waiterJobName })
          : null;
      if (!original || !WAITER_JOB_NAMES.includes(order.waiterJobName)) {
        throw new CoinServiceError('VENUE_WAITER_ASSIGNMENT_CONFLICT', '服務生原始工作歸屬無法核對。');
      }
    } else {
      ensureWaiterJob(api, guildId, userId);
    }
    const items = getOrderItems(api, guildId, id);
    if (!items.length || items.some((item) => item.status === VenueOrderItemStatus.PENDING)) {
      throw new CoinServiceError('VENUE_ORDER_NOT_READY', '餐點或酒水尚未完成，暫時不能送達。');
    }

    if (!items.some((item) => item.status === VenueOrderItemStatus.COMPLETED)) {
      throw new CoinServiceError('VENUE_ORDER_CANCELLED', '這筆訂單沒有可送達的項目。');
    }

    const timestamp = nowIso(date);
    const tipResult = payoutOrderTip(api, row, { timestamp });
    insertAdminLog(api, {
      guildId,
      operatorId: userId,
      targetUserId: order.customerId,
      action: 'venue:serve',
      reason: '服務生完成送達',
      details: { orderId: id, tipAmount: order.tipAmount, taskId: tipResult.taskId },
      createdAt: timestamp,
    });

    return {
      order: mapOrder(api.get('SELECT * FROM casino_venue_orders WHERE guild_id = ? AND id = ?', [guildId, id])),
      items,
      tipResult,
    };
  });
}

function reassignVenueOrderItem(guildId, orderItemId, newMakerId, { operatorId, reason = '', date = new Date(), membership = null } = {}) {
  return withCoinTransaction((api) => {
    const globalSchema = isGlobalWorkSchema(api);
    if (globalSchema) ensureVenueCutoverReady(api);
    ensureEconomyEnabled(api, guildId);
    const row = api.get('SELECT * FROM casino_venue_order_items WHERE guild_id = ? AND id = ?', [guildId, orderItemId]);

    if (!row) {
      throw new CoinServiceError('VENUE_ORDER_ITEM_NOT_FOUND', '找不到這筆待製作項目。');
    }

    const item = mapOrderItem(row);

    if (item.status !== VenueOrderItemStatus.PENDING) {
      throw new CoinServiceError('VENUE_ORDER_ITEM_NOT_PENDING', '只有待製作項目可以重新指派。');
    }

    const timestamp = nowIso(date);
    const makerJob = globalSchema
      ? ensureGlobalVenueJob(api, guildId, newMakerId, [VENUE_JOB_BY_TYPE[item.itemType]], timestamp, membership)
      : ensureMakerJob(api, guildId, newMakerId, item.itemType);
    if (globalSchema) {
      cancelPendingVenueWorkTask(api, {
        guildId, userId: item.makerUserId, jobId: item.makerJobId,
        globalCycleId: item.globalCycleId,
        taskType: item.itemType === VenueItemType.MEAL ? 'casino_venue_meal' : 'casino_venue_drink',
        messageId: `venue-item-${item.id}`,
      }, timestamp, 'reassign');
    }
    api.run(
      `UPDATE casino_venue_order_items
       SET maker_user_id = ?, maker_job_id = ?, ${globalSchema ? 'global_cycle_id = ?,' : ''} maker_job_name = ?, maker_is_npc = 0, assigned_at = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [newMakerId, globalSchema ? null : makerJob.id, ...(globalSchema ? [makerJob.cycle_id] : []),
        makerJob.job_name, timestamp, timestamp, guildId, item.id]
    );
    if (globalSchema) {
      insertPendingVenueWorkTaskWithApi(api, {
        guildId, userId: newMakerId, jobRow: makerJob,
        taskType: item.itemType === VenueItemType.MEAL ? 'casino_venue_meal' : 'casino_venue_drink',
        description: `訂單 #${item.orderId}｜${item.itemName} 改派後待製作`,
        createdAt: timestamp,
        dueAt: new Date(date.getTime() + REMINDER_TIMEOUT_MS).toISOString(),
        channelId: api.get('SELECT channel_id FROM casino_venue_orders WHERE guild_id = ? AND id = ?', [guildId, item.orderId])?.channel_id || null,
        messageId: `venue-item-${item.id}`,
        globalSchema,
      });
    }
    insertAdminLog(api, {
      guildId,
      operatorId,
      targetUserId: newMakerId,
      action: 'venue:reassign',
      reason,
      details: { orderItemId: item.id, orderId: item.orderId, oldMakerId: item.makerUserId, newMakerId },
      createdAt: timestamp,
    });

    return mapOrderItem(api.get('SELECT * FROM casino_venue_order_items WHERE guild_id = ? AND id = ?', [guildId, item.id]));
  });
}

function reassignVenueWaiter(guildId, orderId, newWaiterId, { operatorId, reason = '', date = new Date(), membership = null } = {}) {
  return withCoinTransaction((api) => {
    const globalSchema = isGlobalWorkSchema(api);
    if (globalSchema) ensureVenueCutoverReady(api);
    ensureEconomyEnabled(api, guildId);
    const id = Number(orderId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new CoinServiceError('INVALID_VENUE_ORDER_ID', '訂單 ID 不正確。');
    }

    const row = api.get('SELECT * FROM casino_venue_orders WHERE guild_id = ? AND id = ?', [guildId, id]);
    if (!row) {
      throw new CoinServiceError('VENUE_ORDER_NOT_FOUND', '找不到這筆訂單。');
    }

    const order = mapOrder(row);
    if (order.servedAt || order.tipStatus !== 'escrowed') {
      throw new CoinServiceError('VENUE_ORDER_ALREADY_SERVED', '只有尚未送達且小費保管中的訂單可以改派服務生。');
    }

    const timestamp = nowIso(date);
    const waiterJob = globalSchema
      ? ensureGlobalVenueJob(api, guildId, newWaiterId, WAITER_JOB_NAMES, timestamp, membership)
      : ensureWaiterJob(api, guildId, newWaiterId);
    normalizeTipAmount(order.tipAmount, waiterJob.job_name);
    if (globalSchema) {
      cancelPendingVenueWorkTask(api, {
        guildId, userId: order.waiterUserId, jobId: order.waiterJobId,
        globalCycleId: order.waiterGlobalCycleId,
        taskType: 'casino_venue_service', messageId: `venue-order-${id}`,
      }, timestamp, 'reassign');
    }
    api.run(
      `UPDATE casino_venue_orders
       SET waiter_user_id = ?, waiter_job_id = ?, ${globalSchema ? 'waiter_global_cycle_id = ?,' : ''} waiter_job_name = ?, waiter_assigned_at = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [newWaiterId, globalSchema ? null : waiterJob.id, ...(globalSchema ? [waiterJob.cycle_id] : []),
        waiterJob.job_name, timestamp, timestamp, guildId, id]
    );
    if (!globalSchema) {
      cancelPendingLegacyWaiterTasksWithApi(api, { guildId, orderId: id, timestamp });
    }
    insertPendingVenueWorkTaskWithApi(api, {
      guildId,
      userId: newWaiterId,
      jobRow: waiterJob,
      taskType: 'casino_venue_service',
      description: `訂單 #${id} 改派後待送達，小費 ${order.tipAmount} 籌碼。`,
      createdAt: timestamp,
      dueAt: new Date(new Date(timestamp).getTime() + REMINDER_TIMEOUT_MS).toISOString(),
      channelId: order.channelId,
      messageId: `venue-order-${id}`,
      globalSchema,
    });
    insertAdminLog(api, {
      guildId,
      operatorId,
      targetUserId: newWaiterId,
      action: 'venue:reassign-waiter',
      reason,
      details: { orderId: id, oldWaiterId: order.waiterUserId, newWaiterId },
      createdAt: timestamp,
    });

    return mapOrder(api.get('SELECT * FROM casino_venue_orders WHERE guild_id = ? AND id = ?', [guildId, id]));
  });
}

function cancelVenueOrderItem(guildId, orderItemId, { operatorId, reason = '', date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const globalSchema = isGlobalWorkSchema(api);
    ensureEconomyEnabled(api, guildId);
    const row = api.get('SELECT * FROM casino_venue_order_items WHERE guild_id = ? AND id = ?', [guildId, orderItemId]);

    if (!row) {
      throw new CoinServiceError('VENUE_ORDER_ITEM_NOT_FOUND', '找不到這筆待製作項目。');
    }

    const item = mapOrderItem(row);

    if (item.status !== VenueOrderItemStatus.PENDING) {
      throw new CoinServiceError('VENUE_ORDER_ITEM_NOT_PENDING', '只有待製作項目可以取消。');
    }

    const timestamp = nowIso(date);
    if (globalSchema && !item.makerIsNpc) {
      cancelPendingVenueWorkTask(api, {
        guildId, userId: item.makerUserId, jobId: item.makerJobId,
        globalCycleId: item.globalCycleId,
        taskType: item.itemType === VenueItemType.MEAL ? 'casino_venue_meal' : 'casino_venue_drink',
        messageId: `venue-item-${item.id}`,
      }, timestamp, 'cancel');
    }
    api.run(
      `UPDATE casino_venue_order_items
       SET status = ?, cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [VenueOrderItemStatus.CANCELLED, timestamp, operatorId || null, reason || '管理員取消', timestamp, guildId, item.id]
    );
    const nextStatus = updateOrderStatus(api, item.orderId);
    if (nextStatus === VenueOrderStatus.CANCELLED) {
      const orderRow = api.get('SELECT * FROM casino_venue_orders WHERE guild_id = ? AND id = ?', [guildId, item.orderId]);
      refundCancelledOrderTip(api, orderRow, { timestamp });
    }
    insertAdminLog(api, {
      guildId,
      operatorId,
      targetUserId: item.makerUserId,
      action: 'venue:cancel',
      reason,
      details: { orderItemId: item.id, orderId: item.orderId, itemType: item.itemType, itemName: item.itemName },
      createdAt: timestamp,
    });

    return mapOrderItem(api.get('SELECT * FROM casino_venue_order_items WHERE guild_id = ? AND id = ?', [guildId, item.id]));
  });
}

function listVenueHistory(guildId, { limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const normalizedLimit = Math.min(Math.max(Number(limit || 10), 1), 25);
    return api
      .all(
        `SELECT *
         FROM casino_venue_order_items
         WHERE guild_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [guildId, normalizedLimit]
      )
      .map(mapOrderItem);
  });
}

function processExpiredVenueOrderItems({ date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const cutoff = new Date(date.getTime() - NPC_TIMEOUT_MS).toISOString();
    const rows = api.all(
      'SELECT * FROM casino_venue_order_items WHERE status = ? AND created_at <= ?',
      [VenueOrderItemStatus.PENDING, cutoff]
    );
    const timestamp = nowIso(date);
    const serviceDate = getLocalDate(date);
    let penaltiesCreated = 0;

    for (const row of rows) {
      const item = mapOrderItem(row);
      api.run(
        `UPDATE casino_venue_order_items
         SET maker_is_npc = 1, status = ?, actual_steps = ?, service_date = ?, bonus_amount = 0,
             completed_at = ?, updated_at = ?
         WHERE id = ?`,
        [VenueOrderItemStatus.COMPLETED, item.standardSteps, serviceDate, timestamp, timestamp, item.id]
      );
      const makerJob = item.makerJobId
        ? getGuildJobRowWithApi(api, { guildId: item.guildId, jobId: item.makerJobId })
        : null;
      if (makerJob && item.makerUserId) {
        closeOverdueMakerTaskWithApi(api, { guildId: item.guildId, itemId: item.id, timestamp });
        const penalty = createWorkPenaltyWithApi(api, {
          guildId: item.guildId,
          userId: item.makerUserId,
          jobId: item.makerJobId,
          jobName: item.makerJobName,
          sourceType: 'venue_item',
          sourceId: item.id,
          sourceChannelId: api.get('SELECT channel_id FROM casino_venue_orders WHERE guild_id = ? AND id = ?', [
            item.guildId,
            item.orderId,
          ])?.channel_id || null,
          penaltyDate: getLocalDate(new Date(item.createdAt)),
          amount: Number(makerJob.daily_salary || 0),
          reason: `場館訂單項目 #${item.id} 逾期 24 小時未完成，由小吉接手，扣除當日薪水。`,
          createdAt: timestamp,
        });
        if (penalty) {
          penaltiesCreated++;
        }
      }
      // New primary tasks remain pending until the primary-work expiry handler
      // records the matching cycle penalty and closes that exact task.
      updateOrderStatus(api, item.orderId);
    }

    // The orders this sweep closes share their condition with the primary-task expiry sweep, which
    // leaves exactly these orders' waiter tasks to this sweep (see venueOrders.js).
    const waiterRows = listVenueSweepDueOrdersWithApi(api, { cutoff });
    let waiterRefunded = 0;
    for (const orderRow of waiterRows) {
      // The waiter is late only when every item was ready without NPC staff stepping in.  This
      // sweep is the only one that closes these waiter tasks, so the cause does not depend on which
      // sweep runs first.
      const cause = hasItemTakenOverFromLateMaker(api, orderRow.guild_id, orderRow.id) ? 'maker_overdue' : 'waiter_overdue';
      if (refundOverdueOrderTip(api, orderRow, { cause, timestamp })) {
        waiterRefunded++;
      }
    }

    return { checked: rows.length, completedByNpc: rows.length, penaltiesCreated, waiterRefunded };
  });
}

module.exports = {
  ORDER_RATE_LIMIT_PER_MINUTE,
  VENUE_BONUS_AMOUNT,
  VENUE_BONUS_THRESHOLD,
  VENUE_JOB_BY_TYPE,
  WAITER_TIP_MINIMUMS,
  VenueItemType,
  VenueOrderItemStatus,
  VenueOrderStatus,
  addVenueMenuItem,
  cancelVenueOrderItem,
  completeVenueOrderItem,
  createVenueOrder,
  deleteVenueMenuItem,
  getVenueRecipe,
  listVenueHistory,
  listVenueMenu,
  processExpiredVenueOrderItems,
  reassignVenueOrderItem,
  reassignVenueWaiter,
  serveVenueOrder,
  splitSteps,
  // Test seams: the two tip refunds, so a test can hand them an outdated order row.
  refundCancelledOrderTipForTests: refundCancelledOrderTip,
  refundOverdueOrderTipForTests: refundOverdueOrderTip,
};
