'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  DiscordjsError,
  DiscordjsErrorCodes,
} = require('discord.js');
const { DiscordAPIError, HTTPError } = require('@discordjs/rest');
const { TestControlError } = require('../src/platform/testControlPolicy');
const { RuntimeControlError } = require('../src/platform/testControlRuntimeController');
const { runRuntimeEntry } = require('../src/platform/testControlRuntimeEntry');
const {
  PHASES,
  createTestControlStartupDiagnostics,
} = require('../src/platform/testControlStartupDiagnostics');

function createDiagnostics({ stopping = false, active = true } = {}) {
  const lines = [];
  const diagnostics = createTestControlStartupDiagnostics({
    active,
    isStopping: () => stopping,
    stderr: { write: (line) => lines.push(String(line).trim()) },
  });
  diagnostics.configureTrustedTypes({
    DiscordjsError,
    DiscordAPIError,
    HTTPError,
    tokenInvalidCode: DiscordjsErrorCodes.TokenInvalid,
  });
  return { diagnostics, lines, setStopping: (value) => { stopping = value; } };
}

function expectedLine(code) {
  return `[TEST_CONTROL] code=${code} operation=startup_diagnostic`;
}

test('startup phases are closed, monotonic, deduplicated, bounded, and sealed at ready', () => {
  const { diagnostics, lines } = createDiagnostics();
  for (const phase of PHASES) {
    assert.equal(diagnostics.enterPhase(phase), true);
    assert.equal(diagnostics.enterPhase(phase), false);
  }
  assert.equal(diagnostics.enterPhase('NOT_A_PHASE'), false);
  assert.equal(diagnostics.enterPhase('DEPENDENCY_LOAD'), false);
  diagnostics.markComplete();
  assert.equal(diagnostics.reportFailure(new Error('PRIVATE_CANARY')), null);
  assert.deepEqual(lines, PHASES.map((phase) => expectedLine(`TEST_STARTUP_PHASE_${phase}`)));
  assert.equal(lines.join('\n').includes('PRIVATE_CANARY'), false);
});

test('only trusted concrete error types and closed values receive specific classifications', () => {
  const cases = [
    [() => new TestControlError('TEST_APP_IDENTITY_MISMATCH'), 'TEST_APP_IDENTITY_MISMATCH'],
    [() => new TestControlError('TEST_OWNER_REQUIRED'), 'TEST_OWNER_REQUIRED'],
    [() => new TestControlError('TEST_LAUNCHER_REQUIRED'), 'TEST_LAUNCHER_REQUIRED'],
    [() => new TestControlError('TEST_OWNER_READY'), 'TEST_STARTUP_UNKNOWN'],
    [() => new RuntimeControlError(), 'TEST_STARTUP_CANCELLED'],
    [() => new DiscordjsError(DiscordjsErrorCodes.TokenInvalid), 'TEST_STARTUP_LOGIN_TOKEN_INVALID'],
    [() => Object.assign(new Error('hidden'), { code: 'MODULE_NOT_FOUND' }), 'TEST_STARTUP_DEPENDENCY_MISSING'],
  ];
  for (const [makeError, expected] of cases) {
    const { diagnostics, lines } = createDiagnostics();
    diagnostics.enterPhase('DEPENDENCY_LOAD');
    assert.equal(diagnostics.reportFailure(makeError()), expected);
    assert.equal(lines.at(-1), expectedLine(expected));
  }

  const { diagnostics, lines } = createDiagnostics();
  diagnostics.enterPhase('CONFIG_VALIDATE');
  assert.equal(diagnostics.reportFailure(Object.assign(new Error('hidden'), { code: 'MODULE_NOT_FOUND' })),
    'TEST_STARTUP_UNKNOWN');
  assert.equal(lines.at(-1), expectedLine('TEST_STARTUP_UNKNOWN'));
});

