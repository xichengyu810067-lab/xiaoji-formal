'use strict';

// Attack tests for repeated and half-finished money operations: the same request sent twice or many times at
// once, and a failure in the middle of a multi-step write.
//
// The first half asks "does the money move exactly once?" for every operation that has a natural once-only
// rule: an operation id, an interaction id, a reward key, a status that may only change in one direction, or a
// limited stock. The second half asks "does a failure leave nothing behind?": a SQLite trigger makes one chosen
// write fail in the middle of the service's own transaction, and the test then compares every table with its
// state before the call, retries, and checks the service was not left stuck.
//
// A plain test that passes is a defence that held.

const test = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./support/securityAttackHarness');

const root = harness.createAttackEnvironment('xiaoji-attack-replay-');

const coin = require('../src/services/coinService');
const bankService = require('../src/services/bankService');
const chipService = require('../src/services/chipService');
const luxuryService = require('../src/services/luxuryService');
const casinoService = require('../src/services/casinoService');
const casinoFacility = require('../src/services/casinoFacilityService');
const workService = require('../src/services/workService');
const venueService = require('../src/services/venueService');
const featurePlatform = require('../src/services/featurePlatformService');
const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const { configureWorkRewardCoordinator } = require('../src/systems/work/workRewardPort');

const coordinator = createRuntimeRewardCoordinator();
configureWorkRewardCoordinator(coordinator);

const GUILD = '820000000000000001';
const OTHER_GUILD = '820000000000000002';
const USER = '820000000000000011';
const OTHER_USER = '820000000000000012';
const OPERATOR = '820000000000000099';
const CUSTOMER = '820000000000000021';
const WAITER = '820000000000000022';
const CHEF = '820000000000000023';
const DAY = 86_400_000;

const previousOwner = process.env.BOT_OWNER_ID;
process.env.BOT_OWNER_ID = OPERATOR;

test.after(() => {
  if (previousOwner === undefined) delete process.env.BOT_OWNER_ID;
  else process.env.BOT_OWNER_ID = previousOwner;
  harness.closeAttackDatabase(root);
});

async function settle(promise) {
  try {
    return { ok: true, value: await promise };
  } catch (error) {
    return { ok: false, error };
  }
}

function codes(results) {
  return results.filter((result) => !result.ok).map((result) => result.error.code);
}

let fundings = 0;
async function fund(userId, amount, guildId = GUILD) {
  fundings += 1;
  return coin.adjustPlayerBalance(guildId, userId, {
    action: 'add', amount, operatorId: OPERATOR, reason: 'attack seed', operationId: `attack-fund-${fundings}`,
  });
}

// ---------------------------------------------------------------------------------------------------------
// operation ids, once-a-day rules and status guards
// ---------------------------------------------------------------------------------------------------------

test('an admin adjustment with the same operation id applies once, sequentially and at once', async () => {
  await harness.openAttackDatabase(root);
  const input = { action: 'add', amount: 700, operatorId: OPERATOR, reason: 'replay', operationId: 'attack-op-1' };
  const first = await coin.adjustPlayerBalance(GUILD, USER, input);
  const again = await coin.adjustPlayerBalance(GUILD, USER, input);
  assert.equal(first.alreadyApplied, false);
  assert.equal(again.alreadyApplied, true);
  assert.equal((await harness.readWallet(USER)).balance, 700);

  const burst = await Promise.all(Array.from({ length: 8 }, () => settle(
    coin.adjustPlayerBalance(GUILD, USER, { ...input, operationId: 'attack-op-2', amount: 100 })
  )));
  assert.equal(burst.filter((result) => result.ok && result.value.alreadyApplied === false).length, 1);
  assert.equal((await harness.readWallet(USER)).balance, 800);

  // The same id carrying different content is a conflict, not a second adjustment.
  for (const changed of [{ amount: 101 }, { action: 'remove' }, { reason: 'other' }, { operatorId: 'someone else' }]) {
    await assert.rejects(coin.adjustPlayerBalance(GUILD, USER, { ...input, operationId: 'attack-op-2', amount: 100, ...changed }),
      { code: 'OPERATION_CONFLICT' });
  }
  assert.equal((await harness.readWallet(USER)).balance, 800);
  await harness.assertMoneyLedgersConsistent('operation ids');
});

test('the daily check-in pays once a Taiwan day across guilds, requests and the midnight edge', async (t) => {
  const clock = harness.startClock(t, '2026-03-02T01:00:00.000Z');
  await harness.openAttackDatabase(root);
  const first = await coin.dailyCheckin(GUILD, USER, new Date());
  assert.equal(first.streak, 1);
  const paid = (await harness.readWallet(USER)).balance;
  assert.ok(paid > 0);

  await assert.rejects(coin.dailyCheckin(GUILD, USER, new Date()), { code: 'ALREADY_CHECKED_IN' });
  await assert.rejects(coin.dailyCheckin(OTHER_GUILD, USER, new Date()), { code: 'ALREADY_CHECKED_IN' },
    'another guild must not give a second check-in the same day');
  const burst = await Promise.all(Array.from({ length: 6 }, () => settle(coin.dailyCheckin(GUILD, OTHER_USER, new Date()))));
  assert.equal(burst.filter((result) => result.ok).length, 1);
  // 2026-03-02T15:59:59Z is still the 2nd in Taiwan; one second later is the 3rd.
  await assert.rejects(coin.dailyCheckin(GUILD, USER, new Date('2026-03-02T15:59:59.000Z')), { code: 'ALREADY_CHECKED_IN' });
  assert.equal((await harness.readWallet(USER)).balance, paid);
  const nextDay = await coin.dailyCheckin(OTHER_GUILD, USER, new Date('2026-03-02T16:00:00.000Z'));
  assert.equal(nextDay.streak, 2);
  assert.equal(nextDay.checkinDate, '2026-03-03');
  clock.at('2026-03-03T01:00:00.000Z');
  await assert.rejects(coin.dailyCheckin(GUILD, USER, new Date()), { code: 'ALREADY_CHECKED_IN' });
  await harness.assertMoneyLedgersConsistent('daily');
});

