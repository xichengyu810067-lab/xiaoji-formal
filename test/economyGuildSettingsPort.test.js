const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-economy-port-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const {
  ensureGuildEconomyRowWithApi,
  readGuildEconomyEnabledWithApi,
  setGuildEconomyEnabled,
} = require('../src/services/coinService');
const { grantRewardOnce, grantRewardOnceV2 } = require('../src/services/featurePlatformService');
const {
  claimDailyDiscussionEvent,
  claimDailyDiscussionSettlement,
  getDiscussionWindow,
  settleDailyDiscussion,
} = require('../src/services/dailyDiscussionService');
const {
  claimDailyRiddleEvent,
  claimDailyRiddleSettlement,
  getRiddleWindow,
  settleDailyRiddle,
} = require('../src/services/dailyRiddleService');
const { buildSudoku } = require('../src/systems/games/soloGameRules');
const { createSoloSessionService } = require('../src/systems/games/soloSessionService');

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const squash = (sql) => sql.replace(/\s+/g, ' ').trim();
const settingsRow = (guildId) => withCoinDatabase((api) =>
  api.get('SELECT * FROM coin_guild_settings WHERE guild_id = ?', [guildId]));
const count = (sql, params = []) => withCoinDatabase((api) => api.get(sql, params).count);

// Rows a reward would leave behind for one guild and user.
const rewardFootprint = (guildId, userId) => withCoinDatabase((api) => ({
  grants: api.get('SELECT COUNT(*) AS count FROM reward_grants WHERE guild_id = ? AND user_id = ?', [guildId, userId]).count,
  transactions: api.get('SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = ? AND user_id = ?', [guildId, userId]).count,
  wallets: api.get('SELECT COUNT(*) AS count FROM coin_wallets WHERE user_id = ?', [userId]).count,
}));

// ---------------------------------------------------------------------------------------
// The ports themselves
// ---------------------------------------------------------------------------------------

test('the ports send the moved SQL and parameters to the caller api and never control a transaction', () => {
  const calls = [];
  const api = {
    run: (sql, params) => calls.push({ method: 'run', sql: squash(sql), params }),
    get: (sql, params) => {
      calls.push({ method: 'get', sql: squash(sql), params });
      return { enabled: 0 };
    },
  };

  ensureGuildEconomyRowWithApi(api, 'guild-1', '2026-10-02T01:02:03.000Z');
  assert.equal(readGuildEconomyEnabledWithApi(api, 'guild-1'), 0);

  assert.deepEqual(calls, [
    {
      method: 'run',
      sql: 'INSERT INTO coin_guild_settings (guild_id, created_at, updated_at) VALUES (?, ?, ?) ON CONFLICT(guild_id) DO NOTHING',
      params: ['guild-1', '2026-10-02T01:02:03.000Z', '2026-10-02T01:02:03.000Z'],
    },
    {
      method: 'get',
      sql: 'SELECT enabled FROM coin_guild_settings WHERE guild_id = ?',
      params: ['guild-1'],
    },
  ]);
});

test('a guild without a row reads as undefined; ensuring the row stores the passed time and enables it', async () => {
  const createdAt = '2026-10-01T08:09:10.000Z';
  await withCoinTransaction((api) => {
    assert.equal(readGuildEconomyEnabledWithApi(api, 'port-new'), undefined);
    ensureGuildEconomyRowWithApi(api, 'port-new', createdAt);
    assert.equal(readGuildEconomyEnabledWithApi(api, 'port-new'), 1);
  });

  const row = await settingsRow('port-new');
  assert.equal(row.enabled, 1);
  assert.equal(row.created_at, createdAt);
  assert.equal(row.updated_at, createdAt);
});