test('REST classifications use only installed SDK error types and fixed statuses', () => {
  const cases = [
    [401, 'TEST_STARTUP_REST_UNAUTHORIZED'],
    [403, 'TEST_STARTUP_REST_FORBIDDEN'],
    [404, 'TEST_STARTUP_REST_NOT_FOUND'],
    [429, 'TEST_STARTUP_REST_RATE_LIMITED'],
    [500, 'TEST_STARTUP_REST_SERVER_FAILED'],
    [599, 'TEST_STARTUP_REST_SERVER_FAILED'],
    [400, 'TEST_STARTUP_UNKNOWN'],
  ];
  for (const [status, expected] of cases) {
    for (const error of [
      new HTTPError(status, 'PRIVATE_CANARY', 'GET', 'https://private.invalid', { files: [], body: null }),
      new DiscordAPIError({ message: 'PRIVATE_CANARY' }, 999, status, 'GET',
        'https://private.invalid', { files: [], body: null }),
    ]) {
      const { diagnostics, lines } = createDiagnostics();
      diagnostics.enterPhase('IDENTITY_PREFLIGHT');
      assert.equal(diagnostics.reportFailure(error), expected);
      assert.equal(lines.at(-1), expectedLine(expected));
      assert.equal(lines.join('\n').includes('PRIVATE_CANARY'), false);
      assert.equal(lines.join('\n').includes('private.invalid'), false);
    }
  }

  const { diagnostics, lines } = createDiagnostics();
  diagnostics.enterPhase('IDENTITY_PREFLIGHT');
  diagnostics.reportFailure({ status: 401, code: 'TokenInvalid', message: 'PRIVATE_CANARY' });
  assert.equal(lines.at(-1), expectedLine('TEST_STARTUP_UNKNOWN'));
});

test('only a trusted SDK REST 401 can defer gateway classification to Client.login', () => {
  const { diagnostics } = createDiagnostics();
  const trusted = new HTTPError(401, 'PRIVATE_CANARY', 'GET', 'https://private.invalid',
    { files: [], body: null });
  assert.equal(diagnostics.isTrustedGatewayUnauthorized(trusted), true);
  assert.equal(diagnostics.isTrustedGatewayUnauthorized({ status: 401 }), false);
  assert.equal(diagnostics.isTrustedGatewayUnauthorized(new Proxy({}, {
    get() { throw new Error('PRIVATE_GETTER_CANARY'); },
    getPrototypeOf() { throw new Error('PRIVATE_PROTO_CANARY'); },
  })), false);
});

test('gateway closes use the six closed fatal codes and otherwise stay unknown', () => {
  const cases = [
    [4004, 'TEST_STARTUP_GATEWAY_AUTHENTICATION_FAILED'],
    [4010, 'TEST_STARTUP_GATEWAY_INVALID_SHARD'],
    [4011, 'TEST_STARTUP_GATEWAY_SHARDING_REQUIRED'],
    [4012, 'TEST_STARTUP_GATEWAY_INVALID_API_VERSION'],
    [4013, 'TEST_STARTUP_GATEWAY_INVALID_INTENTS'],
    [4014, 'TEST_STARTUP_GATEWAY_DISALLOWED_INTENTS'],
    [4999, 'TEST_STARTUP_UNKNOWN'],
  ];
  for (const [code, expected] of cases) {
    const { diagnostics, lines } = createDiagnostics();
    diagnostics.enterPhase('LOGIN_GATEWAY');
    assert.equal(diagnostics.recordGatewayClose({ code }), expected);
    assert.equal(lines.at(-1), expectedLine(expected));
  }
});

test('the first failure is immutable and a prior STOP turns later failure into cancellation', () => {
  const first = createDiagnostics();
  first.diagnostics.enterPhase('RUNTIME_PREFLIGHT');
  first.diagnostics.reportFailure(new TestControlError('TEST_DATA_PATH_INVALID'));
  first.setStopping(true);
  first.diagnostics.reportFailure(new DiscordjsError(DiscordjsErrorCodes.TokenInvalid));
  assert.equal(first.diagnostics.firstFailure(), 'TEST_DATA_PATH_INVALID');
  assert.equal(first.diagnostics.enterPhase('LOGIN_REST'), false);
  assert.equal(first.lines.filter((line) => line.includes('operation=startup_diagnostic')).length, 2);

  const stopped = createDiagnostics({ stopping: true });
  stopped.diagnostics.enterPhase('LOGIN_GATEWAY');
  stopped.diagnostics.reportFailure(new DiscordjsError(DiscordjsErrorCodes.TokenInvalid));
  assert.equal(stopped.diagnostics.firstFailure(), 'TEST_STARTUP_CANCELLED');
  assert.equal(stopped.lines.at(-1), expectedLine('TEST_STARTUP_CANCELLED'));
});

