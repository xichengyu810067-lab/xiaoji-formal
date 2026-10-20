'use strict';

// Attack tests for the money rules: what a member can do with the rules as they are written to come out ahead.
//
// The other attack files ask whether the code does what it says. This one asks whether what it says is safe:
// is a game worth less than the stake on average, can a hand be settled before the dealer has played, can a
// pawn shop round trip gain, can a stack be used up completely. Each attack plays the real service against a
// synthetic database in the temporary directory, with the random source replaced by an exact enumeration where
// a rate is measured, so a result is a fact and not a sample.
//
// A test that passes is a defence that held.

const test = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./support/securityAttackHarness');

const root = harness.createAttackEnvironment('xiaoji-attack-rules-');

const coin = require('../src/services/coinService');
const luxuryService = require('../src/services/luxuryService');
const casinoService = require('../src/services/casinoService');

const GUILD = '840000000000000001';
const USER = '840000000000000011';
const OPERATOR = '840000000000000099';
const START = new Date('2026-03-02T01:00:00.000Z');

test.after(() => harness.closeAttackDatabase(root));

let fundings = 0;
async function fund(userId, amount, guildId = GUILD) {
  fundings += 1;
  return coin.adjustPlayerBalance(guildId, userId, {
    action: 'add', amount, operatorId: OPERATOR, reason: 'attack seed', operationId: `attack-rules-fund-${fundings}`,
  });
}

// What the player owns in coins and chips, which is what a game can add to or take from.
async function holdings(userId = USER) {
  return (await harness.readWallet(userId))?.balance + await harness.readChipBalance(userId);
}

// A random source that returns the given numbers in order, so a game is played with exactly one outcome.
function sequence(values) {
  let index = 0;
  return () => values[index++];
}

// ---------------------------------------------------------------------------------------------------------
// Games
// ---------------------------------------------------------------------------------------------------------

test('dice and roulette pay back less than they take, on the choices that matter', async () => {
  await harness.openAttackDatabase(root);
  await fund(USER, 10_000_000);
  const BET = 100;
  const rates = {};
  for (const choice of ['big', 'small', 'seven']) {
    let paid = 0;
    let staked = 0;
    for (let first = 0; first < 6; first += 1) {
      for (let second = 0; second < 6; second += 1) {
        const result = await casinoService.playDice(GUILD, USER, { amount: BET, choice, rng: sequence([first, second]) });
        paid += result.payoutAmount;
        staked += BET;
      }
    }
    rates[`dice ${choice}`] = paid / staked;
  }
  for (const choice of ['red', 'odd', 'zero']) {
    let paid = 0;
    let staked = 0;
    for (let number = 0; number < 37; number += 1) {
      const result = await casinoService.playRoulette(GUILD, USER, { amount: BET, choice, rng: sequence([number]) });
      paid += result.payoutAmount;
      staked += BET;
    }
    rates[`roulette ${choice}`] = paid / staked;
  }
  for (const [name, rate] of Object.entries(rates)) assert.ok(rate < 1, `${name} pays back ${rate.toFixed(3)} per chip staked`);
  await harness.assertMoneyLedgersConsistent('dice and roulette');
});

test('a hand that reaches 21 by hitting is settled against a dealer who plays the hand out', async () => {
  await harness.openAttackDatabase(root);
  await fund(USER, 10_000);
  const at = (hours) => new Date(START.getTime() + hours * 3_600_000);

  // Player 5 + 6 against a dealer 10 + 2. A hit gives the player 21 and the dealer's next card is a 9: the dealer
  // draws it, also has 21, and the hand pushes, returning the 100 staked.
  const push = await casinoService.startBlackjack(GUILD, USER, {
    amount: 100, deck: ['5S', '6H', '10D', '2C', '10S', '9H', '2D', '3D'], date: at(0),
  });
  const pushed = await casinoService.hitBlackjack(GUILD, USER, push.session.id, { date: at(0) });
  assert.equal(pushed.session.status, 'settled');
  assert.equal(pushed.session.payoutAmount, 100, 'a dealer who reaches 21 pushes a player who reached 21');

  // The same hit when the dealer's next card busts the dealer: the player wins 2x.
  const win = await casinoService.startBlackjack(GUILD, USER, {
    amount: 100, deck: ['5S', '6H', '10D', '6C', '10S', '10H', '2D', '3D'], date: at(1),
  });
  const won = await casinoService.hitBlackjack(GUILD, USER, win.session.id, { date: at(1) });
  assert.equal(won.session.payoutAmount, 200);

  // Going over 21 loses at once, whatever the dealer holds.
  const bust = await casinoService.startBlackjack(GUILD, USER, {
    amount: 100, deck: ['10S', '6H', '10D', '7C', '10H', '2D', '3D', '4D'], date: at(2),
  });
  const lost = await casinoService.hitBlackjack(GUILD, USER, bust.session.id, { date: at(2) });
  assert.equal(lost.session.status, 'settled');
  assert.equal(lost.session.payoutAmount, 0);
  await harness.assertMoneyLedgersConsistent('blackjack 21');
});

