'use strict';

// Tests for the venue-table statements of the work system.
//
// src/systems/work/jobCycle.js, payroll.js and workService.js read casino_venue_orders and read
// and write casino_venue_order_items. The statements live in the casino system's leaf
// module src/systems/casino/venueOrders.js.  The REFERENCE_SQL strings below are the statements copied
// byte for byte (SQL text, including the whitespace inside template literals) from the work
// files at 9d6bcc8; the comments give file and line.
//
// The caller cases run jobCycle and payroll on an api that records every statement, and require
// the venue statements, their bound values and their order to be exactly the reference ones, next to
// today's decisions.  They pass unchanged before and after the move.  The workService statements
// run inside its own scheduler transactions; test/venueWorkFlows.test.js pins them.
//
// The port cases, added with the move, run every port of src/systems/casino/venueOrders.js: each
// must run exactly its one reference statement with the reference bound values, and next to that
// statement on the same rows it must give the same return value, the same rows and the same
// changes() and last_insert_rowid().  The expected values are spelled out as well.  The ports
// that are not moved statements have cases of their own: the maker-load count (test/venueTasks.test.js
// compares the split ranking with the joined queries it replaced) and the three venue-sweep ports,
// which share the order condition of the venue sweep with the primary-task expiry sweep.
//
// Every case except the last runs in a transaction that is rolled back.  The last case,
// processDuePrimaryCycles, commits to the temporary database, so it must stay the last one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-venue-orders-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');