test('a fixed deposit pays out once whichever way it is closed, and only to its owner', async (t) => {
  const clock = harness.startClock(t, '2026-03-02T01:00:00.000Z');
  await harness.openAttackDatabase(root);
  await fund(USER, 100_000);
  await fund(OTHER_USER, 1_000);

  const deposit = await bankService.createFixedDeposit(GUILD, USER, { amount: 50_000, termDays: 7 });
  const walletAfterCreate = (await harness.readWallet(USER)).balance;
  assert.equal(walletAfterCreate, 50_000);

  await assert.rejects(bankService.claimFixedDeposit(GUILD, USER, deposit.id), { code: 'FIXED_DEPOSIT_NOT_MATURED' });
  await assert.rejects(bankService.claimFixedDeposit(GUILD, OTHER_USER, deposit.id), { code: 'FIXED_DEPOSIT_NOT_FOUND' });
  await assert.rejects(bankService.cancelFixedDeposit(GUILD, OTHER_USER, deposit.id), { code: 'FIXED_DEPOSIT_NOT_FOUND' });

  clock.at('2026-03-10T01:00:00.000Z');
  const claims = await Promise.all(Array.from({ length: 5 }, () => settle(bankService.claimFixedDeposit(GUILD, USER, deposit.id))));
  assert.equal(claims.filter((result) => result.ok).length, 1);
  assert.deepEqual([...new Set(codes(claims))], ['FIXED_DEPOSIT_ALREADY_CLAIMED']);
  const paidOnce = (await harness.readWallet(USER)).balance;
  assert.equal(paidOnce, walletAfterCreate + deposit.principal + deposit.expectedInterest);

  await assert.rejects(bankService.claimFixedDeposit(GUILD, USER, deposit.id), { code: 'FIXED_DEPOSIT_ALREADY_CLAIMED' });
  await assert.rejects(bankService.cancelFixedDeposit(GUILD, USER, deposit.id), { code: 'FIXED_DEPOSIT_ALREADY_CLAIMED' });
  assert.equal((await harness.readWallet(USER)).balance, paidOnce);

  // A cancelled deposit cannot be claimed afterwards, and claim and cancel racing pay one of them.
  const second = await bankService.createFixedDeposit(GUILD, USER, { amount: 10_000, termDays: 7 });
  clock.at('2026-03-14T01:00:00.000Z');
  const cancelled = await bankService.cancelFixedDeposit(GUILD, USER, second.id);
  assert.equal(cancelled.status, 'cancelled');
  clock.at('2026-03-30T01:00:00.000Z');
  await assert.rejects(bankService.claimFixedDeposit(GUILD, USER, second.id), { code: 'FIXED_DEPOSIT_CANCELLED' });
  await assert.rejects(bankService.cancelFixedDeposit(GUILD, USER, second.id), { code: 'FIXED_DEPOSIT_CANCELLED' });

  const third = await bankService.createFixedDeposit(GUILD, USER, { amount: 10_000, termDays: 7 });
  const beforeRace = (await harness.readWallet(USER)).balance;
  clock.at('2026-04-10T01:00:00.000Z');
  const race = await Promise.all([
    settle(bankService.claimFixedDeposit(GUILD, USER, third.id)),
    settle(bankService.cancelFixedDeposit(GUILD, USER, third.id)),
    settle(bankService.claimFixedDeposit(GUILD, USER, third.id)),
  ]);
  assert.equal(race.filter((result) => result.ok).length, 1);
  assert.equal((await harness.readWallet(USER)).balance, beforeRace + third.principal + third.expectedInterest);
  await harness.assertMoneyLedgersConsistent('fixed deposits');
});

test('demand-deposit interest is paid once per day however often the job runs', async (t) => {
  // The deposit is made at 10:00 in Taipei; the interest of the day is settled from 23:00.
  const clock = harness.startClock(t, '2026-03-02T02:00:00.000Z');
  await harness.openAttackDatabase(root);
  await fund(USER, 1_000_000);
  await bankService.deposit(GUILD, USER, 1_000_000);
  assert.deepEqual(await bankService.processBankInterest(), { processed: 0 }, 'nothing is paid before 23:00');
  clock.at('2026-03-02T15:30:00.000Z');
  const runs = await Promise.all([
    bankService.processBankInterest(), bankService.processBankInterest(), bankService.processBankInterest(),
  ]);
  assert.equal(runs.reduce((sum, run) => sum + run.processed, 0), 1);
  const afterFirstDay = (await harness.readWallet(USER)).balance;
  assert.equal(afterFirstDay, 300, '0.03% of 1,000,000 once');
  assert.deepEqual(await bankService.processBankInterest(), { processed: 0 });
  assert.equal((await harness.readWallet(USER)).balance, afterFirstDay);
  clock.at('2026-03-03T15:30:00.000Z');
  assert.deepEqual(await bankService.processBankInterest(), { processed: 1 });
  assert.equal((await harness.readWallet(USER)).balance, afterFirstDay + 300);
  await harness.assertMoneyLedgersConsistent('interest');
});

test('money put back into an emptied account is not paid for the days the account sat empty', async (t) => {
  const clock = harness.startClock(t, '2026-03-02T02:00:00.000Z');
  await harness.openAttackDatabase(root);
  await fund(USER, 2_000_000);
  await bankService.deposit(GUILD, USER, 1_000_000);
  clock.at('2026-03-02T15:30:00.000Z');
  assert.deepEqual(await bankService.processBankInterest(), { processed: 1 });
  const paidBefore = (await harness.readRows(
    "SELECT COUNT(*) AS count FROM coin_transactions WHERE user_id = ? AND type = 'bank_interest'", [USER]
  ))[0].count;
  assert.equal(paidBefore, 1);

  // Everything is taken out and the account stays empty for a month.
  await bankService.withdraw(GUILD, USER, 1_000_000);
  clock.at('2026-04-01T02:00:00.000Z');
  assert.deepEqual(await bankService.processBankInterest(), { processed: 0 }, 'an empty account earns nothing');
  await bankService.deposit(GUILD, USER, 1_000_000);

  // Several runs the same night, and the next night: only the days the money was there are paid.
  clock.at('2026-04-01T15:30:00.000Z');
  const runs = [];
  for (let run = 0; run < 4; run += 1) runs.push(await bankService.processBankInterest());
  assert.equal(runs.reduce((sum, result) => sum + result.processed, 0), 1, 'one day, however many runs follow');
  clock.at('2026-04-02T15:30:00.000Z');
  assert.deepEqual(await bankService.processBankInterest(), { processed: 1 });
  const paidAfter = (await harness.readRows(
    "SELECT COUNT(*) AS count FROM coin_transactions WHERE user_id = ? AND type = 'bank_interest'", [USER]
  ))[0].count;
  assert.equal(paidAfter - paidBefore, 2, 'two days of interest for two days with money in the account');
  await harness.assertMoneyLedgersConsistent('emptied account');
});

test('loan interest is applied once per day, and repayments cannot exceed the debt', async () => {
  await harness.openAttackDatabase(root);
  await fund(USER, 5_000);
  const start = new Date('2026-03-02T01:00:00.000Z');
  await casinoService.borrowCasinoLoan(GUILD, USER, { amount: 10_000, date: start });
  const later = new Date('2026-03-05T01:00:00.000Z');

  const first = await casinoService.processCasinoLoanInterest({ date: later });
  assert.equal(first.processed, 1);
  assert.ok(first.interestAmount > 0);
  const debtAfterInterest = (await casinoService.getCasinoLoanStatus(GUILD, USER, { date: later })).loan.currentDebtAmount;
  assert.equal(debtAfterInterest, 10_000 + first.interestAmount);
  const replay = await casinoService.processCasinoLoanInterest({ date: later });
  assert.deepEqual(replay, { checked: 1, processed: 0, interestAmount: 0 });
  const status = await casinoService.getCasinoLoanStatus(GUILD, USER, { date: later });
  assert.equal(status.loan.currentDebtAmount, debtAfterInterest);
  assert.equal(status.interestApplied, 0);

  // Many repayments at once: the chips that go out are exactly the debt that was cleared.
  const repayments = await Promise.all(Array.from({ length: 6 }, () => settle(
    casinoService.repayCasinoLoan(GUILD, USER, { amount: 3_000, date: later })
  )));
  const repaid = repayments.filter((result) => result.ok).reduce((sum, result) => sum + result.value.repaymentAmount, 0);
  assert.equal(repaid, debtAfterInterest, 'the six requests clear the debt, no more and no less');
  assert.deepEqual([...new Set(codes(repayments))], ['NO_ACTIVE_CASINO_LOAN']);
  const loan = await harness.readRow('SELECT current_debt_amount, status FROM casino_loans WHERE user_id = ?', [USER]);
  assert.deepEqual({ ...loan }, { current_debt_amount: 0, status: 'repaid' });
  await harness.assertMoneyLedgersConsistent('loan');
});

test('two loans asked for at once cannot together pass the debt cap', async () => {
  await harness.openAttackDatabase(root);
  const race = await Promise.all([
    settle(casinoService.borrowCasinoLoan(GUILD, USER, { amount: 6_000_000_000 })),
    settle(casinoService.borrowCasinoLoan(GUILD, USER, { amount: 6_000_000_000 })),
    settle(casinoService.borrowCasinoLoan(GUILD, USER, { amount: 6_000_000_000 })),
  ]);
  assert.equal(race.filter((result) => result.ok).length, 1);
  assert.deepEqual([...new Set(codes(race))], ['CASINO_LOAN_LIMIT']);
  const loan = await harness.readRow('SELECT current_debt_amount FROM casino_loans WHERE user_id = ?', [USER]);
  assert.equal(loan.current_debt_amount, 6_000_000_000);
  assert.equal(await harness.readChipBalance(USER), 6_000_000_000);
  await harness.assertMoneyLedgersConsistent('loan cap race');
});

