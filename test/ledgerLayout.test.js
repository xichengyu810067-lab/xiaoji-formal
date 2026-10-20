'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { classifyPathLocality } = require('../src/systems/safety/ledgerStore');
const {
  PUBLIC_PURPOSES,
  pathsFor,
  quarantineStampPathFor,
} = require('../src/systems/safety/sideEffectLedger');
const layout = require('../src/systems/safety/ledgerLayout');
const { TEST_DATA_ROOT_MARKER } = require('../src/platform/testControlPolicy');

const BOT_ID = '10000000000000001';
const OWNER_ID = '10000000000000002';

function workspace(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `xiaoji-ledger-layout-${prefix}-`)));
  const cleanups = [];
  t.after(() => {
    while (cleanups.length) {
      try { cleanups.pop()(); } catch {}
    }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });
  return { root, defer: (cleanup) => cleanups.push(cleanup) };
}

// A project root of its own, so the "outside the project" rule can be exercised.
function projectIn(root) {
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  return project;
}

function code(expected, reason) {
  return (error) => error instanceof layout.LedgerLayoutError && error.code === expected &&
    (reason === undefined || error.reason === reason);
}

function registrationFor(purposeId, overrides = {}) {
  const purpose = layout.SAFETY_LEDGER_PURPOSES[purposeId];
  const base = path.join(os.tmpdir(), 'xiaoji-layout-registration');
  return {
    schema: 1,
    state: 'active',
    purposeId,
    kind: purpose.kind,
    ledgerId: layout.generateLedgerId(purposeId),
    runtimeMode: 'production',
    botId: BOT_ID,
    ownerId: purpose.kind === 'owner' ? OWNER_ID : null,
    genesisMs: 1_000,
    cutoverMs: layout.cutoverFor(purposeId, 1_000),
    paths: {
      database: path.join(base, 'safety', `${purpose.stem}.sqlite`),
      anchor: path.join(base, 'safety', `${purpose.stem}.sqlite.witness`),
      witness: path.join(base, 'safety-witness', `${purpose.stem}.witness`),
      receipt: path.join(base, 'safety', `${purpose.stem}.sqlite.provenance.json`),
    },
    receiptSha256: 'a'.repeat(64),
    lastSeen: { bootEpoch: 2, beginSeq: 5, chainHead: 'b'.repeat(64), atMs: 2_000 },
    quarantine: null,
    createdBy: 'bootstrap',
    previous: [],
    ...overrides,
  };
}

test('every protected purpose has one ledger whose paths match the facade layout', (t) => {
  const { root } = workspace(t, 'paths');
  const directories = { ledgerDirectory: path.join(root, 'safety'), witnessDirectory: path.join(root, 'safety-witness') };
  assert.deepEqual(layout.PURPOSE_IDS, ['owner-safety', 'welcome', 'work.penalty.announce', 'work.reminder.dm.prepare',
    'work.reminder.dm.send', 'audit.guild.leave', 'word-chain.reaction', 'number-chain.reaction']);
  for (const purposeId of Object.keys(PUBLIC_PURPOSES)) {
    assert.equal(layout.SAFETY_LEDGER_PURPOSES[purposeId].kind, 'public');
  }
  assert.equal(layout.SAFETY_LEDGER_PURPOSES['owner-safety'].kind, 'owner');
  const stems = new Set();
  for (const purposeId of layout.PURPOSE_IDS) {
    const paths = layout.purposePaths(directories, purposeId);
    const facade = pathsFor(paths.database);
    stems.add(paths.stem);
    assert.equal(path.dirname(paths.database), directories.ledgerDirectory);
    assert.equal(paths.anchor, facade.anchorPath);
    assert.equal(paths.receipt, facade.receiptPath);
    assert.equal(paths.marker, facade.retainedLockPath);
    assert.equal(paths.wal, facade.walPath);
    assert.equal(path.dirname(paths.witness), directories.witnessDirectory);
    assert.equal(paths.stamp, quarantineStampPathFor(paths.witness));
    for (const [role, staged] of Object.entries(paths.staged)) {
      assert.ok(staged.includes('.creating'), role);
    }
    assert.equal(paths.staged.wal, `${paths.staged.database}-wal`);
    assert.equal(path.dirname(paths.reinitRequest), directories.ledgerDirectory);
    assert.equal(path.dirname(paths.releaseRequest), directories.ledgerDirectory);
  }
  assert.equal(stems.size, layout.PURPOSE_IDS.length);
  // Cutover per purpose: the creation time, except automatic leaves and Owner notices.
  assert.equal(layout.cutoverFor('welcome', 5_000), 5_000);
  assert.equal(layout.cutoverFor('word-chain.reaction', 5_000), 5_000);
  assert.equal(layout.cutoverFor('work.penalty.announce', 5_000), 5_000);
  assert.equal(layout.cutoverFor('audit.guild.leave', 5_000), 0);
  assert.equal(layout.cutoverFor('owner-safety', 5_000), 0);
});

