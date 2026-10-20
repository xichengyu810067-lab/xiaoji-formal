'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const coin = require('../src/services/coinDatabase');
const { TEST_CRASH_CODE, bootstrapSafetyLedgers } = require('../src/systems/safety/ledgerBootstrap');
const { DatabaseSync } = require('node:sqlite');
const layout = require('../src/systems/safety/ledgerLayout');
const { parseArguments, runSafetyLedgerCommand } = require('../scripts/safety-ledger');
const { GUARD_FILE_NAME, writeGuardFile } = require('../src/systems/safety/ownerDmStartGuard');
const { buildPreparationOperation } = require('../src/systems/safety/ownerSafetyNotifier');
const { TEST_DATA_ROOT_MARKER } = require('../src/platform/testControlPolicy');

const BOT_ID = '10000000000000001';
const OWNER_ID = '10000000000000002';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'safety-ledger.js');
const ALL = layout.PURPOSE_IDS;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function quiet() {
  return { info() {}, warn() {}, error() {} };
}

async function environment(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `xiaoji-safety-script-${prefix}-`)));
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot);
  const coinDbPath = path.join(dataRoot, 'xiaoji.sqlite');
  const previous = process.env.COIN_DB_PATH;
  process.env.COIN_DB_PATH = coinDbPath;
  coin.resetCoinDatabaseForTests();
  await coin.initializeNewCoinDatabase({ expectedPath: coinDbPath });
  const results = [];
  t.after(() => {
    for (const result of results) result.close();
    coin.resetCoinDatabaseForTests();
    if (previous === undefined) delete process.env.COIN_DB_PATH;
    else process.env.COIN_DB_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const clock = { value: Date.UTC(2026, 9, 3) };
  const boot = async ({ dataRoot: base = dataRoot, ...options } = {}) => {
    const result = await bootstrapSafetyLedgers({ env: { XIAOJI_DATA_ROOT: base }, runtimeMode: 'production',
      botId: BOT_ID, ownerId: OWNER_ID, coinDbPath, logger: quiet(), now: () => clock.value, ...options });
    results.push(result);
    return result;
  };
  // The script runs as another process, from a folder without any .env file.
  const scriptAt = (base, ...args) => {
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir() };
    const result = spawnSync(process.execPath, [SCRIPT, ...args, '--data-root', base, '--coin-db', coinDbPath],
      { cwd: root, env, encoding: 'utf8' });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  };
  const script = (...args) => scriptAt(dataRoot, ...args);
  const directories = { ledgerDirectory: path.join(dataRoot, 'safety'), witnessDirectory: path.join(dataRoot, 'safety-witness') };
  return { root, dataRoot, coinDbPath, clock, boot, script, scriptAt, directories,
    paths: (purposeId) => layout.purposePaths(directories, purposeId) };
}

// A first start that crashed right after registering every ledger as creating.
async function crashAfterCreatingRegistration(env, options = {}) {
  await assert.rejects(env.boot({ ...options, faultInjector: (event) => {
    if (event.label === 'bootstrap' && event.phase === 'after-creating-registration') {
      throw Object.assign(new Error('synthetic crash'), { code: TEST_CRASH_CODE });
    }
  } }), (error) => error.code === TEST_CRASH_CODE);
  return Object.fromEntries(Object.entries(await coin.readSafetyLedgerRegistrations())
    .map(([purposeId, entry]) => [purposeId, JSON.parse(entry.value)]));
}

// Digest of every file under the data root (only while no ledger is open here).
function tree(directory) {
  const entries = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath || entry.path, entry.name);
    entries[path.relative(directory, full)] = sha256(fs.readFileSync(full));
  }
  return entries;
}

// Size and modification time only, so nothing opens a database this process holds.
function statTree(directory) {
  const entries = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const stat = fs.statSync(path.join(entry.parentPath || entry.path, entry.name));
    entries[path.relative(directory, path.join(entry.parentPath || entry.path, entry.name))] = `${stat.size}:${stat.mtimeMs}`;
  }
  return entries;
}

function statusJson(result) {
  return Object.fromEntries(JSON.parse(result.stdout).purposes.map((item) => [item.purposeId, item]));
}

function attempt(ledger, id, sourceTimeMs) {
  const operation = { operationId: `welcome-${id}`, sourceKey: 'welcome:guild:111111111111111111',
    sourceEventId: `event.${id}`, hostPurpose: 'discord.guildMemberAdd', scope: 'guild:111111111111111111',
    action: 'welcome-message.create', target: '222222222222222222', budgetClass: 'none', mergeKey: `welcome-${id}`,
    payload: { content: id }, sourceTimeMs };
  const claimed = ledger.claim(operation);
  ledger.beginDispatch(operation, claimed.operation.generation);
  ledger.finish(operation.operationId, claimed.operation.generation, 'confirmed', 'message_confirmed');
}

test('arguments: reinit and release need purposes, --bot-stopped, and well-formed confirmation codes', () => {
  assert.throws(() => parseArguments([]), /用法[^]*必須先停止機器人/u);
  assert.throws(() => parseArguments(['reinit', '--purpose', 'welcome']), /必須先停止機器人[^]*bot-stopped/u);
  assert.throws(() => parseArguments(['reinit', '--bot-stopped']), /--purpose/u);
  assert.throws(() => parseArguments(['reinit', '--all', '--purpose', 'welcome', '--bot-stopped']), /--purpose/u);
  assert.throws(() => parseArguments(['reinit', '--purpose', 'nope', '--bot-stopped']), /未知的用途/u);
  assert.throws(() => parseArguments(['reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm', 'welcome=XYZ']),
    /8 碼/u);
  const parsed = parseArguments(['reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm', 'welcome=0123abcd']);
  assert.deepEqual([parsed.command, parsed.purposes, parsed.confirms.get('welcome')], ['reinit', ['welcome'], '0123abcd']);
  assert.equal(parseArguments(['status', '--json']).json, true);
});