test('a late login continuation cannot roll READY_ENTRY back to READY_WAIT', () => {
  const { diagnostics, lines } = createDiagnostics();
  diagnostics.enterPhase('LOGIN_GATEWAY');
  diagnostics.enterPhase('READY_ENTRY');
  assert.equal(diagnostics.enterPhase('READY_WAIT'), false);
  assert.equal(diagnostics.currentPhase(), 'READY_ENTRY');
  assert.deepEqual(lines, [
    expectedLine('TEST_STARTUP_PHASE_LOGIN_GATEWAY'),
    expectedLine('TEST_STARTUP_PHASE_READY_ENTRY'),
  ]);
});

test('a phase callback resolving after STOP cannot advance startup state', () => {
  const state = createDiagnostics();
  state.diagnostics.enterPhase('LOGIN_REST');
  state.setStopping(true);
  assert.equal(state.diagnostics.enterPhase('LOGIN_GATEWAY'), false);
  assert.equal(state.diagnostics.currentPhase(), 'LOGIN_REST');
  assert.deepEqual(state.lines, [expectedLine('TEST_STARTUP_PHASE_LOGIN_REST')]);
});

test('malicious getters, proxies, strings, and error fields collapse to UNKNOWN without leaking', () => {
  const { diagnostics, lines } = createDiagnostics();
  diagnostics.enterPhase('CLIENT_SETUP');
  const hostile = new Proxy({}, {
    get() { throw new Error('PRIVATE_GETTER_CANARY'); },
    getPrototypeOf() { throw new Error('PRIVATE_PROTO_CANARY'); },
  });
  assert.equal(diagnostics.reportFailure(hostile), 'TEST_STARTUP_UNKNOWN');
  assert.equal(lines.at(-1), expectedLine('TEST_STARTUP_UNKNOWN'));
  for (const canary of ['PRIVATE_GETTER_CANARY', 'PRIVATE_PROTO_CANARY']) {
    assert.equal(lines.join('\n').includes(canary), false);
  }
});

test('runtime entry catches synchronous load failure, reports it, and requests nonzero shutdown', async () => {
  const { diagnostics, lines } = createDiagnostics();
  let shutdown = null;
  let stopReason = null;
  let exitCode = null;
  const control = {
    bindShutdown(handler) { shutdown = handler; },
    async awaitBound() { return true; },
    assertRunning() { return true; },
    requestStop(reason) { stopReason = reason; shutdown(reason); return true; },
  };
  const missing = Object.assign(new Error('C:/PRIVATE/PATH'), { code: 'MODULE_NOT_FOUND' });
  const result = await runRuntimeEntry({
    control,
    diagnostics,
    loadMain: () => { throw missing; },
    exit: (code) => { exitCode = code; },
  });
  assert.equal(result, false);
  assert.equal(stopReason, 'START_FAILED');
  assert.equal(exitCode, 1);
  assert.deepEqual(lines, [
    expectedLine('TEST_STARTUP_PHASE_DEPENDENCY_LOAD'),
    expectedLine('TEST_STARTUP_DEPENDENCY_MISSING'),
  ]);
  assert.equal(lines.join('\n').includes('PRIVATE'), false);
});