test('directories default to the data root or the coin database folder and are never created by resolution', (t) => {
  const { root } = workspace(t, 'defaults');
  const project = projectIn(root);
  const dataRoot = path.join(root, 'data-root');
  fs.mkdirSync(dataRoot);
  const fromRoot = layout.resolveLedgerDirectories({ env: { XIAOJI_DATA_ROOT: dataRoot }, runtimeMode: 'production',
    projectRoot: project });
  assert.equal(fromRoot.base, dataRoot);
  assert.equal(fromRoot.ledgerDirectory, path.join(dataRoot, 'safety'));
  assert.equal(fromRoot.witnessDirectory, path.join(dataRoot, 'safety-witness'));
  assert.equal(fromRoot.ledgerDirectoryExists, false);
  assert.deepEqual(fs.readdirSync(dataRoot), []);

  const coinFolder = path.join(root, 'coin-folder');
  fs.mkdirSync(coinFolder);
  const fromCoin = layout.resolveLedgerDirectories({ env: {}, runtimeMode: 'production',
    coinDbPath: path.join(coinFolder, 'xiaoji.sqlite'), projectRoot: project });
  assert.equal(fromCoin.base, coinFolder);
  assert.deepEqual(fs.readdirSync(coinFolder), []);

  layout.ensureLedgerDirectories(fromRoot);
  assert.deepEqual(fs.readdirSync(dataRoot).sort(), ['safety', 'safety-witness']);
  // Idempotent; a missing parent is never created.
  layout.ensureLedgerDirectories(fromRoot);
  assert.throws(() => layout.ensureLedgerDirectories({ ledgerDirectory: path.join(root, 'absent', 'safety'),
    witnessDirectory: path.join(dataRoot, 'safety-witness') }), code('LEDGER_PATH_INVALID'));
  assert.equal(fs.existsSync(path.join(root, 'absent')), false);
});

test('ledger and witness directories must be distinct, not nested, existing overrides, and outside the project',
  (t) => {
    const { root } = workspace(t, 'overrides');
    const project = projectIn(root);
    const dataRoot = path.join(root, 'data');
    const ledgerDir = path.join(root, 'ledgers');
    const witnessDir = path.join(root, 'witnesses');
    for (const directory of [dataRoot, ledgerDir, witnessDir]) fs.mkdirSync(directory);
    const resolve = (env, projectRoot = project) => layout.resolveLedgerDirectories({
      env: { XIAOJI_DATA_ROOT: dataRoot, ...env }, runtimeMode: 'production', projectRoot });
    const resolved = resolve({ XIAOJI_SAFETY_LEDGER_DIR: ledgerDir, XIAOJI_SAFETY_WITNESS_DIR: witnessDir });
    assert.equal(resolved.ledgerDirectory, ledgerDir);
    assert.equal(resolved.witnessDirectory, witnessDir);
    assert.throws(() => resolve({ XIAOJI_SAFETY_LEDGER_DIR: path.join(root, 'missing') }),
      code('LEDGER_PATH_INVALID', 'ledger-directory-missing'));
    assert.throws(() => resolve({ XIAOJI_SAFETY_LEDGER_DIR: ledgerDir, XIAOJI_SAFETY_WITNESS_DIR: ledgerDir }),
      code('LEDGER_PATH_OVERLAP'));
    const nested = path.join(ledgerDir, 'inner');
    fs.mkdirSync(nested);
    assert.throws(() => resolve({ XIAOJI_SAFETY_LEDGER_DIR: ledgerDir, XIAOJI_SAFETY_WITNESS_DIR: nested }),
      code('LEDGER_PATH_OVERLAP'));
    assert.throws(() => resolve({ XIAOJI_SAFETY_LEDGER_DIR: 'relative/dir' }), code('LEDGER_PATH_INVALID'));
    // The project: a base inside it, an override inside it, or an override containing it.
    const projectData = path.join(project, 'data');
    fs.mkdirSync(projectData);
    assert.throws(() => layout.resolveLedgerDirectories({ env: { XIAOJI_DATA_ROOT: projectData },
      runtimeMode: 'production', projectRoot: project }), code('LEDGER_PATH_IN_PROJECT', 'base'));
    assert.throws(() => layout.resolveLedgerDirectories({ env: {}, runtimeMode: 'production',
      coinDbPath: path.join(projectData, 'xiaoji.sqlite'), projectRoot: project }), code('LEDGER_PATH_IN_PROJECT', 'base'));
    assert.throws(() => resolve({ XIAOJI_SAFETY_WITNESS_DIR: projectData }), code('LEDGER_PATH_IN_PROJECT', 'witness-directory'));
    const outer = path.join(root, 'outer');
    const outerProject = path.join(outer, 'project');
    fs.mkdirSync(outerProject, { recursive: true });
    assert.throws(() => resolve({ XIAOJI_SAFETY_LEDGER_DIR: outer, XIAOJI_SAFETY_WITNESS_DIR: witnessDir }, outerProject),
      code('LEDGER_PATH_IN_PROJECT', 'ledger-directory'));
    assert.throws(() => layout.resolveLedgerDirectories({ env: {}, runtimeMode: 'production', projectRoot: project }),
      code('LEDGER_PATH_INVALID', 'base'));
    assert.throws(() => layout.resolveLedgerDirectories({ env: {}, runtimeMode: 'staging' }),
      code('LEDGER_CONFIGURATION_INVALID'));
  });