test('status reads registrations and ledgers and changes nothing at all', async (t) => {
  const env = await environment(t, 'status');
  const result = await env.boot();
  attempt(result.ledgers.get('welcome'), 'one', env.clock.value + 1);
  result.close();
  const before = tree(env.dataRoot);
  const status = env.script('status', '--json');
  assert.equal(status.status, 0, status.stderr);
  const report = statusJson(status);
  const registrations = await coin.readSafetyLedgerRegistrations();
  for (const purposeId of ALL) {
    const item = report[purposeId];
    const registration = JSON.parse(registrations[purposeId].value);
    assert.equal(item.verdict, 'ok', `${purposeId}: ${item.anomalies}`);
    assert.equal(item.registration, 'active');
    assert.equal(item.confirmationCode, layout.confirmationCode(registration.ledgerId));
    assert.equal(item.receipt, 'ok');
    assert.equal(item.store.integrity, 'ok');
    assert.equal(item.store.registration, 'ok');
    assert.equal(item.store.neverUsed, purposeId !== 'welcome');
    assert.deepEqual(item.store.witnesses.map((witness) => witness.continuity), ['ok', 'ok']);
    assert.equal(item.walPresent, false);
  }
  const human = env.script('status');
  assert.equal(human.status, 0);
  assert.match(human.stdout, /安全帳本狀態（production）/u);
  assert.match(human.stdout, /- welcome: ok registration=active/u);
  assert.deepEqual(tree(env.dataRoot), before);
});

// The answers the README upgrade steps (升級與資料位置) rely on.
test('status before the first start: eight absent purposes beside the coin database; inside the program folder refused',
  async (t) => {
    const env = await environment(t, 'status-upgrade');
    const before = tree(env.root);
    // COIN_DB_PATH outside the program folder, XIAOJI_DATA_ROOT unset: the base is its folder.
    const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: env.root, encoding: 'utf8',
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(),
        COIN_DB_PATH: env.coinDbPath } });
    const json = run('status', '--json');
    assert.equal(json.status, 0, json.stderr);
    const report = JSON.parse(json.stdout);
    assert.deepEqual([report.directories.base, report.directories.ledgerDirectory],
      [env.dataRoot, path.join(env.dataRoot, 'safety')]);
    assert.deepEqual(report.purposes.map((item) => [item.purposeId, item.verdict]), ALL.map((id) => [id, 'absent']));
    const human = run('status');
    assert.equal(human.status, 0);
    assert.ok(human.stdout.includes(`帳本目錄：${path.join(env.dataRoot, 'safety')}\n`));
    assert.equal(human.stdout.match(/^- \S+: absent /gmu).length, ALL.length);
    assert.deepEqual(tree(env.root), before);

    // A coin database inside the program folder is refused before anything is read.
    const output = { stdout: '', stderr: '' };
    const io = { stdout: { write: (text) => { output.stdout += text; } },
      stderr: { write: (text) => { output.stderr += text; } } };
    const inside = path.join(__dirname, 'xiaoji.sqlite');
    assert.equal(await runSafetyLedgerCommand(['status', '--coin-db', inside], { env: {}, ...io }), 2);
    assert.deepEqual(output, { stdout: '', stderr: '帳本目錄無法使用：LEDGER_PATH_IN_PROJECT (base)\n' });
    assert.deepEqual([fs.existsSync(inside), fs.existsSync(path.join(__dirname, 'safety'))], [false, false]);
    // A relative COIN_DB_PATH (which the bot resolves inside the program folder) is refused too.
    output.stderr = '';
    assert.equal(await runSafetyLedgerCommand(['status'], { env: { COIN_DB_PATH: 'data/xiaoji.sqlite' }, ...io }), 1);
    assert.match(output.stderr, /^吉幣資料庫路徑必須是絕對路徑/u);
    assert.deepEqual(tree(env.root), before);
  });

// The README upgrade steps never let the old and the new version run together: every branch
// that goes on to the start stops the bot first.
test('the README upgrade steps stop the bot before every start', () => {
  const readme = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8').replace(/\r\n/gu, '\n');
  const start = readme.indexOf('\n### 升級與資料位置\n');
  assert.ok(start >= 0);
  const lines = readme.slice(start, readme.indexOf('\n### ', start + 1)).split('\n');
  // The branch of step 1 that needs no move stops the bot (step 2) before going on to step 8.
  const skips = lines.filter((line) => line.includes('跳到第 8 步'));
  assert.equal(skips.length, 1, skips.join('\n'));
  assert.match(skips[0], /結束碼 0/u);
  const stopAt = skips[0].indexOf('先停止小吉（第 2 步）');
  assert.ok(stopAt >= 0 && stopAt < skips[0].indexOf('跳到第 8 步'), skips[0]);
  // Step 2 stops the bot, and step 8 starts it only once the old version is stopped.
  assert.match(lines.find((line) => line.startsWith('2. ')), /^2\. \*\*停止小吉\*\*/u);
  assert.match(lines.find((line) => line.startsWith('8. ')), /確認舊版已停止後，執行 `npm start`/u);
});

test('status while the bot holds the ledgers reports them in use and leaves them alone', async (t) => {
  const env = await environment(t, 'status-in-use');
  const held = await env.boot();
  const before = statTree(env.dataRoot);
  const status = env.script('status', '--json');
  assert.equal(status.status, 2);
  for (const item of Object.values(statusJson(status))) {
    assert.equal(item.verdict, 'in-use', item.purposeId);
    assert.equal(item.store.inUse, 'locked');
    assert.equal(item.store.integrity, null);
  }
  assert.deepEqual(statTree(env.dataRoot), before);
  // The bot still holds every lock afterwards.
  assert.ok([...held.ledgers.values()].every((ledger) => !ledger.failed));
  attempt(held.ledgers.get('welcome'), 'after-status', env.clock.value + 1);
});

