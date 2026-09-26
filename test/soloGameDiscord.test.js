const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const initSqlJs = require('sql.js');
const { createSoloSessionService, makeRewardKey } = require('../src/systems/games/soloSessionService');
const { buildSoloCustomId, parseSoloCustomId } = require('../src/systems/games/soloCustomId');
const { buildSoloMessagePayload, renderSoloPng } = require('../src/systems/games/soloPresenter');
const { createSoloDiscordRuntime, parseMove, menuPayload } = require('../src/systems/games/soloDiscordRuntime');

const CREATE_TABLES = `
CREATE TABLE discord_game_sessions (id TEXT PRIMARY KEY,user_id TEXT NOT NULL,source_guild_id TEXT NOT NULL,channel_id TEXT,
 message_id TEXT,game_type TEXT NOT NULL,difficulty TEXT,seed TEXT NOT NULL,state_json TEXT NOT NULL,status TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 0,action_count INTEGER NOT NULL DEFAULT 0,score INTEGER NOT NULL DEFAULT 0,
 reward_amount INTEGER NOT NULL DEFAULT 0,expires_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,completed_at TEXT);
CREATE TABLE discord_game_actions (id INTEGER PRIMARY KEY AUTOINCREMENT,session_id TEXT NOT NULL,revision INTEGER NOT NULL,
 interaction_id TEXT NOT NULL UNIQUE,action_hash TEXT NOT NULL,result_json TEXT NOT NULL,created_at TEXT NOT NULL,
 UNIQUE(session_id,revision));
CREATE TABLE discord_game_rewards (session_id TEXT PRIMARY KEY,reward_key TEXT UNIQUE,status TEXT NOT NULL,amount INTEGER NOT NULL,
 receipt_id INTEGER,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE coin_guild_settings (guild_id TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1);
CREATE TABLE fake_reward_receipts (reward_key TEXT PRIMARY KEY,amount INTEGER NOT NULL);
`;

async function harness() {
  const dist = path.dirname(require.resolve('sql.js'));
  const SQL = await initSqlJs({ locateFile: (name) => path.join(dist, name) });
  const db = new SQL.Database();
  db.exec(CREATE_TABLES);
  let queue = Promise.resolve();
  let now = new Date('2026-09-26T00:00:00.000Z');
  let sessionNumber = 0;
  const api = {
    run(sql, params = []) { db.run(sql, params); },
    get(sql, params = []) { const statement = db.prepare(sql); try { statement.bind(params); return statement.step() ? statement.getAsObject() : null; } finally { statement.free(); } },
  };
  const withDatabase = (work) => {
    const result = queue.then(() => work(api));
    queue = result.catch(() => {});
    return result;
  };
  const withTransaction = (work) => withDatabase(async () => {
    db.run('BEGIN IMMEDIATE');
    try { const result = await work(api); db.run('COMMIT'); return result; }
    catch (error) { db.run('ROLLBACK'); throw error; }
  });
  const grantRewardOnceV2WithApi = (sqlApi, input) => {
    const key = makeRewardKey({ sessionId: input.canonicalSourceId.slice('discord:'.length), userId: input.userId });
    const existing = sqlApi.get('SELECT amount FROM fake_reward_receipts WHERE reward_key = ?', [key]);
    if (existing && Number(existing.amount) !== input.amount) throw new Error('reward conflict');
    if (!existing) sqlApi.run('INSERT INTO fake_reward_receipts VALUES (?,?)', [key, input.amount]);
    return { alreadyGranted: Boolean(existing), receipt: { id: 1, rewardKey: key } };
  };
  const makeService = () => createSoloSessionService({ withDatabase, withTransaction, grantRewardOnceV2WithApi,
    clock: () => now, idFactory: () => `session${++sessionNumber}`, seedFactory: () => `seed${sessionNumber}` });
  return { api, db, makeService, setTime: (value) => { now = new Date(value); } };
}