const {
  getCoinDatabasePath,
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const { JOB_TYPES } = require('../src/services/workService');
const jobCycle = require('../src/systems/work/jobCycle');
const payroll = require('../src/systems/work/payroll');
const venueOrders = require('../src/systems/casino/venueOrders');
const { configureWorkRewardCoordinator } = require('../src/systems/work/workRewardPort');
const { BASIC_RATIO, GLOBAL_RULE_VERSION } = require('../src/systems/work/workRules');

// Payroll pays through the coordinator the assembly root hands to the work system; here the test plays that root.
configureWorkRewardCoordinator(createRuntimeRewardCoordinator());

const VENUE_ORDERS_SOURCE = path.join(__dirname, '..', 'src', 'systems', 'casino', 'venueOrders.js');

const GUILD_ID = '340000000000000001';
const OTHER_GUILD_ID = '340000000000000002';
const CUSTOMER_ID = '340000000000000011';
const WAITER_ID = '340000000000000021';
const UNIFORM_WAITER_ID = '340000000000000022';
const SECOND_WAITER_ID = '340000000000000023';
const CHEF_ID = '340000000000000031';
const SECOND_CHEF_ID = '340000000000000032';
const THIRD_CHEF_ID = '340000000000000033';
const BARTENDER_ID = '340000000000000041';

const T0 = '2026-04-01T01:00:00.000Z';
const T1 = '2026-04-01T02:00:00.000Z';
const T2 = '2026-04-01T03:00:00.000Z';
const PAY_AT = '2026-04-03T14:00:00.000Z';
const CYCLE_START = '2026-04-04T14:00:00.000Z';
const CYCLE_END = '2026-04-06T14:00:00.000Z';

test.before(async () => {
  resetCoinDatabaseForTests();
  const databasePath = getCoinDatabasePath();
  const relative = path.relative(root, databasePath);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `synthetic data must stay inside the temporary test root: ${databasePath}`);
  await initializeNewCoinDatabase({ expectedPath: databasePath });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------
// Reference statements: src/systems/work/*.js at 9d6bcc8. Do not reformat them.
// ---------------------------------------------------------------------------------------

const REFERENCE_SQL = Object.freeze({
  // jobCycle.js:170-173 hasOpenLegacyVenueWithApi, maker check
  legacyPendingMakerItem:
    "SELECT 1 AS found FROM casino_venue_order_items WHERE maker_job_id = ? AND status = 'pending' LIMIT 1",
  // jobCycle.js:174-177 hasOpenLegacyVenueWithApi, waiter check
  legacyEscrowedWaiterOrder:
    "SELECT 1 AS found FROM casino_venue_orders WHERE waiter_job_id = ? AND tip_status = 'escrowed' LIMIT 1",
  // jobCycle.js:192-195 legacyReadyForActivation
  legacyUnpaidMakerBonusItem:
    "SELECT 1 AS found FROM casino_venue_order_items WHERE maker_job_id = ? AND status = 'completed' AND bonus_paid = 0 AND bonus_amount > 0 LIMIT 1",
  // payroll.js:9-12 hasOpenPrimaryWaiterOrderWithApi
  primaryEscrowedWaiterOrder:
    "SELECT 1 AS found FROM casino_venue_orders WHERE waiter_global_cycle_id = ? AND waiter_user_id = ? AND tip_status = 'escrowed' LIMIT 1",
  // payroll.js:17-20 verifyPrimaryWaiterOrdersWithApi, unlinked orders
  unlinkedTippedWaiterOrder:
    "SELECT 1 AS found FROM casino_venue_orders WHERE waiter_user_id = ? AND waiter_job_id IS NULL AND waiter_global_cycle_id IS NULL AND tip_amount > 0 AND tip_status IN ('escrowed','paid') LIMIT 1",
  // payroll.js:23-26 verifyPrimaryWaiterOrdersWithApi, linked orders
  primaryWaiterOrders:
    'SELECT id,guild_id,waiter_user_id,waiter_job_id,waiter_job_name,tip_amount,tip_status FROM casino_venue_orders WHERE waiter_global_cycle_id = ? ORDER BY id',
  // payroll.js:95-98 calculateGlobalPayrollWithApi, unlinked bonus items
  unlinkedMakerBonusItem:
    "SELECT 1 AS found FROM casino_venue_order_items WHERE maker_user_id = ? AND maker_is_npc = 0 AND status = 'completed' AND bonus_paid = 0 AND global_cycle_id IS NULL AND completed_at >= ? AND completed_at <= ? LIMIT 1",
  // payroll.js:101-104 calculateGlobalPayrollWithApi, linked bonus items
  primaryMakerBonusItems:
    "SELECT id,bonus_amount FROM casino_venue_order_items WHERE global_cycle_id = ? AND maker_user_id = ? AND maker_is_npc = 0 AND status = 'completed' AND bonus_paid = 0 AND bonus_amount > 0 ORDER BY completed_at,id",
  // workService.js:810-822 calculateVenueBonusForJob
  legacyMakerBonusItems: `SELECT id, bonus_amount
     FROM casino_venue_order_items
     WHERE guild_id = ?
       AND maker_user_id = ?
       AND maker_job_id = ?
       AND maker_is_npc = 0
       AND status = 'completed'
       AND bonus_paid = 0
       AND bonus_amount > 0
     ORDER BY completed_at ASC, id ASC`,
  // workService.js:2369-2372 processDuePrimaryCycles
  primaryPendingMakerItem:
    "SELECT 1 AS found FROM casino_venue_order_items WHERE global_cycle_id = ? AND status = 'pending' LIMIT 1",
  // workService.js:2410-2413 processDuePrimaryCycles
  markPrimaryMakerBonusPaid:
    'UPDATE casino_venue_order_items SET bonus_paid = 1, updated_at = ? WHERE id = ? AND global_cycle_id = ?',
  // workService.js:2593-2598 processDueJobs (legacy payroll)
  markLegacyMakerBonusPaid: `UPDATE casino_venue_order_items
             SET bonus_paid = 1, updated_at = ?
             WHERE guild_id = ? AND id = ?`,
});

// ---------------------------------------------------------------------------------------
// Synthetic rows and helpers
// ---------------------------------------------------------------------------------------

function lastInsertId(api) {
  return Number(api.get('SELECT last_insert_rowid() AS id').id);
}

function insertGuildJob(api, { userId, jobName, dailySalary = 70, status = 'active', isPaid = 0 }) {
  api.run(
    `INSERT INTO coin_jobs (
      guild_id, user_id, job_name, job_role_id, daily_salary, work_days, total_salary,
      status, is_paid, start_at, pay_at, last_contribution_at, today_task_count,
      today_completed_task_count, no_work_available_today, payroll_status, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, 2, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 'pending', ?, ?)`,
    [GUILD_ID, userId, jobName, dailySalary, dailySalary * 2, status, isPaid, T0, PAY_AT, T0, T0]
  );
  return lastInsertId(api);
}

// An active primary job with its current cycle; returns the cycle row as the scheduler reads it.
function insertPrimaryCycle(api, { userId, jobName, cycleId, dailySalary = 70 }) {
  api.run(
    `INSERT INTO coin_primary_jobs_global (
      user_id, job_name, work_days, legacy_job_id, source_guild_id, next_cycle_id, requested_at,
      not_before_at, effective_from, effective_until, state, updated_at
    ) VALUES (?, ?, 2, NULL, ?, ?, ?, NULL, ?, ?, 'active', ?)`,
    [userId, jobName, GUILD_ID, cycleId, T0, CYCLE_START, CYCLE_END, T0]
  );
  const salary = { version: GLOBAL_RULE_VERSION, dailySalary, basicRatio: BASIC_RATIO, translatorBonus: 0 };
  api.run(
    `INSERT INTO coin_primary_job_cycles (
      cycle_id, user_id, job_name, work_days, source_guild_id, starts_at, ends_at,
      salary_rule_version, salary_snapshot_json, status, reward_key, created_at, updated_at
    ) VALUES (?, ?, ?, 2, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`,
    [cycleId, userId, jobName, GUILD_ID, CYCLE_START, CYCLE_END, GLOBAL_RULE_VERSION, JSON.stringify(salary), T0, T0]
  );
  return api.get('SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ?', [cycleId]);
}

function insertVenueOrder(api, {
  waiterUserId = WAITER_ID, waiterJobId = null, waiterJobName = '服務生', waiterGlobalCycleId = null,
  tipAmount = 50, tipStatus = 'escrowed', status = 'pending', createdAt = T1,
}) {
  api.run(
    `INSERT INTO casino_venue_orders (
      guild_id, customer_id, channel_id, waiter_user_id, waiter_job_id, waiter_job_name,
      waiter_global_cycle_id, waiter_assigned_at, waiter_due_at, tip_amount, tip_status, status,
      created_at, updated_at
    ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [GUILD_ID, CUSTOMER_ID, waiterUserId, waiterJobId, waiterJobName, waiterGlobalCycleId, createdAt, createdAt,
      tipAmount, tipStatus, status, createdAt, createdAt]
  );
  return lastInsertId(api);
}

function insertVenueItem(api, {
  orderId, itemType = 'meal', makerUserId = CHEF_ID, makerJobId = null, makerJobName = '廚師', makerIsNpc = 0,
  status = 'pending', bonusAmount = 0, bonusPaid = 0, globalCycleId = null, createdAt = T1, completedAt = null,
}) {
  api.run(
    `INSERT INTO casino_venue_order_items (
      guild_id, order_id, item_type, menu_item_id, item_name, standard_steps, maker_user_id,
      maker_job_id, maker_job_name, maker_is_npc, status, bonus_amount, bonus_paid, global_cycle_id,
      created_at, completed_at, updated_at
    ) VALUES (?, ?, ?, NULL, 'synthetic item', 'synthetic step', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [GUILD_ID, orderId, itemType, makerUserId, makerJobId, makerJobName, makerIsNpc, status, bonusAmount, bonusPaid,
      globalCycleId, createdAt, completedAt, completedAt || createdAt]
  );
  return lastInsertId(api);
}

function insertLegacySettlement(api, { jobId, userId, periodKey }) {
  api.run(
    `INSERT INTO coin_work_legacy_settlements (
      job_id, period_key, user_id, source_guild_id, reward_key, amount, status, transaction_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 0, 'granted', NULL, ?, ?)`,
    [jobId, periodKey, userId, GUILD_ID, `synthetic-settlement-${jobId}`, PAY_AT, PAY_AT]
  );
}

// A paid waiter order of a primary cycle comes with the completed service task the cycle carries.
function serviceTask(orderId, userId = WAITER_ID, jobName = '服務生') {
  return {
    task_type: 'casino_venue_service', message_id: `venue-order-${orderId}`, guild_id: GUILD_ID,
    user_id: userId, job_id: null, job_name: jobName, status: 'completed',
  };
}

const ROLLBACK_MARK = Symbol('venue orders synthetic rollback');

// Runs work inside a real coin transaction and always rolls it back.
async function inRolledBackTransaction(work) {
  let outcome;
  await assert.rejects(withCoinTransaction(async (api) => {
    outcome = await work(api);
    throw Object.assign(new Error('roll back the synthetic case'), { [ROLLBACK_MARK]: true });
  }), (error) => error?.[ROLLBACK_MARK] === true);
  return outcome;
}

// Wraps the caller's api and records every statement with a copy of its bound values.
function recordStatements(api) {
  const statements = [];
  const record = (method) => (sql, params) => {
    statements.push([method, sql, params === undefined ? undefined : [...params]]);
    return api[method](sql, params);
  };
  return {
    api: { ...api, all: record('all'), get: record('get'), run: record('run') },
    venueStatements: () => statements.filter(([, sql]) => /casino_venue_/u.test(sql)),
  };
}

// Runs fn(api) on a recording api and returns its value (or error code) with the venue statements.
function callRecorded(api, fn) {
  const recorder = recordStatements(api);
  try {
    return { value: fn(recorder.api), venue: recorder.venueStatements() };
  } catch (error) {
    return { error: error?.code ?? error?.message, venue: recorder.venueStatements() };
  }
}

// ---------------------------------------------------------------------------------------
// Callers: jobCycle and payroll
// ---------------------------------------------------------------------------------------

test('the work modules keep their exports', () => {
  assert.deepEqual(Object.keys(jobCycle).sort(), [
    'activatePrimaryJobWithApi',
    'captureLegacyJobsForUserWithApi',
    'completeLegacyTaskWithApi',
    'completePrimaryTaskWithApi',
    'completeWorkTaskWithApi',
    'createGlobalPendingTaskWithApi',
    'createGlobalWorkTaskWithApi',
    'getActiveCycleForUser',
    'hasOpenLegacyVenueWithApi',
    'legacySettlementPeriodKey',
    'mapPrimary',
    'nextTaiwanPayBoundary',
    'selectPrimaryJobWithApi',
    'verifySavedSnapshot',
  ]);
  assert.deepEqual(Object.keys(payroll).sort(), [
    'calculateGlobalPayrollWithApi',
    'calculatePrimaryPenaltyRefundAmount',
    'hasOpenPrimaryWaiterOrderWithApi',
    'refundPrimaryPenaltyWithApi',
    'reviewPrimaryPenaltyAppealWithApi',
    'verifyPrimaryWaiterOrdersWithApi',
  ]);
});

test('hasOpenLegacyVenueWithApi runs the reference maker check and then the waiter check, both every time', async () => {
  const outcome = await inRolledBackTransaction((api) => {
    const jobs = {
      busyChef: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師' }),
      escrowWaiter: insertGuildJob(api, { userId: WAITER_ID, jobName: '服務生', dailySalary: 0 }),
      bothBusy: insertGuildJob(api, { userId: UNIFORM_WAITER_ID, jobName: '服務生', dailySalary: 0 }),
      quiet: insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師' }),
    };
    const escrowed = insertVenueOrder(api, { waiterJobId: jobs.escrowWaiter });
    insertVenueItem(api, { orderId: escrowed, makerJobId: jobs.busyChef });
    const both = insertVenueOrder(api, { waiterUserId: UNIFORM_WAITER_ID, waiterJobId: jobs.bothBusy });
    insertVenueItem(api, { orderId: both, makerUserId: UNIFORM_WAITER_ID, makerJobId: jobs.bothBusy });
    // Finished work of the quiet job: a completed item, a paid and a refunded tip.
    for (const tipStatus of ['paid', 'refunded', 'none']) {
      const order = insertVenueOrder(api, { waiterUserId: SECOND_CHEF_ID, waiterJobId: jobs.quiet, tipStatus });
      insertVenueItem(api, { orderId: order, makerUserId: SECOND_CHEF_ID, makerJobId: jobs.quiet, status: 'completed' });
    }
    return Object.fromEntries(Object.entries(jobs).map(([name, jobId]) => [name, {
      jobId, ...callRecorded(api, (recorded) => jobCycle.hasOpenLegacyVenueWithApi(recorded, jobId)),
    }]));
  });
  assert.deepEqual(Object.fromEntries(Object.entries(outcome).map(([name, run]) => [name, run.value])),
    { busyChef: true, escrowWaiter: true, bothBusy: true, quiet: false });
  for (const { jobId, venue } of Object.values(outcome)) {
    assert.deepEqual(venue, [
      ['get', REFERENCE_SQL.legacyPendingMakerItem, [jobId]],
      ['get', REFERENCE_SQL.legacyEscrowedWaiterOrder, [jobId]],
    ]);
  }
});

test('legacy activation waits for open venue work and unpaid bonuses with the reference statements', async () => {
  // A chef whose legacy job is paid and settled selects a primary job; the activation then checks
  // the venue rows of that legacy job before it opens the first cycle.
  const activate = (seedVenue) => inRolledBackTransaction((api) => {
    const jobId = insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師' });
    const selected = jobCycle.selectPrimaryJobWithApi(api, {
      guildId: GUILD_ID, userId: CHEF_ID, jobName: '廚師', workDays: 1, jobTypes: JOB_TYPES, timestamp: T2,
    });
    assert.deepEqual([selected.state, selected.notBeforeAt, selected.legacyCount], ['pending_legacy', PAY_AT, 1]);
    api.run("UPDATE coin_jobs SET status = 'paid', is_paid = 1 WHERE id = ?", [jobId]);
    insertLegacySettlement(api, { jobId, userId: CHEF_ID, periodKey: PAY_AT });
    seedVenue(api, jobId);
    const run = callRecorded(api, (recorded) => jobCycle.activatePrimaryJobWithApi(recorded, {
      userId: CHEF_ID, jobTypes: JOB_TYPES, calculatePayTime: () => CYCLE_END, timestamp: PAY_AT,
    }));
    return { jobId, ...run, state: api.get('SELECT state FROM coin_primary_jobs_global WHERE user_id = ?', [CHEF_ID]).state };
  });
  const openChecks = (jobId) => [
    ['get', REFERENCE_SQL.legacyPendingMakerItem, [jobId]],
    ['get', REFERENCE_SQL.legacyEscrowedWaiterOrder, [jobId]],
  ];
  const allChecks = (jobId) => [...openChecks(jobId), ['get', REFERENCE_SQL.legacyUnpaidMakerBonusItem, [jobId]]];

  const clear = await activate((api, jobId) => {
    const order = insertVenueOrder(api, { waiterJobId: null, tipStatus: 'paid' });
    insertVenueItem(api, { orderId: order, makerJobId: jobId, status: 'completed', bonusAmount: 20, bonusPaid: 1 });
    insertVenueItem(api, { orderId: order, makerJobId: jobId, status: 'completed', bonusAmount: 0 });
  });
  assert.equal(clear.error, undefined);
  assert.equal(clear.state, 'active');
  assert.equal(clear.value.state, 'active');
  assert.deepEqual(clear.venue, allChecks(clear.jobId));

  const pendingItem = await activate((api, jobId) => {
    insertVenueItem(api, { orderId: insertVenueOrder(api, {}), makerJobId: jobId });
  });
  assert.deepEqual([pendingItem.value, pendingItem.state], [null, 'pending_legacy']);
  assert.deepEqual(pendingItem.venue, openChecks(pendingItem.jobId));

  const escrowedTip = await activate((api, jobId) => {
    insertVenueOrder(api, { waiterUserId: CHEF_ID, waiterJobId: jobId });
  });
  assert.deepEqual([escrowedTip.value, escrowedTip.state], [null, 'pending_legacy']);
  assert.deepEqual(escrowedTip.venue, openChecks(escrowedTip.jobId));

  // The activation check, unlike the legacy payroll, also counts a bonus made by NPC staff.
  const unpaidBonus = await activate((api, jobId) => {
    const order = insertVenueOrder(api, { tipStatus: 'paid' });
    insertVenueItem(api, { orderId: order, makerJobId: jobId, makerIsNpc: 1, status: 'completed', bonusAmount: 15 });
  });
  assert.deepEqual([unpaidBonus.value, unpaidBonus.state], [null, 'pending_legacy']);
  assert.deepEqual(unpaidBonus.venue, allChecks(unpaidBonus.jobId));
});

test('hasOpenPrimaryWaiterOrderWithApi checks the escrowed tips of waiter cycles only', async () => {
  const outcome = await inRolledBackTransaction((api) => {
    const cycles = {
      waiter: insertPrimaryCycle(api, { userId: WAITER_ID, jobName: '服務生', cycleId: 'cycle-waiter', dailySalary: 0 }),
      uniform: insertPrimaryCycle(api, { userId: UNIFORM_WAITER_ID, jobName: '制服服務生', cycleId: 'cycle-uniform', dailySalary: 0 }),
      noEscrow: insertPrimaryCycle(api, { userId: SECOND_WAITER_ID, jobName: '服務生', cycleId: 'cycle-no-escrow', dailySalary: 0 }),
      chef: insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'cycle-chef' }),
    };
    insertVenueOrder(api, { waiterGlobalCycleId: 'cycle-waiter' });
    insertVenueOrder(api, { waiterUserId: UNIFORM_WAITER_ID, waiterJobName: '制服服務生', waiterGlobalCycleId: 'cycle-uniform' });
    // Tips that are no longer escrowed, or escrowed for another user on the cycle, do not hold it open.
    insertVenueOrder(api, { waiterUserId: SECOND_WAITER_ID, waiterGlobalCycleId: 'cycle-no-escrow', tipStatus: 'paid' });
    insertVenueOrder(api, { waiterUserId: WAITER_ID, waiterGlobalCycleId: 'cycle-no-escrow' });
    // A chef cycle is never asked, even with an escrowed order on it.
    insertVenueOrder(api, { waiterUserId: CHEF_ID, waiterGlobalCycleId: 'cycle-chef' });
    return Object.fromEntries(Object.entries(cycles).map(([name, cycle]) => [name, {
      cycle, ...callRecorded(api, (recorded) => payroll.hasOpenPrimaryWaiterOrderWithApi(recorded, cycle)),
    }]));
  });
  assert.deepEqual(Object.fromEntries(Object.entries(outcome).map(([name, run]) => [name, run.value])),
    { waiter: true, uniform: true, noEscrow: false, chef: false });
  for (const name of ['waiter', 'uniform', 'noEscrow']) {
    const { cycle, venue } = outcome[name];
    assert.deepEqual(venue, [['get', REFERENCE_SQL.primaryEscrowedWaiterOrder, [cycle.cycle_id, cycle.user_id]]], name);
  }
  assert.deepEqual(outcome.chef.venue, []);
});

test('verifyPrimaryWaiterOrdersWithApi reads unlinked and linked waiter orders with the reference statements', async () => {
  const outcome = await inRolledBackTransaction((api) => {
    const waiter = insertPrimaryCycle(api, { userId: WAITER_ID, jobName: '服務生', cycleId: 'cycle-waiter', dailySalary: 0 });
    const unlinked = insertPrimaryCycle(api, {
      userId: UNIFORM_WAITER_ID, jobName: '制服服務生', cycleId: 'cycle-unlinked', dailySalary: 0,
    });
    const conflict = insertPrimaryCycle(api, { userId: SECOND_WAITER_ID, jobName: '服務生', cycleId: 'cycle-conflict', dailySalary: 0 });
    const chef = insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'cycle-chef' });
    const linked = (cycleId, userId, tipStatus, tipAmount = 50) => insertVenueOrder(api, {
      waiterUserId: userId, waiterGlobalCycleId: cycleId, tipStatus, tipAmount,
    });
    const refunded = linked('cycle-waiter', WAITER_ID, 'refunded', 40);
    const paid = linked('cycle-waiter', WAITER_ID, 'paid');
    // Unlinked orders that do not count: no tip, a refunded tip, or a legacy job.
    insertVenueOrder(api, { waiterUserId: WAITER_ID, tipAmount: 0, tipStatus: 'paid' });
    insertVenueOrder(api, { waiterUserId: WAITER_ID, tipStatus: 'refunded' });
    insertVenueOrder(api, { waiterUserId: WAITER_ID, waiterJobId: insertGuildJob(api, { userId: WAITER_ID, jobName: '服務生' }) });
    // An unlinked escrowed tip of the second waiter stops its payroll.
    insertVenueOrder(api, { waiterUserId: UNIFORM_WAITER_ID });
    const stillEscrowed = linked('cycle-conflict', SECOND_WAITER_ID, 'escrowed');
    insertVenueOrder(api, { waiterUserId: CHEF_ID, waiterGlobalCycleId: 'cycle-chef', tipStatus: 'paid' });
    const verify = (cycle, tasks) => callRecorded(api,
      (recorded) => payroll.verifyPrimaryWaiterOrdersWithApi(recorded, cycle, tasks));
    return {
      ids: { refunded, paid, stillEscrowed },
      cycles: { waiter, unlinked, conflict },
      waiter: verify(waiter, [serviceTask(paid)]),
      missingTask: verify(waiter, []),
      unlinked: verify(unlinked, []),
      conflict: verify(conflict, []),
      chef: verify(chef, []),
    };
  });
  const { ids, cycles } = outcome;
  const bothReads = (cycle) => [
    ['get', REFERENCE_SQL.unlinkedTippedWaiterOrder, [cycle.user_id]],
    ['all', REFERENCE_SQL.primaryWaiterOrders, [cycle.cycle_id]],
  ];
  assert.deepEqual(outcome.waiter.value, [ids.refunded, ids.paid]);
  assert.deepEqual(outcome.waiter.venue, bothReads(cycles.waiter));
  assert.equal(outcome.missingTask.error, 'VENUE_WAITER_TASK_MISSING');
  assert.deepEqual(outcome.missingTask.venue, bothReads(cycles.waiter));
  assert.equal(outcome.unlinked.error, 'VENUE_WAITER_CYCLE_UNLINKED');
  assert.deepEqual(outcome.unlinked.venue, [['get', REFERENCE_SQL.unlinkedTippedWaiterOrder, [cycles.unlinked.user_id]]]);
  assert.equal(outcome.conflict.error, 'VENUE_WAITER_CYCLE_CONFLICT');
  assert.deepEqual(outcome.conflict.venue, bothReads(cycles.conflict));
  assert.deepEqual([outcome.chef.value, outcome.chef.venue], [[], []]);
});

