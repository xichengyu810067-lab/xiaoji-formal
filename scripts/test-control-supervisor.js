'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createBoundedLineDrain,
  createControlMessage,
  createSessionId,
  isControlMessage,
  isSessionId,
  safeControlLine,
} = require('../src/platform/testControlProtocol');

const STARTUP_TIMEOUT_MS = 120_000;
const GRACE_TIMEOUT_MS = 10_000;
const FORCE_CONFIRM_MS = 5_000;
const SESSION_LIMIT_MS = 10 * 60 * 1000;
const LEASE_MS = 5_000;
const LEASE_INTERVAL_MS = 1_000;
const OWNER_BIND_TIMEOUT_MS = 5_000;

function writeCode(target, code, operation = 'launcher') {
  const line = safeControlLine(code, operation);
  if (line) target.write(`${line}\n`);
}

function sendControl(target, type, session, details = {}, callback = null) {
  if (!target?.connected || typeof target.send !== 'function') return false;
  const message = createControlMessage(type, session, details);
  if (!message) return false;
  try { target.send(message, () => callback?.()); return true; } catch { return false; }
}

function waitForOwnerBind({ ownerProcess, session, timeoutMs = OWNER_BIND_TIMEOUT_MS, setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout }) {
  return new Promise((resolve, reject) => {
    const timer = setTimeoutFn(() => finish(false), timeoutMs);
    function finish(ok) {
      clearTimeoutFn(timer);
      ownerProcess.off('message', onMessage);
      ownerProcess.off('disconnect', onDisconnect);
      if (ok) resolve(true);
      else reject(Object.assign(new Error('owner control channel unavailable'), { code: 'TEST_OWNER_CHANNEL_REQUIRED' }));
    }
    function onMessage(message) {
      if (isControlMessage(message, { type: 'OWNER_BIND', session })) finish(true);
    }
    function onDisconnect() { finish(false); }
    ownerProcess.on('message', onMessage);
    ownerProcess.on('disconnect', onDisconnect);
  });
}

