const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const initSqlJs = require('sql.js');

const { BoardEngineRegistry } = require('../src/games/engineRegistry');
const { BoardSessionService } = require('../src/games/boardSessionService');
const { installBoardSchema } = require('../src/games/storage/boardSchema');
const { createSqliteBoardStore } = require('../src/games/storage/sqliteBoardStore');
const { createMockBoardEngine } = require('./support/mockBoardEngine');

function getRows(db, sql, params = []) {
  const statement = db.prepare(sql);
  try {
    if (params.length) statement.bind(params);
    const rows = [];
    while (statement.step()) rows.push(statement.getAsObject());
    return rows;
  } finally {
    statement.free();
  }
}

function buildApi(db) {
  return {
    db,
    all: (sql, params = []) => getRows(db, sql, params),
    get: (sql, params = []) => getRows(db, sql, params)[0] || null,
    run: (sql, params = []) => params.length ? db.run(sql, params) : db.run(sql),
  };
}

class SyntheticSqliteAuthority {
  constructor(db) {
    this.db = db;
    this.queue = Promise.resolve();
  }

  _enqueue(work) {
    const result = this.queue.then(work, work);
    this.queue = result.catch(() => {});
    return result;
  }

  withDatabase(work) {
    return this._enqueue(() => work(buildApi(this.db)));
  }

  withTransaction(work) {
    return this._enqueue(() => {
      this.db.run('BEGIN IMMEDIATE');
      try {
        const result = work(buildApi(this.db));
        if (result && typeof result.then === 'function') throw new Error('Synthetic transaction callback unexpectedly returned a Promise.');
        this.db.run('COMMIT');
        return result;
      } catch (error) {
        this.db.run('ROLLBACK');
        throw error;
      }
    });
  }

  export() {
    return Buffer.from(this.db.export());
  }
}

let SQL;

test.before(async () => {
  const directory = path.dirname(require.resolve('sql.js'));
  SQL = await initSqlJs({ locateFile: (name) => path.join(directory, name) });
});

function createAuthority(bytes = null, { install = true } = {}) {
  const authority = new SyntheticSqliteAuthority(bytes ? new SQL.Database(bytes) : new SQL.Database());
  authority.db.run('PRAGMA foreign_keys = ON');
  if (!bytes && install) installBoardSchema(buildApi(authority.db));
  return authority;
}

function createService(authority, suffix = '') {
  let counter = 0;
  const store = createSqliteBoardStore({
    withDatabase: authority.withDatabase.bind(authority),
    withTransaction: authority.withTransaction.bind(authority),
  });
  const registry = new BoardEngineRegistry([createMockBoardEngine()]);
  const service = new BoardSessionService({
    store,
    registry,
    clock: () => new Date('2026-09-22T00:00:00.000Z'),
    idFactory: () => `sql-session-${suffix}-${++counter}`,
    seedFactory: () => `sql-seed-${suffix}-${counter}`,
  });
  return { service, store, registry };
}

async function createActive(service) {
  const lobby = await service.start({ guildId: 'g', channelId: 'c', hostId: 'p1', gameKey: 'chess', options: { target: 9 }, interactionId: 'sql-start' });
  const joined = await service.join({ guildId: 'g', channelId: 'c', actorId: 'p2', expectedRevision: lobby.session.revision, interactionId: 'sql-join' });
  const begun = await service.begin({ guildId: 'g', channelId: 'c', actorId: 'p1', expectedRevision: joined.session.revision, interactionId: 'sql-begin' });
  return service.bindMessage({ guildId: 'g', channelId: 'c', actorId: 'p1', messageId: 'm', expectedRevision: begun.session.revision, interactionId: 'sql-bind' });
}

