'use strict';

// Unit tests for src/systems/work/venueTasks.js.
//
// Every port runs inside a real sql.js coin transaction on a fresh synthetic COIN_DB_PATH and
// is compared with the statements it replaced.  The reference* functions below are those
// statements copied byte for byte (SQL text, bound values and their order) from
// src/services/venueService.js at 1d3fcc2; the comments give the original line numbers.  Each
// case seeds rows, runs the port, reads the tables, rolls back to a savepoint, runs the reference
// statements on the same rows and requires the same return value and the same rows.  The
// expected values are spelled out as well, so the cases also pin today's behavior.  Where a port
// was changed on purpose after the move (the cancelled-status spelling, the cause of a waiter
// task closed with a tip refund, and the separate cancellation of a cancelled order's waiter
// task), its case states the intended difference from the reference statement.
//
// Every case runs in a transaction that is rolled back, so the synthetic database never
// changes between cases.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-venue-tasks-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');

const {
  getCoinDatabasePath,
  initializeNewCoinDatabase,
  readCoinSchemaVersionWithApi,
  resetCoinDatabaseForTests,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { TASK_STATUS, WAITER_JOB_NAMES } = require('../src/services/workService');
const venueService = require('../src/services/venueService');
const venueTasks = require('../src/systems/work/venueTasks');
const { countMakerItemsInWindowWithApi } = require('../src/systems/casino/venueOrders');

const { VENUE_JOB_BY_TYPE } = venueService;
const VENUE_TASKS_SOURCE = path.join(__dirname, '..', 'src', 'systems', 'work', 'venueTasks.js');

const GUILD_ID = '330000000000000001';
const OTHER_GUILD_ID = '330000000000000002';
const CHANNEL_ID = '330000000000000003';
const CHEF_ID = '330000000000000031';
const SECOND_CHEF_ID = '330000000000000032';
const THIRD_CHEF_ID = '330000000000000033';
const BARTENDER_ID = '330000000000000041';
const WAITER_ID = '330000000000000021';
const UNIFORM_WAITER_ID = '330000000000000022';

const T0 = '2026-04-01T01:00:00.000Z';
const T1 = '2026-04-01T02:00:00.000Z';
const T2 = '2026-04-01T03:00:00.000Z';
const PAY_AT = '2026-04-03T14:00:00.000Z';
// Taiwan service day 2026-04-01 as getTaiwanDayRange computes it.
const DAY_RANGE = Object.freeze({ startIso: '2026-03-31T16:00:00.000Z', endIso: '2026-04-01T16:00:00.000Z' });

const WORK_TABLES = Object.freeze(['coin_jobs', 'coin_work_tasks']);

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
// Reference oracle: src/services/venueService.js at 1d3fcc2. Do not reformat the SQL.
// ---------------------------------------------------------------------------------------

function serializeArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

// :305-307 isGlobalWorkSchema
function referenceIsGlobalWorkSchema(api) {
  return Number(api.get("SELECT value FROM coin_metadata WHERE key = 'schema_version'")?.value) >= 22;
}

// :263-268 getActiveJobRow
function referenceGetActiveJobRow(api, guildId, userId, jobName) {
  return api.get(
    'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND job_name = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [guildId, userId, jobName, 'active']
  );
}

// :284-296 ensureWaiterJob, query only.
function referenceActiveWaiterJobRows(api, guildId, userId) {
  const placeholders = WAITER_JOB_NAMES.map(() => '?').join(', ');
  const rows = api.all(
    `SELECT *
     FROM coin_jobs
     WHERE guild_id = ?
       AND user_id = ?
       AND job_name IN (${placeholders})
       AND status = 'active'
     ORDER BY CASE job_name WHEN '制服服務生' THEN 0 ELSE 1 END, id DESC
     LIMIT 1`,
    [guildId, userId, ...WAITER_JOB_NAMES]
  );
  return rows;
}

// :310-317 ensureVenueCutoverReady
function referenceFindUnsnapshottedLegacyJob(api) {
  return api.get(
    `SELECT 1 AS found FROM coin_jobs j
     LEFT JOIN coin_work_legacy_snapshots s ON s.job_id = j.id
     WHERE j.status IN ('active', 'failed') AND j.is_paid = 0 AND s.job_id IS NULL LIMIT 1`
  );
}

function referenceListLegacyJobSnapshots(api) {
  return api.all('SELECT * FROM coin_work_legacy_snapshots ORDER BY job_id');
}

// :345-357 getLeastBusyGlobalMaker
function referenceGlobalMakerCycles(api, guildId, itemType, range, timestamp) {
  const cycles = api.all(
    `SELECT c.*, COUNT(i.id) AS assigned_count
     FROM coin_primary_jobs_global p
     JOIN coin_primary_job_cycles c ON c.cycle_id = p.next_cycle_id AND c.user_id = p.user_id
     LEFT JOIN casino_venue_order_items i ON i.guild_id = ? AND i.maker_user_id = p.user_id
       AND i.item_type = ? AND i.maker_is_npc = 0 AND i.created_at >= ? AND i.created_at < ?
     WHERE p.state = 'active' AND p.job_name = ? AND c.status = 'active'
       AND c.starts_at <= ? AND c.ends_at > ?
     GROUP BY c.cycle_id
     ORDER BY assigned_count ASC, c.starts_at ASC, c.cycle_id ASC`,
    [guildId, itemType, range.startIso, range.endIso, VENUE_JOB_BY_TYPE[itemType], timestamp, timestamp]
  );
  return cycles;
}

// :375-409 insertPendingVenueWorkTask
function referenceInsertPendingVenueWorkTask(api, { guildId, userId, jobRow, taskType, description, createdAt, dueAt, channelId = null, messageId = null }) {
  const globalCycleId = jobRow.cycle_id || null;
  const globalSchema = referenceIsGlobalWorkSchema(api);
  api.run(
    `INSERT INTO coin_work_tasks
      (
        guild_id, user_id, job_id, ${globalSchema ? 'global_cycle_id,' : ''} job_name, task_type, status, description,
        attachment_urls, expected_channel_id, expected_channel_name, message_id,
        external_server_count, external_server_ids, created_at, due_at, updated_at
      )
     VALUES (?, ?, ?, ${globalSchema ? '?, ' : ''}?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
    [
      guildId,
      userId,
      globalCycleId ? null : jobRow.id,
      ...(globalSchema ? [globalCycleId] : []),
      jobRow.job_name,
      taskType,
      TASK_STATUS.PENDING,
      description,
      serializeArray([]),
      channelId,
      jobRow.job_name,
      messageId,
      serializeArray([]),
      createdAt,
      dueAt,
      createdAt,
    ]
  );
  if (!globalCycleId) {
    api.run('UPDATE coin_jobs SET today_task_count = today_task_count + 1, updated_at = ? WHERE id = ?', [createdAt, jobRow.id]);
  }
  return Number(api.get('SELECT last_insert_rowid() AS id').id);
}

// :411-427 getPendingVenueWorkTask, query only
function referencePendingVenueWorkTasks(api, { guildId, userId, jobId = null, globalCycleId = null, taskType, messageId }) {
  const globalSchema = referenceIsGlobalWorkSchema(api);
  const rows = api.all(
    `SELECT *
     FROM coin_work_tasks
     WHERE guild_id = ?
       AND user_id = ?
       AND job_id IS ?
       ${globalSchema ? 'AND global_cycle_id IS ?' : ''}
       AND task_type = ?
       AND status = 'pending'
       AND completed_at IS NULL
       AND message_id = ?
     ORDER BY created_at ASC, id ASC
     LIMIT 2`,
    [guildId, userId, jobId, ...(globalSchema ? [globalCycleId] : []), taskType, messageId]
  );
  return rows;
}

// :431 and :434-437 getPendingVenueWorkTask, legacy snapshot checks
function referenceLegacySnapshot(api, jobId) {
  return api.get('SELECT * FROM coin_work_legacy_snapshots WHERE job_id = ?', [jobId]);
}

function referenceFrozenTask(api, jobId, row) {
  return api.get(
    "SELECT snapshot_json FROM coin_work_legacy_snapshot_items WHERE job_id = ? AND item_kind = 'task' AND item_id = ?",
    [jobId, row.id]
  );
}

// :452-458 completePendingVenueWorkTask, task update
function referenceCompleteTask(api, { guildId, row, description, completedAt }) {
  api.run(
    `UPDATE coin_work_tasks
     SET status = ?, description = ?, completed_at = ?, updated_at = ?
     WHERE guild_id = ? AND id = ? AND status = 'pending' AND completed_at IS NULL`,
    [TASK_STATUS.COMPLETED, description, completedAt, completedAt, guildId, row.id]
  );
  return Number(api.get('SELECT changes() AS count').count);
}

// :461-470 completePendingVenueWorkTask, job counters
function referenceRecordLegacyCompletion(api, { jobId, completedAt }) {
  if (jobId != null) {
    api.run(
      `UPDATE coin_jobs
       SET last_contribution_at = ?,
           today_completed_task_count = today_completed_task_count + 1,
           updated_at = ?
       WHERE id = ?`,
      [completedAt, completedAt, jobId]
    );
  }
}

// :478-482 cancelPendingVenueWorkTask.  It stored 'canceled'; the port now stores
// TASK_STATUS.CANCELED, which its case checks as the one intended difference.
function referenceCancelTask(api, row, timestamp) {
  api.run(
    "UPDATE coin_work_tasks SET status = 'canceled', updated_at = ? WHERE id = ? AND status = 'pending' AND completed_at IS NULL",
    [timestamp, row.id]
  );
  return Number(api.get('SELECT changes() AS count').count);
}

// :487-509 getLeastBusyMaker
function referenceLeastBusyMaker(api, guildId, itemType, range) {
  const jobName = VENUE_JOB_BY_TYPE[itemType];

  return api.get(
    `SELECT j.*, COUNT(i.id) AS assigned_count
     FROM coin_jobs j
     LEFT JOIN casino_venue_order_items i
       ON i.guild_id = j.guild_id
      AND i.maker_user_id = j.user_id
      AND i.item_type = ?
      AND i.maker_is_npc = 0
      AND i.created_at >= ?
      AND i.created_at < ?
     WHERE j.guild_id = ?
       AND j.job_name = ?
       AND j.status = 'active'
     GROUP BY j.id
     ORDER BY assigned_count ASC, j.created_at ASC, j.id ASC
     LIMIT 1`,
    [itemType, range.startIso, range.endIso, guildId, jobName]
  );
}

// :578-591 refundOrderTipIfEscrowed, waiter task.  The port gives the same update for the
// cause 'waiter_overdue'; the cause 'maker_overdue' differs only in the review reason.
function referenceCloseWaiterTaskOnRefund(api, order, timestamp) {
  api.run(
    `UPDATE coin_work_tasks
     SET status = ?, completed_at = ?, review_reason = ?, updated_at = ?
     WHERE guild_id = ? AND message_id = ? AND status = ? AND completed_at IS NULL`,
    [
      TASK_STATUS.SYSTEM_COMPLETED,
      timestamp,
      '服務生逾期未送達，由小吉完成並退還小費。',
      timestamp,
      order.guildId,
      `venue-order-${order.id}`,
      TASK_STATUS.PENDING,
    ]
  );
}

// :669-702 insertVenueWorkTask, pre-v22 insert path
function referenceInsertCompletedTask(api, item, makerJobRow, taskType, description, timestamp) {
  api.run(
    `INSERT INTO coin_work_tasks
      (
        guild_id, user_id, job_id, job_name, task_type, status, description,
        attachment_urls, expected_channel_id, expected_channel_name, message_id,
        external_server_count, external_server_ids, created_at, due_at, completed_at, updated_at
      )
     VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, NULL, ?, NULL, 0, ?, ?, ?, ?, ?)`,
    [
      item.guildId,
      item.makerUserId,
      makerJobRow.id,
      makerJobRow.job_name,
      taskType,
      description,
      serializeArray([]),
      makerJobRow.job_name,
      serializeArray([]),
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    ]
  );
  api.run(
    `UPDATE coin_jobs
     SET last_contribution_at = ?,
         today_task_count = today_task_count + 1,
         today_completed_task_count = today_completed_task_count + 1,
         updated_at = ?
     WHERE id = ?`,
    [timestamp, timestamp, makerJobRow.id]
  );
  const taskId = Number(api.get('SELECT last_insert_rowid() AS id').id);
  return taskId;
}

// :998-1002 and :1064-1068 completeVenueOrderItem / serveVenueOrder assignment checks
function referenceActiveCycle(api, cycleId, userId, jobName) {
  return api.get('SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ? AND user_id = ? AND job_name = ? AND status = ?',
    [cycleId, userId, jobName, 'active']);
}

function referenceAssignedJob(api, jobId, guildId, userId, jobName) {
  return api.get('SELECT * FROM coin_jobs WHERE id = ? AND guild_id = ? AND user_id = ? AND job_name = ?',
    [jobId, guildId, userId, jobName]);
}

// :1205-1212 reassignVenueWaiter, pre-v22 branch
function referenceCancelLegacyWaiterTasks(api, guildId, id, timestamp) {
  api.run(
    `UPDATE coin_work_tasks
         SET status = ?, updated_at = ?
         WHERE guild_id = ? AND message_id = ? AND status = ? AND completed_at IS NULL`,
    [TASK_STATUS.CANCELED, timestamp, guildId, `venue-order-${id}`, TASK_STATUS.PENDING]
  );
}

// :1324-1326 processExpiredVenueOrderItems, maker job
function referenceGuildJob(api, item) {
  return api.get('SELECT * FROM coin_jobs WHERE guild_id = ? AND id = ?', [item.guildId, item.makerJobId]);
}

// :1328-1341 processExpiredVenueOrderItems, maker task
function referenceCloseOverdueMakerTask(api, item, timestamp) {
  api.run(
    `UPDATE coin_work_tasks
           SET status = ?, completed_at = ?, review_reason = ?, updated_at = ?
           WHERE guild_id = ? AND message_id = ? AND status = ? AND completed_at IS NULL`,
    [
      TASK_STATUS.SYSTEM_COMPLETED,
      timestamp,
      '餐飲製作逾期 24 小時未完成，由小吉場館人員接手。',
      timestamp,
      item.guildId,
      `venue-item-${item.id}`,
      TASK_STATUS.PENDING,
    ]
  );
}

// ---------------------------------------------------------------------------------------
// Synthetic rows and the comparison harness
// ---------------------------------------------------------------------------------------

function lastInsertId(api) {
  return Number(api.get('SELECT last_insert_rowid() AS id').id);
}

function setSchemaVersion(api, value) {
  api.run("UPDATE coin_metadata SET value = ? WHERE key = 'schema_version'", [String(value)]);
}

function insertGuildJob(api, { guildId = GUILD_ID, userId, jobName, status = 'active', isPaid = 0, dailySalary = 70, createdAt = T0 }) {
  api.run(
    `INSERT INTO coin_jobs (
      guild_id, user_id, job_name, job_role_id, daily_salary, work_days, total_salary,
      status, is_paid, start_at, pay_at, last_contribution_at, today_task_count,
      today_completed_task_count, no_work_available_today, payroll_status, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, 2, ?, ?, ?, ?, ?, NULL, 0, 0, 0, 'pending', ?, ?)`,
    [guildId, userId, jobName, dailySalary, dailySalary * 2, status, isPaid, createdAt, PAY_AT, createdAt, createdAt]
  );
  return lastInsertId(api);
}

function readJob(api, jobId) {
  return api.get('SELECT * FROM coin_jobs WHERE id = ?', [jobId]);
}

function insertPrimaryCycle(api, {
  userId, jobName, cycleId, state = 'active', status = 'active', startsAt = T0, endsAt = PAY_AT, createdAt = T0,
}) {
  api.run(
    `INSERT INTO coin_primary_jobs_global (
      user_id, job_name, work_days, legacy_job_id, source_guild_id, next_cycle_id, requested_at,
      not_before_at, effective_from, effective_until, state, updated_at
    ) VALUES (?, ?, 2, NULL, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [userId, jobName, GUILD_ID, cycleId, createdAt, startsAt, endsAt, state, createdAt]
  );
  api.run(
    `INSERT INTO coin_primary_job_cycles (
      cycle_id, user_id, job_name, work_days, source_guild_id, starts_at, ends_at,
      salary_rule_version, salary_snapshot_json, status, reward_key, created_at, updated_at
    ) VALUES (?, ?, ?, 2, ?, ?, ?, 'synthetic', '{}', ?, NULL, ?, ?)`,
    [cycleId, userId, jobName, GUILD_ID, startsAt, endsAt, status, createdAt, createdAt]
  );
  return api.get('SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ?', [cycleId]);
}

function insertVenueItem(api, { guildId = GUILD_ID, itemType, makerUserId, makerIsNpc = 0, createdAt = T1 }) {
  api.run(
    `INSERT INTO casino_venue_order_items (
      guild_id, order_id, item_type, menu_item_id, item_name, standard_steps, maker_user_id,
      maker_job_id, maker_job_name, maker_is_npc, status, created_at, updated_at
    ) VALUES (?, 1, ?, NULL, 'synthetic item', 'synthetic step', ?, NULL, NULL, ?, 'completed', ?, ?)`,
    [guildId, itemType, makerUserId, makerIsNpc, createdAt, createdAt]
  );
}

function insertTask(api, {
  guildId = GUILD_ID, userId, jobId = null, globalCycleId = null, jobName, taskType,
  status = 'pending', messageId, createdAt = T0, completedAt = null,
}) {
  api.run(
    `INSERT INTO coin_work_tasks (
      guild_id, user_id, job_id, global_cycle_id, job_name, task_type, status, description,
      attachment_urls, expected_channel_id, expected_channel_name, message_id,
      external_server_count, external_server_ids, created_at, due_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'seeded task', '[]', ?, ?, ?, 0, '[]', ?, ?, ?, ?)`,
    [guildId, userId, jobId, globalCycleId, jobName, taskType, status, CHANNEL_ID, jobName, messageId,
      createdAt, PAY_AT, completedAt, createdAt]
  );
  return lastInsertId(api);
}

function readTask(api, taskId) {
  return api.get('SELECT * FROM coin_work_tasks WHERE id = ?', [taskId]);
}

function insertLegacySnapshot(api, { jobId, userId, jobName }) {
  api.run(
    `INSERT INTO coin_work_legacy_snapshots (
      job_id, user_id, source_guild_id, job_name, job_role_id, daily_salary, work_days, total_salary,
      start_at, pay_at, status, is_paid, payroll_status, rule_version, rules_json, source_hash,
      cutover_state_hash, snapshot_item_count, created_at
    ) VALUES (?, ?, ?, ?, NULL, 70, 2, 140, ?, ?, 'active', 0, 'pending', 'synthetic', '{}',
      'synthetic-source', 'synthetic-cutover', 1, ?)`,
    [jobId, userId, GUILD_ID, jobName, T0, PAY_AT, T0]
  );
}

function insertSnapshotItem(api, { jobId, itemKind = 'task', itemId, status }) {
  api.run(
    `INSERT INTO coin_work_legacy_snapshot_items (job_id, item_kind, item_id, source_hash, snapshot_json, captured_at)
     VALUES (?, ?, ?, 'synthetic', ?, ?)`,
    [jobId, itemKind, itemId, JSON.stringify({ status }), T0]
  );
}

function readTables(api, tables) {
  return Object.fromEntries(tables.map((table) => [table, api.all(`SELECT * FROM "${table}" ORDER BY rowid`)]));
}

const ROLLBACK_MARK = Symbol('venue tasks synthetic rollback');

// Runs work inside a real coin transaction and always rolls it back.
async function inRolledBackTransaction(work) {
  let outcome;
  await assert.rejects(withCoinTransaction(async (api) => {
    outcome = await work(api);
    throw Object.assign(new Error('roll back the synthetic case'), { [ROLLBACK_MARK]: true });
  }), (error) => error?.[ROLLBACK_MARK] === true);
  return outcome;
}

// Seeds once, then runs the port and the reference statements on the same rows.
async function compareWithPreB7({ seed = () => ({}), port, reference, tables = WORK_TABLES }) {
  return inRolledBackTransaction((api) => {
    const seeded = seed(api);
    api.run('SAVEPOINT venue_tasks_case');
    const portResult = port(api, seeded);
    const portRows = readTables(api, tables);
    api.run('ROLLBACK TO venue_tasks_case');
    const referenceResult = reference(api, seeded);
    const referenceRows = readTables(api, tables);
    api.run('RELEASE venue_tasks_case');
    return { seeded, portResult, portRows, referenceResult, referenceRows };
  });
}

function assertSameAsPreB7(outcome) {
  assert.deepEqual(outcome.portResult, outcome.referenceResult, 'port return value differs from the reference statements');
  assert.deepEqual(outcome.portRows, outcome.referenceRows, 'port rows differ from the reference statements');
}

// ---------------------------------------------------------------------------------------
// Module shape
// ---------------------------------------------------------------------------------------

test('venueTasks is a leaf module of *WithApi ports that never controls a transaction or reads the clock', () => {
  const source = fs.readFileSync(VENUE_TASKS_SOURCE, 'utf8');
  assert.doesNotMatch(source, /\brequire\s*\(/u, 'a leaf module must not load other modules');
  assert.doesNotMatch(source, /\bimport\b/u);
  assert.doesNotMatch(source, /\b(BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/u, 'the caller owns the transaction');
  assert.doesNotMatch(source, /withCoin(Transaction|Database)/u);
  assert.doesNotMatch(source, /new Date\(|Date\.now\(/u, 'every timestamp must come from the caller');
  assert.doesNotMatch(source, /coin_metadata/u, 'schema metadata belongs to the storage layer');

  const names = Object.keys(venueTasks).sort();
  assert.deepEqual(names, [
    'cancelPendingLegacyWaiterTasksWithApi',
    'cancelWaiterTaskForCancelledOrderWithApi',
    'closeOverdueMakerTaskWithApi',
    'closeWaiterTaskForTipRefundWithApi',
    'findUnsnapshottedLegacyJobWithApi',
    'getActiveJobCycleWithApi',
    'getActiveJobRowWithApi',
    'getAssignedJobRowWithApi',
    'getFrozenLegacyTaskSnapshotWithApi',
    'getGuildJobRowWithApi',
    'getLeastBusyLegacyMakerJobWithApi',
    'getLegacyJobSnapshotWithApi',
    'insertCompletedLegacyVenueWorkTaskWithApi',
    'insertPendingVenueWorkTaskWithApi',
    'listActiveWaiterJobRowsWithApi',
    'listGlobalMakerCyclesByLoadWithApi',
    'listLegacyJobSnapshotsWithApi',
    'listPendingVenueWorkTasksWithApi',
    'markVenueWorkTaskCanceledWithApi',
    'markVenueWorkTaskCompletedWithApi',
    'recordLegacyVenueTaskCompletionWithApi',
  ]);
  for (const name of names) {
    assert.equal(typeof venueTasks[name], 'function', name);
    assert.ok(venueTasks[name].length >= 1, `${name} takes the caller's api first`);
  }
});

test('venueService keeps its public exports after the move', () => {
  assert.deepEqual(Object.keys(venueService).sort(), [
    'ORDER_RATE_LIMIT_PER_MINUTE',
    'VENUE_BONUS_AMOUNT',
    'VENUE_BONUS_THRESHOLD',
    'VENUE_JOB_BY_TYPE',
    'VenueItemType',
    'VenueOrderItemStatus',
    'VenueOrderStatus',
    'WAITER_TIP_MINIMUMS',
    'addVenueMenuItem',
    'cancelVenueOrderItem',
    'completeVenueOrderItem',
    'createVenueOrder',
    'deleteVenueMenuItem',
    'getVenueRecipe',
    'listVenueHistory',
    'listVenueMenu',
    'processExpiredVenueOrderItems',
    'reassignVenueOrderItem',
    'reassignVenueWaiter',
    'refundCancelledOrderTipForTests',
    'refundOverdueOrderTipForTests',
    'serveVenueOrder',
    'splitSteps',
  ]);
});

test('the statuses the ports write still match TASK_STATUS in workService', () => {
  // The leaf module keeps its own copy; these are the values the reference statements bound.
  assert.equal(TASK_STATUS.PENDING, 'pending');
  assert.equal(TASK_STATUS.COMPLETED, 'completed');
  assert.equal(TASK_STATUS.SYSTEM_COMPLETED, 'system_completed');
  assert.equal(TASK_STATUS.CANCELED, 'cancelled');
});

// ---------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------

test('the storage schema read port matches the reference check (v22 and later)', async () => {
  for (const [version, expected] of [[null, true], ['22', true], ['21', false], ['9', false]]) {
    const outcome = await compareWithPreB7({
      seed: (api) => {
        if (version !== null) setSchemaVersion(api, version);
        return {};
      },
      port: (api) => readCoinSchemaVersionWithApi(api) >= 22,
      reference: (api) => referenceIsGlobalWorkSchema(api),
      tables: ['coin_metadata'],
    });
    assertSameAsPreB7(outcome);
    assert.equal(outcome.portResult, expected, `schema_version ${version ?? '24 (fresh)'}`);
  }
});

test('getActiveJobRowWithApi returns the newest active guild job of that name', async () => {
  const outcome = await compareWithPreB7({
    seed: (api) => ({
      older: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師' }),
      newer: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T1 }),
      paid: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', status: 'paid', isPaid: 1 }),
      otherJob: insertGuildJob(api, { userId: CHEF_ID, jobName: '調酒師' }),
      otherGuild: insertGuildJob(api, { guildId: OTHER_GUILD_ID, userId: CHEF_ID, jobName: '廚師' }),
    }),
    port: (api) => [
      venueTasks.getActiveJobRowWithApi(api, GUILD_ID, CHEF_ID, '廚師'),
      venueTasks.getActiveJobRowWithApi(api, GUILD_ID, SECOND_CHEF_ID, '廚師'),
    ],
    reference: (api) => [
      referenceGetActiveJobRow(api, GUILD_ID, CHEF_ID, '廚師'),
      referenceGetActiveJobRow(api, GUILD_ID, SECOND_CHEF_ID, '廚師'),
    ],
  });
  assertSameAsPreB7(outcome);
  assert.equal(outcome.portResult[0].id, outcome.seeded.newer);
  assert.equal(outcome.portResult[1], null);
});

test('listActiveWaiterJobRowsWithApi prefers the uniform waiter and returns at most one row', async () => {
  const outcome = await compareWithPreB7({
    seed: (api) => ({
      waiter: insertGuildJob(api, { userId: WAITER_ID, jobName: '服務生', dailySalary: 0 }),
      uniform: insertGuildJob(api, { userId: WAITER_ID, jobName: '制服服務生', dailySalary: 0 }),
      newerWaiter: insertGuildJob(api, { userId: WAITER_ID, jobName: '服務生', dailySalary: 0, createdAt: T1 }),
      onlyWaiter: insertGuildJob(api, { userId: UNIFORM_WAITER_ID, jobName: '服務生', dailySalary: 0 }),
      chef: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師' }),
    }),
    port: (api) => [WAITER_ID, UNIFORM_WAITER_ID, CHEF_ID]
      .map((userId) => venueTasks.listActiveWaiterJobRowsWithApi(api, GUILD_ID, userId, WAITER_JOB_NAMES)),
    reference: (api) => [WAITER_ID, UNIFORM_WAITER_ID, CHEF_ID]
      .map((userId) => referenceActiveWaiterJobRows(api, GUILD_ID, userId)),
  });
  assertSameAsPreB7(outcome);
  assert.deepEqual(outcome.portResult.map((rows) => rows.map((row) => row.id)),
    [[outcome.seeded.uniform], [outcome.seeded.onlyWaiter], []]);
});

test('assignment lookups match the reference checks for cycles, assigned jobs and guild jobs', async () => {
  const outcome = await compareWithPreB7({
    seed: (api) => ({
      cycle: insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'synthetic-cycle-chef' }),
      settled: insertPrimaryCycle(api, {
        userId: BARTENDER_ID, jobName: '調酒師', cycleId: 'synthetic-cycle-settled', status: 'settled',
      }),
      job: insertGuildJob(api, { userId: WAITER_ID, jobName: '服務生', dailySalary: 0 }),
      otherGuildJob: insertGuildJob(api, { guildId: OTHER_GUILD_ID, userId: CHEF_ID, jobName: '廚師' }),
    }),
    port: (api, seeded) => ({
      cycle: venueTasks.getActiveJobCycleWithApi(api, { cycleId: 'synthetic-cycle-chef', userId: CHEF_ID, jobName: '廚師' }),
      cycleWrongJob: venueTasks.getActiveJobCycleWithApi(api, {
        cycleId: 'synthetic-cycle-chef', userId: CHEF_ID, jobName: '調酒師',
      }),
      settled: venueTasks.getActiveJobCycleWithApi(api, {
        cycleId: 'synthetic-cycle-settled', userId: BARTENDER_ID, jobName: '調酒師',
      }),
      assigned: venueTasks.getAssignedJobRowWithApi(api, {
        jobId: seeded.job, guildId: GUILD_ID, userId: WAITER_ID, jobName: '服務生',
      }),
      assignedWrongUser: venueTasks.getAssignedJobRowWithApi(api, {
        jobId: seeded.job, guildId: GUILD_ID, userId: UNIFORM_WAITER_ID, jobName: '服務生',
      }),
      guildJob: venueTasks.getGuildJobRowWithApi(api, { guildId: GUILD_ID, jobId: seeded.job }),
      guildJobOtherGuild: venueTasks.getGuildJobRowWithApi(api, { guildId: GUILD_ID, jobId: seeded.otherGuildJob }),
    }),
    reference: (api, seeded) => ({
      cycle: referenceActiveCycle(api, 'synthetic-cycle-chef', CHEF_ID, '廚師'),
      cycleWrongJob: referenceActiveCycle(api, 'synthetic-cycle-chef', CHEF_ID, '調酒師'),
      settled: referenceActiveCycle(api, 'synthetic-cycle-settled', BARTENDER_ID, '調酒師'),
      assigned: referenceAssignedJob(api, seeded.job, GUILD_ID, WAITER_ID, '服務生'),
      assignedWrongUser: referenceAssignedJob(api, seeded.job, GUILD_ID, UNIFORM_WAITER_ID, '服務生'),
      guildJob: referenceGuildJob(api, { guildId: GUILD_ID, makerJobId: seeded.job }),
      guildJobOtherGuild: referenceGuildJob(api, { guildId: GUILD_ID, makerJobId: seeded.otherGuildJob }),
    }),
  });
  assertSameAsPreB7(outcome);
  const result = outcome.portResult;
  assert.deepEqual(result.cycle, outcome.seeded.cycle);
  assert.equal(result.cycleWrongJob, null);
  assert.equal(result.settled, null);
  assert.equal(result.assigned.id, outcome.seeded.job);
  assert.equal(result.assignedWrongUser, null);
  assert.equal(result.guildJob.id, outcome.seeded.job);
  assert.equal(result.guildJobOtherGuild, null);
});

test('listGlobalMakerCyclesByLoadWithApi orders active cycles by venue load like the reference query', async () => {
  const timestamp = T2;
  const outcome = await compareWithPreB7({
    seed: (api) => {
      insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'synthetic-cycle-a', startsAt: T0 });
      insertPrimaryCycle(api, { userId: SECOND_CHEF_ID, jobName: '廚師', cycleId: 'synthetic-cycle-b', startsAt: T0 });
      insertPrimaryCycle(api, { userId: THIRD_CHEF_ID, jobName: '廚師', cycleId: 'synthetic-cycle-c', startsAt: T1 });
      insertPrimaryCycle(api, { userId: BARTENDER_ID, jobName: '調酒師', cycleId: 'synthetic-cycle-d', startsAt: T0 });
      insertPrimaryCycle(api, {
        userId: WAITER_ID, jobName: '廚師', cycleId: 'synthetic-cycle-closed', state: 'closed', startsAt: T0,
      });
      insertPrimaryCycle(api, {
        userId: UNIFORM_WAITER_ID, jobName: '廚師', cycleId: 'synthetic-cycle-future', startsAt: '2026-04-01T05:00:00.000Z',
      });
      // CHEF made two meals today, SECOND_CHEF one; NPC, drink, other-guild and yesterday's
      // items are not counted.
      insertVenueItem(api, { itemType: 'meal', makerUserId: CHEF_ID });
      insertVenueItem(api, { itemType: 'meal', makerUserId: CHEF_ID, createdAt: T0 });
      insertVenueItem(api, { itemType: 'meal', makerUserId: SECOND_CHEF_ID });
      insertVenueItem(api, { itemType: 'meal', makerUserId: THIRD_CHEF_ID, makerIsNpc: 1 });
      insertVenueItem(api, { itemType: 'drink', makerUserId: THIRD_CHEF_ID });
      insertVenueItem(api, { guildId: OTHER_GUILD_ID, itemType: 'meal', makerUserId: THIRD_CHEF_ID });
      insertVenueItem(api, { itemType: 'meal', makerUserId: THIRD_CHEF_ID, createdAt: '2026-03-31T15:59:59.999Z' });
      return {};
    },
    port: (api) => venueTasks.listGlobalMakerCyclesByLoadWithApi(api, {
      jobName: VENUE_JOB_BY_TYPE.meal,
      timestamp,
      makerLoads: countMakerItemsInWindowWithApi(api, {
        guildId: GUILD_ID, itemType: 'meal', startIso: DAY_RANGE.startIso, endIso: DAY_RANGE.endIso,
      }),
    }),
    reference: (api) => referenceGlobalMakerCycles(api, GUILD_ID, 'meal', DAY_RANGE, timestamp),
    tables: ['coin_primary_job_cycles', 'casino_venue_order_items'],
  });
  assertSameAsPreB7(outcome);
  assert.deepEqual(outcome.portResult.map((row) => [row.cycle_id, row.assigned_count]), [
    ['synthetic-cycle-c', 0],
    ['synthetic-cycle-b', 1],
    ['synthetic-cycle-a', 2],
  ]);
});