test('status flags a missing registration (used or never used), a quarantine, staged files, and a receipt change',
  async (t) => {
    const env = await environment(t, 'status-anomalies');
    const result = await env.boot();
    attempt(result.ledgers.get('welcome'), 'used', env.clock.value + 1);
    result.ledgers.get('audit.guild.leave').quarantine('synthetic_review');
    await result.ledgers.get('audit.guild.leave').quarantineFlag;
    result.close();
    await coin.withCoinTransaction((api) => {
      api.run("DELETE FROM coin_metadata WHERE key IN ('safety_ledger:welcome', 'safety_ledger:word-chain.reaction')");
    });
    fs.writeFileSync(env.paths('number-chain.reaction').staged.database, 'leftover');
    fs.appendFileSync(env.paths('work.penalty.announce').receipt, ' ');
    const status = env.script('status', '--json');
    assert.equal(status.status, 2);
    const report = statusJson(status);
    assert.deepEqual(report.welcome.anomalies, ['registration-missing']);
    assert.equal(report.welcome.store.neverUsed, false);
    assert.deepEqual(report['word-chain.reaction'].anomalies, ['registration-missing']);
    assert.equal(report['word-chain.reaction'].store.neverUsed, true);
    assert.equal(report['word-chain.reaction'].confirmationCode, layout.confirmationCode(report['word-chain.reaction'].ledgerId));
    assert.deepEqual(report['audit.guild.leave'].quarantine, { marker: true, stamp: true, registration: true });
    assert.ok(report['audit.guild.leave'].anomalies.includes('quarantined'));
    assert.deepEqual(report['number-chain.reaction'].staged, ['database']);
    assert.deepEqual(report['number-chain.reaction'].anomalies, ['staged-files']);
    assert.deepEqual(report['work.penalty.announce'].anomalies, ['receipt-mismatch']);
    assert.equal(report['owner-safety'].verdict, 'ok');
  });

test('reinit refuses unless the bot is stopped and the code matches; refusals change nothing', async (t) => {
  const env = await environment(t, 'reinit-refused');
  const held = await env.boot();
  const code = layout.confirmationCode(byId(held).welcome.ledgerId);
  const heldBefore = statTree(env.dataRoot);
  const running = env.script('reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm', `welcome=${code}`);
  assert.equal(running.status, 1);
  assert.match(running.stderr, /正被使用[^]*必須先停止機器人/u);
  assert.deepEqual(statTree(env.dataRoot), heldBefore);
  held.close();
  const before = tree(env.dataRoot);
  const wrong = env.script('reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm', 'welcome=00000000');
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /--confirm welcome=/u);
  const missing = env.script('reinit', '--purpose', 'welcome', '--bot-stopped');
  assert.equal(missing.status, 1);
  const notStopped = env.script('reinit', '--purpose', 'welcome', '--confirm', `welcome=${code}`);
  assert.equal(notStopped.status, 1);
  assert.deepEqual(tree(env.dataRoot), before);
});

test('reinit of a creation that never completed starts over with a new ledger and a new cutover', async (t) => {
  const env = await environment(t, 'reinit-creating');
  const stuck = await crashAfterCreatingRegistration(env);
  // status shows the creation as pending, with the confirmation code of its registration.
  const status = env.script('status', '--json');
  assert.equal(status.status, 0, status.stdout);
  const welcomeStatus = statusJson(status).welcome;
  assert.deepEqual([welcomeStatus.verdict, welcomeStatus.registration, welcomeStatus.ledgerIdSource],
    ['pending', 'creating', 'registration']);
  assert.equal(welcomeStatus.confirmationCode, layout.confirmationCode(stuck.welcome.ledgerId));
  const coinBefore = sha256(fs.readFileSync(env.coinDbPath));
  const reinit = env.script('reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm',
    `welcome=${welcomeStatus.confirmationCode}`);
  assert.equal(reinit.status, 0, reinit.stderr);
  assert.equal(sha256(fs.readFileSync(env.coinDbPath)), coinBefore);
  env.clock.value += 3_600_000;
  const result = await env.boot();
  const welcome = byId(result).welcome;
  assert.deepEqual([welcome.code, welcome.notices], ['LEDGER_CREATED', ['LEDGER_REINIT_APPLIED']]);
  assert.notEqual(welcome.ledgerId, stuck.welcome.ledgerId);
  assert.equal(welcome.cutoverMs, env.clock.value);
  assert.ok(welcome.cutoverMs > stuck.welcome.cutoverMs);
  // Every other purpose resumes its own creation with its original cutover.
  assert.deepEqual([byId(result)['word-chain.reaction'].code, byId(result)['word-chain.reaction'].cutoverMs],
    ['LEDGER_CREATION_RESUMED', stuck['word-chain.reaction'].cutoverMs]);
  const registration = JSON.parse((await coin.readSafetyLedgerRegistrations()).welcome.value);
  assert.deepEqual(registration.previous.map((entry) => entry.ledgerId), [stuck.welcome.ledgerId]);
});

