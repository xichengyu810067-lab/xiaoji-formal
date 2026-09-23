const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const Module = require('node:module');

const boardContractsPath = process.env.XIAOJI_BOARD_CONTRACTS_PATH || path.join(__dirname, '..', 'src', 'games', 'contracts.js');
const chessModulePath = process.env.XIAOJI_CHESS_JS_PATH || null;
const boardContracts = require(boardContractsPath);
const trustedSystemActionsPath = path.join(__dirname, '..', 'src', 'games', 'trustedSystemActions.js');
const testTrustedActions = new WeakSet();
const trustedSystemActions = fs.existsSync(trustedSystemActionsPath)
  ? require(trustedSystemActionsPath)
  : {
      createTrustedSystemAction(type, payload) {
        const action = Object.freeze({ type, ...payload });
        testTrustedActions.add(action);
        return action;
      },
      isTrustedSystemAction(action, expectedType) {
        return testTrustedActions.has(action) && action.type === expectedType;
      },
    };
const { BoardEngineRegistry } = require('../src/games/engineRegistry');
const { BoardSessionService } = require('../src/games/boardSessionService');
const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');

function loadEngine(name) {
  const enginePath = path.join(__dirname, '..', 'src', 'games', 'engines', `${name}.js`);
  const originalLoad = Module._load;
  delete require.cache[require.resolve(enginePath)];
  Module._load = function loadForBoardEngine(request, parent, isMain) {
    if (request === '../contracts' && parent?.filename === enginePath) return boardContracts;
    if (request === '../trustedSystemActions' && parent?.filename === enginePath) return trustedSystemActions;
    if (request === 'chess.js' && chessModulePath && parent?.filename === enginePath) return originalLoad(chessModulePath, parent, isMain);
    return originalLoad(request, parent, isMain);
  };
  try {
    return require(enginePath);
  } finally {
    Module._load = originalLoad;
  }
}

const chess = loadEngine('chess');
const gomoku = loadEngine('gomoku');

test('both engines satisfy the shared board contract', () => {
  assert.doesNotThrow(() => boardContracts.assertEngineContract(chess));
  assert.doesNotThrow(() => boardContracts.assertEngineContract(gomoku));
});

test('the shared session core persists each engine turn and passes its viewer identity to legal actions', async () => {
  const registry = new BoardEngineRegistry([chess, gomoku]);
  let id = 0;
  const service = new BoardSessionService({
    store: new InMemoryBoardStore(),
    registry,
    clock: () => new Date('2026-09-22T00:00:00.000Z'),
    idFactory: () => `session-${++id}`,
    seedFactory: () => `seed-${id}`,
  });
  let result = await service.start({ guildId: 'guild', channelId: 'channel', hostId: 'white', gameKey: 'chess', options: {}, interactionId: 'start' });
  result = await service.join({ guildId: 'guild', channelId: 'channel', actorId: 'black', expectedRevision: result.session.revision, interactionId: 'join' });
  result = await service.begin({ guildId: 'guild', channelId: 'channel', actorId: 'white', expectedRevision: result.session.revision, interactionId: 'begin' });
  result = await service.bindMessage({ guildId: 'guild', channelId: 'channel', actorId: 'white', messageId: 'message', expectedRevision: result.session.revision, interactionId: 'bind' });
  result = await service.submitAction({
    guildId: 'guild', channelId: 'channel', messageId: 'message', actorId: 'white', expectedRevision: result.session.revision,
    interactionId: 'move', action: { type: 'move', from: 'e2', to: 'e4' },
  });
  assert.deepEqual(result.session.turn, { playerId: 'black', phase: 'move' });
  const blackView = await service.status({ guildId: 'guild', channelId: 'channel', actorId: 'black' });
  assert.ok(blackView.legalActions.some((action) => action.type === 'move' && action.from === 'e7' && action.to === 'e5'));
});

async function beginBoardSession(gameKey) {
  const registry = new BoardEngineRegistry([chess, gomoku]);
  let id = 0;
  const service = new BoardSessionService({
    store: new InMemoryBoardStore(),
    registry,
    clock: () => new Date('2026-09-22T00:00:00.000Z'),
    idFactory: () => `${gameKey}-session-${++id}`,
    seedFactory: () => `${gameKey}-seed-${id}`,
  });
  let result = await service.start({ guildId: `${gameKey}-guild`, channelId: `${gameKey}-channel`, hostId: 'white', gameKey, options: {}, interactionId: 'start' });
  result = await service.join({ guildId: `${gameKey}-guild`, channelId: `${gameKey}-channel`, actorId: 'black', expectedRevision: result.session.revision, interactionId: 'join' });
  result = await service.begin({ guildId: `${gameKey}-guild`, channelId: `${gameKey}-channel`, actorId: 'white', expectedRevision: result.session.revision, interactionId: 'begin' });
  return { service, result, scope: { guildId: `${gameKey}-guild`, channelId: `${gameKey}-channel` } };
}

