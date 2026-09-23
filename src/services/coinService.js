const crypto = require('node:crypto');
const { getCoinDatabaseInfo, withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const { getWalletPlayerWithApi, mutateWalletWithApi } = require('./coinWalletService');

const MAX_COIN_AMOUNT = 9_000_000_000;
const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 25;
const DAILY_TIME_ZONE = 'Asia/Taipei';

const TransactionType = Object.freeze({
  DAILY: 'daily_checkin',
  ADMIN_ADD: 'admin_add',
  ADMIN_REMOVE: 'admin_remove',
  ADMIN_SET: 'admin_set',
  ADMIN_RESET_USER: 'admin_reset_user',
  SHOP_PURCHASE: 'shop_purchase',
  SYSTEM_REWARD: 'system_reward',
  SYSTEM_REFUND: 'system_refund',
  TRANSFER_IN: 'transfer_in',
  TRANSFER_OUT: 'transfer_out',
  BANK_DEPOSIT: 'bank_deposit',
  BANK_WITHDRAW: 'bank_withdraw',
  BANK_INTEREST: 'bank_interest',
  FIXED_DEPOSIT_CREATE: 'fixed_deposit_create',
  FIXED_DEPOSIT_CLAIM: 'fixed_deposit_claim',
  FIXED_DEPOSIT_CANCEL: 'fixed_deposit_cancel',
  WORK_SALARY: 'work_salary',
  WORK_PENALTY_REFUND: 'work_penalty_refund',
  BASIC_SALARY: 'basic_salary',
  RATE_ADJUST: 'rate_adjust',
  CASINO_BET: 'casino_bet',
  CASINO_PAYOUT: 'casino_payout',
  CASINO_LOAN_BORROW: 'casino_loan_borrow',
  CASINO_LOAN_REPAY: 'casino_loan_repay',
  CASINO_FORCED_COLLECTION: 'casino_forced_collection',
  CHIP_BUY: 'chip_buy',
  CHIP_CASHOUT: 'chip_cashout',
  LUXURY_PURCHASE: 'luxury_purchase',
  PAWN_PAYOUT: 'pawn_payout',
  PAWN_REDEEM: 'pawn_redeem',
});

const ShopItemTypes = Object.freeze({
  ROLE: 'role',
  TEXT_CHANNEL: 'text_channel',
  VOICE_CHANNEL: 'voice_channel',
  TITLE: 'title',
  COLLECTIBLE: 'collectible',
  INTERACTION: 'interaction',
  BATTLE_ITEM: 'battle_item',
});

class CoinServiceError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CoinServiceError';
    this.code = code;
    this.details = details;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function getCoinTimezone() {
  return String(process.env.COIN_TIMEZONE || 'Asia/Taipei').trim() || 'Asia/Taipei';
}

function getLocalDate(date = new Date(), timeZone = getCoinTimezone()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function getDailyDate(date = new Date()) {
  return getLocalDate(date, DAILY_TIME_ZONE);
}

function addDays(dateString, days) {
  const [year, month, day] = String(dateString).split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return date.toISOString().slice(0, 10);
}

function getNextDailyLabel(today = getDailyDate()) {
  const next = addDays(today, 1);
  const [, month, day] = next.split('-').map(Number);
  return `${month}月${day}日00點00分（台灣時間）`;
}

function requireGuildId(guildId) {
  if (!guildId) {
    throw new CoinServiceError('GUILD_REQUIRED', '這個指令只能在伺服器內使用。');
  }
}

function requireUserId(userId) {
  if (!userId) {
    throw new CoinServiceError('USER_REQUIRED', '找不到目標使用者。');
  }
}

function normalizeLimit(limit, fallback = DEFAULT_PAGE_SIZE) {
  const value = Number(limit || fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return fallback;
  }

  return Math.min(value, MAX_PAGE_SIZE);
}

function normalizePage(page) {
  const value = Number(page || 1);
  if (!Number.isSafeInteger(value) || value <= 0) {
    return 1;
  }

  return value;
}

function normalizePositiveInteger(value, name) {
  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_COIN_AMOUNT) {
    throw new CoinServiceError('INVALID_AMOUNT', `${name} 必須是正整數。`);
  }

  return amount;
}

function normalizeNonNegativeInteger(value, name, { allowNull = false } = {}) {
  if ((value === null || value === undefined) && allowNull) {
    return null;
  }

  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_COIN_AMOUNT) {
    throw new CoinServiceError('INVALID_AMOUNT', `${name} 必須是 0 以上的整數。`);
  }

  return amount;
}

