'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const test = require('node:test');
const { makeRealTempDir } = require('./support/realTempDir');
const coin = require('../src/services/coinDatabase');
const {
  LEGACY_LEDGER_VARIABLES,
  TEST_CRASH_CODE,
  bootstrapSafetyLedgers,
  resolveProtectedEffects,
} = require('../src/systems/safety/ledgerBootstrap');
const layout = require('../src/systems/safety/ledgerLayout');
const {
  inspectLedgerStore,
  openLedgerStore,
  readWitness,
  witnessIdentityDigest,
} = require('../src/systems/safety/ledgerStore');
const { initializePublicPurposeLedger } = require('../src/systems/safety/sideEffectLedger');
const { TEST_DATA_ROOT_MARKER, readDataRootIdentity, serializeTestDataRootMarker } =
  require('../src/platform/testControlPolicy');

const BOT_ID = '10000000000000001';
const OWNER_ID = '10000000000000002';
const APPLICATION_ID = '20000000000000001';
const CHILD = path.join(__dirname, 'fixtures', 'ledgerBootstrapChild.js');
const STORE_MODULE = path.join(__dirname, '..', 'src', 'systems', 'safety', 'ledgerStore.js');
const ALL = layout.PURPOSE_IDS;
const TEST_CONTROL_ENABLED = ['welcome', 'work.penalty.announce', 'word-chain.reaction', 'number-chain.reaction'];

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function capturingLogger() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(['info', line]),
    warn: (line) => lines.push(['warn', line]),
    error: (line) => lines.push(['error', line]),
  };
}

function crash(phase) {
  return Object.assign(new Error(`synthetic crash at ${phase}`), { code: TEST_CRASH_CODE });
}

// A temporary data root with its own coin database. run() bootstraps against it; every
// result is closed and the coin database reset when the test ends.
async function environment(t, prefix, { testControl = false } = {}) {
  const root = makeRealTempDir(`xiaoji-ledger-bootstrap-${prefix}-`);
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot);
  const coinDbPath = path.join(dataRoot, 'xiaoji.sqlite');
  const previous = process.env.COIN_DB_PATH;
  process.env.COIN_DB_PATH = coinDbPath;
  coin.resetCoinDatabaseForTests();
  await coin.initializeNewCoinDatabase({ expectedPath: coinDbPath });
  const results = [];
  const children = [];
  t.after(() => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const result of results) result.close();
    coin.resetCoinDatabaseForTests();
    if (previous === undefined) delete process.env.COIN_DB_PATH;
    else process.env.COIN_DB_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  const clock = { value: Date.UTC(2026, 9, 3) };
  const policy = { dataRoot, expectedApplicationId: APPLICATION_ID };
  if (testControl) {
    fs.writeFileSync(path.join(dataRoot, TEST_DATA_ROOT_MARKER),
      serializeTestDataRootMarker(APPLICATION_ID, readDataRootIdentity(dataRoot)));
  }
  const logger = capturingLogger();
  const run = async (options = {}) => {
    const { env = {}, ...rest } = options;
    const result = await bootstrapSafetyLedgers({
      env: testControl ? { ...env } : { XIAOJI_DATA_ROOT: dataRoot, ...env },
      runtimeMode: testControl ? 'test-control' : 'production',
      policy: testControl ? policy : null,
      botId: BOT_ID,
      ownerId: OWNER_ID,
      coinDbPath,
      logger,
      now: () => clock.value,
      ...rest,
    });
    results.push(result);
    return result;
  };
  const directories = { ledgerDirectory: path.join(dataRoot, 'safety'), witnessDirectory: path.join(dataRoot, 'safety-witness') };
  return {
    root,
    dataRoot,
    coinDbPath,
    clock,
    logger,
    policy,
    run,
    directories,
    paths: (purposeId) => layout.purposePaths(directories, purposeId),
    track: (child) => children.push(child),
  };
}

function byPurpose(result) {
  return Object.fromEntries(result.report.purposes.map((item) => [item.purposeId, item]));
}

async function registrations() {
  const raw = await coin.readSafetyLedgerRegistrations();
  return Object.fromEntries(Object.entries(raw).map(([purposeId, entry]) => [purposeId, JSON.parse(entry.value)]));
}

// Rewrites one registration as a tool with coin database access could (compare-and-set).
async function rewriteRegistration(purposeId, mutate) {
  const raw = (await coin.readSafetyLedgerRegistrations())[purposeId].value;
  const next = mutate(JSON.parse(raw));
  await coin.writeSafetyLedgerRegistrations([{ purposeId, expectedValue: raw,
    value: layout.encodeRegistration(purposeId, next) }]);
}

async function removeRegistration(purposeId) {
  await coin.withCoinTransaction((api) => {
    api.run('DELETE FROM coin_metadata WHERE key = ?', [`safety_ledger:${purposeId}`]);
  });
}

// The files of a closed ledger, for later restores.
function copyLedger(paths) {
  return { database: fs.readFileSync(paths.database), anchor: fs.readFileSync(paths.anchor),
    witness: fs.readFileSync(paths.witness) };
}

function restoreLedger(paths, copy) {
  for (const role of Object.keys(copy)) fs.writeFileSync(paths[role], copy[role]);
}

// Every file under a directory with its digest (only for closed ledgers).
function tree(directory) {
  if (!fs.existsSync(directory)) return {};
  const entries = {};
  for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath || entry.path, entry.name);
    entries[path.relative(directory, full)] = sha256(fs.readFileSync(full));
  }
  return entries;
}

function moveAway(env, filePath) {
  const parking = path.join(env.root, 'parking');
  fs.mkdirSync(parking, { recursive: true });
  const target = path.join(parking, `${Date.now()}-${Math.random().toString(16).slice(2)}-${path.basename(filePath)}`);
  fs.renameSync(filePath, target);
  return target;
}

function welcomeOperation(id, overrides = {}) {
  return {
    operationId: `welcome-${id}`,
    sourceKey: 'welcome:guild:111111111111111111',
    sourceEventId: `event.${id}`,
    hostPurpose: 'discord.guildMemberAdd',
    scope: 'guild:111111111111111111',
    action: 'welcome-message.create',
    target: '222222222222222222',
    budgetClass: 'none',
    mergeKey: `welcome-${id}`,
    payload: { content: `welcome ${id}` },
    ...overrides,
  };
}

function attempt(ledger, operation) {
  const claimed = ledger.claim(operation);
  ledger.beginDispatch(operation, claimed.operation.generation);
  ledger.finish(operation.operationId, claimed.operation.generation, 'confirmed', 'message_confirmed');
}

test('with all three records absent every ledger is created once, with the cutover of its purpose', async (t) => {
  const env = await environment(t, 'create');
  const first = await env.run();
  const report = byPurpose(first);
  assert.equal(first.report.version, 1);
  assert.equal(first.report.protectedEffects, 'on');
  assert.equal(first.report.lastSeen, 'written');
  for (const purposeId of ALL) {
    const item = report[purposeId];
    assert.equal(item.status, 'ready', purposeId);
    assert.equal(item.code, 'LEDGER_CREATED', purposeId);
    assert.equal(item.created, true);
    assert.equal(item.escalate, false);
    assert.equal(item.genesisMs, env.clock.value);
    assert.equal(item.cutoverMs, ['audit.guild.leave', 'owner-safety'].includes(purposeId) ? 0 : env.clock.value, purposeId);
    assert.equal(item.confirmationCode, layout.confirmationCode(item.ledgerId));
    assert.ok(first.ledgers.get(purposeId), purposeId);
  }
  // The report carries fixed codes only: no path and no Discord ID.
  const serialized = JSON.stringify(first.report);
  assert.doesNotMatch(serialized, /[\\/]/u);
  assert.ok(!serialized.includes(BOT_ID) && !serialized.includes(OWNER_ID));
  const registered = await registrations();
  assert.deepEqual(Object.keys(registered).sort(), [...ALL].sort());
  for (const purposeId of ALL) {
    const registration = registered[purposeId];
    const paths = env.paths(purposeId);
    assert.equal(registration.state, 'active');
    assert.equal(registration.ledgerId, report[purposeId].ledgerId);
    assert.equal(registration.kind, purposeId === 'owner-safety' ? 'owner' : 'public');
    assert.equal(registration.ownerId, purposeId === 'owner-safety' ? OWNER_ID : null);
    assert.equal(registration.botId, BOT_ID);
    assert.equal(registration.runtimeMode, 'production');
    assert.deepEqual(registration.paths, { anchor: paths.anchor, database: paths.database, receipt: paths.receipt,
      witness: paths.witness });
    assert.equal(registration.receiptSha256, sha256(fs.readFileSync(paths.receipt)));
    assert.equal(registration.lastSeen.bootEpoch, 1);
    assert.equal(registration.createdBy, 'bootstrap');
    assert.deepEqual(registration.previous, []);
    // Receipts name their own creation and the final paths.
    const receipt = JSON.parse(fs.readFileSync(paths.receipt, 'utf8'));
    assert.equal(receipt.createdBy, 'bootstrap');
    assert.equal(receipt.continuityWitness.filePath, paths.witness);
  }
  assert.deepEqual(fs.readdirSync(env.directories.witnessDirectory).sort(),
    ALL.map((purposeId) => `${layout.SAFETY_LEDGER_PURPOSES[purposeId].stem}.witness`).sort());
  first.close();

  env.clock.value += 60_000;
  const second = await env.run();
  for (const item of second.report.purposes) {
    assert.equal(item.code, 'LEDGER_READY', item.purposeId);
    assert.equal(item.created, false);
    assert.equal(item.ledgerId, report[item.purposeId].ledgerId);
  }
  assert.equal((await registrations()).welcome.lastSeen.bootEpoch, 2);
});