test('runtime entry reports a refused data root marker with its fixed code and stops nonzero', async () => {
  const { loadTestControlPolicy, serializeTestDataRootMarker } = require('../src/platform/testControlPolicy');
  const { IDS, createFixture, writeTestRootMarker } = require('./testControlSupport');
  const fs = require('node:fs');
  const path = require('node:path');
  const fixture = createFixture();
  try {
    const cases = [
      ['TEST_DATA_ROOT_MARKER_MISSING', () => fs.rmSync(fixture.markerPath)],
      ['TEST_DATA_ROOT_MARKER_MISMATCH', () => writeTestRootMarker(fixture.root, IDS.formal)],
      ['TEST_DATA_ROOT_MARKER_INVALID', () => fs.writeFileSync(fixture.markerPath, '{"schemaVersion":1}')],
      ['TEST_DATA_ROOT_MARKER_IDENTITY_MISMATCH',
        () => fs.writeFileSync(fixture.markerPath, serializeTestDataRootMarker(IDS.app, '1:2'))],
      // Checked before the marker, so it wins over the stale marker left by the previous case.
      ['TEST_DATA_ROOT_IN_REPOSITORY',
        () => fs.writeFileSync(path.join(fixture.parent, '.git'), 'gitdir: C:/synthetic/.git/worktrees/test\n')],
    ];
    for (const [code, prepare] of cases) {
      prepare();
      const { diagnostics, lines } = createDiagnostics();
      let stopReason = null;
      let exitCode = null;
      let shutdown = null;
      const result = await runRuntimeEntry({
        control: {
          bindShutdown(handler) { shutdown = handler; },
          async awaitBound() { return true; },
          assertRunning() { return true; },
          requestStop(reason) { stopReason = reason; shutdown(reason); return true; },
        },
        diagnostics,
        // The real main module loads the policy before any client, store, or login work.
        loadMain: () => loadTestControlPolicy(fixture.env, { cwd: process.cwd(), logger: { warn() {} } }),
        exit: (value) => { exitCode = value; },
      });
      assert.equal(result, false, code);
      assert.equal(stopReason, 'START_FAILED', code);
      assert.equal(exitCode, 1, code);
      assert.deepEqual(lines, [expectedLine('TEST_STARTUP_PHASE_DEPENDENCY_LOAD'), expectedLine(code)]);
    }
  } finally { fixture.cleanup(); }

  const { diagnostics, lines } = createDiagnostics();
  diagnostics.enterPhase('LOGIN_REST');
  diagnostics.reportFailure(new TestControlError('TEST_ROUTE_NORMALIZATION_DENIED'));
  assert.equal(lines.at(-1), expectedLine('TEST_ROUTE_NORMALIZATION_DENIED'));
});

test('production-disabled diagnostics emit nothing and do not affect a successful entry', async () => {
  const { diagnostics, lines } = createDiagnostics({ active: false });
  let loaded = 0;
  const result = await runRuntimeEntry({
    control: {
      bindShutdown() {},
      async awaitBound() { return true; },
      assertRunning() { return true; },
      requestStop: () => assert.fail('must not stop'),
    },
    diagnostics,
    loadMain: () => { loaded += 1; },
    exit: () => assert.fail('must not exit'),
  });
  assert.equal(result, true);
  assert.equal(loaded, 1);
  assert.deepEqual(lines, []);
});

test('startup diagnostic operation cannot carry owner or launcher authority codes', () => {
  const {
    parseSafeControlLine,
    safeControlLine,
    SAFE_CODES,
    STARTUP_DIAGNOSTIC_CODES,
  } = require('../src/platform/testControlProtocol');
  assert.deepEqual([...STARTUP_DIAGNOSTIC_CODES].filter((code) => !SAFE_CODES.has(code)), []);
  assert.equal(safeControlLine('TEST_OWNER_READY', 'startup_diagnostic'), null);
  assert.equal(safeControlLine('TEST_RUNTIME_EXITED_GRACEFUL', 'startup_diagnostic'), null);
  assert.equal(parseSafeControlLine(
    '[TEST_CONTROL] code=TEST_OWNER_READY operation=startup_diagnostic'), null);
  assert.equal(safeControlLine('TEST_STARTUP_UNKNOWN', 'startup_diagnostic'),
    expectedLine('TEST_STARTUP_UNKNOWN'));
});
