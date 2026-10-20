'use strict';

const { TestControlError } = require('./testControlPolicy');

const SYNTHETIC_HARNESS_SYMBOL = Symbol.for('xiaoji.liveTestSyntheticHarness');

async function enterSyntheticHarness(client, policy, runtimeControl) {
  const harness = globalThis[SYNTHETIC_HARNESS_SYMBOL];
  if (harness === undefined) return false;
  if (!harness || harness.active !== true || harness.dataRoot !== policy.dataRoot ||
      harness.expectedApplicationId !== policy.expectedApplicationId || typeof harness.onReady !== 'function') {
    throw new TestControlError('TEST_LIVE_HARNESS_INVALID');
  }
  await harness.onReady({ client, policy, runtimeControl });
  return true;
}

async function runAllowedTestJobs(policy, registry = {}, { assertRunning = () => true } = {}) {
  const requested = [...policy.allowedJobs];
  for (const name of requested) {
    if (typeof registry[name] !== 'function') throw new TestControlError('TEST_JOB_NOT_REVIEWED');
  }
  for (const name of requested) {
    assertRunning();
    await registry[name]();
    assertRunning();
  }
  return Object.freeze({ started: requested.length });
}

async function enterTestReady(client, policy, { jobs = {}, runtimeControl = null } = {}) {
  const assertRunning = () => runtimeControl?.assertRunning?.() ?? true;
  assertRunning();
  try {
    policy.assertReady(client);
    const inventory = client.testControlEgress?.enableInventory?.();
    inventory?.installGatewayObserver(client);
    inventory?.installExitSeal();
    await enterSyntheticHarness(client, policy, runtimeControl);
  } catch (error) {
    await client.destroy();
    throw error;
  }
  assertRunning();
  return runAllowedTestJobs(policy, jobs, { assertRunning });
}

module.exports = { enterSyntheticHarness, enterTestReady, runAllowedTestJobs };