test('calculateGlobalPayrollWithApi reads unlinked and linked maker bonuses with the reference statements', async () => {
  const outcome = await inRolledBackTransaction((api) => {
    const chef = insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'cycle-chef' });
    const unlinked = insertPrimaryCycle(api, { userId: BARTENDER_ID, jobName: '調酒師', cycleId: 'cycle-bartender', dailySalary: 60 });
    const waiter = insertPrimaryCycle(api, { userId: WAITER_ID, jobName: '服務生', cycleId: 'cycle-waiter', dailySalary: 0 });
    // The items hang on an order without a tip, so the waiter cycle has no unlinked tipped order.
    const order = insertVenueOrder(api, { tipAmount: 0, tipStatus: 'none', status: 'served' });
    const item = (fields) => insertVenueItem(api, { orderId: order, status: 'completed', ...fields });
    const later = item({ globalCycleId: 'cycle-chef', bonusAmount: 20, completedAt: '2026-04-05T03:00:00.000Z' });
    const earlier = item({ globalCycleId: 'cycle-chef', bonusAmount: 25, completedAt: '2026-04-05T01:00:00.000Z' });
    // Linked rows that do not count: NPC staff, already paid, no bonus, still pending, another maker.
    item({ globalCycleId: 'cycle-chef', bonusAmount: 20, makerIsNpc: 1, completedAt: '2026-04-05T02:00:00.000Z' });
    item({ globalCycleId: 'cycle-chef', bonusAmount: 20, bonusPaid: 1, completedAt: '2026-04-05T02:00:00.000Z' });
    item({ globalCycleId: 'cycle-chef', bonusAmount: 0, completedAt: '2026-04-05T02:00:00.000Z' });
    item({ globalCycleId: 'cycle-chef', bonusAmount: 20, status: 'pending' });
    item({ globalCycleId: 'cycle-chef', bonusAmount: 20, makerUserId: SECOND_CHEF_ID, completedAt: '2026-04-05T02:00:00.000Z' });
    // Unlinked bonus rows of the chef outside the cycle window, and one inside the bartender's window.
    item({ bonusAmount: 20, completedAt: '2026-04-04T13:59:59.999Z' });
    item({ bonusAmount: 20, completedAt: '2026-04-06T14:00:00.001Z' });
    item({ itemType: 'drink', makerUserId: BARTENDER_ID, makerJobName: '調酒師', bonusAmount: 20, completedAt: CYCLE_END });
    const calculate = (cycle) => callRecorded(api, (recorded) => payroll.calculateGlobalPayrollWithApi(recorded, cycle));
    return { ids: { later, earlier }, cycles: { chef, unlinked, waiter }, chef: calculate(chef), unlinked: calculate(unlinked), waiter: calculate(waiter) };
  });
  const { ids, cycles } = outcome;
  const unlinkedCheck = (cycle) => ['get', REFERENCE_SQL.unlinkedMakerBonusItem, [cycle.user_id, cycle.starts_at, cycle.ends_at]];
  assert.equal(outcome.chef.error, undefined);
  assert.deepEqual(outcome.chef.venue, [
    unlinkedCheck(cycles.chef),
    ['all', REFERENCE_SQL.primaryMakerBonusItems, [cycles.chef.cycle_id, cycles.chef.user_id]],
  ]);
  const { baseSalary, grossAmount, paidAmount, payRatio, venueBonus, venueItemIds, waiterOrderIds } = outcome.chef.value;
  assert.deepEqual({ baseSalary, grossAmount, paidAmount, payRatio, venueBonus, venueItemIds, waiterOrderIds }, {
    baseSalary: 140, grossAmount: 185, paidAmount: 185, payRatio: 1, venueBonus: 45,
    venueItemIds: [ids.earlier, ids.later], waiterOrderIds: [],
  });
  assert.equal(outcome.unlinked.error, 'VENUE_CYCLE_UNLINKED');
  assert.deepEqual(outcome.unlinked.venue, [unlinkedCheck(cycles.unlinked)]);
  assert.equal(outcome.waiter.error, undefined);
  assert.deepEqual(outcome.waiter.venue, [
    ['get', REFERENCE_SQL.unlinkedTippedWaiterOrder, [cycles.waiter.user_id]],
    ['all', REFERENCE_SQL.primaryWaiterOrders, [cycles.waiter.cycle_id]],
  ]);
  assert.deepEqual([outcome.waiter.value.paidAmount, outcome.waiter.value.venueItemIds], [0, []]);
});

