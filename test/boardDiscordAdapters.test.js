const test = require('node:test');
const assert = require('node:assert/strict');

const { BoardEngineRegistry } = require('../src/games/engineRegistry');
const { BoardSessionService } = require('../src/games/boardSessionService');
const { buildBoardCustomId, parseBoardCustomId } = require('../src/games/discord/boardCustomId');
const {
  createDiscordBoardInteractionAdapter,
  createGridMoveParser,
  getModalValue,
  parseGridCoordinate,
} = require('../src/games/discord/boardInteractionAdapter');
const {
  buildBoardMessagePayload,
  createDiscordBoardPresenter,
} = require('../src/games/discord/boardPresenter');
const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');
const { createMockBoardEngine } = require('./support/mockBoardEngine');

function fakeInteraction({ id, customId, actorId, guildId = 'g', channelId = 'c', messageId = 'm', fields = {} }) {
  return {
    id,
    customId,
    guildId,
    channelId,
    message: { id: messageId },
    user: { id: actorId },
    fields: { getTextInputValue(name) { return fields[name] || ''; } },
  };
}

async function createHarness({ presenter = null } = {}) {
  let id = 0;
  let currentTime = new Date('2026-09-22T00:00:00.000Z');
  const store = new InMemoryBoardStore();
  const registry = new BoardEngineRegistry([createMockBoardEngine()]);
  const service = new BoardSessionService({
    store,
    registry,
    clock: () => new Date(currentTime),
    idFactory: () => `discord-session-${++id}`,
    seedFactory: () => `discord-seed-${id}`,
    presenter,
  });
  const started = await service.start({ guildId: 'g', channelId: 'c', hostId: 'p1', gameKey: 'chess', options: { target: 5 }, interactionId: 'start' });
  const bound = await service.bindMessage({ guildId: 'g', channelId: 'c', actorId: 'p1', messageId: 'm', expectedRevision: started.session.revision, interactionId: 'bind' });
  const adapter = createDiscordBoardInteractionAdapter({
    service,
    store,
    actionParsers: {
      chess: {
        move: ({ interaction }) => ({ type: 'move', amount: Number(getModalValue(interaction, 'amount')) }),
        async: async () => ({ type: 'move', amount: 1 }),
      },
    },
  });
  return {
    adapter,
    bound,
    service,
    store,
    advance(milliseconds) { currentTime = new Date(currentTime.getTime() + milliseconds); },
  };
}

test('custom IDs are bounded, reversible, and reject malformed values', () => {
  const customId = buildBoardCustomId({ sessionId: 'session_123', revision: 42, verb: 'act.move' });
  assert.deepEqual(parseBoardCustomId(customId), { sessionId: 'session_123', revision: 42, verb: 'act.move' });
  assert(customId.length <= 100);
  assert.throws(() => parseBoardCustomId('board|2|session|0|join'), /not a supported|shape/);
  assert.throws(() => buildBoardCustomId({ sessionId: 'contains|pipe', revision: 0, verb: 'join' }), /unsupported/);
});

test('Discord adapter validates session, guild, channel, message, player, and revision through the real core', async () => {
  const harness = await createHarness();
  const joinId = buildBoardCustomId({ sessionId: harness.bound.session.id, revision: harness.bound.session.revision, verb: 'join' });
  const joined = await harness.adapter.handle(fakeInteraction({ id: 'join', customId: joinId, actorId: 'p2' }));
  assert.equal(joined.session.revision, harness.bound.session.revision + 1);

  const beginId = buildBoardCustomId({ sessionId: joined.session.id, revision: joined.session.revision, verb: 'begin' });
  const begun = await harness.adapter.handle(fakeInteraction({ id: 'begin', customId: beginId, actorId: 'p1' }));
  assert.equal(begun.session.status, 'active');

  const moveId = buildBoardCustomId({ sessionId: begun.session.id, revision: begun.session.revision, verb: 'act.move' });
  const moveInteraction = fakeInteraction({ id: 'move', customId: moveId, actorId: 'p1', fields: { amount: '1' } });
  const moved = await harness.adapter.handle(moveInteraction);
  assert.equal(moved.game.value, 1);
  assert.equal((await harness.adapter.handle(moveInteraction)).replayed, true);

  await assert.rejects(
    () => harness.adapter.handle(fakeInteraction({ id: 'wrong-guild', customId: moveId, actorId: 'p1', guildId: 'other' })),
    (error) => error?.code === 'SESSION_SCOPE_MISMATCH'
  );
  await assert.rejects(
    () => harness.adapter.handle(fakeInteraction({ id: 'wrong-channel', customId: moveId, actorId: 'p1', channelId: 'other' })),
    (error) => error?.code === 'SESSION_SCOPE_MISMATCH'
  );
  await assert.rejects(
    () => harness.adapter.handle(fakeInteraction({ id: 'wrong-message', customId: moveId, actorId: 'p1', messageId: 'other' })),
    (error) => error?.code === 'MESSAGE_MISMATCH'
  );
  await assert.rejects(
    () => harness.adapter.handle(fakeInteraction({ id: 'spectator', customId: moveId, actorId: 'spectator' })),
    (error) => error?.code === 'NOT_A_PLAYER'
  );
  await assert.rejects(
    () => harness.adapter.handle(fakeInteraction({ id: 'stale', customId: moveId, actorId: 'p2', fields: { amount: '1' } })),
    (error) => error?.code === 'STALE_REVISION'
  );
});

