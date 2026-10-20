'use strict';

/*
 * On-disk layout of the side-effect ledgers created by ledgerBootstrap.js, and the
 * formats it keeps beside them: the coin database registration of each ledger, the
 * operator request files, and the manifests of retired files.
 *
 * One ledger per purpose (SAFETY_LEDGER_PURPOSES), in two directories:
 *   <ledger dir>/<stem>.sqlite                    database (SQLite, WAL while open)
 *   <ledger dir>/<stem>.sqlite.witness            anchor witness
 *   <ledger dir>/<stem>.sqlite.provenance.json    receipt (its SHA-256 is registered)
 *   <ledger dir>/<stem>.sqlite.retained.lock      quarantine marker
 *   <witness dir>/<stem>.witness                  external continuity witness
 *   <witness dir>/<stem>.witness.quarantine.json  quarantine stamp
 *   <name>.creating                               a creation in progress (staged)
 *   <ledger dir>/reinit-<stem>.request.json       written by scripts/safety-ledger.js
 *   <ledger dir>/release-quarantine-<stem>.request.json
 *                                                 (each written as <name>.tmp, fsynced, and
 *                                                 renamed; a leftover .tmp is ignored)
 *   retired-<UTC>-<stem>-<reason>/                moved files plus manifest.json, in either
 *                                                 directory; never deleted
 *
 * The ledger directory defaults to <base>/safety and the witness directory to
 * <base>/safety-witness. <base> is XIAOJI_DATA_ROOT, or the coin database's directory when
 * that is unset; under test-control it is the policy's data root.
 * XIAOJI_SAFETY_LEDGER_DIR and XIAOJI_SAFETY_WITNESS_DIR may name other directories, which
 * must already exist. Both directories must be local, real (no junction or symbolic
 * link), distinct, not inside each other, and outside the project; under test-control
 * both must be inside the data root. Restore domain: the ledger directory, the witness
 * directory, and the coin database. Restoring all three together cannot be detected; an
 * operator must run `safety:ledger status` and then `reinit` after such a restore.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { TEST_DATA_ROOT_MARKER } = require('../../platform/testControlPolicy');
const { classifyPathLocality, fsyncDirectory, isRemotePath, renameWithRetry } = require('./ledgerStore');
const {
  CREATED_BY_BOOTSTRAP,
  OWNER_PURPOSE_ID,
  PUBLIC_PURPOSES,
  pathsFor,
  quarantineStampPathFor,
  stagedPathOf,
} = require('./sideEffectLedger');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const LEDGER_DIRECTORY_NAME = 'safety';
const WITNESS_DIRECTORY_NAME = 'safety-witness';
const RUNTIME_MODES = Object.freeze(['production', 'test-control']);
// cutover 'genesis': the ledger's creation time; 'zero': every source counts (user
// decision for automatic guild leaves; Owner notices are immediate events).
const SAFETY_LEDGER_PURPOSES = Object.freeze({
  [OWNER_PURPOSE_ID]: Object.freeze({ kind: 'owner', stem: 'owner-safety', cutover: 'zero' }),
  welcome: Object.freeze({ kind: 'public', stem: 'welcome', cutover: 'genesis' }),
  'work.penalty.announce': Object.freeze({ kind: 'public', stem: 'work-penalty-announce', cutover: 'genesis' }),
  'work.reminder.dm.prepare': Object.freeze({ kind: 'public', stem: 'work-reminder-dm-prepare', cutover: 'genesis' }),
  'work.reminder.dm.send': Object.freeze({ kind: 'public', stem: 'work-reminder-dm-send', cutover: 'genesis' }),
  'audit.guild.leave': Object.freeze({ kind: 'public', stem: 'audit-guild-leave', cutover: 'zero' }),
  'word-chain.reaction': Object.freeze({ kind: 'public', stem: 'word-chain-reaction', cutover: 'genesis' }),
  'number-chain.reaction': Object.freeze({ kind: 'public', stem: 'number-chain-reaction', cutover: 'genesis' }),
});
const PURPOSE_IDS = Object.freeze(Object.keys(SAFETY_LEDGER_PURPOSES));

const REGISTRATION_SCHEMA = 1;
const REGISTRATION_STATES = Object.freeze(['creating', 'active', 'retired']);
const REGISTRATION_MAX_BYTES = 4_096;
const REGISTRATION_MAX_PREVIOUS = 8;
const REGISTRATION_KEYS = Object.freeze(['botId', 'createdBy', 'cutoverMs', 'genesisMs', 'kind', 'lastSeen', 'ledgerId',
  'ownerId', 'paths', 'previous', 'purposeId', 'quarantine', 'receiptSha256', 'runtimeMode', 'schema', 'state']);
const PATH_ROLES = Object.freeze(['anchor', 'database', 'receipt', 'witness']);
const REQUEST_SCHEMA = 1;
const REQUEST_KINDS = Object.freeze(['reinit', 'release-quarantine']);
const REQUEST_MAX_BYTES = 4_096;
const MANIFEST_NAME = 'manifest.json';
const MANIFEST_MAX_BYTES = 16_384;
const RETIRED_NAME = /^retired-\d{8}T\d{9}Z-[a-z0-9-]{1,48}-[a-z0-9-]{1,32}(?:-\d{1,3})?$/u;
const TOKEN = /^[A-Za-z0-9:._/-]+$/u;
const REASON = /^[a-z][a-z0-9-]{0,31}$/u;
const SNOWFLAKE = /^\d{17,20}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const LEDGER_ID_PREFIX = 'xjl2';

for (const purposeId of Object.keys(PUBLIC_PURPOSES)) {
  if (SAFETY_LEDGER_PURPOSES[purposeId]?.kind !== 'public') {
    throw new Error(`Safety ledger layout is missing public purpose ${purposeId}.`);
  }
}

class LedgerLayoutError extends Error {
  constructor(code, reason, options = undefined) {
    super(`${code}${reason ? ` (${reason})` : ''}`, options);
    this.name = 'LedgerLayoutError';
    this.code = code;
    this.reason = reason || null;
  }
}

function layoutError(code, reason, cause) {
  return new LedgerLayoutError(code, reason, cause ? { cause } : undefined);
}

function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

// True when target is root itself or anywhere below it.
function isWithin(root, target) {
  const relative = path.relative(pathIdentity(root), pathIdentity(target));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function configuredValue(env, name) {
  const value = env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function lstatOrNull(filePath, role) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw layoutError('LEDGER_PATH_INVALID', role, error);
  }
}

// The UNC check runs on the text as given and again after resolution (isRemotePath), so
// mixed separators such as "/\server\share" are refused before any file is touched.
function requireLocalAbsolute(value, role) {
  const text = String(value || '');
  if (isRemotePath(text)) throw layoutError('LEDGER_PATH_REMOTE', role);
  if (!path.isAbsolute(text) || CONTROL_CHARACTERS.test(text)) throw layoutError('LEDGER_PATH_INVALID', role);
  return path.resolve(text);
}

// An existing directory with no junction or symbolic link anywhere in its path, on a
// local file system. Returns false when it does not exist and `required` is false.
function assertRealDirectory(directory, role, { required = true } = {}) {
  const stat = lstatOrNull(directory, role);
  if (!stat) {
    if (required) throw layoutError('LEDGER_PATH_INVALID', `${role}-missing`);
    return false;
  }
  if (stat.isSymbolicLink()) throw layoutError('LEDGER_PATH_LINKED', role);
  if (!stat.isDirectory()) throw layoutError('LEDGER_PATH_INVALID', role);
  let real;
  try {
    real = fs.realpathSync(directory);
  } catch (error) {
    throw layoutError('LEDGER_PATH_INVALID', role, error);
  }
  if (pathIdentity(real) !== pathIdentity(directory)) throw layoutError('LEDGER_PATH_LINKED', role);
  let remote;
  try {
    remote = classifyPathLocality(directory);
  } catch (error) {
    throw layoutError('LEDGER_PATH_INVALID', role, error);
  }
  if (remote) throw layoutError('LEDGER_PATH_REMOTE', role);
  return true;
}

// Resolves and checks the base of the ledger directories: XIAOJI_DATA_ROOT, or the coin
// database's directory when that is unset; under test-control the policy's data root. It
// must already exist, be local and real, lie outside the project, and in production carry
// no test-control marker. Nothing is created or written. The Owner DM start guard keeps its
// count here too (ownerDmStartGuard.js), under the same rules.
function resolveLedgerBase({ env = process.env, runtimeMode, policy = null, coinDbPath = null,
  projectRoot = PROJECT_ROOT } = {}) {
  if (!RUNTIME_MODES.includes(runtimeMode)) throw layoutError('LEDGER_CONFIGURATION_INVALID', 'runtime-mode');
  let baseValue;
  if (runtimeMode === 'test-control') {
    baseValue = String(policy?.dataRoot || '');
    if (!baseValue) throw layoutError('LEDGER_PATH_INVALID', 'test-root');
  } else {
    baseValue = configuredValue(env, 'XIAOJI_DATA_ROOT') || (coinDbPath ? path.dirname(String(coinDbPath)) : '');
  }
  const base = requireLocalAbsolute(baseValue, 'base');
  assertRealDirectory(base, 'base');
  const project = path.resolve(projectRoot);
  if (isWithin(project, base)) throw layoutError('LEDGER_PATH_IN_PROJECT', 'base');
  if (runtimeMode === 'production' && lstatOrNull(path.join(base, TEST_DATA_ROOT_MARKER), 'base')) {
    throw layoutError('LEDGER_TEST_ROOT_IN_PRODUCTION', 'marker');
  }
  return base;
}

// Resolves and checks the two ledger directories. Nothing is created or written; a
// directory that does not exist yet is created by ensureLedgerDirectories only when a
// ledger is about to be created.
function resolveLedgerDirectories({ env = process.env, runtimeMode, policy = null, coinDbPath = null,
  projectRoot = PROJECT_ROOT } = {}) {
  const base = resolveLedgerBase({ env, runtimeMode, policy, coinDbPath, projectRoot });
  const project = path.resolve(projectRoot);
  const ledgerOverride = configuredValue(env, 'XIAOJI_SAFETY_LEDGER_DIR');
  const witnessOverride = configuredValue(env, 'XIAOJI_SAFETY_WITNESS_DIR');
  const ledgerDirectory = ledgerOverride
    ? requireLocalAbsolute(ledgerOverride, 'ledger-directory') : path.join(base, LEDGER_DIRECTORY_NAME);
  const witnessDirectory = witnessOverride
    ? requireLocalAbsolute(witnessOverride, 'witness-directory') : path.join(base, WITNESS_DIRECTORY_NAME);
  const ledgerExists = assertRealDirectory(ledgerDirectory, 'ledger-directory', { required: Boolean(ledgerOverride) });
  const witnessExists = assertRealDirectory(witnessDirectory, 'witness-directory', { required: Boolean(witnessOverride) });
  if (isWithin(ledgerDirectory, witnessDirectory) || isWithin(witnessDirectory, ledgerDirectory)) {
    throw layoutError('LEDGER_PATH_OVERLAP', 'directories');
  }
  for (const [role, directory] of [['ledger-directory', ledgerDirectory], ['witness-directory', witnessDirectory]]) {
    if (isWithin(project, directory) || isWithin(directory, project)) throw layoutError('LEDGER_PATH_IN_PROJECT', role);
    if (runtimeMode === 'test-control' && (!isWithin(base, directory) || pathIdentity(base) === pathIdentity(directory))) {
      throw layoutError('LEDGER_PATH_OUTSIDE_TEST_ROOT', role);
    }
  }
  return Object.freeze({
    runtimeMode,
    base,
    ledgerDirectory,
    witnessDirectory,
    ledgerDirectoryExists: ledgerExists,
    witnessDirectoryExists: witnessExists,
  });
}

// Creates a missing ledger or witness directory (owner-only on POSIX). Its parent must
// already exist; nothing is created recursively.
function ensureLedgerDirectories(directories) {
  for (const [role, directory] of [['ledger-directory', directories.ledgerDirectory],
    ['witness-directory', directories.witnessDirectory]]) {
    if (assertRealDirectory(directory, role, { required: false })) continue;
    assertRealDirectory(path.dirname(directory), `${role}-parent`);
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
      if (process.platform !== 'win32') fs.chmodSync(directory, 0o700);
      fsyncDirectory(path.dirname(directory));
    } catch (error) {
      if (error?.code !== 'EEXIST') throw layoutError('LEDGER_PATH_INVALID', role, error);
    }
    assertRealDirectory(directory, role);
  }
}

function purposeDefinition(purposeId) {
  const purpose = SAFETY_LEDGER_PURPOSES[purposeId];
  if (!purpose) throw layoutError('LEDGER_CONFIGURATION_INVALID', 'purpose');
  return purpose;
}

// Every path of one purpose's ledger.
function purposePaths(directories, purposeId) {
  const purpose = purposeDefinition(purposeId);
  const database = path.join(directories.ledgerDirectory, `${purpose.stem}.sqlite`);
  const locations = pathsFor(database);
  const witness = path.join(directories.witnessDirectory, `${purpose.stem}.witness`);
  const stagedDatabase = stagedPathOf(database);
  const reinitRequest = path.join(directories.ledgerDirectory, `reinit-${purpose.stem}.request.json`);
  const releaseRequest = path.join(directories.ledgerDirectory, `release-quarantine-${purpose.stem}.request.json`);
  return Object.freeze({
    purposeId,
    kind: purpose.kind,
    stem: purpose.stem,
    ledgerDirectory: directories.ledgerDirectory,
    witnessDirectory: directories.witnessDirectory,
    database,
    wal: locations.walPath,
    shm: locations.shmPath,
    journal: locations.journalPath,
    anchor: locations.anchorPath,
    receipt: locations.receiptPath,
    marker: locations.retainedLockPath,
    witness,
    stamp: quarantineStampPathFor(witness),
    staged: Object.freeze({
      database: stagedDatabase,
      wal: `${stagedDatabase}-wal`,
      shm: `${stagedDatabase}-shm`,
      journal: `${stagedDatabase}-journal`,
      anchor: stagedPathOf(locations.anchorPath),
      receipt: stagedPathOf(locations.receiptPath),
      witness: stagedPathOf(witness),
    }),
    reinitRequest,
    releaseRequest,
    // A request is written here first and renamed into place; a leftover is ignored.
    reinitRequestTemp: requestTempPath(reinitRequest),
    releaseRequestTemp: requestTempPath(releaseRequest),
  });
}

function registeredPathsOf(paths) {
  return Object.freeze({ anchor: paths.anchor, database: paths.database, receipt: paths.receipt, witness: paths.witness });
}

// The role of the first registered path that differs from the current layout, or null.
function registeredPathMismatch(registration, paths) {
  for (const role of PATH_ROLES) {
    if (pathIdentity(registration.paths[role]) !== pathIdentity(paths[role])) return role;
  }
  return null;
}

function cutoverFor(purposeId, genesisMs) {
  return purposeDefinition(purposeId).cutover === 'zero' ? 0 : genesisMs;
}

// A ledger ID ends in 32 random hex digits; their first eight are the confirmation code
// an operator types for reinit and release-quarantine.
function generateLedgerId(purposeId, randomBytes = crypto.randomBytes) {
  const purpose = purposeDefinition(purposeId);
  return `${LEDGER_ID_PREFIX}-${purpose.stem}-${randomBytes(16).toString('hex')}`;
}

function confirmationCode(ledgerId) {
  const text = String(ledgerId || '');
  const match = /-([a-f0-9]{32})$/u.exec(text);
  return match ? match[1].slice(0, 8) : crypto.createHash('sha256').update(text).digest('hex').slice(0, 8);
}

// ---------------------------------------------------------------------------
// Registration format (coin_metadata safety_ledger:<purposeId>, schema 1)
// ---------------------------------------------------------------------------

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function invalidRegistration(reason) {
  return layoutError('LEDGER_REGISTRATION_INVALID', reason);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, keys) {
  return isPlainObject(value) && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function nonNegative(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function validToken(value, maximum) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum && TOKEN.test(value);
}

function normalizeLastSeen(value) {
  if (value === null) return null;
  if (!exactKeys(value, ['atMs', 'beginSeq', 'bootEpoch', 'chainHead']) || !nonNegative(value.atMs) ||
      !nonNegative(value.beginSeq) || !nonNegative(value.bootEpoch) || !HEX64.test(value.chainHead || '')) {
    throw invalidRegistration('last-seen');
  }
  return Object.freeze({ atMs: value.atMs, beginSeq: value.beginSeq, bootEpoch: value.bootEpoch, chainHead: value.chainHead });
}

function normalizeQuarantine(value) {
  if (value === null) return null;
  if (!exactKeys(value, ['ledgerId', 'reason', 'requestedAtMs']) || !validToken(value.ledgerId, 128) ||
      !validToken(value.reason, 64) || !nonNegative(value.requestedAtMs)) {
    throw invalidRegistration('quarantine');
  }
  return Object.freeze({ ledgerId: value.ledgerId, reason: value.reason, requestedAtMs: value.requestedAtMs });
}

function normalizePrevious(value) {
  if (!Array.isArray(value) || value.length > REGISTRATION_MAX_PREVIOUS) throw invalidRegistration('previous');
  return Object.freeze(value.map((item) => {
    if (!exactKeys(item, ['ledgerId', 'reason', 'retiredAtMs']) || !validToken(item.ledgerId, 128) ||
        !validToken(item.reason, 64) || !nonNegative(item.retiredAtMs)) {
      throw invalidRegistration('previous');
    }
    return Object.freeze({ ledgerId: item.ledgerId, reason: item.reason, retiredAtMs: item.retiredAtMs });
  }));
}

function normalizePaths(value) {
  if (!exactKeys(value, PATH_ROLES)) throw invalidRegistration('paths');
  const paths = {};
  for (const role of PATH_ROLES) {
    const item = value[role];
    if (typeof item !== 'string' || item.length > 1_024 || !path.isAbsolute(item) || CONTROL_CHARACTERS.test(item) ||
        isRemotePath(item)) {
      throw invalidRegistration('paths');
    }
    paths[role] = item;
  }
  return Object.freeze(paths);
}

// Strict validation of one registration: exactly the schema-1 fields, each well formed,
// and consistent with the purpose it is stored under.
function normalizeRegistration(purposeId, value) {
  const purpose = SAFETY_LEDGER_PURPOSES[purposeId];
  if (!purpose) throw invalidRegistration('purpose');
  if (!exactKeys(value, REGISTRATION_KEYS)) throw invalidRegistration('fields');
  if (value.schema !== REGISTRATION_SCHEMA) throw invalidRegistration('schema');
  if (!REGISTRATION_STATES.includes(value.state)) throw invalidRegistration('state');
  if (value.purposeId !== purposeId) throw invalidRegistration('purpose');
  if (value.kind !== purpose.kind) throw invalidRegistration('kind');
  if (!validToken(value.ledgerId, 128)) throw invalidRegistration('ledger-id');
  if (!RUNTIME_MODES.includes(value.runtimeMode)) throw invalidRegistration('runtime-mode');
  if (!SNOWFLAKE.test(value.botId || '')) throw invalidRegistration('bot');
  if (purpose.kind === 'owner'
    ? !SNOWFLAKE.test(value.ownerId || '') || value.ownerId === value.botId
    : value.ownerId !== null) {
    throw invalidRegistration('owner');
  }
  if (!nonNegative(value.genesisMs)) throw invalidRegistration('genesis');
  if (!nonNegative(value.cutoverMs)) throw invalidRegistration('cutover');
  if (value.createdBy !== CREATED_BY_BOOTSTRAP) throw invalidRegistration('created-by');
  if (value.receiptSha256 !== null && !HEX64.test(value.receiptSha256 || '')) throw invalidRegistration('receipt');
  if (value.state === 'active' && value.receiptSha256 === null) throw invalidRegistration('receipt');
  if (value.state === 'creating' && value.receiptSha256 !== null) throw invalidRegistration('receipt');
  return Object.freeze({
    schema: REGISTRATION_SCHEMA,
    state: value.state,
    purposeId,
    kind: purpose.kind,
    ledgerId: value.ledgerId,
    runtimeMode: value.runtimeMode,
    botId: value.botId,
    ownerId: value.ownerId,
    genesisMs: value.genesisMs,
    cutoverMs: value.cutoverMs,
    paths: normalizePaths(value.paths),
    receiptSha256: value.receiptSha256,
    lastSeen: normalizeLastSeen(value.lastSeen),
    quarantine: normalizeQuarantine(value.quarantine),
    createdBy: value.createdBy,
    previous: normalizePrevious(value.previous),
  });
}

function decodeRegistration(purposeId, raw) {
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw) > REGISTRATION_MAX_BYTES) {
    throw invalidRegistration('size');
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw invalidRegistration('json');
  }
  return normalizeRegistration(purposeId, parsed);
}

// Fixed key order (sorted at every level), at most 4 KiB. The oldest `previous` entries
// are dropped first if the value would be larger; past that the paths are too long.
function encodeRegistration(purposeId, registration) {
  const normalized = normalizeRegistration(purposeId, registration);
  let previous = [...normalized.previous];
  for (;;) {
    const encoded = stableJson({ ...normalized, previous });
    if (Buffer.byteLength(encoded) <= REGISTRATION_MAX_BYTES) return encoded;
    if (!previous.length) throw layoutError('LEDGER_PATH_INVALID', 'registration-size');
    previous = previous.slice(0, -1);
  }
}

// When a registration was last written: its coin_metadata updated_at (always written by
// toISOString), in milliseconds, or null for anything not in exactly that form. The value
// must also survive a round trip, because Date.parse rolls impossible dates and times
// (2026-02-30, T24:00) forward instead of refusing them.
const REGISTRATION_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function registrationTimeMs(updatedAt) {
  if (typeof updatedAt !== 'string' || !REGISTRATION_TIME.test(updatedAt)) return null;
  const value = Date.parse(updatedAt);
  if (!Number.isSafeInteger(value) || new Date(value).toISOString() !== updatedAt) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Request files and retired directories
// ---------------------------------------------------------------------------

function readSmallJson(filePath, maximum, code, reason) {
  const stat = lstatOrNull(filePath, reason);
  if (!stat) return null;
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maximum) {
    throw layoutError(code, reason);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw layoutError(code, reason, error);
  }
}

function writeNewDurableFile(filePath, text) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(descriptor, text, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(filePath));
}

function normalizeRequest(value, purposeId) {
  const keys = ['kind', 'ledgerId', 'purposeId', 'requestedAtMs', 'retired', 'schema'];
  if (!exactKeys(value, keys) || value.schema !== REQUEST_SCHEMA || !REQUEST_KINDS.includes(value.kind) ||
      value.purposeId !== purposeId || !nonNegative(value.requestedAtMs) ||
      !(value.ledgerId === null || validToken(value.ledgerId, 128)) ||
      !exactKeys(value.retired, ['ledgerDirectory', 'witnessDirectory'])) {
    throw layoutError('LEDGER_REQUEST_INVALID', 'format');
  }
  for (const name of [value.retired.ledgerDirectory, value.retired.witnessDirectory]) {
    if (name !== null && !RETIRED_NAME.test(String(name))) throw layoutError('LEDGER_REQUEST_INVALID', 'format');
  }
  if (value.kind === 'release-quarantine' && value.ledgerId === null) throw layoutError('LEDGER_REQUEST_INVALID', 'format');
  return Object.freeze({ ...value, retired: Object.freeze({ ...value.retired }) });
}

// The parsed request at requestPath, or null when there is none. Only the final name is
// read: a leftover <request>.tmp is never a request.
function readRequest(requestPath, purposeId) {
  const value = readSmallJson(requestPath, REQUEST_MAX_BYTES, 'LEDGER_REQUEST_INVALID', 'request');
  return value === null ? null : normalizeRequest(value, purposeId);
}

function requestTempPath(requestPath) {
  return `${requestPath}.tmp`;
}

// Writes a request atomically: the JSON goes to <request>.tmp, is fsynced, and is renamed
// to the final name, which must not exist yet; then the directory is flushed. A crash
// leaves either no request or a complete one, at most with a leftover .tmp file, which
// readers ignore and the next write replaces (it is this tool's own unfinished output,
// never ledger evidence; anything at that name other than a plain file is refused).
async function writeRequest(requestPath, request) {
  const normalized = normalizeRequest(request, request?.purposeId);
  if (lstatOrNull(requestPath, 'request')) throw layoutError('LEDGER_REQUEST_INVALID', 'exists');
  const tempPath = requestTempPath(requestPath);
  const stale = lstatOrNull(tempPath, 'request');
  if (stale && (stale.isSymbolicLink() || !stale.isFile() || stale.nlink !== 1)) {
    throw layoutError('LEDGER_REQUEST_INVALID', 'temp');
  }
  let descriptor;
  try {
    descriptor = fs.openSync(tempPath, 'w', 0o600);
    fs.writeFileSync(descriptor, `${stableJson(normalized)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (lstatOrNull(requestPath, 'request')) throw layoutError('LEDGER_REQUEST_INVALID', 'exists');
  await renameWithRetry(tempPath, requestPath);
  fsyncDirectory(path.dirname(requestPath));
  return normalized;
}

function readManifest(retiredDirectory) {
  const value = readSmallJson(path.join(retiredDirectory, MANIFEST_NAME), MANIFEST_MAX_BYTES,
    'LEDGER_REQUEST_INVALID', 'manifest');
  if (value === null) return null;
  const keys = ['createdBy', 'files', 'ledgerId', 'purposeId', 'reason', 'retiredAtMs', 'schema'];
  if (!exactKeys(value, keys) || value.schema !== 1 || !Array.isArray(value.files) ||
      !(value.ledgerId === null || validToken(value.ledgerId, 128)) || !REASON.test(String(value.reason || '')) ||
      !nonNegative(value.retiredAtMs) || !['bootstrap', 'script'].includes(value.createdBy)) {
    throw layoutError('LEDGER_REQUEST_INVALID', 'manifest');
  }
  return Object.freeze(value);
}

function compactUtc(ms) {
  return new Date(ms).toISOString().replace(/[-:.]/gu, '');
}

function retiredDirectoryName(directory, { stem, reason, nowMs }) {
  if (!REASON.test(reason)) throw layoutError('LEDGER_CONFIGURATION_INVALID', 'retire-reason');
  const base = `retired-${compactUtc(nowMs)}-${stem}-${reason}`;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const name = attempt === 0 ? base : `${base}-${attempt + 1}`;
    if (!lstatOrNull(path.join(directory, name), 'retired')) return name;
  }
  throw layoutError('LEDGER_PATH_INVALID', 'retired-name');
}

// Moves the existing files among `files` (all directly inside `directory`) into a new
// retired-<UTC>-<stem>-<reason> directory beside them, with a manifest. Nothing is ever
// deleted, and the move stays on one volume. Order: create the directory, write and
// fsync the manifest, rename the files, fsync both directories. Returns null when none
// of the files exists, unless allowEmpty asks for a manifest that records the decision.
async function retireFiles({ directory, purposeId, ledgerId = null, reason, nowMs, createdBy, files,
  allowEmpty = false }) {
  const purpose = purposeDefinition(purposeId);
  const existing = [];
  for (const { role, filePath } of files) {
    const stat = lstatOrNull(filePath, 'retire');
    if (!stat) continue;
    if (pathIdentity(path.dirname(filePath)) !== pathIdentity(directory)) {
      throw layoutError('LEDGER_CONFIGURATION_INVALID', 'retire-directory');
    }
    existing.push({ role, filePath, name: path.basename(filePath), size: stat.size });
  }
  if (!existing.length && !allowEmpty) return null;
  const name = retiredDirectoryName(directory, { stem: purpose.stem, reason, nowMs });
  const retiredDirectory = path.join(directory, name);
  fs.mkdirSync(retiredDirectory, { mode: 0o700 });
  fsyncDirectory(directory);
  writeNewDurableFile(path.join(retiredDirectory, MANIFEST_NAME), `${JSON.stringify({
    schema: 1,
    purposeId,
    ledgerId,
    reason,
    retiredAtMs: nowMs,
    createdBy,
    files: existing.map(({ role, name: fileName, size }) => ({ role, name: fileName, size })),
  }, null, 2)}\n`);
  for (const item of existing) await renameWithRetry(item.filePath, path.join(retiredDirectory, item.name));
  fsyncDirectory(retiredDirectory);
  fsyncDirectory(directory);
  return Object.freeze({ name, path: retiredDirectory, moved: Object.freeze(existing.map((item) => item.role)) });
}

// Moves a processed request into the retired directory it names, as <kind>.request.json.
async function consumeRequest(requestPath, retiredDirectory, kind) {
  const target = path.join(retiredDirectory, `${kind}.request.json`);
  if (lstatOrNull(target, 'request')) throw layoutError('LEDGER_REQUEST_INVALID', 'already-consumed');
  await renameWithRetry(requestPath, target);
  fsyncDirectory(retiredDirectory);
  fsyncDirectory(path.dirname(requestPath));
  return target;
}

module.exports = {
  LEDGER_DIRECTORY_NAME,
  LedgerLayoutError,
  MANIFEST_NAME,
  PROJECT_ROOT,
  PURPOSE_IDS,
  REGISTRATION_MAX_BYTES,
  REGISTRATION_MAX_PREVIOUS,
  REGISTRATION_SCHEMA,
  RETIRED_NAME,
  SAFETY_LEDGER_PURPOSES,
  WITNESS_DIRECTORY_NAME,
  confirmationCode,
  consumeRequest,
  cutoverFor,
  decodeRegistration,
  encodeRegistration,
  ensureLedgerDirectories,
  generateLedgerId,
  isWithin,
  normalizeRegistration,
  pathIdentity,
  purposePaths,
  readManifest,
  readRequest,
  requestTempPath,
  registeredPathMismatch,
  registeredPathsOf,
  registrationTimeMs,
  resolveLedgerBase,
  resolveLedgerDirectories,
  retireFiles,
  stableJson,
  writeRequest,
};
