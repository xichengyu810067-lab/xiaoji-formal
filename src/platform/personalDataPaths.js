const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolveDataPath, assertDistinctDataPaths, DataPathError } = require('./dataPaths');

const projectRoot = path.resolve(__dirname, '..', '..');
const SETTINGS = Object.freeze({
  reminders: { name: 'reminders.json', pathEnv: 'XIAOJI_REMINDERS_PATH', digestEnv: 'XIAOJI_REMINDERS_PROVENANCE_SHA256' },
  calendar: { name: 'calendarEvents.json', pathEnv: 'XIAOJI_CALENDAR_PATH', digestEnv: 'XIAOJI_CALENDAR_PROVENANCE_SHA256' },
});

function identity(filePath) {
  const result = path.resolve(filePath);
  return process.platform === 'win32' ? result.toLowerCase() : result;
}

function digest(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function statIdentity(stat) {
  return `${stat.dev}:${stat.ino}`;
}

function realTargetLocation(filePath) {
  let ancestor = path.dirname(filePath);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new DataPathError('PERSONAL_DATA_PARENT_INVALID', 'Personal data parent cannot be resolved.');
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), path.relative(ancestor, filePath));
}

function settingsFor(kind) {
  const settings = SETTINGS[kind];
  if (!settings) throw new DataPathError('PERSONAL_DATA_KIND_INVALID', 'Unknown personal data kind.');
  return settings;
}

function personalDataTargetForRoot(kind, { env, requireExisting, sourceProjectRoot }) {
  const settings = settingsFor(kind);
  const legacyPath = path.join(sourceProjectRoot, 'src', 'data', settings.name);
  const explicit = String(env[settings.pathEnv] || '').trim();
  const root = String(env.XIAOJI_DATA_ROOT || '').trim();
  if (!explicit && !root) {
    return { ...resolveDataPath({ kind, explicitEnvName: settings.pathEnv,
      rootRelativePath: settings.name, legacyPath, env, requireExisting }),
    legacyPath, protectedTarget: false };
  }
  if (explicit && !path.isAbsolute(explicit)) {
    throw new DataPathError('PERSONAL_DATA_PATH_NOT_ABSOLUTE', `${settings.pathEnv} must be absolute.`);
  }
  const resolved = resolveDataPath({ kind, explicitEnvName: settings.pathEnv,
    rootRelativePath: settings.name, env, requireExisting });
  if (identity(resolved.filePath) === identity(legacyPath) ||
      identity(resolved.filePath).startsWith(`${identity(sourceProjectRoot)}${path.sep}`) ||
      identity(realTargetLocation(resolved.filePath)).startsWith(`${identity(fs.realpathSync(sourceProjectRoot))}${path.sep}`)) {
    throw new DataPathError('PERSONAL_DATA_TARGET_UNPROTECTED', 'Personal data target must be outside the project.');
  }
  return { ...resolved, legacyPath, protectedTarget: true };
}

function personalDataTarget(kind, { env = process.env, requireExisting = false } = {}) {
  return personalDataTargetForRoot(kind, { env, requireExisting, sourceProjectRoot: projectRoot });
}

function provenancePath(targetPath) {
  return `${targetPath}.provenance.json`;
}

function assertProtectedLocation(filePath, sourceProjectRoot = projectRoot) {
  if (!path.isAbsolute(filePath) ||
      identity(filePath) === identity(sourceProjectRoot) ||
      identity(filePath).startsWith(`${identity(sourceProjectRoot)}${path.sep}`) ||
      identity(realTargetLocation(filePath)) === identity(fs.realpathSync(sourceProjectRoot)) ||
      identity(realTargetLocation(filePath)).startsWith(`${identity(fs.realpathSync(sourceProjectRoot))}${path.sep}`)) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Personal data evidence must be outside the project.');
  }
}

