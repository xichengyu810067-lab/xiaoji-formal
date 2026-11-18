const logger = require('../../../../utils/logger');
const { getRow, getRows, getTableColumns, requireColumns, runSql, verifyIntegrity } = require('../sqlHelpers');

// v21: global daily check-ins, stores and debt.
function addIsoDays(dateString, days) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateString || ''));
  if (!match) throw new Error(`invalid calendar date: ${dateString}`);
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days));
  const normalized = date.toISOString().slice(0, 10);
  if (days === 0 && normalized !== dateString) throw new Error(`invalid calendar date: ${dateString}`);
  return normalized;
}

const taipeiDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Taipei',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function normalizeLegacyDailyTimestamp(value) {
  const text = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})([ T])(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z)?$/.exec(text);
  if (!match || (match[4] === 'T' && match[9] !== 'Z') || (match[4] === ' ' && match[9])) {
    throw new Error('legacy daily check-in contains an invalid UTC timestamp');
  }
  const [, yearText, monthText, dayText, , hourText, minuteText, secondText, millisecondText = '0'] = match;
  const parts = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const milliseconds = Number(millisecondText.padEnd(3, '0'));
  const instant = new Date(Date.UTC(...parts.slice(0, 3).map((part, index) => index === 1 ? part - 1 : part), ...parts.slice(3), milliseconds));
  if (
    instant.getUTCFullYear() !== parts[0] ||
    instant.getUTCMonth() !== parts[1] - 1 ||
    instant.getUTCDate() !== parts[2] ||
    instant.getUTCHours() !== parts[3] ||
    instant.getUTCMinutes() !== parts[4] ||
    instant.getUTCSeconds() !== parts[5]
  ) {
    throw new Error('legacy daily check-in contains an invalid UTC timestamp');
  }
  const dateParts = Object.fromEntries(
    taipeiDateFormatter.formatToParts(instant)
      .filter((part) => part.type === 'year' || part.type === 'month' || part.type === 'day')
      .map((part) => [part.type, part.value])
  );
  return {
    checkinDate: `${dateParts.year}-${dateParts.month}-${dateParts.day}`,
    instantMs: instant.getTime(),
  };
}

