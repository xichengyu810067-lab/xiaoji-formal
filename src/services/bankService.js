const { withCoinTransaction, withCoinDatabase } = require('./coinDatabase');
const {
  CoinServiceError,
  TransactionType,
  ensureGuildSettings,
  ensurePlayer,
  nowIso,
  getLocalDate,
} = require('./coinService');
const { mutateWalletWithApi } = require('./coinWalletService');
const logger = require('../utils/logger');

const INTEREST_RATE = 0.0003;
const INTEREST_TIME_TW = '23:00';
const MIN_FIXED_DEPOSIT = 1000;
const DEMAND_RATE_MAX = 0.01;
const FIXED_RATE_MAX = 0.3;
const FIXED_TERMS = Object.freeze([7, 14, 30, 90]);
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

function addDaysIso(date, days) {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000).toISOString();
}

function normalizeAmount(amount, name = 'amount') {
  const value = Number(amount);

  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new CoinServiceError('INVALID_AMOUNT', `${name} must be a positive integer.`);
  }

  return value;
}

function normalizeTerm(termDays) {
  const value = Number(termDays);

  if (!FIXED_TERMS.includes(value)) {
    throw new CoinServiceError('INVALID_FIXED_TERM', 'Fixed deposit term must be 7, 14, 30, or 90 days.');
  }

  return value;
}

