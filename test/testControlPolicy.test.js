'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { Routes } = require('discord-api-types/v10');
const {
  TEST_DATA_ROOT_MARKER,
  SYNTHETIC_REGISTRY_SYMBOL,
  assertTestDataRoot,
  loadTestControlPolicy,
  preflightTestIdentity,
  readDataRootIdentity,
} = require('../src/platform/testControlPolicy');
const { startRuntime } = require('../src/platform/startupSequence');
const { IDS, createFixture, writeTestRootMarker } = require('./testControlSupport');

function assertPolicyRejects(env, code, message) {
  assert.throws(() => loadTestControlPolicy(env, { cwd: process.cwd(), logger: { warn() {} } }),
    (error) => error.code === code, message);
}

// Computed here, independently of the policy, to pin the on-disk contract.
function directoryIdentity(directory) {
  const stat = fs.lstatSync(directory, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
}

function markerJson(root, overrides = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    purpose: 'xiaoji-test-control-data-root',
    expectedApplicationId: IDS.app,
    dataRootIdentity: directoryIdentity(root),
    ...overrides,
  });
}

function relocatedEnv(env, fromRoot, toRoot) {
  const relocated = {};
  for (const [key, value] of Object.entries(env)) {
    relocated[key] = typeof value === 'string' && value.startsWith(fromRoot)
      ? `${toRoot}${value.slice(fromRoot.length)}` : value;
  }
  return relocated;
}

test('a marked isolated test data root passes with the documented marker format', () => {
  const fixture = createFixture();
  try {
    assert.equal(TEST_DATA_ROOT_MARKER, '.xiaoji-test-root.json');
    assert.equal(fixture.markerPath, path.join(fixture.root, '.xiaoji-test-root.json'));
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(fixture.markerPath, 'utf8'))).sort(),
      ['dataRootIdentity', 'expectedApplicationId', 'purpose', 'schemaVersion']);
    // Written by hand so the on-disk contract is pinned independently of the serializer.
    fs.writeFileSync(fixture.markerPath, markerJson(fixture.root));
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    assert.equal(policy.expectedApplicationId, IDS.app);
    assert.equal(policy.dataRoot, fs.realpathSync.native(fixture.root));
    fs.writeFileSync(fixture.markerPath, `${String.fromCharCode(0xFEFF)}${markerJson(fixture.root)}\r\n`);
    assert.equal(loadTestControlPolicy(fixture.env, { cwd: process.cwd() }).expectedApplicationId, IDS.app);
  } finally { fixture.cleanup(); }
});

test('a preloaded synthetic registry can only extend actors for the same active test policy', () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const syntheticId = IDS.otherGuild;
    globalThis[SYNTHETIC_REGISTRY_SYMBOL] = Object.freeze({
      active: true,
      dataRoot: policy.dataRoot,
      expectedApplicationId: policy.expectedApplicationId,
      allowsActor: (id) => id === syntheticId,
    });
    assert.equal(policy.allowsActor(syntheticId), true);
    globalThis[SYNTHETIC_REGISTRY_SYMBOL] = Object.freeze({
      active: true,
      dataRoot: 'C:\\wrong-root',
      expectedApplicationId: policy.expectedApplicationId,
      allowsActor: () => true,
    });
    assert.equal(policy.allowsActor(syntheticId), false);
  } finally {
    delete globalThis[SYNTHETIC_REGISTRY_SYMBOL];
    fixture.cleanup();
  }
});