test('a registered ledger whose files are all gone fails closed and is never rebuilt', async (t) => {
  const env = await environment(t, 'files-missing');
  (await env.run()).close();
  const paths = env.paths('welcome');
  for (const filePath of [paths.database, paths.anchor, paths.receipt, paths.witness]) moveAway(env, filePath);
  const welcomeFiles = () => [env.directories.ledgerDirectory, env.directories.witnessDirectory]
    .flatMap((directory) => fs.readdirSync(directory).filter((name) => name.startsWith('welcome')));
  const before = { files: welcomeFiles(), registration: (await coin.readSafetyLedgerRegistrations()).welcome.value };
  assert.deepEqual(before.files, []);
  const result = await env.run();
  const welcome = byPurpose(result).welcome;
  assert.deepEqual([welcome.status, welcome.code, welcome.reason, welcome.escalate],
    ['failed', 'LEDGER_FILES_MISSING', 'all', true]);
  assert.equal(result.ledgers.has('welcome'), false);
  assert.equal(byPurpose(result)['word-chain.reaction'].code, 'LEDGER_READY');
  result.close();
  // Nothing was rebuilt and the registration was left exactly as it was.
  assert.deepEqual(welcomeFiles(), []);
  assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, before.registration);
  assert.ok(env.logger.lines.some(([level, line]) => level === 'error' &&
    line === '[SAFETY_LEDGER] purpose=welcome code=LEDGER_FILES_MISSING reason=all'));
});

test('a registered ledger missing only its database, anchor, external witness, or receipt fails closed as partial',
  async (t) => {
    const env = await environment(t, 'partial');
    (await env.run()).close();
    const cases = [['welcome', 'database'], ['word-chain.reaction', 'anchor'], ['number-chain.reaction', 'witness'],
      ['work.penalty.announce', 'receipt']];
    for (const [purposeId, role] of cases) moveAway(env, env.paths(purposeId)[role]);
    const before = tree(env.dataRoot);
    const result = await env.run();
    const report = byPurpose(result);
    for (const [purposeId] of cases) {
      assert.deepEqual([report[purposeId].code, report[purposeId].reason], ['LEDGER_PARTIAL', 'active'], purposeId);
    }
    assert.equal(report['audit.guild.leave'].code, 'LEDGER_READY');
    result.close();
    // Only the healthy ledgers' boot (and the registrations' lastSeen) changed anything.
    const after = tree(env.dataRoot);
    for (const [purposeId] of cases) {
      const stem = layout.SAFETY_LEDGER_PURPOSES[purposeId].stem;
      for (const [name, digest] of Object.entries(before)) {
        if (name.includes(stem)) assert.equal(after[name], digest, name);
      }
    }
  });

test('ledger files without a registration fail closed, whether the ledger was never used or used', async (t) => {
  const env = await environment(t, 'unregistered');
  const first = await env.run();
  attempt(first.ledgers.get('welcome'), welcomeOperation('used', { sourceTimeMs: env.clock.value + 1 }));
  first.close();
  await removeRegistration('welcome');
  await removeRegistration('word-chain.reaction');
  const before = tree(env.dataRoot);
  delete before['xiaoji.sqlite'];
  const result = await env.run();
  const report = byPurpose(result);
  for (const purposeId of ['welcome', 'word-chain.reaction']) {
    assert.deepEqual([report[purposeId].code, report[purposeId].reason], ['LEDGER_REGISTRATION_MISSING', 'unregistered']);
    assert.equal(report[purposeId].ledgerId, null);
  }
  result.close();
  const after = tree(env.dataRoot);
  for (const stem of ['welcome', 'word-chain-reaction']) {
    for (const [name, digest] of Object.entries(before)) {
      if (name.includes(stem)) assert.equal(after[name], digest, name);
    }
  }
  // Inspection (as status shows it) tells the never-used ledger from the used one.
  assert.equal(inspectLedgerStore({ filePath: env.paths('welcome').database }).neverUsed, false);
  assert.equal(inspectLedgerStore({ filePath: env.paths('word-chain.reaction').database }).neverUsed, true);
});

test('each identity field that differs from the registration fails closed with its own reason', async (t) => {
  const env = await environment(t, 'identity');
  (await env.run()).close();
  const p = env.paths;
  // ledger-id: another ledger's database in this one's place.
  fs.copyFileSync(p('word-chain.reaction').database, p('welcome').database);
  // kind: the Owner ledger's database in a public ledger's place.
  fs.copyFileSync(p('owner-safety').database, p('work.penalty.announce').database);
  // purpose: a receipt (and its registered digest) naming another purpose.
  const receiptPath = p('word-chain.reaction').receipt;
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  receipt.purposeIdentity.purposeId = 'number-chain.reaction';
  const forged = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  fs.writeFileSync(receiptPath, forged);
  await rewriteRegistration('word-chain.reaction', (value) => ({ ...value, receiptSha256: sha256(forged) }));
  // runtime-mode, genesis, cutover: registrations that no longer match.
  await rewriteRegistration('number-chain.reaction', (value) => ({ ...value, runtimeMode: 'test-control' }));
  await rewriteRegistration('audit.guild.leave', (value) => ({ ...value, genesisMs: value.genesisMs - 1 }));
  await rewriteRegistration('work.reminder.dm.send', (value) => ({ ...value, cutoverMs: value.cutoverMs + 1 }));
  const tampered = await env.run();
  const report = byPurpose(tampered);
  const expected = {
    welcome: 'ledger-id',
    'work.penalty.announce': 'kind',
    'word-chain.reaction': 'purpose',
    'number-chain.reaction': 'runtime-mode',
    'audit.guild.leave': 'genesis',
    'work.reminder.dm.send': 'cutover',
  };
  for (const [purposeId, reason] of Object.entries(expected)) {
    assert.deepEqual([report[purposeId].code, report[purposeId].reason], ['LEDGER_IDENTITY_MISMATCH', reason], purposeId);
  }
  assert.equal(report['work.reminder.dm.prepare'].code, 'LEDGER_READY');
  tampered.close();
  // bot and owner: the same ledgers seen by another bot or for another Owner.
  const otherBot = await env.run({ botId: '10000000000000009' });
  assert.deepEqual([byPurpose(otherBot)['work.reminder.dm.prepare'].code, byPurpose(otherBot)['work.reminder.dm.prepare'].reason],
    ['LEDGER_IDENTITY_MISMATCH', 'bot']);
  otherBot.close();
  const otherOwner = await env.run({ ownerId: '10000000000000008' });
  assert.deepEqual([byPurpose(otherOwner)['owner-safety'].code, byPurpose(otherOwner)['owner-safety'].reason],
    ['LEDGER_IDENTITY_MISMATCH', 'owner']);
  assert.equal(byPurpose(otherOwner)['work.reminder.dm.prepare'].code, 'LEDGER_READY');
});

test('restored copies are caught against the registration; one step ahead of the witness is accepted', async (t) => {
  const env = await environment(t, 'restore');
  const p = env.paths('welcome');
  let result = await env.run();
  result.close();
  const atEpoch1 = copyLedger(p);

  // registration-ahead: database and witnesses restored together to before a recorded boot.
  result = await env.run();
  result.close();
  restoreLedger(p, atEpoch1);
  result = await env.run();
  assert.deepEqual([byPurpose(result).welcome.code, byPurpose(result).welcome.reason], ['LEDGER_ROLLBACK', 'registration-ahead']);
  result.close();

  // registration-fork: the same counters as the record, reached through another step.
  const forkEnv = await environment(t, 'fork');
  const fp = forkEnv.paths('welcome');
  result = await forkEnv.run();
  result.close();
  const base = copyLedger(fp);
  result = await forkEnv.run();
  attempt(result.ledgers.get('welcome'), welcomeOperation('original', { sourceTimeMs: forkEnv.clock.value + 1 }));
  await result.recordLastSeen();
  result.close();
  const recorded = (await registrations()).welcome.lastSeen;
  restoreLedger(fp, base);
  const store = openLedgerStore({ filePath: fp.database, witnessPaths: [fp.anchor, fp.witness], kind: 'public',
    expected: { botId: BOT_ID, runtimeMode: 'production' } });
  const forked = JSON.stringify({ forked: true });
  store.begin({ purposeId: 'welcome', operationId: 'welcome-forked', sourceKey: 'welcome:guild:1', sourceTimeMs: null,
    bindingJson: forked, bindingDigest: sha256(forked), generation: 1, target: 't', mergeKey: 'm', mergeWindowUntilMs: null,
    budgetCharged: false, budgetReservedAtMs: null, claimedAtMs: 1 });
  assert.deepEqual([store.identity.bootEpoch, store.identity.beginSeq], [recorded.bootEpoch, recorded.beginSeq]);
  assert.notEqual(store.identity.chainHead, recorded.chainHead);
  store.close();
  result = await forkEnv.run();
  assert.deepEqual([byPurpose(result).welcome.code, byPurpose(result).welcome.reason], ['LEDGER_ROLLBACK', 'registration-fork']);
  result.close();

  // database-behind: only the database restored; its witnesses are newer.
  const behindEnv = await environment(t, 'behind');
  const bp = behindEnv.paths('welcome');
  result = await behindEnv.run();
  result.close();
  const old = copyLedger(bp);
  result = await behindEnv.run();
  result.close();
  fs.writeFileSync(bp.database, old.database);
  result = await behindEnv.run();
  assert.deepEqual([byPurpose(result).welcome.code, byPurpose(result).welcome.reason], ['LEDGER_ROLLBACK', 'database-behind']);
  result.close();

  // One step ahead (a crash between a commit and its witness writes) is accepted and the
  // witnesses are rewritten; the registration may lag any number of steps.
  const aheadEnv = await environment(t, 'ahead');
  const ap = aheadEnv.paths('welcome');
  result = await aheadEnv.run();
  const ledger = result.ledgers.get('welcome');
  attempt(ledger, welcomeOperation('one', { sourceTimeMs: aheadEnv.clock.value + 1 }));
  const witnessBefore = fs.readFileSync(ap.witness);
  const anchorBefore = fs.readFileSync(ap.anchor);
  attempt(ledger, welcomeOperation('two', { sourceTimeMs: aheadEnv.clock.value + 2 }));
  result.close();
  fs.writeFileSync(ap.witness, witnessBefore);
  fs.writeFileSync(ap.anchor, anchorBefore);
  result = await aheadEnv.run();
  assert.equal(byPurpose(result).welcome.code, 'LEDGER_READY');
  const reopened = result.ledgers.get('welcome');
  assert.equal(reopened.getOperation('welcome-two').status, 'confirmed');
  const digest = witnessIdentityDigest({ ledgerId: reopened.ledgerId, kind: 'public',
    genesisMs: byPurpose(result).welcome.genesisMs });
  assert.equal(readWitness(ap.witness, digest).state.beginSeq, reopened.identityCounters.beginSeq);
});

