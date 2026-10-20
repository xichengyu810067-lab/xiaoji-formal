'use strict';

/*
 * Thin compatibility facade over the format-2 ledger store (./ledgerStore.js).
 *
 * The method names and replay semantics callers already use are kept. What changed:
 * - Only dispatch attempts are durable: beginDispatch writes "attempted" and finish writes
 *   the terminal state. claim/renew are in-memory leases, and pre-dispatch decisions
 *   (suppress, merge and budget suppression, finalizeUnattempted, finalizeClaim,
 *   releasePreparation) are kept in a bounded in-memory map and never write.
 * - Those decisions are forgotten on restart, and inside one process the map holds at
 *   most MAX_VOLATILE_OPERATIONS entries. When it is full, entries are evicted oldest
 *   first in three tiers: settled decisions (final, suppressed_*), then preparation
 *   failures, then claims whose lease expired more than STALE_CLAIM_AFTER_MS ago. Either
 *   way the same unsent operation can later be claimed and sent once (a late send, never
 *   a duplicate), so the two-preparation limit only holds while its entry is kept. If
 *   only live claims remain, a new claim fails closed with SIDE_EFFECT_CAPACITY_EXCEEDED,
 *   while other decisions are still returned but not remembered. An attempted operation
 *   is never retried, because it becomes unknown at boot.
 * - A released preparation (prepare_failed) may be claimed again once
 *   PREPARE_RETRY_AFTER_MS has passed; the second counted failure settles it as final. A
 *   preparation whose begin was refused only for capacity (SIDE_EFFECT_CAPACITY_EXCEEDED)
 *   is not counted: nothing was attempted, and the same operation is retried after the
 *   same wait.
 * - Every claim and re-claim takes its generation from one counter per handle, so a
 *   generation is never handed out twice: a holder whose claim expired, was re-claimed,
 *   or was evicted can never begin, renew, release, or finalize a later holder's claim.
 * - The ledger file is a SQLite database held with an exclusive lock that disappears
 *   with the owning process, so a crash no longer leaves a lock file behind.
 * - quarantine(reason) writes and fsyncs an explicit marker file at once; a failed
 *   reaction-fence write quarantines the ledger by itself, and close({ retainLock: true })
 *   writes the marker again as a backup. The marker blocks every later open until it is
 *   removed by hand, and it is never created by a crash.
 * - A quarantine is kept in up to three independent places: the marker beside the
 *   ledger, a stamp beside the external continuity witness (<witness>.quarantine.json),
 *   and, through the optional onQuarantine hook, the coin database registration. The
 *   first two are written synchronously; the call fails (QUARANTINE_PERSIST_FAILED) only
 *   when neither could be written. The hook is asynchronous; if it fails as well, the
 *   quarantine survives nowhere and LEDGER_QUARANTINE_UNPERSISTED is logged, so an
 *   automatic restart would enable the purpose again (set XIAOJI_PROTECTED_EFFECTS=off).
 * - recordNotSent is the durable "never sent" decision (LedgerStore.recordDecision): it
 *   returns only after the commit and every witness fsync. finish() settles only an
 *   attempt that may have reached the network (confirmed, unknown, rejected); final and
 *   not_sent are refused (SIDE_EFFECT_OUTCOME_INVALID), so a durable not_sent always
 *   means "certainly never sent".
 * - The initializers can stage a new ledger under <final>.creating names (the receipt
 *   already names the final paths); commitStagedLedger then renames the anchor, the
 *   witness, the receipt, and the database last, so the database rename is the commit
 *   point. openRegisteredLedger opens a ledger from its coin database registration
 *   (paths, receipt SHA-256, identity, and the last recorded counters), never from env.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const defaultLogger = require('../../utils/logger');
const {
  LedgerStoreError,
  SOFT_LIMIT_BYTES,
  assertTestOnlyOption,
  createLedgerStore,
  fsyncDirectory,
  isRemotePath,
  openLedgerStore,
  renameWithRetry,
  storeLocations,
} = require('./ledgerStore');

const FORMAT_VERSION = 2;
const MAX_LEDGER_BYTES = SOFT_LIMIT_BYTES;
const MAX_BINDING_BYTES = 4 * 1024;
const MAX_SOURCE_KEY_LENGTH = 1_024;
const MAX_RESULT_BYTES = 2_048;
const MAX_REACTION_FENCES = 1_024;
const MAX_REACTION_FENCE_BYTES = 512;
const MAX_RECEIPT_BYTES = 65_536;
// In-memory claims and pre-dispatch decisions kept per ledger handle.
const MAX_VOLATILE_OPERATIONS = 4_096;
const DEFAULT_LEASE_MS = 30_000;
// A claim whose lease expired this long ago is treated as abandoned and may be evicted.
const STALE_CLAIM_AFTER_MS = 10 * 60 * 1_000;
// A released preparation may be claimed again after this wait; the second counted
// preparation failure settles the operation as final.
const PREPARE_RETRY_AFTER_MS = 30_000;
const MAX_PREPARE_FAILURES = 2;
const DEFAULT_QUARANTINE_REASON = 'retained-by-runtime';
const QUARANTINE_STAMP_SUFFIX = '.quarantine.json';
// The registration flag (third quarantine place) is asked for at most this many times per
// handle: once by quarantine() or close(), and once more by close() if that failed.
const MAX_QUARANTINE_FLAG_ATTEMPTS = 2;
const STAGING_SUFFIX = '.creating';
const MERGE_WINDOW_MS = 10 * 60 * 1_000;
// A budget class may keep its own merge window; the others use MERGE_WINDOW_MS. A security alert is raised by
// whoever attacks, as often as they like, so a repeat of the same guild and kind is held back for an hour (the
// merge key of the notifier names the guild and the kind). The window is stored with the operation, so it holds
// across a restart too.
const OWNER_MERGE_WINDOWS_MS = Object.freeze({
  'owner-security': 60 * 60 * 1_000,
});
function mergeWindowMsFor(binding) {
  return Object.hasOwn(OWNER_MERGE_WINDOWS_MS, binding.budgetClass)
    ? OWNER_MERGE_WINDOWS_MS[binding.budgetClass] : MERGE_WINDOW_MS;
}
const OWNER_PURPOSE_ID = 'owner-safety';
// Receipts of ledgers created by the automatic bootstrap carry this marker.
const CREATED_BY_BOOTSTRAP = 'bootstrap';
const BUDGET_WINDOWS = Object.freeze([
  Object.freeze({ windowMs: 60_000, maximum: 1 }),
  Object.freeze({ windowMs: 60 * 60_000, maximum: 6 }),
  Object.freeze({ windowMs: 24 * 60 * 60_000, maximum: 24 }),
]);
// The rolling windows of each budget class a binding may be charged to ('none' is never charged).
// owner-notice is the budget every Owner notice shared before: the three windows above. The other
// classes are separate budgets for separate events, so none of them spends another's. The ledger
// keeps no class column: a durable charge is counted by (purpose, target, time), so every class
// has a target of its own (OWNER_BUDGET_TARGET_SUFFIXES). Rows written before a class existed
// carry no suffix and are never counted against it, so no migration is needed.
const OWNER_BUDGET_POLICIES = Object.freeze({
  'owner-notice': BUDGET_WINDOWS,
  'owner-member-leave': Object.freeze([
    Object.freeze({ windowMs: 60_000, maximum: 2 }),
    Object.freeze({ windowMs: 60 * 60_000, maximum: 12 }),
    Object.freeze({ windowMs: 24 * 60 * 60_000, maximum: 48 }),
  ]),
  'owner-guild-join': Object.freeze([
    Object.freeze({ windowMs: 60_000, maximum: 1 }),
    Object.freeze({ windowMs: 60 * 60_000, maximum: 6 }),
    Object.freeze({ windowMs: 24 * 60 * 60_000, maximum: 24 }),
  ]),
  'owner-outage': Object.freeze([
    Object.freeze({ windowMs: 60_000, maximum: 1 }),
    Object.freeze({ windowMs: 60 * 60_000, maximum: 2 }),
    Object.freeze({ windowMs: 24 * 60 * 60_000, maximum: 4 }),
  ]),
  'owner-security': Object.freeze([
    Object.freeze({ windowMs: 60_000, maximum: 3 }),
    Object.freeze({ windowMs: 60 * 60_000, maximum: 20 }),
    Object.freeze({ windowMs: 24 * 60 * 60_000, maximum: 60 }),
  ]),
});
// The ending a binding's target must carry for each class that is not owner-notice (whose target
// is the plain Owner ID and may not carry any of these).
const OWNER_BUDGET_TARGET_SUFFIXES = Object.freeze({
  'owner-member-leave': ':member-leave',
  'owner-guild-join': ':guild-join',
  'owner-outage': ':outage',
  'owner-security': ':security',
});
const SAFE_TOKEN = /^[A-Za-z0-9:._/-]+$/u;
const SNOWFLAKE = /^\d{17,20}$/u;
const RUNTIME_MODES = Object.freeze(['production', 'test-control']);
const PUBLIC_PURPOSES = Object.freeze({
  welcome: Object.freeze({ sourceNamespace: 'discord.guildMemberAdd', cutoverField: 'cutoverJoinedTimestampMs' }),
  'work.penalty.announce': Object.freeze({ sourceNamespace: 'db.coin_work_penalties', cutoverField: 'cutoverSourceTimestampMs' }),
  'work.reminder.dm.prepare': Object.freeze({ sourceNamespace: 'discord.work-reminder-recipient', cutoverField: 'cutoverSourceTimestampMs' }),
  'work.reminder.dm.send': Object.freeze({ sourceNamespace: 'db.coin_work_tasks.reminder', cutoverField: 'cutoverSourceTimestampMs' }),
  'audit.guild.leave': Object.freeze({ sourceNamespace: 'discord.guild-audit.join', cutoverField: 'cutoverSourceTimestampMs' }),
  'word-chain.reaction': Object.freeze({ sourceNamespace: 'discord.messageCreate', cutoverField: 'cutoverSourceTimestampMs' }),
  'number-chain.reaction': Object.freeze({ sourceNamespace: 'discord.messageCreate', cutoverField: 'cutoverSourceTimestampMs' }),
});
// Outcomes accepted by finish() for an attempted operation. A "never sent" decision is
// recordNotSent's alone: an attempt may already have reached the network.
const OUTCOME_STATES = Object.freeze({
  confirmed: 'confirmed',
  unknown: 'unknown',
  rejected: 'rejected',
});
// Durable states reported through the legacy status vocabulary.
const LEGACY_STATUS = Object.freeze({
  attempted: 'attempted',
  confirmed: 'confirmed',
  unknown: 'unknown',
  not_sent: 'final',
  rejected: 'rejected',
});
const STORE_CODE_MAP = Object.freeze({
  LEDGER_IN_USE: 'SIDE_EFFECT_LEDGER_IN_USE',
  LEDGER_PURPOSE_IN_USE: 'SIDE_EFFECT_LEDGER_IN_USE',
  LEDGER_ROLLBACK: 'SIDE_EFFECT_ROLLBACK_DETECTED',
  LEDGER_CAPACITY_EXCEEDED: 'SIDE_EFFECT_CAPACITY_EXCEEDED',
  LEDGER_PATH_LINKED: 'SIDE_EFFECT_FILE_INVALID',
  LEDGER_PATH_INVALID: 'SIDE_EFFECT_PATH_INVALID',
  LEDGER_PATH_REMOTE: 'SIDE_EFFECT_PATH_REMOTE',
  LEDGER_MISSING: 'SIDE_EFFECT_FILE_INVALID',
  LEDGER_EXISTS: 'SIDE_EFFECT_INITIALIZATION_CONFLICT',
  LEDGER_TEMP_PRESENT: 'SIDE_EFFECT_TEMP_PRESENT',
  LEDGER_CORRUPT: 'SIDE_EFFECT_FILE_CORRUPT',
  LEDGER_FORMAT_UNKNOWN: 'SIDE_EFFECT_FORMAT_UNKNOWN',
  LEDGER_FORMAT_OUTDATED: 'SIDE_EFFECT_FORMAT_OUTDATED',
  LEDGER_IDENTITY_MISMATCH: 'SIDE_EFFECT_CONTINUITY_INVALID',
  LEDGER_WITNESS_INVALID: 'SIDE_EFFECT_CONTINUITY_INVALID',
  LEDGER_BINDING_CONFLICT: 'SIDE_EFFECT_BINDING_CONFLICT',
  LEDGER_TRANSITION_REJECTED: 'SIDE_EFFECT_FENCE_REJECTED',
  LEDGER_SOURCE_TERMINAL: 'SIDE_EFFECT_SOURCE_TERMINAL',
  LEDGER_WRITE_FORBIDDEN: 'SIDE_EFFECT_WRITE_FORBIDDEN',
  LEDGER_CLOSED: 'SIDE_EFFECT_LEDGER_CLOSED',
  LEDGER_FAILED: 'SIDE_EFFECT_LEDGER_FAILED',
  LEDGER_CLOCK_INVALID: 'SIDE_EFFECT_CLOCK_INVALID',
  LEDGER_INPUT_INVALID: 'SIDE_EFFECT_BINDING_INVALID',
  LEDGER_PERSIST_FAILED: 'SIDE_EFFECT_PERSIST_FAILED',
});
// Store rejections that leave the ledger usable; anything else fails the handle closed.
const STORE_REJECTIONS = new Set([
  'LEDGER_BINDING_CONFLICT', 'LEDGER_TRANSITION_REJECTED', 'LEDGER_SOURCE_TERMINAL',
  'LEDGER_CAPACITY_EXCEEDED', 'LEDGER_INPUT_INVALID', 'LEDGER_WRITE_FORBIDDEN',
]);
const STORE_FAULT_LABELS = Object.freeze({
  begin: 'begin-dispatch',
  boot: 'recover-attempted',
  'put-reaction-fence': 'open-reaction-fence',
  decide: 'record-not-sent',
  create: 'create-ledger',
});

class SideEffectLedgerError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = 'SideEffectLedgerError';
    this.code = code;
  }
}

function fail(code, message, options) {
  throw new SideEffectLedgerError(code, message, options);
}

function mapLedgerError(error) {
  if (!(error instanceof LedgerStoreError)) return error;
  const role = String(error.detail?.role || '');
  const code = (error.code === 'LEDGER_PATH_LINKED' || error.code === 'LEDGER_PATH_INVALID') && role.endsWith('-directory')
    ? 'SIDE_EFFECT_PARENT_INVALID'
    : error.code === 'LEDGER_INPUT_INVALID' && error.detail?.reason === 'test-only-option'
      ? 'SIDE_EFFECT_CONFIGURATION_INVALID'
      : STORE_CODE_MAP[error.code] || 'SIDE_EFFECT_PERSIST_FAILED';
  const mapped = new SideEffectLedgerError(code, error.message, { cause: error });
  mapped.storeCode = error.code;
  mapped.retryable = error.retryable === true;
  // Fixed tokens and counters only (reason, role, step counts); never a path or an ID.
  if (error.detail !== undefined) mapped.storeDetail = error.detail;
  return mapped;
}

// An error carrying a fixed reason token, for mismatches found before the store opens.
function failWithReason(code, message, reason) {
  const error = new SideEffectLedgerError(code, message);
  error.detail = Object.freeze({ reason });
  throw error;
}

// A short, path-free reason for logs: the system error code when there is one (file system
// messages embed paths), otherwise the message reduced to safe characters.
function describeErrorCause(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (/^[A-Z][A-Z0-9_]{1,63}$/u.test(code)) return code;
  const message = String(error?.message || error?.name || '').replace(/[^A-Za-z0-9 ._-]/gu, '').trim();
  return message ? message.replace(/\s+/gu, '_').slice(0, 80) : 'unknown';
}

function withStoreErrors(work) {
  try {
    return work();
  } catch (error) {
    throw mapLedgerError(error);
  }
}

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function identity(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function requiredToken(value, name, maximum = 256) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maximum || !SAFE_TOKEN.test(normalized)) {
    fail('SIDE_EFFECT_BINDING_INVALID', `${name} is invalid.`);
  }
  return normalized;
}

function requiredText(value, name, maximum) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > maximum || /[\u0000-\u001f\u007f]/u.test(normalized)) {
    fail('SIDE_EFFECT_BINDING_INVALID', `${name} is invalid.`);
  }
  return normalized;
}

function normalizeRuntimeMode(value) {
  if (!RUNTIME_MODES.includes(value)) fail('SIDE_EFFECT_CONFIGURATION_INVALID', 'Ledger runtime mode is invalid.');
  return value;
}

function normalizeNotificationIdentity(value) {
  const botId = String(value?.botId || '').trim();
  const ownerId = String(value?.ownerId || '').trim();
  if (!SNOWFLAKE.test(botId) || !SNOWFLAKE.test(ownerId) || botId === ownerId) {
    fail('SIDE_EFFECT_IDENTITY_INVALID', 'A distinct fixed bot and Owner identity is required.');
  }
  return Object.freeze({ botId, ownerId });
}

function normalizePublicPurposeIdentity(value) {
  const purposeId = requiredToken(value?.purposeId, 'purposeId', 64);
  const botId = String(value?.botId || '').trim();
  const sourceNamespace = requiredToken(value?.sourceNamespace, 'sourceNamespace', 128);
  const contract = PUBLIC_PURPOSES[purposeId];
  const cutoverValue = Number(contract ? value?.[contract.cutoverField] : NaN);
  const freshSourceProofDigest = String(value?.freshSourceProofDigest || '').trim();
  if (!contract || !SNOWFLAKE.test(botId) ||
      sourceNamespace !== contract.sourceNamespace ||
      !Number.isSafeInteger(cutoverValue) || cutoverValue < 0 ||
      !/^[a-f0-9]{64}$/u.test(freshSourceProofDigest)) {
    fail('SIDE_EFFECT_PURPOSE_IDENTITY_INVALID', 'A fixed public purpose identity is required.');
  }
  return Object.freeze({
    purposeId,
    botId,
    sourceNamespace,
    [contract.cutoverField]: cutoverValue,
    freshSourceProofDigest,
  });
}

function normalizePublicPurposeExpectation(value) {
  const purposeId = requiredToken(value?.purposeId, 'purposeId', 64);
  const botId = String(value?.botId || '').trim();
  const sourceNamespace = requiredToken(value?.sourceNamespace, 'sourceNamespace', 128);
  const contract = PUBLIC_PURPOSES[purposeId];
  if (!contract || !SNOWFLAKE.test(botId) || sourceNamespace !== contract.sourceNamespace) {
    fail('SIDE_EFFECT_PURPOSE_IDENTITY_INVALID', 'A fixed public purpose expectation is required.');
  }
  return Object.freeze({ purposeId, botId, sourceNamespace });
}

function safeNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) fail('SIDE_EFFECT_CLOCK_INVALID', 'Ledger clock is invalid.');
  return value;
}

// Legacy-compatible file layout. The ledger path itself is now the SQLite database;
// "anchorPath" names the internal two-slot witness kept beside it.
function pathsFor(filePath) {
  const resolved = path.resolve(filePath);
  const store = storeLocations(resolved);
  const retainedLockPath = `${resolved}.retained.lock`;
  return Object.freeze({
    ledgerPath: resolved,
    walPath: store.walPath,
    shmPath: store.shmPath,
    journalPath: store.journalPath,
    anchorPath: `${resolved}.witness`,
    receiptPath: `${resolved}.provenance.json`,
    retainedLockPath,
    // Legacy name: only an explicit close({ retainLock: true }) ever creates this file.
    lockPath: retainedLockPath,
  });
}

function lstat(filePath) {
  try {
    return fs.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    fail('SIDE_EFFECT_PATH_UNREADABLE', 'A ledger path cannot be inspected.', { cause: error });
  }
}

function readBoundedRegularFile(filePath, maximum) {
  const stat = lstat(filePath);
  if (!stat || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > maximum ||
      identity(fs.realpathSync(filePath)) !== identity(filePath)) {
    fail('SIDE_EFFECT_FILE_INVALID', 'A ledger control file is missing, linked, or outside its size limit.');
  }
  let bytes;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (error) {
    fail('SIDE_EFFECT_FILE_UNREADABLE', 'A ledger control file cannot be read.', { cause: error });
  }
  if (bytes.length !== stat.size) fail('SIDE_EFFECT_FILE_DRIFT', 'A ledger control file changed while being read.');
  return { bytes, stat };
}

function parseJson(bytes, code = 'SIDE_EFFECT_FILE_CORRUPT') {
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    fail(code, 'A ledger control file is not valid JSON.', { cause: error });
  }
}

function writeNewDurableFile(filePath, bytes) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
  fsyncDirectory(path.dirname(filePath));
}

function requiredFenceText(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 300 &&
    !/[\u0000-\u001f\u007f]/u.test(value);
}

function normalizeReactionFence(input, ledgerId, generation) {
  const guildId = String(input?.guildId || '').trim();
  const channelId = String(input?.channelId || '').trim();
  const sessionKey = String(input?.sessionKey || '').trim();
  if (!SNOWFLAKE.test(guildId) || !SNOWFLAKE.test(channelId) || !requiredFenceText(sessionKey)) {
    fail('SIDE_EFFECT_FENCE_INVALID', 'Reaction fence binding is invalid.');
  }
  const sourceFence = digest(stableJson({ ledgerId, guildId, generation, channelId, sessionKey }));
  const fence = { generation, open: true, channelId, sessionKey, sourceFence };
  if (Buffer.byteLength(stableJson(fence)) > MAX_REACTION_FENCE_BYTES) {
    fail('SIDE_EFFECT_BINDING_TOO_LARGE', 'Reaction fence exceeds its fixed limit.');
  }
  return Object.freeze({ guildId, fence });
}

function fenceView(fence) {
  return {
    generation: fence.generation,
    open: fence.open,
    channelId: fence.channelId,
    sessionKey: fence.sessionKey,
    sourceFence: fence.sourceFence,
  };
}

// A durable charge is counted by (purpose, target), so the target is what keeps one budget class
// from being counted into another: each class other than owner-notice must end with its own
// suffix, and an owner-notice target may not end with any of them.
function budgetTargetFits(budgetClass, target) {
  if (Object.hasOwn(OWNER_BUDGET_TARGET_SUFFIXES, budgetClass)) {
    const suffix = OWNER_BUDGET_TARGET_SUFFIXES[budgetClass];
    return target.length > suffix.length && target.endsWith(suffix);
  }
  if (!Object.hasOwn(OWNER_BUDGET_POLICIES, budgetClass)) return true;
  return !Object.values(OWNER_BUDGET_TARGET_SUFFIXES).some((reserved) => target.endsWith(reserved));
}

// Returns the normalized binding plus the exact JSON whose SHA-256 is its digest. An
// optional sourceTimeMs (event time, not wall time) enables cutover and watermark checks.
function bindingParts(input) {
  const payloadJson = stableJson(input?.payload);
  const payloadBytes = Buffer.byteLength(payloadJson || '');
  if (!payloadJson || payloadBytes <= 0 || payloadBytes > MAX_BINDING_BYTES) {
    fail('SIDE_EFFECT_BINDING_TOO_LARGE', 'Normalized payload exceeds the binding limit.');
  }
  const binding = {
    operationId: requiredToken(input.operationId, 'operationId'),
    sourceKey: requiredText(input.sourceKey, 'sourceKey', MAX_SOURCE_KEY_LENGTH),
    sourceEventId: requiredToken(input.sourceEventId, 'sourceEventId'),
    hostPurpose: requiredToken(input.hostPurpose, 'hostPurpose'),
    scope: requiredText(input.scope, 'scope', 1_024),
    action: requiredToken(input.action, 'action'),
    target: requiredToken(input.target, 'target'),
    budgetClass: requiredToken(input.budgetClass, 'budgetClass', 64),
    mergeKey: requiredText(input.mergeKey, 'mergeKey', 2_048),
    payloadDigest: digest(payloadJson),
  };
  if (input.sourceTimeMs !== undefined && input.sourceTimeMs !== null) {
    if (!Number.isSafeInteger(input.sourceTimeMs) || input.sourceTimeMs < 0) {
      fail('SIDE_EFFECT_BINDING_INVALID', 'sourceTimeMs is invalid.');
    }
    binding.sourceTimeMs = input.sourceTimeMs;
  }
  if (binding.budgetClass !== 'none' && !Object.hasOwn(OWNER_BUDGET_POLICIES, binding.budgetClass)) {
    fail('SIDE_EFFECT_BINDING_INVALID', 'budgetClass is invalid.');
  }
  if (!budgetTargetFits(binding.budgetClass, binding.target)) {
    fail('SIDE_EFFECT_BINDING_INVALID', 'target does not fit its budgetClass.');
  }
  const bindingJson = stableJson(binding);
  if (Buffer.byteLength(bindingJson) > MAX_BINDING_BYTES) {
    fail('SIDE_EFFECT_BINDING_TOO_LARGE', 'Complete operation binding exceeds the limit.');
  }
  return Object.freeze({
    binding: Object.freeze({ ...binding, bindingDigest: digest(bindingJson), bindingBytes: Buffer.byteLength(bindingJson) }),
    bindingJson,
  });
}

function normalizeBinding(input) {
  return bindingParts(input).binding;
}

function isWithin(now, timestamp, windowMs) {
  return Number.isSafeInteger(timestamp) && timestamp <= now && now - timestamp < windowMs;
}

function durableView(record) {
  const view = {
    ...record.binding,
    bindingDigest: record.bindingDigest,
    bindingBytes: record.bindingBytes,
    status: LEGACY_STATUS[record.state],
    state: record.state,
    durable: true,
    generation: record.generation,
    observedAtMs: record.claimedAtMs,
    claimedAtMs: record.claimedAtMs,
    leaseUntilMs: null,
    attemptedAtMs: record.attemptedAtMs,
    finishedAtMs: record.finishedAtMs,
    mergeWindowUntilMs: record.mergeWindowUntilMs,
    budgetCharged: record.budgetCharged,
    budgetReservedAtMs: record.budgetReservedAtMs,
    resultCode: record.resultCode,
  };
  if (record.resultDigest !== null) {
    view.result = record.result;
    view.resultDigest = record.resultDigest;
  }
  return view;
}

function volatileView(entry) {
  return {
    ...entry.binding,
    status: entry.status,
    state: null,
    durable: false,
    generation: entry.generation,
    observedAtMs: entry.observedAtMs,
    claimedAtMs: entry.claimedAtMs ?? null,
    leaseUntilMs: entry.leaseUntilMs ?? null,
    attemptedAtMs: null,
    finishedAtMs: entry.finishedAtMs ?? null,
    mergeWindowUntilMs: entry.mergeWindowUntilMs ?? null,
    budgetCharged: entry.budgetCharged === true,
    budgetReservedAtMs: entry.budgetReservedAtMs ?? null,
    prepareFailures: entry.prepareFailures ?? 0,
    retryNotBeforeMs: entry.retryNotBeforeMs ?? null,
    resultCode: entry.resultCode ?? null,
  };
}

class SideEffectLedger {
  #store;
  #purposeId;
  #releasePurpose;
  #ownsStore;
  #faultInjector;
  #logger;
  #volatile = new Map();
  // The only source of claim generations on this handle. Every claim and re-claim (after
  // an expired lease or a released preparation) takes the next value, so no generation is
  // ever handed out twice, whatever was evicted or re-claimed before: a holder whose claim
  // expired, was replaced, or was evicted can never begin, renew, release, or finalize a
  // later holder's claim. The counter only grows; gaps are harmless.
  #lastGeneration = 0;
  #closed = false;
  #failed = false;
  #quarantined = false;
  #quarantineReason = null;
  #quarantineWritten = false;
  #quarantineFailure = null;
  #quarantineRequestedAtMs = null;
  #quarantineStampPath = null;
  #onQuarantine = null;
  #quarantineFlag = null;
  #quarantineFlagAttempts = 0;
  #quarantineFlagRetryQueued = false;
  #quarantinePersisted = { marker: false, stamp: false, registration: null };

  constructor({ store, purposeId, locations, provenance, continuityWitness = null, faultInjector = null,
    logger = defaultLogger, ownsStore = true, quarantineStampPath = null, onQuarantine = null } = {}) {
    this.#store = store;
    this.#purposeId = requiredToken(purposeId, 'purposeId', 64);
    this.#releasePurpose = withStoreErrors(() => store.attachPurpose(this.#purposeId));
    this.#ownsStore = ownsStore;
    this.#faultInjector = faultInjector;
    this.#logger = logger || defaultLogger;
    this.#quarantineStampPath = quarantineStampPath;
    this.#onQuarantine = typeof onQuarantine === 'function' ? onQuarantine : null;
    this.locations = locations;
    this.provenance = Object.freeze({ ...provenance });
    this.continuityWitness = continuityWitness;
  }

  get closed() { return this.#closed; }

  // True once the handle can no longer be trusted: a persistence fault, an unreadable or
  // corrupt file seen by any read, or a quarantine.
  get failed() { return this.#failed || this.#quarantined || this.#store.failed; }

  get quarantined() { return this.#quarantined; }

  // The last error that stopped the quarantine marker from being written, if any.
  get quarantineFailure() { return this.#quarantineFailure; }

  get purposeId() { return this.#purposeId; }

  get ledgerId() { return this.#store.identity.ledgerId; }

  // Counters and chain head of the last committed step, from memory (no file access).
  get identityCounters() { return this.#store.identityCounters; }

  // Where this handle's quarantine has been made durable: marker and stamp (null when the
  // ledger has no external witness) are written synchronously; registration is true or
  // false once the onQuarantine hook settled, and null before that or without a hook.
  get quarantinePersistence() {
    return Object.freeze({
      marker: this.#quarantinePersisted.marker,
      stamp: this.#quarantineStampPath ? this.#quarantinePersisted.stamp : null,
      registration: this.#quarantinePersisted.registration,
    });
  }

  // Settles with true or false once the onQuarantine hook finished, including the one
  // retry close() may add (null without a hook or before any quarantine). Never rejects.
  get quarantineFlag() { return this.#quarantineFlag; }

  // The soft size limit of the underlying store (512 MiB by default).
  get maximumLedgerBytes() { return this.#store.softLimitBytes; }

  set maximumLedgerBytes(value) {
    if (!Number.isSafeInteger(value) || value < 1) fail('SIDE_EFFECT_CONFIGURATION_INVALID', 'Ledger size limit is invalid.');
    this.#store.softLimitBytes = value;
  }

  storageBytes() {
    return this.#read(() => this.#store.usedBytes());
  }

  getStoreStatsForTests() {
    return this.#read(() => this.#store.stats());
  }

  assertUsable() {
    if (this.#closed) fail('SIDE_EFFECT_LEDGER_CLOSED', 'Ledger is closed.');
    if (this.#quarantined) fail('SIDE_EFFECT_LEDGER_QUARANTINED', 'Ledger is quarantined and requires manual review.');
    if (this.failed) fail('SIDE_EFFECT_LEDGER_FAILED', 'Ledger is fail-closed after a persistence fault.');
  }

  // Disables this ledger at once and durably: the handle stops accepting work before
  // anything else happens (an invalid reason falls back to the default instead of
  // throwing), then the marker beside the ledger and the stamp beside its external witness
  // are written and fsynced, and the onQuarantine hook (if any) is asked to record the
  // quarantine in the registration. Any one of them blocks every later open
  // (SIDE_EFFECT_LEDGER_QUARANTINED, or LEDGER_QUARANTINED at bootstrap) until an operator
  // releases it. If neither file could be written, the failure is logged, recorded in
  // quarantineFailure, and thrown; the handle stays disabled either way.
  quarantine(reason = DEFAULT_QUARANTINE_REASON) {
    this.#quarantined = true;
    const candidate = typeof reason === 'string' ? reason.trim() : '';
    const normalized = candidate && candidate.length <= 64 && SAFE_TOKEN.test(candidate)
      ? candidate : DEFAULT_QUARANTINE_REASON;
    this.#quarantineReason ||= normalized;
    let failure = null;
    try {
      this.#writeQuarantineRecords();
    } catch (error) {
      failure = error;
    }
    this.#requestQuarantineFlag();
    if (failure) throw failure;
    return Object.freeze({ kind: 'quarantined', reason: this.#quarantineReason });
  }

  #quarantineTargets() {
    return [['marker', this.locations?.retainedLockPath], ['stamp', this.#quarantineStampPath]]
      .filter(([, filePath]) => typeof filePath === 'string' && filePath);
  }

  // Writes the marker and the stamp independently, so one failing never stops the other.
  #writeQuarantineRecords() {
    const targets = this.#quarantineTargets();
    const failures = [];
    if (!targets.length) failures.push(['marker', new Error('No quarantine marker path is configured.')]);
    for (const [target, filePath] of targets) {
      try {
        this.#inject('quarantine', 'before-quarantine-write', { target });
        if (lstat(filePath)) {
          // Any entry already at the path blocks every later open; flush its directory
          // entry so it survives a crash as well.
          fsyncDirectory(path.dirname(filePath));
        } else {
          writeNewDurableFile(filePath, Buffer.from(`${JSON.stringify({
            formatVersion: FORMAT_VERSION,
            ledgerId: this.#safeLedgerId(),
            purposeId: this.#purposeId,
            reason: this.#quarantineReason,
            record: target,
          })}\n`, 'utf8'));
        }
        this.#quarantinePersisted[target] = true;
      } catch (error) {
        failures.push([target, error]);
      }
    }
    if (failures.length < targets.length) {
      this.#quarantineWritten = true;
      this.#quarantineFailure = null;
      for (const [target, error] of failures) {
        this.#logger?.warn?.('[SIDE_EFFECT_LEDGER] code=SIDE_EFFECT_QUARANTINE_PARTIAL ' +
          `ledgerId=${this.#safeLedgerId()} purpose=${this.#purposeId} target=${target} cause=${describeErrorCause(error)}`);
      }
      return;
    }
    const [, error] = failures[0];
    this.#quarantineFailure = error;
    this.#logger?.error?.('[SIDE_EFFECT_LEDGER] code=SIDE_EFFECT_QUARANTINE_PERSIST_FAILED ' +
      `ledgerId=${this.#safeLedgerId()} purpose=${this.#purposeId} cause=${describeErrorCause(error)}`);
    throw new SideEffectLedgerError('SIDE_EFFECT_QUARANTINE_PERSIST_FAILED',
      'The quarantine marker could not be written; the ledger stays disabled in this process.', { cause: error });
  }

  // Asks the hook to record the quarantine outside the ledger directories, the first time
  // only. The hook runs asynchronously; its outcome is kept in
  // quarantinePersistence.registration.
  #requestQuarantineFlag() {
    if (!this.#onQuarantine || this.#quarantineFlag) return;
    this.#quarantineFlag = this.#attemptQuarantineFlag();
  }

  // close(): if the flag was never requested, request it; if the request failed (now or
  // once it settles), ask exactly once more. At most MAX_QUARANTINE_FLAG_ATTEMPTS calls.
  #retryQuarantineFlag() {
    if (!this.#onQuarantine) return;
    if (!this.#quarantineFlag) {
      this.#requestQuarantineFlag();
      return;
    }
    if (this.#quarantineFlagAttempts >= MAX_QUARANTINE_FLAG_ATTEMPTS || this.#quarantineFlagRetryQueued) return;
    this.#quarantineFlagRetryQueued = true;
    this.#quarantineFlag = this.#quarantineFlag.then((recorded) => (recorded ? true : this.#attemptQuarantineFlag()));
  }

  #attemptQuarantineFlag() {
    this.#quarantineFlagAttempts += 1;
    const attempt = this.#quarantineFlagAttempts;
    if (this.#quarantineRequestedAtMs === null) {
      try {
        this.#quarantineRequestedAtMs = this.#store.observedNow();
      } catch {
        this.#quarantineRequestedAtMs = Date.now();
      }
    }
    const event = Object.freeze({
      purposeId: this.#purposeId,
      ledgerId: this.#safeLedgerId(),
      reason: this.#quarantineReason,
      requestedAtMs: this.#quarantineRequestedAtMs,
      persisted: Object.freeze({ marker: this.#quarantinePersisted.marker, stamp: this.#quarantinePersisted.stamp }),
    });
    let pending;
    try {
      pending = Promise.resolve(this.#onQuarantine(event));
    } catch (error) {
      pending = Promise.reject(error);
    }
    return pending.then(() => {
      this.#quarantinePersisted.registration = true;
      return true;
    }, (error) => {
      this.#quarantinePersisted.registration = false;
      const unpersisted = !this.#quarantinePersisted.marker && !this.#quarantinePersisted.stamp;
      const line = `ledgerId=${this.#safeLedgerId()} purpose=${this.#purposeId} attempt=${attempt} ` +
        `cause=${describeErrorCause(error)}`;
      if (unpersisted) {
        // Nothing durable remains: a restart would enable this purpose again.
        this.#logger?.error?.(`[SIDE_EFFECT_LEDGER] code=LEDGER_QUARANTINE_UNPERSISTED ${line}`);
      } else {
        this.#logger?.warn?.(`[SIDE_EFFECT_LEDGER] code=SIDE_EFFECT_QUARANTINE_FLAG_FAILED ${line}`);
      }
      return false;
    });
  }

  #safeLedgerId() {
    try {
      return this.ledgerId;
    } catch {
      return 'unknown';
    }
  }

  // A reaction-fence write that failed for any reason other than a plain rejection leaves
  // the fence state on disk uncertain, so the ledger quarantines itself before the error
  // reaches the caller. A marker write failure travels with the original error.
  #quarantineAfterFenceFault(error) {
    if (!this.#failed && !this.#store.failed) return;
    try {
      this.quarantine('reaction_fence_persist_failed');
    } catch (quarantineError) {
      if (error && typeof error === 'object') error.quarantineError = quarantineError;
    }
  }

  observedNow() {
    return this.#read(() => this.#store.observedNow());
  }

  #inject(label, phase, extra = undefined) {
    if (this.#faultInjector) this.#faultInjector({ label, phase, ...extra });
  }

  #read(work) {
    try {
      return work();
    } catch (error) {
      if (error instanceof LedgerStoreError && error.code === 'LEDGER_CORRUPT') this.#failed = true;
      throw mapLedgerError(error);
    }
  }

  // Every call routed through here is guaranteed by the store to perform zero writes.
  #zeroWrite(work) {
    return this.#read(() => this.#store.withoutWrites(work));
  }

  #persist(label, work) {
    try {
      this.#inject(label, 'before-ledger-write');
      return work();
    } catch (error) {
      if (!(error instanceof LedgerStoreError && STORE_REJECTIONS.has(error.code))) this.#failed = true;
      throw mapLedgerError(error);
    }
  }

  #durableRecord(operationId) {
    const record = this.#store.getOperation(this.#purposeId, operationId);
    if (record && (record.binding.operationId !== record.operationId || record.binding.sourceKey !== record.sourceKey ||
        record.binding.target !== record.target || record.binding.mergeKey !== record.mergeKey)) {
      this.#failed = true;
      fail('SIDE_EFFECT_FILE_CORRUPT', 'Ledger operation binding is inconsistent.');
    }
    return record;
  }

  #existing(binding) {
    const durable = this.#durableRecord(binding.operationId);
    if (durable) {
      if (durable.bindingDigest !== binding.bindingDigest) {
        fail('SIDE_EFFECT_BINDING_CONFLICT', 'Operation ID was replayed with a different binding.');
      }
      return Object.freeze({ durable, entry: null });
    }
    const entry = this.#volatile.get(binding.operationId);
    if (entry) {
      if (entry.binding.bindingDigest !== binding.bindingDigest) {
        fail('SIDE_EFFECT_BINDING_CONFLICT', 'Operation ID was replayed with a different binding.');
      }
      return Object.freeze({ durable: null, entry });
    }
    return null;
  }

  #view(found) {
    return found.durable ? durableView(found.durable) : volatileView(found.entry);
  }

  // A source with no row whose event time is at or below the cutover or its watermark is
  // terminal; this answer is computed, never written.
  #sourceTerminal(binding) {
    if (binding.sourceTimeMs === undefined) return null;
    const inspected = this.#store.inspectOperation({ purposeId: this.#purposeId, operationId: binding.operationId,
      sourceKey: binding.sourceKey, sourceTimeMs: binding.sourceTimeMs });
    if (inspected.kind !== 'terminal') return null;
    const now = this.#store.observedNow();
    return volatileView({
      binding,
      status: 'final',
      generation: 0,
      observedAtMs: now,
      finishedAtMs: now,
      budgetCharged: false,
      resultCode: inspected.reason === 'cutover' ? 'before_cutover' : 'source_watermark',
    });
  }

  #findMerge(binding, now) {
    const durable = this.#store.findMergeHolder({ purposeId: this.#purposeId, mergeKey: binding.mergeKey, nowMs: now });
    if (durable) return durable;
    for (const entry of this.#volatile.values()) {
      if (entry.binding.mergeKey === binding.mergeKey && Number.isSafeInteger(entry.mergeWindowUntilMs) &&
          now < entry.mergeWindowUntilMs) return entry;
    }
    return null;
  }

  // The windows of the binding's own budget class. Durable charges are counted by target, which
  // is unique to the class (see OWNER_BUDGET_TARGET_SUFFIXES); the in-memory ones by class and
  // target. A class without a policy is never allowed.
  #budgetAllows(binding, now, includeNew = true) {
    if (!Object.hasOwn(OWNER_BUDGET_POLICIES, binding.budgetClass)) return false;
    const { budgetClass, target } = binding;
    return OWNER_BUDGET_POLICIES[budgetClass].every(({ windowMs, maximum }) => {
      let count = this.#store.countBudget({ purposeId: this.#purposeId, target, nowMs: now, windowMs });
      for (const entry of this.#volatile.values()) {
        if (entry.binding.budgetClass === budgetClass && entry.binding.target === target &&
            entry.budgetCharged === true && isWithin(now, entry.budgetReservedAtMs, windowMs)) count += 1;
      }
      return count + (includeNew ? 1 : 0) <= maximum;
    });
  }

  // Keeps a pre-dispatch decision in memory. When the map is full, one entry is evicted,
  // oldest first, from the first tier that has any: settled decisions (final,
  // suppressed_*), then preparation failures, then claims whose lease expired more than
  // STALE_CLAIM_AFTER_MS ago. An evicted operation can later be claimed and sent once in
  // this same process (a late send, never a duplicate); that also resets its preparation
  // count. A new claim of it takes a fresh generation from the handle counter, so no
  // evicted holder can act on it. If nothing is evictable, a new claim fails closed with
  // SIDE_EFFECT_CAPACITY_EXCEEDED, and any other decision is returned without being kept.
  #remember(entry, { required = false } = {}) {
    const operationId = entry.binding.operationId;
    if (!this.#volatile.has(operationId) && this.#volatile.size >= MAX_VOLATILE_OPERATIONS &&
        !this.#evictOne(this.#store.observedNow())) {
      if (required) fail('SIDE_EFFECT_CAPACITY_EXCEEDED', 'Only live in-memory claims remain; a new claim cannot be tracked.');
      return entry;
    }
    this.#volatile.set(operationId, entry);
    return entry;
  }

  #evictOne(now) {
    const tiers = [
      (item) => item.status === 'final' || item.status.startsWith('suppressed_'),
      (item) => item.status === 'prepare_failed',
      (item) => item.status === 'claimed' && Number.isSafeInteger(item.leaseUntilMs) &&
        item.leaseUntilMs + STALE_CLAIM_AFTER_MS <= now,
    ];
    for (const evictable of tiers) {
      for (const [key, candidate] of this.#volatile) {
        if (!evictable(candidate)) continue;
        this.#volatile.delete(key);
        return true;
      }
    }
    return false;
  }

  #nextGeneration() {
    this.#lastGeneration += 1;
    return this.#lastGeneration;
  }

  #activeClaim(operationId, generation, message) {
    if (this.#durableRecord(operationId)) fail('SIDE_EFFECT_FENCE_REJECTED', message);
    const entry = this.#volatile.get(operationId);
    if (!entry || entry.status !== 'claimed' || entry.generation !== generation) {
      fail('SIDE_EFFECT_FENCE_REJECTED', message);
    }
    return entry;
  }

  verifyBinding(input) {
    this.assertUsable();
    return this.#zeroWrite(() => {
      const { binding } = bindingParts(input);
      const found = this.#existing(binding);
      return found ? this.#view(found) : this.#sourceTerminal(binding);
    });
  }

  claim(input, { leaseMs = DEFAULT_LEASE_MS } = {}) {
    this.assertUsable();
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 0) fail('SIDE_EFFECT_BINDING_INVALID', 'leaseMs is invalid.');
    return this.#zeroWrite(() => {
      const { binding } = bindingParts(input);
      const found = this.#existing(binding);
      const now = this.#store.observedNow();
      const budgeted = binding.budgetClass !== 'none';
      if (found?.durable) return Object.freeze({ kind: 'replay', operation: durableView(found.durable) });
      if (found?.entry) {
        const entry = found.entry;
        // A released preparation is claimed again only after its retry wait.
        if (entry.status === 'prepare_failed') {
          if ((Number.isSafeInteger(entry.retryNotBeforeMs) && now < entry.retryNotBeforeMs) ||
              (budgeted && !this.#budgetAllows(binding, now))) {
            return Object.freeze({ kind: 'replay', operation: volatileView(entry) });
          }
          Object.assign(entry, {
            status: 'claimed', generation: this.#nextGeneration(), claimedAtMs: now, leaseUntilMs: now + leaseMs,
            budgetCharged: budgeted, budgetReservedAtMs: budgeted ? now : null,
            finishedAtMs: null, retryNotBeforeMs: null, capacityRefused: false, resultCode: null,
          });
          return Object.freeze({ kind: 'claimed', operation: volatileView(entry) });
        }
        if (entry.status === 'claimed' && entry.leaseUntilMs <= now) {
          Object.assign(entry, { generation: this.#nextGeneration(), claimedAtMs: now, leaseUntilMs: now + leaseMs,
            capacityRefused: false });
          return Object.freeze({ kind: 'claimed', operation: volatileView(entry) });
        }
        return Object.freeze({ kind: 'replay', operation: volatileView(entry) });
      }
      const terminal = this.#sourceTerminal(binding);
      if (terminal) return Object.freeze({ kind: 'replay', operation: terminal });

      const merged = this.#findMerge(binding, now);
      let entry;
      if (merged) {
        entry = { binding, status: 'suppressed_merge', generation: 1, observedAtMs: now,
          mergeWindowUntilMs: merged.mergeWindowUntilMs, budgetCharged: false, resultCode: 'merged' };
      } else if (budgeted && !this.#budgetAllows(binding, now)) {
        entry = { binding, status: 'suppressed_budget', generation: 1, observedAtMs: now,
          mergeWindowUntilMs: now + mergeWindowMsFor(binding), budgetCharged: false, resultCode: 'budget' };
      } else {
        entry = { binding, status: 'claimed', generation: this.#nextGeneration(), observedAtMs: now,
          claimedAtMs: now, leaseUntilMs: now + leaseMs, mergeWindowUntilMs: now + mergeWindowMsFor(binding),
          budgetCharged: budgeted, budgetReservedAtMs: budgeted ? now : null, prepareFailures: 0 };
      }
      this.#remember(entry, { required: entry.status === 'claimed' });
      return Object.freeze({ kind: entry.status === 'claimed' ? 'claimed' : 'suppressed', operation: volatileView(entry) });
    });
  }

  // Queue overflow defers the event without any durable write.
  suppress(input, resultCode = 'queue_full') {
    this.assertUsable();
    return this.#zeroWrite(() => {
      const { binding } = bindingParts(input);
      const found = this.#existing(binding);
      if (found) return Object.freeze({ kind: 'replay', operation: this.#view(found) });
      const now = this.#store.observedNow();
      const entry = this.#remember({ binding, status: 'suppressed_queue', generation: 1, observedAtMs: now,
        mergeWindowUntilMs: now + mergeWindowMsFor(binding), budgetCharged: false,
        resultCode: requiredToken(resultCode, 'resultCode', 64) });
      return Object.freeze({ kind: 'suppressed', operation: volatileView(entry) });
    });
  }

  finalizeUnattempted(input, resultCode = 'unavailable_before_dispatch') {
    this.assertUsable();
    return this.#zeroWrite(() => {
      const { binding } = bindingParts(input);
      const found = this.#existing(binding);
      if (found) return Object.freeze({ kind: 'replay', operation: this.#view(found) });
      const terminal = this.#sourceTerminal(binding);
      if (terminal) return Object.freeze({ kind: 'replay', operation: terminal });
      const now = this.#store.observedNow();
      const entry = this.#remember({ binding, status: 'final', generation: 1, observedAtMs: now, finishedAtMs: now,
        mergeWindowUntilMs: now + mergeWindowMsFor(binding), budgetCharged: false,
        resultCode: requiredToken(resultCode, 'resultCode', 64) });
      return Object.freeze({ kind: 'final', operation: volatileView(entry) });
    });
  }

  renew(operationId, generation, { leaseMs = DEFAULT_LEASE_MS } = {}) {
    this.assertUsable();
    if (!Number.isSafeInteger(leaseMs) || leaseMs < 0) fail('SIDE_EFFECT_BINDING_INVALID', 'leaseMs is invalid.');
    return this.#zeroWrite(() => {
      const entry = this.#activeClaim(operationId, generation, 'Claim generation is no longer current.');
      entry.leaseUntilMs = this.#store.observedNow() + leaseMs;
      return volatileView(entry);
    });
  }

  beginDispatch(input, generation) {
    this.assertUsable();
    const { binding, bindingJson } = bindingParts(input);
    const entry = this.#read(() => {
      const found = this.#existing(binding);
      const now = this.#store.observedNow();
      const claim = found?.entry;
      // The budget part of this fence is defense in depth, for every budget class alike. A charge is made
      // only by claim(), which counts everything already charged to the class and target (durable rows and
      // in-memory claims) before it takes one, and the windows only slide forward on a clock that never
      // goes back; so through this API a live claim of a budgeted binding is always charged and its
      // class's windows always hold when it begins. No sequence of calls of one ledger makes this part
      // refuse, which is why no test drives it; it stays so that the fence does not depend on that
      // argument for code added later.
      if (!claim || claim.status !== 'claimed' || claim.generation !== generation || claim.leaseUntilMs < now ||
          (binding.budgetClass !== 'none' && (!claim.budgetCharged ||
            !this.#budgetAllows(binding, now, false)))) {
        fail('SIDE_EFFECT_FENCE_REJECTED', 'Dispatch claim is stale or no longer within its reserved budget.');
      }
      return claim;
    });
    let record;
    try {
      record = this.#persist('begin-dispatch', () => this.#store.begin({
        purposeId: this.#purposeId,
        operationId: binding.operationId,
        sourceKey: binding.sourceKey,
        sourceTimeMs: binding.sourceTimeMs ?? null,
        bindingJson,
        bindingDigest: binding.bindingDigest,
        generation: entry.generation,
        target: binding.target,
        mergeKey: binding.mergeKey,
        mergeWindowUntilMs: entry.mergeWindowUntilMs ?? null,
        budgetCharged: entry.budgetCharged === true,
        budgetReservedAtMs: entry.budgetCharged === true ? entry.budgetReservedAtMs : null,
        claimedAtMs: entry.claimedAtMs,
      }));
    } catch (error) {
      // A begin refused only because the ledger is full wrote nothing and attempted
      // nothing; releasePreparation does not count it against this operation.
      if (error?.code === 'SIDE_EFFECT_CAPACITY_EXCEEDED') entry.capacityRefused = true;
      throw error;
    }
    this.#volatile.delete(binding.operationId);
    return durableView(record);
  }

  finish(operationId, generation, outcome, resultCode, result = undefined) {
    this.assertUsable();
    const state = typeof outcome === 'string' && Object.hasOwn(OUTCOME_STATES, outcome) ? OUTCOME_STATES[outcome] : null;
    if (!state) fail('SIDE_EFFECT_OUTCOME_INVALID', 'Terminal outcome is invalid.');
    const operation = this.#read(() => this.#durableRecord(String(operationId || '')));
    if (!operation || operation.state !== 'attempted' || operation.generation !== generation) {
      fail('SIDE_EFFECT_FENCE_REJECTED', 'Only the active attempted generation can finish.');
    }
    const normalizedCode = requiredToken(resultCode, 'resultCode', 64);
    let resultJson = null;
    if (result !== undefined) {
      resultJson = stableJson(result);
      if (Buffer.byteLength(resultJson) > MAX_RESULT_BYTES) {
        fail('SIDE_EFFECT_RESULT_TOO_LARGE', 'Operation result exceeds its fixed limit.');
      }
    }
    const record = this.#persist('finish', () => this.#store.finish({
      purposeId: this.#purposeId,
      operationId: operation.operationId,
      generation,
      state,
      resultCode: normalizedCode,
      resultJson,
    }));
    return durableView(record);
  }

  // Durably decides that an operation is never sent (LedgerStore.recordDecision): one
  // transaction writes it as attempted and settles it as not_sent, and the call returns
  // only after the commit and every witness write and fsync. Returns
  // { kind: 'recorded' | 'existing' | 'terminal', operation }:
  // - existing: the operation already has a durable row; nothing is written.
  // - terminal: its source is at or below the cutover or its watermark; nothing is written
  //   (operation is the computed final view).
  // A live in-memory claim of the same operation (lease not expired) is refused with
  // SIDE_EFFECT_FENCE_REJECTED; any other in-memory entry is superseded.
  recordNotSent(input, resultCode, result = undefined) {
    this.assertUsable();
    const { binding, bindingJson } = bindingParts(input);
    const normalizedCode = requiredToken(resultCode, 'resultCode', 64);
    let resultJson = null;
    if (result !== undefined) {
      resultJson = stableJson(result);
      if (Buffer.byteLength(resultJson) > MAX_RESULT_BYTES) {
        fail('SIDE_EFFECT_RESULT_TOO_LARGE', 'Operation result exceeds its fixed limit.');
      }
    }
    const prior = this.#read(() => {
      const found = this.#existing(binding);
      if (found?.durable) return Object.freeze({ kind: 'existing', operation: durableView(found.durable) });
      const now = this.#store.observedNow();
      const entry = found?.entry;
      if (entry?.status === 'claimed' && Number.isSafeInteger(entry.leaseUntilMs) && now < entry.leaseUntilMs) {
        fail('SIDE_EFFECT_FENCE_REJECTED', 'The operation is held by a live claim.');
      }
      const terminal = this.#sourceTerminal(binding);
      return terminal ? Object.freeze({ kind: 'terminal', operation: terminal }) : null;
    });
    if (prior) return prior;
    const claimedAtMs = this.#read(() => this.#store.observedNow());
    const outcome = this.#persist('record-not-sent', () => this.#store.recordDecision({
      purposeId: this.#purposeId,
      operationId: binding.operationId,
      sourceKey: binding.sourceKey,
      sourceTimeMs: binding.sourceTimeMs ?? null,
      bindingJson,
      bindingDigest: binding.bindingDigest,
      generation: this.#nextGeneration(),
      target: binding.target,
      mergeKey: binding.mergeKey,
      mergeWindowUntilMs: null,
      budgetCharged: false,
      budgetReservedAtMs: null,
      claimedAtMs,
      resultCode: normalizedCode,
      resultJson,
    }));
    if (outcome.kind === 'terminal') {
      return Object.freeze({ kind: 'terminal', operation: this.#read(() => this.#sourceTerminal(binding)) });
    }
    this.#volatile.delete(binding.operationId);
    return Object.freeze({ kind: outcome.kind, operation: durableView(outcome.operation) });
  }

  // Zero-write view of one operation: its durable row (basis 'durable'), the in-memory
  // decision of this process (basis 'volatile'), a terminal answer computed from the
  // cutover or the watermark (basis 'computed'; needs sourceKey and sourceTimeMs), or
  // absent.
  inspect(input = {}) {
    this.assertUsable();
    return this.#zeroWrite(() => {
      const operationId = requiredToken(input?.operationId, 'operationId');
      const durable = this.#durableRecord(operationId);
      if (durable) return Object.freeze({ kind: 'recorded', basis: 'durable', operation: durableView(durable) });
      const entry = this.#volatile.get(operationId);
      if (entry) return Object.freeze({ kind: 'volatile', basis: 'volatile', operation: volatileView(entry) });
      if (input.sourceTimeMs !== undefined && input.sourceTimeMs !== null) {
        if (!Number.isSafeInteger(input.sourceTimeMs) || input.sourceTimeMs < 0) {
          fail('SIDE_EFFECT_BINDING_INVALID', 'sourceTimeMs is invalid.');
        }
        const sourceKey = requiredText(input.sourceKey, 'sourceKey', MAX_SOURCE_KEY_LENGTH);
        const inspected = this.#store.inspectOperation({ purposeId: this.#purposeId, operationId, sourceKey,
          sourceTimeMs: input.sourceTimeMs });
        if (inspected.kind === 'terminal') {
          return Object.freeze({ kind: 'terminal', basis: 'computed', reason: inspected.reason,
            boundaryMs: inspected.boundaryMs,
            resultCode: inspected.reason === 'cutover' ? 'before_cutover' : 'source_watermark', operation: null });
        }
      }
      return Object.freeze({ kind: 'absent', basis: null, operation: null });
    });
  }

  // Zero-write count of this purpose's operations whose attempt started within the last
  // windowMs on the ledger clock (observedNow) and may have reached the network:
  // attempted, confirmed, unknown, and rejected. not_sent decisions never count.
  countAttempts({ windowMs } = {}) {
    this.assertUsable();
    if (!Number.isSafeInteger(windowMs) || windowMs < 1) fail('SIDE_EFFECT_BINDING_INVALID', 'windowMs is invalid.');
    return this.#zeroWrite(() => {
      const now = this.#store.observedNow();
      return this.#store.countAttemptsSince({ purposeId: this.#purposeId, sinceMs: Math.max(0, now - windowMs) });
    });
  }

  // Read the newest confirmed operation for one already-validated recipient source.  This
  // narrow lookup is used only to reuse a recently confirmed DM channel; it never exposes
  // a mutable store query or changes ledger state.
  findLatestConfirmedBySourceKey({ sourceKey, target, sinceMs } = {}) {
    this.assertUsable();
    const normalizedSourceKey = requiredText(sourceKey, 'sourceKey', MAX_SOURCE_KEY_LENGTH);
    const normalizedTarget = requiredText(target, 'target', MAX_SOURCE_KEY_LENGTH);
    if (!Number.isSafeInteger(sinceMs) || sinceMs < 0) {
      fail('SIDE_EFFECT_BINDING_INVALID', 'sinceMs is invalid.');
    }
    return this.#zeroWrite(() => {
      let latest = null;
      for (const record of this.#store.listOperations(this.#purposeId)) {
        if (record.state !== 'confirmed' || record.sourceKey !== normalizedSourceKey ||
            record.target !== normalizedTarget || record.finishedAtMs < sinceMs) continue;
        if (!latest || record.finishedAtMs > latest.finishedAtMs) latest = record;
      }
      return latest ? durableView(latest) : null;
    });
  }

  // Ends a claim that never began. The operation may be claimed again once
  // PREPARE_RETRY_AFTER_MS has passed, and the second counted failure settles it as final
  // (a dispatcher then treats it as terminal). A preparation whose begin was refused only
  // for capacity is not counted and keeps the code capacity_exceeded: nothing was
  // attempted, and a full ledger is not a property of this operation.
  //
  // options.counted === false releases without counting a failure (a deferral, such as a
  // rate cap, is not a preparation failure), and options.retryNotBeforeMs replaces the
  // default wait with an absolute ledger-clock time.
  releasePreparation(operationId, generation, resultCode = 'prepare_failed', options = {}) {
    this.assertUsable();
    const normalizedCode = requiredToken(resultCode, 'resultCode', 64);
    const { counted: countedOption, retryNotBeforeMs, maxFailures = MAX_PREPARE_FAILURES } = options || {};
    if (countedOption !== undefined && typeof countedOption !== 'boolean') {
      fail('SIDE_EFFECT_BINDING_INVALID', 'counted is invalid.');
    }
    if (retryNotBeforeMs !== undefined && retryNotBeforeMs !== null &&
        (!Number.isSafeInteger(retryNotBeforeMs) || retryNotBeforeMs < 0)) {
      fail('SIDE_EFFECT_BINDING_INVALID', 'retryNotBeforeMs is invalid.');
    }
    if (!Number.isSafeInteger(maxFailures) || maxFailures < 1 || maxFailures > 5) {
      fail('SIDE_EFFECT_BINDING_INVALID', 'maxFailures is invalid.');
    }
    return this.#zeroWrite(() => {
      const entry = this.#activeClaim(operationId, generation,
        'Only a non-attempted active claim can release preparation.');
      const capacityRefused = entry.capacityRefused === true;
      const counted = !capacityRefused && countedOption !== false;
      const failures = (entry.prepareFailures || 0) + (counted ? 1 : 0);
      const settled = failures >= maxFailures;
      const now = this.#store.observedNow();
      Object.assign(entry, {
        status: settled ? 'final' : 'prepare_failed', prepareFailures: failures,
        budgetCharged: false, leaseUntilMs: null, finishedAtMs: now,
        retryNotBeforeMs: settled ? null
          : (retryNotBeforeMs === undefined || retryNotBeforeMs === null ? now + PREPARE_RETRY_AFTER_MS : retryNotBeforeMs),
        capacityRefused: false,
        resultCode: capacityRefused ? 'capacity_exceeded' : normalizedCode,
      });
      return volatileView(entry);
    });
  }

  finalizeClaim(operationId, generation, resultCode = 'cancelled_before_dispatch') {
    this.assertUsable();
    return this.#zeroWrite(() => {
      const entry = this.#activeClaim(operationId, generation, 'Only a non-attempted active claim can be finalized.');
      Object.assign(entry, {
        status: 'final', budgetCharged: false, leaseUntilMs: null, finishedAtMs: this.#store.observedNow(),
        resultCode: requiredToken(resultCode, 'resultCode', 64),
      });
      return volatileView(entry);
    });
  }

  closeSource(_sourceKey, proof) {
    if (!proof?.permanent || !/^[a-f0-9]{64}$/u.test(proof?.trustedDigest || '')) {
      fail('SIDE_EFFECT_SOURCE_PROOF_REQUIRED', 'Permanent trusted source closure proof is required.');
    }
    fail('SIDE_EFFECT_COMPACTION_UNAVAILABLE', 'Format 2 compacts history only through retention watermarks.');
  }

  getOperation(operationId) {
    return this.#read(() => {
      const record = this.#durableRecord(String(operationId || ''));
      if (record) return durableView(record);
      const entry = this.#volatile.get(operationId);
      return entry ? volatileView(entry) : null;
    });
  }

  #readFence(guildId) {
    const fence = this.#read(() => this.#store.getReactionFence(this.#purposeId, guildId));
    return fence ? fenceView(fence) : null;
  }

  getReactionFence(guildId) {
    this.assertUsable();
    const normalizedGuildId = String(guildId || '').trim();
    if (!SNOWFLAKE.test(normalizedGuildId)) fail('SIDE_EFFECT_FENCE_INVALID', 'Guild ID is invalid.');
    return this.#readFence(normalizedGuildId);
  }

  openReactionFence(input, { adoptOnlyIfMissing = false } = {}) {
    this.assertUsable();
    const guildId = String(input?.guildId || '').trim();
    const current = SNOWFLAKE.test(guildId) ? this.#readFence(guildId) : null;
    if (adoptOnlyIfMissing && current) return Object.freeze({ kind: 'existing', fence: current });
    if (current?.open && current.channelId === String(input?.channelId || '').trim() &&
        current.sessionKey === String(input?.sessionKey || '').trim()) {
      return Object.freeze({ kind: 'existing', fence: current });
    }
    const generation = current ? current.generation + 1 : 1;
    const normalized = normalizeReactionFence(input, this.ledgerId, generation);
    let stored;
    try {
      stored = this.#persist('open-reaction-fence', () => this.#store.putReactionFence({
        purposeId: this.#purposeId,
        guildId: normalized.guildId,
        generation: normalized.fence.generation,
        open: true,
        channelId: normalized.fence.channelId,
        sessionKey: normalized.fence.sessionKey,
        sourceFence: normalized.fence.sourceFence,
        maxFences: MAX_REACTION_FENCES,
      }));
    } catch (error) {
      this.#quarantineAfterFenceFault(error);
      throw error;
    }
    return Object.freeze({ kind: 'opened', fence: fenceView(stored) });
  }

  closeReactionFence(guildId, expected = {}) {
    this.assertUsable();
    const normalizedGuildId = String(guildId || '').trim();
    if (!SNOWFLAKE.test(normalizedGuildId)) fail('SIDE_EFFECT_FENCE_INVALID', 'Guild ID is invalid.');
    const current = this.#readFence(normalizedGuildId);
    if (!current) return Object.freeze({ kind: 'missing', fence: null });
    if ((expected.generation !== undefined && current.generation !== expected.generation) ||
        (expected.channelId !== undefined && current.channelId !== expected.channelId)) {
      return Object.freeze({ kind: 'stale', fence: current });
    }
    if (!current.open) return Object.freeze({ kind: 'closed', fence: current });
    let stored;
    try {
      stored = this.#persist('close-reaction-fence', () => this.#store.closeReactionFence({
        purposeId: this.#purposeId, guildId: normalizedGuildId, generation: current.generation,
      }));
    } catch (error) {
      this.#quarantineAfterFenceFault(error);
      throw error;
    }
    return Object.freeze({ kind: 'closed', fence: fenceView(stored) });
  }

  verifyReactionFence(input) {
    this.assertUsable();
    const guildId = String(input?.guildId || '').trim();
    const current = SNOWFLAKE.test(guildId) ? this.#readFence(guildId) : null;
    if (!current || !current.open || current.generation !== input?.generation ||
        current.channelId !== String(input?.channelId || '').trim() ||
        current.sessionKey !== String(input?.sessionKey || '').trim() ||
        current.sourceFence !== String(input?.sourceFence || '').trim()) {
      return null;
    }
    return current;
  }

  // Identity fields are cached; operations and fences are read only when accessed.
  getSnapshotForTests() {
    const storeIdentity = this.#store.identity;
    const snapshot = {
      formatVersion: FORMAT_VERSION,
      ledgerId: storeIdentity.ledgerId,
      storeKind: storeIdentity.kind,
      purposeId: this.#purposeId,
      bootEpoch: storeIdentity.bootEpoch,
      beginSeq: storeIdentity.beginSeq,
      highWaterMs: storeIdentity.highWaterMs,
      cutoverMs: storeIdentity.cutoverMs,
    };
    Object.defineProperties(snapshot, {
      operations: {
        enumerable: true,
        get: () => this.#read(() => {
          const operations = {};
          for (const record of this.#store.listOperations(this.#purposeId)) {
            operations[record.operationId] = durableView(record);
          }
          for (const [operationId, entry] of this.#volatile) {
            if (!operations[operationId]) operations[operationId] = volatileView(entry);
          }
          return operations;
        }),
      },
      reactionFences: {
        enumerable: true,
        get: () => this.#read(() => Object.fromEntries(this.#store.listReactionFences(this.#purposeId)
          .map((fence) => [fence.guildId, fenceView(fence)]))),
      },
    });
    return snapshot;
  }

  close({ retainLock = false } = {}) {
    if (this.#closed) return;
    this.#closed = true;
    if (retainLock || this.#quarantined) {
      this.#quarantined = true;
      this.#quarantineReason ||= 'retained-by-runtime';
      // Backup write, made while the database lock is still held. close() must still
      // release everything, so a failure here is logged and recorded in
      // quarantineFailure (by #writeQuarantineRecords) instead of being thrown.
      try {
        const missing = this.#quarantineTargets().some(([, filePath]) => !lstat(filePath));
        if (!this.#quarantineWritten || missing) this.#writeQuarantineRecords();
      } catch {}
      // The registration flag gets one more (asynchronous) attempt if the first failed.
      this.#retryQuarantineFlag();
    }
    this.#volatile.clear();
    try { this.#releasePurpose(); } catch {}
    if (this.#ownsStore) this.#store.close();
  }
}

// Fault injection exists for tests only; outside the Node test runner it is refused
// before any ledger file is touched (store code LEDGER_INPUT_INVALID).
function normalizeFacadeFaultInjector(faultInjector) {
  if (faultInjector === null || faultInjector === undefined) return null;
  if (typeof faultInjector !== 'function') fail('SIDE_EFFECT_CONFIGURATION_INVALID', 'faultInjector is invalid.');
  withStoreErrors(() => assertTestOnlyOption('faultInjector'));
  return faultInjector;
}

function storeFaultBridge(faultInjector) {
  if (!faultInjector) return null;
  return ({ label, phase }) => faultInjector({
    label: STORE_FAULT_LABELS[label] || label,
    phase: phase === 'before-witness-write' ? 'before-continuity-witness-write' : phase,
  });
}

function ledgerTargets(locations) {
  return [locations.ledgerPath, locations.walPath, locations.shmPath, locations.journalPath,
    locations.anchorPath, locations.receiptPath, locations.retainedLockPath];
}

function assertTargetsAbsent(candidates) {
  for (const candidate of candidates) {
    if (lstat(candidate)) fail('SIDE_EFFECT_INITIALIZATION_CONFLICT', 'Ledger initialization requires every target to be absent.');
  }
}

function writeReceiptFile(receiptPath, receipt) {
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  writeNewDurableFile(receiptPath, receiptBytes);
  return digest(receiptBytes);
}

function stagedPathOf(finalPath) {
  return `${finalPath}${STAGING_SUFFIX}`;
}

// UNC and device paths, including mixed-separator forms that only become one after
// resolution, are refused before any file is touched: their locks and fsync cannot be
// trusted.
function assertLocalPaths(...values) {
  for (const value of values) {
    if (typeof value === 'string' && isRemotePath(value)) fail('SIDE_EFFECT_PATH_REMOTE', 'Ledger paths must be local.');
  }
}

// The quarantine stamp kept beside a ledger's external continuity witness.
function quarantineStampPathFor(witnessPath) {
  return `${path.resolve(witnessPath)}${QUARANTINE_STAMP_SUFFIX}`;
}

// The real path a file has, or will have once created: its directory resolved, plus its
// name. Ledger directories are checked to contain no link, so this is exact.
function realPathOfTarget(filePath) {
  return path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
}

// Where a new ledger's files are first written: the final paths, or with staging the same
// names plus ".creating". The staged database's WAL, SHM, and journal follow its name.
function creationTargets(locations, witnessPath, staging) {
  if (!staging) {
    return Object.freeze({ databasePath: locations.ledgerPath, anchorPath: locations.anchorPath,
      witnessPath, receiptPath: locations.receiptPath });
  }
  return Object.freeze({ databasePath: stagedPathOf(locations.ledgerPath), anchorPath: stagedPathOf(locations.anchorPath),
    witnessPath: witnessPath ? stagedPathOf(witnessPath) : null, receiptPath: stagedPathOf(locations.receiptPath) });
}

function stagedLocations(targets) {
  const store = storeLocations(targets.databasePath);
  return Object.freeze({
    ledgerPath: targets.databasePath,
    walPath: store.walPath,
    shmPath: store.shmPath,
    journalPath: store.journalPath,
    anchorPath: targets.anchorPath,
    receiptPath: targets.receiptPath,
    witnessPath: targets.witnessPath,
  });
}

function normalizeGenesis(genesisMs, now) {
  if (genesisMs === undefined || genesisMs === null) return safeNow(now);
  if (!Number.isSafeInteger(genesisMs) || genesisMs < 0) fail('SIDE_EFFECT_CONFIGURATION_INVALID', 'genesisMs is invalid.');
  return genesisMs;
}

function normalizeCreatedBy(value) {
  if (value === undefined || value === null) return null;
  if (value !== CREATED_BY_BOOTSTRAP) fail('SIDE_EFFECT_CONFIGURATION_INVALID', 'createdBy is invalid.');
  return value;
}

// Every target of a new ledger (final, and staged when staging) must be absent.
function creationConflicts(locations, witnessPath, staging) {
  const finals = [...ledgerTargets(locations)];
  if (witnessPath) finals.push(witnessPath, quarantineStampPathFor(witnessPath));
  if (!staging) return finals;
  const staged = stagedLocations(creationTargets(locations, witnessPath, true));
  return [...finals, staged.ledgerPath, staged.walPath, staged.shmPath, staged.journalPath, staged.anchorPath,
    staged.receiptPath, ...(staged.witnessPath ? [staged.witnessPath] : [])];
}

// Creates the database and its witnesses (at the creation targets), then the receipt. The
// receipt always names the final paths; buildReceipt receives their descriptions.
function createLedgerFiles({ kind, locations, witnessPath, staging, identityFields, faultInjector, buildReceipt }) {
  const targets = creationTargets(locations, witnessPath, staging);
  withStoreErrors(() => createLedgerStore({
    filePath: targets.databasePath,
    witnessPaths: targets.witnessPath ? [targets.anchorPath, targets.witnessPath] : [targets.anchorPath],
    kind,
    ...identityFields,
    faultInjector: storeFaultBridge(faultInjector),
  }));
  const files = {
    ledger: { filePath: locations.ledgerPath, realPath: realPathOfTarget(locations.ledgerPath) },
    anchor: {
      filePath: locations.anchorPath,
      realPath: realPathOfTarget(locations.anchorPath),
      initialSha256: digest(fs.readFileSync(targets.anchorPath)),
    },
  };
  if (witnessPath) {
    files.continuityWitness = {
      filePath: witnessPath,
      realPath: realPathOfTarget(witnessPath),
      initialSha256: digest(fs.readFileSync(targets.witnessPath)),
    };
  }
  if (faultInjector) faultInjector({ label: 'create-ledger', phase: 'before-receipt-write' });
  const receiptSha256 = writeReceiptFile(targets.receiptPath, buildReceipt(files));
  return Object.freeze({ targets, receiptSha256 });
}

// Creates an Owner ledger. continuityWitnessPath adds an external witness in a separate
// directory (the bootstrap always passes one). staging writes every file under its
// ".creating" name for commitStagedLedger; genesisMs pins the genesis (a resumed creation
// must reuse the registered one); createdBy 'bootstrap' marks the receipt.
function initializeSideEffectLedger({ filePath, ledgerId, initializationId, notificationIdentity,
  now = () => Date.now(), runtimeMode = 'production', continuityWitnessPath = null, staging = false,
  genesisMs = undefined, createdBy = undefined, faultInjector = null } = {}) {
  assertLocalPaths(filePath, continuityWitnessPath);
  if (!path.isAbsolute(String(filePath || ''))) fail('SIDE_EFFECT_PATH_INVALID', 'Ledger path must be absolute.');
  if (continuityWitnessPath !== null && continuityWitnessPath !== undefined &&
      !path.isAbsolute(String(continuityWitnessPath))) {
    fail('SIDE_EFFECT_PATH_INVALID', 'The external continuity witness path must be absolute.');
  }
  const injector = normalizeFacadeFaultInjector(faultInjector);
  const locations = pathsFor(filePath);
  const witnessPath = continuityWitnessPath ? path.resolve(continuityWitnessPath) : null;
  if (witnessPath && identity(path.dirname(witnessPath)) === identity(path.dirname(locations.ledgerPath))) {
    fail('SIDE_EFFECT_PATH_INVALID', 'The continuity witness must use a separate protected directory.');
  }
  assertTargetsAbsent(witnessPath || staging ? creationConflicts(locations, witnessPath, staging)
    : ledgerTargets(locations));
  const normalizedLedgerId = requiredToken(ledgerId, 'ledgerId', 128);
  const proof = requiredText(initializationId, 'initializationId', 1_024);
  const fixedIdentity = normalizeNotificationIdentity(notificationIdentity);
  const mode = normalizeRuntimeMode(runtimeMode);
  const initializedAtMs = normalizeGenesis(genesisMs, now);
  const marker = normalizeCreatedBy(createdBy);
  const created = createLedgerFiles({
    kind: 'owner',
    locations,
    witnessPath,
    staging: staging === true,
    identityFields: { ledgerId: normalizedLedgerId, botId: fixedIdentity.botId, ownerId: fixedIdentity.ownerId,
      runtimeMode: mode, genesisMs: initializedAtMs, cutoverMs: 0 },
    faultInjector: injector,
    buildReceipt: (files) => ({
      formatVersion: FORMAT_VERSION,
      ledgerKind: 'owner-safety',
      storeKind: 'owner',
      state: 'fresh',
      ledgerId: normalizedLedgerId,
      runtimeMode: mode,
      initializationProofDigest: digest(proof),
      notificationIdentity: fixedIdentity,
      initializedAtMs,
      ...files,
      ...(marker ? { createdBy: marker } : {}),
    }),
  });
  const result = { ...locations, ledgerId: normalizedLedgerId, receiptSha256: created.receiptSha256 };
  if (witnessPath) result.witnessPath = witnessPath;
  if (staging === true) {
    result.staging = true;
    result.staged = stagedLocations(created.targets);
  }
  return Object.freeze(result);
}

function initializePublicPurposeLedger({ filePath, continuityWitnessPath, ledgerId, initializationId, purposeIdentity,
  now = () => Date.now(), runtimeMode = 'production', staging = false, genesisMs = undefined, createdBy = undefined,
  faultInjector = null } = {}) {
  assertLocalPaths(filePath, continuityWitnessPath);
  if (!path.isAbsolute(String(filePath || '')) || !path.isAbsolute(String(continuityWitnessPath || ''))) {
    fail('SIDE_EFFECT_PATH_INVALID', 'Ledger and external continuity witness paths must be absolute.');
  }
  const injector = normalizeFacadeFaultInjector(faultInjector);
  const locations = pathsFor(filePath);
  const witnessPath = path.resolve(continuityWitnessPath);
  if (identity(path.dirname(witnessPath)) === identity(path.dirname(locations.ledgerPath))) {
    fail('SIDE_EFFECT_PATH_INVALID', 'The continuity witness must use a separate protected directory.');
  }
  assertTargetsAbsent(staging ? creationConflicts(locations, witnessPath, true) : [...ledgerTargets(locations), witnessPath]);
  const normalizedLedgerId = requiredToken(ledgerId, 'ledgerId', 128);
  const proof = requiredText(initializationId, 'initializationId', 1_024);
  const fixedPurpose = normalizePublicPurposeIdentity(purposeIdentity);
  const cutoverMs = fixedPurpose[PUBLIC_PURPOSES[fixedPurpose.purposeId].cutoverField];
  const mode = normalizeRuntimeMode(runtimeMode);
  const initializedAtMs = normalizeGenesis(genesisMs, now);
  const marker = normalizeCreatedBy(createdBy);
  const created = createLedgerFiles({
    kind: 'public',
    locations,
    witnessPath,
    staging: staging === true,
    identityFields: { ledgerId: normalizedLedgerId, botId: fixedPurpose.botId, ownerId: null, runtimeMode: mode,
      genesisMs: initializedAtMs, cutoverMs },
    faultInjector: injector,
    buildReceipt: (files) => ({
      formatVersion: FORMAT_VERSION,
      ledgerKind: 'public-purpose',
      storeKind: 'public',
      state: 'fresh',
      ledgerId: normalizedLedgerId,
      runtimeMode: mode,
      initializationProofDigest: digest(proof),
      purposeIdentity: fixedPurpose,
      initializedAtMs,
      ...files,
      ...(marker ? { createdBy: marker } : {}),
    }),
  });
  const result = {
    ...locations,
    ledgerKind: 'public-purpose',
    ledgerId: normalizedLedgerId,
    purposeIdentity: fixedPurpose,
    witnessPath,
    receiptSha256: created.receiptSha256,
  };
  if (staging === true) {
    result.staging = true;
    result.staged = stagedLocations(created.targets);
  }
  return Object.freeze(result);
}

// Best effort on Windows, where a directory cannot be flushed: flushing the renamed file
// itself asks NTFS to persist its metadata. Errors are ignored. Only ever used on a ledger
// database before anything in this process opened it with SQLite.
function flushFileBestEffort(filePath) {
  let descriptor;
  try {
    descriptor = fs.openSync(filePath, 'r+');
    fs.fsyncSync(descriptor);
  } catch {
    // Best effort only.
  } finally {
    if (descriptor !== undefined) { try { fs.closeSync(descriptor); } catch {} }
  }
}

// Publishes a staged ledger. The staged database must have closed cleanly (no WAL, SHM, or
// journal beside it). The anchor, the external witness, and the receipt are renamed
// first, and their renames are made durable (both directories flushed on POSIX; on
// Windows, where a directory cannot be flushed, each renamed file is flushed as a best
// effort) before the database is renamed last. The database rename is the commit point:
// a crash or power loss before it leaves no final database, and after it the companions
// are already in place, even when the witness directory is on another volume. The
// ledger directory (POSIX) or the new database file (Windows) is flushed afterwards. The
// test-only faultInjector is called with label 'commit-staged-ledger' and phases
// before-rename-<file>, after-flush-companions, and after-rename-database.
async function commitStagedLedger(initialized, { faultInjector = null } = {}) {
  const injector = normalizeFacadeFaultInjector(faultInjector);
  const staged = initialized?.staged;
  if (initialized?.staging !== true || !staged) {
    fail('SIDE_EFFECT_CONFIGURATION_INVALID', 'Only a staged ledger can be committed.');
  }
  const final = pathsFor(initialized.ledgerPath);
  const witnessFinal = initialized.witnessPath ? path.resolve(initialized.witnessPath) : null;
  const inject = (phase) => { if (injector) injector({ label: 'commit-staged-ledger', phase }); };
  for (const leftover of [staged.walPath, staged.shmPath, staged.journalPath]) {
    if (lstat(leftover)) fail('SIDE_EFFECT_STAGING_INCOMPLETE', 'The staged ledger database was not closed cleanly.');
  }
  const companions = [['anchor', staged.anchorPath, final.anchorPath]];
  if (witnessFinal) companions.push(['witness', staged.witnessPath, witnessFinal]);
  companions.push(['receipt', staged.receiptPath, final.receiptPath]);
  const database = ['database', staged.ledgerPath, final.ledgerPath];
  for (const [, from] of [...companions, database]) {
    if (!lstat(from)) fail('SIDE_EFFECT_STAGING_INCOMPLETE', 'A staged ledger file is missing.');
  }
  assertTargetsAbsent([...ledgerTargets(final), ...(witnessFinal ? [witnessFinal] : [])]);
  const renameStaged = async ([role, from, to]) => {
    inject(`before-rename-${role}`);
    if (lstat(to)) fail('SIDE_EFFECT_INITIALIZATION_CONFLICT', 'A ledger target appeared during commit.');
    try {
      await renameWithRetry(from, to);
    } catch (error) {
      fail('SIDE_EFFECT_PERSIST_FAILED', 'A staged ledger file could not be renamed.', { cause: error });
    }
  };
  const flushDirectories = (directories) => {
    try {
      for (const directory of directories) fsyncDirectory(directory);
    } catch (error) {
      fail('SIDE_EFFECT_PERSIST_FAILED', 'A ledger directory could not be flushed.', { cause: error });
    }
  };
  for (const step of companions) await renameStaged(step);
  flushDirectories([...(witnessFinal ? [path.dirname(witnessFinal)] : []), path.dirname(final.ledgerPath)]);
  if (process.platform === 'win32') for (const [, , to] of companions) flushFileBestEffort(to);
  inject('after-flush-companions');
  await renameStaged(database);
  inject('after-rename-database');
  flushDirectories([path.dirname(final.ledgerPath)]);
  if (process.platform === 'win32') flushFileBestEffort(final.ledgerPath);
  for (const leftover of [final.walPath, final.shmPath, final.journalPath]) {
    if (lstat(leftover)) fail('SIDE_EFFECT_STAGING_INCOMPLETE', 'A database companion file appeared during commit.');
  }
  return Object.freeze({ ...final, ledgerId: initialized.ledgerId, receiptSha256: initialized.receiptSha256,
    witnessPath: witnessFinal });
}

function readProvenance({ filePath, expectedReceiptSha256 }) {
  assertLocalPaths(filePath);
  if (!path.isAbsolute(String(filePath || '')) || !/^[a-f0-9]{64}$/u.test(expectedReceiptSha256 || '')) {
    fail('SIDE_EFFECT_CONFIGURATION_INVALID', 'Ledger path and independently saved provenance SHA-256 are required.');
  }
  const locations = pathsFor(filePath);
  if (lstat(locations.retainedLockPath)) {
    fail('SIDE_EFFECT_LEDGER_QUARANTINED', 'Ledger was retained after a fault and requires manual review.');
  }
  const receiptRead = readBoundedRegularFile(locations.receiptPath, MAX_RECEIPT_BYTES);
  if (digest(receiptRead.bytes) !== expectedReceiptSha256) {
    fail('SIDE_EFFECT_PROVENANCE_MISMATCH', 'Ledger provenance differs from the trusted digest.');
  }
  return Object.freeze({
    locations,
    receipt: parseJson(receiptRead.bytes, 'SIDE_EFFECT_PROVENANCE_INVALID'),
  });
}

function validateCommonReceipt(receipt, locations, storeKind) {
  if (receipt?.formatVersion !== FORMAT_VERSION || receipt.state !== 'fresh' || receipt.storeKind !== storeKind ||
      !RUNTIME_MODES.includes(receipt.runtimeMode) || !SAFE_TOKEN.test(receipt.ledgerId || '') ||
      identity(receipt.ledger?.filePath || '') !== identity(locations.ledgerPath) ||
      identity(receipt.anchor?.filePath || '') !== identity(locations.anchorPath) ||
      !/^[a-f0-9]{64}$/u.test(receipt.anchor?.initialSha256 || '')) {
    fail('SIDE_EFFECT_PROVENANCE_INVALID', 'Ledger provenance does not bind this format and path.');
  }
}

function openFacade({ locations, kind, purposeId, witnessPaths, expected, provenance, continuityWitness,
  now, faultInjector, logger, onQuarantine = null }) {
  const store = withStoreErrors(() => openLedgerStore({
    filePath: locations.ledgerPath,
    witnessPaths,
    kind,
    expected,
    now,
    faultInjector: storeFaultBridge(faultInjector),
    logger,
  }));
  try {
    return new SideEffectLedger({ store, purposeId, locations, provenance, continuityWitness, faultInjector, logger,
      quarantineStampPath: continuityWitness ? quarantineStampPathFor(continuityWitness.filePath) : null, onQuarantine });
  } catch (error) {
    store.close();
    throw error;
  }
}

// The external continuity witness named by a receipt: an absolute path in a directory of
// its own, with its real path and initial digest recorded. Its quarantine stamp blocks the
// open just like the marker beside the ledger.
function receiptContinuityWitness(receipt, locations, message) {
  const witnessPath = String(receipt.continuityWitness?.filePath || '');
  assertLocalPaths(witnessPath);
  if (!path.isAbsolute(witnessPath)) fail('SIDE_EFFECT_PROVENANCE_INVALID', message);
  const continuityWitness = Object.freeze({ filePath: path.resolve(witnessPath) });
  if (identity(receipt.continuityWitness?.realPath || '') !== identity(continuityWitness.filePath) ||
      !/^[a-f0-9]{64}$/u.test(receipt.continuityWitness?.initialSha256 || '') ||
      identity(path.dirname(continuityWitness.filePath)) === identity(path.dirname(locations.ledgerPath))) {
    fail('SIDE_EFFECT_PROVENANCE_INVALID', message);
  }
  if (lstat(quarantineStampPathFor(continuityWitness.filePath))) {
    fail('SIDE_EFFECT_LEDGER_QUARANTINED', 'Ledger was quarantined after a fault and requires manual review.');
  }
  return continuityWitness;
}

function openSideEffectLedger({ filePath, expectedReceiptSha256, expectedIdentity,
  now = () => Date.now(), faultInjector = null, logger = null } = {}) {
  const injector = normalizeFacadeFaultInjector(faultInjector);
  const { locations, receipt } = readProvenance({ filePath, expectedReceiptSha256 });
  const fixedIdentity = normalizeNotificationIdentity(expectedIdentity);
  if (receipt?.ledgerKind !== 'owner-safety' || receipt.purposeIdentity !== undefined ||
      receipt.notificationIdentity?.botId !== fixedIdentity.botId ||
      receipt.notificationIdentity?.ownerId !== fixedIdentity.ownerId) {
    fail('SIDE_EFFECT_PROVENANCE_INVALID', 'Ledger provenance does not bind this Owner identity.');
  }
  validateCommonReceipt(receipt, locations, 'owner');
  // Owner ledgers created with an external witness (the bootstrap) must be opened with it.
  const continuityWitness = receipt.continuityWitness === undefined ? null
    : receiptContinuityWitness(receipt, locations, 'Owner continuity witness path is invalid.');
  return openFacade({
    locations,
    kind: 'owner',
    purposeId: OWNER_PURPOSE_ID,
    witnessPaths: continuityWitness ? [locations.anchorPath, continuityWitness.filePath] : [locations.anchorPath],
    expected: { ledgerId: receipt.ledgerId, botId: fixedIdentity.botId, ownerId: fixedIdentity.ownerId,
      runtimeMode: receipt.runtimeMode, cutoverMs: 0 },
    provenance: { ledgerKind: 'owner-safety', notificationIdentity: fixedIdentity },
    continuityWitness,
    now,
    faultInjector: injector,
    logger,
  });
}

function openPublicPurposeLedger({ filePath, expectedReceiptSha256, expectedPurposeIdentity,
  now = () => Date.now(), faultInjector = null, logger = null } = {}) {
  const injector = normalizeFacadeFaultInjector(faultInjector);
  const { locations, receipt } = readProvenance({ filePath, expectedReceiptSha256 });
  validateCommonReceipt(receipt, locations, 'public');
  const expectedPurpose = normalizePublicPurposeExpectation(expectedPurposeIdentity);
  const fixedPurpose = normalizePublicPurposeIdentity(receipt.purposeIdentity);
  const witnessPath = String(receipt.continuityWitness?.filePath || '');
  assertLocalPaths(witnessPath);
  if (!path.isAbsolute(witnessPath)) {
    fail('SIDE_EFFECT_PROVENANCE_INVALID', 'Public-purpose continuity witness path is invalid.');
  }
  const continuityWitness = Object.freeze({ filePath: path.resolve(witnessPath) });
  if (receipt.ledgerKind !== 'public-purpose' || receipt.notificationIdentity !== undefined ||
      fixedPurpose.purposeId !== expectedPurpose.purposeId ||
      fixedPurpose.botId !== expectedPurpose.botId ||
      fixedPurpose.sourceNamespace !== expectedPurpose.sourceNamespace ||
      identity(receipt.continuityWitness?.realPath || '') !== identity(continuityWitness.filePath) ||
      !/^[a-f0-9]{64}$/u.test(receipt.continuityWitness?.initialSha256 || '') ||
      identity(path.dirname(continuityWitness.filePath)) === identity(path.dirname(locations.ledgerPath))) {
    fail('SIDE_EFFECT_PROVENANCE_INVALID', 'Ledger provenance does not bind this public purpose.');
  }
  if (lstat(quarantineStampPathFor(continuityWitness.filePath))) {
    fail('SIDE_EFFECT_LEDGER_QUARANTINED', 'Ledger was quarantined after a fault and requires manual review.');
  }
  return openFacade({
    locations,
    kind: 'public',
    purposeId: fixedPurpose.purposeId,
    witnessPaths: [locations.anchorPath, continuityWitness.filePath],
    expected: { ledgerId: receipt.ledgerId, botId: fixedPurpose.botId, ownerId: null,
      runtimeMode: receipt.runtimeMode,
      cutoverMs: fixedPurpose[PUBLIC_PURPOSES[fixedPurpose.purposeId].cutoverField] },
    provenance: { ledgerKind: 'public-purpose', purposeIdentity: fixedPurpose },
    continuityWitness,
    now,
    faultInjector: injector,
    logger,
  });
}

function normalizeRegisteredPaths(paths) {
  const resolved = {};
  for (const role of ['database', 'anchor', 'witness', 'receipt']) {
    const value = String(paths?.[role] || '');
    assertLocalPaths(value);
    if (!path.isAbsolute(value)) fail('SIDE_EFFECT_PATH_INVALID', `The registered ${role} path must be absolute.`);
    resolved[role] = path.resolve(value);
  }
  return Object.freeze(resolved);
}

function normalizeRegisteredExpectation(kind, expected) {
  const botId = String(expected?.botId || '');
  const ownerId = expected?.ownerId === undefined || expected?.ownerId === null ? null : String(expected.ownerId);
  const notBefore = expected?.notBefore === undefined || expected?.notBefore === null ? null : expected.notBefore;
  if (!SAFE_TOKEN.test(String(expected?.ledgerId || '')) || !SNOWFLAKE.test(botId) ||
      (kind === 'owner' ? !SNOWFLAKE.test(ownerId || '') || ownerId === botId : ownerId !== null) ||
      !RUNTIME_MODES.includes(expected?.runtimeMode) ||
      !Number.isSafeInteger(expected?.genesisMs) || expected.genesisMs < 0 ||
      !Number.isSafeInteger(expected?.cutoverMs) || expected.cutoverMs < 0) {
    fail('SIDE_EFFECT_CONFIGURATION_INVALID', 'The registered ledger identity is incomplete.');
  }
  return Object.freeze({ ledgerId: expected.ledgerId, botId, ownerId, runtimeMode: expected.runtimeMode,
    genesisMs: expected.genesisMs, cutoverMs: expected.cutoverMs, notBefore });
}

// Compares a receipt with the registration that names it. Each identity field that
// differs is SIDE_EFFECT_IDENTITY_MISMATCH with a fixed reason (kind, ledger-id, purpose,
// bot, owner, runtime-mode, genesis, cutover); a receipt that does not have the expected
// shape or does not name the registered paths is SIDE_EFFECT_PROVENANCE_INVALID.
function validateRegisteredReceipt(receipt, { kind, purposeId, locations, witnessPath, expected }) {
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) || receipt.formatVersion !== FORMAT_VERSION ||
      receipt.state !== 'fresh') {
    fail('SIDE_EFFECT_PROVENANCE_INVALID', 'Ledger provenance has an unexpected format.');
  }
  const mismatch = (reason) => failWithReason('SIDE_EFFECT_IDENTITY_MISMATCH',
    'Ledger provenance does not match its registration.', reason);
  if (receipt.storeKind !== kind || receipt.ledgerKind !== (kind === 'owner' ? 'owner-safety' : 'public-purpose')) {
    mismatch('kind');
  }
  if (receipt.ledgerId !== expected.ledgerId) mismatch('ledger-id');
  let cutoverMs;
  if (kind === 'owner') {
    if (receipt.purposeIdentity !== undefined || purposeId !== OWNER_PURPOSE_ID) mismatch('purpose');
    if (receipt.notificationIdentity?.botId !== expected.botId) mismatch('bot');
    if (receipt.notificationIdentity?.ownerId !== expected.ownerId) mismatch('owner');
    cutoverMs = 0;
  } else {
    if (receipt.notificationIdentity !== undefined) mismatch('owner');
    let fixedPurpose;
    try {
      fixedPurpose = normalizePublicPurposeIdentity(receipt.purposeIdentity);
    } catch {
      fail('SIDE_EFFECT_PROVENANCE_INVALID', 'Ledger provenance has no valid purpose identity.');
    }
    if (fixedPurpose.purposeId !== purposeId) mismatch('purpose');
    if (fixedPurpose.botId !== expected.botId) mismatch('bot');
    cutoverMs = fixedPurpose[PUBLIC_PURPOSES[purposeId].cutoverField];
  }
  if (receipt.runtimeMode !== expected.runtimeMode) mismatch('runtime-mode');
  if (receipt.initializedAtMs !== expected.genesisMs) mismatch('genesis');
  if (cutoverMs !== expected.cutoverMs) mismatch('cutover');
  validateCommonReceipt(receipt, locations, kind);
  if (identity(receipt.continuityWitness?.filePath || '') !== identity(witnessPath)) {
    fail('SIDE_EFFECT_PROVENANCE_INVALID', 'Ledger provenance does not name the registered witness.');
  }
  return kind === 'owner'
    ? Object.freeze({ ledgerKind: 'owner-safety',
      notificationIdentity: Object.freeze({ botId: expected.botId, ownerId: expected.ownerId }) })
    : Object.freeze({ ledgerKind: 'public-purpose', purposeIdentity: normalizePublicPurposeIdentity(receipt.purposeIdentity) });
}

// Opens a ledger from its coin database registration instead of environment variables:
// the registered paths, the registered receipt SHA-256, the registered identity (ledger
// ID, bot, Owner, runtime mode, genesis, cutover), and the last recorded counters
// (notBefore, the registration's lastSeen). Checks run in this order: paths, quarantine
// marker and stamp, receipt digest and content, then the store's identity, witness
// continuity, and notBefore comparison. The returned facade has the same shape as one
// opened through openSideEffectLedger or openPublicPurposeLedger, plus the onQuarantine
// hook, which records a quarantine in the registration.
function openRegisteredLedger({ purposeId, kind, paths, receiptSha256, expected, now = () => Date.now(),
  faultInjector = null, logger = null, onQuarantine = null } = {}) {
  const injector = normalizeFacadeFaultInjector(faultInjector);
  if (kind !== 'owner' && kind !== 'public') fail('SIDE_EFFECT_CONFIGURATION_INVALID', 'Ledger kind is invalid.');
  const purpose = requiredToken(purposeId, 'purposeId', 64);
  if (kind === 'owner' ? purpose !== OWNER_PURPOSE_ID : !PUBLIC_PURPOSES[purpose]) {
    fail('SIDE_EFFECT_PURPOSE_IDENTITY_INVALID', 'The registered purpose is not a known ledger purpose.');
  }
  if (!/^[a-f0-9]{64}$/u.test(receiptSha256 || '')) {
    fail('SIDE_EFFECT_CONFIGURATION_INVALID', 'The registered receipt SHA-256 is invalid.');
  }
  const registered = normalizeRegisteredPaths(paths);
  const expectation = normalizeRegisteredExpectation(kind, expected);
  const locations = pathsFor(registered.database);
  if (identity(locations.anchorPath) !== identity(registered.anchor) ||
      identity(locations.receiptPath) !== identity(registered.receipt) ||
      identity(path.dirname(registered.witness)) === identity(path.dirname(locations.ledgerPath))) {
    fail('SIDE_EFFECT_PATH_INVALID', 'The registered paths do not follow the ledger layout.');
  }
  const stampPath = quarantineStampPathFor(registered.witness);
  if (lstat(locations.retainedLockPath) || lstat(stampPath)) {
    fail('SIDE_EFFECT_LEDGER_QUARANTINED', 'Ledger was quarantined after a fault and requires manual review.');
  }
  const receiptRead = readBoundedRegularFile(locations.receiptPath, MAX_RECEIPT_BYTES);
  if (digest(receiptRead.bytes) !== receiptSha256) {
    fail('SIDE_EFFECT_PROVENANCE_MISMATCH', 'Ledger provenance differs from its registration.');
  }
  const receipt = parseJson(receiptRead.bytes, 'SIDE_EFFECT_PROVENANCE_INVALID');
  const provenance = validateRegisteredReceipt(receipt, { kind, purposeId: purpose, locations,
    witnessPath: registered.witness, expected: expectation });
  return openFacade({
    locations,
    kind,
    purposeId: purpose,
    witnessPaths: [locations.anchorPath, registered.witness],
    expected: { ledgerId: expectation.ledgerId, botId: expectation.botId, ownerId: expectation.ownerId,
      runtimeMode: expectation.runtimeMode, cutoverMs: expectation.cutoverMs, genesisMs: expectation.genesisMs,
      notBefore: expectation.notBefore },
    provenance,
    continuityWitness: Object.freeze({ filePath: registered.witness }),
    now,
    faultInjector: injector,
    logger,
    onQuarantine,
  });
}

module.exports = {
  BUDGET_WINDOWS,
  CREATED_BY_BOOTSTRAP,
  DEFAULT_LEASE_MS,
  FORMAT_VERSION,
  MAX_BINDING_BYTES,
  MAX_LEDGER_BYTES,
  MAX_RESULT_BYTES,
  MAX_REACTION_FENCES,
  MAX_REACTION_FENCE_BYTES,
  MAX_SOURCE_KEY_LENGTH,
  MAX_VOLATILE_OPERATIONS,
  MAX_PREPARE_FAILURES,
  MERGE_WINDOW_MS,
  OWNER_MERGE_WINDOWS_MS,
  OWNER_BUDGET_POLICIES,
  OWNER_BUDGET_TARGET_SUFFIXES,
  OWNER_PURPOSE_ID,
  PREPARE_RETRY_AFTER_MS,
  PUBLIC_PURPOSES,
  QUARANTINE_STAMP_SUFFIX,
  STAGING_SUFFIX,
  STALE_CLAIM_AFTER_MS,
  SideEffectLedgerError,
  commitStagedLedger,
  initializePublicPurposeLedger,
  initializeSideEffectLedger,
  normalizeBinding,
  normalizeNotificationIdentity,
  normalizePublicPurposeIdentity,
  normalizePublicPurposeExpectation,
  openPublicPurposeLedger,
  openRegisteredLedger,
  openSideEffectLedger,
  pathsFor,
  quarantineStampPathFor,
  stagedPathOf,
};