// ---------------------------------------------------------------------------------------------------------
// Pawn shop
// ---------------------------------------------------------------------------------------------------------

test('pawning and redeeming never gains: the payout is 80% and the redemption is the highest price ever', async () => {
  await harness.openAttackDatabase(root);
  await fund(USER, 100_000);
  const item = await luxuryService.createLuxuryItem(GUILD, { name: 'arbitrage watch', price: 1_000, createdBy: OPERATOR });
  await luxuryService.purchaseLuxuryItem(GUILD, USER, item.id, 4);
  const start = await holdings();
  const pawned = await luxuryService.pawnLuxuryItem(GUILD, USER, item.id, 2);
  assert.equal(pawned.payoutAmount, 1_600);
  await luxuryService.editLuxuryItem(GUILD, item.id, { price: 400, operatorId: OPERATOR, reason: 'sale' });
  const redeemed = await luxuryService.redeemPawnRecord(GUILD, USER, pawned.record.id, 2);
  assert.equal(redeemed.redeemUnitPrice, 1_000, 'a lower price today does not make the redemption cheaper');
  assert.equal(redeemed.totalPrice, 2_000);
  assert.equal((await holdings()) - start, -400, 'a round trip through the pawn shop costs 20% of the price');
  await harness.assertMoneyLedgersConsistent('pawn arbitrage');
});

test('a stack of luxury items can be pawned in full, and then it is gone', async () => {
  await harness.openAttackDatabase(root);
  await fund(USER, 10_000);
  const item = await luxuryService.createLuxuryItem(GUILD, { name: 'single watch', price: 1_000, createdBy: OPERATOR });
  await luxuryService.purchaseLuxuryItem(GUILD, USER, item.id, 1);
  const pawned = await luxuryService.pawnLuxuryItem(GUILD, USER, item.id, 1);
  assert.equal(pawned.payoutAmount, 800);
  assert.deepEqual(await harness.readRows('SELECT quantity FROM luxury_global_inventory WHERE user_id = ?', [USER]), []);
  await assert.rejects(luxuryService.pawnLuxuryItem(GUILD, USER, item.id, 1), { code: 'LUXURY_INVENTORY_NOT_ENOUGH' });

  // Several units, pawned in two bites that use the stack up exactly.
  await luxuryService.purchaseLuxuryItem(GUILD, USER, item.id, 5);
  await luxuryService.pawnLuxuryItem(GUILD, USER, item.id, 2);
  await luxuryService.pawnLuxuryItem(GUILD, USER, item.id, 3);
  assert.deepEqual(await harness.readRows('SELECT quantity FROM luxury_global_inventory WHERE user_id = ?', [USER]), []);
  // Redeeming brings the units back into a stack that can be pawned in full again.
  await luxuryService.redeemPawnRecord(GUILD, USER, pawned.record.id, 1);
  assert.equal((await harness.readRow(
    'SELECT quantity FROM luxury_global_inventory WHERE user_id = ? AND item_id = ?', [USER, item.id]
  )).quantity, 1);
  await harness.assertMoneyLedgersConsistent('whole stack');
});

test('there is no service entry that credits a refund by item id and amount with no purchase behind it', () => {
  assert.equal(coin.refundPurchase, undefined);
  assert.equal(require('../src/systems/economy/coinService').refundPurchase, undefined);
});