test('the marker is bound to its directory: a full copy is refused, a same-volume rename is kept', () => {
  const fixture = createFixture();
  try {
    const copiedRoot = path.join(fixture.parent, 'copied-data');
    fs.cpSync(fixture.root, copiedRoot, { recursive: true });
    assert.deepEqual(fs.readFileSync(path.join(copiedRoot, TEST_DATA_ROOT_MARKER)), fs.readFileSync(fixture.markerPath));
    assert.notEqual(directoryIdentity(copiedRoot), directoryIdentity(fixture.root));
    const copiedEnv = relocatedEnv(fixture.env, fixture.root, copiedRoot);
    assertPolicyRejects(copiedEnv, 'TEST_DATA_ROOT_MARKER_IDENTITY_MISMATCH', 'copied directory');
    assert.throws(() => assertTestDataRoot({ dataRoot: copiedRoot, expectedApplicationId: IDS.app }),
      (error) => error.code === 'TEST_DATA_ROOT_MARKER_IDENTITY_MISMATCH');
    fs.writeFileSync(path.join(copiedRoot, TEST_DATA_ROOT_MARKER), markerJson(copiedRoot, { dataRootIdentity: '1:2' }));
    assertPolicyRejects(copiedEnv, 'TEST_DATA_ROOT_MARKER_IDENTITY_MISMATCH', 'forged identity');

    const identity = directoryIdentity(fixture.root);
    const renamedRoot = path.join(fixture.parent, 'renamed-data');
    fs.renameSync(fixture.root, renamedRoot);
    assert.equal(directoryIdentity(renamedRoot), identity);
    const renamedEnv = relocatedEnv(fixture.env, fixture.root, renamedRoot);
    assert.equal(loadTestControlPolicy(renamedEnv, { cwd: process.cwd() }).dataRoot, fs.realpathSync.native(renamedRoot));
  } finally { fixture.cleanup(); }
});

test('a data root inside any Git checkout is refused, while an empty .git directory is not a checkout', () => {
  const fixture = createFixture();
  try {
    const parentGit = path.join(fixture.parent, '.git');
    fs.mkdirSync(parentGit);
    fs.writeFileSync(path.join(parentGit, 'HEAD'), 'ref: refs/heads/main\n');
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_IN_REPOSITORY', 'main checkout above the data root');
    fs.rmSync(parentGit, { recursive: true });

    fs.writeFileSync(parentGit, 'gitdir: C:/synthetic/.git/worktrees/test\n');
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_IN_REPOSITORY', 'linked worktree above the data root');
    fs.rmSync(parentGit);

    const ownGit = path.join(fixture.root, '.git');
    fs.writeFileSync(ownGit, 'gitdir: C:/synthetic/.git/worktrees/data\n');
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_IN_REPOSITORY', 'the data root is itself a checkout');
    fs.rmSync(ownGit);

    fs.mkdirSync(parentGit);
    assert.equal(loadTestControlPolicy(fixture.env, { cwd: process.cwd() }).expectedApplicationId, IDS.app);
  } finally { fixture.cleanup(); }
});

test('two data paths reaching one file through a junction are aliases', () => {
  const fixture = createFixture();
  try {
    const realDirectory = path.join(fixture.root, 'shared');
    fs.mkdirSync(realDirectory);
    const shared = path.join(realDirectory, 'conversation.json');
    fs.writeFileSync(shared, '{}');
    const junction = path.join(fixture.root, 'shared-junction');
    fs.symlinkSync(realDirectory, junction, 'junction');
    const env = {
      ...fixture.env,
      AI_CONVERSATION_PATH: shared,
      XIAOJI_MEMORY_PATH: path.join(junction, 'conversation.json'),
    };
    assertPolicyRejects(env, 'TEST_DATA_PATH_ALIAS', 'junction alias');

    const outside = path.join(fixture.parent, 'outside-directory');
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, 'memory.json'), '{}');
    const escape = path.join(fixture.root, 'escape-junction');
    fs.symlinkSync(outside, escape, 'junction');
    assertPolicyRejects({ ...fixture.env, XIAOJI_MEMORY_PATH: path.join(escape, 'memory.json') },
      'TEST_DATA_PATH_INVALID', 'junction escape');
  } finally { fixture.cleanup(); }
});

test('test-control fails closed when the data root marker is missing, foreign, or malformed', () => {
  const fixture = createFixture();
  try {
    fs.rmSync(fixture.markerPath);
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_MISSING');
    for (const applicationId of [IDS.formal, IDS.otherGuild]) {
      writeTestRootMarker(fixture.root, applicationId);
      assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_MISMATCH', applicationId);
    }
    for (const content of [
      '',
      'not json',
      '[]',
      'null',
      JSON.stringify(IDS.app),
      markerJson(fixture.root, { schemaVersion: 2 }),
      markerJson(fixture.root, { purpose: 'xiaoji-production-data' }),
      markerJson(fixture.root, { expectedApplicationId: 111111111111 }),
      markerJson(fixture.root, { expectedApplicationId: 'not-a-snowflake' }),
      markerJson(fixture.root, { dataRoot: fixture.root }),
      markerJson(fixture.root, { dataRootIdentity: 'C:/synthetic' }),
      markerJson(fixture.root, { dataRootIdentity: 12 }),
      JSON.stringify({ schemaVersion: 1, purpose: 'xiaoji-test-control-data-root', expectedApplicationId: IDS.app }),
      `${markerJson(fixture.root)}${' '.repeat(1100)}`,
    ]) {
      fs.writeFileSync(fixture.markerPath, content);
      assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_INVALID', content.slice(0, 80));
    }
  } finally { fixture.cleanup(); }
});

