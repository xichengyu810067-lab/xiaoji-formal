'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  createControlMessage,
  createSessionId,
  isControlMessage,
} = require('../src/platform/testControlProtocol');
const {
  createTestControlRuntimeController,
} = require('../src/platform/testControlRuntimeController');
const { runRuntimeEntry } = require('../src/platform/testControlRuntimeEntry');
const { runOwner } = require('../scripts/test-control-owner');
const { superviseRuntime } = require('../scripts/test-control-supervisor');

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

class FakeChild extends FakeProcess {
  constructor(onSend = null) {
    super();
    this.killCalls = 0;
    this.onSend = onSend;
  }

  send(message, callback) {
    super.send(message, callback);
    this.onSend?.(message, this);
    return true;
  }

  kill() {
    this.killCalls += 1;
    return true;
  }
}

function immediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function createManualClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    setTimeoutFn(callback, delay) {
      const id = nextId++;
      timers.set(id, { callback, due: current + delay });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    advance(milliseconds) {
      current += milliseconds;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= current) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    activeTimers: () => timers.size,
  };
}

function createRuntimeController({ clock = createManualClock(), session = createSessionId() } = {}) {
  const processRef = new FakeProcess();
  const reasons = [];
  const controller = createTestControlRuntimeController({
    env: { XIAOJI_RUNTIME_MODE: 'test-control', XIAOJI_TEST_CONTROL_SESSION: session },
    processRef,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    leaseMs: 50,
    randomBytes: () => Buffer.alloc(16, 0xab),
  });
  controller.bindShutdown(async (reason) => { reasons.push(reason); });
  processRef.emit('message', createControlMessage('LAUNCHER_BIND', session));
  return { clock, controller, processRef, reasons, session };
}

test('startup freshness protocol uses a closed exact nonce schema', () => {
  const session = createSessionId();
  const nonce = 'ab'.repeat(16);
  for (const type of [
    'RUNTIME_STARTUP_PROBE',
    'LAUNCHER_STARTUP_PROBE',
    'OWNER_STARTUP_CONFIRM',
    'LAUNCHER_STARTUP_CONFIRM',
  ]) {
    const message = createControlMessage(type, session, { nonce });
    assert.deepEqual(Object.keys(message).sort(), ['nonce', 'session', 'type', 'version']);
    assert.equal(isControlMessage(message, { type, session }), true);
    assert.equal(createControlMessage(type, session, { nonce, extra: true }), null);
    assert.equal(createControlMessage(type, session, { nonce: nonce.toUpperCase() }), null);
    assert.equal(createControlMessage(type, session, { nonce: nonce.slice(2) }), null);
    assert.equal(isControlMessage({ ...message, extra: true }), false);
  }
});

test('runtime always performs one single-flight owner freshness roundtrip before ready', async () => {
  const run = createRuntimeController();
  await run.controller.awaitBound();
  run.processRef.emit('message', createControlMessage('LAUNCHER_LEASE', run.session, { sequence: 7 }));

  const first = run.controller.awaitStartupFreshness();
  const second = run.controller.awaitStartupFreshness();
  assert.strictEqual(first, second);
  const probes = run.processRef.sent.filter((message) => message.type === 'RUNTIME_STARTUP_PROBE');
  assert.equal(probes.length, 1);
  assert.equal(probes[0].nonce, 'ab'.repeat(16));

  let resolved = false;
  first.then(() => { resolved = true; });
  run.processRef.emit('message', createControlMessage('LAUNCHER_STARTUP_CONFIRM', run.session,
    { nonce: 'cd'.repeat(16) }));
  run.processRef.emit('message', createControlMessage('LAUNCHER_LEASE', run.session, { sequence: 7 }));
  await immediate();
  assert.equal(resolved, false);

  run.processRef.emit('message', createControlMessage('LAUNCHER_STARTUP_CONFIRM', run.session,
    { nonce: probes[0].nonce }));
  assert.equal(await first, true);
  assert.equal(run.controller.markReady(), true);

  run.clock.advance(51);
  run.controller.checkLease();
  await immediate();
  assert.deepEqual(run.reasons, ['LAUNCHER_LEASE_EXPIRED']);
  assert.equal(run.processRef.sent.filter((message) => message.type === 'RUNTIME_STARTUP_PROBE').length, 1);
  run.controller.dispose();
});

