const { withCoinTransaction } = require('../../services/coinDatabase');
const { CoinServiceError, TransactionType, ensureGuildSettings, ensurePlayer, getLocalDate, addDays } = require('./coinService');
const { mutateWalletWithApi } = require('./coinWalletService');
const { ChipLedgerType, creditChipsWithApi, debitChipsForCasinoWithApi, ensureChipAccount } = require('./chipService');
const { CasinoLedgerType, insertCasinoLedger } = require('./casinoLedger');

const MAX_CASINO_AMOUNT = 9_000_000_000;
const LOAN_INTEREST_RATE = 0.03;
const LOAN_RELIEF_STEP_RATIO = 0.05;
const MIN_LOAN_INTEREST_RATE = LOAN_INTEREST_RATE / 2;
function nowIso(date = new Date()) {
  return date.toISOString();
}

function normalizeAmount(value, label = '金額') {
  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CASINO_AMOUNT) {
    throw new CoinServiceError('INVALID_CASINO_AMOUNT', `${label}必須是 1 到 ${MAX_CASINO_AMOUNT.toLocaleString('zh-TW')} 的整數。`);
  }

  return amount;
}

function calculateReliefRate(reliefCount) {
  const reduction = LOAN_INTEREST_RATE * LOAN_RELIEF_STEP_RATIO * Number(reliefCount || 0);
  return Math.max(MIN_LOAN_INTEREST_RATE, Number((LOAN_INTEREST_RATE - reduction).toFixed(6)));
}

function mapLoan(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    principalAmount: Number(row.principal_amount || 0),
    currentDebtAmount: Number(row.current_debt_amount || 0),
    interestRate: Number(row.interest_rate || LOAN_INTEREST_RATE),
    reliefCount: Number(row.relief_count || 0),
    reliefUpdatedBy: row.relief_updated_by || null,
    reliefUpdatedAt: row.relief_updated_at || null,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastInterestDate: row.last_interest_date,
    repaidAt: row.repaid_at || null,
  };
}

function ensureEconomyEnabled(api, guildId) {
  const settings = ensureGuildSettings(api, guildId);

  if (!settings.enabled) {
    throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  }

  return settings;
}

function getActiveLoanRow(api, guildId, userId) {
  const rows = api.all(
    "SELECT * FROM casino_loans WHERE user_id = ? AND status = 'active' ORDER BY id ASC LIMIT 2",
    [userId]
  );
  if (rows.length > 1) {
    throw new CoinServiceError('LOAN_ACCOUNT_CONFLICT', '跨群舊借款有多筆未結清，須先逐筆對帳。');
  }
  return rows[0] || null;
}

function applyLoanInterestForRow(api, loanRow, date = new Date()) {
  if (!loanRow || loanRow.status !== 'active') {
    return { loan: loanRow ? mapLoan(loanRow) : null, interestAmount: 0, daysApplied: 0 };
  }

  const today = getLocalDate(date);
  let cursor = addDays(loanRow.last_interest_date, 1);

  if (cursor > today) {
    return { loan: mapLoan(loanRow), interestAmount: 0, daysApplied: 0 };
  }

  let debt = Number(loanRow.current_debt_amount || 0);
  const beforeDebt = debt;
  let daysApplied = 0;
  const rate = Number(loanRow.interest_rate || LOAN_INTEREST_RATE);

  while (cursor <= today) {
    debt = Math.ceil(debt * (1 + rate));
    daysApplied += 1;
    cursor = addDays(cursor, 1);
  }

  const timestamp = nowIso(date);
  const interestAmount = debt - beforeDebt;
  api.run(
    'UPDATE casino_loans SET current_debt_amount = ?, last_interest_date = ?, updated_at = ? WHERE id = ?',
    [debt, today, timestamp, loanRow.id]
  );

  if (interestAmount > 0) {
    insertCasinoLedger(api, {
      guildId: loanRow.guild_id,
      userId: loanRow.user_id,
      entryType: CasinoLedgerType.LOAN_INTEREST,
      currency: 'coin',
      amount: interestAmount,
      debtBefore: beforeDebt,
      debtAfter: debt,
      loanId: loanRow.id,
      details: { daysApplied, rate },
      createdAt: timestamp,
    });
  }

  const updatedLoan = api.get('SELECT * FROM casino_loans WHERE id = ?', [loanRow.id]);
  return { loan: mapLoan(updatedLoan), interestAmount, daysApplied };
}

function applyLoanInterest(api, guildId, userId, date = new Date()) {
  return applyLoanInterestForRow(api, getActiveLoanRow(api, guildId, userId), date);
}

