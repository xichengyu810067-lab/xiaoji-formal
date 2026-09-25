const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const AUDIT_ENV_NAME = 'XIAOJI_AUDIT_DATA_PATH';
const WHITELIST_ENV_NAME = 'XIAOJI_INVITER_WHITELIST_PATH';
const AUDIT_STATUSES = new Set(['approved', 'pending', 'denied', 'unknown']);

class AdmissionDataError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'AdmissionDataError';
    this.code = code;
  }
}

function cleanEnvValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function getAdmissionDataConfiguration({
  env = process.env,
  projectRoot = path.resolve(__dirname, '..', '..'),
  cwd = process.cwd(),
} = {}) {
  const auditOverride = cleanEnvValue(env[AUDIT_ENV_NAME]);
  const whitelistOverride = cleanEnvValue(env[WHITELIST_ENV_NAME]);
  const resolveConfiguredPath = (configured, fallback) => (
    configured ? path.resolve(cwd, configured) : path.resolve(projectRoot, fallback)
  );

  return Object.freeze({
    audit: Object.freeze({
      kind: 'audit',
      envName: AUDIT_ENV_NAME,
      explicit: Boolean(auditOverride),
      absoluteOverride: Boolean(auditOverride && path.isAbsolute(auditOverride)),
      filePath: resolveConfiguredPath(auditOverride, path.join('src', 'data', 'guildAudit.json')),
    }),
    whitelist: Object.freeze({
      kind: 'whitelist',
      envName: WHITELIST_ENV_NAME,
      explicit: Boolean(whitelistOverride),
      absoluteOverride: Boolean(whitelistOverride && path.isAbsolute(whitelistOverride)),
      filePath: resolveConfiguredPath(whitelistOverride, path.join('src', 'data', 'inviterWhitelist.json')),
    }),
  });
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateAuditData(data) {
  if (!isPlainObject(data)) {
    throw new AdmissionDataError('AUDIT_INVALID_ROOT', 'Guild audit data must be a JSON object.');
  }

  for (const record of Object.values(data)) {
    if (!isPlainObject(record) || !AUDIT_STATUSES.has(record.status)) {
      throw new AdmissionDataError(
        'AUDIT_INVALID_RECORD',
        'Every guild audit record must contain a supported status.'
      );
    }
  }
  return data;
}

function validateWhitelistData(data) {
  if (!Array.isArray(data)) {
    throw new AdmissionDataError('WHITELIST_INVALID_ROOT', 'Inviter whitelist data must be a JSON array.');
  }

  for (const record of data) {
    if (!isPlainObject(record) || !cleanEnvValue(record.userId)) {
      throw new AdmissionDataError(
        'WHITELIST_INVALID_RECORD',
        'Every inviter whitelist record must contain a non-empty userId.'
      );
    }
  }
  return data;
}

function validateAdmissionData(kind, data) {
  if (kind === 'audit') return validateAuditData(data);
  if (kind === 'whitelist') return validateWhitelistData(data);
  throw new AdmissionDataError('ADMISSION_KIND_INVALID', 'Unknown admission data kind.');
}

function readAdmissionDataFile(descriptor) {
  let content;
  try {
    content = fs.readFileSync(descriptor.filePath, 'utf8');
  } catch (error) {
    const code = error?.code === 'ENOENT' ? 'ADMISSION_DATA_MISSING' : 'ADMISSION_DATA_UNREADABLE';
    throw new AdmissionDataError(
      code,
      `${descriptor.envName} admission data is missing or unreadable.`,
      { cause: error }
    );
  }

  let data;
  try {
    data = JSON.parse(content);
  } catch (error) {
    throw new AdmissionDataError(
      'ADMISSION_DATA_INVALID_JSON',
      `${descriptor.envName} admission data is not valid JSON.`,
      { cause: error }
    );
  }

  return validateAdmissionData(descriptor.kind, data);
}

function initializeAdmissionDataFiles(options = {}) {
  const configuration = getAdmissionDataConfiguration(options);
  const descriptors = [configuration.audit, configuration.whitelist];

  if (descriptors.some((descriptor) => fs.existsSync(descriptor.filePath))) {
    throw new AdmissionDataError(
      'ADMISSION_INITIALIZE_CONFLICT',
      'Admission data initialization refuses to overwrite or complete a partial existing set.'
    );
  }

  const created = [];
  try {
    for (const descriptor of descriptors) {
      fs.mkdirSync(path.dirname(descriptor.filePath), { recursive: true });
      const initialData = descriptor.kind === 'audit' ? {} : [];
      fs.writeFileSync(
        descriptor.filePath,
        `${JSON.stringify(initialData, null, 2)}\n`,
        { encoding: 'utf8', flag: 'wx', mode: 0o600 }
      );
      created.push(descriptor.filePath);
    }
  } catch (error) {
    for (const filePath of created.reverse()) {
      try {
        fs.unlinkSync(filePath);
      } catch {
        // Preserve the original initialization failure.
      }
    }
    throw error;
  }

  return configuration;
}

function initializeDefaultAdmissionDataFilesIfEmpty(options = {}) {
  const configuration = getAdmissionDataConfiguration(options);
  if (configuration.audit.explicit || configuration.whitelist.explicit) return configuration;
  const auditExists = fs.existsSync(configuration.audit.filePath);
  const whitelistExists = fs.existsSync(configuration.whitelist.filePath);
  if (!auditExists && !whitelistExists) return initializeAdmissionDataFiles(options);
  return configuration;
}

function summarizeAdmissionData(kind, data) {
  if (kind === 'whitelist') return Object.freeze({ entries: data.length });
  const summary = { entries: 0, approved: 0, pending: 0, denied: 0, unknown: 0 };
  for (const record of Object.values(data)) {
    summary.entries += 1;
    summary[record.status] += 1;
  }
  return Object.freeze(summary);
}

function normalizePathIdentity(filePath) {
  const normalized = path.resolve(filePath).replace(/\\/g, '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function hashText(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function inspectAdmissionDataFile(descriptor) {
  const data = readAdmissionDataFile(descriptor);
  const content = fs.readFileSync(descriptor.filePath);
  const linkStats = fs.lstatSync(descriptor.filePath);
  const targetStats = fs.statSync(descriptor.filePath);
  const realPath = fs.realpathSync(descriptor.filePath);

  return Object.freeze({
    kind: descriptor.kind,
    explicit: descriptor.explicit,
    pathIdentityHash: hashText(normalizePathIdentity(descriptor.filePath)),
    realPathIdentityHash: hashText(normalizePathIdentity(realPath)),
    symbolicLink: linkStats.isSymbolicLink(),
    linkDevice: String(linkStats.dev),
    linkInode: String(linkStats.ino),
    targetDevice: String(targetStats.dev),
    targetInode: String(targetStats.ino),
    contentHash: crypto.createHash('sha256').update(content).digest('hex'),
    summary: summarizeAdmissionData(descriptor.kind, data),
  });
}

module.exports = {
  AUDIT_ENV_NAME,
  AdmissionDataError,
  WHITELIST_ENV_NAME,
  getAdmissionDataConfiguration,
  initializeAdmissionDataFiles,
  initializeDefaultAdmissionDataFilesIfEmpty,
  inspectAdmissionDataFile,
  normalizePathIdentity,
  readAdmissionDataFile,
  summarizeAdmissionData,
  validateAdmissionData,
};