test('a pawn record redeems once, never for someone else, and a stack cannot be pawned twice at once', async () => {
  await harness.openAttackDatabase(root);
  await fund(USER, 100_000);
  await fund(OTHER_USER, 100_000);
  const item = await luxuryService.createLuxuryItem(GUILD, { name: 'attack watch', price: 1_000, createdBy: OPERATOR });
  await luxuryService.purchaseLuxuryItem(GUILD, USER, item.id, 5);
  const wallet = (await harness.readWallet(USER)).balance;

  // Four requests for two units each against a stack of five: exactly two succeed.
  const pawns = await Promise.all(Array.from({ length: 4 }, () => settle(luxuryService.pawnLuxuryItem(GUILD, USER, item.id, 2))));
  assert.equal(pawns.filter((result) => result.ok).length, 2);
  assert.deepEqual([...new Set(codes(pawns))], ['LUXURY_INVENTORY_NOT_ENOUGH']);
  assert.equal((await harness.readWallet(USER)).balance, wallet + 2 * 1_600);
  const [record] = pawns.filter((result) => result.ok).map((result) => result.value.record);

  await assert.rejects(luxuryService.redeemPawnRecord(GUILD, OTHER_USER, record.id, 1), { code: 'PAWN_RECORD_NOT_FOUND' });
  await assert.rejects(luxuryService.redeemPawnRecord(GUILD, USER, record.id, 3), { code: 'PAWN_REDEEM_TOO_MANY' });
  const redeems = await Promise.all(Array.from({ length: 4 }, () => settle(luxuryService.redeemPawnRecord(GUILD, USER, record.id, 1))));
  assert.equal(redeems.filter((result) => result.ok).length, 2, 'a two-unit record can be redeemed twice by one unit, no more');
  assert.deepEqual([...new Set(codes(redeems))], ['PAWN_RECORD_CLOSED']);
  const closed = await harness.readRow('SELECT remaining_quantity, status FROM luxury_global_pawn_records WHERE id = ?', [record.id]);
  assert.deepEqual({ ...closed }, { remaining_quantity: 0, status: 'redeemed' });
  await harness.assertMoneyLedgersConsistent('pawn');
});

test('limited stock, a purchase limit and a small balance each hold under simultaneous purchases', async () => {
  await harness.openAttackDatabase(root);
  await fund(USER, 1_000);
  const limited = await coin.createShopItem(GUILD, { name: 'limited stock', price: 100, stock: 3, createdBy: OPERATOR });
  const capped = await coin.createShopItem(GUILD, { name: 'one each', price: 10, purchaseLimit: 1, createdBy: OPERATOR });
  const dear = await coin.createShopItem(GUILD, { name: 'costs most of the wallet', price: 600, createdBy: OPERATOR });

  const stock = await Promise.all(Array.from({ length: 8 }, () => settle(coin.purchaseItem(GUILD, USER, limited.id, 1))));
  assert.equal(stock.filter((result) => result.ok).length, 3);
  assert.deepEqual([...new Set(codes(stock))], ['OUT_OF_STOCK']);
  assert.equal((await harness.readRow('SELECT stock FROM coin_global_shop_items WHERE id = ?', [limited.id])).stock, 0);

  const limit = await Promise.all(Array.from({ length: 5 }, () => settle(coin.purchaseItem(GUILD, USER, capped.id, 1))));
  assert.equal(limit.filter((result) => result.ok).length, 1);
  assert.deepEqual([...new Set(codes(limit))], ['PURCHASE_LIMIT']);

  const balance = (await harness.readWallet(USER)).balance;
  assert.equal(balance, 1_000 - 300 - 10);
  const spend = await Promise.all([
    settle(coin.purchaseItem(GUILD, USER, dear.id, 1)),
    settle(coin.purchaseItem(GUILD, USER, dear.id, 1)),
    settle(coin.purchaseItem(GUILD, USER, dear.id, 1)),
  ]);
  assert.equal(spend.filter((result) => result.ok).length, 1, 'a 600 item cannot be bought twice with 690');
  assert.deepEqual([...new Set(codes(spend))], ['INSUFFICIENT_FUNDS']);
  assert.equal((await harness.readWallet(USER)).balance, 90);
  await harness.assertMoneyLedgersConsistent('shop');
});

test('chips cannot be cashed out beyond the balance by simultaneous requests', async () => {
  await harness.openAttackDatabase(root);
  await fund(USER, 2_000);
  await chipService.buyChips(GUILD, USER, 1_000);
  const cashouts = await Promise.all(Array.from({ length: 5 }, () => settle(chipService.cashoutChips(GUILD, USER, 400))));
  assert.equal(cashouts.filter((result) => result.ok).length, 2);
  assert.deepEqual([...new Set(codes(cashouts))], ['INSUFFICIENT_CHIPS']);
  assert.equal(await harness.readChipBalance(USER), 200);
  assert.equal((await harness.readWallet(USER)).balance, 1_000 + 2 * 300);
  await harness.assertMoneyLedgersConsistent('chips');
});

// ---------------------------------------------------------------------------------------------------------
// games
// ---------------------------------------------------------------------------------------------------------

test('a game launch with the same interaction id is played and paid once; a changed one is a conflict', async () => {
  await harness.openAttackDatabase(root);
  await fund(USER, 10_000);
  const rng = () => 0;
  const first = await casinoService.playDice(GUILD, USER, { amount: 100, choice: 'big', rng, interactionId: 'attack-ix-1' });
  const walletAfter = (await harness.readWallet(USER)).balance;
  const burst = await Promise.all(Array.from({ length: 5 }, () => settle(
    casinoService.playDice(GUILD, USER, { amount: 100, choice: 'big', rng, interactionId: 'attack-ix-1' })
  )));
  assert.ok(burst.every((result) => result.ok && result.value.alreadyApplied === true));
  assert.equal(first.alreadyApplied, false);
  assert.equal((await harness.readRows('SELECT COUNT(*) AS count FROM casino_games'))[0].count, 1);
  assert.equal((await harness.readWallet(USER)).balance, walletAfter);

  for (const changed of [{ amount: 500 }, { choice: 'small' }]) {
    await assert.rejects(casinoService.playDice(GUILD, USER, { amount: 100, choice: 'big', rng, interactionId: 'attack-ix-1', ...changed }),
      { code: 'OPERATION_CONFLICT' });
  }
  await assert.rejects(casinoService.playDice(OTHER_GUILD, USER, { amount: 100, choice: 'big', rng, interactionId: 'attack-ix-1' }),
    { code: 'OPERATION_CONFLICT' }, 'the same interaction id cannot be reused in another guild');
  await assert.rejects(casinoService.playSlots(GUILD, USER, { amount: 100, rng, interactionId: 'attack-ix-1' }),
    { code: 'OPERATION_CONFLICT' }, 'nor for another game');
  await harness.assertMoneyLedgersConsistent('launch receipts');
});

