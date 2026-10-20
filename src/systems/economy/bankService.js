const { withCoinTransaction, withCoinDatabase } = require('../../services/coinDatabase');
const {
  CoinServiceError,
  TransactionType,
  addDays,
  ensureGuildSettings,
  ensurePlayer,
  readPlayer,
  nowIso,
  getLocalDate,
} = require('./coinService');
const { mutateWalletWithApi } = require('./coinWalletService');
const { BankReason, bankInterestReason, fixedDepositCreatedReason } = require('./transactionReasons');
const logger = require('../../utils/logger');

const MAX_COIN_AMOUNT = 9_000_000_000;
const INTEREST_RATE = 0.0003;
const INTEREST_TIME_TW = '23:00';
const MIN_FIXED_DEPOSIT = 1000;
const DEMAND_RATE_MAX = 0.01;
const FIXED_RATE_MAX = 0.3;
const FIXED_TERMS = Object.freeze([7, 14, 30, 90]);
// Members read these replies directly (replyCoinError shows a CoinServiceError's message), so they are
// fixed Chinese sentences. A deposit that belongs to someone else is "not found" too.
const COIN_DISABLED_MESSAGE = '這個伺服器的吉幣系統目前停用。';
const FIXED_DEPOSIT_NOT_FOUND_MESSAGE = '找不到這筆定存，請用 /bank fixed-list 確認定存 ID。';
const DEFAULT_RATES = Object.freeze({
  demand: INTEREST_RATE,
  fixed_7: 0.0035,
  fixed_14: 0.008,
  fixed_30: 0.02,
  fixed_90: 0.07,
});

function getInterestDate(date = new Date()) {
  return getLocalDate(date);
}

// Interest is settled at 23:00 Taipei time, so the hour is read there whatever the coin time zone is.
// hourCycle h23 (not hour12: false) because some ICU builds print midnight as 24:00 for hour12: false.
function getTaipeiHour(date = new Date()) {
  const twTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  }).format(date);
  const [hour] = twTime.split(':').map(Number);
  return hour;
}

// Interest for a date is paid from 23:00 of that date, to an account that holds money then. A deposit into
// an empty account therefore counts from the settlement it has not missed: today once 23:00 has passed,
// yesterday before that. The days the account sat empty are never owed.
function getEmptyAccountInterestDate(date = new Date()) {
  const today = getInterestDate(date);
  return getTaipeiHour(date) >= 23 ? today : addDays(today, -1);
}

