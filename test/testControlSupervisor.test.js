'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  createBoundedLineDrain,
  createControlMessage,
  createSessionId,
} = require('../src/platform/testControlProtocol');
const { createTestControlRuntimeController } = require('../src/platform/testControlRuntimeController');
const { runStartLauncher, superviseRuntime } = require('../scripts/test-control-supervisor');
const { STANDARD_LAUNCHER_PATH, resolveLauncherPath, runOwner } = require('../scripts/test-control-owner');
const { main: runLauncherMain } = require('../scripts/test-control');
const { startRuntime } = require('../src/platform/startupSequence');
const { runAllowedTestJobs } = require('../src/platform/testControlReady');
const { PHASES } = require('../src/platform/testControlStartupDiagnostics');
const { writeTestRootMarker } = require('./testControlSupport');
const { makeRealTempDir } = require('./support/realTempDir');

const projectRoot = path.join(__dirname, '..');
const syntheticRuntime = path.join(__dirname, 'fixtures', 'testControlSyntheticRuntime.js');

test('the owner starts the standard launcher unless its calling code passes an absolute launcher path', async () => {
  assert.equal(resolveLauncherPath(), STANDARD_LAUNCHER_PATH);
  assert.equal(path.basename(STANDARD_LAUNCHER_PATH), 'test-control.js');
  for (const refused of ['standard', 'synthetic', 'relative/launcher.js', path.join(projectRoot, 'launcher.cmd'), 42]) {
    assert.throws(() => resolveLauncherPath(refused), (error) => error.code === 'TEST_PROTOCOL_INVALID', String(refused));
  }
  const otherLauncher = path.join(projectRoot, 'other-launcher.js');
  const spawned = async (options, env = {}) => {
    let childArgs = null;
    const result = await runOwner({ args: ['start'], processRef: new FakeProcess(env), ...options,
      spawnFn: (_executable, args) => { childArgs = args; throw new Error('stop after path capture'); },
    });
    assert.equal(result.outcome, 'FAILED');
    return childArgs?.[0] ?? null;
  };
  assert.equal(await spawned({}), STANDARD_LAUNCHER_PATH);
  assert.equal(await spawned({ launcherPath: otherLauncher }), otherLauncher);
  // Neither the command line nor the environment chooses the launcher.
  assert.equal(await spawned({ args: ['start', '--launcher', otherLauncher] },
    { XIAOJI_TEST_LAUNCHER: otherLauncher, LAUNCHER_PATH: otherLauncher }), STANDARD_LAUNCHER_PATH);
  assert.equal(await spawned({ launcherPath: 'relative/launcher.js' }), null);
});

class FakeProcess extends EventEmitter {
  constructor(env = {}) {
    super();
    this.connected = true;
    this.env = env;
    this.sent = [];
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.exitCode = null;
  }

  send(message, callback) {
    this.sent.push(message);
    this.emit('sent', message);
    callback?.();
    return true;
  }
}

class FakeChild extends EventEmitter {
  constructor(onSend = null) {
    super();
    this.connected = true;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    this.sent = [];
    this.killCalls = 0;
    this.onSend = onSend;
  }

  send(message, callback) {
    this.sent.push(message);
    this.onSend?.(message, this);
    callback?.();
    return true;
  }

  kill() {
    this.killCalls += 1;
    return true;
  }
}

function collect(stream) {
  let output = '';
  stream.on('data', (chunk) => { output += chunk.toString('utf8'); });
  return () => output;
}

async function waitFor(predicate, timeoutMs = 5_000) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('synthetic wait timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function spawnActualFixture(t, role, mode, { ipc = false } = {}) {
  const stdio = ipc ? ['ignore', 'pipe', 'pipe', 'ipc'] : ['pipe', 'pipe', 'pipe'];
  const env = { PATH: process.env.PATH };
  if (ipc) env.XIAOJI_TEST_OWNER_SESSION = createSessionId();
  const child = spawn(process.execPath, [syntheticRuntime, role, mode], {
    cwd: projectRoot,
    env,
    shell: false,
    detached: false,
    stdio,
  });
  const stdoutText = collect(child.stdout);
  const stderrText = collect(child.stderr);
  let closeRecord = null;
  const closed = new Promise((resolve) => child.once('close', (code, signal) => {
    closeRecord = { code, signal };
    resolve(closeRecord);
  }));
  t.after(async () => {
    child.stdin?.destroy?.();
    if (!closeRecord) {
      child.kill();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 500))]);
    }
  });
  return {
    child,
    closed,
    stdoutText,
    stderrText,
    session: env.XIAOJI_TEST_OWNER_SESSION,
  };
}