test('runtime freshness has one total 1000ms deadline with no retry', async () => {
  const run = createRuntimeController();
  await run.controller.awaitBound();
  const pending = run.controller.awaitStartupFreshness();
  assert.equal(run.clock.activeTimers(), 1);
  run.clock.advance(999);
  assert.equal(run.reasons.length, 0);
  run.clock.advance(1);
  await assert.rejects(pending, (error) => error.code === 'TEST_STARTUP_CANCELLED');
  await immediate();
  assert.deepEqual(run.reasons, ['STARTUP_FRESHNESS_TIMEOUT']);
  assert.equal(run.processRef.sent.filter((message) => message.type === 'RUNTIME_STARTUP_PROBE').length, 1);
  assert.equal(run.clock.activeTimers(), 0);
  run.controller.dispose();
});

test('runtime rejects a pending freshness gate on stop, disconnect, and disposal', async (t) => {
  for (const action of ['stop', 'disconnect', 'dispose']) {
    await t.test(action, async () => {
      const run = createRuntimeController();
      await run.controller.awaitBound();
      const pending = run.controller.awaitStartupFreshness();
      if (action === 'stop') {
        run.processRef.emit('message', createControlMessage('LAUNCHER_STOP', run.session,
          { reason: 'OWNER_REQUEST' }));
      } else if (action === 'disconnect') {
        run.processRef.connected = false;
        run.processRef.emit('disconnect');
      } else {
        run.controller.dispose();
      }
      await assert.rejects(pending, (error) => error.code === 'TEST_STARTUP_CANCELLED');
      assert.equal(run.clock.activeTimers(), 0);
      if (action !== 'dispose') run.controller.dispose();
    });
  }
});

test('slow synchronous dependency work does not consume the freshness deadline', async () => {
  const run = createRuntimeController();
  await run.controller.awaitBound();
  run.clock.advance(5_200);
  run.controller.checkLease();
  assert.equal(run.controller.isStopping(), false);

  const pending = run.controller.awaitStartupFreshness();
  const probe = run.processRef.sent.find((message) => message.type === 'RUNTIME_STARTUP_PROBE');
  run.processRef.emit('message', createControlMessage('LAUNCHER_STARTUP_CONFIRM', run.session,
    { nonce: probe.nonce }));
  assert.equal(await pending, true);
  assert.equal(run.controller.markReady(), true);
  run.controller.dispose();
});

test('runtime entry waits for binding before dependency load and loads exactly once', async () => {
  let resolveBound;
  const bound = new Promise((resolve) => { resolveBound = resolve; });
  const phases = [];
  let loads = 0;
  const pending = runRuntimeEntry({
    control: {
      bindShutdown() {},
      awaitBound: () => bound,
      assertRunning() {},
      requestStop: () => assert.fail('must not stop'),
    },
    diagnostics: {
      enterPhase: (phase) => phases.push(phase),
      reportFailure: () => assert.fail('must not fail'),
    },
    loadMain: () => { loads += 1; },
  });
  await immediate();
  assert.equal(loads, 0);
  assert.deepEqual(phases, []);
  resolveBound(true);
  assert.equal(await pending, true);
  assert.equal(loads, 1);
  assert.deepEqual(phases, ['DEPENDENCY_LOAD']);
});