test('a blackjack hand settles once: stand, hit, expiry and rivals cannot pay it a second time', async () => {
  await harness.openAttackDatabase(root);
  await fund(USER, 10_000);
  const start = new Date('2026-03-02T01:00:00.000Z');
  const chipsIn = async () => (await harness.readChipBalance(USER));

  // player 19 against a dealer 17: stands and wins 200 for a 100 bet
  const winning = ['10S', '9H', '10D', '7C', '2S', '3S', '4S', '5S'];
  const opened = await casinoService.startBlackjack(GUILD, USER, { amount: 100, deck: winning, date: start });
  const sessionId = opened.session.id;
  await assert.rejects(casinoService.standBlackjack(GUILD, OTHER_USER, sessionId, { date: start }),
    { code: 'BLACKJACK_SESSION_OWNER_ONLY' });
  await assert.rejects(casinoService.standBlackjack(OTHER_GUILD, USER, sessionId, { date: start }),
    { code: 'BLACKJACK_SESSION_NOT_FOUND' });
  await assert.rejects(casinoService.startBlackjack(GUILD, USER, { amount: 100, deck: winning, date: start }),
    { code: 'ACTIVE_BLACKJACK_SESSION' }, 'one open hand per player and guild');
  const stands = await Promise.all([
    settle(casinoService.standBlackjack(GUILD, USER, sessionId, { date: start })),
    settle(casinoService.standBlackjack(GUILD, USER, sessionId, { date: start })),
    settle(casinoService.hitBlackjack(GUILD, USER, sessionId, { date: start })),
  ]);
  assert.ok(stands.every((result) => result.ok));
  const settledHands = (await harness.readRows("SELECT payout_amount FROM casino_blackjack_sessions WHERE id = ? AND status = 'settled'", [sessionId]));
  assert.deepEqual(settledHands.map((row) => row.payout_amount), [200]);
  const chipsSettled = await chipsIn();
  assert.equal((await harness.readRows("SELECT COUNT(*) AS count FROM casino_games WHERE game_type = 'blackjack'"))[0].count, 1);
  await casinoService.standBlackjack(GUILD, USER, sessionId, { date: start });
  await casinoService.hitBlackjack(GUILD, USER, sessionId, { date: start });
  assert.equal(await chipsIn(), chipsSettled, 'a settled hand pays nothing more');
  const expired = await casinoService.processExpiredBlackjackSessions({ date: new Date(start.getTime() + 3_600_000) });
  assert.deepEqual(expired, { checked: 0, refunded: 0 }, 'a settled hand is not refunded on expiry');
  assert.equal(await chipsIn(), chipsSettled);

  // an abandoned hand is refunded once, and cannot then be played or refunded again
  const abandoned = ['10S', '2H', '10D', '9C', '5H', '6C', '7D', '8S'];
  const later = new Date(start.getTime() + 2 * 3_600_000);
  const second = await casinoService.startBlackjack(GUILD, USER, { amount: 100, deck: abandoned, date: later });
  const afterBet = await chipsIn();
  const sweepAt = new Date(later.getTime() + 11 * 60_000);
  const sweeps = await Promise.all([
    casinoService.processExpiredBlackjackSessions({ date: sweepAt }),
    casinoService.processExpiredBlackjackSessions({ date: sweepAt }),
  ]);
  assert.equal(sweeps.reduce((sum, sweep) => sum + sweep.refunded, 0), 1);
  assert.equal(await chipsIn(), afterBet + 100);
  const late = await casinoService.standBlackjack(GUILD, USER, second.session.id, { date: sweepAt });
  assert.equal(late.settled, true);
  assert.equal(await chipsIn(), afterBet + 100);

  // a natural 21 at the start settles on the spot and cannot be played further
  const natural = await casinoService.startBlackjack(GUILD, USER, {
    amount: 100, deck: ['AS', 'KH', '9D', '9C'], date: new Date(sweepAt.getTime() + 3_600_000),
  });
  assert.equal(natural.session.status, 'settled');
  assert.equal(natural.session.payoutAmount, 250);
  await harness.assertMoneyLedgersConsistent('blackjack');
});

test('a reward is granted once per key; another amount, recipient or operation id for the key is refused', async () => {
  await harness.openAttackDatabase(root);
  const identity = {
    kind: 'game', canonicalSourceId: 'attack-session-1', rewardKind: 'win', userId: USER,
    sourceGuildId: GUILD, amount: 50, operationId: 'attack-reward-op-1',
  };
  const first = await coordinator.grant(identity);
  const burst = await Promise.all(Array.from({ length: 5 }, () => settle(coordinator.grant(identity))));
  assert.equal(first.alreadyGranted, false);
  assert.ok(burst.every((result) => result.ok && result.value.alreadyGranted === true));
  assert.equal((await harness.readWallet(USER)).balance, 50);

  await assert.rejects(coordinator.grant({ ...identity, amount: 5_000 }), { code: 'REWARD_KEY_CONFLICT' });
  await assert.rejects(coordinator.grant({ ...identity, operationId: 'attack-reward-op-2' }), { code: 'REWARD_KEY_CONFLICT' });
  await assert.rejects(coordinator.grant({ ...identity, canonicalSourceId: 'attack-session-2' }), { code: 'OPERATION_CONFLICT' });
  const sameSourceOtherUser = await coordinator.grant({ ...identity, userId: OTHER_USER, operationId: 'attack-reward-op-3' });
  assert.equal(sameSourceOtherUser.alreadyGranted, false, 'a different recipient is a different reward');
  assert.equal((await harness.readWallet(USER)).balance, 50);
  assert.equal((await harness.readWallet(OTHER_USER)).balance, 50);

  const legacy = await featurePlatform.grantRewardOnce(GUILD, USER, 'game', 'attack-legacy-source', 'win', 10);
  const legacyBurst = await Promise.all(Array.from({ length: 4 }, () => featurePlatform.grantRewardOnce(
    GUILD, USER, 'game', 'attack-legacy-source', 'win', 10
  )));
  assert.equal(legacy.alreadyGranted, false);
  assert.ok(legacyBurst.every((result) => result.alreadyGranted === true));
  assert.equal((await harness.readWallet(USER)).balance, 60);
  await harness.assertMoneyLedgersConsistent('rewards');
});

// ---------------------------------------------------------------------------------------------------------
// salary, penalties and venue tips
// ---------------------------------------------------------------------------------------------------------

async function startPrimaryJob(clock, userId, jobName, days) {
  await workService.startJob(GUILD, userId, jobName, days);
  clock.at('2026-03-02T14:00:00.000Z');
  const activation = await workService.processDueJobs(null);
  assert.equal(activation.activations.activated >= 1, true);
  clock.advance(60_000);
}

test('a primary job pays its salary once however often and however many times at once payroll runs', async (t) => {
  const clock = harness.startClock(t, '2026-03-02T01:00:00.000Z');
  await harness.openAttackDatabase(root);
  await fund(USER, 10);
  await startPrimaryJob(clock, USER, '會計師', 2);
  const task = await workService.reportWork(GUILD, USER, { description: 'daily report', channelName: '會計師' });
  assert.equal(task.task.status, 'pending');

  clock.at('2026-03-04T13:59:59.000Z');
  assert.deepEqual((await workService.processDueJobs(null)).primaryCycles,
    { checked: 0, settled: 0, failed: 0, roleCleanupFailed: 0 }, 'nothing is paid before the cycle ends');
  assert.equal((await harness.readWallet(USER)).balance, 10);

  clock.at('2026-03-04T14:00:01.000Z');
  const runs = await Promise.all([
    workService.processDueJobs(null), workService.processDueJobs(null), workService.processDueJobs(null),
  ]);
  assert.equal(runs.reduce((sum, run) => sum + run.primaryCycles.settled, 0), 1);
  assert.equal((await harness.readWallet(USER)).balance, 10 + 2 * 500);
  const replay = await workService.processDueJobs(null);
  assert.deepEqual(replay.primaryCycles, { checked: 0, settled: 0, failed: 0, roleCleanupFailed: 0 });
  assert.equal((await harness.readRows('SELECT COUNT(*) AS count FROM coin_primary_cycle_payroll'))[0].count, 1);
  assert.equal((await harness.readRows("SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE kind = 'work-settlement'"))[0].count, 1);
  await harness.assertMoneyLedgersConsistent('payroll');
});