// ---------------------------------------------------------------------------------------
// Ports: src/systems/casino/venueOrders.js
// ---------------------------------------------------------------------------------------

// Records every statement the api runs, with a copy of its bound values.
function recordEveryStatement(api) {
  const statements = [];
  const record = (method) => (sql, params) => {
    statements.push([method, sql, params === undefined ? undefined : [...params]]);
    return api[method](sql, params);
  };
  return { api: { ...api, all: record('all'), get: record('get'), run: record('run') }, statements };
}

function connectionState(api) {
  const row = api.get('SELECT changes() AS changes, last_insert_rowid() AS lastId');
  return { changes: Number(row.changes), lastId: Number(row.lastId) };
}

function readVenueTables(api) {
  return {
    casino_venue_orders: api.all('SELECT * FROM casino_venue_orders ORDER BY rowid'),
    casino_venue_order_items: api.all('SELECT * FROM casino_venue_order_items ORDER BY rowid'),
  };
}

function moveToGuild(api, table, id, guildId) {
  api.run(`UPDATE ${table} SET guild_id = ? WHERE id = ?`, [guildId, id]);
}

// Seeds once, then runs the port and the reference statement on the same rows.
async function compareWithPreB8({ seed, port, reference }) {
  return inRolledBackTransaction((api) => {
    const seeded = seed(api);
    const seededLastId = lastInsertId(api);
    api.run('SAVEPOINT venue_orders_case');
    const portResult = port(api, seeded);
    const portState = connectionState(api);
    const portRows = readVenueTables(api);
    api.run('ROLLBACK TO venue_orders_case');
    const referenceResult = reference(api, seeded);
    const referenceState = connectionState(api);
    const referenceRows = readVenueTables(api);
    api.run('RELEASE venue_orders_case');
    return { seeded, seededLastId, portResult, portState, portRows, referenceResult, referenceState, referenceRows };
  });
}

function assertSameAsPreB8(outcome) {
  assert.deepEqual(outcome.portResult, outcome.referenceResult, 'port return value differs from the reference statement');
  assert.deepEqual(outcome.portState, outcome.referenceState, 'changes() or last_insert_rowid() differs from the reference statement');
  assert.deepEqual(outcome.portRows, outcome.referenceRows, 'port rows differ from the reference statement');
}

const FOUND = Object.freeze({ found: 1 });
// Ports that are not moved statements; each has a case of its own.
const NOT_MOVED_PORTS = Object.freeze([
  'countMakerItemsInWindowWithApi',
  'findVenueSweepOrderForTaskWithApi',
  'listVenueSweepDueOrdersWithApi',
  'listVenueSweepWaiterTaskKeysWithApi',
]);

