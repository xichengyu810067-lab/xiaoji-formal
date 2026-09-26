'use strict';

const { createIdentityContext } = require('../platform/identityContext');

class OperationCoordinatorError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'OperationCoordinatorError';
    this.code = code;
  }
}

function requirePort(port, method, name) {
  if (typeof port?.[method] !== 'function') {
    throw new OperationCoordinatorError('PORT_INVALID', `${name}.${method} is required.`);
  }
}

function errorCode(error, fallback) {
  return typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(error.code) ? error.code : fallback;
}

function normalizeReceipt(receipt, operationId) {
  if (receipt == null) return null;
  if (typeof receipt !== 'object' || !(
    typeof receipt.id === 'string' && receipt.id.length > 0 ||
    Number.isSafeInteger(receipt.id) && receipt.id >= 0
  ) ||
      (receipt.operationId != null && receipt.operationId !== operationId)) {
    throw new OperationCoordinatorError('RECEIPT_INVALID', 'The authoritative receipt is invalid.');
  }
  const id = String(receipt.id);
  if (!id || id.length > 256) throw new OperationCoordinatorError('RECEIPT_INVALID', 'The authoritative receipt ID is invalid.');
  return { ...receipt, id };
}

function normalizeInspection(value) {
  const status = typeof value === 'string' ? value : value?.status;
  return ['applied', 'not_applied', 'unknown'].includes(status) ? status : 'unknown';
}

