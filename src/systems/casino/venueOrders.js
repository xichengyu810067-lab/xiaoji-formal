// Venue-table SQL used by the work system.
//
// The casino system owns casino_venue_orders and casino_venue_order_items. The statements that
// read and write them live here, and the work system's callers (src/systems/work/jobCycle.js,
// payroll.js and workService.js) pass in the api of their own coin transaction.
// The SQL text (including the whitespace inside template literals), the bound values, their
// order and their time source are part of the behavior: keep them byte for byte when editing.
//
// Leaf-module rules:
// - every export is a *WithApi(api, ...) port that runs on the api the caller received from its
//   own coin transaction (or read-only database) callback; nothing here opens, commits or rolls
//   back a transaction, and nothing here reads the clock: every timestamp comes from the caller;
// - every port runs exactly one statement and returns what api.get, api.all or api.run returned,
//   so a SELECT changes() or last_insert_rowid() that the caller runs next sees the same value;
// - this file loads no other module, so it cannot take part in a CommonJS require cycle;
// - validation, error codes, error messages and the salary and bonus arithmetic stay with the
//   caller.
//
// countMakerItemsInWindowWithApi reads the venue half of the least-busy maker ranking: the venue
// items of each maker in the window, under the venue conditions of that ranking.
// src/services/venueService.js passes its counts to src/systems/work/venueTasks.js, which reads
// the work tables and does the ranking.
//
// The three venue-sweep ports share one order condition: venueService's 24-hour sweep lists its
// due orders with it, and workService's primary-task expiry sweep uses it to leave those orders'
// waiter tasks to the venue sweep.

// --- Legacy guild-scoped jobs (coin_jobs) ----------------------------------------------

// A pending item made for one legacy job.  Used by jobCycle hasOpenLegacyVenueWithApi.
function findPendingLegacyMakerItemWithApi(api, jobId) {
  return api.get(
    "SELECT 1 AS found FROM casino_venue_order_items WHERE maker_job_id = ? AND status = 'pending' LIMIT 1",
    [jobId]
  );
}

// An order whose tip is still escrowed for one legacy waiter job.  Used by jobCycle
// hasOpenLegacyVenueWithApi.
function findEscrowedLegacyWaiterOrderWithApi(api, jobId) {
  return api.get(
    "SELECT 1 AS found FROM casino_venue_orders WHERE waiter_job_id = ? AND tip_status = 'escrowed' LIMIT 1",
    [jobId]
  );
}

// A completed item of one legacy job whose bonus is still unpaid, items made by NPC staff
// included.  Used by the jobCycle activation check (legacyReadyForActivation).
function findUnpaidLegacyMakerBonusItemWithApi(api, jobId) {
  return api.get(
    "SELECT 1 AS found FROM casino_venue_order_items WHERE maker_job_id = ? AND status = 'completed' AND bonus_paid = 0 AND bonus_amount > 0 LIMIT 1",
    [jobId]
  );
}

// The unpaid bonus items one legacy maker job made itself, oldest first.  Used by the legacy
// payroll (workService calculateVenueBonusForJob).
function listUnpaidLegacyMakerBonusItemsWithApi(api, { guildId, userId, jobId }) {
  return api.all(
    `SELECT id, bonus_amount
     FROM casino_venue_order_items
     WHERE guild_id = ?
       AND maker_user_id = ?
       AND maker_job_id = ?
       AND maker_is_npc = 0
       AND status = 'completed'
       AND bonus_paid = 0
       AND bonus_amount > 0
     ORDER BY completed_at ASC, id ASC`,
    [guildId, userId, jobId]
  );
}

// Marks the bonus of one item paid by the legacy payroll (workService processDueJobs).
function markLegacyMakerBonusPaidWithApi(api, { guildId, itemId, timestamp }) {
  return api.run(
    `UPDATE casino_venue_order_items
             SET bonus_paid = 1, updated_at = ?
             WHERE guild_id = ? AND id = ?`,
    [timestamp, guildId, itemId]
  );
}

