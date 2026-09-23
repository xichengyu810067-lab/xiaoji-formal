const test = require('node:test');
const assert = require('node:assert/strict');

const { BoardCoreError, BoardRuleError, GAME_KEYS } = require('../src/games/contracts');
const { BoardEngineRegistry } = require('../src/games/engineRegistry');
const { BoardSessionService } = require('../src/games/boardSessionService');
const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');
const { createMockBoardEngine } = require('./support/mockBoardEngine');

function createHarness({
  engine = createMockBoardEngine(),
  store = new InMemoryBoardStore(),
  presenter = null,
  initialTime = '2026-09-22T00:00:00.000Z',
} = {}) {
  let currentTime = new Date(initialTime);
  let id = 0;
  const registry = new BoardEngineRegistry([engine]);
  const service = new BoardSessionService({
    store,
    registry,
    presenter,
    clock: () => new Date(currentTime),
    idFactory: () => `session-${++id}`,
    seedFactory: () => `seed-${id}`,
  });
  return {
    service,
    store,
    registry,
    setTime(value) { currentTime = new Date(value); },
    advance(milliseconds) { currentTime = new Date(currentTime.getTime() + milliseconds); },
  };
}

async function createStartedChess(harness, { target = 5 } = {}) {
  const { service } = harness;
  const lobby = await service.start({
    guildId: 'guild-1', channelId: 'channel-1', hostId: 'host', gameKey: 'chess',
    options: { target }, interactionId: 'start-1',
  });
  const joined = await service.join({
    guildId: 'guild-1', channelId: 'channel-1', actorId: 'guest',
    expectedRevision: lobby.session.revision, interactionId: 'join-1',
  });
  const begun = await service.begin({
    guildId: 'guild-1', channelId: 'channel-1', actorId: 'host',
    expectedRevision: joined.session.revision, interactionId: 'begin-1',
  });
  return service.bindMessage({
    guildId: 'guild-1', channelId: 'channel-1', actorId: 'host', messageId: 'message-1',
    expectedRevision: begun.session.revision, interactionId: 'bind-1',
  });
}

test('board engine contract exposes fixed game keys and stable rule errors', () => {
  assert.deepEqual(GAME_KEYS, ['turtle-soup', 'chess', 'gomoku', 'go', 'checkers', 'xiangqi']);
  const error = new BoardRuleError('NOT_YOUR_TURN', 'wait');
  assert.equal(error.code, 'NOT_YOUR_TURN');
  assert(error instanceof BoardCoreError);
  assert.throws(() => new BoardRuleError('UNSAFE_INTERNAL', 'no'), /not supported/);
});

test('checkers lobby requires an explicit host begin and rejects five but accepts six players', async () => {
  const harness = createHarness({ engine: createMockBoardEngine({ key: 'checkers', allowedPlayerCounts: [2, 3, 4, 6] }) });
  const { service } = harness;
  let result = await service.start({
    guildId: 'g', channelId: 'c', hostId: 'p1', gameKey: 'checkers', options: {}, interactionId: 'i-start',
  });
  assert.equal(result.session.status, 'lobby');
  for (let player = 2; player <= 5; player += 1) {
    result = await service.join({
      guildId: 'g', channelId: 'c', actorId: `p${player}`,
      expectedRevision: result.session.revision, interactionId: `i-join-${player}`,
    });
  }
  await assert.rejects(
    () => service.begin({ guildId: 'g', channelId: 'c', actorId: 'p1', expectedRevision: result.session.revision, interactionId: 'i-begin-5' }),
    (error) => error?.code === 'INVALID_PLAYER_COUNT'
  );
  result = await service.join({
    guildId: 'g', channelId: 'c', actorId: 'p6',
    expectedRevision: result.session.revision, interactionId: 'i-join-6',
  });
  result = await service.begin({
    guildId: 'g', channelId: 'c', actorId: 'p1',
    expectedRevision: result.session.revision, interactionId: 'i-begin-6',
  });
  assert.equal(result.session.status, 'active');
  assert.equal(result.session.players.length, 6);
});