test('a primary penalty is refunded once after an approved appeal, and only the owner can approve it', async (t) => {
  const clock = harness.startClock(t, '2026-03-02T01:00:00.000Z');
  await harness.openAttackDatabase(root);
  await startPrimaryJob(clock, USER, '會計師', 3);
  await workService.reportWork(GUILD, USER, { description: 'daily report', channelName: '會計師' });
  await workService.addPendingTask(GUILD, USER, { description: 'an assignment that will be missed', dueHours: 10 });
  clock.advance(25 * 3_600_000);
  const swept = await workService.processExpiredPrimaryTasks({ date: new Date() });
  assert.deepEqual(swept, { checked: 1, completed: 1, penalties: 1 });

  clock.at('2026-03-05T14:00:01.000Z');
  assert.equal((await workService.processDueJobs(null)).primaryCycles.settled, 1);
  const wallet = (await harness.readWallet(USER)).balance;
  assert.equal(wallet, 3 * 500 - 500, 'three days of salary less the one-day penalty');

  const [penalty] = await workService.listPrimaryPenalties(USER, { limit: 5 });
  assert.equal(penalty.amount, 500);
  const appeal = await workService.createPrimaryPenaltyAppeal(USER, penalty.id, { reason: 'I was ill' });
  await assert.rejects(workService.createPrimaryPenaltyAppeal(USER, penalty.id, { reason: 'again' }),
    { code: 'PENALTY_APPEAL_EXISTS' });
  await assert.rejects(workService.createPrimaryPenaltyAppeal(OTHER_USER, penalty.id, { reason: 'not mine' }),
    { code: 'PENALTY_NOT_FOUND' });
  await assert.rejects(workService.reviewPrimaryPenaltyAppeal(USER, appeal.appealId, { action: 'approved' }),
    { code: 'OWNER_REQUIRED' }, 'the penalised member cannot approve their own appeal');
  assert.equal((await harness.readWallet(USER)).balance, wallet);

  const approvals = await Promise.all(Array.from({ length: 4 }, () => settle(
    workService.reviewPrimaryPenaltyAppeal(OPERATOR, appeal.appealId, { action: 'approved' })
  )));
  assert.equal(approvals.filter((result) => result.ok).length, 1);
  assert.deepEqual([...new Set(codes(approvals))], ['APPEAL_NOT_PENDING']);
  assert.equal((await harness.readWallet(USER)).balance, wallet + 500);
  await assert.rejects(workService.reviewPrimaryPenaltyAppeal(OPERATOR, appeal.appealId, { action: 'approved' }),
    { code: 'APPEAL_NOT_PENDING' });
  assert.equal((await harness.readWallet(USER)).balance, wallet + 500);
  await harness.assertMoneyLedgersConsistent('penalty refund');
});

test('an appealed old-style penalty refunds in total no more than payroll really took, in any order', async () => {
  const { withCoinTransaction } = require('../src/services/coinDatabase');
  const logger = require('../src/utils/logger');
  await harness.openAttackDatabase(root);
  const STARTED = '2026-04-01T01:00:00.000Z';
  const PAY_AT = '2026-04-03T14:00:00.000Z';
  const DEADLINE = '2099-01-01T00:00:00.000Z';
  const penaltyIds = [];
  // An old-style job: 400 a day for 2 days, one finished task, and three penalties of 500 that together are
  // more than the 800 it could pay, so payroll marks all of them applied while only 800 was ever there to take.
  await withCoinTransaction((api) => {
    api.run(`INSERT INTO coin_jobs
      (guild_id,user_id,job_name,job_role_id,daily_salary,work_days,total_salary,status,is_paid,start_at,pay_at,
       last_contribution_at,today_task_count,today_completed_task_count,no_work_available_today,payroll_status,
       created_at,updated_at) VALUES (?,?,'老師',NULL,400,2,800,'active',0,?,?,NULL,0,0,0,'pending',?,?)`,
    [GUILD, USER, STARTED, PAY_AT, STARTED, STARTED]);
    const jobId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    api.run(`INSERT INTO coin_work_tasks
      (guild_id,user_id,job_id,job_name,task_type,status,description,attachment_urls,expected_channel_id,
       expected_channel_name,message_id,external_server_count,external_server_ids,created_at,due_at,completed_at,updated_at)
      VALUES (?,?,?,'老師','daily','completed','finished',  '[]',NULL,'老師',NULL,0,'[]',?,?,?,?)`,
    [GUILD, USER, jobId, STARTED, DEADLINE, STARTED, STARTED]);
    for (let index = 0; index < 3; index += 1) {
      api.run(`INSERT INTO coin_work_penalties
        (guild_id,user_id,job_id,job_name,task_id,source_type,source_id,source_channel_id,penalty_date,daily_salary,
         penalty_amount,status,reason,appeal_deadline_at,created_at,updated_at)
        VALUES (?,?,?,'老師',NULL,'synthetic',NULL,NULL,'2026-04-01',400,500,'active','synthetic penalty',?,?,?)`,
      [GUILD, USER, jobId, DEADLINE, STARTED, STARTED]);
      penaltyIds.push(Number(api.get('SELECT last_insert_rowid() AS id').id));
    }
  });
  await workService.captureLegacyJobBatch();
  const original = { error: logger.error, warn: logger.warn, info: logger.info };
  for (const level of Object.keys(original)) logger[level] = () => {};
  try {
    assert.equal((await workService.processDueJobs(null)).success, 1);
  } finally {
    Object.assign(logger, original);
  }
  const payroll = (await harness.readRows('SELECT paid_amount FROM coin_payroll_history WHERE user_id = ?', [USER]))[0];
  assert.equal(payroll.paid_amount, 0, 'the penalties used up the whole pay');

  // The last penalty is appealed first. A repeated approval and a second appeal do nothing.
  const refunds = [];
  for (const penaltyId of [...penaltyIds].reverse()) {
    const { appeal } = await workService.createWorkPenaltyAppeal(GUILD, USER, penaltyId, { reason: 'attack' });
    const reviewed = await workService.reviewWorkPenaltyAppeal(GUILD, OPERATOR, appeal.id, { action: 'approved' });
    refunds.push(reviewed.refund ? reviewed.refund.amount : 0);
    await assert.rejects(workService.reviewWorkPenaltyAppeal(GUILD, OPERATOR, appeal.id, { action: 'approved' }),
      { code: 'APPEAL_ALREADY_REVIEWED' });
    await assert.rejects(workService.createWorkPenaltyAppeal(GUILD, USER, penaltyId, { reason: 'again' }),
      { code: 'PENALTY_NOT_APPEALABLE' });
  }
  assert.equal(refunds.reduce((sum, amount) => sum + amount, 0), 800, 'refunds add up to what was taken, no more');
  assert.equal((await harness.readWallet(USER)).balance, 800);
  await harness.assertMoneyLedgersConsistent('old-style penalties');
});

async function openVenue(t) {
  const clock = harness.startClock(t, '2026-03-02T01:00:00.000Z');
  await harness.openAttackDatabase(root);
  await fund(CUSTOMER, 5_000);
  await workService.startVenueJobs(GUILD, WAITER, { days: 3, waiter: '服務生' });
  await workService.startVenueJobs(GUILD, CHEF, { days: 3, chef: true });
  clock.at('2026-03-02T14:00:00.000Z');
  const activation = await workService.processDueJobs(null);
  assert.deepEqual(activation.activations, { checked: 2, activated: 2 });
  clock.at('2026-03-03T01:00:00.000Z');
  const menu = await venueService.listVenueMenu(GUILD);
  const meal = menu.find((entry) => entry.itemType === 'meal');
  assert.ok(meal, 'the default menu has a meal');
  const membership = { guildId: GUILD, verifiedUserIds: [CUSTOMER, WAITER, CHEF], rosterComplete: false };
  return { clock, mealId: meal.id, membership };
}

