const assert = require('node:assert/strict');
const test = require('node:test');
const initSqlJs = require('sql.js');
const { BoardCoreError, BoardRuleError } = require('../src/systems/games/board/core/contracts');
const { BoardEngineRegistry } = require('../src/systems/games/board/core/engineRegistry');
const { BoardSessionService } = require('../src/systems/games/board/core/boardSessionService');
const { buildBoardCustomId } = require('../src/systems/games/board/discord/boardCustomId');
const { createBoardDiscordRuntime } = require('../src/systems/games/board/discord/boardDiscordRuntime');
const { buildBoardComponents } = require('../src/systems/games/board/discord/boardPresenter');
const engine = require('../src/systems/games/board/engines/werewolf');
const turtleSoup = require('../src/systems/games/board/engines/turtleSoup');
const { BOARD_SCHEMA_SQL, installBoardSchema } = require('../src/systems/games/board/storage/boardSchema');
const { FALLBACK_NOTICE, createWerewolfNarrator } = require('../src/systems/games/board/werewolf/werewolfNarrator');
const { createPhaseTimers } = require('../src/systems/games/board/werewolf/werewolfTimers');
const { buildActionMenu } = require('../src/systems/games/board/werewolf/werewolfInteractions');
const { InMemoryBoardStore } = require('./support/inMemoryBoardStore');

const SCOPE = Object.freeze({ guildId: 'guild-1', channelId: 'channel-1' });
const ROLE_WORDS = /（(?:狼人|預言家|女巫|獵人|守衛|平民)）/u;

function recoverableStore() {
  const store = new InMemoryBoardStore();
  store.listRecoverable = async ({ now, limit }) => store.snapshot().sessions
    .filter((session) => ['lobby', 'active'].includes(session.status) && session.expiresAt > now)
    .slice(0, limit);
  return store;
}

function fakeTransport({ threads = true } = {}) {
  const transport = {
    updates: [],
    posts: [],
    threads: [],
    async update(value) { transport.updates.push(value); },
    async messageExists() { return true; },
    async ensureThread(value) {
      if (!threads) throw Object.assign(new Error('Missing Permissions'), { code: 50013 });
      transport.threads.push(value);
      return { id: 'thread-1' };
    },
    async post(value) { transport.posts.push(value); return { id: `post-${transport.posts.length}` }; },
  };
  return transport;
}

let nextId = 0;
function interaction({ verb, revision = 0, sessionId, actorId, values = null, select = false }) {
  const output = { edits: [], replies: [], followUps: [] };
  return {
    id: `interaction-${++nextId}`,
    customId: buildBoardCustomId({ sessionId, revision, verb }),
    ...SCOPE,
    message: { id: select ? 'ephemeral-message' : 'board-message-1' },
    user: { id: actorId },
    values: values || [],
    deferred: false,
    replied: false,
    isButton: () => !select,
    isStringSelectMenu: () => select,
    isModalSubmit: () => false,
    async deferReply() { this.deferred = true; },
    async deferUpdate() { this.deferred = true; },
    async editReply(payload) { output.edits.push(payload); },
    async reply(payload) { this.replied = true; output.replies.push(payload); },
    async followUp(payload) { output.followUps.push(payload); },
    output,
  };
}

function lastText(target) {
  const { edits, followUps, replies } = target.output;
  return String(edits.at(-1)?.content || followUps.at(-1)?.content || replies.at(-1)?.content || '');
}

function components(target) {
  return (target.output.edits.at(-1)?.components || []).map((row) => row.toJSON().components).flat();
}

function createRuntime({ transport = fakeTransport(), store = recoverableStore() } = {}) {
  const clock = { now: Date.parse('2026-11-13T00:00:00.000Z') };
  const logs = [];
  const runtime = createBoardDiscordRuntime({
    store,
    transport,
    scenarioProviderReadiness: { ready: false, code: 'CORPUS_NOT_CONFIGURED', scenarioCount: 0 },
    judgeProvider: { async judge() { throw new Error('unused'); } },
    idFactory: () => 'ww-session',
    seedFactory: () => 'ww-seed',
    clock: () => new Date(clock.now),
    renderPngImpl: async () => Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]),
    runtimeLogger: { error(...values) { logs.push(values); }, warn() {}, info() {} },
  });
  return { runtime, transport, store, clock, logs };
}