function safeMultiply(left, right, name) {
  const amount = Number(left) * Number(right);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_COIN_AMOUNT) {
    throw new CoinServiceError('INVALID_AMOUNT', `${name}超過安全範圍。`);
  }
  return amount;
}

function normalizeReason(reason) {
  return String(reason || '').trim().slice(0, 500) || '未提供原因';
}

function normalizeItemType(type) {
  const normalized = String(type || ShopItemTypes.COLLECTIBLE).trim();

  if (!Object.values(ShopItemTypes).includes(normalized)) {
    throw new CoinServiceError('INVALID_ITEM_TYPE', '商品類型不正確。');
  }

  return normalized;
}

function serializeMetadata(metadata) {
  if (!metadata) {
    return null;
  }

  return JSON.stringify(metadata);
}

function mapSettings(row) {
  return {
    guildId: row.guild_id,
    enabled: Boolean(row.enabled),
    dailyBaseReward: Number(row.daily_base_reward),
    streakThreeBonus: Number(row.streak_three_bonus),
    streakSevenBonus: Number(row.streak_seven_bonus),
    allowTransfer: Boolean(row.allow_transfer),
    shopEnabled: Boolean(row.shop_enabled),
    adminLogChannelId: row.admin_log_channel_id || null,
    announcementChannelId: row.announcement_channel_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPlayer(row) {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    balance: Number(row.balance),
    bankBalance: Number(row.bank_balance || 0),
    bankInterestAccrued: Number(row.bank_interest_accrued || 0),
    lastInterestDate: row.last_interest_date || null,
    totalEarned: Number(row.total_earned),
    totalSpent: Number(row.total_spent),
    debtAmount: Number(row.debt_amount || 0),
    lastDailyDate: row.global_last_daily_date || row.last_checkin_date || null,
    dailyStreak: Number(row.global_daily_streak || row.streak || 0),
    revision: Number(row.revision || 0),
    createdAt: row.wallet_created_at || row.created_at,
    updatedAt: row.wallet_updated_at || row.updated_at,
  };
}

function mapShopItem(row) {
  return {
    id: String(row.id),
    guildId: row.source_guild_id || null,
    sourceGuildId: row.source_guild_id || null,
    name: row.name,
    description: row.description || '',
    price: Number(row.price),
    type: row.type,
    roleId: null,
    enabled: Boolean(row.enabled),
    deleted: Boolean(row.deleted),
    stock: row.stock === null || row.stock === undefined ? null : Number(row.stock),
    purchaseLimit: row.purchase_limit === null || row.purchase_limit === undefined ? null : Number(row.purchase_limit),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInventoryItem(row) {
  return {
    id: row.id == null ? null : Number(row.id),
    guildId: null,
    userId: row.user_id,
    itemId: String(row.item_id),
    itemName: row.item_name,
    quantity: Number(row.quantity),
    acquiredAt: row.acquired_at,
    lastUsedAt: row.last_used_at || null,
    isUsed: Boolean(row.is_used),
    isExpired: Boolean(row.is_expired),
  };
}

function mapTransaction(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    type: row.type,
    balanceBefore: Number(row.balance_before),
    amount: Number(row.amount),
    balanceAfter: Number(row.balance_after),
    operatorId: row.operator_id || null,
    reason: row.reason || '',
    metadata: row.metadata || null,
    walletScope: row.wallet_scope || 'guild_legacy',
    walletRevision: row.wallet_revision == null ? null : Number(row.wallet_revision),
    createdAt: row.created_at,
  };
}

function mapPurchase(row) {
  return {
    id: Number(row.id),
    guildId: row.source_guild_id || null,
    userId: row.user_id,
    itemId: String(row.item_id),
    itemName: row.item_name,
    quantity: Number(row.quantity),
    totalPrice: Number(row.total_price),
    itemType: row.item_type || ShopItemTypes.COLLECTIBLE,
    status: row.status || 'active',
    expiresAt: row.expires_at || null,
    createdAt: row.created_at,
  };
}

function ensureGuildSettings(api, guildId) {
  requireGuildId(guildId);

  const timestamp = nowIso();
  api.run(
    `INSERT INTO coin_guild_settings (guild_id, created_at, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(guild_id) DO NOTHING`,
    [guildId, timestamp, timestamp]
  );

  return mapSettings(api.get('SELECT * FROM coin_guild_settings WHERE guild_id = ?', [guildId]));
}

function ensurePlayer(api, guildId, userId) {
  requireGuildId(guildId);
  requireUserId(userId);
  return getWalletPlayerWithApi(api, guildId, userId);
}

function assertEconomyEnabled(settings) {
  if (!settings.enabled) {
    throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  }
}

function assertShopEnabled(settings) {
  if (!settings.shopEnabled) {
    throw new CoinServiceError('SHOP_DISABLED', '這個伺服器的商店目前停用。');
  }
}

function insertAdminLog(api, log) {
  api.run(
    `INSERT INTO coin_admin_logs (guild_id, operator_id, target_user_id, action, reason, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      log.guildId,
      log.operatorId,
      log.targetUserId || null,
      log.action,
      normalizeReason(log.reason),
      serializeMetadata(log.details),
      log.createdAt || nowIso(),
    ]
  );
}

async function getGuildCoinSettings(guildId) {
  return withCoinTransaction((api) => ensureGuildSettings(api, guildId));
}

async function setGuildEconomyEnabled(guildId, enabled, { operatorId } = {}) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const timestamp = nowIso();

    api.run('UPDATE coin_guild_settings SET enabled = ?, updated_at = ? WHERE guild_id = ?', [
      enabled ? 1 : 0,
      timestamp,
      guildId,
    ]);
    insertAdminLog(api, {
      guildId,
      operatorId: operatorId || 'unknown',
      action: enabled ? 'coin_admin:enable' : 'coin_admin:disable',
      reason: enabled ? '啟用吉幣系統' : '停用吉幣系統',
      details: { enabled },
      createdAt: timestamp,
    });

    return mapSettings(api.get('SELECT * FROM coin_guild_settings WHERE guild_id = ?', [guildId]));
  });
}

async function getPlayerBalance(guildId, userId, { allowDisabled = false } = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);

    if (!allowDisabled) {
      assertEconomyEnabled(settings);
    }

    return ensurePlayer(api, guildId, userId);
  });
}

async function dailyCheckin(guildId, userId, date = new Date()) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);

    const player = ensurePlayer(api, guildId, userId);
    const today = getDailyDate(date);
    const dailyState = api.get('SELECT last_checkin_date, streak FROM coin_daily_state WHERE user_id = ?', [userId]);

    if (dailyState?.last_checkin_date === today) {
      throw new CoinServiceError('ALREADY_CHECKED_IN', `今日已簽到過，請等待${getNextDailyLabel(today)}再簽到一次。`, {
        player,
        nextDailyAt: getNextDailyLabel(today),
      });
    }

    const yesterday = addDays(today, -1);
    const streak = dailyState?.last_checkin_date === yesterday ? Number(dailyState.streak) + 1 : 1;
    let bonus = 0;

    if (streak > 0 && streak % 7 === 0) {
      bonus = settings.streakSevenBonus;
    } else if (streak === 3) {
      bonus = settings.streakThreeBonus;
    }

    const earned = settings.dailyBaseReward + bonus;
    const timestamp = nowIso();

    api.run(
      `INSERT INTO coin_daily_checkins_global
        (user_id, checkin_date, source_guild_id, earned_amount, bonus_amount, streak, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, today, guildId, earned, bonus, streak, timestamp]
    );
    api.run(
      `INSERT INTO coin_daily_state (user_id, last_checkin_date, streak, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         last_checkin_date = excluded.last_checkin_date,
         streak = excluded.streak,
         updated_at = excluded.updated_at`,
      [userId, today, streak, timestamp]
    );
    const mutation = mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.DAILY,
      balanceDelta: earned,
      totalEarnedDelta: earned,
      operatorId: null,
      reason: '每日簽到',
      metadata: { streak, bonus, checkinDate: today },
      createdAt: timestamp,
    });
    return {
      player: mutation.after,
      earned,
      baseReward: settings.dailyBaseReward,
      bonus,
      streak,
      checkinDate: today,
      nextDailyAt: getNextDailyLabel(today),
    };
  });
}

