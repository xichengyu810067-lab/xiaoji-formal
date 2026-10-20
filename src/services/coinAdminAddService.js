const crypto = require('node:crypto');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const { adjustPlayerBalanceWithApi } = require('./coinService');
const { CoinCampaignError } = require('./coinCampaignService');

const MAX_COIN_AMOUNT = 9_000_000_000;
const VALID_STATUSES = new Set(['pending', 'partial', 'completed', 'cancelled']);

function requiredText(value, name, maxLength = 300) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) {
    throw new CoinCampaignError('INVALID_ARGUMENT', `${name} is invalid.`);
  }
  return text;
}

function normalizePreview(input) {
  const mode = input.mode;
  if (!['user', 'role'].includes(mode)) {
    throw new CoinCampaignError('INVALID_AUDIENCE', 'Add confirmation mode is invalid.');
  }
  const operationId = requiredText(input.operationId, 'operationId', 200);
  const actorUserId = requiredText(input.actorUserId, 'actorUserId', 80);
  const guildId = requiredText(input.guildId, 'guildId', 80);
  const amount = Number(input.amount);
  const expiresAt = Number(input.expiresAt);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_COIN_AMOUNT ||
      !Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    throw new CoinCampaignError('INVALID_ARGUMENT', 'Add confirmation amount or expiry is invalid.');
  }
  const normalized = {
    operationId,
    mode,
    actorUserId,
    guildId,
    targetUserId: mode === 'user' ? requiredText(input.targetUserId, 'targetUserId', 80) : null,
    roleId: mode === 'role' ? requiredText(input.roleId, 'roleId', 80) : null,
    campaignId: mode === 'role' ? requiredText(input.campaignId, 'campaignId', 160) : null,
    previewToken: mode === 'role' ? requiredText(input.previewToken, 'previewToken', 64) : null,
    amount,
    reason: requiredText(input.reason, 'reason', 300),
    expiresAt,
  };
  if (normalized.previewToken && !/^[a-f0-9]{64}$/.test(normalized.previewToken)) {
    throw new CoinCampaignError('INVALID_ARGUMENT', 'Campaign preview token is invalid.');
  }
  return normalized;
}

function previewPayloadHash(preview) {
  return crypto.createHash('sha256').update(JSON.stringify([
    preview.operationId,
    preview.mode,
    preview.actorUserId,
    preview.guildId,
    preview.targetUserId || '',
    preview.roleId || '',
    preview.campaignId || '',
    preview.previewToken || '',
    preview.amount,
    preview.reason,
    preview.expiresAt,
  ])).digest('hex');
}

