'use strict';

// Attack tests for the economy service layer: hostile numbers and hostile text thrown straight at it.
//
// Discord already limits what a slash-command option can hold, but the services are also reached through
// buttons, scheduled jobs and other code, so each of them has to refuse a bad number by itself. Every attack
// runs against the real services and a synthetic SQLite database in the temporary directory; nothing is faked
// except the Discord side, which these tests never touch.
//
// A test that passes is a defence that held.

const test = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./support/securityAttackHarness');

const root = harness.createAttackEnvironment('xiaoji-attack-inputs-');

const coin = require('../src/services/coinService');
const bankService = require('../src/services/bankService');
const chipService = require('../src/services/chipService');
const luxuryService = require('../src/services/luxuryService');
const casinoService = require('../src/services/casinoService');
const casinoFacility = require('../src/services/casinoFacilityService');
const workService = require('../src/services/workService');
const featurePlatform = require('../src/services/featurePlatformService');
const campaignService = require('../src/services/coinCampaignService');

const GUILD = '810000000000000001';
const USER = '810000000000000011';
const OPERATOR = '810000000000000099';
const MAX_COIN_AMOUNT = 9_000_000_000;

const previousOwner = process.env.BOT_OWNER_ID;
process.env.BOT_OWNER_ID = OPERATOR;

test.after(() => {
  if (previousOwner === undefined) delete process.env.BOT_OWNER_ID;
  else process.env.BOT_OWNER_ID = previousOwner;
  harness.closeAttackDatabase(root);
});

let counter = 0;
function nextNumber() {
  counter += 1;
  return counter;
}
function freshUserId() {
  return `8100000000${String(200000 + nextNumber())}`;
}

// A database in which the attacking user can afford every entry below: wallet, bank, chips, an open loan, a
// shop item, a luxury item held in stock, a pawn record and a battle item.
async function seedEconomy() {
  await harness.openAttackDatabase(root);
  await coin.adjustPlayerBalance(GUILD, USER, {
    action: 'add', amount: 5_000_000, operatorId: OPERATOR, reason: 'attack seed', operationId: 'attack-seed-wallet',
  });
  await bankService.deposit(GUILD, USER, 100_000);
  await chipService.buyChips(GUILD, USER, 200_000);
  await casinoService.borrowCasinoLoan(GUILD, USER, { amount: 50_000 });
  const shopItem = await coin.createShopItem(GUILD, { name: 'attack shop item', price: 10, createdBy: OPERATOR });
  const luxuryItem = await luxuryService.createLuxuryItem(GUILD, { name: 'attack luxury item', price: 100, createdBy: OPERATOR });
  await luxuryService.purchaseLuxuryItem(GUILD, USER, luxuryItem.id, 900);
  const pawned = await luxuryService.pawnLuxuryItem(GUILD, USER, luxuryItem.id, 400);
  return { shopItemId: shopItem.id, luxuryItemId: luxuryItem.id, pawnRecordId: pawned.record.id };
}

// ---------------------------------------------------------------------------------------------------------
// The money entries. `run` makes one call with the hostile value; `applied` reads, from the result, the whole
// number the service says it applied.
// ---------------------------------------------------------------------------------------------------------