test('ensuring an existing row changes nothing, including a disabled switch', async () => {
  await setGuildEconomyEnabled('port-existing', false, { operatorId: 'owner-1' });
  const before = await settingsRow('port-existing');
  assert.equal(before.enabled, 0);

  await withCoinTransaction((api) => {
    ensureGuildEconomyRowWithApi(api, 'port-existing', '2030-01-01T00:00:00.000Z');
    assert.equal(readGuildEconomyEnabledWithApi(api, 'port-existing'), 0);
  });

  assert.deepEqual(await settingsRow('port-existing'), before);
});

test('the ports join the caller transaction, so the caller rolling back removes the row', async () => {
  await assert.rejects(withCoinTransaction((api) => {
    ensureGuildEconomyRowWithApi(api, 'port-rolled-back', '2026-10-01T00:00:00.000Z');
    assert.equal(readGuildEconomyEnabledWithApi(api, 'port-rolled-back'), 1);
    throw new Error('caller aborts');
  }), /caller aborts/);

  assert.equal(await settingsRow('port-rolled-back'), null);
});

// ---------------------------------------------------------------------------------------
// Before and after the move: every column of coin_guild_settings is written the same way
// ---------------------------------------------------------------------------------------

// The inline statements exactly as the call sites carried them before the move (b1acd05).
const LEGACY_INSERTS = {
  'featurePlatformService grantRewardOnceV2WithApi': `INSERT INTO coin_guild_settings (guild_id, created_at, updated_at)
      VALUES (?, ?, ?) ON CONFLICT(guild_id) DO NOTHING`,
  'featurePlatformService grantRewardOnce': `INSERT INTO coin_guild_settings (guild_id, created_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(guild_id) DO NOTHING`,
  'dailyDiscussionService settleDailyDiscussion': `INSERT INTO coin_guild_settings (guild_id, created_at, updated_at)
       VALUES (?, ?, ?) ON CONFLICT(guild_id) DO NOTHING`,
  'dailyRiddleService settleDailyRiddle': `INSERT INTO coin_guild_settings (guild_id, created_at, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(guild_id) DO NOTHING`,
};
const LEGACY_READ = 'SELECT enabled FROM coin_guild_settings WHERE guild_id = ?';

const OLD_TIME = '2026-01-01T00:00:00.000Z';
const NEW_TIME = '2026-10-02T03:04:05.000Z';
const STARTING_ROWS = {
  'no row': null,
  'enabled row': {
    enabled: 1, daily_base_reward: 70, streak_three_bonus: 25, streak_seven_bonus: 120, allow_transfer: 1,
    shop_enabled: 1, admin_log_channel_id: 'admin-room', announcement_channel_id: null,
    created_at: OLD_TIME, updated_at: OLD_TIME,
  },
  'disabled row': {
    enabled: 0, daily_base_reward: 30, streak_three_bonus: 5, streak_seven_bonus: 9, allow_transfer: 0,
    shop_enabled: 0, admin_log_channel_id: null, announcement_channel_id: 'news-room',
    created_at: OLD_TIME, updated_at: '2026-02-02T00:00:00.000Z',
  },
};