async function openLobby(runtime, count = 6) {
  const command = {
    id: `command-${++nextId}`,
    ...SCOPE,
    user: { id: 'p1' },
    options: { getSubcommand: () => 'start', getString: () => 'werewolf' },
    deferred: false,
    replied: false,
    async deferReply() { this.deferred = true; },
    async editReply() {},
    async reply() { this.replied = true; },
    async followUp() {},
    async fetchReply() { return { id: 'board-message-1' }; },
  };
  await runtime.executeCommand(command);
  for (let index = 2; index <= count; index += 1) {
    const current = await runtime.service.status({ ...SCOPE, actorId: 'p1' });
    await runtime.service.join({
      ...SCOPE, actorId: `p${index}`, expectedRevision: current.session.revision, interactionId: `join-${index}-${++nextId}`,
    });
  }
  return runtime.store.getSessionById('ww-session');
}

async function begin(runtime) {
  const current = await runtime.service.status({ ...SCOPE, actorId: 'p1' });
  return runtime.service.begin({ ...SCOPE, actorId: 'p1', expectedRevision: current.session.revision, interactionId: `begin-${++nextId}` });
}

test('the lobby panel offers the host settings and only the host can change them', async (t) => {
  const { runtime, transport, store } = createRuntime();
  t.after(() => runtime.stopLifecycle());
  await openLobby(runtime, 6);
  const lobbyPanel = transport.updates.at(-1).payload;
  const labels = lobbyPanel.components.flatMap((row) => row.components.map((entry) => entry.label));
  assert.ok(labels.includes('節奏：慢速'));
  assert.ok(labels.includes('勝利：屠邊'));
  assert.ok(labels.includes('出局不公開身分'));
  assert.ok(labels.includes('角色設定'));
  assert.match(lobbyPanel.embeds[0].description, /2 狼、預言家、女巫、2 平民/u);

  const pace = interaction({ verb: 'ww.pace', sessionId: 'ww-session', actorId: 'p1' });
  await runtime.handleInteraction(pace);
  assert.match(lastText(pace), /節奏改為 標準/u);
  const win = interaction({ verb: 'ww.win', sessionId: 'ww-session', actorId: 'p1' });
  await runtime.handleInteraction(win);
  const reveal = interaction({ verb: 'ww.reveal', sessionId: 'ww-session', actorId: 'p1' });
  await runtime.handleInteraction(reveal);
  assert.deepEqual((await store.getSessionById('ww-session')).rules, { pace: 'standard', win: 'city', reveal: true, roles: null });

  const intruder = interaction({ verb: 'ww.pace', sessionId: 'ww-session', actorId: 'p2' });
  await runtime.handleInteraction(intruder);
  assert.match(lastText(intruder), /只有房主/u);

  const roles = interaction({ verb: 'ww.roles', sessionId: 'ww-session', actorId: 'p1' });
  await runtime.handleInteraction(roles);
  assert.deepEqual(components(roles).map((entry) => entry.custom_id.split('|')[4]), ['ww.cfg-wolves', 'ww.cfg-gods', 'ww.cfg-auto']);
  const wolves = interaction({ verb: 'ww.cfg-wolves', sessionId: 'ww-session', actorId: 'p1', values: ['1'], select: true });
  await runtime.handleInteraction(wolves);
  const gods = interaction({ verb: 'ww.cfg-gods', sessionId: 'ww-session', actorId: 'p1', values: ['seer', 'guard'], select: true });
  await runtime.handleInteraction(gods);
  assert.deepEqual((await store.getSessionById('ww-session')).rules.roles, { wolves: 1, gods: ['seer', 'guard'] });
  assert.match(lastText(gods), /1 狼、預言家、守衛、3 平民/u);
  const auto = interaction({ verb: 'ww.cfg-auto', sessionId: 'ww-session', actorId: 'p1', select: false });
  await runtime.handleInteraction(auto);
  assert.equal((await store.getSessionById('ww-session')).rules.roles, null);
});

