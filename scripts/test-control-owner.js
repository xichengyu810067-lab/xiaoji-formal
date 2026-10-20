'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');
const {
  createBoundedLineDrain,
  createControlMessage,
  createSessionId,
  isControlMessage,
  safeControlLine,
} = require('../src/platform/testControlProtocol');
const {
  FORCE_CONFIRM_MS,
  GRACE_TIMEOUT_MS,
  LEASE_INTERVAL_MS,
  SESSION_LIMIT_MS,
  STARTUP_TIMEOUT_MS,
} = require('./test-control-supervisor');

const OWNER_EXIT_CONFIRM_MS = GRACE_TIMEOUT_MS + FORCE_CONFIRM_MS + 2_000;
const OWNER_PARENT_KEYS = new Set([
  'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'WINDIR',
]);
const STANDARD_LAUNCHER_PATH = path.join(__dirname, 'test-control.js');

// The launcher the owner starts: scripts/test-control.js, unless the code calling runOwner passes another
// one as launcherPath (an absolute path to a .js file). Only code can: launcherPath is never read from
// the command line or the environment. A private tool that wraps this owner passes its own fixed launcher.
function resolveLauncherPath(launcherPath = null) {
  if (launcherPath === null) return STANDARD_LAUNCHER_PATH;
  if (typeof launcherPath !== 'string' || !path.isAbsolute(launcherPath) || path.extname(launcherPath) !== '.js') {
    const error = new Error('Test-control launcher path is not allowed.');
    error.code = 'TEST_PROTOCOL_INVALID';
    throw error;
  }
  return path.normalize(launcherPath);
}

function writeLine(target, code, operation = 'owner') {
  const line = safeControlLine(code, operation);
  if (line) target.write(`${line}\n`);
}