function normalizeRatePercent(ratePercent, maxPercent, label) {
  const value = Number(ratePercent);

  if (!Number.isFinite(value) || value < 0) {
    throw new CoinServiceError('INVALID_RATE', `${label} rate cannot be negative.`);
  }

  if (value > maxPercent) {
    throw new CoinServiceError('RATE_TOO_HIGH', `${label} rate cannot exceed ${maxPercent}%.`);
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

function ensureBankRates(api, guildId) {
  const timestamp = nowIso();

  for (const [rateKey, rate] of Object.entries(DEFAULT_RATES)) {
    api.run(
      `INSERT INTO coin_bank_rates (guild_id, rate_key, rate, updated_by, reason, updated_at)
       VALUES (?, ?, ?, 'system', 'default rate', ?)
       ON CONFLICT(guild_id, rate_key) DO NOTHING`,
      [guildId, rateKey, rate, timestamp]
    );
  }

  reconcileExpiredRateEvents(api, guildId);
}

function reconcileExpiredRateEvents(api, guildId) {
  const timestamp = nowIso();
  const expiredRows = api.all(
    `SELECT *
     FROM coin_bank_rates
     WHERE guild_id = ?
       AND is_event = 1
       AND event_ends_at IS NOT NULL
       AND event_ends_at <= ?`,
    [guildId, timestamp]
  );

  for (const row of expiredRows) {
    const restoredRate = Number(row.previous_rate ?? DEFAULT_RATES[row.rate_key] ?? row.rate);

    api.run(
      `UPDATE coin_bank_rates
       SET rate = ?, previous_rate = NULL, is_event = 0, event_ends_at = NULL,
           updated_by = 'system', reason = 'event expired', updated_at = ?
       WHERE guild_id = ? AND rate_key = ?`,
      [restoredRate, timestamp, guildId, row.rate_key]
    );
    api.run(
      `INSERT INTO coin_rate_history
        (guild_id, operator_id, rate_key, rate_type, term_days, old_rate, new_rate, reason, is_event, event_ends_at, created_at)
       VALUES (?, 'system', ?, ?, ?, ?, ?, 'event expired auto restore', 0, NULL, ?)`,
      [
        guildId,
        row.rate_key,
        rateTypeForKey(row.rate_key),
        termForKey(row.rate_key),
        Number(row.rate),
        restoredRate,
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
    guildId: row.guild_id,
    operatorId: row.operator_id,
    rateKey: row.rate_key,
    rateType: row.rate_type,
    termDays: row.term_days === null || row.term_days === undefined ? null : Number(row.term_days),
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
    ensureBankRates(api, guildId);

    return mapRates(api.all('SELECT * FROM coin_bank_rates WHERE guild_id = ? ORDER BY rate_key ASC', [guildId]));
  });
}

async function setDemandRate(guildId, ratePercent, { operatorId, reason = '', durationDays = null } = {}) {
  return setRate(guildId, 'demand', ratePercent, {
    operatorId,
    reason,
    durationDays,
    maxPercent: 1,
    label: 'Demand',
  });
}

async function setFixedRate(guildId, termDays, ratePercent, { operatorId, reason = '', durationDays = null } = {}) {
  const term = normalizeTerm(termDays);

  return setRate(guildId, `fixed_${term}`, ratePercent, {
    operatorId,
    reason,
    durationDays,
    maxPercent: 30,
    label: `${term}-day fixed`,
  });
}

async function setRate(guildId, rateKey, ratePercent, { operatorId, reason, durationDays, maxPercent, label }) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    ensureBankRates(api, guildId);

    const newRate = normalizeRatePercent(ratePercent, maxPercent, label);
    const row = api.get('SELECT * FROM coin_bank_rates WHERE guild_id = ? AND rate_key = ?', [guildId, rateKey]);
    const oldRate = Number(row.rate);
    const timestamp = nowIso();
    const eventDays = durationDays === null || durationDays === undefined ? null : Number(durationDays);

    if (eventDays !== null && (!Number.isSafeInteger(eventDays) || eventDays <= 0 || eventDays > 365)) {
      throw new CoinServiceError('INVALID_EVENT_DURATION', 'Event duration must be 1 to 365 days.');
    }

    const isEvent = eventDays !== null;
    const eventEndsAt = isEvent ? addDaysIso(new Date(timestamp), eventDays) : null;
    const previousRate = isEvent ? oldRate : null;

    api.run(
      `UPDATE coin_bank_rates
       SET rate = ?, previous_rate = ?, is_event = ?, event_ends_at = ?,
           updated_by = ?, reason = ?, updated_at = ?
       WHERE guild_id = ? AND rate_key = ?`,
      [newRate, previousRate, isEvent ? 1 : 0, eventEndsAt, operatorId || 'unknown', reason || '', timestamp, guildId, rateKey]
    );
    api.run(
      `INSERT INTO coin_rate_history
        (guild_id, operator_id, rate_key, rate_type, term_days, old_rate, new_rate, reason, is_event, event_ends_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guildId,
        operatorId || 'unknown',
        rateKey,
        rateTypeForKey(rateKey),
        termForKey(rateKey),
        oldRate,
        newRate,
        reason || '',
        isEvent ? 1 : 0,
        eventEndsAt,
        timestamp,
      ]
    );

    return { rateKey, oldRate, newRate, isEvent, eventEndsAt };
  });
}

async function getRateHistory(guildId, { limit = 10 } = {}) {
  return withCoinDatabase((api) =>
    api
      .all(
        `SELECT *
         FROM coin_rate_history
         WHERE guild_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [guildId, Math.min(Math.max(Number(limit) || 10, 1), 25)]
      )
      .map(mapRateHistory)
  );
}

async function deposit(guildId, userId, amount) {
  return withCoinTransaction(async (api) => {
    const settings = ensureGuildSettings(api, guildId);
    if (!settings.enabled) {
      throw new CoinServiceError('COIN_DISABLED', 'Coin system is disabled.');
    }

    const val = normalizeAmount(amount, 'Deposit amount');
    const player = ensurePlayer(api, guildId, userId);
    if (player.balance < val) {
      throw new CoinServiceError('INSUFFICIENT_FUNDS', 'Wallet balance is not enough.', {
        balance: player.balance,
        required: val,
      });
    }

    const timestamp = nowIso();
    const newBalance = player.balance - val;
    const newBankBalance = player.bankBalance + val;

    api.run(
      'UPDATE coin_guild_players SET bank_balance = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
      [newBankBalance, timestamp, guildId, userId]
    );
    mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.BANK_DEPOSIT,
      balanceDelta: -val,
      operatorId: null,
      reason: 'bank deposit',
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
      throw new CoinServiceError('COIN_DISABLED', 'Coin system is disabled.');
    }

    const val = normalizeAmount(amount, 'Withdraw amount');
    const player = ensurePlayer(api, guildId, userId);
    if (player.bankBalance < val) {
      throw new CoinServiceError('INSUFFICIENT_BANK_FUNDS', 'Bank balance is not enough.', {
        bankBalance: player.bankBalance,
        required: val,
      });
    }

    const timestamp = nowIso();
    const newBalance = player.balance + val;
    const newBankBalance = player.bankBalance - val;

    api.run(
      'UPDATE coin_guild_players SET bank_balance = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
      [newBankBalance, timestamp, guildId, userId]
    );
    mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.BANK_WITHDRAW,
      balanceDelta: val,
      operatorId: null,
      reason: 'bank withdraw',
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
      throw new CoinServiceError('COIN_DISABLED', 'Coin system is disabled.');
    }
    ensureBankRates(api, guildId);

    const principal = normalizeAmount(amount, 'Fixed deposit amount');
    if (principal < MIN_FIXED_DEPOSIT) {
      throw new CoinServiceError('FIXED_DEPOSIT_TOO_SMALL', `Fixed deposit amount must be at least ${MIN_FIXED_DEPOSIT}.`);
    }

    const term = normalizeTerm(termDays);
    const normalizedSource = source === 'bank' ? 'bank' : 'wallet';
    const player = ensurePlayer(api, guildId, userId);

    if (normalizedSource === 'wallet' && player.balance < principal) {
      throw new CoinServiceError('INSUFFICIENT_FUNDS', 'Wallet balance is not enough.', {
        balance: player.balance,
        required: principal,
      });
    }
    if (normalizedSource === 'bank' && player.bankBalance < principal) {
      throw new CoinServiceError('INSUFFICIENT_BANK_FUNDS', 'Bank balance is not enough.', {
        bankBalance: player.bankBalance,
        required: principal,
      });
    }

    const rates = mapRates(api.all('SELECT * FROM coin_bank_rates WHERE guild_id = ?', [guildId]));
    const rate = rates.fixedRates[term];
    const expectedInterest = Math.floor(principal * rate);
    const timestamp = nowIso();
    const maturityAt = addDaysIso(new Date(timestamp), term);
    const walletAfter = normalizedSource === 'wallet' ? player.balance - principal : player.balance;
    const bankAfter = normalizedSource === 'bank' ? player.bankBalance - principal : player.bankBalance;

    api.run(
      'UPDATE coin_guild_players SET bank_balance = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?',
      [bankAfter, timestamp, guildId, userId]
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
      reason: `${term}-day fixed deposit created`,
      metadata: { fixedDepositId: id, principal, termDays: term, rate, source: normalizedSource, bankAfter },
      createdAt: timestamp,
    });

    return mapFixedDeposit(api.get('SELECT * FROM coin_fixed_deposits WHERE id = ?', [id]));
  });
}

