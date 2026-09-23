const assert = require('node:assert/strict');
const test = require('node:test');
const { BoardRuleError } = require('../src/games/contracts');
const { BoardEngineRegistry } = require('../src/games/engineRegistry');
const { BoardSessionService } = require('../src/games/boardSessionService');
const { createTrustedSystemAction } = require('../src/games/trustedSystemActions');
const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');
const engine = require('../src/games/engines/checkers');

function createState(count = 2) {
  const players = Array.from({ length: count }, (_value, index) => `player-${index + 1}`);
  return engine.createInitialState({ players, rules: {}, seed: 'synthetic-seed' });
}

function context(state, actorId, activePlayers = state.players.map((player) => player.id)) {
  return {
    actorId,
    players: state.players.map((player) => player.id),
    activePlayers,
    retiredPlayers: state.retiredPlayerIds,
    revision: 7,
    now: '2026-09-22T00:00:00.000Z',
  };
}

function movePiece(state, pieceId, pointId) {
  const piece = state.pieces.find((entry) => entry.id === pieceId);
  assert.ok(piece, `missing fixture piece ${pieceId}`);
  piece.pointId = pointId;
}

function expectRuleError(work, code) {
  assert.throws(work, (error) => error instanceof BoardRuleError && error.code === code);
}

function findInitialAdjacentMove(state, playerId) {
  const occupied = new Set(state.pieces.map((piece) => piece.pointId));
  const pointIds = new Set(engine.getPublicView(state).board.points.map((point) => point.id));
  const directions = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];
  for (const piece of state.pieces.filter((entry) => entry.ownerId === playerId)) {
    const [, qText, rText] = /^q(-?\d+)r(-?\d+)$/.exec(piece.pointId);
    for (const [deltaQ, deltaR] of directions) {
      const destination = `q${Number(qText) + deltaQ}r${Number(rText) + deltaR}`;
      if (pointIds.has(destination) && !occupied.has(destination)) {
        return { type: 'move', path: [piece.pointId, destination] };
      }
    }
  }
  throw new Error('Initial Chinese checkers state had no adjacent move.');
}

function createCheckersHarness() {
  let id = 0;
  const store = new InMemoryBoardStore();
  const service = new BoardSessionService({
    store,
    registry: new BoardEngineRegistry([engine]),
    clock: () => new Date('2026-09-22T00:00:00.000Z'),
    idFactory: () => `checkers-session-${++id}`,
    seedFactory: () => `checkers-seed-${id}`,
  });
  return { service, store };
}

test('engine satisfies the formal board-core registry contract', () => {
  const registry = new BoardEngineRegistry([engine]);
  assert.equal(registry.get('checkers'), engine);
  assert.deepEqual(registry.list(), ['checkers']);
});

test('a normal initial two-player game accepts a server-validated move DTO', () => {
  const state = createState();
  const action = findInitialAdjacentMove(state, 'player-1');
  const result = engine.applyAction(state, action, context(state, 'player-1'));
  assert.deepEqual(result.events, [{ type: 'piece-moved', playerId: 'player-1', path: action.path }]);
  assert.equal(result.state.turn.playerId, 'player-2');
});