function mapRow(row) {
  if (!row || !VALID_STATUSES.has(row.status)) return null;
  let result = null;
  if (row.result_json != null) {
    try { result = JSON.parse(row.result_json); }
    catch { throw new CoinCampaignError('PREVIEW_CHANGED', 'Stored add confirmation result is invalid.'); }
  }
  const mapped = {
    operationId: row.operation_id,
    mode: row.mode,
    actorUserId: row.actor_user_id,
    guildId: row.guild_id,
    targetUserId: row.target_user_id,
    roleId: row.role_id,
    campaignId: row.campaign_id,
    previewToken: row.preview_token,
    amount: Number(row.amount),
    reason: row.reason,
    expiresAt: Number(row.expires_at),
    payloadHash: row.payload_hash,
    status: row.status,
    result,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  const normalized = normalizePreview(mapped);
  if (!/^[a-f0-9]{64}$/.test(mapped.payloadHash) || previewPayloadHash(normalized) !== mapped.payloadHash) {
    throw new CoinCampaignError('PREVIEW_CHANGED', 'Stored add confirmation payload is invalid.');
  }
  return mapped;
}

function getRow(api, operationId) {
  const row = mapRow(api.get(
    'SELECT * FROM coin_admin_add_confirmations WHERE operation_id = ?', [operationId]
  ));
  if (!row) throw new CoinCampaignError('PREVIEW_CHANGED', 'Stored add confirmation is missing.');
  return row;
}

function validateControl(row, input) {
  const expectedDigest = String(input.digest || '');
  if (row.mode !== input.mode || row.actorUserId !== input.actorUserId ||
      row.guildId !== input.guildId || row.expiresAt !== Number(input.expiresAt) ||
      row.payloadHash.slice(0, 24) !== expectedDigest) {
    throw new CoinCampaignError('PREVIEW_SCOPE_MISMATCH', 'Stored add confirmation scope differs.');
  }
  return row;
}

function assertConfirmable(row, nowSeconds) {
  if (row.status !== 'pending') return;
  if (Number(nowSeconds) > row.expiresAt) {
    throw new CoinCampaignError('PREVIEW_EXPIRED', 'Stored add confirmation expired.');
  }
}

async function createAddConfirmation(input) {
  const preview = normalizePreview(input);
  const payloadHash = previewPayloadHash(preview);
  return withCoinTransaction((api) => {
    const existing = api.get(
      'SELECT * FROM coin_admin_add_confirmations WHERE operation_id = ?', [preview.operationId]
    );
    if (existing) {
      const mapped = mapRow(existing);
      if (mapped.payloadHash !== payloadHash) {
        throw new CoinCampaignError('PREVIEW_CHANGED', 'Operation ID already belongs to another add preview.');
      }
      return mapped;
    }
    const timestamp = new Date().toISOString();
    api.run(`INSERT INTO coin_admin_add_confirmations
      (operation_id, mode, actor_user_id, guild_id, target_user_id, role_id, campaign_id,
       preview_token, amount, reason, expires_at, payload_hash, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`, [
      preview.operationId, preview.mode, preview.actorUserId, preview.guildId,
      preview.targetUserId, preview.roleId, preview.campaignId, preview.previewToken,
      preview.amount, preview.reason, preview.expiresAt, payloadHash, timestamp, timestamp,
    ]);
    return getRow(api, preview.operationId);
  });
}

async function getAddConfirmation(operationId) {
  return withCoinDatabase((api) => getRow(api, requiredText(operationId, 'operationId', 200)));
}

async function cancelAddConfirmation(input) {
  return withCoinTransaction((api) => {
    const row = validateControl(getRow(api, requiredText(input.operationId, 'operationId', 200)), input);
    if (row.status === 'pending') {
      const timestamp = new Date().toISOString();
      api.run(`UPDATE coin_admin_add_confirmations
        SET status = 'cancelled', updated_at = ? WHERE operation_id = ? AND status = 'pending'`,
      [timestamp, row.operationId]);
      return { state: 'cancelled', confirmation: getRow(api, row.operationId) };
    }
    if (row.status === 'cancelled') return { state: 'cancelled', confirmation: row };
    if (row.status === 'completed') return { state: 'completed', confirmation: row };
    return { state: 'partial', confirmation: row };
  });
}

async function confirmUserAdd(input) {
  return withCoinTransaction((api) => {
    const row = validateControl(getRow(api, requiredText(input.operationId, 'operationId', 200)), input);
    if (row.mode !== 'user') throw new CoinCampaignError('PREVIEW_CHANGED', 'Confirmation mode is not user.');
    assertConfirmable(row, input.nowSeconds);
    if (row.status === 'cancelled') return { state: 'cancelled', confirmation: row };
    if (row.status === 'completed') {
      return { state: 'completed', confirmation: row, result: { ...row.result, alreadyApplied: true } };
    }
    if (row.status !== 'pending') throw new CoinCampaignError('PREVIEW_CHANGED', 'User confirmation state is invalid.');
    const result = adjustPlayerBalanceWithApi(api, row.guildId, row.targetUserId, {
      action: 'add', amount: row.amount, operatorId: row.actorUserId,
      reason: row.reason, operationId: row.operationId,
    });
    const timestamp = new Date().toISOString();
    api.run(`UPDATE coin_admin_add_confirmations
      SET status = 'completed', result_json = ?, updated_at = ?
      WHERE operation_id = ? AND status = 'pending'`,
    [JSON.stringify({ before: result.before, amount: result.amount, after: result.after,
      alreadyApplied: result.alreadyApplied }), timestamp, row.operationId]);
    return { state: 'completed', confirmation: getRow(api, row.operationId), result };
  });
}

// A role add is 'pending' until it pays someone and 'partial' from its first payment on: then members may already have
// been paid, so it can no longer be cancelled, only resumed. That move happens in the transaction of the first new
// payment (roleAddPaymentGate), never before it, so a press that stops before paying anyone (history not reconciled,
// the preview changed, the member list incomplete, every payment refused) leaves the add pending, still cancellable.

// Checks a press of the role confirm button (scope, mode, and the expiry of an add that has not paid anyone yet) and
// returns the stored add without changing it.
async function authorizeRoleAdd(input) {
  return withCoinDatabase((api) => {
    const row = validateControl(getRow(api, requiredText(input.operationId, 'operationId', 200)), input);
    if (row.mode !== 'role') throw new CoinCampaignError('PREVIEW_CHANGED', 'Confirmation mode is not role.');
    assertConfirmable(row, input.nowSeconds);
    return row;
  });
}

// The payment gate of one role add, for applyOwnerCampaign. Each payment runs open() first in its own transaction:
// only an add that is still pending or partial may pay. After a new payment, paid() moves pending to partial in that
// same transaction. A cancel commits only while the add is pending, so it either comes before every payment of the
// add, and every later payment then stops here, or it is refused because a payment was already made.
function roleAddPaymentGate(operationId) {
  const id = requiredText(operationId, 'operationId', 200);
  return Object.freeze({
    open(api) {
      const row = getRow(api, id);
      if (row.mode !== 'role') throw new CoinCampaignError('PREVIEW_CHANGED', 'Confirmation mode is not role.');
      if (row.status !== 'pending' && row.status !== 'partial') {
        const closed = new CoinCampaignError('ADD_CONFIRMATION_CLOSED', 'Role confirmation is no longer open.');
        closed.status = row.status;
        throw closed;
      }
    },
    paid(api) {
      api.run(`UPDATE coin_admin_add_confirmations
        SET status = 'partial', updated_at = ? WHERE operation_id = ? AND status = 'pending'`,
      [new Date().toISOString(), id]);
    },
  });
}

// Records the result of one press. An add that is still pending paid no one through any press, so it stays pending
// while something is left to retry and is completed when nothing is; a partial one stays partial or is completed. A
// cancelled or completed add is left as it is.
async function recordRoleAddResult(operationId, result, retryable) {
  return withCoinTransaction((api) => {
    const row = getRow(api, requiredText(operationId, 'operationId', 200));
    if (row.status === 'completed' || row.status === 'cancelled') return row;
    const timestamp = new Date().toISOString();
    api.run(`UPDATE coin_admin_add_confirmations
      SET status = ?, result_json = ?, updated_at = ? WHERE operation_id = ? AND status = ?`,
    [retryable ? row.status : 'completed', JSON.stringify(result), timestamp, row.operationId, row.status]);
    return getRow(api, row.operationId);
  });
}

module.exports = {
  authorizeRoleAdd,
  cancelAddConfirmation,
  confirmUserAdd,
  createAddConfirmation,
  getAddConfirmation,
  previewPayloadHash,
  recordRoleAddResult,
  roleAddPaymentGate,
};