test('getLeastBusyLegacyMakerJobWithApi picks the guild job with the fewest venue items like the reference query', async () => {
  const seed = (api) => {
    const jobs = {
      busy: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T0 }),
      idleLater: insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師', createdAt: T1 }),
      idleEarlier: insertGuildJob(api, { userId: THIRD_CHEF_ID, jobName: '廚師', createdAt: T0 }),
      paid: insertGuildJob(api, { userId: BARTENDER_ID, jobName: '廚師', status: 'paid', isPaid: 1 }),
    };
    insertVenueItem(api, { itemType: 'meal', makerUserId: CHEF_ID });
    insertVenueItem(api, { itemType: 'meal', makerUserId: THIRD_CHEF_ID, createdAt: '2026-03-31T15:00:00.000Z' });
    insertVenueItem(api, { itemType: 'drink', makerUserId: THIRD_CHEF_ID });
    return jobs;
  };
  const outcome = await compareWithPreB7({
    seed,
    port: (api) => [
      venueTasks.getLeastBusyLegacyMakerJobWithApi(api, {
        guildId: GUILD_ID, jobName: '廚師', makerLoads: countMakerItemsInWindowWithApi(api, {
          guildId: GUILD_ID, itemType: 'meal', startIso: DAY_RANGE.startIso, endIso: DAY_RANGE.endIso,
        }),
      }),
      venueTasks.getLeastBusyLegacyMakerJobWithApi(api, {
        guildId: GUILD_ID, jobName: '調酒師', makerLoads: countMakerItemsInWindowWithApi(api, {
          guildId: GUILD_ID, itemType: 'drink', startIso: DAY_RANGE.startIso, endIso: DAY_RANGE.endIso,
        }),
      }),
    ],
    reference: (api) => [
      referenceLeastBusyMaker(api, GUILD_ID, 'meal', DAY_RANGE),
      referenceLeastBusyMaker(api, GUILD_ID, 'drink', DAY_RANGE),
    ],
    tables: ['coin_jobs', 'casino_venue_order_items'],
  });
  assertSameAsPreB7(outcome);
  assert.deepEqual([outcome.portResult[0].id, outcome.portResult[0].assigned_count], [outcome.seeded.idleEarlier, 0]);
  assert.equal(outcome.portResult[1], null);
});