// --- Primary job cycles (coin_primary_job_cycles) --------------------------------------

// An order of one primary waiter cycle whose tip is still escrowed.  Used by payroll
// hasOpenPrimaryWaiterOrderWithApi.
function findEscrowedPrimaryWaiterOrderWithApi(api, { cycleId, userId }) {
  return api.get(
    "SELECT 1 AS found FROM casino_venue_orders WHERE waiter_global_cycle_id = ? AND waiter_user_id = ? AND tip_status = 'escrowed' LIMIT 1",
    [cycleId, userId]
  );
}

// A tipped order of a waiter that belongs to neither a legacy job nor a primary cycle.  Used by
// payroll verifyPrimaryWaiterOrdersWithApi.
function findUnlinkedTippedWaiterOrderWithApi(api, userId) {
  return api.get(
    "SELECT 1 AS found FROM casino_venue_orders WHERE waiter_user_id = ? AND waiter_job_id IS NULL AND waiter_global_cycle_id IS NULL AND tip_amount > 0 AND tip_status IN ('escrowed','paid') LIMIT 1",
    [userId]
  );
}

// Every order of one primary waiter cycle, by id.  Used by payroll
// verifyPrimaryWaiterOrdersWithApi.
function listPrimaryWaiterOrdersWithApi(api, cycleId) {
  return api.all(
    'SELECT id,guild_id,waiter_user_id,waiter_job_id,waiter_job_name,tip_amount,tip_status FROM casino_venue_orders WHERE waiter_global_cycle_id = ? ORDER BY id',
    [cycleId]
  );
}

// A pending item of one primary maker cycle.  Used by workService processDuePrimaryCycles.
function findPendingPrimaryMakerItemWithApi(api, cycleId) {
  return api.get(
    "SELECT 1 AS found FROM casino_venue_order_items WHERE global_cycle_id = ? AND status = 'pending' LIMIT 1",
    [cycleId]
  );
}

// A completed item that a maker made in [startsAt, endsAt], that no primary cycle owns and whose
// bonus is not marked paid, whatever its bonus amount (0 included).  Used by payroll
// calculateGlobalPayrollWithApi.
function findUnlinkedMakerBonusItemWithApi(api, { userId, startsAt, endsAt }) {
  return api.get(
    "SELECT 1 AS found FROM casino_venue_order_items WHERE maker_user_id = ? AND maker_is_npc = 0 AND status = 'completed' AND bonus_paid = 0 AND global_cycle_id IS NULL AND completed_at >= ? AND completed_at <= ? LIMIT 1",
    [userId, startsAt, endsAt]
  );
}

// The unpaid bonus items one maker made itself in one primary cycle, oldest first.  Used by
// payroll calculateGlobalPayrollWithApi.
function listUnpaidPrimaryMakerBonusItemsWithApi(api, { cycleId, userId }) {
  return api.all(
    "SELECT id,bonus_amount FROM casino_venue_order_items WHERE global_cycle_id = ? AND maker_user_id = ? AND maker_is_npc = 0 AND status = 'completed' AND bonus_paid = 0 AND bonus_amount > 0 ORDER BY completed_at,id",
    [cycleId, userId]
  );
}

// Marks the bonus of one item paid by the primary cycle settlement (workService
// processDuePrimaryCycles).
function markPrimaryMakerBonusPaidWithApi(api, { itemId, cycleId, timestamp }) {
  return api.run(
    'UPDATE casino_venue_order_items SET bonus_paid = 1, updated_at = ? WHERE id = ? AND global_cycle_id = ?',
    [timestamp, itemId, cycleId]
  );
}