test('UNC, device, and network paths are refused before any file system access', (t) => {
  const { root } = workspace(t, 'remote');
  const project = projectIn(root);
  const dataRoot = path.join(root, 'data');
  fs.mkdirSync(dataRoot);
  // Mixed separators only become UNC paths when Windows resolves them; elsewhere they are
  // ordinary (if odd) local names.
  const mixed = process.platform === 'win32' ? ['/\\server\\share\\data', '\\/server/share/data'] : [];
  const remotePaths = ['\\\\localhost\\c$\\xiaoji-data', '\\\\server\\share\\data', '//server/share/data',
    '\\\\?\\C:\\xiaoji-data', '\\\\.\\C:\\xiaoji-data', ...mixed];
  const calls = [];
  const originals = { lstatSync: fs.lstatSync, statSync: fs.statSync, realpathSync: fs.realpathSync };
  for (const name of Object.keys(originals)) {
    fs[name] = function spy(target, ...rest) {
      calls.push([name, String(target)]);
      return originals[name].call(this, target, ...rest);
    };
  }
  fs.realpathSync.native = originals.realpathSync.native;
  try {
    for (const remote of remotePaths) {
      calls.length = 0;
      assert.throws(() => layout.resolveLedgerDirectories({ env: { XIAOJI_DATA_ROOT: remote }, runtimeMode: 'production',
        projectRoot: project }), code('LEDGER_PATH_REMOTE', 'base'), remote);
      assert.deepEqual(calls.filter(([, target]) => /server|localhost|\\\\[?.]\\/u.test(target)), [], remote);
      assert.throws(() => layout.resolveLedgerDirectories({ env: { XIAOJI_DATA_ROOT: dataRoot,
        XIAOJI_SAFETY_WITNESS_DIR: remote }, runtimeMode: 'production', projectRoot: project }),
      code('LEDGER_PATH_REMOTE', 'witness-directory'), remote);
    }
  } finally {
    Object.assign(fs, originals);
  }
  // Mapped network drives (Windows) and network file systems (Linux) are recognized from
  // the native real path and the file system type; macOS is checked by prefix only.
  const probe = (platform, real, type) => ({ platform, realpathNative: () => real, statfs: () => ({ type }) });
  assert.equal(classifyPathLocality('Z:\\data', probe('win32', '\\\\nas\\share\\data', 0)), 'network-drive');
  if (process.platform === 'win32') {
    assert.equal(classifyPathLocality('/\\nas\\share', probe('win32', 'C:\\never-called', 0)), 'unc-prefix');
    // A registration naming a mixed-separator UNC path is not a valid registration.
    const registration = registrationFor('welcome');
    assert.throws(() => layout.encodeRegistration('welcome', { ...registration,
      paths: { ...registration.paths, witness: '/\\server\\share\\welcome.witness' } }),
    code('LEDGER_REGISTRATION_INVALID', 'paths'));
  }
  assert.equal(classifyPathLocality('C:\\data', probe('win32', 'C:\\data', 0)), null);
  assert.equal(classifyPathLocality('/mnt/nfs', probe('linux', '/mnt/nfs', 0x6969)), 'network-nfs');
  assert.equal(classifyPathLocality('/mnt/smb', probe('linux', '/mnt/smb', 0xff534d42)), 'network-cifs');
  assert.equal(classifyPathLocality('/mnt/smb', probe('linux', '/mnt/smb', -11317950)), 'network-cifs');
  assert.equal(classifyPathLocality('/mnt/fuse', probe('linux', '/mnt/fuse', 0x65735546)), 'network-fuse');
  assert.equal(classifyPathLocality('/var/data', probe('linux', '/var/data', 0xef53)), null);
  assert.equal(classifyPathLocality('/Volumes/share', probe('darwin', '/Volumes/share', 24)), null);
  assert.equal(classifyPathLocality('//server/share', probe('linux', '/', 0)), 'unc-prefix');
});

