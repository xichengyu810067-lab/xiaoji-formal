const { randomInt } = require('node:crypto');
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} = require('discord.js');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const { CoinServiceError, ensureGuildSettings } = require('./coinService');
const { ChipLedgerType, creditChipsWithApi, debitChipsForCasinoWithApi, ensureChipAccount } = require('./chipService');
const { CasinoLedgerType, insertCasinoLedger } = require('../systems/economy/casinoLedger');
const { LOAN_INTEREST_RATE, LOAN_RELIEF_STEP_RATIO, MIN_LOAN_INTEREST_RATE,
  applyCasinoLoanRelief, applyLoanInterest, borrowCasinoLoan, collectCasinoDebt,
  getCasinoDebtStatus, getCasinoLoanStatus, processCasinoLoanInterest,
  repayCasinoLoan } = require('../systems/economy/loans');
const { formatChips } = require('../utils/coinPresentation');

const MAX_CASINO_AMOUNT = 9_000_000_000;
const BLACKJACK_TTL_MS = 10 * 60 * 1000;

const CasinoGameType = Object.freeze({
  DICE: 'dice',
  SLOTS: 'slots',
  BLACKJACK: 'blackjack',
  ROULETTE: 'roulette',
  BACCARAT: 'baccarat',
  POKER: 'poker',
});

const CasinoGameStatus = Object.freeze({
  SETTLED: 'settled',
  ACTIVE: 'active',
  EXPIRED_REFUNDED: 'expired_refunded',
});

const BlackjackAction = Object.freeze({
  HIT: 'hit',
  STAND: 'stand',
});

const BlackjackStatus = Object.freeze({
  ACTIVE: 'active',
  SETTLED: 'settled',
  EXPIRED_REFUNDED: 'expired_refunded',
});

const SLOT_SYMBOLS = Object.freeze(['櫻桃', '檸檬', '鈴鐺', '星星', '七']);
const CARD_RANKS = Object.freeze(['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K']);
const CARD_SUITS = Object.freeze(['S', 'H', 'D', 'C']);
const ROULETTE_RED_NUMBERS = new Set([1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36]);

function nowIso(date = new Date()) {
  return date.toISOString();
}

function defaultRng(maxExclusive) {
  return randomInt(maxExclusive);
}

function normalizeAmount(value, label = '金額') {
  const amount = Number(value);

  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_CASINO_AMOUNT) {
    throw new CoinServiceError('INVALID_CASINO_AMOUNT', `${label}必須是 1 到 ${MAX_CASINO_AMOUNT.toLocaleString('zh-TW')} 的整數。`);
  }

  return amount;
}

function serializeJson(value) {
  return JSON.stringify(value || {});
}

function parseJson(value, fallback) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function mapGame(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    gameType: row.game_type,
    currency: row.currency || 'chip',
    betAmount: Number(row.bet_amount),
    payoutAmount: Number(row.payout_amount || 0),
    netAmount: Number(row.net_amount || 0),
    status: row.status,
    result: parseJson(row.result_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapLedger(row) {
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    entryType: row.entry_type,
    currency: row.currency || 'chip',
    amount: Number(row.amount || 0),
    balanceBefore: row.balance_before === null || row.balance_before === undefined ? null : Number(row.balance_before),
    balanceAfter: row.balance_after === null || row.balance_after === undefined ? null : Number(row.balance_after),
    debtBefore: row.debt_before === null || row.debt_before === undefined ? null : Number(row.debt_before),
    debtAfter: row.debt_after === null || row.debt_after === undefined ? null : Number(row.debt_after),
    gameId: row.game_id === null || row.game_id === undefined ? null : Number(row.game_id),
    loanId: row.loan_id === null || row.loan_id === undefined ? null : Number(row.loan_id),
    details: parseJson(row.details, {}),
    createdAt: row.created_at,
  };
}

function mapBlackjackSession(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    channelId: row.channel_id || null,
    messageId: row.message_id || null,
    currency: row.currency || 'chip',
    betAmount: Number(row.bet_amount),
    deck: parseJson(row.deck_json, []),
    playerHand: parseJson(row.player_hand_json, []),
    dealerHand: parseJson(row.dealer_hand_json, []),
    status: row.status,
    payoutAmount: Number(row.payout_amount || 0),
    netAmount: Number(row.net_amount || 0),
    result: parseJson(row.result_json, {}),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    settledAt: row.settled_at || null,
  };
}

function ensureEconomyEnabled(api, guildId) {
  const settings = ensureGuildSettings(api, guildId);

  if (!settings.enabled) {
    throw new CoinServiceError('COIN_DISABLED', '這個伺服器的吉幣系統目前停用。');
  }

  return settings;
}

