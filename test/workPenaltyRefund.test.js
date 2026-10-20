'use strict';

// A legacy work penalty that is refunded on appeal returns only what payroll really took from the pay.
// A penalty is marked applied by payroll even when the pay was already used up, so the refund is worked
// out from the payroll receipt, the way a primary-job refund is. A real, isolated coin database; only the
// reward coordinator comes from the runtime and Discord is not involved.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-work-penalty-refund-'));
process.env.COIN_DB_PATH = path.join(root, 'work-penalty-refund.sqlite');
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
const {
  configureWorkRewardCoordinator,
  resetWorkRewardCoordinatorForTests,
} = require('../src/systems/work/workRewardPort');
const {
  captureLegacyJobBatch,
  createWorkPenaltyAppeal,
  processDueJobs,
  reviewWorkPenaltyAppeal,
} = require('../src/systems/work/workService');
const logger = require('../src/utils/logger');

const GUILD_ID = '330000000000000001';
const REVIEWER_ID = '330000000000000002';
const STARTED = '2026-04-01T01:00:00.000Z';
const PAY_AT = '2026-04-03T14:00:00.000Z';
const APPEAL_DEADLINE = '2099-01-01T00:00:00.000Z';
let sequence = 0;

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  configureWorkRewardCoordinator(createRuntimeRewardCoordinator());
});

