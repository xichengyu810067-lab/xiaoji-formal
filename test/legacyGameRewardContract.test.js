'use strict';

// The v18 migration checks the rewards the retired web game server stored against a frozen copy of
// the reward contract (the economy does not load games code, R4). For every state that server could
// store, the copy and the solo games' reward policy give the same reward or reject it with the same
// message and code.

const assert = require('node:assert/strict');
const test = require('node:test');
const { deriveServerGameReward } = require('../src/systems/games/gameRewardPolicy');
const { deriveLegacyGameReward } = require('../src/systems/economy/storage/migrations/v18GameSessions');

const SOLVED = Array.from({ length: 9 }, (_, row) => Array.from({ length: 9 }, (__, column) => ((row * 3 + Math.floor(row / 3) + column) % 9) + 1));

function outcome(derive, input) {
  try {
    return { reward: derive(input) };
  } catch (error) {
    return { error: error.message, code: error.code, name: error.name };
  }
}

function cases() {
  const states = [];
  const add = (gameType, difficulty, status, score, state) => states.push({ gameType, difficulty, status, score, state });
  const copy = (value) => JSON.parse(JSON.stringify(value));
  for (const difficulty of ['easy', 'normal', 'complex', 'hard', 'impossible', null]) {
    for (const status of ['completed', 'active', 'failed']) {
      add('sudoku', difficulty, status, 0, { completed: true, entries: copy(SOLVED), solution: copy(SOLVED) });
      add('number-match', difficulty, status, 0, { completed: true, board: [null, null] });
      add('tetris', difficulty, status, 400, { score: 400, gameOver: true });
    }
  }
  const wrongCell = copy(SOLVED);
  wrongCell[4][4] = wrongCell[4][4] === 9 ? 1 : wrongCell[4][4] + 1;
  const shortRow = copy(SOLVED);
  shortRow[2] = shortRow[2].slice(0, 8);
  const textCell = copy(SOLVED);
  textCell[0][0] = String(textCell[0][0]);
  for (const state of [
    { completed: false, entries: copy(SOLVED), solution: copy(SOLVED) },
    { completed: true, entries: wrongCell, solution: copy(SOLVED) },
    { completed: true, entries: shortRow, solution: copy(SOLVED) },
    { completed: true, entries: textCell, solution: copy(SOLVED) },
    { completed: true, entries: copy(SOLVED).slice(0, 8), solution: copy(SOLVED) },
    { completed: true, entries: copy(SOLVED) },
    { completed: true, entries: copy(SOLVED), solution: 'no' },
  ]) add('sudoku', 'hard', 'completed', 0, state);
  for (const state of [
    { completed: true, board: [] },
    { completed: true, board: [null, 3] },
    { completed: false, board: [null] },
    { completed: false, noMoves: true, board: [1, 2] },
    { completed: true, noMoves: true, board: [1] },
    { noMoves: true },
  ]) add('number-match', 'normal', 'completed', 0, state);
  for (const [score, state] of [
    [0, { score: 0, gameOver: true }],
    [19, { score: 19, gameOver: true }],
    [20_000, { score: 20_000, gameOver: false }],
    [20_000, { score: 20_000 }],
    [19_999, { score: 19_999, gameOver: false }],
    [20_001, { score: 20_001, gameOver: true }],
    [-1, { score: -1, gameOver: true }],
    [400, { score: 401, gameOver: true }],
    [400, { score: '400', gameOver: true }],
    ['400', { score: 400, gameOver: true }],
    [400.5, { score: 400.5, gameOver: true }],
    [null, { score: 0, gameOver: true }],
  ]) add('tetris', 'easy', 'completed', score, state);
  for (const state of [null, [], 'state', 3]) add('sudoku', 'easy', 'completed', 0, state);
  add('chess', 'easy', 'completed', 0, { completed: true });
  return states;
}

test('the frozen v18 reward contract matches the solo games reward policy for every stored legacy state', () => {
  const all = cases();
  assert.ok(all.length > 80);
  let rewarded = 0;
  for (const input of all) {
    const expected = outcome(deriveServerGameReward, input);
    const actual = outcome(deriveLegacyGameReward, input);
    assert.deepEqual(actual, expected, JSON.stringify(input));
    if ('reward' in expected) rewarded += 1;
  }
  assert.ok(rewarded >= 12, 'the cases include rewarded games');
  assert.equal(deriveLegacyGameReward({ gameType: 'tetris', difficulty: 'easy', status: 'completed', score: 20_000,
    state: { score: 20_000, gameOver: true } }), 1_000);
  assert.equal(deriveLegacyGameReward({ gameType: 'sudoku', difficulty: 'complex', status: 'completed', score: 0,
    state: { completed: true, entries: SOLVED, solution: SOLVED } }), 50);
});
