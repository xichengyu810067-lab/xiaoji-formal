const { randomInt } = require('node:crypto');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  CoinServiceError,
  ShopItemTypes,
  ensureGuildSettings,
  ensurePlayer,
} = require('./coinService');
const {
  ChipLedgerType,
  creditChipsWithApi,
  debitChipsForCasinoWithApi,
  normalizeAmount,
} = require('./chipService');

const MAX_LODGING_NIGHTS = 30;
const DEFAULT_HISTORY_LIMIT = 10;
const MAX_HISTORY_LIMIT = 25;

const RoomTypes = Object.freeze({
  standard: Object.freeze({ type: 'standard', name: '標準客房', nightlyRate: 80 }),
  deluxe: Object.freeze({ type: 'deluxe', name: '豪華套房', nightlyRate: 300 }),
  suite: Object.freeze({ type: 'suite', name: '頂級貴賓房', nightlyRate: 1000 }),
});

const towerOpponents = Object.freeze([
  '塔台見習守衛',
  '籌碼廳護衛',
  '奢侈品街保鑣',
  '吧檯巡場員',
  '高塔決鬥官',
  '貴賓廳守門人',
]);

function nowIso(date = new Date()) {
  return date.toISOString();
}

function addDaysIso(date, days) {
  const next = new Date(date.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString();
}

function defaultRng(maxExclusive) {
  return randomInt(maxExclusive);
}

function normalizeLimit(limit) {
  const value = Number(limit || DEFAULT_HISTORY_LIMIT);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, MAX_HISTORY_LIMIT) : DEFAULT_HISTORY_LIMIT;
}

function normalizeNights(value) {
  const nights = Number(value);

  if (!Number.isSafeInteger(nights) || nights <= 0 || nights > MAX_LODGING_NIGHTS) {
    throw new CoinServiceError('INVALID_LODGING_NIGHTS', `住宿天數必須是 1 到 ${MAX_LODGING_NIGHTS} 天。`);
  }

  return nights;
}

function normalizeRoomType(value) {
  const roomType = String(value || '').trim().toLowerCase();
  const room = RoomTypes[roomType];

  if (!room) {
    throw new CoinServiceError('INVALID_ROOM_TYPE', '住宿房型只能選 standard、deluxe 或 suite。');
  }

  return room;
}

function parseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function serializeJson(value) {
  return JSON.stringify(value || {});
}

function assertEconomyEnabled(settings) {
  if (!settings.enabled) {
    throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  }
}

function mapLodging(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    roomType: row.room_type,
    roomName: row.room_name,
    nights: Number(row.nights),
    chipAmount: Number(row.chip_amount),
    status: row.status,
    checkInAt: row.check_in_at,
    checkOutAt: row.check_out_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapWeapon(row) {
  return {
    itemId: String(row.item_id),
    itemName: row.item_name,
    quantity: Number(row.quantity),
    price: Number(row.price || 0),
    description: row.description || '',
  };
}

function mapDuelRun(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    weaponItemId: String(row.weapon_item_id),
    weaponName: row.weapon_name,
    wagerAmount: Number(row.wager_amount),
    floor: Number(row.floor),
    opponentName: row.opponent_name,
    playerPower: Number(row.player_power),
    opponentPower: Number(row.opponent_power),
    status: row.status,
    payoutAmount: Number(row.payout_amount),
    netAmount: Number(row.net_amount),
    result: parseJson(row.result_json, {}),
    createdAt: row.created_at,
  };
}

function getOwnedBattleWeaponRow(api, guildId, userId, itemId) {
  return api.get(
    `SELECT ci.item_id, ci.item_name, ci.quantity, si.price, si.description
     FROM coin_global_inventory ci
     JOIN coin_global_shop_items si ON si.id = ci.item_id
     WHERE ci.user_id = ?
       AND ci.item_id = ?
       AND ci.quantity > 0
       AND si.type = ?
     LIMIT 1`,
    [userId, itemId, ShopItemTypes.BATTLE_ITEM]
  );
}

function calculateWeaponPower(weapon) {
  const pricePower = Math.min(220, Math.floor(Number(weapon.price || 0) / 100));
  const quantityPower = Math.min(60, Number(weapon.quantity || 1) * 5);
  return 30 + pricePower + quantityPower;
}

