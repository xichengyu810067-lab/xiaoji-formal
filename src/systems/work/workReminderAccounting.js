'use strict';

const { readActiveWorkReminderSource } = require('../../services/coinDatabase');
const { normalizeReminderSource, reminderOperationId } = require('../safety/workReminderSource');

function sameNullable(left, right) {
  return (left == null ? null : String(left)) === (right == null ? null : String(right));
}

function stateMatches(record, state) {
  return Boolean(record && Number(record.task.reminder_count || 0) === state.taskCount &&
    sameNullable(record.task.last_reminder_at, state.taskLastAt));
}

function laterIso(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(rightMs)) return Number.isFinite(leftMs) ? left : right;
  return Number.isFinite(leftMs) && leftMs > rightMs ? left : right;
}

// This is deliberately a work-system write port.  The safety proof module creates and
// verifies the fixed accounting plan, but it cannot mutate coin tables itself.
function applyWorkReminderPlanWithApi(api, plan) {
  const source = normalizeReminderSource({
    ...plan?.lineage,
    scope: plan?.lineage?.parentKind,
  });
  if (!source || plan.schemaVersion !== 1 || reminderOperationId(source) !== plan.dmOperationId ||
      plan.expectedCount !== source.slot - 1) return Object.freeze({ kind: 'conflict' });
  const before = readActiveWorkReminderSource(api, source);
  if (stateMatches(before, plan.post)) return Object.freeze({ kind: 'already_applied' });
  if (!stateMatches(before, plan.pre) || before.task.status !== 'pending' || before.task.completed_at ||
      before.parent.status !== 'active') return Object.freeze({ kind: 'conflict' });
  api.run(
    `UPDATE coin_work_tasks SET reminder_count = ?, last_reminder_at = ?, updated_at = ?
      WHERE id = ? AND guild_id = ? AND user_id = ? AND created_at = ? AND reminder_count = ?`,
    [plan.post.taskCount, plan.post.taskLastAt,
      laterIso(before.task.updated_at || before.task.created_at, plan.post.taskUpdatedAt), source.taskId,
      source.guildId, source.userId, before.task.created_at, plan.pre.taskCount]
  );
  if (source.scope === 'legacy') {
    api.run(
      `UPDATE coin_jobs SET last_reminder_at = ?, updated_at = ?
        WHERE id = ? AND guild_id = ? AND user_id = ?`,
      [laterIso(before.parent.last_reminder_at, plan.post.jobLastAt || plan.post.taskLastAt),
        laterIso(before.parent.updated_at, plan.post.jobUpdatedAt || plan.post.taskLastAt),
        source.parentId, source.guildId, source.userId]
    );
  }
  const after = readActiveWorkReminderSource(api, source);
  return Object.freeze({ kind: stateMatches(after, plan.post) ? 'applied' : 'conflict' });
}

module.exports = { applyWorkReminderPlanWithApi };