test('only staged files are retired (never deleted) before creation; a used staged witness fails closed', async (t) => {
  const env = await environment(t, 'staged');
  fs.mkdirSync(env.directories.ledgerDirectory);
  fs.mkdirSync(env.directories.witnessDirectory);
  const p = env.paths('welcome');
  // Leftovers of a creation whose registration was lost: never opened, counters 0/0.
  initializePublicPurposeLedger({ filePath: p.database, continuityWitnessPath: p.witness, ledgerId: 'lost-creation',
    initializationId: 'synthetic', staging: true, purposeIdentity: { purposeId: 'welcome', botId: BOT_ID,
      sourceNamespace: 'discord.guildMemberAdd', cutoverJoinedTimestampMs: 1, freshSourceProofDigest: 'a'.repeat(64) } });
  const stagedDatabase = sha256(fs.readFileSync(p.staged.database));
  // A staged witness with counters past 0/0 was used by something: fail closed.
  const q = env.paths('word-chain.reaction');
  initializePublicPurposeLedger({ filePath: q.database, continuityWitnessPath: q.witness, ledgerId: 'used-staging',
    initializationId: 'synthetic', staging: true, purposeIdentity: { purposeId: 'word-chain.reaction', botId: BOT_ID,
      sourceNamespace: 'discord.messageCreate', cutoverSourceTimestampMs: 1, freshSourceProofDigest: 'a'.repeat(64) } });
  const scratch = path.join(env.root, 'scratch');
  fs.mkdirSync(path.join(scratch, 'l'), { recursive: true });
  fs.mkdirSync(path.join(scratch, 'w'));
  const usedPaths = { database: path.join(scratch, 'l', 'x.sqlite'), witness: path.join(scratch, 'w', 'x.witness') };
  const { createLedgerStore } = require('../src/systems/safety/ledgerStore');
  createLedgerStore({ filePath: usedPaths.database, witnessPaths: [usedPaths.witness], kind: 'public', ledgerId: 'x',
    botId: BOT_ID, runtimeMode: 'production', genesisMs: 1, cutoverMs: 0 });
  openLedgerStore({ filePath: usedPaths.database, witnessPaths: [usedPaths.witness], kind: 'public',
    expected: { botId: BOT_ID, runtimeMode: 'production' } }).close();
  fs.copyFileSync(usedPaths.witness, q.staged.witness);

  const result = await env.run();
  const report = byPurpose(result);
  assert.equal(report.welcome.code, 'LEDGER_CREATED');
  assert.deepEqual(report.welcome.notices, ['LEDGER_TEMP_RETIRED']);
  assert.notEqual(report.welcome.ledgerId, 'lost-creation');
  assert.deepEqual([report['word-chain.reaction'].code, report['word-chain.reaction'].reason],
    ['LEDGER_TEMP_PRESENT', 'staged-used']);
  const retired = fs.readdirSync(env.directories.ledgerDirectory).filter((name) => name.startsWith('retired-'));
  assert.equal(retired.length, 1);
  assert.match(retired[0], /-welcome-staged$/u);
  const retiredFiles = fs.readdirSync(path.join(env.directories.ledgerDirectory, retired[0])).sort();
  assert.deepEqual(retiredFiles, ['manifest.json', 'welcome.sqlite.creating', 'welcome.sqlite.provenance.json.creating',
    'welcome.sqlite.witness.creating']);
  assert.equal(sha256(fs.readFileSync(path.join(env.directories.ledgerDirectory, retired[0], 'welcome.sqlite.creating'))),
    stagedDatabase);
  assert.ok(fs.readdirSync(env.directories.witnessDirectory).some((name) => /^retired-.*-welcome-staged$/u.test(name)));
});

test('a staged file beside an active ledger, or a registration that cannot be parsed, fails that purpose closed',
  async (t) => {
    const env = await environment(t, 'active-staged');
    (await env.run()).close();
    fs.writeFileSync(env.paths('welcome').staged.database, 'leftover');
    fs.writeFileSync(env.paths('word-chain.reaction').staged.witness, 'leftover');
    const raw = await coin.readSafetyLedgerRegistrations();
    await coin.writeSafetyLedgerRegistrations([
      { purposeId: 'number-chain.reaction', expectedValue: raw['number-chain.reaction'].value, value: '{not json' },
      { purposeId: 'audit.guild.leave', expectedValue: raw['audit.guild.leave'].value,
        value: JSON.stringify({ ...JSON.parse(raw['audit.guild.leave'].value), extra: true }) },
    ]);
    const filesBefore = Object.fromEntries(['welcome', 'word-chain.reaction', 'number-chain.reaction', 'audit.guild.leave']
      .map((purposeId) => [purposeId, sha256(fs.readFileSync(env.paths(purposeId).database))]));
    const result = await env.run();
    const report = byPurpose(result);
    assert.deepEqual([report.welcome.code, report.welcome.reason], ['LEDGER_TEMP_PRESENT', 'staged']);
    assert.deepEqual([report['word-chain.reaction'].code, report['word-chain.reaction'].reason],
      ['LEDGER_TEMP_PRESENT', 'staged']);
    assert.deepEqual([report['number-chain.reaction'].code, report['number-chain.reaction'].reason],
      ['LEDGER_REGISTRATION_INVALID', 'json']);
    assert.deepEqual([report['audit.guild.leave'].code, report['audit.guild.leave'].reason],
      ['LEDGER_REGISTRATION_INVALID', 'fields']);
    assert.equal(report['owner-safety'].code, 'LEDGER_READY');
    result.close();
    for (const [purposeId, digest] of Object.entries(filesBefore)) {
      assert.equal(sha256(fs.readFileSync(env.paths(purposeId).database)), digest, purposeId);
    }
    // The unparsable registration was left exactly as found.
    assert.equal((await coin.readSafetyLedgerRegistrations())['number-chain.reaction'].value, '{not json');
  });

const CRASH_POINTS = Object.freeze([
  ['bootstrap', 'after-creating-registration'],
  ['create-ledger', 'after-database'],
  ['create-ledger', 'after-witness'],
  ['create-ledger', 'before-receipt-write'],
  ['bootstrap', 'after-staged-files'],
  ['commit-staged-ledger', 'before-rename-anchor'],
  ['commit-staged-ledger', 'before-rename-witness'],
  ['commit-staged-ledger', 'before-rename-receipt'],
  ['commit-staged-ledger', 'after-flush-companions'],
  ['commit-staged-ledger', 'before-rename-database'],
  ['commit-staged-ledger', 'after-rename-database'],
  ['bootstrap', 'after-active-registration'],
  ['bootstrap', 'before-last-seen'],
]);

test('a crash at every point of a creation resumes with the same ledger ID and cutover', async (t) => {
  for (const [label, phase] of CRASH_POINTS) {
    await t.test(`${label}:${phase}`, async (subtest) => {
      const env = await environment(subtest, `crash-${phase}`);
      await assert.rejects(env.run({ faultInjector: (event) => {
        if (event.label === label && event.phase === phase) throw crash(phase);
      } }), (error) => error.code === TEST_CRASH_CODE);
      const atCrash = await registrations();
      assert.ok(atCrash['owner-safety'], 'the creating registration was written before any file');
      env.clock.value += 5 * 60_000;
      const resumed = await env.run();
      const report = byPurpose(resumed);
      for (const purposeId of ALL) {
        assert.equal(report[purposeId].status, 'ready', `${purposeId} after ${phase}`);
        if (atCrash[purposeId]) {
          assert.equal(report[purposeId].ledgerId, atCrash[purposeId].ledgerId, purposeId);
          assert.equal(report[purposeId].cutoverMs, atCrash[purposeId].cutoverMs, purposeId);
          assert.equal(report[purposeId].genesisMs, atCrash[purposeId].genesisMs, purposeId);
        }
      }
      const owner = report['owner-safety'];
      const expectedCode = atCrash['owner-safety'].state === 'active' ? 'LEDGER_READY' : 'LEDGER_CREATION_RESUMED';
      assert.equal(owner.code, expectedCode, phase);
      for (const directory of [env.directories.ledgerDirectory, env.directories.witnessDirectory]) {
        assert.deepEqual(fs.readdirSync(directory).filter((name) => name.endsWith('.creating') || name.includes('.creating-')),
          [], `${phase}: no staged file remains`);
      }
      const active = await registrations();
      for (const purposeId of ALL) assert.equal(active[purposeId].state, 'active', purposeId);
    });
  }
});