async function getLeaderboard(guildId, { page = 1, limit = DEFAULT_PAGE_SIZE } = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);

    const normalizedPage = normalizePage(page);
    const normalizedLimit = normalizeLimit(limit);
    const offset = (normalizedPage - 1) * normalizedLimit;
    const rows = api.all(
      `SELECT gp.guild_id, gp.user_id, gp.bank_balance, gp.bank_interest_accrued,
              gp.last_interest_date, ds.last_checkin_date AS global_last_daily_date,
              ds.streak AS global_daily_streak,
              w.balance, w.total_earned, w.total_spent, w.revision,
              w.created_at AS wallet_created_at, w.updated_at AS wallet_updated_at
       FROM coin_guild_players gp
       JOIN coin_wallets w ON w.user_id = gp.user_id
       LEFT JOIN coin_daily_state ds ON ds.user_id = gp.user_id
       WHERE gp.guild_id = ?
       ORDER BY w.balance DESC, w.total_earned DESC, w.updated_at ASC
       LIMIT ? OFFSET ?`,
      [guildId, normalizedLimit, offset]
    );

    return {
      page: normalizedPage,
      limit: normalizedLimit,
      players: rows.map(mapPlayer),
    };
  });
}

async function adjustPlayerBalance(guildId, userId, { action, amount, operatorId, reason, allowNegative = false }) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const player = ensurePlayer(api, guildId, userId);
    const timestamp = nowIso();
    let delta;
    let type;
    let newBalance;

    if (action === 'add') {
      delta = normalizePositiveInteger(amount, '加幣數量');
      type = TransactionType.ADMIN_ADD;
      newBalance = player.balance + delta;
    } else if (action === 'remove') {
      delta = -normalizePositiveInteger(amount, '扣幣數量');
      type = TransactionType.ADMIN_REMOVE;
      newBalance = player.balance + delta;
    } else if (action === 'set') {
      newBalance = normalizeNonNegativeInteger(amount, '設定餘額');
      delta = newBalance - player.balance;
      type = TransactionType.ADMIN_SET;
    } else {
      throw new CoinServiceError('INVALID_ACTION', '未知的管理操作。');
    }

    if (!allowNegative && newBalance < 0) {
      throw new CoinServiceError('NEGATIVE_BALANCE', '吉幣餘額不可低於 0。', {
        balance: player.balance,
        requestedAmount: amount,
      });
    }

    const mutation = mutateWalletWithApi(api, {
      guildId,
      userId,
      type,
      balanceTarget: newBalance,
      totalEarnedDelta: Math.max(delta, 0),
      totalSpentDelta: Math.max(-delta, 0),
      operatorId,
      reason,
      createdAt: timestamp,
    });
    insertAdminLog(api, {
      guildId,
      operatorId: operatorId || 'unknown',
      targetUserId: userId,
      action: `coin_admin:${action}`,
      reason,
      details: { before: player.balance, amount: delta, after: newBalance },
      createdAt: timestamp,
    });

    return {
      before: player.balance,
      amount: delta,
      after: newBalance,
      player: mutation.after,
    };
  });
}

