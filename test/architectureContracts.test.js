'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createIdentityContext } = require('../src/platform/identityContext');
const { assertDistinctDataPaths, resolveDataPath } = require('../src/platform/dataPaths');
const { createOperationCoordinator } = require('../src/coordinators/operationCoordinator');
const { createRewardCoordinator, makeRewardKey } = require('../src/coordinators/rewardCoordinator');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-architecture-contract-'));
  t.after(() => {
    const resolved = path.resolve(root);
    const temp = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== temp || !path.basename(resolved).startsWith('xiaoji-architecture-contract-')) {
      throw new Error('Refusing to remove an unexpected test directory.');
    }
    fs.rmSync(resolved, { recursive: true, force: true });
  });
  return root;
}

function readJson(file, fallback) {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : fallback;
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value), 'utf8');
}

function makeIntentPort(file, clock, { failRecordOnce = false, failAfterAttemptRecordOnce = false } = {}) {
  let failRecord = failRecordOnce;
  let failAfterAttemptRecord = failAfterAttemptRecordOnce;
  return {
    async claim(candidate) {
      const state = readJson(file, { nextToken: 1, intents: {} });
      let intent = state.intents[candidate.operationId];
      if (!intent) {
        intent = { ...candidate };
        state.intents[candidate.operationId] = intent;
      }
      if (intent.state === 'applied' || intent.state === 'manual_review' ||
          (intent.state === 'failed' && intent.retryable === false) || intent.leaseUntil > clock()) {
        return { acquired: false, intent };
      }
      const leaseToken = `lease-${state.nextToken++}`;
      intent.leaseToken = leaseToken;
      intent.leaseUntil = clock() + 100;
      writeJson(file, state);
      return { acquired: true, intent, leaseToken };
    },
    async renew(operationId, leaseToken) {
      const state = readJson(file, { nextToken: 1, intents: {} });
      const intent = state.intents[operationId];
      if (!intent || intent.leaseToken !== leaseToken || intent.leaseUntil <= clock()) return false;
      intent.leaseUntil = clock() + 100;
      writeJson(file, state);
      return true;
    },
    async record(operationId, leaseToken, patch) {
      const state = readJson(file, { nextToken: 1, intents: {} });
      const intent = state.intents[operationId];
      if (!intent || intent.leaseToken !== leaseToken || intent.leaseUntil <= clock()) {
        const error = new Error('stale lease cannot record');
        error.code = 'LEASE_LOST';
        throw error;
      }
      if (failRecord) {
        failRecord = false;
        throw new Error('simulated intent-store write failure');
      }
      Object.assign(intent, patch);
      if (patch.state !== 'pending') {
        intent.leaseUntil = 0;
        intent.leaseToken = null;
      }
      writeJson(file, state);
      if (patch.externalAttempted && failAfterAttemptRecord) {
        failAfterAttemptRecord = false;
        throw new Error('simulated crash after durable external intent');
      }
    },
  };
}

function makeLocalPort(file, { failAfterCommitOnce = false } = {}) {
  let failAfterCommit = failAfterCommitOnce;
  return {
    async getReceipt(intent) {
      return readJson(file, { effectCount: 0, receipts: {} }).receipts[intent.operationId] || null;
    },
    async applyOnce(intent) {
      const state = readJson(file, { effectCount: 0, receipts: {} });
      if (state.receipts[intent.operationId]) return state.receipts[intent.operationId];
      state.effectCount += 1;
      const receipt = { id: `local-${state.effectCount}`, operationId: intent.operationId };
      state.receipts[intent.operationId] = receipt;
      writeJson(file, state);
      if (failAfterCommit) {
        failAfterCommit = false;
        throw new Error('simulated lost response after local commit');
      }
      return receipt;
    },
  };
}

const operationInput = {
  identity: { userId: '12345', sourceGuildId: '67890', operationId: 'activity-12345' },
  kind: 'campaign',
  payloadHash: crypto.createHash('sha256').update('fixture-campaign-v1').digest('hex'),
};

test('identity keeps Discord IDs as strings and rejects unsafe operation identity', () => {
  const identity = createIdentityContext({ userId: '9007199254740993', operationId: 'reward:v1:abc' });
  assert.equal(identity.userId, '9007199254740993');
  assert.equal(identity.sourceGuildId, null);
  assert.ok(Object.isFrozen(identity));
  assert.throws(() => createIdentityContext({ userId: 9007199254740993, operationId: 'x' }), { code: 'IDENTITY_INVALID' });
  assert.throws(() => createIdentityContext({ userId: '123', operationId: 'unsafe\nkey' }), { code: 'OPERATION_ID_INVALID' });
});