test('reinit of a creation whose data root moved (path mismatch) creates the ledger at the new root', async (t) => {
  const env = await environment(t, 'reinit-moved');
  const stuck = await crashAfterCreatingRegistration(env);
  const movedRoot = path.join(env.root, 'moved-data');
  fs.mkdirSync(movedRoot);
  const mismatched = await env.boot({ dataRoot: movedRoot });
  assert.deepEqual([byId(mismatched).welcome.code, byId(mismatched).welcome.reason], ['LEDGER_PATH_MISMATCH', 'anchor']);
  mismatched.close();
  const code = layout.confirmationCode(stuck.welcome.ledgerId);
  const reinit = env.scriptAt(movedRoot, 'reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm', `welcome=${code}`);
  assert.equal(reinit.status, 0, reinit.stderr);
  env.clock.value += 3_600_000;
  const result = await env.boot({ dataRoot: movedRoot });
  const welcome = byId(result).welcome;
  assert.deepEqual([welcome.code, welcome.notices], ['LEDGER_CREATED', ['LEDGER_REINIT_APPLIED']]);
  assert.ok(welcome.cutoverMs > stuck.welcome.cutoverMs);
  const registration = JSON.parse((await coin.readSafetyLedgerRegistrations()).welcome.value);
  assert.equal(registration.paths.database, path.join(movedRoot, 'safety', 'welcome.sqlite'));
  assert.equal(fs.existsSync(registration.paths.database), true);
  assert.equal(byId(result)['word-chain.reaction'].code, 'LEDGER_PATH_MISMATCH');
});

test('reinit of a creation registered for another bot creates the ledger for the current one', async (t) => {
  const env = await environment(t, 'reinit-identity');
  const stuck = await crashAfterCreatingRegistration(env, { botId: '10000000000000007' });
  const otherBot = await env.boot();
  assert.deepEqual([byId(otherBot).welcome.code, byId(otherBot).welcome.reason], ['LEDGER_IDENTITY_MISMATCH', 'bot']);
  otherBot.close();
  const reinit = env.script('reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm',
    `welcome=${layout.confirmationCode(stuck.welcome.ledgerId)}`);
  assert.equal(reinit.status, 0, reinit.stderr);
  const result = await env.boot();
  assert.equal(byId(result).welcome.code, 'LEDGER_CREATED');
  assert.equal(JSON.parse((await coin.readSafetyLedgerRegistrations()).welcome.value).botId, BOT_ID);
  assert.equal(byId(result)['word-chain.reaction'].code, 'LEDGER_IDENTITY_MISMATCH');
});

test('reinit of ledger files whose registration is missing uses the ledger ID inside the database', async (t) => {
  const env = await environment(t, 'reinit-unregistered');
  const first = await env.boot();
  const old = byId(first).welcome;
  first.close();
  await coin.withCoinTransaction((api) => {
    api.run("DELETE FROM coin_metadata WHERE key = 'safety_ledger:welcome'");
  });
  const status = statusJson(env.script('status', '--json')).welcome;
  assert.deepEqual([status.registration, status.ledgerIdSource, status.ledgerId], ['none', 'database', old.ledgerId]);
  assert.deepEqual(status.anomalies, ['registration-missing']);
  const reinit = env.script('reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm',
    `welcome=${status.confirmationCode}`);
  assert.equal(reinit.status, 0, reinit.stderr);
  for (const filePath of [env.paths('welcome').database, env.paths('welcome').witness]) {
    assert.equal(fs.existsSync(filePath), false);
  }
  env.clock.value += 60_000;
  const result = await env.boot();
  const welcome = byId(result).welcome;
  assert.deepEqual([welcome.code, welcome.notices], ['LEDGER_CREATED', ['LEDGER_REINIT_APPLIED']]);
  assert.notEqual(welcome.ledgerId, old.ledgerId);
  const registration = JSON.parse((await coin.readSafetyLedgerRegistrations()).welcome.value);
  assert.deepEqual(registration.previous.map((entry) => entry.ledgerId), [old.ledgerId]);
});

test('reinit of a registration that cannot be parsed needs the ledger ID inside the database, then replaces it',
  async (t) => {
    const env = await environment(t, 'reinit-invalid');
    const first = await env.boot();
    const old = byId(first)['word-chain.reaction'];
    first.close();
    const raw = await coin.readSafetyLedgerRegistrations();
    await coin.writeSafetyLedgerRegistrations([
      { purposeId: 'word-chain.reaction', expectedValue: raw['word-chain.reaction'].value, value: '{"broken":' },
      { purposeId: 'number-chain.reaction', expectedValue: raw['number-chain.reaction'].value, value: '{"broken":' },
    ]);
    // Without the database there is no ledger ID to confirm against: refused, nothing moved.
    const parked = path.join(env.root, 'parked');
    fs.mkdirSync(parked);
    fs.renameSync(env.paths('number-chain.reaction').database, path.join(parked, 'number-chain.sqlite'));
    const before = tree(env.dataRoot);
    const statusBefore = statusJson(env.script('status', '--json'));
    assert.deepEqual([statusBefore['number-chain.reaction'].registration, statusBefore['number-chain.reaction'].ledgerId],
      ['invalid', null]);
    const refused = env.script('reinit', '--purpose', 'number-chain.reaction', '--bot-stopped', '--confirm',
      'number-chain.reaction=00000000');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /無法解析/u);
    assert.deepEqual(tree(env.dataRoot), before);
    // With the database, the code comes from the database's own ledger ID.
    const chain = statusBefore['word-chain.reaction'];
    assert.deepEqual([chain.registration, chain.ledgerIdSource, chain.ledgerId], ['invalid', 'database', old.ledgerId]);
    const reinit = env.script('reinit', '--purpose', 'word-chain.reaction', '--bot-stopped', '--confirm',
      `word-chain.reaction=${chain.confirmationCode}`);
    assert.equal(reinit.status, 0, reinit.stderr);
    env.clock.value += 60_000;
    const result = await env.boot();
    const created = byId(result)['word-chain.reaction'];
    assert.deepEqual([created.code, created.notices], ['LEDGER_CREATED', ['LEDGER_REINIT_APPLIED']]);
    const registration = JSON.parse((await coin.readSafetyLedgerRegistrations())['word-chain.reaction'].value);
    assert.equal(registration.state, 'active');
    assert.deepEqual(registration.previous.map((entry) => entry.ledgerId), [old.ledgerId]);
    // The other unparsable registration stays closed and untouched.
    assert.deepEqual([byId(result)['number-chain.reaction'].code, byId(result)['number-chain.reaction'].reason],
      ['LEDGER_REGISTRATION_INVALID', 'json']);
    assert.equal((await coin.readSafetyLedgerRegistrations())['number-chain.reaction'].value, '{"broken":');
  });