// With no second argument the tip is 60; an explicit undefined is passed through as it is.
async function placeOrder(venue, ...rest) {
  const tipAmount = rest.length ? rest[0] : 60;
  return venueService.createVenueOrder(GUILD, CUSTOMER, {
    mealId: venue.mealId, chefId: CHEF, waiterId: WAITER, tipAmount, channelId: 'venue-channel', membership: venue.membership,
  });
}

test('a tip below the waiter minimum, or not a whole number of chips, is refused before any chip moves', async (t) => {
  const venue = await openVenue(t);
  const before = await harness.snapshotAllTables();
  const hostile = [0, -1, -60, Number.NaN, Number.POSITIVE_INFINITY, 1.5, 49, '49', 'abc', '', null, undefined, {}, [],
    Number.MAX_SAFE_INTEGER, 2 ** 53, 1e12, 9_000_000_001, 9007199254740993n];
  for (const tipAmount of hostile) {
    const error = await harness.assertRejectedWithoutWrites(() => placeOrder(venue, tipAmount), `tip ${String(tipAmount)}`);
    assert.equal(typeof error.code, 'string', `tip ${String(tipAmount)}: ${error.message}`);
  }
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);
  const placed = await placeOrder(venue, '50');
  assert.equal(placed.order.tipAmount, 50, 'a numeric text that means 50 is applied as exactly 50');
  assert.equal(placed.order.tipStatus, 'escrowed');
});

test('a tip is paid to the waiter once; serving again, by the customer or by a stranger, pays nothing', async (t) => {
  const venue = await openVenue(t);
  const placed = await placeOrder(venue, 60);
  const [item] = placed.items;
  const chefSteps = '熱鍋下油\n加入白飯拌炒\n盛盤';
  await assert.rejects(venueService.serveVenueOrder(GUILD, WAITER, placed.order.id), { code: 'VENUE_ORDER_NOT_READY' });
  await assert.rejects(venueService.completeVenueOrderItem(GUILD, WAITER, item.id, { steps: chefSteps }),
    { code: 'VENUE_MAKE_OWNER_ONLY' });
  await assert.rejects(venueService.completeVenueOrderItem(GUILD, CHEF, item.id, { steps: 's'.repeat(1_001) }),
    { code: 'INVALID_VENUE_STEPS' });
  await assert.rejects(venueService.completeVenueOrderItem(GUILD, CHEF, item.id, { steps: '   ' }),
    { code: 'INVALID_VENUE_STEPS' });
  await venueService.completeVenueOrderItem(GUILD, CHEF, item.id, { steps: chefSteps });
  await assert.rejects(venueService.completeVenueOrderItem(GUILD, CHEF, item.id, { steps: chefSteps }),
    { code: 'VENUE_ORDER_ITEM_NOT_PENDING' });

  const waiterChips = await harness.readChipBalance(WAITER);
  await assert.rejects(venueService.serveVenueOrder(GUILD, CUSTOMER, placed.order.id), { code: 'VENUE_SERVE_OWNER_ONLY' });
  await assert.rejects(venueService.serveVenueOrder(GUILD, CHEF, placed.order.id), { code: 'VENUE_SERVE_OWNER_ONLY' });
  await assert.rejects(venueService.serveVenueOrder(OTHER_GUILD, WAITER, placed.order.id), { code: 'VENUE_ORDER_NOT_FOUND' });
  const serves = await Promise.all(Array.from({ length: 4 }, () => settle(venueService.serveVenueOrder(GUILD, WAITER, placed.order.id))));
  assert.equal(serves.filter((result) => result.ok).length, 1);
  assert.deepEqual([...new Set(codes(serves))], ['VENUE_ORDER_ALREADY_SERVED']);
  assert.equal(await harness.readChipBalance(WAITER), waiterChips + 60);

  // After service the order cannot be cancelled into a refund, and the sweep leaves a paid tip alone.
  await assert.rejects(venueService.cancelVenueOrderItem(GUILD, item.id, { operatorId: OPERATOR }),
    { code: 'VENUE_ORDER_ITEM_NOT_PENDING' });
  venue.clock.advance(3 * DAY);
  const sweeps = await Promise.all([
    venueService.processExpiredVenueOrderItems({ date: new Date() }),
    venueService.processExpiredVenueOrderItems({ date: new Date() }),
  ]);
  assert.equal(sweeps.reduce((sum, sweep) => sum + sweep.waiterRefunded, 0), 0);
  assert.equal(await harness.readChipBalance(WAITER), waiterChips + 60);
  assert.equal((await harness.readRow('SELECT tip_status FROM casino_venue_orders WHERE id = ?', [placed.order.id])).tip_status, 'paid');
  await harness.assertMoneyLedgersConsistent('tip paid');
});

test('an unserved tip goes back to the customer once, whether the order is cancelled or swept twice', async (t) => {
  const venue = await openVenue(t);
  const cancelled = await placeOrder(venue, 70);
  const chipsBefore = await harness.readChipBalance(CUSTOMER);
  const first = await venueService.cancelVenueOrderItem(GUILD, cancelled.items[0].id, { operatorId: OPERATOR, reason: 'attack' });
  assert.equal(first.status, 'cancelled');
  assert.equal(await harness.readChipBalance(CUSTOMER), chipsBefore + 70);
  await assert.rejects(venueService.cancelVenueOrderItem(GUILD, cancelled.items[0].id, { operatorId: OPERATOR }),
    { code: 'VENUE_ORDER_ITEM_NOT_PENDING' });
  assert.equal(await harness.readChipBalance(CUSTOMER), chipsBefore + 70);

  const overdue = await placeOrder(venue, 80);
  const chipsAfterOrder = await harness.readChipBalance(CUSTOMER);
  venue.clock.advance(2 * DAY);
  const sweeps = await Promise.all([
    venueService.processExpiredVenueOrderItems({ date: new Date() }),
    venueService.processExpiredVenueOrderItems({ date: new Date() }),
  ]);
  assert.equal(sweeps.reduce((sum, sweep) => sum + sweep.waiterRefunded, 0), 1);
  assert.equal(await harness.readChipBalance(CUSTOMER), chipsAfterOrder + 80);
  await venueService.processExpiredVenueOrderItems({ date: new Date() });
  assert.equal(await harness.readChipBalance(CUSTOMER), chipsAfterOrder + 80);
  assert.equal((await harness.readRow('SELECT tip_status FROM casino_venue_orders WHERE id = ?', [overdue.order.id])).tip_status,
    'refunded');
  await harness.assertMoneyLedgersConsistent('tip refunds');
});

// ---------------------------------------------------------------------------------------------------------
// a failure in the middle of a write leaves nothing behind
// ---------------------------------------------------------------------------------------------------------

// Everything an operation below might need, built through the real services.
async function seedForAtomicity() {
  await fund(USER, 1_000_000);
  await bankService.deposit(GUILD, USER, 100_000);
  await chipService.buyChips(GUILD, USER, 100_000);
  await casinoService.borrowCasinoLoan(GUILD, USER, { amount: 20_000 });
  const shop = await coin.createShopItem(GUILD, { name: 'atomic shop item', price: 50, stock: 10, createdBy: OPERATOR });
  const battle = await coin.createShopItem(GUILD, {
    name: 'atomic battle item', price: 100, type: 'battle_item', createdBy: OPERATOR,
  });
  await coin.purchaseItem(GUILD, USER, battle.id, 1);
  const luxury = await luxuryService.createLuxuryItem(GUILD, { name: 'atomic luxury item', price: 1_000, createdBy: OPERATOR });
  await luxuryService.purchaseLuxuryItem(GUILD, USER, luxury.id, 6);
  const pawned = await luxuryService.pawnLuxuryItem(GUILD, USER, luxury.id, 2);
  return { shopId: shop.id, battleId: battle.id, luxuryId: luxury.id, pawnRecordId: pawned.record.id };
}

const NOW = '2026-03-02T01:00:00.000Z';