test('a process killed in the middle of a creation leaves files the next start resumes', async (t) => {
  for (const [label, phase] of [['create-ledger', 'after-database'], ['commit-staged-ledger', 'before-rename-database']]) {
    await t.test(`${label}:${phase}`, async (subtest) => {
      const env = await environment(subtest, `killed-${phase}`);
      const child = spawn(process.execPath, [CHILD, JSON.stringify({ mode: 'bootstrap-crash', dataRoot: env.dataRoot,
        coinDbPath: env.coinDbPath, botId: BOT_ID, ownerId: OWNER_ID, label, phase })],
      { stdio: ['ignore', 'pipe', 'inherit'], cwd: env.root });
      env.track(child);
      let output = '';
      child.stdout.on('data', (chunk) => { output += chunk; });
      await new Promise((resolve) => child.once('exit', resolve));
      assert.doesNotMatch(output, /FINISHED_UNEXPECTEDLY|ERROR/u);
      const p = env.paths('owner-safety');
      if (phase === 'after-database') assert.equal(fs.existsSync(p.staged.wal), true, 'the killed creation left its WAL');
      else assert.equal(fs.existsSync(p.anchor) && fs.existsSync(p.witness) && fs.existsSync(p.receipt), true);
      // This process reloads the coin database the child wrote.
      coin.resetCoinDatabaseForTests();
      await coin.initializeCoinDatabase();
      const atCrash = (await registrations())['owner-safety'];
      assert.equal(atCrash.state, 'creating');
      const resumed = await env.run();
      const owner = byPurpose(resumed)['owner-safety'];
      assert.deepEqual([owner.code, owner.ledgerId, owner.cutoverMs], ['LEDGER_CREATION_RESUMED', atCrash.ledgerId, 0]);
      assert.deepEqual(owner.notices, ['LEDGER_TEMP_RETIRED']);
      assert.equal(fs.existsSync(p.staged.wal), false);
      const retired = fs.readdirSync(env.directories.ledgerDirectory).filter((name) => name.startsWith('retired-'));
      assert.equal(retired.length, 1);
      assert.equal(layout.readManifest(path.join(env.directories.ledgerDirectory, retired[0])).ledgerId, atCrash.ledgerId);
    });
  }
});

test('a creating registration whose witness was already used fails closed instead of rebuilding', async (t) => {
  const env = await environment(t, 'creating-used');
  const result = await env.run();
  attempt(result.ledgers.get('welcome'), welcomeOperation('used', { sourceTimeMs: env.clock.value + 1 }));
  result.close();
  await rewriteRegistration('welcome', (value) => ({ ...value, state: 'creating', receiptSha256: null, lastSeen: null }));
  moveAway(env, env.paths('welcome').database);
  const again = await env.run();
  assert.deepEqual([byPurpose(again).welcome.code, byPurpose(again).welcome.reason], ['LEDGER_FILES_MISSING', 'used']);
  assert.equal(fs.existsSync(env.paths('welcome').database), false);
});

test('a ledger held by another process is retried with async backoff until released', async (t) => {
  const env = await environment(t, 'in-use-retry');
  (await env.run()).close();
  const p = env.paths('welcome');
  const child = spawn(process.execPath, [CHILD, JSON.stringify({ mode: 'hold', filePath: p.database,
    witnessPaths: [p.anchor, p.witness], kind: 'public', botId: BOT_ID, runtimeMode: 'production', holdMs: 2_000 })],
  { stdio: ['ignore', 'pipe', 'inherit'] });
  env.track(child);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => { if (String(chunk).includes('READY')) resolve(); });
    child.once('exit', () => reject(new Error('holder exited early')));
  });
  let ticks = 0;
  const timer = setInterval(() => { ticks += 1; }, 50);
  const waits = [];
  const started = Date.now();
  let result;
  try {
    result = await env.run({ sleep: async (ms) => { waits.push(ms); await new Promise((resolve) => setTimeout(resolve, ms)); } });
  } finally {
    clearInterval(timer);
  }
  const elapsed = Date.now() - started;
  assert.equal(byPurpose(result).welcome.code, 'LEDGER_READY');
  assert.ok(elapsed >= 1_000, `waited ${elapsed} ms`);
  assert.ok(ticks >= 10, `timers kept firing while waiting (${ticks} ticks)`);
  assert.deepEqual(waits.slice(0, 4), [50, 100, 200, 400]);
  assert.ok(waits.every((ms) => ms <= 5_000));
  t.diagnostic(`reopened ${elapsed} ms after the holder took the lock, after ${waits.length} waits`);
});

test('past the shared deadline a held ledger fails closed as in use; a second open in this process is not retried',
  async (t) => {
    const env = await environment(t, 'in-use-deadline');
    (await env.run()).close();
    const p = env.paths('welcome');
    const child = spawn(process.execPath, [CHILD, JSON.stringify({ mode: 'hold', filePath: p.database,
      witnessPaths: [p.anchor, p.witness], kind: 'public', botId: BOT_ID, runtimeMode: 'production', holdMs: 0 })],
    { stdio: ['ignore', 'pipe', 'inherit'] });
    env.track(child);
    await new Promise((resolve, reject) => {
      child.stdout.on('data', (chunk) => { if (String(chunk).includes('READY')) resolve(); });
      child.once('exit', () => reject(new Error('holder exited early')));
    });
    const started = Date.now();
    const held = await env.run({ inUseDeadlineMs: 1_200 });
    const elapsed = Date.now() - started;
    assert.deepEqual([byPurpose(held).welcome.code, byPurpose(held).welcome.reason, byPurpose(held).welcome.escalate],
      ['LEDGER_IN_USE', 'locked', true]);
    assert.equal(byPurpose(held)['word-chain.reaction'].code, 'LEDGER_READY');
    assert.ok(elapsed >= 1_000 && elapsed < 10_000, `${elapsed} ms`);
    held.close();
    // Stopping ends the wait at once.
    let stoppingChecks = 0;
    const stopped = await env.run({ isStopping: () => { stoppingChecks += 1; return true; } });
    assert.deepEqual([byPurpose(stopped).welcome.code, byPurpose(stopped).welcome.reason], ['LEDGER_IN_USE', 'stopping']);
    assert.ok(stoppingChecks >= 1);
    stopped.close();
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));

    const holder = openLedgerStore({ filePath: p.database, witnessPaths: [p.anchor, p.witness], kind: 'public',
      expected: { botId: BOT_ID, runtimeMode: 'production' } });
    try {
      const waits = [];
      const same = await env.run({ sleep: async (ms) => { waits.push(ms); } });
      assert.deepEqual([byPurpose(same).welcome.code, byPurpose(same).welcome.reason], ['LEDGER_IN_USE', 'same-process']);
      assert.deepEqual(waits, []);
    } finally {
      holder.close();
    }
  });

test('registration write failures: no file before creating is durable, and no handle before active is', async (t) => {
  const env = await environment(t, 'registration-write');
  let writes = 0;
  const failingAt = (call, code) => ({
    read: () => coin.readSafetyLedgerRegistrations(),
    write: (updates) => {
      writes += 1;
      if (writes === call) {
        return Promise.reject(Object.assign(new Error('synthetic registration failure'), { code }));
      }
      return coin.writeSafetyLedgerRegistrations(updates);
    },
  });
  const first = await env.run({ registry: failingAt(1, 'SAFETY_REGISTRATION_WRITE_FAILED') });
  for (const item of first.report.purposes) {
    assert.deepEqual([item.code, item.reason], ['LEDGER_REGISTRATION_WRITE_FAILED', 'write'], item.purposeId);
  }
  assert.equal(fs.existsSync(env.directories.ledgerDirectory), false);
  assert.equal(fs.existsSync(env.directories.witnessDirectory), false);
  assert.deepEqual(await registrations(), {});

  writes = 0;
  const second = await env.run({ registry: failingAt(2, 'SAFETY_REGISTRATION_CONFLICT') });
  for (const item of second.report.purposes) {
    assert.deepEqual([item.code, item.reason], ['LEDGER_REGISTRATION_WRITE_FAILED', 'conflict'], item.purposeId);
  }
  assert.equal(second.ledgers.size, 0);
  const pending = await registrations();
  for (const purposeId of ALL) {
    assert.equal(pending[purposeId].state, 'creating');
    assert.equal(fs.existsSync(env.paths(purposeId).database), true);
  }
  const third = await env.run();
  for (const item of third.report.purposes) {
    assert.equal(item.code, 'LEDGER_CREATION_RESUMED', item.purposeId);
    assert.equal(item.ledgerId, pending[item.purposeId].ledgerId);
  }
});