test('reinit does not probe staged files: an interrupted creation is moved away; on Windows a held file stops the run',
  async (t) => {
    const env = await environment(t, 'reinit-staged');
    await assert.rejects(env.boot({ faultInjector: (event) => {
      if (event.label === 'bootstrap' && event.phase === 'after-staged-files') {
        throw Object.assign(new Error('synthetic crash'), { code: TEST_CRASH_CODE });
      }
    } }), (error) => error.code === TEST_CRASH_CODE);
    const stuck = JSON.parse((await coin.readSafetyLedgerRegistrations())['owner-safety'].value);
    const p = env.paths('owner-safety');
    const args = ['reinit', '--purpose', 'owner-safety', '--bot-stopped', '--confirm',
      `owner-safety=${layout.confirmationCode(stuck.ledgerId)}`];
    if (process.platform === 'win32') {
      // An open handle without any lock, as a creation still running would have. Nothing
      // detects it; only moving the file fails, so no request is written.
      const holder = new DatabaseSync(p.staged.database);
      try {
        const refused = env.script(...args);
        assert.equal(refused.status, 1);
        assert.match(refused.stderr, /必須先停止機器人/u);
        assert.equal(fs.existsSync(p.staged.database), true);
        assert.equal(fs.existsSync(p.reinitRequest), false);
      } finally {
        holder.close();
      }
    }
    const accepted = env.script(...args);
    assert.equal(accepted.status, 0, accepted.stderr);
    for (const filePath of [p.staged.database, p.staged.anchor, p.staged.receipt, p.staged.witness]) {
      assert.equal(fs.existsSync(filePath), false, filePath);
    }
    env.clock.value += 3_600_000;
    const result = await env.boot();
    const owner = byId(result)['owner-safety'];
    assert.deepEqual([owner.code, owner.notices], ['LEDGER_CREATED', ['LEDGER_REINIT_APPLIED']]);
    assert.notEqual(owner.ledgerId, stuck.ledgerId);
  });

test('reinit of an unparsable registration is refused while the clock is not past its last write', async (t) => {
  const env = await environment(t, 'reinit-invalid-clock');
  (await env.boot()).close();
  const stored = (await coin.readSafetyLedgerRegistrations()).welcome;
  await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: stored.value, value: '{"broken":' }]);
  const writtenMs = Date.parse((await coin.readSafetyLedgerRegistrations()).welcome.updatedAt);
  const welcome = statusJson(env.script('status', '--json')).welcome;
  assert.deepEqual([welcome.registration, welcome.ledgerIdSource], ['invalid', 'database']);
  const before = tree(env.dataRoot);
  const errors = [];
  const reinitAt = (nowMs) => runSafetyLedgerCommand(['reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm',
    `welcome=${welcome.confirmationCode}`, '--data-root', env.dataRoot, '--coin-db', env.coinDbPath],
  { env: {}, stdout: { write() {} }, stderr: { write: (text) => errors.push(text) }, now: () => nowMs });
  // The bot would refuse a request that is not newer than the value: refused, nothing moved.
  assert.equal(await reinitAt(writtenMs), 1);
  assert.match(errors.join(''), /系統時間/u);
  assert.deepEqual(tree(env.dataRoot), before);
  assert.equal(await reinitAt(writtenMs + 1), 0, errors.join(''));
  assert.equal(layout.readRequest(env.paths('welcome').reinitRequest, 'welcome').requestedAtMs, writtenMs + 1);
});

test('a leftover temporary request is shown by status and replaced by the next request', async (t) => {
  const env = await environment(t, 'request-temp');
  const first = await env.boot();
  const code = byId(first).welcome.confirmationCode;
  first.close();
  const temp = env.paths('welcome').reinitRequestTemp;
  fs.writeFileSync(temp, '{"schema":1,"kin');
  const status = env.script('status', '--json');
  assert.equal(status.status, 0, status.stdout);
  assert.equal(statusJson(status).welcome.requests.incomplete, true);
  assert.equal(statusJson(status).welcome.verdict, 'ok');
  const reinit = env.script('reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm', `welcome=${code}`);
  assert.equal(reinit.status, 0, reinit.stderr);
  assert.equal(fs.existsSync(temp), false);
  assert.equal(layout.readRequest(env.paths('welcome').reinitRequest, 'welcome').ledgerId, byId(first).welcome.ledgerId);
});

function byId(result) {
  return Object.fromEntries(result.report.purposes.map((item) => [item.purposeId, item]));
}