function insertGame(api, { guildId, userId, gameType, betAmount, payoutAmount, netAmount, status, result, createdAt }) {
  api.run(
    `INSERT INTO casino_games
      (guild_id, user_id, game_type, currency, bet_amount, payout_amount, net_amount, status, result_json, created_at, updated_at)
     VALUES (?, ?, ?, 'chip', ?, ?, ?, ?, ?, ?, ?)`,
    [
      guildId,
      userId,
      gameType,
      betAmount,
      payoutAmount,
      netAmount,
      status,
      serializeJson(result),
      createdAt,
      createdAt,
    ]
  );

  const gameId = Number(api.get('SELECT last_insert_rowid() AS id').id);
  return mapGame(api.get('SELECT * FROM casino_games WHERE id = ?', [gameId]));
}

function settleImmediateGame(api, { guildId, userId, gameType, betAmount, payoutAmount, result, timestamp }) {
  const bet = debitChipsForCasinoWithApi(api, guildId, userId, betAmount, {
    timestamp,
    entryType: ChipLedgerType.BET,
    reason: `賭場下注：${gameType}`,
    metadata: { gameType, result },
  });
  const payout =
    payoutAmount > 0
      ? creditChipsWithApi(api, guildId, userId, payoutAmount, {
          timestamp,
          entryType: ChipLedgerType.PAYOUT,
          debtOffsetAmount: Math.max(payoutAmount - betAmount, 0),
          reason: `賭場派彩：${gameType}`,
          metadata: {
            gameType,
            betAmount,
            payoutAmount,
            eligibleIncome: Math.max(payoutAmount - betAmount, 0),
            result,
          },
        })
      : { balanceBefore: bet.balanceAfter, balanceAfter: bet.balanceAfter };
  const balanceAfter = payout.balanceAfter;
  const netAmount = payoutAmount - betAmount;

  const game = insertGame(api, {
    guildId,
    userId,
    gameType,
    betAmount,
    payoutAmount,
    netAmount,
    status: CasinoGameStatus.SETTLED,
    result,
    createdAt: timestamp,
  });
  insertCasinoLedger(api, {
    guildId,
    userId,
    entryType: netAmount > 0 ? CasinoLedgerType.GAME_WIN : netAmount < 0 ? CasinoLedgerType.GAME_LOSS : CasinoLedgerType.GAME_PUSH,
    amount: netAmount,
    currency: 'chip',
    balanceBefore: bet.chipBalanceBeforeTopUp,
    balanceAfter,
    gameId: game.id,
    details: { ...result, autoTopUpAmount: bet.autoTopUpAmount },
    createdAt: timestamp,
  });

  return {
    game,
    betAmount,
    payoutAmount,
    netAmount,
    balanceBefore: bet.chipBalanceBeforeTopUp,
    balanceAfter,
    autoTopUpAmount: bet.autoTopUpAmount,
    coinBalanceAfter: bet.coinBalanceAfter,
  };
}

function playDice(guildId, userId, { amount, choice, rng = defaultRng, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    applyLoanInterest(api, guildId, userId, date);
    const betAmount = normalizeAmount(amount, '下注金額');
    const normalizedChoice = String(choice || '').trim().toLowerCase();

    if (!['big', 'small', 'seven'].includes(normalizedChoice)) {
      throw new CoinServiceError('INVALID_DICE_CHOICE', '骰子下注只能選 big、small 或 seven。');
    }

    const dice = [rng(6) + 1, rng(6) + 1];
    const sum = dice[0] + dice[1];
    const win =
      (normalizedChoice === 'big' && sum >= 8 && sum <= 12) ||
      (normalizedChoice === 'small' && sum >= 2 && sum <= 6) ||
      (normalizedChoice === 'seven' && sum === 7);
    const multiplier = normalizedChoice === 'seven' ? 5 : 2;
    const payoutAmount = win ? betAmount * multiplier : 0;

    return settleImmediateGame(api, {
      guildId,
      userId,
      gameType: CasinoGameType.DICE,
      betAmount,
      payoutAmount,
      result: { choice: normalizedChoice, dice, sum, win, multiplier: win ? multiplier : 0 },
      timestamp: nowIso(date),
    });
  });
}