test('a running table hosts the game in a thread and keeps every role private', async (t) => {
  const { runtime, transport, store, clock } = createRuntime();
  t.after(() => runtime.stopLifecycle());
  await openLobby(runtime, 6);
  await begin(runtime);
  const session = await store.getSessionById('ww-session');
  assert.equal(session.status, 'active');
  assert.equal(transport.threads.length, 1);
  assert.equal(transport.posts[0].threadId, 'thread-1');
  assert.match(transport.posts[0].content, /狼人殺開始/u);
  assert.deepEqual(transport.posts[0].mentionUserIds, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']);
  assert.match(transport.posts[1].content, /第 1 夜/u);
  assert.equal(runtime.phaseTimers.size(), 1);

  const roleOf = (id) => session.state.players.find((entry) => entry.id === id).role;
  const wolf = session.state.players.find((entry) => entry.role === 'wolf').id;
  const villager = session.state.players.find((entry) => entry.role === 'villager').id;

  const card = interaction({ verb: 'act.role', sessionId: 'ww-session', actorId: wolf });
  await runtime.handleInteraction(card);
  assert.match(lastText(card), /身分：\*\*狼人\*\*/u);
  assert.match(lastText(card), /狼隊友/u);
  assert.equal(roleOf(wolf), 'wolf');

  const menu = interaction({ verb: 'act.action', sessionId: 'ww-session', actorId: wolf });
  await runtime.handleInteraction(menu);
  const kill = components(menu).find((entry) => entry.custom_id.endsWith('|ww.kill'));
  assert.ok(kill);
  assert.equal(kill.custom_id.split('|')[3], String(session.state.phaseSerial));

  const choose = interaction({ verb: 'ww.kill', revision: session.state.phaseSerial, sessionId: 'ww-session', actorId: wolf, values: [villager], select: true });
  await runtime.handleInteraction(choose);
  assert.match(lastText(choose), /你選擇殺害/u);
  assert.equal((await store.getSessionById('ww-session')).state.night.wolfVotes[wolf], villager);

  const stale = interaction({ verb: 'ww.kill', revision: 0, sessionId: 'ww-session', actorId: wolf, values: [villager], select: true });
  await runtime.handleInteraction(stale);
  assert.match(lastText(stale), /選單已經過期/u);

  const quiet = interaction({ verb: 'act.action', sessionId: 'ww-session', actorId: villager });
  await runtime.handleInteraction(quiet);
  assert.match(lastText(quiet), /夜晚沒有你需要做的事/u);
  assert.equal(components(quiet).length, 0);

  const stranger = interaction({ verb: 'act.role', sessionId: 'ww-session', actorId: 'outsider' });
  await runtime.handleInteraction(stranger);
  assert.match(lastText(stranger), /只有目前棋局的參與者/u);

  // The phase timer's job, done by hand: the night ends, the witch's turn comes, then the day.
  clock.now = Date.parse((await store.getSessionById('ww-session')).state.deadline) + 1;
  assert.ok(await runtime.service.advanceDue({ sessionId: 'ww-session' }));
  clock.now = Date.parse((await store.getSessionById('ww-session')).state.deadline) + 1;
  await runtime.service.advanceDue({ sessionId: 'ww-session' });
  assert.equal((await store.getSessionById('ww-session')).state.phase, 'day');
  assert.ok(transport.posts.some((entry) => /天亮了/u.test(entry.content)));
  assert.equal(await runtime.service.advanceDue({ sessionId: 'ww-session' }), null);

  // Nothing public names a living player's role.
  for (const update of transport.updates) assert.equal(ROLE_WORDS.test(JSON.stringify(update.payload.embeds)), false);
  for (const post of transport.posts) {
    if (!/身分揭曉/u.test(post.content)) assert.equal(ROLE_WORDS.test(post.content), false);
  }
  const living = (await store.getSessionById('ww-session')).state.players.find((entry) => entry.alive && entry.id !== 'p1').id;
  const ready = interaction({ verb: 'act.ready', sessionId: 'ww-session', actorId: living });
  await runtime.handleInteraction(ready);
  assert.match(lastText(ready), /你已準備投票（1／/u);
  const early = interaction({ verb: 'act.start-vote', sessionId: 'ww-session', actorId: living });
  await runtime.handleInteraction(early);
  assert.match(lastText(early), /只有房主/u);
});

test('the host can end a running table as a draw and the host role passes on when the host leaves', async (t) => {
  const { runtime, store } = createRuntime();
  t.after(() => runtime.stopLifecycle());
  await openLobby(runtime, 6);
  await begin(runtime);
  let current = await runtime.service.status({ ...SCOPE, actorId: 'p1' });
  await runtime.service.leave({ ...SCOPE, actorId: 'p1', expectedRevision: current.session.revision, interactionId: `leave-${++nextId}` });
  let session = await store.getSessionById('ww-session');
  assert.equal(session.hostId, 'p2');
  assert.equal(session.state.players[0].alive, false);
  current = await runtime.service.status({ ...SCOPE, actorId: 'p2' });
  await assert.rejects(
    runtime.service.stop({ ...SCOPE, actorId: 'p3', expectedRevision: current.session.revision, interactionId: `stop-${++nextId}` }),
    (error) => error.code === 'HOST_ONLY'
  );
  const stopped = await runtime.service.stop({ ...SCOPE, actorId: 'p2', expectedRevision: current.session.revision, interactionId: `stop-${++nextId}` });
  assert.equal(stopped.session.status, 'completed');
  assert.equal(stopped.session.outcome.reason, 'host-ended');
  session = await store.getSessionById('ww-session');
  assert.equal(session.state.phase, 'ended');
  assert.equal(runtime.phaseTimers.size(), 0);
});

test('a table that cannot be dealt says so, and other games keep their fixed settings', async () => {
  const store = new InMemoryBoardStore();
  let id = 0;
  const service = new BoardSessionService({
    store,
    registry: new BoardEngineRegistry([engine, turtleSoup]),
    clock: () => new Date('2026-11-13T00:00:00.000Z'),
    idFactory: () => `session-${++id}`,
    seedFactory: () => `seed-${id}`,
  });
  const started = await service.start({ ...SCOPE, hostId: 'p1', gameKey: 'werewolf', interactionId: 'start-1' });
  let revision = started.session.revision;
  for (let index = 2; index <= 6; index += 1) {
    revision = (await service.join({ ...SCOPE, actorId: `p${index}`, expectedRevision: revision, interactionId: `join-${index}` })).session.revision;
  }
  await assert.rejects(
    service.configure({ ...SCOPE, actorId: 'p1', expectedRevision: revision, interactionId: 'bad-key', rules: { scenarioId: 'x' } }),
    (error) => error instanceof BoardCoreError && error.code === 'ACTION_NOT_AVAILABLE'
  );
  revision = (await service.configure({
    ...SCOPE, actorId: 'p1', expectedRevision: revision, interactionId: 'roles', rules: { roles: { wolves: 3, gods: [] } },
  })).session.revision;
  await assert.rejects(
    service.begin({ ...SCOPE, actorId: 'p1', expectedRevision: revision, interactionId: 'begin-1' }),
    (error) => error instanceof BoardRuleError && error.code === 'INVALID_SETUP'
  );

  const soup = await service.start({ guildId: 'guild-1', channelId: 'channel-2', hostId: 'p1', gameKey: 'turtle-soup', interactionId: 'soup', options: { scenarioId: 'a', scenarioVersion: 1 } });
  await assert.rejects(
    service.configure({ guildId: 'guild-1', channelId: 'channel-2', actorId: 'p1', expectedRevision: soup.session.revision, interactionId: 'soup-cfg', rules: { scenarioId: 'b' } }),
    (error) => error.code === 'ACTION_NOT_AVAILABLE'
  );
});

test('the lobby panel rejects a control that is not a werewolf lobby setting', () => {
  const result = {
    session: { id: 'ww-session', status: 'lobby', revision: 3, gameKey: 'werewolf' },
    lobbyControls: [{ verb: 'ww.pace', label: '節奏：慢速' }],
  };
  const rows = buildBoardComponents(result);
  assert.equal(rows.flatMap((row) => row.components).length, 5);
  assert.throws(() => buildBoardComponents({ ...result, lobbyControls: [{ verb: 'act.resign', label: 'x' }] }),
    (error) => error.code === 'INVALID_PUBLIC_VIEW');
});

test('the narrator posts each announcement once, in order, and falls back to the channel without a thread', async () => {
  const transport = fakeTransport();
  const now = Date.parse('2026-11-13T00:10:00.000Z');
  const narrator = createWerewolfNarrator({ transport, clock: () => new Date(now), logger: null });
  const session = {
    id: 's1', ...SCOPE, gameKey: 'werewolf', status: 'active', messageId: 'm1',
    state: { log: [
      { seq: 1, at: '2026-11-13T00:09:00.000Z', text: 'one', ping: ['p1'] },
      { seq: 2, at: '2026-11-13T00:09:30.000Z', text: 'two' },
    ] },
  };
  assert.equal(await narrator.sync(session), 2);
  assert.equal(await narrator.sync(session), 0);
  session.state.log.push({ seq: 3, at: '2026-11-13T00:09:50.000Z', text: 'three' });
  assert.equal(await narrator.sync(session), 1);
  assert.deepEqual(transport.posts.map((entry) => [entry.content, entry.threadId]), [['one', 'thread-1'], ['two', 'thread-1'], ['three', 'thread-1']]);
  assert.deepEqual(transport.posts[0].mentionUserIds, ['p1']);

  // After a restart the cursor is unknown: only the last two minutes are posted again.
  const restarted = createWerewolfNarrator({ transport: fakeTransport({ threads: false }), clock: () => new Date(now), logger: null });
  const old = { ...session, id: 's2', state: { log: [
    { seq: 1, at: '2026-11-13T00:01:00.000Z', text: 'old' },
    { seq: 2, at: '2026-11-13T00:09:59.000Z', text: 'new' },
  ] } };
  const fallback = fakeTransport({ threads: false });
  const narratorWithoutThreads = createWerewolfNarrator({ transport: fallback, clock: () => new Date(now), logger: null });
  await narratorWithoutThreads.sync(old);
  assert.deepEqual(fallback.posts.map((entry) => [entry.content, entry.threadId ?? null]), [[FALLBACK_NOTICE, null], ['new', null]]);
  assert.equal(await restarted.sync({ ...old, messageId: null }), 0);
});

test('phase timers keep one timer per table and call the service when it fires', async () => {
  const scheduled = [];
  const advanced = [];
  const timers = createPhaseTimers({
    advance: async (sessionId) => { advanced.push(sessionId); },
    clock: () => new Date('2026-11-13T00:00:00.000Z'),
    setTimer: (fn, delay) => { const handle = { fn, delay, cleared: false }; scheduled.push(handle); return handle; },
    clearTimer: (handle) => { handle.cleared = true; },
    logger: null,
  });
  assert.equal(timers.schedule('s1', '2026-11-13T00:01:00.000Z'), true);
  assert.equal(scheduled[0].delay, 60_750);
  timers.schedule('s1', '2026-11-13T00:01:00.000Z');
  assert.equal(scheduled.length, 1);
  timers.schedule('s1', '2026-11-13T00:02:00.000Z');
  assert.equal(scheduled[0].cleared, true);
  assert.equal(timers.size(), 1);
  scheduled[1].fn();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(advanced, ['s1']);
  assert.equal(timers.size(), 0);
  timers.schedule('s2', null);
  assert.equal(timers.size(), 0);
});

test('the private menu shows only what the viewer may do, with the phase in each control id', () => {
  const players = Array.from({ length: 6 }, (_, index) => `p${index + 1}`);
  const state = engine.createInitialState({ players, rules: engine.normalizeOptions({}), seed: 'menu-seed', now: '2026-11-13T00:00:00.000Z' });
  const names = new Map(players.map((id) => [id, `玩家${id}`]));
  const seats = players.map((id, index) => ({ id, seat: index + 1 }));
  const seer = state.players.find((entry) => entry.role === 'seer');
  const view = { ...engine.getPrivateView(state, seer.id), selfId: seer.id };
  const menu = buildActionMenu({ sessionId: 's1', view, names, seats });
  assert.equal(menu.rows.length, 1);
  assert.equal(menu.rows[0].customId, `board|1|s1|${state.phaseSerial}|ww.check`);
  assert.equal(menu.rows[0].options.some((option) => option.value === seer.id), false);
  const villager = state.players.find((entry) => entry.role === 'villager');
  assert.equal(buildActionMenu({ sessionId: 's1', view: { ...engine.getPrivateView(state, villager.id), selfId: villager.id }, names, seats }).rows.length, 0);
});

test('an existing board database is rebuilt once to accept werewolf, keeping every row and link', async () => {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  db.run('PRAGMA foreign_keys = ON');
  const api = {
    run: (sql, params) => (params ? db.run(sql, params) : db.run(sql)),
    get: (sql, params = []) => {
      const statement = db.prepare(sql);
      try {
        statement.bind(params);
        return statement.step() ? statement.getAsObject() : null;
      } finally {
        statement.free();
      }
    },
  };
  api.run(BOARD_SCHEMA_SQL.replace(", 'werewolf'", ''));
  const insertSession = (id, gameKey) => api.run(
    `INSERT INTO board_sessions (id, guild_id, channel_id, game_key, rules_version, status, host_id, players_json, rules_json, seed,
      created_at, updated_at, last_progress_at, expires_at) VALUES (?, 'g', ?, ?, '1', 'completed', 'h', '[]', '{}', 's', 't', 't', 't', 't')`,
    [id, id, gameKey]
  );
  insertSession('old-chess', 'chess');
  api.run("INSERT INTO board_actions (session_id, revision, interaction_id, action_json, events_json, created_at) VALUES ('old-chess', 1, 'i1', '{}', '[]', 't')");
  api.run("INSERT INTO board_interactions (interaction_id, request_digest, session_id, session_revision, session_snapshot_json, events_json, created_at) VALUES ('i1', 'd', 'old-chess', 1, '{}', '[]', 't')");
  assert.throws(() => insertSession('too-early', 'werewolf'), /CHECK/u);

  installBoardSchema(api);
  installBoardSchema(api);
  insertSession('new-werewolf', 'werewolf');
  assert.equal(api.get('SELECT COUNT(*) AS count FROM board_actions').count, 1);
  assert.equal(api.get('SELECT COUNT(*) AS count FROM board_interactions').count, 1);
  const indexes = db.exec("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_board_%' ORDER BY name")[0].values.flat();
  assert.deepEqual(indexes, [
    'idx_board_actions_interaction', 'idx_board_interactions_session', 'idx_board_sessions_active_channel', 'idx_board_sessions_recovery',
  ]);
  assert.equal(db.exec("SELECT name FROM sqlite_master WHERE name LIKE '%_rebuild'").length, 0);
  api.run("DELETE FROM board_sessions WHERE id = 'old-chess'");
  assert.equal(api.get('SELECT COUNT(*) AS count FROM board_actions').count, 0);
  assert.equal(api.get('SELECT COUNT(*) AS count FROM board_interactions').count, 0);
  db.close();
});