test('test-control rejects a marker that is misplaced or not one plain regular file', () => {
  const fixture = createFixture();
  try {
    const content = fs.readFileSync(fixture.markerPath);
    fs.rmSync(fixture.markerPath);
    fs.writeFileSync(path.join(fixture.parent, TEST_DATA_ROOT_MARKER), content);
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_MISSING', 'marker in parent directory');
    const nested = path.join(fixture.root, 'nested');
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, TEST_DATA_ROOT_MARKER), content);
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_MISSING', 'marker in nested directory');
    fs.writeFileSync(path.join(fixture.root, 'xiaoji-test-root.json'), content);
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_MISSING', 'marker under another name');

    fs.mkdirSync(fixture.markerPath);
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_INVALID', 'marker is a directory');
    fs.rmdirSync(fixture.markerPath);

    const outsideMarker = path.join(fixture.parent, 'outside-marker.json');
    fs.writeFileSync(outsideMarker, content);
    fs.linkSync(outsideMarker, fixture.markerPath);
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_INVALID', 'marker is a hard link');
    fs.rmSync(fixture.markerPath);

    if (process.platform === 'win32') {
      const markedElsewhere = path.join(fixture.parent, 'marked-elsewhere');
      fs.mkdirSync(markedElsewhere);
      fs.writeFileSync(path.join(markedElsewhere, TEST_DATA_ROOT_MARKER), content);
      fs.symlinkSync(markedElsewhere, fixture.markerPath, 'junction');
      assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_INVALID', 'marker is a junction');
    }
  } finally { fixture.cleanup(); }
});

test('test-control rejects a symbolic-link marker when links are available', (context) => {
  const fixture = createFixture();
  try {
    const outsideMarker = path.join(fixture.parent, 'outside-marker.json');
    fs.renameSync(fixture.markerPath, outsideMarker);
    try { fs.symlinkSync(outsideMarker, fixture.markerPath, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) { context.skip('symlink creation is unavailable'); return; }
      throw error;
    }
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_INVALID');
  } finally { fixture.cleanup(); }
});

test('a data root that looks like production data is refused without a matching test marker', () => {
  const fixture = createFixture();
  try {
    fs.rmSync(fixture.markerPath);
    for (const name of [
      'owner-safety-side-effects-v1.json',
      'welcome-side-effects-v1.json',
      'xiaoji.sqlite.bak',
      'reminders.migration-v1.receipt.json',
    ]) fs.writeFileSync(path.join(fixture.root, name), '{}');
    const before = fs.readdirSync(fixture.root).sort();
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_MISSING');
    writeTestRootMarker(fixture.root, IDS.formal);
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_MARKER_MISMATCH');
    fs.rmSync(fixture.markerPath);
    assert.deepEqual(fs.readdirSync(fixture.root).sort(), before);
  } finally { fixture.cleanup(); }
});

// Two different 64-bit file IDs that collapse to the same Number, taken from the
// observed Windows collision (xiaoji.sqlite vs inviterWhitelist.json).
function collidingInodes() {
  const base = BigInt(Number(110901140826835620n));
  return [base, base + 1n];
}

function lstatWithIdentities(identities) {
  const byPath = new Map([...identities].map(([target, identity]) => [path.resolve(target).toLowerCase(), identity]));
  return (target) => {
    const stat = fs.lstatSync(target, { bigint: true });
    const identity = byPath.get(path.resolve(target).toLowerCase());
    if (!identity) return stat;
    const forged = Object.create(stat);
    Object.defineProperties(forged, { dev: { value: identity.dev }, ino: { value: identity.ino } });
    return forged;
  };
}