test('stale refresh control redraws the latest committed revision without changing session state', async () => {
  const presented = [];
  let failRevisionFour = true;
  const presenter = {
    async refresh(result) {
      presented.push(result.session.revision);
      if (result.session.revision === 4 && failRevisionFour) {
        failRevisionFour = false;
        throw new Error('synthetic Discord update failure');
      }
    },
  };
  const harness = await createHarness({ presenter });
  const joined = await harness.service.join({
    guildId: 'g', channelId: 'c', actorId: 'p2',
    expectedRevision: harness.bound.session.revision, interactionId: 'refresh-join',
  });
  const begun = await harness.service.begin({
    guildId: 'g', channelId: 'c', actorId: 'p1',
    expectedRevision: joined.session.revision, interactionId: 'refresh-begin',
  });
  const moveId = buildBoardCustomId({ sessionId: begun.session.id, revision: begun.session.revision, verb: 'act.move' });
  const moved = await harness.adapter.handle(fakeInteraction({
    id: 'refresh-move', customId: moveId, actorId: 'p1', fields: { amount: '1' },
  }));
  assert.deepEqual(moved.presentation, { ok: false, skipped: false, code: 'MESSAGE_UPDATE_FAILED' });
  const beforeRefresh = await harness.store.getSessionById(moved.session.id);
  const staleRefreshId = buildBoardCustomId({ sessionId: begun.session.id, revision: begun.session.revision, verb: 'status' });
  const refreshed = await harness.adapter.handle(fakeInteraction({
    id: 'refresh-stale-control', customId: staleRefreshId, actorId: 'p1',
  }));
  assert.equal(refreshed.session.revision, moved.session.revision);
  assert.equal(refreshed.game.value, 1);
  assert.deepEqual(refreshed.presentation, { ok: true, skipped: false });
  const stored = await harness.store.getSessionById(moved.session.id);
  assert.deepEqual(stored, beforeRefresh);
  assert.deepEqual(presented.slice(-2), [moved.session.revision, moved.session.revision]);
  await assert.rejects(
    () => harness.adapter.handle(fakeInteraction({
      id: 'refresh-outsider', customId: staleRefreshId, actorId: 'spectator',
    })),
    (error) => error?.code === 'NOT_A_PLAYER'
  );
});

test('refresh controls atomically expire timed-out lobby and active sessions before redrawing', async () => {
  const lobby = await createHarness();
  lobby.advance(10 * 60 * 1000 + 1);
  const lobbyRefreshId = buildBoardCustomId({
    sessionId: lobby.bound.session.id,
    revision: lobby.bound.session.revision,
    verb: 'status',
  });
  const expiredLobby = await lobby.adapter.handle(fakeInteraction({
    id: 'expire-lobby-refresh', customId: lobbyRefreshId, actorId: 'p1',
  }));
  assert.equal(expiredLobby.session.status, 'expired');
  assert.equal(expiredLobby.session.revision, lobby.bound.session.revision + 1);
  assert.equal((await lobby.store.getSessionById(lobby.bound.session.id)).endReason, 'lobby-timeout');

  const active = await createHarness();
  const joined = await active.service.join({
    guildId: 'g', channelId: 'c', actorId: 'p2',
    expectedRevision: active.bound.session.revision, interactionId: 'expire-active-join',
  });
  const begun = await active.service.begin({
    guildId: 'g', channelId: 'c', actorId: 'p1',
    expectedRevision: joined.session.revision, interactionId: 'expire-active-begin',
  });
  active.advance(24 * 60 * 60 * 1000 + 1);
  const activeRefreshId = buildBoardCustomId({
    sessionId: begun.session.id,
    revision: begun.session.revision,
    verb: 'status',
  });
  const expiredActive = await active.adapter.handle(fakeInteraction({
    id: 'expire-active-refresh', customId: activeRefreshId, actorId: 'p1',
  }));
  assert.equal(expiredActive.session.status, 'expired');
  assert.equal(expiredActive.session.revision, begun.session.revision + 1);
  assert.equal((await active.store.getSessionById(begun.session.id)).endReason, 'inactivity-timeout');
});