test('venueOrders is a leaf module of *WithApi ports that never controls a transaction or reads the clock', () => {
  const source = fs.readFileSync(VENUE_ORDERS_SOURCE, 'utf8');
  assert.doesNotMatch(source, /\brequire\s*\(/u, 'a leaf module must not load other modules');
  assert.doesNotMatch(source, /\bimport\b/u);
  assert.doesNotMatch(source, /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/u, 'the caller owns the transaction');
  assert.doesNotMatch(source, /withCoin(Transaction|Database)/u);
  assert.doesNotMatch(source, /new Date\(|Date\.now\(/u, 'every timestamp must come from the caller');

  assert.deepEqual(Object.keys(venueOrders).sort(), [
    'countMakerItemsInWindowWithApi',
    'findEscrowedLegacyWaiterOrderWithApi',
    'findEscrowedPrimaryWaiterOrderWithApi',
    'findPendingLegacyMakerItemWithApi',
    'findPendingPrimaryMakerItemWithApi',
    'findUnlinkedMakerBonusItemWithApi',
    'findUnlinkedTippedWaiterOrderWithApi',
    'findUnpaidLegacyMakerBonusItemWithApi',
    'findVenueSweepOrderForTaskWithApi',
    'listPrimaryWaiterOrdersWithApi',
    'listUnpaidLegacyMakerBonusItemsWithApi',
    'listUnpaidPrimaryMakerBonusItemsWithApi',
    'listVenueSweepDueOrdersWithApi',
    'listVenueSweepWaiterTaskKeysWithApi',
    'markLegacyMakerBonusPaidWithApi',
    'markPrimaryMakerBonusPaidWithApi',
  ]);
  for (const [name, port] of Object.entries(venueOrders)) {
    assert.equal(typeof port, 'function', name);
    assert.ok(port.length >= 1, `${name} takes the caller's api first`);
  }
});

test('every port runs exactly its reference statement with the reference bound values and returns what the api returned', async () => {
  const cases = [
    ['findPendingLegacyMakerItemWithApi', [11], 'get', REFERENCE_SQL.legacyPendingMakerItem, [11]],
    ['findEscrowedLegacyWaiterOrderWithApi', [12], 'get', REFERENCE_SQL.legacyEscrowedWaiterOrder, [12]],
    ['findUnpaidLegacyMakerBonusItemWithApi', [13], 'get', REFERENCE_SQL.legacyUnpaidMakerBonusItem, [13]],
    ['listUnpaidLegacyMakerBonusItemsWithApi', [{ guildId: GUILD_ID, userId: CHEF_ID, jobId: 14 }],
      'all', REFERENCE_SQL.legacyMakerBonusItems, [GUILD_ID, CHEF_ID, 14]],
    ['markLegacyMakerBonusPaidWithApi', [{ guildId: GUILD_ID, itemId: 15, timestamp: T2 }],
      'run', REFERENCE_SQL.markLegacyMakerBonusPaid, [T2, GUILD_ID, 15]],
    ['findEscrowedPrimaryWaiterOrderWithApi', [{ cycleId: 'cycle-cycle', userId: WAITER_ID }],
      'get', REFERENCE_SQL.primaryEscrowedWaiterOrder, ['cycle-cycle', WAITER_ID]],
    ['findUnlinkedTippedWaiterOrderWithApi', [WAITER_ID], 'get', REFERENCE_SQL.unlinkedTippedWaiterOrder, [WAITER_ID]],
    ['listPrimaryWaiterOrdersWithApi', ['cycle-cycle'], 'all', REFERENCE_SQL.primaryWaiterOrders, ['cycle-cycle']],
    ['findPendingPrimaryMakerItemWithApi', ['cycle-cycle'], 'get', REFERENCE_SQL.primaryPendingMakerItem, ['cycle-cycle']],
    ['findUnlinkedMakerBonusItemWithApi', [{ userId: CHEF_ID, startsAt: CYCLE_START, endsAt: CYCLE_END }],
      'get', REFERENCE_SQL.unlinkedMakerBonusItem, [CHEF_ID, CYCLE_START, CYCLE_END]],
    ['listUnpaidPrimaryMakerBonusItemsWithApi', [{ cycleId: 'cycle-cycle', userId: CHEF_ID }],
      'all', REFERENCE_SQL.primaryMakerBonusItems, ['cycle-cycle', CHEF_ID]],
    ['markPrimaryMakerBonusPaidWithApi', [{ itemId: 16, cycleId: 'cycle-cycle', timestamp: T2 }],
      'run', REFERENCE_SQL.markPrimaryMakerBonusPaid, [T2, 16, 'cycle-cycle']],
  ];
  const movedPorts = Object.keys(venueOrders)
    .filter((name) => !NOT_MOVED_PORTS.includes(name));
  assert.deepEqual(cases.map(([name]) => name).sort(), movedPorts.sort(), 'every moved port has a case');
  await inRolledBackTransaction((api) => {
    insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'cycle-cycle' });
    const order = insertVenueOrder(api, { waiterGlobalCycleId: 'cycle-cycle' });
    insertVenueItem(api, { orderId: order, globalCycleId: 'cycle-cycle', status: 'completed', bonusAmount: 20, completedAt: CYCLE_END });
    for (const [name, args, method, sql, params] of cases) {
      const recorder = recordEveryStatement(api);
      const value = venueOrders[name](recorder.api, ...args);
      assert.deepEqual(recorder.statements, [[method, sql, params]], name);
      assert.deepEqual(value, api[method](sql, params), `${name} returns what api.${method} returned`);
    }
  });
});

test('legacy job checks match the reference reads: pending maker items, escrowed waiter tips and unpaid bonuses', async () => {
  const outcome = await compareWithPreB8({
    seed: (api) => {
      const jobs = {
        busyChef: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師' }),
        escrowWaiter: insertGuildJob(api, { userId: WAITER_ID, jobName: '服務生', dailySalary: 0 }),
        npcBonus: insertGuildJob(api, { userId: BARTENDER_ID, jobName: '調酒師', dailySalary: 60 }),
        settled: insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師' }),
      };
      const order = insertVenueOrder(api, { waiterJobId: jobs.escrowWaiter });
      insertVenueItem(api, { orderId: order, makerJobId: jobs.busyChef });
      insertVenueItem(api, { orderId: order, makerJobId: jobs.busyChef, status: 'completed', bonusAmount: 20 });
      insertVenueItem(api, {
        orderId: order, makerUserId: BARTENDER_ID, makerJobId: jobs.npcBonus, makerIsNpc: 1, status: 'completed', bonusAmount: 15,
      });
      // Settled work: paid and zero bonuses, a cancelled item, and paid, refunded or untipped orders.
      const settledItem = (fields) => insertVenueItem(api, {
        orderId: order, makerUserId: SECOND_CHEF_ID, makerJobId: jobs.settled, ...fields,
      });
      settledItem({ status: 'completed', bonusAmount: 20, bonusPaid: 1 });
      settledItem({ status: 'completed', bonusAmount: 0 });
      settledItem({ status: 'cancelled', bonusAmount: 20 });
      for (const tipStatus of ['paid', 'refunded', 'none']) {
        insertVenueOrder(api, { waiterUserId: SECOND_CHEF_ID, waiterJobId: jobs.settled, tipStatus });
      }
      return jobs;
    },
    port: (api, jobs) => Object.fromEntries(Object.entries(jobs).map(([name, jobId]) => [name, [
      venueOrders.findPendingLegacyMakerItemWithApi(api, jobId),
      venueOrders.findEscrowedLegacyWaiterOrderWithApi(api, jobId),
      venueOrders.findUnpaidLegacyMakerBonusItemWithApi(api, jobId),
    ]])),
    reference: (api, jobs) => Object.fromEntries(Object.entries(jobs).map(([name, jobId]) => [name, [
      api.get(REFERENCE_SQL.legacyPendingMakerItem, [jobId]),
      api.get(REFERENCE_SQL.legacyEscrowedWaiterOrder, [jobId]),
      api.get(REFERENCE_SQL.legacyUnpaidMakerBonusItem, [jobId]),
    ]])),
  });
  assertSameAsPreB8(outcome);
  assert.deepEqual(outcome.portResult, {
    busyChef: [FOUND, null, FOUND],
    escrowWaiter: [null, FOUND, null],
    npcBonus: [null, null, FOUND],
    settled: [null, null, null],
  });
  assert.equal(outcome.portState.lastId, outcome.seededLastId);
});

test('listUnpaidLegacyMakerBonusItemsWithApi lists the unpaid bonuses a legacy job made itself, oldest first', async () => {
  const outcome = await compareWithPreB8({
    seed: (api) => {
      const job = insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師' });
      const otherJob = insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師' });
      const order = insertVenueOrder(api, {});
      const item = (fields) => insertVenueItem(api, {
        orderId: order, makerJobId: job, status: 'completed', bonusAmount: 20, ...fields,
      });
      const ids = {
        latest: item({ completedAt: T2 }),
        earliest: item({ bonusAmount: 15, completedAt: T1 }),
        tie: item({ bonusAmount: 10, completedAt: T1 }),
      };
      // Rows that do not count: another guild, maker or job, NPC staff, not completed, paid, no bonus.
      moveToGuild(api, 'casino_venue_order_items', item({ completedAt: T1 }), OTHER_GUILD_ID);
      item({ makerUserId: SECOND_CHEF_ID, completedAt: T1 });
      item({ makerJobId: otherJob, completedAt: T1 });
      item({ makerIsNpc: 1, completedAt: T1 });
      item({ status: 'pending' });
      item({ status: 'cancelled', completedAt: T1 });
      item({ bonusPaid: 1, completedAt: T1 });
      item({ bonusAmount: 0, completedAt: T1 });
      return { job, ids };
    },
    port: (api, { job }) => venueOrders.listUnpaidLegacyMakerBonusItemsWithApi(api, { guildId: GUILD_ID, userId: CHEF_ID, jobId: job }),
    reference: (api, { job }) => api.all(REFERENCE_SQL.legacyMakerBonusItems, [GUILD_ID, CHEF_ID, job]),
  });
  assertSameAsPreB8(outcome);
  const { ids } = outcome.seeded;
  assert.deepEqual(outcome.portResult, [
    { id: ids.earliest, bonus_amount: 15 },
    { id: ids.tie, bonus_amount: 10 },
    { id: ids.latest, bonus_amount: 20 },
  ]);
});

test('primary waiter reads match the reference payroll checks', async () => {
  const outcome = await compareWithPreB8({
    seed: (api) => {
      insertPrimaryCycle(api, { userId: WAITER_ID, jobName: '服務生', cycleId: 'cycle-waiter', dailySalary: 0 });
      insertPrimaryCycle(api, { userId: SECOND_WAITER_ID, jobName: '服務生', cycleId: 'cycle-idle', dailySalary: 0 });
      const linked = (userId, tipStatus) => insertVenueOrder(api, { waiterUserId: userId, waiterGlobalCycleId: 'cycle-waiter', tipStatus });
      const ids = {
        escrowed: linked(WAITER_ID, 'escrowed'),
        paid: linked(WAITER_ID, 'paid'),
        otherWaiter: linked(SECOND_WAITER_ID, 'escrowed'),
      };
      moveToGuild(api, 'casino_venue_orders', ids.paid, OTHER_GUILD_ID);
      // Unlinked orders: only a tipped, escrowed or paid one without a legacy job counts.
      insertVenueOrder(api, { waiterUserId: WAITER_ID, tipAmount: 30, tipStatus: 'paid' });
      insertVenueOrder(api, { waiterUserId: UNIFORM_WAITER_ID, waiterJobName: '制服服務生', tipAmount: 100 });
      insertVenueOrder(api, { waiterUserId: SECOND_WAITER_ID, tipAmount: 0, tipStatus: 'paid' });
      insertVenueOrder(api, { waiterUserId: SECOND_WAITER_ID, tipAmount: 10, tipStatus: 'refunded' });
      const legacyJob = insertGuildJob(api, { userId: SECOND_WAITER_ID, jobName: '服務生', dailySalary: 0 });
      insertVenueOrder(api, { waiterUserId: SECOND_WAITER_ID, waiterJobId: legacyJob });
      return ids;
    },
    port: (api) => ({
      escrowed: [WAITER_ID, SECOND_WAITER_ID, UNIFORM_WAITER_ID]
        .map((userId) => venueOrders.findEscrowedPrimaryWaiterOrderWithApi(api, { cycleId: 'cycle-waiter', userId })),
      escrowedIdle: venueOrders.findEscrowedPrimaryWaiterOrderWithApi(api, { cycleId: 'cycle-idle', userId: SECOND_WAITER_ID }),
      unlinked: [WAITER_ID, UNIFORM_WAITER_ID, SECOND_WAITER_ID]
        .map((userId) => venueOrders.findUnlinkedTippedWaiterOrderWithApi(api, userId)),
      orders: ['cycle-waiter', 'cycle-idle'].map((cycleId) => venueOrders.listPrimaryWaiterOrdersWithApi(api, cycleId)),
    }),
    reference: (api) => ({
      escrowed: [WAITER_ID, SECOND_WAITER_ID, UNIFORM_WAITER_ID]
        .map((userId) => api.get(REFERENCE_SQL.primaryEscrowedWaiterOrder, ['cycle-waiter', userId])),
      escrowedIdle: api.get(REFERENCE_SQL.primaryEscrowedWaiterOrder, ['cycle-idle', SECOND_WAITER_ID]),
      unlinked: [WAITER_ID, UNIFORM_WAITER_ID, SECOND_WAITER_ID]
        .map((userId) => api.get(REFERENCE_SQL.unlinkedTippedWaiterOrder, [userId])),
      orders: ['cycle-waiter', 'cycle-idle'].map((cycleId) => api.all(REFERENCE_SQL.primaryWaiterOrders, [cycleId])),
    }),
  });
  assertSameAsPreB8(outcome);
  const ids = outcome.seeded;
  const row = (id, waiterUserId, tipStatus, guildId = GUILD_ID) => ({
    id, guild_id: guildId, waiter_user_id: waiterUserId, waiter_job_id: null, waiter_job_name: '服務生',
    tip_amount: 50, tip_status: tipStatus,
  });
  assert.deepEqual(outcome.portResult, {
    escrowed: [FOUND, FOUND, null],
    escrowedIdle: null,
    unlinked: [FOUND, FOUND, null],
    orders: [[
      row(ids.escrowed, WAITER_ID, 'escrowed'),
      row(ids.paid, WAITER_ID, 'paid', OTHER_GUILD_ID),
      row(ids.otherWaiter, SECOND_WAITER_ID, 'escrowed'),
    ], []],
  });
});

test('primary maker reads match the reference settlement checks, both window ends included', async () => {
  const outcome = await compareWithPreB8({
    seed: (api) => {
      insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'cycle-chef' });
      insertPrimaryCycle(api, { userId: BARTENDER_ID, jobName: '調酒師', cycleId: 'cycle-idle', dailySalary: 60 });
      const order = insertVenueOrder(api, { tipAmount: 0, tipStatus: 'none' });
      const item = (fields) => insertVenueItem(api, { orderId: order, status: 'completed', ...fields });
      const linked = (fields) => item({ globalCycleId: 'cycle-chef', bonusAmount: 20, ...fields });
      const ids = {
        latest: linked({ completedAt: '2026-04-05T03:00:00.000Z' }),
        earliest: linked({ bonusAmount: 25, completedAt: '2026-04-05T01:00:00.000Z' }),
        tie: linked({ bonusAmount: 30, completedAt: '2026-04-05T01:00:00.000Z' }),
        otherMaker: linked({ makerUserId: SECOND_CHEF_ID, completedAt: '2026-04-05T02:00:00.000Z' }),
      };
      // Linked rows of the chef that do not count: NPC staff, already paid, no bonus, pending.
      linked({ makerIsNpc: 1, completedAt: '2026-04-05T02:00:00.000Z' });
      linked({ bonusPaid: 1, completedAt: '2026-04-05T02:00:00.000Z' });
      linked({ bonusAmount: 0, completedAt: '2026-04-05T02:00:00.000Z' });
      linked({ status: 'pending' });
      // Unlinked rows: the chef finished one exactly at the window start, the bartender one exactly at
      // the window end, and the third chef one without a bonus (the check does not read the amount).
      item({ completedAt: CYCLE_START });
      item({ makerUserId: BARTENDER_ID, makerJobName: '調酒師', itemType: 'drink', bonusAmount: 20, completedAt: CYCLE_END });
      item({ makerUserId: THIRD_CHEF_ID, completedAt: '2026-04-05T00:00:00.000Z' });
      // The second chef's unlinked rows do not count: outside the window, NPC staff, paid or cancelled.
      const secondChef = (fields) => item({ makerUserId: SECOND_CHEF_ID, bonusAmount: 20, ...fields });
      secondChef({ completedAt: '2026-04-04T13:59:59.999Z' });
      secondChef({ completedAt: '2026-04-06T14:00:00.001Z' });
      secondChef({ makerIsNpc: 1, completedAt: '2026-04-05T00:00:00.000Z' });
      secondChef({ bonusPaid: 1, completedAt: '2026-04-05T00:00:00.000Z' });
      secondChef({ status: 'cancelled', completedAt: '2026-04-05T00:00:00.000Z' });
      return ids;
    },
    port: (api) => ({
      pending: ['cycle-chef', 'cycle-idle'].map((cycleId) => venueOrders.findPendingPrimaryMakerItemWithApi(api, cycleId)),
      unlinked: [CHEF_ID, BARTENDER_ID, THIRD_CHEF_ID, SECOND_CHEF_ID].map((userId) => venueOrders
        .findUnlinkedMakerBonusItemWithApi(api, { userId, startsAt: CYCLE_START, endsAt: CYCLE_END })),
      unlinkedShorterWindow: venueOrders.findUnlinkedMakerBonusItemWithApi(api, {
        userId: CHEF_ID, startsAt: '2026-04-04T14:00:00.001Z', endsAt: CYCLE_END,
      }),
      bonuses: [['cycle-chef', CHEF_ID], ['cycle-chef', SECOND_CHEF_ID], ['cycle-idle', BARTENDER_ID]].map(([cycleId, userId]) =>
        venueOrders.listUnpaidPrimaryMakerBonusItemsWithApi(api, { cycleId, userId })),
    }),
    reference: (api) => ({
      pending: ['cycle-chef', 'cycle-idle'].map((cycleId) => api.get(REFERENCE_SQL.primaryPendingMakerItem, [cycleId])),
      unlinked: [CHEF_ID, BARTENDER_ID, THIRD_CHEF_ID, SECOND_CHEF_ID]
        .map((userId) => api.get(REFERENCE_SQL.unlinkedMakerBonusItem, [userId, CYCLE_START, CYCLE_END])),
      unlinkedShorterWindow: api.get(REFERENCE_SQL.unlinkedMakerBonusItem, [CHEF_ID, '2026-04-04T14:00:00.001Z', CYCLE_END]),
      bonuses: [['cycle-chef', CHEF_ID], ['cycle-chef', SECOND_CHEF_ID], ['cycle-idle', BARTENDER_ID]].map(([cycleId, userId]) =>
        api.all(REFERENCE_SQL.primaryMakerBonusItems, [cycleId, userId])),
    }),
  });
  assertSameAsPreB8(outcome);
  const ids = outcome.seeded;
  assert.deepEqual(outcome.portResult, {
    pending: [FOUND, null],
    unlinked: [FOUND, FOUND, FOUND, null],
    unlinkedShorterWindow: null,
    bonuses: [[
      { id: ids.earliest, bonus_amount: 25 },
      { id: ids.tie, bonus_amount: 30 },
      { id: ids.latest, bonus_amount: 20 },
    ], [{ id: ids.otherMaker, bonus_amount: 20 }], []],
  });
});

