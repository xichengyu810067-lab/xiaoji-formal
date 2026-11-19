'use strict';

// The farm and kitchen against a real, isolated coin database: seeds and land are paid from the global wallet, sales
// are paid into it under the daily cap, a refused action changes nothing, a guild with coins turned off still lets
// members tend their farm but not buy or sell, and gifts move dishes between two farms in one transaction.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-farm-'));
process.env.COIN_DB_PATH = path.join(root, 'farm.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

const { initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinDatabase } = require('../src/systems/economy/storage/coinDatabase');
const { adjustPlayerBalance, setGuildEconomyEnabled } = require('../src/systems/economy/coinService');
const { HOUR_MS, MINUTE_MS } = require('../src/systems/farm/farmCatalog');
const farm = require('../src/systems/farm/farmService');
const { FarmError } = require('../src/systems/farm/farmRules');

const GUILD_ID = '771000000000000001';
const OFF_GUILD_ID = '771000000000000002';
const T0 = Date.UTC(2026, 10, 13, 2, 0, 0);
let sequence = 0;

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

async function memberWith(coins) {
  sequence += 1;
  const userId = `77200000000000${String(sequence).padStart(4, '0')}`;
  if (coins > 0) {
    await adjustPlayerBalance(GUILD_ID, userId, { action: 'add', amount: coins, operatorId: 'farm-admin', reason: '測試資料' });
  }
  return userId;
}

const balanceOf = (userId) => withCoinDatabase((api) => Number(
  api.get('SELECT balance FROM coin_wallets WHERE user_id = ?', [userId])?.balance ?? 0));
const farmTransactions = (userId) => withCoinDatabase((api) => api.all(
  "SELECT type, amount FROM coin_transactions WHERE user_id = ? AND type LIKE 'farm_%' ORDER BY id", [userId])
  .map((row) => ({ type: row.type, amount: Number(row.amount) })));
const stateRow = (userId) => withCoinDatabase((api) => api.get('SELECT state_json, revision FROM farm_states WHERE user_id = ?', [userId]));

async function refusal(promise) {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof FarmError, `expected a FarmError, got ${error?.stack || error}`);
    return error.code;
  }
  assert.fail('expected the farm to refuse');
}

test('播種從全域錢包扣種子錢，收成後出售入帳，帳務類型是農場支出與出售', async () => {
  const userId = await memberWith(100);
  const planted = await farm.plant(GUILD_ID, userId, { crop: 'cabbage', now: T0 });
  assert.equal(planted.cost, 20);
  assert.equal(planted.balance, 80);
  const harvest = await farm.harvest(GUILD_ID, userId, { now: T0 + 10 * MINUTE_MS });
  assert.equal(harvest.harvested.length, 4);
  const sale = await farm.sell(GUILD_ID, userId, { kind: 'crop', now: T0 + 10 * MINUTE_MS });
  assert.equal(sale.total, 32);
  assert.equal(await balanceOf(userId), 112);
  assert.deepEqual(await farmTransactions(userId), [
    { type: 'farm_purchase', amount: -20 },
    { type: 'farm_sale', amount: 32 },
  ]);
});

test('吉幣不夠時什麼都不變：沒扣錢、沒種下、農場沒改', async () => {
  const userId = await memberWith(50);
  await farm.viewFarm(GUILD_ID, userId, { now: T0 });
  const before = await stateRow(userId);
  assert.equal(await refusal(farm.plant(GUILD_ID, userId, { crop: 'pumpkin', now: T0 })), 'INSUFFICIENT_FUNDS');
  assert.equal(await refusal(farm.expand(GUILD_ID, userId, { now: T0 })), 'INSUFFICIENT_FUNDS');
  assert.deepEqual(await stateRow(userId), before);
  assert.equal(await balanceOf(userId), 50);
  assert.deepEqual(await farmTransactions(userId), []);
});