test('reinit retires the files and writes a request without writing the coin database; the next start applies it',
  async (t) => {
    const env = await environment(t, 'reinit');
    const first = await env.boot();
    const old = byId(first).welcome;
    first.close();
    const coinBefore = sha256(fs.readFileSync(env.coinDbPath));
    const coinStat = fs.statSync(env.coinDbPath).mtimeMs;
    const p = env.paths('welcome');
    const reinit = env.script('reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm',
      `welcome=${old.confirmationCode}`);
    assert.equal(reinit.status, 0, reinit.stderr);
    assert.equal(sha256(fs.readFileSync(env.coinDbPath)), coinBefore);
    assert.equal(fs.statSync(env.coinDbPath).mtimeMs, coinStat);
    for (const filePath of [p.database, p.anchor, p.receipt, p.witness]) assert.equal(fs.existsSync(filePath), false);
    const request = layout.readRequest(p.reinitRequest, 'welcome');
    assert.equal(request.ledgerId, old.ledgerId);
    const retiredLedger = path.join(env.directories.ledgerDirectory, request.retired.ledgerDirectory);
    const manifest = layout.readManifest(retiredLedger);
    assert.deepEqual([manifest.createdBy, manifest.reason, manifest.ledgerId], ['script', 'reinit', old.ledgerId]);
    assert.deepEqual(manifest.files.map((file) => file.role).sort(), ['anchor', 'database', 'receipt']);
    assert.ok(fs.existsSync(path.join(env.directories.witnessDirectory, request.retired.witnessDirectory, 'welcome.witness')));
    // Another request cannot pile up before the bot handled this one.
    const twice = env.script('reinit', '--purpose', 'welcome', '--bot-stopped', '--confirm', `welcome=${old.confirmationCode}`);
    assert.equal(twice.status, 1);

    env.clock.value += 3_600_000;
    const second = await env.boot();
    const welcome = byId(second).welcome;
    assert.deepEqual([welcome.code, welcome.notices], ['LEDGER_CREATED', ['LEDGER_REINIT_APPLIED']]);
    assert.notEqual(welcome.ledgerId, old.ledgerId);
    assert.equal(welcome.cutoverMs, env.clock.value);
    assert.equal(fs.existsSync(p.reinitRequest), false);
    assert.equal(fs.existsSync(path.join(retiredLedger, 'reinit.request.json')), true);
    const registration = JSON.parse((await coin.readSafetyLedgerRegistrations()).welcome.value);
    assert.equal(registration.previous[0].ledgerId, old.ledgerId);
    for (const purposeId of ALL.filter((id) => id !== 'welcome')) assert.equal(byId(second)[purposeId].code, 'LEDGER_READY');
    second.close();
    const status = env.script('status', '--json');
    assert.equal(status.status, 0, status.stdout);
  });

test('release-quarantine retires the marker and stamp; the next start clears the registration flag', async (t) => {
  const env = await environment(t, 'release');
  const result = await env.boot();
  const ledger = result.ledgers.get('number-chain.reaction');
  ledger.quarantine('synthetic_fence_fault');
  await ledger.quarantineFlag;
  const code = layout.confirmationCode(ledger.ledgerId);
  result.close();
  const notQuarantined = env.script('release-quarantine', '--purpose', 'welcome', '--bot-stopped', '--confirm',
    `welcome=${byId(result).welcome.confirmationCode}`);
  assert.equal(notQuarantined.status, 1);
  assert.match(notQuarantined.stderr, /沒有被隔離/u);
  const coinBefore = sha256(fs.readFileSync(env.coinDbPath));
  const released = env.script('release-quarantine', '--purpose', 'number-chain.reaction', '--bot-stopped', '--confirm',
    `number-chain.reaction=${code}`);
  assert.equal(released.status, 0, released.stderr);
  assert.equal(sha256(fs.readFileSync(env.coinDbPath)), coinBefore);
  const p = env.paths('number-chain.reaction');
  assert.equal(fs.existsSync(p.marker), false);
  assert.equal(fs.existsSync(p.stamp), false);
  assert.equal(fs.existsSync(p.database), true);
  const reopened = await env.boot();
  const item = byId(reopened)['number-chain.reaction'];
  assert.deepEqual([item.code, item.notices], ['LEDGER_READY', ['LEDGER_QUARANTINE_RELEASED']]);
  assert.equal(item.ledgerId, ledger.ledgerId);
  assert.equal(JSON.parse((await coin.readSafetyLedgerRegistrations())['number-chain.reaction'].value).quarantine, null);
});

// A POSIX directory file system for the status probe: open, fsync and close of a folder,
// with one step failing per folder as chosen; it has no way to write anything.
function directoryProbeFileSystem(failures) {
  const calls = [];
  const folders = new Map();
  let next = 9000;
  const failIfChosen = (step, directory) => {
    const failure = failures.get(directory);
    if (failure?.step === step) throw Object.assign(new Error(`synthetic ${step} failure`), { code: failure.code });
  };
  return {
    calls,
    openSync(target, flags) {
      const directory = path.resolve(String(target));
      calls.push(['open', path.basename(directory), flags]);
      failIfChosen('open', directory);
      next += 1;
      folders.set(next, directory);
      return next;
    },
    fsyncSync(descriptor) {
      const directory = folders.get(descriptor);
      calls.push(['fsync', path.basename(directory)]);
      failIfChosen('fsync', directory);
    },
    closeSync(descriptor) {
      const directory = folders.get(descriptor);
      calls.push(['close', path.basename(directory)]);
      failIfChosen('close', directory);
    },
  };
}