function playSlots(guildId, userId, { amount, rng = defaultRng, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    applyLoanInterest(api, guildId, userId, date);
    const betAmount = normalizeAmount(amount, '下注金額');
    const reels = [SLOT_SYMBOLS[rng(SLOT_SYMBOLS.length)], SLOT_SYMBOLS[rng(SLOT_SYMBOLS.length)], SLOT_SYMBOLS[rng(SLOT_SYMBOLS.length)]];
    const counts = new Map();

    for (const symbol of reels) {
      counts.set(symbol, (counts.get(symbol) || 0) + 1);
    }

    const maxMatches = Math.max(...counts.values());
    let multiplier = 0;

    if (maxMatches === 3) {
      multiplier = reels[0] === '七' ? 10 : 5;
    } else if (maxMatches === 2) {
      multiplier = 2;
    }

    const payoutAmount = betAmount * multiplier;

    return settleImmediateGame(api, {
      guildId,
      userId,
      gameType: CasinoGameType.SLOTS,
      betAmount,
      payoutAmount,
      result: { reels, multiplier, win: multiplier > 0 },
      timestamp: nowIso(date),
    });
  });
}

function getRouletteColor(number) {
  if (number === 0) {
    return 'green';
  }

  return ROULETTE_RED_NUMBERS.has(number) ? 'red' : 'black';
}

function playRoulette(guildId, userId, { amount, choice, rng = defaultRng, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    applyLoanInterest(api, guildId, userId, date);
    const betAmount = normalizeAmount(amount, '下注金額');
    const normalizedChoice = String(choice || '').trim().toLowerCase();

    if (!['red', 'black', 'odd', 'even', 'zero'].includes(normalizedChoice)) {
      throw new CoinServiceError('INVALID_ROULETTE_CHOICE', '輪盤下注只能選 red、black、odd、even 或 zero。');
    }

    const number = rng(37);
    const color = getRouletteColor(number);
    const win =
      (normalizedChoice === 'red' && color === 'red') ||
      (normalizedChoice === 'black' && color === 'black') ||
      (normalizedChoice === 'odd' && number > 0 && number % 2 === 1) ||
      (normalizedChoice === 'even' && number > 0 && number % 2 === 0) ||
      (normalizedChoice === 'zero' && number === 0);
    const multiplier = normalizedChoice === 'zero' ? 36 : 2;
    const payoutAmount = win ? betAmount * multiplier : 0;

    return settleImmediateGame(api, {
      guildId,
      userId,
      gameType: CasinoGameType.ROULETTE,
      betAmount,
      payoutAmount,
      result: { choice: normalizedChoice, number, color, win, multiplier: win ? multiplier : 0 },
      timestamp: nowIso(date),
    });
  });
}

function createDeck(rng = defaultRng) {
  const deck = [];

  for (const suit of CARD_SUITS) {
    for (const rank of CARD_RANKS) {
      deck.push(`${rank}${suit}`);
    }
  }

  for (let index = deck.length - 1; index > 0; index -= 1) {
    const swapIndex = rng(index + 1);
    [deck[index], deck[swapIndex]] = [deck[swapIndex], deck[index]];
  }

  return deck;
}

function drawCard(deck) {
  const card = deck.shift();

  if (!card) {
    throw new CoinServiceError('BLACKJACK_DECK_EMPTY', '牌堆已空，無法繼續這局 21點。');
  }

  return card;
}

function getCardRank(card) {
  return String(card).slice(0, -1);
}

function getHandValue(hand) {
  let value = 0;
  let aces = 0;

  for (const card of hand) {
    const rank = getCardRank(card);

    if (rank === 'A') {
      value += 11;
      aces += 1;
    } else if (['J', 'Q', 'K'].includes(rank)) {
      value += 10;
    } else {
      value += Number(rank);
    }
  }

  while (value > 21 && aces > 0) {
    value -= 10;
    aces -= 1;
  }

  return value;
}

function getBaccaratCardValue(card) {
  const rank = getCardRank(card);
  if (rank === 'A') {
    return 1;
  }
  if (['10', 'J', 'Q', 'K'].includes(rank)) {
    return 0;
  }
  return Number(rank);
}

function getBaccaratValue(hand) {
  return hand.reduce((sum, card) => sum + getBaccaratCardValue(card), 0) % 10;
}

function drawBaccaratSide(deck) {
  const hand = [drawCard(deck), drawCard(deck)];
  if (getBaccaratValue(hand) <= 5) {
    hand.push(drawCard(deck));
  }
  return hand;
}

