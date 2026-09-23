const test = require('node:test');
const assert = require('node:assert/strict');
const xiangqi = require('../src/games/engines/xiangqi');
const { createTrustedSystemAction } = require('../src/games/trustedSystemActions');

const players = ['red-player', 'black-player'];
function game() { return xiangqi.createInitialState({ players, rules: {}, seed: 'test-seed' }); }
function context(actorId) { return { actorId, players, activePlayers: players, retiredPlayers: [], revision: 0, now: '2026-09-22T00:00:00.000Z' }; }
function act(state, action, actorId) { return xiangqi.applyAction(state, action, context(actorId)); }
function blankState(placements, currentColor = 'red') {
  const state = game();
  state.board = Array.from({ length: 10 }, () => Array(9).fill(null));
  for (const [x, y, color, type] of placements) state.board[y][x] = { color, type };
  state.currentColor = currentColor;
  state.turn = { playerId: currentColor === 'red' ? players[0] : players[1], phase: 'play' };
  const hash = `${state.board.map((row) => row.map((piece) => piece ? `${piece.color[0]}${piece.type[0]}` : '--').join(',')).join('/')}|${currentColor}`;
  state.positionHistory = [hash];
  return state;
}

test('象棋初始盤、座標、輪次與輸入 state 驗證', () => {
  const state = game(); const before = structuredClone(state);
  assert.equal(xiangqi.getPublicView(state).board.pieces.length, 32);
  assert.throws(() => act(state, { type: 'move', from: { x: 1, y: 9 }, to: { x: 1.5, y: 7 } }, players[0]), (error) => error.code === 'INVALID_ACTION');
  assert.throws(() => act(state, { type: 'move', from: { x: 1, y: 0 }, to: { x: 2, y: 2 } }, players[1]), (error) => error.code === 'NOT_YOUR_TURN');
  assert.deepEqual(state, before);
});

test('象棋驗證馬腿、象眼與過河、炮架及兵的移動', () => {
  const horseBlocked = blankState([[4, 0, 'black', 'general'], [4, 9, 'red', 'general'], [4, 6, 'red', 'soldier'], [4, 4, 'red', 'horse'], [4, 3, 'red', 'soldier']]);
  assert.throws(() => act(horseBlocked, { type: 'move', from: { x: 4, y: 4 }, to: { x: 5, y: 2 } }, players[0]), (error) => error.code === 'ACTION_NOT_LEGAL');
  const elephantCross = blankState([[4, 0, 'black', 'general'], [4, 9, 'red', 'general'], [4, 6, 'red', 'soldier'], [2, 5, 'red', 'elephant']]);
  assert.throws(() => act(elephantCross, { type: 'move', from: { x: 2, y: 5 }, to: { x: 4, y: 3 } }, players[0]), (error) => error.code === 'ACTION_NOT_LEGAL');
  const cannon = blankState([[4, 0, 'black', 'general'], [4, 9, 'red', 'general'], [4, 6, 'red', 'soldier'], [0, 5, 'red', 'cannon'], [3, 5, 'black', 'soldier'], [5, 5, 'black', 'rook']]);
  const cannonResult = act(cannon, { type: 'move', from: { x: 0, y: 5 }, to: { x: 5, y: 5 } }, players[0]);
  assert.equal(cannonResult.state.board[5][5].type, 'cannon');
  const beforeRiver = blankState([[4, 0, 'black', 'general'], [4, 9, 'red', 'general'], [4, 6, 'red', 'soldier'], [0, 5, 'red', 'soldier']]);
  assert.throws(() => act(beforeRiver, { type: 'move', from: { x: 0, y: 5 }, to: { x: 1, y: 5 } }, players[0]), (error) => error.code === 'ACTION_NOT_LEGAL');
  const afterRiver = blankState([[4, 0, 'black', 'general'], [4, 9, 'red', 'general'], [4, 6, 'red', 'soldier'], [0, 4, 'red', 'soldier']]);
  assert.equal(act(afterRiver, { type: 'move', from: { x: 0, y: 4 }, to: { x: 1, y: 4 } }, players[0]).state.board[4][1].type, 'soldier');
});

