'use strict';

const crypto = require('node:crypto');
const { normalizeWorkReminderTimestamp, readActiveWorkReminderSource } = require('../../services/coinDatabase');
const { createLinkApproval, rewriteLinks } = require('../../platform/linkPolicy');
const { version } = require('../../../package.json');

const SNOWFLAKE = /^\d{17,20}$/u;
const MAX_SLOT = 3;
const RECOVERY_COOLDOWN_MS = 10 * 60 * 60 * 1000;
const sourceProofs = new WeakMap();
const accountingProofs = new WeakMap();
const egressApproval = createLinkApproval({ approvedReleaseTag: `v${version}`, releaseTags: 'stable' });

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// Same rule as the database lookup: only a string with a trailing Z or ±HH:MM offset is a
// timestamp; anything else (including a local-time string) normalizes to null.
function iso(value) {
  return normalizeWorkReminderTimestamp(value);
}

function sameNullable(left, right) {
  return (left == null ? null : String(left)) === (right == null ? null : String(right));
}

function normalizeReminderSource(source) {
  const normalized = {
    namespace: 'db.coin_work_tasks.reminder',
    botId: String(source?.botId || ''),
    guildId: String(source?.guildId || ''),
    userId: String(source?.userId || ''),
    taskId: Number(source?.taskId),
    createdAt: iso(source?.createdAt),
    scope: source?.scope === 'legacy' ? 'legacy' : source?.scope === 'global' ? 'global' : null,
    parentId: source?.scope === 'legacy' ? Number(source?.parentId) : String(source?.parentId || ''),
    slot: Number(source?.slot),
  };
  if (![normalized.botId, normalized.guildId, normalized.userId].every((value) => SNOWFLAKE.test(value)) ||
      !Number.isSafeInteger(normalized.taskId) || normalized.taskId < 1 || !normalized.createdAt ||
      !normalized.scope || !Number.isSafeInteger(normalized.slot) || normalized.slot < 1 || normalized.slot > MAX_SLOT ||
      (normalized.scope === 'legacy' && (!Number.isSafeInteger(normalized.parentId) || normalized.parentId < 1)) ||
      (normalized.scope === 'global' && !normalized.parentId)) return null;
  return Object.freeze(normalized);
}

function reminderOperationSeed(source) {
  return Object.freeze({
    schemaVersion: 1,
    botId: source.botId,
    namespace: source.namespace,
    guildId: source.guildId,
    userId: source.userId,
    taskId: source.taskId,
    createdAt: source.createdAt,
    parentKind: source.scope,
    parentId: source.parentId,
    slot: source.slot,
  });
}

function reminderOperationId(source) {
  const normalized = normalizeReminderSource(source);
  if (!normalized) return null;
  const seed = {
    schemaVersion: 1,
    purposeId: 'work.reminder.dm.send',
    botId: normalized.botId,
    sourceNamespace: normalized.namespace,
    guildId: normalized.guildId,
    userId: normalized.userId,
    taskId: normalized.taskId,
    createdAt: normalized.createdAt,
    parentKind: normalized.scope,
    parentId: normalized.parentId,
    slot: normalized.slot,
  };
  return `work.reminder.dm.send-v1:${sha256(stableJson(seed))}`;
}

function buildWorkReminderPreparationRecord(input) {
  const source = normalizeReminderSource(input);
  const dmOperationId = reminderOperationId(source);
  if (!source || !dmOperationId) return null;
  return Object.freeze({
    ...source,
    dmOperationId,
    purposeId: 'work.reminder.dm.prepare',
    sourceNamespace: 'discord.work-reminder-recipient',
    sourceTimestampMs: Date.parse(source.createdAt),
  });
}

function buildWorkReminderSendRecord(input) {
  const source = normalizeReminderSource(input);
  if (!source) return null;
  return Object.freeze({
    ...source,
    purposeId: 'work.reminder.dm.send',
    sourceNamespace: source.namespace,
    taskScope: source.scope,
    sourceTimestampMs: Date.parse(source.createdAt),
  });
}

