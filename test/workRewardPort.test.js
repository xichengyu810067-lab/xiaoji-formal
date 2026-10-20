'use strict';

// How the work system gets its reward coordinator. The work system is a set of module functions, so
// the assembly root hands the process's one reward coordinator to src/systems/work/workRewardPort.js and payroll pays
// through it. Nothing in the work system builds a coordinator of its own: with none configured, payroll pauses and the
// transaction that would pay is rolled back, so nothing is left half done, and the next run pays once one is configured.
// The assembly itself (src/index.js hands the work system the very coordinator the solo games get) is checked in
// test/soloRewardPort.test.js, which starts the real index.js.
// Only a synthetic coin database in a temporary directory is used.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-work-reward-port-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');

const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { legacySettlementPeriodKey } = require('../src/systems/work/jobCycle');
const {
  configureWorkRewardCoordinator,
  getWorkRewardCoordinator,
  resetWorkRewardCoordinatorForTests,
} = require('../src/systems/work/workRewardPort');
const { captureLegacyJobBatch, processDueJobs } = require('../src/systems/work/workService');
const logger = require('../src/utils/logger');

const GUILD_ID = '320000000000000001';
const PRIMARY_USER_ID = '320000000000000011';
const LEGACY_USER_ID = '320000000000000021';
const STARTED = '2026-04-01T01:00:00.000Z';
const CYCLE_END = '2026-04-02T01:00:00.000Z';
const PAY_AT = '2026-04-03T14:00:00.000Z';
const APPEAL_DEADLINE = '2099-01-01T00:00:00.000Z';
const UNSET_MESSAGE = '全域結算介面尚未就緒，暫停發薪。';

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetWorkRewardCoordinatorForTests();
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// The reward key of a work settlement, derived here independently of the code under test.
const settlementKeyOf = (canonicalSourceId, userId) => `reward:v1:${crypto.createHash('sha256')
  .update(JSON.stringify(['work-settlement', canonicalSourceId, 'salary', userId])).digest('hex')}`;

// Runs `work` with the logger quiet and reports what the logger was asked to print.
async function withLoggerCaptured(work) {
  const original = { error: logger.error, warn: logger.warn, info: logger.info };
  const seen = { error: [], warn: [], info: [] };
  for (const level of Object.keys(seen)) logger[level] = (...args) => { seen[level].push(args); };
  try {
    return { value: await work(), seen };
  } finally {
    Object.assign(logger, original);
  }
}

// Every row of every table, to compare the database before and after a run that must change nothing.
function snapshotEveryTable() {
  return withCoinDatabase((api) => {
    const tables = api.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .map((row) => row.name);
    return Object.fromEntries(tables.map((name) => [name, api.all(`SELECT * FROM "${name}"`)]));
  });
}

test('the work reward port takes exactly one reward coordinator', () => {
  resetWorkRewardCoordinatorForTests();
  const unset = (error) => error.name === 'CoinServiceError' && error.code === 'WORK_REWARD_API_REQUIRED'
    && error.message === UNSET_MESSAGE;
  assert.throws(() => getWorkRewardCoordinator(), unset);

  for (const invalid of [undefined, null, {}, { grant() {} }, { grantInTransaction: 'not a function' }, 'coordinator']) {
    assert.throws(() => configureWorkRewardCoordinator(invalid),
      (error) => error.name === 'CoinServiceError' && error.code === 'WORK_REWARD_COORDINATOR_INVALID',
      `${String(invalid)}`);
  }
  assert.throws(() => getWorkRewardCoordinator(), unset, 'a refused value configures nothing');

  const first = createRuntimeRewardCoordinator();
  assert.ok(configureWorkRewardCoordinator(first) === first);
  assert.ok(getWorkRewardCoordinator() === first);
  assert.ok(configureWorkRewardCoordinator(first) === first, 'the same coordinator again is accepted');

  const second = createRuntimeRewardCoordinator();
  assert.ok(second !== first);
  assert.throws(() => configureWorkRewardCoordinator(second),
    (error) => error.name === 'CoinServiceError' && error.code === 'WORK_REWARD_COORDINATOR_CONFLICT');
  assert.ok(getWorkRewardCoordinator() === first, 'a refused coordinator does not replace the first');

  resetWorkRewardCoordinatorForTests();
  assert.throws(() => getWorkRewardCoordinator(), unset);
});

