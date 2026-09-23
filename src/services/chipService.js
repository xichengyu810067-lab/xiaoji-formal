const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  CoinServiceError,
  TransactionType,
  ensureGuildSettings,
  ensurePlayer,
  nowIso,
} = require('./coinService');
const {
  getDebtWithApi,
  mutateWalletWithApi,
  setDebtWithApi,
} = require('./coinWalletService');

const MAX_CHIP_AMOUNT = 9_000_000_000;
const CASHOUT_FEE_THRESHOLD = 500_000;
const CASHOUT_FEE_LOW = 100;
const CASHOUT_FEE_HIGH = 200;
const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 25;

const ChipLedgerType = Object.freeze({
  BUY: 'buy',
  AUTO_TOP_UP: 'auto_top_up',
  CASHOUT: 'cashout',
  BET: 'bet',
  PAYOUT: 'payout',
  REFUND: 'refund',
  TIP_ESCROW: 'tip_escrow',
  TIP_PAYOUT: 'tip_payout',
  TIP_REFUND: 'tip_refund',
  LOAN_BORROW: 'loan_borrow',
  LOAN_REPAY: 'loan_repay',
  LODGING: 'lodging',
  DUEL_BET: 'duel_bet',
  DUEL_PAYOUT: 'duel_payout',
});

const DEBT_OFFSET_CHIP_LEDGER_TYPES = new Set([
  ChipLedgerType.TIP_PAYOUT,
]);

function normalizeAmount(value, label = '金額') {
  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CHIP_AMOUNT) {
    throw new CoinServiceError('INVALID_CHIP_AMOUNT', `${label}必須是 1 到 ${MAX_CHIP_AMOUNT.toLocaleString('zh-TW')} 的整數。`);
  }

  return amount;
}

function normalizeLimit(limit) {
  const value = Number(limit || DEFAULT_HISTORY_LIMIT);

  if (!Number.isSafeInteger(value) || value <= 0) {
    return DEFAULT_HISTORY_LIMIT;
  }

  return Math.min(value, MAX_HISTORY_LIMIT);
}

function normalizeReason(reason) {
  return String(reason || '').trim().slice(0, 500) || '未提供原因';
}

function serializeMetadata(metadata) {
  return metadata ? JSON.stringify(metadata) : null;
}