function addDaysIso(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeAmount(amount, label = '金額') {
  const value = Number(amount);

  if (!Number.isSafeInteger(value) || value <= 0 || value > MAX_COIN_AMOUNT) {
    throw new CoinServiceError('INVALID_AMOUNT', `${label}必須是 1 到 ${MAX_COIN_AMOUNT.toLocaleString('zh-TW')} 的整數。`);
  }

  return value;
}

function normalizeTerm(termDays) {
  const value = Number(termDays);

  if (!FIXED_TERMS.includes(value)) {
    throw new CoinServiceError('INVALID_FIXED_TERM', '定存期間只能選 7、14、30 或 90 天。');
  }

  return value;
}

function normalizeRatePercent(ratePercent, maxPercent, label) {
  const value = Number(ratePercent);

  if (!Number.isFinite(value) || value < 0) {
    throw new CoinServiceError('INVALID_RATE', `${label}利率不能是負數。`);
  }

  if (value > maxPercent) {
    throw new CoinServiceError('RATE_TOO_HIGH', `${label}利率不能超過 ${maxPercent}%。`);
  }

  return value / 100;
}

function rateTypeForKey(rateKey) {
  return rateKey === 'demand' ? 'demand' : 'fixed';
}

function termForKey(rateKey) {
  const match = /^fixed_(\d+)$/.exec(rateKey);
  return match ? Number(match[1]) : null;
}

function ensureBankRates(api) {
  const timestamp = nowIso();

  for (const [rateKey, rate] of Object.entries(DEFAULT_RATES)) {
    api.run(
      `INSERT INTO coin_bank_rates_global (rate_key, rate, updated_by, reason, updated_at)
       VALUES (?, ?, 'system', ?, ?)
       ON CONFLICT(rate_key) DO NOTHING`,
      [rateKey, rate, BankReason.DEFAULT_RATE, timestamp]
    );
  }

  reconcileExpiredRateEvents(api);
}

function reconcileExpiredRateEvents(api) {
  const timestamp = nowIso();
  const expiredRows = api.all(
    `SELECT *
     FROM coin_bank_rates_global
     WHERE is_event = 1
       AND event_ends_at IS NOT NULL
       AND event_ends_at <= ?`,
    [timestamp]
  );

  for (const row of expiredRows) {
    const restoredRate = Number(row.previous_rate ?? DEFAULT_RATES[row.rate_key] ?? row.rate);

    api.run(
      `UPDATE coin_bank_rates_global
       SET rate = ?, previous_rate = NULL, is_event = 0, event_ends_at = NULL,
           updated_by = 'system', reason = ?, updated_at = ?
       WHERE rate_key = ?`,
      [restoredRate, BankReason.RATE_EVENT_EXPIRED, timestamp, row.rate_key]
    );
    api.run(
      `INSERT INTO coin_rate_history_global
        (operator_id, rate_key, old_rate, new_rate, reason, is_event, event_ends_at, source_guild_id, created_at)
       VALUES ('system', ?, ?, ?, ?, 0, NULL, NULL, ?)`,
      [
        row.rate_key,
        Number(row.rate),
        restoredRate,
        BankReason.RATE_EVENT_RESTORED,
        timestamp,
      ]
    );
  }
}

function mapRates(rows) {
  const rateMap = Object.fromEntries(rows.map((row) => [row.rate_key, row]));

  return {
    demandRate: Number(rateMap.demand?.rate ?? DEFAULT_RATES.demand),
    fixedRates: Object.fromEntries(
      FIXED_TERMS.map((term) => [term, Number(rateMap[`fixed_${term}`]?.rate ?? DEFAULT_RATES[`fixed_${term}`])])
    ),
    activeEvents: rows
      .filter((row) => Number(row.is_event) === 1)
      .map((row) => ({
        rateKey: row.rate_key,
        rate: Number(row.rate),
        previousRate: row.previous_rate === null || row.previous_rate === undefined ? null : Number(row.previous_rate),
        eventEndsAt: row.event_ends_at,
        reason: row.reason || '',
      })),
  };
}

function mapFixedDeposit(row) {
  const now = nowIso();
  const storedStatus = row.status;
  const displayStatus = storedStatus === 'active' && row.maturity_at <= now ? 'matured' : storedStatus;

  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    principal: Number(row.principal),
    termDays: Number(row.term_days),
    rate: Number(row.rate),
    expectedInterest: Number(row.expected_interest),
    source: row.source || 'wallet',
    status: storedStatus,
    displayStatus,
    createdAt: row.created_at,
    maturityAt: row.maturity_at,
    claimedAt: row.claimed_at || null,
    cancelledAt: row.cancelled_at || null,
    claimableAmount: Number(row.principal) + Number(row.expected_interest),
  };
}

function mapRateHistory(row) {
  return {
    id: Number(row.id),
    guildId: row.source_guild_id || row.guild_id || null,
    operatorId: row.operator_id,
    rateKey: row.rate_key,
    rateType: rateTypeForKey(row.rate_key),
    termDays: termForKey(row.rate_key),
    oldRate: Number(row.old_rate),
    newRate: Number(row.new_rate),
    reason: row.reason || '',
    isEvent: Boolean(row.is_event),
    eventEndsAt: row.event_ends_at || null,
    createdAt: row.created_at,
  };
}

async function getBankRates(guildId) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    ensureBankRates(api);

    return mapRates(api.all('SELECT * FROM coin_bank_rates_global ORDER BY rate_key ASC'));
  });
}

async function setDemandRate(guildId, ratePercent, { operatorId, reason = '', durationDays = null } = {}) {
  return setRate(guildId, 'demand', ratePercent, {
    operatorId,
    reason,
    durationDays,
    maxPercent: 1,
    label: '活存',
  });
}

async function setFixedRate(guildId, termDays, ratePercent, { operatorId, reason = '', durationDays = null } = {}) {
  const term = normalizeTerm(termDays);

  return setRate(guildId, `fixed_${term}`, ratePercent, {
    operatorId,
    reason,
    durationDays,
    maxPercent: 30,
    label: `${term} 天定存`,
  });
}