test('a junction in the base or a directory override is refused', (t) => {
  const { root, defer } = workspace(t, 'junction');
  const project = projectIn(root);
  const real = path.join(root, 'real');
  fs.mkdirSync(real);
  const junction = path.join(root, 'junction');
  fs.symlinkSync(real, junction, 'junction');
  defer(() => fs.unlinkSync(junction));
  assert.throws(() => layout.resolveLedgerDirectories({ env: { XIAOJI_DATA_ROOT: junction }, runtimeMode: 'production',
    projectRoot: project }), code('LEDGER_PATH_LINKED', 'base'));
  assert.throws(() => layout.resolveLedgerDirectories({ env: { XIAOJI_DATA_ROOT: real, XIAOJI_SAFETY_LEDGER_DIR: junction },
    runtimeMode: 'production', projectRoot: project }), code('LEDGER_PATH_LINKED', 'ledger-directory'));
  fs.mkdirSync(path.join(real, 'linked-target'));
  fs.symlinkSync(path.join(real, 'linked-target'), path.join(real, 'safety'), 'junction');
  defer(() => fs.unlinkSync(path.join(real, 'safety')));
  assert.throws(() => layout.resolveLedgerDirectories({ env: { XIAOJI_DATA_ROOT: real }, runtimeMode: 'production',
    projectRoot: project }), code('LEDGER_PATH_LINKED', 'ledger-directory'));
});

test('test-control keeps both directories inside the data root; production refuses a test-marked root', (t) => {
  const { root } = workspace(t, 'test-root');
  const project = projectIn(root);
  const dataRoot = path.join(root, 'test-data');
  const outside = path.join(root, 'outside');
  fs.mkdirSync(dataRoot);
  fs.mkdirSync(outside);
  const policy = { dataRoot, expectedApplicationId: '20000000000000001' };
  const resolved = layout.resolveLedgerDirectories({ env: {}, runtimeMode: 'test-control', policy, projectRoot: project });
  assert.equal(resolved.ledgerDirectory, path.join(dataRoot, 'safety'));
  assert.throws(() => layout.resolveLedgerDirectories({ env: { XIAOJI_SAFETY_WITNESS_DIR: outside },
    runtimeMode: 'test-control', policy, projectRoot: project }), code('LEDGER_PATH_OUTSIDE_TEST_ROOT', 'witness-directory'));
  // The data root itself is not a ledger directory either.
  assert.throws(() => layout.resolveLedgerDirectories({ env: { XIAOJI_SAFETY_LEDGER_DIR: dataRoot,
    XIAOJI_SAFETY_WITNESS_DIR: outside }, runtimeMode: 'test-control', policy, projectRoot: project }),
  code('LEDGER_PATH_OUTSIDE_TEST_ROOT', 'ledger-directory'));
  assert.throws(() => layout.resolveLedgerDirectories({ env: {}, runtimeMode: 'test-control', policy: {},
    projectRoot: project }), code('LEDGER_PATH_INVALID', 'test-root'));
  fs.writeFileSync(path.join(dataRoot, TEST_DATA_ROOT_MARKER), '{}');
  assert.throws(() => layout.resolveLedgerDirectories({ env: { XIAOJI_DATA_ROOT: dataRoot }, runtimeMode: 'production',
    projectRoot: project }), code('LEDGER_TEST_ROOT_IN_PRODUCTION'));
});