function assertLegacyMigrationEvidence(kind, targetPath, receipt, descriptors, sourceProjectRoot = projectRoot) {
  const legacyPath = path.join(sourceProjectRoot, 'src', 'data', settingsFor(kind).name);
  const sourceBackup = `${legacyPath}.legacy-v1.bak`;
  const sourceReceipt = `${legacyPath}.migration-v1.receipt.json`;
  const sourceBackupExists = fs.existsSync(sourceBackup);
  const sourceReceiptExists = fs.existsSync(sourceReceipt);
  const evidence = receipt.legacyMigrationEvidence;
  if (!evidence) {
    if (sourceBackupExists || sourceReceiptExists) {
      throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Release migration evidence is not retained in the protected target.');
    }
    return;
  }
  if (sourceBackupExists !== sourceReceiptExists) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Release migration evidence is incomplete.');
  }
  const backupPath = `${targetPath}.legacy-v1.bak`;
  const migrationReceiptPath = `${targetPath}.migration-v1.receipt.json`;
  for (const [filePath, record] of [[backupPath, evidence.backup], [migrationReceiptPath, evidence.receipt]]) {
    assertProtectedLocation(filePath, sourceProjectRoot);
    const stat = fs.lstatSync(filePath);
    if (identity(record?.filePath || '') !== identity(filePath) ||
        identity(record?.realPath || '') !== identity(filePath) ||
        !stat.isFile() || stat.isSymbolicLink() ||
        identity(fs.realpathSync(filePath)) !== identity(filePath) ||
        statIdentity(stat) !== record.fileIdentity ||
        !/^[a-f0-9]{64}$/.test(record.sha256 || '') ||
        digest(fs.readFileSync(filePath)) !== record.sha256) {
      throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Protected migration evidence differs from cutover receipt.');
    }
    descriptors.push({ filePath });
  }
  let migrationReceipt;
  let backup;
  try {
    migrationReceipt = JSON.parse(fs.readFileSync(migrationReceiptPath, 'utf8'));
    backup = JSON.parse(fs.readFileSync(backupPath, 'utf8'));
  } catch {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Protected migration evidence is not valid JSON.');
  }
  if (migrationReceipt?.version !== 1 || !backup || typeof backup !== 'object' || Array.isArray(backup) ||
      migrationReceipt.sourceHash !== evidence.backup.sha256 ||
      migrationReceipt.targetHash !== receipt.source.sha256 ||
      migrationReceipt.recordCount !== Object.keys(backup).length) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Protected migration evidence does not bind the snapshot.');
  }
  if (sourceBackupExists) {
    for (const [releasePath, protectedRecord] of [[sourceBackup, evidence.backup], [sourceReceipt, evidence.receipt]]) {
      const stat = fs.lstatSync(releasePath);
      if (!stat.isFile() || stat.isSymbolicLink() ||
          digest(fs.readFileSync(releasePath)) !== protectedRecord.sha256) {
        throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Release migration evidence changed after cutover.');
      }
      descriptors.push({ filePath: releasePath });
    }
  }
}

function assertActiveSource(kind, targetPath, receipt, receiptPath, { requireOrigin = false, sourceProjectRoot = projectRoot } = {}) {
  const legacyPath = path.join(sourceProjectRoot, 'src', 'data', settingsFor(kind).name);
  const snapshotPath = `${targetPath}.source-snapshot.json`;
  assertProtectedLocation(targetPath, sourceProjectRoot);
  assertProtectedLocation(snapshotPath, sourceProjectRoot);
  assertProtectedLocation(receiptPath, sourceProjectRoot);
  if (identity(receipt.source?.filePath || '') !== identity(snapshotPath) ||
      identity(receipt.source?.realPath || '') !== identity(snapshotPath) ||
      identity(receipt.origin?.filePath || '') !== identity(legacyPath) ||
      receipt.origin?.sha256 !== receipt.source?.sha256 ||
      !/^[a-f0-9]{64}$/.test(receipt.source?.sha256 || '') ||
      !/^\d+:\d+$/.test(receipt.source?.fileIdentity || '') ||
      !/^\d+:\d+$/.test(receipt.origin?.fileIdentity || '')) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Cutover origin and protected snapshot do not match.');
  }
  const snapshot = fs.lstatSync(snapshotPath);
  if (!snapshot.isFile() || snapshot.isSymbolicLink() ||
      identity(fs.realpathSync(snapshotPath)) !== identity(snapshotPath) ||
      statIdentity(snapshot) !== receipt.source.fileIdentity ||
      digest(fs.readFileSync(snapshotPath)) !== receipt.source.sha256) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Protected snapshot differs from cutover evidence.');
  }
  const descriptors = [{ filePath: snapshotPath }, { filePath: targetPath }];
  if (fs.existsSync(receiptPath)) descriptors.push({ filePath: receiptPath });
  if (fs.existsSync(legacyPath)) {
    const origin = fs.lstatSync(legacyPath);
    if (!origin.isFile() || origin.isSymbolicLink() ||
        statIdentity(origin) !== receipt.origin.fileIdentity ||
        identity(fs.realpathSync(legacyPath)) !== identity(receipt.origin.realPath || '') ||
        digest(fs.readFileSync(legacyPath)) !== receipt.origin.sha256) {
      throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Cutover release source differs from origin evidence.');
    }
    descriptors.push({ filePath: legacyPath });
  } else if (requireOrigin) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Cutover release source is missing at receipt creation.');
  }
  assertLegacyMigrationEvidence(kind, targetPath, receipt, descriptors, sourceProjectRoot);
  assertDistinctDataPaths(descriptors);
}