function scope(session, extra = {}) {
  return { sessionId: session.id, actorId: 'owner', guildId: 'guild', channelId: 'channel', messageId: 'message', ...extra };
}

test('Discord solo session rejects wrong owner, scope, message, and stale simultaneous actions; replay pays once', async () => {
  const h = await harness();
  const firstEndpoint = h.makeService();
  const secondEndpoint = h.makeService();
  const created = await firstEndpoint.create({ userId: 'owner', guildId: 'guild', channelId: 'channel', gameType: 'number-match', difficulty: 'easy' });
  await firstEndpoint.bindMessage({ ...scope(created) });
  for (const field of [{ actorId: 'other' }, { guildId: 'other' }, { channelId: 'other' }, { messageId: 'other' }]) {
    await assert.rejects(() => firstEndpoint.get(scope(created, field)), (error) => Boolean(error.code));
  }
  const firstAction = { type: 'pair', first: 0, second: 1 };
  const [one, two] = await Promise.allSettled([
    firstEndpoint.apply({ ...scope(created), expectedRevision: 0, interactionId: 'click1', action: firstAction }),
    secondEndpoint.apply({ ...scope(created), expectedRevision: 0, interactionId: 'click2', action: firstAction }),
  ]);
  assert.equal([one, two].filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal([one, two].filter((result) => result.status === 'rejected')[0].reason.code, 'STALE_REVISION');
  const completed = await secondEndpoint.apply({ ...scope(created), expectedRevision: 1, interactionId: 'click3',
    action: { type: 'pair', first: 0, second: 1 } });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.rewardAmount, 20);
  assert.equal(completed.rewardStatus, 'granted');
  const replay = await firstEndpoint.apply({ ...scope(created), expectedRevision: 1, interactionId: 'click3',
    action: { type: 'pair', first: 0, second: 1 } });
  assert.equal(replay.replayed, true);
  assert.equal(h.api.get('SELECT COUNT(*) AS count FROM fake_reward_receipts').count, 1);
  assert.equal(h.api.get('SELECT COUNT(*) AS count FROM discord_game_rewards').count, 1);
  await assert.rejects(() => firstEndpoint.apply({ ...scope(created), expectedRevision: 0, interactionId: 'click3', action: firstAction }),
    (error) => error.code === 'REPLAY_MISMATCH');
  assert.equal((await secondEndpoint.get(scope(created))).revision, 2);
  h.db.close();
});

test('Discord solo sessions survive a new service instance, permit controlled panel rebind, and persist expiry', async () => {
  const h = await harness();
  const service = h.makeService();
  const created = await service.create({ userId: 'owner', guildId: 'guild', channelId: 'channel', gameType: 'sudoku', difficulty: 'normal' });
  await service.bindMessage(scope(created));
  const reopened = h.makeService();
  assert.equal((await reopened.get(scope(created))).state.solution, undefined);
  const rebound = await reopened.rebindMessage({ ...scope(created), oldMessageId: 'message', newMessageId: 'replacement', expectedRevision: 0 });
  assert.equal(rebound.revision, 1);
  await assert.rejects(() => reopened.get(scope(created)), (error) => error.code === 'MESSAGE_MISMATCH');
  assert.equal((await reopened.get(scope(created, { messageId: 'replacement' }))).messageId, 'replacement');
  h.setTime('2026-09-26T00:30:01.000Z');
  await assert.rejects(() => reopened.apply({ ...scope(created, { messageId: 'replacement' }), expectedRevision: 1,
    interactionId: 'expired-click', action: { type: 'set', row: 0, column: 2, value: 4 } }), (error) => error.code === 'SESSION_EXPIRED');
  assert.equal(h.api.get('SELECT status FROM discord_game_sessions WHERE id = ?', [created.id]).status, 'expired');
  assert.equal(h.api.get('SELECT COUNT(*) AS count FROM discord_game_rewards').count, 0);
  h.db.close();
});