const ENTRIES = [
  {
    id: 'admin add',
    run: (value) => coin.adjustPlayerBalance(GUILD, USER, { action: 'add', amount: value, operatorId: OPERATOR, reason: 'attack' }),
    applied: (result) => result.amount,
  },
  {
    id: 'admin remove',
    run: (value) => coin.adjustPlayerBalance(GUILD, USER, { action: 'remove', amount: value, operatorId: OPERATOR, reason: 'attack' }),
    applied: (result) => -result.amount,
  },
  {
    id: 'admin set',
    nonNegative: true,
    run: (value) => coin.adjustPlayerBalance(GUILD, USER, { action: 'set', amount: value, operatorId: OPERATOR, reason: 'attack' }),
    applied: (result) => result.after,
  },
  {
    id: 'shop purchase quantity',
    run: (value, context) => coin.purchaseItem(GUILD, USER, context.shopItemId, value),
    applied: (result) => result.quantity,
  },
  {
    id: 'shop item price',
    nonNegative: true,
    run: (value) => coin.createShopItem(GUILD, { name: 'price attack', price: value, createdBy: OPERATOR }),
    applied: (result) => result.price,
  },
  {
    id: 'shop item edit price',
    nonNegative: true,
    run: (value, context) => coin.editShopItem(GUILD, context.shopItemId, { price: value, operatorId: OPERATOR }),
    applied: (result) => result.price,
  },
  {
    id: 'luxury item price',
    run: (value) => luxuryService.createLuxuryItem(GUILD, { name: 'luxury price attack', price: value, createdBy: OPERATOR }),
    applied: (result) => result.price,
  },
  {
    id: 'luxury purchase quantity',
    run: (value, context) => luxuryService.purchaseLuxuryItem(GUILD, USER, context.luxuryItemId, value),
    applied: (result) => result.quantity,
  },
  {
    id: 'pawn quantity',
    run: (value, context) => luxuryService.pawnLuxuryItem(GUILD, USER, context.luxuryItemId, value),
    applied: (result) => result.quantity,
  },
  {
    id: 'pawn redeem quantity',
    run: (value, context) => luxuryService.redeemPawnRecord(GUILD, USER, context.pawnRecordId, value),
    applied: (result) => result.quantity,
  },
  {
    id: 'bank deposit',
    run: (value) => bankService.deposit(GUILD, USER, value),
    applied: (result) => result.bankAfter - result.bankBefore,
  },
  {
    id: 'bank withdraw',
    run: (value) => bankService.withdraw(GUILD, USER, value),
    applied: (result) => result.bankBefore - result.bankAfter,
  },
  {
    id: 'fixed deposit',
    run: (value) => bankService.createFixedDeposit(GUILD, USER, { amount: value, termDays: 7 }),
    applied: (result) => result.principal,
  },
  {
    id: 'chip buy',
    run: (value) => chipService.buyChips(GUILD, USER, value),
    applied: (result) => result.amount,
  },
  {
    id: 'chip cashout',
    run: (value) => chipService.cashoutChips(GUILD, USER, value),
    applied: (result) => result.amount,
  },
  {
    id: 'loan borrow',
    run: (value) => casinoService.borrowCasinoLoan(GUILD, USER, { amount: value }),
    applied: (result) => result.borrowedAmount,
  },
  {
    id: 'loan repay',
    run: (value) => casinoService.repayCasinoLoan(GUILD, USER, { amount: value }),
    applied: (result) => result.repaymentAmount,
  },
  {
    id: 'loan forced collection',
    run: (value) => casinoService.collectCasinoDebt(GUILD, USER, { amount: value, operatorId: OPERATOR }),
    applied: (result) => result.collectionAmount,
  },
  {
    id: 'dice bet',
    run: (value) => casinoService.playDice(GUILD, USER, { amount: value, choice: 'big' }),
    applied: (result) => result.betAmount,
  },
  {
    id: 'slots bet',
    run: (value) => casinoService.playSlots(GUILD, USER, { amount: value }),
    applied: (result) => result.betAmount,
  },
  {
    id: 'roulette bet',
    run: (value) => casinoService.playRoulette(GUILD, USER, { amount: value, choice: 'red' }),
    applied: (result) => result.betAmount,
  },
  {
    id: 'baccarat bet',
    run: (value) => casinoService.playBaccarat(GUILD, USER, { amount: value, choice: 'player' }),
    applied: (result) => result.betAmount,
  },
  {
    id: 'poker bet',
    run: (value) => casinoService.playPoker(GUILD, USER, { amount: value }),
    applied: (result) => result.betAmount,
  },
  {
    // A blackjack session stays open until it is finished or has expired, so each attempt is made an hour
    // after the last one, which the service expires and refunds before it opens the next.
    id: 'blackjack bet',
    run: (value, context) => {
      context.clock += 3_600_000;
      return casinoService.startBlackjack(GUILD, USER, { amount: value, date: new Date(context.clock) });
    },
    applied: (result) => result.session.betAmount,
  },
  {
    id: 'lodging nights',
    run: (value) => casinoFacility.bookLodging(GUILD, USER, { roomType: 'standard', nights: value }),
    applied: (result) => result.booking.nights,
  },
  {
    id: 'work days',
    run: (value) => workService.startJob(GUILD, freshUserId(), '會計師', value),
    applied: (result) => result.workDays,
    // Whole days are what the service stores: it rounds a fraction down, which is exact handling.
    exclude: new Set(['fraction 1.5', 'text "1.5"']),
    extraCoercible: [['fraction 1.5 rounded down', 1.5, 1], ['text "1.5" rounded down', '1.5', 1]],
  },
  {
    id: 'reward grant amount',
    run: (value) => featurePlatform.grantRewardOnceV2({
      kind: 'game',
      canonicalSourceId: `attack-source-${nextNumber()}`,
      rewardKind: 'win',
      userId: USER,
      sourceGuildId: GUILD,
      amount: value,
      operationId: `attack-operation-${nextNumber()}`,
    }),
    applied: (result) => result.receipt.amount,
  },
  {
    id: 'owner campaign amount',
    run: (value) => campaignService.previewOwnerCampaign({
      campaignId: `attack-campaign-${nextNumber()}`,
      sourceGuildId: GUILD,
      audienceType: 'member',
      amount: value,
      reason: 'attack',
      actorUserId: OPERATOR,
      memberIds: [USER],
    }),
    applied: (result) => result.amount,
  },
];