async function waitForActualClose(run, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      run.closed,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('actual synthetic process did not close')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function launchSynthetic(mode, timeouts = {}) {
  const session = createSessionId();
  const owner = new FakeProcess({ XIAOJI_TEST_OWNER_SESSION: session });
  const stderrText = collect(owner.stderr);
  const pending = runStartLauncher({
    childEnv: {
      PATH: process.env.PATH,
      XIAOJI_RUNTIME_MODE: 'test-control',
      XIAOJI_SYNTHETIC_MODE: mode,
    },
    projectRoot,
    ownerProcess: owner,
    stderr: owner.stderr,
    runtimeEntry: syntheticRuntime,
    timeouts: {
      ownerBindTimeoutMs: 500,
      startupTimeoutMs: 2_000,
      graceTimeoutMs: 200,
      forceConfirmMs: 200,
      sessionLimitMs: 4_000,
      leaseMs: 1_000,
      leaseIntervalMs: 25,
      ...timeouts,
    },
  });
  owner.on('sent', (message) => {
    if (message.type === 'LAUNCHER_STARTUP_PROBE') {
      setImmediate(() => owner.emit('message', createControlMessage(
        'OWNER_STARTUP_CONFIRM', session, { nonce: message.nonce }
      )));
    }
  });
  owner.emit('message', createControlMessage('OWNER_BIND', session));
  return { owner, pending, stderrText };
}

test('bounded drains forward only closed safe lines and suppress fake ready or arbitrary stderr', async () => {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const lines = [];
  createBoundedLineDrain({ stream: stdout, streamName: 'stdout', emitLine: (line) => lines.push(line) });
  createBoundedLineDrain({ stream: stderr, streamName: 'stderr', emitLine: (line) => lines.push(line) });
  stdout.end('[TEST_CONTROL] code=TEST_OWNER_READY operation=owner\nnot trusted\n');
  stderr.end('[time] [TEST_CONTROL] code=TEST_EGRESS_GET_LOGIN_WAIT_READY_OTHER_UNKNOWN operation=discord_rest_diagnostic\nC:/private/path\n');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lines, [
    '[TEST_CONTROL] code=TEST_OWNER_READY operation=owner',
    '[TEST_CONTROL] code=TEST_CHILD_STDOUT_SUPPRESSED operation=launcher',
    '[TEST_CONTROL] code=TEST_EGRESS_GET_LOGIN_WAIT_READY_OTHER_UNKNOWN operation=discord_rest_diagnostic',
    '[TEST_CONTROL] code=TEST_CHILD_STDERR_SUPPRESSED operation=launcher',
  ]);
  assert.equal(lines.join('\n').includes('private/path'), false);
});