test('the kill switch reads and writes nothing; an invalid value counts as off and warns once', async (t) => {
  const env = await environment(t, 'kill-switch');
  (await env.run()).close();
  const before = tree(env.dataRoot);
  const registry = { reads: 0, writes: 0, read() { this.reads += 1; return {}; }, write() { this.writes += 1; } };
  const touched = [];
  const names = ['openSync', 'readFileSync', 'lstatSync', 'statSync', 'readdirSync', 'mkdirSync', 'renameSync',
    'writeFileSync', 'realpathSync', 'existsSync', 'statfsSync'];
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  for (const name of names) {
    fs[name] = function spy(target, ...rest) {
      if (String(target).startsWith(env.root)) touched.push([name, String(target)]);
      return originals[name].call(this, target, ...rest);
    };
  }
  fs.realpathSync.native = originals.realpathSync.native;
  let off;
  let invalid;
  try {
    off = await env.run({ env: { XIAOJI_PROTECTED_EFFECTS: 'off' }, registry });
    invalid = await env.run({ env: { XIAOJI_PROTECTED_EFFECTS: 'disable-later' }, registry });
  } finally {
    Object.assign(fs, originals);
  }
  for (const result of [off, invalid]) {
    assert.equal(result.report.protectedEffects, 'off');
    assert.equal(result.ledgers.size, 0);
    assert.equal(result.report.lastSeen, 'skipped');
    for (const item of result.report.purposes) {
      assert.deepEqual([item.status, item.code, item.escalate], ['disabled', 'LEDGER_PROTECTED_EFFECTS_OFF', false]);
    }
  }
  assert.deepEqual(touched, []);
  assert.deepEqual([registry.reads, registry.writes], [0, 0]);
  assert.deepEqual(tree(env.dataRoot), before);
  assert.equal(env.logger.lines.filter(([, line]) => line.includes('LEDGER_PROTECTED_EFFECTS_INVALID')).length, 1);
  assert.deepEqual(resolveProtectedEffects({}), { enabled: true, invalid: false });
  assert.deepEqual(resolveProtectedEffects({ XIAOJI_PROTECTED_EFFECTS: '  ' }), { enabled: true, invalid: false });
  assert.deepEqual(resolveProtectedEffects({ XIAOJI_PROTECTED_EFFECTS: 'ON' }), { enabled: true, invalid: false });
  assert.deepEqual(resolveProtectedEffects({ XIAOJI_PROTECTED_EFFECTS: 'Off' }), { enabled: false, invalid: false });
  assert.deepEqual(resolveProtectedEffects({ XIAOJI_PROTECTED_EFFECTS: 'false' }), { enabled: false, invalid: true });
});

test('legacy ledger variables are named once, never read, and the reminder provenance variables are not listed', async (t) => {
  const env = await environment(t, 'legacy');
  const legacy = {
    XIAOJI_WELCOME_LEDGER_PATH: 'C:\\secret\\welcome.json',
    XIAOJI_SIDE_EFFECT_LEDGER_PROVENANCE_SHA256: 'f'.repeat(64),
    XIAOJI_AUDIT_LEAVE_LEDGER_ENABLED: 'true',
    XIAOJI_REMINDERS_PROVENANCE_SHA256: 'e'.repeat(64),
    XIAOJI_CALENDAR_PROVENANCE_SHA256: 'd'.repeat(64),
  };
  const result = await env.run({ env: { ...legacy, XIAOJI_PROTECTED_EFFECTS: 'off' } });
  assert.deepEqual(result.report.legacyVariables, ['XIAOJI_SIDE_EFFECT_LEDGER_PROVENANCE_SHA256',
    'XIAOJI_WELCOME_LEDGER_PATH', 'XIAOJI_AUDIT_LEAVE_LEDGER_ENABLED']);
  const warnings = env.logger.lines.filter(([, line]) => line.includes('LEDGER_LEGACY_VARIABLES_IGNORED'));
  assert.equal(warnings.length, 1);
  assert.doesNotMatch(warnings[0][1], /secret|ffff|true|REMINDERS|CALENDAR/u);
  assert.equal(LEGACY_LEDGER_VARIABLES.length, 24);
  assert.ok(!LEGACY_LEDGER_VARIABLES.some((name) => /REMINDERS_PROVENANCE|CALENDAR_PROVENANCE/u.test(name)));
});

test('test-control creates only its four ledgers, inside the marked data root, bound to its mode', async (t) => {
  const env = await environment(t, 'test-control', { testControl: true });
  const result = await env.run();
  const report = byPurpose(result);
  for (const purposeId of ALL) {
    if (TEST_CONTROL_ENABLED.includes(purposeId)) assert.equal(report[purposeId].code, 'LEDGER_CREATED', purposeId);
    else assert.deepEqual([report[purposeId].status, report[purposeId].code], ['disabled', 'LEDGER_POLICY_DISABLED']);
  }
  assert.equal(fs.readdirSync(env.directories.ledgerDirectory).filter((name) => name.endsWith('.sqlite')).length, 4);
  assert.equal(fs.readdirSync(env.directories.witnessDirectory).length, 4);
  const registered = await registrations();
  assert.deepEqual(Object.keys(registered).sort(), [...TEST_CONTROL_ENABLED].sort());
  for (const purposeId of TEST_CONTROL_ENABLED) assert.equal(registered[purposeId].runtimeMode, 'test-control');
  result.close();
  assert.equal(inspectLedgerStore({ filePath: env.paths('welcome').database }).identity.runtimeMode, 'test-control');

  // The same root in production is refused, and so is a directory outside the data root.
  const production = await bootstrapSafetyLedgers({ env: { XIAOJI_DATA_ROOT: env.dataRoot }, runtimeMode: 'production',
    botId: BOT_ID, ownerId: OWNER_ID, coinDbPath: env.coinDbPath, logger: env.logger });
  for (const item of production.report.purposes) assert.equal(item.code, 'LEDGER_TEST_ROOT_IN_PRODUCTION');
  const outside = path.join(env.root, 'outside');
  fs.mkdirSync(outside);
  const scoped = await env.run({ env: { XIAOJI_SAFETY_WITNESS_DIR: outside } });
  assert.deepEqual([byPurpose(scoped).welcome.code, byPurpose(scoped).welcome.reason],
    ['LEDGER_PATH_OUTSIDE_TEST_ROOT', 'witness-directory']);
  assert.equal(byPurpose(scoped)['owner-safety'].code, 'LEDGER_POLICY_DISABLED');

  // A marker that does not prove this data root stops creation (existing ledgers still open).
  await removeRegistration('word-chain.reaction');
  const p = env.paths('word-chain.reaction');
  for (const filePath of [p.database, p.anchor, p.receipt, p.witness]) moveAway(env, filePath);
  fs.writeFileSync(path.join(env.dataRoot, TEST_DATA_ROOT_MARKER), '{}');
  const unproven = await env.run();
  assert.deepEqual([byPurpose(unproven)['word-chain.reaction'].code, byPurpose(unproven)['word-chain.reaction'].reason],
    ['LEDGER_TEST_ROOT_INVALID', 'marker']);
  assert.equal(byPurpose(unproven).welcome.code, 'LEDGER_READY');
  assert.equal(fs.existsSync(p.database), false);
});

test('UNC, network, and in-project data roots fail every purpose closed before any registration is read', async (t) => {
  const env = await environment(t, 'paths');
  const registry = { reads: 0, read() { this.reads += 1; return {}; }, write() { throw new Error('never'); } };
  for (const remote of ['\\\\localhost\\c$\\xiaoji-data', '//server/share/data', '\\\\?\\C:\\xiaoji-data']) {
    const result = await env.run({ env: { XIAOJI_DATA_ROOT: remote }, registry });
    for (const item of result.report.purposes) assert.deepEqual([item.code, item.reason], ['LEDGER_PATH_REMOTE', 'base']);
  }
  const project = path.join(env.root, 'project');
  fs.mkdirSync(path.join(project, 'data'), { recursive: true });
  const inProject = await env.run({ env: { XIAOJI_DATA_ROOT: path.join(project, 'data') }, registry, projectRoot: project });
  for (const item of inProject.report.purposes) assert.deepEqual([item.code, item.reason], ['LEDGER_PATH_IN_PROJECT', 'base']);
  assert.equal(registry.reads, 0);
  assert.equal(fs.existsSync(path.join(project, 'data', 'safety')), false);
});

test('a quarantine survives restarts in each of its three places alone, until an operator releases it', async (t) => {
  const env = await environment(t, 'quarantine');
  let result = await env.run();
  const ledger = result.ledgers.get('word-chain.reaction');
  ledger.quarantine('synthetic_fence_fault');
  assert.equal(await ledger.quarantineFlag, true);
  result.close();
  const p = env.paths('word-chain.reaction');
  const flagged = (await registrations())['word-chain.reaction'].quarantine;
  assert.equal(flagged.reason, 'synthetic_fence_fault');
  assert.equal(flagged.ledgerId, ledger.ledgerId);
  assert.equal(fs.existsSync(p.marker), true);
  assert.equal(fs.existsSync(p.stamp), true);

  const parked = {};
  for (const [place, next] of [['marker', p.marker], ['stamp', p.stamp], ['registration', null]]) {
    result = await env.run();
    const item = byPurpose(result)['word-chain.reaction'];
    assert.deepEqual([item.code, item.reason, item.escalate], ['LEDGER_QUARANTINED', place, true], place);
    assert.equal(byPurpose(result).welcome.code, 'LEDGER_READY');
    result.close();
    if (next) parked[place] = moveAway(env, next);
  }

  // Release: the marker and stamp go to a retired directory (as the script does) and a
  // request names the ledger; the next start clears the registration flag and opens it.
  fs.renameSync(parked.marker, p.marker);
  fs.renameSync(parked.stamp, p.stamp);
  const nowMs = env.clock.value;
  const ledgerRetired = await layout.retireFiles({ directory: env.directories.ledgerDirectory,
    purposeId: 'word-chain.reaction', ledgerId: ledger.ledgerId, reason: 'release-quarantine', nowMs, createdBy: 'script',
    files: [{ role: 'marker', filePath: p.marker }] });
  const witnessRetired = await layout.retireFiles({ directory: env.directories.witnessDirectory,
    purposeId: 'word-chain.reaction', ledgerId: ledger.ledgerId, reason: 'release-quarantine', nowMs, createdBy: 'script',
    files: [{ role: 'stamp', filePath: p.stamp }] });
  await layout.writeRequest(p.releaseRequest, { schema: 1, kind: 'release-quarantine', purposeId: 'word-chain.reaction',
    ledgerId: ledger.ledgerId, requestedAtMs: nowMs,
    retired: { ledgerDirectory: ledgerRetired.name, witnessDirectory: witnessRetired.name } });
  result = await env.run();
  const released = byPurpose(result)['word-chain.reaction'];
  assert.deepEqual([released.code, released.notices], ['LEDGER_READY', ['LEDGER_QUARANTINE_RELEASED']]);
  assert.equal((await registrations())['word-chain.reaction'].quarantine, null);
  assert.equal(fs.existsSync(p.releaseRequest), false);
  assert.equal(fs.existsSync(path.join(ledgerRetired.path, 'release-quarantine.request.json')), true);
  result.close();

  // A release request that does not name the registered ledger is refused.
  result = await env.run();
  result.ledgers.get('welcome').quarantine('synthetic_review');
  await result.ledgers.get('welcome').quarantineFlag;
  result.close();
  const w = env.paths('welcome');
  const wRetired = await layout.retireFiles({ directory: env.directories.ledgerDirectory, purposeId: 'welcome',
    ledgerId: 'xjl2-welcome-00000000000000000000000000000000', reason: 'release-quarantine', nowMs, createdBy: 'script',
    files: [{ role: 'marker', filePath: w.marker }] });
  moveAway(env, w.stamp);
  await layout.writeRequest(w.releaseRequest, { schema: 1, kind: 'release-quarantine', purposeId: 'welcome',
    ledgerId: 'xjl2-welcome-00000000000000000000000000000000', requestedAtMs: nowMs,
    retired: { ledgerDirectory: wRetired.name, witnessDirectory: null } });
  result = await env.run();
  assert.deepEqual([byPurpose(result).welcome.code, byPurpose(result).welcome.reason], ['LEDGER_REQUEST_INVALID', 'ledger-id']);
});