// Each case names the write that is made to fail, the operation to attempt and what the one successful
// application leaves behind. `prepare` may move the clock or make a deposit.
const ATOMICITY_CASES = [
  {
    name: 'admin balance adjustment (receipt is the last write)',
    fault: { name: 'fault_receipt', table: 'coin_operation_receipts' },
    attempt: () => coin.adjustPlayerBalance(GUILD, USER, {
      action: 'add', amount: 500, operatorId: OPERATOR, reason: 'atomic', operationId: 'attack-atomic-adjust',
    }),
    expectOnce: async (_, before) => assert.equal((await harness.readWallet(USER)).balance, before.wallet + 500),
  },
  {
    name: 'daily check-in (streak is written before the payout)',
    fault: { name: 'fault_daily', table: 'coin_transactions', when: "NEW.type = 'daily_checkin'" },
    attempt: () => coin.dailyCheckin(GUILD, USER, new Date(NOW)),
    expectOnce: async () => assert.equal(
      (await harness.readRows('SELECT COUNT(*) AS count FROM coin_daily_checkins_global WHERE user_id = ?', [USER]))[0].count, 1),
  },
  {
    name: 'bank deposit (bank balance is written before the wallet)',
    fault: { name: 'fault_deposit', table: 'coin_transactions', when: "NEW.type = 'bank_deposit'" },
    attempt: () => bankService.deposit(GUILD, USER, 5_000),
    expectOnce: async (_, before) => assert.equal(await harness.readBankBalance(USER), before.bank + 5_000),
  },
  {
    name: 'bank withdrawal',
    fault: { name: 'fault_withdraw', table: 'coin_transactions', when: "NEW.type = 'bank_withdraw'" },
    attempt: () => bankService.withdraw(GUILD, USER, 5_000),
    expectOnce: async (_, before) => assert.equal(await harness.readBankBalance(USER), before.bank - 5_000),
  },
  {
    name: 'fixed deposit creation (deposit row is written before the wallet)',
    fault: { name: 'fault_fixed_create', table: 'coin_transactions', when: "NEW.type = 'fixed_deposit_create'" },
    attempt: () => bankService.createFixedDeposit(GUILD, USER, { amount: 5_000, termDays: 7 }),
    expectOnce: async () => assert.equal(
      (await harness.readRows('SELECT COUNT(*) AS count FROM coin_fixed_deposits WHERE user_id = ?', [USER]))[0].count, 1),
  },
  {
    name: 'fixed deposit claim (principal is returned, then the interest write fails)',
    prepare: async (context, clock) => {
      context.deposit = await bankService.createFixedDeposit(GUILD, USER, { amount: 100_000, termDays: 7 });
      clock.at('2026-03-10T01:00:00.000Z');
    },
    fault: { name: 'fault_claim', table: 'coin_transactions', when: "NEW.type = 'fixed_deposit_interest'" },
    attempt: (context) => bankService.claimFixedDeposit(GUILD, USER, context.deposit.id),
    expectOnce: async (context) => assert.equal(
      (await harness.readRow('SELECT status FROM coin_fixed_deposits WHERE id = ?', [context.deposit.id])).status, 'claimed'),
  },
  {
    name: 'fixed deposit early cancellation (principal is returned, then the interest write fails)',
    prepare: async (context, clock) => {
      context.deposit = await bankService.createFixedDeposit(GUILD, USER, { amount: 100_000, termDays: 7 });
      clock.at('2026-03-06T01:00:00.000Z');
    },
    fault: { name: 'fault_cancel', table: 'coin_transactions', when: "NEW.type = 'fixed_deposit_interest'" },
    attempt: (context) => bankService.cancelFixedDeposit(GUILD, USER, context.deposit.id),
    expectOnce: async (context) => assert.equal(
      (await harness.readRow('SELECT status FROM coin_fixed_deposits WHERE id = ?', [context.deposit.id])).status, 'cancelled'),
  },
  {
    name: 'shop purchase (wallet, stock and inventory move before the purchase row)',
    fault: { name: 'fault_shop', table: 'coin_global_purchases' },
    attempt: (context) => coin.purchaseItem(GUILD, USER, context.shopId, 2),
    expectOnce: async (context) => assert.equal(
      (await harness.readRow('SELECT stock FROM coin_global_shop_items WHERE id = ?', [context.shopId])).stock, 8),
  },
  {
    name: 'luxury purchase',
    fault: { name: 'fault_luxury', table: 'luxury_global_purchases' },
    attempt: (context) => luxuryService.purchaseLuxuryItem(GUILD, USER, context.luxuryId, 1),
    expectOnce: async (context) => assert.equal((await harness.readRow(
      'SELECT quantity FROM luxury_global_inventory WHERE user_id = ? AND item_id = ?', [USER, context.luxuryId])).quantity, 5),
  },
  {
    name: 'pawn (inventory and record are written before the payout)',
    fault: { name: 'fault_pawn', table: 'coin_transactions', when: "NEW.type = 'pawn_payout'" },
    attempt: (context) => luxuryService.pawnLuxuryItem(GUILD, USER, context.luxuryId, 1),
    expectOnce: async (context) => assert.equal((await harness.readRow(
      'SELECT quantity FROM luxury_global_inventory WHERE user_id = ? AND item_id = ?', [USER, context.luxuryId])).quantity, 3),
  },
  {
    name: 'pawn of a whole stack (the stack is deleted before the payout)',
    fault: { name: 'fault_pawn_stack', table: 'coin_transactions', when: "NEW.type = 'pawn_payout'" },
    attempt: (context) => luxuryService.pawnLuxuryItem(GUILD, USER, context.luxuryId, 4),
    expectOnce: async (context) => assert.deepEqual(await harness.readRows(
      'SELECT quantity FROM luxury_global_inventory WHERE user_id = ? AND item_id = ?', [USER, context.luxuryId]), []),
  },
  {
    name: 'pawn redemption (wallet and inventory move before the redemption row)',
    fault: { name: 'fault_redeem', table: 'luxury_global_pawn_redemptions' },
    attempt: (context) => luxuryService.redeemPawnRecord(GUILD, USER, context.pawnRecordId, 1),
    expectOnce: async (context) => assert.equal((await harness.readRow(
      'SELECT remaining_quantity FROM luxury_global_pawn_records WHERE id = ?', [context.pawnRecordId])).remaining_quantity, 1),
  },
  {
    name: 'chip purchase (wallet is debited before the chip ledger)',
    fault: { name: 'fault_chip_buy', table: 'chip_ledger', when: "NEW.entry_type = 'buy'" },
    attempt: () => chipService.buyChips(GUILD, USER, 1_000),
    expectOnce: async (_, before) => assert.equal(await harness.readChipBalance(USER), before.chips + 1_000),
  },
  {
    name: 'chip cashout (wallet is credited before the chip ledger)',
    fault: { name: 'fault_chip_cashout', table: 'chip_ledger', when: "NEW.entry_type = 'cashout'" },
    attempt: () => chipService.cashoutChips(GUILD, USER, 1_000),
    expectOnce: async (_, before) => assert.equal(await harness.readChipBalance(USER), before.chips - 1_000),
  },
  {
    name: 'loan borrowing (loan and chips are written before the casino ledger)',
    fault: { name: 'fault_borrow', table: 'casino_ledger', when: "NEW.entry_type = 'loan_borrow'" },
    attempt: () => casinoService.borrowCasinoLoan(GUILD, USER, { amount: 1_000, date: new Date(NOW) }),
    expectOnce: async (_, before) => assert.equal(await harness.readChipBalance(USER), before.chips + 1_000),
  },
  {
    name: 'loan repayment',
    fault: { name: 'fault_repay', table: 'casino_ledger', when: "NEW.entry_type = 'loan_repay'" },
    attempt: () => casinoService.repayCasinoLoan(GUILD, USER, { amount: 1_000, date: new Date(NOW) }),
    expectOnce: async (_, before) => assert.equal(await harness.readChipBalance(USER), before.chips - 1_000),
  },
  {
    name: 'forced collection (bank and wallet are written before the casino ledger)',
    fault: { name: 'fault_collect', table: 'casino_ledger', when: "NEW.entry_type = 'loan_forced_collection'" },
    attempt: () => casinoService.collectCasinoDebt(GUILD, USER, { amount: 1_000, operatorId: OPERATOR, date: new Date(NOW) }),
    expectOnce: async (_, before) => assert.equal((await harness.readWallet(USER)).balance, before.wallet - 1_000),
  },
  {
    name: 'dice game (bet and payout are written before the game row)',
    fault: { name: 'fault_dice', table: 'casino_games' },
    attempt: () => casinoService.playDice(GUILD, USER, {
      amount: 100, choice: 'big', rng: () => 0, interactionId: 'attack-atomic-dice', date: new Date(NOW),
    }),
    expectOnce: async () => assert.equal((await harness.readRows('SELECT COUNT(*) AS count FROM casino_games'))[0].count, 1),
  },
  {
    name: 'blackjack start (the bet is taken before the session row)',
    fault: { name: 'fault_blackjack', table: 'casino_blackjack_sessions' },
    attempt: () => casinoService.startBlackjack(GUILD, USER, {
      amount: 100, deck: ['10S', '2H', '10D', '9C', '5H', '6C'], date: new Date(NOW),
    }),
    expectOnce: async () => assert.equal(
      (await harness.readRows("SELECT COUNT(*) AS count FROM casino_blackjack_sessions WHERE status = 'active'"))[0].count, 1),
  },
  {
    name: 'duel tower run (the wager is taken before the run row)',
    fault: { name: 'fault_duel', table: 'casino_duel_tower_runs' },
    attempt: (context) => casinoFacility.enterDuelTower(GUILD, USER, {
      weaponItemId: context.battleId, wager: 100, rng: () => 0, interactionId: 'attack-atomic-duel', date: new Date(NOW),
    }),
    expectOnce: async () => assert.equal((await harness.readRows('SELECT COUNT(*) AS count FROM casino_duel_tower_runs'))[0].count, 1),
  },
  {
    name: 'lodging booking (chips are taken before the booking row)',
    fault: { name: 'fault_lodging', table: 'casino_lodging_bookings' },
    attempt: () => casinoFacility.bookLodging(GUILD, USER, { roomType: 'standard', nights: 2, date: new Date(NOW) }),
    expectOnce: async (_, before) => assert.equal(await harness.readChipBalance(USER), before.chips - 160),
  },
  {
    name: 'reward grant (wallet is credited before the receipt)',
    fault: { name: 'fault_reward', table: 'reward_grants_v2' },
    attempt: () => coordinator.grant({
      kind: 'game', canonicalSourceId: 'attack-atomic-reward', rewardKind: 'win', userId: USER,
      sourceGuildId: GUILD, amount: 75, operationId: 'attack-atomic-reward-op',
    }),
    expectOnce: async (_, before) => assert.equal((await harness.readWallet(USER)).balance, before.wallet + 75),
  },
];