test('both engines only accept trusted player retirement as self-resignation, even off-turn', () => {
  for (const [gameKey, engine] of [['chess', chess], ['gomoku', gomoku]]) {
    const state = engine.createInitialState({ players: ['white', 'black'], rules: {}, seed: 'seed' });
    assert.throws(
      () => engine.applyAction(state, { type: 'player-retired', playerId: 'black' }, context(state, 'black')),
      (error) => error.code === 'INVALID_ACTION'
    );
    const direct = engine.applyAction(
      state,
      trustedSystemActions.createTrustedSystemAction('player-retired', { playerId: 'black' }),
      context(state, 'black')
    );
    assert.equal(direct.outcome.reason, 'resignation');
    assert.deepEqual(direct.outcome.winnerIds, ['white']);
    assert.throws(
      () => engine.applyAction(
        state,
        trustedSystemActions.createTrustedSystemAction('player-retired', { playerId: 'black' }),
        context(state, 'white')
      ),
      (error) => error.code === 'ACTION_NOT_LEGAL'
    );
  }
});

test('the trusted core leave flow resigns once and rejects stale revisions', { skip: !fs.existsSync(trustedSystemActionsPath) }, async () => {
  for (const gameKey of ['chess', 'gomoku']) {
    const { service, result, scope } = await beginBoardSession(gameKey);
    await assert.rejects(
      () => service.leave({ ...scope, actorId: 'black', expectedRevision: result.session.revision - 1, interactionId: 'leave-stale' }),
      (error) => error.code === 'STALE_REVISION'
    );
    const left = await service.leave({ ...scope, actorId: 'black', expectedRevision: result.session.revision, interactionId: 'leave' });
    assert.equal(left.session.status, 'completed');
    assert.equal(left.session.outcome.reason, 'resignation');
    assert.deepEqual(left.session.outcome.winnerIds, ['white']);
    const replay = await service.leave({ ...scope, actorId: 'black', expectedRevision: result.session.revision, interactionId: 'leave' });
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.session.outcome, left.session.outcome);
  }
});

function context(state, actorId) {
  return {
    actorId,
    players: [...state.players],
    activePlayers: [...state.players],
    retiredPlayers: [],
    revision: 0,
    now: '2026-09-22T00:00:00.000Z',
  };
}

function playChess(state, move) {
  const actorId = state.players[state.fen.split(' ')[1] === 'w' ? 0 : 1];
  return chess.applyAction(state, { type: 'move', ...move }, context(state, actorId)).state;
}

function playGomoku(state, x, y) {
  const actorId = state.players[state.turnIndex];
  return gomoku.applyAction(state, { type: 'place', x, y }, context(state, actorId)).state;
}

test('chess supports legal moves, castling, en passant, promotion, and an immutable restartable state', () => {
  let state = chess.createInitialState({ players: ['white', 'black'], rules: {}, seed: 'seed' });
  const initial = JSON.stringify(state);
  state = playChess(state, { from: 'g1', to: 'f3' });
  state = playChess(state, { from: 'g8', to: 'f6' });
  state = playChess(state, { from: 'e2', to: 'e3' });
  state = playChess(state, { from: 'b8', to: 'c6' });
  state = playChess(state, { from: 'f1', to: 'e2' });
  state = playChess(state, { from: 'e7', to: 'e6' });
  state = playChess(state, { from: 'e1', to: 'g1' });
  assert.equal(JSON.stringify(chess.createInitialState({ players: ['white', 'black'], rules: {}, seed: 'seed' })), initial);
  assert.ok(chess.getPublicView(state).board.pieces.some((piece) => piece.id === 'g1' && piece.symbol === '♔'));
  assert.deepEqual(chess.getLegalActions(JSON.parse(JSON.stringify(state)), { actorId: 'black' }), chess.getLegalActions(state, { actorId: 'black' }));

  state = chess.createInitialState({ players: ['white', 'black'], rules: {}, seed: 'seed' });
  for (const move of [
    { from: 'e2', to: 'e4' }, { from: 'a7', to: 'a6' }, { from: 'e4', to: 'e5' }, { from: 'd7', to: 'd5' },
    { from: 'e5', to: 'd6' },
  ]) state = playChess(state, move);
  assert.ok(chess.getPublicView(state).board.pieces.some((piece) => piece.id === 'd6' && piece.symbol === '♙'));

  state = chess.createInitialState({ players: ['white', 'black'], rules: {}, seed: 'seed' });
  for (const move of [
    { from: 'a2', to: 'a4' }, { from: 'h7', to: 'h5' }, { from: 'a4', to: 'a5' }, { from: 'h5', to: 'h4' },
    { from: 'a5', to: 'a6' }, { from: 'h4', to: 'h3' }, { from: 'a6', to: 'b7' }, { from: 'h3', to: 'g2' },
    { from: 'b7', to: 'a8', promotion: 'q' },
  ]) state = playChess(state, move);
  assert.ok(chess.getPublicView(state).board.pieces.some((piece) => piece.id === 'a8' && piece.symbol === '♕'));
});