test('runtime control binds one session, acknowledges repeated stop once, and shuts down once', async () => {
  const session = createSessionId();
  const processRef = new FakeProcess();
  let intervalCallback = null;
  let shutdownCalls = 0;
  const controller = createTestControlRuntimeController({
    env: { XIAOJI_RUNTIME_MODE: 'test-control', XIAOJI_TEST_CONTROL_SESSION: session },
    processRef,
    setIntervalFn: (callback) => { intervalCallback = callback; return 1; },
    clearIntervalFn: () => {},
  });
  assert.equal(processRef.sent[0].type, 'RUNTIME_HELLO');
  processRef.emit('message', createControlMessage('LAUNCHER_BIND', session));
  await controller.awaitBound();
  controller.bindShutdown(async () => { shutdownCalls += 1; });
  processRef.emit('message', createControlMessage('LAUNCHER_STOP', session, { reason: 'OWNER_REQUEST' }));
  processRef.emit('message', createControlMessage('LAUNCHER_STOP', session, { reason: 'OWNER_REQUEST' }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.isStopping(), true);
  assert.equal(shutdownCalls, 1);
  assert.equal(processRef.sent.filter((message) => message.type === 'RUNTIME_STOP_ACK').length, 2);
  assert.equal(typeof intervalCallback, 'function');
  controller.dispose();
});

test('runtime control stops on launcher disconnect and on a live channel that stops renewing its lease', async () => {
  for (const trigger of ['disconnect', 'lease']) {
    const session = createSessionId();
    const processRef = new FakeProcess();
    let current = 0;
    let reason = null;
    const controller = createTestControlRuntimeController({
      env: { XIAOJI_RUNTIME_MODE: 'test-control', XIAOJI_TEST_CONTROL_SESSION: session },
      processRef,
      now: () => current,
      setIntervalFn: () => 1,
      clearIntervalFn: () => {},
      leaseMs: 50,
    });
    controller.bindShutdown(async (value) => { reason = value; });
    processRef.emit('message', createControlMessage('LAUNCHER_BIND', session));
    await controller.awaitBound();
    const freshness = controller.awaitStartupFreshness();
    const nonce = processRef.sent.find((message) => message.type === 'RUNTIME_STARTUP_PROBE').nonce;
    processRef.emit('message', createControlMessage('LAUNCHER_STARTUP_CONFIRM', session, { nonce }));
    await freshness;
    if (trigger === 'disconnect') processRef.emit('disconnect');
    else { current = 51; controller.checkLease(); }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(reason, trigger === 'disconnect' ? 'LAUNCHER_DISCONNECTED' : 'LAUNCHER_LEASE_EXPIRED');
    controller.dispose();
  }
});

test('runtime starts graceful shutdown only after STOP_ACK is queued', async () => {
  const session = createSessionId();
  const processRef = new FakeProcess();
  let pendingCallback = null;
  processRef.send = function send(message, callback) {
    this.sent.push(message);
    if (message.type === 'RUNTIME_STOP_ACK') pendingCallback = callback;
    else callback?.();
    return true;
  };
  let shutdownCalls = 0;
  const controller = createTestControlRuntimeController({
    env: { XIAOJI_RUNTIME_MODE: 'test-control', XIAOJI_TEST_CONTROL_SESSION: session },
    processRef,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    setTimeoutFn: () => 2,
    clearTimeoutFn: () => {},
  });
  processRef.emit('message', createControlMessage('LAUNCHER_BIND', session));
  await controller.awaitBound();
  controller.bindShutdown(async () => { shutdownCalls += 1; });
  processRef.emit('message', createControlMessage('LAUNCHER_STOP', session, { reason: 'OWNER_REQUEST' }));
  assert.equal(shutdownCalls, 0);
  pendingCallback();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(shutdownCalls, 1);
  controller.dispose();
});

test('startup cancellation after an awaited preflight prevents login and later work', async () => {
  let stopping = false;
  const calls = [];
  await assert.rejects(() => startRuntime({
    preflightControl: async () => { calls.push('control'); stopping = true; },
    preflightPublic: async () => calls.push('public'),
    preflightPrivate: async () => calls.push('private'),
    shouldDeploy: () => false,
    deploy: async () => calls.push('deploy'),
    login: async () => calls.push('login'),
    runtimeControl: {
      assertRunning() {
        if (stopping) throw Object.assign(new Error('stopping'), { code: 'TEST_STARTUP_CANCELLED' });
      },
    },
  }), (error) => error.code === 'TEST_STARTUP_CANCELLED');
  assert.deepEqual(calls, ['control']);
});

test('stop racing with login is rechecked after login resolves', async () => {
  let stopping = false;
  let releaseLogin;
  const calls = [];
  const pending = startRuntime({
    preflightControl: async () => calls.push('control'),
    preflightPublic: async () => calls.push('public'),
    preflightPrivate: async () => calls.push('private'),
    shouldDeploy: () => false,
    deploy: async () => calls.push('deploy'),
    login: async () => { calls.push('login'); await new Promise((resolve) => { releaseLogin = resolve; }); },
    runtimeControl: {
      assertRunning() {
        if (stopping) throw Object.assign(new Error('stopping'), { code: 'TEST_STARTUP_CANCELLED' });
      },
    },
  });
  await waitFor(() => typeof releaseLogin === 'function');
  stopping = true;
  releaseLogin();
  await assert.rejects(() => pending, (error) => error.code === 'TEST_STARTUP_CANCELLED');
  assert.deepEqual(calls, ['control', 'public', 'private', 'login']);
});

test('ready job cancellation checks before and after every approved job', async () => {
  let stopping = false;
  const calls = [];
  await assert.rejects(() => runAllowedTestJobs({ allowedJobs: new Set(['one', 'two']) }, {
    one: async () => { calls.push('one'); stopping = true; },
    two: async () => calls.push('two'),
  }, {
    assertRunning() {
      if (stopping) throw Object.assign(new Error('stopping'), { code: 'TEST_STARTUP_CANCELLED' });
    },
  }), (error) => error.code === 'TEST_STARTUP_CANCELLED');
  assert.deepEqual(calls, ['one']);
});

test('synthetic owner-launcher-runtime reaches trusted IPC ready then graceful ACK, exit and close', async () => {
  const run = await launchSynthetic('ready');
  await waitFor(() => run.owner.sent.some((message) => message.type === 'RUNTIME_READY'));
  run.owner.emit('message', createControlMessage('OWNER_STOP', run.owner.env.XIAOJI_TEST_OWNER_SESSION,
    { reason: 'OWNER_REQUEST' }));
  const result = await run.pending;
  assert.deepEqual({ outcome: result.outcome, ready: result.ready, ack: result.stopAcknowledged,
    exited: result.exited, closed: result.closed },
  { outcome: 'GRACEFUL', ready: true, ack: true, exited: true, closed: true });
});

test('actual owner process forwards fixed double-drained diagnostics and exits nonzero after startup failure', async (t) => {
  const run = spawnActualFixture(t, 'owner', 'diagnostic-fail');
  const close = await waitForActualClose(run);
  assert.equal(close.code, 1);
  assert.equal(close.signal, null);
  assert.equal(run.stdoutText().includes('TEST_OWNER_READY'), false);
  assert.match(run.stderrText(),
    /TEST_EGRESS_GET_LOGIN_WAIT_READY_OTHER_UNKNOWN operation=discord_rest_diagnostic/u);
  assert.match(run.stderrText(), /TEST_RUNTIME_START_FAILED operation=start/u);
  assert.match(run.stderrText(), /TEST_RUNTIME_EXITED_FAILED operation=launcher/u);
  assert.equal(run.stderrText().includes('SYNTHETIC_PRIVATE_DIAGNOSTIC_CANARY'), false);
});

test('actual double-drained processes expose every reached startup phase and only fixed UNKNOWN failure', async (t) => {
  for (const phase of PHASES) {
    const mode = `diagnostic-phase-${phase.toLowerCase().replaceAll('_', '-')}`;
    const run = spawnActualFixture(t, 'owner', mode);
    const close = await waitForActualClose(run, 15_000);
    const output = run.stderrText();
    assert.equal(close.code, 1, phase);
    assert.match(output, new RegExp(`TEST_STARTUP_PHASE_${phase} operation=startup_diagnostic`, 'u'));
    assert.match(output, /TEST_STARTUP_UNKNOWN operation=startup_diagnostic/u);
    assert.match(output, /TEST_RUNTIME_EXITED_FAILED operation=launcher/u);
    assert.equal(run.stdoutText().includes('TEST_OWNER_READY'), false);
    for (const canary of ['SYNTHETIC_PHASE_PRIVATE_CANARY', 'SYNTHETIC_ERROR_PRIVATE_CANARY']) {
      assert.equal(output.includes(canary), false);
    }
    const later = PHASES.slice(PHASES.indexOf(phase) + 1);
    for (const laterPhase of later) assert.equal(output.includes(`TEST_STARTUP_PHASE_${laterPhase}`), false);
  }
});

test('actual double-drained processes retain closed SDK, ready guard, REST guard, and hostile classifications', async (t) => {
  const cases = [
    ['diagnostic-token', 'TEST_STARTUP_LOGIN_TOKEN_INVALID'],
    ['diagnostic-rest-503', 'TEST_STARTUP_REST_SERVER_FAILED'],
    ['diagnostic-gateway-4014', 'TEST_STARTUP_GATEWAY_DISALLOWED_INTENTS'],
    ['diagnostic-malicious', 'TEST_STARTUP_UNKNOWN'],
    ['diagnostic-ready-identity', 'TEST_READY_GUILD_MISMATCH'],
    ['diagnostic-ready-job', 'TEST_JOB_NOT_REVIEWED'],
    ['diagnostic-failure-before-stop', 'TEST_DATA_PATH_INVALID'],
    ['diagnostic-runtime-entry-sync', 'TEST_STARTUP_DEPENDENCY_MISSING'],
  ];
  for (const [mode, code] of cases) {
    const run = spawnActualFixture(t, 'owner', mode);
    const close = await waitForActualClose(run, 15_000);
    const output = run.stderrText();
    assert.equal(close.code, 1, mode);
    assert.match(output, new RegExp(`${code} operation=startup_diagnostic`, 'u'));
    assert.match(output, /TEST_RUNTIME_EXITED_FAILED operation=launcher/u);
    assert.equal(output.includes('TEST_STARTUP_CANCELLED operation=startup_diagnostic'), false);
    for (const canary of [
      'SYNTHETIC_REST_PRIVATE_CANARY', 'private.invalid', 'SYNTHETIC_GATEWAY_PRIVATE_CANARY',
      'SYNTHETIC_GETTER_PRIVATE_CANARY', 'SYNTHETIC_PROTO_PRIVATE_CANARY',
      'SYNTHETIC_STDERR_PRIVATE_CANARY',
      'SYNTHETIC_MODULE_PRIVATE_CANARY',
    ]) assert.equal(output.includes(canary), false);
  }
});

test('actual unknown GET keeps its original fixed route diagnostic and never reaches arbitrary text', async (t) => {
  const run = spawnActualFixture(t, 'owner', 'diagnostic-unknown-get');
  const close = await waitForActualClose(run, 15_000);
  const output = run.stderrText();
  assert.equal(close.code, 1);
  assert.match(output,
    /TEST_EGRESS_GET_LOGIN_WAIT_READY_OTHER_UNKNOWN operation=discord_rest_diagnostic/u);
  assert.match(output, /TEST_UNKNOWN_READ_DENIED operation=startup_diagnostic/u);
  for (const canary of ['SYNTHETIC_STACK_PRIVATE_CANARY', 'SYNTHETIC_ROUTE_PRIVATE_CANARY']) {
    assert.equal(output.includes(canary), false);
  }
});

test('actual permanent gateway wait reports its last phase and cancellation only after startup timeout', async (t) => {
  const run = spawnActualFixture(t, 'owner', 'diagnostic-hang-gateway');
  const close = await waitForActualClose(run, 15_000);
  const output = run.stderrText();
  assert.equal(close.code, 1);
  assert.match(output, /TEST_STARTUP_PHASE_LOGIN_GATEWAY operation=startup_diagnostic/u);
  assert.match(output, /TEST_STARTUP_TIMEOUT operation=launcher/u);
  assert.match(output, /TEST_STARTUP_CANCELLED operation=startup_diagnostic/u);
  assert.ok(output.indexOf('TEST_STARTUP_PHASE_LOGIN_GATEWAY operation=startup_diagnostic') <
    output.indexOf('TEST_STARTUP_TIMEOUT operation=launcher'));
  assert.ok(output.indexOf('TEST_STARTUP_TIMEOUT operation=launcher') <
    output.indexOf('TEST_STARTUP_CANCELLED operation=startup_diagnostic'));
  assert.equal(output.includes('TEST_STARTUP_LOGIN_TOKEN_INVALID'), false);
  assert.equal(run.stdoutText().includes('TEST_OWNER_READY'), false);
});

test('actual owner STOP before a later login-shaped error stays cancellation and exits through full graceful chain', async (t) => {
  const run = spawnActualFixture(t, 'owner', 'diagnostic-stop-then-error');
  await waitFor(() => run.stdoutText().includes('TEST_OWNER_READY'), 15_000);
  run.child.stdin.write('STOP\n');
  const close = await waitForActualClose(run);
  const output = run.stderrText();
  assert.equal(close.code, 0);
  assert.match(output, /TEST_STARTUP_CANCELLED operation=startup_diagnostic/u);
  assert.equal(output.includes('TEST_STARTUP_LOGIN_TOKEN_INVALID'), false);
  assert.match(output, /TEST_STOP_ACKNOWLEDGED operation=launcher/u);
  assert.match(output, /TEST_RUNTIME_EXITED_GRACEFUL operation=launcher/u);
});

test('actual owner process holds stdin through ready, accepts STOP, and exits zero only after close evidence', async (t) => {
  const run = spawnActualFixture(t, 'owner', 'ready');
  await waitFor(() => run.stdoutText().includes('TEST_OWNER_READY'));
  run.child.stdin.write('STOP\n');
  const close = await waitForActualClose(run);
  assert.equal(close.code, 0);
  assert.equal(close.signal, null);
  assert.match(run.stderrText(), /TEST_STOP_REQUESTED operation=owner/u);
  assert.match(run.stderrText(), /TEST_STOP_ACKNOWLEDGED operation=launcher/u);
  assert.match(run.stderrText(), /TEST_RUNTIME_EXITED_GRACEFUL operation=launcher/u);
});

test('actual startup nonce reaches the locked identity routes through the installed REST guard', async (t) => {
  const run = spawnActualFixture(t, 'owner', 'identity-route-preflight');
  await waitFor(() => run.stdoutText().includes('TEST_OWNER_READY'), 15_000);
  run.child.stdin.write('STOP\n');
  const close = await waitForActualClose(run);
  const output = run.stderrText();
  assert.equal(close.code, 0);
  assert.equal(close.signal, null);
  assert.match(output, /TEST_RUNTIME_BOUND operation=launcher/u);
  assert.match(output, /TEST_STOP_ACKNOWLEDGED operation=launcher/u);
  assert.match(output, /TEST_RUNTIME_EXITED_GRACEFUL operation=launcher/u);
  assert.equal(output.includes('TEST_UNKNOWN_READ_DENIED'), false);
  assert.equal(output.includes('TEST_RUNTIME_START_FAILED'), false);
});

test('actual chain starts its freshness deadline after more than 5s of synchronous loading', async (t) => {
  const run = spawnActualFixture(t, 'owner', 'freshness-slow-load');
  await waitFor(() => run.stdoutText().includes('TEST_OWNER_READY'), 10_000);
  run.child.stdin.write('STOP\n');
  const close = await waitForActualClose(run, 5_000);
  assert.equal(close.code, 0);
  assert.equal(close.signal, null);
  assert.match(run.stderrText(), /TEST_RUNTIME_BOUND operation=launcher/u);
  assert.match(run.stderrText(), /TEST_STOP_ACKNOWLEDGED operation=launcher/u);
  assert.match(run.stderrText(), /TEST_RUNTIME_EXITED_GRACEFUL operation=launcher/u);
  assert.equal(run.stderrText().includes('TEST_STARTUP_TIMEOUT'), false);
});

test('actual ACK without runtime exit is forced and can never report graceful', async (t) => {
  const run = spawnActualFixture(t, 'owner', 'hang-on-stop');
  await waitFor(() => run.stdoutText().includes('TEST_OWNER_READY'));
  run.child.stdin.write('STOP\n');
  const close = await waitForActualClose(run);
  assert.equal(close.code, 1);
  assert.match(run.stderrText(), /TEST_STOP_ACKNOWLEDGED operation=launcher/u);
  assert.match(run.stderrText(), /TEST_RUNTIME_EXITED_FORCED operation=launcher/u);
  assert.equal(run.stderrText().includes('TEST_RUNTIME_EXITED_GRACEFUL'), false);
});

test('actual startup timeout and runtime IPC disconnect exit nonzero without trusted ready or graceful outcome', async (t) => {
  for (const mode of ['fake-stdout-ready', 'runtime-disconnect']) {
    const run = spawnActualFixture(t, 'owner', mode);
    const close = await waitForActualClose(run);
    assert.equal(close.code, 1);
    assert.equal(run.stdoutText().includes('TEST_OWNER_READY'), false);
    assert.match(run.stderrText(), /TEST_RUNTIME_EXITED_FAILED operation=launcher/u);
    assert.equal(run.stderrText().includes('TEST_RUNTIME_EXITED_GRACEFUL'), false);
  }
});

test('bootstrap or preflight failure exits without trusted ready', async () => {
  for (const mode of ['bootstrap-throw', 'preflight-reject']) {
    const run = await launchSynthetic(mode);
    const result = await run.pending;
    assert.equal(result.ready, false);
    assert.equal(result.outcome, 'FAILED');
    assert.equal(run.owner.sent.some((message) => message.type === 'RUNTIME_READY'), false);
  }
});

test('fake stdout READY never becomes trusted readiness and arbitrary child output is suppressed', async () => {
  const run = await launchSynthetic('fake-stdout-ready');
  await waitFor(() => run.stderrText().includes('TEST_CHILD_STDOUT_SUPPRESSED') &&
    run.stderrText().includes('TEST_CHILD_STDERR_SUPPRESSED'));
  assert.match(run.stderrText(), /TEST_CHILD_STDOUT_SUPPRESSED/u);
  assert.match(run.stderrText(), /TEST_CHILD_STDERR_SUPPRESSED/u);
  assert.equal(run.stderrText().includes('TEST_OWNER_READY'), false);
  assert.equal(run.owner.sent.some((message) => message.type === 'RUNTIME_READY'), false);
  run.owner.emit('message', createControlMessage('OWNER_STOP', run.owner.env.XIAOJI_TEST_OWNER_SESSION,
    { reason: 'OWNER_REQUEST' }));
  const result = await run.pending;
  assert.equal(result.ready, false);
  assert.equal(result.outcome, 'GRACEFUL');
});

test('owner disconnect and a live owner that stops renewing both fail closed after runtime stops', async () => {
  const disconnected = await launchSynthetic('ready');
  await waitFor(() => disconnected.owner.sent.some((message) => message.type === 'RUNTIME_READY'));
  disconnected.owner.connected = false;
  disconnected.owner.emit('disconnect');
  assert.equal((await disconnected.pending).outcome, 'FAILED');

  const expired = await launchSynthetic('ready', { leaseMs: 40, leaseIntervalMs: 10 });
  let sequence = 0;
  const renew = setInterval(() => expired.owner.emit('message', createControlMessage(
    'OWNER_LEASE', expired.owner.env.XIAOJI_TEST_OWNER_SESSION, { sequence: sequence++ }
  )), 10);
  await waitFor(() => expired.owner.sent.some((message) => message.type === 'RUNTIME_READY'));
  clearInterval(renew);
  const expiredResult = await expired.pending;
  assert.equal(expiredResult.outcome, 'FAILED');
  assert.equal(expired.stderrText().includes('TEST_OWNER_LEASE_EXPIRED'), true);
});

test('the first stop reason is immutable and a later owner request cannot turn a timeout graceful', async () => {
  const ownerSession = createSessionId();
  const runtimeSession = createSessionId();
  const owner = new FakeProcess({ XIAOJI_TEST_OWNER_SESSION: ownerSession });
  const child = new FakeChild();
  const pending = superviseRuntime({
    child, ownerProcess: owner, ownerSession, runtimeSession, stderr: owner.stderr,
    startupTimeoutMs: 1_000, graceTimeoutMs: 200, forceConfirmMs: 100,
    sessionLimitMs: 2_000, leaseMs: 500, leaseIntervalMs: 10,
  });
  child.emit('message', createControlMessage('RUNTIME_HELLO', runtimeSession));
  child.emit('message', createControlMessage('RUNTIME_BOUND', runtimeSession));
  owner.emit('message', createControlMessage('OWNER_STOP', ownerSession, { reason: 'STARTUP_TIMEOUT' }));
  owner.emit('message', createControlMessage('OWNER_STOP', ownerSession, { reason: 'OWNER_REQUEST' }));
  child.emit('message', createControlMessage('RUNTIME_STOP_ACK', runtimeSession,
    { reason: 'STARTUP_TIMEOUT' }));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.stopReason, 'STARTUP_TIMEOUT');
  assert.equal(result.outcome, 'FAILED');
});