function parseMetadata(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function assertEconomyEnabled(settings) {
  if (!settings.enabled) {
    throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  }
}

function calculateCashoutFee(amount) {
  return amount > CASHOUT_FEE_THRESHOLD ? CASHOUT_FEE_HIGH : CASHOUT_FEE_LOW;
}

function mapChipAccount(row) {
  return {
    guildId: row.guild_id,
    userId: row.user_id,
    balance: Number(row.balance || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapChipLedger(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    entryType: row.entry_type,
    amount: Number(row.amount || 0),
    balanceBefore: Number(row.balance_before || 0),
    balanceAfter: Number(row.balance_after || 0),
    coinAmount: Number(row.coin_amount || 0),
    fee: Number(row.fee || 0),
    operatorId: row.operator_id || null,
    reason: row.reason || '',
    metadata: parseMetadata(row.metadata),
    createdAt: row.created_at,
  };
}

function ensureChipAccount(api, guildId, userId, timestamp = nowIso()) {
  ensurePlayer(api, guildId, userId);
  api.run(
    `INSERT INTO chip_accounts (guild_id, user_id, balance, created_at, updated_at)
     VALUES (?, ?, 0, ?, ?)
     ON CONFLICT(guild_id, user_id) DO NOTHING`,
    [guildId, userId, timestamp, timestamp]
  );

  return mapChipAccount(api.get('SELECT * FROM chip_accounts WHERE guild_id = ? AND user_id = ?', [guildId, userId]));
}

function writeChipBalance(api, guildId, userId, balance, timestamp = nowIso()) {
  api.run(
    'UPDATE chip_accounts SET balance = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
    [balance, timestamp, guildId, userId]
  );
}

function insertChipLedger(api, entry) {
  api.run(
    `INSERT INTO chip_ledger
      (guild_id, user_id, entry_type, amount, balance_before, balance_after, coin_amount, fee, operator_id, reason, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      entry.guildId,
      entry.userId,
      entry.entryType,
      entry.amount,
      entry.balanceBefore,
      entry.balanceAfter,
      entry.coinAmount || 0,
      entry.fee || 0,
      entry.operatorId || null,
      normalizeReason(entry.reason),
      serializeMetadata(entry.metadata),
      entry.createdAt || nowIso(),
    ]
  );
}

function debitCoinsForChips(api, guildId, userId, amount, { timestamp, reason, metadata, operatorId = null }) {
  const player = ensurePlayer(api, guildId, userId);

  if (player.balance < amount) {
    throw new CoinServiceError('INSUFFICIENT_FUNDS', '吉幣不足，無法兌換籌碼。', {
      balance: player.balance,
      required: amount,
    });
  }

  const balanceAfter = player.balance - amount;
  mutateWalletWithApi(api, {
    guildId,
    userId,
    type: TransactionType.CHIP_BUY,
    balanceDelta: -amount,
    totalSpentDelta: amount,
    operatorId,
    reason,
    metadata,
    createdAt: timestamp,
  });

  return {
    coinBalanceBefore: player.balance,
    coinBalanceAfter: balanceAfter,
  };
}

function creditCoinsFromChips(api, guildId, userId, amount, { timestamp, reason, metadata, operatorId = null }) {
  const player = ensurePlayer(api, guildId, userId);
  const balanceAfter = player.balance + amount;

  mutateWalletWithApi(api, {
    guildId,
    userId,
    type: TransactionType.CHIP_CASHOUT,
    balanceDelta: amount,
    totalEarnedDelta: amount,
    operatorId,
    reason,
    metadata,
    createdAt: timestamp,
  });

  return {
    coinBalanceBefore: player.balance,
    coinBalanceAfter: balanceAfter,
  };
}

function creditChipsWithApi(api, guildId, userId, amount, options = {}) {
  const grossChipAmount = normalizeAmount(amount, '籌碼數量');
  const timestamp = options.timestamp || nowIso();
  const account = ensureChipAccount(api, guildId, userId, timestamp);
  const entryType = options.entryType || ChipLedgerType.PAYOUT;
  const debtBefore = getDebtWithApi(api, userId);
  const explicitEligibleIncome = options.debtOffsetAmount;
  if (explicitEligibleIncome != null &&
      (!Number.isSafeInteger(explicitEligibleIncome) || explicitEligibleIncome < 0 || explicitEligibleIncome > grossChipAmount)) {
    throw new CoinServiceError('INVALID_DEBT_OFFSET_AMOUNT', '可抵債的新收益必須是不超過籌碼入帳額的非負整數。');
  }
  const eligibleIncome = explicitEligibleIncome != null
    ? explicitEligibleIncome
    : options.debtOffset === true || DEBT_OFFSET_CHIP_LEDGER_TYPES.has(entryType)
      ? grossChipAmount
      : 0;
  const debtOffset = Math.min(debtBefore, eligibleIncome);
  const chipAmount = grossChipAmount - debtOffset;
  const debtAfter = debtBefore - debtOffset;
  const balanceAfter = account.balance + chipAmount;

  if (debtOffset > 0) {
    setDebtWithApi(api, userId, debtAfter, timestamp);
  }

  writeChipBalance(api, guildId, userId, balanceAfter, timestamp);
  insertChipLedger(api, {
    guildId,
    userId,
    entryType,
    amount: chipAmount,
    balanceBefore: account.balance,
    balanceAfter,
    coinAmount: options.coinAmount || 0,
    fee: options.fee || 0,
    operatorId: options.operatorId || null,
    reason: options.reason || '籌碼入帳',
    metadata: debtOffset > 0 ? {
      ...(options.metadata || {}),
      debtOffset: {
        gross: grossChipAmount,
        eligibleIncome,
        offset: debtOffset,
        net: chipAmount,
        debtBefore,
        debtAfter,
      },
    } : options.metadata,
    createdAt: timestamp,
  });

  return {
    balanceBefore: account.balance,
    balanceAfter,
    grossAmount: grossChipAmount,
    debtOffset,
    netAmount: chipAmount,
    debtBefore,
    debtAfter,
  };
}

function ensureChipsForCasinoWithApi(api, guildId, userId, amount, options = {}) {
  const requiredAmount = normalizeAmount(amount, '籌碼數量');
  const timestamp = options.timestamp || nowIso();
  let account = ensureChipAccount(api, guildId, userId, timestamp);

  if (account.balance >= requiredAmount) {
    return {
      autoTopUpAmount: 0,
      chipBalanceBeforeTopUp: account.balance,
      chipBalanceAfterTopUp: account.balance,
      coinBalanceBefore: null,
      coinBalanceAfter: null,
    };
  }

  const topUpAmount = requiredAmount - account.balance;
  const coinResult = debitCoinsForChips(api, guildId, userId, topUpAmount, {
    timestamp,
    reason: options.topUpReason || '賭場自動補足籌碼',
    metadata: {
      ...(options.metadata || {}),
      autoTopUpFor: options.entryType || 'casino',
      requiredAmount,
      chipBalanceBeforeTopUp: account.balance,
    },
    operatorId: options.operatorId || null,
  });
  const balanceAfterTopUp = account.balance + topUpAmount;

  writeChipBalance(api, guildId, userId, balanceAfterTopUp, timestamp);
  insertChipLedger(api, {
    guildId,
    userId,
    entryType: ChipLedgerType.AUTO_TOP_UP,
    amount: topUpAmount,
    balanceBefore: account.balance,
    balanceAfter: balanceAfterTopUp,
    coinAmount: topUpAmount,
    reason: options.topUpReason || '賭場自動補足籌碼',
    metadata: {
      ...(options.metadata || {}),
      requiredAmount,
    },
    createdAt: timestamp,
  });
  account = { ...account, balance: balanceAfterTopUp };

  return {
    autoTopUpAmount: topUpAmount,
    chipBalanceBeforeTopUp: balanceAfterTopUp - topUpAmount,
    chipBalanceAfterTopUp: account.balance,
    coinBalanceBefore: coinResult.coinBalanceBefore,
    coinBalanceAfter: coinResult.coinBalanceAfter,
  };
}

function debitChipsForCasinoWithApi(api, guildId, userId, amount, options = {}) {
  const chipAmount = normalizeAmount(amount, '籌碼數量');
  const timestamp = options.timestamp || nowIso();
  const funding = ensureChipsForCasinoWithApi(api, guildId, userId, chipAmount, {
    ...options,
    timestamp,
  });
  const account = ensureChipAccount(api, guildId, userId, timestamp);
  const balanceAfter = account.balance - chipAmount;

  if (balanceAfter < 0) {
    throw new CoinServiceError('INSUFFICIENT_CHIPS', '籌碼不足，且吉幣也不足以自動兌換。', {
      balance: account.balance,
      required: chipAmount,
    });
  }

  writeChipBalance(api, guildId, userId, balanceAfter, timestamp);
  insertChipLedger(api, {
    guildId,
    userId,
    entryType: options.entryType || ChipLedgerType.BET,
    amount: -chipAmount,
    balanceBefore: account.balance,
    balanceAfter,
    reason: options.reason || '賭場扣除籌碼',
    metadata: {
      ...(options.metadata || {}),
      autoTopUpAmount: funding.autoTopUpAmount,
    },
    createdAt: timestamp,
  });

  return {
    ...funding,
    balanceBefore: account.balance,
    balanceAfter,
  };
}

function buyChipsWithApi(api, guildId, userId, amount, options = {}) {
  const chipAmount = normalizeAmount(amount, '兌換數量');
  const timestamp = options.timestamp || nowIso();
  ensureGuildSettings(api, guildId);
  const account = ensureChipAccount(api, guildId, userId, timestamp);
  const coinResult = debitCoinsForChips(api, guildId, userId, chipAmount, {
    timestamp,
    reason: options.reason || '吉幣兌換籌碼',
    metadata: options.metadata,
    operatorId: options.operatorId || null,
  });
  const balanceAfter = account.balance + chipAmount;

  writeChipBalance(api, guildId, userId, balanceAfter, timestamp);
  insertChipLedger(api, {
    guildId,
    userId,
    entryType: options.entryType || ChipLedgerType.BUY,
    amount: chipAmount,
    balanceBefore: account.balance,
    balanceAfter,
    coinAmount: chipAmount,
    operatorId: options.operatorId || null,
    reason: options.reason || '吉幣兌換籌碼',
    metadata: options.metadata,
    createdAt: timestamp,
  });

  return {
    amount: chipAmount,
    balanceBefore: account.balance,
    balanceAfter,
    ...coinResult,
  };
}

function cashoutChipsWithApi(api, guildId, userId, amount, options = {}) {
  const chipAmount = normalizeAmount(amount, '兌換數量');
  const fee = calculateCashoutFee(chipAmount);

  if (chipAmount <= fee) {
    throw new CoinServiceError('CHIP_CASHOUT_TOO_SMALL', `兌換數量必須大於手續費 ${fee.toLocaleString('zh-TW')} 籌碼。`);
  }

  const timestamp = options.timestamp || nowIso();
  ensureGuildSettings(api, guildId);
  const account = ensureChipAccount(api, guildId, userId, timestamp);

  if (account.balance < chipAmount) {
    throw new CoinServiceError('INSUFFICIENT_CHIPS', '籌碼不足，無法換回吉幣。', {
      balance: account.balance,
      required: chipAmount,
    });
  }

  const coinAmount = chipAmount - fee;
  const balanceAfter = account.balance - chipAmount;
  const coinResult = creditCoinsFromChips(api, guildId, userId, coinAmount, {
    timestamp,
    reason: options.reason || '籌碼換回吉幣',
    metadata: { ...(options.metadata || {}), fee, chipAmount },
    operatorId: options.operatorId || null,
  });

  writeChipBalance(api, guildId, userId, balanceAfter, timestamp);
  insertChipLedger(api, {
    guildId,
    userId,
    entryType: ChipLedgerType.CASHOUT,
    amount: -chipAmount,
    balanceBefore: account.balance,
    balanceAfter,
    coinAmount,
    fee,
    operatorId: options.operatorId || null,
    reason: options.reason || '籌碼換回吉幣',
    metadata: options.metadata,
    createdAt: timestamp,
  });

  return {
    amount: chipAmount,
    fee,
    coinAmount,
    balanceBefore: account.balance,
    balanceAfter,
    ...coinResult,
  };
}

async function getChipBalance(guildId, userId) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    return ensureChipAccount(api, guildId, userId);
  });
}

async function buyChips(guildId, userId, amount, options = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    return buyChipsWithApi(api, guildId, userId, amount, options);
  });
}

async function cashoutChips(guildId, userId, amount, options = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    return cashoutChipsWithApi(api, guildId, userId, amount, options);
  });
}

async function getChipHistory(guildId, userId, { limit = DEFAULT_HISTORY_LIMIT } = {}) {
  return withCoinDatabase((api) => {
    return api
      .all(
        `SELECT *
         FROM chip_ledger
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [guildId, userId, normalizeLimit(limit)]
      )
      .map(mapChipLedger);
  });
}

module.exports = {
  CASHOUT_FEE_HIGH,
  CASHOUT_FEE_LOW,
  CASHOUT_FEE_THRESHOLD,
  ChipLedgerType,
  DEBT_OFFSET_CHIP_LEDGER_TYPES,
  MAX_CHIP_AMOUNT,
  buyChips,
  buyChipsWithApi,
  calculateCashoutFee,
  cashoutChips,
  cashoutChipsWithApi,
  creditChipsWithApi,
  debitChipsForCasinoWithApi,
  ensureChipAccount,
  ensureChipsForCasinoWithApi,
  getChipBalance,
  getChipHistory,
  insertChipLedger,
  normalizeAmount,
};
