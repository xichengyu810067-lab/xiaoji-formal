'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class DataPathError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'DataPathError';
    this.code = code;
  }
}

function configuredValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function pathIdentity(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function fileIdentity(stats) {
  return `${stats.dev}:${stats.ino}`;
}

function isIsoTimestamp(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function sha256File(filePath, filesystem) {
  let descriptor;
  try {
    descriptor = filesystem.openSync(filePath, 'r');
    const before = filesystem.fstatSync(descriptor);
    const hash = crypto.createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count;
    while ((count = filesystem.readSync(descriptor, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, count));
    }
    const after = filesystem.fstatSync(descriptor);
    if (fileIdentity(before) !== fileIdentity(after) || before.size !== after.size || before.mtimeMs !== after.mtimeMs) {
      throw new DataPathError('DATA_MIGRATION_SOURCE_DRIFT', 'A migration source changed during verification.');
    }
    return { sha256: hash.digest('hex'), stats: after };
  } catch (error) {
    if (error instanceof DataPathError) throw error;
    throw new DataPathError('DATA_PATH_UNREADABLE', 'A migration source cannot be read.', { cause: error });
  } finally {
    if (descriptor !== undefined) filesystem.closeSync(descriptor);
  }
}

function statIfPresent(filePath, filesystem, { bigint = false } = {}) {
  try {
    return bigint ? filesystem.lstatSync(filePath, { bigint: true }) : filesystem.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw new DataPathError('DATA_PATH_UNREADABLE', 'A configured data path cannot be inspected.', { cause: error });
  }
}

function validateRootRelativePath(value) {
  if (typeof value !== 'string' || path.isAbsolute(value) || !value.trim()) {
    throw new DataPathError('DATA_ROOT_FILE_INVALID', 'rootRelativePath must be a relative file path.');
  }
  const parts = value.split(/[\\/]/);
  if (parts.some((part) => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new DataPathError('DATA_ROOT_FILE_INVALID', 'rootRelativePath cannot escape the data root.');
  }
  return parts;
}

function assertRegularFile(filePath, filesystem) {
  const stat = statIfPresent(filePath, filesystem);
  if (!stat) throw new DataPathError('DATA_FILE_MISSING', 'A required data file is missing.');
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new DataPathError('DATA_FILE_INVALID', 'A required data file must be a regular file.');
  }
}

function assertRootTargetSafe(root, filePath, filesystem) {
  let current = root;
  const relative = path.relative(root, filePath);
  for (const part of relative.split(path.sep).slice(0, -1)) {
    current = path.join(current, part);
    const stat = statIfPresent(current, filesystem);
    if (stat && (!stat.isDirectory() || stat.isSymbolicLink())) {
      throw new DataPathError('DATA_ROOT_CHILD_INVALID', 'A data-root child must be a real directory.');
    }
  }
}

// The expected receipt hash is supplied by an independently approved deploy
// configuration, never computed from the same replaceable receipt at startup.
// The target's initial hash/identity is cutover evidence, not a requirement
// that a mutable database or atomically replaced JSON file stay unchanged.
// Domain stores must still validate the active target's schema and continuity.
function verifyMigrationReceipt({ migrationReceipt, kind, legacyPath, targetPath, filesystem }) {
  if (!migrationReceipt || typeof migrationReceipt.filePath !== 'string' ||
      !path.isAbsolute(migrationReceipt.filePath) ||
      !/^[a-f0-9]{64}$/.test(migrationReceipt.expectedSha256 || '')) {
    throw new DataPathError('DATA_MIGRATION_RECEIPT_INVALID', 'An approved migration receipt path and SHA-256 are required.');
  }
  const receiptPath = path.normalize(migrationReceipt.filePath);
  const receiptStat = statIfPresent(receiptPath, filesystem);
  if (!receiptStat || !receiptStat.isFile() || receiptStat.isSymbolicLink() || receiptStat.size > 65_536) {
    throw new DataPathError('DATA_MIGRATION_RECEIPT_INVALID', 'The migration receipt must be a small real file.');
  }
  if (pathIdentity(filesystem.realpathSync(receiptPath)) !== pathIdentity(receiptPath)) {
    throw new DataPathError('DATA_MIGRATION_RECEIPT_INVALID', 'The migration receipt path cannot be redirected through a link.');
  }
  let raw;
  try {
    raw = filesystem.readFileSync(receiptPath);
  } catch (error) {
    throw new DataPathError('DATA_MIGRATION_RECEIPT_UNREADABLE', 'The migration receipt cannot be read.', { cause: error });
  }
  if (crypto.createHash('sha256').update(raw).digest('hex') !== migrationReceipt.expectedSha256) {
    throw new DataPathError('DATA_MIGRATION_RECEIPT_MISMATCH', 'The migration receipt differs from approved bytes.');
  }
  let receipt;
  try {
    receipt = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new DataPathError('DATA_MIGRATION_RECEIPT_INVALID', 'The migration receipt is not valid JSON.', { cause: error });
  }
  if (receipt?.schemaVersion !== 1 || receipt?.state !== 'active' || receipt.kind !== kind ||
      typeof receipt.migrationId !== 'string' || !receipt.migrationId ||
      !isIsoTimestamp(receipt.activatedAt) ||
      !path.isAbsolute(receipt.source?.filePath || '') ||
      !path.isAbsolute(receipt.target?.filePath || '') ||
      !path.isAbsolute(receipt.source?.realPath || '') ||
      !path.isAbsolute(receipt.target?.realPath || '') ||
      pathIdentity(receipt.source?.filePath || '') !== pathIdentity(legacyPath) ||
      pathIdentity(receipt.target?.filePath || '') !== pathIdentity(targetPath) ||
      !/^[a-f0-9]{64}$/.test(receipt.source?.sha256 || '') ||
      !/^[a-f0-9]{64}$/.test(receipt.target?.initialSha256 || '') ||
      !/^\d+:\d+$/.test(receipt.source?.fileIdentity || '') ||
      !/^\d+:\d+$/.test(receipt.target?.initialFileIdentity || '')) {
    throw new DataPathError('DATA_MIGRATION_RECEIPT_INVALID', 'The migration receipt does not bind this data path.');
  }
  const sourceStat = statIfPresent(legacyPath, filesystem);
  const targetStat = statIfPresent(targetPath, filesystem);
  if (!sourceStat || !targetStat || !sourceStat.isFile() || !targetStat.isFile() ||
      sourceStat.isSymbolicLink() || targetStat.isSymbolicLink()) {
    throw new DataPathError('DATA_MIGRATION_FILE_MISSING', 'Both retained source and active target must be real files.');
  }
  assertDistinctDataPaths([
    { filePath: legacyPath }, { filePath: targetPath }, { filePath: receiptPath },
  ], { filesystem });
  if (fileIdentity(sourceStat) !== receipt.source.fileIdentity ||
      pathIdentity(filesystem.realpathSync(legacyPath)) !== pathIdentity(receipt.source.realPath || '') ||
      pathIdentity(filesystem.realpathSync(targetPath)) !== pathIdentity(receipt.target.realPath || '')) {
    throw new DataPathError('DATA_MIGRATION_IDENTITY_MISMATCH', 'Migration file identity or real path changed.');
  }
  const sourceDigest = sha256File(legacyPath, filesystem);
  if (fileIdentity(sourceDigest.stats) !== receipt.source.fileIdentity || sourceDigest.sha256 !== receipt.source.sha256) {
    throw new DataPathError('DATA_MIGRATION_SOURCE_DRIFT', 'Retained source data differs from the approved cutover.');
  }
  return receipt.migrationId;
}

// This resolver never creates a directory or an empty replacement file.
function resolveDataPath({
  kind,
  explicitEnvName,
  rootRelativePath,
  legacyPath = null,
  explicitRelativeBase = process.cwd(),
  env = process.env,
  filesystem = fs,
  requireExisting = false,
  migrationReceipt = null,
} = {}) {
  if (typeof kind !== 'string' || !kind || typeof explicitEnvName !== 'string' || !explicitEnvName) {
    throw new DataPathError('DATA_DESCRIPTOR_INVALID', 'kind and explicitEnvName are required.');
  }
  if (legacyPath != null && !path.isAbsolute(legacyPath)) {
    throw new DataPathError('DATA_DESCRIPTOR_INVALID', 'legacyPath must be absolute.');
  }
  const explicit = configuredValue(env, explicitEnvName);
  let filePath;
  let source;
  let migrationId = null;

  if (explicit) {
    filePath = path.isAbsolute(explicit) ? path.normalize(explicit) : path.resolve(explicitRelativeBase, explicit);
    if (legacyPath && pathIdentity(legacyPath) !== pathIdentity(filePath)) {
      if (migrationReceipt) {
        migrationId = verifyMigrationReceipt({ migrationReceipt, kind, legacyPath, targetPath: filePath, filesystem });
      } else if (statIfPresent(legacyPath, filesystem)) {
        throw new DataPathError('DATA_MIGRATION_REQUIRED', 'Existing legacy data requires an approved cutover receipt before explicit selection.');
      }
    }
    source = 'explicit';
  } else {
    const dataRoot = configuredValue(env, 'XIAOJI_DATA_ROOT');
    if (dataRoot) {
      if (!path.isAbsolute(dataRoot)) {
        throw new DataPathError('DATA_ROOT_NOT_ABSOLUTE', 'XIAOJI_DATA_ROOT must be absolute.');
      }
      const root = path.normalize(dataRoot);
      const rootStat = statIfPresent(root, filesystem);
      if (!rootStat || !rootStat.isDirectory() || rootStat.isSymbolicLink()) {
        throw new DataPathError('DATA_ROOT_INVALID', 'XIAOJI_DATA_ROOT must be an existing real directory.');
      }
      if (pathIdentity(filesystem.realpathSync(root)) !== pathIdentity(root)) {
        throw new DataPathError('DATA_ROOT_INVALID', 'XIAOJI_DATA_ROOT cannot be redirected through a link.');
      }
      filePath = path.join(root, ...validateRootRelativePath(rootRelativePath));
      assertRootTargetSafe(root, filePath, filesystem);
      if (legacyPath && pathIdentity(legacyPath) !== pathIdentity(filePath)) {
        if (migrationReceipt) {
          migrationId = verifyMigrationReceipt({ migrationReceipt, kind, legacyPath, targetPath: filePath, filesystem });
        } else if (statIfPresent(legacyPath, filesystem)) {
          throw new DataPathError('DATA_MIGRATION_REQUIRED', 'Existing legacy data requires an approved cutover receipt before data-root selection.');
        }
      }
      source = 'data-root';
    } else if (legacyPath) {
      filePath = path.resolve(legacyPath);
      source = 'legacy';
    } else {
      throw new DataPathError('DATA_PATH_UNCONFIGURED', `${kind} needs an explicit path or XIAOJI_DATA_ROOT.`);
    }
  }

  if (requireExisting) assertRegularFile(filePath, filesystem);
  const targetStat = statIfPresent(filePath, filesystem);
  if (targetStat && (!targetStat.isFile() || targetStat.isSymbolicLink())) {
    throw new DataPathError('DATA_FILE_INVALID', 'A data path must be a regular file.');
  }
  return Object.freeze({ kind, filePath, source, exists: Boolean(targetStat), migrationId });
}

function assertDistinctDataPaths(descriptors, { filesystem = fs } = {}) {
  const seenPaths = new Set();
  const seenRealPaths = new Set();
  const seenFiles = new Set();
  for (const descriptor of descriptors) {
    if (!descriptor?.filePath || !path.isAbsolute(descriptor.filePath)) {
      throw new DataPathError('DATA_PATH_INVALID', 'Protected data paths must be absolute.');
    }
    const identity = pathIdentity(descriptor.filePath);
    if (seenPaths.has(identity)) {
      throw new DataPathError('DATA_PATH_COLLISION', 'Protected data paths must be distinct.');
    }
    seenPaths.add(identity);
    const stat = statIfPresent(descriptor.filePath, filesystem, { bigint: true });
    if (!stat) {
      throw new DataPathError('DATA_FILE_MISSING', 'A protected data path is missing.');
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new DataPathError('DATA_FILE_INVALID', 'A protected data path must be a real file.');
    }
    const real = pathIdentity(filesystem.realpathSync(descriptor.filePath));
    const file = fileIdentity(stat);
    if (seenRealPaths.has(real) || seenFiles.has(file)) {
      throw new DataPathError('DATA_PATH_COLLISION', 'Protected data paths must not alias the same file.');
    }
    seenRealPaths.add(real);
    seenFiles.add(file);
  }
}

module.exports = { DataPathError, assertDistinctDataPaths, resolveDataPath };