test('legacy snapshot reads match the reference cutover checks', async () => {
  const outcome = await compareWithPreB7({
    seed: (api) => {
      const snapshotted = insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師' });
      const second = insertGuildJob(api, { userId: BARTENDER_ID, jobName: '調酒師' });
      const paid = insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師', status: 'paid', isPaid: 1 });
      // Inserted in reverse job order so the ORDER BY is observable.
      insertLegacySnapshot(api, { jobId: second, userId: BARTENDER_ID, jobName: '調酒師' });
      insertLegacySnapshot(api, { jobId: snapshotted, userId: CHEF_ID, jobName: '廚師' });
      insertSnapshotItem(api, { jobId: snapshotted, itemId: 7, status: 'pending' });
      insertSnapshotItem(api, { jobId: snapshotted, itemKind: 'penalty', itemId: 8, status: 'active' });
      return { snapshotted, second, paid };
    },
    port: (api, seeded) => ({
      unsnapshotted: venueTasks.findUnsnapshottedLegacyJobWithApi(api),
      snapshots: venueTasks.listLegacyJobSnapshotsWithApi(api).map((row) => row.job_id),
      snapshot: venueTasks.getLegacyJobSnapshotWithApi(api, seeded.snapshotted),
      missingSnapshot: venueTasks.getLegacyJobSnapshotWithApi(api, seeded.paid),
      frozen: venueTasks.getFrozenLegacyTaskSnapshotWithApi(api, seeded.snapshotted, 7),
      notATask: venueTasks.getFrozenLegacyTaskSnapshotWithApi(api, seeded.snapshotted, 8),
    }),
    reference: (api, seeded) => ({
      unsnapshotted: referenceFindUnsnapshottedLegacyJob(api),
      snapshots: referenceListLegacyJobSnapshots(api).map((row) => row.job_id),
      snapshot: referenceLegacySnapshot(api, seeded.snapshotted),
      missingSnapshot: referenceLegacySnapshot(api, seeded.paid),
      frozen: referenceFrozenTask(api, seeded.snapshotted, { id: 7 }),
      notATask: referenceFrozenTask(api, seeded.snapshotted, { id: 8 }),
    }),
    tables: ['coin_work_legacy_snapshots', 'coin_work_legacy_snapshot_items'],
  });
  assertSameAsPreB7(outcome);
  const result = outcome.portResult;
  assert.equal(result.unsnapshotted, null);
  assert.deepEqual(result.snapshots, [outcome.seeded.snapshotted, outcome.seeded.second]);
  assert.equal(result.snapshot.job_id, outcome.seeded.snapshotted);
  assert.equal(result.missingSnapshot, null);
  assert.deepEqual(result.frozen, { snapshot_json: '{"status":"pending"}' });
  assert.equal(result.notATask, null);

  // An open, unpaid job without a snapshot (active or failed) blocks new venue work.
  for (const status of ['active', 'failed']) {
    const blocked = await compareWithPreB7({
      seed: (api) => ({ job: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', status }) }),
      port: (api) => venueTasks.findUnsnapshottedLegacyJobWithApi(api),
      reference: (api) => referenceFindUnsnapshottedLegacyJob(api),
    });
    assertSameAsPreB7(blocked);
    assert.deepEqual(blocked.portResult, { found: 1 }, status);
  }
});

test('listPendingVenueWorkTasksWithApi matches the reference pending-task query on v24 and pre-v22 schemas', async () => {
  for (const version of [null, '21']) {
    const outcome = await compareWithPreB7({
      seed: (api) => {
        if (version !== null) setSchemaVersion(api, version);
        const cycle = insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'synthetic-cycle-chef' });
        const job = insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師' });
        const base = { userId: CHEF_ID, jobName: '廚師', taskType: 'casino_venue_meal', messageId: 'venue-item-9' };
        return {
          cycleTask: insertTask(api, { ...base, globalCycleId: cycle.cycle_id, createdAt: T1 }),
          olderCycleTask: insertTask(api, { ...base, globalCycleId: cycle.cycle_id, createdAt: T0 }),
          legacyTask: insertTask(api, { ...base, jobId: job }),
          completed: insertTask(api, { ...base, globalCycleId: cycle.cycle_id, status: 'completed', completedAt: T1 }),
          otherMessage: insertTask(api, { ...base, globalCycleId: cycle.cycle_id, messageId: 'venue-item-10' }),
          job,
        };
      },
      port: (api, seeded) => {
        const globalSchema = readCoinSchemaVersionWithApi(api) >= 22;
        return [
          venueTasks.listPendingVenueWorkTasksWithApi(api, {
          guildId: GUILD_ID, userId: CHEF_ID, globalCycleId: 'synthetic-cycle-chef',
            taskType: 'casino_venue_meal', messageId: 'venue-item-9', globalSchema,
          }),
          venueTasks.listPendingVenueWorkTasksWithApi(api, {
          guildId: GUILD_ID, userId: CHEF_ID, jobId: seeded.job, taskType: 'casino_venue_meal', messageId: 'venue-item-9',
            globalSchema,
          }),
        ].map((rows) => rows.map((row) => row.id));
      },
      reference: (api, seeded) => [
        referencePendingVenueWorkTasks(api, {
          guildId: GUILD_ID, userId: CHEF_ID, globalCycleId: 'synthetic-cycle-chef',
          taskType: 'casino_venue_meal', messageId: 'venue-item-9',
        }),
        referencePendingVenueWorkTasks(api, {
          guildId: GUILD_ID, userId: CHEF_ID, jobId: seeded.job, taskType: 'casino_venue_meal', messageId: 'venue-item-9',
        }),
      ].map((rows) => rows.map((row) => row.id)),
    });
    assertSameAsPreB7(outcome);
    const { seeded } = outcome;
    // job_id IS NULL selects the cycle tasks (oldest first, at most two); before v22 the
    // cycle filter is not part of the query.
    assert.deepEqual(outcome.portResult, [
      [seeded.olderCycleTask, seeded.cycleTask],
      [seeded.legacyTask],
    ], `schema_version ${version ?? '24 (fresh)'}`);
  }
});