test('data paths preserve explicit override and block silent migration or empty replacement', (t) => {
  const root = fixture(t);
  const protectedRoot = path.join(root, 'protected');
  fs.mkdirSync(protectedRoot);
  const oldPath = path.join(root, 'legacy.json');
  const explicitPath = path.join(root, 'explicit.json');
  fs.writeFileSync(oldPath, '{"kept":true}\n');
  fs.writeFileSync(explicitPath, '{"authority":true}\n');
  const descriptor = {
    kind: 'admission-audit',
    explicitEnvName: 'XIAOJI_AUDIT_DATA_PATH',
    rootRelativePath: 'admission/audit.json',
    legacyPath: oldPath,
  };

  assert.throws(() => resolveDataPath({ ...descriptor, env: {
    XIAOJI_AUDIT_DATA_PATH: explicitPath,
    XIAOJI_DATA_ROOT: protectedRoot,
  }, requireExisting: true }), { code: 'DATA_MIGRATION_REQUIRED' });
  const explicit = resolveDataPath({ ...descriptor, legacyPath: null, env: {
    XIAOJI_AUDIT_DATA_PATH: explicitPath,
    XIAOJI_DATA_ROOT: protectedRoot,
  }, requireExisting: true });
  assert.equal(explicit.filePath, explicitPath);
  assert.equal(explicit.source, 'explicit');
  assert.equal(fs.readFileSync(oldPath, 'utf8'), '{"kept":true}\n');
  assert.throws(() => resolveDataPath({ ...descriptor, env: { XIAOJI_DATA_ROOT: protectedRoot } }), { code: 'DATA_MIGRATION_REQUIRED' });
  assert.throws(() => resolveDataPath({ ...descriptor, legacyPath: null,
    env: { XIAOJI_AUDIT_DATA_PATH: path.join(root, 'missing.json') }, requireExisting: true }), { code: 'DATA_FILE_MISSING' });
  assert.throws(() => resolveDataPath({ ...descriptor, env: { XIAOJI_DATA_ROOT: protectedRoot }, rootRelativePath: '../escape.json' }), { code: 'DATA_ROOT_FILE_INVALID' });
  fs.writeFileSync(path.join(protectedRoot, 'archive'), 'not a directory');
  assert.throws(() => resolveDataPath({ kind: 'archive', explicitEnvName: 'XIAOJI_ARCHIVE_DB_PATH', rootRelativePath: 'archive/conversations.sqlite', env: { XIAOJI_DATA_ROOT: protectedRoot } }), { code: 'DATA_ROOT_CHILD_INVALID' });
  assertDistinctDataPaths([explicit, { filePath: oldPath }]);
  assert.throws(() => assertDistinctDataPaths([explicit, { filePath: explicitPath }]), { code: 'DATA_PATH_COLLISION' });
});

test('distinct data paths compare full precision file identities', () => {
  const firstPath = path.resolve('synthetic-first.sqlite');
  const secondPath = path.resolve('synthetic-second.sqlite');
  const firstInode = 9_007_199_254_740_992n;
  const secondInode = firstInode + 1n;
  assert.equal(Number(firstInode), Number(secondInode));
  let secondIdentity = secondInode;
  const filesystem = {
    lstatSync(filePath, options) {
      const inode = filePath === firstPath ? firstInode : secondIdentity;
      return {
        dev: options?.bigint ? 1n : 1,
        ino: options?.bigint ? inode : Number(inode),
        isFile: () => true,
        isSymbolicLink: () => false,
      };
    },
    realpathSync: (filePath) => filePath,
  };
  assert.doesNotThrow(() => assertDistinctDataPaths([
    { filePath: firstPath }, { filePath: secondPath },
  ], { filesystem }));
  secondIdentity = firstInode;
  assert.throws(() => assertDistinctDataPaths([
    { filePath: firstPath }, { filePath: secondPath },
  ], { filesystem }), { code: 'DATA_PATH_COLLISION' });
});