test('board schema creates isolated tables, partial active uniqueness, and foreign keys', () => {
  const authority = createAuthority();
  const api = buildApi(authority.db);
  const tables = api.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'board_%' ORDER BY name").map((row) => row.name);
  assert.deepEqual(tables, ['board_actions', 'board_interactions', 'board_sessions']);
  const index = api.get("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_board_sessions_active_channel'");
  assert.match(index.sql, /WHERE status IN \('lobby', 'active'\)/);
  assert.equal(api.all('PRAGMA foreign_key_check').length, 0);
  assert.equal(api.get("SELECT COUNT(*) AS count FROM sqlite_master WHERE name IN ('game_sessions','game_actions')").count, 0);
});

test('SQLite store installs its isolated schema through the injected authority on first use', async () => {
  const authority = createAuthority(null, { install: false });
  const { store } = createService(authority, 'bootstrap');
  assert.deepEqual(await store.listRecoverable({ now: '2026-09-22T00:00:00.000Z' }), []);
  const tables = await authority.withDatabase((api) => api.all(
    "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'board_%' ORDER BY name"
  ).map((row) => row.name));
  assert.deepEqual(tables, ['board_actions', 'board_interactions', 'board_sessions']);
});

test('SQLite store commits moves, deduplicates interactions, and survives byte-for-byte restart', async () => {
  const authority = createAuthority();
  const first = createService(authority, 'first');
  const active = await createActive(first.service);
  const input = {
    guildId: 'g', channelId: 'c', messageId: 'm', actorId: 'p1',
    expectedRevision: active.session.revision, interactionId: 'sql-move', action: { type: 'move', amount: 1 },
  };
  const moved = await first.service.submitAction(input);
  assert.equal(moved.game.value, 1);
  const counts = await authority.withDatabase((api) => ({
    sessions: Number(api.get('SELECT COUNT(*) AS count FROM board_sessions').count),
    actions: Number(api.get('SELECT COUNT(*) AS count FROM board_actions').count),
    interactions: Number(api.get('SELECT COUNT(*) AS count FROM board_interactions').count),
  }));
  assert.deepEqual(counts, { sessions: 1, actions: 4, interactions: 5 });
  const bytes = authority.export();

  const reopenedAuthority = createAuthority(bytes);
  const reopened = createService(reopenedAuthority, 'reopened');
  const status = await reopened.service.status({ guildId: 'g', channelId: 'c', actorId: 'p2' });
  assert.equal(status.session.id, moved.session.id);
  assert.equal(status.game.value, 1);
  const replay = await reopened.service.submitAction(input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.session.revision, moved.session.revision);
  assert.equal(await reopenedAuthority.withDatabase((api) => Number(api.get("SELECT COUNT(*) AS count FROM board_actions WHERE interaction_id='sql-move'").count)), 1);
  assert.equal(await reopenedAuthority.withDatabase((api) => api.all('PRAGMA foreign_key_check').length), 0);
});

test('SQLite transaction queue and revision CAS allow only one concurrent action', async () => {
  const authority = createAuthority();
  const { service } = createService(authority, 'race');
  const active = await createActive(service);
  const common = {
    guildId: 'g', channelId: 'c', messageId: 'm', actorId: 'p1',
    expectedRevision: active.session.revision, action: { type: 'move', amount: 1 },
  };
  const settled = await Promise.allSettled([
    service.submitAction({ ...common, interactionId: 'race-a' }),
    service.submitAction({ ...common, interactionId: 'race-b' }),
  ]);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((result) => result.status === 'rejected' && result.reason?.code === 'STALE_REVISION').length, 1);
  const stored = await authority.withDatabase((api) => ({
    value: JSON.parse(api.get('SELECT state_json FROM board_sessions').state_json).value,
    moveCount: Number(api.get("SELECT COUNT(*) AS count FROM board_actions WHERE interaction_id IN ('race-a','race-b')").count),
  }));
  assert.deepEqual(stored, { value: 1, moveCount: 1 });
});