// ---------------------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------------------

test('insertPendingVenueWorkTaskWithApi writes the same task and job counter as the reference insert', async () => {
  const cases = [
    { name: 'v24 primary cycle', version: null, cycle: true },
    { name: 'v24 guild job', version: null, cycle: false },
    { name: 'pre-v22 guild job', version: '21', cycle: false },
  ];
  for (const testCase of cases) {
    const outcome = await compareWithPreB7({
      seed: (api) => {
        if (testCase.version !== null) setSchemaVersion(api, testCase.version);
        const jobRow = testCase.cycle
          ? insertPrimaryCycle(api, { userId: WAITER_ID, jobName: '服務生', cycleId: 'synthetic-cycle-waiter' })
          : readJob(api, insertGuildJob(api, { userId: WAITER_ID, jobName: '服務生', dailySalary: 0 }));
        insertTask(api, { userId: CHEF_ID, jobName: '廚師', taskType: 'casino_venue_meal', messageId: 'venue-item-1' });
        return { jobRow };
      },
      port: (api, { jobRow }) => {
        const globalSchema = readCoinSchemaVersionWithApi(api) >= 22;
        return [
          venueTasks.insertPendingVenueWorkTaskWithApi(api, {
          guildId: GUILD_ID, userId: WAITER_ID, jobRow, taskType: 'casino_venue_service',
            description: '訂單 #5 待送達，小費 80 籌碼。', createdAt: T1, dueAt: T2, channelId: CHANNEL_ID, messageId: 'venue-order-5',
            globalSchema,
          }),
          venueTasks.insertPendingVenueWorkTaskWithApi(api, {
          guildId: GUILD_ID, userId: WAITER_ID, jobRow, taskType: 'casino_venue_service',
            description: 'defaults', createdAt: T2, dueAt: PAY_AT, globalSchema,
          }),
        ];
      },
      reference: (api, { jobRow }) => [
        referenceInsertPendingVenueWorkTask(api, {
          guildId: GUILD_ID, userId: WAITER_ID, jobRow, taskType: 'casino_venue_service',
          description: '訂單 #5 待送達，小費 80 籌碼。', createdAt: T1, dueAt: T2, channelId: CHANNEL_ID, messageId: 'venue-order-5',
        }),
        referenceInsertPendingVenueWorkTask(api, {
          guildId: GUILD_ID, userId: WAITER_ID, jobRow, taskType: 'casino_venue_service',
          description: 'defaults', createdAt: T2, dueAt: PAY_AT,
        }),
      ],
    });
    assertSameAsPreB7(outcome);
    const tasks = outcome.portRows.coin_work_tasks;
    const [firstId, secondId] = outcome.portResult;
    assert.deepEqual([firstId, secondId], [tasks[1].id, tasks[2].id], testCase.name);
    const first = tasks[1];
    assert.deepEqual({
      user_id: first.user_id,
      job_id: first.job_id,
      global_cycle_id: first.global_cycle_id,
      job_name: first.job_name,
      task_type: first.task_type,
      status: first.status,
      description: first.description,
      attachment_urls: first.attachment_urls,
      expected_channel_id: first.expected_channel_id,
      expected_channel_name: first.expected_channel_name,
      message_id: first.message_id,
      external_server_count: first.external_server_count,
      external_server_ids: first.external_server_ids,
      created_at: first.created_at,
      due_at: first.due_at,
      completed_at: first.completed_at,
      updated_at: first.updated_at,
    }, {
      user_id: WAITER_ID,
      job_id: testCase.cycle ? null : outcome.seeded.jobRow.id,
      global_cycle_id: testCase.cycle ? 'synthetic-cycle-waiter' : null,
      job_name: '服務生',
      task_type: 'casino_venue_service',
      status: TASK_STATUS.PENDING,
      description: '訂單 #5 待送達，小費 80 籌碼。',
      attachment_urls: '[]',
      expected_channel_id: CHANNEL_ID,
      expected_channel_name: '服務生',
      message_id: 'venue-order-5',
      external_server_count: 0,
      external_server_ids: '[]',
      created_at: T1,
      due_at: T2,
      completed_at: null,
      updated_at: T1,
    }, testCase.name);
    assert.deepEqual([tasks[2].expected_channel_id, tasks[2].message_id], [null, null], testCase.name);
    if (!testCase.cycle) {
      const job = outcome.portRows.coin_jobs.find((row) => row.id === outcome.seeded.jobRow.id);
      assert.deepEqual([job.today_task_count, job.updated_at], [2, T2], testCase.name);
    }
  }
});

