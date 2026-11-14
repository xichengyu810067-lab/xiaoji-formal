'use strict';

// Each player's farm and kitchen, kept as one checked JSON state per Discord account (shared by every guild, like the
// wallet) in the coin database. Every action loads the state, settles it to now (withered crops, the Taiwan day),
// applies one rule of farmRules and writes it back in the same coin transaction as the coins it moves, so a crop is
// never sold without the coins arriving and seeds are never planted without being paid for.
//
// The tables are the farm's own and are created here when first used; the coin schema version is not touched.

const { withCoinTransaction } = require('../../services/coinDatabase');
const { ensureGuildEconomyRowWithApi, readGuildEconomyEnabledWithApi } = require('../economy/coinService');
const { getWalletPlayerWithApi, mutateWalletWithApi } = require('../economy/coinWalletService');
const { FARM_RULES } = require('./farmCatalog');
const rules = require('./farmRules');

const { FarmError } = rules;

const FarmTransactionType = Object.freeze({
  PURCHASE: 'farm_purchase',
  SALE: 'farm_sale',
});

const FARM_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS farm_states (
  user_id TEXT PRIMARY KEY NOT NULL,
  state_json TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS farm_gift_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  giver_id TEXT NOT NULL,
  receiver_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  recipe_key TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_farm_gift_log_giver ON farm_gift_log (giver_id, created_at);
CREATE INDEX IF NOT EXISTS idx_farm_gift_log_receiver ON farm_gift_log (receiver_id, created_at);
`;

const MAX_STATE_JSON_BYTES = 64 * 1024;

function installFarmSchema(api) {
  api.run(FARM_SCHEMA_SQL);
}

function requireId(value, label) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,30}$/u.test(text)) throw new FarmError('FARM_INVALID_ARGUMENT', `${label} is required.`);
  return text;
}

function requireTime(now) {
  const time = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isSafeInteger(time) || time < 0) throw new TypeError('now must be a valid time.');
  return time;
}

function loadState(api, userId) {
  const row = api.get('SELECT state_json, revision FROM farm_states WHERE user_id = ?', [userId]);
  if (!row) return { state: rules.createFarmState(), revision: null };
  let raw = null;
  try {
    raw = JSON.parse(row.state_json);
  } catch (_error) {
    raw = null;
  }
  return { state: rules.normalizeFarmState(raw), revision: Number(row.revision) };
}

function saveState(api, userId, state, revision, time) {
  const json = JSON.stringify(state);
  if (Buffer.byteLength(json) > MAX_STATE_JSON_BYTES) throw new FarmError('FARM_STATE_TOO_LARGE', 'Farm state is too large.');
  const timestamp = new Date(time).toISOString();
  if (revision === null) {
    api.run(
      'INSERT INTO farm_states (user_id, state_json, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
      [userId, json, timestamp, timestamp],
    );
    return;
  }
  api.run('UPDATE farm_states SET state_json = ?, revision = revision + 1, updated_at = ? WHERE user_id = ? AND revision = ?',
    [json, timestamp, userId, revision]);
  if (Number(api.get('SELECT changes() AS count').count) !== 1) {
    throw new FarmError('FARM_STATE_CONFLICT', 'Farm state changed during the action.');
  }
}

function assertCoinsEnabled(api, guildId, time) {
  ensureGuildEconomyRowWithApi(api, guildId, new Date(time).toISOString());
  if (Number(readGuildEconomyEnabledWithApi(api, guildId)) !== 1) {
    throw new FarmError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用，農場買賣要等管理員重新開啟吉幣。');
  }
}

function chargeCoins(api, { guildId, userId, cost, reason, metadata, time }) {
  assertCoinsEnabled(api, guildId, time);
  const player = getWalletPlayerWithApi(api, guildId, userId);
  if (player.balance < cost) {
    throw new FarmError('INSUFFICIENT_FUNDS', `吉幣不夠：需要 ${cost} 吉幣，你目前有 ${player.balance} 吉幣。`,
      { balance: player.balance, required: cost });
  }
  return mutateWalletWithApi(api, {
    guildId, userId, type: FarmTransactionType.PURCHASE, balanceDelta: -cost, totalSpentDelta: cost,
    operatorId: null, reason, metadata, createdAt: new Date(time).toISOString(),
  });
}

function payCoins(api, { guildId, userId, amount, reason, metadata, time }) {
  return mutateWalletWithApi(api, {
    guildId, userId, type: FarmTransactionType.SALE, balanceDelta: amount, totalEarnedDelta: amount,
    debtOffset: true, operatorId: null, reason, metadata, createdAt: new Date(time).toISOString(),
  });
}

function balanceOf(api, guildId, userId) {
  return getWalletPlayerWithApi(api, guildId, userId).balance;
}

// Runs one action on the caller's settled farm and saves what it returns as `state`.
async function runFarmAction(guildId, userId, now, action) {
  const guild = requireId(guildId, 'guildId');
  const user = requireId(userId, 'userId');
  const time = requireTime(now);
  return withCoinTransaction((api) => {
    installFarmSchema(api);
    const loaded = loadState(api, user);
    const settled = rules.settleFarm(loaded.state, time);
    const result = action({ api, guildId: guild, userId: user, time, state: settled.state });
    saveState(api, user, result.state, loaded.revision, time);
    return { ...result, withered: settled.withered, time };
  });
}

async function viewFarm(guildId, userId, { now = Date.now() } = {}) {
  return runFarmAction(guildId, userId, now, ({ state }) => ({ state }));
}

async function plant(guildId, userId, { crop, plot = null, now = Date.now() } = {}) {
  return runFarmAction(guildId, userId, now, ({ api, guildId: guild, userId: user, time, state }) => {
    const result = rules.plantCrop(state, crop, plot, time);
    chargeCoins(api, { guildId: guild, userId: user, cost: result.cost, time,
      reason: `農場種子：${result.crop.name} x${result.plots.length}`,
      metadata: { crop: result.crop.key, plots: result.plots.map((index) => index + 1) } });
    return { ...result, balance: balanceOf(api, guild, user) };
  });
}

async function water(guildId, userId, { now = Date.now() } = {}) {
  return runFarmAction(guildId, userId, now, ({ time, state }) => rules.waterFarm(state, time));
}

async function harvest(guildId, userId, { now = Date.now() } = {}) {
  return runFarmAction(guildId, userId, now, ({ time, state }) => rules.harvestFarm(state, time));
}

async function fertilize(guildId, userId, { plot, now = Date.now() } = {}) {
  return runFarmAction(guildId, userId, now, ({ api, guildId: guild, userId: user, time, state }) => {
    const result = rules.fertilizePlot(state, plot, time);
    chargeCoins(api, { guildId: guild, userId: user, cost: result.cost, time,
      reason: `農場化肥：第 ${result.plot + 1} 格`, metadata: { plot: result.plot + 1, effect: result.effect } });
    return { ...result, balance: balanceOf(api, guild, user) };
  });
}

async function expand(guildId, userId, { now = Date.now() } = {}) {
  return runFarmAction(guildId, userId, now, ({ api, guildId: guild, userId: user, time, state }) => {
    const result = rules.expandFarm(state);
    chargeCoins(api, { guildId: guild, userId: user, cost: result.cost, time,
      reason: `農場擴充：第 ${result.plot + 1} 格`, metadata: { plot: result.plot + 1 } });
    return { ...result, balance: balanceOf(api, guild, user) };
  });
}

async function reclaim(guildId, userId, { plot, now = Date.now() } = {}) {
  return runFarmAction(guildId, userId, now, ({ api, guildId: guild, userId: user, time, state }) => {
    const result = rules.reclaimPlot(state, plot);
    chargeCoins(api, { guildId: guild, userId: user, cost: result.cost, time,
      reason: `農場重新開墾：第 ${result.plot + 1} 格`, metadata: { plot: result.plot + 1 } });
    return { ...result, balance: balanceOf(api, guild, user) };
  });
}

// kind is 'crop' (the farm's barn) or 'dish' (own dishes from the kitchen).
async function sell(guildId, userId, { kind, key = null, quantity = null, now = Date.now() } = {}) {
  if (!['crop', 'dish'].includes(kind)) throw new FarmError('FARM_INVALID_ARGUMENT', 'kind must be crop or dish.');
  return runFarmAction(guildId, userId, now, ({ api, guildId: guild, userId: user, time, state }) => {
    assertCoinsEnabled(api, guild, time);
    const result = rules.sellGoods(state, { kind, key, quantity }, time);
    const label = kind === 'crop' ? '農場出售作物' : '廚房出售料理';
    const mutation = payCoins(api, { guildId: guild, userId: user, amount: result.total, time,
      reason: `${label}：${result.sold.map((entry) => `${entry.name} x${entry.quantity}`).join('、')}`,
      metadata: { kind, sold: result.sold.map(({ key: itemKey, quantity: count, amount }) => ({ key: itemKey, quantity: count, amount })) } });
    return { ...result, debtOffset: Number(mutation?.debtOffset || 0), balance: balanceOf(api, guild, user) };
  });
}

async function cook(guildId, userId, { recipe, quantity = 1, now = Date.now() } = {}) {
  return runFarmAction(guildId, userId, now, ({ time, state }) => rules.cookDish(state, recipe, quantity, time));
}

async function eat(guildId, userId, { recipe, now = Date.now() } = {}) {
  return runFarmAction(guildId, userId, now, ({ time, state }) => rules.eatDish(state, recipe, time));
}

async function gift(guildId, userId, { receiverId, recipe, quantity = 1, now = Date.now() } = {}) {
  const guild = requireId(guildId, 'guildId');
  const giver = requireId(userId, 'userId');
  const receiver = requireId(receiverId, 'receiverId');
  if (giver === receiver) throw new FarmError('FARM_GIFT_SELF', '料理不能送給自己，想吃就用 /kitchen eat。');
  const time = requireTime(now);
  return withCoinTransaction((api) => {
    installFarmSchema(api);
    const giverLoaded = loadState(api, giver);
    const receiverLoaded = loadState(api, receiver);
    const giverState = rules.settleFarm(giverLoaded.state, time).state;
    const receiverState = rules.settleFarm(receiverLoaded.state, time).state;
    const result = rules.giftDish(giverState, receiverState, recipe, quantity, time);
    saveState(api, giver, result.giver, giverLoaded.revision, time);
    saveState(api, receiver, result.receiver, receiverLoaded.revision, time);
    api.run(
      `INSERT INTO farm_gift_log (giver_id, receiver_id, guild_id, recipe_key, quantity, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [giver, receiver, guild, result.recipe.key, result.quantity, new Date(time).toISOString()],
    );
    return { recipe: result.recipe, quantity: result.quantity, giftsLeft: result.giftsLeft, state: result.giver, time };
  });
}

module.exports = {
  FARM_RULES,
  FARM_SCHEMA_SQL,
  FarmError,
  FarmTransactionType,
  cook,
  eat,
  expand,
  fertilize,
  gift,
  harvest,
  installFarmSchema,
  plant,
  reclaim,
  sell,
  viewFarm,
  water,
};