async function superviseRuntime({
  child,
  ownerProcess,
  ownerSession,
  runtimeSession,
  stderr = process.stderr,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  graceTimeoutMs = GRACE_TIMEOUT_MS,
  forceConfirmMs = FORCE_CONFIRM_MS,
  sessionLimitMs = SESSION_LIMIT_MS,
  leaseMs = LEASE_MS,
  leaseIntervalMs = LEASE_INTERVAL_MS,
}) {
  return new Promise((resolve) => {
    const startedAt = now();
    let lastOwnerLeaseAt = startedAt;
    let lastOwnerSequence = -1;
    let runtimeSequence = 0;
    let runtimeBound = false;
    let ready = false;
    let stopping = false;
    let stopReason = null;
    let stopAcknowledged = false;
    let forced = false;
    let exited = false;
    let closed = false;
    let exitCode = null;
    let exitSignal = null;
    let settled = false;
    let graceTimer = null;
    let forceTimer = null;
    let startupProbeNonce = null;
    let startupProbeComplete = false;

    const stdoutDrain = createBoundedLineDrain({
      stream: child.stdout,
      streamName: 'stdout',
      acceptLine: (line) => !line.endsWith('operation=owner') && !line.endsWith('operation=launcher'),
      emitLine: (line) => stderr.write(`${line}\n`),
    });
    const stderrDrain = createBoundedLineDrain({
      stream: child.stderr,
      streamName: 'stderr',
      acceptLine: (line) => !line.endsWith('operation=owner') && !line.endsWith('operation=launcher'),
      emitLine: (line) => stderr.write(`${line}\n`),
    });

    function notifyOwner(type, details = {}) {
      return sendControl(ownerProcess, type, ownerSession, details);
    }

    function notifyRuntime(type, details = {}) {
      return sendControl(child, type, runtimeSession, details);
    }

    function cleanup() {
      clearTimeoutFn(startupTimer);
      clearTimeoutFn(sessionTimer);
      clearTimeoutFn(graceTimer);
      clearTimeoutFn(forceTimer);
      clearIntervalFn(leaseTimer);
      ownerProcess.off('message', onOwnerMessage);
      ownerProcess.off('disconnect', onOwnerDisconnect);
      child.off('message', onRuntimeMessage);
      child.off('error', onChildError);
      child.off('exit', onChildExit);
      child.off('close', onChildClose);
      stdoutDrain.close();
      stderrDrain.close();
    }

    function finish(outcome) {
      if (settled) return;
      settled = true;
      cleanup();
      const code = outcome === 'GRACEFUL' ? 'TEST_RUNTIME_EXITED_GRACEFUL'
        : outcome === 'FORCED' ? 'TEST_RUNTIME_EXITED_FORCED'
          : outcome === 'UNVERIFIED' ? 'TEST_RUNTIME_EXIT_UNVERIFIED' : 'TEST_RUNTIME_EXITED_FAILED';
      writeCode(stderr, code);
      const result = Object.freeze({
        outcome,
        stopReason,
        ready,
        stopAcknowledged,
        exited,
        closed,
        exitCode,
        exitSignal: exitSignal ? 'SIGNALLED' : null,
      });
      let delivered = false;
      const complete = () => {
        if (delivered) return;
        delivered = true;
        resolve(result);
      };
      const queued = sendControl(ownerProcess, 'RUNTIME_EXITED', ownerSession,
        { outcome, reason: stopReason || 'RUNTIME_EXITED' }, complete);
      if (!queued) complete();
      else if (!delivered) setTimeoutFn(complete, 250);
    }

    function armGraceTimer() {
      if (graceTimer) return;
      graceTimer = setTimeoutFn(() => {
        if (closed) return;
        forced = true;
        try { child.kill(); } catch {}
        forceTimer = setTimeoutFn(() => {
          if (!closed) finish('UNVERIFIED');
        }, forceConfirmMs);
      }, graceTimeoutMs);
    }

    function requestStop(reason = 'OWNER_REQUEST') {
      if (stopping) {
        notifyRuntime('LAUNCHER_STOP', { reason: stopReason });
        return false;
      }
      stopping = true;
      if (!stopReason) stopReason = reason;
      startupProbeNonce = null;
      writeCode(stderr, 'TEST_STOP_REQUESTED');
      notifyRuntime('LAUNCHER_STOP', { reason: stopReason });
      armGraceTimer();
      return true;
    }

    function onOwnerMessage(message) {
      if (!isControlMessage(message, { session: ownerSession })) return;
      if (message.type === 'OWNER_LEASE' && message.sequence > lastOwnerSequence) {
        lastOwnerSequence = message.sequence;
        lastOwnerLeaseAt = now();
      } else if (message.type === 'OWNER_STARTUP_CONFIRM' && !stopping && !settled &&
          ownerProcess.connected && now() - startedAt < sessionLimitMs &&
          message.nonce === startupProbeNonce) {
        const nonce = startupProbeNonce;
        startupProbeNonce = null;
        startupProbeComplete = true;
        lastOwnerLeaseAt = now();
        if (!notifyRuntime('LAUNCHER_STARTUP_CONFIRM', { nonce })) {
          requestStop('LAUNCHER_DISCONNECTED');
        }
      } else if (message.type === 'OWNER_STOP') {
        requestStop(message.reason || 'OWNER_REQUEST');
      }
    }

    function onOwnerDisconnect() {
      writeCode(stderr, 'TEST_OWNER_DISCONNECTED');
      requestStop('OWNER_DISCONNECTED');
    }

    function onRuntimeMessage(message) {
      if (!isControlMessage(message, { session: runtimeSession })) return;
      if (message.type === 'RUNTIME_HELLO' && !stopping) {
        notifyRuntime('LAUNCHER_BIND');
      } else if (message.type === 'RUNTIME_BOUND' && !stopping) {
        runtimeBound = true;
        writeCode(stderr, 'TEST_RUNTIME_BOUND');
      } else if (message.type === 'RUNTIME_STARTUP_PROBE' && runtimeBound && !stopping &&
          !startupProbeComplete && startupProbeNonce === null && ownerProcess.connected &&
          now() - startedAt < sessionLimitMs) {
        startupProbeNonce = message.nonce;
        if (!notifyOwner('LAUNCHER_STARTUP_PROBE', { nonce: message.nonce })) {
          requestStop('OWNER_DISCONNECTED');
        }
      } else if (message.type === 'RUNTIME_READY' && runtimeBound && !stopping) {
        ready = true;
        clearTimeoutFn(startupTimer);
        writeCode(stderr, 'TEST_RUNTIME_READY');
        notifyOwner('RUNTIME_READY');
      } else if (message.type === 'RUNTIME_STOP_ACK') {
        if (!stopReason) stopReason = message.reason;
        if (!stopping) {
          stopping = true;
          startupProbeNonce = null;
          armGraceTimer();
        }
        stopAcknowledged = true;
        writeCode(stderr, 'TEST_STOP_ACKNOWLEDGED');
      }
    }

    function onChildError() {
      writeCode(stderr, 'TEST_CHILD_SPAWN_FAILED');
      requestStop('START_FAILED');
    }

    function onChildExit(code, signal) {
      exited = true;
      exitCode = Number.isInteger(code) ? code : null;
      exitSignal = signal || null;
    }

    function onChildClose(code, signal) {
      closed = true;
      if (!exited) onChildExit(code, signal);
      if (forced) return finish('FORCED');
      if (stopping && stopReason === 'OWNER_REQUEST' && stopAcknowledged &&
          exitCode === 0 && !exitSignal) return finish('GRACEFUL');
      if (exitCode !== 0 || exitSignal) writeCode(stderr, 'TEST_CHILD_EXIT_NONZERO');
      finish('FAILED');
    }

    ownerProcess.on('message', onOwnerMessage);
    ownerProcess.on('disconnect', onOwnerDisconnect);
    child.on('message', onRuntimeMessage);
    child.on('error', onChildError);
    child.on('exit', onChildExit);
    child.on('close', onChildClose);

    const startupTimer = setTimeoutFn(() => {
      writeCode(stderr, 'TEST_STARTUP_TIMEOUT');
      requestStop('STARTUP_TIMEOUT');
    }, startupTimeoutMs);
    const sessionTimer = setTimeoutFn(() => {
      writeCode(stderr, 'TEST_SESSION_EXPIRED');
      requestStop('SESSION_EXPIRED');
    }, sessionLimitMs);
    const leaseTimer = setIntervalFn(() => {
      if (settled || stopping) return;
      if (now() - lastOwnerLeaseAt >= leaseMs) {
        writeCode(stderr, 'TEST_OWNER_LEASE_EXPIRED');
        requestStop('OWNER_LEASE_EXPIRED');
        return;
      }
      if (runtimeBound) notifyRuntime('LAUNCHER_LEASE', { sequence: runtimeSequence++ });
    }, leaseIntervalMs);
  });
}

