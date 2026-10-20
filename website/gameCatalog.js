(function exposeGameCatalog(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XiaojiGameCatalog = api;
})(typeof globalThis === 'object' ? globalThis : this, function createGameCatalog() {
  'use strict';

  const games = [
    ['turtle-soup', '海龜湯（1–20 人）', 'board'],
    ['chess', '西洋棋（2 人）', 'board'],
    ['gomoku', '五子棋（2 人）', 'board'],
    ['go', '圍棋（2 人）', 'board'],
    ['checkers', '六角星跳棋（2、3、4、6 人）', 'board'],
    ['xiangqi', '象棋（2 人）', 'board'],
    ['tetris', '俄羅斯方塊', 'solo', ['difficulty'], 'tetris'],
    ['number-match', '數字配對', 'solo', ['difficulty'], 'number_match'],
    ['sudoku', '數獨', 'solo', ['difficulty'], 'sudoku'],
    ['word-chain', '文字接龍', 'word-chain', ['channel', 'seed'], 'word_chain'],
    ['number-chain', '數字接龍', 'number-chain', ['channel', 'target'], 'number_chain'],
    ['daily-riddle', '每日猜謎', 'daily-riddle', [], 'daily_riddle'],
    ['duel-tower', '決鬥塔台', 'duel', ['weapon-item-id', 'wager']],
    ['casino-dice', '賭場骰子', 'casino', ['amount', 'choice']],
    ['casino-slots', '賭場角子機', 'casino', ['amount']],
    ['casino-blackjack', '賭場 21 點', 'casino', ['amount']],
    ['casino-roulette', '賭場輪盤', 'casino', ['amount', 'choice']],
    ['casino-baccarat', '賭場百家樂', 'casino', ['amount', 'choice']],
    ['casino-poker', '賭場五張牌撲克', 'casino', ['amount']],
  ].map(([key, name, launcher, parameters = [], publicFeatureKey = null]) => Object.freeze({
    key, name, launcher, parameters: Object.freeze(parameters), publicFeatureKey,
  }));

  const GAME_CATALOG = Object.freeze(games);
  const GAME_BY_KEY = new Map(GAME_CATALOG.map((game) => [game.key, game]));
  const BOARD_GAME_CHOICES = Object.freeze(GAME_CATALOG.map(({ name, key }) => Object.freeze({ name, value: key })));
  const LEGACY_GAME_STARTS = Object.freeze({
    games: Object.freeze(['menu', 'play', 'resume']),
    casino: Object.freeze(['dice', 'slots', 'blackjack', 'roulette', 'baccarat', 'poker']),
    'duel-tower': Object.freeze(['enter']),
    'word-chain': Object.freeze(['start']),
    'number-chain': Object.freeze(['start']),
  });

  function getGame(key) {
    return GAME_BY_KEY.get(String(key || '')) || null;
  }

  return Object.freeze({ BOARD_GAME_CHOICES, GAME_CATALOG, LEGACY_GAME_STARTS, getGame });
});