function getNextTowerFloor(api, guildId, userId) {
  const row = api.get(
    `SELECT COUNT(*) AS wins
     FROM casino_duel_tower_runs
     WHERE guild_id = ? AND user_id = ? AND status = 'win'`,
    [guildId, userId]
  );
  return Number(row?.wins || 0) + 1;
}

async function getCasinoLobby() {
  return {
    areas: [
      { name: '決鬥塔台', command: '/duel-tower weapons / enter / history', description: '使用吉幣商店的對戰技能道具進行塔台決鬥。' },
      { name: '酒水吧檯與餐廳', command: '/casino-venue', description: '點飲料與餐點，指定調酒師、廚師與服務生。' },
      { name: '住宿', command: '/casino-lobby stay', description: '使用籌碼登記賭場客房。' },
      { name: '下注區', command: '/casino dice / slots / blackjack / roulette / baccarat / poker', description: '所有賭場遊戲優先使用籌碼。' },
      { name: '貸幣兌換區', command: '/exchange', description: '吉幣與籌碼兌換，以及籌碼換回吉幣。' },
      { name: '當鋪', command: '/pawn', description: '典當或贖回奢侈品商店街商品。' },
      { name: '奢侈品商店街', command: '/luxury', description: '獨立於吉幣商店的名牌包、項鍊、首飾、手錶等商品。' },
    ],
    rooms: Object.values(RoomTypes),
  };
}

async function bookLodging(guildId, userId, { roomType, nights, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    ensurePlayer(api, guildId, userId);

    const room = normalizeRoomType(roomType);
    const normalizedNights = normalizeNights(nights);
    const chipAmount = room.nightlyRate * normalizedNights;
    const timestamp = nowIso(date);
    const checkOutAt = addDaysIso(date, normalizedNights);
    const debit = debitChipsForCasinoWithApi(api, guildId, userId, chipAmount, {
      timestamp,
      entryType: ChipLedgerType.LODGING,
      reason: `賭場住宿：${room.name}`,
      metadata: { roomType: room.type, nights: normalizedNights },
    });

    api.run(
      `INSERT INTO casino_lodging_bookings
        (guild_id, user_id, room_type, room_name, nights, chip_amount, status, check_in_at, check_out_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?)`,
      [guildId, userId, room.type, room.name, normalizedNights, chipAmount, timestamp, checkOutAt, timestamp, timestamp]
    );

    const id = Number(api.get('SELECT last_insert_rowid() AS id').id);
    return {
      booking: mapLodging(api.get('SELECT * FROM casino_lodging_bookings WHERE id = ?', [id])),
      balanceAfter: debit.balanceAfter,
      autoTopUpAmount: debit.autoTopUpAmount,
    };
  });
}

async function listLodging(guildId, userId, { limit = DEFAULT_HISTORY_LIMIT } = {}) {
  return withCoinDatabase((api) =>
    api
      .all(
        `SELECT *
         FROM casino_lodging_bookings
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [guildId, userId, normalizeLimit(limit)]
      )
      .map(mapLodging)
  );
}

async function listOwnedBattleWeapons(guildId, userId) {
  return withCoinDatabase((api) =>
    api
      .all(
        `SELECT ci.item_id, ci.item_name, ci.quantity, si.price, si.description
         FROM coin_global_inventory ci
         JOIN coin_global_shop_items si ON si.id = ci.item_id
         WHERE ci.user_id = ?
           AND ci.quantity > 0
           AND si.type = ?
         ORDER BY si.price DESC, ci.item_id ASC`,
        [userId, ShopItemTypes.BATTLE_ITEM]
      )
      .map(mapWeapon)
  );
}

async function getDuelTowerProfile(guildId, userId) {
  return withCoinDatabase((api) => {
    const row = api.get(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'win' THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN status = 'loss' THEN 1 ELSE 0 END) AS losses,
         SUM(net_amount) AS net
       FROM casino_duel_tower_runs
       WHERE guild_id = ? AND user_id = ?`,
      [guildId, userId]
    );
    return {
      total: Number(row?.total || 0),
      wins: Number(row?.wins || 0),
      losses: Number(row?.losses || 0),
      netAmount: Number(row?.net || 0),
      nextFloor: getNextTowerFloor(api, guildId, userId),
    };
  });
}