function runOwner({
  args = process.argv.slice(2),
  processRef = process,
  spawnFn = spawn,
  now = () => Date.now(),
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  startupTimeoutMs = STARTUP_TIMEOUT_MS,
  sessionLimitMs = SESSION_LIMIT_MS,
  leaseIntervalMs = LEASE_INTERVAL_MS,
  exitConfirmMs = OWNER_EXIT_CONFIRM_MS,
  launcherPath: requestedLauncherPath = null,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = now();
    if (args[0] !== 'start') {
      writeLine(processRef.stderr, 'TEST_PROTOCOL_INVALID');
      processRef.exitCode = 1;
      return resolve({ outcome: 'FAILED', ready: false, launcherClosed: false });
    }
    const session = createSessionId();
    let launcherPath;
    try { launcherPath = resolveLauncherPath(requestedLauncherPath); } catch {
      writeLine(processRef.stderr, 'TEST_PROTOCOL_INVALID');
      processRef.exitCode = 1;
      return resolve({ outcome: 'FAILED', ready: false, launcherClosed: false });
    }
    const childEnv = { XIAOJI_TEST_OWNER_SESSION: session };
    for (const [key, value] of Object.entries(processRef.env || {})) {
      if (OWNER_PARENT_KEYS.has(key.toUpperCase())) childEnv[key] = value;
    }
    let launcher;
    try {
      launcher = spawnFn(process.execPath, [launcherPath, ...args], {
        cwd: path.join(__dirname, '..'),
        env: childEnv,
        shell: false,
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      });
    } catch {
      writeLine(processRef.stderr, 'TEST_CHILD_SPAWN_FAILED');
      processRef.exitCode = 1;
      return resolve({ outcome: 'FAILED', ready: false, launcherClosed: false });
    }
    if (!launcher?.stdout || !launcher?.stderr || typeof launcher.send !== 'function') {
      writeLine(processRef.stderr, 'TEST_CHILD_SPAWN_FAILED');
      try { launcher?.kill?.(); } catch {}
      processRef.exitCode = 1;
      return resolve({ outcome: 'FAILED', ready: false, launcherClosed: false });
    }

    let sequence = 0;
    let ready = false;
    let stopping = false;
    let launcherBound = false;
    let launcherClosed = false;
    let reportedOutcome = null;
    let reportedReason = null;
    let settled = false;
    let exitConfirmTimer = null;
    let forceConfirmTimer = null;
    let inputBuffer = '';
    let startupFreshnessConfirmed = false;

    const stdoutDrain = createBoundedLineDrain({
      stream: launcher.stdout, streamName: 'stdout',
      acceptLine: (line) => !line.endsWith('operation=owner'),
      emitLine: (line) => processRef.stderr.write(`${line}\n`),
    });
    const stderrDrain = createBoundedLineDrain({
      stream: launcher.stderr, streamName: 'stderr',
      acceptLine: (line) => !line.endsWith('operation=owner'),
      emitLine: (line) => processRef.stderr.write(`${line}\n`),
    });

    function send(type, details = {}) {
      if (!launcher.connected) return false;
      const message = createControlMessage(type, session, details);
      if (!message) return false;
      try { launcher.send(message, () => {}); return true; } catch { return false; }
    }

    function cleanup() {
      clearTimeoutFn(startupTimer);
      clearTimeoutFn(sessionTimer);
      clearTimeoutFn(exitConfirmTimer);
      clearTimeoutFn(forceConfirmTimer);
      clearIntervalFn(leaseTimer);
      stdoutDrain.close();
      stderrDrain.close();
      launcher.off('message', onMessage);
      launcher.off('error', onError);
      launcher.off('close', onClose);
      processRef.stdin?.off?.('data', onInput);
      processRef.stdin?.pause?.();
      processRef.stdin?.unref?.();
      processRef.off?.('SIGINT', onSignal);
      processRef.off?.('SIGTERM', onSignal);
    }

    function finish(outcome) {
      if (settled) return;
      settled = true;
      cleanup();
      processRef.exitCode = outcome === 'GRACEFUL' && reportedReason === 'OWNER_REQUEST' && launcherClosed ? 0 : 1;
      resolve(Object.freeze({ outcome, ready, launcherClosed }));
    }

    function requestStop(reason = 'OWNER_REQUEST') {
      if (!stopping) {
        stopping = true;
        writeLine(processRef.stderr, 'TEST_STOP_REQUESTED');
      }
      send('OWNER_STOP', { reason });
      if (!exitConfirmTimer) {
        exitConfirmTimer = setTimeoutFn(() => {
          if (launcherClosed) return;
          try { launcher.kill(); } catch {}
          reportedOutcome = 'UNVERIFIED';
          writeLine(processRef.stderr, 'TEST_RUNTIME_EXIT_UNVERIFIED');
          forceConfirmTimer = setTimeoutFn(() => finish('UNVERIFIED'), FORCE_CONFIRM_MS);
        }, exitConfirmMs);
      }
    }

    function onMessage(message) {
      if (!isControlMessage(message, { session })) return;
      if (message.type === 'LAUNCHER_BOUND') {
        launcherBound = true;
        writeLine(processRef.stderr, 'TEST_LAUNCHER_BOUND');
      } else if (message.type === 'LAUNCHER_STARTUP_PROBE' && launcherBound &&
          !startupFreshnessConfirmed && !stopping && !settled && launcher.connected &&
          now() - startedAt < sessionLimitMs) {
        startupFreshnessConfirmed = true;
        send('OWNER_STARTUP_CONFIRM', { nonce: message.nonce });
      } else if (message.type === 'RUNTIME_READY' && launcherBound && !stopping) {
        ready = true;
        clearTimeoutFn(startupTimer);
        writeLine(processRef.stdout, 'TEST_OWNER_READY');
      } else if (message.type === 'RUNTIME_EXITED') {
        reportedOutcome = message.outcome;
        reportedReason = message.reason;
      }
    }

    function onError() {
      writeLine(processRef.stderr, 'TEST_CHILD_SPAWN_FAILED');
      requestStop('START_FAILED');
    }

    function onClose(code, signal) {
      launcherClosed = true;
      if (reportedOutcome === 'GRACEFUL' && code === 0 && !signal) return finish('GRACEFUL');
      if (reportedOutcome === 'FORCED') return finish('FORCED');
      if (reportedOutcome === 'UNVERIFIED') return finish('UNVERIFIED');
      finish('FAILED');
    }

    function onInput(chunk) {
      inputBuffer += String(chunk || '');
      if (inputBuffer.length > 256) {
        inputBuffer = '';
        writeLine(processRef.stderr, 'TEST_OWNER_INPUT_REJECTED');
        return;
      }
      const lines = inputBuffer.split(/\r?\n/u);
      inputBuffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim() === 'STOP') requestStop('OWNER_REQUEST');
        else if (line.trim()) writeLine(processRef.stderr, 'TEST_OWNER_INPUT_REJECTED');
      }
    }

    function onSignal() { requestStop('OWNER_REQUEST'); }

    launcher.on('message', onMessage);
    launcher.on('error', onError);
    launcher.on('close', onClose);
    processRef.stdin?.on?.('data', onInput);
    processRef.on?.('SIGINT', onSignal);
    processRef.on?.('SIGTERM', onSignal);
    send('OWNER_BIND');

    const leaseTimer = setIntervalFn(() => {
      if (!settled && !stopping) send('OWNER_LEASE', { sequence: sequence++ });
    }, leaseIntervalMs);
    const startupTimer = setTimeoutFn(() => {
      writeLine(processRef.stderr, 'TEST_STARTUP_TIMEOUT');
      requestStop('STARTUP_TIMEOUT');
    }, startupTimeoutMs);
    const sessionTimer = setTimeoutFn(() => {
      writeLine(processRef.stderr, 'TEST_SESSION_EXPIRED');
      requestStop('SESSION_EXPIRED');
    }, sessionLimitMs);
  });
}

if (require.main === module) {
  runOwner().catch(() => {
    writeLine(process.stderr, 'TEST_BOOTSTRAP_FAILED');
    process.exitCode = 1;
  });
}

module.exports = {
  OWNER_EXIT_CONFIRM_MS, OWNER_PARENT_KEYS, STANDARD_LAUNCHER_PATH, resolveLauncherPath, runOwner, writeLine,
};