// --- Orders the 24-hour venue sweep closes ----------------------------------------------
//
// The venue sweep (venueService processExpiredVenueOrderItems) refunds the escrowed tip of an
// unserved order and, in the same step, closes the order's waiter task (guild of the order,
// message id 'venue-order-<id>') with the cause: late waiter or late maker.  It does so for every
// order that matches VENUE_SWEEP_ORDER_CONDITION once the order is 24 hours old and has no pending
// item; the same sweep hands every pending item to NPC staff once that item is 24 hours old, so
// each such order is closed in time.  The primary-task expiry sweep (workService
// processExpiredPrimaryTasks) leaves exactly those waiter tasks to the venue sweep and closes
// every other one, so no waiter task is left to neither sweep.  The three statements below share
// this one condition so the two sweeps cannot drift apart.
const VENUE_SWEEP_ORDER_CONDITION = "o.tip_status = 'escrowed' AND o.served_at IS NULL AND o.tip_amount > 0";

// The guild and waiter-task message id of every order the venue sweep closes, by order id.  Used
// by workService processExpiredPrimaryTasks to leave those waiter tasks out before its limit.
function listVenueSweepWaiterTaskKeysWithApi(api) {
  return api.all(
    `SELECT o.guild_id, 'venue-order-' || o.id AS message_id FROM casino_venue_orders o WHERE ${VENUE_SWEEP_ORDER_CONDITION} ORDER BY o.id`
  );
}

// The order the venue sweep closes for one waiter task (its guild and message id), if any.  Used
// by workService processExpiredPrimaryTasks to check a task again inside its transaction.
function findVenueSweepOrderForTaskWithApi(api, { guildId, messageId }) {
  return api.get(
    `SELECT 1 AS found FROM casino_venue_orders o WHERE o.guild_id = ? AND 'venue-order-' || o.id = ? AND ${VENUE_SWEEP_ORDER_CONDITION} LIMIT 1`,
    [guildId, messageId]
  );
}

// The orders the venue sweep closes in this pass: those orders created at or before cutoff that no
// longer have a pending item, by order id.  Used by venueService processExpiredVenueOrderItems,
// after it has handed the pending items of that age to NPC staff.
function listVenueSweepDueOrdersWithApi(api, { cutoff }) {
  return api.all(
    `SELECT o.*
     FROM casino_venue_orders o
     WHERE ${VENUE_SWEEP_ORDER_CONDITION}
       AND o.created_at <= ?
       AND NOT EXISTS (
         SELECT 1 FROM casino_venue_order_items i
         WHERE i.guild_id = o.guild_id
           AND i.order_id = o.id
           AND i.status = ?
       )
     ORDER BY o.id`,
    [cutoff, 'pending']
  );
}

// --- Maker load (the least-busy split) -------------------------------------------------

// How many items each maker made in [startIso, endIso) for one guild and item type, items made
// by NPC staff left out and every item status counted.  Makers without such an item are not
// listed.  venueService passes these rows to the least-busy maker ranking of venueTasks.
function countMakerItemsInWindowWithApi(api, { guildId, itemType, startIso, endIso }) {
  return api.all(
    `SELECT i.maker_user_id, COUNT(i.id) AS assigned_count
     FROM casino_venue_order_items i
     WHERE i.guild_id = ?
       AND i.item_type = ? AND i.maker_is_npc = 0 AND i.created_at >= ? AND i.created_at < ?
     GROUP BY i.maker_user_id`,
    [guildId, itemType, startIso, endIso]
  );
}

module.exports = {
  countMakerItemsInWindowWithApi,
  findEscrowedLegacyWaiterOrderWithApi,
  findEscrowedPrimaryWaiterOrderWithApi,
  findPendingLegacyMakerItemWithApi,
  findPendingPrimaryMakerItemWithApi,
  findUnlinkedMakerBonusItemWithApi,
  findUnlinkedTippedWaiterOrderWithApi,
  findUnpaidLegacyMakerBonusItemWithApi,
  findVenueSweepOrderForTaskWithApi,
  listPrimaryWaiterOrdersWithApi,
  listUnpaidLegacyMakerBonusItemsWithApi,
  listUnpaidPrimaryMakerBonusItemsWithApi,
  listVenueSweepDueOrdersWithApi,
  listVenueSweepWaiterTaskKeysWithApi,
  markLegacyMakerBonusPaidWithApi,
  markPrimaryMakerBonusPaidWithApi,
};