// Values a service may take or refuse, as long as it applies exactly this whole number when it takes one.
const EXTRA_COERCIBLE = Object.freeze([
  ['text "1500"', '1500', 1500],
  ['text "1e4"', '1e4', 10_000],
]);

async function attackEntry(entry) {
  const context = { ...(await seedEconomy()), clock: Date.parse('2026-03-02T00:00:00.000Z') };
  // Zero is a valid amount for the entries that take zero, so a value that reads as 0 is not in their list.
  const never = harness.NEVER_ACCEPTED_AMOUNTS.filter(([name, value]) =>
    !(entry.nonNegative && Number(value) === 0) && !(entry.exclude && entry.exclude.has(name)));

  // 1. Values that must never be applied: refused, and not one table moves.
  const before = await harness.snapshotAllTables();
  const accepted = [];
  for (const [name, value] of never) {
    let error = null;
    try {
      await entry.run(value, context);
    } catch (caught) {
      error = caught;
    }
    if (!error) accepted.push(name);
  }
  const after = await harness.snapshotAllTables();
  assert.deepEqual(accepted, [], `${entry.id} accepted a value it must refuse`);
  assert.deepEqual(harness.changedTables(before, after), [], `${entry.id}: refused calls must not change any table`);
  await harness.assertMoneyLedgersConsistent(entry.id);

  // 2. Values JavaScript turns into whole numbers: refused, or applied exactly.
  const coercible = [...harness.COERCIBLE_AMOUNTS, ...EXTRA_COERCIBLE, ...(entry.extraCoercible || [])];
  for (const [name, value, expected] of coercible) {
    let result = null;
    let error = null;
    try {
      result = await entry.run(value, context);
    } catch (caught) {
      error = caught;
    }
    if (!error) assert.equal(entry.applied(result), expected, `${entry.id} <- ${name}: applied a different number`);
    await harness.assertMoneyLedgersConsistent(`${entry.id} <- ${name}`);
  }
}

