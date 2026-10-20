'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const readyEvent = require('../src/events/ready');
const { enterTestReady, runAllowedTestJobs } = require('../src/platform/testControlReady');
const { loadTestControlPolicy } = require('../src/platform/testControlPolicy');
const { IDS, createFixture } = require('./testControlSupport');

function readyClient(policy, userId = IDS.app) {
  return { testControlPolicy: policy, user: { id: userId }, application: { id: userId },
    guilds: { cache: new Map([[IDS.guild, {}]]) }, destroyCalls: 0,
    async destroy() { this.destroyCalls += 1; } };
}

test('default test ready starts zero jobs and wrong ready identity destroys before jobs', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    let jobCalls = 0;
    assert.deepEqual(await enterTestReady(readyClient(policy), policy, { jobs: { unsafe: () => { jobCalls += 1; } } }), { started: 0 });
    assert.equal(jobCalls, 0);
    const wrong = readyClient(policy, IDS.formal);
    await assert.rejects(() => enterTestReady(wrong, policy, { jobs: { unsafe: () => { jobCalls += 1; } } }),
      (error) => error.code === 'TEST_FORMAL_APP_FORBIDDEN');
    assert.equal(wrong.destroyCalls, 1);
    assert.equal(jobCalls, 0);
  } finally { fixture.cleanup(); }
});

test('only explicitly named reviewed jobs can run', async () => {
  const fixture = createFixture({ XIAOJI_TEST_ALLOWED_JOBS: 'reviewed' });
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    let calls = 0;
    assert.deepEqual(await runAllowedTestJobs(policy, { reviewed: async () => { calls += 1; } }), { started: 1 });
    assert.equal(calls, 1);
    await assert.rejects(() => runAllowedTestJobs(policy, {}), (error) => error.code === 'TEST_JOB_NOT_REVIEWED');
  } finally { fixture.cleanup(); }
});

test('test ready starts the inventory only after identity verification', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const calls = [];
    const client = readyClient(policy);
    client.testControlEgress = {
      enableInventory() {
        calls.push('enabled');
        return {
          installGatewayObserver(target) { calls.push(target === client ? 'observer' : 'wrong-client'); },
          installExitSeal() { calls.push('exit-seal'); },
        };
      },
    };
    await enterTestReady(client, policy);
    assert.deepEqual(calls, ['enabled', 'observer', 'exit-seal']);

    const wrong = readyClient(policy, IDS.formal);
    wrong.testControlEgress = { enableInventory: () => assert.fail('must not enable before identity verification') };
    await assert.rejects(() => enterTestReady(wrong, policy), (error) => error.code === 'TEST_FORMAL_APP_FORBIDDEN');
  } finally { fixture.cleanup(); }
});

test('test ready invokes only a matching preloaded synthetic harness after inventory observation attaches', async () => {
  const fixture = createFixture();
  const symbol = Symbol.for('xiaoji.liveTestSyntheticHarness');
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const client = readyClient(policy);
    const calls = [];
    client.testControlEgress = { enableInventory: () => ({
      installGatewayObserver: () => calls.push('observer'), installExitSeal: () => calls.push('seal'),
    }) };
    globalThis[symbol] = Object.freeze({ active: true, dataRoot: policy.dataRoot,
      expectedApplicationId: policy.expectedApplicationId,
      onReady: async ({ client: target, policy: targetPolicy }) => calls.push(target === client && targetPolicy === policy ? 'harness' : 'wrong'),
    });
    await enterTestReady(client, policy, { runtimeControl: { active: true, assertRunning() {} } });
    assert.deepEqual(calls, ['observer', 'seal', 'harness']);
  } finally {
    delete globalThis[symbol];
    fixture.cleanup();
  }
});

test('public ready callback enters the fixed ready diagnostic phase before acceptance', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const client = readyClient(policy);
    const phases = [];
    const failures = [];
    const control = { checks: 0, ready: 0,
      assertRunning() { this.checks += 1; }, markReady() { this.ready += 1; } };
    client.testControlEgress = { setDiagnosticPhase: (phase) => phases.push(phase) };
    client.testControlStartupDiagnostics = {
      enterPhase: (phase) => phases.push(phase),
      markComplete: () => phases.push('complete'),
      reportFailure: (error) => failures.push(error),
    };
    client.testControlRuntimeController = control;
    await readyEvent.execute(client);
    assert.deepEqual(phases, ['READY_ENTRY', 'ready_entry', 'complete']);
    assert.deepEqual(failures, []);
    assert.equal(control.ready, 1);
    assert.equal(control.checks >= 3, true);
  } finally { fixture.cleanup(); }
});

test('ready identity and unreviewed job failures are reported in READY_ENTRY before rejection', async () => {
  for (const allowedJobs of ['', 'not_reviewed']) {
    const fixture = createFixture({ XIAOJI_TEST_ALLOWED_JOBS: allowedJobs });
    try {
      const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
      const client = readyClient(policy, allowedJobs ? IDS.app : IDS.formal);
      const phases = [];
      const failures = [];
      client.testControlEgress = { setDiagnosticPhase: (phase) => phases.push(phase) };
      client.testControlStartupDiagnostics = {
        enterPhase: (phase) => phases.push(phase),
        markComplete: () => assert.fail('must not complete'),
        reportFailure: (error) => failures.push(error.code),
      };
      client.testControlRuntimeController = { assertRunning() {}, markReady: () => assert.fail('must not ready') };
      await assert.rejects(() => readyEvent.execute(client));
      assert.deepEqual(phases, ['READY_ENTRY', 'ready_entry']);
      assert.deepEqual(failures, [allowedJobs ? 'TEST_JOB_NOT_REVIEWED' : 'TEST_FORMAL_APP_FORBIDDEN']);
    } finally { fixture.cleanup(); }
  }
});