async function setRate(guildId, rateKey, ratePercent, { operatorId, reason, durationDays, maxPercent, label }) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    ensureBankRates(api);

    const newRate = normalizeRatePercent(ratePercent, maxPercent, label);
    const row = api.get('SELECT * FROM coin_bank_rates_global WHERE rate_key = ?', [rateKey]);
    const oldRate = Number(row.rate);
    const timestamp = nowIso();
    const eventDays = durationDays === null || durationDays === undefined ? null : Number(durationDays);

    if (eventDays !== null && (!Number.isSafeInteger(eventDays) || eventDays <= 0 || eventDays > 365)) {
      throw new CoinServiceError('INVALID_EVENT_DURATION', '活動天數必須介於 1 到 365 天。');
    }

    const isEvent = eventDays !== null;
    const eventEndsAt = isEvent ? addDaysIso(new Date(timestamp), eventDays) : null;
    const previousRate = isEvent ? oldRate : null;

    api.run(
      `UPDATE coin_bank_rates_global
       SET rate = ?, previous_rate = ?, is_event = ?, event_ends_at = ?,
           updated_by = ?, reason = ?, updated_at = ?
       WHERE rate_key = ?`,
      [newRate, previousRate, isEvent ? 1 : 0, eventEndsAt, operatorId || 'unknown', reason || '', timestamp, rateKey]
    );
    api.run(
      `INSERT INTO coin_rate_history_global
        (operator_id, rate_key, old_rate, new_rate, reason, is_event, event_ends_at, source_guild_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        operatorId || 'unknown',
        rateKey,
        oldRate,
        newRate,
        reason || '',
        isEvent ? 1 : 0,
        eventEndsAt,
        guildId,
        timestamp,
      ]
    );

    return { rateKey, oldRate, newRate, isEvent, eventEndsAt };
  });
}

async function getRateHistory(guildId, { limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const count = Math.min(Math.max(Number(limit) || 10, 1), 25);
    const globalRows = api.all(`SELECT * FROM coin_rate_history_global
      ORDER BY created_at DESC, id DESC LIMIT ?`, [count]);
    const legacyRows = api.all(`SELECT * FROM coin_rate_history
      WHERE guild_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`, [guildId, count]);
    return [...globalRows, ...legacyRows]
      .sort((left, right) => right.created_at.localeCompare(left.created_at) || Number(right.id) - Number(left.id))
      .slice(0, count)
      .map(mapRateHistory);
  });
}

async function deposit(guildId, userId, amount) {
  return withCoinTransaction(async (api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', COIN_DISABLED_MESSAGE);
    }

    const val = normalizeAmount(amount, '存入金額');
    const player = ensurePlayer(api, guildId, userId);
    if (player.balance < val) {
      throw new CoinServiceError('INSUFFICIENT_FUNDS', '錢包吉幣不足，無法存入活存。', {
        balance: player.balance,
        required: val,
      });
    }

    const timestamp = nowIso();
    const newBalance = player.balance - val;
    const newBankBalance = player.bankBalance + val;
    // An empty account earns nothing, and its interest date stands still while it is empty. Money put into it
    // moves that date up first, so the days it sat empty are not paid afterwards, one day per run. An account
    // that still holds money keeps its date: the days the bot was down are still owed to it.
    const emptyAccountDate = getEmptyAccountInterestDate(new Date(timestamp));
    const keepsDate = player.bankBalance > 0
      || (player.lastInterestDate && player.lastInterestDate > emptyAccountDate);
    const lastInterestDate = keepsDate ? player.lastInterestDate : emptyAccountDate;

    api.run(
      'UPDATE coin_bank_accounts_global SET balance = ?, last_interest_date = ?, updated_at = ? WHERE user_id = ?',
      [newBankBalance, lastInterestDate, timestamp, userId]
    );
    mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.BANK_DEPOSIT,
      balanceDelta: -val,
      operatorId: null,
      reason: BankReason.DEPOSIT,
      metadata: { bankBalanceBefore: player.bankBalance, bankBalanceAfter: newBankBalance },
      createdAt: timestamp,
    });

    return {
      walletBefore: player.balance,
      walletAfter: newBalance,
      bankBefore: player.bankBalance,
      bankAfter: newBankBalance,
    };
  });
}

async function withdraw(guildId, userId, amount) {
  return withCoinTransaction(async (api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', COIN_DISABLED_MESSAGE);
    }

    const val = normalizeAmount(amount, '領出金額');
    const player = ensurePlayer(api, guildId, userId);
    if (player.bankBalance < val) {
      throw new CoinServiceError('INSUFFICIENT_BANK_FUNDS', '活存餘額不足，無法領出。', {
        bankBalance: player.bankBalance,
        required: val,
      });
    }

    const timestamp = nowIso();
    const newBalance = player.balance + val;
    const newBankBalance = player.bankBalance - val;

    api.run(
      'UPDATE coin_bank_accounts_global SET balance = ?, updated_at = ? WHERE user_id = ?',
      [newBankBalance, timestamp, userId]
    );
    mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.BANK_WITHDRAW,
      balanceDelta: val,
      operatorId: null,
      reason: BankReason.WITHDRAW,
      metadata: { bankBalanceBefore: player.bankBalance, bankBalanceAfter: newBankBalance },
      createdAt: timestamp,
    });

    return {
      walletBefore: player.balance,
      walletAfter: newBalance,
      bankBefore: player.bankBalance,
      bankAfter: newBankBalance,
    };
  });
}

async function createFixedDeposit(guildId, userId, { amount, termDays, source = 'wallet' }) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', COIN_DISABLED_MESSAGE);
    }
    ensureBankRates(api);

    const principal = normalizeAmount(amount, '定存金額');
    if (principal < MIN_FIXED_DEPOSIT) {
      throw new CoinServiceError('FIXED_DEPOSIT_TOO_SMALL', `定存金額至少要 ${MIN_FIXED_DEPOSIT.toLocaleString('zh-TW')} 吉幣。`);
    }

    const term = normalizeTerm(termDays);
    const normalizedSource = source === 'bank' ? 'bank' : 'wallet';
    const player = ensurePlayer(api, guildId, userId);

    if (normalizedSource === 'wallet' && player.balance < principal) {
      throw new CoinServiceError('INSUFFICIENT_FUNDS', '錢包吉幣不足，無法建立定存。', {
        balance: player.balance,
        required: principal,
      });
    }
    if (normalizedSource === 'bank' && player.bankBalance < principal) {
      throw new CoinServiceError('INSUFFICIENT_BANK_FUNDS', '活存餘額不足，無法建立定存。', {
        bankBalance: player.bankBalance,
        required: principal,
      });
    }

    const rates = mapRates(api.all('SELECT * FROM coin_bank_rates_global'));
    const rate = rates.fixedRates[term];
    const expectedInterest = Math.floor(principal * rate);
    const timestamp = nowIso();
    const maturityAt = addDaysIso(new Date(timestamp), term);
    const walletAfter = normalizedSource === 'wallet' ? player.balance - principal : player.balance;
    const bankAfter = normalizedSource === 'bank' ? player.bankBalance - principal : player.bankBalance;

    api.run(
      'UPDATE coin_bank_accounts_global SET balance = ?, updated_at = ? WHERE user_id = ?',
      [bankAfter, timestamp, userId]
    );
    api.run(
      `INSERT INTO coin_fixed_deposits
        (guild_id, user_id, principal, term_days, rate, expected_interest, source, status, created_at, maturity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      [guildId, userId, principal, term, rate, expectedInterest, normalizedSource, timestamp, maturityAt]
    );

    const id = Number(api.get('SELECT last_insert_rowid() AS id').id);
    mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.FIXED_DEPOSIT_CREATE,
      balanceDelta: normalizedSource === 'wallet' ? -principal : 0,
      operatorId: null,
      reason: fixedDepositCreatedReason(term),
      metadata: { fixedDepositId: id, principal, termDays: term, rate, source: normalizedSource, bankAfter },
      createdAt: timestamp,
    });

    return mapFixedDeposit(api.get('SELECT * FROM coin_fixed_deposits WHERE id = ?', [id]));
  });
}