function buildWorkReminderBody(task) {
  const taskId = Number(task?.id ?? task?.taskId);
  const taskType = String(task?.task_type ?? task?.taskType ?? '');
  const description = rewriteLinks(String(task?.description || taskType).trim(), {
    approve: egressApproval.approve, maskedLink: 'label-and-marker', bareInvites: true, bareDomains: true,
  }).text;
  if (!Number.isSafeInteger(taskId) || taskId < 1 || !taskType || !description) return null;
  const actionHint = taskType.startsWith('casino_venue_')
    ? '你有尚未完成的場館任務，請用對應場館指令處理。'
    : '請使用 /work submit 的 task-id 完成這筆待辦。';
  return Object.freeze({
    content: ['你有一筆小吉工作待辦。', `任務 #${taskId}：${description}`, actionHint].join('\n'),
    allowed_mentions: Object.freeze({ parse: [], users: [], roles: [], replied_user: false }),
  });
}

function sourceRow(api, source) {
  return readActiveWorkReminderSource(api, source);
}

function isEligible(record, source, { nowIso, cutoffIso, force = false } = {}) {
  const now = iso(nowIso);
  const cutoff = iso(cutoffIso);
  const task = record?.task;
  const parent = record?.parent;
  if (!now || !cutoff || !task || !parent || task.status !== 'pending' || task.completed_at ||
      Number(task.reminder_count || 0) !== source.slot - 1 || source.slot > MAX_SLOT ||
      parent.status !== 'active') return false;
  if (source.scope === 'legacy' && force === true) return true;
  if (Date.parse(task.due_at) > Date.parse(now)) return false;
  const notAfterCutoff = (value) => !value || Date.parse(value) <= Date.parse(cutoff);
  if (source.scope === 'legacy' && !notAfterCutoff(parent.last_contribution_at)) return false;
  // The legacy job-level reminder time only selects a batch. Sibling tasks of one
  // job reminded earlier in the same batch must not revoke each other, so the final
  // authorization uses the per-task cooldown for both legacy and global tasks.
  return notAfterCutoff(task.last_reminder_at);
}

function buildDmChannelBinding(operation, response, botId, recipientId) {
  const base = {
    schemaVersion: 1,
    botId,
    recipientId,
    channelId: String(response?.id || ''),
    channelType: Number(response?.type),
    recipientCount: Array.isArray(response?.recipients) ? response.recipients.length : -1,
    prepareOperationId: operation?.operationId,
    prepareBindingDigest: operation?.bindingDigest,
  };
  return Object.freeze({ ...base, bindingProof: sha256(stableJson(base)) });
}

function validateCreatedDm(response, recipientId) {
  return Boolean(response && response.type === 1 && SNOWFLAKE.test(String(response.id || '')) &&
    Array.isArray(response.recipients) && response.recipients.length === 1 &&
    String(response.recipients[0]?.id || '') === recipientId);
}

function validateDmChannelBinding(result, botId, recipientId) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const keys = ['bindingProof', 'botId', 'channelId', 'channelType', 'prepareBindingDigest',
    'prepareOperationId', 'recipientCount', 'recipientId', 'schemaVersion'];
  if (Object.keys(result).sort().join(',') !== keys.sort().join(',') || result.schemaVersion !== 1 ||
      result.botId !== botId || result.recipientId !== recipientId || result.channelType !== 1 ||
      result.recipientCount !== 1 || !SNOWFLAKE.test(result.channelId || '') ||
      !String(result.prepareOperationId || '').startsWith('work.reminder.dm.prepare-v1:') ||
      !/^[a-f0-9]{64}$/u.test(String(result.prepareBindingDigest || ''))) return null;
  const base = { ...result };
  delete base.bindingProof;
  return sha256(stableJson(base)) === result.bindingProof ? result.channelId : null;
}

function validateDmChannelBindingForOperation(result, operation, botId, recipientId) {
  const channelId = validateDmChannelBinding(result, botId, recipientId);
  if (!channelId || operation?.status !== 'confirmed' ||
      result.prepareOperationId !== operation.operationId ||
      result.prepareBindingDigest !== operation.bindingDigest) return null;
  return channelId;
}

