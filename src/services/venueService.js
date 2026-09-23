const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
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
  TASK_STATUS,
  WAITER_JOB_NAMES,
  createWorkPenaltyWithApi,
} = require('./workService');

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

function serializeArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
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

function getActiveJobRow(api, guildId, userId, jobName) {
  return api.get(
    'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND job_name = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [guildId, userId, jobName, 'active']
  );
}

function ensureMakerJob(api, guildId, userId, itemType) {
  const jobName = VENUE_JOB_BY_TYPE[itemType];
  const row = getActiveJobRow(api, guildId, userId, jobName);

  if (!row) {
    throw new CoinServiceError(
      'VENUE_MAKER_JOB_REQUIRED',
      itemType === VenueItemType.MEAL ? '餐點只能指定目前在職的廚師。' : '飲料只能指定目前在職的調酒師。'
    );
  }

  return row;
}

function ensureWaiterJob(api, guildId, userId) {
  const placeholders = WAITER_JOB_NAMES.map(() => '?').join(', ');
  const row = api.get(
    `SELECT *
     FROM coin_jobs
     WHERE guild_id = ?
       AND user_id = ?
       AND job_name IN (${placeholders})
       AND status = 'active'
     ORDER BY CASE job_name WHEN '制服服務生' THEN 0 ELSE 1 END, id DESC
     LIMIT 1`,
    [guildId, userId, ...WAITER_JOB_NAMES]
  );

  if (!row) {
    throw new CoinServiceError('VENUE_WAITER_JOB_REQUIRED', '點餐必須指定目前在職的服務生或制服服務生。');
  }

  return row;
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

function insertPendingVenueWorkTask(api, { guildId, userId, jobRow, taskType, description, createdAt, dueAt, channelId = null, messageId = null }) {
  api.run(
    `INSERT INTO coin_work_tasks
      (
        guild_id, user_id, job_id, job_name, task_type, status, description,
        attachment_urls, expected_channel_id, expected_channel_name, message_id,
        external_server_count, external_server_ids, created_at, due_at, updated_at
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      guildId,
      userId,
      jobRow.id,
      jobRow.job_name,
      taskType,
      TASK_STATUS.PENDING,
      description,
      serializeArray([]),
      channelId,
      jobRow.job_name,
      messageId,
      serializeArray([]),
      createdAt,
      dueAt,
      createdAt,
    ]
  );
  api.run('UPDATE coin_jobs SET today_task_count = today_task_count + 1, updated_at = ? WHERE id = ?', [createdAt, jobRow.id]);
  return Number(api.get('SELECT last_insert_rowid() AS id').id);
}

function completePendingVenueWorkTask(api, { guildId, jobId, taskType, messageId = null, description, completedAt }) {
  const params = [guildId, jobId, taskType, TASK_STATUS.PENDING];
  let messageFilter = '';
  if (messageId) {
    messageFilter = 'AND message_id = ?';
    params.push(messageId);
  }

  const row = api.get(
    `SELECT *
     FROM coin_work_tasks
     WHERE guild_id = ?
       AND job_id = ?
       AND task_type = ?
       AND status = ?
       AND completed_at IS NULL
       ${messageFilter}
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    params
  );

  if (!row) {
    return null;
  }

  api.run(
    `UPDATE coin_work_tasks
     SET status = ?, description = ?, completed_at = ?, updated_at = ?
     WHERE guild_id = ? AND id = ?`,
    [TASK_STATUS.COMPLETED, description, completedAt, completedAt, guildId, row.id]
  );
  api.run(
    `UPDATE coin_jobs
     SET last_contribution_at = ?,
         today_completed_task_count = today_completed_task_count + 1,
         updated_at = ?
     WHERE id = ?`,
    [completedAt, completedAt, jobId]
  );

  return Number(row.id);
}

function getLeastBusyMaker(api, guildId, itemType, date = new Date()) {
  const jobName = VENUE_JOB_BY_TYPE[itemType];
  const range = getTaiwanDayRange(date);

  return api.get(
    `SELECT j.*, COUNT(i.id) AS assigned_count
     FROM coin_jobs j
     LEFT JOIN casino_venue_order_items i
       ON i.guild_id = j.guild_id
      AND i.maker_user_id = j.user_id
      AND i.item_type = ?
      AND i.maker_is_npc = 0
      AND i.created_at >= ?
      AND i.created_at < ?
     WHERE j.guild_id = ?
       AND j.job_name = ?
       AND j.status = 'active'
     GROUP BY j.id
     ORDER BY assigned_count ASC, j.created_at ASC, j.id ASC
     LIMIT 1`,
    [itemType, range.startIso, range.endIso, guildId, jobName]
  );
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

function refundOrderTipIfEscrowed(api, orderRow, { reason, timestamp = nowIso() } = {}) {
  const order = mapOrder(orderRow);
  if (order.tipStatus !== 'escrowed' || order.tipAmount <= 0) {
    return null;
  }

  const refund = creditChipsWithApi(api, order.guildId, order.customerId, order.tipAmount, {
    entryType: ChipLedgerType.TIP_REFUND,
    reason: reason || `場館訂單 #${order.id} 小費退還`,
    metadata: { orderId: order.id, waiterUserId: order.waiterUserId },
    timestamp,
  });
  api.run(
    `UPDATE casino_venue_orders
     SET tip_status = 'refunded', tip_refunded_at = ?, served_at = COALESCE(served_at, ?), served_by = COALESCE(served_by, 'system'), updated_at = ?
     WHERE guild_id = ? AND id = ?`,
    [timestamp, timestamp, timestamp, order.guildId, order.id]
  );
  api.run(
    `UPDATE coin_work_tasks
     SET status = ?, completed_at = ?, review_reason = ?, updated_at = ?
     WHERE guild_id = ? AND message_id = ? AND status = ? AND completed_at IS NULL`,
    [
      TASK_STATUS.SYSTEM_COMPLETED,
      timestamp,
      '服務生逾期未送達，由小吉完成並退還小費。',
      timestamp,
      order.guildId,
      `venue-order-${order.id}`,
      TASK_STATUS.PENDING,
    ]
  );

  return refund;
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
    jobId: order.waiterJobId,
    taskType: 'casino_venue_service',
    messageId: `venue-order-${order.id}`,
    description: `訂單 #${order.id} 已送達，收到小費 ${order.tipAmount} 籌碼。`,
    completedAt: timestamp,
  });

  return { payout, taskId };
}