test('duplicate interactions replay once while stale revisions and changed payloads fail closed', async () => {
  const harness = createHarness();
  const bound = await createStartedChess(harness);
  const { service, store } = harness;
  const input = {
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', actorId: 'host',
    expectedRevision: bound.session.revision, interactionId: 'move-1', action: { type: 'move', amount: 1 },
  };
  const first = await service.submitAction(input);
  assert.equal(first.replayed, false);
  assert.equal(first.game.value, 1);
  const replay = await service.submitAction(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.session.revision, first.session.revision);
  assert.equal(store.actions.filter((entry) => entry.interactionId === 'move-1').length, 1);
  await assert.rejects(
    () => service.submitAction({ ...input, action: { type: 'move', amount: 2 } }),
    (error) => error?.code === 'INTERACTION_MISMATCH'
  );
  await assert.rejects(
    () => service.submitAction({ ...input, interactionId: 'move-stale' }),
    (error) => error?.code === 'STALE_REVISION'
  );
});

test('guild, channel, message, player, and turn authority are validated before an action', async () => {
  const harness = createHarness();
  const bound = await createStartedChess(harness);
  const base = {
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', actorId: 'host',
    expectedRevision: bound.session.revision, action: { type: 'move', amount: 1 },
  };
  await assert.rejects(
    () => harness.service.submitAction({ ...base, guildId: 'other-guild', interactionId: 'wrong-guild' }),
    (error) => error?.code === 'SESSION_NOT_FOUND'
  );
  await assert.rejects(
    () => harness.service.submitAction({ ...base, channelId: 'other-channel', interactionId: 'wrong-channel' }),
    (error) => error?.code === 'SESSION_NOT_FOUND'
  );
  await assert.rejects(
    () => harness.service.submitAction({ ...base, messageId: 'other-message', interactionId: 'wrong-message' }),
    (error) => error?.code === 'MESSAGE_MISMATCH'
  );
  await assert.rejects(
    () => harness.service.submitAction({ ...base, actorId: 'spectator', interactionId: 'wrong-player' }),
    (error) => error?.code === 'NOT_A_PLAYER'
  );
  const first = await harness.service.submitAction({ ...base, interactionId: 'right-move' });
  await assert.rejects(
    () => harness.service.submitAction({ ...base, expectedRevision: first.session.revision, interactionId: 'wrong-turn' }),
    (error) => error?.code === 'NOT_YOUR_TURN'
  );
});

test('concurrent actions with one revision commit only once', async () => {
  const harness = createHarness();
  const bound = await createStartedChess(harness, { target: 10 });
  const common = {
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', actorId: 'host',
    expectedRevision: bound.session.revision, action: { type: 'move', amount: 1 },
  };
  const results = await Promise.allSettled([
    harness.service.submitAction({ ...common, interactionId: 'concurrent-a' }),
    harness.service.submitAction({ ...common, interactionId: 'concurrent-b' }),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason?.code === 'STALE_REVISION').length, 1);
  const stored = await harness.store.getSessionById(bound.session.id);
  assert.equal(stored.state.value, 1);
});

test('Discord presentation failure cannot roll back a committed move', async () => {
  const presenter = { async refresh() { throw new Error('synthetic Discord failure'); } };
  const harness = createHarness({ presenter });
  const bound = await createStartedChess(harness);
  const moved = await harness.service.submitAction({
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', actorId: 'host',
    expectedRevision: bound.session.revision, interactionId: 'move-presentation-fails', action: { type: 'move', amount: 1 },
  });
  assert.deepEqual(moved.presentation, { ok: false, skipped: false, code: 'MESSAGE_UPDATE_FAILED' });
  const stored = await harness.store.getSessionById(bound.session.id);
  assert.equal(stored.state.value, 1);
  assert.equal(stored.revision, bound.session.revision + 1);
});

