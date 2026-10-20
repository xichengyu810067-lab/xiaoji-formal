'use strict';

const assert = require('node:assert/strict');
const controller = require('../../src/platform/testControlRuntimeBootstrap');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const mode = String(process.env.XIAOJI_SYNTHETIC_MODE || 'ready');
let keepAlive = null;
let diagnosticSupport = null;
let syntheticCleanup = null;

function usesDiagnosticSupport(selectedMode) {
  return selectedMode.startsWith('diagnostic-') && selectedMode !== 'diagnostic-fail';
}

function getDiagnosticSupport() {
  if (diagnosticSupport) return diagnosticSupport;
  const { DiscordjsError, DiscordjsErrorCodes } = require('discord.js');
  const { HTTPError } = require('@discordjs/rest');
  const { createTestControlEgress } = require('../../src/platform/testControlEgress');
  const { TestControlError } = require('../../src/platform/testControlPolicy');
  const { safeControlLine } = require('../../src/platform/testControlProtocol');
  const {
    PHASES,
    getTestControlStartupDiagnostics,
  } = require('../../src/platform/testControlStartupDiagnostics');
  const startupDiagnostics = getTestControlStartupDiagnostics({
    active: controller.active,
    isStopping: () => controller.isStopping(),
  });
  startupDiagnostics.configureTrustedTypes({
    DiscordjsError,
    HTTPError,
    tokenInvalidCode: DiscordjsErrorCodes.TokenInvalid,
  });
  diagnosticSupport = {
    createTestControlEgress,
    DiscordjsError,
    DiscordjsErrorCodes,
    HTTPError,
    PHASES,
    safeControlLine,
    startupDiagnostics,
    TestControlError,
  };
  return diagnosticSupport;
}

function enterThrough(phase) {
  const { PHASES, startupDiagnostics } = getDiagnosticSupport();
  const target = PHASES.indexOf(phase);
  for (let index = 0; index <= target; index += 1) startupDiagnostics.enterPhase(PHASES[index]);
}

function failWith(error) {
  const { safeControlLine, startupDiagnostics } = getDiagnosticSupport();
  startupDiagnostics.reportFailure(error);
  console.error(safeControlLine('TEST_RUNTIME_START_FAILED', 'start'));
  return controller.requestStop('START_FAILED');
}

controller.bindShutdown(async (reason) => {
  if (mode === 'hang-on-stop') return new Promise(() => {});
  if (mode === 'diagnostic-hang-gateway' || mode === 'diagnostic-stop-then-error') {
    const { DiscordjsError, DiscordjsErrorCodes, startupDiagnostics } = getDiagnosticSupport();
    startupDiagnostics.reportFailure(new DiscordjsError(DiscordjsErrorCodes.TokenInvalid));
  }
  if (keepAlive) clearInterval(keepAlive);
  syntheticCleanup?.();
  controller.dispose();
  process.exit(reason === 'START_FAILED' ? 1 : 0);
});

