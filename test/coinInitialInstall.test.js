const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { exportPublicFiles } = require('../scripts/create-public-export');

test('public initial install creates only the explicitly selected coin database once', () => {
  const temporaryDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-public-init-')));
  const exportRoot = path.join(temporaryDirectory, 'public');
  const coinPath = path.join(temporaryDirectory, 'runtime', 'coins.sqlite');
  assert.equal(path.dirname(temporaryDirectory), fs.realpathSync(os.tmpdir()));
  try {
    const files = exportPublicFiles({ outputPath: exportRoot }).files;
    assert.equal(files.includes('scripts/init-coin-db.js'), true);
    const env = {
      ...process.env,
      COIN_DB_PATH: coinPath,
      NODE_PATH: [path.join(__dirname, '..', 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter),
    };
    const run = (requestedPath) => spawnSync(process.execPath, ['scripts/init-coin-db.js', requestedPath], {
      cwd: exportRoot, env, encoding: 'utf8',
    });
    const first = run(coinPath);
    assert.equal(first.status, 0, first.stderr);
    assert.equal(fs.statSync(coinPath).isFile(), true);
    const originalHash = crypto.createHash('sha256').update(fs.readFileSync(coinPath)).digest('hex');
    const second = run(coinPath);
    assert.notEqual(second.status, 0);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(coinPath)).digest('hex'), originalHash);
    const otherPath = path.join(temporaryDirectory, 'runtime', 'other.sqlite');
    const mismatch = run(otherPath);
    assert.notEqual(mismatch.status, 0);
    assert.equal(fs.existsSync(otherPath), false);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('public initial install creates four JSON authorities once and preserves partial data', () => {
  const temporaryDirectory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-public-json-init-')));
  const exportRoot = path.join(temporaryDirectory, 'public');
  const auditPath = path.join(temporaryDirectory, 'protected', 'audit.json');
  const whitelistPath = path.join(temporaryDirectory, 'protected', 'whitelist.json');
  const dataRoot = path.join(temporaryDirectory, 'protected', 'personal');
  try {
    const files = exportPublicFiles({ outputPath: exportRoot }).files;
    assert.equal(files.includes('scripts/init-public-data.js'), true);
    fs.mkdirSync(dataRoot, { recursive: true });
    const env = {
      ...process.env,
      NODE_PATH: [path.join(__dirname, '..', 'node_modules'), process.env.NODE_PATH || ''].filter(Boolean).join(path.delimiter),
      XIAOJI_AUDIT_DATA_PATH: auditPath,
      XIAOJI_INVITER_WHITELIST_PATH: whitelistPath,
      XIAOJI_DATA_ROOT: dataRoot,
      COIN_DB_PATH: path.join(temporaryDirectory, 'protected', 'coins.sqlite'),
    };
    const run = (override = {}) => spawnSync(process.execPath, ['scripts/init-public-data.js'], {
      cwd: exportRoot, env: { ...env, ...override }, encoding: 'utf8',
    });
    const filesToCheck = [
      auditPath, whitelistPath,
      path.join(dataRoot, 'reminders.json'),
      path.join(dataRoot, 'calendarEvents.json'),
    ];
    const unsafe = run({ XIAOJI_AUDIT_DATA_PATH: path.join(exportRoot, 'audit.json') });
    assert.notEqual(unsafe.status, 0);
    assert.equal(fs.existsSync(path.join(exportRoot, 'audit.json')), false);
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const reminderDigest = first.stdout.match(/XIAOJI_REMINDERS_PROVENANCE_SHA256=([a-f0-9]{64})/)?.[1];
    const calendarDigest = first.stdout.match(/XIAOJI_CALENDAR_PROVENANCE_SHA256=([a-f0-9]{64})/)?.[1];
    assert.ok(reminderDigest);
    assert.ok(calendarDigest);
    assert.deepEqual(filesToCheck.map((filePath) => JSON.parse(fs.readFileSync(filePath, 'utf8'))), [{}, [], {}, {}]);
    const verify = spawnSync(process.execPath, ['-e',
      "const {resolvePersonalDataPath}=require('./src/platform/personalDataPaths'); for (const kind of ['reminders','calendar']) resolvePersonalDataPath(kind);"], {
      cwd: exportRoot, env: { ...env, XIAOJI_REMINDERS_PROVENANCE_SHA256: reminderDigest,
        XIAOJI_CALENDAR_PROVENANCE_SHA256: calendarDigest }, encoding: 'utf8',
    });
    assert.equal(verify.status, 0, verify.stderr);
    const coinInit = spawnSync(process.execPath, ['scripts/init-coin-db.js', env.COIN_DB_PATH], {
      cwd: exportRoot, env, encoding: 'utf8',
    });
    assert.equal(coinInit.status, 0, coinInit.stderr);
    const preflight = spawnSync(process.execPath, ['-e',
      "require('./src/platform/runtimeDataPreflight').preflightRuntimeData().catch(e=>{console.error(e.message);process.exitCode=1})"], {
      cwd: exportRoot, env: { ...env, XIAOJI_REMINDERS_PROVENANCE_SHA256: reminderDigest,
        XIAOJI_CALENDAR_PROVENANCE_SHA256: calendarDigest }, encoding: 'utf8',
    });
    assert.equal(preflight.status, 0, preflight.stderr);
    const original = filesToCheck.map((filePath) => fs.readFileSync(filePath));
    const second = run();
    assert.notEqual(second.status, 0);
    filesToCheck.forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), original[index]));
    const databaseHash = crypto.createHash('sha256').update(fs.readFileSync(env.COIN_DB_PATH)).digest('hex');
    fs.unlinkSync(filesToCheck[3]);
    const missingPreflight = spawnSync(process.execPath, ['-e',
      "require('./src/platform/runtimeDataPreflight').preflightRuntimeData().catch(e=>{console.error(e.message);process.exitCode=1})"], {
      cwd: exportRoot, env: { ...env, XIAOJI_REMINDERS_PROVENANCE_SHA256: reminderDigest,
        XIAOJI_CALENDAR_PROVENANCE_SHA256: calendarDigest }, encoding: 'utf8',
    });
    assert.notEqual(missingPreflight.status, 0);
    assert.equal(fs.existsSync(filesToCheck[3]), false);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(env.COIN_DB_PATH)).digest('hex'), databaseHash);
    const partial = run();
    assert.notEqual(partial.status, 0);
    assert.equal(fs.existsSync(filesToCheck[3]), false);
    filesToCheck.slice(0, 3).forEach((filePath, index) => assert.deepEqual(fs.readFileSync(filePath), original[index]));
    assert.match(partial.stderr, /人工檢查/);
    assert.doesNotMatch(first.stdout + first.stderr + second.stdout + second.stderr + partial.stderr,
      /protected|audit\.json|whitelist\.json/);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