async function resetPlayerData(guildId, userId, { operatorId, reason }) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const player = ensurePlayer(api, guildId, userId);
    const timestamp = nowIso();

    api.run(
      `UPDATE coin_guild_players
       SET last_daily_date = NULL, daily_streak = 0, updated_at = ?
       WHERE guild_id = ? AND user_id = ?`,
      [timestamp, guildId, userId]
    );
    api.run('DELETE FROM coin_daily_checkins WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    api.run('DELETE FROM coin_inventory WHERE guild_id = ? AND user_id = ?', [guildId, userId]);
    api.run('DELETE FROM coin_daily_checkins_global WHERE user_id = ?', [userId]);
    api.run('DELETE FROM coin_daily_state WHERE user_id = ?', [userId]);
    api.run('DELETE FROM coin_global_inventory WHERE user_id = ?', [userId]);
    api.run('DELETE FROM coin_debts WHERE user_id = ?', [userId]);
    mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.ADMIN_RESET_USER,
      balanceTarget: 0,
      totalEarnedTarget: 0,
      totalSpentTarget: 0,
      operatorId,
      reason,
      createdAt: timestamp,
    });
    insertAdminLog(api, {
      guildId,
      operatorId: operatorId || 'unknown',
      targetUserId: userId,
      action: 'coin_admin:reset-user',
      reason,
      details: { before: player.balance, after: 0 },
      createdAt: timestamp,
    });

    return {
      before: player.balance,
      after: 0,
    };
  });
}