test('distinct files whose bigint identities collapse as Numbers are never aliases', () => {
  const fixture = createFixture();
  try {
    const [first, second] = collidingInodes();
    assert.notEqual(first, second);
    assert.equal(Number(first), Number(second), 'precondition: a Number identity would collide');
    const lstat = lstatWithIdentities([
      [fixture.env.COIN_DB_PATH, { dev: 7n, ino: first }],
      [fixture.env.XIAOJI_INVITER_WHITELIST_PATH, { dev: 7n, ino: second }],
    ]);
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd(), logger: { warn() {} }, lstat });
    assert.equal(policy.expectedApplicationId, IDS.app);

    const sameIdentity = lstatWithIdentities([
      [fixture.env.COIN_DB_PATH, { dev: 7n, ino: first }],
      [fixture.env.XIAOJI_INVITER_WHITELIST_PATH, { dev: 7n, ino: first }],
    ]);
    assert.throws(() => loadTestControlPolicy(fixture.env, {
      cwd: process.cwd(), logger: { warn() {} }, lstat: sameIdentity,
    }), (error) => error.code === 'TEST_DATA_PATH_ALIAS');

    // Imprecise Number stats are refused instead of being compared.
    const numberStats = (target) => (path.resolve(target) === path.resolve(fixture.env.COIN_DB_PATH)
      ? fs.lstatSync(target) : fs.lstatSync(target, { bigint: true }));
    assert.throws(() => loadTestControlPolicy(fixture.env, {
      cwd: process.cwd(), logger: { warn() {} }, lstat: numberStats,
    }), (error) => error.code === 'TEST_DATA_PATH_INVALID');
  } finally { fixture.cleanup(); }
});

test('real aliases stay blocked: same path, hard link, and same file under another spelling', () => {
  const fixture = createFixture();
  try {
    assertPolicyRejects({ ...fixture.env, XIAOJI_ARCHIVE_DB_PATH: fixture.env.XIAOJI_MEMORY_PATH },
      'TEST_DATA_PATH_ALIAS', 'same path');
    const hardLink = path.join(fixture.root, 'memory-hard-link.json');
    fs.linkSync(fixture.env.XIAOJI_MEMORY_PATH, hardLink);
    assertPolicyRejects({ ...fixture.env, XIAOJI_ARCHIVE_DB_PATH: hardLink }, 'TEST_DATA_PATH_INVALID', 'hard link');
    assertPolicyRejects(fixture.env, 'TEST_DATA_PATH_INVALID', 'hard-linked original');
    fs.rmSync(hardLink);
    assert.equal(loadTestControlPolicy(fixture.env, { cwd: process.cwd() }).expectedApplicationId, IDS.app);
    if (process.platform === 'win32') {
      const upper = path.join(fixture.root, path.basename(fixture.env.XIAOJI_MEMORY_PATH).toUpperCase());
      assertPolicyRejects({ ...fixture.env, XIAOJI_ARCHIVE_DB_PATH: upper }, 'TEST_DATA_PATH_ALIAS', 'case variant');
    }
  } finally { fixture.cleanup(); }
});

test('a data root whose file ID is 0 or all ones cannot be bound to a marker', () => {
  const fixture = createFixture();
  try {
    for (const ino of [0n, 0xFFFFFFFFFFFFFFFFn, -1n]) {
      const lstat = lstatWithIdentities([[fixture.root, { dev: 7n, ino }]]);
      assert.throws(() => readDataRootIdentity(fixture.root, lstat),
        (error) => error.code === 'TEST_DATA_ROOT_INVALID', String(ino));
      assert.throws(() => loadTestControlPolicy(fixture.env, { cwd: process.cwd(), logger: { warn() {} }, lstat }),
        (error) => error.code === 'TEST_DATA_ROOT_INVALID', String(ino));
    }
    const usable = lstatWithIdentities([[fixture.root, { dev: 7n, ino: 0xFFFFFFFFFFFFFFFEn }]]);
    assert.equal(readDataRootIdentity(fixture.root, usable), '7:18446744073709551614');
  } finally { fixture.cleanup(); }
});

