const test = require('node:test');
const assert = require('node:assert/strict');

const { buildBoardCustomId } = require('../src/games/discord/boardCustomId');
const {
  createActionParsers,
  getControls,
  getModalDefinition,
  parseCheckersPath,
  parsePromotion,
} = require('../src/games/discord/boardControls');
const { createBoardDiscordRuntime } = require('../src/games/discord/boardDiscordRuntime');
const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');

function recoverableStore(snapshot = null) {
  const store = new InMemoryBoardStore(snapshot);
  store.listRecoverable = async ({ now, limit }) => store.snapshot().sessions
    .filter((session) => ['lobby', 'active'].includes(session.status) && session.expiresAt > now)
    .slice(0, limit);
  return store;
}

function fakeTransport() {
  const state = { updates: [], replacements: [], missing: false };
  return {
    state,
    async update(value) { state.updates.push(value); },
    async messageExists() { return !state.missing; },
    async createReplacement({ guildId, channelId }) {
      const replacement = { id: `replacement-${state.replacements.length + 1}`, guildId, channelId };
      state.replacements.push(replacement);
      return replacement;
    },
  };
}

let interactionId = 0;
function commandInteraction(action, { userId = 'p1', game = 'chess', messageId = 'board-message', fetchError = null } = {}) {
  const output = { replies: [], followUps: [], edits: [] };
  return {
    id: `command-${++interactionId}`,
    guildId: 'guild',
    channelId: 'channel',
    user: { id: userId },
    options: {
      getSubcommand: () => action,
      getString: (name) => name === 'game' ? game : null,
    },
    replied: false,
    deferred: false,
    async reply(payload) { this.replied = true; output.replies.push(payload); },
    async fetchReply() {
      if (fetchError) throw fetchError;
      return { id: messageId };
    },
    async followUp(payload) { output.followUps.push(payload); },
    async editReply(payload) { output.edits.push(payload); },
    output,
  };
}

function componentInteraction(customId, { userId, modal = false, fields = {}, messageId = 'board-message' } = {}) {
  const output = { modal: null, followUps: [], edits: [] };
  return {
    id: `component-${++interactionId}`,
    customId,
    guildId: 'guild',
    channelId: 'channel',
    message: { id: messageId },
    user: { id: userId },
    fields: { getTextInputValue: (name) => fields[name] || '' },
    replied: false,
    deferred: false,
    isButton: () => !modal,
    isModalSubmit: () => modal,
    async showModal(value) { output.modal = value; this.replied = true; },
    async deferUpdate() { this.deferred = true; },
    async deferReply() { this.deferred = true; },
    async followUp(payload) { output.followUps.push(payload); },
    async editReply(payload) { output.edits.push(payload); },
    async reply(payload) { this.replied = true; output.followUps.push(payload); },
    output,
  };
}

function latestCustomId(transport, label) {
  const payload = transport.state.updates.at(-1).payload;
  return payload.components.flatMap((row) => row.components).find((component) => component.label === label).customId;
}

function createHarness(options = {}) {
  const store = options.store || recoverableStore();
  const transport = options.transport || fakeTransport();
  let generatedId = 0;
  const runtime = createBoardDiscordRuntime({
    store,
    transport,
    isGuildApproved: () => true,
    isBotOwner: () => false,
    idFactory: () => `runtime-${++generatedId}`,
    seedFactory: () => `seed-${generatedId}`,
    renderPngImpl: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    runtimeLogger: { error() {} },
    ...options,
  });
  return { runtime, store, transport };
}

test('controls expose six games through readable buttons and strict non-JSON parsers', () => {
  assert.equal(getControls('chess').some((control) => control.id === 'claim-draw'), true);
  assert.equal(getControls('go').some((control) => control.id === 'confirm-dead'), true);
  assert.equal(getControls('turtle-soup').every((control) => control.kind === 'modal'), true);
  assert.equal(getModalDefinition('chess', 'move').fields.length, 3);
  assert.deepEqual(parseCheckersPath('q0r0 q1r0 q3r0'), ['q0r0', 'q1r0', 'q3r0']);
  assert.equal(parsePromotion('皇后'), 'q');
  assert.throws(() => parseCheckersPath('["q0r0","q1r0"]'), /路徑/);

  const parsers = createActionParsers();
  const goAction = parsers.go['propose-dead']({
    interaction: { fields: { getTextInputValue: () => 'A1 B2，C3' } },
    publicView: { board: { width: 9, height: 9 } },
  });
  assert.deepEqual(goAction, {
    type: 'propose-dead', coordinates: [{ x: 0, y: 0 }, { x: 1, y: 1 }, { x: 2, y: 2 }],
  });
});