async function getTransactions(guildId, userId, { limit = DEFAULT_PAGE_SIZE } = {}) {
  return withCoinDatabase((api) => {
    requireGuildId(guildId);
    requireUserId(userId);

    return api
      .all(
        `SELECT *
         FROM coin_transactions
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [guildId, userId, normalizeLimit(limit)]
      )
      .map(mapTransaction);
  });
}

async function getAllTransactions(guildId, { userId = null, limit = DEFAULT_PAGE_SIZE } = {}) {
  return withCoinDatabase((api) => {
    requireGuildId(guildId);

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
         FROM coin_transactions
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        params
      )
      .map(mapTransaction);
  });
}

async function getAllPlayers(guildId, { limit = MAX_PAGE_SIZE } = {}) {
  return withCoinDatabase((api) => {
    requireGuildId(guildId);

    return api
      .all(
        `SELECT gp.guild_id, gp.user_id, gp.bank_balance, gp.bank_interest_accrued,
                gp.last_interest_date, ds.last_checkin_date AS global_last_daily_date,
                ds.streak AS global_daily_streak,
                w.balance, w.total_earned, w.total_spent, w.revision,
                w.created_at AS wallet_created_at, w.updated_at AS wallet_updated_at
         FROM coin_guild_players gp
         JOIN coin_wallets w ON w.user_id = gp.user_id
         LEFT JOIN coin_daily_state ds ON ds.user_id = gp.user_id
         WHERE gp.guild_id = ?
         ORDER BY (w.balance + gp.bank_balance) DESC, w.total_earned DESC, w.updated_at ASC
         LIMIT ?`,
        [guildId, normalizeLimit(limit, MAX_PAGE_SIZE)]
      )
      .map(mapPlayer);
  });
}

async function createShopItem(guildId, input) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const name = String(input.name || '').trim().slice(0, 80);
    const description = String(input.description || '').trim().slice(0, 500);
    const price = normalizeNonNegativeInteger(input.price, '商品價格');
    const type = normalizeItemType(input.type);
    const stock = normalizeNonNegativeInteger(input.stock, '庫存', { allowNull: true });
    const purchaseLimit = normalizeNonNegativeInteger(input.purchaseLimit, '每人購買限制', { allowNull: true });
    const timestamp = nowIso();

    if (!name) {
      throw new CoinServiceError('INVALID_ITEM_NAME', '商品名稱不可空白。');
    }

    if (type === ShopItemTypes.ROLE || input.roleId) {
      throw new CoinServiceError('ROLE_ITEM_NOT_SUPPORTED', '新全域商品不可使用 Discord 身分組類型。');
    }

    const id = `g_${crypto.randomUUID()}`;

    api.run(
      `INSERT INTO coin_global_shop_items
        (id, name, description, price, type, enabled, deleted, stock, purchase_limit,
         created_by, source_guild_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        name,
        description,
        price,
        type,
        stock,
        purchaseLimit,
        input.createdBy,
        guildId,
        timestamp,
        timestamp,
      ]
    );

    const item = mapShopItem(api.get('SELECT * FROM coin_global_shop_items WHERE id = ?', [id]));

    insertAdminLog(api, {
      guildId,
      operatorId: input.createdBy || 'unknown',
      action: 'shop_admin:create',
      reason: '新增商店商品',
      details: { itemId: item.id, name: item.name, price: item.price, type: item.type },
      createdAt: timestamp,
    });

    return item;
  });
}

async function editShopItem(guildId, itemId, input) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const item = api.get('SELECT * FROM coin_global_shop_items WHERE id = ? AND deleted = 0', [itemId]);

    if (!item) {
      throw new CoinServiceError('ITEM_NOT_FOUND', '找不到這個商品。');
    }

    const updates = [];
    const params = [];

    function setColumn(column, value) {
      updates.push(`${column} = ?`);
      params.push(value);
    }

    if (input.name !== undefined) {
      const name = String(input.name || '').trim().slice(0, 80);
      if (!name) {
        throw new CoinServiceError('INVALID_ITEM_NAME', '商品名稱不可空白。');
      }
      setColumn('name', name);
    }

    if (input.description !== undefined) {
      setColumn('description', String(input.description || '').trim().slice(0, 500));
    }

    if (input.price !== undefined) {
      setColumn('price', normalizeNonNegativeInteger(input.price, '商品價格'));
    }

    if (input.type !== undefined) {
      const type = normalizeItemType(input.type);
      if (type === ShopItemTypes.ROLE) throw new CoinServiceError('ROLE_ITEM_NOT_SUPPORTED', '新全域商品不可使用 Discord 身分組類型。');
      setColumn('type', type);
    }

    if (input.roleId !== undefined) {
      throw new CoinServiceError('ROLE_ITEM_NOT_SUPPORTED', '新全域商品不可綁定 Discord 身分組。');
    }

    if (input.stock !== undefined) {
      setColumn('stock', normalizeNonNegativeInteger(input.stock, '庫存', { allowNull: true }));
    }

    if (input.purchaseLimit !== undefined) {
      setColumn('purchase_limit', normalizeNonNegativeInteger(input.purchaseLimit, '每人購買限制', { allowNull: true }));
    }

    if (updates.length === 0) {
      throw new CoinServiceError('NO_CHANGES', '沒有提供要修改的欄位。');
    }

    const timestamp = nowIso();
    setColumn('updated_at', timestamp);
    api.run(`UPDATE coin_global_shop_items SET ${updates.join(', ')} WHERE id = ?`, [...params, itemId]);
    insertAdminLog(api, {
      guildId,
      operatorId: input.operatorId || 'unknown',
      action: 'shop_admin:edit',
      reason: '修改商店商品',
      details: { itemId, changedColumns: updates.map((update) => update.split(' = ')[0]) },
      createdAt: timestamp,
    });

    return mapShopItem(api.get('SELECT * FROM coin_global_shop_items WHERE id = ?', [itemId]));
  });
}