test('a reinit request retires the old ledger in the registration and creates a new one with a new cutover',
  async (t) => {
    const env = await environment(t, 'reinit');
    (await env.run()).close();
    const old = (await registrations()).welcome;
    const p = env.paths('welcome');
    env.clock.value += 60 * 60_000;
    const nowMs = env.clock.value;
    const ledgerRetired = await layout.retireFiles({ directory: env.directories.ledgerDirectory, purposeId: 'welcome',
      ledgerId: old.ledgerId, reason: 'reinit', nowMs, createdBy: 'script', files: [{ role: 'database', filePath: p.database },
        { role: 'anchor', filePath: p.anchor }, { role: 'receipt', filePath: p.receipt }] });
    const witnessRetired = await layout.retireFiles({ directory: env.directories.witnessDirectory, purposeId: 'welcome',
      ledgerId: old.ledgerId, reason: 'reinit', nowMs, createdBy: 'script', files: [{ role: 'witness', filePath: p.witness }] });
    // A request naming another ledger is refused while the files are gone.
    await layout.writeRequest(p.reinitRequest, { schema: 1, kind: 'reinit', purposeId: 'welcome', ledgerId: 'xjl2-welcome-other',
      requestedAtMs: nowMs, retired: { ledgerDirectory: ledgerRetired.name, witnessDirectory: witnessRetired.name } });
    let result = await env.run();
    assert.deepEqual([byPurpose(result).welcome.code, byPurpose(result).welcome.reason], ['LEDGER_REQUEST_INVALID', 'manifest']);
    result.close();
    moveAway(env, p.reinitRequest);
    await layout.writeRequest(p.reinitRequest, { schema: 1, kind: 'reinit', purposeId: 'welcome', ledgerId: old.ledgerId,
      requestedAtMs: nowMs, retired: { ledgerDirectory: ledgerRetired.name, witnessDirectory: witnessRetired.name } });
    result = await env.run();
    const welcome = byPurpose(result).welcome;
    assert.deepEqual([welcome.code, welcome.notices], ['LEDGER_CREATED', ['LEDGER_REINIT_APPLIED']]);
    assert.notEqual(welcome.ledgerId, old.ledgerId);
    assert.equal(welcome.cutoverMs, nowMs);
    assert.ok(welcome.cutoverMs > old.cutoverMs);
    const registration = (await registrations()).welcome;
    assert.deepEqual(registration.previous, [{ ledgerId: old.ledgerId, retiredAtMs: nowMs, reason: 'reinit' }]);
    assert.equal(fs.existsSync(p.reinitRequest), false);
    assert.equal(fs.existsSync(path.join(ledgerRetired.path, 'reinit.request.json')), true);
    // The retired files are kept as they were.
    assert.ok(fs.existsSync(path.join(ledgerRetired.path, 'welcome.sqlite')));
    result.close();
    const again = await env.run();
    assert.equal(byPurpose(again).welcome.code, 'LEDGER_READY');
  });

test('opening registered ledgers touches database files only through SQLite and keeps every lock', async (t) => {
  const env = await environment(t, 'descriptors');
  (await env.run()).close();
  const databaseFiles = new Set();
  for (const purposeId of ALL) {
    const p = env.paths(purposeId);
    for (const filePath of [p.database, p.wal, p.shm]) databaseFiles.add(path.resolve(filePath).toLowerCase());
  }
  const calls = [];
  const names = ['openSync', 'closeSync', 'readFileSync', 'readSync', 'copyFileSync', 'createReadStream', 'cpSync'];
  const originals = Object.fromEntries(names.map((name) => [name, fs[name]]));
  const descriptors = new Map();
  fs.openSync = function spyOpen(target, ...rest) {
    const descriptor = originals.openSync.call(this, target, ...rest);
    if (databaseFiles.has(path.resolve(String(target)).toLowerCase())) {
      calls.push(['openSync', path.basename(String(target)), rest[0]]);
      descriptors.set(descriptor, path.basename(String(target)));
    }
    return descriptor;
  };
  fs.closeSync = function spyClose(descriptor) {
    descriptors.delete(descriptor);
    return originals.closeSync.call(this, descriptor);
  };
  fs.readSync = function spyRead(descriptor, ...rest) {
    if (descriptors.has(descriptor)) calls.push(['readSync', descriptors.get(descriptor)]);
    return originals.readSync.call(this, descriptor, ...rest);
  };
  for (const name of ['readFileSync', 'copyFileSync', 'createReadStream', 'cpSync']) {
    fs[name] = function spy(target, ...rest) {
      if (databaseFiles.has(path.resolve(String(target)).toLowerCase())) calls.push([name, path.basename(String(target))]);
      return originals[name].call(this, target, ...rest);
    };
  }
  let result;
  let afterOpen;
  try {
    result = await env.run();
    afterOpen = calls.length;
    await result.recordLastSeen();
    attempt(result.ledgers.get('welcome'), welcomeOperation('fd', { sourceTimeMs: env.clock.value + 1 }));
    result.ledgers.get('welcome').recordNotSent(welcomeOperation('fd-decision', { sourceTimeMs: env.clock.value + 2 }),
      'never_sent');
  } finally {
    Object.assign(fs, originals);
  }
  for (const item of result.report.purposes) assert.equal(item.code, 'LEDGER_READY', item.purposeId);
  // Exactly the 100-byte header read of each database, before SQLite opened it.
  const opens = calls.filter(([name]) => name === 'openSync');
  assert.equal(opens.length, ALL.length);
  assert.ok(opens.every(([, name, flags]) => name.endsWith('.sqlite') && flags === 'r'));
  assert.equal(calls.filter(([name]) => name === 'readSync').length, ALL.length);
  assert.ok(!calls.some(([name]) => ['readFileSync', 'copyFileSync', 'createReadStream', 'cpSync'].includes(name)));
  assert.equal(calls.length, afterOpen, 'nothing outside SQLite touched a database file after the open');
  // Another process is turned away from every ledger while this one holds them.
  const probe = spawnSync(process.execPath, ['-e', [
    'const [storeModule, ...files] = process.argv.slice(1);',
    'const store = require(storeModule);',
    'const codes = files.map((filePath) => {',
    '  try { store.openLedgerStore({ filePath, witnessPaths: [filePath + ".witness"], kind: "public",',
    `    expected: { botId: "${BOT_ID}", runtimeMode: "production" } }).close(); return "OPENED"; }`,
    '  catch (error) { return error.code + ":" + (error.detail?.reason || ""); }',
    '});',
    'process.stdout.write(JSON.stringify(codes));',
  ].join('\n'), STORE_MODULE, ...ALL.map((purposeId) => env.paths(purposeId).database)], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(probe.stdout), ALL.map(() => 'LEDGER_IN_USE:locked'), probe.stderr);
});

// ---------------------------------------------------------------------------
// Reinit of creating registrations, request edge cases, creating failure
// branches, staging retry, lastSeen failure
// ---------------------------------------------------------------------------

// Moves a purpose's final and staged files into retired directories and writes a reinit
// request, exactly as scripts/safety-ledger.js does. nowMs: the script's clock.
async function scriptLikeReinit(env, purposeId, ledgerId, { nowMs = env.clock.value } = {}) {
  const p = env.paths(purposeId);
  layout.ensureLedgerDirectories(env.directories);
  const ledgerRetired = await layout.retireFiles({ directory: env.directories.ledgerDirectory, purposeId, ledgerId,
    reason: 'reinit', nowMs, createdBy: 'script', allowEmpty: true, files: [p.database, p.wal, p.shm, p.journal, p.anchor,
      p.receipt, p.marker, ...Object.entries(p.staged).filter(([role]) => role !== 'witness').map(([, filePath]) => filePath)]
      .map((filePath, index) => ({ role: `file-${index}`, filePath })) });
  const witnessRetired = await layout.retireFiles({ directory: env.directories.witnessDirectory, purposeId, ledgerId,
    reason: 'reinit', nowMs, createdBy: 'script',
    files: [p.witness, p.stamp, p.staged.witness].map((filePath, index) => ({ role: `witness-${index}`, filePath })) });
  await layout.writeRequest(p.reinitRequest, { schema: 1, kind: 'reinit', purposeId, ledgerId, requestedAtMs: nowMs,
    retired: { ledgerDirectory: ledgerRetired.name, witnessDirectory: witnessRetired ? witnessRetired.name : null } });
  return ledgerRetired;
}