test('a runtime that ACKs but hangs is forcibly terminated through its owned child handle', async () => {
  const run = await launchSynthetic('hang-on-stop', { graceTimeoutMs: 40, forceConfirmMs: 200 });
  await waitFor(() => run.owner.sent.some((message) => message.type === 'RUNTIME_READY'));
  run.owner.emit('message', createControlMessage('OWNER_STOP', run.owner.env.XIAOJI_TEST_OWNER_SESSION,
    { reason: 'OWNER_REQUEST' }));
  const result = await run.pending;
  assert.equal(result.outcome, 'FORCED');
  assert.equal(result.stopAcknowledged, true);
  assert.equal(result.closed, true);
});

test('a child that never ACKs is still forcibly closed through only its owned handle', async () => {
  const ownerSession = createSessionId();
  const runtimeSession = createSessionId();
  const owner = new FakeProcess({ XIAOJI_TEST_OWNER_SESSION: ownerSession });
  const child = new FakeChild();
  child.kill = function kill() {
    this.killCalls += 1;
    setImmediate(() => { this.emit('exit', null, 'SIGTERM'); this.emit('close', null, 'SIGTERM'); });
    return true;
  };
  const pending = superviseRuntime({
    child, ownerProcess: owner, ownerSession, runtimeSession, stderr: owner.stderr,
    startupTimeoutMs: 1_000, graceTimeoutMs: 20, forceConfirmMs: 100,
    sessionLimitMs: 2_000, leaseMs: 500, leaseIntervalMs: 10,
  });
  child.emit('message', createControlMessage('RUNTIME_HELLO', runtimeSession));
  child.emit('message', createControlMessage('RUNTIME_BOUND', runtimeSession));
  child.emit('message', createControlMessage('RUNTIME_READY', runtimeSession));
  owner.emit('message', createControlMessage('OWNER_STOP', ownerSession, { reason: 'OWNER_REQUEST' }));
  const result = await pending;
  assert.equal(result.outcome, 'FORCED');
  assert.equal(result.stopAcknowledged, false);
  assert.equal(result.closed, true);
  assert.equal(child.killCalls, 1);
});