async function enterDuelTower(guildId, userId, { weaponItemId, wager, rng = defaultRng, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const settings = ensureGuildSettings(api, guildId);
    assertEconomyEnabled(settings);
    ensurePlayer(api, guildId, userId);

    const itemId = String(weaponItemId || '').trim();
    if (!/^g_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(itemId)) {
      throw new CoinServiceError('INVALID_WEAPON_ITEM_ID', '武器商品 ID 不正確。');
    }

    const weaponRow = getOwnedBattleWeaponRow(api, guildId, userId, itemId);
    if (!weaponRow) {
      throw new CoinServiceError('BATTLE_WEAPON_REQUIRED', '你需要先在吉幣商店購買對戰技能道具，才能進入決鬥塔台。');
    }

    const wagerAmount = normalizeAmount(wager, '決鬥籌碼');
    const floor = getNextTowerFloor(api, guildId, userId);
    const timestamp = nowIso(date);
    const weapon = mapWeapon(weaponRow);
    const weaponPower = calculateWeaponPower(weapon);
    const opponentName = towerOpponents[(floor - 1) % towerOpponents.length];
    const playerPower = weaponPower + floor * 8 + rng(60);
    const opponentPower = 35 + floor * 14 + rng(80);
    const debit = debitChipsForCasinoWithApi(api, guildId, userId, wagerAmount, {
      timestamp,
      entryType: ChipLedgerType.DUEL_BET,
      reason: `決鬥塔台下注：${weapon.itemName}`,
      metadata: { weaponItemId: itemId, floor },
    });

    let status = 'loss';
    let payoutAmount = 0;
    if (Math.abs(playerPower - opponentPower) <= 3) {
      status = 'draw';
      payoutAmount = wagerAmount;
    } else if (playerPower > opponentPower) {
      status = 'win';
      payoutAmount = wagerAmount * 2;
    }

    const payout =
      payoutAmount > 0
        ? creditChipsWithApi(api, guildId, userId, payoutAmount, {
            timestamp,
            entryType: ChipLedgerType.DUEL_PAYOUT,
            debtOffsetAmount: Math.max(payoutAmount - wagerAmount, 0),
            reason: `決鬥塔台結算：${status}`,
            metadata: {
              weaponItemId: itemId,
              floor,
              status,
              wagerAmount,
              payoutAmount,
              eligibleIncome: Math.max(payoutAmount - wagerAmount, 0),
            },
          })
        : { balanceAfter: debit.balanceAfter };
    const netAmount = payoutAmount - wagerAmount;
    const result = { weaponPower, playerPower, opponentPower };

    api.run(
      `INSERT INTO casino_duel_tower_runs
        (guild_id, user_id, weapon_item_id, weapon_name, wager_amount, floor, opponent_name,
         player_power, opponent_power, status, payout_amount, net_amount, result_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guildId,
        userId,
        weapon.itemId,
        weapon.itemName,
        wagerAmount,
        floor,
        opponentName,
        playerPower,
        opponentPower,
        status,
        payoutAmount,
        netAmount,
        serializeJson(result),
        timestamp,
      ]
    );

    const id = Number(api.get('SELECT last_insert_rowid() AS id').id);
    return {
      run: mapDuelRun(api.get('SELECT * FROM casino_duel_tower_runs WHERE id = ?', [id])),
      weapon,
      balanceAfter: payout.balanceAfter,
      autoTopUpAmount: debit.autoTopUpAmount,
    };
  });
}

async function getDuelTowerHistory(guildId, userId, { limit = DEFAULT_HISTORY_LIMIT } = {}) {
  return withCoinDatabase((api) =>
    api
      .all(
        `SELECT *
         FROM casino_duel_tower_runs
         WHERE guild_id = ? AND user_id = ?
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [guildId, userId, normalizeLimit(limit)]
      )
      .map(mapDuelRun)
  );
}

module.exports = {
  MAX_LODGING_NIGHTS,
  RoomTypes,
  bookLodging,
  enterDuelTower,
  getCasinoLobby,
  getDuelTowerHistory,
  getDuelTowerProfile,
  listLodging,
  listOwnedBattleWeapons,
};