function insertVenueWorkTask(api, item, makerJobRow, actualSteps, timestamp) {
  const taskType = item.itemType === VenueItemType.MEAL ? 'casino_venue_meal' : 'casino_venue_drink';
  const description = `${item.itemName} 製作完成\n${normalizeSteps(actualSteps)}`;
  const existingTaskId = completePendingVenueWorkTask(api, {
    guildId: item.guildId,
    jobId: makerJobRow.id,
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
        jobId: makerJobRow.id,
        taskId: existingTaskId,
      },
      createdAt: timestamp,
    });
    return existingTaskId;
  }

  api.run(
    `INSERT INTO coin_work_tasks
      (
        guild_id, user_id, job_id, job_name, task_type, status, description,
        attachment_urls, expected_channel_id, expected_channel_name, message_id,
        external_server_count, external_server_ids, created_at, due_at, completed_at, updated_at
      )
     VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, NULL, ?, NULL, 0, ?, ?, ?, ?, ?)`,
    [
      item.guildId,
      item.makerUserId,
      makerJobRow.id,
      makerJobRow.job_name,
      taskType,
      description,
      serializeArray([]),
      makerJobRow.job_name,
      serializeArray([]),
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    ]
  );
  api.run(
    `UPDATE coin_jobs
     SET last_contribution_at = ?,
         today_task_count = today_task_count + 1,
         today_completed_task_count = today_completed_task_count + 1,
         updated_at = ?
     WHERE id = ?`,
    [timestamp, timestamp, makerJobRow.id]
  );
  const taskId = Number(api.get('SELECT last_insert_rowid() AS id').id);
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
      jobId: makerJobRow.id,
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

  api.run(
    `INSERT INTO casino_venue_order_items
      (
        guild_id, order_id, item_type, menu_item_id, item_name, standard_steps,
        maker_user_id, maker_job_id, maker_job_name, maker_is_npc, status, actual_steps,
        service_date, bonus_amount, created_at, assigned_at, completed_at, updated_at
      )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      guildId,
      orderId,
      menuItem.itemType,
      menuItem.id,
      menuItem.name,
      menuItem.steps,
      makerRow?.user_id || null,
      makerRow?.id || null,
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
    insertPendingVenueWorkTask(api, {
      guildId,
      userId: makerRow.user_id,
      jobRow: makerRow,
      taskType,
      description: `訂單 #${orderId}｜${menuItem.name} 待製作`,
      createdAt: timestamp,
      dueAt: new Date(new Date(timestamp).getTime() + REMINDER_TIMEOUT_MS).toISOString(),
      channelId,
      messageId: `venue-item-${itemId}`,
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
  { mealId = null, drinkId = null, chefId = null, bartenderId = null, waiterId = null, tipAmount = null, channelId = null, date = new Date() } = {}
) {
  return withCoinTransaction((api) => {
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
    const waiterJob = ensureWaiterJob(api, guildId, waiterId);
    const normalizedTip = normalizeTipAmount(tipAmount, waiterJob.job_name);
    const timestamp = nowIso(date);
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
        guild_id, customer_id, channel_id, waiter_user_id, waiter_job_id, waiter_job_name,
        waiter_assigned_at, waiter_due_at, tip_amount, tip_status, status, created_at, updated_at
      )
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'escrowed', ?, ?, ?)`,
      [
        guildId,
        customerId,
        channelId || null,
        waiterId,
        waiterJob.id,
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

    insertPendingVenueWorkTask(api, {
      guildId,
      userId: waiterId,
      jobRow: waiterJob,
      taskType: 'casino_venue_service',
      description: `訂單 #${orderId} 待送達，小費 ${normalizedTip} 籌碼。`,
      createdAt: timestamp,
      dueAt: new Date(new Date(timestamp).getTime() + REMINDER_TIMEOUT_MS).toISOString(),
      channelId,
      messageId: `venue-order-${orderId}`,
    });

    if (meal) {
      const maker = chefId ? ensureMakerJob(api, guildId, chefId, VenueItemType.MEAL) : getLeastBusyMaker(api, guildId, VenueItemType.MEAL, date);
      items.push(insertOrderItem(api, orderId, meal, maker, { guildId, date, forceNpc: !maker, channelId }));
    }

    if (drink) {
      const maker = bartenderId
        ? ensureMakerJob(api, guildId, bartenderId, VenueItemType.DRINK)
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

    const makerJob = ensureMakerJob(api, guildId, userId, item.itemType);
    const normalizedSteps = normalizeSteps(steps);
    const timestamp = nowIso(date);
    const serviceDate = getLocalDate(date);
    const bonusAmount = calculateBonusAmount(api, guildId, item.itemType, serviceDate);
    const taskId = insertVenueWorkTask(api, item, makerJob, normalizedSteps, timestamp);

    api.run(
      `UPDATE casino_venue_order_items
       SET maker_job_id = ?, maker_job_name = ?, status = ?, actual_steps = ?, service_date = ?,
           bonus_amount = ?, completed_at = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [
        makerJob.id,
        makerJob.job_name,
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

    ensureWaiterJob(api, guildId, userId);
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

function reassignVenueOrderItem(guildId, orderItemId, newMakerId, { operatorId, reason = '', date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    const row = api.get('SELECT * FROM casino_venue_order_items WHERE guild_id = ? AND id = ?', [guildId, orderItemId]);

    if (!row) {
      throw new CoinServiceError('VENUE_ORDER_ITEM_NOT_FOUND', '找不到這筆待製作項目。');
    }

    const item = mapOrderItem(row);

    if (item.status !== VenueOrderItemStatus.PENDING) {
      throw new CoinServiceError('VENUE_ORDER_ITEM_NOT_PENDING', '只有待製作項目可以重新指派。');
    }

    const makerJob = ensureMakerJob(api, guildId, newMakerId, item.itemType);
    const timestamp = nowIso(date);
    api.run(
      `UPDATE casino_venue_order_items
       SET maker_user_id = ?, maker_job_id = ?, maker_job_name = ?, maker_is_npc = 0, assigned_at = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [newMakerId, makerJob.id, makerJob.job_name, timestamp, timestamp, guildId, item.id]
    );
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

function reassignVenueWaiter(guildId, orderId, newWaiterId, { operatorId, reason = '', date = new Date() } = {}) {
  return withCoinTransaction((api) => {
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

    const waiterJob = ensureWaiterJob(api, guildId, newWaiterId);
    normalizeTipAmount(order.tipAmount, waiterJob.job_name);
    const timestamp = nowIso(date);
    api.run(
      `UPDATE casino_venue_orders
       SET waiter_user_id = ?, waiter_job_id = ?, waiter_job_name = ?, waiter_assigned_at = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [newWaiterId, waiterJob.id, waiterJob.job_name, timestamp, timestamp, guildId, id]
    );
    api.run(
      `UPDATE coin_work_tasks
       SET status = ?, updated_at = ?
       WHERE guild_id = ? AND message_id = ? AND status = ? AND completed_at IS NULL`,
      [TASK_STATUS.CANCELED, timestamp, guildId, `venue-order-${id}`, TASK_STATUS.PENDING]
    );
    insertPendingVenueWorkTask(api, {
      guildId,
      userId: newWaiterId,
      jobRow: waiterJob,
      taskType: 'casino_venue_service',
      description: `訂單 #${id} 改派後待送達，小費 ${order.tipAmount} 籌碼。`,
      createdAt: timestamp,
      dueAt: new Date(new Date(timestamp).getTime() + REMINDER_TIMEOUT_MS).toISOString(),
      channelId: order.channelId,
      messageId: `venue-order-${id}`,
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
    api.run(
      `UPDATE casino_venue_order_items
       SET status = ?, cancelled_at = ?, cancelled_by = ?, cancel_reason = ?, updated_at = ?
       WHERE guild_id = ? AND id = ?`,
      [VenueOrderItemStatus.CANCELLED, timestamp, operatorId || null, reason || '管理員取消', timestamp, guildId, item.id]
    );
    const nextStatus = updateOrderStatus(api, item.orderId);
    if (nextStatus === VenueOrderStatus.CANCELLED) {
      const orderRow = api.get('SELECT * FROM casino_venue_orders WHERE guild_id = ? AND id = ?', [guildId, item.orderId]);
      refundOrderTipIfEscrowed(api, orderRow, { reason: `場館訂單 #${item.orderId} 已取消，退還小費。`, timestamp });
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
        ? api.get('SELECT * FROM coin_jobs WHERE guild_id = ? AND id = ?', [item.guildId, item.makerJobId])
        : null;
      if (makerJob && item.makerUserId) {
        api.run(
          `UPDATE coin_work_tasks
           SET status = ?, completed_at = ?, review_reason = ?, updated_at = ?
           WHERE guild_id = ? AND message_id = ? AND status = ? AND completed_at IS NULL`,
          [
            TASK_STATUS.SYSTEM_COMPLETED,
            timestamp,
            '餐飲製作逾期 24 小時未完成，由小吉場館人員接手。',
            timestamp,
            item.guildId,
            `venue-item-${item.id}`,
            TASK_STATUS.PENDING,
          ]
        );
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
      updateOrderStatus(api, item.orderId);
    }

    const waiterRows = api.all(
      `SELECT o.*
       FROM casino_venue_orders o
       WHERE o.tip_status = 'escrowed'
         AND o.served_at IS NULL
         AND o.created_at <= ?
         AND NOT EXISTS (
           SELECT 1 FROM casino_venue_order_items i
           WHERE i.guild_id = o.guild_id
             AND i.order_id = o.id
             AND i.status = ?
         )`,
      [cutoff, VenueOrderItemStatus.PENDING]
    );
    let waiterRefunded = 0;
    for (const orderRow of waiterRows) {
      if (refundOrderTipIfEscrowed(api, orderRow, { reason: `場館訂單 #${orderRow.id} 服務生逾期未送達，退還小費。`, timestamp })) {
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
};