test('the schema-dependent task functions refuse a globalSchema that is not a boolean before any database access', () => {
  const untouched = {
    run() { assert.fail('the database must not be written'); },
    get() { assert.fail('the database must not be read'); },
    all() { assert.fail('the database must not be read'); },
  };
  const insertInput = {
    guildId: GUILD_ID, userId: WAITER_ID, jobRow: { id: 1, cycle_id: null, job_name: '服務生' },
    taskType: 'casino_venue_service', description: 'x', createdAt: T1, dueAt: T2,
  };
  const listInput = {
    guildId: GUILD_ID, userId: WAITER_ID, jobId: 1, taskType: 'casino_venue_service', messageId: 'venue-order-1',
  };
  const wrongValues = [undefined, null, 0, 1, 'true', {}];
  for (const globalSchema of wrongValues) {
    assert.throws(() => venueTasks.insertPendingVenueWorkTaskWithApi(untouched, { ...insertInput, globalSchema }),
      /globalSchema/u);
    assert.throws(() => venueTasks.listPendingVenueWorkTasksWithApi(untouched, { ...listInput, globalSchema }),
      /globalSchema/u);
  }
  // Left out altogether it is the same mistake.
  assert.throws(() => venueTasks.insertPendingVenueWorkTaskWithApi(untouched, insertInput), /globalSchema/u);
  assert.throws(() => venueTasks.listPendingVenueWorkTasksWithApi(untouched, listInput), /globalSchema/u);
});

test('markVenueWorkTaskCompletedWithApi and recordLegacyVenueTaskCompletionWithApi match the reference completion', async () => {
  const outcome = await compareWithPreB7({
    seed: (api) => {
      const job = insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師' });
      const base = { userId: CHEF_ID, jobId: job, jobName: '廚師', taskType: 'casino_venue_meal' };
      return {
        job,
        pending: insertTask(api, { ...base, messageId: 'venue-item-1' }),
        alreadyDone: insertTask(api, { ...base, messageId: 'venue-item-2', status: 'completed', completedAt: T0 }),
        otherGuild: insertTask(api, { ...base, guildId: OTHER_GUILD_ID, messageId: 'venue-item-3' }),
      };
    },
    port: (api, seeded) => {
      const changes = [seeded.pending, seeded.alreadyDone, seeded.otherGuild].map((taskId) => venueTasks
        .markVenueWorkTaskCompletedWithApi(api, { guildId: GUILD_ID, taskId, description: '做好了', completedAt: T2 }));
      venueTasks.recordLegacyVenueTaskCompletionWithApi(api, { jobId: seeded.job, completedAt: T2 });
      return changes;
    },
    reference: (api, seeded) => {
      const changes = [seeded.pending, seeded.alreadyDone, seeded.otherGuild].map((id) => referenceCompleteTask(
        api, { guildId: GUILD_ID, row: { id }, description: '做好了', completedAt: T2 }));
      referenceRecordLegacyCompletion(api, { jobId: seeded.job, completedAt: T2 });
      return changes;
    },
  });
  assertSameAsPreB7(outcome);
  assert.deepEqual(outcome.portResult, [1, 0, 0]);
  const tasks = outcome.portRows.coin_work_tasks;
  assert.deepEqual(tasks.map((task) => [task.status, task.description, task.completed_at, task.updated_at]), [
    [TASK_STATUS.COMPLETED, '做好了', T2, T2],
    ['completed', 'seeded task', T0, T0],
    ['pending', 'seeded task', null, T0],
  ]);
  const job = outcome.portRows.coin_jobs[0];
  assert.deepEqual([job.last_contribution_at, job.today_task_count, job.today_completed_task_count, job.updated_at],
    [T2, 0, 1, T2]);
});

