'use strict';

const crypto = require('node:crypto');
const { normalizeWorkReminderTimestamp, readActiveWorkPenaltySource } = require('../../services/coinDatabase');
const { createLinkApproval, rewriteLinks } = require('../../platform/linkPolicy');
const { version } = require('../../../package.json');

const SNOWFLAKE = /^\d{17,20}$/u;
const sourceProofs = new WeakMap();
const egressApproval = createLinkApproval({ approvedReleaseTag: `v${version}`, releaseTags: 'stable' });

function safeFreeText(value) {
  return rewriteLinks(String(value || ''), {
    approve: egressApproval.approve, maskedLink: 'label-and-marker', bareInvites: true, bareDomains: true,
  }).text;
}

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

function buildWorkPenaltyAnnouncementBody(penalty) {
  const id = Number(penalty?.id);
  const userId = String(penalty?.userId || '');
  const jobName = safeFreeText(penalty?.jobName);
  const amount = Number(penalty?.penaltyAmount);
  const reason = safeFreeText(penalty?.reason);
  const deadline = new Date(penalty?.appealDeadlineAt).getTime();
  if (!Number.isSafeInteger(id) || id < 1 || !SNOWFLAKE.test(userId) || !jobName ||
      !Number.isSafeInteger(amount) || amount < 0 || !reason || !Number.isFinite(deadline)) {
    throw new Error('WORK_PENALTY_SOURCE_INVALID');
  }
  return Object.freeze({
    content: [
      `**小吉工作扣薪公告 #${id}**`,
      `當事人：<@${userId}>`,
      `職業：${jobName}`,
      `扣薪金額：${amount.toLocaleString('zh-TW')} 吉幣`,
      `原因：${reason}`,
      `申訴期限：<t:${Math.floor(deadline / 1000)}:F>`,
      `如需申訴，請使用 \`/work appeal penalty-id:${id} reason:申訴事由\`。`,
    ].join('\n'),
    allowed_mentions: { parse: [], users: [userId], roles: [], replied_user: false },
  });
}

function proveWorkPenaltySourceWithApi(api, { botId, guildId, penaltyId, createdAt, effect } = {}) {
  const normalized = {
    botId: String(botId || ''),
    guildId: String(guildId || ''),
    penaltyId: Number(penaltyId),
    createdAt: String(createdAt || ''),
  };
  if (!SNOWFLAKE.test(normalized.botId) || !SNOWFLAKE.test(normalized.guildId) ||
      !Number.isSafeInteger(normalized.penaltyId) || normalized.penaltyId < 1 || !normalized.createdAt) return null;
  const row = readActiveWorkPenaltySource(api, normalized);
  if (!row || row.status !== 'active' || row.announced_at) return null;
  // The event time must name its offset (a trailing Z or ±HH:MM, the work reminder rule):
  // a local-time created_at would read differently on another host, so it is never sent.
  const zonedCreatedAt = normalizeWorkReminderTimestamp(row.created_at);
  const sourceTimestampMs = zonedCreatedAt ? Date.parse(zonedCreatedAt) : Number.NaN;
  const target = String(effect?.target || '');
  let expectedBody;
  try {
    expectedBody = buildWorkPenaltyAnnouncementBody({
      id: row.id,
      userId: row.user_id,
      jobName: row.job_name,
      penaltyAmount: row.penalty_amount,
      reason: row.reason,
      appealDeadlineAt: row.appeal_deadline_at,
    });
  } catch {
    return null;
  }
  if (!Number.isSafeInteger(sourceTimestampMs) || sourceTimestampMs < 0 || !SNOWFLAKE.test(target) ||
      effect?.purposeId !== 'work.penalty.announce' || effect?.action !== 'work-penalty-message.create' ||
      String(effect?.method || '').toUpperCase() !== 'POST' ||
      effect?.route !== `/channels/${target}/messages` || stableJson(effect?.body) !== stableJson(expectedBody)) return null;
  const proof = Object.freeze({ kind: 'trusted-work-penalty-source' });
  sourceProofs.set(proof, Object.freeze({
    ...normalized,
    sourceTimestampMs,
    purposeId: 'work.penalty.announce',
    sourceNamespace: 'db.coin_work_penalties',
    hostPurpose: 'db.coin_work_penalties',
    sourceEventId: `${normalized.guildId}.${normalized.penaltyId}.${normalized.createdAt}`,
    scope: `guild:${normalized.guildId}`,
    action: effect.action,
    target,
    method: 'POST',
    route: effect.route,
    body: stableValue(expectedBody),
    payloadDigest: sha256(stableJson(expectedBody)),
  }));
  return proof;
}

function consumeWorkPenaltySourceProof(proof) {
  const record = sourceProofs.get(proof) || null;
  if (record) sourceProofs.delete(proof);
  return record;
}

module.exports = {
  buildWorkPenaltyAnnouncementBody,
  consumeWorkPenaltySourceProof,
  proveWorkPenaltySourceWithApi,
};
