const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-baccarat-'));
process.env.COIN_DB_PATH = path.join(tempDirectory, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_MEMORY_PATH = path.join(tempDirectory, 'memory.json');

const { drawBaccaratHands, playBaccarat } = require('../src/services/casinoService');
const { resetCoinDatabaseForTests, withCoinDatabase } = require('../src/services/coinDatabase');
const { adjustPlayerBalance } = require('../src/services/coinService');
const { buyChips, getChipBalance } = require('../src/services/chipService');

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

function cardFor(value, suit) {
  return `${value === 0 ? 'K' : value === 1 ? 'A' : value}${suit}`;
}

function expectHands(cards, playerLength, bankerLength, label) {
  const deck = [...cards];
  const hands = drawBaccaratHands(deck);
  assert.equal(hands.playerHand.length, playerLength, `${label}: 閒家牌數`);
  assert.equal(hands.bankerHand.length, bankerLength, `${label}: 莊家牌數`);
  assert.deepEqual(hands.playerHand.slice(0, 2), [cards[0], cards[2]], `${label}: 閒家起手順序`);
  assert.deepEqual(hands.bankerHand.slice(0, 2), [cards[1], cards[3]], `${label}: 莊家起手順序`);
  assert.equal(deck.length, cards.length - playerLength - bankerLength, `${label}: 消耗牌數`);
  return hands;
}

test('任一方起手自然牌 8 或 9，兩邊都不補牌', () => {
  for (const [label, cards] of [
    ['閒 8', ['8S', '4D', '10H', 'JC', '9S', '9H']],
    ['閒 9', ['9S', '4D', '10H', 'JC', '8S', '9H']],
    ['莊 8', ['2S', '8D', '3H', '10C', '9S', '9H']],
    ['莊 9', ['2S', '9D', '3H', '10C', '8S', '9H']],
  ]) {
    expectHands(cards, 2, 2, label);
  }
});

test('閒家 0–5 補牌，6–7 停牌；閒停時莊家 0–5 補、6–7 停', () => {
  for (let player = 0; player <= 7; player += 1) {
    for (let banker = 0; banker <= 7; banker += 1) {
      const cards = [cardFor(player, 'S'), cardFor(banker, 'D'), '10H', 'JC', '9H', '8C'];
      const playerDraws = player <= 5;
      const bankerDraws = banker <= (playerDraws ? 3 : 5);
      expectHands(cards, playerDraws ? 3 : 2, bankerDraws ? 3 : 2, `閒 ${player}／莊 ${banker}`);
    }
  }
});

test('閒家補第三張後，莊家依完整第三張表決定補牌', () => {
  const bankerDrawsOn = [
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [0, 1, 2, 3, 4, 5, 6, 7, 8, 9],
    [0, 1, 2, 3, 4, 5, 6, 7, 9],
    [2, 3, 4, 5, 6, 7],
    [4, 5, 6, 7],
    [6, 7],
    [],
  ];
  for (let banker = 0; banker <= 7; banker += 1) {
    for (let third = 0; third <= 9; third += 1) {
      const cards = ['2C', cardFor(banker, 'D'), '9C', 'JC', cardFor(third, 'S'), '9H'];
      const bankerDraws = bankerDrawsOn[banker].includes(third);
      const hands = expectHands(cards, 3, bankerDraws ? 3 : 2, `莊 ${banker}／閒第三張 ${third}`);
      assert.equal(hands.playerHand[2], cards[4]);
      if (bankerDraws) assert.equal(hands.bankerHand[2], cards[5]);
    }
  }
});

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
  assert.deepEqual(working, target);
  let call = 0;
  return (maxExclusive) => {
    assert.equal(maxExclusive, 52 - call);
    return swaps[call++];
  };
}

test('合成自然牌結算只扣注與派彩各一次', async () => {
  resetCoinDatabaseForTests({ allowCreateOnNextOpen: true });
  await adjustPlayerBalance('synthetic-guild', 'synthetic-user', {
    action: 'add', amount: 100, operatorId: 'synthetic-admin', reason: 'synthetic fixture',
  });
  await buyChips('synthetic-guild', 'synthetic-user', 100);
  const before = await getChipBalance('synthetic-guild', 'synthetic-user');
  const game = await playBaccarat('synthetic-guild', 'synthetic-user', {
    amount: 10,
    choice: 'player',
    rng: rngForTopCards(['8S', '4D', '10H', 'JC', '9S']),
    date: new Date('2026-09-28T00:00:00.000Z'),
  });
  const after = await getChipBalance('synthetic-guild', 'synthetic-user');
  const rows = await withCoinDatabase((api) => ({
    games: api.all("SELECT * FROM casino_games WHERE user_id = ? AND game_type = 'baccarat'", ['synthetic-user']),
    ledger: api.all("SELECT entry_type, amount FROM chip_ledger WHERE user_id = ? AND entry_type IN ('bet', 'payout') ORDER BY id", ['synthetic-user']),
  }));

  assert.deepEqual(game.game.result.playerHand, ['8S', '10H']);
  assert.deepEqual(game.game.result.bankerHand, ['4D', 'JC']);
  assert.equal(game.game.result.outcome, 'player');
  assert.equal(game.betAmount, 10);
  assert.equal(game.payoutAmount, 20);
  assert.equal(game.netAmount, 10);
  assert.equal(before.balance, 100);
  assert.equal(after.balance, 110);
  assert.equal(rows.games.length, 1);
  assert.equal(rows.games[0].status, 'settled');
  assert.deepEqual(rows.ledger, [
    { entry_type: 'bet', amount: -10 },
    { entry_type: 'payout', amount: 20 },
  ]);
});