function playBaccarat(guildId, userId, { amount, choice, rng = defaultRng, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    applyLoanInterest(api, guildId, userId, date);
    const betAmount = normalizeAmount(amount, '下注金額');
    const normalizedChoice = String(choice || '').trim().toLowerCase();

    if (!['player', 'banker', 'tie'].includes(normalizedChoice)) {
      throw new CoinServiceError('INVALID_BACCARAT_CHOICE', '百家樂下注只能選 player、banker 或 tie。');
    }

    const deck = createDeck(rng);
    const playerHand = drawBaccaratSide(deck);
    const bankerHand = drawBaccaratSide(deck);
    const playerValue = getBaccaratValue(playerHand);
    const bankerValue = getBaccaratValue(bankerHand);
    const outcome = playerValue === bankerValue ? 'tie' : playerValue > bankerValue ? 'player' : 'banker';
    const win = normalizedChoice === outcome;
    const multiplier = normalizedChoice === 'tie' ? 8 : 2;
    const payoutAmount = win ? betAmount * multiplier : 0;

    return settleImmediateGame(api, {
      guildId,
      userId,
      gameType: CasinoGameType.BACCARAT,
      betAmount,
      payoutAmount,
      result: {
        choice: normalizedChoice,
        outcome,
        playerHand,
        bankerHand,
        playerValue,
        bankerValue,
        win,
        multiplier: win ? multiplier : 0,
      },
      timestamp: nowIso(date),
    });
  });
}

function getPokerRankValue(card) {
  const rank = getCardRank(card);
  const values = {
    A: 14,
    K: 13,
    Q: 12,
    J: 11,
  };
  return values[rank] || Number(rank);
}

function evaluatePokerHand(hand) {
  const values = hand.map(getPokerRankValue).sort((a, b) => b - a);
  const suits = hand.map((card) => String(card).slice(-1));
  const counts = new Map();
  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  const countValues = [...counts.values()].sort((a, b) => b - a);
  const uniqueValues = [...new Set(values)].sort((a, b) => b - a);
  const isFlush = suits.every((suit) => suit === suits[0]);
  const straightHigh = (() => {
    const lowAce = JSON.stringify(uniqueValues) === JSON.stringify([14, 5, 4, 3, 2]);
    if (lowAce) {
      return 5;
    }
    if (uniqueValues.length === 5 && uniqueValues[0] - uniqueValues[4] === 4) {
      return uniqueValues[0];
    }
    return 0;
  })();

  let category = 0;
  let label = '高牌';
  let tiebreakers = values;

  if (straightHigh && isFlush) {
    category = 8;
    label = '同花順';
    tiebreakers = [straightHigh];
  } else if (countValues[0] === 4) {
    category = 7;
    label = '四條';
    tiebreakers = [...uniqueValues].sort((a, b) => counts.get(b) - counts.get(a) || b - a);
  } else if (countValues[0] === 3 && countValues[1] === 2) {
    category = 6;
    label = '葫蘆';
    tiebreakers = [...uniqueValues].sort((a, b) => counts.get(b) - counts.get(a) || b - a);
  } else if (isFlush) {
    category = 5;
    label = '同花';
  } else if (straightHigh) {
    category = 4;
    label = '順子';
    tiebreakers = [straightHigh];
  } else if (countValues[0] === 3) {
    category = 3;
    label = '三條';
    tiebreakers = [...uniqueValues].sort((a, b) => counts.get(b) - counts.get(a) || b - a);
  } else if (countValues[0] === 2 && countValues[1] === 2) {
    category = 2;
    label = '兩對';
    tiebreakers = [...uniqueValues].sort((a, b) => counts.get(b) - counts.get(a) || b - a);
  } else if (countValues[0] === 2) {
    category = 1;
    label = '一對';
    tiebreakers = [...uniqueValues].sort((a, b) => counts.get(b) - counts.get(a) || b - a);
  }

  return { category, label, tiebreakers };
}

function comparePokerRanks(left, right) {
  if (left.category !== right.category) {
    return left.category > right.category ? 1 : -1;
  }

  const max = Math.max(left.tiebreakers.length, right.tiebreakers.length);
  for (let index = 0; index < max; index += 1) {
    const leftValue = left.tiebreakers[index] || 0;
    const rightValue = right.tiebreakers[index] || 0;
    if (leftValue !== rightValue) {
      return leftValue > rightValue ? 1 : -1;
    }
  }

  return 0;
}