async function runIdentityRoutePreflight({ boundAndFresh }) {
  const { Client, GatewayIntentBits, Routes } = require('discord.js');
  const { createFixture, IDS } = require('../testControlSupport');
  const { createTestControlEgress } = require('../../src/platform/testControlEgress');
  const {
    loadTestControlPolicy,
    preflightTestIdentity,
  } = require('../../src/platform/testControlPolicy');

  const fixture = createFixture();
  syntheticCleanup = fixture.cleanup;
  const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
  const client = new Client({ intents: [GatewayIntentBits.Guilds], rest: { retries: 0 } });
  const rest = client.rest;
  const expectedRoutes = new Map([
    ['APPLICATION_SELF', '/oauth2/applications/@me'],
    ['BOT_SELF', '/users/%40me'],
    ['TARGET_GUILD', `/guilds/${IDS.guild}`],
    ['TARGET_CHANNEL', `/channels/${IDS.channel}`],
  ]);
  const sourceRoutes = [
    ['APPLICATION_SELF', Routes.oauth2CurrentApplication()],
    ['BOT_SELF', Routes.user('@me')],
    ['TARGET_GUILD', Routes.guild(IDS.guild)],
    ['TARGET_CHANNEL', Routes.channel(IDS.channel)],
  ];
  const runtimeSourceMatchesReviewedCandidate = [
    ['../../src/index.js', 'src/index.js'],
    ['../../src/platform/testControlEgress.js', 'src/platform/testControlEgress.js'],
    ['../../src/platform/testControlPolicy.js', 'src/platform/testControlPolicy.js'],
  ].every(([request, relative]) => fs.realpathSync(require.resolve(request)) ===
    fs.realpathSync(path.join(__dirname, '..', '..', ...relative.split('/'))));
  const projectRoot = fs.realpathSync(path.join(__dirname, '..', '..'));
  const moduleRoot = `${fs.realpathSync(path.join(projectRoot, 'node_modules'))}${path.sep}`;
  const resolvedSdkMatchesExpected = [
    require.resolve('discord.js'),
    require.resolve('@discordjs/rest'),
    require.resolve('discord-api-types/v10'),
  ].every((resolved) => fs.realpathSync(resolved).startsWith(moduleRoot)) &&
    require(path.join(projectRoot, 'node_modules', 'discord.js', 'package.json')).version === '14.27.0' &&
    require(path.join(projectRoot, 'node_modules', '@discordjs', 'rest', 'package.json')).version === '2.6.3' &&
    require(path.join(projectRoot, 'node_modules', 'discord-api-types', 'package.json')).version === '0.38.54';
  const metadata = [];
  let requestIndex = 0;
  const response = (body) => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

  createTestControlEgress(policy, { isStopping: () => controller.isStopping() }).install(rest);
  rest.queueRequest = async (options) => {
    const [readStep = 'NONE', sourceRoute = ''] = sourceRoutes[requestIndex] || [];
    requestIndex += 1;
    metadata.push({
      readStep,
      sourceRouteMatchesExpected: sourceRoute === expectedRoutes.get(readStep),
      egressRouteMatchesExpected: options.fullRoute === expectedRoutes.get(readStep),
      methodIsGet: options.method === 'GET',
      sameRestInstance: client.rest === rest,
      runtimeSourceMatchesReviewedCandidate,
      resolvedSdkMatchesExpected,
      boundAndFresh,
    });
    if (readStep === 'TARGET_CHANNEL') return response({ id: IDS.channel, guild_id: IDS.guild });
    if (readStep === 'TARGET_GUILD') return response({ id: IDS.guild });
    return response({ id: IDS.app });
  };

  await preflightTestIdentity({ policy, rest, configuredClientId: IDS.app, Routes });
  metadata.push({
    readStep: 'NONE',
    sourceRouteMatchesExpected: true,
    egressRouteMatchesExpected: true,
    methodIsGet: true,
    sameRestInstance: client.rest === rest,
    runtimeSourceMatchesReviewedCandidate,
    resolvedSdkMatchesExpected,
    boundAndFresh,
  });
  assert.deepEqual(metadata.map((item) => item.readStep), [
    'APPLICATION_SELF', 'BOT_SELF', 'TARGET_GUILD', 'TARGET_CHANNEL', 'NONE',
  ]);
  for (const item of metadata) {
    assert.deepEqual(item, {
      readStep: item.readStep,
      sourceRouteMatchesExpected: true,
      egressRouteMatchesExpected: true,
      methodIsGet: true,
      sameRestInstance: true,
      runtimeSourceMatchesReviewedCandidate: true,
      resolvedSdkMatchesExpected: true,
      boundAndFresh: true,
    });
  }
}