for (const entry of ENTRIES) {
  test(`${entry.id}: hostile numbers are refused without a write, coercible ones apply exactly`, async () => {
    await attackEntry(entry);
  });
}

// ---------------------------------------------------------------------------------------------------------
// the edges of the range
// ---------------------------------------------------------------------------------------------------------

test('the cap itself is exact: MAX_COIN_AMOUNT applies in full, one more is refused', async () => {
  await seedEconomy();
  const before = await harness.readWallet(USER);
  const added = await coin.adjustPlayerBalance(GUILD, USER, {
    action: 'add', amount: MAX_COIN_AMOUNT, operatorId: OPERATOR, reason: 'cap',
  });
  assert.equal(added.amount, MAX_COIN_AMOUNT);
  assert.equal((await harness.readWallet(USER)).balance, before.balance + MAX_COIN_AMOUNT);
  await assert.rejects(coin.adjustPlayerBalance(GUILD, USER, {
    action: 'add', amount: MAX_COIN_AMOUNT + 1, operatorId: OPERATOR, reason: 'cap',
  }), { code: 'INVALID_AMOUNT' });
  assert.equal((await harness.readWallet(USER)).balance, before.balance + MAX_COIN_AMOUNT);
  const set = await coin.adjustPlayerBalance(GUILD, USER, {
    action: 'set', amount: MAX_COIN_AMOUNT, operatorId: OPERATOR, reason: 'cap',
  });
  assert.equal(set.after, MAX_COIN_AMOUNT);
  await harness.assertMoneyLedgersConsistent('cap');
});

test('price times quantity cannot overflow the cap, in the shop and in the luxury shop', async () => {
  await seedEconomy();
  const dear = await coin.createShopItem(GUILD, { name: 'dear item', price: MAX_COIN_AMOUNT, createdBy: OPERATOR });
  const dearLuxury = await luxuryService.createLuxuryItem(GUILD, {
    name: 'dear luxury', price: MAX_COIN_AMOUNT, createdBy: OPERATOR,
  });
  const before = await harness.snapshotAllTables();
  for (const quantity of [2, 3, 1_000, MAX_COIN_AMOUNT]) {
    await assert.rejects(coin.purchaseItem(GUILD, USER, dear.id, quantity), { code: 'INVALID_AMOUNT' });
    await assert.rejects(luxuryService.purchaseLuxuryItem(GUILD, USER, dearLuxury.id, quantity),
      { code: 'INVALID_LUXURY_AMOUNT' });
  }
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);
  // One unit at the cap is a price the user simply cannot pay, and is refused as such.
  await assert.rejects(coin.purchaseItem(GUILD, USER, dear.id, 1), { code: 'INSUFFICIENT_FUNDS' });
});

test('a wallet next to the safe-integer limit refuses a credit that would cross it', async () => {
  await seedEconomy();
  const { withCoinTransaction } = require('../src/services/coinDatabase');
  await withCoinTransaction((api) => api.run(
    'UPDATE coin_wallets SET balance = ?, total_earned = ? WHERE user_id = ?',
    [Number.MAX_SAFE_INTEGER - 5, Number.MAX_SAFE_INTEGER - 5, USER]
  ));
  const before = await harness.snapshotAllTables();
  await assert.rejects(coin.adjustPlayerBalance(GUILD, USER, {
    action: 'add', amount: 10, operatorId: OPERATOR, reason: 'crossing',
  }), { code: 'WALLET_VALUE_OUT_OF_RANGE' });
  await assert.rejects(coin.dailyCheckin(GUILD, USER, new Date('2026-03-02T01:00:00.000Z')),
    { code: 'WALLET_VALUE_OUT_OF_RANGE' });
  await assert.rejects(featurePlatform.grantRewardOnceV2({
    kind: 'game', canonicalSourceId: 'crossing', rewardKind: 'win', userId: USER, sourceGuildId: GUILD, amount: 10,
  }), (error) => typeof error.code === 'string');
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), [],
    'a refused credit near the limit must leave every table as it was');
  const wallet = await harness.readWallet(USER);
  assert.equal(wallet.balance, Number.MAX_SAFE_INTEGER - 5);
});