function proveWorkReminderSourceWithApi(api, {
  source: input, effect, nowIso, cutoffIso, force = false, channelBinding = null, preparationOperation = null,
} = {}) {
  const source = normalizeReminderSource(input);
  if (!source) return null;
  const record = sourceRow(api, source);
  if (!isEligible(record, source, { nowIso, cutoffIso, force })) return null;
  const purposeId = String(effect?.purposeId || '');
  let authorized;
  if (purposeId === 'work.reminder.dm.prepare') {
    if (effect?.action !== 'work-reminder-dm-channel.prepare' || effect?.target !== source.userId ||
        String(effect?.method || '').toUpperCase() !== 'POST' || effect?.route !== '/users/@me/channels' ||
        stableJson(effect?.body) !== stableJson({ recipient_id: source.userId })) return null;
    const dmOperationId = reminderOperationId(source);
    if (!dmOperationId) return null;
    authorized = {
      ...source,
      dmOperationId,
      purposeId,
      sourceNamespace: 'discord.work-reminder-recipient',
      hostPurpose: 'discord.work-reminder-recipient',
      sourceEventId: dmOperationId,
      taskScope: source.scope,
      scope: `bot:${source.botId}:recipient:${source.userId}`,
      action: effect.action,
      target: source.userId,
      method: 'POST',
      route: effect.route,
      body: stableValue(effect.body),
      payloadDigest: sha256(stableJson(effect.body)),
      sourceTimestampMs: Date.parse(source.createdAt),
    };
  } else if (purposeId === 'work.reminder.dm.send') {
    const channelId = validateDmChannelBindingForOperation(channelBinding, preparationOperation,
      source.botId, source.userId);
    const expectedBody = buildWorkReminderBody(record.task);
    if (!channelId || effect?.action !== 'work-reminder-message.create' || effect?.target !== channelId ||
        String(effect?.method || '').toUpperCase() !== 'POST' ||
        effect?.route !== `/channels/${channelId}/messages` || stableJson(effect?.body) !== stableJson(expectedBody)) return null;
    authorized = {
      ...source,
      purposeId,
      sourceNamespace: source.namespace,
      hostPurpose: source.namespace,
      sourceEventId: `${source.guildId}.${source.taskId}.${source.slot}`,
      taskScope: source.scope,
      scope: `guild:${source.guildId}:user:${source.userId}`,
      action: effect.action,
      target: channelId,
      recipientId: source.userId,
      preparationOperationId: channelBinding.prepareOperationId,
      preparationBindingDigest: channelBinding.prepareBindingDigest,
      channelBindingProof: channelBinding.bindingProof,
      method: 'POST',
      route: effect.route,
      body: stableValue(expectedBody),
      payloadDigest: sha256(stableJson(expectedBody)),
      sourceTimestampMs: Date.parse(source.createdAt),
    };
  } else {
    return null;
  }
  const proof = Object.freeze({ kind: 'trusted-work-reminder-source' });
  sourceProofs.set(proof, Object.freeze(authorized));
  return proof;
}

function consumeWorkReminderSourceProof(proof) {
  const record = sourceProofs.get(proof) || null;
  if (record) sourceProofs.delete(proof);
  return record;
}

function planOperationId(dmOperationId) {
  return `work-reminder-accounting-plan-v1:${sha256(String(dmOperationId || ''))}`;
}

function ackOperationId(dmOperationId) {
  return `work-reminder-accounting-ack-v1:${sha256(String(dmOperationId || ''))}`;
}

function expectedStates(record, fixedAt) {
  const task = record.task;
  const pre = {
    taskCount: Number(task.reminder_count || 0),
    taskLastAt: task.last_reminder_at || null,
    taskUpdatedAt: task.updated_at || task.created_at,
  };
  const post = {
    taskCount: pre.taskCount + 1,
    taskLastAt: fixedAt,
    // A recovered outcome may carry an older fixed time; updated_at never moves backwards.
    taskUpdatedAt: laterIso(pre.taskUpdatedAt, fixedAt),
  };
  if (record.scope === 'legacy') {
    pre.jobLastAt = record.parent.last_reminder_at || null;
    pre.jobUpdatedAt = record.parent.updated_at;
    // Sibling tasks of one legacy job share these columns; never move them backwards.
    post.jobLastAt = laterIso(pre.jobLastAt, fixedAt);
    post.jobUpdatedAt = laterIso(pre.jobUpdatedAt, fixedAt);
  }
  return { pre, post };
}

