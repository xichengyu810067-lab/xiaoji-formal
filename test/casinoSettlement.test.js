'use strict';

// Casino settlement against a real, isolated coin database: a bet whose best payout would be above the
// payout limit is refused before anything is drawn or charged, and a 21 reached by hitting is settled the
// same way as standing. The duel tower pays like the casino games and has the same limit. Only the
// database file and the random source are synthetic.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-casino-settlement-'));
process.env.COIN_DB_PATH = path.join(root, 'casino-settlement.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { enterDuelTower } = require('../src/services/casinoFacilityService');
const { adjustPlayerBalance } = require('../src/services/coinService');
const {
  hitBlackjack,
  playBaccarat,
  playDice,
  playPoker,
  playRoulette,
  playSlots,
  standBlackjack,
  startBlackjack,
} = require('../src/services/casinoService');

const GUILD_ID = 'casino-settlement-guild';
const PAYOUT_LIMIT = 9_000_000_000;
let sequence = 0;

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

async function memberWithCoins(coins) {
  sequence += 1;
  const userId = `casino-member-${sequence}`;
  await adjustPlayerBalance(GUILD_ID, userId, {
    action: 'add', amount: coins, operatorId: 'synthetic-operator', reason: '測試資料',
  });
  return userId;
}

const walletOf = (userId) => withCoinDatabase((api) => Number(
  api.get('SELECT balance FROM coin_wallets WHERE user_id = ?', [userId]).balance));
const chipsOf = (userId) => withCoinDatabase((api) => Number(
  api.get('SELECT balance FROM chip_accounts_global WHERE user_id = ?', [userId])?.balance ?? 0));
const recordsOf = (userId) => withCoinDatabase((api) => ({
  games: Number(api.get('SELECT COUNT(*) AS count FROM casino_games WHERE user_id = ?', [userId]).count),
  chipEntries: Number(api.get('SELECT COUNT(*) AS count FROM chip_ledger WHERE user_id = ?', [userId]).count),
}));

// Returns the values in turn, for a random source that must produce one fixed round.
function sequenceRng(values) {
  let index = 0;
  return () => values[index++ % values.length];
}

// A random source that fails the test when it is used: a refused bet must not draw anything.
function unusedRng() {
  return () => { throw new Error('the random source was used'); };
}

// The shuffle steps that put `topCards` on top of a fresh 52-card deck (see baccaratRules.test.js).
function rngForTopCards(topCards) {
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  const suits = ['S', 'H', 'D', 'C'];
  const initial = suits.flatMap((suit) => ranks.map((rank) => `${rank}${suit}`));
  assert.equal(new Set(topCards).size, topCards.length);
  const target = [...topCards, ...initial.filter((card) => !topCards.includes(card))];
  const working = [...initial];
  const swaps = [];
  for (let index = working.length - 1; index > 0; index -= 1) {
    const swapIndex = working.indexOf(target[index]);
    assert.ok(swapIndex <= index);
    swaps.push(swapIndex);
    [working[index], working[swapIndex]] = [working[swapIndex], working[index]];
  }
  let call = 0;
  return (maxExclusive) => {
    assert.equal(maxExclusive, 52 - call);
    return swaps[call++];
  };
}

const tooLarge = (error) => error.code === 'CASINO_BET_TOO_LARGE' && /9,000,000,000/u.test(error.message);

// One case per game: the largest bet whose best payout is exactly the limit, a round that wins it, and the
// choice the best multiplier belongs to.
const games = [
  {
    name: 'dice (seven, 5x)',
    limit: 1_800_000_000,
    play: (userId, amount, rng) => playDice(GUILD_ID, userId, { amount, choice: 'seven', rng }),
    winningRng: () => sequenceRng([2, 3]),
  },
  {
    name: 'slots (three sevens, 10x)',
    limit: 900_000_000,
    play: (userId, amount, rng) => playSlots(GUILD_ID, userId, { amount, rng }),
    winningRng: () => sequenceRng([4]),
  },
  {
    name: 'roulette (zero, 36x)',
    limit: 250_000_000,
    play: (userId, amount, rng) => playRoulette(GUILD_ID, userId, { amount, choice: 'zero', rng }),
    winningRng: () => sequenceRng([0]),
  },
  {
    name: 'baccarat (tie, 8x)',
    limit: 1_125_000_000,
    play: (userId, amount, rng) => playBaccarat(GUILD_ID, userId, { amount, choice: 'tie', rng }),
    winningRng: () => rngForTopCards(['8S', '8D', '10H', 'JC']),
  },
  {
    name: 'poker (win, 2x)',
    limit: 4_500_000_000,
    play: (userId, amount, rng) => playPoker(GUILD_ID, userId, { amount, rng }),
    winningRng: () => rngForTopCards(['AS', 'AH', 'AD', 'AC', 'KS', '2S', '3H', '5D', '7C', '9S']),
  },
];

for (const game of games) {
  test(`${game.name}: a bet above the payout limit is refused before anything is drawn or charged`, async () => {
    const userId = await memberWithCoins(game.limit + 1);

    await assert.rejects(() => game.play(userId, game.limit + 1, unusedRng()), tooLarge);

    assert.equal(await walletOf(userId), game.limit + 1);
    assert.equal(await chipsOf(userId), 0);
    assert.deepEqual(await recordsOf(userId), { games: 0, chipEntries: 0 });
  });

  test(`${game.name}: the largest allowed bet that wins is paid in full`, async () => {
    const userId = await memberWithCoins(game.limit);

    const result = await game.play(userId, game.limit, game.winningRng());

    assert.equal(result.betAmount, game.limit);
    assert.equal(result.payoutAmount, PAYOUT_LIMIT);
    assert.equal(result.game.status, 'settled');
    assert.equal(await walletOf(userId), 0);
    assert.equal(await chipsOf(userId), PAYOUT_LIMIT);
    assert.deepEqual(await recordsOf(userId), { games: 1, chipEntries: 3 });
  });
}

test('blackjack (natural 21, 2.5x): a bet above the payout limit is refused before the deal', async () => {
  const userId = await memberWithCoins(3_600_000_001);

  await assert.rejects(() => startBlackjack(GUILD_ID, userId, { amount: 3_600_000_001, rng: unusedRng() }), tooLarge);

  assert.equal(await walletOf(userId), 3_600_000_001);
  assert.equal(await chipsOf(userId), 0);
  const sessions = await withCoinDatabase((api) => Number(api.get(
    'SELECT COUNT(*) AS count FROM casino_blackjack_sessions WHERE user_id = ?', [userId]).count));
  assert.equal(sessions, 0);
});

test('blackjack (natural 21, 2.5x): the largest allowed bet that wins is paid in full', async () => {
  const userId = await memberWithCoins(3_600_000_000);

  const started = await startBlackjack(GUILD_ID, userId, {
    amount: 3_600_000_000,
    deck: ['AS', 'KS', '5H', '6D', '2C', '3C'],
  });

  assert.equal(started.settled.result.payoutAmount, PAYOUT_LIMIT);
  assert.equal(await chipsOf(userId), PAYOUT_LIMIT);
  assert.equal(await walletOf(userId), 0);
});

// Player 5 and 6, dealer 10 and 2; the cards after those are drawn in order.
async function blackjackWithDeck(rest) {
  const userId = await memberWithCoins(1000);
  const started = await startBlackjack(GUILD_ID, userId, {
    amount: 100,
    deck: ['5S', '6S', '10H', '2H', ...rest],
  });
  assert.equal(started.settled, null);
  return { userId, sessionId: started.session.id };
}

test('a 21 reached by hitting plays the dealer out like standing does: a dealer 21 is a push', async () => {
  // The player hits a ten for 21; the dealer's 12 draws a nine for 21.
  const { userId, sessionId } = await blackjackWithDeck(['10S', '9S', '3C', '4C']);

  const settled = await hitBlackjack(GUILD_ID, userId, sessionId);

  assert.equal(settled.result.outcome, 'push');
  assert.equal(settled.result.payoutAmount, 100);
  assert.deepEqual(settled.result.dealerHand, ['10H', '2H', '9S']);
  assert.equal(settled.result.dealerValue, 21);
  assert.equal(settled.session.status, 'settled');
  assert.equal(await chipsOf(userId), 100);
});

test('a 21 reached by hitting beats a dealer that has to stop below 21', async () => {
  // The dealer's 12 draws a six for 18 and stops.
  const { userId, sessionId } = await blackjackWithDeck(['10S', '6S', '3C', '4C']);

  const settled = await hitBlackjack(GUILD_ID, userId, sessionId);

  assert.equal(settled.result.outcome, 'win');
  assert.equal(settled.result.payoutAmount, 200);
  assert.deepEqual(settled.result.dealerHand, ['10H', '2H', '6S']);
  assert.equal(await chipsOf(userId), 200);
});

test('a 21 reached by hitting against a dealer who goes over wins', async () => {
  // The dealer's 12 draws a four for 16 and then a king for 26.
  const { userId, sessionId } = await blackjackWithDeck(['10S', '4S', 'KS', '3C']);

  const settled = await hitBlackjack(GUILD_ID, userId, sessionId);

  assert.equal(settled.result.outcome, 'win');
  assert.deepEqual(settled.result.dealerHand, ['10H', '2H', '4S', 'KS']);
  assert.equal(await chipsOf(userId), 200);
});

test('going over 21 by hitting loses at once and the dealer draws nothing', async () => {
  // 11 and a two make 13, and a king on top of that makes 23.
  const { userId, sessionId } = await blackjackWithDeck(['2S', 'KS', '9S', '4C']);
  assert.equal((await hitBlackjack(GUILD_ID, userId, sessionId)).settled, false);

  const settled = await hitBlackjack(GUILD_ID, userId, sessionId);

  assert.equal(settled.result.outcome, 'lose');
  assert.equal(settled.result.playerValue, 23);
  assert.equal(settled.result.payoutAmount, 0);
  assert.deepEqual(settled.result.dealerHand, ['10H', '2H']);
  assert.equal(await chipsOf(userId), 0);
});

test('hitting without reaching 21 leaves the round open and the dealer untouched', async () => {
  const { userId, sessionId } = await blackjackWithDeck(['2S', '9S', '3C', '4C']);

  const open = await hitBlackjack(GUILD_ID, userId, sessionId);

  assert.equal(open.settled, false);
  assert.equal(open.session.status, 'active');
  assert.deepEqual(open.session.playerHand, ['5S', '6S', '2S']);
  assert.deepEqual(open.session.dealerHand, ['10H', '2H']);

  // Standing afterwards plays the dealer out the same way: 13 against the dealer's 21.
  const stood = await standBlackjack(GUILD_ID, userId, sessionId);
  assert.equal(stood.result.outcome, 'lose');
  assert.deepEqual(stood.result.dealerHand, ['10H', '2H', '9S']);
});

// A member who owns one battle item, which the duel tower needs. The item is worth 100, so its power is 36.
let weaponSequence = 0;
async function memberWithWeapon(coins) {
  const userId = await memberWithCoins(coins);
  weaponSequence += 1;
  const weaponId = `g_00000000-0000-4000-8000-${String(weaponSequence).padStart(12, '0')}`;
  const timestamp = '2026-09-30T03:00:00.000Z';
  await withCoinTransaction((api) => {
    api.run(`INSERT INTO coin_global_shop_items
      (id,name,description,price,type,enabled,deleted,stock,purchase_limit,created_by,source_guild_id,created_at,updated_at)
      VALUES (?,?,?,?,?,1,0,NULL,NULL,?,?,?,?)`,
    [weaponId, '合成木劍', 'synthetic fixture', 100, 'battle_item', 'synthetic-operator', GUILD_ID, timestamp, timestamp]);
    api.run(`INSERT INTO coin_global_inventory (user_id,item_id,item_name,quantity,acquired_at,updated_at)
      VALUES (?,?,?,?,?,?)`, [userId, weaponId, '合成木劍', 1, timestamp, timestamp]);
  });
  return { userId, weaponId };
}

const towerRunsOf = (userId) => withCoinDatabase((api) => Number(api.get(
  'SELECT COUNT(*) AS count FROM casino_duel_tower_runs WHERE user_id = ?', [userId]).count));

test('duel tower (win, 2x): a wager above the payout limit is refused before the fight', async () => {
  const { userId, weaponId } = await memberWithWeapon(4_500_000_001);

  await assert.rejects(
    () => enterDuelTower(GUILD_ID, userId, { weaponItemId: weaponId, wager: 4_500_000_001, rng: unusedRng() }),
    tooLarge
  );

  assert.equal(await walletOf(userId), 4_500_000_001);
  assert.equal(await chipsOf(userId), 0);
  assert.equal(await towerRunsOf(userId), 0);
  assert.deepEqual(await recordsOf(userId), { games: 0, chipEntries: 0 });
});

test('duel tower (win, 2x): the largest allowed wager that wins is paid in full', async () => {
  const { userId, weaponId } = await memberWithWeapon(4_500_000_000);

  // Power 36 + 8 + 59 against 49 + 0.
  const result = await enterDuelTower(GUILD_ID, userId, {
    weaponItemId: weaponId, wager: 4_500_000_000, rng: sequenceRng([59, 0]),
  });

  assert.equal(result.run.status, 'win');
  assert.equal(result.run.payoutAmount, PAYOUT_LIMIT);
  assert.equal(await walletOf(userId), 0);
  assert.equal(await chipsOf(userId), PAYOUT_LIMIT);
  assert.equal(await towerRunsOf(userId), 1);
});

test('duel tower: a lost fight at the largest allowed wager still only costs the wager', async () => {
  const { userId, weaponId } = await memberWithWeapon(4_500_000_000);

  // Power 36 + 8 + 0 against 49 + 79.
  const result = await enterDuelTower(GUILD_ID, userId, {
    weaponItemId: weaponId, wager: 4_500_000_000, rng: sequenceRng([0, 79]),
  });

  assert.equal(result.run.status, 'loss');
  assert.equal(await walletOf(userId), 0);
  assert.equal(await chipsOf(userId), 0);
});