async function listFixedDeposits(guildId, { userId = null, includeClosed = true, limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const params = [guildId];
    let where = 'WHERE guild_id = ?';

    if (userId) {
      where += ' AND user_id = ?';
      params.push(userId);
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
       WHERE id = ? AND guild_id = ? AND user_id = ?`,
      [fixedDepositId, guildId, userId]
    );

    if (!depositRow) {
      throw new CoinServiceError('FIXED_DEPOSIT_NOT_FOUND', 'Fixed deposit was not found.');
    }

    const depositInfo = mapFixedDeposit(depositRow);
    if (depositInfo.status === 'claimed') {
      throw new CoinServiceError('FIXED_DEPOSIT_ALREADY_CLAIMED', 'This fixed deposit was already claimed.');
    }
    if (depositInfo.status === 'cancelled') {
      throw new CoinServiceError('FIXED_DEPOSIT_CANCELLED', 'This fixed deposit was already cancelled.');
    }
    if (depositInfo.maturityAt > nowIso()) {
      throw new CoinServiceError('FIXED_DEPOSIT_NOT_MATURED', 'This fixed deposit has not matured yet.');
    }

    const player = ensurePlayer(api, guildId, userId);
    const timestamp = nowIso();
    const claimAmount = depositInfo.principal + depositInfo.expectedInterest;
    const walletAfter = player.balance + claimAmount;

    api.run("UPDATE coin_fixed_deposits SET status = 'claimed', claimed_at = ? WHERE id = ?", [timestamp, depositInfo.id]);
    mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.FIXED_DEPOSIT_CLAIM,
      balanceDelta: claimAmount,
      totalEarnedDelta: depositInfo.expectedInterest,
      operatorId: null,
      reason: 'fixed deposit claimed',
      metadata: { fixedDepositId: depositInfo.id, principal: depositInfo.principal, interest: depositInfo.expectedInterest },
      createdAt: timestamp,
    });

    return { ...depositInfo, status: 'claimed', claimedAt: timestamp, paidAmount: claimAmount, walletAfter };
  });
}

async function cancelFixedDeposit(guildId, userId, fixedDepositId) {
  return withCoinTransaction((api) => {
    const depositRow = api.get(
      `SELECT *
       FROM coin_fixed_deposits
       WHERE id = ? AND guild_id = ? AND user_id = ?`,
      [fixedDepositId, guildId, userId]
    );

    if (!depositRow) {
      throw new CoinServiceError('FIXED_DEPOSIT_NOT_FOUND', 'Fixed deposit was not found.');
    }

    const depositInfo = mapFixedDeposit(depositRow);
    if (depositInfo.status === 'claimed') {
      throw new CoinServiceError('FIXED_DEPOSIT_ALREADY_CLAIMED', 'This fixed deposit was already claimed.');
    }
    if (depositInfo.status === 'cancelled') {
      throw new CoinServiceError('FIXED_DEPOSIT_CANCELLED', 'This fixed deposit was already cancelled.');
    }
    if (depositInfo.maturityAt <= nowIso()) {
      throw new CoinServiceError('FIXED_DEPOSIT_MATURED', 'This fixed deposit has matured. Please claim it instead.');
    }

    const createdAt = new Date(depositInfo.createdAt).getTime();
    const maturityAt = new Date(depositInfo.maturityAt).getTime();
    const nowMs = Date.now();
    const halfReached = nowMs - createdAt >= (maturityAt - createdAt) / 2;
    const penaltyInterest = halfReached ? Math.floor(depositInfo.expectedInterest * 0.3) : 0;
    const refundAmount = depositInfo.principal + penaltyInterest;
    const player = ensurePlayer(api, guildId, userId);
    const timestamp = nowIso();
    const walletAfter = player.balance + refundAmount;

    api.run("UPDATE coin_fixed_deposits SET status = 'cancelled', cancelled_at = ? WHERE id = ?", [
      timestamp,
      depositInfo.id,
    ]);
    mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.FIXED_DEPOSIT_CANCEL,
      balanceDelta: refundAmount,
      totalEarnedDelta: penaltyInterest,
      operatorId: null,
      reason: 'fixed deposit cancelled',
      metadata: { fixedDepositId: depositInfo.id, principal: depositInfo.principal, interest: penaltyInterest, halfReached },
      createdAt: timestamp,
    });

    return { ...depositInfo, status: 'cancelled', cancelledAt: timestamp, paidAmount: refundAmount, interestPaid: penaltyInterest, walletAfter };
  });
}

async function getBalanceSummary(guildId, userId) {
  return withCoinTransaction((api) => {
    ensureGuildSettings(api, guildId);
    const player = ensurePlayer(api, guildId, userId);
    const fixed = api.get(
      `SELECT
         COALESCE(SUM(principal), 0) AS principal,
         COALESCE(SUM(expected_interest), 0) AS interest,
         COALESCE(SUM(CASE WHEN maturity_at <= ? THEN principal + expected_interest ELSE 0 END), 0) AS claimable
       FROM coin_fixed_deposits
       WHERE guild_id = ? AND user_id = ? AND status IN ('active', 'matured')`,
      [nowIso(), guildId, userId]
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
  });
}

async function getAllBalanceSummaries(guildId, { limit = 25 } = {}) {
  return withCoinDatabase((api) =>
    api.all(
      `SELECT
         p.guild_id,
         p.user_id,
         w.balance,
         p.bank_balance,
         p.bank_interest_accrued,
         COALESCE(SUM(CASE WHEN f.status IN ('active', 'matured') THEN f.principal ELSE 0 END), 0) AS fixed_principal,
         COALESCE(SUM(CASE WHEN f.status IN ('active', 'matured') THEN f.expected_interest ELSE 0 END), 0) AS fixed_interest,
         COALESCE(SUM(CASE WHEN f.status IN ('active', 'matured') AND f.maturity_at <= ? THEN f.principal + f.expected_interest ELSE 0 END), 0) AS fixed_claimable
       FROM coin_guild_players p
       JOIN coin_wallets w ON w.user_id = p.user_id
       LEFT JOIN coin_fixed_deposits f ON f.guild_id = p.guild_id AND f.user_id = p.user_id
       WHERE p.guild_id = ?
       GROUP BY p.guild_id, p.user_id
       ORDER BY (w.balance + p.bank_balance + fixed_principal + fixed_interest) DESC
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
  const twTime = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Taipei',
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
  }).format(now);
  const [hour] = twTime.split(':').map(Number);

  const eligiblePlayers = await withCoinDatabase((api) =>
    api.all(
      `SELECT guild_id, user_id, bank_balance, bank_interest_accrued, last_interest_date
       FROM coin_guild_players
       WHERE bank_balance > 0
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
        ensureBankRates(api, playerRow.guild_id);
        const p = ensurePlayer(api, playerRow.guild_id, playerRow.user_id);
        if (!p || p.bankBalance <= 0 || (p.lastInterestDate && p.lastInterestDate >= payDate)) {
          return;
        }

        const rates = mapRates(api.all('SELECT * FROM coin_bank_rates WHERE guild_id = ?', [playerRow.guild_id]));
        const interest = p.bankBalance * rates.demandRate;
        const totalAccrued = (p.bankInterestAccrued || 0) + interest;
        const creditAmount = Math.floor(totalAccrued);
        const remainingAccrued = totalAccrued - creditAmount;
        const timestamp = nowIso();

        if (creditAmount > 0) {
          api.run(
            `UPDATE coin_guild_players
             SET bank_interest_accrued = ?, last_interest_date = ?, updated_at = ?
             WHERE guild_id = ? AND user_id = ?`,
            [remainingAccrued, payDate, timestamp, p.guildId, p.userId]
          );
          mutateWalletWithApi(api, {
            guildId: p.guildId,
            userId: p.userId,
            type: TransactionType.BANK_INTEREST,
            balanceDelta: creditAmount,
            totalEarnedDelta: creditAmount,
            operatorId: null,
            reason: `bank interest (${payDate})`,
            metadata: { bankBalance: p.bankBalance, interestRate: rates.demandRate, accrued: totalAccrued },
            createdAt: timestamp,
          });
        } else {
          api.run(
            `UPDATE coin_guild_players
             SET bank_interest_accrued = ?, last_interest_date = ?, updated_at = ?
             WHERE guild_id = ? AND user_id = ?`,
            [remainingAccrued, payDate, timestamp, p.guildId, p.userId]
          );
        }
        processedCount++;
      });
    } catch (error) {
      logger.error(`Bank interest failed (Guild: ${playerRow.guild_id}, User: ${playerRow.user_id})`, error);
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
  setDemandRate,
  setFixedRate,
  withdraw,
};