test('missing close after owned-child force is distinguished as EXIT_UNVERIFIED', async () => {
  const ownerSession = createSessionId();
  const runtimeSession = createSessionId();
  const owner = new FakeProcess({ XIAOJI_TEST_OWNER_SESSION: ownerSession });
  const child = new FakeChild();
  const pending = superviseRuntime({
    child, ownerProcess: owner, ownerSession, runtimeSession, stderr: owner.stderr,
    startupTimeoutMs: 1_000, graceTimeoutMs: 20, forceConfirmMs: 20,
    sessionLimitMs: 2_000, leaseMs: 500, leaseIntervalMs: 10,
  });
  child.emit('message', createControlMessage('RUNTIME_HELLO', runtimeSession));
  child.emit('message', createControlMessage('RUNTIME_BOUND', runtimeSession));
  child.emit('message', createControlMessage('RUNTIME_READY', runtimeSession));
  owner.emit('message', createControlMessage('OWNER_STOP', ownerSession, { reason: 'OWNER_REQUEST' }));
  const result = await pending;
  assert.equal(result.outcome, 'UNVERIFIED');
  assert.equal(child.killCalls, 1);
  assert.equal(result.closed, false);
});

test('generic QA owner holds upstream IPC until STOP and confirms launcher close', async () => {
  const fakeProcess = new FakeProcess({ PATH: process.env.PATH, PRIVATE_PARENT_VALUE: 'must-not-inherit' });
  const stdoutText = collect(fakeProcess.stdout);
  let spawnedEnv = null;
  const child = new FakeChild((message, launcher) => {
    if (message.type === 'OWNER_BIND') {
      setImmediate(() => {
        launcher.emit('message', createControlMessage('LAUNCHER_BOUND', message.session));
        launcher.emit('message', createControlMessage('RUNTIME_READY', message.session));
      });
    } else if (message.type === 'OWNER_STOP') {
      launcher.emit('message', createControlMessage('RUNTIME_EXITED', message.session,
        { outcome: 'GRACEFUL', reason: 'OWNER_REQUEST' }));
      setImmediate(() => launcher.emit('close', 0, null));
    }
  });
  const pending = runOwner({
    args: ['start', '--config', 'synthetic', '--trust', 'synthetic'],
    processRef: fakeProcess,
    spawnFn: (executable, args, options) => { spawnedEnv = options.env; return child; },
    startupTimeoutMs: 1_000,
    sessionLimitMs: 2_000,
    leaseIntervalMs: 20,
    exitConfirmMs: 200,
  });
  await waitFor(() => stdoutText().includes('TEST_OWNER_READY'));
  fakeProcess.stdin.write('STOP\n');
  const result = await pending;
  assert.deepEqual(result, { outcome: 'GRACEFUL', ready: true, launcherClosed: true });
  assert.equal(fakeProcess.exitCode, 0);
  assert.equal(spawnedEnv.PRIVATE_PARENT_VALUE, undefined);
  assert.equal(typeof spawnedEnv.XIAOJI_TEST_OWNER_SESSION, 'string');
});