test('a reinit applied by a start that crashed before moving the request is recognized and consumed', async (t) => {
  const env = await environment(t, 'reinit-consumed');
  (await env.run()).close();
  const old = (await registrations()).welcome;
  env.clock.value += 60_000;
  const retired = await scriptLikeReinit(env, 'welcome', old.ledgerId);
  // The start applies the reinit (creating registration with the old ID in previous) and
  // crashes before the request is moved away and before anything is created.
  await assert.rejects(env.run({ faultInjector: (event) => {
    if (event.label === 'bootstrap' && event.phase === 'after-creating-registration') throw crash('applied');
  } }), (error) => error.code === TEST_CRASH_CODE);
  const applied = (await registrations()).welcome;
  assert.equal(applied.state, 'creating');
  assert.notEqual(applied.ledgerId, old.ledgerId);
  assert.equal(applied.previous[0].ledgerId, old.ledgerId);
  assert.equal(fs.existsSync(env.paths('welcome').reinitRequest), true);
  env.clock.value += 60_000;
  const resumed = await env.run();
  const welcome = byPurpose(resumed).welcome;
  assert.deepEqual([welcome.code, welcome.notices, welcome.ledgerId, welcome.cutoverMs],
    ['LEDGER_CREATION_RESUMED', ['LEDGER_REINIT_CONSUMED'], applied.ledgerId, applied.cutoverMs]);
  assert.equal(fs.existsSync(env.paths('welcome').reinitRequest), false);
  assert.equal(fs.existsSync(path.join(retired.path, 'reinit.request.json')), true);
  assert.equal((await registrations()).welcome.previous.filter((entry) => entry.ledgerId === old.ledgerId).length, 1);
});

test('a reinit request that cannot be moved away is reported as a notice of its purpose', async (t) => {
  const env = await environment(t, 'reinit-not-consumed');
  (await env.run()).close();
  const old = (await registrations()).welcome;
  env.clock.value += 60_000;
  await scriptLikeReinit(env, 'welcome', old.ledgerId);
  const consumeRequest = layout.consumeRequest;
  layout.consumeRequest = async () => {
    throw Object.assign(new Error('synthetic move failure'), { code: 'EPERM' });
  };
  let result;
  try {
    result = await env.run();
  } finally {
    layout.consumeRequest = consumeRequest;
  }
  const welcome = byPurpose(result).welcome;
  assert.deepEqual([welcome.status, welcome.code, welcome.notices],
    ['ready', 'LEDGER_CREATED', ['LEDGER_REINIT_APPLIED', 'LEDGER_REQUEST_NOT_CONSUMED']]);
  assert.equal(fs.existsSync(env.paths('welcome').reinitRequest), true);
  assert.ok(env.logger.lines.some(([level, line]) => level === 'warn' &&
    line === '[SAFETY_LEDGER] purpose=welcome code=LEDGER_REQUEST_NOT_CONSUMED'));
  // The next start recognizes the request as applied and consumes it.
  result.close();
  env.clock.value += 60_000;
  const next = byPurpose(await env.run()).welcome;
  assert.deepEqual([next.status, next.notices], ['ready', ['LEDGER_REINIT_CONSUMED']]);
  assert.equal(fs.existsSync(env.paths('welcome').reinitRequest), false);
});

test('an applied reinit request left beside a registration damaged since then keeps it invalid, creating nothing',
  async (t) => {
    const env = await environment(t, 'reinit-stale');
    (await env.run()).close();
    const old = (await registrations()).welcome;
    // The request carries the wall clock, as the script's does; every registration write
    // below comes later, so the damaged value is never older than the request.
    await scriptLikeReinit(env, 'welcome', old.ledgerId, { nowMs: Date.now() });
    env.clock.value += 60_000;
    await assert.rejects(env.run({ faultInjector: (event) => {
      if (event.label === 'bootstrap' && event.phase === 'after-creating-registration') throw crash('applied');
    } }), (error) => error.code === TEST_CRASH_CODE);
    const applied = (await coin.readSafetyLedgerRegistrations()).welcome;
    assert.equal(JSON.parse(applied.value).previous[0].ledgerId, old.ledgerId);
    await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: applied.value, value: '{"broken":' }]);
    // Every ledger file of the purpose is gone: the old ones were retired, the new ones never made.
    const p = env.paths('welcome');
    for (const filePath of [p.database, p.wal, p.shm, p.anchor, p.witness, p.receipt, ...Object.values(p.staged)]) {
      assert.equal(fs.existsSync(filePath), false, filePath);
    }
    const welcomeFiles = () => [env.directories.ledgerDirectory, env.directories.witnessDirectory]
      .map((directory) => Object.fromEntries(Object.entries(tree(directory)).filter(([name]) => name.includes('welcome'))));
    const before = welcomeFiles();
    assert.equal(Object.keys(before[0]).some((name) => name.endsWith('.request.json')), true);
    env.clock.value += 60_000;
    const result = await env.run();
    const report = byPurpose(result);
    assert.deepEqual([report.welcome.code, report.welcome.reason, report.welcome.created],
      ['LEDGER_REGISTRATION_INVALID', 'json', false]);
    assert.equal(report['word-chain.reaction'].code, 'LEDGER_READY');
    result.close();
    assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, '{"broken":');
    assert.deepEqual(welcomeFiles(), before);
  });

test('a reinit request for an unparsable registration counts only when written after the value', async (t) => {
  const env = await environment(t, 'reinit-invalid-time');
  (await env.run()).close();
  const old = (await registrations()).welcome;
  const stored = (await coin.readSafetyLedgerRegistrations()).welcome;
  await coin.writeSafetyLedgerRegistrations([{ purposeId: 'welcome', expectedValue: stored.value, value: '{"broken":' }]);
  const writtenMs = Date.parse((await coin.readSafetyLedgerRegistrations()).welcome.updatedAt);
  const p = env.paths('welcome');
  // Written in the same millisecond as the value, so not after it: the registration stays closed.
  await scriptLikeReinit(env, 'welcome', old.ledgerId, { nowMs: writtenMs });
  const request = layout.readRequest(p.reinitRequest, 'welcome');
  const refused = await env.run();
  assert.deepEqual([byPurpose(refused).welcome.code, byPurpose(refused).welcome.reason],
    ['LEDGER_REGISTRATION_INVALID', 'json']);
  refused.close();
  assert.equal((await coin.readSafetyLedgerRegistrations()).welcome.value, '{"broken":');
  assert.equal(fs.existsSync(p.database), false);
  assert.equal(fs.existsSync(p.reinitRequest), true);
  // One millisecond later it is a request for this value, and it is applied.
  moveAway(env, p.reinitRequest);
  await layout.writeRequest(p.reinitRequest, { ...request, requestedAtMs: writtenMs + 1 });
  const result = await env.run();
  const welcome = byPurpose(result).welcome;
  assert.deepEqual([welcome.code, welcome.notices], ['LEDGER_CREATED', ['LEDGER_REINIT_APPLIED']]);
  const registration = (await registrations()).welcome;
  assert.equal(registration.state, 'active');
  assert.deepEqual(registration.previous.map((entry) => entry.ledgerId), [old.ledgerId]);
  assert.equal(fs.existsSync(p.reinitRequest), false);
});

test('a reinit request for a creating registration must name that registration, and then starts over', async (t) => {
  const env = await environment(t, 'reinit-creating');
  await assert.rejects(env.run({ faultInjector: (event) => {
    if (event.label === 'bootstrap' && event.phase === 'after-creating-registration') throw crash('creating');
  } }), (error) => error.code === TEST_CRASH_CODE);
  const stuck = await registrations();
  await scriptLikeReinit(env, 'welcome', 'xjl2-welcome-0123456789abcdef0123456789abcdef');
  await scriptLikeReinit(env, 'word-chain.reaction', stuck['word-chain.reaction'].ledgerId);
  env.clock.value += 3_600_000;
  const result = await env.run();
  const report = byPurpose(result);
  assert.deepEqual([report.welcome.code, report.welcome.reason], ['LEDGER_REQUEST_INVALID', 'ledger-id']);
  assert.equal((await registrations()).welcome.ledgerId, stuck.welcome.ledgerId);
  const chain = report['word-chain.reaction'];
  assert.deepEqual([chain.code, chain.notices], ['LEDGER_CREATED', ['LEDGER_REINIT_APPLIED']]);
  assert.notEqual(chain.ledgerId, stuck['word-chain.reaction'].ledgerId);
  assert.equal(chain.cutoverMs, env.clock.value);
  assert.ok(chain.cutoverMs > stuck['word-chain.reaction'].cutoverMs);
  assert.equal(report['number-chain.reaction'].code, 'LEDGER_CREATION_RESUMED');
  assert.equal(report['number-chain.reaction'].cutoverMs, stuck['number-chain.reaction'].cutoverMs);
});