test('status probes whether the data folders sync a directory, read-only, and reports one fixed-code line', async (t) => {
  const env = await environment(t, 'directory-sync');
  const folders = { 'coin-database': env.dataRoot, ledger: env.directories.ledgerDirectory,
    witness: env.directories.witnessDirectory };
  const status = async ({ failures = {}, platform = 'linux', json = false } = {}) => {
    const filesystem = directoryProbeFileSystem(new Map(Object.entries(failures)
      .map(([folder, failure]) => [path.resolve(folders[folder]), failure])));
    const output = { stdout: '', stderr: '' };
    const code = await runSafetyLedgerCommand(['status', '--coin-db', env.coinDbPath, '--data-root', env.dataRoot,
      ...(json ? ['--json'] : [])], {
      env: {},
      stdout: { write: (text) => { output.stdout += text; } },
      stderr: { write: (text) => { output.stderr += text; } },
      probe: (directory) => coin.probeDirectorySync(directory, { filesystem, platform }),
    });
    const line = output.stdout.split('\n').find((text) => text.startsWith('資料夾同步：')) || null;
    return { code, line, calls: filesystem.calls, ...output };
  };
  const sync = (name) => [['open', name, 'r'], ['fsync', name], ['close', name]];

  // Before the first start only the coin database's folder exists.
  let result = await status();
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.line, '資料夾同步：code=DIRECTORY_SYNC_OK');
  assert.deepEqual(result.calls, sync('data'));

  const started = await env.boot();
  started.close();
  const before = tree(env.dataRoot);
  result = await status();
  assert.equal(result.code, 0, result.stdout);
  assert.equal(result.line, '資料夾同步：code=DIRECTORY_SYNC_OK');
  assert.deepEqual(result.calls, [...sync('data'), ...sync('safety'), ...sync('safety-witness')]);

  // The coin database's folder on a file system that cannot sync a directory: the coin database
  // would still write there, but the safety ledgers would not start, so it needs attention.
  result = await status({ failures: { 'coin-database': { step: 'fsync', code: 'EINVAL' } } });
  assert.equal(result.code, 2);
  assert.equal(result.line, '資料夾同步：code=DIRECTORY_SYNC_UNSUPPORTED errno=EINVAL folder=coin-database');
  // The ledger and witness folders follow the ledgers' rule: any error fails, EINVAL included.
  // A failure outweighs a folder that is only unsupported; a failing open or close counts like a
  // failing fsync, and a missing folder is ENOENT.
  for (const [failures, line] of [
    [{ ledger: { step: 'fsync', code: 'EINVAL' } }, '資料夾同步：code=DIRECTORY_SYNC_FAILED errno=EINVAL folder=ledger'],
    [{ witness: { step: 'open', code: 'EISDIR' } }, '資料夾同步：code=DIRECTORY_SYNC_FAILED errno=EISDIR folder=witness'],
    [{ 'coin-database': { step: 'fsync', code: 'EINVAL' }, witness: { step: 'fsync', code: 'EIO' } },
      '資料夾同步：code=DIRECTORY_SYNC_FAILED errno=EIO folder=witness'],
    [{ ledger: { step: 'open', code: 'EACCES' } }, '資料夾同步：code=DIRECTORY_SYNC_FAILED errno=EACCES folder=ledger'],
    [{ ledger: { step: 'close', code: 'EIO' } }, '資料夾同步：code=DIRECTORY_SYNC_FAILED errno=EIO folder=ledger'],
    [{ 'coin-database': { step: 'open', code: 'ENOENT' } }, '資料夾同步：code=DIRECTORY_SYNC_FAILED errno=ENOENT folder=coin-database'],
  ]) {
    result = await status({ failures });
    assert.equal(result.code, 2, line);
    assert.equal(result.line, line);
  }
  // Windows has no directory sync: nothing is opened.
  result = await status({ platform: 'win32' });
  assert.equal(result.code, 0);
  assert.equal(result.line, '資料夾同步：code=DIRECTORY_SYNC_NOT_APPLICABLE');
  assert.deepEqual(result.calls, []);
  // The JSON report carries the same result.
  result = await status({ failures: { 'coin-database': { step: 'fsync', code: 'EIO' } }, json: true });
  assert.equal(result.code, 2);
  assert.deepEqual(JSON.parse(result.stdout).directorySync,
    { code: 'DIRECTORY_SYNC_FAILED', result: 'failed', errno: 'EIO', folder: 'coin-database' });
  // The line never names a path, and nothing under the data root was written.
  for (const failures of [{}, { witness: { step: 'fsync', code: 'EIO' } }]) {
    const { line } = await status({ failures });
    assert.equal(line.includes(env.root), false, line);
    assert.equal(/[\\/]/u.test(line), false, line);
  }
  assert.deepEqual(tree(env.dataRoot), before);
});