async function setShopItemEnabled(guildId, itemId, enabled, { operatorId } = {}) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const item = api.get('SELECT * FROM coin_global_shop_items WHERE id = ? AND deleted = 0', [itemId]);

    if (!item) {
      throw new CoinServiceError('ITEM_NOT_FOUND', '找不到這個商品。');
    }

    const timestamp = nowIso();

    api.run('UPDATE coin_global_shop_items SET enabled = ?, updated_at = ? WHERE id = ?', [
      enabled ? 1 : 0,
      timestamp,
      itemId,
    ]);
    insertAdminLog(api, {
      guildId,
      operatorId: operatorId || 'unknown',
      action: enabled ? 'shop_admin:enable' : 'shop_admin:disable',
      reason: enabled ? '啟用商店商品' : '停用商店商品',
      details: { itemId },
      createdAt: timestamp,
    });

    return mapShopItem(api.get('SELECT * FROM coin_global_shop_items WHERE id = ?', [itemId]));
  });
}

async function deleteShopItem(guildId, itemId, { operatorId } = {}) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const item = api.get('SELECT * FROM coin_global_shop_items WHERE id = ? AND deleted = 0', [itemId]);

    if (!item) {
      throw new CoinServiceError('ITEM_NOT_FOUND', '找不到這個商品。');
    }

    const timestamp = nowIso();

    api.run('UPDATE coin_global_shop_items SET enabled = 0, deleted = 1, updated_at = ? WHERE id = ?', [
      timestamp,
      itemId,
    ]);
    insertAdminLog(api, {
      guildId,
      operatorId: operatorId || 'unknown',
      action: 'shop_admin:delete',
      reason: '軟刪除商店商品',
      details: { itemId },
      createdAt: timestamp,
    });

    return mapShopItem(api.get('SELECT * FROM coin_global_shop_items WHERE id = ?', [itemId]));
  });
}

async function listShopItems(guildId, { page = 1, limit = DEFAULT_PAGE_SIZE, includeDisabled = false } = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    assertShopEnabled(settings);

    const normalizedPage = normalizePage(page);
    const normalizedLimit = normalizeLimit(limit);
    const offset = (normalizedPage - 1) * normalizedLimit;
    const rows = api.all(
      `SELECT *
       FROM coin_global_shop_items
       WHERE deleted = 0 AND (? = 1 OR enabled = 1)
       ORDER BY created_at ASC, id ASC
       LIMIT ? OFFSET ?`,
      [includeDisabled ? 1 : 0, normalizedLimit, offset]
    );

    return {
      page: normalizedPage,
      limit: normalizedLimit,
      items: rows.map(mapShopItem),
    };
  });
}

async function getShopItem(guildId, itemId, { includeDisabled = false, includeDeleted = false } = {}) {
  return withCoinDatabase((api) => {
    requireGuildId(guildId);
    const item = api.get(
      `SELECT *
       FROM coin_global_shop_items
       WHERE id = ?
         AND (? = 1 OR enabled = 1)
         AND (? = 1 OR deleted = 0)`,
      [itemId, includeDisabled ? 1 : 0, includeDeleted ? 1 : 0]
    );

    return item ? mapShopItem(item) : null;
  });
}

