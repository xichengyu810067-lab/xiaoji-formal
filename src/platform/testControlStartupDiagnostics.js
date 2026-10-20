'use strict';

const { TestControlError } = require('./testControlPolicy');
const { RuntimeControlError } = require('./testControlRuntimeController');
const { safeControlLine, STARTUP_TEST_CONTROL_CODES } = require('./testControlProtocol');

const GLOBAL_KEY = Symbol.for('xiaoji.testControlStartupDiagnostics');
const OPERATION = 'startup_diagnostic';
const PHASES = Object.freeze([
  'DEPENDENCY_LOAD',
  'CONFIG_VALIDATE',
  'CLIENT_SETUP',
  'IDENTITY_PREFLIGHT',
  'RUNTIME_PREFLIGHT',
  'LOGIN_REST',
  'LOGIN_GATEWAY',
  'READY_WAIT',
  'READY_ENTRY',
]);
const PHASE_INDEX = new Map(PHASES.map((phase, index) => [phase, index]));
const GATEWAY_FAILURES = new Map([
  [4004, 'TEST_STARTUP_GATEWAY_AUTHENTICATION_FAILED'],
  [4010, 'TEST_STARTUP_GATEWAY_INVALID_SHARD'],
  [4011, 'TEST_STARTUP_GATEWAY_SHARDING_REQUIRED'],
  [4012, 'TEST_STARTUP_GATEWAY_INVALID_API_VERSION'],
  [4013, 'TEST_STARTUP_GATEWAY_INVALID_INTENTS'],
  [4014, 'TEST_STARTUP_GATEWAY_DISALLOWED_INTENTS'],
]);
function safeGet(value, key) {
  try { return value?.[key]; } catch { return undefined; }
}

function safeInstanceOf(value, constructor) {
  if (typeof constructor !== 'function') return false;
  try { return value instanceof constructor; } catch { return false; }
}