test('the 5s bind watchdog fails before dependency load', async () => {
  const clock = createManualClock();
  const session = createSessionId();
  const processRef = new FakeProcess();
  const controller = createTestControlRuntimeController({
    env: { XIAOJI_RUNTIME_MODE: 'test-control', XIAOJI_TEST_CONTROL_SESSION: session },
    processRef,
    now: clock.now,
    setTimeoutFn: clock.setTimeoutFn,
    clearTimeoutFn: clock.clearTimeoutFn,
    setIntervalFn: () => 1,
    clearIntervalFn: () => {},
    bindMs: 5_000,
  });
  let loads = 0;
  const phases = [];
  const pending = runRuntimeEntry({
    control: controller,
    diagnostics: {
      enterPhase: (phase) => phases.push(phase),
      reportFailure() {},
    },
    loadMain: () => { loads += 1; },
    exit() {},
  });
  clock.advance(5_000);
  controller.checkLease();
  assert.equal(await pending, false);
  assert.equal(loads, 0);
  assert.deepEqual(phases, []);
  assert.equal(processRef.sent.find((message) => message.type === 'RUNTIME_STOP_ACK').reason,
    'LAUNCHER_LEASE_EXPIRED');
  controller.dispose();
});

test('launcher forwards exactly one live four-hop challenge and rejects stale alternatives', async () => {
  const ownerSession = createSessionId();
  const runtimeSession = createSessionId();
  const owner = new FakeProcess({ XIAOJI_TEST_OWNER_SESSION: ownerSession });
  const child = new FakeChild();
  const pending = superviseRuntime({
    child, ownerProcess: owner, ownerSession, runtimeSession, stderr: owner.stderr,
    startupTimeoutMs: 1_000, graceTimeoutMs: 100, forceConfirmMs: 100,
    sessionLimitMs: 2_000, leaseMs: 500, leaseIntervalMs: 20,
  });
  child.emit('message', createControlMessage('RUNTIME_HELLO', runtimeSession));
  child.emit('message', createControlMessage('RUNTIME_BOUND', runtimeSession));
  const nonce = '12'.repeat(16);
  child.emit('message', createControlMessage('RUNTIME_STARTUP_PROBE', runtimeSession, { nonce }));
  assert.deepEqual(owner.sent.filter((message) => message.type === 'LAUNCHER_STARTUP_PROBE')
    .map((message) => message.nonce), [nonce]);

  owner.emit('message', createControlMessage('OWNER_LEASE', ownerSession, { sequence: 99 }));
  owner.emit('message', createControlMessage('OWNER_STARTUP_CONFIRM', ownerSession,
    { nonce: '34'.repeat(16) }));
  assert.equal(child.sent.some((message) => message.type === 'LAUNCHER_STARTUP_CONFIRM'), false);

  owner.emit('message', createControlMessage('OWNER_STARTUP_CONFIRM', ownerSession, { nonce }));
  assert.deepEqual(child.sent.filter((message) => message.type === 'LAUNCHER_STARTUP_CONFIRM')
    .map((message) => message.nonce), [nonce]);
  child.emit('message', createControlMessage('RUNTIME_STARTUP_PROBE', runtimeSession,
    { nonce: '56'.repeat(16) }));
  owner.emit('message', createControlMessage('OWNER_STARTUP_CONFIRM', ownerSession, { nonce }));
  assert.equal(owner.sent.filter((message) => message.type === 'LAUNCHER_STARTUP_PROBE').length, 1);
  assert.equal(child.sent.filter((message) => message.type === 'LAUNCHER_STARTUP_CONFIRM').length, 1);

  child.emit('message', createControlMessage('RUNTIME_READY', runtimeSession));
  owner.emit('message', createControlMessage('OWNER_STOP', ownerSession, { reason: 'OWNER_REQUEST' }));
  child.emit('message', createControlMessage('RUNTIME_STOP_ACK', runtimeSession,
    { reason: 'OWNER_REQUEST' }));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  assert.equal((await pending).outcome, 'GRACEFUL');
});