async function purchaseItem(guildId, userId, itemId, quantity = 1) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    assertShopEnabled(settings);

    const normalizedQuantity = normalizePositiveInteger(quantity, '購買數量');
    const itemRow = api.get('SELECT * FROM coin_global_shop_items WHERE id = ? AND deleted = 0', [itemId]);

    if (!itemRow) {
      throw new CoinServiceError('ITEM_NOT_FOUND', '找不到這個商品。');
    }

    const item = mapShopItem(itemRow);

    if (!item.enabled) {
      throw new CoinServiceError('ITEM_DISABLED', '這個商品目前不可購買。');
    }

    if (item.stock !== null && item.stock < normalizedQuantity) {
      throw new CoinServiceError('OUT_OF_STOCK', '商品庫存不足。', { stock: item.stock });
    }

    const inventoryRow = api.get(
      'SELECT quantity FROM coin_global_inventory WHERE user_id = ? AND item_id = ?',
      [userId, item.id]
    );
    const currentQuantity = Number(inventoryRow?.quantity || 0);

    if (item.purchaseLimit !== null && currentQuantity + normalizedQuantity > item.purchaseLimit) {
      throw new CoinServiceError('PURCHASE_LIMIT', '已達到這個商品的每人購買限制。', {
        currentQuantity,
        purchaseLimit: item.purchaseLimit,
      });
    }

    const totalPrice = safeMultiply(item.price, normalizedQuantity, '購買總價');
    const player = ensurePlayer(api, guildId, userId);

    if (player.balance < totalPrice) {
      throw new CoinServiceError('INSUFFICIENT_FUNDS', '吉幣不足，無法購買。', {
        balance: player.balance,
        required: totalPrice,
      });
    }

    const timestamp = nowIso();
    const after = player.balance - totalPrice;

    const mutation = mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.SHOP_PURCHASE,
      balanceDelta: -totalPrice,
      totalSpentDelta: totalPrice,
      operatorId: null,
      reason: `購買商品：${item.name}`,
      metadata: { itemId: item.id, quantity: normalizedQuantity },
      createdAt: timestamp,
    });

    if (item.stock !== null) {
      api.run('UPDATE coin_global_shop_items SET stock = stock - ?, updated_at = ? WHERE id = ?', [
        normalizedQuantity,
        timestamp,
        item.id,
      ]);
    }

    api.run(
      `INSERT INTO coin_global_inventory
        (user_id, item_id, item_name, quantity, acquired_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, item_id) DO UPDATE SET
         item_name = excluded.item_name,
         quantity = coin_global_inventory.quantity + excluded.quantity,
         updated_at = excluded.updated_at`,
      [userId, item.id, item.name, normalizedQuantity, timestamp, timestamp]
    );
    api.run(
      `INSERT INTO coin_global_purchases
        (source_guild_id, user_id, item_id, item_name, quantity, total_price, item_type, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [guildId, userId, item.id, item.name, normalizedQuantity, totalPrice, item.type, timestamp]
    );
    return {
      item: mapShopItem(api.get('SELECT * FROM coin_global_shop_items WHERE id = ?', [item.id])),
      quantity: normalizedQuantity,
      totalPrice,
      before: player.balance,
      after,
      player: mutation.after,
    };
  });
}

async function refundPurchase(guildId, userId, { itemId, quantity, amount, reason }) {
  return withCoinTransaction((api) => {
    const player = ensurePlayer(api, guildId, userId);
    const normalizedAmount = normalizeNonNegativeInteger(amount, '退款金額');
    const normalizedQuantity = normalizePositiveInteger(quantity || 1, '退款數量');
    const item = api.get('SELECT * FROM coin_global_shop_items WHERE id = ?', [itemId]);
    const timestamp = nowIso();
    const after = player.balance + normalizedAmount;

    mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.SYSTEM_REFUND,
      balanceDelta: normalizedAmount,
      totalSpentTarget: Math.max(player.totalSpent - normalizedAmount, 0),
      operatorId: null,
      reason,
      metadata: { itemId, quantity: normalizedQuantity },
      createdAt: timestamp,
    });

    if (item?.stock !== null && item?.stock !== undefined) {
      api.run('UPDATE coin_global_shop_items SET stock = stock + ?, updated_at = ? WHERE id = ?', [
        normalizedQuantity,
        timestamp,
        itemId,
      ]);
    }

    api.run(
      `UPDATE coin_global_inventory
       SET quantity = MAX(quantity - ?, 0)
       WHERE user_id = ? AND item_id = ?`,
      [normalizedQuantity, userId, itemId]
    );
    api.run('DELETE FROM coin_global_inventory WHERE user_id = ? AND item_id = ? AND quantity <= 0', [
      userId,
      itemId,
    ]);
    return {
      before: player.balance,
      after,
      amount: normalizedAmount,
    };
  });
}

async function getInventory(guildId, userId) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    ensurePlayer(api, guildId, userId);

    return api
      .all(
        `SELECT *
         FROM coin_global_inventory
         WHERE user_id = ? AND quantity > 0
         ORDER BY updated_at DESC, item_id`,
        [userId]
      )
      .map(mapInventoryItem);
  });
}

async function getAllInventory(guildId, { userId = null, limit = DEFAULT_PAGE_SIZE } = {}) {
  return withCoinDatabase((api) => {
    requireGuildId(guildId);

    const params = [];
    let where = 'WHERE quantity > 0';

    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }

    params.push(normalizeLimit(limit, MAX_PAGE_SIZE));

    return api
      .all(
        `SELECT *
         FROM coin_global_inventory
         ${where}
         ORDER BY updated_at DESC, item_id
         LIMIT ?`,
        params
      )
      .map(mapInventoryItem);
  });
}

async function getPurchaseHistory(guildId, userId, { limit = DEFAULT_PAGE_SIZE } = {}) {
  return withCoinDatabase((api) => {
    requireGuildId(guildId);
    requireUserId(userId);

    return api
      .all(
        `SELECT *
         FROM coin_global_purchases
         WHERE user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [userId, normalizeLimit(limit)]
      )
      .map(mapPurchase);
  });
}