function playPoker(guildId, userId, { amount, rng = defaultRng, date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    applyLoanInterest(api, guildId, userId, date);
    const betAmount = normalizeAmount(amount, '下注金額');
    const deck = createDeck(rng);
    const playerHand = [drawCard(deck), drawCard(deck), drawCard(deck), drawCard(deck), drawCard(deck)];
    const dealerHand = [drawCard(deck), drawCard(deck), drawCard(deck), drawCard(deck), drawCard(deck)];
    const playerRank = evaluatePokerHand(playerHand);
    const dealerRank = evaluatePokerHand(dealerHand);
    const compared = comparePokerRanks(playerRank, dealerRank);
    const outcome = compared > 0 ? 'win' : compared < 0 ? 'lose' : 'push';
    const payoutAmount = outcome === 'win' ? betAmount * 2 : outcome === 'push' ? betAmount : 0;

    return settleImmediateGame(api, {
      guildId,
      userId,
      gameType: CasinoGameType.POKER,
      betAmount,
      payoutAmount,
      result: {
        playerHand,
        dealerHand,
        playerRank,
        dealerRank,
        outcome,
        win: outcome === 'win',
      },
      timestamp: nowIso(date),
    });
  });
}

function isNaturalBlackjack(hand) {
  return hand.length === 2 && getHandValue(hand) === 21;
}

function compareBlackjack(playerHand, dealerHand) {
  const playerValue = getHandValue(playerHand);
  const dealerValue = getHandValue(dealerHand);

  if (playerValue > 21) {
    return { outcome: 'lose', reason: '玩家爆牌。' };
  }

  if (dealerValue > 21) {
    return { outcome: 'win', reason: '莊家爆牌。' };
  }

  if (playerValue > dealerValue) {
    return { outcome: 'win', reason: '玩家點數較高。' };
  }

  if (playerValue < dealerValue) {
    return { outcome: 'lose', reason: '莊家點數較高。' };
  }

  return { outcome: 'push', reason: '平手，退回下注。' };
}

function calculateBlackjackPayout(betAmount, playerHand, dealerHand) {
  const playerNatural = isNaturalBlackjack(playerHand);
  const dealerNatural = isNaturalBlackjack(dealerHand);

  if (playerNatural && dealerNatural) {
    return { payoutAmount: betAmount, outcome: 'push', reason: '雙方都是自然 21 點，平手退回下注。' };
  }

  if (playerNatural) {
    return { payoutAmount: Math.floor((betAmount * 5) / 2), outcome: 'blackjack', reason: '自然 21 點。' };
  }

  if (dealerNatural) {
    return { payoutAmount: 0, outcome: 'lose', reason: '莊家自然 21 點。' };
  }

  const compared = compareBlackjack(playerHand, dealerHand);
  if (compared.outcome === 'win') {
    return { payoutAmount: betAmount * 2, ...compared };
  }

  if (compared.outcome === 'push') {
    return { payoutAmount: betAmount, ...compared };
  }

  return { payoutAmount: 0, ...compared };
}

function insertBlackjackGameAndLedger(api, session, playerBeforeSettle, balanceAfter, result, timestamp) {
  const game = insertGame(api, {
    guildId: session.guildId,
    userId: session.userId,
    gameType: CasinoGameType.BLACKJACK,
    betAmount: session.betAmount,
    payoutAmount: result.payoutAmount,
    netAmount: result.payoutAmount - session.betAmount,
    status: CasinoGameStatus.SETTLED,
    result,
    createdAt: timestamp,
  });

  insertCasinoLedger(api, {
    guildId: session.guildId,
    userId: session.userId,
    entryType:
      result.payoutAmount > session.betAmount
        ? CasinoLedgerType.GAME_WIN
        : result.payoutAmount < session.betAmount
          ? CasinoLedgerType.GAME_LOSS
          : CasinoLedgerType.GAME_PUSH,
    currency: 'chip',
    amount: result.payoutAmount - session.betAmount,
    balanceBefore: playerBeforeSettle,
    balanceAfter,
    gameId: game.id,
    details: result,
    createdAt: timestamp,
  });

  return game;
}

