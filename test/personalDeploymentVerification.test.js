'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { verifyPersonalDataForDeployment } = require('../src/platform/personalDataPaths');

function hash(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function evidence(file) {
  const stat = fs.lstatSync(file);
  return { filePath: file, realPath: fs.realpathSync(file), fileIdentity: `${stat.dev}:${stat.ino}`, sha256: hash(file) };
}
function fixture(kind) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-personal-deploy-')));
  const sourceProjectRoot = path.join(root, 'old-release');
  const oldData = path.join(sourceProjectRoot, 'src', 'data');
  const protectedRoot = path.join(root, 'protected');
  fs.mkdirSync(oldData, { recursive: true });
  fs.mkdirSync(protectedRoot);
  const name = kind === 'reminders' ? 'reminders.json' : 'calendarEvents.json';
  const origin = path.join(oldData, name);
  const target = path.join(protectedRoot, name);
  fs.writeFileSync(origin, '{"old":{"fixture":true}}\n');
  const env = { XIAOJI_DATA_ROOT: protectedRoot };
  const pinName = kind === 'reminders' ? 'XIAOJI_REMINDERS_PROVENANCE_SHA256' : 'XIAOJI_CALENDAR_PROVENANCE_SHA256';
  return { root, sourceProjectRoot, origin, target, env, pinName, kind };
}
function writeProvenance(f, state) {
  fs.copyFileSync(f.origin, f.target);
  const targetStat = fs.lstatSync(f.target);
  const receipt = {
    schemaVersion: 1, state, kind: f.kind, migrationId: crypto.randomUUID(),
    activatedAt: '2026-09-26T00:00:00.000Z',
    target: { filePath: f.target, realPath: fs.realpathSync(f.target),
      initialFileIdentity: `${targetStat.dev}:${targetStat.ino}`, initialSha256: hash(f.target) },
  };
  if (state === 'active') {
    const snapshot = `${f.target}.source-snapshot.json`;
    fs.copyFileSync(f.origin, snapshot);
    receipt.source = evidence(snapshot);
    receipt.origin = evidence(f.origin);
  }
  const receiptPath = `${f.target}.provenance.json`;
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
  f.env[f.pinName] = hash(receiptPath);
  return receiptPath;
}

test('deployment verification explicitly identifies legacy authority for both kinds', () => {
  for (const kind of ['reminders', 'calendar']) {
    const f = fixture(kind);
    try {
      const result = verifyPersonalDataForDeployment(kind, { sourceProjectRoot: f.sourceProjectRoot, env: {} });
      assert.equal(result.mode, 'legacy');
      assert.equal(result.authorityPath, f.origin);
      assert.equal(result.authoritySha256, hash(f.origin));
      assert.equal(fs.existsSync(f.target), false);
      assert.throws(() => verifyPersonalDataForDeployment(kind, { sourceProjectRoot: f.sourceProjectRoot,
        env: { [f.pinName]: 'a'.repeat(64) } }), { code: 'PERSONAL_DATA_PROVENANCE_REQUIRED' });
    } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
  }
});

test('deployment verification selects current protected active bytes, including changed records', () => {
  const f = fixture('reminders');
  try {
    const receiptPath = writeProvenance(f, 'active');
    fs.writeFileSync(f.target, '{"new":{"fixture":true}}\n');
    const before = fs.readdirSync(path.dirname(f.target)).sort();
    let result = verifyPersonalDataForDeployment(f.kind, { sourceProjectRoot: f.sourceProjectRoot, env: f.env });
    assert.equal(result.mode, 'protected-active');
    assert.equal(result.authorityPath, f.target);
    assert.equal(result.authoritySha256, hash(f.target));
    assert.notEqual(result.authoritySha256, hash(f.origin));
    assert.equal(result.provenanceSha256, hash(receiptPath));
    assert.equal(result.originPresent, true);
    assert.deepEqual(fs.readdirSync(path.dirname(f.target)).sort(), before);
    fs.rmSync(f.origin);
    result = verifyPersonalDataForDeployment(f.kind, { sourceProjectRoot: f.sourceProjectRoot, env: f.env });
    assert.equal(result.originPresent, false);
    assert.equal(result.authoritySha256, hash(f.target));
    assert.throws(() => verifyPersonalDataForDeployment(f.kind, { sourceProjectRoot: f.sourceProjectRoot,
      env: { ...f.env, [f.pinName]: '0'.repeat(64) } }), { code: 'PERSONAL_DATA_PROVENANCE_MISMATCH' });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('fresh protected authority may have records but must have no legacy source', () => {
  const f = fixture('calendar');
  try {
    writeProvenance(f, 'fresh');
    assert.throws(() => verifyPersonalDataForDeployment(f.kind, { sourceProjectRoot: f.sourceProjectRoot,
      env: f.env }), { code: 'DATA_MIGRATION_REQUIRED' });
    fs.rmSync(f.origin);
    fs.writeFileSync(f.target, '{"existing":{"fixture":true}}\n');
    const result = verifyPersonalDataForDeployment(f.kind, { sourceProjectRoot: f.sourceProjectRoot, env: f.env });
    assert.equal(result.mode, 'protected-fresh');
    assert.equal(result.authoritySha256, hash(f.target));
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('protected configuration cannot silently fall back after missing or tampered proof', () => {
  const f = fixture('reminders');
  try {
    fs.copyFileSync(f.origin, f.target);
    assert.throws(() => verifyPersonalDataForDeployment(f.kind, { sourceProjectRoot: f.sourceProjectRoot,
      env: f.env }), { code: 'PERSONAL_DATA_PROVENANCE_REQUIRED' });
    fs.rmSync(f.target);
    const receiptPath = writeProvenance(f, 'active');
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.origin.filePath = path.join(f.root, 'wrong-release', 'src', 'data', 'reminders.json');
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    f.env[f.pinName] = hash(receiptPath);
    assert.throws(() => verifyPersonalDataForDeployment(f.kind, { sourceProjectRoot: f.sourceProjectRoot,
      env: f.env }), { code: 'PERSONAL_DATA_PROVENANCE_INVALID' });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('repinned active receipt cannot masquerade as fresh after origin disappears', () => {
  const f = fixture('reminders');
  try {
    const receiptPath = writeProvenance(f, 'active');
    fs.rmSync(f.origin);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    receipt.state = 'fresh';
    fs.writeFileSync(receiptPath, `${JSON.stringify(receipt)}\n`);
    f.env[f.pinName] = hash(receiptPath);
    assert.throws(() => verifyPersonalDataForDeployment(f.kind, { sourceProjectRoot: f.sourceProjectRoot,
      env: f.env }), { code: 'PERSONAL_DATA_PROVENANCE_INVALID' });
  } finally { fs.rmSync(f.root, { recursive: true, force: true }); }
});