test('markVenueWorkTaskCanceledWithApi cancels like the reference update but stores TASK_STATUS.CANCELED', async () => {
  const outcome = await compareWithPreB7({
    seed: (api) => {
      const base = { userId: CHEF_ID, globalCycleId: null, jobName: '廚師', taskType: 'casino_venue_meal' };
      return {
        pending: insertTask(api, { ...base, messageId: 'venue-item-1' }),
        done: insertTask(api, { ...base, messageId: 'venue-item-2', status: 'completed', completedAt: T0 }),
      };
    },
    port: (api, seeded) => [seeded.pending, seeded.pending, seeded.done]
      .map((taskId) => venueTasks.markVenueWorkTaskCanceledWithApi(api, { taskId, timestamp: T2 })),
    reference: (api, seeded) => [seeded.pending, seeded.pending, seeded.done]
      .map((id) => referenceCancelTask(api, { id }, T2)),
  });
  // Same return values and the same rows as the reference update, except the spelling of the
  // cancelled status ('canceled' before, TASK_STATUS.CANCELED now).
  assert.deepEqual(outcome.portResult, outcome.referenceResult);
  assert.deepEqual(outcome.portResult, [1, 0, 0]);
  assert.deepEqual(outcome.portRows.coin_jobs, outcome.referenceRows.coin_jobs);
  assert.deepEqual(outcome.portRows.coin_work_tasks, outcome.referenceRows.coin_work_tasks.map((task) => (
    task.status === 'canceled' ? { ...task, status: TASK_STATUS.CANCELED } : task)));
  const [pending, done] = outcome.portRows.coin_work_tasks;
  assert.deepEqual([pending.status, pending.updated_at, pending.completed_at], [TASK_STATUS.CANCELED, T2, null]);
  assert.equal(TASK_STATUS.CANCELED, 'cancelled');
  assert.equal(done.status, 'completed');
});

test('insertCompletedLegacyVenueWorkTaskWithApi writes the reference completed task and returns its id', async () => {
  const outcome = await compareWithPreB7({
    seed: (api) => {
      const makerJobRow = readJob(api, insertGuildJob(api, { userId: BARTENDER_ID, jobName: '調酒師', dailySalary: 60 }));
      insertTask(api, { userId: CHEF_ID, jobName: '廚師', taskType: 'casino_venue_meal', messageId: 'venue-item-1' });
      return { makerJobRow };
    },
    port: (api, { makerJobRow }) => venueTasks.insertCompletedLegacyVenueWorkTaskWithApi(api, {
      guildId: GUILD_ID,
      makerUserId: BARTENDER_ID,
      makerJobRow,
      taskType: 'casino_venue_drink',
      description: '星光氣泡飲 製作完成\n加冰',
      timestamp: T2,
    }),
    reference: (api, { makerJobRow }) => referenceInsertCompletedTask(api, { guildId: GUILD_ID, makerUserId: BARTENDER_ID },
      makerJobRow, 'casino_venue_drink', '星光氣泡飲 製作完成\n加冰', T2),
  });
  assertSameAsPreB7(outcome);
  const tasks = outcome.portRows.coin_work_tasks;
  // The id comes from the task insert even though the job update runs after it.
  assert.equal(outcome.portResult, tasks[1].id);
  assert.deepEqual([tasks[1].status, tasks[1].job_id, tasks[1].expected_channel_id, tasks[1].message_id,
    tasks[1].created_at, tasks[1].due_at, tasks[1].completed_at, tasks[1].updated_at],
  ['completed', outcome.seeded.makerJobRow.id, null, null, T2, T2, T2, T2]);
  const job = outcome.portRows.coin_jobs[0];
  assert.deepEqual([job.last_contribution_at, job.today_task_count, job.today_completed_task_count, job.updated_at],
    [T2, 1, 1, T2]);
});

test('task closing updates match the reference refund, overdue and pre-v22 waiter reassignment updates', async () => {
  const seed = (api) => {
    const waiter = { userId: WAITER_ID, jobName: '服務生', taskType: 'casino_venue_service' };
    const maker = { userId: CHEF_ID, jobName: '廚師', taskType: 'casino_venue_meal' };
    return {
      waiterPending: insertTask(api, { ...waiter, messageId: 'venue-order-5' }),
      waiterDone: insertTask(api, { ...waiter, messageId: 'venue-order-5', status: 'completed', completedAt: T0 }),
      waiterOtherGuild: insertTask(api, { ...waiter, guildId: OTHER_GUILD_ID, messageId: 'venue-order-5' }),
      waiterOtherOrder: insertTask(api, { ...waiter, messageId: 'venue-order-6' }),
      makerPending: insertTask(api, { ...maker, messageId: 'venue-item-7' }),
      makerOtherItem: insertTask(api, { ...maker, messageId: 'venue-item-8' }),
    };
  };
  const refund = await compareWithPreB7({
    seed,
    port: (api) => venueTasks.closeWaiterTaskForTipRefundWithApi(api, {
      guildId: GUILD_ID, orderId: 5, timestamp: T2, cause: 'waiter_overdue',
    }),
    reference: (api) => referenceCloseWaiterTaskOnRefund(api, { guildId: GUILD_ID, id: 5 }, T2),
  });
  assertSameAsPreB7(refund);
  // A late maker closes the same rows with a review reason that does not blame the waiter.
  const makerLate = await compareWithPreB7({
    seed,
    port: (api) => venueTasks.closeWaiterTaskForTipRefundWithApi(api, {
      guildId: GUILD_ID, orderId: 5, timestamp: T2, cause: 'maker_overdue',
    }),
    reference: (api) => referenceCloseWaiterTaskOnRefund(api, { guildId: GUILD_ID, id: 5 }, T2),
  });
  assert.deepEqual(makerLate.portRows.coin_work_tasks, makerLate.referenceRows.coin_work_tasks.map((task) => (
    task.status === TASK_STATUS.SYSTEM_COMPLETED
      ? { ...task, review_reason: '餐飲製作逾期由小吉接手，服務生不算逾期；小費已退還顧客。' } : task)));
  // The cancellation of a cancelled order's waiter task: cancelled, its own reason, completed_at
  // left empty, the same rows touched.
  const cancelledOrder = await compareWithPreB7({
    seed,
    port: (api) => venueTasks.cancelWaiterTaskForCancelledOrderWithApi(api, { guildId: GUILD_ID, orderId: 5, timestamp: T2 }),
    reference: (api) => referenceCloseWaiterTaskOnRefund(api, { guildId: GUILD_ID, id: 5 }, T2),
  });
  assert.deepEqual(cancelledOrder.portRows.coin_work_tasks, cancelledOrder.referenceRows.coin_work_tasks.map((task) => (
    task.status === TASK_STATUS.SYSTEM_COMPLETED
      ? { ...task, status: TASK_STATUS.CANCELED, completed_at: null, review_reason: '訂單已取消，服務生任務一併取消；小費已退還顧客。' }
      : task)));
  // The cause is required: leaving it out, or an unknown one, writes nothing.
  for (const cause of [undefined, 'unknown', 'toString']) {
    const refused = await inRolledBackTransaction((api) => {
      seed(api);
      let thrown = null;
      try {
        venueTasks.closeWaiterTaskForTipRefundWithApi(api, { guildId: GUILD_ID, orderId: 5, timestamp: T2, cause });
      } catch (error) {
        thrown = error;
      }
      return { thrown, statuses: readTables(api, ['coin_work_tasks']).coin_work_tasks.map((task) => task.status) };
    });
    assert.ok(refused.thrown instanceof TypeError && /known cause/u.test(refused.thrown.message), String(cause));
    assert.deepEqual(refused.statuses, ['pending', 'completed', 'pending', 'pending', 'pending', 'pending'], String(cause));
  }
  const overdue = await compareWithPreB7({
    seed,
    port: (api) => venueTasks.closeOverdueMakerTaskWithApi(api, { guildId: GUILD_ID, itemId: 7, timestamp: T2 }),
    reference: (api) => referenceCloseOverdueMakerTask(api, { guildId: GUILD_ID, id: 7 }, T2),
  });
  assertSameAsPreB7(overdue);
  const legacyReassign = await compareWithPreB7({
    seed,
    port: (api) => venueTasks.cancelPendingLegacyWaiterTasksWithApi(api, { guildId: GUILD_ID, orderId: 5, timestamp: T2 }),
    reference: (api) => referenceCancelLegacyWaiterTasks(api, GUILD_ID, 5, T2),
  });
  assertSameAsPreB7(legacyReassign);

  const statusOf = (outcome) => outcome.portRows.coin_work_tasks
    .map((task) => [task.message_id, task.status, task.completed_at, task.review_reason, task.updated_at]);
  const untouched = (messageId) => [messageId, 'pending', null, null, T0];
  assert.deepEqual(statusOf(makerLate), [
    ['venue-order-5', TASK_STATUS.SYSTEM_COMPLETED, T2, '餐飲製作逾期由小吉接手，服務生不算逾期；小費已退還顧客。', T2],
    ['venue-order-5', 'completed', T0, null, T0],
    untouched('venue-order-5'),
    untouched('venue-order-6'),
    untouched('venue-item-7'),
    untouched('venue-item-8'),
  ]);
  assert.deepEqual(statusOf(cancelledOrder), [
    ['venue-order-5', TASK_STATUS.CANCELED, null, '訂單已取消，服務生任務一併取消；小費已退還顧客。', T2],
    ['venue-order-5', 'completed', T0, null, T0],
    untouched('venue-order-5'),
    untouched('venue-order-6'),
    untouched('venue-item-7'),
    untouched('venue-item-8'),
  ]);
  assert.deepEqual(statusOf(refund), [
    ['venue-order-5', TASK_STATUS.SYSTEM_COMPLETED, T2, '服務生逾期未送達，由小吉完成並退還小費。', T2],
    ['venue-order-5', 'completed', T0, null, T0],
    untouched('venue-order-5'),
    untouched('venue-order-6'),
    untouched('venue-item-7'),
    untouched('venue-item-8'),
  ]);
  assert.deepEqual(statusOf(overdue), [
    untouched('venue-order-5'),
    ['venue-order-5', 'completed', T0, null, T0],
    untouched('venue-order-5'),
    untouched('venue-order-6'),
    ['venue-item-7', TASK_STATUS.SYSTEM_COMPLETED, T2, '餐飲製作逾期 24 小時未完成，由小吉場館人員接手。', T2],
    untouched('venue-item-8'),
  ]);
  assert.deepEqual(statusOf(legacyReassign), [
    ['venue-order-5', TASK_STATUS.CANCELED, null, null, T2],
    ['venue-order-5', 'completed', T0, null, T0],
    untouched('venue-order-5'),
    untouched('venue-order-6'),
    untouched('venue-item-7'),
    untouched('venue-item-8'),
  ]);
});