function getFixedDepositSummary(api, guildId, userId, date = new Date()) {
  const timestamp = nowIso(date);
  const fixed = api.get(
    `SELECT
       COALESCE(SUM(CASE WHEN status IN ('active', 'matured') THEN principal ELSE 0 END), 0) AS principal,
       COALESCE(SUM(CASE WHEN status IN ('active', 'matured') THEN expected_interest ELSE 0 END), 0) AS interest,
       COALESCE(SUM(CASE WHEN status IN ('active', 'matured') AND maturity_at <= ? THEN principal + expected_interest ELSE 0 END), 0) AS claimable
     FROM coin_fixed_deposits
     WHERE user_id = ?`,
    [timestamp, userId]
  );

  return {
    fixedPrincipal: Number(fixed?.principal || 0),
    fixedExpectedInterest: Number(fixed?.interest || 0),
    fixedClaimable: Number(fixed?.claimable || 0),
  };
}

function borrowCasinoLoan(guildId, userId, { amount, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    const loanAmount = normalizeAmount(amount, '借款金額');
    ensurePlayer(api, guildId, userId);
    const interest = applyLoanInterest(api, guildId, userId, date);
    const activeLoan = interest.loan;
    const debtBefore = activeLoan?.currentDebtAmount || 0;

    if (debtBefore + loanAmount > MAX_CASINO_AMOUNT) {
      throw new CoinServiceError('CASINO_LOAN_LIMIT', `借款後總債務不可超過 ${MAX_CASINO_AMOUNT.toLocaleString('zh-TW')} 吉幣。`);
    }

    const timestamp = nowIso(date);
    const today = getLocalDate(date);
    let loanId;

    if (activeLoan) {
      api.run(
        'UPDATE casino_loans SET principal_amount = principal_amount + ?, current_debt_amount = current_debt_amount + ?, updated_at = ? WHERE id = ?',
        [loanAmount, loanAmount, timestamp, activeLoan.id]
      );
      loanId = activeLoan.id;
    } else {
      api.run(
        `INSERT INTO casino_loans
          (guild_id, user_id, principal_amount, current_debt_amount, interest_rate, status, created_at, updated_at, last_interest_date)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
        [guildId, userId, loanAmount, loanAmount, LOAN_INTEREST_RATE, timestamp, timestamp, today]
      );
      loanId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    }

    const chipCredit = creditChipsWithApi(api, guildId, userId, loanAmount, {
      timestamp,
      entryType: ChipLedgerType.LOAN_BORROW,
      reason: '賭場貸幣借款',
      metadata: { loanId, debtAmount: loanAmount },
    });
    insertCasinoLedger(api, {
      guildId,
      userId,
      entryType: CasinoLedgerType.LOAN_BORROW,
      currency: 'chip',
      amount: loanAmount,
      balanceBefore: chipCredit.balanceBefore,
      balanceAfter: chipCredit.balanceAfter,
      debtBefore,
      debtAfter: debtBefore + loanAmount,
      loanId,
      createdAt: timestamp,
    });

    return {
      loan: mapLoan(api.get('SELECT * FROM casino_loans WHERE id = ?', [loanId])),
      borrowedAmount: loanAmount,
      balanceBefore: chipCredit.balanceBefore,
      balanceAfter: chipCredit.balanceAfter,
      interestApplied: interest.interestAmount,
    };
  });
}

function repayCasinoLoan(guildId, userId, { amount, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    const requestedAmount = normalizeAmount(amount, '還款金額');
    ensurePlayer(api, guildId, userId);
    const interest = applyLoanInterest(api, guildId, userId, date);
    const activeLoan = interest.loan;

    if (!activeLoan) {
      throw new CoinServiceError('NO_ACTIVE_CASINO_LOAN', '你目前沒有賭場借款。');
    }

    const repaymentAmount = Math.min(requestedAmount, activeLoan.currentDebtAmount);

    const timestamp = nowIso(date);
    const chipDebit = debitChipsForCasinoWithApi(api, guildId, userId, repaymentAmount, {
      timestamp,
      entryType: ChipLedgerType.LOAN_REPAY,
      reason: '賭場貸幣還款',
      metadata: { loanId: activeLoan.id, debtAmount: repaymentAmount },
      topUpReason: '賭場還款自動補足籌碼',
    });
    const debtAfter = activeLoan.currentDebtAmount - repaymentAmount;
    api.run(
      `UPDATE casino_loans
       SET current_debt_amount = ?, status = ?, updated_at = ?, repaid_at = CASE WHEN ? = 0 THEN ? ELSE repaid_at END
       WHERE id = ?`,
      [debtAfter, debtAfter === 0 ? 'repaid' : 'active', timestamp, debtAfter, timestamp, activeLoan.id]
    );
    insertCasinoLedger(api, {
      guildId,
      userId,
      entryType: CasinoLedgerType.LOAN_REPAY,
      currency: 'chip',
      amount: -repaymentAmount,
      balanceBefore: chipDebit.balanceBefore,
      balanceAfter: chipDebit.balanceAfter,
      debtBefore: activeLoan.currentDebtAmount,
      debtAfter,
      loanId: activeLoan.id,
      createdAt: timestamp,
    });

    return {
      loan: mapLoan(api.get('SELECT * FROM casino_loans WHERE id = ?', [activeLoan.id])),
      repaymentAmount,
      balanceBefore: chipDebit.balanceBefore,
      balanceAfter: chipDebit.balanceAfter,
      autoTopUpAmount: chipDebit.autoTopUpAmount,
      coinBalanceAfter: chipDebit.coinBalanceAfter,
      interestApplied: interest.interestAmount,
    };
  });
}

function getCasinoLoanStatus(guildId, userId, { date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    ensurePlayer(api, guildId, userId);
    const chipAccount = ensureChipAccount(api, guildId, userId);
    const interest = applyLoanInterest(api, guildId, userId, date);
    const loan = interest.loan || mapLoan(getActiveLoanRow(api, guildId, userId));

    return {
      loan,
      chipBalance: chipAccount.balance,
      interestApplied: interest.interestAmount,
      daysApplied: interest.daysApplied,
    };
  });
}

function getCasinoDebtStatus(guildId, userId, { date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    const player = ensurePlayer(api, guildId, userId);
    const chipAccount = ensureChipAccount(api, guildId, userId);
    const interest = applyLoanInterest(api, guildId, userId, date);
    const loan = interest.loan || mapLoan(getActiveLoanRow(api, guildId, userId));
    const fixed = getFixedDepositSummary(api, guildId, userId, date);
    const collectableAmount = player.balance + player.bankBalance;

    return {
      loan,
      interestApplied: interest.interestAmount,
      daysApplied: interest.daysApplied,
      walletBalance: player.balance,
      bankBalance: player.bankBalance,
      chipBalance: chipAccount.balance,
      collectableAmount,
      maxCollectableAmount: loan ? Math.min(loan.currentDebtAmount, collectableAmount) : 0,
      ...fixed,
    };
  });
}

function applyCasinoLoanRelief(guildId, userId, { operatorId, reason = '', date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    ensurePlayer(api, guildId, userId);
    const interest = applyLoanInterest(api, guildId, userId, date);
    const activeLoan = interest.loan;

    if (!activeLoan) {
      throw new CoinServiceError('NO_ACTIVE_CASINO_LOAN', '目標目前沒有賭場借款。');
    }

    const oldRate = Number(activeLoan.interestRate || LOAN_INTEREST_RATE);

    if (oldRate <= MIN_LOAN_INTEREST_RATE) {
      throw new CoinServiceError('CASINO_LOAN_RELIEF_LIMIT', '這筆借款已達最低可調整利率。');
    }

    const timestamp = nowIso(date);
    const nextReliefCount = Number(activeLoan.reliefCount || 0) + 1;
    const newRate = calculateReliefRate(nextReliefCount);

    api.run(
      `UPDATE casino_loans
       SET interest_rate = ?, relief_count = ?, relief_updated_by = ?, relief_updated_at = ?, updated_at = ?
       WHERE id = ?`,
      [newRate, nextReliefCount, operatorId || null, timestamp, timestamp, activeLoan.id]
    );
    insertCasinoLedger(api, {
      guildId,
      userId,
      entryType: CasinoLedgerType.LOAN_RELIEF,
      currency: 'coin',
      amount: 0,
      debtBefore: activeLoan.currentDebtAmount,
      debtAfter: activeLoan.currentDebtAmount,
      loanId: activeLoan.id,
      details: {
        operatorId,
        reason,
        oldRate,
        newRate,
        reliefCount: nextReliefCount,
        interestApplied: interest.interestAmount,
      },
      createdAt: timestamp,
    });

    return {
      loan: mapLoan(api.get('SELECT * FROM casino_loans WHERE id = ?', [activeLoan.id])),
      oldRate,
      newRate,
      reliefCount: nextReliefCount,
      interestApplied: interest.interestAmount,
    };
  });
}

function collectCasinoDebt(guildId, userId, { amount, operatorId, reason = '', date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    const requestedAmount = normalizeAmount(amount, '徵收金額');
    const interest = applyLoanInterest(api, guildId, userId, date);
    const activeLoan = interest.loan;

    if (!activeLoan) {
      throw new CoinServiceError('NO_ACTIVE_CASINO_LOAN', '目標目前沒有賭場借款。');
    }

    const player = ensurePlayer(api, guildId, userId);
    const collectableAmount = player.balance + player.bankBalance;

    if (collectableAmount <= 0) {
      throw new CoinServiceError('NO_COLLECTABLE_CASINO_FUNDS', '目標錢包與活存目前都沒有可徵收金額。');
    }

    const collectionAmount = Math.min(requestedAmount, activeLoan.currentDebtAmount, collectableAmount);
    const walletCollected = Math.min(player.balance, collectionAmount);
    const bankCollected = collectionAmount - walletCollected;
    const walletAfter = player.balance - walletCollected;
    const bankAfter = player.bankBalance - bankCollected;
    const debtAfter = activeLoan.currentDebtAmount - collectionAmount;
    const timestamp = nowIso(date);

    api.run(
      `UPDATE coin_bank_accounts_global
       SET balance = ?, updated_at = ?
       WHERE user_id = ?`,
      [bankAfter, timestamp, userId]
    );
    api.run(
      `UPDATE casino_loans
       SET current_debt_amount = ?, status = ?, updated_at = ?, repaid_at = CASE WHEN ? = 0 THEN ? ELSE repaid_at END
       WHERE id = ?`,
      [debtAfter, debtAfter === 0 ? 'repaid' : 'active', timestamp, debtAfter, timestamp, activeLoan.id]
    );
    mutateWalletWithApi(api, {
      guildId,
      userId,
      type: TransactionType.CASINO_FORCED_COLLECTION,
      balanceDelta: -walletCollected,
      totalSpentDelta: collectionAmount,
      operatorId: operatorId || null,
      reason: reason || '賭場貸幣強制徵收',
      metadata: {
        loanId: activeLoan.id,
        requestedAmount,
        collectionAmount,
        walletCollected,
        bankCollected,
        bankBalanceBefore: player.bankBalance,
        bankBalanceAfter: bankAfter,
        debtBefore: activeLoan.currentDebtAmount,
        debtAfter,
        fixedDepositsTouched: false,
        interestApplied: interest.interestAmount,
      },
      createdAt: timestamp,
    });
    insertCasinoLedger(api, {
      guildId,
      userId,
      entryType: CasinoLedgerType.LOAN_FORCED_COLLECTION,
      currency: 'coin',
      amount: -collectionAmount,
      balanceBefore: player.balance,
      balanceAfter: walletAfter,
      debtBefore: activeLoan.currentDebtAmount,
      debtAfter,
      loanId: activeLoan.id,
      details: {
        operatorId,
        reason,
        requestedAmount,
        walletCollected,
        bankCollected,
        bankBalanceBefore: player.bankBalance,
        bankBalanceAfter: bankAfter,
        fixedDepositsTouched: false,
      },
      createdAt: timestamp,
    });

    return {
      loan: mapLoan(api.get('SELECT * FROM casino_loans WHERE id = ?', [activeLoan.id])),
      requestedAmount,
      collectionAmount,
      walletCollected,
      bankCollected,
      walletBefore: player.balance,
      walletAfter,
      bankBefore: player.bankBalance,
      bankAfter,
      debtBefore: activeLoan.currentDebtAmount,
      debtAfter,
      interestApplied: interest.interestAmount,
    };
  });
}

function processCasinoLoanInterest({ date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const loans = api.all("SELECT * FROM casino_loans WHERE status = 'active'");
    let processed = 0;
    let interestAmount = 0;

    for (const loan of loans) {
      const result = applyLoanInterestForRow(api, loan, date);
      if (result.interestAmount > 0) {
        processed += 1;
        interestAmount += result.interestAmount;
      }
    }

    return {
      checked: loans.length,
      processed,
      interestAmount,
    };
  });
}

module.exports = {
  LOAN_INTEREST_RATE,
  LOAN_RELIEF_STEP_RATIO,
  MIN_LOAN_INTEREST_RATE,
  applyCasinoLoanRelief,
  applyLoanInterest,
  borrowCasinoLoan,
  collectCasinoDebt,
  getCasinoDebtStatus,
  getCasinoLoanStatus,
  processCasinoLoanInterest,
  repayCasinoLoan,
};
