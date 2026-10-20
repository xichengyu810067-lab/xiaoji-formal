'use strict';

const CODE_PATTERN = /^[A-Z0-9_]{1,64}$/;
const OVERFLOW_CODE = 'TEST_OBS_OVERFLOW';
const MAX_CODES = 256;

/**
 * Creates a test control observation counter module.
 * Only active when the runtime controller's `active` flag is true.
 * When inactive (production), all operations are no-ops.
 * @param {Object} options
 * @param {Object} options.runtimeController - Runtime controller with `active` property
 * @returns {Object} The observation module with observe() and snapshot() methods
 */
function createTestControlObservation({
  runtimeController = null,
} = {}) {
  const isActive = runtimeController?.active === true;

  // State only created if active
  let counters = isActive ? new Map() : null;
  let codeCount = 0;

  function observe(code) {
    if (!isActive) return; // No-op when inactive
    if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
      return; // Silently ignore invalid codes, don't log or error
    }

    // Check if we need to apply overflow behavior
    if (!counters.has(code) && codeCount >= MAX_CODES) {
      // Overflow: accumulate to fixed overflow code instead
      counters.set(OVERFLOW_CODE, (counters.get(OVERFLOW_CODE) ?? 0) + 1);
      return;
    }

    // Normal accumulation
    if (!counters.has(code)) {
      codeCount++;
    }
    counters.set(code, (counters.get(code) ?? 0) + 1);
  }

  function snapshot() {
    if (!isActive) {
      return Object.freeze({}); // Empty frozen object when inactive
    }

    // Return a frozen copy
    const copy = Object.freeze(Object.fromEntries(counters));
    return copy;
  }

  // Test-only reset function
  function _testReset() {
    if (!process.env.NODE_TEST_CONTEXT) {
      throw new Error('_testReset() is only available in test context (NODE_TEST_CONTEXT)');
    }
    if (!isActive) return;
    counters.clear();
    codeCount = 0;
  }

  return Object.freeze({
    observe,
    snapshot,
    _testReset,
  });
}

/**
 * Module-level instance state that persists across calls.
 * Created lazily and only when runtime controller is active.
 * Reads the runtime controller from the global symbol on each call.
 */
let defaultInstance = null;
let defaultInstanceCounters = null;
let defaultInstanceCodeCount = 0;

/**
 * Get the current runtime controller from the global symbol without requiring bootstrap.
 * @returns {Object|null} Runtime controller or null
 */
function getGlobalRuntimeController() {
  return globalThis[Symbol.for('xiaoji.testControlRuntimeController')] ?? null;
}

/**
 * Observe a code at module level, reading runtime controller from global symbol.
 * No-op if not in test-control mode or if runtime controller is inactive.
 * @param {string} code - The observation code
 */
function observe(code) {
  const controller = getGlobalRuntimeController();
  if (controller?.active !== true) return; // No-op when inactive

  if (typeof code !== 'string' || !CODE_PATTERN.test(code)) {
    return; // Silently ignore invalid codes
  }

  // Lazy initialize state if needed
  if (!defaultInstanceCounters) {
    defaultInstanceCounters = new Map();
    defaultInstanceCodeCount = 0;
  }

  // Check if we need to apply overflow behavior
  if (!defaultInstanceCounters.has(code) && defaultInstanceCodeCount >= MAX_CODES) {
    // Overflow: accumulate to fixed overflow code instead
    defaultInstanceCounters.set(OVERFLOW_CODE, (defaultInstanceCounters.get(OVERFLOW_CODE) ?? 0) + 1);
    return;
  }

  // Normal accumulation
  if (!defaultInstanceCounters.has(code)) {
    defaultInstanceCodeCount++;
  }
  defaultInstanceCounters.set(code, (defaultInstanceCounters.get(code) ?? 0) + 1);
}

/**
 * Get a snapshot at module level.
 * Returns empty object if not in test-control mode.
 * @returns {Object} Frozen snapshot of observation counts
 */
function snapshot() {
  const controller = getGlobalRuntimeController();
  if (controller?.active !== true) {
    return Object.freeze({}); // Empty frozen object when inactive
  }

  if (!defaultInstanceCounters) {
    return Object.freeze({});
  }

  // Return a frozen copy
  return Object.freeze(Object.fromEntries(defaultInstanceCounters));
}

/**
 * Test-only reset function for module-level instance.
 * Only available when NODE_TEST_CONTEXT is set.
 */
function _testReset() {
  if (!process.env.NODE_TEST_CONTEXT) {
    throw new Error('_testReset() is only available in test context (NODE_TEST_CONTEXT)');
  }
  if (defaultInstanceCounters) {
    defaultInstanceCounters.clear();
    defaultInstanceCodeCount = 0;
  }
}

module.exports = {
  // Factory function for dependency injection in tests
  createTestControlObservation,
  // Module-level functions that read from global symbol
  observe,
  snapshot,
  _testReset,
  // Constants and internals for testing
  CODE_PATTERN,
  OVERFLOW_CODE,
  MAX_CODES,
  getGlobalRuntimeController,
};