test('the loan cap is exact: the full 9e9 is lent once, one more chip is refused', async () => {
  await harness.openAttackDatabase(root);
  const first = await casinoService.borrowCasinoLoan(GUILD, USER, { amount: MAX_COIN_AMOUNT });
  assert.equal(first.borrowedAmount, MAX_COIN_AMOUNT);
  assert.equal(await harness.readChipBalance(USER), MAX_COIN_AMOUNT);
  const before = await harness.snapshotAllTables();
  await assert.rejects(casinoService.borrowCasinoLoan(GUILD, USER, { amount: 1 }), { code: 'CASINO_LOAN_LIMIT' });
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);
  await harness.assertMoneyLedgersConsistent('loan cap');
});

test('bank amounts above the coin limit are refused with an amount error before anything moves', async () => {
  await seedEconomy();
  const before = await harness.snapshotAllTables();
  for (const amount of [MAX_COIN_AMOUNT + 1, 2 ** 40, Number.MAX_SAFE_INTEGER]) {
    await assert.rejects(bankService.deposit(GUILD, USER, amount), { code: 'INVALID_AMOUNT' });
    await assert.rejects(bankService.withdraw(GUILD, USER, amount), { code: 'INVALID_AMOUNT' });
    await assert.rejects(bankService.createFixedDeposit(GUILD, USER, { amount, termDays: 7 }), { code: 'INVALID_AMOUNT' });
  }
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);
});

// ---------------------------------------------------------------------------------------------------------
// The best payout of a round must fit in the chip limit
// ---------------------------------------------------------------------------------------------------------

function sequence(values) {
  let index = 0;
  return () => values[index++];
}

// Every game with the multiplier of its best outcome. The rounds are played with a random source that loses
// where the game takes one, so the largest bet is really settled and not only accepted.
const BEST_PAYOUT_GAMES = [
  {
    name: 'dice on big',
    multiplier: 2,
    play: (amount) => casinoService.playDice(GUILD, USER, { amount, choice: 'big', rng: sequence([0, 0]) }),
    bet: (result) => result.betAmount,
  },
  {
    name: 'dice on seven',
    multiplier: 5,
    play: (amount) => casinoService.playDice(GUILD, USER, { amount, choice: 'seven', rng: sequence([0, 0]) }),
    bet: (result) => result.betAmount,
  },
  {
    name: 'slots',
    multiplier: 10,
    play: (amount) => casinoService.playSlots(GUILD, USER, { amount, rng: sequence([0, 1, 2]) }),
    bet: (result) => result.betAmount,
  },
  {
    name: 'roulette on red',
    multiplier: 2,
    play: (amount) => casinoService.playRoulette(GUILD, USER, { amount, choice: 'red', rng: sequence([0]) }),
    bet: (result) => result.betAmount,
  },
  {
    name: 'roulette on zero',
    multiplier: 36,
    play: (amount) => casinoService.playRoulette(GUILD, USER, { amount, choice: 'zero', rng: sequence([5]) }),
    bet: (result) => result.betAmount,
  },
  {
    name: 'baccarat on the player',
    multiplier: 2,
    play: (amount) => casinoService.playBaccarat(GUILD, USER, { amount, choice: 'player' }),
    bet: (result) => result.betAmount,
  },
  {
    name: 'baccarat on a tie',
    multiplier: 8,
    play: (amount) => casinoService.playBaccarat(GUILD, USER, { amount, choice: 'tie' }),
    bet: (result) => result.betAmount,
  },
  {
    name: 'poker',
    multiplier: 2,
    play: (amount) => casinoService.playPoker(GUILD, USER, { amount }),
    bet: (result) => result.betAmount,
  },
  {
    name: 'blackjack',
    multiplier: 2.5,
    play: (amount) => casinoService.startBlackjack(GUILD, USER, { amount }),
    bet: (result) => result.session.betAmount,
  },
  {
    name: 'duel tower',
    multiplier: 2,
    play: (amount, context) => casinoFacility.enterDuelTower(GUILD, USER, {
      weaponItemId: context.weaponId, wager: amount, rng: sequence([0, 79]),
    }),
    bet: (result) => result.run.wagerAmount,
  },
];