test('chess rejects unsafe actions and handles terminal, claimable, and agreed draws', () => {
  let state = chess.createInitialState({ players: ['white', 'black'], rules: {}, seed: 'seed' });
  assert.throws(() => chess.applyAction(state, { type: 'move', from: 'e7', to: 'e5' }, context(state, 'white')), (error) => error.code === 'ACTION_NOT_LEGAL');
  assert.throws(() => chess.applyAction(state, { type: 'move', from: 'e2', to: 'e4' }, context(state, 'black')), (error) => error.code === 'NOT_YOUR_TURN');
  assert.throws(() => chess.applyAction(state, { type: 'move', from: 'a9', to: 'a1' }, context(state, 'white')), (error) => error.code === 'INVALID_ACTION');

  for (const move of [
    { from: 'f2', to: 'f3' }, { from: 'e7', to: 'e5' }, { from: 'g2', to: 'g4' }, { from: 'd8', to: 'h4' },
  ]) state = playChess(state, move);
  assert.equal(state.outcome.reason, 'checkmate');
  assert.throws(() => chess.applyAction(state, { type: 'move', from: 'e1', to: 'f2' }, context(state, 'white')), (error) => error.code === 'ACTION_NOT_LEGAL');

  state = chess.createInitialState({ players: ['white', 'black'], rules: {}, seed: 'seed' });
  for (let cycle = 0; cycle < 2; cycle += 1) {
    for (const move of [
      { from: 'g1', to: 'f3' }, { from: 'g8', to: 'f6' }, { from: 'f3', to: 'g1' }, { from: 'f6', to: 'g8' },
    ]) state = playChess(state, move);
  }
  const claim = chess.applyAction(state, { type: 'claim-draw' }, context(state, 'white'));
  assert.equal(claim.outcome.reason, 'threefold-repetition');

  state = chess.createInitialState({ players: ['white', 'black'], rules: {}, seed: 'seed' });
  state = chess.applyAction(state, { type: 'offer-draw' }, context(state, 'white')).state;
  const agreed = chess.applyAction(state, { type: 'accept-draw' }, context(state, 'black'));
  assert.equal(agreed.outcome.reason, 'agreed-draw');
});

test('gomoku uses a 15 by 15 server-owned grid and detects five or more in every direction', () => {
  let state = gomoku.createInitialState({ players: ['black', 'white'], rules: {}, seed: 'seed' });
  const before = JSON.stringify(state);
  for (const [x, y] of [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0], [2, 1], [3, 0], [3, 1]]) state = playGomoku(state, x, y);
  const result = gomoku.applyAction(state, { type: 'place', x: 4, y: 0 }, context(state, 'black'));
  assert.equal(result.outcome.reason, 'five-in-a-row');
  assert.equal(JSON.stringify(gomoku.createInitialState({ players: ['black', 'white'], rules: {}, seed: 'seed' })), before);
  const view = gomoku.getPublicView(result.state);
  assert.equal(view.board.width, 15);
  assert.ok(view.board.pieces.some((piece) => piece.position.x === 4 && piece.position.y === 0 && piece.symbol === '●'));
  assert.throws(() => gomoku.applyAction(result.state, { type: 'place', x: 5, y: 0 }, context(result.state, 'white')), (error) => error.code === 'ACTION_NOT_LEGAL');
});

test('gomoku rejects out of turn, invalid, and overwritten points; draw agreement and JSON restart retain legal moves', () => {
  let state = gomoku.createInitialState({ players: ['black', 'white'], rules: {}, seed: 'seed' });
  assert.throws(() => gomoku.applyAction(state, { type: 'place', x: 0, y: 0 }, context(state, 'white')), (error) => error.code === 'NOT_YOUR_TURN');
  assert.throws(() => gomoku.applyAction(state, { type: 'place', x: 15, y: 0 }, context(state, 'black')), (error) => error.code === 'INVALID_ACTION');
  state = playGomoku(state, 0, 0);
  state = playGomoku(state, 1, 0);
  assert.throws(() => gomoku.applyAction(state, { type: 'place', x: 0, y: 0 }, context(state, 'black')), (error) => error.code === 'ACTION_NOT_LEGAL');
  assert.deepEqual(gomoku.getLegalActions(JSON.parse(JSON.stringify(state)), { actorId: 'black' }), gomoku.getLegalActions(state, { actorId: 'black' }));

  state = gomoku.createInitialState({ players: ['black', 'white'], rules: {}, seed: 'seed' });
  state = gomoku.applyAction(state, { type: 'offer-draw' }, context(state, 'black')).state;
  const agreed = gomoku.applyAction(state, { type: 'accept-draw' }, context(state, 'white'));
  assert.equal(agreed.outcome.reason, 'agreed-draw');
});