test('a data root with positive or negative non-zero file IDs (except -1n) pass inode checks', () => {
  const fixture = createFixture();
  try {
    // Positive small inode: 5n should pass.
    const positiveLstat = lstatWithIdentities([[fixture.root, { dev: 7n, ino: 5n }]]);
    assert.equal(readDataRootIdentity(fixture.root, positiveLstat), '7:5');
    // Update marker to reflect the forged positive inode.
    fs.writeFileSync(fixture.markerPath, markerJson(fixture.root, { dataRootIdentity: '7:5' }));
    assert.doesNotThrow(() => loadTestControlPolicy(fixture.env, { cwd: process.cwd(), logger: { warn() {} }, lstat: positiveLstat }),
      'positive inode 5n should pass');

    // Negative inode representing high NTFS sequence: -5n (as BigInt64Array) converts to
    // 0xFFFFFFFFFFFFFFFB (unsigned) and should pass. However, the identity string
    // preserves the signed representation for backward compatibility.
    const negativeLstat = lstatWithIdentities([[fixture.root, { dev: 7n, ino: -5n }]]);
    assert.equal(readDataRootIdentity(fixture.root, negativeLstat), '7:-5');
    // Update marker to reflect the forged negative inode.
    fs.writeFileSync(fixture.markerPath, markerJson(fixture.root, { dataRootIdentity: '7:-5' }));
    assert.doesNotThrow(() => loadTestControlPolicy(fixture.env, { cwd: process.cwd(), logger: { warn() {} }, lstat: negativeLstat }),
      'negative inode -5n (high NTFS sequence) should pass after unsigned conversion');
  } finally { fixture.cleanup(); }
});

test('a .git junction above the data root blocks it even when it points at an empty directory', () => {
  const fixture = createFixture();
  try {
    const emptyTarget = path.join(fixture.parent, 'empty-git-target');
    fs.mkdirSync(emptyTarget);
    fs.symlinkSync(emptyTarget, path.join(fixture.parent, '.git'), 'junction');
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_IN_REPOSITORY', 'junction .git');
    assert.throws(() => assertTestDataRoot({ dataRoot: fixture.root, expectedApplicationId: IDS.app }),
      (error) => error.code === 'TEST_DATA_ROOT_IN_REPOSITORY');
  } finally { fixture.cleanup(); }
});

test('a .git symbolic link above the data root blocks it when links are available', (context) => {
  const fixture = createFixture();
  try {
    const emptyTarget = path.join(fixture.parent, 'empty-git-target');
    fs.mkdirSync(emptyTarget);
    try { fs.symlinkSync(emptyTarget, path.join(fixture.parent, '.git'), 'dir'); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) { context.skip('symlink creation is unavailable'); return; }
      throw error;
    }
    assertPolicyRejects(fixture.env, 'TEST_DATA_ROOT_IN_REPOSITORY', 'symbolic-link .git');
  } finally { fixture.cleanup(); }
});

test('no data path may alias the test data root marker', () => {
  const fixture = createFixture();
  try {
    assertPolicyRejects({ ...fixture.env, XIAOJI_MEMORY_PATH: fixture.markerPath }, 'TEST_DATA_PATH_ALIAS');
    assertPolicyRejects({ ...fixture.env, XIAOJI_ARCHIVE_DB_PATH: fixture.markerPath }, 'TEST_DATA_PATH_ALIAS');
  } finally { fixture.cleanup(); }
});

test('test-control requires owner and isolated real data paths', () => {
  const fixture = createFixture();
  try {
    assert.throws(() => loadTestControlPolicy({ ...fixture.env, BOT_OWNER_ID: '' }, { cwd: process.cwd() }),
      (error) => error.code === 'TEST_OWNER_REQUIRED');
    const outside = path.join(fixture.parent, 'outside.json');
    fs.writeFileSync(outside, '{}');
    assert.throws(() => loadTestControlPolicy({ ...fixture.env, XIAOJI_MEMORY_PATH: outside }, { cwd: process.cwd() }),
      (error) => error.code === 'TEST_DATA_PATH_INVALID');
    const nestedWorktree = path.join(fixture.root, 'nested-worktree');
    fs.mkdirSync(nestedWorktree);
    assert.throws(() => loadTestControlPolicy(fixture.env, { cwd: nestedWorktree }),
      (error) => error.code === 'TEST_DATA_ROOT_IN_WORKTREE');
    assert.throws(() => loadTestControlPolicy({
      ...fixture.env,
      XIAOJI_ARCHIVE_DB_PATH: fixture.env.XIAOJI_MEMORY_PATH,
    }, { cwd: process.cwd() }), (error) => error.code === 'TEST_DATA_PATH_ALIAS');
  } finally { fixture.cleanup(); }
});