test('start refuses to spawn without an upstream owner IPC channel', async () => {
  const owner = new FakeProcess({ XIAOJI_TEST_OWNER_SESSION: createSessionId() });
  owner.connected = false;
  let spawnCalls = 0;
  const result = await runStartLauncher({
    childEnv: {}, projectRoot, ownerProcess: owner, stderr: owner.stderr,
    spawnFn: () => { spawnCalls += 1; return new FakeChild(); },
  });
  assert.equal(result.outcome, 'FAILED');
  assert.equal(spawnCalls, 0);
});

test('start launcher uses only the test-control runtime entry while production entry remains unchanged', async () => {
  const ownerSession = createSessionId();
  const owner = new FakeProcess({ XIAOJI_TEST_OWNER_SESSION: ownerSession });
  let spawnArgs = null;
  let runtimeSession = null;
  const child = new FakeChild((message, runtime) => {
    if (message.type === 'LAUNCHER_BIND') {
      setImmediate(() => {
        runtime.emit('message', createControlMessage('RUNTIME_BOUND', message.session));
        runtime.emit('message', createControlMessage('RUNTIME_READY', message.session));
      });
    } else if (message.type === 'LAUNCHER_STOP') {
      runtime.emit('message', createControlMessage('RUNTIME_STOP_ACK', message.session,
        { reason: message.reason }));
      setImmediate(() => {
        runtime.emit('exit', 0, null);
        runtime.emit('close', 0, null);
      });
    }
  });
  const pending = runStartLauncher({
    childEnv: {}, projectRoot, ownerProcess: owner, stderr: owner.stderr,
    spawnFn: (executable, args, options) => {
      spawnArgs = [executable, ...args];
      runtimeSession = options.env.XIAOJI_TEST_CONTROL_SESSION;
      return child;
    },
    timeouts: {
      ownerBindTimeoutMs: 500, startupTimeoutMs: 1_000, graceTimeoutMs: 200,
      forceConfirmMs: 100, sessionLimitMs: 2_000, leaseMs: 500, leaseIntervalMs: 10,
    },
  });
  owner.emit('message', createControlMessage('OWNER_BIND', ownerSession));
  await waitFor(() => Array.isArray(spawnArgs));
  child.emit('message', createControlMessage('RUNTIME_HELLO', runtimeSession));
  await waitFor(() => owner.sent.some((message) => message.type === 'RUNTIME_READY'));
  owner.emit('message', createControlMessage('OWNER_STOP', ownerSession, { reason: 'OWNER_REQUEST' }));
  const result = await pending;
  assert.equal(result.outcome, 'GRACEFUL');
  assert.deepEqual(spawnArgs.slice(1), [
    '--require', path.join(projectRoot, 'src', 'platform', 'testControlRuntimeBootstrap.js'),
    path.join(projectRoot, 'src', 'platform', 'testControlRuntimeEntry.js'),
  ]);
  assert.equal(spawnArgs.includes(path.join(projectRoot, 'src', 'index.js')), false);
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  assert.equal(packageJson.scripts.start, 'node src/index.js');
});