test('每日出售上限 500 吉幣跟著帳號走，換伺服器也不會重算', async () => {
  const userId = await memberWith(10_000);
  for (let index = 0; index < 4; index += 1) await farm.expand(GUILD_ID, userId, { now: T0 });
  await farm.plant(GUILD_ID, userId, { crop: 'pumpkin', now: T0 });
  await farm.harvest(GUILD_ID, userId, { now: T0 + 8 * HOUR_MS });
  const crops = await farm.sell(GUILD_ID, userId, { kind: 'crop', quantity: 8, key: 'pumpkin', now: T0 + 8 * HOUR_MS });
  assert.equal(crops.total, 448);
  const otherGuild = '771000000000000009';
  assert.equal(await refusal(farm.sell(otherGuild, userId, { kind: 'crop', now: T0 + 8 * HOUR_MS })), 'FARM_SALE_CAP');
  const view = await farm.viewFarm(otherGuild, userId, { now: T0 + 8 * HOUR_MS });
  assert.equal(view.state.daily.sold, 448);
  assert.equal(view.state.crops.pumpkin, 8);
});

test('伺服器停用吉幣時不能買賣，但仍可澆水與收成', async () => {
  const userId = await memberWith(100);
  await farm.plant(GUILD_ID, userId, { crop: 'cabbage', plot: 1, now: T0 });
  await setGuildEconomyEnabled(OFF_GUILD_ID, false, { operatorId: 'farm-admin' });
  assert.equal(await refusal(farm.plant(OFF_GUILD_ID, userId, { crop: 'cabbage', plot: 2, now: T0 })), 'COIN_DISABLED');
  await farm.water(OFF_GUILD_ID, userId, { now: T0 + MINUTE_MS });
  const harvest = await farm.harvest(OFF_GUILD_ID, userId, { now: T0 + 10 * MINUTE_MS });
  assert.equal(harvest.harvested[0].count, 2);
  assert.equal(await refusal(farm.sell(OFF_GUILD_ID, userId, { kind: 'crop', now: T0 + 10 * MINUTE_MS })), 'COIN_DISABLED');
  assert.equal(await balanceOf(userId), 95);
});

test('送禮：料理從送禮者移到收禮者的禮物，寫入送禮紀錄；收到的只能吃', async () => {
  const giver = await memberWith(1000);
  const receiver = await memberWith(0);
  await farm.plant(GUILD_ID, giver, { crop: 'cabbage', now: T0 });
  await farm.harvest(GUILD_ID, giver, { now: T0 + 10 * MINUTE_MS });
  await farm.cook(GUILD_ID, giver, { recipe: 'cabbage-salad', quantity: 2, now: T0 + 10 * MINUTE_MS });
  assert.equal(await refusal(farm.gift(GUILD_ID, giver, { receiverId: giver, recipe: 'cabbage-salad', now: T0 })),
    'FARM_GIFT_SELF');
  const result = await farm.gift(GUILD_ID, giver, { receiverId: receiver, recipe: 'cabbage-salad', quantity: 2,
    now: T0 + 11 * MINUTE_MS });
  assert.equal(result.giftsLeft, 3);
  const received = await farm.viewFarm(GUILD_ID, receiver, { now: T0 + 11 * MINUTE_MS });
  assert.deepEqual(received.state.gifts, { 'cabbage-salad': 2 });
  assert.equal(await refusal(farm.sell(GUILD_ID, receiver, { kind: 'dish', now: T0 + 11 * MINUTE_MS })), 'FARM_NOTHING_TO_SELL');
  const ate = await farm.eat(GUILD_ID, receiver, { recipe: 'cabbage-salad', now: T0 + 12 * MINUTE_MS });
  assert.equal(ate.source, 'gift');
  const log = await withCoinDatabase((api) => api.all('SELECT giver_id, receiver_id, recipe_key, quantity FROM farm_gift_log'));
  assert.deepEqual(log.map((row) => ({ ...row, quantity: Number(row.quantity) })),
    [{ giver_id: giver, receiver_id: receiver, recipe_key: 'cabbage-salad', quantity: 2 }]);
});
