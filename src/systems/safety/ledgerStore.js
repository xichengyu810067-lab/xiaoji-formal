'use strict';

/*
 * Side-effect ledger storage core, format 2 (node:sqlite).
 *
 * - One SQLite file per ledger kind ('owner' or 'public'); operations are keyed by
 *   (purpose_id, operation_id), so one public file can hold several purposes.
 * - The file is opened with locking_mode=EXCLUSIVE, journal_mode=WAL, and
 *   synchronous=FULL. The exclusive lock lives only as long as the owning process: when
 *   that process exits or is killed, the operating system releases it and no lock file is
 *   left behind. A second opener receives the retryable code LEDGER_IN_USE.
 * - Durable operation rows only exist as attempted -> confirmed | rejected | unknown |
 *   not_sent. Claims, leases, suppressions, merges, and budget decisions stay in the
 *   caller's memory; one worker per purpose plus the exclusive lock prevents duplicates.
 * - Every durable transition is a single BEGIN IMMEDIATE transaction. Each boot, begin,
 *   and reaction-fence change is a sequenced step: it advances boot_epoch or begin_seq by
 *   exactly one and extends a SHA-256 chain (chain_prev -> chain_head) kept in the
 *   identity row. Opening the ledger turns attempted rows from an earlier boot into
 *   unknown.
 * - Each caller-provided witness file holds two 256-byte slots rewritten in place with
 *   fsync (no rename). A witness records the counters and chain head of the last step.
 *   On open the database may be at most one step ahead of every witness, and the chain
 *   must connect (equal heads, or the database's previous head equal to the witness
 *   head); anything else is LEDGER_ROLLBACK. Witnesses are then resynchronized before the
 *   boot step, so an interrupted witness write never accumulates into a larger gap.
 * - Terminal rows older than the retention period may be pruned; their source time is
 *   merged into a per-(purpose, source_key) watermark that never decreases. A source with
 *   no row and a source time at or below its watermark (or the cutover) is terminal. A
 *   trigger lets a row be deleted only when it is terminal, has a source time, and is
 *   already covered by its watermark.
 * - The 100-byte SQLite header (magic, WAL, application_id, schema revision in
 *   user_version) is checked before SQLite touches the file; an older known schema
 *   revision is reported as LEDGER_FORMAT_OUTDATED, never as corruption.
 * - Triggers and the keyless SHA-256 digests catch accidents, foreign tools, and partial
 *   restores. They cannot stop someone who can write the files: such a writer can drop
 *   triggers, recompute digests, and rewrite witnesses. Protect the directories instead.
 * - Ledger and witness paths must be local: UNC and device paths (\\server, //server,
 *   \\?\, \\.\), a Windows drive that resolves to a network share, and Linux network or
 *   FUSE file systems are refused with LEDGER_PATH_REMOTE, because their locks and fsync
 *   cannot be trusted. macOS is checked on a best-effort basis only (by path prefix).
 * - A caller may pass the last state it recorded elsewhere (expected.notBefore: boot
 *   epoch, begin sequence, chain head). It is compared after the witnesses and before any
 *   write: a database behind it is LEDGER_ROLLBACK registration-ahead, the same counters
 *   with another chain head are registration-fork. A database ahead of it is accepted,
 *   because that record may lag.
 * - recordDecision is the only durable "not sent" path: one BEGIN IMMEDIATE transaction
 *   inserts the row as attempted and settles it as not_sent, as its own sequenced step
 *   ('decide'). Like every step it returns only after the commit and every witness write
 *   and fsync, so a caller never acts on a decision that a restore could silently undo.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DatabaseSync } = require('node:sqlite');
const defaultLogger = require('../../utils/logger');

// STORE_FORMAT is the ledger generation (format 2, kept in identity.format). SCHEMA_VERSION
// is the revision of its SQLite schema (kept in PRAGMA user_version); revision 2 files came
// from earlier development builds of format 2 and are refused as outdated, not corrupt.
const STORE_FORMAT = 2;
const SCHEMA_VERSION = 3;
const OLDEST_KNOWN_SCHEMA_VERSION = 2;
const APPLICATION_ID = 0x584a4c47; // ASCII "XJLG"
const LEDGER_KINDS = Object.freeze(['owner', 'public']);
const RUNTIME_MODES = Object.freeze(['production', 'test-control']);
const DURABLE_STATES = Object.freeze(['attempted', 'confirmed', 'rejected', 'unknown', 'not_sent']);
const TERMINAL_STATES = Object.freeze(['confirmed', 'rejected', 'unknown', 'not_sent']);
const DAY_MS = 24 * 60 * 60 * 1_000;
const RETENTION_MS = 30 * DAY_MS;
const ACCELERATED_RETENTION_MS = 7 * DAY_MS;
const SOFT_LIMIT_BYTES = 512 * 1024 * 1024;
const PRUNE_BATCH_ROWS = 2_000;
const PRUNE_EVERY_BEGINS = 512;
const BOOT_PRUNE_MAX_BATCHES = 32;
const ACCELERATED_PRUNE_MAX_BATCHES = 32;
// A ledger at its soft size limit runs the accelerated prune, and logs its two capacity
// warnings, at most once in this interval (measured on the ledger's own clock). Inside
// the interval a growth write is refused at once with LEDGER_CAPACITY_EXCEEDED.
const CAPACITY_RELIEF_INTERVAL_MS = 10 * 60 * 1_000;
const MAX_BINDING_JSON_BYTES = 8 * 1024;
const MAX_RESULT_JSON_BYTES = 2 * 1024;
const WITNESS_SLOT_BYTES = 256;
const WITNESS_BYTES = 2 * WITNESS_SLOT_BYTES;
const WITNESS_BODY_BYTES = WITNESS_SLOT_BYTES - 32;
const WITNESS_MAGIC = Buffer.from('XJLWIT03', 'ascii');
const WITNESS_CHAIN_END = 104;
const CHAIN_LABEL = 'xiaoji-ledger-chain-v2';
const SQLITE_HEADER_MAGIC = Buffer.from('SQLite format 3\u0000', 'latin1');
const DURABILITY_FULL = 'full';
// Test-only profile: identical SQL and witness writes, but without fsync. It exists so
// algorithmic growth can be measured without disk-flush noise; it is refused unless the
// Node test runner started this process (NODE_TEST_CONTEXT).
const DURABILITY_UNSAFE_NO_SYNC = 'unsafe-no-sync-for-tests';

const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CANTOPEN = 14;
const SQLITE_NOTADB = 26;
// SQLite results that mean the file itself can no longer be trusted.
const FAILING_SQLITE_CODES = new Set([SQLITE_IOERR, SQLITE_CORRUPT, SQLITE_NOTADB]);

const TOKEN = /^[A-Za-z0-9:._/-]+$/u;
const SNOWFLAKE = /^\d{17,20}$/u;
const HEX64 = /^[a-f0-9]{64}$/u;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
// UNC shares and Win32 device namespaces (\\server, //server, \\?\, \\.\) on any platform.
const REMOTE_PATH_PREFIX = /^(?:\\\\|\/\/)/u;
// Linux statfs f_type values of network, cluster, and FUSE file systems. Their locks and
// fsync cannot be trusted, so every one of them is refused.
const REMOTE_FILE_SYSTEM_TYPES = new Map([
  [0x6969, 'nfs'],
  [0x517b, 'smb'],
  [0xff534d42, 'cifs'],
  [0xfe534d42, 'smb2'],
  [0x01021997, '9p'],
  [0x00c36400, 'ceph'],
  [0x5346414f, 'afs'],
  [0x6b414653, 'afs'],
  [0x65735546, 'fuse'],
]);

// Errors a caller can handle without the store becoming unusable.
const REJECTION_CODES = new Set([
  'LEDGER_BINDING_CONFLICT',
  'LEDGER_TRANSITION_REJECTED',
  'LEDGER_SOURCE_TERMINAL',
  'LEDGER_CAPACITY_EXCEEDED',
  'LEDGER_INPUT_INVALID',
  'LEDGER_WRITE_FORBIDDEN',
]);

// Databases this process holds open, keyed by exact file identity. A second open is
// refused before any descriptor is touched: on POSIX, closing any descriptor of a file
// drops every advisory lock this process holds on it, including SQLite's.
const OPEN_DATABASES = new Set();

class LedgerStoreError extends Error {
  constructor(code, message, { retryable = false, cause, detail } = {}) {
    super(message, cause ? { cause } : undefined);
    this.name = 'LedgerStoreError';
    this.code = code;
    this.retryable = retryable;
    if (detail !== undefined) this.detail = detail;
  }
}

function storeError(code, message, options) {
  return new LedgerStoreError(code, message, options);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function normalizeSql(sql) {
  return String(sql || '').replace(/\s+/gu, ' ').trim();
}

function chainGenesis({ ledgerId, kind, genesisMs }, nonce) {
  return sha256Hex([CHAIN_LABEL, ledgerId, kind, genesisMs, nonce].join('\n'));
}

function chainStep(previous, fields) {
  return sha256Hex([previous, ...fields].join('\n'));
}

const SCHEMA = Object.freeze([
  Object.freeze({ type: 'table', name: 'identity', tableName: 'identity', sql: `CREATE TABLE identity (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    ledger_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('owner', 'public')),
    format INTEGER NOT NULL CHECK (format = 2),
    bot_id TEXT NOT NULL,
    owner_id TEXT,
    runtime_mode TEXT NOT NULL,
    genesis_ms INTEGER NOT NULL CHECK (genesis_ms >= 0),
    cutover_ms INTEGER NOT NULL CHECK (cutover_ms >= 0),
    boot_epoch INTEGER NOT NULL CHECK (boot_epoch >= 0),
    begin_seq INTEGER NOT NULL CHECK (begin_seq >= 0),
    high_water_ms INTEGER NOT NULL CHECK (high_water_ms >= 0),
    chain_head TEXT NOT NULL CHECK (length(chain_head) = 64),
    chain_prev TEXT NOT NULL CHECK (length(chain_prev) = 64)
  ) STRICT` }),
  Object.freeze({ type: 'table', name: 'operations', tableName: 'operations', sql: `CREATE TABLE operations (
    purpose_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    source_time_ms INTEGER CHECK (source_time_ms IS NULL OR source_time_ms >= 0),
    binding_digest TEXT NOT NULL,
    binding_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('attempted', 'confirmed', 'rejected', 'unknown', 'not_sent')),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    target TEXT NOT NULL,
    merge_key TEXT NOT NULL,
    merge_window_until_ms INTEGER,
    budget_charged INTEGER NOT NULL CHECK (budget_charged IN (0, 1)),
    budget_reserved_at_ms INTEGER,
    boot_epoch INTEGER NOT NULL CHECK (boot_epoch >= 1),
    begin_seq INTEGER NOT NULL CHECK (begin_seq >= 1),
    claimed_at_ms INTEGER NOT NULL,
    attempted_at_ms INTEGER NOT NULL,
    finished_at_ms INTEGER,
    result_code TEXT,
    result_json TEXT,
    result_digest TEXT,
    PRIMARY KEY (purpose_id, operation_id),
    CHECK ((state = 'attempted') = (finished_at_ms IS NULL)),
    CHECK ((result_json IS NULL) = (result_digest IS NULL))
  ) STRICT` }),
  Object.freeze({ type: 'index', name: 'operations_attempted', tableName: 'operations', sql:
    'CREATE INDEX operations_attempted ON operations (purpose_id) WHERE state = \'attempted\'' }),
  Object.freeze({ type: 'index', name: 'operations_retention', tableName: 'operations', sql:
    'CREATE INDEX operations_retention ON operations (finished_at_ms) ' +
    'WHERE state <> \'attempted\' AND source_time_ms IS NOT NULL' }),
  Object.freeze({ type: 'index', name: 'operations_merge', tableName: 'operations', sql:
    'CREATE INDEX operations_merge ON operations (purpose_id, merge_key, merge_window_until_ms) ' +
    'WHERE merge_window_until_ms IS NOT NULL' }),
  Object.freeze({ type: 'index', name: 'operations_budget', tableName: 'operations', sql:
    'CREATE INDEX operations_budget ON operations (purpose_id, target, budget_reserved_at_ms) ' +
    'WHERE budget_charged = 1' }),
  Object.freeze({ type: 'table', name: 'watermarks', tableName: 'watermarks', sql: `CREATE TABLE watermarks (
    purpose_id TEXT NOT NULL,
    source_key TEXT NOT NULL,
    watermark_ms INTEGER NOT NULL CHECK (watermark_ms >= 0),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (purpose_id, source_key)
  ) STRICT` }),
  Object.freeze({ type: 'table', name: 'reaction_fences', tableName: 'reaction_fences', sql: `CREATE TABLE reaction_fences (
    purpose_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation >= 1),
    open INTEGER NOT NULL CHECK (open IN (0, 1)),
    channel_id TEXT NOT NULL,
    session_key TEXT NOT NULL,
    source_fence TEXT NOT NULL,
    boot_epoch INTEGER NOT NULL CHECK (boot_epoch >= 1),
    begin_seq INTEGER NOT NULL CHECK (begin_seq >= 1),
    updated_at_ms INTEGER NOT NULL,
    PRIMARY KEY (purpose_id, guild_id)
  ) STRICT` }),
  Object.freeze({ type: 'trigger', name: 'identity_single', tableName: 'identity', sql: `CREATE TRIGGER identity_single
    BEFORE INSERT ON identity WHEN EXISTS (SELECT 1 FROM identity)
    BEGIN SELECT RAISE(ABORT, 'ledger identity is created once'); END` }),
  Object.freeze({ type: 'trigger', name: 'identity_immutable', tableName: 'identity', sql: `CREATE TRIGGER identity_immutable
    BEFORE UPDATE ON identity
    WHEN NEW.singleton IS NOT OLD.singleton OR NEW.ledger_id IS NOT OLD.ledger_id
      OR NEW.kind IS NOT OLD.kind OR NEW.format IS NOT OLD.format OR NEW.bot_id IS NOT OLD.bot_id
      OR NEW.owner_id IS NOT OLD.owner_id OR NEW.runtime_mode IS NOT OLD.runtime_mode
      OR NEW.genesis_ms IS NOT OLD.genesis_ms OR NEW.cutover_ms IS NOT OLD.cutover_ms
      OR NEW.boot_epoch < OLD.boot_epoch OR NEW.begin_seq < OLD.begin_seq
      OR NEW.high_water_ms < OLD.high_water_ms
      OR (NEW.boot_epoch - OLD.boot_epoch) + (NEW.begin_seq - OLD.begin_seq) > 1
      OR (NEW.boot_epoch = OLD.boot_epoch AND NEW.begin_seq = OLD.begin_seq
        AND (NEW.chain_head IS NOT OLD.chain_head OR NEW.chain_prev IS NOT OLD.chain_prev))
      OR ((NEW.boot_epoch <> OLD.boot_epoch OR NEW.begin_seq <> OLD.begin_seq)
        AND (NEW.chain_prev IS NOT OLD.chain_head OR NEW.chain_head IS OLD.chain_head))
    BEGIN SELECT RAISE(ABORT,
      'ledger identity is immutable, its counters never decrease, and it advances one chained step at a time');
    END` }),
  Object.freeze({ type: 'trigger', name: 'identity_permanent', tableName: 'identity', sql: `CREATE TRIGGER identity_permanent
    BEFORE DELETE ON identity
    BEGIN SELECT RAISE(ABORT, 'ledger identity is permanent'); END` }),
  Object.freeze({ type: 'trigger', name: 'operations_unique', tableName: 'operations', sql: `CREATE TRIGGER operations_unique
    BEFORE INSERT ON operations
    WHEN EXISTS (SELECT 1 FROM operations WHERE purpose_id = NEW.purpose_id AND operation_id = NEW.operation_id)
    BEGIN SELECT RAISE(ABORT, 'an operation is recorded once and never replaced'); END` }),
  Object.freeze({ type: 'trigger', name: 'operations_born_attempted', tableName: 'operations', sql: `CREATE TRIGGER operations_born_attempted
    BEFORE INSERT ON operations WHEN NEW.state <> 'attempted'
    BEGIN SELECT RAISE(ABORT, 'operations are recorded only when attempted'); END` }),
  Object.freeze({ type: 'trigger', name: 'operations_terminal_once', tableName: 'operations', sql: `CREATE TRIGGER operations_terminal_once
    BEFORE UPDATE ON operations
    WHEN OLD.state <> 'attempted' OR NEW.state = 'attempted'
      OR NEW.purpose_id IS NOT OLD.purpose_id OR NEW.operation_id IS NOT OLD.operation_id
      OR NEW.source_key IS NOT OLD.source_key OR NEW.source_time_ms IS NOT OLD.source_time_ms
      OR NEW.binding_digest IS NOT OLD.binding_digest OR NEW.binding_json IS NOT OLD.binding_json
      OR NEW.generation IS NOT OLD.generation OR NEW.target IS NOT OLD.target
      OR NEW.merge_key IS NOT OLD.merge_key OR NEW.merge_window_until_ms IS NOT OLD.merge_window_until_ms
      OR NEW.budget_charged IS NOT OLD.budget_charged
      OR NEW.budget_reserved_at_ms IS NOT OLD.budget_reserved_at_ms
      OR NEW.boot_epoch IS NOT OLD.boot_epoch OR NEW.begin_seq IS NOT OLD.begin_seq
      OR NEW.claimed_at_ms IS NOT OLD.claimed_at_ms OR NEW.attempted_at_ms IS NOT OLD.attempted_at_ms
    BEGIN SELECT RAISE(ABORT, 'operations move once from attempted to a terminal state'); END` }),
  // Only pruning may delete: the row must be terminal, carry a source time, and already be
  // covered by its source's watermark. Rows without a source time can never be deleted.
  Object.freeze({ type: 'trigger', name: 'operations_delete_guard', tableName: 'operations', sql: `CREATE TRIGGER operations_delete_guard
    BEFORE DELETE ON operations
    WHEN OLD.state = 'attempted' OR OLD.source_time_ms IS NULL
      OR NOT EXISTS (SELECT 1 FROM watermarks WHERE purpose_id = OLD.purpose_id AND source_key = OLD.source_key
        AND watermark_ms >= OLD.source_time_ms)
    BEGIN SELECT RAISE(ABORT, 'only terminal operations already covered by a watermark can be deleted'); END` }),
  Object.freeze({ type: 'trigger', name: 'watermarks_unique', tableName: 'watermarks', sql: `CREATE TRIGGER watermarks_unique
    BEFORE INSERT ON watermarks
    WHEN EXISTS (SELECT 1 FROM watermarks WHERE purpose_id = NEW.purpose_id AND source_key = NEW.source_key)
    BEGIN SELECT RAISE(ABORT, 'a watermark is created once and then only raised'); END` }),
  Object.freeze({ type: 'trigger', name: 'watermarks_monotonic', tableName: 'watermarks', sql: `CREATE TRIGGER watermarks_monotonic
    BEFORE UPDATE ON watermarks
    WHEN NEW.purpose_id IS NOT OLD.purpose_id OR NEW.source_key IS NOT OLD.source_key
      OR NEW.watermark_ms < OLD.watermark_ms
    BEGIN SELECT RAISE(ABORT, 'watermarks never decrease'); END` }),
  Object.freeze({ type: 'trigger', name: 'watermarks_permanent', tableName: 'watermarks', sql: `CREATE TRIGGER watermarks_permanent
    BEFORE DELETE ON watermarks
    BEGIN SELECT RAISE(ABORT, 'watermarks are permanent'); END` }),
  Object.freeze({ type: 'trigger', name: 'reaction_fences_unique', tableName: 'reaction_fences', sql: `CREATE TRIGGER reaction_fences_unique
    BEFORE INSERT ON reaction_fences
    WHEN EXISTS (SELECT 1 FROM reaction_fences WHERE purpose_id = NEW.purpose_id AND guild_id = NEW.guild_id)
    BEGIN SELECT RAISE(ABORT, 'a reaction fence is created once and then updated'); END` }),
  Object.freeze({ type: 'trigger', name: 'reaction_fences_monotonic', tableName: 'reaction_fences', sql: `CREATE TRIGGER reaction_fences_monotonic
    BEFORE UPDATE ON reaction_fences
    WHEN NEW.purpose_id IS NOT OLD.purpose_id OR NEW.guild_id IS NOT OLD.guild_id
      OR NEW.generation < OLD.generation OR NEW.begin_seq <= OLD.begin_seq
    BEGIN SELECT RAISE(ABORT, 'reaction fence generations and sequence numbers never decrease'); END` }),
  Object.freeze({ type: 'trigger', name: 'reaction_fences_permanent', tableName: 'reaction_fences', sql: `CREATE TRIGGER reaction_fences_permanent
    BEFORE DELETE ON reaction_fences
    BEGIN SELECT RAISE(ABORT, 'reaction fences are permanent'); END` }),
]);

// The only schema rows without SQL: the automatic indexes of the composite primary keys.
const AUTOMATIC_INDEXES = Object.freeze([
  Object.freeze({ type: 'index', name: 'sqlite_autoindex_operations_1', tableName: 'operations', sql: null }),
  Object.freeze({ type: 'index', name: 'sqlite_autoindex_reaction_fences_1', tableName: 'reaction_fences', sql: null }),
  Object.freeze({ type: 'index', name: 'sqlite_autoindex_watermarks_1', tableName: 'watermarks', sql: null }),
]);

// ---------------------------------------------------------------------------
// Input validation
// ---------------------------------------------------------------------------

function invalid(message, detail) {
  return storeError('LEDGER_INPUT_INVALID', message, detail ? { detail } : undefined);
}

function requireToken(value, name, maximum = 256) {
  const normalized = typeof value === 'string' ? value : '';
  if (!normalized || normalized.length > maximum || !TOKEN.test(normalized)) throw invalid(`${name} is invalid.`);
  return normalized;
}

function requireText(value, name, maximum) {
  const normalized = typeof value === 'string' ? value : '';
  if (!normalized || normalized.trim() !== normalized || normalized.length > maximum ||
      CONTROL_CHARACTERS.test(normalized)) {
    throw invalid(`${name} is invalid.`);
  }
  return normalized;
}

function requireTime(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${name} is invalid.`);
  return value;
}

function optionalTime(value, name) {
  if (value === undefined || value === null) return null;
  return requireTime(value, name);
}

function requireCount(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw invalid(`${name} is invalid.`);
  return value;
}

function requireSnowflake(value, name) {
  if (typeof value !== 'string' || !SNOWFLAKE.test(value)) throw invalid(`${name} is invalid.`);
  return value;
}

// True for a UNC or device path, including one that only becomes one after resolution:
// on Windows "/\server\share" and "\/server/share" resolve to "\\server\share". Pure
// string work; nothing is touched on disk.
function isRemotePath(value) {
  if (typeof value !== 'string') return false;
  if (REMOTE_PATH_PREFIX.test(value)) return true;
  return REMOTE_PATH_PREFIX.test(path.resolve(value));
}

function requireAbsolutePath(value, name) {
  if (isRemotePath(value)) {
    throw storeError('LEDGER_PATH_REMOTE', `${name} must be a local path.`,
      { detail: { role: name, reason: 'unc-prefix' } });
  }
  if (typeof value !== 'string' || !path.isAbsolute(value)) {
    throw storeError('LEDGER_PATH_INVALID', `${name} must be an absolute path.`, { detail: { role: name } });
  }
  return path.resolve(value);
}

const DEFAULT_LOCALITY_PROBE = Object.freeze({
  platform: process.platform,
  realpathNative: (value) => fs.realpathSync.native(value),
  statfs: (value) => fs.statfsSync(value),
});

// Why an existing directory is not local, or null. Windows: the native real path of a
// drive mapped to a network share is that share's UNC path. Linux: the file system type.
// Other platforms (macOS) are checked by prefix only, which is a best-effort guard.
function classifyPathLocality(directory, probe = DEFAULT_LOCALITY_PROBE) {
  if (typeof directory !== 'string' || isRemotePath(directory)) return 'unc-prefix';
  if (probe.platform === 'win32') {
    const real = String(probe.realpathNative(directory) || '');
    return REMOTE_PATH_PREFIX.test(real) ? 'network-drive' : null;
  }
  if (probe.platform === 'linux') {
    const type = Number(probe.statfs(directory)?.type) >>> 0;
    return REMOTE_FILE_SYSTEM_TYPES.has(type) ? `network-${REMOTE_FILE_SYSTEM_TYPES.get(type)}` : null;
  }
  return null;
}

function assertLocalDirectory(directory, role) {
  let reason;
  try {
    reason = classifyPathLocality(directory);
  } catch (error) {
    throw storeError('LEDGER_PATH_INVALID', 'A ledger directory cannot be classified.', { cause: error, detail: { role } });
  }
  if (reason) {
    throw storeError('LEDGER_PATH_REMOTE', 'A ledger directory is not on a local file system.', { detail: { role, reason } });
  }
}

function safeNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) throw storeError('LEDGER_CLOCK_INVALID', 'Ledger clock is invalid.');
  return value;
}

function testRunnerActive() {
  return typeof process.env.NODE_TEST_CONTEXT === 'string' && process.env.NODE_TEST_CONTEXT.length > 0;
}

// Test-only options (no-fsync durability, fault injection) are refused unless the Node
// test runner started this process, so production configuration cannot enable them.
function assertTestOnlyOption(name) {
  if (!testRunnerActive()) {
    throw invalid(`${name} is accepted only inside the Node test runner.`, { reason: 'test-only-option', option: name });
  }
}

function normalizeDurability(value) {
  if (value === undefined || value === DURABILITY_FULL) return DURABILITY_FULL;
  if (value !== DURABILITY_UNSAFE_NO_SYNC) throw invalid('durability is invalid.');
  assertTestOnlyOption('durability');
  return DURABILITY_UNSAFE_NO_SYNC;
}

function normalizeFaultInjector(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'function') throw invalid('faultInjector is invalid.');
  assertTestOnlyOption('faultInjector');
  return value;
}

function normalizeLogger(value) {
  if (value === undefined || value === null) return defaultLogger;
  if (typeof value !== 'object' || typeof value.warn !== 'function' || typeof value.error !== 'function') {
    throw invalid('logger is invalid.');
  }
  return value;
}

// ---------------------------------------------------------------------------
// Path safety: no symbolic links, junctions, or hard links anywhere in the chain
// ---------------------------------------------------------------------------

function pathIdentity(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function lstatOrNull(filePath, role, options) {
  try {
    return fs.lstatSync(filePath, options);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw storeError('LEDGER_PATH_INVALID', 'A ledger path cannot be inspected.', { cause: error, detail: { role } });
  }
}

function realPathIdentity(filePath, role) {
  try {
    return pathIdentity(fs.realpathSync(filePath));
  } catch (error) {
    throw storeError('LEDGER_PATH_INVALID', 'A ledger path cannot be resolved.', { cause: error, detail: { role } });
  }
}

// Node reports Windows junctions as symbolic links through lstat, and realpath resolves
// both, so comparing the real path with the requested path rejects any link in the chain.
function assertRealDirectory(directory, role) {
  const stat = lstatOrNull(directory, role);
  if (!stat) throw storeError('LEDGER_PATH_INVALID', 'A ledger directory is missing.', { detail: { role } });
  if (stat.isSymbolicLink()) {
    throw storeError('LEDGER_PATH_LINKED', 'A ledger directory is a junction or symbolic link.', { detail: { role } });
  }
  if (!stat.isDirectory()) throw storeError('LEDGER_PATH_INVALID', 'A ledger directory is not a directory.', { detail: { role } });
  if (realPathIdentity(directory, role) !== pathIdentity(directory)) {
    throw storeError('LEDGER_PATH_LINKED', 'A ledger directory crosses a junction or symbolic link.', { detail: { role } });
  }
  assertLocalDirectory(directory, role);
}

function assertRegularFile(filePath, { role, required = true, exactSize } = {}) {
  const stat = lstatOrNull(filePath, role);
  if (!stat) {
    if (required) throw storeError('LEDGER_MISSING', 'A required ledger file is missing.', { detail: { role } });
    return null;
  }
  if (stat.isSymbolicLink()) {
    throw storeError('LEDGER_PATH_LINKED', 'A ledger file is a junction or symbolic link.', { detail: { role } });
  }
  if (!stat.isFile()) throw storeError('LEDGER_PATH_INVALID', 'A ledger file is not a regular file.', { detail: { role } });
  if (stat.nlink !== 1) throw storeError('LEDGER_PATH_LINKED', 'A ledger file has additional hard links.', { detail: { role } });
  if (realPathIdentity(filePath, role) !== pathIdentity(filePath)) {
    throw storeError('LEDGER_PATH_LINKED', 'A ledger file resolves through a link.', { detail: { role } });
  }
  if (exactSize !== undefined && stat.size !== exactSize) {
    throw storeError('LEDGER_WITNESS_INVALID', 'A ledger witness has an unexpected size.', { detail: { role } });
  }
  return stat;
}

function assertAbsent(filePath, role) {
  if (lstatOrNull(filePath, role)) {
    throw storeError('LEDGER_EXISTS', 'A ledger target already exists.', { detail: { role } });
  }
}

// Exact identity (BigInt device and file index): JavaScript numbers lose precision on
// large Windows file indexes, which would let two files share one key.
function fileRegistryKey(filePath) {
  const stat = lstatOrNull(filePath, 'database', { bigint: true });
  if (!stat) throw storeError('LEDGER_MISSING', 'A required ledger file is missing.', { detail: { role: 'database' } });
  return `${stat.dev}:${stat.ino}`;
}

function fsyncDirectory(directory) {
  // Windows cannot open a directory for flushing; NTFS journals the metadata itself.
  if (process.platform === 'win32') return;
  const descriptor = fs.openSync(directory, 'r');
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

// On Windows a scanner or indexer may hold a just-written file for a moment, so a rename
// refused with EPERM, EBUSY, or EACCES is retried a few times without blocking the event
// loop. Elsewhere those codes are real permission errors and fail at once. The target
// must not exist: callers check that first, because Windows renames replace targets.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

async function renameWithRetry(from, to, {
  attempts = 8,
  delayMs = 25,
  platform = process.platform,
  rename = fs.renameSync,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  let delay = delayMs;
  for (let attempt = 1; ; attempt += 1) {
    try {
      rename(from, to);
      return attempt;
    } catch (error) {
      if (platform !== 'win32' || !RENAME_RETRY_CODES.has(error?.code) || attempt >= attempts) throw error;
      await sleep(delay);
      delay = Math.min(delay * 2, 1_000);
    }
  }
}

function storeLocations(filePath) {
  const databasePath = requireAbsolutePath(filePath, 'database');
  return Object.freeze({
    databasePath,
    walPath: `${databasePath}-wal`,
    shmPath: `${databasePath}-shm`,
    journalPath: `${databasePath}-journal`,
  });
}

function normalizeWitnessPaths(value, locations) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 4) {
    throw invalid('At least one witness path is required.');
  }
  const witnessPaths = value.map((item) => requireAbsolutePath(item, 'witness'));
  const identities = new Set([locations.databasePath, locations.walPath, locations.shmPath, locations.journalPath]
    .map(pathIdentity));
  for (const witnessPath of witnessPaths) {
    const identity = pathIdentity(witnessPath);
    if (identities.has(identity)) throw invalid('Witness paths must be distinct from each other and the database.');
    identities.add(identity);
  }
  return Object.freeze(witnessPaths);
}

// Reads only the 100-byte SQLite header, before SQLite touches the file, so a foreign or
// empty file is refused without being converted to WAL or otherwise modified.
function inspectDatabaseHeader(databasePath) {
  const header = Buffer.alloc(100);
  let bytesRead = 0;
  let descriptor;
  try {
    descriptor = fs.openSync(databasePath, 'r');
    bytesRead = fs.readSync(descriptor, header, 0, header.length, 0);
  } catch (error) {
    throw storeError('LEDGER_PATH_INVALID', 'The ledger database header cannot be read.',
      { cause: error, detail: { role: 'database' } });
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
  }
  if (bytesRead < header.length || !header.subarray(0, 16).equals(SQLITE_HEADER_MAGIC)) {
    throw storeError('LEDGER_CORRUPT', 'The ledger file is empty or is not a SQLite database.');
  }
  if (header[18] !== 2 || header[19] !== 2 || header.readUInt32BE(68) !== APPLICATION_ID) {
    throw storeError('LEDGER_FORMAT_UNKNOWN', 'The file is not a format-2 side-effect ledger.');
  }
  const schemaVersion = header.readUInt32BE(60);
  if (schemaVersion !== SCHEMA_VERSION) throw schemaVersionError(schemaVersion);
}

// An older known revision is reported as outdated (no migration exists; recreate it),
// anything else as unknown. Neither is treated as corruption.
function schemaVersionError(found) {
  const detail = { found, expected: SCHEMA_VERSION };
  if (Number.isSafeInteger(found) && found >= OLDEST_KNOWN_SCHEMA_VERSION && found < SCHEMA_VERSION) {
    return storeError('LEDGER_FORMAT_OUTDATED',
      `The ledger uses schema revision ${found}; this build requires revision ${SCHEMA_VERSION}.`, { detail });
  }
  return storeError('LEDGER_FORMAT_UNKNOWN', 'The ledger schema revision is not supported.', { detail });
}

// ---------------------------------------------------------------------------
// Witness: two 256-byte slots, each [magic 8][identity 32][counter 8][boot 8][seq 8]
// [high-water 8][chain head 32][zero padding][sha256 32]. Writers overwrite the older
// slot in place.
// ---------------------------------------------------------------------------

function witnessIdentityDigest({ ledgerId, kind, genesisMs }) {
  return sha256Bytes(`xiaoji-ledger-witness-v2\n${ledgerId}\n${kind}\n${genesisMs}`);
}

function encodeWitnessSlot(identityDigest, { counter, bootEpoch, beginSeq, highWaterMs, chainHead }) {
  const slot = Buffer.alloc(WITNESS_SLOT_BYTES);
  WITNESS_MAGIC.copy(slot, 0);
  identityDigest.copy(slot, 8);
  slot.writeBigUInt64BE(BigInt(counter), 40);
  slot.writeBigUInt64BE(BigInt(bootEpoch), 48);
  slot.writeBigUInt64BE(BigInt(beginSeq), 56);
  slot.writeBigUInt64BE(BigInt(highWaterMs), 64);
  Buffer.from(chainHead, 'hex').copy(slot, 72);
  sha256Bytes(slot.subarray(0, WITNESS_BODY_BYTES)).copy(slot, WITNESS_BODY_BYTES);
  return slot;
}

function decodeWitnessSlot(slot, identityDigest) {
  if (!sha256Bytes(slot.subarray(0, WITNESS_BODY_BYTES)).equals(slot.subarray(WITNESS_BODY_BYTES)) ||
      !slot.subarray(0, 8).equals(WITNESS_MAGIC) ||
      slot.subarray(WITNESS_CHAIN_END, WITNESS_BODY_BYTES).some((byte) => byte !== 0)) {
    return Object.freeze({ valid: false, reason: 'torn' });
  }
  if (!slot.subarray(8, 40).equals(identityDigest)) return Object.freeze({ valid: false, reason: 'foreign' });
  const values = [40, 48, 56, 64].map((offset) => slot.readBigUInt64BE(offset));
  if (values.some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) {
    return Object.freeze({ valid: false, reason: 'torn' });
  }
  const [counter, bootEpoch, beginSeq, highWaterMs] = values.map(Number);
  return Object.freeze({ valid: true, counter, bootEpoch, beginSeq, highWaterMs,
    chainHead: slot.subarray(72, WITNESS_CHAIN_END).toString('hex') });
}

function readWitness(filePath, identityDigest) {
  assertRealDirectory(path.dirname(filePath), 'witness-directory');
  assertRegularFile(filePath, { role: 'witness', exactSize: WITNESS_BYTES });
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    throw storeError('LEDGER_WITNESS_INVALID', 'A ledger witness cannot be read.', { cause: error });
  }
  if (bytes.length !== WITNESS_BYTES) throw storeError('LEDGER_WITNESS_INVALID', 'A ledger witness changed while read.');
  const slots = [0, 1].map((index) => decodeWitnessSlot(
    bytes.subarray(index * WITNESS_SLOT_BYTES, (index + 1) * WITNESS_SLOT_BYTES), identityDigest
  ));
  if (slots.some((slot) => slot.reason === 'foreign')) {
    throw storeError('LEDGER_WITNESS_INVALID', 'A ledger witness belongs to a different ledger.');
  }
  const valid = slots.map((slot, index) => ({ slot, index })).filter(({ slot }) => slot.valid);
  if (!valid.length) throw storeError('LEDGER_WITNESS_INVALID', 'Both ledger witness slots are torn.');
  const newest = valid.reduce((best, item) => (item.slot.counter > best.slot.counter ? item : best));
  return Object.freeze({
    filePath,
    counter: newest.slot.counter,
    newestSlot: newest.index,
    tornSlots: Object.freeze(slots.flatMap((slot, index) => (slot.valid ? [] : [index]))),
    state: Object.freeze({
      bootEpoch: newest.slot.bootEpoch,
      beginSeq: newest.slot.beginSeq,
      highWaterMs: newest.slot.highWaterMs,
      chainHead: newest.slot.chainHead,
    }),
  });
}

// A slot decoded without deciding whose it is: only its own checksum, magic, and padding
// are checked, and the identity digest is returned for the caller to compare.
function decodeWitnessSlotUnbound(slot) {
  if (!sha256Bytes(slot.subarray(0, WITNESS_BODY_BYTES)).equals(slot.subarray(WITNESS_BODY_BYTES)) ||
      !slot.subarray(0, 8).equals(WITNESS_MAGIC) ||
      slot.subarray(WITNESS_CHAIN_END, WITNESS_BODY_BYTES).some((byte) => byte !== 0)) {
    return Object.freeze({ valid: false });
  }
  const values = [40, 48, 56, 64].map((offset) => slot.readBigUInt64BE(offset));
  if (values.some((value) => value > BigInt(Number.MAX_SAFE_INTEGER))) return Object.freeze({ valid: false });
  const [counter, bootEpoch, beginSeq, highWaterMs] = values.map(Number);
  return Object.freeze({ valid: true, identityDigest: slot.subarray(8, 40).toString('hex'), counter, bootEpoch,
    beginSeq, highWaterMs, chainHead: slot.subarray(72, WITNESS_CHAIN_END).toString('hex') });
}

// Read-only description of a witness file. Unlike readWitness it never throws for the
// file's content: a missing file, a wrong shape or size, torn slots, and a foreign
// identity are all reported in `problem` (null when the file is usable). With an
// identityDigest the slots must belong to that ledger; without one they are decoded as is.
// Only plain witness files are read here, never a database file.
function inspectWitnessFile(filePath, { identityDigest = null } = {}) {
  const stat = lstatOrNull(filePath, 'witness');
  if (!stat) return Object.freeze({ present: false, problem: 'missing', tornSlots: Object.freeze([]), state: null });
  const report = (problem, extra = {}) => Object.freeze({ present: true, problem, tornSlots: Object.freeze([]),
    state: null, ...extra });
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) return report('not-regular');
  if (stat.size !== WITNESS_BYTES) return report('size');
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch {
    return report('unreadable');
  }
  if (bytes.length !== WITNESS_BYTES) return report('size');
  const slots = [0, 1].map((index) => decodeWitnessSlotUnbound(
    bytes.subarray(index * WITNESS_SLOT_BYTES, (index + 1) * WITNESS_SLOT_BYTES)));
  const tornSlots = Object.freeze(slots.flatMap((slot, index) => (slot.valid ? [] : [index])));
  const valid = slots.filter((slot) => slot.valid);
  if (!valid.length) return report('torn', { tornSlots });
  let expected = null;
  if (Buffer.isBuffer(identityDigest)) expected = identityDigest.toString('hex');
  else if (identityDigest !== null && identityDigest !== undefined) {
    if (!HEX64.test(String(identityDigest))) throw invalid('identityDigest is invalid.');
    expected = String(identityDigest);
  }
  if (expected !== null && valid.some((slot) => slot.identityDigest !== expected)) return report('foreign', { tornSlots });
  const newest = valid.reduce((best, slot) => (slot.counter > best.counter ? slot : best));
  return Object.freeze({
    present: true,
    problem: null,
    tornSlots,
    counter: newest.counter,
    identityDigest: newest.identityDigest,
    state: Object.freeze({ bootEpoch: newest.bootEpoch, beginSeq: newest.beginSeq, highWaterMs: newest.highWaterMs,
      chainHead: newest.chainHead }),
  });
}

function sameWitnessState(left, right) {
  return left.bootEpoch === right.bootEpoch && left.beginSeq === right.beginSeq &&
    left.highWaterMs === right.highWaterMs && left.chainHead === right.chainHead;
}

// The database may be at most one sequenced step ahead of a witness (a crash between the
// commit and the witness write), and their chains must connect. Equal counters with a
// different head, a database behind the witness, or a larger gap are all rollbacks.
function assertWitnessContinuity(identity, witness) {
  const epochAhead = identity.bootEpoch - witness.bootEpoch;
  const seqAhead = identity.beginSeq - witness.beginSeq;
  const steps = epochAhead + seqAhead;
  let reason = null;
  if (epochAhead < 0 || seqAhead < 0 || identity.highWaterMs < witness.highWaterMs) reason = 'database-behind';
  else if (steps > 1) reason = 'gap';
  else if (steps === 0 && identity.chainHead !== witness.chainHead) reason = 'fork';
  else if (steps === 1 && identity.chainPrev !== witness.chainHead) reason = 'fork';
  if (reason) {
    throw storeError('LEDGER_ROLLBACK', 'The ledger database and its witness do not continue each other.', {
      detail: {
        reason,
        database: { bootEpoch: identity.bootEpoch, beginSeq: identity.beginSeq },
        witness: { bootEpoch: witness.bootEpoch, beginSeq: witness.beginSeq },
      },
    });
  }
}

function createWitnessFile(filePath, identityDigest, state, durability) {
  const bytes = Buffer.concat([
    encodeWitnessSlot(identityDigest, { ...state, counter: 1 }),
    encodeWitnessSlot(identityDigest, { ...state, counter: 0 }),
  ]);
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    if (durability === DURABILITY_FULL) fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  if (durability === DURABILITY_FULL) fsyncDirectory(path.dirname(filePath));
}

// The witness descriptor stays open for the store's lifetime: the file validated at open
// is the file written, and no per-write open/close cost is paid.
function openWitnessDescriptor(filePath) {
  const descriptor = fs.openSync(filePath, 'r+');
  try {
    assertWitnessDescriptor(descriptor);
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function assertWitnessDescriptor(descriptor) {
  const stat = fs.fstatSync(descriptor);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size !== WITNESS_BYTES) {
    throw storeError('LEDGER_WITNESS_INVALID', 'A ledger witness changed shape while in use.');
  }
}

function writeWitnessSlot(witness, state, durability) {
  assertWitnessDescriptor(witness.descriptor);
  const counter = witness.counter + 1;
  const slotIndex = 1 - witness.newestSlot;
  const slot = encodeWitnessSlot(witness.identityDigest, { ...state, counter });
  const written = fs.writeSync(witness.descriptor, slot, 0, WITNESS_SLOT_BYTES, slotIndex * WITNESS_SLOT_BYTES);
  if (written !== WITNESS_SLOT_BYTES) throw new Error('Short witness write.');
  if (durability === DURABILITY_FULL) fs.fsyncSync(witness.descriptor);
  witness.counter = counter;
  witness.newestSlot = slotIndex;
  witness.state = state;
}

function closeWitnessDescriptors(witnesses) {
  for (const witness of witnesses) {
    if (witness.descriptor === undefined || witness.descriptor === null) continue;
    try { fs.closeSync(witness.descriptor); } catch {}
    witness.descriptor = null;
  }
}

// ---------------------------------------------------------------------------
// SQLite connection
// ---------------------------------------------------------------------------

function sqlitePrimaryCode(error) {
  return Number(error?.errcode) & 0xff;
}

function sqliteFailure(error, fallbackMessage) {
  if (error instanceof LedgerStoreError) return error;
  const primary = sqlitePrimaryCode(error);
  if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) {
    // reason 'locked': another process (or connection) holds SQLite's lock. Only this
    // case is worth retrying; 'same-process' (a second open in this process) never is.
    return storeError('LEDGER_IN_USE', 'Another process or connection holds this ledger.',
      { retryable: true, cause: error, detail: { reason: 'locked' } });
  }
  if (primary === SQLITE_NOTADB || primary === SQLITE_CORRUPT) {
    return storeError('LEDGER_CORRUPT', 'The ledger file is not a valid ledger database.', { cause: error });
  }
  if (primary === SQLITE_CANTOPEN) {
    return storeError('LEDGER_MISSING', 'The ledger database cannot be opened.', { cause: error });
  }
  return storeError('LEDGER_PERSIST_FAILED', fallbackMessage, { cause: error });
}

function openDatabase(databasePath, { create, durability }) {
  const url = pathToFileURL(databasePath);
  url.searchParams.set('mode', create ? 'rwc' : 'rw');
  let db;
  try {
    // defensive=true (SQLITE_DBCONFIG_DEFENSIVE) refuses writable_schema and similar
    // schema-corrupting statements on this connection.
    db = new DatabaseSync(url, {
      timeout: 0,
      enableDoubleQuotedStringLiterals: false,
      allowExtension: false,
      defensive: true,
    });
  } catch (error) {
    throw sqliteFailure(error, 'The ledger database cannot be opened.');
  }
  try {
    if (create && process.platform !== 'win32') fs.chmodSync(databasePath, 0o600);
    // EXCLUSIVE must precede the first WAL access so no shared-memory index is created.
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    const journal = db.prepare('PRAGMA journal_mode = WAL').get();
    if (String(journal?.journal_mode || '').toLowerCase() !== 'wal') {
      throw storeError('LEDGER_PERSIST_FAILED', 'WAL journaling is unavailable for the ledger.');
    }
    const syncLevel = durability === DURABILITY_FULL ? 2 : 0;
    db.exec(`PRAGMA synchronous = ${syncLevel === 2 ? 'FULL' : 'OFF'}`);
    if (Number(db.prepare('PRAGMA synchronous').get()?.synchronous) !== syncLevel) {
      throw storeError('LEDGER_PERSIST_FAILED', 'The ledger synchronous level could not be fixed.');
    }
    // REPLACE conflict handling deletes rows; with recursive triggers on, those deletes
    // fire the DELETE guards as well.
    db.exec('PRAGMA recursive_triggers = ON');
    db.exec('PRAGMA fullfsync = ON');
    db.exec('PRAGMA checkpoint_fullfsync = ON');
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec('PRAGMA cell_size_check = ON');
    // Take the write lock now; in EXCLUSIVE mode it is held until the connection closes.
    db.exec('BEGIN IMMEDIATE');
    db.exec('COMMIT');
    return db;
  } catch (error) {
    try { db.close(); } catch {}
    throw sqliteFailure(error, 'The ledger database could not be prepared.');
  }
}

// Every row of sqlite_schema must be expected: the declared objects plus the three
// automatic primary-key indexes. Any other object, including sqlite_* tables such as
// sqlite_stat1, is refused.
function verifySchema(db) {
  const applicationId = Number(db.prepare('PRAGMA application_id').get()?.application_id);
  const userVersion = Number(db.prepare('PRAGMA user_version').get()?.user_version);
  if (applicationId !== APPLICATION_ID) {
    throw storeError('LEDGER_FORMAT_UNKNOWN', 'The ledger database format is not supported.');
  }
  if (userVersion !== SCHEMA_VERSION) throw schemaVersionError(userVersion);
  const byName = (left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  const actual = db.prepare('SELECT type, name, tbl_name, sql FROM sqlite_schema').all().sort(byName);
  const expected = [...SCHEMA, ...AUTOMATIC_INDEXES].sort(byName);
  if (actual.length !== expected.length || actual.some((row, index) => row.type !== expected[index].type ||
      row.name !== expected[index].name || row.tbl_name !== expected[index].tableName ||
      (expected[index].sql === null ? row.sql !== null : normalizeSql(row.sql) !== normalizeSql(expected[index].sql)))) {
    throw storeError('LEDGER_CORRUPT', 'The ledger schema differs from format 2.');
  }
}

function readIdentityRow(db) {
  const rows = db.prepare('SELECT * FROM identity').all();
  if (rows.length !== 1) throw storeError('LEDGER_CORRUPT', 'The ledger identity row is missing.');
  const row = rows[0];
  const valid = row.singleton === 1 && typeof row.ledger_id === 'string' && TOKEN.test(row.ledger_id) &&
    row.ledger_id.length <= 128 && LEDGER_KINDS.includes(row.kind) && row.format === STORE_FORMAT &&
    SNOWFLAKE.test(row.bot_id || '') && (row.owner_id === null || SNOWFLAKE.test(row.owner_id)) &&
    (row.kind !== 'owner' || row.owner_id !== null) && RUNTIME_MODES.includes(row.runtime_mode) &&
    ['genesis_ms', 'cutover_ms', 'boot_epoch', 'begin_seq', 'high_water_ms']
      .every((name) => Number.isSafeInteger(row[name]) && row[name] >= 0) &&
    HEX64.test(row.chain_head || '') && HEX64.test(row.chain_prev || '');
  if (!valid) throw storeError('LEDGER_CORRUPT', 'The ledger identity row is invalid.');
  return Object.freeze({
    ledgerId: row.ledger_id,
    kind: row.kind,
    format: row.format,
    botId: row.bot_id,
    ownerId: row.owner_id,
    runtimeMode: row.runtime_mode,
    genesisMs: row.genesis_ms,
    cutoverMs: row.cutover_ms,
    bootEpoch: row.boot_epoch,
    beginSeq: row.begin_seq,
    highWaterMs: row.high_water_ms,
    chainHead: row.chain_head,
    chainPrev: row.chain_prev,
  });
}

// detail.reason names the first field that differs (kind, ledger-id, bot, owner,
// runtime-mode, cutover, genesis); it is a fixed token, never a value.
function assertExpectedIdentity(identity, kind, expected) {
  const mismatch = (field, reason) => storeError('LEDGER_IDENTITY_MISMATCH', `The ledger ${field} does not match.`,
    { detail: { reason } });
  if (identity.kind !== kind) throw mismatch('kind', 'kind');
  if (expected.ledgerId !== undefined && identity.ledgerId !== expected.ledgerId) throw mismatch('ledger ID', 'ledger-id');
  if (identity.botId !== expected.botId) throw mismatch('bot ID', 'bot');
  if (kind === 'owner' || expected.ownerId !== undefined) {
    if (identity.ownerId !== (expected.ownerId ?? null)) throw mismatch('Owner ID', 'owner');
  }
  if (identity.runtimeMode !== expected.runtimeMode) throw mismatch('runtime mode', 'runtime-mode');
  if (expected.cutoverMs !== undefined && identity.cutoverMs !== expected.cutoverMs) throw mismatch('cutover', 'cutover');
  if (expected.genesisMs !== undefined && identity.genesisMs !== expected.genesisMs) throw mismatch('genesis', 'genesis');
}

// expected.notBefore is the last state recorded outside the ledger (the coin database
// registration's lastSeen). That record may lag the ledger by any number of steps, but it
// can never be ahead of it: a database behind it, or at the same counters on another
// chain, was restored or replaced together with its witnesses.
function assertRegistrationContinuity(identity, notBefore) {
  let reason = null;
  if (identity.bootEpoch < notBefore.bootEpoch || identity.beginSeq < notBefore.beginSeq) {
    reason = 'registration-ahead';
  } else if (identity.bootEpoch === notBefore.bootEpoch && identity.beginSeq === notBefore.beginSeq &&
      identity.chainHead !== notBefore.chainHead) {
    reason = 'registration-fork';
  }
  if (reason) {
    throw storeError('LEDGER_ROLLBACK', 'The ledger is older than its registration records.', {
      detail: {
        reason,
        database: { bootEpoch: identity.bootEpoch, beginSeq: identity.beginSeq },
        registration: { bootEpoch: notBefore.bootEpoch, beginSeq: notBefore.beginSeq },
      },
    });
  }
}

function requireCounter(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw invalid(`${name} is invalid.`);
  return value;
}

function normalizeNotBefore(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw invalid('expected.notBefore is invalid.');
  return Object.freeze({
    bootEpoch: requireCounter(value.bootEpoch, 'expected.notBefore.bootEpoch'),
    beginSeq: requireCounter(value.beginSeq, 'expected.notBefore.beginSeq'),
    chainHead: HEX64.test(value.chainHead || '') ? value.chainHead
      : (() => { throw invalid('expected.notBefore.chainHead is invalid.'); })(),
  });
}

function normalizeExpected(value, kind) {
  const expected = value || {};
  return Object.freeze({
    ledgerId: expected.ledgerId === undefined ? undefined : requireToken(expected.ledgerId, 'expected.ledgerId', 128),
    botId: requireSnowflake(expected.botId, 'expected.botId'),
    ownerId: kind === 'owner'
      ? requireSnowflake(expected.ownerId, 'expected.ownerId')
      : expected.ownerId === undefined || expected.ownerId === null
        ? expected.ownerId
        : requireSnowflake(expected.ownerId, 'expected.ownerId'),
    runtimeMode: RUNTIME_MODES.includes(expected.runtimeMode) ? expected.runtimeMode
      : (() => { throw invalid('expected.runtimeMode is invalid.'); })(),
    cutoverMs: expected.cutoverMs === undefined ? undefined : requireTime(expected.cutoverMs, 'expected.cutoverMs'),
    genesisMs: expected.genesisMs === undefined ? undefined : requireTime(expected.genesisMs, 'expected.genesisMs'),
    notBefore: normalizeNotBefore(expected.notBefore),
  });
}

function rowToOperation(row) {
  if (!row) return null;
  const corrupt = () => storeError('LEDGER_CORRUPT', 'A ledger operation row failed its integrity check.');
  if (typeof row.binding_json !== 'string' || sha256Hex(row.binding_json) !== row.binding_digest) throw corrupt();
  let binding;
  try { binding = JSON.parse(row.binding_json); } catch { throw corrupt(); }
  if (!binding || typeof binding !== 'object' || Array.isArray(binding)) throw corrupt();
  let result = null;
  if (row.result_json !== null) {
    if (typeof row.result_json !== 'string' || sha256Hex(row.result_json) !== row.result_digest) throw corrupt();
    try { result = JSON.parse(row.result_json); } catch { throw corrupt(); }
  }
  return Object.freeze({
    purposeId: row.purpose_id,
    operationId: row.operation_id,
    sourceKey: row.source_key,
    sourceTimeMs: row.source_time_ms,
    bindingDigest: row.binding_digest,
    bindingBytes: Buffer.byteLength(row.binding_json),
    binding,
    state: row.state,
    generation: row.generation,
    target: row.target,
    mergeKey: row.merge_key,
    mergeWindowUntilMs: row.merge_window_until_ms,
    budgetCharged: row.budget_charged === 1,
    budgetReservedAtMs: row.budget_reserved_at_ms,
    bootEpoch: row.boot_epoch,
    beginSeq: row.begin_seq,
    claimedAtMs: row.claimed_at_ms,
    attemptedAtMs: row.attempted_at_ms,
    finishedAtMs: row.finished_at_ms,
    resultCode: row.result_code,
    result,
    resultDigest: row.result_digest,
  });
}

function rowToFence(row) {
  if (!row) return null;
  return Object.freeze({
    purposeId: row.purpose_id,
    guildId: row.guild_id,
    generation: row.generation,
    open: row.open === 1,
    channelId: row.channel_id,
    sessionKey: row.session_key,
    sourceFence: row.source_fence,
    bootEpoch: row.boot_epoch,
    beginSeq: row.begin_seq,
    updatedAtMs: row.updated_at_ms,
  });
}

// Every statement the store prepares. Exported so tests can check the exact SQL with
// EXPLAIN QUERY PLAN and confirm the main lookups use indexes.
const STATEMENT_SQL = Object.freeze({
  pageSize: 'PRAGMA page_size',
  pageCount: 'PRAGMA page_count',
  freelistCount: 'PRAGMA freelist_count',
  totalChanges: 'SELECT total_changes() AS changes',
  selectIdentity: 'SELECT boot_epoch, begin_seq, high_water_ms, chain_head, chain_prev FROM identity WHERE singleton = 1',
  // In an UPDATE every right-hand side reads the old row, so chain_prev takes the old head.
  bootIdentity: 'UPDATE identity SET boot_epoch = ?, high_water_ms = ?, chain_prev = chain_head, chain_head = ? ' +
    'WHERE singleton = 1',
  sequenceIdentity: 'UPDATE identity SET begin_seq = ?, high_water_ms = ?, chain_prev = chain_head, chain_head = ? ' +
    'WHERE singleton = 1',
  highWaterIdentity: 'UPDATE identity SET high_water_ms = max(high_water_ms, ?) WHERE singleton = 1',
  recoverAttempted: "UPDATE operations SET state = 'unknown', finished_at_ms = ?, result_code = 'restart_after_attempt' " +
    "WHERE state = 'attempted'",
  selectOperation: 'SELECT * FROM operations WHERE purpose_id = ? AND operation_id = ?',
  listOperations: 'SELECT * FROM operations WHERE purpose_id = ? ORDER BY rowid',
  countOperations: 'SELECT COUNT(*) AS count FROM operations WHERE purpose_id = ?',
  countAttempts: 'SELECT COUNT(*) AS count FROM operations WHERE purpose_id = ? AND attempted_at_ms > ? ' +
    "AND state <> 'not_sent'",
  attemptedPresent: "SELECT 1 AS present FROM operations WHERE state = 'attempted' LIMIT 1",
  insertOperation: 'INSERT INTO operations (purpose_id, operation_id, source_key, source_time_ms, binding_digest, ' +
    'binding_json, state, generation, target, merge_key, merge_window_until_ms, budget_charged, budget_reserved_at_ms, ' +
    'boot_epoch, begin_seq, claimed_at_ms, attempted_at_ms, finished_at_ms, result_code, result_json, result_digest) ' +
    "VALUES (?, ?, ?, ?, ?, ?, 'attempted', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)",
  finishOperation: 'UPDATE operations SET state = ?, finished_at_ms = ?, result_code = ?, result_json = ?, ' +
    "result_digest = ? WHERE purpose_id = ? AND operation_id = ? AND state = 'attempted'",
  selectMerge: 'SELECT operation_id, merge_window_until_ms FROM operations ' +
    'WHERE purpose_id = ? AND merge_key = ? AND merge_window_until_ms > ? ORDER BY rowid LIMIT 1',
  countBudget: 'SELECT COUNT(*) AS count FROM operations WHERE purpose_id = ? AND target = ? AND budget_charged = 1 ' +
    'AND budget_reserved_at_ms > ? AND budget_reserved_at_ms <= ?',
  selectWatermark: 'SELECT watermark_ms FROM watermarks WHERE purpose_id = ? AND source_key = ?',
  insertWatermark: 'INSERT INTO watermarks (purpose_id, source_key, watermark_ms, updated_at_ms) VALUES (?, ?, ?, ?)',
  raiseWatermark: 'UPDATE watermarks SET watermark_ms = max(watermark_ms, ?), updated_at_ms = ? ' +
    'WHERE purpose_id = ? AND source_key = ?',
  selectPrunable: 'SELECT rowid AS row_id, purpose_id, source_key, source_time_ms FROM operations ' +
    "WHERE state <> 'attempted' AND source_time_ms IS NOT NULL AND finished_at_ms <= ? " +
    'ORDER BY finished_at_ms LIMIT ?',
  deletePrunable: "DELETE FROM operations WHERE rowid = ? AND state <> 'attempted' AND source_time_ms IS NOT NULL " +
    'AND finished_at_ms <= ?',
  selectFence: 'SELECT * FROM reaction_fences WHERE purpose_id = ? AND guild_id = ?',
  listFences: 'SELECT * FROM reaction_fences WHERE purpose_id = ? ORDER BY rowid',
  countFences: 'SELECT COUNT(*) AS count FROM reaction_fences WHERE purpose_id = ?',
  insertFence: 'INSERT INTO reaction_fences (purpose_id, guild_id, generation, open, channel_id, session_key, ' +
    'source_fence, boot_epoch, begin_seq, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  updateFence: 'UPDATE reaction_fences SET generation = ?, open = ?, channel_id = ?, session_key = ?, ' +
    'source_fence = ?, boot_epoch = ?, begin_seq = ?, updated_at_ms = ? WHERE purpose_id = ? AND guild_id = ?',
});

function prepareStatements(db) {
  return Object.freeze(Object.fromEntries(Object.entries(STATEMENT_SQL).map(([name, sql]) => [name, db.prepare(sql)])));
}

// The validated row of a begin or a decision.
function normalizeOperationInput(input) {
  const record = Object.freeze({
    purposeId: requireToken(input.purposeId, 'purposeId', 64),
    operationId: requireToken(input.operationId, 'operationId'),
    sourceKey: requireText(input.sourceKey, 'sourceKey', 1_024),
    sourceTimeMs: optionalTime(input.sourceTimeMs, 'sourceTimeMs'),
    bindingJson: typeof input.bindingJson === 'string' && input.bindingJson.length > 0 &&
      Buffer.byteLength(input.bindingJson) <= MAX_BINDING_JSON_BYTES ? input.bindingJson
      : (() => { throw invalid('bindingJson is invalid.'); })(),
    bindingDigest: HEX64.test(input.bindingDigest || '') ? input.bindingDigest
      : (() => { throw invalid('bindingDigest is invalid.'); })(),
    generation: requireCount(input.generation, 'generation'),
    target: requireText(input.target, 'target', 256),
    mergeKey: requireText(input.mergeKey, 'mergeKey', 2_048),
    mergeWindowUntilMs: optionalTime(input.mergeWindowUntilMs, 'mergeWindowUntilMs'),
    budgetCharged: input.budgetCharged === true,
    budgetReservedAtMs: optionalTime(input.budgetReservedAtMs, 'budgetReservedAtMs'),
    claimedAtMs: requireTime(input.claimedAtMs, 'claimedAtMs'),
  });
  if (sha256Hex(record.bindingJson) !== record.bindingDigest) throw invalid('bindingDigest does not match bindingJson.');
  if (record.budgetCharged !== (record.budgetReservedAtMs !== null)) throw invalid('Budget reservation is inconsistent.');
  return record;
}

function normalizeResultJson(value) {
  const resultJson = value === undefined || value === null ? null : value;
  if (resultJson !== null && (typeof resultJson !== 'string' || !resultJson ||
      Buffer.byteLength(resultJson) > MAX_RESULT_JSON_BYTES)) {
    throw invalid('resultJson is invalid.');
  }
  return resultJson;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

class LedgerStore {
  #db;
  #statements;
  #locations;
  #identity;
  #witnesses;
  #now;
  #durability;
  #faultInjector;
  #logger;
  #registryKey = null;
  #closed = false;
  #failure = null;
  #writeGuardDepth = 0;
  #purposes = new Set();
  #commits = 0;
  #memoryHighWater;
  #beginsSincePrune = 0;
  #bootSummary = null;
  #resynchronizedWitnesses = 0;
  #quickCheck = null;
  #quickCheckTrigger = null;
  #lastCapacityReliefAtMs = null;

  constructor({ db, locations, identity, witnesses, now, durability, faultInjector, logger, softLimitBytes,
    retentionMs, acceleratedRetentionMs, acceleratedPruneMaxBatches, pruneBatchRows }) {
    this.#db = db;
    this.#statements = prepareStatements(db);
    this.#locations = locations;
    this.#identity = { ...identity };
    this.#witnesses = witnesses;
    this.#now = now;
    this.#durability = durability;
    this.#faultInjector = faultInjector;
    this.#logger = logger;
    this.#memoryHighWater = identity.highWaterMs;
    this.softLimitBytes = softLimitBytes;
    this.retentionMs = retentionMs;
    this.acceleratedRetentionMs = acceleratedRetentionMs;
    this.acceleratedPruneMaxBatches = acceleratedPruneMaxBatches;
    this.pruneBatchRows = pruneBatchRows;
  }

  static open(config) {
    const { locations, witnessPaths, kind, expected } = config;
    assertRealDirectory(path.dirname(locations.databasePath), 'database-directory');
    assertRegularFile(locations.databasePath, { role: 'database' });
    // A WAL left beside the database means the last holder did not close cleanly.
    const walPresent = Boolean(assertRegularFile(locations.walPath, { role: 'wal', required: false }));
    assertRegularFile(locations.shmPath, { role: 'shm', required: false });
    // This store never uses rollback journals; a hot journal means a foreign writer.
    if (lstatOrNull(locations.journalPath, 'journal')) {
      throw storeError('LEDGER_TEMP_PRESENT', 'A rollback journal beside the ledger requires manual review.');
    }
    for (const witnessPath of witnessPaths) {
      assertRealDirectory(path.dirname(witnessPath), 'witness-directory');
      assertRegularFile(witnessPath, { role: 'witness', exactSize: WITNESS_BYTES });
    }
    const registryKey = fileRegistryKey(locations.databasePath);
    if (OPEN_DATABASES.has(registryKey)) {
      throw storeError('LEDGER_IN_USE', 'This process already holds this ledger open.',
        { retryable: true, detail: { reason: 'same-process' } });
    }
    inspectDatabaseHeader(locations.databasePath);
    const db = openDatabase(locations.databasePath, { create: false, durability: config.durability });
    OPEN_DATABASES.add(registryKey);
    const witnesses = [];
    let store;
    try {
      verifySchema(db);
      // After an unclean close every page is checked once before anything read from the
      // file is trusted. An unclean close shows as a WAL left beside the database, or as
      // attempted rows the last holder never finished: an operator inspection (status)
      // may already have merged and removed that WAL.
      let quickCheck = null;
      let quickCheckTrigger = walPresent ? 'wal' : null;
      if (!quickCheckTrigger && db.prepare(STATEMENT_SQL.attemptedPresent).get()) quickCheckTrigger = 'attempted';
      if (quickCheckTrigger) {
        const rows = db.prepare('PRAGMA quick_check').all();
        quickCheck = rows.length === 1 && rows[0].quick_check === 'ok' ? 'ok' : 'failed';
        if (quickCheck !== 'ok') {
          throw storeError('LEDGER_CORRUPT', 'The ledger failed its quick check after an unclean close.',
            { detail: { reason: 'quick-check' } });
        }
      }
      const identity = readIdentityRow(db);
      assertExpectedIdentity(identity, kind, expected);
      const identityDigest = witnessIdentityDigest(identity);
      for (const filePath of witnessPaths) {
        const witness = readWitness(filePath, identityDigest);
        assertWitnessContinuity(identity, witness.state);
        witnesses.push({ filePath, identityDigest, counter: witness.counter, newestSlot: witness.newestSlot,
          tornSlots: witness.tornSlots, state: witness.state, descriptor: openWitnessDescriptor(filePath) });
      }
      // Compared before any write, so a refused open leaves the database and witnesses as found.
      if (expected.notBefore) assertRegistrationContinuity(identity, expected.notBefore);
      store = new LedgerStore({ db, locations, identity, witnesses, now: config.now,
        durability: config.durability, faultInjector: config.faultInjector, logger: config.logger,
        softLimitBytes: config.softLimitBytes, retentionMs: config.retentionMs,
        acceleratedRetentionMs: config.acceleratedRetentionMs,
        acceleratedPruneMaxBatches: config.acceleratedPruneMaxBatches, pruneBatchRows: config.pruneBatchRows });
      store.#registryKey = registryKey;
      store.#quickCheck = quickCheck;
      store.#quickCheckTrigger = quickCheckTrigger;
      store.#resynchronizeWitnesses();
      store.#boot();
      return store;
    } catch (error) {
      if (store) store.close();
      else {
        OPEN_DATABASES.delete(registryKey);
        closeWitnessDescriptors(witnesses);
        try { db.close(); } catch {}
      }
      throw sqliteFailure(error, 'The ledger could not be opened.');
    }
  }

  get closed() { return this.#closed; }

  get failed() { return this.#failure !== null; }

  get locations() { return this.#locations; }

  get witnessPaths() { return Object.freeze(this.#witnesses.map((witness) => witness.filePath)); }

  get identity() { return Object.freeze({ ...this.#identity }); }

  // The counters and chain head of the last committed step, from memory only: reading
  // this never touches the database or a witness. Callers record it elsewhere (the coin
  // database registration's lastSeen) to detect a later restore of the ledger.
  get identityCounters() {
    return Object.freeze({
      bootEpoch: this.#identity.bootEpoch,
      beginSeq: this.#identity.beginSeq,
      chainHead: this.#identity.chainHead,
      highWaterMs: this.#identity.highWaterMs,
    });
  }

  get bootSummary() { return this.#bootSummary; }

  // Connection settings as SQLite reports them, for diagnostics and tests. Trying to turn
  // writable_schema on proves whether the defensive flag is in force.
  describeConnection() {
    return this.#read(() => {
      const pragma = (name) => this.#db.prepare(`PRAGMA ${name}`).get();
      this.#db.exec('PRAGMA writable_schema = ON');
      const schemaWritesLocked = Number(pragma('writable_schema')?.writable_schema) === 0;
      this.#db.exec('PRAGMA writable_schema = OFF');
      return Object.freeze({
        journalMode: String(pragma('journal_mode')?.journal_mode || ''),
        synchronous: Number(pragma('synchronous')?.synchronous),
        lockingMode: String(pragma('locking_mode')?.locking_mode || ''),
        recursiveTriggers: Number(pragma('recursive_triggers')?.recursive_triggers) === 1,
        schemaWritesLocked,
      });
    });
  }

  stats() {
    return this.#read(() => Object.freeze({
      commits: this.#commits,
      totalChanges: Number(this.#statements.totalChanges.get().changes),
      usedBytes: this.usedBytes(),
      bootEpoch: this.#identity.bootEpoch,
      beginSeq: this.#identity.beginSeq,
    }));
  }

  #assertOpen() {
    if (this.#closed) throw storeError('LEDGER_CLOSED', 'The ledger is closed.');
  }

  #assertWritable() {
    this.#assertOpen();
    if (this.#failure) throw storeError('LEDGER_FAILED', 'The ledger failed closed after a persistence fault.');
    if (this.#writeGuardDepth > 0) {
      throw storeError('LEDGER_WRITE_FORBIDDEN', 'This ledger call is guaranteed not to write.');
    }
  }

  #fail(error) {
    if (!this.#failure) this.#failure = error || new Error('Ledger failure.');
  }

  #inject(label, phase) {
    if (this.#faultInjector) this.#faultInjector({ label, phase });
  }

  // Every read goes through here: SQLite errors are translated, and results that mean the
  // file itself is untrustworthy (CORRUPT, NOTADB, IOERR, or a failed row digest) mark
  // the store failed so callers can see it through `failed`.
  #read(work) {
    this.#assertOpen();
    try {
      return work();
    } catch (error) {
      if (error instanceof LedgerStoreError) {
        if (error.code === 'LEDGER_CORRUPT') this.#fail(error);
        throw error;
      }
      if (FAILING_SQLITE_CODES.has(sqlitePrimaryCode(error))) this.#fail(error);
      throw sqliteFailure(error, 'A ledger read failed.');
    }
  }

  // Runs callers' read-only work with every write path disabled. Deferred, merged, and
  // budget-suppressed decisions go through here so they provably produce zero writes.
  withoutWrites(work) {
    this.#assertOpen();
    this.#writeGuardDepth += 1;
    try {
      return work();
    } finally {
      this.#writeGuardDepth -= 1;
    }
  }

  // Grants one in-process worker exclusive use of a purpose. Together with the database
  // lock this is what keeps memory-only claims from being duplicated.
  attachPurpose(purposeId) {
    this.#assertOpen();
    const purpose = requireToken(purposeId, 'purposeId', 64);
    if (this.#purposes.has(purpose)) {
      throw storeError('LEDGER_PURPOSE_IN_USE', 'Another worker already owns this ledger purpose.');
    }
    this.#purposes.add(purpose);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#purposes.delete(purpose);
    };
  }

  observedNow() {
    this.#assertOpen();
    const value = safeNow(this.#now);
    if (value > this.#memoryHighWater) this.#memoryHighWater = value;
    return this.#memoryHighWater;
  }

  usedBytes() {
    return this.#read(() => {
      const pageSize = Number(this.#statements.pageSize.get().page_size);
      const pageCount = Number(this.#statements.pageCount.get().page_count);
      const freelist = Number(this.#statements.freelistCount.get().freelist_count);
      return (pageCount - freelist) * pageSize;
    });
  }

  #transaction(label, work, { capacity = false } = {}) {
    this.#assertWritable();
    let began = false;
    try {
      this.#db.exec('BEGIN IMMEDIATE');
      began = true;
      const result = work();
      if (capacity && this.usedBytes() > this.softLimitBytes) {
        throw storeError('LEDGER_CAPACITY_EXCEEDED', 'The ledger reached its soft size limit.',
          { detail: { reason: 'soft-limit' } });
      }
      this.#inject(label, 'before-commit');
      this.#db.exec('COMMIT');
      began = false;
      this.#commits += 1;
      return result;
    } catch (error) {
      if (began) {
        try { this.#db.exec('ROLLBACK'); } catch (rollbackError) { this.#fail(rollbackError); }
      }
      if (error instanceof LedgerStoreError && REJECTION_CODES.has(error.code)) throw error;
      this.#fail(error);
      throw sqliteFailure(error, 'A ledger transaction failed closed.');
    }
  }

  // A growth write that hits the soft limit prunes on the accelerated schedule (bounded
  // to a fixed number of batches, and logged) once and retries; if the ledger is still
  // over the limit the caller receives the fixed code. The relief and its two warnings
  // run at most once per CAPACITY_RELIEF_INTERVAL_MS on this ledger; inside that interval
  // the refused write (already rolled back) is reported at once, without pruning or
  // logging again, and detail.throttled is true.
  #growthTransaction(label, work) {
    try {
      return this.#transaction(label, work, { capacity: true });
    } catch (error) {
      if (error?.code !== 'LEDGER_CAPACITY_EXCEEDED' || error.detail?.reason !== 'soft-limit') throw error;
    }
    const nowMs = this.observedNow();
    if (this.#lastCapacityReliefAtMs !== null && nowMs - this.#lastCapacityReliefAtMs < CAPACITY_RELIEF_INTERVAL_MS) {
      throw storeError('LEDGER_CAPACITY_EXCEEDED', 'The ledger reached its soft size limit.',
        { detail: { reason: 'soft-limit', throttled: true } });
    }
    this.#lastCapacityReliefAtMs = nowMs;
    const relief = this.prune({ retentionMs: Math.min(this.acceleratedRetentionMs, this.retentionMs),
      maxBatches: this.acceleratedPruneMaxBatches });
    this.#logger.warn(`[SIDE_EFFECT_LEDGER] code=LEDGER_ACCELERATED_PRUNE kind=${this.#identity.kind} ` +
      `pruned=${relief.pruned} batches=${relief.batches} complete=${relief.complete}`);
    try {
      return this.#transaction(label, work, { capacity: true });
    } catch (error) {
      if (error?.code === 'LEDGER_CAPACITY_EXCEEDED') {
        this.#logger.warn(`[SIDE_EFFECT_LEDGER] code=LEDGER_CAPACITY_EXCEEDED kind=${this.#identity.kind}`);
      }
      throw error;
    }
  }

  #witnessState() {
    return Object.freeze({
      bootEpoch: this.#identity.bootEpoch,
      beginSeq: this.#identity.beginSeq,
      highWaterMs: this.#identity.highWaterMs,
      chainHead: this.#identity.chainHead,
    });
  }

  #writeWitness(witness, label, state) {
    try {
      this.#inject(label, 'before-witness-write');
      writeWitnessSlot(witness, state, this.#durability);
    } catch (error) {
      this.#fail(error);
      throw storeError('LEDGER_PERSIST_FAILED', 'The ledger witness could not be updated.', { cause: error });
    }
  }

  #writeWitnesses(label) {
    const state = this.#witnessState();
    for (const witness of this.#witnesses) this.#writeWitness(witness, label, state);
  }

  // Before the boot step, bring every witness up to the database's current step, so a
  // witness that missed one write (crash or I/O error) never falls two steps behind.
  #resynchronizeWitnesses() {
    const state = this.#witnessState();
    for (const witness of this.#witnesses) {
      if (sameWitnessState(witness.state, state)) continue;
      this.#writeWitness(witness, 'resync', state);
      this.#resynchronizedWitnesses += 1;
    }
  }

  #boot() {
    const nowMs = this.observedNow();
    const committed = this.#transaction('boot', () => {
      const current = this.#statements.selectIdentity.get();
      const bootEpoch = current.boot_epoch + 1;
      const highWaterMs = Math.max(current.high_water_ms, nowMs);
      const chainHead = chainStep(current.chain_head, ['boot', bootEpoch]);
      this.#statements.bootIdentity.run(bootEpoch, highWaterMs, chainHead);
      const recovered = Number(this.#statements.recoverAttempted.run(highWaterMs).changes);
      return { bootEpoch, highWaterMs, chainHead, chainPrev: current.chain_head, recovered };
    });
    Object.assign(this.#identity, { bootEpoch: committed.bootEpoch, highWaterMs: committed.highWaterMs,
      chainHead: committed.chainHead, chainPrev: committed.chainPrev });
    this.#writeWitnesses('boot');
    const pruned = this.prune({ maxBatches: BOOT_PRUNE_MAX_BATCHES });
    this.#bootSummary = Object.freeze({
      bootEpoch: committed.bootEpoch,
      recoveredAttempted: committed.recovered,
      pruned: pruned.pruned,
      resynchronizedWitnesses: this.#resynchronizedWitnesses,
      tornWitnessSlots: Object.freeze(this.#witnesses.map((witness) => witness.tornSlots)),
      // 'ok' when the open ran PRAGMA quick_check; null when the last close was clean.
      quickCheck: this.#quickCheck,
      // Why it ran: 'wal' (a WAL was left beside the database) or 'attempted' (rows the
      // last holder never finished); null when it did not run.
      quickCheckTrigger: this.#quickCheckTrigger,
    });
  }

  // One sequenced step inside the current transaction: begin_seq + 1 and a chain link.
  #advanceSequence(nowMs, stepFields) {
    const current = this.#statements.selectIdentity.get();
    const beginSeq = current.begin_seq + 1;
    const highWaterMs = Math.max(current.high_water_ms, nowMs);
    const chainHead = chainStep(current.chain_head, stepFields(current.boot_epoch, beginSeq));
    this.#statements.sequenceIdentity.run(beginSeq, highWaterMs, chainHead);
    return { bootEpoch: current.boot_epoch, beginSeq, highWaterMs, chainHead, chainPrev: current.chain_head };
  }

  #recordSequence(step, label) {
    Object.assign(this.#identity, { beginSeq: step.beginSeq, highWaterMs: step.highWaterMs,
      chainHead: step.chainHead, chainPrev: step.chainPrev });
    this.#writeWitnesses(label);
  }

  #sourceTerminal(purposeId, sourceKey, sourceTimeMs) {
    if (sourceTimeMs === null) return null;
    if (sourceTimeMs <= this.#identity.cutoverMs) {
      return Object.freeze({ reason: 'cutover', boundaryMs: this.#identity.cutoverMs });
    }
    const row = this.#statements.selectWatermark.get(purposeId, sourceKey);
    if (row && sourceTimeMs <= row.watermark_ms) {
      return Object.freeze({ reason: 'watermark', boundaryMs: row.watermark_ms });
    }
    return null;
  }

  getOperation(purposeId, operationId) {
    return this.#read(() => rowToOperation(this.#statements.selectOperation.get(purposeId, operationId)));
  }

  listOperations(purposeId) {
    return this.#read(() => this.#statements.listOperations.all(purposeId).map(rowToOperation));
  }

  countOperations(purposeId) {
    return this.#read(() => Number(this.#statements.countOperations.get(purposeId).count));
  }

  getWatermark(purposeId, sourceKey) {
    return this.#read(() => {
      const row = this.#statements.selectWatermark.get(purposeId, sourceKey);
      return row ? row.watermark_ms : null;
    });
  }

  // Read-only query: a recorded row decides; otherwise a source time at or below the
  // cutover or its (purpose, source_key) watermark is terminal without any write.
  inspectOperation({ purposeId, operationId, sourceKey, sourceTimeMs = null }) {
    const purpose = requireToken(purposeId, 'purposeId', 64);
    const operation = this.getOperation(purpose, requireToken(operationId, 'operationId'));
    if (operation) return Object.freeze({ kind: 'recorded', operation });
    const key = requireText(sourceKey, 'sourceKey', 1_024);
    const time = optionalTime(sourceTimeMs, 'sourceTimeMs');
    const terminal = this.#read(() => this.#sourceTerminal(purpose, key, time));
    if (terminal) return Object.freeze({ kind: 'terminal', ...terminal });
    return Object.freeze({ kind: 'absent' });
  }

  findMergeHolder({ purposeId, mergeKey, nowMs }) {
    return this.#read(() => {
      const row = this.#statements.selectMerge.get(purposeId, mergeKey, nowMs);
      return row ? Object.freeze({ operationId: row.operation_id, mergeWindowUntilMs: row.merge_window_until_ms }) : null;
    });
  }

  countBudget({ purposeId, target, nowMs, windowMs }) {
    return this.#read(() => Number(this.#statements.countBudget.get(purposeId, target, nowMs - windowMs, nowMs).count));
  }

  begin(input = {}) {
    const record = normalizeOperationInput(input);
    this.#assertWritable();
    this.#maybePrune();
    const nowMs = this.observedNow();
    const step = this.#growthTransaction('begin', () => {
      const existing = this.#statements.selectOperation.get(record.purposeId, record.operationId);
      if (existing) {
        if (existing.binding_digest !== record.bindingDigest) {
          throw storeError('LEDGER_BINDING_CONFLICT', 'The operation ID was replayed with a different binding.');
        }
        throw storeError('LEDGER_TRANSITION_REJECTED', 'The operation was already attempted.');
      }
      const terminal = this.#sourceTerminal(record.purposeId, record.sourceKey, record.sourceTimeMs);
      if (terminal) {
        throw storeError('LEDGER_SOURCE_TERMINAL', 'The source is already terminal by cutover or watermark.',
          { detail: terminal });
      }
      const advanced = this.#advanceSequence(nowMs, (bootEpoch, beginSeq) => ['begin', bootEpoch, beginSeq,
        record.purposeId, record.operationId, record.bindingDigest]);
      this.#statements.insertOperation.run(record.purposeId, record.operationId, record.sourceKey,
        record.sourceTimeMs, record.bindingDigest, record.bindingJson, record.generation, record.target,
        record.mergeKey, record.mergeWindowUntilMs, record.budgetCharged ? 1 : 0, record.budgetReservedAtMs,
        advanced.bootEpoch, advanced.beginSeq, record.claimedAtMs, nowMs);
      return advanced;
    });
    this.#recordSequence(step, 'begin');
    return this.getOperation(record.purposeId, record.operationId);
  }

  // Durably decides that an operation is never sent. One BEGIN IMMEDIATE transaction
  // inserts the row as attempted and settles it as not_sent; it is a sequenced step of its
  // own ('decide': begin_seq + 1, chain link) and returns only after the commit and every
  // witness write and fsync. A crash before the commit leaves no row; a crash after it
  // leaves the database one step ahead of the witnesses, which the next open accepts and
  // resynchronizes. The row is terminal from the start, so boot recovery never touches it.
  //
  // Nothing is written when the operation already has a row ({ kind: 'existing' }; the
  // same ID with another binding is LEDGER_BINDING_CONFLICT) or when its source is already
  // terminal by cutover or watermark ({ kind: 'terminal' }).
  recordDecision(input = {}) {
    const record = normalizeOperationInput(input);
    const resultCode = requireToken(input.resultCode, 'resultCode', 64);
    const resultJson = normalizeResultJson(input.resultJson);
    this.#assertWritable();
    const prior = this.#read(() => {
      const existing = this.#statements.selectOperation.get(record.purposeId, record.operationId);
      if (existing) {
        if (existing.binding_digest !== record.bindingDigest) {
          throw storeError('LEDGER_BINDING_CONFLICT', 'The operation ID was replayed with a different binding.');
        }
        return Object.freeze({ kind: 'existing', operation: rowToOperation(existing) });
      }
      const terminal = this.#sourceTerminal(record.purposeId, record.sourceKey, record.sourceTimeMs);
      return terminal ? Object.freeze({ kind: 'terminal', ...terminal }) : null;
    });
    if (prior) return prior;
    this.#maybePrune();
    const nowMs = this.observedNow();
    const step = this.#growthTransaction('decide', () => {
      // Re-checked under the write lock; the reads above ran outside the transaction.
      if (this.#statements.selectOperation.get(record.purposeId, record.operationId)) {
        throw storeError('LEDGER_TRANSITION_REJECTED', 'The operation was recorded concurrently.');
      }
      if (this.#sourceTerminal(record.purposeId, record.sourceKey, record.sourceTimeMs)) {
        throw storeError('LEDGER_SOURCE_TERMINAL', 'The source became terminal concurrently.');
      }
      const advanced = this.#advanceSequence(nowMs, (bootEpoch, beginSeq) => ['decide', bootEpoch, beginSeq,
        record.purposeId, record.operationId, record.bindingDigest, resultCode]);
      this.#statements.insertOperation.run(record.purposeId, record.operationId, record.sourceKey,
        record.sourceTimeMs, record.bindingDigest, record.bindingJson, record.generation, record.target,
        record.mergeKey, record.mergeWindowUntilMs, record.budgetCharged ? 1 : 0, record.budgetReservedAtMs,
        advanced.bootEpoch, advanced.beginSeq, record.claimedAtMs, nowMs);
      const settled = Number(this.#statements.finishOperation.run('not_sent', nowMs, resultCode, resultJson,
        resultJson === null ? null : sha256Hex(resultJson), record.purposeId, record.operationId).changes);
      if (settled !== 1) throw storeError('LEDGER_PERSIST_FAILED', 'The decision row could not be settled.');
      return advanced;
    });
    this.#recordSequence(step, 'decide');
    return Object.freeze({ kind: 'recorded', operation: this.getOperation(record.purposeId, record.operationId) });
  }

  // Rows of one purpose whose attempt started after sinceMs and that may have reached the
  // network: attempted, confirmed, unknown, and rejected. not_sent rows never count. Read
  // only; it scans that purpose's rows through the primary-key index.
  countAttemptsSince({ purposeId, sinceMs } = {}) {
    const purpose = requireToken(purposeId, 'purposeId', 64);
    const since = requireTime(sinceMs, 'sinceMs');
    return this.#read(() => Number(this.#statements.countAttempts.get(purpose, since).count));
  }

  finish(input = {}) {
    const purposeId = requireToken(input.purposeId, 'purposeId', 64);
    const operationId = requireToken(input.operationId, 'operationId');
    const generation = input.generation;
    if (!TERMINAL_STATES.includes(input.state)) throw invalid('Terminal state is invalid.');
    const resultCode = requireToken(input.resultCode, 'resultCode', 64);
    const resultJson = input.resultJson === undefined || input.resultJson === null ? null : input.resultJson;
    if (resultJson !== null && (typeof resultJson !== 'string' || !resultJson ||
        Buffer.byteLength(resultJson) > MAX_RESULT_JSON_BYTES)) {
      throw invalid('resultJson is invalid.');
    }
    this.#assertWritable();
    const nowMs = this.observedNow();
    this.#transaction('finish', () => {
      const row = this.#statements.selectOperation.get(purposeId, operationId);
      if (!row || row.state !== 'attempted' || row.generation !== generation ||
          row.boot_epoch !== this.#identity.bootEpoch) {
        throw storeError('LEDGER_TRANSITION_REJECTED', 'Only the active attempted generation can finish.');
      }
      this.#statements.finishOperation.run(input.state, nowMs, resultCode, resultJson,
        resultJson === null ? null : sha256Hex(resultJson), purposeId, operationId);
      this.#statements.highWaterIdentity.run(nowMs);
    });
    if (nowMs > this.#identity.highWaterMs) this.#identity.highWaterMs = nowMs;
    return this.getOperation(purposeId, operationId);
  }

  getReactionFence(purposeId, guildId) {
    return this.#read(() => rowToFence(this.#statements.selectFence.get(purposeId, guildId)));
  }

  listReactionFences(purposeId) {
    return this.#read(() => this.#statements.listFences.all(purposeId).map(rowToFence));
  }

  // Opening, moving, or reopening a fence is a sequenced step (begin_seq + 1, chain link,
  // witness write), so a restored older fence state is caught as a rollback.
  putReactionFence(input = {}) {
    const fence = Object.freeze({
      purposeId: requireToken(input.purposeId, 'purposeId', 64),
      guildId: requireSnowflake(input.guildId, 'guildId'),
      generation: requireCount(input.generation, 'generation'),
      channelId: requireSnowflake(input.channelId, 'channelId'),
      sessionKey: requireText(input.sessionKey, 'sessionKey', 300),
      sourceFence: HEX64.test(input.sourceFence || '') ? input.sourceFence
        : (() => { throw invalid('sourceFence is invalid.'); })(),
    });
    const maximum = input.maxFences === undefined ? Infinity : input.maxFences;
    if (maximum !== Infinity && (!Number.isSafeInteger(maximum) || maximum < 1)) throw invalid('maxFences is invalid.');
    this.#assertWritable();
    const nowMs = this.observedNow();
    const step = this.#growthTransaction('put-reaction-fence', () => {
      const current = this.#statements.selectFence.get(fence.purposeId, fence.guildId);
      if (current && fence.generation <= current.generation) {
        throw storeError('LEDGER_TRANSITION_REJECTED', 'Reaction fence generations must increase.');
      }
      if (!current && Number(this.#statements.countFences.get(fence.purposeId).count) >= maximum) {
        throw storeError('LEDGER_CAPACITY_EXCEEDED', 'Reaction fence capacity is full.', { detail: { reason: 'fences' } });
      }
      const advanced = this.#advanceSequence(nowMs, (bootEpoch, beginSeq) => ['fence', bootEpoch, beginSeq,
        fence.purposeId, fence.guildId, fence.generation, 1, fence.sourceFence]);
      if (current) {
        this.#statements.updateFence.run(fence.generation, 1, fence.channelId, fence.sessionKey, fence.sourceFence,
          advanced.bootEpoch, advanced.beginSeq, nowMs, fence.purposeId, fence.guildId);
      } else {
        this.#statements.insertFence.run(fence.purposeId, fence.guildId, fence.generation, 1, fence.channelId,
          fence.sessionKey, fence.sourceFence, advanced.bootEpoch, advanced.beginSeq, nowMs);
      }
      return advanced;
    });
    this.#recordSequence(step, 'put-reaction-fence');
    return this.getReactionFence(fence.purposeId, fence.guildId);
  }

  closeReactionFence(input = {}) {
    const purposeId = requireToken(input.purposeId, 'purposeId', 64);
    const guildId = requireSnowflake(input.guildId, 'guildId');
    const generation = input.generation;
    this.#assertWritable();
    const nowMs = this.observedNow();
    const step = this.#transaction('close-reaction-fence', () => {
      const current = this.#statements.selectFence.get(purposeId, guildId);
      if (!current || current.generation !== generation || current.open !== 1) {
        throw storeError('LEDGER_TRANSITION_REJECTED', 'The reaction fence generation is stale or already closed.');
      }
      const advanced = this.#advanceSequence(nowMs, (bootEpoch, beginSeq) => ['fence', bootEpoch, beginSeq,
        purposeId, guildId, current.generation, 0, current.source_fence]);
      this.#statements.updateFence.run(current.generation, 0, current.channel_id, current.session_key,
        current.source_fence, advanced.bootEpoch, advanced.beginSeq, nowMs, purposeId, guildId);
      return advanced;
    });
    this.#recordSequence(step, 'close-reaction-fence');
    return this.getReactionFence(purposeId, guildId);
  }

  #maybePrune() {
    this.#beginsSincePrune += 1;
    if (this.#beginsSincePrune < PRUNE_EVERY_BEGINS) return;
    this.#beginsSincePrune = 0;
    this.prune({ maxBatches: 1 });
  }

  // Deletes terminal rows whose terminal time is older than the retention period. Each
  // batch is one transaction that first raises the watermark of every affected
  // (purpose, source_key) to the newest pruned source time.
  prune({ retentionMs = this.retentionMs, maxBatches = Infinity, batchRows = this.pruneBatchRows } = {}) {
    if (!Number.isSafeInteger(retentionMs) || retentionMs < 0 || !Number.isSafeInteger(batchRows) || batchRows < 1 ||
        !(maxBatches === Infinity || (Number.isSafeInteger(maxBatches) && maxBatches >= 1))) {
      throw invalid('Prune options are invalid.');
    }
    this.#assertWritable();
    const nowMs = this.observedNow();
    const cutoff = nowMs - retentionMs;
    let pruned = 0;
    let batches = 0;
    let watermarks = 0;
    let complete = false;
    while (batches < maxBatches) {
      const rows = this.#read(() => this.#statements.selectPrunable.all(cutoff, batchRows));
      if (!rows.length) {
        complete = true;
        break;
      }
      watermarks += this.#transaction('prune', () => {
        const maxima = new Map();
        for (const row of rows) {
          const key = `${row.purpose_id}\u0000${row.source_key}`;
          const current = maxima.get(key);
          if (!current || row.source_time_ms > current.sourceTimeMs) {
            maxima.set(key, { purposeId: row.purpose_id, sourceKey: row.source_key, sourceTimeMs: row.source_time_ms });
          }
        }
        for (const { purposeId, sourceKey, sourceTimeMs } of maxima.values()) {
          if (this.#statements.selectWatermark.get(purposeId, sourceKey)) {
            this.#statements.raiseWatermark.run(sourceTimeMs, nowMs, purposeId, sourceKey);
          } else {
            this.#statements.insertWatermark.run(purposeId, sourceKey, sourceTimeMs, nowMs);
          }
        }
        for (const row of rows) this.#statements.deletePrunable.run(row.row_id, cutoff);
        return maxima.size;
      });
      pruned += rows.length;
      batches += 1;
      if (rows.length < batchRows) {
        complete = true;
        break;
      }
    }
    return Object.freeze({ pruned, batches, watermarks, complete });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#purposes.clear();
    closeWitnessDescriptors(this.#witnesses);
    // Closing checkpoints the WAL into the database file and releases the exclusive lock.
    try { this.#db.close(); } catch {}
    if (this.#registryKey) OPEN_DATABASES.delete(this.#registryKey);
  }
}

function normalizeCommonOptions(options) {
  const locations = storeLocations(options.filePath);
  const witnessPaths = normalizeWitnessPaths(options.witnessPaths, locations);
  if (!LEDGER_KINDS.includes(options.kind)) throw invalid('Ledger kind is invalid.');
  return { locations, witnessPaths, kind: options.kind, durability: normalizeDurability(options.durability) };
}

// Creates a new, empty ledger file plus its witnesses. Every target must be absent. The
// test-only faultInjector is called with label 'create' and phase 'after-database' (the
// identity row is committed, no witness exists yet) and 'after-witness' (after each
// witness file).
function createLedgerStore(options = {}) {
  const { locations, witnessPaths, kind, durability } = normalizeCommonOptions(options);
  const faultInjector = normalizeFaultInjector(options.faultInjector);
  const inject = (phase) => { if (faultInjector) faultInjector({ label: 'create', phase }); };
  const identity = Object.freeze({
    ledgerId: requireToken(options.ledgerId, 'ledgerId', 128),
    kind,
    botId: requireSnowflake(options.botId, 'botId'),
    ownerId: kind === 'owner' ? requireSnowflake(options.ownerId, 'ownerId')
      : options.ownerId === undefined || options.ownerId === null ? null : requireSnowflake(options.ownerId, 'ownerId'),
    runtimeMode: RUNTIME_MODES.includes(options.runtimeMode) ? options.runtimeMode
      : (() => { throw invalid('runtimeMode is invalid.'); })(),
    genesisMs: requireTime(options.genesisMs, 'genesisMs'),
    cutoverMs: requireTime(options.cutoverMs, 'cutoverMs'),
  });
  if (identity.ownerId !== null && identity.ownerId === identity.botId) throw invalid('Bot and Owner IDs must differ.');
  assertRealDirectory(path.dirname(locations.databasePath), 'database-directory');
  for (const [role, candidate] of [['database', locations.databasePath], ['wal', locations.walPath],
    ['shm', locations.shmPath], ['journal', locations.journalPath]]) assertAbsent(candidate, role);
  for (const witnessPath of witnessPaths) {
    assertRealDirectory(path.dirname(witnessPath), 'witness-directory');
    assertAbsent(witnessPath, 'witness');
  }
  const genesisChain = chainGenesis(identity, crypto.randomBytes(16).toString('hex'));
  const db = openDatabase(locations.databasePath, { create: true, durability });
  try {
    // Enabling WAL already writes a header page, so emptiness is judged by schema and header.
    if (Number(db.prepare('SELECT COUNT(*) AS count FROM sqlite_schema').get()?.count) !== 0 ||
        Number(db.prepare('PRAGMA application_id').get()?.application_id) !== 0 ||
        Number(db.prepare('PRAGMA user_version').get()?.user_version) !== 0) {
      throw storeError('LEDGER_EXISTS', 'The ledger database appeared during creation.');
    }
    db.exec('BEGIN IMMEDIATE');
    try {
      db.exec(`PRAGMA application_id = ${APPLICATION_ID}`);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      for (const object of SCHEMA) db.exec(object.sql);
      db.prepare(`INSERT INTO identity (singleton, ledger_id, kind, format, bot_id, owner_id, runtime_mode,
        genesis_ms, cutover_ms, boot_epoch, begin_seq, high_water_ms, chain_head, chain_prev)
        VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`)
        .run(identity.ledgerId, identity.kind, STORE_FORMAT, identity.botId, identity.ownerId, identity.runtimeMode,
          identity.genesisMs, identity.cutoverMs, identity.genesisMs, genesisChain, genesisChain);
      db.exec('COMMIT');
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch {}
      throw error;
    }
    inject('after-database');
    const identityDigest = witnessIdentityDigest(identity);
    for (const witnessPath of witnessPaths) {
      createWitnessFile(witnessPath, identityDigest,
        { bootEpoch: 0, beginSeq: 0, highWaterMs: identity.genesisMs, chainHead: genesisChain }, durability);
      inject('after-witness');
    }
  } catch (error) {
    try { db.close(); } catch {}
    throw sqliteFailure(error, 'The ledger could not be created.');
  }
  try { db.close(); } catch (error) { throw sqliteFailure(error, 'The new ledger could not be closed cleanly.'); }
  if (durability === DURABILITY_FULL) fsyncDirectory(path.dirname(locations.databasePath));
  return Object.freeze({ ...locations, witnessPaths, identity });
}

// Opens an existing ledger, verifies identity and witness continuity, resynchronizes the
// witnesses, advances the boot epoch, recovers attempted rows to unknown, and prunes a
// bounded amount of old history.
function openLedgerStore(options = {}) {
  const { locations, witnessPaths, kind, durability } = normalizeCommonOptions(options);
  const expected = normalizeExpected(options.expected, kind);
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const faultInjector = normalizeFaultInjector(options.faultInjector);
  const logger = normalizeLogger(options.logger);
  const softLimitBytes = options.softLimitBytes === undefined ? SOFT_LIMIT_BYTES : options.softLimitBytes;
  const retentionMs = options.retentionMs === undefined ? RETENTION_MS : options.retentionMs;
  const acceleratedRetentionMs = options.acceleratedRetentionMs === undefined
    ? ACCELERATED_RETENTION_MS : options.acceleratedRetentionMs;
  const acceleratedPruneMaxBatches = options.acceleratedPruneMaxBatches === undefined
    ? ACCELERATED_PRUNE_MAX_BATCHES : options.acceleratedPruneMaxBatches;
  const pruneBatchRows = options.pruneBatchRows === undefined ? PRUNE_BATCH_ROWS : options.pruneBatchRows;
  for (const [name, value] of [['softLimitBytes', softLimitBytes], ['retentionMs', retentionMs],
    ['acceleratedRetentionMs', acceleratedRetentionMs], ['acceleratedPruneMaxBatches', acceleratedPruneMaxBatches],
    ['pruneBatchRows', pruneBatchRows]]) {
    requireCount(value, name);
  }
  return LedgerStore.open({ locations, witnessPaths, kind, expected, now, durability, faultInjector, logger,
    softLimitBytes, retentionMs, acceleratedRetentionMs, acceleratedPruneMaxBatches, pruneBatchRows });
}

// An action name counted by the inspection (rows.byAction); any other is left out.
const INSPECTION_ACTION = /^[a-z][a-z0-9.-]{0,63}$/u;
const INSPECTION_SQL = Object.freeze({
  operations: 'SELECT * FROM operations ORDER BY rowid',
  fences: 'SELECT COUNT(*) AS count FROM reaction_fences',
  watermarks: 'SELECT COUNT(*) AS count FROM watermarks',
});

// Read-only inspection for operators (scripts/safety-ledger.js status). Nothing is booted,
// recovered, pruned, or resynchronized, and no witness is written. The checks are: the
// 100-byte header (before SQLite touches the file), the exclusive lock, the schema
// (including sqlite_* objects), PRAGMA integrity_check, every operation row's digests,
// the identity row, each witness's two slots and its continuity with the database, and
// optionally the registration's last recorded state (notBefore). rows.byAction counts the
// operations whose row verifies by their binding's action and state (safety-ledger status reads
// the Owner DM channel preparation from it).
//
// The connection is opened read-write so a WAL left by a crash can be replayed, takes the
// exclusive lock with an empty write transaction, and then switches to query_only. A
// ledger held by another process is reported as inUse 'locked' and nothing else is read;
// one held by this process is reported as inUse 'same-process' without opening any
// descriptor. Limitation: closing checkpoints a replayed WAL into the database file. That
// is a physical write; the logical content does not change.
//
// Findings never throw; only invalid arguments do.
function inspectLedgerStore(options = {}) {
  const locations = storeLocations(options.filePath);
  const witnessPaths = options.witnessPaths === undefined ? [] : options.witnessPaths;
  if (!Array.isArray(witnessPaths) || witnessPaths.length > 4) throw invalid('witnessPaths is invalid.');
  const witnessTargets = witnessPaths.map((item) => requireAbsolutePath(item, 'witness'));
  const notBefore = normalizeNotBefore(options.notBefore);
  const presence = (filePath, role) => Boolean(lstatOrNull(filePath, role));
  const report = {
    database: {
      present: presence(locations.databasePath, 'database'),
      walPresent: presence(locations.walPath, 'wal'),
      shmPresent: presence(locations.shmPath, 'shm'),
      journalPresent: presence(locations.journalPath, 'journal'),
    },
    inUse: null,
    header: null,
    schema: null,
    integrity: null,
    identity: null,
    rows: null,
    neverUsed: null,
    neverOpened: null,
    registration: null,
    witnesses: [],
    problems: [],
  };
  const finish = () => {
    if (!report.witnesses.length) {
      report.witnesses = witnessTargets.map((filePath) => describeWitness(filePath, null, null));
    }
    for (const witness of report.witnesses) {
      if (witness.problem) report.problems.push(`witness-${witness.problem}`);
      else if (witness.continuity && witness.continuity !== 'ok') report.problems.push(`witness-${witness.continuity}`);
    }
    return deepFreeze(report);
  };
  if (!report.database.present) {
    report.problems.push('database-missing');
    return finish();
  }
  try {
    assertRealDirectory(path.dirname(locations.databasePath), 'database-directory');
    assertRegularFile(locations.databasePath, { role: 'database' });
  } catch (error) {
    report.problems.push(String(error?.code || 'LEDGER_PATH_INVALID').toLowerCase().replace(/_/gu, '-'));
    return finish();
  }
  if (OPEN_DATABASES.has(fileRegistryKey(locations.databasePath))) {
    report.inUse = 'same-process';
    report.problems.push('in-use');
    return finish();
  }
  try {
    inspectDatabaseHeader(locations.databasePath);
    report.header = 'ok';
  } catch (error) {
    report.header = error?.code || 'LEDGER_CORRUPT';
    report.problems.push('header');
    return finish();
  }
  const url = pathToFileURL(locations.databasePath);
  url.searchParams.set('mode', 'rw');
  let db;
  try {
    db = new DatabaseSync(url, { timeout: 0, enableDoubleQuotedStringLiterals: false, allowExtension: false,
      defensive: true });
    db.exec('PRAGMA locking_mode = EXCLUSIVE');
    try {
      db.exec('BEGIN IMMEDIATE');
      db.exec('COMMIT');
    } catch (error) {
      const primary = sqlitePrimaryCode(error);
      if (primary === SQLITE_BUSY || primary === SQLITE_LOCKED) {
        report.inUse = 'locked';
        report.problems.push('in-use');
        return finish();
      }
      throw error;
    }
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA trusted_schema = OFF');
    db.exec('PRAGMA cell_size_check = ON');
    try {
      verifySchema(db);
      report.schema = 'ok';
    } catch (error) {
      report.schema = error?.code || 'LEDGER_CORRUPT';
      report.problems.push('schema');
    }
    const integrity = db.prepare('PRAGMA integrity_check').all().map((row) => row.integrity_check);
    report.integrity = integrity.length === 1 && integrity[0] === 'ok' ? 'ok' : 'failed';
    if (report.integrity !== 'ok') report.problems.push('integrity');
    let identity = null;
    try {
      identity = readIdentityRow(db);
      report.identity = identity;
    } catch {
      report.problems.push('identity');
    }
    if (report.schema === 'ok') {
      const rows = { operations: 0, digestFailures: 0, byState: {}, byAction: {}, fences: 0, watermarks: 0 };
      for (const row of db.prepare(INSPECTION_SQL.operations).iterate()) {
        rows.operations += 1;
        rows.byState[row.state] = (rows.byState[row.state] || 0) + 1;
        let operation;
        try { operation = rowToOperation(row); } catch { rows.digestFailures += 1; continue; }
        const action = operation.binding.action;
        if (typeof action === 'string' && INSPECTION_ACTION.test(action)) {
          const states = Object.hasOwn(rows.byAction, action) ? rows.byAction[action] : (rows.byAction[action] = {});
          states[row.state] = (states[row.state] || 0) + 1;
        }
      }
      rows.fences = Number(db.prepare(INSPECTION_SQL.fences).get().count);
      rows.watermarks = Number(db.prepare(INSPECTION_SQL.watermarks).get().count);
      report.rows = rows;
      if (rows.digestFailures) report.problems.push('row-digest');
      if (identity) {
        report.neverOpened = identity.bootEpoch === 0;
        report.neverUsed = identity.beginSeq === 0 && rows.operations === 0 && rows.fences === 0;
      }
    }
    if (identity) {
      const digest = witnessIdentityDigest(identity);
      report.witnesses = witnessTargets.map((filePath) => describeWitness(filePath, digest, identity));
      if (notBefore) {
        try {
          assertRegistrationContinuity(identity, notBefore);
          report.registration = 'ok';
        } catch (error) {
          report.registration = error.detail?.reason || 'rollback';
          report.problems.push(report.registration);
        }
      }
    }
  } catch (error) {
    const failure = sqliteFailure(error, 'The ledger could not be inspected.');
    report.problems.push(String(failure.code).toLowerCase().replace(/_/gu, '-'));
  } finally {
    if (db) { try { db.close(); } catch {} }
  }
  return finish();
}

function describeWitness(filePath, identityDigest, identity) {
  let inspected;
  try {
    inspected = inspectWitnessFile(filePath, { identityDigest });
  } catch {
    return Object.freeze({ filePath, present: null, problem: 'uninspectable', tornSlots: Object.freeze([]),
      state: null, continuity: null });
  }
  let continuity = null;
  if (identity && !inspected.problem) {
    try {
      assertWitnessContinuity(identity, inspected.state);
      continuity = 'ok';
    } catch (error) {
      continuity = error.detail?.reason || 'rollback';
    }
  }
  return Object.freeze({ filePath, present: inspected.present, problem: inspected.problem,
    tornSlots: inspected.tornSlots, state: inspected.state, continuity });
}

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

module.exports = {
  ACCELERATED_PRUNE_MAX_BATCHES,
  ACCELERATED_RETENTION_MS,
  APPLICATION_ID,
  DURABILITY_FULL,
  DURABILITY_UNSAFE_NO_SYNC,
  DURABLE_STATES,
  LEDGER_KINDS,
  LedgerStore,
  LedgerStoreError,
  MAX_BINDING_JSON_BYTES,
  MAX_RESULT_JSON_BYTES,
  PRUNE_BATCH_ROWS,
  RETENTION_MS,
  RUNTIME_MODES,
  SCHEMA_VERSION,
  SOFT_LIMIT_BYTES,
  STATEMENT_SQL,
  STORE_FORMAT,
  TERMINAL_STATES,
  WITNESS_BYTES,
  WITNESS_SLOT_BYTES,
  CAPACITY_RELIEF_INTERVAL_MS,
  assertTestOnlyOption,
  classifyPathLocality,
  createLedgerStore,
  fsyncDirectory,
  inspectLedgerStore,
  inspectWitnessFile,
  isRemotePath,
  openLedgerStore,
  readWitness,
  renameWithRetry,
  storeLocations,
  witnessIdentityDigest,
};
