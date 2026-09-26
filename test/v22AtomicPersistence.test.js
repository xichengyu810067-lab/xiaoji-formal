const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { initializeCoinDatabase, initializeNewCoinDatabase, resetCoinDatabaseForTests,
  withCoinDatabase, withCoinTransaction } = require('../src/services/coinDatabase');
const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const { createRewardCoordinator } = require('../src/coordinators/rewardCoordinator');
const { grantRewardOnceV2WithApi } = require('../src/services/featurePlatformService');
const { createSoloSessionService } = require('../src/systems/games/soloSessionService');
const { createSoloDiscordRuntime } = require('../src/systems/games/soloDiscordRuntime');
const { buildSoloCustomId } = require('../src/systems/games/soloCustomId');
const { processDuePrimaryCycles } = require('../src/services/workService');

function databaseFixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-v22-persist-'));
  const filePath = path.join(directory, 'coins.sqlite');
  const previous = process.env.COIN_DB_PATH;
  resetCoinDatabaseForTests();
  process.env.COIN_DB_PATH = filePath;
  t.after(() => {
    resetCoinDatabaseForTests();
    if (previous === undefined) delete process.env.COIN_DB_PATH;
    else process.env.COIN_DB_PATH = previous;
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return filePath;
}

function hash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

async function failNextSave(filePath, run) {
  const original = fs.renameSync;
  let failed = false;
  fs.renameSync = (source, target) => {
    if (!failed && path.resolve(target) === path.resolve(filePath)) {
      failed = true;
      throw new Error('synthetic persistence failure');
    }
    return original(source, target);
  };
  try {
    const result = await run();
    assert.equal(failed, true, 'the database save must reach the injected failure');
    return result;
  } finally {
    fs.renameSync = original;
  }
}

test('v22 solo completion does not acknowledge a lost game and reward save', async (t) => {
  const dbPath = databaseFixture(t);
  await initializeNewCoinDatabase({ expectedPath: dbPath });
  const coordinator = createRuntimeRewardCoordinator();
  const service = createSoloSessionService({ withDatabase: withCoinDatabase, withTransaction: withCoinTransaction,
    grantRewardOnceV2WithApi: (api, request) => coordinator.grantInTransaction(api, request),
    clock: () => new Date('2026-09-26T00:00:00.000Z'),
    idFactory: () => 'failedsavegame', seedFactory: () => 'syntheticseed' });
  const session = await service.create({ userId: '10001', guildId: '20001', channelId: '30001',
    gameType: 'number-match', difficulty: 'easy' });
  await service.bindMessage({ sessionId: session.id, actorId: '10001', guildId: '20001',
    channelId: '30001', messageId: '40001' });
  const scope = { sessionId: session.id, actorId: '10001', guildId: '20001',
    channelId: '30001', messageId: '40001' };
  await service.apply({ ...scope, expectedRevision: 0, interactionId: 'firstmove',
    action: { type: 'pair', first: 0, second: 1 } });
  const before = hash(dbPath);
  await failNextSave(dbPath, async () => {
    await assert.rejects(service.apply({ ...scope, expectedRevision: 1, interactionId: 'finalmove',
      action: { type: 'pair', first: 0, second: 1 } }), /落盤失敗/);
  });
  assert.equal(hash(dbPath), before);
  const inspect = () => withCoinDatabase((api) => ({
    session: api.get('SELECT status,revision FROM discord_game_sessions WHERE id = ?', [session.id]),
    rewards: Number(api.get('SELECT COUNT(*) AS count FROM reward_grants_v2').count),
    actions: Number(api.get('SELECT COUNT(*) AS count FROM discord_game_actions WHERE session_id = ?', [session.id]).count),
  }));
  assert.deepEqual(await inspect(), { session: { status: 'active', revision: 1 }, rewards: 0, actions: 1 });
  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  assert.deepEqual(await inspect(), { session: { status: 'active', revision: 1 }, rewards: 0, actions: 1 });
  const beforeUiFailure = hash(dbPath);
  const replies = [];
  let panelEdits = 0;
  const runtime = createSoloDiscordRuntime({ service,
    client: { channels: { fetch: async () => ({ guildId: '20001', messages: {
      fetch: async () => ({ edit: async () => { panelEdits++; } }),
    } }) } },
    runtimeLogger: { error() {} }, isGuildApproved: () => true, isBotOwner: () => false });
  const interaction = {
    id: 'ui-finalmove', customId: buildSoloCustomId({ sessionId: session.id, revision: 1, verb: 'move.n' }),
    guildId: '20001', channelId: '30001', user: { id: '10001' }, message: { id: '40001' },
    fields: { getTextInputValue: (name) => name === 'first' ? 'A1' : 'B1' },
    isButton: () => false, isModalSubmit: () => true,
    async deferReply() { this.deferred = true; },
    async editReply(value) { replies.push(value); },
  };
  await failNextSave(dbPath, async () => {
    assert.equal(await runtime.handleInteraction(interaction), true);
  });
  assert.equal(replies.length, 1);
  assert.match(replies[0].content, /無法處理/);
  assert.doesNotMatch(replies[0].content, /已儲存|已更新/);
  assert.equal(panelEdits, 0);
  assert.deepEqual(await inspect(), { session: { status: 'active', revision: 1 }, rewards: 0, actions: 1 });
  assert.equal(hash(dbPath), beforeUiFailure);
  await withCoinTransaction((api) => api.run(`CREATE TRIGGER reject_game_outcome
    BEFORE INSERT ON discord_game_rewards BEGIN SELECT RAISE(ABORT, 'synthetic game outcome failure'); END`));
  const beforeOutcomeFailure = hash(dbPath);
  let synchronousGrants = 0;
  let asyncGrants = 0;
  const guardedCoordinator = createRewardCoordinator({
    grantRewardOnceV2() { asyncGrants++; throw new Error('nested grant forbidden'); },
    getRewardReceiptV2() { asyncGrants++; throw new Error('nested read forbidden'); },
    grantRewardOnceV2WithApi(api, request) {
      synchronousGrants++;
      return grantRewardOnceV2WithApi(api, request);
    },
  });
  const rejectedOutcome = createSoloSessionService({ withDatabase: withCoinDatabase,
    withTransaction: withCoinTransaction,
    grantRewardOnceV2WithApi: (api, request) => guardedCoordinator.grantInTransaction(api, request),
    clock: () => new Date('2026-09-26T00:00:00.000Z') });
  await assert.rejects(rejectedOutcome.apply({ ...scope, expectedRevision: 1,
    interactionId: 'finalmove', action: { type: 'pair', first: 0, second: 1 } }),
  /synthetic game outcome failure/);
  assert.equal(synchronousGrants, 1);
  assert.equal(asyncGrants, 0);
  assert.deepEqual(await inspect(), { session: { status: 'active', revision: 1 }, rewards: 0, actions: 1 });
  assert.equal(hash(dbPath), beforeOutcomeFailure);
});

test('v22 primary payroll reports failure and preserves cycle and reward after lost save', async (t) => {
  const dbPath = databaseFixture(t);
  await initializeNewCoinDatabase({ expectedPath: dbPath });
  const timestamp = '2020-01-01T00:00:00.000Z';
  await withCoinTransaction((api) => {
    api.run(`INSERT INTO coin_primary_jobs_global
      (user_id,job_name,work_days,source_guild_id,next_cycle_id,requested_at,not_before_at,effective_from,effective_until,state,updated_at)
      VALUES ('10001','廚師',1,'20001','cycle-1',?,?,?,?, 'active',?)`,
    [timestamp, timestamp, timestamp, timestamp, timestamp]);
    api.run(`INSERT INTO coin_primary_job_cycles
      (cycle_id,user_id,job_name,work_days,source_guild_id,starts_at,ends_at,salary_rule_version,salary_snapshot_json,status,created_at,updated_at)
      VALUES ('cycle-1','10001','廚師',1,'20001',?,?,'primary-v1',?,'active',?,?)`,
    [timestamp, '2020-01-02T00:00:00.000Z',
      JSON.stringify({ version: 'primary-v1', dailySalary: 70, basicRatio: 0.75, translatorBonus: 0 }), timestamp, timestamp]);
    api.run(`INSERT INTO coin_work_tasks
      (guild_id,user_id,job_id,global_cycle_id,job_name,task_type,status,description,attachment_urls,
       external_server_ids,created_at,due_at,completed_at,updated_at)
       VALUES ('20001','10001',NULL,'cycle-1','廚師','regular','completed','合成工作','[]','[]',?,?,?,?)`,
    [timestamp, '2020-01-02T00:00:00.000Z', '2020-01-01T12:00:00.000Z', timestamp]);
  });
  const before = hash(dbPath);
  const outcome = await failNextSave(dbPath, () => processDuePrimaryCycles());
  assert.deepEqual(outcome, { checked: 1, settled: 0, failed: 1, roleCleanupFailed: 0 });
  assert.equal(hash(dbPath), before);
  const inspect = () => withCoinDatabase((api) => ({
    primary: api.get("SELECT state FROM coin_primary_jobs_global WHERE user_id = '10001'").state,
    cycle: api.get("SELECT status FROM coin_primary_job_cycles WHERE cycle_id = 'cycle-1'").status,
    payrolls: Number(api.get('SELECT COUNT(*) AS count FROM coin_primary_cycle_payroll').count),
    rewards: Number(api.get('SELECT COUNT(*) AS count FROM reward_grants_v2').count),
  }));
  assert.deepEqual(await inspect(), { primary: 'active', cycle: 'active', payrolls: 0, rewards: 0 });
  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  assert.deepEqual(await inspect(), { primary: 'active', cycle: 'active', payrolls: 0, rewards: 0 });
  await withCoinTransaction((api) => api.run(`CREATE TRIGGER reject_primary_payroll
    BEFORE INSERT ON coin_primary_cycle_payroll BEGIN SELECT RAISE(ABORT, 'synthetic payroll failure'); END`));
  const beforePayrollFailure = hash(dbPath);
  const rejectedPayroll = await processDuePrimaryCycles();
  assert.deepEqual(rejectedPayroll, { checked: 1, settled: 0, failed: 1, roleCleanupFailed: 0 });
  assert.deepEqual(await inspect(), { primary: 'active', cycle: 'active', payrolls: 0, rewards: 0 });
  assert.equal(hash(dbPath), beforePayrollFailure);
});