function settleBlackjackSession(api, sessionRow, { date = new Date(), resultOverride = null } = {}) {
  const session = mapBlackjackSession(sessionRow);
  const timestamp = nowIso(date);
  const result = resultOverride || {
    ...calculateBlackjackPayout(session.betAmount, session.playerHand, session.dealerHand),
    playerHand: session.playerHand,
    dealerHand: session.dealerHand,
    playerValue: getHandValue(session.playerHand),
    dealerValue: getHandValue(session.dealerHand),
  };
  const account = ensureChipAccount(api, session.guildId, session.userId, timestamp);
  const payout =
    result.payoutAmount > 0
      ? creditChipsWithApi(api, session.guildId, session.userId, result.payoutAmount, {
          timestamp,
          entryType: ChipLedgerType.PAYOUT,
          debtOffsetAmount: Math.max(result.payoutAmount - session.betAmount, 0),
          reason: '賭場派彩：blackjack',
          metadata: {
            blackjackSessionId: session.id,
            betAmount: session.betAmount,
            payoutAmount: result.payoutAmount,
            eligibleIncome: Math.max(result.payoutAmount - session.betAmount, 0),
            result,
          },
        })
      : { balanceBefore: account.balance, balanceAfter: account.balance };
  const balanceAfter = payout.balanceAfter;

  api.run(
    `UPDATE casino_blackjack_sessions
     SET status = ?, payout_amount = ?, net_amount = ?, result_json = ?, updated_at = ?, settled_at = ?
     WHERE id = ?`,
    [
      BlackjackStatus.SETTLED,
      result.payoutAmount,
      result.payoutAmount - session.betAmount,
      serializeJson(result),
      timestamp,
      timestamp,
      session.id,
    ]
  );

  const game = insertBlackjackGameAndLedger(api, session, account.balance, balanceAfter, result, timestamp);

  return {
    session: mapBlackjackSession(api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [session.id])),
    game,
    result,
    balanceAfter,
  };
}

function expireBlackjackSessionRow(api, sessionRow, date = new Date()) {
  const session = mapBlackjackSession(sessionRow);

  if (!session || session.status !== BlackjackStatus.ACTIVE) {
    return { session, refunded: false };
  }

  const timestamp = nowIso(date);
  const refund = creditChipsWithApi(api, session.guildId, session.userId, session.betAmount, {
    timestamp,
    entryType: ChipLedgerType.REFUND,
    reason: '21點逾時退回下注',
    metadata: { blackjackSessionId: session.id },
  });
  const balanceAfter = refund.balanceAfter;
  api.run(
    `UPDATE casino_blackjack_sessions
     SET status = ?, payout_amount = ?, net_amount = 0, result_json = ?, updated_at = ?, settled_at = ?
     WHERE id = ?`,
    [
      BlackjackStatus.EXPIRED_REFUNDED,
      session.betAmount,
      serializeJson({ outcome: 'expired_refunded', reason: '逾時未操作，已退回下注。' }),
      timestamp,
      timestamp,
      session.id,
    ]
  );
  insertCasinoLedger(api, {
    guildId: session.guildId,
    userId: session.userId,
    entryType: CasinoLedgerType.BLACKJACK_REFUND,
    currency: 'chip',
    amount: session.betAmount,
    balanceBefore: refund.balanceBefore,
    balanceAfter,
    loanId: null,
    details: { blackjackSessionId: session.id },
    createdAt: timestamp,
  });

  return {
    session: mapBlackjackSession(api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [session.id])),
    refunded: true,
    balanceAfter,
  };
}

function expireUserBlackjackSessions(api, guildId, userId, date = new Date()) {
  const rows = api.all(
    'SELECT * FROM casino_blackjack_sessions WHERE guild_id = ? AND user_id = ? AND status = ? AND expires_at <= ?',
    [guildId, userId, BlackjackStatus.ACTIVE, nowIso(date)]
  );

  return rows.map((row) => expireBlackjackSessionRow(api, row, date));
}

