const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { assertAllowedPath, buildPublicExportPlan, exportPublicFiles } = require('../scripts/create-public-export');

test('repository public export plan is allowlisted and excludes protected roots', () => {
  const files = buildPublicExportPlan();
  assert.ok(files.includes('src/index.js'));
  assert.ok(files.includes('src/games/discord/boardDiscordRuntime.js'));
  assert.ok(files.includes('deploy/lavalink/application.yml'));
  assert.ok(files.includes('deploy/lavalink/Dockerfile'));
  assert.ok(files.includes('deploy/lavalink/compose.yml'));
  assert.ok(files.includes('website/statusData.js'));
  assert.ok(files.includes('website/policies.html'));
  assert.ok(files.includes('website/siteSupport.js'));
  assert.ok(files.includes('website/support.css'));
  assert.equal(files.some((file) => /(^|\/)private\//.test(file)), false);
  assert.equal(files.some((file) => /(^|\/)(?:data|logs)\//.test(file)), false);
  assert.deepEqual(files.filter((file) => file.startsWith('deploy/')), [
    'deploy/lavalink/.dockerignore',
    'deploy/lavalink/Dockerfile',
    'deploy/lavalink/application.yml',
    'deploy/lavalink/compose.yml',
    'deploy/lavalink/lavalink.env.example',
  ]);
  assert.equal(files.some((file) => /(^|\/)\.env(?:\.|$)/.test(file) && file !== '.env.example'), false);
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
    for (const scriptName of ['smoke:login', 'prod:check', 'pm2:start', 'pm2:restart', 'pm2:status', 'pm2:logs']) {
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

test('board storage export exception permits source only and rejects database artifacts', () => {
  assert.equal(assertAllowedPath('src/games/storage/boardSchema.js'), 'src/games/storage/boardSchema.js');
  for (const artifact of ['session.db', 'session.sqlite', 'session.sqlite-wal', 'snapshot.json']) {
    assert.throws(
      () => assertAllowedPath(`src/games/storage/${artifact}`),
      /protected path/
    );
  }
});

test('Lavalink public export permits only reviewed template files', () => {
  for (const relativePath of [
    'deploy/lavalink/.dockerignore',
    'deploy/lavalink/application.yml',
    'deploy/lavalink/compose.yml',
    'deploy/lavalink/Dockerfile',
    'deploy/lavalink/lavalink.env.example',
  ]) {
    assert.equal(assertAllowedPath(relativePath), relativePath);
  }
  for (const rejected of [
    'deploy/lavalink/lavalink.env',
    'deploy/lavalink/plugins/private.jar',
    'deploy/production.json',
  ]) {
    assert.throws(() => assertAllowedPath(rejected), /protected path/);
  }
});
