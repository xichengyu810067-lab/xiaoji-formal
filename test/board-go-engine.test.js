const test = require('node:test');
const assert = require('node:assert/strict');
const go = require('../src/games/engines/go');
const { createTrustedSystemAction } = require('../src/games/trustedSystemActions');

function game() { return go.createInitialState({ players: ['black-player', 'white-player'], rules: {}, seed: 'test-seed' }); }
function context(actorId) { return { actorId, players: ['black-player', 'white-player'], activePlayers: ['black-player', 'white-player'], retiredPlayers: [], revision: 0, now: '2026-09-22T00:00:00.000Z' }; }
function act(state, action, actorId) { return go.applyAction(state, action, context(actorId)); }
function arrange(state, placements, currentColor = 'black') {
  const next = structuredClone(state);
  for (const [x, y, color] of placements) next.board[y][x] = color;
  const hash = next.board.map((row) => row.map((cell) => cell === 'black' ? 'b' : cell === 'white' ? 'w' : '.').join('')).join('/');
  next.positionHistory = [hash];
  next.currentColor = currentColor;
  next.turn = { playerId: currentColor === 'black' ? 'black-player' : 'white-player', phase: 'play' };
  return next;
}

test('圍棋拒絕越界、非整數、錯回合與自殺，且不改動輸入', () => {
  const state = game();
  const before = structuredClone(state);
  assert.throws(() => act(state, { type: 'move', x: 9, y: 0 }, 'black-player'), (error) => error.code === 'INVALID_ACTION');
  assert.throws(() => act(state, { type: 'move', x: 0.5, y: 0 }, 'black-player'), (error) => error.code === 'INVALID_ACTION');
  assert.throws(() => act(state, { type: 'move', x: 0, y: 0 }, 'white-player'), (error) => error.code === 'NOT_YOUR_TURN');
  const surrounded = arrange(state, [[0, 1, 'white'], [1, 0, 'white']], 'black');
  assert.throws(() => act(surrounded, { type: 'move', x: 0, y: 0 }, 'black-player'), (error) => error.code === 'ACTION_NOT_LEGAL');
  assert.deepEqual(state, before);
});

test('圍棋先提子並拒絕劫與全局局面重複', () => {
  let state = arrange(game(), [[1, 0, 'black'], [0, 1, 'black'], [2, 1, 'black'], [1, 1, 'white'], [0, 2, 'white'], [2, 2, 'white'], [1, 3, 'white']]);
  const captured = act(state, { type: 'move', x: 1, y: 2 }, 'black-player');
  assert.equal(captured.state.board[1][1], null);
  assert.equal(captured.state.captures.black, 1);
  assert.throws(() => act(captured.state, { type: 'move', x: 1, y: 1 }, 'white-player'), (error) => error.code === 'ACTION_NOT_LEGAL');
});

test('雙方連續停手後只能對相同完整死子集合確認，再以中國面積法結算', () => {
  let state = arrange(game(), [[0, 0, 'black']]);
  state = act(state, { type: 'pass' }, 'black-player').state;
  state = act(state, { type: 'pass' }, 'white-player').state;
  assert.equal(state.phase, 'scoring');
  state = act(state, { type: 'propose-dead', coordinates: [{ x: 0, y: 0 }] }, 'black-player').state;
  assert.throws(() => act(state, { type: 'confirm-dead' }, 'black-player'), (error) => error.code === 'ACTION_NOT_LEGAL');
  state = act(state, { type: 'propose-dead', coordinates: [{ x: 0, y: 0 }] }, 'white-player').state;
  state = act(state, { type: 'confirm-dead' }, 'black-player').state;
  const finished = act(state, { type: 'confirm-dead' }, 'white-player');
  assert.equal(finished.outcome.terminal, true);
  assert.deepEqual(finished.outcome.winnerIds, ['white-player']);
  assert.equal(finished.state.score.totals.white, 7.5);
  assert.throws(() => act(finished.state, { type: 'move', x: 2, y: 2 }, 'black-player'), (error) => error.code === 'ACTION_NOT_LEGAL');
});

test('圍棋計分爭議可恢復落子，JSON 重建後 public view 與合法動作一致', () => {
  let state = game();
  state = act(state, { type: 'pass' }, 'black-player').state;
  state = act(state, { type: 'pass' }, 'white-player').state;
  state = act(state, { type: 'resume-play' }, 'black-player').state;
  const restored = JSON.parse(JSON.stringify(state));
  assert.equal(restored.phase, 'play');
  assert.deepEqual(go.getPublicView(restored), go.getPublicView(state));
  assert.deepEqual(go.getLegalActions(restored, { viewerId: 'black-player', isActivePlayer: true }), go.getLegalActions(state, { viewerId: 'black-player', isActivePlayer: true }));
  assert.throws(() => act(restored, { type: 'move', x: 0, y: 0 }, 'intruder'), (error) => error.code === 'ACTION_NOT_LEGAL');
});

test('圍棋死子提案會擴展為完整連通群組，並且中立地不會歸給任一方', () => {
  let state = arrange(game(), [[0, 0, 'black'], [0, 1, 'black'], [2, 0, 'white']]);
  state = act(state, { type: 'pass' }, 'black-player').state;
  state = act(state, { type: 'pass' }, 'white-player').state;
  const proposed = act(state, { type: 'propose-dead', coordinates: [{ x: 0, y: 0 }] }, 'black-player').state;
  assert.deepEqual(proposed.deadProposal.black, ['0,0', '0,1']);
  let neutral = arrange(game(), [[0, 0, 'black'], [2, 0, 'white']]);
  neutral = act(neutral, { type: 'pass' }, 'black-player').state;
  neutral = act(neutral, { type: 'pass' }, 'white-player').state;
  neutral = act(neutral, { type: 'propose-dead', coordinates: [] }, 'black-player').state;
  neutral = act(neutral, { type: 'propose-dead', coordinates: [] }, 'white-player').state;
  neutral = act(neutral, { type: 'confirm-dead' }, 'black-player').state;
  const result = act(neutral, { type: 'confirm-dead' }, 'white-player').state;
  assert.deepEqual(result.score.territory, { black: 0, white: 0 });
});

test('圍棋只接受核心建立且與本人相符的退賽動作', () => {
  const state = game();
  assert.throws(() => act(state, { type: 'player-retired', playerId: 'black-player' }, 'black-player'), (error) => error.code === 'INVALID_ACTION');
  assert.throws(() => go.applyAction(state, createTrustedSystemAction('player-retired', { playerId: 'white-player' }), context('black-player')), (error) => error.code === 'ACTION_NOT_LEGAL');
  const retired = go.applyAction(state, createTrustedSystemAction('player-retired', { playerId: 'black-player' }), context('black-player'));
  assert.deepEqual(retired.outcome.winnerIds, ['white-player']);
});