test('a new archive resolves only to a protected root or explicit path', (t) => {
  const root = fixture(t);
  const protectedRoot = path.join(root, 'protected');
  fs.mkdirSync(protectedRoot);
  const descriptor = { kind: 'archive', explicitEnvName: 'XIAOJI_ARCHIVE_DB_PATH', rootRelativePath: 'archive/conversations.sqlite' };
  assert.throws(() => resolveDataPath({ ...descriptor, env: {} }), { code: 'DATA_PATH_UNCONFIGURED' });
  const result = resolveDataPath({ ...descriptor, env: { XIAOJI_DATA_ROOT: protectedRoot } });
  assert.equal(result.filePath, path.join(protectedRoot, 'archive', 'conversations.sqlite'));
  assert.equal(result.exists, false);
  assert.equal(fs.existsSync(result.filePath), false);
});

test('approved cutover keeps legacy data and permits later target replacements', (t) => {
  const root = fixture(t);
  const protectedRoot = path.join(root, 'protected');
  fs.mkdirSync(protectedRoot);
  const sourcePath = path.join(root, 'legacy.json');
  const targetPath = path.join(protectedRoot, 'reminders.json');
  const receiptPath = path.join(protectedRoot, 'cutover-receipt.json');
  fs.writeFileSync(sourcePath, '{"version":1,"records":[1]}\n');
  fs.writeFileSync(targetPath, '{"version":2,"records":[1]}\n');
  const sourceStat = fs.statSync(sourcePath);
  const targetStat = fs.statSync(targetPath);
  const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const receipt = {
    schemaVersion: 1, state: 'active', kind: 'reminders', migrationId: 'cutover-1',
    activatedAt: '2026-09-26T00:00:00.000Z',
    source: {
      filePath: sourcePath, realPath: fs.realpathSync(sourcePath),
      fileIdentity: `${sourceStat.dev}:${sourceStat.ino}`, sha256: digest(sourcePath),
    },
    target: {
      filePath: targetPath, realPath: fs.realpathSync(targetPath),
      initialFileIdentity: `${targetStat.dev}:${targetStat.ino}`,
      initialSha256: digest(targetPath),
    },
  };
  writeJson(receiptPath, receipt);
  const descriptor = {
    kind: 'reminders', explicitEnvName: 'XIAOJI_REMINDERS_PATH',
    rootRelativePath: 'reminders.json', legacyPath: sourcePath,
    env: { XIAOJI_DATA_ROOT: protectedRoot },
    migrationReceipt: { filePath: receiptPath, expectedSha256: digest(receiptPath) },
    requireExisting: true,
  };
  assert.equal(resolveDataPath(descriptor).migrationId, 'cutover-1');
  assert.equal(fs.readFileSync(sourcePath, 'utf8'), '{"version":1,"records":[1]}\n');

  fs.unlinkSync(targetPath);
  fs.writeFileSync(targetPath, '{"version":2,"records":[1,2]}\n');
  assert.equal(resolveDataPath(descriptor).filePath, targetPath);
  assert.throws(() => resolveDataPath({ ...descriptor, migrationReceipt: { filePath: receiptPath } }), { code: 'DATA_MIGRATION_RECEIPT_INVALID' });
  writeJson(receiptPath, { ...receipt, migrationId: 'unapproved-replacement' });
  assert.throws(() => resolveDataPath(descriptor), { code: 'DATA_MIGRATION_RECEIPT_MISMATCH' });
  writeJson(receiptPath, receipt);
  fs.writeFileSync(sourcePath, '{"version":1,"records":[]}\n');
  assert.throws(() => resolveDataPath(descriptor), { code: 'DATA_MIGRATION_SOURCE_DRIFT' });
  fs.writeFileSync(sourcePath, '{"version":1,"records":[1]}\n');
  fs.unlinkSync(targetPath);
  assert.throws(() => resolveDataPath(descriptor), { code: 'DATA_MIGRATION_FILE_MISSING' });
  fs.linkSync(sourcePath, targetPath);
  assert.throws(() => resolveDataPath(descriptor), { code: 'DATA_PATH_COLLISION' });
});

test('distinct protected paths reject a hard-link alias', (t) => {
  const root = fixture(t);
  const sourcePath = path.join(root, 'audit.json');
  const aliasPath = path.join(root, 'whitelist.json');
  fs.writeFileSync(sourcePath, '{}\n');
  fs.linkSync(sourcePath, aliasPath);
  assert.throws(() => assertDistinctDataPaths([{ filePath: sourcePath }, { filePath: aliasPath }]), { code: 'DATA_PATH_COLLISION' });
});