test('registrations carry every field, are strictly validated, and encode in a fixed order within 4 KiB', () => {
  for (const purposeId of layout.PURPOSE_IDS) {
    const registration = registrationFor(purposeId);
    const encoded = layout.encodeRegistration(purposeId, registration);
    assert.ok(Buffer.byteLength(encoded) <= layout.REGISTRATION_MAX_BYTES);
    const decoded = layout.decodeRegistration(purposeId, encoded);
    assert.deepEqual(Object.keys(decoded).sort(), ['botId', 'createdBy', 'cutoverMs', 'genesisMs', 'kind', 'lastSeen',
      'ledgerId', 'ownerId', 'paths', 'previous', 'purposeId', 'quarantine', 'receiptSha256', 'runtimeMode', 'schema',
      'state']);
    assert.equal(layout.encodeRegistration(purposeId, decoded), encoded);
    // Fixed key order: the same content in another insertion order encodes identically.
    const reversed = Object.fromEntries(Object.entries(registration).reverse());
    assert.equal(layout.encodeRegistration(purposeId, reversed), encoded);
    assert.deepEqual(Object.keys(JSON.parse(encoded)), Object.keys(JSON.parse(encoded)).sort());
  }
  const invalid = (purposeId, value, reason) => assert.throws(
    () => layout.decodeRegistration(purposeId, typeof value === 'string' ? value : JSON.stringify(value)),
    code('LEDGER_REGISTRATION_INVALID', reason));
  const base = registrationFor('welcome');
  const { quarantine: _dropped, ...missingField } = base;
  invalid('welcome', missingField, 'fields');
  invalid('welcome', { ...base, extra: true }, 'fields');
  invalid('welcome', { ...base, schema: 2 }, 'schema');
  invalid('welcome', { ...base, state: 'deleted' }, 'state');
  invalid('welcome', { ...base, purposeId: 'word-chain.reaction' }, 'purpose');
  invalid('welcome', { ...base, kind: 'owner' }, 'kind');
  invalid('welcome', { ...base, ownerId: OWNER_ID }, 'owner');
  invalid('owner-safety', { ...registrationFor('owner-safety'), ownerId: null }, 'owner');
  invalid('owner-safety', { ...registrationFor('owner-safety'), ownerId: BOT_ID }, 'owner');
  invalid('welcome', { ...base, botId: 'not-a-snowflake' }, 'bot');
  invalid('welcome', { ...base, runtimeMode: 'staging' }, 'runtime-mode');
  invalid('welcome', { ...base, receiptSha256: null }, 'receipt');
  invalid('welcome', { ...base, state: 'creating' }, 'receipt');
  invalid('welcome', { ...base, lastSeen: { bootEpoch: 1, beginSeq: 0, chainHead: 'z' } }, 'last-seen');
  invalid('welcome', { ...base, quarantine: { requestedAtMs: 1, reason: 'has space', ledgerId: base.ledgerId } }, 'quarantine');
  invalid('welcome', { ...base, paths: { ...base.paths, witness: 'relative.witness' } }, 'paths');
  invalid('welcome', { ...base, paths: { ...base.paths, witness: '\\\\server\\share\\w.witness' } }, 'paths');
  invalid('welcome', { ...base, createdBy: 'operator' }, 'created-by');
  invalid('welcome', { ...base, previous: Array.from({ length: 9 }, (_, index) => ({ ledgerId: `old-${index}`,
    retiredAtMs: index, reason: 'reinit' })) }, 'previous');
  invalid('welcome', '{not json', 'json');
  invalid('welcome', 'x'.repeat(layout.REGISTRATION_MAX_BYTES + 1), 'size');
  // Long paths: the oldest previous entries are dropped to stay within 4 KiB.
  const longDirectory = path.join(os.tmpdir(), 'x'.repeat(250));
  const long = registrationFor('welcome', {
    paths: Object.fromEntries(Object.entries(base.paths).map(([role]) => [role, path.join(longDirectory, `${role}-${'y'.repeat(400)}`)])),
    previous: Array.from({ length: 8 }, (_, index) => ({ ledgerId: `xjl2-welcome-${String(index).repeat(32).slice(0, 32)}`,
      retiredAtMs: 1_000 + index, reason: 'reinit-after-operator-review' })),
  });
  const trimmed = layout.decodeRegistration('welcome', layout.encodeRegistration('welcome', long));
  assert.ok(trimmed.previous.length < 8);
  assert.deepEqual(trimmed.previous, long.previous.slice(0, trimmed.previous.length));
});