// One due primary cycle (a completed task, a penalty of 30 on a day's pay of 100) and one due legacy job (a completed
// task, a task still pending, a penalty of 50 on 2 days of 400). Each is settled by its own grant site.
async function seedDuePayroll() {
  await withCoinTransaction((api) => {
    api.run(`INSERT INTO coin_primary_jobs_global
      (user_id,job_name,work_days,source_guild_id,next_cycle_id,requested_at,not_before_at,effective_from,
       effective_until,state,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'active',?)`,
    [PRIMARY_USER_ID, '老師', 1, GUILD_ID, 'work-port-cycle', STARTED, STARTED, STARTED, CYCLE_END, STARTED]);
    api.run(`INSERT INTO coin_primary_job_cycles
      (cycle_id,user_id,job_name,work_days,source_guild_id,starts_at,ends_at,salary_rule_version,
       salary_snapshot_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)`,
    ['work-port-cycle', PRIMARY_USER_ID, '老師', 1, GUILD_ID, STARTED, CYCLE_END, 'primary-v1',
      JSON.stringify({ version: 'primary-v1', dailySalary: 100, basicRatio: 0.75, translatorBonus: 0 }), STARTED, STARTED]);
    api.run(`INSERT INTO coin_work_tasks
      (guild_id,user_id,job_id,global_cycle_id,job_name,task_type,status,description,attachment_urls,
       external_server_count,external_server_ids,created_at,due_at,completed_at,updated_at)
      VALUES (?,?,NULL,'work-port-cycle','老師','daily','completed','synthetic primary task','[]',0,'[]',?,?,?,?)`,
    [GUILD_ID, PRIMARY_USER_ID, STARTED, CYCLE_END, STARTED, STARTED]);
    api.run(`INSERT INTO coin_primary_cycle_penalties
      (cycle_id,user_id,task_id,amount,status,reason,applied_at,appeal_deadline,created_at,updated_at)
      VALUES ('work-port-cycle',?,NULL,30,'active','synthetic primary penalty',NULL,?,?,?)`,
    [PRIMARY_USER_ID, APPEAL_DEADLINE, STARTED, STARTED]);

    api.run(`INSERT INTO coin_jobs
      (guild_id,user_id,job_name,job_role_id,daily_salary,work_days,total_salary,status,is_paid,start_at,pay_at,
       last_contribution_at,today_task_count,today_completed_task_count,no_work_available_today,payroll_status,
       created_at,updated_at) VALUES (?,?,?,NULL,400,2,800,'active',0,?,?,NULL,0,0,0,'pending',?,?)`,
    [GUILD_ID, LEGACY_USER_ID, '老師', STARTED, PAY_AT, STARTED, STARTED]);
    const jobId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    for (const [status, completedAt] of [['completed', STARTED], ['pending', null]]) {
      api.run(`INSERT INTO coin_work_tasks
        (guild_id,user_id,job_id,job_name,task_type,status,description,attachment_urls,expected_channel_id,
         expected_channel_name,message_id,external_server_count,external_server_ids,created_at,due_at,completed_at,updated_at)
        VALUES (?,?,?,'老師','daily',?,?,'[]',NULL,'老師',NULL,0,'[]',?,?,?,?)`,
      [GUILD_ID, LEGACY_USER_ID, jobId, status, `synthetic legacy task (${status})`, STARTED, APPEAL_DEADLINE,
        completedAt, STARTED]);
    }
    api.run(`INSERT INTO coin_work_penalties
      (guild_id,user_id,job_id,job_name,task_id,source_type,source_id,source_channel_id,penalty_date,daily_salary,
       penalty_amount,status,reason,appeal_deadline_at,created_at,updated_at)
      VALUES (?,?,?,'老師',NULL,'synthetic',NULL,NULL,'2026-04-01',400,50,'active','synthetic legacy penalty',?,?,?)`,
    [GUILD_ID, LEGACY_USER_ID, jobId, APPEAL_DEADLINE, STARTED, STARTED]);
  });
  // The cutover snapshot that fixes the legacy job's pay rules, as the scheduler's capture makes it.
  assert.deepEqual(await captureLegacyJobBatch(), { users: 1, snapshots: 1, nextUserId: null });
}