// ---------------------------------------------------------------------------------------
// Least-busy maker selection before the query split
// ---------------------------------------------------------------------------------------
//
// When an order names no chef or bartender, the venue gives the item to the maker with the fewest
// venue items that day.  These cases record whom each path picks today: the global path (schema
// v22 and later) ranks every active primary cycle and venueService takes the first visible one;
// the pre-v22 path picks one guild job.  They cover different loads, equal loads, no venue items
// at all and items in every status.  Only rankGlobalMakers and pickLegacyMaker call the ports, so
// the expectations do not depend on how the ports get their counts.

const FOURTH_CHEF_ID = '330000000000000034';
const FIFTH_CHEF_ID = '330000000000000035';
const SECOND_BARTENDER_ID = '330000000000000042';
const LOAD_WINDOW = Object.freeze({ guildId: GUILD_ID, startIso: DAY_RANGE.startIso, endIso: DAY_RANGE.endIso });

// [user, cycle, items counted] of every candidate, in the order the global path tries them.
function rankGlobalMakers(api, { itemType = 'meal', jobName = '廚師', timestamp = T2 } = {}) {
  const makerLoads = countMakerItemsInWindowWithApi(api, { ...LOAD_WINDOW, itemType });
  return venueTasks.listGlobalMakerCyclesByLoadWithApi(api, { jobName, timestamp, makerLoads })
    .map((row) => [row.user_id, row.cycle_id, row.assigned_count]);
}

// [user, job id, items counted] of the job the pre-v22 path picks, or null.
function pickLegacyMaker(api, { itemType = 'meal', jobName = '廚師' } = {}) {
  const makerLoads = countMakerItemsInWindowWithApi(api, { ...LOAD_WINDOW, itemType });
  const row = venueTasks.getLeastBusyLegacyMakerJobWithApi(api, { guildId: GUILD_ID, jobName, makerLoads });
  return row ? [row.user_id, row.id, row.assigned_count] : null;
}

function insertLoadItem(api, {
  guildId = GUILD_ID, itemType = 'meal', makerUserId, makerIsNpc = 0, status = 'completed', createdAt = T1,
}) {
  api.run(
    `INSERT INTO casino_venue_order_items (
      guild_id, order_id, item_type, menu_item_id, item_name, standard_steps, maker_user_id,
      maker_job_id, maker_job_name, maker_is_npc, status, created_at, updated_at
    ) VALUES (?, 1, ?, NULL, 'synthetic item', 'synthetic step', ?, NULL, NULL, ?, ?, ?, ?)`,
    [guildId, itemType, makerUserId, makerIsNpc, status, createdAt, createdAt]
  );
}

function insertLoadItems(api, makerUserId, count, fields = {}) {
  for (let index = 0; index < count; index += 1) insertLoadItem(api, { makerUserId, ...fields });
}

// The maker items of the "every status" cases: CHEF made one item in each status (3), SECOND_CHEF
// made one item at the very start of the day and others that do not count (1), THIRD_CHEF made two
// pending items (2); BARTENDER made one cancelled drink and two meals, SECOND_BARTENDER two drinks.
function insertMixedLoadItems(api) {
  for (const status of ['pending', 'completed', 'cancelled']) insertLoadItem(api, { makerUserId: CHEF_ID, status });
  insertLoadItem(api, { makerUserId: SECOND_CHEF_ID, createdAt: DAY_RANGE.startIso });
  insertLoadItem(api, { makerUserId: SECOND_CHEF_ID, createdAt: '2026-03-31T15:59:59.999Z' });
  insertLoadItem(api, { makerUserId: SECOND_CHEF_ID, createdAt: DAY_RANGE.endIso });
  insertLoadItem(api, { makerUserId: SECOND_CHEF_ID, makerIsNpc: 1 });
  insertLoadItem(api, { makerUserId: SECOND_CHEF_ID, itemType: 'drink' });
  insertLoadItem(api, { makerUserId: SECOND_CHEF_ID, guildId: OTHER_GUILD_ID });
  insertLoadItems(api, THIRD_CHEF_ID, 2, { status: 'pending' });
  insertLoadItem(api, { makerUserId: BARTENDER_ID, itemType: 'drink', status: 'cancelled' });
  insertLoadItems(api, BARTENDER_ID, 2, { itemType: 'meal' });
  insertLoadItems(api, SECOND_BARTENDER_ID, 2, { itemType: 'drink', status: 'pending' });
}

test('global least-busy ranking: fewest items first, equal loads by the earlier start, then by cycle id', async () => {
  const ranked = await inRolledBackTransaction((api) => {
    // Inserted out of order on purpose. 'load-tie-B' sorts before 'load-tie-a' in binary order only.
    insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'load-a', startsAt: T0 });
    insertPrimaryCycle(api, { userId: SECOND_CHEF_ID, jobName: '廚師', cycleId: 'load-b', startsAt: T1 });
    insertPrimaryCycle(api, { userId: THIRD_CHEF_ID, jobName: '廚師', cycleId: 'load-tie-a', startsAt: T0 });
    insertPrimaryCycle(api, { userId: FOURTH_CHEF_ID, jobName: '廚師', cycleId: 'load-tie-B', startsAt: T0 });
    insertPrimaryCycle(api, { userId: FIFTH_CHEF_ID, jobName: '廚師', cycleId: 'load-e', startsAt: T1 });
    // Not candidates: a cycle that ends at the query time and a settled one.
    insertPrimaryCycle(api, { userId: WAITER_ID, jobName: '廚師', cycleId: 'load-ended', startsAt: T0, endsAt: T2 });
    insertPrimaryCycle(api, { userId: UNIFORM_WAITER_ID, jobName: '廚師', cycleId: 'load-settled', status: 'settled' });
    insertLoadItems(api, CHEF_ID, 2);
    for (const userId of [SECOND_CHEF_ID, THIRD_CHEF_ID, FOURTH_CHEF_ID]) insertLoadItems(api, userId, 1);
    return rankGlobalMakers(api);
  });
  assert.deepEqual(ranked, [
    [FIFTH_CHEF_ID, 'load-e', 0],
    [FOURTH_CHEF_ID, 'load-tie-B', 1],
    [THIRD_CHEF_ID, 'load-tie-a', 1],
    [SECOND_CHEF_ID, 'load-b', 1],
    [CHEF_ID, 'load-a', 2],
  ]);
});

test('global least-busy ranking without any venue item: earlier start first, then cycle id', async () => {
  const ranked = await inRolledBackTransaction((api) => {
    insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'idle-c', startsAt: T1 });
    insertPrimaryCycle(api, { userId: SECOND_CHEF_ID, jobName: '廚師', cycleId: 'idle-b', startsAt: T0 });
    insertPrimaryCycle(api, { userId: THIRD_CHEF_ID, jobName: '廚師', cycleId: 'idle-a', startsAt: T0 });
    insertPrimaryCycle(api, { userId: BARTENDER_ID, jobName: '調酒師', cycleId: 'idle-z', startsAt: T0 });
    return {
      meal: rankGlobalMakers(api),
      drink: rankGlobalMakers(api, { itemType: 'drink', jobName: '調酒師' }),
      nobody: rankGlobalMakers(api, { jobName: '翻譯官' }),
    };
  });
  assert.deepEqual(ranked, {
    meal: [[THIRD_CHEF_ID, 'idle-a', 0], [SECOND_CHEF_ID, 'idle-b', 0], [CHEF_ID, 'idle-c', 0]],
    drink: [[BARTENDER_ID, 'idle-z', 0]],
    nobody: [],
  });
});

test('global least-busy ranking counts a maker\'s items in every status, for this guild, type and day only', async () => {
  const ranked = await inRolledBackTransaction((api) => {
    insertPrimaryCycle(api, { userId: CHEF_ID, jobName: '廚師', cycleId: 'mixed-a', startsAt: T0 });
    insertPrimaryCycle(api, { userId: SECOND_CHEF_ID, jobName: '廚師', cycleId: 'mixed-b', startsAt: T0 });
    insertPrimaryCycle(api, { userId: THIRD_CHEF_ID, jobName: '廚師', cycleId: 'mixed-c', startsAt: T0 });
    insertPrimaryCycle(api, { userId: BARTENDER_ID, jobName: '調酒師', cycleId: 'mixed-x', startsAt: T0 });
    insertPrimaryCycle(api, { userId: SECOND_BARTENDER_ID, jobName: '調酒師', cycleId: 'mixed-y', startsAt: T0 });
    insertMixedLoadItems(api);
    return { meal: rankGlobalMakers(api), drink: rankGlobalMakers(api, { itemType: 'drink', jobName: '調酒師' }) };
  });
  assert.deepEqual(ranked, {
    meal: [[SECOND_CHEF_ID, 'mixed-b', 1], [THIRD_CHEF_ID, 'mixed-c', 2], [CHEF_ID, 'mixed-a', 3]],
    drink: [[BARTENDER_ID, 'mixed-x', 1], [SECOND_BARTENDER_ID, 'mixed-y', 2]],
  });
});

test('pre-v22 least-busy pick: fewest items first, equal loads by the earlier job, then by job id', async () => {
  const pick = (seed) => inRolledBackTransaction((api) => {
    const jobs = seed(api);
    return { jobs, picked: pickLegacyMaker(api) };
  });

  const differentLoads = await pick((api) => {
    const jobs = {
      busy: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T0 }),
      once: insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師', createdAt: T0 }),
      idleLater: insertGuildJob(api, { userId: THIRD_CHEF_ID, jobName: '廚師', createdAt: T1 }),
    };
    insertLoadItems(api, CHEF_ID, 2);
    insertLoadItems(api, SECOND_CHEF_ID, 1);
    return jobs;
  });
  assert.deepEqual(differentLoads.picked, [THIRD_CHEF_ID, differentLoads.jobs.idleLater, 0]);

  // Equal loads: the earlier job wins; on the same creation time the smaller job id, not the user id.
  const equalLoads = await pick((api) => {
    const jobs = {
      later: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T1 }),
      earlierFirst: insertGuildJob(api, { userId: THIRD_CHEF_ID, jobName: '廚師', createdAt: T0 }),
      earlierSecond: insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師', createdAt: T0 }),
    };
    for (const userId of [CHEF_ID, SECOND_CHEF_ID, THIRD_CHEF_ID]) insertLoadItems(api, userId, 1);
    return jobs;
  });
  assert.deepEqual(equalLoads.picked, [THIRD_CHEF_ID, equalLoads.jobs.earlierFirst, 1]);

  const noItems = await pick((api) => ({
    later: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T1 }),
    earlier: insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師', createdAt: T0 }),
  }));
  assert.deepEqual(noItems.picked, [SECOND_CHEF_ID, noItems.jobs.earlier, 0]);

  // Both active jobs of one user carry that user's whole count.
  const oneUserTwoJobs = await pick((api) => {
    const jobs = {
      laterOfTwo: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T1 }),
      other: insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師', createdAt: T0 }),
      earlierOfTwo: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T0 }),
    };
    insertLoadItems(api, CHEF_ID, 1);
    insertLoadItems(api, SECOND_CHEF_ID, 2);
    return jobs;
  });
  assert.deepEqual(oneUserTwoJobs.picked, [CHEF_ID, oneUserTwoJobs.jobs.earlierOfTwo, 1]);
});

