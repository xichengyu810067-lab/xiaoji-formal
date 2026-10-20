'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  buildTestDeploymentPlan,
  deployCommands,
  parseDeploymentArgs,
  shouldAutoDeployCommands,
} = require('../deploy-commands');
const { loadTestControlPolicy, serializeTestDataRootMarker } = require('../src/platform/testControlPolicy');
const { IDS, createFixture, writeTestRootMarker } = require('./testControlSupport');

const projectRoot = path.join(__dirname, '..');

test('test deployment contains only trusted guild routes and allowed command names', () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const plan = buildTestDeploymentPlan({ policy, publicCommands: [{ name: 'ping' }, { name: 'work' }] });
    assert.equal(plan.length, 1);
    assert.equal(plan[0].kind, 'test-guild');
    assert.equal(plan[0].guildId, IDS.guild);
    assert.deepEqual(plan[0].body, [{ name: 'ping' }]);
    assert.equal(plan[0].route.includes(`/applications/${IDS.app}/guilds/${IDS.guild}/commands`), true);
    assert.equal(plan[0].route.endsWith(`/applications/${IDS.app}/commands`), false);
  } finally { fixture.cleanup(); }
});

test('auto deploy remains available in production but is forced off in test-control', () => {
  assert.equal(shouldAutoDeployCommands({ AUTO_DEPLOY_COMMANDS: 'true' }), true);
  assert.equal(shouldAutoDeployCommands({ XIAOJI_RUNTIME_MODE: 'test-control', AUTO_DEPLOY_COMMANDS: 'true' }), false);
});

test('test deployment requires both the explicit action and trusted policy', async () => {
  assert.deepEqual(parseDeploymentArgs(['--test-control']), { publicOnly: false, testControl: true });
  await assert.rejects(
    deployCommands({ clientId: IDS.app, dryRun: true, testControl: true, testControlPolicy: null, protectedGuildIds: null }),
    /trusted launcher/,
  );

  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    await assert.rejects(
      deployCommands({ clientId: IDS.app, dryRun: true, testControlPolicy: policy, protectedGuildIds: null }),
      /explicit test-control action/,
    );
  } finally { fixture.cleanup(); }
});

test('deploy child process refuses an unmarked, foreign, copied, or in-checkout test data root before any Discord request', () => {
  const fixture = createFixture();
  try {
    // Without a token, even a missed data-root check could not authenticate any request.
    const env = { ...fixture.env, PATH: process.env.PATH };
    delete env.DISCORD_TOKEN;
    const runDeploy = () => spawnSync(process.execPath, [path.join(projectRoot, 'deploy-commands.js'), '--test-control'], {
      cwd: projectRoot, env, encoding: 'utf8', shell: false, timeout: 60_000,
    });
    fs.rmSync(fixture.markerPath);
    const missing = runDeploy();
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, '');
    assert.equal(missing.stderr, '[TEST_CONTROL] code=TEST_DATA_ROOT_MARKER_MISSING\n');

    writeTestRootMarker(fixture.root, IDS.formal);
    const foreign = runDeploy();
    assert.equal(foreign.status, 1);
    assert.equal(foreign.stderr, '[TEST_CONTROL] code=TEST_DATA_ROOT_MARKER_MISMATCH\n');

    // A marker carried over from another directory (copy or restore) keeps its old identity.
    fs.writeFileSync(fixture.markerPath, serializeTestDataRootMarker(IDS.app, '1:2'));
    const copied = runDeploy();
    assert.equal(copied.status, 1);
    assert.equal(copied.stdout, '');
    assert.equal(copied.stderr, '[TEST_CONTROL] code=TEST_DATA_ROOT_MARKER_IDENTITY_MISMATCH\n');

    writeTestRootMarker(fixture.root, IDS.app);
    fs.writeFileSync(path.join(fixture.parent, '.git'), 'gitdir: C:/synthetic/.git/worktrees/test\n');
    const inCheckout = runDeploy();
    assert.equal(inCheckout.status, 1);
    assert.equal(inCheckout.stdout, '');
    assert.equal(inCheckout.stderr, '[TEST_CONTROL] code=TEST_DATA_ROOT_IN_REPOSITORY\n');
  } finally { fixture.cleanup(); }
});
