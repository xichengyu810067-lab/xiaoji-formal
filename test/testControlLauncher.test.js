'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  buildChildEnvironment,
  initializeTestDataRoot,
  loadLaunchConfiguration,
  main,
  parseArgs,
} = require('../scripts/test-control');
const { IDS, writeTestRootMarker } = require('./testControlSupport');
const { makeRealTempDir, removeRealTempDir } = require('./support/realTempDir');

const projectRoot = path.join(__dirname, '..');

function trust() {
  return {
    expectedApplicationId: IDS.app,
    forbiddenApplicationIds: [IDS.formal],
    allowedGuildIds: [IDS.guild], allowedChannelIds: [IDS.channel], allowedActorIds: [IDS.actor],
    allowedCommands: ['ping'], allowedComponentPrefixes: [], allowedMessageFeatures: [],
    allowedEvents: [], allowedJobs: [], dataRoot: 'C:\\synthetic-test-data',
  };
}

test('clean child environment excludes parent application credentials and disables outbound defaults', () => {
  const env = buildChildEnvironment({
    parentEnv: { PATH: 'synthetic-path', OPENAI_API_KEY: 'parent-secret', DISCORD_TOKEN: 'parent-token', NODE_OPTIONS: '--require bad' },
    config: { DISCORD_TOKEN: 'test-token', DISCORD_CLIENT_ID: IDS.app, BOT_OWNER_ID: IDS.actor },
    trust: trust(),
  });
  assert.equal(env.PATH, 'synthetic-path');
  assert.equal(env.DISCORD_TOKEN, 'test-token');
  assert.equal(env.OPENAI_API_KEY, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.AUTO_DEPLOY_COMMANDS, 'false');
  assert.equal(env.XIAOJI_RELEASE_DISPATCH_ENABLED, 'false');
  assert.equal(env.STATUS_SNAPSHOT_PUBLISHER_URL, undefined);
});

test('test config cannot override independently trusted identity or scope', () => {
  assert.throws(() => buildChildEnvironment({
    parentEnv: {}, config: { XIAOJI_TEST_EXPECTED_APPLICATION_ID: IDS.formal }, trust: trust(),
  }), (error) => error.code === 'TEST_CONFIG_TRUST_COLLISION');
});

const PRODUCTION_LOOKING_FILES = Object.freeze([
  'xiaoji.sqlite', 'guildConfig.json', 'polls.json', 'reminders.json', 'owner-safety-side-effects-v1.json',
]);

function writeTrustFile(trustPath, dataRoot, overrides = {}) {
  fs.writeFileSync(trustPath, JSON.stringify({
    schemaVersion: 1,
    expectedApplicationId: IDS.app,
    forbiddenApplicationIds: [IDS.formal],
    allowedGuildIds: [IDS.guild],
    allowedChannelIds: [IDS.channel],
    allowedActorIds: [IDS.actor],
    allowedCommands: ['ping'],
    dataRoot,
    ...overrides,
  }));
}

// Simulates the .git entry of a main checkout (non-empty directory), a linked worktree
// (file), a junction named .git (pointing at an empty directory), or a lone empty .git
// directory, which Git does not treat as a repository.
function writeGitEntry(directory, kind) {
  const entry = path.join(directory, '.git');
  if (kind === 'checkout') {
    fs.mkdirSync(entry);
    fs.writeFileSync(path.join(entry, 'HEAD'), 'ref: refs/heads/main\n');
  } else if (kind === 'junction') {
    const target = path.join(directory, 'empty-git-target');
    fs.mkdirSync(target);
    fs.symlinkSync(target, entry, 'junction');
  } else if (kind === 'empty') {
    fs.mkdirSync(entry);
  } else {
    fs.writeFileSync(entry, 'gitdir: C:/synthetic/.git/worktrees/test\n');
  }
}