test('repeated panel rebinds change CAS revision without spending real game actions', async () => {
  const h = await harness();
  const service = h.makeService();
  const created = await service.create({ userId: 'owner', guildId: 'guild', channelId: 'channel', gameType: 'sudoku', difficulty: 'hard' });
  await service.bindMessage(scope(created, { messageId: 'panel0' }));
  let messageId = 'panel0';
  let revision = 0;
  for (let index = 1; index <= 501; index += 1) {
    const next = `panel${index}`;
    const rebound = await service.rebindMessage({ sessionId: created.id, actorId: 'owner', guildId: 'guild', channelId: 'channel',
      oldMessageId: messageId, newMessageId: next, expectedRevision: revision });
    messageId = next;
    revision += 1;
    assert.equal(rebound.revision, revision);
    assert.equal(rebound.actionCount, 0);
  }
  const first = await service.apply({ ...scope(created, { messageId }), expectedRevision: revision,
    interactionId: 'after-many-rebinds', action: { type: 'set', row: 0, column: 2, value: 4 } });
  assert.equal(first.revision, 502);
  assert.equal(first.actionCount, 1);
  const rebound = await service.rebindMessage({ sessionId: created.id, actorId: 'owner', guildId: 'guild', channelId: 'channel',
    oldMessageId: messageId, newMessageId: 'panel-after-action', expectedRevision: first.revision });
  assert.equal(rebound.revision, 503);
  assert.equal(rebound.actionCount, 1);
  const second = await service.apply({ ...scope(created, { messageId: 'panel-after-action' }), expectedRevision: rebound.revision,
    interactionId: 'second-action', action: { type: 'set', row: 0, column: 3, value: 6 } });
  assert.equal(second.revision, 504);
  assert.equal(second.actionCount, 2);
  assert.equal(h.api.get('SELECT action_count FROM discord_game_sessions WHERE id = ?', [created.id]).action_count, 2);
  h.api.run('UPDATE discord_game_sessions SET action_count = ? WHERE id = ?', [500, created.id]);
  await assert.rejects(() => service.apply({ ...scope(created, { messageId: 'panel-after-action' }), expectedRevision: second.revision,
    interactionId: 'limit-check', action: { type: 'set', row: 0, column: 5, value: 8 } }),
  (error) => error.code === 'ACTION_LIMIT_REACHED');
  h.db.close();
});

test('disabled source guild retains a completed game with no payout', async () => {
  const h = await harness();
  const service = h.makeService();
  h.api.run('INSERT INTO coin_guild_settings (guild_id,enabled) VALUES (?,0)', ['guild']);
  const created = await service.create({ userId: 'owner', guildId: 'guild', channelId: 'channel', gameType: 'number-match', difficulty: 'easy' });
  await service.bindMessage(scope(created));
  await service.apply({ ...scope(created), expectedRevision: 0, interactionId: 'disabled1', action: { type: 'pair', first: 0, second: 1 } });
  const final = await service.apply({ ...scope(created), expectedRevision: 1, interactionId: 'disabled2', action: { type: 'pair', first: 0, second: 1 } });
  assert.equal(final.status, 'completed');
  assert.equal(final.rewardAmount, 20);
  assert.equal(final.rewardStatus, 'no_reward');
  assert.equal(h.api.get('SELECT COUNT(*) AS count FROM fake_reward_receipts').count, 0);
  assert.equal(h.api.get('SELECT status FROM discord_game_rewards WHERE session_id = ?', [created.id]).status, 'no_reward');
  h.db.close();
});