test('operation resumes after a committed effect and a lost intent response', async (t) => {
  const root = fixture(t);
  const intentFile = path.join(root, 'intent.json');
  const localFile = path.join(root, 'local.json');
  let tick = 0;
  const now = () => new Date(1_800_000_000_000 + tick);
  const first = createOperationCoordinator({
    intentPort: makeIntentPort(intentFile, () => tick, { failRecordOnce: true }),
    localPort: makeLocalPort(localFile, { failAfterCommitOnce: true }),
    now,
  });
  await assert.rejects(() => first.execute(operationInput), /intent-store write failure/);
  assert.equal(readJson(localFile, {}).effectCount, 1);

  tick = 200; // synthetic lease expiry after the first coordinator disappeared
  const resumed = createOperationCoordinator({
    intentPort: makeIntentPort(intentFile, () => tick),
    localPort: makeLocalPort(localFile),
    now,
  });
  assert.deepEqual(await resumed.execute(operationInput), {
    operationId: 'activity-12345', state: 'applied', receiptId: 'local-1', retryable: false,
  });
  assert.equal(readJson(localFile, {}).effectCount, 1);
  assert.equal((await resumed.execute(operationInput)).alreadyApplied, true);
  assert.equal(readJson(localFile, {}).effectCount, 1);
  await assert.rejects(() => resumed.execute({ ...operationInput, payloadHash: 'a'.repeat(64) }), { code: 'OPERATION_CONFLICT' });
  writeJson(localFile, { effectCount: 1, receipts: {} });
  await assert.rejects(() => resumed.execute(operationInput), { code: 'RECEIPT_MISSING' });
});

test('uncertain external effect stops retries for manual review', async (t) => {
  const root = fixture(t);
  const intentFile = path.join(root, 'intent.json');
  const localFile = path.join(root, 'local.json');
  let dispatches = 0;
  const externalPort = {
    async inspect() { return 'not_applied'; },
    async dispatch() { dispatches += 1; throw new Error('network response lost'); },
  };
  const coordinator = createOperationCoordinator({
    intentPort: makeIntentPort(intentFile, () => 0), localPort: makeLocalPort(localFile), externalPort,
  });
  const result = await coordinator.execute(operationInput);
  assert.equal(result.state, 'manual_review');
  assert.equal(result.retryable, false);
  assert.equal(result.reasonCode, 'EXTERNAL_ATTEMPT_UNCONFIRMED');
  assert.equal(dispatches, 1);
  assert.equal((await coordinator.execute(operationInput)).state, 'manual_review');
  assert.equal(dispatches, 1);
  assert.equal(readJson(localFile, {}).effectCount, 1);
});

test('crash after durable dispatch marker prevents an unkeyed external retry', async (t) => {
  const root = fixture(t);
  const intentFile = path.join(root, 'intent.json');
  const localFile = path.join(root, 'local.json');
  let tick = 0;
  let dispatches = 0;
  const externalPort = {
    async inspect() { return 'not_applied'; },
    async dispatch() { dispatches += 1; return 'applied'; },
  };
  const first = createOperationCoordinator({
    intentPort: makeIntentPort(intentFile, () => tick, { failAfterAttemptRecordOnce: true }),
    localPort: makeLocalPort(localFile), externalPort,
  });
  await assert.rejects(() => first.execute(operationInput), /crash after durable external intent/);
  assert.equal(dispatches, 0);
  tick = 200;
  const resumed = createOperationCoordinator({
    intentPort: makeIntentPort(intentFile, () => tick), localPort: makeLocalPort(localFile), externalPort,
  });
  const result = await resumed.execute(operationInput);
  assert.equal(result.state, 'manual_review');
  assert.equal(result.retryable, false);
  assert.equal(dispatches, 0);
});