async function listFixedDeposits(guildId, { userId = null, includeClosed = true, limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const params = [];
    let where = '';

    if (userId) {
      where = 'WHERE user_id = ?';
      params.push(userId);
    } else {
      where = 'WHERE guild_id = ?';
      params.push(guildId);
    }
    if (!includeClosed) {
      where += " AND status IN ('active', 'matured')";
    }

    params.push(Math.min(Math.max(Number(limit) || 10, 1), 25));

    return api
      .all(
        `SELECT *
         FROM coin_fixed_deposits
         ${where}
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        params
      )
      .map(mapFixedDeposit);
  });
}

async function claimFixedDeposit(guildId, userId, fixedDepositId) {
  return withCoinTransaction((api) => {
    const depositRow = api.get(
      `SELECT *
       FROM coin_fixed_deposits
       WHERE id = ? AND user_id = ?`,
      [fixedDepositId, userId]
    );

    if (!depositRow) {
      throw new CoinServiceError('FIXED_DEPOSIT_NOT_FOUND', FIXED_DEPOSIT_NOT_FOUND_MESSAGE);
    }

    const depositInfo = mapFixedDeposit(depositRow);
    if (depositInfo.status === 'claimed') {
      throw new CoinServiceError('FIXED_DEPOSIT_ALREADY_CLAIMED', '這筆定存已經領取過了。');
    }
    if (depositInfo.status === 'cancelled') {
      throw new CoinServiceError('FIXED_DEPOSIT_CANCELLED', '這筆定存已經解約了。');
    }
    if (depositInfo.maturityAt > nowIso()) {
      throw new CoinServiceError('FIXED_DEPOSIT_NOT_MATURED', '這筆定存尚未到期；如要提前拿回，請改用 /bank fixed-cancel 解約。');
    }

    const timestamp = nowIso();
    const claimAmount = depositInfo.principal + depositInfo.expectedInterest;

    api.run("UPDATE coin_fixed_deposits SET status = 'claimed', claimed_at = ? WHERE id = ?", [timestamp, depositInfo.id]);
    const principalReturn = mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.FIXED_DEPOSIT_CLAIM,
      balanceDelta: depositInfo.principal,
      totalEarnedDelta: 0,
      operatorId: null,
      reason: BankReason.FIXED_PRINCIPAL_RETURNED,
      metadata: { fixedDepositId: depositInfo.id, principal: depositInfo.principal },
      createdAt: timestamp,
    });
    const interestPayment = depositInfo.expectedInterest > 0 ? mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.FIXED_DEPOSIT_INTEREST,
      balanceDelta: depositInfo.expectedInterest,
      totalEarnedDelta: depositInfo.expectedInterest,
      operatorId: null,
      reason: BankReason.FIXED_INTEREST,
      metadata: { fixedDepositId: depositInfo.id, interest: depositInfo.expectedInterest },
      createdAt: timestamp,
    }) : null;

    return { ...depositInfo, status: 'claimed', claimedAt: timestamp,
      grossAmount: claimAmount, paidAmount: depositInfo.principal + (interestPayment?.netAmount || 0),
      debtOffset: interestPayment?.debtOffset || 0,
      walletAfter: (interestPayment || principalReturn).after.balance };
  });
}

async function cancelFixedDeposit(guildId, userId, fixedDepositId) {
  return withCoinTransaction((api) => {
    const depositRow = api.get(
      `SELECT *
       FROM coin_fixed_deposits
       WHERE id = ? AND user_id = ?`,
      [fixedDepositId, userId]
    );

    if (!depositRow) {
      throw new CoinServiceError('FIXED_DEPOSIT_NOT_FOUND', FIXED_DEPOSIT_NOT_FOUND_MESSAGE);
    }

    const depositInfo = mapFixedDeposit(depositRow);
    if (depositInfo.status === 'claimed') {
      throw new CoinServiceError('FIXED_DEPOSIT_ALREADY_CLAIMED', '這筆定存已經領取過了。');
    }
    if (depositInfo.status === 'cancelled') {
      throw new CoinServiceError('FIXED_DEPOSIT_CANCELLED', '這筆定存已經解約了。');
    }
    if (depositInfo.maturityAt <= nowIso()) {
      throw new CoinServiceError('FIXED_DEPOSIT_MATURED', '這筆定存已經到期，請改用 /bank fixed-claim 領取。');
    }

    const createdAt = new Date(depositInfo.createdAt).getTime();
    const maturityAt = new Date(depositInfo.maturityAt).getTime();
    const nowMs = Date.now();
    const halfReached = nowMs - createdAt >= (maturityAt - createdAt) / 2;
    const penaltyInterest = halfReached ? Math.floor(depositInfo.expectedInterest * 0.3) : 0;
    const refundAmount = depositInfo.principal + penaltyInterest;
    const timestamp = nowIso();

    api.run("UPDATE coin_fixed_deposits SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [
      timestamp,
      depositInfo.id,
    ]);
    const principalReturn = mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.FIXED_DEPOSIT_CANCEL,
      balanceDelta: depositInfo.principal,
      totalEarnedDelta: 0,
      operatorId: null,
      reason: BankReason.FIXED_CANCEL_PRINCIPAL_RETURNED,
      metadata: { fixedDepositId: depositInfo.id, principal: depositInfo.principal, halfReached },
      createdAt: timestamp,
    });
    const interestPayment = penaltyInterest > 0 ? mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.FIXED_DEPOSIT_INTEREST,
      balanceDelta: penaltyInterest,
      totalEarnedDelta: penaltyInterest,
      operatorId: null,
      reason: BankReason.FIXED_CANCEL_INTEREST,
      metadata: { fixedDepositId: depositInfo.id, interest: penaltyInterest, halfReached },
      createdAt: timestamp,
    }) : null;

    return { ...depositInfo, status: 'cancelled', cancelledAt: timestamp,
      grossAmount: refundAmount, paidAmount: depositInfo.principal + (interestPayment?.netAmount || 0),
      interestPaid: penaltyInterest, debtOffset: interestPayment?.debtOffset || 0,
      walletAfter: (interestPayment || principalReturn).after.balance };
  });
}

// The wallet, bank and fixed deposit figures of one user. The fixed deposits are the user's own, whatever guild
// they were made in.
function summarizeBalance(api, userId, player) {
  const fixed = api.get(
    `SELECT
       COALESCE(SUM(principal), 0) AS principal,
       COALESCE(SUM(expected_interest), 0) AS interest,
       COALESCE(SUM(CASE WHEN maturity_at <= ? THEN principal + expected_interest ELSE 0 END), 0) AS claimable
     FROM coin_fixed_deposits
     WHERE user_id = ? AND status IN ('active', 'matured')`,
    [nowIso(), userId]
  );

  const fixedPrincipal = Number(fixed.principal || 0);
  const fixedInterest = Number(fixed.interest || 0);
  const claimable = Number(fixed.claimable || 0);

  return {
    userId,
    walletBalance: player.balance,
    bankBalance: player.bankBalance,
    interestRemainder: player.bankInterestAccrued,
    fixedPrincipal,
    fixedExpectedInterest: fixedInterest,
    fixedClaimable: claimable,
    totalAssets: player.balance + player.bankBalance + fixedPrincipal + fixedInterest,
    player,
  };
}

async function getBalanceSummary(guildId, userId) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    return summarizeBalance(api, userId, ensurePlayer(api, guildId, userId));
  });
}

// Read-only counterpart of getBalanceSummary, for looking at somebody else. It files nobody under the guild
// (getBalanceSummary does, through ensurePlayer, and the user would then show on the guild's boards) and writes
// nothing. A user the economy has not seen reads as zeros.
async function readBalanceSummary(guildId, userId) {
  return withCoinDatabase((api) => summarizeBalance(api, userId, readPlayer(api, guildId, userId)));
}

async function getAllBalanceSummaries(guildId, { limit = 25 } = {}) {
  return withCoinDatabase((api) =>
    api.all(
      `SELECT
         p.guild_id,
         p.user_id,
         w.balance,
         COALESCE(ba.balance, 0) AS bank_balance,
         COALESCE(ba.interest_accrued, 0) AS bank_interest_accrued,
         COALESCE(SUM(CASE WHEN f.status IN ('active', 'matured') THEN f.principal ELSE 0 END), 0) AS fixed_principal,
         COALESCE(SUM(CASE WHEN f.status IN ('active', 'matured') THEN f.expected_interest ELSE 0 END), 0) AS fixed_interest,
         COALESCE(SUM(CASE WHEN f.status IN ('active', 'matured') AND f.maturity_at <= ? THEN f.principal + f.expected_interest ELSE 0 END), 0) AS fixed_claimable
       FROM coin_guild_players p
       JOIN coin_wallets w ON w.user_id = p.user_id
       LEFT JOIN coin_bank_accounts_global ba ON ba.user_id = p.user_id
       LEFT JOIN coin_fixed_deposits f ON f.user_id = p.user_id
       WHERE p.guild_id = ?
       GROUP BY p.guild_id, p.user_id
       ORDER BY (w.balance + COALESCE(ba.balance, 0) + fixed_principal + fixed_interest) DESC
       LIMIT ?`,
      [nowIso(), guildId, Math.min(Math.max(Number(limit) || 25, 1), 25)]
    ).map((row) => ({
      userId: row.user_id,
      walletBalance: Number(row.balance || 0),
      bankBalance: Number(row.bank_balance || 0),
      interestRemainder: Number(row.bank_interest_accrued || 0),
      fixedPrincipal: Number(row.fixed_principal || 0),
      fixedExpectedInterest: Number(row.fixed_interest || 0),
      fixedClaimable: Number(row.fixed_claimable || 0),
      totalAssets:
        Number(row.balance || 0) +
        Number(row.bank_balance || 0) +
        Number(row.fixed_principal || 0) +
        Number(row.fixed_interest || 0),
    }))
  );
}

async function processBankInterest() {
  const now = new Date();
  const todayStr = getInterestDate(now);
  const hour = getTaipeiHour(now);

  const eligiblePlayers = await withCoinDatabase((api) =>
    api.all(
      `SELECT user_id, balance AS bank_balance, interest_accrued AS bank_interest_accrued,
              last_interest_date,
              COALESCE((SELECT MIN(guild_id) FROM coin_guild_players gp
                        WHERE gp.user_id = ba.user_id), '__global__') AS source_guild_id
       FROM coin_bank_accounts_global ba
       WHERE balance > 0
         AND (last_interest_date IS NULL OR last_interest_date < ?)`,
      [todayStr]
    )
  );

  let processedCount = 0;

  for (const playerRow of eligiblePlayers) {
    let payDate = playerRow.last_interest_date
      ? require('./coinService').addDays(playerRow.last_interest_date, 1)
      : hour >= 23
        ? todayStr
        : getInterestDate(new Date(now.getTime() - 24 * 60 * 60 * 1000));

    if (payDate === todayStr && hour < 23) {
      continue;
    }
    if (payDate > todayStr) {
      continue;
    }

    try {
      await withCoinTransaction(async (api) => {
        ensureBankRates(api);
        const p = ensurePlayer(api, playerRow.source_guild_id, playerRow.user_id);
        if (!p || p.bankBalance <= 0 || (p.lastInterestDate && p.lastInterestDate >= payDate)) {
          return;
        }

        const rates = mapRates(api.all('SELECT * FROM coin_bank_rates_global'));
        const interest = p.bankBalance * rates.demandRate;
        const totalAccrued = (p.bankInterestAccrued || 0) + interest;
        const creditAmount = Math.floor(totalAccrued);
        const remainingAccrued = totalAccrued - creditAmount;
        const timestamp = nowIso();

        if (creditAmount > 0) {
          api.run(
            `UPDATE coin_bank_accounts_global
             SET interest_accrued = ?, last_interest_date = ?, updated_at = ?
             WHERE user_id = ?`,
            [remainingAccrued, payDate, timestamp, p.userId]
          );
          mutateWalletWithApi(api, {
            guildId: p.guildId,
            userId: p.userId,
            type: TransactionType.BANK_INTEREST,
            balanceDelta: creditAmount,
            totalEarnedDelta: creditAmount,
            operatorId: null,
            reason: bankInterestReason(payDate),
            metadata: { bankBalance: p.bankBalance, interestRate: rates.demandRate, accrued: totalAccrued },
            createdAt: timestamp,
          });
        } else {
          api.run(
            `UPDATE coin_bank_accounts_global
             SET interest_accrued = ?, last_interest_date = ?, updated_at = ?
             WHERE user_id = ?`,
            [remainingAccrued, payDate, timestamp, p.userId]
          );
        }
        processedCount++;
      });
    } catch (error) {
      logger.error(`Bank interest failed (User: ${playerRow.user_id})`, error);
    }
  }

  return { processed: processedCount };
}

module.exports = {
  DEFAULT_RATES,
  DEMAND_RATE_MAX,
  FIXED_RATE_MAX,
  FIXED_TERMS,
  INTEREST_RATE,
  INTEREST_TIME_TW,
  MIN_FIXED_DEPOSIT,
  cancelFixedDeposit,
  claimFixedDeposit,
  createFixedDeposit,
  deposit,
  getAllBalanceSummaries,
  getBalanceSummary,
  getBankRates,
  getInterestDate,
  getRateHistory,
  listFixedDeposits,
  processBankInterest,
  readBalanceSummary,
  setDemandRate,
  setFixedRate,
  withdraw,
};
