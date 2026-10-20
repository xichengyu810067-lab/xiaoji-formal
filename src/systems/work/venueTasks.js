// Work-table SQL used by the casino venue flows.
//
// src/services/venueService.js reads and writes the work system's tables (coin_jobs,
// coin_work_tasks, coin_work_legacy_snapshots, coin_work_legacy_snapshot_items,
// coin_primary_jobs_global, coin_primary_job_cycles) through the statements in this module.
// The SQL text (including the whitespace inside template literals), the bound values, their
// order and their time source are part of the behavior: keep them byte for byte when editing.
//
// Leaf-module rules:
// - every export is a *WithApi(api, ...) port that runs on the api the caller received from
//   its own coin transaction (or read-only database) callback; nothing here opens, commits or
//   rolls back a transaction, and nothing here reads the clock: every timestamp comes from
//   the caller;
// - this file loads no other module, so it cannot take part in a CommonJS require cycle;
// - validation, error codes and error messages stay with the caller.
//
// The two least-busy maker queries read only the work tables. The venue item counts they rank by
// come from countMakerItemsInWindowWithApi (src/systems/casino/venueOrders.js) and are passed in
// by the caller; rankByLoad below orders the candidates by those counts, then by the given
// order columns.
//
// Cancelled tasks are written as TASK_STATUS.CANCELED ('cancelled'). Rows written before that
// fix may still hold 'canceled'; the work system's readers accept both spellings.

// Work-task statuses bound by these statements.  They must stay equal to TASK_STATUS in
// src/systems/work/workService.js (test/venueTasks.test.js pins this); they are copied here
// because a leaf module cannot load workService.
const TASK_STATUS = Object.freeze({
  PENDING: 'pending',
  COMPLETED: 'completed',
  SYSTEM_COMPLETED: 'system_completed',
  CANCELED: 'cancelled',
});