for (const scenario of ATOMICITY_CASES) {
  test(`${scenario.name}: a failure in the middle rolls everything back and a retry applies once`, async (t) => {
    const clock = harness.startClock(t, NOW);
    await harness.openAttackDatabase(root);
    const context = await seedForAtomicity();
    if (scenario.prepare) await scenario.prepare(context, clock);
    await harness.assertMoneyLedgersConsistent(`${scenario.name} (before)`);
    const start = {
      wallet: (await harness.readWallet(USER)).balance,
      chips: await harness.readChipBalance(USER),
      bank: await harness.readBankBalance(USER),
    };

    const disarm = await harness.armFault(scenario.fault);
    const before = await harness.snapshotAllTables();
    const failure = await settle(Promise.resolve().then(() => scenario.attempt(context)));
    assert.equal(failure.ok, false, 'the operation must fail when one of its writes fails');
    assert.match(failure.error.message, /synthetic fault/u);
    const after = await harness.snapshotAllTables();
    assert.deepEqual(harness.changedTables(before, after), [],
      'a failure part-way through must leave every table exactly as it was');
    await harness.assertMoneyLedgersConsistent(`${scenario.name} (after the failure)`);
    await disarm();

    // The same request, retried, is applied exactly once and is not blocked by a leftover.
    const retried = await settle(Promise.resolve().then(() => scenario.attempt(context)));
    assert.equal(retried.ok, true, `the retry must succeed: ${retried.ok ? '' : retried.error.message}`);
    await scenario.expectOnce(context, start);
    await harness.assertMoneyLedgersConsistent(`${scenario.name} (after the retry)`);
  });
}

test('salary settlement is all or nothing: a failed write keeps the cycle open, a retry pays once', async (t) => {
  const clock = harness.startClock(t, NOW);
  await harness.openAttackDatabase(root);
  await fund(USER, 10);
  await startPrimaryJob(clock, USER, '會計師', 2);
  await workService.reportWork(GUILD, USER, { description: 'daily report', channelName: '會計師' });
  clock.at('2026-03-04T14:00:01.000Z');
  const disarm = await harness.armFault({ name: 'fault_payroll', table: 'coin_primary_cycle_payroll' });
  const before = await harness.snapshotAllTables();
  // The settlement logs the failure it was made to hit; the log is not what this test is about.
  const logger = require('../src/utils/logger');
  const loggedError = logger.error;
  logger.error = () => {};
  let failed;
  try {
    failed = await workService.processDueJobs(null);
  } finally {
    logger.error = loggedError;
  }
  assert.deepEqual(failed.primaryCycles, { checked: 1, settled: 0, failed: 1, roleCleanupFailed: 0 });
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);
  assert.equal((await harness.readWallet(USER)).balance, 10);
  await disarm();
  const paid = await workService.processDueJobs(null);
  assert.deepEqual(paid.primaryCycles, { checked: 1, settled: 1, failed: 0, roleCleanupFailed: 0 });
  assert.equal((await harness.readWallet(USER)).balance, 10 + 1_000);
  await harness.assertMoneyLedgersConsistent('payroll fault');
});

test('a venue order and a tip payout are all or nothing', async (t) => {
  const venue = await openVenue(t);
  const customerChips = async () => harness.readChipBalance(CUSTOMER);
  const chipsStart = await customerChips();

  const orderFault = await harness.armFault({ name: 'fault_venue_item', table: 'casino_venue_order_items' });
  const beforeOrder = await harness.snapshotAllTables();
  await assert.rejects(placeOrder(venue, 60), /synthetic fault/u);
  assert.deepEqual(harness.changedTables(beforeOrder, await harness.snapshotAllTables()), []);
  assert.equal(await customerChips(), chipsStart, 'the escrowed tip must come back with the failed order');
  await orderFault();

  const placed = await placeOrder(venue, 60);
  await venueService.completeVenueOrderItem(GUILD, CHEF, placed.items[0].id, { steps: '熱鍋下油\n加入白飯拌炒\n盛盤' });
  const waiterChips = await harness.readChipBalance(WAITER);
  const serveFault = await harness.armFault({
    name: 'fault_venue_serve', table: 'coin_admin_logs', when: "NEW.action = 'venue:serve'",
  });
  const beforeServe = await harness.snapshotAllTables();
  await assert.rejects(venueService.serveVenueOrder(GUILD, WAITER, placed.order.id), /synthetic fault/u);
  assert.deepEqual(harness.changedTables(beforeServe, await harness.snapshotAllTables()), []);
  assert.equal(await harness.readChipBalance(WAITER), waiterChips, 'a failed service must not leave the tip paid');
  await serveFault();
  await venueService.serveVenueOrder(GUILD, WAITER, placed.order.id);
  assert.equal(await harness.readChipBalance(WAITER), waiterChips + 60);
  await harness.assertMoneyLedgersConsistent('venue faults');
});