// The Owner DM start guard's count (src/systems/safety/ownerDmStartGuard.js): shown by status,
// set back to 0 by reset-start-failures with the bot stopped.
test('status shows the Owner DM start guard count; reset-start-failures sets it back to 0 with the bot stopped',
  async (t) => {
    const env = await environment(t, 'start-guard');
    const guardPath = path.join(env.dataRoot, GUARD_FILE_NAME);
    const guardLine = (result) => result.stdout.split('\n').find((text) => text.startsWith('Owner 私訊啟動保護：')) || null;
    const guardJson = () => {
      const result = env.script('status', '--json');
      return { status: result.status, guard: JSON.parse(result.stdout).ownerDmStartGuard };
    };

    // Before the first start: no count, nothing to do.
    assert.deepEqual(guardJson(), { status: 0, guard: { state: 'absent', cause: null, consecutiveFailures: 0,
      threshold: 3, suppressNextStart: false } });
    assert.equal(guardLine(env.script('status')), 'Owner 私訊啟動保護：連續啟動失敗 0 次（門檻 3）；下次啟動照常送 Owner 私訊');
    let reset = env.script('reset-start-failures', '--bot-stopped');
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /沒有紀錄，不需要歸零/u);
    assert.equal(fs.existsSync(guardPath), false, 'an absent count stays absent');

    // Two failed starts: still fine. Three: the next start sends no Owner DM, which needs attention.
    writeGuardFile(guardPath, 2, 1);
    let human = env.script('status');
    assert.equal(human.status, 0);
    assert.equal(guardLine(human), 'Owner 私訊啟動保護：連續啟動失敗 2 次（門檻 3）；下次啟動照常送 Owner 私訊');
    writeGuardFile(guardPath, 3, 1);
    human = env.script('status');
    assert.equal(human.status, 2);
    assert.equal(guardLine(human), 'Owner 私訊啟動保護：連續啟動失敗 3 次（門檻 3）；' +
      '下次啟動不送 Owner 私訊，直到該次啟動成功或執行 reset-start-failures');
    assert.equal(guardJson().guard.suppressNextStart, true);
    const written = fs.readFileSync(guardPath);

    // The reset needs --bot-stopped and takes no ledger options; refusals change nothing.
    for (const args of [['reset-start-failures'], ['reset-start-failures', '--bot-stopped', '--all'],
      ['reset-start-failures', '--bot-stopped', '--purpose', 'welcome'], ['reset-start-failures', '--bot-stopped', '--json']]) {
      const refused = env.script(...args);
      assert.equal(refused.status, 1, args.join(' '));
      assert.deepEqual(fs.readFileSync(guardPath), written);
    }
    reset = env.script('reset-start-failures', '--bot-stopped');
    assert.equal(reset.status, 0, reset.stderr);
    assert.match(reset.stdout, /已歸零（原本 3 次）/u);
    assert.deepEqual(guardJson(), { status: 0, guard: { state: 'ok', cause: null,
      consecutiveFailures: 0, threshold: 3, suppressNextStart: false } });

    // A count that cannot be trusted needs attention too, and the reset repairs it.
    fs.writeFileSync(guardPath, 'not json');
    human = env.script('status');
    assert.equal(human.status, 2);
    assert.match(guardLine(human), /^Owner 私訊啟動保護：state=invalid（紀錄無法使用；下次啟動不送 Owner 私訊/u);
    assert.equal(env.script('reset-start-failures', '--bot-stopped').status, 0);
    assert.equal(JSON.parse(fs.readFileSync(guardPath, 'utf8')).consecutiveFailures, 0);
    // A name taken by a folder is refused, and left alone.
    fs.rmSync(guardPath);
    fs.mkdirSync(guardPath);
    const folder = env.script('reset-start-failures', '--bot-stopped');
    assert.equal(folder.status, 1);
    assert.match(folder.stderr, /不是一般檔案/u);
    assert.equal(fs.statSync(guardPath).isDirectory(), true);
    fs.rmdirSync(guardPath);
    // The line never names a path.
    assert.equal(/[\/]/u.test(guardLine(env.script('status'))), false);

    // A test-control data root has no count: shown as not used, and never reset.
    const testRoot = path.join(env.root, 'test-root');
    fs.mkdirSync(testRoot);
    fs.writeFileSync(path.join(testRoot, TEST_DATA_ROOT_MARKER), '{}');
    const testStatus = env.scriptAt(testRoot, 'status');
    assert.equal(guardLine(testStatus), 'Owner 私訊啟動保護：test-control 不使用');
    const testReset = env.scriptAt(testRoot, 'reset-start-failures', '--bot-stopped');
    assert.equal(testReset.status, 1);
    assert.deepEqual(fs.readdirSync(testRoot), [TEST_DATA_ROOT_MARKER]);
  });

// An Owner DM channel preparation that reached Discord and ended rejected or unknown is final in
// the Owner ledger, so no Owner notice can go out: status reports it, and the README's way back
// (stop the bot, reinit the Owner ledger, start) clears it.
test('status reports an Owner DM preparation that ended unknown or rejected; reinit of the Owner ledger clears it',
  async (t) => {
    // attempted: cut off in flight; the next start records it as unknown.
    for (const outcome of ['unknown', 'rejected', 'attempted']) {
      const env = await environment(t, `owner-dm-${outcome}`);
      const first = await env.boot();
      const owner = first.ledgers.get('owner-safety');
      const preparation = buildPreparationOperation(BOT_ID, OWNER_ID);
      const claimed = owner.claim(preparation);
      owner.beginDispatch(preparation, claimed.operation.generation);
      if (outcome !== 'attempted') {
        owner.finish(preparation.operationId, claimed.operation.generation, outcome, `dm_prepare_${outcome}`);
      }
      const code = byId(first)['owner-safety'].confirmationCode;
      first.close();

      const anomaly = `owner-dm-preparation-${outcome === 'rejected' ? 'rejected' : 'unknown'}`;
      const json = env.script('status', '--json');
      assert.equal(json.status, 2, json.stdout);
      const report = statusJson(json);
      assert.equal(report['owner-safety'].verdict, 'anomaly');
      assert.deepEqual(report['owner-safety'].anomalies, [anomaly]);
      assert.deepEqual(report['owner-safety'].store.rows.byAction['dm-channel.prepare'], { [outcome]: 1 });
      for (const purposeId of ALL.filter((id) => id !== 'owner-safety')) assert.equal(report[purposeId].verdict, 'ok');
      assert.match(env.script('status').stdout, new RegExp(`- owner-safety: anomaly .* anomalies=${anomaly}`, 'u'));

      const reinit = env.script('reinit', '--purpose', 'owner-safety', '--bot-stopped', '--confirm', `owner-safety=${code}`);
      assert.equal(reinit.status, 0, reinit.stderr);
      env.clock.value += 3_600_000;
      const second = await env.boot();
      assert.deepEqual(byId(second)['owner-safety'].notices, ['LEDGER_REINIT_APPLIED']);
      assert.equal(second.ledgers.get('owner-safety').getOperation(preparation.operationId), null);
      second.close();
      const after = env.script('status', '--json');
      assert.equal(after.status, 0, after.stdout);
      assert.deepEqual(statusJson(after)['owner-safety'].anomalies, []);
    }
  });