function insertStartingRow(api, guildId, row) {
  api.run(
    `INSERT INTO coin_guild_settings
      (guild_id, enabled, daily_base_reward, streak_three_bonus, streak_seven_bonus, allow_transfer,
       shop_enabled, admin_log_channel_id, announcement_channel_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [guildId, row.enabled, row.daily_base_reward, row.streak_three_bonus, row.streak_seven_bonus,
      row.allow_transfer, row.shop_enabled, row.admin_log_channel_id, row.announcement_channel_id,
      row.created_at, row.updated_at]
  );
}

test('moving the SQL leaves every coin_guild_settings column and every read result unchanged', async () => {
  // A guild that never gets a row: the strict reading says disabled, the defaulted reading says enabled.
  const absent = await withCoinDatabase((api) => ({
    legacyStrict: Number(api.get(LEGACY_READ, ['move-absent'])?.enabled) === 1,
    portStrict: Number(readGuildEconomyEnabledWithApi(api, 'move-absent')) === 1,
    legacyDefaulted: Number(api.get(LEGACY_READ, ['move-absent'])?.enabled ?? 1) === 1,
    portDefaulted: Number(readGuildEconomyEnabledWithApi(api, 'move-absent') ?? 1) === 1,
  }));
  assert.deepEqual(absent, { legacyStrict: false, portStrict: false, legacyDefaulted: true, portDefaulted: true });
  assert.equal(await settingsRow('move-absent'), null);

  let scenario = 0;
  for (const [site, legacyInsert] of Object.entries(LEGACY_INSERTS)) {
    for (const [label, startingRow] of Object.entries(STARTING_ROWS)) {
      scenario += 1;
      const legacyGuild = `move-${scenario}-legacy`;
      const portGuild = `move-${scenario}-port`;
      const context = `${site} / ${label}`;

      const reads = await withCoinTransaction((api) => {
        if (startingRow) {
          insertStartingRow(api, legacyGuild, startingRow);
          insertStartingRow(api, portGuild, startingRow);
        }
        api.run(legacyInsert, [legacyGuild, NEW_TIME, NEW_TIME]);
        ensureGuildEconomyRowWithApi(api, portGuild, NEW_TIME);
        return {
          legacyStrict: Number(api.get(LEGACY_READ, [legacyGuild])?.enabled) === 1,
          portStrict: Number(readGuildEconomyEnabledWithApi(api, portGuild)) === 1,
          legacyDefaulted: Number(api.get(LEGACY_READ, [legacyGuild])?.enabled ?? 1) === 1,
          portDefaulted: Number(readGuildEconomyEnabledWithApi(api, portGuild) ?? 1) === 1,
        };
      });

      const { guild_id: legacyId, ...legacyColumns } = await settingsRow(legacyGuild);
      const { guild_id: portId, ...portColumns } = await settingsRow(portGuild);
      assert.equal(legacyId, legacyGuild, context);
      assert.equal(portId, portGuild, context);
      assert.deepEqual(portColumns, legacyColumns, context);
      assert.equal(reads.portStrict, reads.legacyStrict, context);
      assert.equal(reads.portDefaulted, reads.legacyDefaulted, context);
      if (!startingRow) {
        assert.equal(portColumns.created_at, NEW_TIME, context);
        assert.equal(portColumns.updated_at, NEW_TIME, context);
        assert.equal(reads.portStrict, true, context);
      } else {
        assert.equal(portColumns.created_at, startingRow.created_at, context);
        assert.equal(portColumns.updated_at, startingRow.updated_at, context);
        assert.equal(reads.portStrict, startingRow.enabled === 1, context);
      }
    }
  }
});

// ---------------------------------------------------------------------------------------
// Call sites: featurePlatformService
// ---------------------------------------------------------------------------------------

test('grantRewardOnce pays nothing for a disabled guild and keeps its settings row as it was', async () => {
  await setGuildEconomyEnabled('grant-off', false, { operatorId: 'owner-1' });
  const before = await settingsRow('grant-off');

  await assert.rejects(
    () => grantRewardOnce('grant-off', 'player-1', 'daily_riddle', 'event-1', 'participation', 30),
    (error) => error.code === 'COIN_DISABLED'
  );

  assert.deepEqual(await settingsRow('grant-off'), before);
  assert.deepEqual(await rewardFootprint('grant-off', 'player-1'), { grants: 0, transactions: 0, wallets: 0 });

  await setGuildEconomyEnabled('grant-off', true, { operatorId: 'owner-1' });
  const paid = await grantRewardOnce('grant-off', 'player-1', 'daily_riddle', 'event-1', 'participation', 30);
  assert.equal(paid.alreadyGranted, false);
  assert.equal((await rewardFootprint('grant-off', 'player-1')).grants, 1);
});

test('grantRewardOnce creates a missing settings row with the time of the grant and pays', async () => {
  assert.equal(await settingsRow('grant-new'), null);

  const paid = await grantRewardOnce('grant-new', 'player-2', 'daily_riddle', 'event-2', 'participation', 30);

  assert.equal(paid.alreadyGranted, false);
  assert.equal(paid.grant.amount, 30);
  const row = await settingsRow('grant-new');
  assert.equal(row.enabled, 1);
  assert.equal(row.created_at, paid.grant.createdAt);
  assert.equal(row.updated_at, paid.grant.createdAt);
});

test('grantRewardOnceV2 pays nothing for a disabled source guild and keeps its settings row as it was', async () => {
  const input = {
    kind: 'game', canonicalSourceId: 'discord:v2-off', rewardKind: 'completion',
    userId: 'player-3', sourceGuildId: 'v2-off', amount: 20,
  };
  await setGuildEconomyEnabled('v2-off', false, { operatorId: 'owner-1' });
  const before = await settingsRow('v2-off');

  await assert.rejects(() => grantRewardOnceV2(input), (error) => error.code === 'COIN_DISABLED');

  assert.deepEqual(await settingsRow('v2-off'), before);
  assert.equal(await count("SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE canonical_source_id = 'discord:v2-off'"), 0);
  assert.equal(await count("SELECT COUNT(*) AS count FROM coin_wallets WHERE user_id = 'player-3'"), 0);

  await setGuildEconomyEnabled('v2-off', true, { operatorId: 'owner-1' });
  const paid = await grantRewardOnceV2(input);
  assert.equal(paid.alreadyGranted, false);
  assert.equal(await count("SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE canonical_source_id = 'discord:v2-off'"), 1);
});

test('grantRewardOnceV2 creates a missing settings row at the current time and pays', async () => {
  assert.equal(await settingsRow('v2-new'), null);

  const lower = new Date().toISOString();
  const paid = await grantRewardOnceV2({
    kind: 'game', canonicalSourceId: 'discord:v2-new', rewardKind: 'completion',
    userId: 'player-4', sourceGuildId: 'v2-new', amount: 20,
  });
  const upper = new Date().toISOString();

  assert.equal(paid.alreadyGranted, false);
  const row = await settingsRow('v2-new');
  assert.equal(row.enabled, 1);
  assert.ok(row.created_at >= lower && row.created_at <= upper, `${row.created_at} is outside ${lower}..${upper}`);
  assert.equal(row.updated_at, row.created_at);
});

// ---------------------------------------------------------------------------------------
// Call sites: daily discussion and daily riddle settlement
// ---------------------------------------------------------------------------------------

const hour = 60 * 60 * 1000;
const minute = 60 * 1000;

function fakeClient(guildId, thread) {
  const guild = { id: guildId, channels: { cache: new Map([[thread.id, thread]]) } };
  return { user: { id: 'bot-1' }, guilds: { cache: new Map([[guildId, guild]]) } };
}

async function publishFixtureEvent(eventId, publishedAt) {
  await withCoinTransaction((api) => api.run(
    `UPDATE daily_events
     SET status = 'published', announcement_message_id = 'announcement-1', thread_id = 'thread-1', published_at = ?
     WHERE id = ?`,
    [publishedAt.toISOString(), eventId]
  ));
}

async function prepareDiscussion(guildId) {
  const localDate = '2026-09-30';
  const window = getDiscussionWindow(localDate);
  const claimedAt = new Date(window.start.getTime() + hour);
  const { event } = await claimDailyDiscussionEvent({
    guildId, parentChannelId: 'parent-room', localDate, now: claimedAt,
  });
  await publishFixtureEvent(event.id, claimedAt);
  const settleAt = new Date(window.endExclusive.getTime() + minute);
  const claim = await claimDailyDiscussionSettlement(event.id, settleAt);
  assert.equal(claim.claimed, true);
  const thread = {
    id: 'thread-1',
    messages: {
      fetch: async () => [{
        id: 'message-1', author: { id: 'player-5', bot: false }, content: '我覺得這個議題需要先看看大家的實際狀況再討論。',
        createdAt: new Date(window.start.getTime() + 2 * hour),
      }],
    },
  };
  return { client: fakeClient(guildId, thread), claim, settleAt, eventId: event.id };
}

async function prepareRiddle(guildId) {
  const localDate = '2026-09-30';
  const window = getRiddleWindow(localDate);
  const claimedAt = new Date(window.start.getTime() + 5 * minute);
  const { event } = await claimDailyRiddleEvent({
    guildId, parentChannelId: 'parent-room', localDate, now: claimedAt,
  });
  await publishFixtureEvent(event.id, claimedAt);
  const settleAt = new Date(window.end.getTime() + minute);
  const claim = await claimDailyRiddleSettlement(event.id, settleAt);
  assert.equal(claim.claimed, true);
  const thread = {
    id: 'thread-1',
    send: async () => ({ id: 'answer-message-1' }),
    messages: {
      fetch: async () => [{
        id: 'message-1', author: { id: 'player-6', bot: false }, content: '我想這個謎題要從題目的第一句話開始往下想。',
        createdAt: new Date(window.start.getTime() + hour),
      }],
    },
  };
  return { client: fakeClient(guildId, thread), claim, settleAt, eventId: event.id };
}

const settlementCases = [
  { name: 'daily discussion', prepare: prepareDiscussion, settle: settleDailyDiscussion, participant: 'player-5', guildId: 'discussion' },
  { name: 'daily riddle', prepare: prepareRiddle, settle: settleDailyRiddle, participant: 'player-6', guildId: 'riddle' },
];

for (const { name, prepare, settle, participant, guildId } of settlementCases) {
  test(`${name} settlement pays nothing and blocks the event while the guild coin system is disabled`, async () => {
    const guild = `${guildId}-off`;
    await setGuildEconomyEnabled(guild, false, { operatorId: 'owner-1' });
    const before = await settingsRow(guild);
    const { client, claim, settleAt, eventId } = await prepare(guild);

    const result = await settle(client, claim.event, { now: settleAt, leaseOwner: claim.leaseOwner });

    assert.deepEqual(result, { settled: false, blocked: true, reason: 'coin_disabled', rewarded: 0 });
    assert.deepEqual(await settingsRow(guild), before);
    assert.deepEqual(await rewardFootprint(guild, participant), { grants: 0, transactions: 0, wallets: 0 });
    assert.equal(await withCoinDatabase((api) => api.get('SELECT status FROM daily_events WHERE id = ?', [eventId]).status), 'blocked');
  });

  test(`${name} settlement creates a missing settings row at the settlement time and then pays`, async () => {
    const guild = `${guildId}-new`;
    assert.equal(await settingsRow(guild), null);
    const { client, claim, settleAt, eventId } = await prepare(guild);

    const result = await settle(client, claim.event, { now: settleAt, leaseOwner: claim.leaseOwner });

    assert.equal(result.settled, true);
    assert.equal(result.blocked, false);
    assert.equal(result.rewarded, 1);
    const row = await settingsRow(guild);
    assert.equal(row.enabled, 1);
    assert.equal(row.created_at, settleAt.toISOString());
    assert.equal(row.updated_at, settleAt.toISOString());
    assert.equal((await rewardFootprint(guild, participant)).grants, 1);
    assert.equal(await withCoinDatabase((api) => api.get('SELECT status FROM daily_events WHERE id = ?', [eventId]).status), 'settled');
  });
}

// ---------------------------------------------------------------------------------------
// Call site: solo game session (reads the switch through an injected port)
// ---------------------------------------------------------------------------------------

function blanks(board) {
  const cells = [];
  for (let row = 0; row < 9; row += 1) {
    for (let column = 0; column < 9; column += 1) {
      if (board.puzzle[row][column] === 0) cells.push({ row, column, value: board.solution[row][column] });
    }
  }
  return cells;
}

// Plays a one-batch sudoku to completion in `guildId` and returns the final result.
// `reader` is the injected switch reader; leave it out to use the default.
async function completeSoloGame({ sessionId, guildId, grants, reader, spyStatements }) {
  const service = createSoloSessionService({
    withDatabase: withCoinDatabase,
    withTransaction: spyStatements
      ? (work) => withCoinTransaction((api) => work({
        ...api,
        get: (sql, params) => { spyStatements.push(sql); return api.get(sql, params); },
        run: (sql, params) => { spyStatements.push(sql); return api.run(sql, params); },
        all: (sql, params) => { spyStatements.push(sql); return api.all(sql, params); },
      }))
      : withCoinTransaction,
    grantRewardOnceV2WithApi: (api, input) => {
      grants.push(input);
      return { receipt: { id: grants.length }, debtOffset: 0 };
    },
    ...(reader ? { readGuildEconomyEnabledWithApi: reader } : {}),
    clock: () => new Date('2026-10-02T00:00:00.000Z'),
    idFactory: () => sessionId,
    seedFactory: () => `${sessionId}-seed`,
  });
  await service.create({ userId: 'player-7', guildId, channelId: 'room', gameType: 'sudoku', difficulty: 'easy' });
  const scope = { sessionId, actorId: 'player-7', guildId, channelId: 'room', messageId: 'panel' };
  await service.bindMessage(scope);
  const board = buildSudoku(`${sessionId}-seed`, 'easy');
  const outcome = await service.apply({
    ...scope, expectedRevision: 0, interactionId: `${sessionId}-action`,
    action: { type: 'set_batch', cells: blanks(board) },
  });
  return { outcome, service, scope };
}

const rewardStatusOf = (sessionId) => withCoinDatabase((api) =>
  api.get('SELECT status FROM discord_game_rewards WHERE session_id = ?', [sessionId])?.status);

test('a solo game pays nothing while the guild coin system is disabled', async () => {
  await setGuildEconomyEnabled('solo-off', false, { operatorId: 'owner-1' });
  const grants = [];

  const { outcome } = await completeSoloGame({ sessionId: 'solo-off-round', guildId: 'solo-off', grants });

  assert.equal(outcome.status, 'completed');
  assert.equal(outcome.rewardStatus, 'no_reward');
  assert.deepEqual(grants, []);
  assert.equal(await rewardStatusOf('solo-off-round'), 'no_reward');
});

test('a solo game in a guild without a settings row still pays, and the game never writes the row', async () => {
  assert.equal(await settingsRow('solo-new'), null);
  const grants = [];

  const { outcome } = await completeSoloGame({ sessionId: 'solo-new-round', guildId: 'solo-new', grants });

  assert.equal(outcome.rewardStatus, 'granted');
  assert.equal(grants.length, 1);
  assert.equal(grants[0].sourceGuildId, 'solo-new');
  assert.equal(await settingsRow('solo-new'), null);
});

test('a solo game in an enabled guild pays', async () => {
  await setGuildEconomyEnabled('solo-on', true, { operatorId: 'owner-1' });
  const grants = [];

  const { outcome } = await completeSoloGame({ sessionId: 'solo-on-round', guildId: 'solo-on', grants });

  assert.equal(outcome.rewardStatus, 'granted');
  assert.equal(grants.length, 1);
});

test('the solo game reads the switch only through the port, inside its own transaction', async () => {
  await setGuildEconomyEnabled('solo-spy', false, { operatorId: 'owner-1' });

  // Default port: the single settings read is the economy port, issued on the transaction api.
  const defaultStatements = [];
  const defaultResult = await completeSoloGame({
    sessionId: 'solo-spy-default', guildId: 'solo-spy', grants: [], spyStatements: defaultStatements,
  });
  assert.equal(defaultResult.outcome.rewardStatus, 'no_reward');
  assert.deepEqual(
    defaultStatements.filter((sql) => sql.includes('coin_guild_settings')).map(squash),
    ['SELECT enabled FROM coin_guild_settings WHERE guild_id = ?']
  );

  // Injected port: the service issues no SQL on the settings table itself and honours the answer.
  const injectedStatements = [];
  const seen = [];
  const reader = (api, guildId) => {
    seen.push({ guildId, hasTransactionApi: typeof api.get === 'function' && typeof api.run === 'function' });
    return 1;
  };
  const injected = await completeSoloGame({
    sessionId: 'solo-spy-injected', guildId: 'solo-spy', grants: [], reader, spyStatements: injectedStatements,
  });
  assert.equal(injected.outcome.rewardStatus, 'granted');
  assert.deepEqual(seen, [{ guildId: 'solo-spy', hasTransactionApi: true }]);
  assert.deepEqual(injectedStatements.filter((sql) => sql.includes('coin_guild_settings')), []);
});

test('an injected reader answering 0 stops the reward and one answering undefined keeps the default of enabled', async () => {
  const stopped = await completeSoloGame({
    sessionId: 'solo-reader-zero', guildId: 'solo-reader', grants: [], reader: () => 0,
  });
  assert.equal(stopped.outcome.rewardStatus, 'no_reward');

  const grants = [];
  const defaulted = await completeSoloGame({
    sessionId: 'solo-reader-undefined', guildId: 'solo-reader', grants, reader: () => undefined,
  });
  assert.equal(defaulted.outcome.rewardStatus, 'granted');
  assert.equal(grants.length, 1);
});

test('a reader that is not a function is refused when the service is created', () => {
  for (const reader of [null, 'yes', 1, {}]) {
    assert.throws(
      () => createSoloSessionService({
        withDatabase: withCoinDatabase, withTransaction: withCoinTransaction, readGuildEconomyEnabledWithApi: reader,
      }),
      (error) => error.code === 'STORE_NOT_CONFIGURED'
    );
  }
});

test('a reader that answers asynchronously fails the completing move and persists nothing', async () => {
  const grants = [];
  await assert.rejects(
    completeSoloGame({
      sessionId: 'solo-reader-async', guildId: 'solo-reader', grants, reader: async () => 1,
    }),
    (error) => error.code === 'REWARD_CONTRACT_INVALID'
  );

  assert.deepEqual(grants, []);
  assert.equal(await rewardStatusOf('solo-reader-async'), undefined);
  assert.equal(
    await withCoinDatabase((api) => api.get('SELECT status FROM discord_game_sessions WHERE id = ?', ['solo-reader-async']).status),
    'active'
  );
});

test('a reader that rejects asynchronously does not cause unhandledRejection; the error is thrown instead', async () => {
  const grants = [];
  const unhandledRejections = [];
  const listener = (reason) => unhandledRejections.push(reason);
  process.on('unhandledRejection', listener);

  try {
    await assert.rejects(
      completeSoloGame({
        sessionId: 'solo-reader-reject', guildId: 'solo-reader', grants, reader: async () => {
          throw new Error('Injected reader failure');
        },
      }),
      (error) => error.code === 'REWARD_CONTRACT_INVALID'
    );

    // Allow one event loop tick for any pending rejections to surface
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(grants, []);
    assert.equal(await rewardStatusOf('solo-reader-reject'), undefined);
    assert.equal(
      await withCoinDatabase((api) => api.get('SELECT status FROM discord_game_sessions WHERE id = ?', ['solo-reader-reject']).status),
      'active'
    );
    assert.equal(unhandledRejections.length, 0, `Expected no unhandledRejection events, but got ${unhandledRejections.length}: ${unhandledRejections.map(e => String(e)).join(', ')}`);
  } finally {
    process.removeListener('unhandledRejection', listener);
  }
});