test('pre-v22 least-busy pick counts a maker\'s items in every status and needs an active guild job of that name', async () => {
  const outcome = await inRolledBackTransaction((api) => {
    const jobs = {
      chef: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T0 }),
      secondChef: insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師', createdAt: T1 }),
      thirdChef: insertGuildJob(api, { userId: THIRD_CHEF_ID, jobName: '廚師', createdAt: T0 }),
      bartender: insertGuildJob(api, { userId: BARTENDER_ID, jobName: '調酒師', createdAt: T1 }),
      secondBartender: insertGuildJob(api, { userId: SECOND_BARTENDER_ID, jobName: '調酒師', createdAt: T0 }),
    };
    insertMixedLoadItems(api);
    const picks = { meal: pickLegacyMaker(api), drink: pickLegacyMaker(api, { itemType: 'drink', jobName: '調酒師' }) };
    // Without an active job of that name in this guild nobody is picked: paid, failed or other-guild jobs.
    api.run("UPDATE coin_jobs SET status = 'paid', is_paid = 1 WHERE job_name = '調酒師'");
    insertGuildJob(api, { userId: FOURTH_CHEF_ID, jobName: '調酒師', status: 'failed' });
    insertGuildJob(api, { guildId: OTHER_GUILD_ID, userId: FIFTH_CHEF_ID, jobName: '調酒師' });
    picks.drinkWithoutActiveJob = pickLegacyMaker(api, { itemType: 'drink', jobName: '調酒師' });
    picks.unknownJob = pickLegacyMaker(api, { jobName: '翻譯官' });
    return { jobs, picks };
  });
  assert.deepEqual(outcome.picks, {
    meal: [SECOND_CHEF_ID, outcome.jobs.secondChef, 1],
    drink: [BARTENDER_ID, outcome.jobs.bartender, 1],
    drinkWithoutActiveJob: null,
    unknownJob: null,
  });
});

// ---------------------------------------------------------------------------------------
// The split ranking against the joined queries
// ---------------------------------------------------------------------------------------
//
// Representative states from the random differential check of the split, where the joined and the
// split ranking agreed on every state: ties at every level, text keys whose binary order differs
// from case-insensitive, UTF-16 and length order, two spellings of the same instant, a current and
// an older cycle of one user, two jobs of one user, and items that do and do not count.  The split
// ranking must return the joined query's rows with the same values, columns and column order;
// referenceGlobalMakerCycles and referenceLeastBusyMaker above are byte-for-byte copies of those queries.

const T0_OTHER_SPELLING = '2026-04-01T01:00:00Z';

function assertSameRowsAndColumns(outcome) {
  assertSameAsPreB7(outcome);
  assert.equal(JSON.stringify(outcome.portResult), JSON.stringify(outcome.referenceResult), 'column order differs');
}

test('the split global ranking returns the joined query\'s rows, in its order, on a tie-heavy state', async () => {
  const outcome = await compareWithPreB7({
    seed: (api) => {
      const chef = (userId, cycleId, startsAt = T0, fields = {}) => insertPrimaryCycle(api, {
        userId, jobName: '廚師', cycleId, startsAt, ...fields,
      });
      chef(CHEF_ID, 'A');
      chef(SECOND_CHEF_ID, 'ｱ');
      chef(THIRD_CHEF_ID, '😀');
      chef(FOURTH_CHEF_ID, 'c10');
      chef(FIFTH_CHEF_ID, 'c2');
      chef(BARTENDER_ID, 'c1');
      chef(SECOND_BARTENDER_ID, 'tie-B', T0_OTHER_SPELLING);
      // Not candidates: a primary job still waiting for its legacy jobs, a settled current cycle and an
      // older active cycle of CHEF that is not CHEF's current one.
      chef(WAITER_ID, 'pending-legacy', T0, { state: 'pending_legacy' });
      chef(UNIFORM_WAITER_ID, 'settled-current', T0, { status: 'settled' });
      api.run(
        `INSERT INTO coin_primary_job_cycles (cycle_id, user_id, job_name, work_days, source_guild_id, starts_at, ends_at,
          salary_rule_version, salary_snapshot_json, status, reward_key, created_at, updated_at)
         VALUES ('0-older', ?, '廚師', 2, ?, ?, ?, 'synthetic', '{}', 'active', NULL, ?, ?)`,
        [CHEF_ID, GUILD_ID, T0, PAY_AT, T0, T0]
      );
      for (const userId of [SECOND_CHEF_ID, THIRD_CHEF_ID, FOURTH_CHEF_ID, FIFTH_CHEF_ID, SECOND_BARTENDER_ID]) {
        insertLoadItem(api, { makerUserId: userId });
      }
      insertLoadItem(api, { makerUserId: BARTENDER_ID, status: 'odd' });
      // Items that count for nobody: CHEF's made by NPC staff, of another type, guild or day; no maker.
      insertLoadItem(api, { makerUserId: CHEF_ID, makerIsNpc: 1 });
      insertLoadItem(api, { makerUserId: CHEF_ID, itemType: 'drink' });
      insertLoadItem(api, { makerUserId: CHEF_ID, guildId: OTHER_GUILD_ID });
      insertLoadItem(api, { makerUserId: CHEF_ID, createdAt: DAY_RANGE.endIso });
      insertLoadItem(api, { makerUserId: null });
      return {};
    },
    port: (api) => venueTasks.listGlobalMakerCyclesByLoadWithApi(api, {
      jobName: '廚師', timestamp: T2, makerLoads: countMakerItemsInWindowWithApi(api, { ...LOAD_WINDOW, itemType: 'meal' }),
    }),
    reference: (api) => referenceGlobalMakerCycles(api, GUILD_ID, 'meal', DAY_RANGE, T2),
    tables: ['coin_primary_job_cycles', 'casino_venue_order_items'],
  });
  assertSameRowsAndColumns(outcome);
  // Binary text order: 'c1' < 'c10' < 'c2' < 'ｱ' < '😀', and '...00.000Z' < '...00Z' for the start.
  assert.deepEqual(outcome.portResult.map((row) => [row.user_id, row.cycle_id, row.assigned_count]), [
    [CHEF_ID, 'A', 0],
    [BARTENDER_ID, 'c1', 1],
    [FOURTH_CHEF_ID, 'c10', 1],
    [FIFTH_CHEF_ID, 'c2', 1],
    [SECOND_CHEF_ID, 'ｱ', 1],
    [THIRD_CHEF_ID, '😀', 1],
    [SECOND_BARTENDER_ID, 'tie-B', 1],
  ]);
});

test('the split pre-v22 pick returns the joined query\'s row on tie-heavy states', async () => {
  const pickBoth = (seed) => compareWithPreB7({
    seed,
    port: (api) => venueTasks.getLeastBusyLegacyMakerJobWithApi(api, {
      guildId: GUILD_ID, jobName: '廚師', makerLoads: countMakerItemsInWindowWithApi(api, { ...LOAD_WINDOW, itemType: 'meal' }),
    }),
    reference: (api) => referenceLeastBusyMaker(api, GUILD_ID, 'meal', DAY_RANGE),
    tables: ['coin_jobs', 'casino_venue_order_items'],
  });

  // No load anywhere: the earlier spelling of the same instant first, then the smaller job id.
  const idle = await pickBoth((api) => {
    const jobs = {
      otherSpelling: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T0_OTHER_SPELLING }),
      chefSecondJob: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T0 }),
      secondChef: insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師', createdAt: T0 }),
    };
    insertGuildJob(api, { guildId: OTHER_GUILD_ID, userId: THIRD_CHEF_ID, jobName: '廚師', createdAt: '2026-03-30T00:00:00.000Z' });
    insertGuildJob(api, { userId: FOURTH_CHEF_ID, jobName: '廚師', status: 'failed', createdAt: '2026-03-30T00:00:00.000Z' });
    insertLoadItem(api, { makerUserId: CHEF_ID, makerIsNpc: 1 });
    insertLoadItem(api, { makerUserId: SECOND_CHEF_ID, itemType: 'drink' });
    insertLoadItem(api, { makerUserId: null });
    return jobs;
  });
  assertSameRowsAndColumns(idle);
  assert.deepEqual([idle.portResult.user_id, idle.portResult.id, idle.portResult.assigned_count],
    [CHEF_ID, idle.seeded.chefSecondJob, 0]);

  // A tie at the lowest load: the smaller job id among the jobs of the same time.
  const tied = await pickBoth((api) => {
    const jobs = {
      thirdChef: insertGuildJob(api, { userId: THIRD_CHEF_ID, jobName: '廚師', createdAt: T0 }),
      secondChef: insertGuildJob(api, { userId: SECOND_CHEF_ID, jobName: '廚師', createdAt: T0 }),
      chef: insertGuildJob(api, { userId: CHEF_ID, jobName: '廚師', createdAt: T0 }),
      fourthChef: insertGuildJob(api, { userId: FOURTH_CHEF_ID, jobName: '廚師', createdAt: '2026-03-30T00:00:00.000Z' }),
    };
    insertLoadItems(api, CHEF_ID, 2);
    insertLoadItem(api, { makerUserId: SECOND_CHEF_ID, status: 'pending' });
    insertLoadItem(api, { makerUserId: THIRD_CHEF_ID, status: 'odd' });
    insertLoadItems(api, FOURTH_CHEF_ID, 3, { status: 'cancelled' });
    return jobs;
  });
  assertSameRowsAndColumns(tied);
  assert.deepEqual([tied.portResult.user_id, tied.portResult.id, tied.portResult.assigned_count],
    [THIRD_CHEF_ID, tied.seeded.thirdChef, 1]);
});