test('synthetic Discord flow starts, binds, joins, begins, opens a move modal, and commits a chess move', async () => {
  const { runtime, store, transport } = createHarness();
  const start = commandInteraction('start');
  const bound = await runtime.executeCommand(start);
  assert.equal(bound.session.messageId, 'board-message');
  assert.equal(bound.session.revision, 1);
  assert.equal(transport.state.updates.length, 1);

  const join = componentInteraction(latestCustomId(transport, '加入'), { userId: 'p2' });
  assert.equal(await runtime.handleInteraction(join), true);
  let session = await store.getActiveSession({ guildId: 'guild', channelId: 'channel' });
  assert.equal(session.players.length, 2);

  const begin = componentInteraction(latestCustomId(transport, '開始遊戲'), { userId: 'p1' });
  await runtime.handleInteraction(begin);
  session = await store.getActiveSession({ guildId: 'guild', channelId: 'channel' });
  assert.equal(session.status, 'active');

  const moveCustomId = latestCustomId(transport, '走棋');
  const moveButton = componentInteraction(moveCustomId, { userId: 'p1' });
  await runtime.handleInteraction(moveButton);
  assert(moveButton.output.modal);

  const moveSubmit = componentInteraction(moveCustomId, {
    userId: 'p1', modal: true, fields: { from: 'E2', to: 'E4', promotion: '' },
  });
  await runtime.handleInteraction(moveSubmit);
  session = await store.getActiveSession({ guildId: 'guild', channelId: 'channel' });
  assert.equal(session.state.moveHistory.length, 1);
  assert.deepEqual(session.state.moveHistory[0], { from: 'e2', to: 'e4' });
  assert.equal(moveSubmit.output.edits.at(-1).content, '棋盤已更新。');
});

test('unapproved guilds are denied before public command or component mutation', async () => {
  const harness = createHarness({ isGuildApproved: () => false });
  const start = commandInteraction('start');
  const result = await harness.runtime.executeCommand(start);
  assert.equal(result.code, 'GUILD_NOT_APPROVED');
  assert.equal((await harness.store.getActiveSession({ guildId: 'guild', channelId: 'channel' })), null);
  assert.match(start.output.replies[0].content, /尚未通過/);
});

test('missing turtle corpus fails closed without blocking another game', async () => {
  const { runtime, store } = createHarness();
  const turtle = commandInteraction('start', { game: 'turtle-soup' });
  const turtleResult = await runtime.executeCommand(turtle);
  assert.equal(turtleResult.code, 'CORPUS_UNAVAILABLE');
  assert.equal(await store.getActiveSession({ guildId: 'guild', channelId: 'channel' }), null);

  const chessStart = commandInteraction('start', { game: 'chess' });
  const chessResult = await runtime.executeCommand(chessStart);
  assert.equal(chessResult.session.gameKey, 'chess');
});

test('same-channel deleted-message recovery uses the core CAS rebind without changing scope', async () => {
  const transport = fakeTransport();
  transport.state.missing = true;
  const { runtime, store } = createHarness({ transport });
  await runtime.executeCommand(commandInteraction('start'));
  const status = commandInteraction('status');
  const recovered = await runtime.executeCommand(status);
  assert.equal(recovered.session.messageId, 'replacement-1');
  assert.deepEqual(transport.state.replacements[0], { id: 'replacement-1', guildId: 'guild', channelId: 'channel' });
  assert.equal((await store.getActiveSession({ guildId: 'guild', channelId: 'channel' })).messageId, 'replacement-1');
  assert.equal(store.snapshot().actions.at(-1).action.type, 'rebind-message');
});

test('failed reply fetch atomically aborts only the unbound lobby and permits an immediate retry', async () => {
  const { runtime, store } = createHarness();
  const failed = commandInteraction('start', { fetchError: new Error('synthetic fetch failure') });
  const failedResult = await runtime.executeCommand(failed);
  assert.equal(failedResult.ok, false);
  assert.equal(await store.getActiveSession({ guildId: 'guild', channelId: 'channel' }), null);
  const aborted = store.snapshot().sessions[0];
  assert.equal(aborted.status, 'expired');
  assert.equal(aborted.messageId, null);
  assert.equal(aborted.endReason, 'message-bind-failed');
  assert.equal(runtime.lifecycle.trackedCount(), 0);

  const retried = await runtime.executeCommand(commandInteraction('start', { messageId: 'retry-message' }));
  assert.equal(retried.session.messageId, 'retry-message');
  assert.equal(retried.session.status, 'lobby');
  assert.equal((await store.getActiveSession({ guildId: 'guild', channelId: 'channel' })).id, retried.session.id);

  const lateAbort = await runtime.service.abortUnboundLobby({
    sessionId: retried.session.id,
    guildId: 'guild',
    channelId: 'channel',
    hostId: 'p1',
  });
  assert.equal(lateAbort, null);
  assert.equal((await store.getActiveSession({ guildId: 'guild', channelId: 'channel' })).messageId, 'retry-message');
});

test('lifecycle is idempotent, recovers sessions, expires tracked lobbies, and cleans its timer', async () => {
  let now = new Date('2026-09-23T00:00:00.000Z');
  const { runtime, store } = createHarness({
    clock: () => new Date(now),
    lifecycleIntervalMs: 60_000,
  });
  await runtime.executeCommand(commandInteraction('start'));
  const first = await runtime.startLifecycle();
  const second = await runtime.startLifecycle();
  assert.equal(first.started, true);
  assert.equal(second.started, false);
  now = new Date('2026-09-23T00:10:00.001Z');
  await runtime.lifecycle.tick();
  const session = store.snapshot().sessions[0];
  assert.equal(session.status, 'expired');
  assert.equal(session.endReason, 'lobby-timeout');
  await runtime.stopLifecycle();
  assert.equal(runtime.lifecycle.isStarted(), false);
  assert.equal(runtime.lifecycle.trackedCount(), 0);
});