// Ports contract:
// intentPort.claim atomically inserts or leases a matching intent, returning
// { acquired, intent, leaseToken }. renew and record must fence stale tokens;
// terminal intents cannot be leased again. A crashed lease may be recovered.
// record persists a state; a pending externalAttempted marker stays durable.
// localPort.applyOnce must commit its effect and receipt atomically in one store.
// externalPort.dispatch receives operationId as its stable idempotency key.
// An attempted external effect is never automatically dispatched again, even
// if inspection says not_applied. A future provider-enforced retry would need
// a separately reviewed adapter rather than a caller-set flag.
// The injected dispatch port must not hide retries of an unkeyed side effect.
// This does not claim generic exactly-once delivery from an external service.
function createOperationCoordinator({ intentPort, localPort, externalPort = null, now = () => new Date() } = {}) {
  requirePort(intentPort, 'claim', 'intentPort');
  requirePort(intentPort, 'renew', 'intentPort');
  requirePort(intentPort, 'record', 'intentPort');
  requirePort(localPort, 'getReceipt', 'localPort');
  requirePort(localPort, 'applyOnce', 'localPort');
  if (externalPort) {
    requirePort(externalPort, 'inspect', 'externalPort');
    requirePort(externalPort, 'dispatch', 'externalPort');
  }

  async function execute({ identity, kind, payloadHash } = {}) {
    const context = createIdentityContext(identity);
    if (typeof kind !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(kind)) {
      throw new OperationCoordinatorError('KIND_INVALID', 'kind must be a stable lowercase operation kind.');
    }
    if (typeof payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(payloadHash)) {
      throw new OperationCoordinatorError('PAYLOAD_HASH_INVALID', 'payloadHash must be a SHA-256 hex digest.');
    }
    const candidate = Object.freeze({
      operationId: context.operationId,
      kind,
      userId: context.userId,
      sourceGuildId: context.sourceGuildId,
      channelId: context.channelId,
      actorUserId: context.actorUserId,
      payloadHash,
      state: 'pending',
      attemptCount: 0,
      createdAt: now().toISOString(),
    });
    const claim = await intentPort.claim(candidate);
    const intent = claim?.intent;
    if (!intent || intent.operationId !== candidate.operationId || intent.kind !== kind ||
        intent.userId !== context.userId || intent.payloadHash !== payloadHash) {
      throw new OperationCoordinatorError('OPERATION_CONFLICT', 'An operation ID already belongs to different data.');
    }
    if (intent.state === 'applied') {
      if (intent.receiptId == null) throw new OperationCoordinatorError('RECEIPT_MISSING', 'An applied operation has no receipt.');
      let committed;
      try {
        committed = normalizeReceipt(await localPort.getReceipt(intent), context.operationId);
      } catch (error) {
        throw new OperationCoordinatorError('RECEIPT_LOOKUP_FAILED', 'An applied operation receipt cannot be verified.', { cause: error });
      }
      if (!committed || committed.id !== String(intent.receiptId)) {
        throw new OperationCoordinatorError('RECEIPT_MISSING', 'An applied operation receipt cannot be verified.');
      }
      return { operationId: context.operationId, state: 'applied', receiptId: String(intent.receiptId), retryable: false, alreadyApplied: true };
    }
    if (intent.state === 'manual_review') {
      return { operationId: context.operationId, state: 'manual_review', receiptId: intent.receiptId || null, retryable: false, reasonCode: intent.reasonCode || 'OUTCOME_UNKNOWN' };
    }
    if (intent.state === 'failed' && intent.retryable === false) {
      return { operationId: context.operationId, state: 'failed', receiptId: intent.receiptId || null, retryable: false, reasonCode: intent.reasonCode || 'LOCAL_APPLY_FAILED' };
    }
    if (!claim.acquired) {
      return { operationId: context.operationId, state: intent.state || 'pending', receiptId: intent.receiptId || null, retryable: true, reasonCode: 'OPERATION_BUSY' };
    }
    const leaseToken = claim.leaseToken;
    if (typeof leaseToken !== 'string' || !leaseToken) {
      throw new OperationCoordinatorError('PORT_INVALID', 'claim must return a non-empty leaseToken.');
    }

    const renewLease = async () => {
      const retained = await intentPort.renew(context.operationId, leaseToken);
      if (retained !== true) {
        throw new OperationCoordinatorError('LEASE_LOST', 'This executor no longer owns the operation.');
      }
    };
    const persist = async (patch) => {
      await renewLease();
      await intentPort.record(context.operationId, leaseToken, patch);
    };
    const finish = async (state, receiptId, retryable, reasonCode = null) => {
      await persist({
        state,
        receiptId: receiptId || null,
        retryable,
        reasonCode,
        updatedAt: now().toISOString(),
      });
      return { operationId: context.operationId, state, receiptId: receiptId || null, retryable, ...(reasonCode ? { reasonCode } : {}) };
    };

    let receipt;
    try {
      await renewLease();
      receipt = normalizeReceipt(await localPort.getReceipt(intent), context.operationId);
    } catch (error) {
      if (error?.code === 'LEASE_LOST') throw error;
      return finish('manual_review', null, false, errorCode(error, 'RECEIPT_LOOKUP_FAILED'));
    }
    if (!receipt) {
      try {
        await renewLease();
        receipt = normalizeReceipt(await localPort.applyOnce(intent), context.operationId);
        if (!receipt) throw new OperationCoordinatorError('RECEIPT_MISSING', 'A local effect returned no receipt.');
      } catch (error) {
        if (error?.code === 'LEASE_LOST') throw error;
        try {
          await renewLease();
          receipt = normalizeReceipt(await localPort.getReceipt(intent), context.operationId);
        } catch (lookupError) {
          if (lookupError?.code === 'LEASE_LOST') throw lookupError;
          return finish('manual_review', null, false, errorCode(lookupError, 'RECEIPT_LOOKUP_FAILED'));
        }
        if (!receipt) return finish('failed', null, error?.retryable !== false && error?.code !== 'RECEIPT_MISSING', errorCode(error, 'LOCAL_APPLY_FAILED'));
      }
    }

    if (!externalPort) return finish('applied', receipt.id, false);

    if (intent.externalAttempted) {
      return finish('manual_review', receipt.id, false, 'EXTERNAL_ATTEMPT_UNCONFIRMED');
    }

    let inspection;
    try {
      await renewLease();
      inspection = normalizeInspection(await externalPort.inspect(intent, receipt, { idempotencyKey: context.operationId }));
    } catch (_error) {
      if (_error?.code === 'LEASE_LOST') throw _error;
      return finish('manual_review', receipt.id, false, 'EXTERNAL_OUTCOME_UNKNOWN');
    }
    if (inspection === 'applied') return finish('applied', receipt.id, false);
    if (inspection === 'unknown') return finish('manual_review', receipt.id, false, 'EXTERNAL_OUTCOME_UNKNOWN');

    if (!intent.externalAttempted) {
      await persist({
        state: 'pending',
        receiptId: receipt.id,
        externalAttempted: true,
        updatedAt: now().toISOString(),
      });
    }

    let dispatched = 'unknown';
    try {
      await renewLease();
      dispatched = normalizeInspection(await externalPort.dispatch(intent, receipt, { idempotencyKey: context.operationId }));
    } catch (error) {
      if (error?.code === 'LEASE_LOST') throw error;
      // A thrown response can still follow a successful external effect.
    }
    if (dispatched === 'applied') return finish('applied', receipt.id, false);
    if (dispatched === 'not_applied') return finish('manual_review', receipt.id, false, 'EXTERNAL_ATTEMPT_UNCONFIRMED');
    try {
      await renewLease();
      inspection = normalizeInspection(await externalPort.inspect(intent, receipt, { idempotencyKey: context.operationId }));
    } catch (error) {
      if (error?.code === 'LEASE_LOST') throw error;
      inspection = 'unknown';
    }
    if (inspection === 'applied') return finish('applied', receipt.id, false);
    return finish('manual_review', receipt.id, false, 'EXTERNAL_ATTEMPT_UNCONFIRMED');
  }

  return Object.freeze({ execute });
}

module.exports = { OperationCoordinatorError, createOperationCoordinator };