test('expired lease cannot double dispatch while the first external call is pending', async (t) => {
  const root = fixture(t);
  const intentFile = path.join(root, 'intent.json');
  const localFile = path.join(root, 'local.json');
  let tick = 0;
  let dispatches = 0;
  let releaseDispatch;
  let reportDispatch;
  const enteredDispatch = new Promise((resolve) => { reportDispatch = resolve; });
  const externalPort = {
    async inspect() { return 'not_applied'; },
    async dispatch(_intent, _receipt, options) {
      dispatches += 1;
      assert.equal(options.idempotencyKey, operationInput.identity.operationId);
      reportDispatch();
      return new Promise((resolve) => { releaseDispatch = resolve; });
    },
  };
  const first = createOperationCoordinator({
    intentPort: makeIntentPort(intentFile, () => tick), localPort: makeLocalPort(localFile), externalPort,
  });
  const firstRun = first.execute(operationInput);
  await enteredDispatch;
  tick = 200;
  const second = createOperationCoordinator({
    intentPort: makeIntentPort(intentFile, () => tick), localPort: makeLocalPort(localFile), externalPort,
  });
  assert.equal((await second.execute(operationInput)).state, 'manual_review');
  releaseDispatch('applied');
  await assert.rejects(firstRun, { code: 'LEASE_LOST' });
  assert.equal(dispatches, 1);
  assert.equal(readJson(localFile, {}).effectCount, 1);
});

test('stale executor cannot mark dispatch after another lease took over', async (t) => {
  const root = fixture(t);
  const intentFile = path.join(root, 'intent.json');
  const localFile = path.join(root, 'local.json');
  let tick = 0;
  let inspections = 0;
  let dispatches = 0;
  let releaseFirstInspection;
  let firstInspectionStarted;
  const paused = new Promise((resolve) => { firstInspectionStarted = resolve; });
  const externalPort = {
    async inspect() {
      inspections += 1;
      if (inspections !== 1) return 'not_applied';
      firstInspectionStarted();
      return new Promise((resolve) => { releaseFirstInspection = resolve; });
    },
    async dispatch() { dispatches += 1; return 'applied'; },
  };
  const first = createOperationCoordinator({
    intentPort: makeIntentPort(intentFile, () => tick), localPort: makeLocalPort(localFile), externalPort,
  });
  const firstRun = first.execute(operationInput);
  await paused;
  tick = 200;
  const second = createOperationCoordinator({
    intentPort: makeIntentPort(intentFile, () => tick), localPort: makeLocalPort(localFile), externalPort,
  });
  assert.equal((await second.execute(operationInput)).state, 'applied');
  releaseFirstInspection('not_applied');
  await assert.rejects(firstRun, { code: 'LEASE_LOST' });
  assert.equal(dispatches, 1);
});

test('reward uses the shared key and authoritative receipt after a lost response', async () => {
  const receipts = new Map();
  let credits = 0;
  let calls = 0;
  const coordinator = createRewardCoordinator({
    async getRewardReceiptV2({ rewardKey }) { return receipts.get(rewardKey) || null; },
    async grantRewardOnceV2(input) {
      calls += 1;
      const rewardKey = makeRewardKey(input);
      credits += input.amount;
      receipts.set(rewardKey, {
        id: 1, rewardKey, operationId: input.operationId, kind: input.kind,
        canonicalSourceId: input.canonicalSourceId, rewardKind: input.rewardKind,
        userId: input.userId, amount: input.amount, transactionId: 1,
      });
      throw new Error('response lost after economic commit');
    },
  });
  const input = { kind: 'game', canonicalSourceId: 'discord:session-1', rewardKind: 'completion', userId: '12345', sourceGuildId: '67890', amount: 50 };
  const first = await coordinator.grant(input);
  assert.equal(first.alreadyGranted, true);
  assert.equal(first.receipt.transactionId, 1);
  assert.equal(credits, 50);
  assert.equal(calls, 1);
  const second = await coordinator.grant({ ...input, sourceGuildId: '98765' });
  assert.equal(second.rewardKey, first.rewardKey);
  assert.equal(calls, 1);
  assert.equal(credits, 50);
  await assert.rejects(() => coordinator.grant({ ...input, amount: 51 }), { code: 'REWARD_KEY_CONFLICT' });
});

test('reward stops before credit when receipt authority is unavailable', async () => {
  let credits = 0;
  const coordinator = createRewardCoordinator({
    async getRewardReceiptV2() { throw new Error('database unavailable'); },
    async grantRewardOnceV2() { credits += 1; },
  });
  await assert.rejects(() => coordinator.grant({
    kind: 'owner-campaign', canonicalSourceId: 'campaign-1', rewardKind: 'bonus',
    userId: '12345', sourceGuildId: '67890', amount: 1,
  }), { code: 'REWARD_OUTCOME_UNKNOWN' });
  assert.equal(credits, 0);
});