test.after(() => {
  resetWorkRewardCoordinatorForTests();
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// Seeds one legacy job (a day's pay of 400 for 2 days, so 800) with the given tasks and penalties, pays it
// out through the real payroll, and returns the ids of the penalties in the order given.
async function paidJob({ tasks, penalties }) {
  sequence += 1;
  const userId = `33000000000001${String(sequence).padStart(2, '0')}`;
  const penaltyIds = [];
  await withCoinTransaction((api) => {
    api.run(`INSERT INTO coin_jobs
      (guild_id,user_id,job_name,job_role_id,daily_salary,work_days,total_salary,status,is_paid,start_at,pay_at,
       last_contribution_at,today_task_count,today_completed_task_count,no_work_available_today,payroll_status,
       created_at,updated_at) VALUES (?,?,'老師',NULL,400,2,800,'active',0,?,?,NULL,0,0,0,'pending',?,?)`,
    [GUILD_ID, userId, STARTED, PAY_AT, STARTED, STARTED]);
    const jobId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    for (const [status, completedAt] of tasks) {
      api.run(`INSERT INTO coin_work_tasks
        (guild_id,user_id,job_id,job_name,task_type,status,description,attachment_urls,expected_channel_id,
         expected_channel_name,message_id,external_server_count,external_server_ids,created_at,due_at,completed_at,updated_at)
        VALUES (?,?,?,'老師','daily',?,?,'[]',NULL,'老師',NULL,0,'[]',?,?,?,?)`,
      [GUILD_ID, userId, jobId, status, `synthetic task (${status})`, STARTED, APPEAL_DEADLINE, completedAt, STARTED]);
    }
    for (const amount of penalties) {
      api.run(`INSERT INTO coin_work_penalties
        (guild_id,user_id,job_id,job_name,task_id,source_type,source_id,source_channel_id,penalty_date,daily_salary,
         penalty_amount,status,reason,appeal_deadline_at,created_at,updated_at)
        VALUES (?,?,?,'老師',NULL,'synthetic',NULL,NULL,'2026-04-01',400,?,'active','synthetic penalty',?,?,?)`,
      [GUILD_ID, userId, jobId, amount, APPEAL_DEADLINE, STARTED, STARTED]);
      penaltyIds.push(Number(api.get('SELECT last_insert_rowid() AS id').id));
    }
  });
  await captureLegacyJobBatch();

  const original = { error: logger.error, warn: logger.warn, info: logger.info };
  for (const level of Object.keys(original)) logger[level] = () => {};
  try {
    const run = await processDueJobs(null);
    assert.equal(run.success, 1);
  } finally {
    Object.assign(logger, original);
  }
  return { userId, penaltyIds };
}

async function approveAppeal(userId, penaltyId) {
  const { appeal } = await createWorkPenaltyAppeal(GUILD_ID, userId, penaltyId, { reason: '測試申訴' });
  return reviewWorkPenaltyAppeal(GUILD_ID, REVIEWER_ID, appeal.id, { action: 'approved', reason: '測試通過' });
}

const refundsOf = (userId) => withCoinDatabase((api) => api.all(
  "SELECT amount FROM coin_transactions WHERE user_id = ? AND type = 'work_penalty_refund' ORDER BY id", [userId]));
const paidOf = (userId) => withCoinDatabase((api) => Number(
  api.get('SELECT paid_amount FROM coin_payroll_history WHERE user_id = ?', [userId]).paid_amount));
const penaltyRow = (penaltyId) => withCoinDatabase((api) => api.get(
  'SELECT status, applied_at, refunded_at FROM coin_work_penalties WHERE id = ?', [penaltyId]));

test('pay with a penalty that it fully covers: the whole penalty is refunded', async () => {
  const { userId, penaltyIds } = await paidJob({ tasks: [['completed', STARTED]], penalties: [50] });
  assert.equal(await paidOf(userId), 750);

  const result = await approveAppeal(userId, penaltyIds[0]);

  assert.equal(result.refund.amount, 50);
  assert.deepEqual(await refundsOf(userId), [{ amount: 50 }]);
  assert.ok((await penaltyRow(penaltyIds[0])).refunded_at);
});

test('a penalty on a job that earned nothing took nothing, so nothing is refunded', async () => {
  // Only a task that was never completed: no valid work, no pay, and the penalty is marked applied anyway.
  const { userId, penaltyIds } = await paidJob({ tasks: [['pending', null]], penalties: [50] });
  assert.equal(await paidOf(userId), 0);
  assert.ok((await penaltyRow(penaltyIds[0])).applied_at);

  const result = await approveAppeal(userId, penaltyIds[0]);

  assert.equal(result.refund, null);
  assert.deepEqual(await refundsOf(userId), []);
  const stored = await penaltyRow(penaltyIds[0]);
  assert.equal(stored.status, 'canceled');
  assert.ok(stored.refunded_at, 'the penalty is closed so it cannot be refunded again later');
});

test('penalties above a basic pay refund together only the basic pay that was used up', async () => {
  // Basic pay is 75% of 800 = 600; two penalties of 350 leave nothing, and 100 of them were never taken.
  const { userId, penaltyIds } = await paidJob({
    tasks: [['no_work_available', STARTED]], penalties: [350, 350],
  });
  assert.equal(await paidOf(userId), 0);

  // The later penalty is reviewed first: it only ever took what the earlier one left.
  const second = await approveAppeal(userId, penaltyIds[1]);
  const first = await approveAppeal(userId, penaltyIds[0]);

  assert.equal(second.refund.amount, 250);
  assert.equal(first.refund.amount, 350);
  assert.deepEqual(await refundsOf(userId), [{ amount: 250 }, { amount: 350 }]);
});

test('penalties above the full pay of a worked job refund together the pay that was used up', async () => {
  const { userId, penaltyIds } = await paidJob({
    tasks: [['completed', STARTED]], penalties: [500, 500],
  });
  assert.equal(await paidOf(userId), 0);

  const first = await approveAppeal(userId, penaltyIds[0]);
  const second = await approveAppeal(userId, penaltyIds[1]);

  assert.equal(first.refund.amount, 500);
  assert.equal(second.refund.amount, 300);
  assert.deepEqual(await refundsOf(userId), [{ amount: 500 }, { amount: 300 }]);
});

test('a refund is suspended, and the appeal stays open, when the payroll receipt is missing', async () => {
  const { userId, penaltyIds } = await paidJob({ tasks: [['completed', STARTED]], penalties: [50] });
  await withCoinTransaction((api) => api.run('DELETE FROM coin_payroll_history WHERE user_id = ?', [userId]));
  const { appeal } = await createWorkPenaltyAppeal(GUILD_ID, userId, penaltyIds[0], { reason: '測試申訴' });

  await assert.rejects(
    () => reviewWorkPenaltyAppeal(GUILD_ID, REVIEWER_ID, appeal.id, { action: 'approved' }),
    (error) => error.code === 'WORK_PAYROLL_REQUIRED' && /暫停退款/u.test(error.message)
  );

  assert.deepEqual(await refundsOf(userId), []);
  const stored = await withCoinDatabase((api) => api.get(
    'SELECT status FROM coin_work_penalty_appeals WHERE id = ?', [appeal.id]));
  assert.equal(stored.status, 'pending');
  assert.equal((await penaltyRow(penaltyIds[0])).refunded_at, null);
});

test('a rejected appeal refunds nothing', async () => {
  const { userId, penaltyIds } = await paidJob({ tasks: [['completed', STARTED]], penalties: [50] });
  const { appeal } = await createWorkPenaltyAppeal(GUILD_ID, userId, penaltyIds[0], { reason: '測試申訴' });

  const result = await reviewWorkPenaltyAppeal(GUILD_ID, REVIEWER_ID, appeal.id, { action: 'rejected' });

  assert.equal(result.refund, null);
  assert.deepEqual(await refundsOf(userId), []);
  assert.equal((await penaltyRow(penaltyIds[0])).status, 'active');
});