test('SQLite message rebind CAS commits exactly once and survives restart', async () => {
  const authority = createAuthority();
  const { service } = createService(authority, 'rebind');
  const active = await createActive(service);
  const common = {
    sessionId: active.session.id,
    guildId: 'g',
    channelId: 'c',
    actorId: 'p1',
    oldMessageId: 'm',
    expectedRevision: active.session.revision,
  };
  const settled = await Promise.allSettled([
    service.rebindMessage({ ...common, newMessageId: 'replacement-a', interactionId: 'rebind-a' }),
    service.rebindMessage({ ...common, newMessageId: 'replacement-b', interactionId: 'rebind-b' }),
  ]);
  const fulfilled = settled.find((result) => result.status === 'fulfilled');
  assert.ok(fulfilled);
  assert.equal(settled.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(settled.filter((result) => result.status === 'rejected' && result.reason?.code === 'STALE_REVISION').length, 1);
  assert.match(fulfilled.value.session.messageId, /^replacement-[ab]$/);

  const actionCount = await authority.withDatabase((api) => Number(api.get(
    "SELECT COUNT(*) AS count FROM board_actions WHERE action_json LIKE '%rebind-message%'"
  ).count));
  assert.equal(actionCount, 1);

  const reopenedAuthority = createAuthority(authority.export());
  const reopened = createService(reopenedAuthority, 'reopened-rebind');
  const restored = await reopened.service.status({ guildId: 'g', channelId: 'c', actorId: 'p2' });
  assert.equal(restored.session.messageId, fulfilled.value.session.messageId);
  assert.equal(restored.session.revision, fulfilled.value.session.revision);
});

test('SQLite store rejects async callbacks and immutable rule changes before commit', async () => {
  const authority = createAuthority();
  const { service, store } = createService(authority, 'contract');
  const active = await createActive(service);
  const request = {
    guildId: 'g', channelId: 'c', expectedRevision: active.session.revision,
    interactionId: 'contract-async', requestDigest: 'digest-async',
  };
  await assert.rejects(
    () => store.mutate(request, async (session) => ({ session })),
    (error) => error?.code === 'ASYNC_TRANSACTION_FORBIDDEN'
  );
  await assert.rejects(
    () => store.mutate(
      { ...request, interactionId: 'contract-rules', requestDigest: 'digest-rules' },
      (session) => ({ session: { ...session, rules: { target: 99 } }, events: [] })
    ),
    (error) => error?.code === 'STORE_CONTRACT_VIOLATION'
  );
  const stored = await store.getSessionById(active.session.id);
  assert.equal(stored.revision, active.session.revision);
  assert.deepEqual(stored.rules, { target: 9 });
});

test('SQLite expiry rejects immutable rule or seed changes and rolls back the whole transaction', async () => {
  const authority = createAuthority();
  const { service, store } = createService(authority, 'expiry-contract');
  const active = await createActive(service);
  const before = await store.getSessionById(active.session.id);
  await assert.rejects(
    () => store.expireActive({
      guildId: 'g',
      channelId: 'c',
      shouldExpire: () => true,
      buildExpired: (session) => ({
        ...session,
        rules: { target: 99 },
        seed: 'changed-seed',
        status: 'expired',
        revision: session.revision + 1,
      }),
    }),
    (error) => error?.code === 'STORE_CONTRACT_VIOLATION'
  );
  const after = await store.getSessionById(active.session.id);
  assert.deepEqual(after, before);
  assert.equal(await authority.withDatabase((api) => Number(api.get(
    "SELECT COUNT(*) AS count FROM board_actions WHERE action_json LIKE '%expired%'"
  ).count)), 0);
});

test('recovery query returns only unexpired lobby or active sessions', async () => {
  const authority = createAuthority();
  const { service, store } = createService(authority, 'recovery');
  const active = await createActive(service);
  const recovered = await store.listRecoverable({ now: '2026-09-22T00:05:00.000Z' });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].id, active.session.id);
  assert.equal(recovered[0].messageId, 'm');
  assert.deepEqual(recovered[0].players.map((player) => player.userId), ['p1', 'p2']);
  assert.equal(recovered[0].revision, active.session.revision);
});