test('the bonus updates mark the reference rows and leave changes() and last_insert_rowid() as the reference statements did', async () => {
  const seed = (api) => {
    insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'cycle-chef' });
    const order = insertVenueOrder(api, { tipStatus: 'paid' });
    const item = (fields) => insertVenueItem(api, {
      orderId: order, status: 'completed', bonusAmount: 20, completedAt: T1, ...fields,
    });
    const ids = {
      primary: item({ globalCycleId: 'cycle-chef' }),
      primaryOtherGuild: item({ globalCycleId: 'cycle-chef' }),
      legacy: item({}),
      legacyOtherGuild: item({}),
      alreadyPaid: item({ bonusPaid: 1 }),
    };
    moveToGuild(api, 'casino_venue_order_items', ids.primaryOtherGuild, OTHER_GUILD_ID);
    moveToGuild(api, 'casino_venue_order_items', ids.legacyOtherGuild, OTHER_GUILD_ID);
    return ids;
  };
  const cases = [
    // [label, update, its arguments, expected changes(), the item it stamps or null]
    ['primary item', 'primary', (ids) => ({ itemId: ids.primary, cycleId: 'cycle-chef' }), 1, 'primary'],
    ['primary item of another guild: no guild check', 'primary',
      (ids) => ({ itemId: ids.primaryOtherGuild, cycleId: 'cycle-chef' }), 1, 'primaryOtherGuild'],
    ['legacy item on the primary update', 'primary', (ids) => ({ itemId: ids.legacy, cycleId: 'cycle-chef' }), 0, null],
    ['legacy item', 'legacy', (ids) => ({ guildId: GUILD_ID, itemId: ids.legacy }), 1, 'legacy'],
    ['primary item on the legacy update: no cycle check', 'legacy', (ids) => ({ guildId: GUILD_ID, itemId: ids.primary }), 1, 'primary'],
    ['legacy item of another guild', 'legacy', (ids) => ({ guildId: GUILD_ID, itemId: ids.legacyOtherGuild }), 0, null],
    ['an already paid item is stamped again', 'legacy', (ids) => ({ guildId: GUILD_ID, itemId: ids.alreadyPaid }), 1, 'alreadyPaid'],
  ];
  for (const [label, kind, args, expectedChanges, stampedItem] of cases) {
    const outcome = await compareWithPreB8({
      seed,
      port: (api, ids) => (kind === 'primary'
        ? venueOrders.markPrimaryMakerBonusPaidWithApi(api, { ...args(ids), timestamp: T2 })
        : venueOrders.markLegacyMakerBonusPaidWithApi(api, { ...args(ids), timestamp: T2 })),
      reference: (api, ids) => {
        const values = args(ids);
        return kind === 'primary'
          ? api.run(REFERENCE_SQL.markPrimaryMakerBonusPaid, [T2, values.itemId, values.cycleId])
          : api.run(REFERENCE_SQL.markLegacyMakerBonusPaid, [T2, values.guildId, values.itemId]);
      },
    });
    assertSameAsPreB8(outcome);
    assert.equal(outcome.portResult, undefined, label);
    assert.deepEqual(outcome.portState, { changes: expectedChanges, lastId: outcome.seededLastId }, label);
    const stamped = outcome.portRows.casino_venue_order_items
      .filter((row) => row.updated_at === T2)
      .map((row) => [row.id, row.bonus_paid]);
    assert.deepEqual(stamped, stampedItem ? [[outcome.seeded[stampedItem], 1]] : [], label);
  }
});