test('a creating registration with a final database fails closed when a file is missing or a leftover is beside it',
  async (t) => {
    const env = await environment(t, 'creating-branches');
    // The owner ledger's database was renamed (the commit point) but active never written.
    await assert.rejects(env.run({ faultInjector: (event) => {
      if (event.label === 'commit-staged-ledger' && event.phase === 'after-rename-database') throw crash('committed');
    } }), (error) => error.code === TEST_CRASH_CODE);
    const p = env.paths('owner-safety');
    const expectOwner = async (code, reason) => {
      const result = await env.run();
      const owner = byPurpose(result)['owner-safety'];
      result.close();
      assert.deepEqual([owner.code, owner.reason], [code, reason]);
      assert.equal((await registrations())['owner-safety'].state, 'creating');
    };
    const parked = moveAway(env, p.anchor);
    await expectOwner('LEDGER_PARTIAL', 'creating');
    fs.renameSync(parked, p.anchor);
    fs.writeFileSync(p.staged.receipt, 'leftover');
    await expectOwner('LEDGER_TEMP_PRESENT', 'creating');
    moveAway(env, p.staged.receipt);
    fs.writeFileSync(p.journal, '');
    await expectOwner('LEDGER_TEMP_PRESENT', 'creating');
    moveAway(env, p.journal);
    // Untouched, the same files complete the creation.
    const completed = await env.run();
    assert.equal(byPurpose(completed)['owner-safety'].code, 'LEDGER_CREATION_RESUMED');
  });

test('a creating registration with only a WAL or SHM file where the database should be fails closed', async (t) => {
  for (const companion of ['wal', 'shm']) {
    await t.test(companion, async (subtest) => {
      const env = await environment(subtest, `creating-${companion}`);
      await assert.rejects(env.run({ faultInjector: (event) => {
        if (event.label === 'commit-staged-ledger' && event.phase === 'before-rename-database') throw crash('companion');
      } }), (error) => error.code === TEST_CRASH_CODE);
      const p = env.paths('owner-safety');
      fs.writeFileSync(p[companion], '');
      const result = await env.run();
      const owner = byPurpose(result)['owner-safety'];
      assert.deepEqual([owner.code, owner.reason], ['LEDGER_PARTIAL', 'companion']);
      assert.equal(fs.existsSync(p.staged.database), true, 'nothing was retired or rebuilt');
    });
  }
});

test('a staged database left with a WAL is retired and created again once, then fails closed', async (t) => {
  const env = await environment(t, 'staging-retry');
  let injected = 0;
  const leaveWal = (limit) => (event) => {
    if (event.label === 'bootstrap' && event.phase === 'after-staged-files' && event.purposeId === 'welcome' &&
        injected < limit) {
      injected += 1;
      fs.writeFileSync(env.paths('welcome').staged.wal, Buffer.alloc(0));
    }
  };
  const once = await env.run({ faultInjector: leaveWal(1) });
  const welcome = byPurpose(once).welcome;
  assert.deepEqual([welcome.code, welcome.notices], ['LEDGER_CREATED', ['LEDGER_TEMP_RETIRED']]);
  assert.equal(injected, 1);
  const retired = fs.readdirSync(env.directories.ledgerDirectory).filter((name) => /^retired-.*-welcome-staged$/u.test(name));
  assert.equal(retired.length, 1);
  assert.ok(fs.readdirSync(path.join(env.directories.ledgerDirectory, retired[0])).includes('welcome.sqlite.creating-wal'));
  once.close();

  const always = await environment(t, 'staging-retry-twice');
  let attempts = 0;
  const failing = await always.run({ faultInjector: (event) => {
    if (event.label === 'bootstrap' && event.phase === 'after-staged-files' && event.purposeId === 'welcome') {
      attempts += 1;
      fs.writeFileSync(always.paths('welcome').staged.wal, Buffer.alloc(0));
    }
  } });
  assert.equal(attempts, 2);
  assert.deepEqual([byPurpose(failing).welcome.code, byPurpose(failing).welcome.reason],
    ['LEDGER_CREATE_FAILED', 'staging-incomplete']);
  assert.equal(byPurpose(failing)['word-chain.reaction'].code, 'LEDGER_CREATED');
  // Nothing was committed; the next start resumes the same creation.
  const creating = (await registrations()).welcome;
  assert.equal(creating.state, 'creating');
  failing.close();
  const resumed = await always.run();
  assert.deepEqual([byPurpose(resumed).welcome.code, byPurpose(resumed).welcome.ledgerId],
    ['LEDGER_CREATION_RESUMED', creating.ledgerId]);
});

test('a lastSeen that cannot be written is reported, and every ledger stays open', async (t) => {
  const env = await environment(t, 'last-seen-failure');
  (await env.run()).close();
  const before = await coin.readSafetyLedgerRegistrations();
  const result = await env.run({ registry: {
    read: () => coin.readSafetyLedgerRegistrations(),
    write: () => Promise.reject(Object.assign(new Error('synthetic lastSeen failure'), { code: 'SAFETY_REGISTRATION_WRITE_FAILED' })),
  } });
  assert.equal(result.report.lastSeen, 'failed');
  for (const item of result.report.purposes) {
    assert.deepEqual([item.status, item.code], ['ready', 'LEDGER_READY'], item.purposeId);
  }
  assert.equal(result.ledgers.size, ALL.length);
  assert.ok(env.logger.lines.some(([level, line]) => level === 'warn' && line === '[SAFETY_LEDGER] code=LEDGER_LAST_SEEN_WRITE_FAILED'));
  assert.deepEqual(await coin.readSafetyLedgerRegistrations(), before);
  // A later refresh through the same (still failing) registry rejects; its caller decides.
  await assert.rejects(result.recordLastSeen(), (error) => error.code === 'SAFETY_REGISTRATION_WRITE_FAILED');
  result.close();
  // The registration only lagged: the next start opens normally and records the counters.
  const next = await env.run();
  assert.equal(next.report.lastSeen, 'written');
  assert.ok((await registrations()).welcome.lastSeen.bootEpoch > JSON.parse(before.welcome.value).lastSeen.bootEpoch);
});

test('a leftover temporary request file is ignored and reported, never read as a request', async (t) => {
  const env = await environment(t, 'request-temp');
  (await env.run()).close();
  const p = env.paths('welcome');
  fs.writeFileSync(p.reinitRequestTemp, '{"schema":1,"kind":"reinit","purp');
  const result = await env.run();
  const welcome = byPurpose(result).welcome;
  assert.deepEqual([welcome.code, welcome.notices], ['LEDGER_READY', ['LEDGER_REQUEST_TEMP_IGNORED']]);
  assert.equal(fs.readFileSync(p.reinitRequestTemp, 'utf8'), '{"schema":1,"kind":"reinit","purp');
  assert.equal(env.logger.lines.filter(([, line]) => line.includes('purpose=welcome code=LEDGER_REQUEST_TEMP_IGNORED')).length, 1);
});

test('a bot ID only the configuration vouches for opens active ledgers and creates, completes, or reinitializes none',
  async (t) => {
    const env = await environment(t, 'unverified');
    // Nothing exists yet: every purpose fails closed, and nothing is written.
    let result = await env.run({ identityVerified: false });
    assert.equal(result.ledgers.size, 0);
    assert.deepEqual(result.report.purposes.map((item) => [item.purposeId, item.status, item.code, item.reason]),
      ALL.map((purposeId) => [purposeId, 'failed', 'LEDGER_IDENTITY_UNVERIFIED', 'configured']));
    assert.deepEqual(await registrations(), {});
    assert.deepEqual([fs.existsSync(env.directories.ledgerDirectory), fs.existsSync(env.directories.witnessDirectory)],
      [false, false]);
    result.close();

    // A creation left half done is not completed for an unverified ID either.
    await assert.rejects(env.run({ faultInjector: (event) => {
      if (event.label === 'bootstrap' && event.phase === 'after-creating-registration') throw crash('creating');
    } }), (error) => error.code === TEST_CRASH_CODE);
    const creating = await registrations();
    assert.ok(ALL.every((purposeId) => creating[purposeId].state === 'creating'));
    result = await env.run({ identityVerified: false });
    assert.equal(result.ledgers.size, 0);
    assert.ok(result.report.purposes.every((item) => item.code === 'LEDGER_IDENTITY_UNVERIFIED'));
    assert.deepEqual(await registrations(), creating);
    assert.equal(fs.existsSync(env.directories.ledgerDirectory), false);
    result.close();

    // A start with the ID read from the token completes them; an unverified start then
    // opens them as they are.
    result = await env.run();
    assert.ok(result.report.purposes.every((item) => item.code === 'LEDGER_CREATION_RESUMED'));
    result.close();
    result = await env.run({ identityVerified: false });
    assert.equal(result.ledgers.size, ALL.length);
    assert.ok(result.report.purposes.every((item) => item.code === 'LEDGER_READY'));
    result.close();

    // A pending reinit request waits for a start with the verified ID.
    const old = (await registrations()).welcome;
    await scriptLikeReinit(env, 'welcome', old.ledgerId);
    env.clock.value += 60_000;
    result = await env.run({ identityVerified: false });
    assert.deepEqual([byPurpose(result).welcome.code, byPurpose(result).welcome.reason],
      ['LEDGER_IDENTITY_UNVERIFIED', 'configured']);
    assert.equal(byPurpose(result)['work.penalty.announce'].code, 'LEDGER_READY');
    assert.equal(fs.existsSync(env.paths('welcome').reinitRequest), true);
    assert.equal((await registrations()).welcome.ledgerId, old.ledgerId);
    result.close();
    result = await env.run();
    assert.deepEqual([byPurpose(result).welcome.code, byPurpose(result).welcome.notices],
      ['LEDGER_CREATED', ['LEDGER_REINIT_APPLIED']]);
    result.close();
  });