test('象棋拒絕將帥照面與釘住棋子造成的自陷將軍', () => {
  const facing = blankState([[4, 0, 'black', 'general'], [4, 9, 'red', 'general'], [4, 5, 'red', 'rook']]);
  assert.throws(() => act(facing, { type: 'move', from: { x: 4, y: 5 }, to: { x: 3, y: 5 } }, players[0]), (error) => error.code === 'ACTION_NOT_LEGAL');
  const pinned = blankState([[4, 0, 'black', 'rook'], [3, 0, 'black', 'general'], [4, 9, 'red', 'general'], [4, 5, 'red', 'rook']]);
  assert.throws(() => act(pinned, { type: 'move', from: { x: 4, y: 5 }, to: { x: 3, y: 5 } }, players[0]), (error) => error.code === 'ACTION_NOT_LEGAL');
});

test('象棋正確判定將死與困斃皆為被困方敗北', () => {
  const mate = blankState([[4, 0, 'black', 'general'], [4, 9, 'red', 'general'], [4, 6, 'red', 'soldier'], [3, 1, 'red', 'rook'], [5, 1, 'red', 'rook'], [4, 2, 'red', 'rook']]);
  const mateResult = act(mate, { type: 'move', from: { x: 4, y: 2 }, to: { x: 4, y: 1 } }, players[0]);
  assert.equal(mateResult.outcome.reason, 'checkmate');
  assert.deepEqual(mateResult.outcome.winnerIds, [players[0]]);
  const stale = blankState([[4, 0, 'black', 'general'], [4, 9, 'red', 'general'], [4, 6, 'red', 'soldier'], [3, 1, 'red', 'rook'], [5, 1, 'red', 'rook'], [2, 2, 'red', 'horse'], [0, 2, 'red', 'rook']]);
  const staleResult = act(stale, { type: 'move', from: { x: 0, y: 2 }, to: { x: 0, y: 1 } }, players[0]);
  assert.equal(staleResult.outcome.reason, 'stalemate');
  assert.deepEqual(staleResult.outcome.loserIds, [players[1]]);
});

test('象棋三次重複、和棋協商、認輸與 JSON 重建均可安全處理', () => {
  let state = game();
  const cycle = [
    [{ from: { x: 1, y: 9 }, to: { x: 2, y: 7 } }, players[0]],
    [{ from: { x: 1, y: 0 }, to: { x: 2, y: 2 } }, players[1]],
    [{ from: { x: 2, y: 7 }, to: { x: 1, y: 9 } }, players[0]],
    [{ from: { x: 2, y: 2 }, to: { x: 1, y: 0 } }, players[1]],
  ];
  for (const [move, actor] of [...cycle, ...cycle]) state = act(state, { type: 'move', ...move }, actor).state;
  assert.equal(state.outcome.reason, 'threefold-repetition');
  let draw = game();
  draw = act(draw, { type: 'offer-draw' }, players[0]).state;
  const agreed = act(draw, { type: 'accept-draw' }, players[1]);
  assert.equal(agreed.outcome.reason, 'agreed-draw');
  const resigned = act(game(), { type: 'resign' }, players[0]);
  assert.deepEqual(resigned.outcome.winnerIds, [players[1]]);
  const restored = JSON.parse(JSON.stringify(game()));
  assert.deepEqual(xiangqi.getPublicView(restored), xiangqi.getPublicView(game()));
  assert.throws(() => act(restored, { type: 'move', from: { x: 1, y: 9 }, to: { x: 2, y: 7 } }, 'intruder'), (error) => error.code === 'ACTION_NOT_LEGAL');
});

test('象棋只接受核心建立且與本人相符的退賽動作', () => {
  const state = game();
  assert.throws(() => act(state, { type: 'player-retired', playerId: players[0] }, players[0]), (error) => error.code === 'INVALID_ACTION');
  assert.throws(() => xiangqi.applyAction(state, createTrustedSystemAction('player-retired', { playerId: players[1] }), context(players[0])), (error) => error.code === 'ACTION_NOT_LEGAL');
  const retired = xiangqi.applyAction(state, createTrustedSystemAction('player-retired', { playerId: players[0] }), context(players[0]));
  assert.deepEqual(retired.outcome.winnerIds, [players[1]]);
});