test('a bet whose best payout would pass the chip limit is refused before the round, the largest one is played', async () => {
  await seedEconomy();
  const weapon = await coin.createShopItem(GUILD, {
    name: 'payout limit weapon', price: 100, type: 'battle_item', createdBy: OPERATOR,
  });
  await coin.purchaseItem(GUILD, USER, weapon.id, 1);
  const context = { weaponId: weapon.id };

  for (const game of BEST_PAYOUT_GAMES) {
    const largest = Math.floor(MAX_COIN_AMOUNT / game.multiplier);
    const before = await harness.snapshotAllTables();
    for (const tooLarge of [largest + 1, largest + 1_000, MAX_COIN_AMOUNT]) {
      await assert.rejects(game.play(tooLarge, context), { code: 'CASINO_BET_TOO_LARGE' }, `${game.name} ${tooLarge}`);
    }
    assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), [],
      `${game.name}: a refused bet must not touch any table`);

    await coin.adjustPlayerBalance(GUILD, USER, {
      action: 'set', amount: MAX_COIN_AMOUNT, operatorId: OPERATOR, reason: `fund the largest ${game.name} bet`,
    });
    const played = await game.play(largest, context);
    assert.equal(game.bet(played), largest, `${game.name}: the largest allowed bet is taken in full`);
    await harness.assertMoneyLedgersConsistent(game.name);
  }
});

// ---------------------------------------------------------------------------------------------------------
// Terms, choices and other fixed vocabularies
// ---------------------------------------------------------------------------------------------------------

test('fixed-deposit terms outside 7, 14, 30 and 90 days are refused by the service itself', async () => {
  await seedEconomy();
  const before = await harness.snapshotAllTables();
  for (const term of [0, -7, 1, 8, 13, 31, 91, 365, 7.5, Number.NaN, Number.POSITIVE_INFINITY, '', null, undefined, {}, [], 'abc']) {
    await assert.rejects(bankService.createFixedDeposit(GUILD, USER, { amount: 5_000, termDays: term }),
      { code: 'INVALID_FIXED_TERM' }, `term ${String(term)}`);
  }
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);
  const taken = await bankService.createFixedDeposit(GUILD, USER, { amount: 5_000, termDays: '7' });
  assert.equal(taken.termDays, 7, 'a numeric text that means exactly 7 is applied as 7');
});

test('casino choices outside the vocabulary are refused after the bet is read, and nothing is written', async () => {
  await seedEconomy();
  const before = await harness.snapshotAllTables();
  for (const choice of ['', 'bigg', 'evil', null, undefined, {}, '; DROP TABLE casino_games;--']) {
    await assert.rejects(casinoService.playDice(GUILD, USER, { amount: 100, choice }), { code: 'INVALID_DICE_CHOICE' });
    await assert.rejects(casinoService.playRoulette(GUILD, USER, { amount: 100, choice }), { code: 'INVALID_ROULETTE_CHOICE' });
    await assert.rejects(casinoService.playBaccarat(GUILD, USER, { amount: 100, choice }), { code: 'INVALID_BACCARAT_CHOICE' });
  }
  for (const roomType of ['', 'penthouse', null, '../standard']) {
    await assert.rejects(casinoFacility.bookLodging(GUILD, USER, { roomType, nights: 1 }), { code: 'INVALID_ROOM_TYPE' });
  }
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);
});

