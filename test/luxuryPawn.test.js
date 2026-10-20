'use strict';

// The pawn shop against a real, isolated coin database: pawning a whole stack or part of it, redeeming,
// and the payout being paid once per pawn record. Only the database file is synthetic.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-luxury-pawn-'));
process.env.COIN_DB_PATH = path.join(root, 'luxury-pawn.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

const { initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinDatabase } = require('../src/services/coinDatabase');
const { adjustPlayerBalance } = require('../src/services/coinService');
const {
  createLuxuryItem,
  getLuxuryInventory,
  listPawnRecords,
  listPawnRedemptions,
  pawnLuxuryItem,
  purchaseLuxuryItem,
  redeemPawnRecord,
} = require('../src/services/luxuryService');

const GUILD_ID = 'pawn-guild';
const PRICE = 100;
let sequence = 0;

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// A member with 1,000 coins who has bought `quantity` of a fresh item priced at 100.
async function memberWithItem(quantity) {
  sequence += 1;
  const userId = `pawn-member-${sequence}`;
  await adjustPlayerBalance(GUILD_ID, userId, {
    action: 'add', amount: 1000, operatorId: 'pawn-admin', reason: '測試資料',
  });
  const item = await createLuxuryItem(GUILD_ID, {
    name: `測試奢侈品 ${sequence}`, description: '當鋪測試', price: PRICE, createdBy: 'pawn-admin',
  });
  await purchaseLuxuryItem(GUILD_ID, userId, item.id, quantity);
  return { userId, item };
}

const balanceOf = (userId) => withCoinDatabase((api) => Number(
  api.get('SELECT balance FROM coin_wallets WHERE user_id = ?', [userId]).balance));
const heldOf = async (userId, itemId) => {
  const inventory = await getLuxuryInventory(GUILD_ID, userId);
  return inventory.items.find((row) => row.itemId === itemId)?.quantity ?? 0;
};
const transactionsOf = (userId, type) => withCoinDatabase((api) => api.all(
  'SELECT amount FROM coin_transactions WHERE user_id = ? AND type = ? ORDER BY id', [userId, type]));
const hasCode = (code) => (error) => error.code === code;

test('pawning every piece of an item pays out and empties that inventory row', async () => {
  const { userId, item } = await memberWithItem(3);
  assert.equal(await balanceOf(userId), 700);

  const result = await pawnLuxuryItem(GUILD_ID, userId, item.id, 3);

  assert.equal(result.payoutAmount, 240);
  assert.equal(result.record.quantity, 3);
  assert.equal(result.record.remainingQuantity, 3);
  assert.equal(result.record.status, 'active');
  assert.equal(await balanceOf(userId), 940);
  assert.equal(await heldOf(userId, item.id), 0);
  const rows = await withCoinDatabase((api) => api.all(
    'SELECT quantity FROM luxury_global_inventory WHERE user_id = ?', [userId]));
  assert.deepEqual(rows, []);
});

test('pawning part of an item keeps the rest in the inventory', async () => {
  const { userId, item } = await memberWithItem(5);

  const result = await pawnLuxuryItem(GUILD_ID, userId, item.id, 2);

  assert.equal(result.payoutAmount, 160);
  assert.equal(result.record.remainingQuantity, 2);
  assert.equal(await balanceOf(userId), 500 + 160);
  assert.equal(await heldOf(userId, item.id), 3);
});

test('pawning more than is held is refused and pays nothing', async () => {
  const { userId, item } = await memberWithItem(2);

  await assert.rejects(() => pawnLuxuryItem(GUILD_ID, userId, item.id, 3), hasCode('LUXURY_INVENTORY_NOT_ENOUGH'));

  assert.equal(await balanceOf(userId), 800);
  assert.equal(await heldOf(userId, item.id), 2);
  assert.deepEqual(await transactionsOf(userId, 'pawn_payout'), []);
});

test('redeeming returns the pieces in steps and closes the record once everything is back', async () => {
  const { userId, item } = await memberWithItem(3);
  const pawned = await pawnLuxuryItem(GUILD_ID, userId, item.id, 3);
  const recordId = pawned.record.id;
  assert.equal(await balanceOf(userId), 940);

  const first = await redeemPawnRecord(GUILD_ID, userId, recordId, 1);
  assert.equal(first.totalPrice, PRICE);
  assert.equal(first.record.remainingQuantity, 2);
  assert.equal(first.record.redeemedQuantity, 1);
  assert.equal(first.record.status, 'active');
  assert.equal(await balanceOf(userId), 840);
  assert.equal(await heldOf(userId, item.id), 1);

  const rest = await redeemPawnRecord(GUILD_ID, userId, recordId, 2);
  assert.equal(rest.record.remainingQuantity, 0);
  assert.equal(rest.record.redeemedQuantity, 3);
  assert.equal(rest.record.status, 'redeemed');
  assert.ok(rest.record.redeemedAt);
  assert.equal(await balanceOf(userId), 640);
  assert.equal(await heldOf(userId, item.id), 3);
  assert.deepEqual((await listPawnRedemptions(GUILD_ID, userId)).map((row) => row.quantity), [2, 1]);
  assert.deepEqual(await listPawnRecords(GUILD_ID, userId, { activeOnly: true }), []);
});

test('a record that is already redeemed cannot be redeemed again', async () => {
  const { userId, item } = await memberWithItem(2);
  const { record } = await pawnLuxuryItem(GUILD_ID, userId, item.id, 2);
  await redeemPawnRecord(GUILD_ID, userId, record.id, 2);
  const balance = await balanceOf(userId);
  const redemptions = await listPawnRedemptions(GUILD_ID, userId);

  await assert.rejects(() => redeemPawnRecord(GUILD_ID, userId, record.id, 1), hasCode('PAWN_RECORD_CLOSED'));

  assert.equal(await balanceOf(userId), balance);
  assert.equal(await heldOf(userId, item.id), 2);
  assert.equal((await listPawnRedemptions(GUILD_ID, userId)).length, redemptions.length);
});

test('redeeming more than the record still holds is refused', async () => {
  const { userId, item } = await memberWithItem(3);
  const { record } = await pawnLuxuryItem(GUILD_ID, userId, item.id, 2);
  const balance = await balanceOf(userId);

  await assert.rejects(() => redeemPawnRecord(GUILD_ID, userId, record.id, 3), hasCode('PAWN_REDEEM_TOO_MANY'));

  assert.equal(await balanceOf(userId), balance);
  assert.equal(await heldOf(userId, item.id), 1);
  const [stored] = await listPawnRecords(GUILD_ID, userId);
  assert.equal(stored.remainingQuantity, 2);
});

test("another member cannot redeem someone else's record", async () => {
  const owner = await memberWithItem(1);
  const stranger = await memberWithItem(1);
  const { record } = await pawnLuxuryItem(GUILD_ID, owner.userId, owner.item.id, 1);

  await assert.rejects(() => redeemPawnRecord(GUILD_ID, stranger.userId, record.id, 1), hasCode('PAWN_RECORD_NOT_FOUND'));

  assert.equal(await heldOf(stranger.userId, owner.item.id), 0);
});

test('the payout is paid once per pawn record, also when two requests arrive together', async () => {
  const { userId, item } = await memberWithItem(2);
  const start = await balanceOf(userId);

  const settled = await Promise.allSettled([
    pawnLuxuryItem(GUILD_ID, userId, item.id, 2),
    pawnLuxuryItem(GUILD_ID, userId, item.id, 2),
  ]);

  assert.deepEqual(settled.map((entry) => entry.status).sort(), ['fulfilled', 'rejected']);
  const rejected = settled.find((entry) => entry.status === 'rejected');
  assert.equal(rejected.reason.code, 'LUXURY_INVENTORY_NOT_ENOUGH');
  assert.deepEqual(await transactionsOf(userId, 'pawn_payout'), [{ amount: 160 }]);
  assert.equal((await listPawnRecords(GUILD_ID, userId)).length, 1);
  assert.equal(await balanceOf(userId), start + 160);

  // Redeeming pays the shop, it never pays out again.
  await redeemPawnRecord(GUILD_ID, userId, (await listPawnRecords(GUILD_ID, userId))[0].id, 2);
  assert.deepEqual(await transactionsOf(userId, 'pawn_payout'), [{ amount: 160 }]);
  assert.deepEqual(await transactionsOf(userId, 'pawn_redeem'), [{ amount: -200 }]);
});