test('payroll with no reward coordinator pauses and leaves nothing behind; once one is configured the next run pays', async () => {
  resetWorkRewardCoordinatorForTests();
  await seedDuePayroll();
  const before = await snapshotEveryTable();
  const jobId = Number((await withCoinDatabase((api) => api.get('SELECT id FROM coin_jobs'))).id);

  // Both grant sites: the legacy job pays first, then the primary cycle.
  const paused = await withLoggerCaptured(() => processDueJobs(null));

  assert.deepEqual([paused.value.processed, paused.value.success, paused.value.fail], [1, 0, 1]);
  assert.deepEqual(paused.value.primaryCycles, { checked: 1, settled: 0, failed: 1, roleCleanupFailed: 0 });
  const pausedCodes = paused.seen.error.map(([, error]) => error?.code);
  assert.deepEqual(pausedCodes, ['WORK_REWARD_API_REQUIRED', 'WORK_REWARD_API_REQUIRED']);
  assert.ok(paused.seen.error.every(([, error]) => error?.message === UNSET_MESSAGE));
  // No payroll row, no task state, no deduction, no receipt: every table is exactly as it was.
  const afterPause = await snapshotEveryTable();
  assert.deepEqual(afterPause, before);
  const state = await withCoinDatabase((api) => ({
    job: api.get('SELECT status, is_paid, payroll_status FROM coin_jobs'),
    cycle: api.get("SELECT status FROM coin_primary_job_cycles WHERE cycle_id = 'work-port-cycle'").status,
    legacyTasks: api.all('SELECT status, is_paid FROM coin_work_tasks WHERE job_id IS NOT NULL ORDER BY id'),
    primaryTask: api.get("SELECT status, is_paid FROM coin_work_tasks WHERE global_cycle_id = 'work-port-cycle'"),
    penalties: [
      api.get("SELECT applied_at FROM coin_primary_cycle_penalties WHERE cycle_id = 'work-port-cycle'").applied_at,
      api.get('SELECT applied_at FROM coin_work_penalties').applied_at,
    ],
    payrollRows: Number(api.get('SELECT COUNT(*) AS count FROM coin_payroll_history').count)
      + Number(api.get('SELECT COUNT(*) AS count FROM coin_primary_cycle_payroll').count)
      + Number(api.get('SELECT COUNT(*) AS count FROM coin_work_legacy_settlements').count),
    receipts: Number(api.get('SELECT COUNT(*) AS count FROM reward_grants_v2').count),
  }));
  assert.deepEqual(state, {
    job: { status: 'active', is_paid: 0, payroll_status: 'pending' },
    cycle: 'active',
    legacyTasks: [{ status: 'completed', is_paid: 0 }, { status: 'pending', is_paid: 0 }],
    primaryTask: { status: 'completed', is_paid: 0 },
    penalties: [null, null],
    payrollRows: 0,
    receipts: 0,
  });

  // Configure the coordinator: a recording wrapper around the real one, so the requests it is asked for are seen.
  const real = createRuntimeRewardCoordinator();
  const requests = [];
  const configured = Object.freeze({
    grantInTransaction(api, request) {
      requests.push(request);
      return real.grantInTransaction(api, request);
    },
  });
  configureWorkRewardCoordinator(configured);
  assert.ok(getWorkRewardCoordinator() === configured);

  const retried = await withLoggerCaptured(() => processDueJobs(null));

  assert.deepEqual([retried.value.processed, retried.value.success, retried.value.fail], [1, 1, 0]);
  assert.deepEqual(retried.value.primaryCycles, { checked: 1, settled: 1, failed: 0, roleCleanupFailed: 0 });
  assert.deepEqual(retried.seen.error, []);
  // The legacy job: 2 days of 400, less the penalty of 50, and the pending task is expired by the settlement.
  const periodKey = legacySettlementPeriodKey(await withCoinDatabase((api) => api.get(
    'SELECT * FROM coin_work_legacy_snapshots WHERE job_id = ?', [jobId])));
  assert.deepEqual(requests, [
    {
      kind: 'work-settlement',
      canonicalSourceId: `legacy:${jobId}:${periodKey}`,
      rewardKind: 'salary',
      userId: LEGACY_USER_ID,
      sourceGuildId: GUILD_ID,
      amount: 750,
      operationId: `work-settlement:${jobId}:${periodKey}:${LEGACY_USER_ID}`,
    },
    {
      kind: 'work-settlement',
      canonicalSourceId: 'primary:work-port-cycle',
      rewardKind: 'salary',
      userId: PRIMARY_USER_ID,
      sourceGuildId: GUILD_ID,
      amount: 70,
      operationId: 'work-settlement:primary:work-port-cycle',
    },
  ]);
  const paid = await withCoinDatabase((api) => ({
    job: api.get('SELECT status, is_paid, payroll_status FROM coin_jobs'),
    history: api.all('SELECT user_id, paid_amount FROM coin_payroll_history'),
    legacySettlements: api.all('SELECT user_id, reward_key, amount, status FROM coin_work_legacy_settlements'),
    cycle: api.get("SELECT status FROM coin_primary_job_cycles WHERE cycle_id = 'work-port-cycle'").status,
    primaryPayroll: api.all('SELECT user_id, gross_amount, paid_amount, reward_key FROM coin_primary_cycle_payroll'),
    legacyTasks: api.all('SELECT status FROM coin_work_tasks WHERE job_id IS NOT NULL ORDER BY id'),
    primaryTask: api.get("SELECT status, is_paid FROM coin_work_tasks WHERE global_cycle_id = 'work-port-cycle'"),
    appliedPenalties: [
      api.get("SELECT applied_at IS NOT NULL AS applied FROM coin_primary_cycle_penalties WHERE cycle_id = 'work-port-cycle'").applied,
      api.get('SELECT applied_at IS NOT NULL AS applied FROM coin_work_penalties').applied,
    ].map(Number),
    receipts: api.all('SELECT reward_key, user_id, amount FROM reward_grants_v2 ORDER BY id'),
  }));
  const legacyKey = settlementKeyOf(`legacy:${jobId}:${periodKey}`, LEGACY_USER_ID);
  const primaryKey = settlementKeyOf('primary:work-port-cycle', PRIMARY_USER_ID);
  assert.deepEqual(paid, {
    job: { status: 'paid', is_paid: 1, payroll_status: 'paid' },
    history: [{ user_id: LEGACY_USER_ID, paid_amount: 750 }],
    legacySettlements: [{ user_id: LEGACY_USER_ID, reward_key: legacyKey, amount: 750, status: 'granted' }],
    cycle: 'settled',
    primaryPayroll: [{ user_id: PRIMARY_USER_ID, gross_amount: 100, paid_amount: 70, reward_key: primaryKey }],
    legacyTasks: [{ status: 'paid' }, { status: 'expired' }],
    primaryTask: { status: 'paid', is_paid: 1 },
    appliedPenalties: [1, 1],
    receipts: [
      { reward_key: legacyKey, user_id: LEGACY_USER_ID, amount: 750 },
      { reward_key: primaryKey, user_id: PRIMARY_USER_ID, amount: 70 },
    ],
  });

  // A third run finds nothing due and pays nothing more.
  const settled = await snapshotEveryTable();
  const again = await withLoggerCaptured(() => processDueJobs(null));
  assert.deepEqual([again.value.processed, again.value.success, again.value.fail], [0, 0, 0]);
  assert.deepEqual(again.value.primaryCycles, { checked: 0, settled: 0, failed: 0, roleCleanupFailed: 0 });
  assert.equal(requests.length, 2);
  assert.deepEqual(await snapshotEveryTable(), settled);
});