function readProvenance(kind, targetPath, env = process.env, sourceProjectRoot = projectRoot) {
  const settings = settingsFor(kind);
  const expected = String(env[settings.digestEnv] || '').trim();
  if (!/^[a-f0-9]{64}$/.test(expected)) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_REQUIRED', `${settings.digestEnv} must contain an independently saved SHA-256.`);
  }
  const receiptPath = provenancePath(targetPath);
  const stat = fs.lstatSync(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65_536 ||
      identity(fs.realpathSync(receiptPath)) !== identity(receiptPath)) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Personal data provenance must be a small real file.');
  }
  const bytes = fs.readFileSync(receiptPath);
  if (digest(bytes) !== expected) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_MISMATCH', 'Personal data provenance differs from approved bytes.');
  }
  let receipt;
  try { receipt = JSON.parse(bytes.toString('utf8')); }
  catch { throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Personal data provenance is not JSON.'); }
  if (receipt?.schemaVersion !== 1 || receipt.kind !== kind ||
      identity(receipt.target?.filePath || '') !== identity(targetPath) ||
      identity(receipt.target?.realPath || '') !== identity(fs.realpathSync(targetPath)) ||
      !/^[a-f0-9]{64}$/.test(receipt.target?.initialSha256 || '') ||
      !/^\d+:\d+$/.test(receipt.target?.initialFileIdentity || '')) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Personal data provenance does not bind this target.');
  }
  if (receipt.state === 'active') assertActiveSource(kind, targetPath, receipt, receiptPath, { sourceProjectRoot });
  return { receipt, receiptPath, expected };
}

function inspectPersonalDataForRoot(kind, env, sourceProjectRoot, requireProtectedPin) {
  const settings = settingsFor(kind);
  const configured = String(env[settings.pathEnv] || '').trim() || String(env.XIAOJI_DATA_ROOT || '').trim();
  if (requireProtectedPin && !configured && String(env[settings.digestEnv] || '').trim()) {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_REQUIRED', 'A provenance pin cannot select legacy data without a protected target.');
  }
  const target = personalDataTargetForRoot(kind, { env, requireExisting: true, sourceProjectRoot });
  if (!target.protectedTarget) return { target, mode: 'legacy' };
  const { receipt, receiptPath, expected } = readProvenance(kind, target.filePath, env, sourceProjectRoot);
  assertDistinctDataPaths([{ filePath: target.filePath }, { filePath: receiptPath }]);
  if (receipt.state === 'fresh') {
    if (requireProtectedPin && ['source', 'origin', 'legacyMigrationEvidence'].some((field) =>
      Object.prototype.hasOwnProperty.call(receipt, field))) {
      throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Fresh deployment evidence cannot carry active-source fields.');
    }
    if (fs.existsSync(target.legacyPath)) {
      throw new DataPathError('DATA_MIGRATION_REQUIRED', 'Legacy personal data exists; fresh provenance cannot select a replacement.');
    }
  } else if (receipt.state === 'active' && receipt.source?.filePath) {
    const verified = resolveDataPath({ kind, explicitEnvName: settingsFor(kind).pathEnv,
      rootRelativePath: settingsFor(kind).name, legacyPath: receipt.source.filePath,
      env, requireExisting: true,
      migrationReceipt: { filePath: receiptPath, expectedSha256: expected } });
    if (identity(verified.filePath) !== identity(target.filePath)) {
      throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Cutover target changed.');
    }
  } else {
    throw new DataPathError('PERSONAL_DATA_PROVENANCE_INVALID', 'Unsupported personal data provenance state.');
  }
  return { target, mode: `protected-${receipt.state}`, receipt, receiptPath, receiptHash: expected };
}