test('presentations are serialized per session so an older board cannot finish after a newer board', async () => {
  let releaseRevisionFour;
  let markRevisionFourStarted;
  const revisionFourGate = new Promise((resolve) => { releaseRevisionFour = resolve; });
  const revisionFourStarted = new Promise((resolve) => { markRevisionFourStarted = resolve; });
  const started = [];
  const completed = [];
  const presenter = {
    async refresh(result) {
      const revision = result.session.revision;
      started.push(revision);
      if (revision === 4) {
        markRevisionFourStarted();
        await revisionFourGate;
      }
      completed.push(revision);
    },
  };
  const harness = createHarness({ presenter });
  const bound = await createStartedChess(harness, { target: 10 });
  const firstPromise = harness.service.submitAction({
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', actorId: 'host',
    expectedRevision: bound.session.revision, interactionId: 'ordered-first', action: { type: 'move', amount: 1 },
  });
  await revisionFourStarted;
  const secondPromise = harness.service.submitAction({
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', actorId: 'guest',
    expectedRevision: bound.session.revision + 1, interactionId: 'ordered-second', action: { type: 'move', amount: 1 },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(started, [3, 4]);
  releaseRevisionFour();
  const [, second] = await Promise.all([firstPromise, secondPromise]);
  assert.equal(second.session.revision, 5);
  assert.deepEqual(started, [3, 4, 5]);
  assert.deepEqual(completed, [3, 4, 5]);
});

test('restart restores the same session and revision from the durable snapshot', async () => {
  const first = createHarness();
  const bound = await createStartedChess(first);
  const moved = await first.service.submitAction({
    guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', actorId: 'host',
    expectedRevision: bound.session.revision, interactionId: 'before-restart', action: { type: 'move', amount: 1 },
  });
  const reopenedStore = new InMemoryBoardStore(first.store.snapshot());
  const second = createHarness({ store: reopenedStore });
  const status = await second.service.status({ guildId: 'guild-1', channelId: 'channel-1', actorId: 'guest' });
  assert.equal(status.session.id, moved.session.id);
  assert.equal(status.session.revision, moved.session.revision);
  assert.equal(status.game.value, 1);
  assert.deepEqual(status.legalActions, [{ type: 'move', amount: 1 }]);
});

test('lobby and active inactivity deadlines expire atomically and release the channel', async () => {
  const lobbyHarness = createHarness();
  const lobby = await lobbyHarness.service.start({
    guildId: 'g', channelId: 'c', hostId: 'host', gameKey: 'chess', options: {}, interactionId: 'lobby-start',
  });
  lobbyHarness.advance(10 * 60 * 1000 + 1);
  await assert.rejects(
    () => lobbyHarness.service.status({ guildId: 'g', channelId: 'c', actorId: 'host' }),
    (error) => error?.code === 'SESSION_NOT_FOUND'
  );
  assert.equal((await lobbyHarness.store.getSessionById(lobby.session.id)).status, 'expired');
  const replacement = await lobbyHarness.service.start({
    guildId: 'g', channelId: 'c', hostId: 'host', gameKey: 'chess', options: {}, interactionId: 'replacement',
  });
  assert.notEqual(replacement.session.id, lobby.session.id);

  const activeHarness = createHarness();
  const active = await createStartedChess(activeHarness);
  activeHarness.advance(24 * 60 * 60 * 1000 + 1);
  await assert.rejects(
    () => activeHarness.service.status({ guildId: 'guild-1', channelId: 'channel-1', actorId: 'host' }),
    (error) => error?.code === 'SESSION_NOT_FOUND'
  );
  assert.equal((await activeHarness.store.getSessionById(active.session.id)).status, 'expired');
});

test('active board stop is denied while leave is a one-time resignation', async () => {
  const harness = createHarness();
  const active = await createStartedChess(harness);
  await assert.rejects(
    () => harness.service.stop({
      guildId: 'guild-1', channelId: 'channel-1', actorId: 'host',
      expectedRevision: active.session.revision, interactionId: 'stop-active-board',
    }),
    (error) => error?.code === 'RESIGN_REQUIRED'
  );
  const leaveInput = {
    guildId: 'guild-1', channelId: 'channel-1', actorId: 'host',
    expectedRevision: active.session.revision, interactionId: 'resign-once',
  };
  const resigned = await harness.service.leave(leaveInput);
  assert.equal(resigned.session.status, 'completed');
  assert.deepEqual(resigned.session.outcome.winnerIds, ['guest']);
  const replay = await harness.service.leave(leaveInput);
  assert.equal(replay.replayed, true);
  assert.equal(harness.store.actions.filter((entry) => entry.interactionId === 'resign-once').length, 1);
});

test('user JSON cannot forge a trusted retirement or retire another player', async () => {
  const harness = createHarness();
  const active = await createStartedChess(harness);
  const before = await harness.store.getSessionById(active.session.id);
  for (const [interactionId, action] of [
    ['forged-self', { type: 'player-retired', playerId: 'host' }],
    ['forged-other', { type: 'player-retired', playerId: 'guest' }],
    ['forged-namespace', { type: 'system:anything', playerId: 'guest' }],
  ]) {
    await assert.rejects(
      () => harness.service.submitAction({
        guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', actorId: 'host',
        expectedRevision: before.revision, interactionId, action,
      }),
      (error) => error?.code === 'RESERVED_ACTION'
    );
  }
  const after = await harness.store.getSessionById(active.session.id);
  assert.equal(after.revision, before.revision);
  assert.deepEqual(after.players, before.players);
  assert.equal(harness.store.actions.some((entry) => String(entry.interactionId || '').startsWith('forged-')), false);
});

test('trusted multiplayer leave retires only the actor, remains active, deduplicates, and rejects stale follow-up', async () => {
  const harness = createHarness({ engine: createMockBoardEngine({ key: 'checkers', allowedPlayerCounts: [3] }) });
  let result = await harness.service.start({ guildId: 'g', channelId: 'c', hostId: 'p1', gameKey: 'checkers', options: {}, interactionId: 'multi-start' });
  for (const playerId of ['p2', 'p3']) {
    result = await harness.service.join({ guildId: 'g', channelId: 'c', actorId: playerId, expectedRevision: result.session.revision, interactionId: `multi-join-${playerId}` });
  }
  result = await harness.service.begin({ guildId: 'g', channelId: 'c', actorId: 'p1', expectedRevision: result.session.revision, interactionId: 'multi-begin' });
  const leaveInput = { guildId: 'g', channelId: 'c', actorId: 'p2', expectedRevision: result.session.revision, interactionId: 'multi-leave' };
  const left = await harness.service.leave(leaveInput);
  assert.equal(left.session.status, 'active');
  assert.equal(left.session.players.find((player) => player.userId === 'p2').status, 'retired');
  assert.equal(left.session.players.find((player) => player.userId === 'p3').status, 'active');
  assert.equal((await harness.service.leave(leaveInput)).replayed, true);
  await assert.rejects(
    () => harness.service.leave({ ...leaveInput, actorId: 'p3', interactionId: 'multi-stale' }),
    (error) => error?.code === 'STALE_REVISION'
  );
});

test('turtle soup leave never enters the engine, transfers host, and cancels only after the last participant leaves', async () => {
  const engine = createMockBoardEngine({ key: 'turtle-soup', allowedPlayerCounts: [1, 2, 3] });
  engine.applyAction = () => { throw new Error('turtle leave must not enter the engine'); };
  const harness = createHarness({ engine });
  let result = await harness.service.start({ guildId: 'g', channelId: 'c', hostId: 'p1', gameKey: 'turtle-soup', options: {}, interactionId: 'soup-start' });
  for (const playerId of ['p2', 'p3']) {
    result = await harness.service.join({ guildId: 'g', channelId: 'c', actorId: playerId, expectedRevision: result.session.revision, interactionId: `soup-join-${playerId}` });
  }
  result = await harness.service.begin({ guildId: 'g', channelId: 'c', actorId: 'p1', expectedRevision: result.session.revision, interactionId: 'soup-begin' });
  result = await harness.service.leave({ guildId: 'g', channelId: 'c', actorId: 'p1', expectedRevision: result.session.revision, interactionId: 'soup-host-leave' });
  assert.equal(result.session.status, 'active');
  assert.equal(result.session.hostId, 'p2');
  result = await harness.service.leave({ guildId: 'g', channelId: 'c', actorId: 'p2', expectedRevision: result.session.revision, interactionId: 'soup-p2-leave' });
  assert.equal(result.session.status, 'active');
  assert.equal(result.session.hostId, 'p3');
  result = await harness.service.leave({ guildId: 'g', channelId: 'c', actorId: 'p3', expectedRevision: result.session.revision, interactionId: 'soup-last-leave' });
  assert.equal(result.session.status, 'cancelled');
  assert.equal(result.session.outcome, null);
  assert.equal((await harness.store.getSessionById(result.session.id)).endReason, 'all-players-left');
});

test('malformed, mutating, or throwing engine transitions fail before persistence', async (t) => {
  const cases = [
    ['terminal false', (state) => ({ state, events: [], outcome: { terminal: false, type: 'win', winnerIds: [], loserIds: [], reason: 'bad' }, progressed: true }), 'ENGINE_CONTRACT_VIOLATION'],
    ['unknown winner', (state) => ({ state, events: [], outcome: { terminal: true, type: 'win', winnerIds: ['outsider'], loserIds: [], reason: 'bad' }, progressed: true }), 'ENGINE_CONTRACT_VIOLATION'],
    ['missing state', () => ({ events: [], outcome: null, progressed: true }), 'ENGINE_CONTRACT_VIOLATION'],
    ['wrong state binding', (state) => ({ state: { ...state, gameKey: 'gomoku' }, events: [], outcome: null, progressed: true }), 'ENGINE_CONTRACT_VIOLATION'],
    ['non-json state', (state) => ({ state: { ...state, impossible: 1n }, events: [], outcome: null, progressed: true }), 'INVALID_JSON'],
    ['input mutation', (state) => { state.value = 999; return { state: { ...state, value: 1 }, events: [], outcome: null, progressed: true }; }, 'ENGINE_CONTRACT_VIOLATION'],
    ['unexpected throw', () => { throw new Error('private engine failure'); }, 'ENGINE_FAILURE'],
  ];
  for (const [name, applyAction, expectedCode] of cases) {
    await t.test(name, async () => {
      const engine = createMockBoardEngine();
      engine.applyAction = applyAction;
      const harness = createHarness({ engine });
      const active = await createStartedChess(harness);
      const before = await harness.store.getSessionById(active.session.id);
      await assert.rejects(
        () => harness.service.submitAction({
          guildId: 'guild-1', channelId: 'channel-1', messageId: 'message-1', actorId: 'host',
          expectedRevision: active.session.revision, interactionId: `malformed-${name}`, action: { type: 'move', amount: 1 },
        }),
        (error) => error?.code === expectedCode
      );
      const after = await harness.store.getSessionById(active.session.id);
      assert.deepEqual(after, before);
      assert.equal(harness.store.actions.some((entry) => entry.interactionId === `malformed-${name}`), false);
    });
  }
});

test('store rejects async callbacks so external awaits cannot occur inside a transaction', async () => {
  const harness = createHarness();
  const lobby = await harness.service.start({
    guildId: 'g', channelId: 'c', hostId: 'host', gameKey: 'chess', options: {}, interactionId: 'start',
  });
  await assert.rejects(
    () => harness.store.mutate({
      guildId: 'g', channelId: 'c', expectedRevision: lobby.session.revision,
      interactionId: 'async-mutation', requestDigest: 'digest',
    }, async (session) => ({ session })),
    (error) => error?.code === 'ASYNC_TRANSACTION_FORBIDDEN'
  );
});
