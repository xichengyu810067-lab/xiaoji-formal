const crypto = require('node:crypto');
const logger = require('../../../../utils/logger');
const {
  addColumnIfMissing, getRow, getRows, getTableColumns, getTableDefinition, hasUniqueIndex, requireColumns, runSql,
  verifyIntegrity, verifyTableContract,
} = require('../sqlHelpers');

// v20: one global spendable wallet per user; coin_players becomes a read-only archive.
function safeAdd(left, right, label) {
  const value = Number(left) + Number(right);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} exceeds the supported non-negative safe-integer range`);
  }
  return value;
}

function canonicalLegacyWalletSource(rows) {
  return rows.map((row) => ({
    guild_id: String(row.guild_id),
    user_id: String(row.user_id),
    balance: Number(row.balance),
    bank_balance: Number(row.bank_balance),
    bank_interest_accrued: Number(row.bank_interest_accrued),
    last_interest_date: row.last_interest_date == null ? null : String(row.last_interest_date),
    total_earned: Number(row.total_earned),
    total_spent: Number(row.total_spent),
    last_daily_date: row.last_daily_date == null ? null : String(row.last_daily_date),
    daily_streak: Number(row.daily_streak),
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
  }));
}

function migrateGlobalWalletV20(db, currentVersion) {
  if (currentVersion >= 20) return false;

  requireColumns(db, 'coin_players', [
    'guild_id', 'user_id', 'balance', 'bank_balance', 'bank_interest_accrued', 'last_interest_date',
    'total_earned', 'total_spent', 'last_daily_date', 'daily_streak', 'created_at', 'updated_at',
  ]);
  requireColumns(db, 'coin_wallets', [
    'user_id', 'balance', 'total_earned', 'total_spent', 'revision', 'created_at', 'updated_at',
  ]);
  requireColumns(db, 'coin_guild_players', [
    'guild_id', 'user_id', 'bank_balance', 'bank_interest_accrued', 'last_interest_date',
    'last_daily_date', 'daily_streak', 'created_at', 'updated_at',
  ]);
  requireColumns(db, 'coin_wallet_migrations', [
    'from_version', 'to_version', 'source_row_count', 'source_distinct_user_count',
    'source_balance_sum', 'source_total_earned_sum', 'source_total_spent_sum', 'source_sha256', 'completed_at',
  ]);

  if (getRow(db, 'SELECT 1 AS found FROM coin_wallet_migrations WHERE to_version = 20')) {
    throw new Error('schema is below v20 but a completed v20 wallet migration already exists');
  }
  const preexistingTargetRows = Number(getRow(
    db,
    'SELECT (SELECT COUNT(*) FROM coin_wallets) + (SELECT COUNT(*) FROM coin_guild_players) AS count'
  ).count);
  if (preexistingTargetRows !== 0) {
    throw new Error('v20 wallet target tables must be empty before migration');
  }

  const sourceRows = canonicalLegacyWalletSource(getRows(
    db,
    `SELECT guild_id, user_id, balance, bank_balance, bank_interest_accrued, last_interest_date,
            total_earned, total_spent, last_daily_date, daily_streak, created_at, updated_at
     FROM coin_players
     ORDER BY user_id, guild_id`
  ));
  const wallets = new Map();
  let balanceSum = 0;
  let earnedSum = 0;
  let spentSum = 0;

  for (const row of sourceRows) {
    for (const [field, value] of [
      ['balance', row.balance], ['bank_balance', row.bank_balance], ['total_earned', row.total_earned],
      ['total_spent', row.total_spent], ['daily_streak', row.daily_streak],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`coin_players ${field} contains an invalid value for ${row.guild_id}/${row.user_id}`);
      }
    }
    if (!Number.isFinite(row.bank_interest_accrued) || row.bank_interest_accrued < 0) {
      throw new Error(`coin_players bank_interest_accrued contains an invalid value for ${row.guild_id}/${row.user_id}`);
    }
    if (!row.guild_id || !row.user_id || !row.created_at || !row.updated_at) {
      throw new Error('coin_players contains an invalid identity or timestamp');
    }

    balanceSum = safeAdd(balanceSum, row.balance, 'global balance sum');
    earnedSum = safeAdd(earnedSum, row.total_earned, 'global total-earned sum');
    spentSum = safeAdd(spentSum, row.total_spent, 'global total-spent sum');
    const current = wallets.get(row.user_id) || {
      userId: row.user_id,
      balance: 0,
      totalEarned: 0,
      totalSpent: 0,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
    current.balance = safeAdd(current.balance, row.balance, `balance for ${row.user_id}`);
    current.totalEarned = safeAdd(current.totalEarned, row.total_earned, `total earned for ${row.user_id}`);
    current.totalSpent = safeAdd(current.totalSpent, row.total_spent, `total spent for ${row.user_id}`);
    if (row.created_at < current.createdAt) current.createdAt = row.created_at;
    if (row.updated_at > current.updatedAt) current.updatedAt = row.updated_at;
    wallets.set(row.user_id, current);
  }

  const sourceSha256 = crypto.createHash('sha256').update(JSON.stringify(sourceRows)).digest('hex');
  const transactionCountBefore = Number(getRow(db, 'SELECT COUNT(*) AS count FROM coin_transactions').count);
  const transactionIdSumBefore = Number(getRow(db, 'SELECT COALESCE(SUM(id), 0) AS total FROM coin_transactions').total);
  const linkedGrantCountBefore = Number(getRow(db, 'SELECT COUNT(*) AS count FROM reward_grants WHERE transaction_id IS NOT NULL').count);
  let transactionStarted = false;

  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    addColumnIfMissing(
      db,
      'coin_transactions',
      'wallet_scope',
      "TEXT NOT NULL DEFAULT 'guild_legacy' CHECK (wallet_scope IN ('guild_legacy', 'global'))"
    );
    addColumnIfMissing(db, 'coin_transactions', 'wallet_revision', 'INTEGER');

    for (const wallet of wallets.values()) {
      runSql(
        db,
        `INSERT INTO coin_wallets
          (user_id, balance, total_earned, total_spent, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, 0, ?, ?)`,
        [wallet.userId, wallet.balance, wallet.totalEarned, wallet.totalSpent, wallet.createdAt, wallet.updatedAt]
      );
    }
    for (const row of sourceRows) {
      runSql(
        db,
        `INSERT INTO coin_guild_players
          (guild_id, user_id, bank_balance, bank_interest_accrued, last_interest_date,
           last_daily_date, daily_streak, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          row.guild_id, row.user_id, row.bank_balance, row.bank_interest_accrued, row.last_interest_date,
          row.last_daily_date, row.daily_streak, row.created_at, row.updated_at,
        ]
      );
    }

    const timestamp = new Date().toISOString();
    runSql(
      db,
      `INSERT INTO coin_wallet_migrations
        (from_version, to_version, source_row_count, source_distinct_user_count,
         source_balance_sum, source_total_earned_sum, source_total_spent_sum, source_sha256, completed_at)
       VALUES (?, 20, ?, ?, ?, ?, ?, ?, ?)`,
      [currentVersion, sourceRows.length, wallets.size, balanceSum, earnedSum, spentSum, sourceSha256, timestamp]
    );

    const migratedCounts = getRow(
      db,
      `SELECT (SELECT COUNT(*) FROM coin_wallets) AS wallets,
              (SELECT COUNT(*) FROM coin_guild_players) AS guild_players,
              (SELECT COALESCE(SUM(balance), 0) FROM coin_wallets) AS balance_sum,
              (SELECT COALESCE(SUM(total_earned), 0) FROM coin_wallets) AS earned_sum,
              (SELECT COALESCE(SUM(total_spent), 0) FROM coin_wallets) AS spent_sum`
    );
    if (
      Number(migratedCounts.wallets) !== wallets.size ||
      Number(migratedCounts.guild_players) !== sourceRows.length ||
      Number(migratedCounts.balance_sum) !== balanceSum ||
      Number(migratedCounts.earned_sum) !== earnedSum ||
      Number(migratedCounts.spent_sum) !== spentSum
    ) {
      throw new Error('v20 wallet migration aggregate verification failed');
    }
    for (const wallet of wallets.values()) {
      const migrated = getRow(
        db,
        'SELECT balance, total_earned, total_spent FROM coin_wallets WHERE user_id = ?',
        [wallet.userId]
      );
      if (
        Number(migrated?.balance) !== wallet.balance ||
        Number(migrated?.total_earned) !== wallet.totalEarned ||
        Number(migrated?.total_spent) !== wallet.totalSpent
      ) {
        throw new Error(`v20 wallet migration verification failed for ${wallet.userId}`);
      }
    }
    if (
      Number(getRow(db, 'SELECT COUNT(*) AS count FROM coin_transactions').count) !== transactionCountBefore ||
      Number(getRow(db, 'SELECT COALESCE(SUM(id), 0) AS total FROM coin_transactions').total) !== transactionIdSumBefore ||
      Number(getRow(db, 'SELECT COUNT(*) AS count FROM reward_grants WHERE transaction_id IS NOT NULL').count) !== linkedGrantCountBefore
    ) {
      throw new Error('v20 wallet migration changed legacy transaction or reward-grant identity');
    }
    verifyIntegrity(db);
    db.exec('COMMIT');
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { logger.error('Global wallet v20 migration rollback failed', rollbackError); }
    }
    throw error;
  }
}