function resolvePersonalDataPath(kind, { env = process.env } = {}) {
  return inspectPersonalDataForRoot(kind, env, projectRoot, false).target;
}

// Deployment-only read path. The caller must first bind sourceProjectRoot to the
// reviewed, retained release; this function never changes the live resolver root.
function verifyPersonalDataForDeployment(kind, { sourceProjectRoot, env } = {}) {
  settingsFor(kind);
  if (typeof sourceProjectRoot !== 'string' || !path.isAbsolute(sourceProjectRoot)) {
    throw new DataPathError('PERSONAL_DATA_SOURCE_ROOT_INVALID', 'Reviewed source project root must be absolute.');
  }
  const sourceRoot = path.resolve(sourceProjectRoot);
  const stat = fs.lstatSync(sourceRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink() || identity(fs.realpathSync(sourceRoot)) !== identity(sourceRoot)) {
    throw new DataPathError('PERSONAL_DATA_SOURCE_ROOT_INVALID', 'Reviewed source project root must be a real directory.');
  }
  if (!env || typeof env !== 'object') {
    throw new DataPathError('PERSONAL_DATA_DEPLOY_ENV_REQUIRED', 'Deployment verification requires an explicit approved environment map.');
  }
  const { target, mode, receipt, receiptPath, receiptHash } = inspectPersonalDataForRoot(kind, env, sourceRoot, true);
  const authority = fs.lstatSync(target.filePath);
  if (!authority.isFile() || authority.isSymbolicLink() || authority.nlink !== 1
    || identity(fs.realpathSync(target.filePath)) !== identity(target.filePath)) {
    throw new DataPathError('PERSONAL_DATA_TARGET_INVALID', 'Deployment authority must be a unique real file.');
  }
  return Object.freeze({ kind, mode, sourceProjectRoot: sourceRoot, authorityPath: target.filePath,
    authoritySha256: digest(fs.readFileSync(target.filePath)),
    ...(receipt ? { provenancePath: receiptPath, provenanceSha256: receiptHash,
      sourceSnapshotPath: receipt.state === 'active' ? receipt.source.filePath : null,
      originPath: receipt.state === 'active' ? receipt.origin.filePath : null,
      originPresent: receipt.state === 'active' ? fs.existsSync(receipt.origin.filePath) : null } : {}) });
}

function createProvenance(kind, targetPath, { source = null, origin = null, legacyMigrationEvidence = null } = {}) {
  settingsFor(kind);
  assertProtectedLocation(targetPath);
  const stat = fs.lstatSync(targetPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DataPathError('PERSONAL_DATA_TARGET_INVALID', 'Personal data target must be a real file.');
  }
  const receipt = {
    schemaVersion: 1, state: source ? 'active' : 'fresh', kind,
    migrationId: crypto.randomUUID(), activatedAt: new Date().toISOString(),
    ...(source ? { source, origin, ...(legacyMigrationEvidence ? { legacyMigrationEvidence } : {}) } : {}),
    target: { filePath: targetPath, realPath: fs.realpathSync(targetPath),
      initialFileIdentity: statIdentity(stat), initialSha256: digest(fs.readFileSync(targetPath)) },
  };
  const receiptPath = provenancePath(targetPath);
  if (source || origin) assertActiveSource(kind, targetPath, receipt, receiptPath, { requireOrigin: true });
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  fs.writeFileSync(receiptPath, bytes, { flag: 'wx', mode: 0o600 });
  return { receiptPath, sha256: digest(bytes) };
}

module.exports = { SETTINGS, createProvenance, personalDataTarget, provenancePath,
  realTargetLocation, resolvePersonalDataPath, verifyPersonalDataForDeployment };
