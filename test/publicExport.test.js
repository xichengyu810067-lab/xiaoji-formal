const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cp = require('node:child_process');
const { assertAllowedPath, buildPublicExportPlan, exportPublicFiles } = require('../scripts/create-public-export');

const deploymentOnlyTests = [
  'test/admissionDataDeployment.test.js',
  'test/admissionDeploymentScripts.test.js',
  'test/nyankoTrustedBootstrap.test.js',
  'test/nyankoUpdateContract.test.js',
  'test/pterodactylLauncher.test.js',
  'test/pterodactylLifecycleRunner.test.js',
  'test/pm2StopGuard.test.js',
];
const projectRoot = path.join(__dirname, '..');

function deploymentOnlySourceCount(rootPath = projectRoot) {
  return deploymentOnlyTests.filter((relativePath) => fs.existsSync(path.join(rootPath, relativePath))).length;
}

function removeTemporaryDirectory(targetPath) {
  for (let attempt = 0; attempt <= 20; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true });
      return;
    } catch (error) {
      if (process.platform !== 'win32' || !['EBUSY', 'EPERM'].includes(error.code) || attempt === 20) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
    }
  }
}

test('repository public export plan is allowlisted and excludes protected roots', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(projectRoot, 'public-export', 'manifest.json'), 'utf8'));
  const files = buildPublicExportPlan();
  assert.ok(files.includes('src/index.js'));
  assert.ok(files.includes('src/platform/startupSequence.js'));
  assert.ok(files.includes('src/games/discord/boardDiscordRuntime.js'));
  assert.ok(files.includes('src/systems/games/board/storage/boardSchema.js'));
  assert.ok(files.includes('src/systems/games/board/storage/sqliteBoardStore.js'));
  assert.ok(files.includes('src/systems/conversation/aiArchive.js'));
  assert.ok(files.includes('src/systems/games/soloDiscordRuntime.js'));
  assert.ok(files.includes('website/statusData.js'));
  assert.ok(files.includes('website/policies.html'));
  assert.ok(files.includes('website/siteSupport.js'));
  assert.ok(files.includes('website/support.css'));
  assert.deepEqual(
    files.filter((file) => file.startsWith('.github/workflows/')),
    ['.github/workflows/public-core.yml']
  );
  assert.equal(files.some((file) => /(^|\/)private\//.test(file)), false);
  assert.equal(files.some((file) => /(^|\/)(?:data|logs)\//.test(file)), false);
  assert.deepEqual(files.filter((file) => file.startsWith('deploy/')), []);
  assert.equal(files.includes('scripts/admission-data-preflight.js'), false);
  assert.equal(files.includes('scripts/guarded-release-switch.sh'), false);
  assert.equal(files.includes('scripts/nyanko-guarded-src-update.sh'), false);
  assert.equal(files.includes('scripts/nyanko-trusted-bootstrap.js'), false);
  assert.equal(files.includes('scripts/nyanko-update-contract.js'), false);
  assert.equal(files.includes('scripts/nyanko-update-candidate-manifest.json'), false);
  assert.equal(files.includes('scripts/pterodactyl-lifecycle-runner.js'), false);
  assert.equal(files.includes('xdeploy.js'), false);
  assert.equal(files.includes('scripts/pm2-stop-guard.sh'), false);
  assert.deepEqual(manifest.excludePaths, deploymentOnlyTests);
  const sourceCount = deploymentOnlySourceCount();
  assert.ok(
    sourceCount === 0 || sourceCount === deploymentOnlyTests.length,
    'Deployment-only test sources must be either complete in the repository or completely absent from a public export.'
  );
  for (const deploymentTest of deploymentOnlyTests) {
    if (sourceCount === deploymentOnlyTests.length) {
      assert.equal(fs.statSync(path.join(projectRoot, deploymentTest)).isFile(), true);
    }
    assert.equal(files.includes(deploymentTest), false);
  }
  assert.equal(files.some((file) => /(^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example'), false);
});

test('clean public export npm test passes without deployment-only tools', {
  skip: deploymentOnlySourceCount() === 0,
}, () => {
  const outputPath = fs.mkdtempSync(path.join(projectRoot, '.public-export-npm-test-'));
  fs.rmSync(outputPath, { recursive: true, force: true });
  try {
    exportPublicFiles({ sourceRoot: projectRoot, outputPath });
    const program = process.platform === 'win32' ? process.env.ComSpec : 'npm';
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'npm.cmd test'] : ['test'];
    const childEnv = { ...process.env };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = cp.spawnSync(program, args, {
      cwd: outputPath,
      encoding: 'utf8',
      env: childEnv,
      maxBuffer: 16 * 1024 * 1024,
    });
    assert.equal(
      result.status,
      0,
      `Public export npm test failed.\n${result.error?.message || ''}\n${(result.stdout || '').slice(-4000)}\n${(result.stderr || '').slice(-4000)}`
    );
  } finally {
    removeTemporaryDirectory(outputPath);
  }
});

test('actual public export can load board commands and runtime dependencies', () => {
  const projectRoot = path.join(__dirname, '..');
  const outputPath = fs.mkdtempSync(path.join(projectRoot, '.public-export-test-'));
  fs.rmSync(outputPath, { recursive: true, force: true });
  try {
    exportPublicFiles({ sourceRoot: projectRoot, outputPath });
    const { loadCommands } = require(path.join(outputPath, 'src', 'loadCommands.js'));
    const commands = loadCommands(path.join(outputPath, 'src', 'commands'), {
      extensionHost: { getCommandDirectories: () => [] },
    });
    assert.ok(commands.has('board'));

    const runtimeModule = require(path.join(outputPath, 'src', 'games', 'discord', 'boardDiscordRuntime.js'));
    assert.equal(typeof runtimeModule.createBoardDiscordRuntime, 'function');

    const packageJson = JSON.parse(fs.readFileSync(path.join(outputPath, 'package.json'), 'utf8'));
    assert.equal(packageJson.version, '1.1.0');
    for (const scriptName of [
      'smoke:login',
      'prod:check',
      'pm2:start',
      'pm2:restart',
      'pm2:status',
      'pm2:logs',
      'admission:init',
      'admission:before-update',
      'admission:after-update',
    ]) {
      assert.equal(packageJson.scripts[scriptName], undefined);
    }
  } finally {
    fs.rmSync(outputPath, { recursive: true, force: true });
  }
});

test('public export rejects protected paths and synthetic secret canaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-public-export-'));
  try {
    const canary = ['SYNTHETIC', 'SECRET', 'CANARY'].join('_');
    fs.writeFileSync(path.join(root, 'safe.txt'), `${canary}=do-not-copy\n`);
    assert.throws(
      () => exportPublicFiles({ sourceRoot: root, manifest: { version: 1, paths: ['safe.txt'] }, dryRun: true }),
      /sensitive content/
    );
    assert.throws(
      () => buildPublicExportPlan({ sourceRoot: root, manifest: { version: 1, paths: ['data'] } }),
      /protected path/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('public export exclusions are exact files and remain safe after exclusion', () => {
  const sourceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-public-export-excludes-'));
  try {
    fs.mkdirSync(path.join(sourceRoot, 'test'));
    fs.writeFileSync(path.join(sourceRoot, 'test', 'public.test.js'), 'module.exports = true;\n');
    fs.writeFileSync(path.join(sourceRoot, 'test', 'deployment.test.js'), 'module.exports = true;\n');
    assert.deepEqual(buildPublicExportPlan({
      sourceRoot,
      manifest: {
        version: 1,
        paths: ['test'],
        excludePaths: ['test/deployment.test.js'],
      },
    }), ['test/public.test.js']);
    assert.deepEqual(buildPublicExportPlan({
      sourceRoot,
      manifest: {
        version: 1,
        paths: ['test'],
        excludePaths: ['test/missing.test.js'],
      },
    }), ['test/deployment.test.js', 'test/public.test.js']);
    assert.throws(() => buildPublicExportPlan({
      sourceRoot,
      manifest: {
        version: 1,
        paths: ['test'],
        excludePaths: ['test'],
      },
    }), /exclusion may name only a file/);
  } finally {
    fs.rmSync(sourceRoot, { recursive: true, force: true });
  }
});

test('board storage export exception permits source only and rejects database artifacts', () => {
  assert.equal(assertAllowedPath('src/games/storage/boardSchema.js'), 'src/games/storage/boardSchema.js');
  assert.equal(assertAllowedPath('src/systems/games/board/storage/boardSchema.js'), 'src/systems/games/board/storage/boardSchema.js');
  assert.equal(assertAllowedPath('src/systems/games/board/storage/sqliteBoardStore.js'), 'src/systems/games/board/storage/sqliteBoardStore.js');
  assert.throws(() => assertAllowedPath('src/systems/games/board/storage/unlisted.js'));
  for (const artifact of ['session.db', 'session.sqlite', 'session.sqlite-wal', 'snapshot.json']) {
    assert.throws(
      () => assertAllowedPath(`src/games/storage/${artifact}`),
      /protected path/
    );
  }
});

test('public export rejects deployment and private runtime paths', () => {
  for (const rejected of [
    'deploy/internal/.dockerignore',
    'deploy/internal/application.yml',
    'deploy/internal/runtime.env',
    'deploy/internal/plugins/private.jar',
    'deploy/production.json',
    'private/internal/index.js',
  ]) {
    assert.throws(() => assertAllowedPath(rejected), /protected path/);
  }
});
