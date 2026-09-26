'use strict';

const crypto = require('node:crypto');
const { createIdentityContext } = require('../platform/identityContext');

class RewardCoordinatorError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'RewardCoordinatorError';
    this.code = code;
  }
}

function requirePart(value, field, maxLength) {
  if (typeof value !== 'string' || !value || value.length > maxLength || value.trim() !== value) {
    throw new RewardCoordinatorError('REWARD_IDENTITY_INVALID', `${field} must be a stable non-empty string.`);
  }
  return value;
}

function makeRewardKey({ kind, canonicalSourceId, rewardKind, userId } = {}) {
  requirePart(kind, 'kind', 64);
  if (!/^[a-z][a-z0-9-]*$/.test(kind)) {
    throw new RewardCoordinatorError('REWARD_IDENTITY_INVALID', 'kind must use a stable lowercase name.');
  }
  requirePart(canonicalSourceId, 'canonicalSourceId', 200);
  requirePart(rewardKind, 'rewardKind', 80);
  if (typeof userId !== 'string' || !/^\d{1,20}$/.test(userId)) {
    throw new RewardCoordinatorError('REWARD_IDENTITY_INVALID', 'userId must be a Discord ID string.');
  }
  const tuple = JSON.stringify([kind, canonicalSourceId, rewardKind, userId]);
  return `reward:v1:${crypto.createHash('sha256').update(tuple, 'utf8').digest('hex')}`;
}

function validateReceipt(receipt, expected) {
  if (!receipt || typeof receipt !== 'object' ||
      !Number.isSafeInteger(receipt.id) || receipt.id <= 0 ||
      !Number.isSafeInteger(receipt.transactionId) || receipt.transactionId <= 0) {
    throw new RewardCoordinatorError('REWARD_RECEIPT_INVALID', 'The economic service returned no complete reward receipt.');
  }
  for (const field of ['rewardKey', 'operationId', 'kind', 'canonicalSourceId', 'rewardKind', 'userId', 'amount']) {
    if (receipt[field] !== expected[field]) {
      throw new RewardCoordinatorError('REWARD_KEY_CONFLICT', `The existing reward receipt conflicts on ${field}.`);
    }
  }
  return receipt;
}

function prepareGrant({ kind, canonicalSourceId, rewardKind, userId, sourceGuildId = null,
  amount, operationId = null, actorUserId = null, metadata } = {}) {
  const rewardKey = makeRewardKey({ kind, canonicalSourceId, rewardKind, userId });
  const identity = createIdentityContext({
    userId, sourceGuildId, actorUserId, operationId: operationId == null ? rewardKey : operationId,
  });
  if (identity.operationId.length > 200) {
    throw new RewardCoordinatorError('REWARD_IDENTITY_INVALID', 'operationId exceeds the economic port limit.');
  }
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RewardCoordinatorError('REWARD_AMOUNT_INVALID', 'amount must be a positive safe integer.');
  }
  const input = {
    kind, canonicalSourceId, rewardKind, userId: identity.userId,
    sourceGuildId: identity.sourceGuildId, amount, operationId: identity.operationId,
  };
  if (identity.actorUserId !== null) input.actorUserId = identity.actorUserId;
  if (metadata !== undefined) input.metadata = metadata;
  return { input, expected: { ...input, rewardKey }, rewardKey, operationId: identity.operationId };
}

function grantResult(result, receipt, rewardKey) {
  return {
    alreadyGranted: Boolean(result?.alreadyGranted), receipt, rewardKey,
    balance: result?.balance ?? null,
    totalEarned: result?.totalEarned ?? null,
    debtOffset: result?.debtOffset ?? null,
  };
}

function createRewardCoordinator({ grantRewardOnceV2, getRewardReceiptV2, grantRewardOnceV2WithApi = null } = {}) {
  if (typeof grantRewardOnceV2 !== 'function' || typeof getRewardReceiptV2 !== 'function') {
    throw new RewardCoordinatorError('PORT_INVALID', 'Both economic reward and receipt ports are required.');
  }
  if (grantRewardOnceV2WithApi !== null && typeof grantRewardOnceV2WithApi !== 'function') {
    throw new RewardCoordinatorError('PORT_INVALID', 'The in-transaction reward port must be synchronous.');
  }

  async function grant(request = {}) {
    const { input, expected, rewardKey, operationId } = prepareGrant(request);
    const query = () => getRewardReceiptV2({ rewardKey, operationId });

    let existing;
    try {
      existing = await query();
    } catch (error) {
      throw new RewardCoordinatorError('REWARD_OUTCOME_UNKNOWN', 'The authoritative reward receipt could not be read.', { cause: error });
    }
    if (existing) return grantResult({ alreadyGranted: true }, validateReceipt(existing, expected), rewardKey);

    let result;
    try {
      result = await grantRewardOnceV2(input);
    } catch (error) {
      if (error?.code === 'REWARD_KEY_CONFLICT' || error?.code === 'OPERATION_CONFLICT') throw error;
      try {
        existing = await query();
      } catch (lookupError) {
        throw new RewardCoordinatorError('REWARD_OUTCOME_UNKNOWN', 'Reward outcome is unknown until its receipt can be read.', { cause: lookupError });
      }
      if (existing) return grantResult({ alreadyGranted: true }, validateReceipt(existing, expected), rewardKey);
      throw error;
    }

    let receipt = result?.receipt;
    if (!receipt) {
      try {
        receipt = await query();
      } catch (error) {
        throw new RewardCoordinatorError('REWARD_OUTCOME_UNKNOWN', 'Reward response had no receipt and readback failed.', { cause: error });
      }
    }
    return grantResult(result, validateReceipt(receipt, expected), rewardKey);
  }

  // Called only inside the caller's existing withCoinTransaction callback.
  // The receipt is provisional until that outer transaction commits and persists.
  function grantInTransaction(api, request = {}) {
    if (typeof grantRewardOnceV2WithApi !== 'function') {
      throw new RewardCoordinatorError('PORT_INVALID', 'The in-transaction economic reward port is required.');
    }
    const { input, expected, rewardKey } = prepareGrant(request);
    const result = grantRewardOnceV2WithApi(api, input);
    if (result && typeof result.then === 'function') {
      throw new RewardCoordinatorError('PORT_ASYNC_IN_TRANSACTION', 'The in-transaction reward port must return synchronously.');
    }
    return grantResult(result, validateReceipt(result?.receipt, expected), rewardKey);
  }

  return Object.freeze({ grant, grantInTransaction });
}

module.exports = { RewardCoordinatorError, createRewardCoordinator, makeRewardKey };