async function main() {
  await controller.awaitBound();
  controller.assertRunning();
  if (usesDiagnosticSupport(mode)) {
    getDiagnosticSupport();
    controller.assertRunning();
  }
  if (mode === 'freshness-slow-load') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_200);
  }
  await controller.awaitStartupFreshness();
  controller.assertRunning();
  if (mode === 'identity-route-preflight') {
    await runIdentityRoutePreflight({ boundAndFresh: true });
    controller.markReady();
    keepAlive = setInterval(() => {}, 1_000);
    return;
  }
  if (mode.startsWith('diagnostic-phase-')) {
    const phase = mode.slice('diagnostic-phase-'.length).toUpperCase().replaceAll('-', '_');
    enterThrough(phase);
    console.error('SYNTHETIC_PHASE_PRIVATE_CANARY');
    return failWith(new Error('SYNTHETIC_ERROR_PRIVATE_CANARY'));
  }
  if (mode === 'diagnostic-token') {
    const { DiscordjsError, DiscordjsErrorCodes } = getDiagnosticSupport();
    enterThrough('LOGIN_REST');
    return failWith(new DiscordjsError(DiscordjsErrorCodes.TokenInvalid));
  }
  if (mode === 'diagnostic-rest-503') {
    const { createTestControlEgress, HTTPError, safeControlLine, startupDiagnostics } = getDiagnosticSupport();
    enterThrough('IDENTITY_PREFLIGHT');
    const policy = {
      reporter: { deny(code, operation) { console.error(safeControlLine(code, operation)); } },
      allowsActor: () => false,
      allowsChannel: () => false,
      allowsGuild: () => true,
      expectedApplicationId: '100000000000000001',
    };
    const rest = {
      async request() {
        throw new HTTPError(503, 'SYNTHETIC_REST_PRIVATE_CANARY', 'GET',
          'https://private.invalid', { files: [], body: null });
      },
    };
    createTestControlEgress(policy, { startupDiagnostics }).install(rest);
    try {
      await rest.request({ method: 'GET', fullRoute: '/guilds/100000000000000002' });
    } catch (error) {
      return failWith(error);
    }
  }
  if (mode === 'diagnostic-gateway-4014') {
    const { startupDiagnostics } = getDiagnosticSupport();
    enterThrough('LOGIN_GATEWAY');
    startupDiagnostics.recordGatewayClose({ code: 4014 });
    return failWith(new Error('SYNTHETIC_GATEWAY_PRIVATE_CANARY'));
  }
  if (mode === 'diagnostic-malicious') {
    enterThrough('CLIENT_SETUP');
    const hostile = new Proxy({}, {
      get() { throw new Error('SYNTHETIC_GETTER_PRIVATE_CANARY'); },
      getPrototypeOf() { throw new Error('SYNTHETIC_PROTO_PRIVATE_CANARY'); },
    });
    console.error('SYNTHETIC_STDERR_PRIVATE_CANARY');
    return failWith(hostile);
  }
  if (mode === 'diagnostic-ready-identity' || mode === 'diagnostic-ready-job') {
    const { TestControlError } = getDiagnosticSupport();
    enterThrough('READY_ENTRY');
    return failWith(new TestControlError(mode.endsWith('identity')
      ? 'TEST_READY_GUILD_MISMATCH' : 'TEST_JOB_NOT_REVIEWED'));
  }
  if (mode === 'diagnostic-unknown-get') {
    const { createTestControlEgress, safeControlLine, startupDiagnostics } = getDiagnosticSupport();
    enterThrough('LOGIN_REST');
    const policy = {
      reporter: { deny(code, operation) { console.error(safeControlLine(code, operation)); } },
      allowsActor: () => false,
      allowsChannel: () => false,
      allowsGuild: () => false,
      expectedApplicationId: '100000000000000001',
    };
    const egress = createTestControlEgress(policy, {
      captureStack: () => 'SYNTHETIC_STACK_PRIVATE_CANARY',
      startupDiagnostics,
    });
    egress.setDiagnosticPhase('login_wait_ready');
    try {
      egress.allowRequest({ method: 'GET', fullRoute: '/unknown/SYNTHETIC_ROUTE_PRIVATE_CANARY' });
    } catch (error) {
      return failWith(error);
    }
  }
  if (mode === 'diagnostic-failure-before-stop') {
    const { TestControlError } = getDiagnosticSupport();
    enterThrough('RUNTIME_PREFLIGHT');
    return failWith(new TestControlError('TEST_DATA_PATH_INVALID'));
  }
  if (mode === 'diagnostic-runtime-entry-sync') {
    const { startupDiagnostics } = getDiagnosticSupport();
    const { runRuntimeEntry } = require('../../src/platform/testControlRuntimeEntry');
    const missing = Object.assign(new Error('SYNTHETIC_MODULE_PRIVATE_CANARY'),
      { code: 'MODULE_NOT_FOUND' });
    return runRuntimeEntry({
      control: controller,
      diagnostics: startupDiagnostics,
      loadMain: () => { throw missing; },
    });
  }
  if (mode === 'diagnostic-hang-gateway') {
    enterThrough('LOGIN_GATEWAY');
    keepAlive = setInterval(() => {}, 1_000);
    return;
  }
  if (mode === 'diagnostic-stop-then-error') {
    enterThrough('READY_ENTRY');
    controller.markReady();
    keepAlive = setInterval(() => {}, 1_000);
    return;
  }
  if (mode === 'bootstrap-throw') throw new Error('synthetic bootstrap failure');
  if (mode === 'preflight-reject') return controller.requestStop('START_FAILED');
  if (mode === 'diagnostic-fail') {
    console.error('[synthetic-prefix] [TEST_CONTROL] ' +
      'code=TEST_EGRESS_GET_LOGIN_WAIT_READY_OTHER_UNKNOWN operation=discord_rest_diagnostic');
    console.error('SYNTHETIC_PRIVATE_DIAGNOSTIC_CANARY');
    console.error('[TEST_CONTROL] code=TEST_RUNTIME_START_FAILED operation=start');
    return controller.requestStop('START_FAILED');
  }
  if (mode === 'runtime-disconnect') {
    process.disconnect();
    return;
  }
  if (mode === 'fake-stdout-ready') {
    console.log('[TEST_CONTROL] code=TEST_OWNER_READY operation=owner');
    console.error('synthetic untrusted stderr');
    keepAlive = setInterval(() => {}, 1_000);
    return;
  }
  controller.markReady();
  keepAlive = setInterval(() => {}, 1_000);
}

