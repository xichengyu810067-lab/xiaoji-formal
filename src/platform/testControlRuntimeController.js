'use strict';

const crypto = require('node:crypto');
const {
  createControlMessage,
  isControlMessage,
  isSessionId,
  safeControlLine,
} = require('./testControlProtocol');

const DEFAULT_LEASE_MS = 5_000;
const DEFAULT_BIND_MS = 5_000;
const DEFAULT_SESSION_MS = 10 * 60 * 1000;
const DEFAULT_STARTUP_FRESHNESS_MS = 1_000;

class RuntimeControlError extends Error {
  constructor(code = 'TEST_STARTUP_CANCELLED') {
    super('Test-control runtime is stopping.');
    this.name = 'RuntimeControlError';
    this.code = code;
  }
}

function createNoopController() {
  return Object.freeze({
    active: false,
    assertRunning() { return true; },
    async awaitBound() { return true; },
    async awaitStartupFreshness() { return true; },
    bindShutdown() {},
    checkLease() {},
    dispose() {},
    isStopping() { return false; },
    markReady() { return false; },
    requestStop() { return false; },
  });
}

function createTestControlRuntimeController({
  env = process.env,
  processRef = process,
  now = () => Date.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  leaseMs = DEFAULT_LEASE_MS,
  bindMs = DEFAULT_BIND_MS,
  sessionMs = DEFAULT_SESSION_MS,
  startupFreshnessMs = DEFAULT_STARTUP_FRESHNESS_MS,
  randomBytes = crypto.randomBytes,
} = {}) {
  if (env.XIAOJI_RUNTIME_MODE !== 'test-control') return createNoopController();

  const session = String(env.XIAOJI_TEST_CONTROL_SESSION || '');
  if (!isSessionId(session) || !processRef.connected || typeof processRef.send !== 'function') {
    const line = safeControlLine('TEST_CONTROL_CHANNEL_REQUIRED', 'runtime');
    processRef.stderr?.write?.(`${line}\n`);
    return Object.freeze({
      active: true,
      invalid: true,
      assertRunning() { throw new RuntimeControlError('TEST_CONTROL_CHANNEL_REQUIRED'); },
      async awaitBound() { throw new RuntimeControlError('TEST_CONTROL_CHANNEL_REQUIRED'); },
      async awaitStartupFreshness() { throw new RuntimeControlError('TEST_CONTROL_CHANNEL_REQUIRED'); },
      bindShutdown(handler) { if (typeof handler === 'function') void handler('START_FAILED'); },
      checkLease() {}, dispose() {}, isStopping() { return true; },
      markReady() { throw new RuntimeControlError('TEST_CONTROL_CHANNEL_REQUIRED'); },
      requestStop() { return false; },
    });
  }

  const startedAt = now();
  let state = 'binding';
  let boundAt = 0;
  let lastLeaseAt = startedAt;
  let lastSequence = -1;
  let shutdownHandler = null;
  let shutdownStarted = false;
  let ackTimer = null;
  let stopReason = null;
  let startupFreshnessPromise = null;
  let resolveStartupFreshness = null;
  let rejectStartupFreshness = null;
  let startupFreshnessTimer = null;
  let startupFreshnessDeadline = 0;
  let startupFreshnessNonce = null;
  let startupFreshnessComplete = false;
  let resolveBound;
  let rejectBound;
  const boundPromise = new Promise((resolve, reject) => {
    resolveBound = resolve;
    rejectBound = reject;
  });
  boundPromise.catch(() => {});

  function send(type, details = {}, callback = null) {
    if (!processRef.connected) return false;
    const message = createControlMessage(type, session, details);
    if (!message) return false;
    try { processRef.send(message, () => callback?.()); return true; } catch { return false; }
  }

  async function beginShutdown() {
    if (shutdownStarted || typeof shutdownHandler !== 'function') return;
    shutdownStarted = true;
    clearTimeoutFn(ackTimer);
    try { await shutdownHandler(stopReason); } catch {
      processRef.stderr?.write?.(`${safeControlLine('TEST_RUNTIME_START_FAILED', 'runtime')}\n`);
      processRef.exitCode = 1;
    }
  }

  function rejectPendingStartupFreshness(error = new RuntimeControlError()) {
    clearTimeoutFn(startupFreshnessTimer);
    startupFreshnessTimer = null;
    startupFreshnessNonce = null;
    if (typeof rejectStartupFreshness === 'function') rejectStartupFreshness(error);
    resolveStartupFreshness = null;
    rejectStartupFreshness = null;
  }

  function requestStop(reason = 'START_FAILED') {
    const safeReason = [
      'LAUNCHER_DISCONNECTED', 'LAUNCHER_LEASE_EXPIRED', 'STARTUP_TIMEOUT',
      'STARTUP_FRESHNESS_TIMEOUT',
      'SESSION_EXPIRED', 'OWNER_REQUEST', 'OWNER_DISCONNECTED', 'OWNER_LEASE_EXPIRED',
      'START_FAILED', 'RUNTIME_EXITED',
    ].includes(reason) ? reason : 'START_FAILED';
    if (state === 'stopping') {
      send('RUNTIME_STOP_ACK', { reason: stopReason });
      return false;
    }
    state = 'stopping';
    stopReason = safeReason;
    rejectBound(new RuntimeControlError());
    rejectPendingStartupFreshness(new RuntimeControlError());
    let acknowledged = false;
    const queued = send('RUNTIME_STOP_ACK', { reason: safeReason }, () => {
      acknowledged = true;
      void beginShutdown();
    });
    if (queued && !acknowledged) ackTimer = setTimeoutFn(() => void beginShutdown(), 250);
    else void beginShutdown();
    return true;
  }

  function onMessage(message) {
    if (!isControlMessage(message, { session })) return;
    if (message.type === 'LAUNCHER_BIND' && state === 'binding') {
      state = 'starting';
      boundAt = now();
      lastLeaseAt = boundAt;
      send('RUNTIME_BOUND');
      resolveBound(true);
      return;
    }
    if (message.type === 'LAUNCHER_STARTUP_CONFIRM' && state === 'starting' &&
        !startupFreshnessComplete && message.nonce === startupFreshnessNonce) {
      if (now() >= startupFreshnessDeadline) {
        requestStop('STARTUP_FRESHNESS_TIMEOUT');
        return;
      }
      clearTimeoutFn(startupFreshnessTimer);
      startupFreshnessTimer = null;
      startupFreshnessNonce = null;
      startupFreshnessComplete = true;
      lastLeaseAt = now();
      const resolve = resolveStartupFreshness;
      resolveStartupFreshness = null;
      rejectStartupFreshness = null;
      resolve?.(true);
      return;
    }
    if (message.type === 'LAUNCHER_LEASE' && state !== 'binding' && state !== 'stopping') {
      if (message.sequence > lastSequence) {
        lastSequence = message.sequence;
        if (startupFreshnessComplete) lastLeaseAt = now();
      }
      return;
    }
    if (message.type === 'LAUNCHER_STOP') requestStop(message.reason);
  }

  function onDisconnect() {
    requestStop('LAUNCHER_DISCONNECTED');
  }

  function checkLease() {
    if (state === 'stopping') return;
    const current = now();
    if (state === 'binding' && current - startedAt >= bindMs) return requestStop('LAUNCHER_LEASE_EXPIRED');
    if (current - startedAt >= sessionMs) return requestStop('SESSION_EXPIRED');
    if (state === 'starting' && !startupFreshnessComplete) return;
    if (state !== 'binding' && current - lastLeaseAt >= leaseMs) requestStop('LAUNCHER_LEASE_EXPIRED');
  }

  function awaitStartupFreshness() {
    assertRunning();
    if (state !== 'starting') return Promise.reject(new RuntimeControlError('TEST_PROTOCOL_INVALID'));
    if (startupFreshnessPromise) return startupFreshnessPromise;
    startupFreshnessNonce = randomBytes(16).toString('hex');
    startupFreshnessDeadline = now() + startupFreshnessMs;
    startupFreshnessPromise = new Promise((resolve, reject) => {
      resolveStartupFreshness = resolve;
      rejectStartupFreshness = reject;
    });
    startupFreshnessPromise.catch(() => {});
    startupFreshnessTimer = setTimeoutFn(() => {
      if (!startupFreshnessComplete && startupFreshnessNonce) {
        requestStop('STARTUP_FRESHNESS_TIMEOUT');
      }
    }, startupFreshnessMs);
    const pending = startupFreshnessPromise;
    if (!send('RUNTIME_STARTUP_PROBE', { nonce: startupFreshnessNonce })) {
      requestStop('LAUNCHER_DISCONNECTED');
    }
    return pending;
  }

  function assertRunning() {
    if (state === 'stopping') throw new RuntimeControlError();
    return true;
  }

  function bindShutdown(handler) {
    if (typeof handler !== 'function') throw new TypeError('shutdown handler must be a function');
    shutdownHandler = handler;
    if (state === 'stopping') void beginShutdown();
  }

  function markReady() {
    assertRunning();
    if (state !== 'starting' || !startupFreshnessComplete) {
      throw new RuntimeControlError('TEST_PROTOCOL_INVALID');
    }
    state = 'ready';
    send('RUNTIME_READY');
    return true;
  }

  function dispose() {
    clearTimeoutFn(ackTimer);
    rejectPendingStartupFreshness(new RuntimeControlError());
    clearIntervalFn(interval);
    processRef.off?.('message', onMessage);
    processRef.off?.('disconnect', onDisconnect);
  }

  processRef.on('message', onMessage);
  processRef.on('disconnect', onDisconnect);
  const interval = setIntervalFn(checkLease, Math.min(1_000, leaseMs));
  send('RUNTIME_HELLO');

  return Object.freeze({
    active: true,
    assertRunning,
    awaitBound: () => boundPromise,
    awaitStartupFreshness,
    bindShutdown,
    checkLease,
    dispose,
    isStopping: () => state === 'stopping',
    markReady,
    requestStop,
    state: () => state,
  });
}

module.exports = {
  DEFAULT_BIND_MS,
  DEFAULT_LEASE_MS,
  DEFAULT_SESSION_MS,
  DEFAULT_STARTUP_FRESHNESS_MS,
  RuntimeControlError,
  createNoopController,
  createTestControlRuntimeController,
};