function createTestControlStartupDiagnostics({
  active = false,
  stderr = process.stderr,
  isStopping = () => false,
} = {}) {
  let enabled = active === true;
  let stoppingCheck = typeof isStopping === 'function' ? isStopping : () => false;
  let highestPhase = -1;
  let currentPhase = null;
  let firstFailure = null;
  let complete = false;
  const emitted = new Set();
  const trusted = {
    DiscordjsError: null,
    DiscordAPIError: null,
    HTTPError: null,
    tokenInvalidCode: null,
  };

  function emit(code) {
    if (!enabled || emitted.has(code)) return false;
    const line = safeControlLine(code, OPERATION);
    if (!line) return false;
    emitted.add(code);
    try { stderr?.write?.(`${line}\n`); } catch {}
    return true;
  }

  function configureRuntime({ active: nextActive, isStopping: nextStopping } = {}) {
    if (nextActive === true) enabled = true;
    if (typeof nextStopping === 'function') stoppingCheck = nextStopping;
  }

  function configureTrustedTypes({ DiscordjsError, DiscordAPIError, HTTPError, tokenInvalidCode } = {}) {
    if (typeof DiscordjsError === 'function') trusted.DiscordjsError = DiscordjsError;
    if (typeof DiscordAPIError === 'function') trusted.DiscordAPIError = DiscordAPIError;
    if (typeof HTTPError === 'function') trusted.HTTPError = HTTPError;
    if (tokenInvalidCode === 'TokenInvalid') trusted.tokenInvalidCode = tokenInvalidCode;
  }

  function isStoppingNow() {
    try { return stoppingCheck() === true; } catch { return true; }
  }

  function enterPhase(phase) {
    if (!enabled || complete || firstFailure || isStoppingNow()) return false;
    const index = PHASE_INDEX.get(phase);
    if (!Number.isInteger(index) || index <= highestPhase) return false;
    highestPhase = index;
    currentPhase = phase;
    return emit(`TEST_STARTUP_PHASE_${phase}`);
  }

  function classifyRest(error) {
    const isRestError = safeInstanceOf(error, trusted.DiscordAPIError) ||
      safeInstanceOf(error, trusted.HTTPError);
    if (!isRestError) return null;
    const status = safeGet(error, 'status');
    if (status === 401) return 'TEST_STARTUP_REST_UNAUTHORIZED';
    if (status === 403) return 'TEST_STARTUP_REST_FORBIDDEN';
    if (status === 404) return 'TEST_STARTUP_REST_NOT_FOUND';
    if (status === 429) return 'TEST_STARTUP_REST_RATE_LIMITED';
    if (Number.isInteger(status) && status >= 500 && status <= 599) {
      return 'TEST_STARTUP_REST_SERVER_FAILED';
    }
    return 'TEST_STARTUP_UNKNOWN';
  }

  function isTrustedGatewayUnauthorized(error) {
    const isRestError = safeInstanceOf(error, trusted.DiscordAPIError) ||
      safeInstanceOf(error, trusted.HTTPError);
    return isRestError && safeGet(error, 'status') === 401;
  }

  function classify(error) {
    if (safeInstanceOf(error, RuntimeControlError)) return 'TEST_STARTUP_CANCELLED';
    if (safeInstanceOf(error, TestControlError)) {
      const code = safeGet(error, 'code');
      return STARTUP_TEST_CONTROL_CODES.has(code) ? code : 'TEST_STARTUP_UNKNOWN';
    }
    if (safeInstanceOf(error, trusted.DiscordjsError) &&
        safeGet(error, 'code') === trusted.tokenInvalidCode) {
      return 'TEST_STARTUP_LOGIN_TOKEN_INVALID';
    }
    const restCode = classifyRest(error);
    if (restCode) return restCode;
    if (currentPhase === 'DEPENDENCY_LOAD' && safeInstanceOf(error, Error) &&
        safeGet(error, 'code') === 'MODULE_NOT_FOUND') {
      return 'TEST_STARTUP_DEPENDENCY_MISSING';
    }
    return 'TEST_STARTUP_UNKNOWN';
  }

  function recordFailureCode(code) {
    if (!enabled || complete || firstFailure) return firstFailure;
    firstFailure = isStoppingNow() ? 'TEST_STARTUP_CANCELLED' : code;
    emit(firstFailure);
    return firstFailure;
  }

  function reportFailure(error) {
    if (!enabled || complete || firstFailure) return firstFailure;
    return recordFailureCode(isStoppingNow() ? 'TEST_STARTUP_CANCELLED' : classify(error));
  }

  function recordGatewayClose(value) {
    if (!enabled || complete || firstFailure) return firstFailure;
    const code = Number.isInteger(value) ? value : safeGet(value, 'code');
    const fixed = GATEWAY_FAILURES.get(code) || 'TEST_STARTUP_UNKNOWN';
    return recordFailureCode(fixed);
  }

  function markComplete() {
    complete = true;
    return true;
  }

  return Object.freeze({
    configureRuntime,
    configureTrustedTypes,
    currentPhase: () => currentPhase,
    enterPhase,
    firstFailure: () => firstFailure,
    isActive: () => enabled && !complete,
    isTrustedGatewayUnauthorized,
    markComplete,
    recordGatewayClose,
    reportFailure,
  });
}

function getTestControlStartupDiagnostics(options = {}) {
  if (!globalThis[GLOBAL_KEY]) {
    globalThis[GLOBAL_KEY] = createTestControlStartupDiagnostics(options);
  } else {
    globalThis[GLOBAL_KEY].configureRuntime(options);
  }
  return globalThis[GLOBAL_KEY];
}

module.exports = {
  GATEWAY_FAILURES,
  PHASES,
  STARTUP_TEST_CONTROL_CODES,
  createTestControlStartupDiagnostics,
  getTestControlStartupDiagnostics,
};