// The venue half of the two least-busy maker queries. Its conditions are those
// of the joined global query at 89378c5 (src/systems/work/venueTasks.js:92-93), word for word:
//   LEFT JOIN casino_venue_order_items i ON i.guild_id = ? AND i.maker_user_id = p.user_id
//     AND i.item_type = ? AND i.maker_is_npc = 0 AND i.created_at >= ? AND i.created_at < ?
const SPLIT_LOAD_CONDITIONS = 'AND i.item_type = ? AND i.maker_is_npc = 0 AND i.created_at >= ? AND i.created_at < ?';
const LOAD_WINDOW = Object.freeze({ startIso: '2026-03-31T16:00:00.000Z', endIso: '2026-04-01T16:00:00.000Z' });

test('countMakerItemsInWindowWithApi counts each maker\'s items with the venue conditions of the joined least-busy queries', async () => {
  const outcome = await inRolledBackTransaction((api) => {
    const order = insertVenueOrder(api, {});
    const item = (fields) => insertVenueItem(api, { orderId: order, ...fields });
    for (const status of ['pending', 'completed', 'cancelled', 'odd']) item({ makerUserId: CHEF_ID, status });
    // SECOND_CHEF: only the meal made at the very start of the window counts, and one drink.
    item({ makerUserId: SECOND_CHEF_ID, createdAt: LOAD_WINDOW.startIso });
    item({ makerUserId: SECOND_CHEF_ID, createdAt: LOAD_WINDOW.endIso });
    item({ makerUserId: SECOND_CHEF_ID, createdAt: '2026-03-31T15:59:59.999Z' });
    item({ makerUserId: SECOND_CHEF_ID, makerIsNpc: 1 });
    item({ makerUserId: SECOND_CHEF_ID, itemType: 'drink' });
    moveToGuild(api, 'casino_venue_order_items', item({ makerUserId: SECOND_CHEF_ID }), OTHER_GUILD_ID);
    // Items without a maker form a group of their own, which no candidate matches.
    item({ makerUserId: null });
    item({ makerUserId: null, status: 'completed' });
    item({ makerUserId: BARTENDER_ID, itemType: 'drink' });
    const recorder = recordEveryStatement(api);
    const meal = venueOrders.countMakerItemsInWindowWithApi(recorder.api, { guildId: GUILD_ID, itemType: 'meal', ...LOAD_WINDOW });
    const drink = venueOrders.countMakerItemsInWindowWithApi(api, { guildId: GUILD_ID, itemType: 'drink', ...LOAD_WINDOW });
    return { statements: recorder.statements, meal, drink };
  });
  assert.equal(outcome.statements.length, 1);
  const [[method, sql, params]] = outcome.statements;
  assert.equal(method, 'all');
  assert.ok(sql.includes('WHERE i.guild_id = ?') && sql.includes(SPLIT_LOAD_CONDITIONS), 'the venue conditions are copied word for word');
  assert.doesNotMatch(sql, /\bcoin_/u, 'the venue half names no work table');
  assert.deepEqual(params, [GUILD_ID, 'meal', LOAD_WINDOW.startIso, LOAD_WINDOW.endIso]);
  const byMaker = (rows) => Object.fromEntries(rows.map((row) => [String(row.maker_user_id), row.assigned_count]));
  assert.deepEqual(byMaker(outcome.meal), { null: 2, [CHEF_ID]: 4, [SECOND_CHEF_ID]: 1 });
  assert.deepEqual(byMaker(outcome.drink), { [BARTENDER_ID]: 1, [SECOND_CHEF_ID]: 1 });
});