function startBlackjack(guildId, userId, { amount, rng = defaultRng, deck = null, date = new Date(), channelId = null } = {}) {
  return withCoinTransaction((api) => {
    ensureEconomyEnabled(api, guildId);
    applyLoanInterest(api, guildId, userId, date);
    expireUserBlackjackSessions(api, guildId, userId, date);

    const existing = api.get(
      'SELECT * FROM casino_blackjack_sessions WHERE guild_id = ? AND user_id = ? AND status = ? ORDER BY id DESC LIMIT 1',
      [guildId, userId, BlackjackStatus.ACTIVE]
    );

    if (existing) {
      throw new CoinServiceError('ACTIVE_BLACKJACK_SESSION', '你已經有一局進行中的 21點，請先完成或等待逾時。');
    }

    const betAmount = normalizeAmount(amount, '下注金額');
    const timestamp = nowIso(date);
    const bet = debitChipsForCasinoWithApi(api, guildId, userId, betAmount, {
      timestamp,
      entryType: ChipLedgerType.BET,
      reason: '賭場下注：blackjack',
      metadata: { gameType: CasinoGameType.BLACKJACK },
    });

    const gameDeck = Array.isArray(deck) ? [...deck] : createDeck(rng);
    const playerHand = [drawCard(gameDeck), drawCard(gameDeck)];
    const dealerHand = [drawCard(gameDeck), drawCard(gameDeck)];
    const expiresAt = new Date(date.getTime() + BLACKJACK_TTL_MS).toISOString();

    api.run(
      `INSERT INTO casino_blackjack_sessions
        (guild_id, user_id, channel_id, currency, bet_amount, deck_json, player_hand_json, dealer_hand_json, status, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, 'chip', ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        guildId,
        userId,
        channelId,
        betAmount,
        serializeJson(gameDeck),
        serializeJson(playerHand),
        serializeJson(dealerHand),
        BlackjackStatus.ACTIVE,
        expiresAt,
        timestamp,
        timestamp,
      ]
    );

    const sessionId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    let sessionRow = api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [sessionId]);
    let settled = null;

    if (isNaturalBlackjack(playerHand) || isNaturalBlackjack(dealerHand)) {
      settled = settleBlackjackSession(api, sessionRow, { date });
      sessionRow = api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [sessionId]);
    }

    return {
      session: mapBlackjackSession(sessionRow),
      settled,
      balanceAfter: settled?.balanceAfter ?? bet.balanceAfter,
      autoTopUpAmount: bet.autoTopUpAmount,
      coinBalanceAfter: bet.coinBalanceAfter,
    };
  });
}

function getBlackjackSession(api, guildId, userId, sessionId) {
  const row = api.get('SELECT * FROM casino_blackjack_sessions WHERE guild_id = ? AND id = ?', [guildId, sessionId]);

  if (!row) {
    throw new CoinServiceError('BLACKJACK_SESSION_NOT_FOUND', '找不到這局 21點，可能已經結束或被清除。');
  }

  if (row.user_id !== userId) {
    throw new CoinServiceError('BLACKJACK_SESSION_OWNER_ONLY', '只有開局的玩家可以操作這局 21點。');
  }

  return row;
}

function hitBlackjack(guildId, userId, sessionId, { date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const row = getBlackjackSession(api, guildId, userId, sessionId);

    if (row.status !== BlackjackStatus.ACTIVE) {
      return { session: mapBlackjackSession(row), settled: true };
    }

    if (row.expires_at <= nowIso(date)) {
      return { ...expireBlackjackSessionRow(api, row, date), expired: true };
    }

    const session = mapBlackjackSession(row);
    session.playerHand.push(drawCard(session.deck));
    const timestamp = nowIso(date);
    api.run(
      'UPDATE casino_blackjack_sessions SET deck_json = ?, player_hand_json = ?, updated_at = ? WHERE id = ?',
      [serializeJson(session.deck), serializeJson(session.playerHand), timestamp, session.id]
    );

    const updatedRow = api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [session.id]);

    if (getHandValue(session.playerHand) >= 21) {
      return settleBlackjackSession(api, updatedRow, { date });
    }

    return {
      session: mapBlackjackSession(updatedRow),
      settled: false,
    };
  });
}

function standBlackjack(guildId, userId, sessionId, { date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const row = getBlackjackSession(api, guildId, userId, sessionId);

    if (row.status !== BlackjackStatus.ACTIVE) {
      return { session: mapBlackjackSession(row), settled: true };
    }

    if (row.expires_at <= nowIso(date)) {
      return { ...expireBlackjackSessionRow(api, row, date), expired: true };
    }

    const session = mapBlackjackSession(row);

    while (getHandValue(session.dealerHand) < 17) {
      session.dealerHand.push(drawCard(session.deck));
    }

    const timestamp = nowIso(date);
    api.run(
      'UPDATE casino_blackjack_sessions SET deck_json = ?, dealer_hand_json = ?, updated_at = ? WHERE id = ?',
      [serializeJson(session.deck), serializeJson(session.dealerHand), timestamp, session.id]
    );

    const updatedRow = api.get('SELECT * FROM casino_blackjack_sessions WHERE id = ?', [session.id]);
    return settleBlackjackSession(api, updatedRow, { date });
  });
}

function listCasinoHistory(guildId, userId, { limit = 10 } = {}) {
  return withCoinDatabase((api) => {
    const normalizedLimit = Math.min(Math.max(Number(limit || 10), 1), 25);
    return api
      .all(
        `SELECT *
         FROM casino_ledger
         WHERE user_id = ?
           AND entry_type NOT IN (?, ?)
         ORDER BY created_at DESC, id DESC
         LIMIT ?`,
        [userId, CasinoLedgerType.LOAN_RELIEF, CasinoLedgerType.LOAN_FORCED_COLLECTION, normalizedLimit]
      )
      .map(mapLedger);
  });
}

function processExpiredBlackjackSessions({ date = new Date() } = {}) {
  return withCoinTransaction((api) => {
    const rows = api.all('SELECT * FROM casino_blackjack_sessions WHERE status = ? AND expires_at <= ?', [
      BlackjackStatus.ACTIVE,
      nowIso(date),
    ]);

    for (const row of rows) {
      expireBlackjackSessionRow(api, row, date);
    }

    return {
      checked: rows.length,
      refunded: rows.length,
    };
  });
}

function getSuitSymbol(suit) {
  return {
    S: '♠',
    H: '♥',
    D: '♦',
    C: '♣',
  }[suit] || suit;
}

function formatCard(card) {
  const text = String(card);
  return `${text.slice(0, -1)}${getSuitSymbol(text.slice(-1))}`;
}

function formatHand(hand, { hideHole = false } = {}) {
  if (hideHole && hand.length > 1) {
    return `${formatCard(hand[0])} 暗牌`;
  }

  return hand.map(formatCard).join(' ');
}

function buildBlackjackEmbed(session) {
  const active = session.status === BlackjackStatus.ACTIVE;
  const dealerHandText = active ? formatHand(session.dealerHand, { hideHole: true }) : formatHand(session.dealerHand);
  const dealerValueText = active ? `${getHandValue([session.dealerHand[0]])}+` : String(getHandValue(session.dealerHand));
  const resultLine = active ? `操作期限：<t:${Math.floor(new Date(session.expiresAt).getTime() / 1000)}:R>` : session.result.reason;

  return new EmbedBuilder()
    .setColor(active ? 0xf59e0b : session.netAmount > 0 ? 0x22c55e : session.netAmount < 0 ? 0xef4444 : 0x64748b)
    .setTitle(`小吉賭場｜21點 #${session.id}`)
    .setDescription(resultLine || '21點')
    .addFields(
      { name: '下注', value: formatChips(session.betAmount), inline: true },
      { name: '狀態', value: session.status, inline: true },
      { name: '派彩', value: formatChips(session.payoutAmount), inline: true },
      { name: '你的手牌', value: `${formatHand(session.playerHand)}\n點數：${getHandValue(session.playerHand)}`, inline: false },
      { name: '莊家手牌', value: `${dealerHandText}\n點數：${dealerValueText}`, inline: false }
    );
}

function buildBlackjackComponents(session) {
  const disabled = session.status !== BlackjackStatus.ACTIVE;

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`casino:blackjack:${BlackjackAction.HIT}:${session.id}`)
        .setLabel('補牌')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(disabled),
      new ButtonBuilder()
        .setCustomId(`casino:blackjack:${BlackjackAction.STAND}:${session.id}`)
        .setLabel('停牌')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(disabled)
    ),
  ];
}