function verifyGlobalWalletV20Schema(db) {
  const text = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'TEXT', notNull, defaultValue, primaryKeyPosition,
  });
  const integer = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'INTEGER', notNull, defaultValue, primaryKeyPosition,
  });
  const real = (notNull = false, defaultValue = null, primaryKeyPosition = 0) => ({
    type: 'REAL', notNull, defaultValue, primaryKeyPosition,
  });
  verifyTableContract(db, 'coin_wallets', {
    user_id: text(false, null, 1),
    balance: integer(true, '0'),
    total_earned: integer(true, '0'),
    total_spent: integer(true, '0'),
    revision: integer(true, '0'),
    created_at: text(true),
    updated_at: text(true),
  }, [
    'check(balance>=0andbalance<=9007199254740991)',
    'check(total_earned>=0andtotal_earned<=9007199254740991)',
    'check(total_spent>=0andtotal_spent<=9007199254740991)',
    'check(revision>=0andrevision<=9007199254740991)',
  ]);
  verifyTableContract(db, 'coin_guild_players', {
    guild_id: text(true, null, 1),
    user_id: text(true, null, 2),
    bank_balance: integer(true, '0'),
    bank_interest_accrued: real(true, '0'),
    last_interest_date: text(),
    last_daily_date: text(),
    daily_streak: integer(true, '0'),
    created_at: text(true),
    updated_at: text(true),
  }, [
    'check(bank_balance>=0andbank_balance<=9007199254740991)',
    'check(bank_interest_accrued>=0)',
    'check(daily_streak>=0)',
  ]);
  verifyTableContract(db, 'coin_wallet_migrations', {
    id: integer(false, null, 1),
    from_version: integer(true),
    to_version: integer(true),
    source_row_count: integer(true),
    source_distinct_user_count: integer(true),
    source_balance_sum: integer(true),
    source_total_earned_sum: integer(true),
    source_total_spent_sum: integer(true),
    source_sha256: text(true),
    completed_at: text(true),
  }, []);
  const transactionColumns = new Map(getTableColumns(db, 'coin_transactions').map((column) => [column.name, column]));
  for (const [columnName, expected] of Object.entries({
    wallet_scope: text(true, "'guild_legacy'"),
    wallet_revision: integer(),
  })) {
    const actual = transactionColumns.get(columnName);
    if (!actual || JSON.stringify(actual) !== JSON.stringify({ name: columnName, ...expected })) {
      throw new Error(`coin_transactions.${columnName} does not match its required schema contract`);
    }
  }
  if (!getTableDefinition(db, 'coin_transactions').includes("check(wallet_scopein('guild_legacy','global'))")) {
    throw new Error('coin_transactions is missing its wallet-scope CHECK constraint');
  }
  if (!hasUniqueIndex(db, 'coin_wallet_migrations', ['to_version'])) {
    throw new Error('coin_wallet_migrations is missing its migration-version unique key');
  }
  const guildPlayerForeignKey = getRows(db, 'PRAGMA foreign_key_list(coin_guild_players)')
    .find((row) => row.table === 'coin_wallets' && row.from === 'user_id' && row.to === 'user_id');
  if (!guildPlayerForeignKey) throw new Error('coin_guild_players is missing its global-wallet foreign key');
  const globalRevisionIndex = getRows(db, 'PRAGMA index_list(coin_transactions)')
    .find((index) => index.name === 'idx_coin_transactions_global_wallet_revision' && Number(index.unique) === 1 && Number(index.partial) === 1);
  if (!globalRevisionIndex) throw new Error('global wallet transaction revisions are not uniquely indexed');

  const walletRows = getRows(
    db,
    'SELECT user_id, balance, total_earned, total_spent, revision, created_at, updated_at FROM coin_wallets'
  );
  for (const wallet of walletRows) {
    if (!String(wallet.user_id || '').trim() || !String(wallet.created_at || '').trim() || !String(wallet.updated_at || '').trim()) {
      throw new Error('global wallet contains an invalid identity or timestamp');
    }
    if ([wallet.balance, wallet.total_earned, wallet.total_spent, wallet.revision].some(
      (value) => !Number.isSafeInteger(Number(value)) || Number(value) < 0
    )) {
      throw new Error(`invalid global wallet row: ${wallet.user_id}`);
    }
  }
  const guildPlayerRows = getRows(
    db,
    `SELECT guild_id, user_id, bank_balance, bank_interest_accrued, daily_streak, created_at, updated_at
     FROM coin_guild_players`
  );
  for (const player of guildPlayerRows) {
    if (
      !String(player.guild_id || '').trim() || !String(player.user_id || '').trim() ||
      !String(player.created_at || '').trim() || !String(player.updated_at || '').trim() ||
      !Number.isSafeInteger(Number(player.bank_balance)) || Number(player.bank_balance) < 0 ||
      !Number.isFinite(Number(player.bank_interest_accrued)) || Number(player.bank_interest_accrued) < 0 ||
      !Number.isSafeInteger(Number(player.daily_streak)) || Number(player.daily_streak) < 0
    ) {
      throw new Error(`invalid guild wallet state: ${player.guild_id}/${player.user_id}`);
    }
  }
  const orphanGuildPlayer = getRow(
    db,
    `SELECT gp.guild_id, gp.user_id
     FROM coin_guild_players gp
     LEFT JOIN coin_wallets w ON w.user_id = gp.user_id
     WHERE w.user_id IS NULL
     LIMIT 1`
  );
  if (orphanGuildPlayer) {
    throw new Error(`guild wallet state has no global authority: ${orphanGuildPlayer.guild_id}/${orphanGuildPlayer.user_id}`);
  }
  const invalidScope = getRow(
    db,
    "SELECT id FROM coin_transactions WHERE wallet_scope NOT IN ('guild_legacy', 'global') LIMIT 1"
  );
  if (invalidScope) throw new Error(`invalid wallet scope on transaction ${invalidScope.id}`);
  const invalidRevision = getRow(
    db,
    `SELECT id FROM coin_transactions
     WHERE (wallet_scope = 'global' AND (
              wallet_revision IS NULL OR wallet_revision < 1 OR
              wallet_revision > 9007199254740991 OR typeof(wallet_revision) != 'integer'
            ))
        OR (wallet_scope = 'guild_legacy' AND wallet_revision IS NOT NULL)
     LIMIT 1`
  );
  if (invalidRevision) throw new Error(`invalid wallet revision on transaction ${invalidRevision.id}`);
  const brokenRevisionChain = getRow(
    db,
    `SELECT w.user_id
     FROM coin_wallets w
     LEFT JOIN coin_transactions t
       ON t.user_id = w.user_id AND t.wallet_scope = 'global'
     GROUP BY w.user_id, w.revision
     HAVING COUNT(t.id) != w.revision
        OR COALESCE(MIN(t.wallet_revision), 0) != CASE WHEN w.revision = 0 THEN 0 ELSE 1 END
        OR COALESCE(MAX(t.wallet_revision), 0) != w.revision
        OR COUNT(DISTINCT t.wallet_revision) != w.revision
     LIMIT 1`
  );
  if (brokenRevisionChain) throw new Error(`broken global wallet revision chain: ${brokenRevisionChain.user_id}`);
  const triggerCount = Number(getRow(
    db,
    `SELECT COUNT(*) AS count FROM sqlite_master
     WHERE type = 'trigger' AND name IN (
       'coin_players_v19_archive_no_insert',
       'coin_players_v19_archive_no_update',
       'coin_players_v19_archive_no_delete'
     )`
  ).count);
  if (triggerCount !== 3) throw new Error('coin_players v19 archive write guards are incomplete');

  const manifests = getRows(db, 'SELECT * FROM coin_wallet_migrations WHERE to_version = 20');
  if (manifests.length !== 1) throw new Error('v20 wallet migration manifest is missing or duplicated');
  const manifest = manifests[0];
  const sourceRows = canonicalLegacyWalletSource(getRows(
    db,
    `SELECT guild_id, user_id, balance, bank_balance, bank_interest_accrued, last_interest_date,
            total_earned, total_spent, last_daily_date, daily_streak, created_at, updated_at
     FROM coin_players
     ORDER BY user_id, guild_id`
  ));
  const archiveSha256 = crypto.createHash('sha256').update(JSON.stringify(sourceRows)).digest('hex');
  const archiveUsers = new Set();
  let archiveBalanceSum = 0;
  let archiveEarnedSum = 0;
  let archiveSpentSum = 0;
  for (const row of sourceRows) {
    if (!row.guild_id || !row.user_id || !row.created_at || !row.updated_at) {
      throw new Error('coin_players archive contains an invalid identity or timestamp');
    }
    for (const [field, value] of [
      ['balance', row.balance], ['bank_balance', row.bank_balance], ['total_earned', row.total_earned],
      ['total_spent', row.total_spent], ['daily_streak', row.daily_streak],
    ]) {
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`coin_players archive ${field} contains an invalid value`);
      }
    }
    if (!Number.isFinite(row.bank_interest_accrued) || row.bank_interest_accrued < 0) {
      throw new Error('coin_players archive bank interest contains an invalid value');
    }
    archiveUsers.add(row.user_id);
    archiveBalanceSum = safeAdd(archiveBalanceSum, row.balance, 'archived balance sum');
    archiveEarnedSum = safeAdd(archiveEarnedSum, row.total_earned, 'archived total-earned sum');
    archiveSpentSum = safeAdd(archiveSpentSum, row.total_spent, 'archived total-spent sum');
  }
  if (
    Number(manifest.source_row_count) !== sourceRows.length ||
    Number(manifest.source_distinct_user_count) !== archiveUsers.size ||
    Number(manifest.source_balance_sum) !== archiveBalanceSum ||
    Number(manifest.source_total_earned_sum) !== archiveEarnedSum ||
    Number(manifest.source_total_spent_sum) !== archiveSpentSum ||
    manifest.source_sha256 !== archiveSha256
  ) {
    throw new Error('v20 wallet migration manifest does not match the legacy archive');
  }
}

module.exports = {
  migrateGlobalWalletV20,
  verifyGlobalWalletV20Schema,
};