function migrateGlobalEconomyV21(db, currentVersion) {
  if (currentVersion >= 21) return false;

  for (const [tableName, columns] of Object.entries({
    coin_daily_checkins_global: ['user_id', 'checkin_date', 'source_guild_id', 'earned_amount', 'bonus_amount', 'streak', 'created_at'],
    coin_daily_state: ['user_id', 'last_checkin_date', 'streak', 'updated_at'],
    coin_debts: ['user_id', 'amount', 'created_at', 'updated_at'],
    coin_global_shop_items: ['id', 'name', 'price', 'type', 'stock', 'purchase_limit', 'source_guild_id'],
    coin_global_inventory: ['user_id', 'item_id', 'quantity'],
    coin_global_purchases: ['source_guild_id', 'user_id', 'item_id', 'quantity', 'total_price'],
    luxury_global_items: ['id', 'name', 'price', 'stock', 'purchase_limit', 'source_guild_id'],
    luxury_global_inventory: ['user_id', 'item_id', 'quantity'],
    luxury_global_purchases: ['source_guild_id', 'user_id', 'item_id', 'quantity', 'unit_price', 'total_price'],
    luxury_global_pawn_records: ['source_guild_id', 'user_id', 'item_id', 'quantity', 'remaining_quantity', 'payout_amount'],
  })) {
    requireColumns(db, tableName, columns);
  }

  const targetCount = Number(getRow(
    db,
    `SELECT (SELECT COUNT(*) FROM coin_daily_checkins_global) +
            (SELECT COUNT(*) FROM coin_daily_state) +
            (SELECT COUNT(*) FROM coin_debts) +
            (SELECT COUNT(*) FROM coin_global_shop_items) +
            (SELECT COUNT(*) FROM coin_global_inventory) +
            (SELECT COUNT(*) FROM coin_global_purchases) +
            (SELECT COUNT(*) FROM luxury_global_items) +
            (SELECT COUNT(*) FROM luxury_global_price_history) +
            (SELECT COUNT(*) FROM luxury_global_inventory) +
            (SELECT COUNT(*) FROM luxury_global_purchases) +
            (SELECT COUNT(*) FROM luxury_global_pawn_records) +
            (SELECT COUNT(*) FROM luxury_global_pawn_redemptions) AS count`
  ).count);
  if (targetCount !== 0) throw new Error('v21 authority targets must be empty before migration');

  const sourceRows = getRows(
    db,
    `SELECT id, guild_id, user_id, checkin_date, earned_amount, bonus_amount, created_at
     FROM coin_daily_checkins
     ORDER BY id`
  );
  const normalizedRows = sourceRows.map((row) => {
    const userId = String(row.user_id || '').trim();
    const guildId = String(row.guild_id || '').trim();
    addIsoDays(String(row.checkin_date || ''), 0);
    if (!userId || !guildId || !String(row.created_at || '').trim()) {
      throw new Error('legacy daily check-in contains an invalid identity or timestamp');
    }
    const normalizedTimestamp = normalizeLegacyDailyTimestamp(row.created_at);
    for (const value of [row.earned_amount, row.bonus_amount]) {
      if (!Number.isSafeInteger(Number(value)) || Number(value) < 0) {
        throw new Error(`legacy daily check-in contains an invalid amount for ${userId}/${normalizedTimestamp.checkinDate}`);
      }
    }
    if (!getRow(db, 'SELECT 1 AS found FROM coin_wallets WHERE user_id = ?', [userId])) {
      throw new Error(`legacy daily check-in has no global wallet: ${userId}/${normalizedTimestamp.checkinDate}`);
    }
    return {
      id: Number(row.id),
      userId,
      guildId,
      checkinDate: normalizedTimestamp.checkinDate,
      instantMs: normalizedTimestamp.instantMs,
      earnedAmount: Number(row.earned_amount),
      bonusAmount: Number(row.bonus_amount),
      createdAt: String(row.created_at),
    };
  }).sort((left, right) =>
    left.userId.localeCompare(right.userId) ||
    left.checkinDate.localeCompare(right.checkinDate) ||
    left.instantMs - right.instantMs ||
    left.id - right.id
  );
  const distinctRows = [];
  const seen = new Set();
  for (const row of normalizedRows) {
    const key = `${row.userId}\u0000${row.checkinDate}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinctRows.push(row);
  }

  let started = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    started = true;
    const duelWeaponColumn = getTableColumns(db, 'casino_duel_tower_runs')
      .find((column) => column.name === 'weapon_item_id');
    if (!duelWeaponColumn || duelWeaponColumn.type !== 'TEXT') {
      db.exec(`
        CREATE TABLE casino_duel_tower_runs_v21_rebuild (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          guild_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          weapon_item_id TEXT NOT NULL,
          weapon_name TEXT NOT NULL,
          wager_amount INTEGER NOT NULL,
          floor INTEGER NOT NULL,
          opponent_name TEXT NOT NULL,
          player_power INTEGER NOT NULL,
          opponent_power INTEGER NOT NULL,
          status TEXT NOT NULL,
          payout_amount INTEGER NOT NULL DEFAULT 0,
          net_amount INTEGER NOT NULL DEFAULT 0,
          result_json TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO casino_duel_tower_runs_v21_rebuild
          (id, guild_id, user_id, weapon_item_id, weapon_name, wager_amount, floor, opponent_name,
           player_power, opponent_power, status, payout_amount, net_amount, result_json, created_at)
        SELECT id, guild_id, user_id, CAST(weapon_item_id AS TEXT), weapon_name, wager_amount, floor, opponent_name,
               player_power, opponent_power, status, payout_amount, net_amount, result_json, created_at
        FROM casino_duel_tower_runs;
        DROP TABLE casino_duel_tower_runs;
        ALTER TABLE casino_duel_tower_runs_v21_rebuild RENAME TO casino_duel_tower_runs;
      `);
    }
    const stateByUser = new Map();
    for (const row of distinctRows) {
      const previous = stateByUser.get(row.userId);
      const streak = previous && addIsoDays(previous.date, 1) === row.checkinDate ? previous.streak + 1 : 1;
      runSql(
        db,
        `INSERT INTO coin_daily_checkins_global
          (user_id, checkin_date, source_guild_id, earned_amount, bonus_amount, streak, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [row.userId, row.checkinDate, row.guildId, row.earnedAmount, row.bonusAmount, streak, row.createdAt]
      );
      stateByUser.set(row.userId, { date: row.checkinDate, streak, updatedAt: row.createdAt });
    }
    for (const [userId, stateRow] of stateByUser) {
      runSql(
        db,
        `INSERT INTO coin_daily_state (user_id, last_checkin_date, streak, updated_at)
         VALUES (?, ?, ?, ?)`,
        [userId, stateRow.date, stateRow.streak, stateRow.updatedAt]
      );
    }
    if (Number(getRow(db, 'SELECT COUNT(*) AS count FROM coin_daily_checkins_global').count) !== distinctRows.length) {
      throw new Error('v21 daily migration row-count verification failed');
    }
    verifyIntegrity(db);
    db.exec('COMMIT');
    started = false;
    return true;
  } catch (error) {
    if (started) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { logger.error('Global economy v21 migration rollback failed', rollbackError); }
    }
    throw error;
  }
}