async function runSyntheticLauncher(selectedMode) {
  const { runStartLauncher } = require('../../scripts/test-control-supervisor');
  const identityRoutePreflight = selectedMode === 'identity-route-preflight';
  const diagnosticSupportRequired = usesDiagnosticSupport(selectedMode);
  const result = await runStartLauncher({
    childEnv: {
      PATH: process.env.PATH,
      XIAOJI_RUNTIME_MODE: 'test-control',
      XIAOJI_SYNTHETIC_MODE: selectedMode,
    },
    projectRoot: path.join(__dirname, '..', '..'),
    ownerProcess: process,
    stderr: process.stderr,
    runtimeEntry: __filename,
    timeouts: {
      ownerBindTimeoutMs: 500,
      startupTimeoutMs: selectedMode === 'freshness-slow-load' ? 7_000
        : identityRoutePreflight || diagnosticSupportRequired ? 10_000
          : selectedMode.startsWith('diagnostic-') ? 3_000 : 400,
      graceTimeoutMs: 80,
      forceConfirmMs: 200,
      sessionLimitMs: selectedMode === 'freshness-slow-load' ? 8_000
        : identityRoutePreflight || diagnosticSupportRequired ? 15_000
          : selectedMode.startsWith('diagnostic-') ? 5_000 : 2_000,
      leaseMs: 500,
      leaseIntervalMs: 20,
    },
  });
  process.exitCode = result.outcome === 'GRACEFUL' && result.stopReason === 'OWNER_REQUEST' ? 0 : 1;
}

async function runSyntheticOwner(selectedMode) {
  const { runOwner } = require('../../scripts/test-control-owner');
  const identityRoutePreflight = selectedMode === 'identity-route-preflight';
  const diagnosticSupportRequired = usesDiagnosticSupport(selectedMode);
  const result = await runOwner({
    args: ['start', '--synthetic-mode', selectedMode],
    spawnFn(executable, args, options) {
      return spawn(executable, [__filename, 'launcher', selectedMode], options);
    },
    startupTimeoutMs: selectedMode === 'freshness-slow-load' ? 7_500
      : identityRoutePreflight || diagnosticSupportRequired ? 12_000
        : selectedMode.startsWith('diagnostic-') ? 4_500 : 1_000,
    sessionLimitMs: selectedMode === 'freshness-slow-load' ? 8_500
      : identityRoutePreflight || diagnosticSupportRequired ? 16_000
        : selectedMode.startsWith('diagnostic-') ? 6_000 : 3_000,
    leaseIntervalMs: 20,
    exitConfirmMs: 600,
  });
  return result;
}

const role = process.argv[2];
const selectedMode = String(process.argv[3] || 'ready');
const entry = role === 'launcher' ? runSyntheticLauncher(selectedMode)
  : role === 'owner' ? runSyntheticOwner(selectedMode) : main();
entry.catch(() => {
  if (role) process.exitCode = 1;
  else controller.requestStop('START_FAILED');
});