function createLaunchFiles({ marker = IDS.app, productionLooking = false, parentGit = null } = {}) {
  const parent = makeRealTempDir('xiaoji-test-control-launch-');
  const dataRoot = path.join(parent, 'test-data');
  fs.mkdirSync(dataRoot);
  const configPath = path.join(parent, 'launcher.env');
  const trustPath = path.join(parent, 'trust.json');
  fs.writeFileSync(configPath,
    `DISCORD_TOKEN=synthetic-token\nDISCORD_CLIENT_ID=${IDS.app}\nBOT_OWNER_ID=${IDS.actor}\n`);
  writeTrustFile(trustPath, dataRoot);
  if (productionLooking) {
    for (const name of PRODUCTION_LOOKING_FILES) fs.writeFileSync(path.join(dataRoot, name), 'production-like');
  }
  if (marker) writeTestRootMarker(dataRoot, marker);
  if (parentGit) writeGitEntry(parent, parentGit);
  return {
    parent,
    dataRoot,
    configPath,
    trustPath,
    markerPath: path.join(dataRoot, '.xiaoji-test-root.json'),
    cleanup() {
      removeRealTempDir(parent);
    },
  };
}

function snapshot(directory) {
  return fs.readdirSync(directory).sort().map((name) => {
    const filePath = path.join(directory, name);
    const stat = fs.lstatSync(filePath, { bigint: true });
    return [name, stat.isFile() ? fs.readFileSync(filePath, 'utf8') : 'non-file', String(stat.mtimeNs)];
  });
}

function fakeProcess() {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let stdoutText = '';
  stdout.on('data', (chunk) => { stdoutText += chunk.toString('utf8'); });
  return { env: { PATH: process.env.PATH }, stdout, stderr, exitCode: null, stdoutText: () => stdoutText };
}