test('a registration write time is read only in the exact toISOString form, otherwise it is unknown', () => {
  const at = new Date(Date.UTC(2026, 9, 3, 4, 5, 6, 7));
  assert.equal(layout.registrationTimeMs(at.toISOString()), at.getTime());
  for (const value of [undefined, null, '', 'null', String(at.getTime()), '2026-10-03 04:05:06', '2026-10-03T04:05:06Z',
    '2026-10-03T04:05:06.007+08:00', '2026-13-03T04:05:06.007Z', ` ${at.toISOString()}`,
    // Impossible dates and times that Date.parse would roll forward.
    '2026-02-30T00:00:00.000Z', '2026-04-31T00:00:00.000Z', '2026-10-03T24:00:00.000Z']) {
    assert.equal(layout.registrationTimeMs(value), null, String(value));
  }
  assert.equal(layout.registrationTimeMs('2028-02-29T23:59:59.999Z'), Date.UTC(2028, 1, 29, 23, 59, 59, 999));
});

test('ledger IDs end in a random part whose first eight digits confirm operator commands', () => {
  const fixed = () => Buffer.from('0123456789abcdef0123456789abcdef', 'hex');
  const ledgerId = layout.generateLedgerId('work.penalty.announce', fixed);
  assert.equal(ledgerId, 'xjl2-work-penalty-announce-0123456789abcdef0123456789abcdef');
  assert.equal(layout.confirmationCode(ledgerId), '01234567');
  assert.match(layout.confirmationCode('welcome-v1-legacy'), /^[a-f0-9]{8}$/u);
  assert.notEqual(layout.generateLedgerId('welcome'), layout.generateLedgerId('welcome'));
});

test('retiring files moves them with a manifest, never deletes, and requests are strict and consumed once', async (t) => {
  const { root } = workspace(t, 'retire');
  const directory = path.join(root, 'safety');
  fs.mkdirSync(directory);
  const first = path.join(directory, 'welcome.sqlite.creating');
  const second = path.join(directory, 'welcome.sqlite.witness.creating');
  fs.writeFileSync(first, 'staged database');
  fs.writeFileSync(second, 'staged witness');
  const nowMs = Date.UTC(2026, 9, 3, 1, 2, 3, 456);
  assert.equal(await layout.retireFiles({ directory, purposeId: 'welcome', reason: 'staged', nowMs, createdBy: 'bootstrap',
    files: [{ role: 'absent', filePath: path.join(directory, 'absent') }] }), null);
  const retired = await layout.retireFiles({ directory, purposeId: 'welcome', ledgerId: 'xjl2-welcome-x', reason: 'staged',
    nowMs, createdBy: 'bootstrap', files: [{ role: 'database', filePath: first }, { role: 'anchor', filePath: second },
      { role: 'absent', filePath: path.join(directory, 'absent') }] });
  assert.equal(retired.name, 'retired-20261003T010203456Z-welcome-staged');
  assert.match(retired.name, layout.RETIRED_NAME);
  assert.deepEqual(retired.moved, ['database', 'anchor']);
  assert.equal(fs.existsSync(first), false);
  assert.equal(fs.readFileSync(path.join(retired.path, 'welcome.sqlite.creating'), 'utf8'), 'staged database');
  const manifest = layout.readManifest(retired.path);
  assert.equal(manifest.ledgerId, 'xjl2-welcome-x');
  assert.deepEqual(manifest.files.map((file) => file.role), ['database', 'anchor']);
  // A second retirement in the same millisecond gets its own directory.
  fs.writeFileSync(first, 'again');
  const again = await layout.retireFiles({ directory, purposeId: 'welcome', reason: 'staged', nowMs,
    createdBy: 'bootstrap', files: [{ role: 'database', filePath: first }] });
  assert.equal(again.name, 'retired-20261003T010203456Z-welcome-staged-2');
  const empty = await layout.retireFiles({ directory, purposeId: 'welcome', reason: 'reinit', nowMs, createdBy: 'script',
    files: [], allowEmpty: true });
  assert.deepEqual(layout.readManifest(empty.path).files, []);
  // Files outside the directory are never moved across directories.
  const elsewhere = path.join(root, 'elsewhere.txt');
  fs.writeFileSync(elsewhere, 'x');
  await assert.rejects(layout.retireFiles({ directory, purposeId: 'welcome', reason: 'staged', nowMs,
    createdBy: 'bootstrap', files: [{ role: 'other', filePath: elsewhere }] }), code('LEDGER_CONFIGURATION_INVALID'));

  const requestPath = path.join(directory, 'reinit-welcome.request.json');
  const request = { schema: 1, kind: 'reinit', purposeId: 'welcome', ledgerId: 'xjl2-welcome-x', requestedAtMs: nowMs,
    retired: { ledgerDirectory: retired.name, witnessDirectory: null } };
  // An interrupted earlier write left half a request in the temporary file: it is never
  // read as a request, and the next write replaces it and renames a complete one.
  const tempPath = layout.requestTempPath(requestPath);
  fs.writeFileSync(tempPath, '{"schema":1,"kind":"rei');
  assert.equal(layout.readRequest(requestPath, 'welcome'), null);
  await layout.writeRequest(requestPath, request);
  assert.equal(fs.existsSync(tempPath), false);
  await assert.rejects(layout.writeRequest(requestPath, request), code('LEDGER_REQUEST_INVALID', 'exists'));
  assert.deepEqual(layout.readRequest(requestPath, 'welcome'), request);
  assert.throws(() => layout.readRequest(requestPath, 'word-chain.reaction'), code('LEDGER_REQUEST_INVALID', 'format'));
  assert.equal(layout.readRequest(path.join(directory, 'none.request.json'), 'welcome'), null);
  const consumed = await layout.consumeRequest(requestPath, retired.path, 'reinit');
  assert.equal(fs.existsSync(requestPath), false);
  assert.equal(path.basename(consumed), 'reinit.request.json');
  fs.writeFileSync(requestPath, JSON.stringify({ ...request, retired: { ledgerDirectory: '../escape', witnessDirectory: null } }));
  assert.throws(() => layout.readRequest(requestPath, 'welcome'), code('LEDGER_REQUEST_INVALID', 'format'));
  // Anything other than a plain file at the temporary name is never written through.
  const otherRequest = path.join(directory, 'release-quarantine-welcome.request.json');
  fs.mkdirSync(layout.requestTempPath(otherRequest));
  await assert.rejects(layout.writeRequest(otherRequest, { ...request, kind: 'release-quarantine' }),
    code('LEDGER_REQUEST_INVALID', 'temp'));
  assert.equal(fs.existsSync(otherRequest), false);
});