test('Chinese checkers board has 121 unique points, six ten-point camps, and a 61-point centre', () => {
  const state = createState(6);
  const view = engine.getPublicView(state);
  assert.equal(view.board.kind, 'graph');
  assert.equal(view.board.points.length, 121);
  assert.equal(new Set(view.board.points.map((point) => point.id)).size, 121);
  const pointIds = new Set(view.board.points.map((point) => point.id));
  for (const { id } of view.board.points) {
    const [, qText, rText] = /^q(-?\d+)r(-?\d+)$/.exec(id);
    let q = Number(qText);
    let r = Number(rText);
    for (let rotation = 0; rotation < 6; rotation += 1) {
      assert.ok(pointIds.has(`q${q}r${r}`));
      [q, r] = [-r, q + r];
    }
  }
  assert.deepEqual(view.board.camps.map((camp) => camp.pointIds.length), [10, 10, 10, 10, 10, 10]);
  const centre = view.board.points.filter(({ id }) => {
    const match = /^q(-?\d+)r(-?\d+)$/.exec(id);
    const q = Number(match[1]);
    const r = Number(match[2]);
    return Math.abs(q) <= 4 && Math.abs(r) <= 4 && Math.abs(q + r) <= 4;
  });
  assert.equal(centre.length, 61);
  assert.equal(view.board.coordinateSystem.format, 'q{q}r{r}');
  assert.ok(view.board.points.every((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
});

test('only 2, 3, 4, or 6 players initialise with fixed opposite camps', () => {
  assert.deepEqual(engine.allowedPlayerCounts, [2, 3, 4, 6]);
  for (const count of [2, 3, 4, 6]) {
    const state = createState(count);
    assert.equal(state.players.length, count);
    assert.equal(state.pieces.length, count * 10);
    assert.equal(new Set(state.pieces.map((piece) => piece.pointId)).size, count * 10);
    for (const player of state.players) {
      const camp = engine.getPublicView(state).board.camps.find((entry) => entry.id === player.campId);
      assert.equal(camp.pointIds.filter((pointId) => state.pieces.some((piece) => piece.ownerId === player.id && piece.pointId === pointId)).length, 10);
      assert.notEqual(player.campId, player.targetCampId);
    }
    assert.ok(engine.getPublicView(state).players.every((player) => /^#[0-9a-f]{6}$/i.test(player.color)));
  }
  expectRuleError(() => createState(5), 'INVALID_ACTION');
});

test('a player may jump over either their own or another player\'s piece', () => {
  const own = createState();
  movePiece(own, 's0-0', 'q0r0');
  movePiece(own, 's0-1', 'q1r0');
  const ownResult = engine.applyAction(own, { type: 'move', path: ['q0r0', 'q2r0'] }, context(own, 'player-1'));
  assert.equal(ownResult.state.pieces.find((piece) => piece.id === 's0-0').pointId, 'q2r0');

  const enemy = createState();
  movePiece(enemy, 's0-0', 'q0r0');
  movePiece(enemy, 's1-0', 'q1r0');
  const enemyResult = engine.applyAction(enemy, { type: 'move', path: ['q0r0', 'q2r0'] }, context(enemy, 'player-1'));
  assert.equal(enemyResult.state.pieces.find((piece) => piece.id === 's0-0').pointId, 'q2r0');
});

test('jump chains validate every segment and reject repeated landing points', () => {
  const legal = createState();
  movePiece(legal, 's0-0', 'q0r0');
  movePiece(legal, 's0-1', 'q1r0');
  movePiece(legal, 's0-2', 'q3r0');
  const result = engine.applyAction(legal, { type: 'move', path: ['q0r0', 'q2r0', 'q4r0'] }, context(legal, 'player-1'));
  assert.deepEqual(result.events, [{ type: 'piece-moved', playerId: 'player-1', path: ['q0r0', 'q2r0', 'q4r0'] }]);

  const missingSecondBridge = createState();
  movePiece(missingSecondBridge, 's0-0', 'q0r0');
  movePiece(missingSecondBridge, 's0-1', 'q1r0');
  expectRuleError(() => engine.applyAction(
    missingSecondBridge,
    { type: 'move', path: ['q0r0', 'q2r0', 'q4r0'] },
    context(missingSecondBridge, 'player-1'),
  ), 'ACTION_NOT_LEGAL');
  expectRuleError(() => engine.applyAction(
    legal,
    { type: 'move', path: ['q0r0', 'q2r0', 'q0r0'] },
    context(legal, 'player-1'),
  ), 'ACTION_NOT_LEGAL');
});

test('moves reject the wrong actor, invalid board points, occupied landings, and post-game actions', () => {
  const state = createState();
  movePiece(state, 's0-0', 'q0r0');
  movePiece(state, 's1-0', 'q1r0');
  expectRuleError(() => engine.applyAction(
    state,
    { type: 'move', path: ['q0r0', 'q1r0'] },
    context(state, 'player-2'),
  ), 'NOT_YOUR_TURN');
  expectRuleError(() => engine.applyAction(
    state,
    { type: 'move', path: ['q0r0', 'q99r99'] },
    context(state, 'player-1'),
  ), 'ACTION_NOT_LEGAL');
  expectRuleError(() => engine.applyAction(
    state,
    { type: 'move', path: ['q0r0', 42] },
    context(state, 'player-1'),
  ), 'INVALID_ACTION');
  expectRuleError(() => engine.applyAction(
    state,
    { type: 'move', path: ['q0r0', 'q1r0'] },
    context(state, 'player-1'),
  ), 'ACTION_NOT_LEGAL');
  const finished = { ...state, outcome: { terminal: true, type: 'win', winnerIds: ['player-1'], loserIds: ['player-2'], reason: 'fixture' }, turn: null };
  expectRuleError(() => engine.applyAction(finished, { type: 'resign' }, context(finished, 'player-2')), 'ACTION_NOT_LEGAL');
});

test('placing all ten pieces in the opposite camp wins immediately', () => {
  const state = createState();
  const playerOne = state.players[0];
  const target = engine.getPublicView(state).board.camps.find((camp) => camp.id === playerOne.targetCampId).pointIds;
  const home = engine.getPublicView(state).board.camps.find((camp) => camp.id === playerOne.campId).pointIds;
  state.pieces.filter((piece) => piece.ownerId === 'player-1').forEach((piece, index) => {
    piece.pointId = index === 0 ? 'q-4r1' : target[index];
  });
  state.pieces.filter((piece) => piece.ownerId === 'player-2').forEach((piece, index) => {
    piece.pointId = home[index];
  });
  const result = engine.applyAction(state, { type: 'move', path: ['q-4r1', target[0]] }, context(state, 'player-1'));
  assert.deepEqual(result.outcome, {
    terminal: true,
    type: 'win',
    winnerIds: ['player-1'],
    loserIds: ['player-2'],
    reason: 'all-pieces-in-target-camp',
  });
  assert.equal(result.state.turn, null);
});

test('resigning removes only the retired player, preserves camps, and advances active players', () => {
  const state = createState(3);
  const result = engine.applyAction(state, { type: 'resign' }, context(state, 'player-2'));
  assert.deepEqual(result.state.retiredPlayerIds, ['player-2']);
  assert.equal(result.state.pieces.some((piece) => piece.ownerId === 'player-2'), false);
  const view = engine.getPublicView(result.state);
  assert.equal(view.board.camps.length, 6);
  assert.equal(view.players.find((player) => player.id === 'player-2').status, 'retired');
  assert.equal(view.players.find((player) => player.id === 'player-1').targetCampId, 'xn');
  assert.equal(result.state.turn.playerId, 'player-1');
  expectRuleError(() => engine.applyAction(
    result.state,
    { type: 'move', path: ['q0r0', 'q1r0'] },
    context(result.state, 'player-2', ['player-1', 'player-3']),
  ), 'ACTION_NOT_LEGAL');

  const twoPlayer = createState();
  expectRuleError(() => engine.applyAction(
    twoPlayer,
    { type: 'player-retired', playerId: 'player-1' },
    context(twoPlayer, 'player-1'),
  ), 'INVALID_ACTION');
  expectRuleError(() => engine.applyAction(
    twoPlayer,
    createTrustedSystemAction('player-retired', { playerId: 'player-2' }),
    context(twoPlayer, 'player-1'),
  ), 'INVALID_ACTION');
  const terminal = engine.applyAction(
    twoPlayer,
    createTrustedSystemAction('player-retired', { playerId: 'player-1' }),
    context(twoPlayer, 'player-1'),
  );
  assert.deepEqual(terminal.outcome.winnerIds, ['player-2']);
  assert.deepEqual(terminal.outcome.loserIds, ['player-1']);
});

test('the core can retire a non-current player once, while forged and stale requests fail closed', async () => {
  const { service, store } = createCheckersHarness();
  let result = await service.start({
    guildId: 'guild', channelId: 'channel', hostId: 'player-1', gameKey: 'checkers', options: {}, interactionId: 'start',
  });
  for (const actorId of ['player-2', 'player-3']) {
    result = await service.join({
      guildId: 'guild', channelId: 'channel', actorId, expectedRevision: result.session.revision, interactionId: `join-${actorId}`,
    });
  }
  result = await service.begin({
    guildId: 'guild', channelId: 'channel', actorId: 'player-1', expectedRevision: result.session.revision, interactionId: 'begin',
  });
  const leaveInput = {
    guildId: 'guild', channelId: 'channel', actorId: 'player-2', expectedRevision: result.session.revision, interactionId: 'retire-player-2',
  };
  const left = await service.leave(leaveInput);
  assert.equal(left.session.status, 'active');
  assert.equal(left.session.turn.playerId, 'player-1');
  assert.equal(left.session.players.find((player) => player.userId === 'player-2').status, 'retired');
  assert.equal((await service.leave(leaveInput)).replayed, true);
  await assert.rejects(
    () => service.leave({ ...leaveInput, actorId: 'player-3', interactionId: 'stale-retire-player-3' }),
    (error) => error?.code === 'STALE_REVISION',
  );
  await assert.rejects(
    () => service.submitAction({
      guildId: 'guild', channelId: 'channel', messageId: 'unbound-message', actorId: 'player-1',
      expectedRevision: left.session.revision, interactionId: 'forged-retire', action: { type: 'player-retired', playerId: 'player-1' },
    }),
    (error) => error?.code === 'RESERVED_ACTION',
  );
  assert.equal(store.actions.filter((entry) => entry.interactionId === 'retire-player-2').length, 1);
});

test('state is JSON-restartable, action application does not mutate input, and public view is renderer-ready', () => {
  const state = createState();
  movePiece(state, 's0-0', 'q0r0');
  movePiece(state, 's0-1', 'q1r0');
  const before = JSON.parse(JSON.stringify(state));
  const restored = JSON.parse(JSON.stringify(state));
  const action = { type: 'move', path: ['q0r0', 'q2r0'] };
  const first = engine.applyAction(state, action, context(state, 'player-1'));
  const restarted = engine.applyAction(restored, action, context(restored, 'player-1'));
  assert.deepEqual(first, restarted);
  assert.deepEqual(state, before);

  const view = engine.getPublicView(first.state);
  assert.equal(view.turn.playerId, 'player-2');
  assert.equal(view.board.pieces.length, 20);
  assert.equal(view.board.pieces.find((piece) => piece.id === 's0-0').position.pointId, 'q2r0');
  assert.match(view.prompts[1].text, /pointId/);
  assert.equal(view.outcome, null);
});