function verifyGlobalEconomyV21Schema(db) {
  for (const [tableName, columns] of Object.entries({
    coin_daily_checkins_global: ['user_id', 'checkin_date', 'source_guild_id', 'earned_amount', 'bonus_amount', 'streak', 'created_at'],
    coin_daily_state: ['user_id', 'last_checkin_date', 'streak', 'updated_at'],
    coin_debts: ['user_id', 'amount', 'created_at', 'updated_at'],
    coin_global_shop_items: ['id', 'name', 'description', 'price', 'type', 'enabled', 'deleted', 'stock', 'purchase_limit', 'created_by', 'source_guild_id', 'created_at', 'updated_at'],
    coin_global_inventory: ['user_id', 'item_id', 'item_name', 'quantity', 'acquired_at', 'updated_at'],
    coin_global_purchases: ['id', 'source_guild_id', 'user_id', 'item_id', 'item_name', 'quantity', 'total_price', 'item_type', 'status', 'created_at'],
    luxury_global_items: ['id', 'name', 'description', 'price', 'enabled', 'deleted', 'stock', 'purchase_limit', 'created_by', 'source_guild_id', 'created_at', 'updated_at'],
    luxury_global_price_history: ['id', 'item_id', 'price', 'changed_by', 'reason', 'created_at'],
    luxury_global_inventory: ['user_id', 'item_id', 'item_name', 'quantity', 'acquired_at', 'updated_at'],
    luxury_global_purchases: ['id', 'source_guild_id', 'user_id', 'item_id', 'item_name', 'quantity', 'unit_price', 'total_price', 'created_at'],
    luxury_global_pawn_records: ['id', 'source_guild_id', 'user_id', 'item_id', 'item_name', 'quantity', 'remaining_quantity', 'pawn_unit_price', 'payout_amount', 'redeemed_quantity', 'redeemed_amount', 'status', 'created_at', 'updated_at', 'redeemed_at'],
    luxury_global_pawn_redemptions: ['id', 'pawn_record_id', 'source_guild_id', 'user_id', 'item_id', 'item_name', 'quantity', 'redeem_unit_price', 'total_price', 'created_at'],
  })) {
    requireColumns(db, tableName, columns);
  }

  const invalidDebt = getRow(db, 'SELECT user_id FROM coin_debts WHERE amount < 0 OR typeof(amount) != \'integer\' LIMIT 1');
  if (invalidDebt) throw new Error(`invalid global debt row: ${invalidDebt.user_id}`);
  const invalidItem = getRow(
    db,
    `SELECT id FROM coin_global_shop_items
     WHERE substr(id, 1, 2) != 'g_' OR type = 'role'
     UNION ALL
     SELECT id FROM luxury_global_items WHERE substr(id, 1, 2) != 'l_'
     LIMIT 1`
  );
  if (invalidItem) throw new Error(`invalid global item id or type: ${invalidItem.id}`);
  const duelWeaponColumn = getTableColumns(db, 'casino_duel_tower_runs')
    .find((column) => column.name === 'weapon_item_id');
  if (!duelWeaponColumn || duelWeaponColumn.type !== 'TEXT') {
    throw new Error('casino duel weapon id is not compatible with global item ids');
  }

  const dailyRows = getRows(
    db,
    `SELECT user_id, checkin_date, streak
     FROM coin_daily_checkins_global
     ORDER BY user_id, checkin_date`
  );
  const expectedState = new Map();
  for (const row of dailyRows) {
    addIsoDays(row.checkin_date, 0);
    const previous = expectedState.get(row.user_id);
    const streak = previous && addIsoDays(previous.date, 1) === row.checkin_date ? previous.streak + 1 : 1;
    if (Number(row.streak) !== streak) throw new Error(`invalid global daily streak: ${row.user_id}/${row.checkin_date}`);
    expectedState.set(row.user_id, { date: row.checkin_date, streak });
  }
  const stateRows = getRows(db, 'SELECT user_id, last_checkin_date, streak FROM coin_daily_state');
  if (stateRows.length !== expectedState.size) throw new Error('global daily state count does not match history');
  for (const row of stateRows) {
    const expected = expectedState.get(row.user_id);
    if (!expected || expected.date !== row.last_checkin_date || expected.streak !== Number(row.streak)) {
      throw new Error(`global daily state does not match history: ${row.user_id}`);
    }
  }
  const foreignKeyFailure = getRow(db, 'PRAGMA foreign_key_check');
  if (foreignKeyFailure) throw new Error(`global economy foreign key failure: ${foreignKeyFailure.table}`);
}

module.exports = {
  migrateGlobalEconomyV21,
  verifyGlobalEconomyV21Schema,
};