test('a request write is a temporary file, fsynced, then renamed: a crash leaves no half request', async (t) => {
  const { root } = workspace(t, 'request-order');
  const directory = path.join(root, 'safety');
  fs.mkdirSync(directory);
  const requestPath = path.join(directory, 'reinit-welcome.request.json');
  const calls = [];
  const originals = { openSync: fs.openSync, fsyncSync: fs.fsyncSync, renameSync: fs.renameSync };
  const descriptors = new Map();
  fs.openSync = (target, ...rest) => {
    const descriptor = originals.openSync(target, ...rest);
    if (String(target).startsWith(directory)) {
      descriptors.set(descriptor, path.basename(String(target)));
      calls.push(['open', path.basename(String(target)), rest[0]]);
    }
    return descriptor;
  };
  fs.fsyncSync = (descriptor) => {
    if (descriptors.has(descriptor)) calls.push(['fsync', descriptors.get(descriptor)]);
    return originals.fsyncSync(descriptor);
  };
  fs.renameSync = (from, to) => {
    calls.push(['rename', path.basename(String(from)), path.basename(String(to))]);
    return originals.renameSync(from, to);
  };
  try {
    await layout.writeRequest(requestPath, { schema: 1, kind: 'reinit', purposeId: 'welcome', ledgerId: null,
      requestedAtMs: 1, retired: { ledgerDirectory: 'retired-20261003T000000000Z-welcome-reinit', witnessDirectory: null } });
  } finally {
    Object.assign(fs, originals);
  }
  assert.deepEqual(calls.slice(0, 3), [
    ['open', 'reinit-welcome.request.json.tmp', 'w'],
    ['fsync', 'reinit-welcome.request.json.tmp'],
    ['rename', 'reinit-welcome.request.json.tmp', 'reinit-welcome.request.json'],
  ]);
  assert.deepEqual(fs.readdirSync(directory), ['reinit-welcome.request.json']);
});
