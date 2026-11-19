const crypto = require('node:crypto');
const { addColumnIfMissing, exportDatabase, getRow, getRows, requireColumns, runSql } = require('../sqlHelpers');
const { globalEconomyV22Sql } = require('../schema');

// v22: global bank accounts and chips. inspectGlobalEconomyV22 is also the read-only dry run.
function taipeiSettlementDate(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(now).filter((part) => part.type !== 'literal').map((part) => [part.type, part.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  if (Number(parts.hour) >= 23) return today;
  return new Date(Date.parse(`${today}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
}

function safeSum(rows, key, label) {
  const total = rows.reduce((sum, row) => sum + Number(row[key]), 0);
  if (!Number.isSafeInteger(total) || total < 0) throw new Error(`${label} is outside supported range`);
  return total;
}

function inspectGlobalEconomyV22(db, now = new Date(), sourceSha256 = null) {
  const bankRows = getRows(db, `SELECT guild_id, user_id, bank_balance, bank_interest_accrued,
    last_interest_date, created_at, updated_at FROM coin_guild_players ORDER BY user_id, guild_id`);
  const chipRows = getRows(db, 'SELECT * FROM chip_accounts ORDER BY user_id, guild_id');
  const rateRows = getRows(db, 'SELECT * FROM coin_bank_rates ORDER BY guild_id, rate_key');
  const fixedRows = getRows(db, 'SELECT id, guild_id, user_id, principal, expected_interest, status FROM coin_fixed_deposits ORDER BY id');
  const loanRows = getRows(db, 'SELECT id, guild_id, user_id, principal_amount, current_debt_amount, status FROM casino_loans ORDER BY id');
  const rewardRows = getRows(db, 'SELECT id, guild_id, user_id, source_type, source_id, reward_kind, amount, transaction_id, created_at FROM reward_grants ORDER BY id');
  const settlementDate = taipeiSettlementDate(now);
  const conflicts = [];
  const legacyRewardConflicts = [];
  const loanConflicts = [];
  const bankByUser = new Map();
  const chipsByUser = new Map();
  for (const row of bankRows) {
    const balance = Number(row.bank_balance);
    const accrued = Number(row.bank_interest_accrued);
    if (!Number.isSafeInteger(balance) || balance < 0 || !Number.isFinite(accrued) || accrued < 0) {
      conflicts.push({ code: 'INVALID_BANK_VALUE', userId: row.user_id, sourceGuildId: row.guild_id });
      continue;
    }
    if (balance > 0 && (!row.last_interest_date || row.last_interest_date < settlementDate)) {
      conflicts.push({ code: 'UNSETTLED_LEGACY_INTEREST', userId: row.user_id, sourceGuildId: row.guild_id });
    }
    const account = bankByUser.get(row.user_id) || {
      userId: row.user_id, balance: 0, interestAccrued: 0,
      lastInterestDate: row.last_interest_date, positiveBalanceDate: null,
      createdAt: row.created_at, updatedAt: row.updated_at,
    };
    account.balance += balance;
    account.interestAccrued += accrued;
    if (balance > 0 && account.positiveBalanceDate && row.last_interest_date && account.positiveBalanceDate !== row.last_interest_date) {
      conflicts.push({ code: 'MIXED_INTEREST_DATES', userId: row.user_id });
    }
    if (balance > 0) account.positiveBalanceDate = row.last_interest_date;
    if (row.last_interest_date > (account.lastInterestDate || '')) account.lastInterestDate = row.last_interest_date;
    if (row.created_at < account.createdAt) account.createdAt = row.created_at;
    if (row.updated_at > account.updatedAt) account.updatedAt = row.updated_at;
    if (!Number.isSafeInteger(account.balance) || account.balance > Number.MAX_SAFE_INTEGER || !Number.isFinite(account.interestAccrued)) {
      conflicts.push({ code: 'BANK_SUM_OVERFLOW', userId: row.user_id });
    }
    bankByUser.set(row.user_id, account);
  }
  for (const row of chipRows) {
    const amount = Number(row.balance);
    if (!Number.isSafeInteger(amount) || amount < 0) {
      conflicts.push({ code: 'INVALID_CHIP_VALUE', userId: row.user_id, sourceGuildId: row.guild_id });
      continue;
    }
    const account = chipsByUser.get(row.user_id) || { userId: row.user_id, balance: 0, createdAt: row.created_at, updatedAt: row.updated_at };
    account.balance += amount;
    if (row.created_at < account.createdAt) account.createdAt = row.created_at;
    if (row.updated_at > account.updatedAt) account.updatedAt = row.updated_at;
    if (!Number.isSafeInteger(account.balance)) conflicts.push({ code: 'CHIP_SUM_OVERFLOW', userId: row.user_id });
    chipsByUser.set(row.user_id, account);
  }
  for (const row of rateRows) {
    if (Number(row.is_event) === 1) {
      conflicts.push({ code: 'LEGACY_RATE_EVENT', sourceGuildId: row.guild_id, rateKey: row.rate_key });
    }
  }
  const pendingGames = Number(getRow(db, "SELECT COUNT(*) AS count FROM casino_games WHERE status != 'settled'").count);
  const pendingBlackjack = Number(getRow(db, "SELECT COUNT(*) AS count FROM casino_blackjack_sessions WHERE status = 'active'").count);
  const escrowedTips = Number(getRow(db, "SELECT COUNT(*) AS count FROM casino_venue_orders WHERE tip_status = 'escrowed'").count);
  if (pendingGames || pendingBlackjack || escrowedTips) {
    conflicts.push({ code: 'UNSETTLED_GAME_OR_ESCROW', pendingGames, pendingBlackjack, escrowedTips });
  }
  const legacyRewardKeys = new Map();
  const activeLoansByUser = new Map();
  for (const row of loanRows.filter((loan) => loan.status === 'active')) {
    const loans = activeLoansByUser.get(row.user_id) || [];
    loans.push(row.id);
    activeLoansByUser.set(row.user_id, loans);
  }
  for (const [userId, loanIds] of activeLoansByUser) {
    if (loanIds.length > 1) loanConflicts.push({ code: 'MULTIPLE_ACTIVE_LOANS', userId, loanIds });
  }
  for (const row of rewardRows) {
    const key = JSON.stringify([row.user_id, row.source_type, row.source_id, row.reward_kind]);
    const prior = legacyRewardKeys.get(key);
    if (prior && (Number(prior.amount) !== Number(row.amount) || prior.guild_id !== row.guild_id)) {
      legacyRewardConflicts.push({ code: 'LEGACY_REWARD_SOURCE_COLLISION', legacyGrantIds: [prior.id, row.id] });
    }
    legacyRewardKeys.set(key, row);
  }
  const completeSourceSha256 = sourceSha256 || crypto.createHash('sha256').update(exportDatabase(db)).digest('hex');
  const blockingSettlements = conflicts.filter((conflict) =>
    ['UNSETTLED_LEGACY_INTEREST', 'UNSETTLED_GAME_OR_ESCROW'].includes(conflict.code));
  const decisionRequired = [
    ...conflicts.filter((conflict) => !blockingSettlements.includes(conflict)),
    ...loanConflicts,
    ...legacyRewardConflicts,
  ];
  return {
    fromVersion: 21, toVersion: 22, settlementDate, sourceSha256: completeSourceSha256,
    canApply: conflicts.length === 0 && decisionRequired.length === 0,
    conflicts, blockingSettlements, decisionRequired, legacyRewardConflicts, loanConflicts,
    autoMigratable: {
      bankAccountCount: bankByUser.size,
      chipAccountCount: chipsByUser.size,
      fixedContractCount: fixedRows.length,
      loanContractCount: loanRows.length,
    },
    bankAccounts: [...bankByUser.values()], chipAccounts: [...chipsByUser.values()],
    totals: {
      bankBalance: safeSum(bankRows, 'bank_balance', 'bank balance'),
      chipBalance: safeSum(chipRows, 'balance', 'chip balance'),
      interestAccrued: bankRows.reduce((sum, row) => sum + Number(row.bank_interest_accrued), 0),
      fixedPrincipal: safeSum(fixedRows.filter((row) => row.status === 'active' || row.status === 'matured'), 'principal', 'fixed principal'),
      fixedInterest: safeSum(fixedRows.filter((row) => row.status === 'active' || row.status === 'matured'), 'expected_interest', 'fixed interest'),
      loanPrincipal: safeSum(loanRows.filter((row) => row.status === 'active'), 'principal_amount', 'loan principal'),
      loanDebt: safeSum(loanRows.filter((row) => row.status === 'active'), 'current_debt_amount', 'loan debt'),
    },
  };
}

function migrateGlobalEconomyV22(db, { expectedSourceSha256 = null, requireExpectedSource = false, sourceSha256 = null } = {}) {
  const plan = inspectGlobalEconomyV22(db, new Date(), sourceSha256);
  if (requireExpectedSource && !/^[a-f0-9]{64}$/.test(String(expectedSourceSha256 || ''))) {
    throw new Error('v22 migration requires a reviewed v21 source SHA-256');
  }
  if (expectedSourceSha256 && expectedSourceSha256 !== plan.sourceSha256) {
    throw new Error('v22 source SHA-256 changed since dry run');
  }
  if (!plan.canApply) {
    const unresolved = [...plan.blockingSettlements, ...plan.decisionRequired];
    const error = new Error(`v22 migration has ${unresolved.length} unresolved conflicts`);
    error.conflicts = unresolved;
    throw error;
  }
  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    db.exec(globalEconomyV22Sql);
    addColumnIfMissing(db, 'coin_work_tasks', 'global_cycle_id', 'TEXT REFERENCES coin_primary_job_cycles(cycle_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_coin_work_tasks_global_cycle ON coin_work_tasks (global_cycle_id, status, id)');
    addColumnIfMissing(db, 'casino_venue_orders', 'waiter_global_cycle_id', 'TEXT REFERENCES coin_primary_job_cycles(cycle_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_venue_orders_waiter_global_cycle ON casino_venue_orders (waiter_global_cycle_id, tip_status, id)');
    addColumnIfMissing(db, 'casino_venue_order_items', 'global_cycle_id', 'TEXT REFERENCES coin_primary_job_cycles(cycle_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_venue_order_items_global_cycle ON casino_venue_order_items (global_cycle_id, status, id)');
    const timestamp = new Date().toISOString();
    for (const account of plan.bankAccounts) {
      runSql(db, `INSERT INTO coin_bank_accounts_global
        (user_id, balance, interest_accrued, last_interest_date, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)`, [account.userId, account.balance, account.interestAccrued,
        account.lastInterestDate, account.createdAt, account.updatedAt]);
    }
    for (const account of plan.chipAccounts) {
      runSql(db, `INSERT INTO chip_accounts_global (user_id, balance, created_at, updated_at)
        VALUES (?, ?, ?, ?)`, [account.userId, account.balance, account.createdAt, account.updatedAt]);
    }
    for (const [rateKey, rate] of Object.entries({ demand: 0.0003, fixed_7: 0.0035,
      fixed_14: 0.008, fixed_30: 0.02, fixed_90: 0.07 })) {
      runSql(db, `INSERT INTO coin_bank_rates_global (rate_key, rate, updated_by, reason, updated_at)
        VALUES (?, ?, 'system', 'v22 global default', ?)`, [rateKey, rate, timestamp]);
    }
    const targetBankBalance = Number(getRow(db, 'SELECT COALESCE(SUM(balance), 0) AS total FROM coin_bank_accounts_global').total);
    const targetChipBalance = Number(getRow(db, 'SELECT COALESCE(SUM(balance), 0) AS total FROM chip_accounts_global').total);
    const targetInterest = Number(getRow(db, 'SELECT COALESCE(SUM(interest_accrued), 0) AS total FROM coin_bank_accounts_global').total);
    if (targetBankBalance !== plan.totals.bankBalance || targetChipBalance !== plan.totals.chipBalance ||
      Math.abs(targetInterest - plan.totals.interestAccrued) > 1e-8) throw new Error('v22 asset conservation check failed');
    runSql(db, `INSERT INTO coin_global_economy_migrations
      (to_version, source_sha256, source_bank_balance_sum, target_bank_balance_sum,
       source_chip_balance_sum, target_chip_balance_sum, source_interest_sum, target_interest_sum,
       source_fixed_principal_sum, target_fixed_principal_sum, source_fixed_interest_sum, target_fixed_interest_sum,
       source_loan_principal_sum, target_loan_principal_sum, source_loan_debt_sum, target_loan_debt_sum, completed_at)
       VALUES (22, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [plan.sourceSha256,
      plan.totals.bankBalance, targetBankBalance, plan.totals.chipBalance, targetChipBalance,
      plan.totals.interestAccrued, targetInterest, plan.totals.fixedPrincipal,
      plan.totals.fixedPrincipal, plan.totals.fixedInterest, plan.totals.fixedInterest,
      plan.totals.loanPrincipal, plan.totals.loanPrincipal,
      plan.totals.loanDebt, plan.totals.loanDebt, timestamp]);
    db.exec('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) db.exec('ROLLBACK');
    throw error;
  }
}

function verifyGlobalEconomyV22Schema(db) {
  for (const [table, columns] of Object.entries({
    coin_bank_accounts_global: ['user_id', 'balance', 'interest_accrued', 'last_interest_date'],
    coin_bank_rates_global: ['rate_key', 'rate', 'is_event'],
    coin_rate_history_global: ['id', 'rate_key', 'old_rate', 'new_rate', 'source_guild_id'],
    chip_accounts_global: ['user_id', 'balance'],
    reward_grants_v2: ['reward_key', 'user_id', 'amount', 'payload_hash', 'debt_offset', 'net_amount', 'transaction_id'],
    coin_operation_receipts: ['operation_id', 'payload_hash', 'transaction_id'],
    coin_owner_campaigns: ['campaign_id', 'amount', 'reason'],
    coin_owner_campaign_audiences: ['campaign_id', 'source_guild_id', 'audience_type', 'role_id'],
    coin_owner_campaign_recipients: ['campaign_id', 'user_id', 'first_source_guild_id'],
    coin_owner_campaign_audience_members: ['campaign_id', 'source_guild_id', 'audience_type', 'role_id', 'user_id'],
    coin_owner_campaign_history_reviews: ['campaign_id', 'user_id', 'prior_grant', 'source_sha256', 'review_batch_sha256', 'review_id', 'review_reason'],
    coin_owner_campaign_history_classifications: ['campaign_id', 'user_id', 'record_type', 'record_id', 'row_sha256', 'source_sha256', 'evidence_reference'],
    coin_primary_jobs_global: ['user_id', 'job_name', 'work_days', 'state', 'next_cycle_id'],
    coin_primary_job_cycles: ['cycle_id', 'user_id', 'job_name', 'starts_at', 'ends_at'],
    coin_primary_cycle_penalties: ['id', 'cycle_id', 'user_id', 'amount', 'status'],
    coin_primary_cycle_penalty_appeals: ['id', 'penalty_id', 'status', 'reason', 'review_reason'],
    coin_primary_cycle_payroll: ['cycle_id', 'user_id', 'gross_amount', 'paid_amount', 'pay_ratio', 'reward_key', 'settled_at'],
    coin_work_legacy_snapshots: ['job_id', 'source_hash', 'cutover_state_hash', 'snapshot_item_count'],
    coin_work_legacy_snapshot_items: ['job_id', 'item_kind', 'item_id', 'source_hash'],
    coin_work_legacy_settlements: ['job_id', 'period_key', 'user_id', 'source_guild_id', 'reward_key', 'status'],
    discord_game_sessions: ['id', 'user_id', 'source_guild_id', 'game_type', 'revision', 'state_json', 'completed_at'],
    discord_game_actions: ['session_id', 'revision', 'interaction_id', 'action_hash', 'result_json'],
    discord_game_rewards: ['session_id', 'reward_key', 'status', 'amount', 'receipt_id'],
    coin_global_economy_migrations: ['to_version', 'source_sha256'],
  })) requireColumns(db, table, columns);
  requireColumns(db, 'coin_work_tasks', ['global_cycle_id']);
  requireColumns(db, 'casino_venue_orders', ['waiter_global_cycle_id']);
  requireColumns(db, 'casino_venue_order_items', ['global_cycle_id']);
  const receipt = getRow(db, 'SELECT * FROM coin_global_economy_migrations WHERE to_version = 22');
  if (!receipt) throw new Error('missing v22 migration receipt');
  const bank = Number(getRow(db, 'SELECT COALESCE(SUM(balance), 0) AS total FROM coin_bank_accounts_global').total);
  const chips = Number(getRow(db, 'SELECT COALESCE(SUM(balance), 0) AS total FROM chip_accounts_global').total);
  if (bank < 0 || chips < 0) throw new Error('invalid v22 global assets');
  if (getRow(db, 'PRAGMA foreign_key_check')) throw new Error('v22 foreign key failure');
}

module.exports = {
  inspectGlobalEconomyV22,
  migrateGlobalEconomyV22,
  verifyGlobalEconomyV22Schema,
};