async function runStartLauncher({
  childEnv,
  projectRoot,
  ownerProcess = process,
  spawnFn = spawn,
  stderr = process.stderr,
  timeouts = {},
  runtimeBootstrap = path.join(projectRoot, 'src', 'platform', 'testControlRuntimeBootstrap.js'),
  runtimeEntry = path.join(projectRoot, 'src', 'platform', 'testControlRuntimeEntry.js'),
}) {
  const ownerSession = String(ownerProcess.env?.XIAOJI_TEST_OWNER_SESSION || process.env.XIAOJI_TEST_OWNER_SESSION || '');
  if (!isSessionId(ownerSession) || !ownerProcess.connected || typeof ownerProcess.send !== 'function') {
    writeCode(stderr, 'TEST_OWNER_CHANNEL_REQUIRED');
    return Object.freeze({ outcome: 'FAILED', ready: false });
  }

  try {
    await waitForOwnerBind({ ownerProcess, session: ownerSession,
      timeoutMs: timeouts.ownerBindTimeoutMs || OWNER_BIND_TIMEOUT_MS });
  } catch {
    writeCode(stderr, 'TEST_OWNER_CHANNEL_REQUIRED');
    return Object.freeze({ outcome: 'FAILED', ready: false });
  }
  if (!ownerProcess.connected) {
    writeCode(stderr, 'TEST_OWNER_DISCONNECTED');
    return Object.freeze({ outcome: 'FAILED', ready: false });
  }
  writeCode(stderr, 'TEST_OWNER_BOUND');
  sendControl(ownerProcess, 'LAUNCHER_BOUND', ownerSession);

  const runtimeSession = createSessionId();
  let child;
  try {
    child = spawnFn(process.execPath, ['--require', runtimeBootstrap, runtimeEntry], {
      cwd: projectRoot,
      env: { ...childEnv, XIAOJI_TEST_CONTROL_SESSION: runtimeSession },
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  } catch {
    writeCode(stderr, 'TEST_CHILD_SPAWN_FAILED');
    return Object.freeze({ outcome: 'FAILED', ready: false });
  }
  if (!child?.stdout || !child?.stderr || typeof child.send !== 'function') {
    writeCode(stderr, 'TEST_CHILD_SPAWN_FAILED');
    try { child?.kill?.(); } catch {}
    return Object.freeze({ outcome: 'FAILED', ready: false });
  }
  return superviseRuntime({ child, ownerProcess, ownerSession, runtimeSession, stderr, ...timeouts });
}

module.exports = {
  FORCE_CONFIRM_MS,
  GRACE_TIMEOUT_MS,
  LEASE_INTERVAL_MS,
  LEASE_MS,
  OWNER_BIND_TIMEOUT_MS,
  SESSION_LIMIT_MS,
  STARTUP_TIMEOUT_MS,
  runStartLauncher,
  sendControl,
  superviseRuntime,
  waitForOwnerBind,
  writeCode,
};