test('live owner confirms a startup probe once and not after stopping', async () => {
  const processRef = new FakeProcess({ PATH: process.env.PATH });
  let session;
  const launcher = new FakeChild((message, child) => {
    session ||= message.session;
    if (message.type === 'OWNER_STOP') {
      child.emit('message', createControlMessage('RUNTIME_EXITED', session,
        { outcome: 'GRACEFUL', reason: message.reason }));
      setImmediate(() => child.emit('close', 0, null));
    }
  });
  const pending = runOwner({
    args: ['start'], processRef,
    spawnFn: () => launcher,
    startupTimeoutMs: 1_000, sessionLimitMs: 2_000, leaseIntervalMs: 20, exitConfirmMs: 200,
  });
  await immediate();
  launcher.emit('message', createControlMessage('LAUNCHER_BOUND', session));
  const nonce = '78'.repeat(16);
  launcher.emit('message', createControlMessage('LAUNCHER_STARTUP_PROBE', session, { nonce }));
  assert.deepEqual(launcher.sent.filter((message) => message.type === 'OWNER_STARTUP_CONFIRM')
    .map((message) => message.nonce), [nonce]);
  launcher.emit('message', createControlMessage('LAUNCHER_STARTUP_PROBE', session,
    { nonce: '9a'.repeat(16) }));
  processRef.stdin.write('STOP\n');
  launcher.emit('message', createControlMessage('LAUNCHER_STARTUP_PROBE', session,
    { nonce: 'bc'.repeat(16) }));
  assert.equal(launcher.sent.filter((message) => message.type === 'OWNER_STARTUP_CONFIRM').length, 1);
  assert.equal((await pending).outcome, 'GRACEFUL');
});

test('owner refuses freshness confirmation after session expiry or launcher disconnect', async (t) => {
  for (const condition of ['expired', 'disconnected']) {
    await t.test(condition, async () => {
      let current = 0;
      const processRef = new FakeProcess({ PATH: process.env.PATH });
      let session;
      const launcher = new FakeChild((message) => { session ||= message.session; });
      const pending = runOwner({
        args: ['start'], processRef, now: () => current,
        spawnFn: () => launcher,
        startupTimeoutMs: 1_000, sessionLimitMs: 2_000, leaseIntervalMs: 20, exitConfirmMs: 200,
      });
      await immediate();
      launcher.emit('message', createControlMessage('LAUNCHER_BOUND', session));
      if (condition === 'expired') current = 2_000;
      else launcher.connected = false;
      launcher.emit('message', createControlMessage('LAUNCHER_STARTUP_PROBE', session,
        { nonce: 'de'.repeat(16) }));
      assert.equal(launcher.sent.some((message) => message.type === 'OWNER_STARTUP_CONFIRM'), false);
      launcher.emit('close', 1, null);
      assert.equal((await pending).outcome, 'FAILED');
    });
  }
});