function laterIso(left, right) {
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (!Number.isFinite(rightMs)) return Number.isFinite(leftMs) ? left : right;
  return Number.isFinite(leftMs) && leftMs > rightMs ? left : right;
}

function proveWorkReminderPlanWithApi(api, { source: input, dmOperationId, outcome } = {}) {
  const source = normalizeReminderSource(input);
  const fixedAt = iso(outcome?.fixedAt);
  const reason = String(outcome?.reason || '');
  if (!source || reminderOperationId(source) !== dmOperationId || !fixedAt ||
      !/^[a-z][a-z0-9_]{0,63}$/u.test(reason)) return null;
  const record = sourceRow(api, source);
  if (!record || Number(record.task.reminder_count || 0) !== source.slot - 1 ||
      record.task.status !== 'pending' || record.task.completed_at || record.parent.status !== 'active') return null;
  const { pre, post } = expectedStates(record, fixedAt);
  if (pre.taskLastAt && Date.parse(pre.taskLastAt) > Date.parse(fixedAt)) return null;
  const plan = Object.freeze({
    schemaVersion: 1,
    dmOperationId,
    lineage: reminderOperationSeed(source),
    expectedCount: source.slot - 1,
    reason,
    attemptedAt: iso(outcome?.attemptedAt) || fixedAt,
    completionAt: outcome?.completionAt ? iso(outcome.completionAt) : null,
    recoveryNotBefore: new Date(Date.parse(iso(outcome?.attemptedAt) || fixedAt) + RECOVERY_COOLDOWN_MS).toISOString(),
    pre,
    post,
  });
  const proof = Object.freeze({ kind: 'trusted-work-reminder-accounting-plan' });
  accountingProofs.set(proof, Object.freeze({ kind: 'plan', source, plan }));
  return proof;
}

// Only the task's own reminder slot decides whether a plan is pending or applied:
// reminder_count advances exactly once per slot and last_reminder_at is written only
// by this accounting. updated_at columns and the shared legacy job row are also
// written by edits, venue and payroll flows, so pinning them would turn an
// unrelated update into a permanent accounting conflict.
function stateMatches(record, state) {
  return Boolean(record && Number(record.task.reminder_count || 0) === state.taskCount &&
    sameNullable(record.task.last_reminder_at, state.taskLastAt));
}

function proveWorkReminderAckWithApi(api, { source: input, plan, planOperationId: operationId,
  planResultDigest, appliedAt } = {}) {
  const source = normalizeReminderSource(input);
  if (!source || operationId !== planOperationId(plan?.dmOperationId) ||
      !/^[a-f0-9]{64}$/u.test(String(planResultDigest || ''))) return null;
  const record = sourceRow(api, source);
  if (!stateMatches(record, plan.post)) return null;
  const ack = Object.freeze({
    schemaVersion: 1,
    dmOperationId: plan.dmOperationId,
    planOperationId: operationId,
    planResultDigest,
    accountingApplied: true,
    appliedAt: iso(appliedAt) || plan.post.taskUpdatedAt,
    postDigest: sha256(stableJson(plan.post)),
  });
  const proof = Object.freeze({ kind: 'trusted-work-reminder-accounting-ack' });
  accountingProofs.set(proof, Object.freeze({ kind: 'ack', source, ack }));
  return proof;
}

function consumeWorkReminderAccountingProof(proof) {
  const record = accountingProofs.get(proof) || null;
  if (record) accountingProofs.delete(proof);
  return record;
}

module.exports = {
  MAX_SLOT,
  RECOVERY_COOLDOWN_MS,
  ackOperationId,
  buildDmChannelBinding,
  buildWorkReminderPreparationRecord,
  buildWorkReminderSendRecord,
  buildWorkReminderBody,
  consumeWorkReminderAccountingProof,
  consumeWorkReminderSourceProof,
  normalizeReminderSource,
  planOperationId,
  proveWorkReminderAckWithApi,
  proveWorkReminderPlanWithApi,
  proveWorkReminderSourceWithApi,
  reminderOperationId,
  stableJson,
  validateCreatedDm,
  validateDmChannelBinding,
  validateDmChannelBindingForOperation,
};
