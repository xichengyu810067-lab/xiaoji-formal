const { BoardCoreError, cloneJson, requireIdentifier } = require('./contracts');

const trustedActions = new WeakSet();
const RESERVED_SYSTEM_ACTION_TYPES = Object.freeze([
  'player-retired',
  'judge-result',
  'host-stop',
]);

function isReservedSystemActionType(type) {
  const value = String(type || '');
  return RESERVED_SYSTEM_ACTION_TYPES.includes(value) || value.startsWith('system:') || value.startsWith('internal:');
}

function assertUserAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    throw new BoardCoreError('INVALID_ACTION', 'action must be an object.');
  }
  if (isReservedSystemActionType(action.type)) {
    throw new BoardCoreError('RESERVED_ACTION', 'This action type is reserved for the server.');
  }
  return action;
}

function createTrustedSystemAction(type, payload = {}) {
  const normalizedType = requireIdentifier(type, 'system action type', 80);
  if (!isReservedSystemActionType(normalizedType)) {
    throw new BoardCoreError('INVALID_ACTION', 'Trusted actions must use a reserved system type.');
  }
  const action = Object.freeze({ type: normalizedType, ...cloneJson(payload, 'system action payload') });
  trustedActions.add(action);
  return action;
}

function isTrustedSystemAction(action, expectedType = null) {
  return Boolean(action && typeof action === 'object' && trustedActions.has(action) &&
    (expectedType == null || action.type === expectedType));
}

module.exports = {
  RESERVED_SYSTEM_ACTION_TYPES,
  assertUserAction,
  createTrustedSystemAction,
  isReservedSystemActionType,
  isTrustedSystemAction,
};