async function getAllPurchaseHistory(guildId, { userId = null, limit = DEFAULT_PAGE_SIZE } = {}) {
  return withCoinDatabase((api) => {
    requireGuildId(guildId);

    const params = [guildId];
    let where = 'WHERE source_guild_id = ?';

    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
    }

    params.push(normalizeLimit(limit, MAX_PAGE_SIZE));

    return api
      .all(
        `SELECT *
         FROM coin_global_purchases
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        params
      )
      .map(mapPurchase);
  });
}

async function getCoinDatabaseStats(guildId) {
  return withCoinTransaction(async (api) => {
    const settings = guildId ? ensureGuildSettings(api, guildId) : null;
    const databaseInfo = await getCoinDatabaseInfo();
    const count = (tableName, whereSql = '', params = []) =>
      Number(api.get(`SELECT COUNT(*) AS count FROM ${tableName} ${whereSql}`, params).count);
    const lastTransaction = api.get(
      guildId
        ? 'SELECT * FROM coin_transactions WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT 1'
        : 'SELECT * FROM coin_transactions ORDER BY created_at DESC, id DESC LIMIT 1',
      guildId ? [guildId] : []
    );

    return {
      databaseInfo,
      settings,
      players: count('coin_guild_players', guildId ? 'WHERE guild_id = ?' : '', guildId ? [guildId] : []),
      shopItems: count('coin_global_shop_items', 'WHERE deleted = 0'),
      transactions: count('coin_transactions', guildId ? 'WHERE guild_id = ?' : '', guildId ? [guildId] : []),
      purchases: count('coin_global_purchases', guildId ? 'WHERE source_guild_id = ?' : '', guildId ? [guildId] : []),
      adminLogs: count('coin_admin_logs', guildId ? 'WHERE guild_id = ?' : '', guildId ? [guildId] : []),
      lastTransaction: lastTransaction ? mapTransaction(lastTransaction) : null,
    };
  });
}

module.exports = {
  CoinServiceError,
  ShopItemTypes,
  TransactionType,
  adjustPlayerBalance,
  createShopItem,
  dailyCheckin,
  deleteShopItem,
  editShopItem,
  getAllPlayers,
  getAllInventory,
  getAllPurchaseHistory,
  getAllTransactions,
  getCoinDatabaseStats,
  getGuildCoinSettings,
  getInventory,
  getLeaderboard,
  getPlayerBalance,
  getPurchaseHistory,
  getShopItem,
  getTransactions,
  listShopItems,
  purchaseItem,
  refundPurchase,
  resetPlayerData,
  setGuildEconomyEnabled,
  setShopItemEnabled,
  // Exported helpers
  nowIso,
  getLocalDate,
  addDays,
  getCoinTimezone,
  ensureGuildSettings,
  ensurePlayer,
  insertAdminLog,
};