test('shop item types are a closed list, and a role item cannot be created through the service', async () => {
  await seedEconomy();
  const before = await harness.snapshotAllTables();
  for (const type of ['admin', 'ROLE ', 'roles', '../role']) {
    await assert.rejects(coin.createShopItem(GUILD, { name: 'typed', price: 1, type, createdBy: OPERATOR }),
      (error) => ['INVALID_ITEM_TYPE', 'ROLE_ITEM_NOT_SUPPORTED'].includes(error.code), `type ${JSON.stringify(type)}`);
  }
  await assert.rejects(coin.createShopItem(GUILD, { name: 'typed', price: 1, type: 'role', createdBy: OPERATOR }),
    { code: 'ROLE_ITEM_NOT_SUPPORTED' });
  await assert.rejects(coin.createShopItem(GUILD, { name: 'typed', price: 1, roleId: '123', createdBy: OPERATOR }),
    { code: 'ROLE_ITEM_NOT_SUPPORTED' });
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);
});

// ---------------------------------------------------------------------------------------------------------
// list sizes, pages, text lengths and identifiers
// ---------------------------------------------------------------------------------------------------------

const HOSTILE_LIMITS = Object.freeze([
  0, -1, -25, Number.NaN, Number.POSITIVE_INFINITY, 26, 1_000, 1e9, Number.MAX_SAFE_INTEGER, '1e9', '25', 'abc', '', null,
  undefined, {}, [], [3],
]);

test('page sizes and page numbers are normalised again by the services that list rows', async () => {
  await seedEconomy();
  for (let index = 0; index < 30; index += 1) {
    await coin.createShopItem(GUILD, { name: `listed ${index}`, price: 1, createdBy: OPERATOR });
  }
  for (const limit of HOSTILE_LIMITS) {
    const label = `limit ${String(limit)}`;
    const shop = await coin.listShopItems(GUILD, { limit, page: limit });
    assert.ok(shop.items.length <= 25, `${label}: shop page size ${shop.items.length}`);
    assert.ok(Number.isSafeInteger(shop.page) && shop.page >= 1, `${label}: shop page ${shop.page}`);
    const board = await coin.getLeaderboard(GUILD, { limit, page: limit });
    assert.ok(board.players.length <= 25, label);
    assert.ok((await coin.getAllPlayers(GUILD, { limit })).length <= 25, label);
    assert.ok((await coin.getTransactions(GUILD, USER, { limit })).length <= 25, label);
    assert.ok((await coin.getAllTransactions(GUILD, { limit })).length <= 25, label);
    assert.ok((await coin.getAllPurchaseHistory(GUILD, { limit })).length <= 25, label);
    assert.ok((await coin.getAllInventory(GUILD, { limit })).length <= 25, label);
    assert.ok((await chipService.getChipHistory(GUILD, USER, { limit })).length <= 25, label);
    const luxury = await luxuryService.listLuxuryItems(GUILD, { limit, page: limit });
    assert.ok(luxury.items.length <= 25 && luxury.page >= 1, label);
    assert.ok((await workService.listWorkTasks(GUILD, { limit })).length <= 25, label);
    assert.ok((await workService.getPayrollHistory(GUILD, { limit })).length <= 25, label);
    assert.ok((await casinoFacility.listLodging(GUILD, USER, { limit })).length <= 25, label);
    assert.ok((await casinoFacility.getDuelTowerHistory(GUILD, USER, { limit })).length <= 25, label);
  }
});