test('test-control rejects hard-link aliases', () => {
  const fixture = createFixture();
  try {
    const outside = path.join(fixture.parent, 'outside-memory.json');
    fs.writeFileSync(outside, '{}');
    const hardLink = path.join(fixture.root, 'hard-link-memory.json');
    fs.linkSync(outside, hardLink);
    assert.throws(() => loadTestControlPolicy({ ...fixture.env, XIAOJI_MEMORY_PATH: hardLink }, { cwd: process.cwd() }),
      (error) => error.code === 'TEST_DATA_PATH_INVALID');
  } finally { fixture.cleanup(); }
});

test('test-control rejects symbolic-link realpath escapes when links are available', (context) => {
  const fixture = createFixture();
  try {
    const outside = path.join(fixture.parent, 'outside-memory.json');
    fs.writeFileSync(outside, '{}');
    const symbolic = path.join(fixture.root, 'symbolic-memory.json');
    try { fs.symlinkSync(outside, symbolic, 'file'); }
    catch (error) {
      if (['EPERM', 'EACCES'].includes(error.code)) { context.skip('symlink creation is unavailable'); return; }
      throw error;
    }
    assert.throws(() => loadTestControlPolicy({ ...fixture.env, XIAOJI_MEMORY_PATH: symbolic }, { cwd: process.cwd() }),
      (error) => error.code === 'TEST_DATA_PATH_INVALID');
  } finally { fixture.cleanup(); }
});

test('identity preflight rejects matching formal token and client IDs before target reads', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const calls = [];
    const rest = { async get(route) { calls.push(route); return { id: IDS.formal }; } };
    await assert.rejects(() => preflightTestIdentity({
      policy, rest, configuredClientId: IDS.formal, Routes,
    }), (error) => error.code === 'TEST_FORMAL_APP_FORBIDDEN');
    assert.deepEqual(calls, ['/oauth2/applications/@me', '/users/%40me']);
  } finally { fixture.cleanup(); }
});

test('identity preflight confirms app, user, guild, and channel relationship', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const rest = { async get(route) {
      if (route.startsWith('/channels/')) return { id: IDS.channel, guild_id: IDS.guild };
      return { id: route.startsWith('/guilds/') ? IDS.guild : IDS.app };
    } };
    assert.equal(await preflightTestIdentity({ policy, rest, configuredClientId: IDS.app, Routes }), true);
  } finally { fixture.cleanup(); }
});

test('identity preflight stops before target reads when either locked SDK self identity mismatches', async () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    for (const mismatchStep of ['APPLICATION_SELF', 'BOT_SELF']) {
      const calls = [];
      let laterSteps = 0;
      let loginCalls = 0;
      const rest = { async get(route) {
        calls.push(route);
        const readStep = route === Routes.oauth2CurrentApplication() ? 'APPLICATION_SELF' : 'BOT_SELF';
        return { id: readStep === mismatchStep ? IDS.otherGuild : IDS.app };
      } };
      await assert.rejects(() => startRuntime({
        preflightControl: () => preflightTestIdentity({
          policy, rest, configuredClientId: IDS.app, Routes,
        }),
        preflightPublic: async () => { laterSteps += 1; },
        preflightPrivate: async () => { laterSteps += 1; },
        shouldDeploy: () => false,
        deploy: async () => { laterSteps += 1; },
        login: async () => { loginCalls += 1; },
      }), (error) => error.code === 'TEST_APP_IDENTITY_MISMATCH');
      assert.deepEqual(calls, [Routes.oauth2CurrentApplication(), Routes.user('@me')]);
      assert.equal(laterSteps, 0);
      assert.equal(loginCalls, 0);
    }
  } finally { fixture.cleanup(); }
});

test('production environment without test markers remains outside test-control', () => {
  assert.equal(loadTestControlPolicy({}), null);
});