test('launcher refuses runtime probes after session expiry, stop, or owner disconnect', async (t) => {
  for (const condition of ['expired', 'stopping', 'disconnected']) {
    await t.test(condition, async () => {
      let current = 0;
      const ownerSession = createSessionId();
      const runtimeSession = createSessionId();
      const owner = new FakeProcess({ XIAOJI_TEST_OWNER_SESSION: ownerSession });
      const child = new FakeChild();
      const pending = superviseRuntime({
        child, ownerProcess: owner, ownerSession, runtimeSession, stderr: owner.stderr,
        now: () => current,
        startupTimeoutMs: 1_000, graceTimeoutMs: 100, forceConfirmMs: 100,
        sessionLimitMs: 2_000, leaseMs: 500, leaseIntervalMs: 20,
      });
      child.emit('message', createControlMessage('RUNTIME_HELLO', runtimeSession));
      child.emit('message', createControlMessage('RUNTIME_BOUND', runtimeSession));
      if (condition === 'expired') current = 2_000;
      if (condition === 'stopping') {
        owner.emit('message', createControlMessage('OWNER_STOP', ownerSession,
          { reason: 'OWNER_REQUEST' }));
      }
      if (condition === 'disconnected') {
        owner.connected = false;
        owner.emit('disconnect');
      }
      child.emit('message', createControlMessage('RUNTIME_STARTUP_PROBE', runtimeSession,
        { nonce: 'ef'.repeat(16) }));
      assert.equal(owner.sent.some((message) => message.type === 'LAUNCHER_STARTUP_PROBE'), false);
      if (condition === 'expired') {
        owner.emit('message', createControlMessage('OWNER_STOP', ownerSession,
          { reason: 'SESSION_EXPIRED' }));
      }
      child.emit('message', createControlMessage('RUNTIME_STOP_ACK', runtimeSession, {
        reason: condition === 'stopping' ? 'OWNER_REQUEST'
          : condition === 'disconnected' ? 'OWNER_DISCONNECTED' : 'SESSION_EXPIRED',
      }));
      child.emit('exit', 1, null);
      child.emit('close', 1, null);
      assert.equal((await pending).outcome, 'FAILED');
    });
  }
});

test('runtime-originated STOP_ACK preserves its first reason and cannot become graceful', async () => {
  const ownerSession = createSessionId();
  const runtimeSession = createSessionId();
  const owner = new FakeProcess({ XIAOJI_TEST_OWNER_SESSION: ownerSession });
  const child = new FakeChild();
  let stderr = '';
  owner.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const pending = superviseRuntime({
    child, ownerProcess: owner, ownerSession, runtimeSession, stderr: owner.stderr,
    startupTimeoutMs: 1_000, graceTimeoutMs: 100, forceConfirmMs: 100,
    sessionLimitMs: 2_000, leaseMs: 500, leaseIntervalMs: 20,
  });
  child.emit('message', createControlMessage('RUNTIME_HELLO', runtimeSession));
  child.emit('message', createControlMessage('RUNTIME_BOUND', runtimeSession));
  child.emit('message', createControlMessage('RUNTIME_STOP_ACK', runtimeSession,
    { reason: 'STARTUP_FRESHNESS_TIMEOUT' }));
  owner.emit('message', createControlMessage('OWNER_STOP', ownerSession, { reason: 'OWNER_REQUEST' }));
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
  const result = await pending;
  assert.equal(result.stopReason, 'STARTUP_FRESHNESS_TIMEOUT');
  assert.equal(result.stopAcknowledged, true);
  assert.equal(result.outcome, 'FAILED');
  assert.equal(stderr.includes('TEST_STOP_REQUESTED operation=launcher'), false);
});

test('runtime-originated STOP_ACK without exit still reaches forced unverified completion', async () => {
  const ownerSession = createSessionId();
  const runtimeSession = createSessionId();
  const owner = new FakeProcess({ XIAOJI_TEST_OWNER_SESSION: ownerSession });
  const child = new FakeChild();
  const pending = superviseRuntime({
    child, ownerProcess: owner, ownerSession, runtimeSession, stderr: owner.stderr,
    startupTimeoutMs: 1_000, graceTimeoutMs: 10, forceConfirmMs: 10,
    sessionLimitMs: 2_000, leaseMs: 500, leaseIntervalMs: 20,
  });
  child.emit('message', createControlMessage('RUNTIME_HELLO', runtimeSession));
  child.emit('message', createControlMessage('RUNTIME_BOUND', runtimeSession));
  child.emit('message', createControlMessage('RUNTIME_STOP_ACK', runtimeSession,
    { reason: 'STARTUP_FRESHNESS_TIMEOUT' }));
  const result = await pending;
  assert.equal(result.stopReason, 'STARTUP_FRESHNESS_TIMEOUT');
  assert.equal(result.outcome, 'UNVERIFIED');
  assert.equal(result.closed, false);
  assert.equal(child.killCalls, 1);
});