test('modal parsers are synchronous and grid coordinates are strictly bounded', async () => {
  const board = { width: 9, height: 10 };
  assert.deepEqual(parseGridCoordinate('A1', board), { x: 0, y: 0 });
  assert.deepEqual(parseGridCoordinate('8,9', board), { x: 8, y: 9 });
  assert.throws(() => parseGridCoordinate('J1', board), /outside/);
  assert.throws(() => parseGridCoordinate('A0', board), /outside/);
  const parser = createGridMoveParser();
  const action = parser({
    interaction: fakeInteraction({ id: 'coordinate', customId: 'unused', actorId: 'p1', fields: { from: 'A1', to: 'B2' } }),
    publicView: { board },
  });
  assert.deepEqual(action, { type: 'move', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } });

  const harness = await createHarness();
  const joined = await harness.service.join({ guildId: 'g', channelId: 'c', actorId: 'p2', expectedRevision: harness.bound.session.revision, interactionId: 'join-async' });
  const begun = await harness.service.begin({ guildId: 'g', channelId: 'c', actorId: 'p1', expectedRevision: joined.session.revision, interactionId: 'begin-async' });
  const asyncId = buildBoardCustomId({ sessionId: begun.session.id, revision: begun.session.revision, verb: 'act.async' });
  await assert.rejects(
    () => harness.adapter.handle(fakeInteraction({ id: 'async-parser', customId: asyncId, actorId: 'p1' })),
    (error) => error?.code === 'ASYNC_ACTION_PARSER_FORBIDDEN'
  );
  assert.equal((await harness.store.getSessionById(begun.session.id)).revision, begun.session.revision);
});

test('presenter uses the committed revision in every PNG name and component custom ID', async () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const result = {
    session: {
      id: 'present-session', guildId: 'g', channelId: 'c', messageId: 'm', gameKey: 'chess', rulesVersion: '1',
      status: 'active', hostId: 'p1', players: [{ userId: 'p1', seat: 0, status: 'active' }, { userId: 'p2', seat: 1, status: 'active' }],
      turn: { playerId: 'p1', phase: 'move' }, outcome: null, revision: 7, expiresAt: '2026-09-23T00:00:00.000Z',
    },
    game: {
      gameKey: 'chess', rulesVersion: '1',
      board: { kind: 'grid', width: 8, height: 8, points: [], pieces: [] },
      turn: { playerId: 'p1', phase: 'move' }, prompts: [], outcome: null,
      controls: [{ id: 'move', label: '走棋', kind: 'modal' }],
    },
    legalActions: [], events: [], replayed: false,
  };
  const payload = await buildBoardMessagePayload(result, { renderPng: async () => png });
  assert.equal(payload.embeds[0].title, '西洋棋');
  assert.equal(payload.files[0].name, 'board-present-session-r7.png');
  assert.equal(payload.embeds[0].image.url, 'attachment://board-present-session-r7.png');
  for (const row of payload.components) for (const component of row.components) {
    assert.equal(parseBoardCustomId(component.customId).revision, 7);
  }
  let update = null;
  const presenter = createDiscordBoardPresenter({
    renderPng: () => png,
    transport: { async update(value) { update = value; } },
  });
  await presenter.refresh(result);
  assert.deepEqual({ guildId: update.guildId, channelId: update.channelId, messageId: update.messageId }, { guildId: 'g', channelId: 'c', messageId: 'm' });
  assert.equal(update.payload.files[0].name, 'board-present-session-r7.png');
});