// The order condition the three venue-sweep ports share, as the venue sweep must apply it.
const VENUE_SWEEP_ORDER_CONDITION = "o.tip_status = 'escrowed' AND o.served_at IS NULL AND o.tip_amount > 0";

test('the venue-sweep ports share one order condition: escrowed, unserved, with a positive tip', async () => {
  const outcome = await inRolledBackTransaction((api) => {
    const order = (fields = {}) => insertVenueOrder(api, { createdAt: T0, ...fields });
    const ids = {
      open: order(),
      // The sweep closes it once its pending item has been handed to NPC staff; until then it is
      // not due, but its waiter task is still the sweep's.
      openWithPendingItem: order(),
      openLater: order({ createdAt: T2 }),
      served: order(),
      noTip: order({ tipAmount: 0 }),
      paid: order({ tipStatus: 'paid' }),
      refunded: order({ tipStatus: 'refunded' }),
      none: order({ tipStatus: 'none', tipAmount: 0 }),
      elsewhere: order(),
    };
    insertVenueItem(api, { orderId: ids.openWithPendingItem, status: 'pending', createdAt: T0 });
    insertVenueItem(api, { orderId: ids.open, status: 'completed', createdAt: T0, completedAt: T0 });
    api.run('UPDATE casino_venue_orders SET served_at = ?, served_by = ? WHERE id = ?', [T1, WAITER_ID, ids.served]);
    moveToGuild(api, 'casino_venue_orders', ids.elsewhere, OTHER_GUILD_ID);

    const recorder = recordEveryStatement(api);
    const keys = venueOrders.listVenueSweepWaiterTaskKeysWithApi(recorder.api);
    const found = venueOrders.findVenueSweepOrderForTaskWithApi(recorder.api, {
      guildId: GUILD_ID, messageId: `venue-order-${ids.open}`,
    });
    const due = venueOrders.listVenueSweepDueOrdersWithApi(recorder.api, { cutoff: T1 });
    const findFor = (guildId, messageId) => Boolean(venueOrders.findVenueSweepOrderForTaskWithApi(api, { guildId, messageId }));
    return {
      ids,
      statements: recorder.statements,
      keys,
      found,
      dueIds: due.map((row) => row.id),
      dueRow: due[0],
      lookups: {
        open: findFor(GUILD_ID, `venue-order-${ids.open}`),
        openWithPendingItem: findFor(GUILD_ID, `venue-order-${ids.openWithPendingItem}`),
        openLater: findFor(GUILD_ID, `venue-order-${ids.openLater}`),
        served: findFor(GUILD_ID, `venue-order-${ids.served}`),
        noTip: findFor(GUILD_ID, `venue-order-${ids.noTip}`),
        paid: findFor(GUILD_ID, `venue-order-${ids.paid}`),
        refunded: findFor(GUILD_ID, `venue-order-${ids.refunded}`),
        none: findFor(GUILD_ID, `venue-order-${ids.none}`),
        elsewhereFromThisGuild: findFor(GUILD_ID, `venue-order-${ids.elsewhere}`),
        elsewhereFromItsGuild: findFor(OTHER_GUILD_ID, `venue-order-${ids.elsewhere}`),
        // The venue sweep closes the task whose message id is exactly 'venue-order-<id>'.
        paddedId: findFor(GUILD_ID, `venue-order-0${ids.open}`),
        itemMessage: findFor(GUILD_ID, `venue-item-${ids.open}`),
      },
      fullRow: api.get('SELECT * FROM casino_venue_orders WHERE id = ?', [ids.open]),
    };
  });
  const { ids } = outcome;
  assert.deepEqual(outcome.statements, [
    ['all', `SELECT o.guild_id, 'venue-order-' || o.id AS message_id FROM casino_venue_orders o WHERE ${VENUE_SWEEP_ORDER_CONDITION} ORDER BY o.id`, undefined],
    ['get', `SELECT 1 AS found FROM casino_venue_orders o WHERE o.guild_id = ? AND 'venue-order-' || o.id = ? AND ${VENUE_SWEEP_ORDER_CONDITION} LIMIT 1`,
      [GUILD_ID, `venue-order-${ids.open}`]],
    ['all', `SELECT o.*
     FROM casino_venue_orders o
     WHERE ${VENUE_SWEEP_ORDER_CONDITION}
       AND o.created_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM casino_venue_order_items i
         WHERE i.guild_id = o.guild_id
           AND i.order_id = o.id
           AND i.status = ?
       )
     ORDER BY o.id`, [T1, 'pending']],
  ]);
  assert.deepEqual(outcome.keys, [ids.open, ids.openWithPendingItem, ids.openLater, ids.elsewhere].map((id) => ({
    guild_id: id === ids.elsewhere ? OTHER_GUILD_ID : GUILD_ID, message_id: `venue-order-${id}`,
  })));
  assert.deepEqual(outcome.found, FOUND);
  assert.deepEqual(outcome.lookups, {
    open: true, openWithPendingItem: true, openLater: true, served: false, noTip: false, paid: false, refunded: false,
    none: false, elsewhereFromThisGuild: false, elsewhereFromItsGuild: true, paddedId: false, itemMessage: false,
  });
  // Due now: old enough and no pending item; the order elsewhere is due in its own guild.
  assert.deepEqual(outcome.dueIds, [ids.open, ids.elsewhere]);
  assert.deepEqual(outcome.dueRow, outcome.fullRow);
});

// The scheduler opens its own transactions, so this case commits its rows.  It stays the last case
// of the file; the temporary database is removed after it.
test('processDuePrimaryCycles waits while a maker item of the cycle is pending, then marks its bonus paid once', async (t) => {
  const { processDuePrimaryCycles } = require('../src/services/workService');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(CYCLE_END) });
  const seeded = await withCoinTransaction((api) => {
    insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'cycle-due-chef' });
    const order = insertVenueOrder(api, { tipAmount: 0, tipStatus: 'none', status: 'served' });
    return {
      bonusItem: insertVenueItem(api, {
        orderId: order, globalCycleId: 'cycle-due-chef', status: 'completed', bonusAmount: 20,
        completedAt: '2026-04-05T01:00:00.000Z',
      }),
      pendingItem: insertVenueItem(api, { orderId: order, globalCycleId: 'cycle-due-chef' }),
    };
  });
  const readState = () => withCoinTransaction((api) => ({
    cycle: api.get("SELECT status FROM coin_primary_job_cycles WHERE cycle_id = 'cycle-due-chef'").status,
    items: api.all('SELECT id, bonus_paid, updated_at FROM casino_venue_order_items ORDER BY id')
      .map((row) => [row.id, row.bonus_paid, row.updated_at]),
    payroll: api.all("SELECT gross_amount, paid_amount, settled_at FROM coin_primary_cycle_payroll WHERE cycle_id = 'cycle-due-chef'"),
  }));

  assert.deepEqual(await processDuePrimaryCycles(null), { checked: 1, settled: 0, failed: 0, roleCleanupFailed: 0 });
  assert.deepEqual(await readState(), {
    cycle: 'active',
    items: [[seeded.bonusItem, 0, '2026-04-05T01:00:00.000Z'], [seeded.pendingItem, 0, T1]],
    payroll: [],
  });

  const finishedAt = '2026-04-06T15:00:00.000Z';
  await withCoinTransaction((api) => api.run(
    "UPDATE casino_venue_order_items SET status = 'completed', completed_at = ?, updated_at = ? WHERE id = ?",
    [finishedAt, finishedAt, seeded.pendingItem]
  ));
  const settledAt = '2026-04-06T16:00:00.000Z';
  t.mock.timers.setTime(Date.parse(settledAt));
  assert.deepEqual(await processDuePrimaryCycles(null), { checked: 1, settled: 1, failed: 0, roleCleanupFailed: 0 });
  assert.deepEqual(await readState(), {
    cycle: 'settled',
    items: [[seeded.bonusItem, 1, settledAt], [seeded.pendingItem, 0, finishedAt]],
    payroll: [{ gross_amount: 160, paid_amount: 160, settled_at: settledAt }],
  });
  assert.deepEqual(await processDuePrimaryCycles(null), { checked: 0, settled: 0, failed: 0, roleCleanupFailed: 0 });
});