test('test runtime bootstrap exits before the main module when IPC is absent, while production is untouched', () => {
  const bootstrap = path.join(projectRoot, 'src', 'platform', 'testControlRuntimeBootstrap.js');
  const rejected = spawnSync(process.execPath, ['--require', bootstrap, '-e', 'process.stdout.write("MAIN_RAN")'], {
    cwd: projectRoot,
    env: { PATH: process.env.PATH, XIAOJI_RUNTIME_MODE: 'test-control', XIAOJI_TEST_CONTROL_SESSION: createSessionId() },
    encoding: 'utf8',
    shell: false,
  });
  assert.equal(rejected.status, 1);
  assert.equal(rejected.stdout, '');
  assert.equal(rejected.stderr.trim(),
    '[TEST_CONTROL] code=TEST_CONTROL_CHANNEL_REQUIRED operation=runtime');

  const production = spawnSync(process.execPath, ['--require', bootstrap, '-e', 'process.stdout.write("MAIN_RAN")'], {
    cwd: projectRoot, env: { PATH: process.env.PATH }, encoding: 'utf8', shell: false,
  });
  assert.equal(production.status, 0);
  assert.equal(production.stdout, 'MAIN_RAN');
  assert.equal(production.stderr, '');
});

test('deploy keeps the prior synchronous branch and never waits for Bot READY', async () => {
  const root = makeRealTempDir('xiaoji-supervisor-deploy-');
  try {
    const configPath = path.join(root, 'launcher.env');
    const trustPath = path.join(root, 'trust.json');
    fs.writeFileSync(configPath, 'DISCORD_TOKEN=synthetic\nDISCORD_CLIENT_ID=111111111111111111\nBOT_OWNER_ID=555555555555555555\n');
    fs.writeFileSync(trustPath, JSON.stringify({
      schemaVersion: 1,
      expectedApplicationId: '111111111111111111',
      forbiddenApplicationIds: ['222222222222222222'],
      allowedGuildIds: ['333333333333333333'],
      allowedChannelIds: ['444444444444444444'],
      allowedActorIds: ['555555555555555555'],
      dataRoot: root,
    }));
    writeTestRootMarker(root, '111111111111111111');
    const processRef = new FakeProcess({ PATH: process.env.PATH });
    let spawnOptions = null;
    const result = await runLauncherMain(['deploy', '--config', configPath, '--trust', trustPath], {
      processRef,
      spawnSyncFn: (executable, args, options) => {
        spawnOptions = { executable, args, options };
        return { status: 0, error: null };
      },
    });
    assert.equal(result.outcome, 'GRACEFUL');
    assert.equal(spawnOptions.args.at(-1), '--test-control');
    assert.equal(spawnOptions.options.shell, false);
    assert.equal(processRef.exitCode, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