test('text fields are cut to their limit by the service, not only by the Discord option', async () => {
  await seedEconomy();
  const longName = 'n'.repeat(500);
  const longText = 'd'.repeat(5_000);
  const item = await coin.createShopItem(GUILD, { name: longName, description: longText, price: 1, createdBy: OPERATOR });
  assert.equal(item.name.length, 80);
  assert.equal(item.description.length, 500);
  const edited = await coin.editShopItem(GUILD, item.id, { name: longName, description: longText, operatorId: OPERATOR });
  assert.equal(edited.name.length, 80);
  assert.equal(edited.description.length, 500);
  const luxuryItem = await luxuryService.createLuxuryItem(GUILD, {
    name: longName, description: longText, price: 5, createdBy: OPERATOR,
  });
  assert.equal(luxuryItem.name.length, 80);
  assert.equal(luxuryItem.description.length, 500);
  await assert.rejects(coin.createShopItem(GUILD, { name: '   ', price: 1, createdBy: OPERATOR }), { code: 'INVALID_ITEM_NAME' });
  await assert.rejects(luxuryService.createLuxuryItem(GUILD, { name: '', price: 1, createdBy: OPERATOR }),
    { code: 'INVALID_LUXURY_ITEM_NAME' });
  const adjusted = await coin.adjustPlayerBalance(GUILD, USER, {
    action: 'add', amount: 1, operatorId: OPERATOR, reason: longText,
  });
  assert.ok(adjusted.alreadyApplied === false);
  const transaction = (await harness.readRows(
    'SELECT reason FROM coin_transactions WHERE user_id = ? ORDER BY id DESC LIMIT 1', [USER]
  ))[0];
  assert.ok(transaction.reason.length <= 300, `transaction reason stored ${transaction.reason.length} characters`);
  const log = (await harness.readRows(
    "SELECT reason FROM coin_admin_logs WHERE action = 'coin_admin:add' ORDER BY id DESC LIMIT 1"
  ))[0];
  assert.ok(log.reason.length <= 500, `admin log reason stored ${log.reason.length} characters`);
});

test('identifiers are opaque text of at most 80 characters, and quote characters are only ever data', async () => {
  await seedEconomy();
  const before = await harness.snapshotAllTables();
  await assert.rejects(coin.getPlayerBalance(GUILD, 'u'.repeat(81)), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(coin.getPlayerBalance('g'.repeat(81), USER), { code: 'INVALID_ARGUMENT' });
  await assert.rejects(coin.getPlayerBalance(GUILD, '   '), { code: 'INVALID_ARGUMENT' });
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);

  const hostileId = "1' OR '1'='1'; DROP TABLE coin_wallets;--";
  const stored = await coin.getPlayerBalance(GUILD, hostileId);
  assert.equal(stored.userId, hostileId);
  assert.equal(stored.balance, 0);
  await assert.rejects(coin.purchaseItem(GUILD, USER, "x' OR 1=1;--", 1), { code: 'ITEM_NOT_FOUND' });
  await assert.rejects(bankService.claimFixedDeposit(GUILD, USER, '1 OR 1=1'), { code: 'FIXED_DEPOSIT_NOT_FOUND' });
  await assert.rejects(bankService.cancelFixedDeposit(GUILD, USER, "1; DROP TABLE coin_fixed_deposits;--"),
    { code: 'FIXED_DEPOSIT_NOT_FOUND' });
  await assert.rejects(luxuryService.redeemPawnRecord(GUILD, USER, '1 OR 1=1', 1), { code: 'PAWN_RECORD_NOT_FOUND' });
  const named = await coin.createShopItem(GUILD, {
    name: "x'); DROP TABLE coin_wallets;--", description: "'; DELETE FROM coin_transactions;--", price: 1, createdBy: OPERATOR,
  });
  assert.equal(named.name, "x'); DROP TABLE coin_wallets;--");
  const wallets = await harness.readRows('SELECT COUNT(*) AS count FROM coin_wallets');
  assert.ok(wallets[0].count >= 2, 'the wallet table is intact');
  assert.ok((await harness.readRows('SELECT COUNT(*) AS count FROM coin_transactions'))[0].count >= 1,
    'the ledger is intact');
  await harness.assertMoneyLedgersConsistent('injection');
});