function runActual(script, args, timeoutMs = 15_000) {
  const child = spawn(process.execPath, [path.join(projectRoot, 'scripts', script), ...args], {
    cwd: projectRoot,
    env: { PATH: process.env.PATH },
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('actual test-control process did not close'));
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

test('launcher start and deploy refuse an unmarked, foreign, production-looking, or in-checkout data root before any child', async () => {
  const scenarios = [
    [{ marker: null }, 'TEST_DATA_ROOT_MARKER_MISSING'],
    [{ marker: IDS.formal }, 'TEST_DATA_ROOT_MARKER_MISMATCH'],
    [{ marker: IDS.otherGuild }, 'TEST_DATA_ROOT_MARKER_MISMATCH'],
    [{ marker: null, productionLooking: true }, 'TEST_DATA_ROOT_MARKER_MISSING'],
    [{ parentGit: 'checkout' }, 'TEST_DATA_ROOT_IN_REPOSITORY'],
    [{ parentGit: 'worktree' }, 'TEST_DATA_ROOT_IN_REPOSITORY'],
    [{ parentGit: 'junction' }, 'TEST_DATA_ROOT_IN_REPOSITORY'],
  ];
  for (const [options, code] of scenarios) {
    const files = createLaunchFiles(options);
    try {
      const before = snapshot(files.dataRoot);
      for (const action of ['start', 'deploy']) {
        let runStartCalls = 0;
        let spawnCalls = 0;
        await assert.rejects(() => main([action, '--config', files.configPath, '--trust', files.trustPath], {
          processRef: fakeProcess(),
          runStart: async () => { runStartCalls += 1; return { outcome: 'GRACEFUL', stopReason: 'OWNER_REQUEST' }; },
          spawnSyncFn: () => { spawnCalls += 1; return { status: 0, error: null }; },
        }), (error) => error.code === code, `${action} ${code}`);
        assert.equal(runStartCalls, 0, action);
        assert.equal(spawnCalls, 0, action);
      }
      assert.deepEqual(snapshot(files.dataRoot), before);
    } finally { files.cleanup(); }
  }
});

test('launcher start and deploy hand the marked data root to their children', async () => {
  const files = createLaunchFiles();
  try {
    let startEnv = null;
    let deployEnv = null;
    const startProcess = fakeProcess();
    await main(['start', '--config', files.configPath, '--trust', files.trustPath], {
      processRef: startProcess,
      runStart: async ({ childEnv }) => {
        startEnv = childEnv;
        return { outcome: 'GRACEFUL', stopReason: 'OWNER_REQUEST' };
      },
    });
    assert.equal(startProcess.exitCode, 0);
    assert.equal(startEnv.XIAOJI_TEST_DATA_ROOT, files.dataRoot);
    assert.equal(startEnv.XIAOJI_TEST_EXPECTED_APPLICATION_ID, IDS.app);
    await main(['deploy', '--config', files.configPath, '--trust', files.trustPath], {
      processRef: fakeProcess(),
      spawnSyncFn: (executable, args, options) => {
        deployEnv = options.env;
        return { status: 0, error: null };
      },
    });
    assert.equal(deployEnv.XIAOJI_DATA_ROOT, files.dataRoot);
  } finally { files.cleanup(); }
});

test('config and trust independence compares exact bigint file identities', () => {
  const files = createLaunchFiles();
  try {
    const base = BigInt(Number(110901140826835620n));
    assert.equal(Number(base), Number(base + 1n), 'precondition: a Number identity would collide');
    const forgedStat = (identities) => (target) => {
      const stat = fs.statSync(target, { bigint: true });
      const forged = Object.create(stat);
      const ino = path.resolve(target) === path.resolve(files.configPath) ? identities.config : identities.trust;
      Object.defineProperties(forged, { dev: { value: 9n }, ino: { value: ino } });
      return forged;
    };
    const options = { configPath: files.configPath, trustPath: files.trustPath, parentEnv: {} };
    const loaded = loadLaunchConfiguration({ ...options, stat: forgedStat({ config: base, trust: base + 1n }) });
    assert.equal(loaded.trust.dataRoot, files.dataRoot);
    assert.throws(() => loadLaunchConfiguration({ ...options, stat: forgedStat({ config: base, trust: base }) }),
      (error) => error.code === 'TEST_TRUST_NOT_INDEPENDENT');
    assert.throws(() => loadLaunchConfiguration({ ...options, stat: (target) => fs.statSync(target) }),
      (error) => error.code === 'TEST_CONFIG_FILE_INVALID');

    const linkedConfig = path.join(files.parent, 'linked-trust.env');
    fs.linkSync(files.trustPath, linkedConfig);
    assert.throws(() => loadLaunchConfiguration({ configPath: linkedConfig, trustPath: files.trustPath, parentEnv: {} }),
      (error) => error.code === 'TEST_TRUST_NOT_INDEPENDENT');
    assert.equal(loadLaunchConfiguration(options).trust.expectedApplicationId, IDS.app);
  } finally { files.cleanup(); }
});

test('init-data-root accepts only a trust file argument', () => {
  assert.deepEqual(parseArgs(['init-data-root', '--trust', 'synthetic-trust.json']),
    { action: 'init-data-root', configPath: null, trustPath: 'synthetic-trust.json' });
  assert.throws(() => parseArgs(['init-data-root', '--trust', 'synthetic-trust.json', '--config', 'launcher.env']),
    (error) => error.code === 'TEST_LAUNCH_ARGUMENT_INVALID');
  assert.throws(() => parseArgs(['init-data-root']), (error) => error.code === 'TEST_LAUNCH_ARGUMENT_REQUIRED');
  assert.throws(() => parseArgs(['start', '--trust', 'synthetic-trust.json']),
    (error) => error.code === 'TEST_LAUNCH_ARGUMENT_REQUIRED');
});

test('init-data-root creates the marker in an empty directory, then the launcher accepts the root', async () => {
  const files = createLaunchFiles({ marker: null });
  try {
    const processRef = fakeProcess();
    const created = await main(['init-data-root', '--trust', files.trustPath], { processRef });
    assert.equal(created.code, 'TEST_DATA_ROOT_MARKER_CREATED');
    assert.equal(processRef.exitCode, 0);
    assert.equal(processRef.stdoutText(), '[TEST_CONTROL] code=TEST_DATA_ROOT_MARKER_CREATED operation=launcher\n');
    assert.deepEqual(fs.readdirSync(files.dataRoot), ['.xiaoji-test-root.json']);
    const rootStat = fs.lstatSync(files.dataRoot, { bigint: true });
    assert.deepEqual(JSON.parse(fs.readFileSync(files.markerPath, 'utf8')), {
      schemaVersion: 1,
      purpose: 'xiaoji-test-control-data-root',
      expectedApplicationId: IDS.app,
      dataRootIdentity: `${rootStat.dev}:${rootStat.ino}`,
    });

    const before = snapshot(files.dataRoot);
    const repeated = initializeTestDataRoot({ trustPath: files.trustPath, projectRoot });
    assert.equal(repeated.code, 'TEST_DATA_ROOT_MARKER_PRESENT');
    assert.deepEqual(snapshot(files.dataRoot), before);

    fs.writeFileSync(path.join(files.dataRoot, 'guildConfig.json'), '{}');
    let spawnCalls = 0;
    await main(['deploy', '--config', files.configPath, '--trust', files.trustPath], {
      processRef: fakeProcess(),
      spawnSyncFn: () => { spawnCalls += 1; return { status: 0, error: null }; },
    });
    assert.equal(spawnCalls, 1);
    const withData = snapshot(files.dataRoot);
    assert.throws(() => initializeTestDataRoot({ trustPath: files.trustPath, projectRoot }),
      (error) => error.code === 'TEST_DATA_ROOT_NOT_EMPTY');
    assert.deepEqual(snapshot(files.dataRoot), withData);
  } finally { files.cleanup(); }
});

test('init-data-root refuses production-looking, foreign-marked, in-project, missing, or linked roots without writing', () => {
  const production = createLaunchFiles({ marker: null, productionLooking: true });
  try {
    const before = snapshot(production.dataRoot);
    assert.throws(() => initializeTestDataRoot({ trustPath: production.trustPath, projectRoot }),
      (error) => error.code === 'TEST_DATA_ROOT_NOT_EMPTY');
    assert.deepEqual(snapshot(production.dataRoot), before);
    assert.equal(fs.existsSync(production.markerPath), false);
  } finally { production.cleanup(); }

  const foreign = createLaunchFiles({ marker: IDS.formal });
  try {
    const before = snapshot(foreign.dataRoot);
    assert.throws(() => initializeTestDataRoot({ trustPath: foreign.trustPath, projectRoot }),
      (error) => error.code === 'TEST_DATA_ROOT_MARKER_MISMATCH');
    assert.deepEqual(snapshot(foreign.dataRoot), before);
  } finally { foreign.cleanup(); }

  const local = createLaunchFiles({ marker: null });
  try {
    // A temporary directory stands in for the project so the real worktree is never written.
    assert.throws(() => initializeTestDataRoot({ trustPath: local.trustPath, projectRoot: local.parent }),
      (error) => error.code === 'TEST_DATA_ROOT_IN_WORKTREE');
    assert.throws(() => initializeTestDataRoot({
      trustPath: local.trustPath, projectRoot: path.join(local.dataRoot, 'project'),
    }), (error) => error.code === 'TEST_DATA_ROOT_IN_WORKTREE');
    assert.deepEqual(fs.readdirSync(local.dataRoot), []);

    for (const dataRoot of [path.join(local.parent, 'missing-data'), 'relative-test-data']) {
      writeTrustFile(local.trustPath, dataRoot);
      assert.throws(() => initializeTestDataRoot({ trustPath: local.trustPath, projectRoot }),
        (error) => error.code === 'TEST_DATA_ROOT_INVALID', dataRoot);
    }
    assert.equal(fs.existsSync(path.join(local.parent, 'missing-data')), false);

    if (process.platform === 'win32') {
      const linked = path.join(local.parent, 'linked-data');
      fs.symlinkSync(local.dataRoot, linked, 'junction');
      writeTrustFile(local.trustPath, linked);
      assert.throws(() => initializeTestDataRoot({ trustPath: local.trustPath, projectRoot }),
        (error) => error.code === 'TEST_DATA_ROOT_INVALID');
      assert.deepEqual(fs.readdirSync(local.dataRoot), []);
    }
  } finally { local.cleanup(); }
});

test('init-data-root checks for a forbidden expected application before touching the directory', () => {
  const files = createLaunchFiles({ marker: null });
  try {
    writeTrustFile(files.trustPath, files.dataRoot, { forbiddenApplicationIds: [IDS.formal, IDS.app] });
    assert.throws(() => initializeTestDataRoot({ trustPath: files.trustPath, projectRoot }),
      (error) => error.code === 'TEST_EXPECTED_APP_FORBIDDEN');
    assert.deepEqual(fs.readdirSync(files.dataRoot), []);
    // Checked first: even an unusable dataRoot reports the forbidden application.
    writeTrustFile(files.trustPath, path.join(files.parent, 'missing-data'),
      { forbiddenApplicationIds: [IDS.app] });
    assert.throws(() => initializeTestDataRoot({ trustPath: files.trustPath, projectRoot }),
      (error) => error.code === 'TEST_EXPECTED_APP_FORBIDDEN');
  } finally { files.cleanup(); }
});

test('an empty .git directory above the data root does not block launcher start or deploy', async () => {
  const files = createLaunchFiles({ parentGit: 'empty' });
  try {
    let startEnv = null;
    let spawnCalls = 0;
    await main(['start', '--config', files.configPath, '--trust', files.trustPath], {
      processRef: fakeProcess(),
      runStart: async ({ childEnv }) => {
        startEnv = childEnv;
        return { outcome: 'GRACEFUL', stopReason: 'OWNER_REQUEST' };
      },
    });
    await main(['deploy', '--config', files.configPath, '--trust', files.trustPath], {
      processRef: fakeProcess(),
      spawnSyncFn: () => { spawnCalls += 1; return { status: 0, error: null }; },
    });
    assert.equal(startEnv.XIAOJI_TEST_DATA_ROOT, files.dataRoot);
    assert.equal(spawnCalls, 1);
  } finally { files.cleanup(); }
});

test('an empty .git directory above the data root does not block init-data-root', () => {
  const files = createLaunchFiles({ marker: null, parentGit: 'empty' });
  try {
    assert.equal(initializeTestDataRoot({ trustPath: files.trustPath, projectRoot }).code,
      'TEST_DATA_ROOT_MARKER_CREATED');
    assert.deepEqual(fs.readdirSync(files.dataRoot), ['.xiaoji-test-root.json']);
  } finally { files.cleanup(); }
});

test('init-data-root refuses a data root inside a main checkout or a linked worktree without writing', () => {
  for (const kind of ['checkout', 'worktree', 'junction']) {
    const files = createLaunchFiles({ marker: null, parentGit: kind });
    try {
      assert.throws(() => initializeTestDataRoot({ trustPath: files.trustPath, projectRoot }),
        (error) => error.code === 'TEST_DATA_ROOT_IN_REPOSITORY', kind);
      assert.deepEqual(fs.readdirSync(files.dataRoot), []);
    } finally { files.cleanup(); }
  }

  const nested = createLaunchFiles({ marker: null });
  try {
    const repository = path.join(nested.parent, 'repository');
    const deepRoot = path.join(repository, 'runtime', 'test-data');
    fs.mkdirSync(deepRoot, { recursive: true });
    writeGitEntry(repository, 'checkout');
    writeTrustFile(nested.trustPath, deepRoot);
    assert.throws(() => initializeTestDataRoot({ trustPath: nested.trustPath, projectRoot }),
      (error) => error.code === 'TEST_DATA_ROOT_IN_REPOSITORY');
    assert.deepEqual(fs.readdirSync(deepRoot), []);
  } finally { nested.cleanup(); }
});

test('actual owner and launcher processes stop with a fixed code before the supervisor on an unmarked root', async () => {
  const files = createLaunchFiles({ marker: null, productionLooking: true });
  try {
    const before = snapshot(files.dataRoot);
    const owner = await runActual('test-control-owner.js',
      ['start', '--config', files.configPath, '--trust', files.trustPath]);
    assert.equal(owner.code, 1);
    assert.equal(owner.signal, null);
    assert.equal(owner.stdout, '');
    assert.equal(owner.stderr, '[TEST_CONTROL] code=TEST_DATA_ROOT_MARKER_MISSING operation=launcher\n');

    const deploy = await runActual('test-control.js',
      ['deploy', '--config', files.configPath, '--trust', files.trustPath]);
    assert.equal(deploy.code, 1);
    assert.equal(deploy.stdout, '');
    assert.equal(deploy.stderr, '[TEST_CONTROL] code=TEST_DATA_ROOT_MARKER_MISSING operation=launcher\n');

    writeTestRootMarker(files.dataRoot, IDS.formal);
    const mismatched = await runActual('test-control-owner.js',
      ['start', '--config', files.configPath, '--trust', files.trustPath]);
    assert.equal(mismatched.code, 1);
    assert.equal(mismatched.stderr, '[TEST_CONTROL] code=TEST_DATA_ROOT_MARKER_MISMATCH operation=launcher\n');
    fs.rmSync(files.markerPath);
    assert.deepEqual(snapshot(files.dataRoot), before);
  } finally { files.cleanup(); }
});