test('solo custom controls, modalities, and PNG show the same authoritative board without a solution leak', async () => {
  const h = await harness();
  const service = h.makeService();
  const sudoku = await service.create({ userId: 'owner', guildId: 'guild', channelId: 'channel', gameType: 'sudoku', difficulty: 'hard' });
  const id = buildSoloCustomId({ sessionId: sudoku.id, revision: 0, verb: 'move.s' });
  assert.deepEqual(parseSoloCustomId(id), { sessionId: sudoku.id, revision: 0, verb: 'move.s' });
  const payload = buildSoloMessagePayload(sudoku);
  assert.equal(payload.components[0].components[0].custom_id, id);
  assert.equal(renderSoloPng(sudoku).subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(sudoku.state.solution, undefined);
  const fields = { cell: 'C1', value: '4' };
  assert.deepEqual(parseMove({ fields: { getTextInputValue: (key) => fields[key] } }, sudoku), { type: 'set', row: 0, column: 2, value: 4 });
  assert.equal(menuPayload().components[0].components[0].options.length, 9);
  h.db.close();
});

test('failed Discord panel edit leaves committed move available for a later refresh', async () => {
  const h = await harness();
  const service = h.makeService();
  const created = await service.create({ userId: 'owner', guildId: 'guild', channelId: 'channel', gameType: 'number-match', difficulty: 'easy' });
  await service.bindMessage(scope(created));
  const replies = [];
  const client = { channels: { fetch: async () => ({ guildId: 'guild', messages: { fetch: async () => ({ edit: async () => { throw new Error('synthetic edit failure'); } }) } }) } };
  const runtime = createSoloDiscordRuntime({ service, client, renderPng: () => Buffer.from('synthetic'), runtimeLogger: { error() {} },
    isGuildApproved: () => true, isBotOwner: () => false });
  const fields = { first: 'A1', second: 'B1' };
  const interaction = {
    id: 'move-interaction', customId: buildSoloCustomId({ sessionId: created.id, revision: 0, verb: 'move.n' }),
    guildId: 'guild', channelId: 'channel', user: { id: 'owner' }, message: { id: 'message' },
    fields: { getTextInputValue: (name) => fields[name] }, isButton: () => false, isModalSubmit: () => true,
    async deferReply() { this.deferred = true; }, async editReply(value) { replies.push(value); },
  };
  assert.equal(await runtime.handleInteraction(interaction), true);
  assert.match(replies[0].content, /已儲存/);
  assert.equal((await service.get(scope(created))).revision, 1);
  h.db.close();
});

test('game command acknowledges before persistence and rejects an unapproved guild', async () => {
  const calls = [];
  const interaction = {
    guildId: 'guild', channelId: 'channel', user: { id: 'owner' },
    options: { getSubcommand: () => 'play', getString: (name) => name === 'game' ? 'sudoku' : 'easy' },
    async deferReply() { calls.push('ack'); this.deferred = true; },
    async editReply() { calls.push('panel'); },
    async fetchReply() { return { id: 'message' }; },
    async reply(value) { calls.push(value.content); },
  };
  const session = { id: 'session', gameType: 'sudoku', difficulty: 'easy', status: 'active', revision: 0,
    state: { puzzle: Array.from({ length: 9 }, () => Array(9).fill(0)), entries: Array.from({ length: 9 }, () => Array(9).fill(0)) } };
  const service = {
    async create() { calls.push('persist'); return session; },
    async bindMessage() { calls.push('bind'); return session; },
  };
  const runtime = createSoloDiscordRuntime({ service, client: {}, renderPng: () => Buffer.from('synthetic png'),
    isGuildApproved: () => true, isBotOwner: () => false, runtimeLogger: { error() {} } });
  await runtime.executeCommand(interaction);
  assert.deepEqual(calls, ['ack', 'persist', 'panel', 'bind']);
  const denied = createSoloDiscordRuntime({ service, client: {}, isGuildApproved: () => false,
    isBotOwner: () => false, runtimeLogger: { error() {} } });
  calls.length = 0;
  interaction.deferred = false;
  await denied.executeCommand(interaction);
  assert.match(calls[0], /尚未通過/);
  assert.equal(calls.includes('persist'), false);
});