function serializeArray(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

// The order SQLite's ORDER BY gives the values of one column: NULL first, then numbers by value,
// then text in the BINARY collation (byte order of its UTF-8 encoding), then blobs byte by byte.
// This relies on the sort columns (cycle_id, starts_at, created_at, id) being made by the system
// and being valid UTF-8.  Text with a lone surrogate would come back from sql.js with U+FFFD in
// its place, and the order would then no longer be sure to match SQLite's.
function sqliteTypeRank(value) {
  if (value === null || value === undefined) return 0;
  if (typeof value === 'number' || typeof value === 'bigint') return 1;
  if (typeof value === 'string') return 2;
  return 3;
}

function compareSqliteValues(left, right) {
  const rank = sqliteTypeRank(left);
  if (rank !== sqliteTypeRank(right)) return rank - sqliteTypeRank(right);
  if (rank === 0) return 0;
  if (rank === 1) return left < right ? -1 : left > right ? 1 : 0;
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

// Adds each candidate's venue item count as assigned_count after its columns, the way the joined
// queries returned it (0 for a maker without items), and orders the candidates the way their
// ORDER BY did: fewest items first, then by orderColumns.  The last of orderColumns is a unique
// key of the candidate rows, so the order is total and no other tie rule is needed.
function rankByLoad(rows, makerLoads, orderColumns) {
  const loads = new Map(makerLoads.map((load) => [load.maker_user_id, load.assigned_count]));
  return rows
    .map((row) => ({ ...row, assigned_count: loads.get(row.user_id) ?? 0 }))
    .sort((left, right) => orderColumns.reduce(
      (order, column) => order || compareSqliteValues(left[column], right[column]),
      compareSqliteValues(left.assigned_count, right.assigned_count)
    ));
}

// --- Job rows and primary cycles -------------------------------------------------------

// Newest active guild-scoped (pre-v22) job of one name.
function getActiveJobRowWithApi(api, guildId, userId, jobName) {
  return api.get(
    'SELECT * FROM coin_jobs WHERE guild_id = ? AND user_id = ? AND job_name = ? AND status = ? ORDER BY id DESC LIMIT 1',
    [guildId, userId, jobName, 'active']
  );
}

// Active guild-scoped waiter jobs of a user, uniform waiter first (at most one row).
function listActiveWaiterJobRowsWithApi(api, guildId, userId, waiterJobNames) {
  const placeholders = waiterJobNames.map(() => '?').join(', ');
  return api.all(
    `SELECT *
     FROM coin_jobs
     WHERE guild_id = ?
       AND user_id = ?
       AND job_name IN (${placeholders})
       AND status = 'active'
     ORDER BY CASE job_name WHEN '制服服務生' THEN 0 ELSE 1 END, id DESC
     LIMIT 1`,
    [guildId, userId, ...waiterJobNames]
  );
}

// The original guild-scoped job an order or item was assigned to.
function getAssignedJobRowWithApi(api, { jobId, guildId, userId, jobName }) {
  return api.get('SELECT * FROM coin_jobs WHERE id = ? AND guild_id = ? AND user_id = ? AND job_name = ?',
    [jobId, guildId, userId, jobName]);
}

function getGuildJobRowWithApi(api, { guildId, jobId }) {
  return api.get('SELECT * FROM coin_jobs WHERE guild_id = ? AND id = ?', [guildId, jobId]);
}

// The still-active primary cycle an order or item was assigned to.
function getActiveJobCycleWithApi(api, { cycleId, userId, jobName }) {
  return api.get('SELECT * FROM coin_primary_job_cycles WHERE cycle_id = ? AND user_id = ? AND job_name = ? AND status = ?',
    [cycleId, userId, jobName, 'active']);
}

// Active primary cycles of one job, ranked by the venue items their makers made in the window that
// makerLoads counted: fewest first, then the earlier start, then the cycle id.  Each cycle is the
// current cycle of one primary job, so no cycle appears twice.
function listGlobalMakerCyclesByLoadWithApi(api, { jobName, timestamp, makerLoads }) {
  const cycles = api.all(
    `SELECT c.*
     FROM coin_primary_jobs_global p
     JOIN coin_primary_job_cycles c ON c.cycle_id = p.next_cycle_id AND c.user_id = p.user_id
     WHERE p.state = 'active' AND p.job_name = ? AND c.status = 'active'
       AND c.starts_at <= ? AND c.ends_at > ?`,
    [jobName, timestamp, timestamp]
  );
  return rankByLoad(cycles, makerLoads, ['starts_at', 'cycle_id']);
}

// The active guild-scoped job of one name whose maker made the fewest venue items in the window
// that makerLoads counted; on equal loads the earlier job, then the smaller id.  Null if none.
function getLeastBusyLegacyMakerJobWithApi(api, { guildId, jobName, makerLoads }) {
  const jobs = api.all(
    `SELECT j.*
     FROM coin_jobs j
     WHERE j.guild_id = ?
       AND j.job_name = ?
       AND j.status = 'active'`,
    [guildId, jobName]
  );
  return rankByLoad(jobs, makerLoads, ['created_at', 'id'])[0] || null;
}

// --- Legacy cutover snapshots ----------------------------------------------------------

// Any open, unpaid guild-scoped job that the cutover has not snapshotted yet.
function findUnsnapshottedLegacyJobWithApi(api) {
  return api.get(
    `SELECT 1 AS found FROM coin_jobs j
     LEFT JOIN coin_work_legacy_snapshots s ON s.job_id = j.id
     WHERE j.status IN ('active', 'failed') AND j.is_paid = 0 AND s.job_id IS NULL LIMIT 1`
  );
}

function listLegacyJobSnapshotsWithApi(api) {
  return api.all('SELECT * FROM coin_work_legacy_snapshots ORDER BY job_id');
}

function getLegacyJobSnapshotWithApi(api, jobId) {
  return api.get('SELECT * FROM coin_work_legacy_snapshots WHERE job_id = ?', [jobId]);
}

function getFrozenLegacyTaskSnapshotWithApi(api, jobId, taskId) {
  return api.get(
    "SELECT snapshot_json FROM coin_work_legacy_snapshot_items WHERE job_id = ? AND item_kind = 'task' AND item_id = ?",
    [jobId, taskId]
  );
}

// --- Venue work tasks ------------------------------------------------------------------

// The task rows carry a cycle column from schema version 22 on. The caller has read the version, so it
// must pass the answer: a missing flag would silently write or select rows of the older shape.
function requireGlobalSchemaFlag(globalSchema, operation) {
  if (typeof globalSchema !== 'boolean') {
    throw new TypeError(`${operation} requires globalSchema to be a boolean.`);
  }
}

// Adds the pending task of a newly assigned maker or waiter and returns its id.  A
// guild-scoped job row (no cycle_id) also counts the task on the job.
function insertPendingVenueWorkTaskWithApi(api, { guildId, userId, jobRow, taskType, description, createdAt, dueAt,
  channelId = null, messageId = null, globalSchema }) {
  requireGlobalSchemaFlag(globalSchema, 'insertPendingVenueWorkTaskWithApi');
  const globalCycleId = jobRow.cycle_id || null;
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

// Pending, uncompleted tasks of one assignment (at most two rows, oldest first).
function listPendingVenueWorkTasksWithApi(api, { guildId, userId, jobId = null, globalCycleId = null, taskType, messageId,
  globalSchema }) {
  requireGlobalSchemaFlag(globalSchema, 'listPendingVenueWorkTasksWithApi');
  return api.all(
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
}

// Completes one pending task; returns the number of changed rows (1 on success).
function markVenueWorkTaskCompletedWithApi(api, { guildId, taskId, description, completedAt }) {
  api.run(
    `UPDATE coin_work_tasks
     SET status = ?, description = ?, completed_at = ?, updated_at = ?
     WHERE guild_id = ? AND id = ? AND status = 'pending' AND completed_at IS NULL`,
    [TASK_STATUS.COMPLETED, description, completedAt, completedAt, guildId, taskId]
  );
  return Number(api.get('SELECT changes() AS count').count);
}

// Counts a completed venue task on its guild-scoped job.
function recordLegacyVenueTaskCompletionWithApi(api, { jobId, completedAt }) {
  api.run(
    `UPDATE coin_jobs
       SET last_contribution_at = ?,
           today_completed_task_count = today_completed_task_count + 1,
           updated_at = ?
       WHERE id = ?`,
    [completedAt, completedAt, jobId]
  );
}

// Cancels one pending task after a reassignment or an item cancellation; returns the number of
// changed rows.
function markVenueWorkTaskCanceledWithApi(api, { taskId, timestamp }) {
  api.run(
    "UPDATE coin_work_tasks SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending' AND completed_at IS NULL",
    [TASK_STATUS.CANCELED, timestamp, taskId]
  );
  return Number(api.get('SELECT changes() AS count').count);
}

// Pre-v22 only: records a maker task that had no pending row as completed, counts it on the
// job and returns the new task id.
function insertCompletedLegacyVenueWorkTaskWithApi(api, { guildId, makerUserId, makerJobRow, taskType, description, timestamp }) {
  api.run(
    `INSERT INTO coin_work_tasks
      (
        guild_id, user_id, job_id, job_name, task_type, status, description,
        attachment_urls, expected_channel_id, expected_channel_name, message_id,
        external_server_count, external_server_ids, created_at, due_at, completed_at, updated_at
      )
     VALUES (?, ?, ?, ?, ?, 'completed', ?, ?, NULL, ?, NULL, 0, ?, ?, ?, ?, ?)`,
    [
      guildId,
      makerUserId,
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
  return Number(api.get('SELECT last_insert_rowid() AS id').id);
}

// Why the 24-hour venue sweep refunds an order's escrowed tip; each text is the review reason
// of the waiter task it closes.
const WAITER_TASK_REFUND_REASONS = Object.freeze({
  // Every item was ready and the waiter did not serve the order within 24 hours.
  waiter_overdue: '服務生逾期未送達，由小吉完成並退還小費。',
  // NPC staff made an item whose maker was 24 hours late, so the waiter could not serve in time
  // and is not counted late.
  maker_overdue: '餐飲製作逾期由小吉接手，服務生不算逾期；小費已退還顧客。',
});
const CANCELLED_ORDER_WAITER_TASK_REASON = '訂單已取消，服務生任務一併取消；小費已退還顧客。';

// Closes the waiter's pending service task of an order whose escrowed tip the 24-hour sweep
// refunds.  cause is a key of WAITER_TASK_REFUND_REASONS; it is required so that a caller can
// never name the waiter late by leaving it out.
function closeWaiterTaskForTipRefundWithApi(api, { guildId, orderId, timestamp, cause }) {
  if (!Object.hasOwn(WAITER_TASK_REFUND_REASONS, cause)) {
    throw new TypeError(`closeWaiterTaskForTipRefundWithApi requires a known cause, got ${String(cause)}.`);
  }
  api.run(
    `UPDATE coin_work_tasks
     SET status = ?, completed_at = ?, review_reason = ?, updated_at = ?
     WHERE guild_id = ? AND message_id = ? AND status = ? AND completed_at IS NULL`,
    [
      TASK_STATUS.SYSTEM_COMPLETED,
      timestamp,
      WAITER_TASK_REFUND_REASONS[cause],
      timestamp,
      guildId,
      `venue-order-${orderId}`,
      TASK_STATUS.PENDING,
    ]
  );
}

// Cancels the waiter's pending service task of an order that was cancelled (its last pending
// item was cancelled and nothing was made).  Like every other cancelled task it keeps
// completed_at empty.
function cancelWaiterTaskForCancelledOrderWithApi(api, { guildId, orderId, timestamp }) {
  api.run(
    `UPDATE coin_work_tasks
     SET status = ?, review_reason = ?, updated_at = ?
     WHERE guild_id = ? AND message_id = ? AND status = ? AND completed_at IS NULL`,
    [
      TASK_STATUS.CANCELED,
      CANCELLED_ORDER_WAITER_TASK_REASON,
      timestamp,
      guildId,
      `venue-order-${orderId}`,
      TASK_STATUS.PENDING,
    ]
  );
}

// Pre-v22 only: cancels the pending service tasks of an order whose waiter is reassigned.
function cancelPendingLegacyWaiterTasksWithApi(api, { guildId, orderId, timestamp }) {
  api.run(
    `UPDATE coin_work_tasks
         SET status = ?, updated_at = ?
         WHERE guild_id = ? AND message_id = ? AND status = ? AND completed_at IS NULL`,
    [TASK_STATUS.CANCELED, timestamp, guildId, `venue-order-${orderId}`, TASK_STATUS.PENDING]
  );
}

// Closes the pending maker task of an item that NPC staff took over after 24 hours.
function closeOverdueMakerTaskWithApi(api, { guildId, itemId, timestamp }) {
  api.run(
    `UPDATE coin_work_tasks
           SET status = ?, completed_at = ?, review_reason = ?, updated_at = ?
           WHERE guild_id = ? AND message_id = ? AND status = ? AND completed_at IS NULL`,
    [
      TASK_STATUS.SYSTEM_COMPLETED,
      timestamp,
      '餐飲製作逾期 24 小時未完成，由小吉場館人員接手。',
      timestamp,
      guildId,
      `venue-item-${itemId}`,
      TASK_STATUS.PENDING,
    ]
  );
}

module.exports = {
  cancelPendingLegacyWaiterTasksWithApi,
  cancelWaiterTaskForCancelledOrderWithApi,
  closeOverdueMakerTaskWithApi,
  closeWaiterTaskForTipRefundWithApi,
  findUnsnapshottedLegacyJobWithApi,
  getActiveJobCycleWithApi,
  getActiveJobRowWithApi,
  getAssignedJobRowWithApi,
  getFrozenLegacyTaskSnapshotWithApi,
  getGuildJobRowWithApi,
  getLeastBusyLegacyMakerJobWithApi,
  getLegacyJobSnapshotWithApi,
  insertCompletedLegacyVenueWorkTaskWithApi,
  insertPendingVenueWorkTaskWithApi,
  listActiveWaiterJobRowsWithApi,
  listGlobalMakerCyclesByLoadWithApi,
  listLegacyJobSnapshotsWithApi,
  listPendingVenueWorkTasksWithApi,
  markVenueWorkTaskCanceledWithApi,
  markVenueWorkTaskCompletedWithApi,
  recordLegacyVenueTaskCompletionWithApi,
};