function buildBlackjackPayload(session) {
  return {
    content: '',
    embeds: [buildBlackjackEmbed(session)],
    components: buildBlackjackComponents(session),
    allowedMentions: { parse: [] },
  };
}

async function handleBlackjackButton(interaction) {
  const [, , action, sessionIdText] = interaction.customId.split(':');
  const sessionId = Number(sessionIdText);

  if (!Number.isSafeInteger(sessionId) || sessionId <= 0) {
    await interaction.reply({ content: '找不到這局 21點。', ephemeral: true });
    return;
  }

  try {
    const result =
      action === BlackjackAction.HIT
        ? await hitBlackjack(interaction.guildId, interaction.user.id, sessionId)
        : await standBlackjack(interaction.guildId, interaction.user.id, sessionId);

    await interaction.update(buildBlackjackPayload(result.session));
  } catch (error) {
    if (error instanceof CoinServiceError) {
      await interaction.reply({ content: error.message, ephemeral: true });
      return;
    }

    throw error;
  }
}

module.exports = {
  BLACKJACK_TTL_MS,
  MAX_CASINO_AMOUNT,
  LOAN_INTEREST_RATE,
  LOAN_RELIEF_STEP_RATIO,
  MIN_LOAN_INTEREST_RATE,
  CasinoGameStatus,
  CasinoGameType,
  CasinoLedgerType,
  BlackjackStatus,
  applyCasinoLoanRelief,
  buildBlackjackPayload,
  borrowCasinoLoan,
  collectCasinoDebt,
  formatCard,
  formatHand,
  getCasinoDebtStatus,
  getCasinoLoanStatus,
  getHandValue,
  handleBlackjackButton,
  hitBlackjack,
  listCasinoHistory,
  playDice,
  playBaccarat,
  playPoker,
  playRoulette,
  playSlots,
  processCasinoLoanInterest,
  processExpiredBlackjackSessions,
  repayCasinoLoan,
  standBlackjack,
  startBlackjack,
};
