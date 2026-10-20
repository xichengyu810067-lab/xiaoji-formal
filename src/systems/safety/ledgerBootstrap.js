'use strict';

/*
 * Automatic creation and three-way checking of the side-effect ledgers.
 *
 * Three independent records must agree for each protected purpose: the ledger files
 * (database, anchor witness, receipt), the external continuity witness, and the coin
 * database registration (coin_metadata safety_ledger:<purposeId>, see ledgerLayout.js).
 * A ledger is created only when all three are absent; every other inconsistency fails
 * that purpose closed (it stays disabled) and never touches another purpose.
 *
 * Decision order for each purpose:
 *   1. XIAOJI_PROTECTED_EFFECTS=off  -> LEDGER_PROTECTED_EFFECTS_OFF, and no I/O at all.
 *      Unset or blank means on; any value other than on/off counts as off (one warning).
 *   2. disabled by test-control policy -> LEDGER_POLICY_DISABLED (nothing created or read).
 *   3. directories                   -> LEDGER_PATH_* (shared by every purpose).
 *   4. registration unparsable       -> LEDGER_REGISTRATION_INVALID, unless a valid reinit
 *      request, written after the value's last write (coin_metadata updated_at), names
 *      the ledger ID the database carried (then step 6 replaces it).
 *   5. quarantine marker, stamp, or registration flag -> LEDGER_QUARANTINED, unless a
 *      valid release-quarantine (or reinit) request resolves it.
 *   6. valid reinit request          -> the old ledger is retired in the registration. It
 *      may be active, creating (a creation that cannot be completed, or a restored
 *      backup), unregistered, or unparsable; the new ledger always gets a new genesis and
 *      cutover. A leftover <request>.tmp is ignored (LEDGER_REQUEST_TEMP_IGNORED).
 *   7. registration / files table    -> create, resume, complete, open, or fail:
 *      none|retired + nothing             -> create                LEDGER_CREATED
 *      none|retired + only staged files   -> retire them, create   LEDGER_TEMP_RETIRED (notice)
 *      none|retired + any ledger file     -> fail                  LEDGER_REGISTRATION_MISSING
 *      creating(X) + no database, witnesses unused (0/0) -> retire leftovers, recreate X
 *                                                               LEDGER_CREATION_RESUMED
 *      creating(X) + no database, a witness used        -> fail  LEDGER_FILES_MISSING
 *      creating(X) + complete files       -> register active, open LEDGER_CREATION_RESUMED
 *      active(X) + nothing                -> fail (never rebuilt)  LEDGER_FILES_MISSING
 *      active(X) + some files missing     -> fail                  LEDGER_PARTIAL
 *      active(X) + staged files present   -> fail                  LEDGER_TEMP_PRESENT
 *      active(X) + complete               -> open, checking paths, receipt digest and
 *        content, identity (ledger-id, kind, purpose, runtime-mode, bot, owner, genesis,
 *        cutover), witness continuity, and lastSeen: LEDGER_PATH_MISMATCH,
 *        LEDGER_RECEIPT_MISMATCH, LEDGER_IDENTITY_MISMATCH, LEDGER_ROLLBACK
 *        (database-behind, gap, fork, registration-ahead, registration-fork),
 *        LEDGER_FORMAT_*, LEDGER_CORRUPT, LEDGER_IN_USE.
 *   8. identityVerified false (the bot ID stands in from the configuration because it
 *      could not be read with the bot token): only the open of an active registration
 *      goes on; every other purpose fails with LEDGER_IDENTITY_UNVERIFIED and nothing is
 *      written for it, so no ledger is ever bound to an unverified ID.
 *   A ledger one step ahead of its witnesses (a crash between a commit and the witness
 *   write) is accepted and its witnesses rewritten; a ledger ahead of its registration by
 *   any number of steps is accepted, because the registration may lag.
 *
 * Creation: (1) create the directories (owner-only on POSIX); (2) durably register
 * creating(X) with its genesis and cutover; (3) write the database, anchor, external
 * witness, and receipt under ".creating" names, each fsynced; (4) rename anchor, witness,
 * receipt, and the database last (the commit point), then flush both directories; a
 * staged database that left a WAL is retired and created again; (5) durably register
 * active(X) with the receipt digest; (6) open (boot); (7) record lastSeen. Registration
 * writes are batched: one for every creating (and request) update, one for every active
 * update, one for every lastSeen. If creating cannot be written nothing is created; if
 * active cannot be written the ledger is not opened and the next start completes it.
 * Retired files are moved to retired-* directories with a manifest and never deleted.
 *
 * A ledger held by another process (LEDGER_IN_USE, reason locked) is retried with
 * asynchronous backoff from 50 ms to 5 s under one 30-second deadline shared by every
 * purpose, checking isStopping/assertRunning before each wait. A second open inside
 * this process (reason same-process) fails at once.
 *
 * Nothing here sends a message. The report (format version 1) carries what an Owner
 * notice, an escalation, or a status page needs:
 *   { version: 1, protectedEffects: 'on'|'off', runtimeMode, startedAtMs, finishedAtMs,
 *     legacyVariables: [names], lastSeen: 'written'|'unchanged'|'failed'|'skipped',
 *     purposes: [{ purposeId, kind, status: 'ready'|'disabled'|'failed', code, reason,
 *       notices: [codes], ledgerId, confirmationCode, genesisMs, cutoverMs,
 *       created (a ledger was created or completed by this start),
 *       escalate (the purpose failed closed) }] }
 * Codes and reasons are fixed tokens; no path, Discord ID, or message text is included.
 * The returned `ledgers` map holds the open facades of ready purposes; recordLastSeen()
 * writes their counters to the registrations again (for a clean stop or an hourly
 * refresh); close() closes them.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const defaultLogger = require('../../utils/logger');
const coinDatabase = require('../../services/coinDatabase');
const { assertTestDataRootMarker } = require('../../platform/testControlPolicy');
const { LedgerStoreError, assertTestOnlyOption, inspectWitnessFile, witnessIdentityDigest } = require('./ledgerStore');
const {
  CREATED_BY_BOOTSTRAP,
  OWNER_PURPOSE_ID,
  PUBLIC_PURPOSES,
  commitStagedLedger,
  initializePublicPurposeLedger,
  initializeSideEffectLedger,
  openRegisteredLedger,
} = require('./sideEffectLedger');
const layout = require('./ledgerLayout');

const REPORT_VERSION = 1;
// Tests simulate a crash by throwing an error with this code from the test-only fault
// injector: it is never turned into a purpose failure and aborts the bootstrap where it
// was thrown, leaving every file exactly as a crash at that point would.
const TEST_CRASH_CODE = 'LEDGER_BOOTSTRAP_TEST_CRASH';
const IN_USE_DEADLINE_MS = 30_000;
const IN_USE_INITIAL_DELAY_MS = 50;
const IN_USE_MAX_DELAY_MS = 5_000;
const MAX_STAGING_ATTEMPTS = 2;
const MAX_RECEIPT_BYTES = 65_536;
const SNOWFLAKE = /^\d{17,20}$/u;
const REASON_TOKEN = /^[a-z][a-z0-9-]{0,31}$/u;
const CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const QUARANTINE_REASON = /^[A-Za-z0-9:._/-]{1,64}$/u;
// Purposes that test-control never enables: Owner DMs, work reminder DMs, and automatic
// guild leaves (its egress already refuses them). Only four ledgers exist there.
const TEST_CONTROL_DISABLED_PURPOSES = Object.freeze(new Set([
  OWNER_PURPOSE_ID,
  'work.reminder.dm.prepare',
  'work.reminder.dm.send',
  'audit.guild.leave',
]));
// Variables of the environment-configured ledgers this bootstrap replaces. Their names are
// logged once if set; their values are never read. XIAOJI_REMINDERS_PROVENANCE_SHA256 and
// XIAOJI_CALENDAR_PROVENANCE_SHA256 are still in use and deliberately not listed.
const LEGACY_LEDGER_VARIABLES = Object.freeze([
  'XIAOJI_OWNER_SAFETY_DM_ENABLED',
  'XIAOJI_SIDE_EFFECT_LEDGER_PATH',
  'XIAOJI_SIDE_EFFECT_LEDGER_PROVENANCE_SHA256',
  'XIAOJI_WELCOME_LEDGER_ENABLED',
  'XIAOJI_WELCOME_LEDGER_PATH',
  'XIAOJI_WELCOME_LEDGER_PROVENANCE_SHA256',
  ...['XIAOJI_WORK_PENALTY_LEDGER', 'XIAOJI_WORK_REMINDER_DM_PREPARE_LEDGER', 'XIAOJI_WORK_REMINDER_DM_LEDGER',
    'XIAOJI_AUDIT_LEAVE_LEDGER', 'XIAOJI_WORD_CHAIN_REACTION_LEDGER', 'XIAOJI_NUMBER_CHAIN_REACTION_LEDGER']
    .flatMap((prefix) => ['ENABLED', 'PATH', 'PROVENANCE_SHA256'].map((suffix) => `${prefix}_${suffix}`)),
]);
const DEFAULT_REGISTRY = Object.freeze({
  read: () => coinDatabase.readSafetyLedgerRegistrations(),
  write: (updates) => coinDatabase.writeSafetyLedgerRegistrations(updates),
});

// A purpose that ends here, with a fixed code and reason.
class BootstrapFailure extends Error {
  constructor(code, reason = null) {
    super(`${code}${reason ? ` (${reason})` : ''}`);
    this.name = 'BootstrapFailure';
    this.code = code;
    this.reason = reason;
  }
}

function failure(code, reason = null) {
  return new BootstrapFailure(code, reason);
}

// The simulated crash inside an error's cause chain (store and facade errors wrap it).
function findTestCrash(error) {
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 6; depth += 1) {
    if (current.code === TEST_CRASH_CODE) return current;
    current = current.cause;
  }
  return null;
}

function rethrowTestCrash(error) {
  const crash = findTestCrash(error);
  if (crash) throw crash;
}

function safeReason(value) {
  return typeof value === 'string' && REASON_TOKEN.test(value) ? value : null;
}

function safeCode(value, fallback) {
  return typeof value === 'string' && CODE_TOKEN.test(value) ? value : fallback;
}

// Maps any error met while checking, creating, or opening a ledger to a fixed code.
function describeFailure(error, fallback) {
  if (error instanceof BootstrapFailure || error instanceof layout.LedgerLayoutError) {
    return { code: error.code, reason: safeReason(error.reason) };
  }
  if (typeof error?.storeCode === 'string') {
    return { code: safeCode(error.storeCode, fallback), reason: safeReason(error.storeDetail?.reason) };
  }
  if (error instanceof LedgerStoreError) return { code: safeCode(error.code, fallback), reason: safeReason(error.detail?.reason) };
  switch (error?.code) {
    case 'SIDE_EFFECT_IDENTITY_MISMATCH':
      return { code: 'LEDGER_IDENTITY_MISMATCH', reason: safeReason(error.detail?.reason) };
    case 'SIDE_EFFECT_PROVENANCE_MISMATCH':
      return { code: 'LEDGER_RECEIPT_MISMATCH', reason: 'sha256' };
    case 'SIDE_EFFECT_PROVENANCE_INVALID':
      return { code: 'LEDGER_RECEIPT_MISMATCH', reason: 'content' };
    case 'SIDE_EFFECT_FILE_INVALID':
    case 'SIDE_EFFECT_FILE_UNREADABLE':
    case 'SIDE_EFFECT_FILE_DRIFT':
    case 'SIDE_EFFECT_FILE_CORRUPT':
      return { code: 'LEDGER_RECEIPT_MISMATCH', reason: 'file' };
    case 'SIDE_EFFECT_LEDGER_QUARANTINED':
      return { code: 'LEDGER_QUARANTINED', reason: 'marker' };
    case 'SIDE_EFFECT_PATH_INVALID':
      return { code: 'LEDGER_PATH_MISMATCH', reason: 'layout' };
    case 'SIDE_EFFECT_PATH_REMOTE':
      return { code: 'LEDGER_PATH_REMOTE', reason: 'unc-prefix' };
    case 'SIDE_EFFECT_STAGING_INCOMPLETE':
      return { code: fallback, reason: 'staging-incomplete' };
    case 'SIDE_EFFECT_INITIALIZATION_CONFLICT':
      return { code: fallback, reason: 'conflict' };
    case 'SAFETY_REGISTRATION_CONFLICT':
      return { code: 'LEDGER_REGISTRATION_WRITE_FAILED', reason: 'conflict' };
    case 'SAFETY_REGISTRATION_WRITE_FAILED':
    case 'SAFETY_REGISTRATION_INVALID':
      return { code: 'LEDGER_REGISTRATION_WRITE_FAILED', reason: 'write' };
    default:
      return { code: fallback, reason: null };
  }
}

// XIAOJI_PROTECTED_EFFECTS: unset or blank is on; "on"/"off" in any case; anything else
// is off and flagged so the caller warns once.
function resolveProtectedEffects(env = process.env) {
  const raw = env?.XIAOJI_PROTECTED_EFFECTS;
  if (raw === undefined || raw === null || String(raw).trim() === '') return Object.freeze({ enabled: true, invalid: false });
  const value = String(raw).trim().toLowerCase();
  if (value === 'on') return Object.freeze({ enabled: true, invalid: false });
  if (value === 'off') return Object.freeze({ enabled: false, invalid: false });
  return Object.freeze({ enabled: false, invalid: true });
}

function detectLegacyVariables(env = process.env) {
  return Object.freeze(LEGACY_LEDGER_VARIABLES.filter((name) => typeof env?.[name] === 'string' && env[name].trim() !== ''));
}

function normalizeLogger(value) {
  if (value && typeof value.warn === 'function' && typeof value.error === 'function') {
    return {
      info: typeof value.info === 'function' ? value.info.bind(value) : () => {},
      warn: value.warn.bind(value),
      error: value.error.bind(value),
    };
  }
  return defaultLogger;
}

function lstatPresent(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw failure('LEDGER_PATH_INVALID', 'uninspectable');
  }
}

function safeNow(now) {
  const value = Number(now());
  if (!Number.isSafeInteger(value) || value < 0) throw failure('LEDGER_CLOCK_INVALID');
  return value;
}

// Serializes every registration write of one bootstrap: each batch compares against the
// values it last read or wrote (compare-and-set) inside one queue, so a quarantine flag
// and a lastSeen update can never overwrite each other. It also keeps when each value
// was last written (coin_metadata updated_at), which a reinit request for an unparsable
// value is checked against.
class RegistrationBook {
  #registry;
  #raw;
  #updatedAt;
  #queue = Promise.resolve();

  constructor(registry, registrations) {
    this.#registry = registry;
    const entries = Object.entries(registrations || {});
    this.#raw = new Map(entries.map(([purposeId, entry]) => [purposeId, entry?.value]));
    this.#updatedAt = new Map(entries.map(([purposeId, entry]) => [purposeId, entry?.updatedAt]));
  }

  raw(purposeId) {
    const value = this.#raw.get(purposeId);
    return typeof value === 'string' ? value : null;
  }

  // When the stored value was last written (milliseconds), or null when unknown.
  updatedAtMs(purposeId) {
    return layout.registrationTimeMs(this.#updatedAt.get(purposeId));
  }

  current(purposeId) {
    const raw = this.raw(purposeId);
    return raw === null ? null : layout.decodeRegistration(purposeId, raw);
  }

  // compute(purposeId, current) returns the next registration, or null for no change. A
  // stored value that cannot be decoded aborts the batch, except for purposes listed in
  // replaceInvalid (a validated reinit of an unparsable registration): those see null as
  // current, and the write still compares against the exact stored value.
  apply(purposeIds, compute, { replaceInvalid = new Set() } = {}) {
    const run = async () => {
      const updates = [];
      for (const purposeId of purposeIds) {
        const expectedValue = this.raw(purposeId);
        let current = null;
        if (expectedValue !== null) {
          try {
            current = layout.decodeRegistration(purposeId, expectedValue);
          } catch (error) {
            if (!replaceInvalid.has(purposeId)) throw error;
          }
        }
        const next = compute(purposeId, current);
        if (!next) continue;
        const value = layout.encodeRegistration(purposeId, next);
        if (value !== expectedValue) updates.push({ purposeId, expectedValue, value });
      }
      if (!updates.length) return Object.freeze({ written: 0 });
      const written = await this.#registry.write(updates.map(({ purposeId, expectedValue, value }) =>
        ({ purposeId, expectedValue, value })));
      for (const { purposeId, value } of updates) {
        this.#raw.set(purposeId, value);
        this.#updatedAt.set(purposeId, written?.updatedAt);
      }
      return Object.freeze({ written: updates.length });
    };
    const result = this.#queue.then(run, run);
    this.#queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

class PurposeReport {
  constructor(purposeId) {
    this.purposeId = purposeId;
    this.kind = layout.SAFETY_LEDGER_PURPOSES[purposeId].kind;
    this.status = null;
    this.code = null;
    this.reason = null;
    this.notices = [];
    this.ledgerId = null;
    this.genesisMs = null;
    this.cutoverMs = null;
    this.created = false;
  }

  get settled() { return this.status !== null; }

  identify(registration) {
    if (!registration) return;
    this.ledgerId = registration.ledgerId;
    this.genesisMs = registration.genesisMs;
    this.cutoverMs = registration.cutoverMs;
  }

  notice(code) {
    if (!this.notices.includes(code)) this.notices.push(code);
  }

  disable(code) {
    this.status = 'disabled';
    this.code = code;
  }

  fail(code, reason = null) {
    this.status = 'failed';
    this.code = code;
    this.reason = safeReason(reason);
  }

  ready(code, created) {
    this.status = 'ready';
    this.code = code;
    this.created = created;
  }

  toJSON() {
    return Object.freeze({
      purposeId: this.purposeId,
      kind: this.kind,
      status: this.status,
      code: this.code,
      reason: this.reason,
      notices: Object.freeze([...this.notices]),
      ledgerId: this.ledgerId,
      confirmationCode: this.ledgerId ? layout.confirmationCode(this.ledgerId) : null,
      genesisMs: this.genesisMs,
      cutoverMs: this.cutoverMs,
      created: this.created,
      escalate: this.status === 'failed',
    });
  }
}

function normalizeBootstrapOptions(options) {
  const inUseDeadlineMs = options.inUseDeadlineMs === undefined ? IN_USE_DEADLINE_MS : options.inUseDeadlineMs;
  if (!Number.isSafeInteger(inUseDeadlineMs) || inUseDeadlineMs < 0 || inUseDeadlineMs > 120_000) {
    throw new TypeError('inUseDeadlineMs is invalid.');
  }
  if (options.faultInjector !== undefined && options.faultInjector !== null) {
    if (typeof options.faultInjector !== 'function') throw new TypeError('faultInjector is invalid.');
    assertTestOnlyOption('faultInjector');
  }
  const registry = options.registry || DEFAULT_REGISTRY;
  if (typeof registry.read !== 'function' || typeof registry.write !== 'function') throw new TypeError('registry is invalid.');
  return {
    env: options.env || process.env,
    runtimeMode: options.runtimeMode,
    botId: String(options.botId || ''),
    // false when botId could not be read with the bot token and stands in from the
    // configuration: then nothing is created (see runBootstrap).
    identityVerified: options.identityVerified !== false,
    ownerId: options.ownerId === undefined || options.ownerId === null ? '' : String(options.ownerId),
    policy: options.policy || null,
    coinDbPath: options.coinDbPath,
    projectRoot: options.projectRoot || layout.PROJECT_ROOT,
    registry,
    now: typeof options.now === 'function' ? options.now : () => Date.now(),
    monotonic: typeof options.monotonic === 'function' ? options.monotonic : () => performance.now(),
    sleep: typeof options.sleep === 'function' ? options.sleep : (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    isStopping: typeof options.isStopping === 'function' ? options.isStopping : () => false,
    assertRunning: typeof options.assertRunning === 'function' ? options.assertRunning : null,
    logger: normalizeLogger(options.logger),
    inUseDeadlineMs,
    faultInjector: options.faultInjector || null,
    randomBytes: typeof options.randomBytes === 'function' ? options.randomBytes : crypto.randomBytes,
  };
}

function inject(ctx, phase, extra = {}) {
  if (ctx.faultInjector) ctx.faultInjector({ label: 'bootstrap', phase, ...extra });
}

// ---------------------------------------------------------------------------
// Observation: classify one purpose from its registration and files. Only lstat is used
// on database paths; only plain witness, receipt, request, and manifest files are read.
// ---------------------------------------------------------------------------

function observeFiles(paths) {
  return Object.freeze({
    final: Object.freeze({
      database: lstatPresent(paths.database),
      wal: lstatPresent(paths.wal),
      shm: lstatPresent(paths.shm),
      journal: lstatPresent(paths.journal),
      anchor: lstatPresent(paths.anchor),
      witness: lstatPresent(paths.witness),
      receipt: lstatPresent(paths.receipt),
    }),
    staged: Object.freeze(Object.fromEntries(Object.entries(paths.staged)
      .map(([role, filePath]) => [role, lstatPresent(filePath)]))),
    marker: lstatPresent(paths.marker),
    stamp: lstatPresent(paths.stamp),
    reinitRequest: lstatPresent(paths.reinitRequest),
    releaseRequest: lstatPresent(paths.releaseRequest),
    // Unfinished request writes of the operator script: ignored (never read, moved, or
    // deleted here) and reported once.
    requestTemp: lstatPresent(paths.reinitRequestTemp) || lstatPresent(paths.releaseRequestTemp),
  });
}

function anyFinalFile(files) {
  return Object.values(files.final).some(Boolean);
}

function anyStagedFile(files) {
  return Object.values(files.staged).some(Boolean);
}

// A staged witness was never used by a store (stores open final paths only). One that
// decodes with counters past 0/0 means something unexpected wrote it: fail closed. One
// that cannot be decoded (a crash while it was written) is unused.
function stagedWitnessUsed(filePath) {
  if (!lstatPresent(filePath)) return false;
  const inspected = inspectWitnessFile(filePath);
  return !inspected.problem && (inspected.state.bootEpoch !== 0 || inspected.state.beginSeq !== 0);
}

// For creating(X) without a final database: every witness that exists must belong to X
// and be unused (0/0). Final witnesses are checked strictly; staged ones leniently.
function assertCreationWitnessesUnused(registration, paths) {
  const digest = witnessIdentityDigest({ ledgerId: registration.ledgerId, kind: registration.kind,
    genesisMs: registration.genesisMs });
  for (const filePath of [paths.anchor, paths.witness]) {
    if (!lstatPresent(filePath)) continue;
    const inspected = inspectWitnessFile(filePath, { identityDigest: digest });
    if (inspected.problem === 'foreign') throw failure('LEDGER_IDENTITY_MISMATCH', 'witness');
    if (inspected.problem) throw failure('LEDGER_WITNESS_INVALID', inspected.problem);
    if (inspected.state.bootEpoch !== 0 || inspected.state.beginSeq !== 0) throw failure('LEDGER_FILES_MISSING', 'used');
  }
  for (const filePath of [paths.staged.anchor, paths.staged.witness]) {
    if (stagedWitnessUsed(filePath)) throw failure('LEDGER_FILES_MISSING', 'used');
  }
}

function assertRuntimeIdentity(registration, ctx) {
  if (registration.runtimeMode !== ctx.runtimeMode) throw failure('LEDGER_IDENTITY_MISMATCH', 'runtime-mode');
  if (registration.botId !== ctx.botId) throw failure('LEDGER_IDENTITY_MISMATCH', 'bot');
  if (registration.kind === 'owner' && registration.ownerId !== ctx.ownerId) throw failure('LEDGER_IDENTITY_MISMATCH', 'owner');
}

function assertRegisteredPaths(registration, paths) {
  const role = layout.registeredPathMismatch(registration, paths);
  if (role) throw failure('LEDGER_PATH_MISMATCH', role);
}

function retiredDirectoryOf(directory, name, purposeId, ledgerId, reason) {
  if (name === null) return null;
  const retired = path.join(directory, name);
  const manifest = layout.readManifest(retired);
  if (!manifest || manifest.purposeId !== purposeId || manifest.ledgerId !== ledgerId || manifest.reason !== reason) {
    throw failure('LEDGER_REQUEST_INVALID', 'manifest');
  }
  return retired;
}

// A reinit request is valid when the script retired the files of the registered ledger
// (its manifests name the same ledger ID) and no ledger file, marker, or stamp is left.
// The registered ledger may be active or still creating: a creation that can no longer
// be completed (moved paths, another bot or Owner, a restored backup) is reset this way
// too, and the new ledger gets a new genesis and cutover instead of the stuck one's.
// invalidRegistration ({ reason, updatedAtMs }): the stored registration cannot be
// parsed, so the request must name a ledger ID (the script reads it from the database
// itself) and the manifests and absent files are the only proof; the new registration
// then replaces the unparsable value by compare-and-set. Without a registration an
// applied request cannot be recognized, so the request must also be newer than the
// value's last write: an older one (say, applied by an earlier start, never moved away,
// and the value damaged since) leaves the registration closed as invalid.
function readReinitRequest(purposeId, paths, registration, files, { invalidRegistration = null } = {}) {
  const request = layout.readRequest(paths.reinitRequest, purposeId);
  if (request.kind !== 'reinit') throw failure('LEDGER_REQUEST_INVALID', 'kind');
  if (invalidRegistration) {
    const { reason, updatedAtMs } = invalidRegistration;
    if (updatedAtMs === null || request.requestedAtMs <= updatedAtMs) {
      throw failure('LEDGER_REGISTRATION_INVALID', reason);
    }
    if (request.ledgerId === null) throw failure('LEDGER_REQUEST_INVALID', 'ledger-id');
  }
  const ledgerRetired = retiredDirectoryOf(paths.ledgerDirectory, request.retired.ledgerDirectory, purposeId,
    request.ledgerId, 'reinit');
  const witnessRetired = retiredDirectoryOf(paths.witnessDirectory, request.retired.witnessDirectory, purposeId,
    request.ledgerId, 'reinit');
  const consumeInto = ledgerRetired || witnessRetired;
  if (!consumeInto) throw failure('LEDGER_REQUEST_INVALID', 'manifest');
  // Already applied by an earlier start that stopped before moving the request away.
  if (registration && request.ledgerId !== null && registration.ledgerId !== request.ledgerId &&
      registration.previous.some((entry) => entry.ledgerId === request.ledgerId)) {
    return Object.freeze({ request, consumeInto, applied: true });
  }
  if ((registration?.state === 'active' || registration?.state === 'creating') &&
      registration.ledgerId !== request.ledgerId) {
    throw failure('LEDGER_REQUEST_INVALID', 'ledger-id');
  }
  if (anyFinalFile(files) || files.marker || files.stamp) throw failure('LEDGER_REQUEST_INVALID', 'files-present');
  return Object.freeze({ request, consumeInto, applied: false });
}

// A release request is valid when it names the registered (active) ledger and the script
// already moved its marker and stamp into a retired directory.
function readReleaseRequest(purposeId, paths, registration, files) {
  const request = layout.readRequest(paths.releaseRequest, purposeId);
  if (request.kind !== 'release-quarantine') throw failure('LEDGER_REQUEST_INVALID', 'kind');
  if (registration?.state !== 'active' || registration.ledgerId !== request.ledgerId) {
    throw failure('LEDGER_REQUEST_INVALID', 'ledger-id');
  }
  if (files.marker || files.stamp) throw failure('LEDGER_REQUEST_INVALID', 'quarantine-present');
  const ledgerRetired = retiredDirectoryOf(paths.ledgerDirectory, request.retired.ledgerDirectory, purposeId,
    request.ledgerId, 'release-quarantine');
  const witnessRetired = retiredDirectoryOf(paths.witnessDirectory, request.retired.witnessDirectory, purposeId,
    request.ledgerId, 'release-quarantine');
  const consumeInto = ledgerRetired || witnessRetired;
  if (!consumeInto) throw failure('LEDGER_REQUEST_INVALID', 'manifest');
  return Object.freeze({ request, consumeInto });
}

// Decides what to do with one purpose. Returns a plan or throws BootstrapFailure.
function planPurpose(ctx, purposeId, report) {
  const paths = layout.purposePaths(ctx.directories, purposeId);
  let observed = null;
  let invalidReason = null;
  try {
    observed = ctx.book.current(purposeId);
  } catch (error) {
    invalidReason = error?.reason || 'invalid';
  }
  report.identify(observed);
  const files = observeFiles(paths);
  if (files.requestTemp) {
    report.notice('LEDGER_REQUEST_TEMP_IGNORED');
    ctx.logger.warn(`[SAFETY_LEDGER] purpose=${purposeId} code=LEDGER_REQUEST_TEMP_IGNORED`);
  }
  // An unparsable registration stays closed unless a valid reinit request, newer than
  // the value's last write, replaces it.
  if (invalidReason !== null && !files.reinitRequest) throw failure('LEDGER_REGISTRATION_INVALID', invalidReason);
  const invalidRegistration = invalidReason === null ? null
    : { reason: invalidReason, updatedAtMs: ctx.book.updatedAtMs(purposeId) };
  const reinit = files.reinitRequest
    ? readReinitRequest(purposeId, paths, observed, files, { invalidRegistration }) : null;
  if (invalidReason !== null && files.releaseRequest) throw failure('LEDGER_REQUEST_INVALID', 'conflicting');
  const release = files.releaseRequest ? readReleaseRequest(purposeId, paths, observed, files) : null;
  const reinitPending = Boolean(reinit && !reinit.applied);
  if (reinitPending && release) throw failure('LEDGER_REQUEST_INVALID', 'conflicting');
  if (files.marker) throw failure('LEDGER_QUARANTINED', 'marker');
  if (files.stamp) throw failure('LEDGER_QUARANTINED', 'stamp');
  if (observed?.quarantine && !reinitPending && !release) throw failure('LEDGER_QUARANTINED', 'registration');
  const plan = { purposeId, report, paths, observed, registration: observed, files, reinit, release,
    replacesInvalid: invalidReason !== null, retireStaged: false, receiptSha256: null };
  const state = reinitPending ? 'retired' : (observed?.state || 'none');
  if (state === 'none' || state === 'retired') {
    if (anyFinalFile(files)) throw failure('LEDGER_REGISTRATION_MISSING', state === 'none' ? 'unregistered' : 'retired');
    if (anyStagedFile(files)) {
      if (stagedWitnessUsed(paths.staged.anchor) || stagedWitnessUsed(paths.staged.witness)) {
        throw failure('LEDGER_TEMP_PRESENT', 'staged-used');
      }
      plan.retireStaged = true;
    }
    plan.action = 'create';
    return plan;
  }
  assertRegisteredPaths(observed, paths);
  assertRuntimeIdentity(observed, ctx);
  const { final } = files;
  if (state === 'creating') {
    if (final.database) {
      if (!final.anchor || !final.witness || !final.receipt) throw failure('LEDGER_PARTIAL', 'creating');
      if (final.journal || anyStagedFile(files)) throw failure('LEDGER_TEMP_PRESENT', 'creating');
      plan.action = 'complete';
      return plan;
    }
    if (final.wal || final.shm || final.journal) throw failure('LEDGER_PARTIAL', 'companion');
    assertCreationWitnessesUnused(observed, paths);
    plan.action = 'resume';
    return plan;
  }
  const required = [final.database, final.anchor, final.witness, final.receipt];
  if (!required.some(Boolean) && !final.wal && !final.shm) throw failure('LEDGER_FILES_MISSING', 'all');
  if (!required.every(Boolean)) throw failure('LEDGER_PARTIAL', 'active');
  if (anyStagedFile(files)) throw failure('LEDGER_TEMP_PRESENT', 'staged');
  plan.action = 'open';
  return plan;
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

function newRegistration(ctx, plan, nowMs) {
  const definition = layout.SAFETY_LEDGER_PURPOSES[plan.purposeId];
  const previous = [];
  if (plan.reinit && !plan.reinit.applied && plan.reinit.request.ledgerId !== null) {
    previous.push({ ledgerId: plan.reinit.request.ledgerId, retiredAtMs: nowMs, reason: 'reinit' });
  }
  for (const entry of plan.observed?.previous || []) {
    if (!previous.some((item) => item.ledgerId === entry.ledgerId)) previous.push(entry);
  }
  return {
    schema: layout.REGISTRATION_SCHEMA,
    state: 'creating',
    purposeId: plan.purposeId,
    kind: definition.kind,
    ledgerId: layout.generateLedgerId(plan.purposeId, ctx.randomBytes),
    runtimeMode: ctx.runtimeMode,
    botId: ctx.botId,
    ownerId: definition.kind === 'owner' ? ctx.ownerId : null,
    genesisMs: nowMs,
    cutoverMs: layout.cutoverFor(plan.purposeId, nowMs),
    paths: layout.registeredPathsOf(plan.paths),
    receiptSha256: null,
    lastSeen: null,
    quarantine: null,
    createdBy: CREATED_BY_BOOTSTRAP,
    previous: previous.slice(0, layout.REGISTRATION_MAX_PREVIOUS),
  };
}

// Moves leftovers of an earlier, interrupted creation into retired directories (never
// deleted). includeFinal also retires final anchor, witness, and receipt files that
// were renamed before the database (they were checked to be unused).
async function retireLeftovers(ctx, plan, reason, includeFinal) {
  const { paths } = plan;
  const nowMs = safeNow(ctx.now);
  const ledgerFiles = [
    ['database', paths.staged.database], ['wal', paths.staged.wal], ['shm', paths.staged.shm],
    ['journal', paths.staged.journal], ['anchor', paths.staged.anchor], ['receipt', paths.staged.receipt],
  ];
  const witnessFiles = [['witness', paths.staged.witness]];
  if (includeFinal) {
    ledgerFiles.push(['final-anchor', paths.anchor], ['final-receipt', paths.receipt]);
    witnessFiles.push(['final-witness', paths.witness]);
  }
  const ledgerId = plan.observed?.state === 'creating' ? plan.observed.ledgerId : null;
  let retired = 0;
  for (const [directory, files] of [[paths.ledgerDirectory, ledgerFiles], [paths.witnessDirectory, witnessFiles]]) {
    const result = await layout.retireFiles({ directory, purposeId: plan.purposeId, ledgerId, reason, nowMs,
      createdBy: 'bootstrap', files: files.map(([role, filePath]) => ({ role, filePath })) });
    if (result) retired += 1;
  }
  if (retired) plan.report.notice('LEDGER_TEMP_RETIRED');
}

async function stageAndCommit(ctx, plan, registration) {
  const common = {
    filePath: plan.paths.database,
    continuityWitnessPath: plan.paths.witness,
    ledgerId: registration.ledgerId,
    initializationId: `bootstrap:${registration.ledgerId}`,
    runtimeMode: registration.runtimeMode,
    staging: true,
    genesisMs: registration.genesisMs,
    createdBy: CREATED_BY_BOOTSTRAP,
    faultInjector: ctx.faultInjector,
  };
  const contract = PUBLIC_PURPOSES[plan.purposeId];
  const staged = registration.kind === 'owner'
    ? initializeSideEffectLedger({ ...common,
      notificationIdentity: { botId: registration.botId, ownerId: registration.ownerId } })
    : initializePublicPurposeLedger({ ...common, purposeIdentity: {
      purposeId: plan.purposeId,
      botId: registration.botId,
      sourceNamespace: contract.sourceNamespace,
      [contract.cutoverField]: registration.cutoverMs,
      // There is no operator proof for an automatic creation: the digest binds the
      // cutover instead, which makes every older source terminal.
      freshSourceProofDigest: crypto.createHash('sha256')
        .update(`xiaoji-ledger-bootstrap-cutover\n${registration.ledgerId}\n${registration.cutoverMs}`).digest('hex'),
    } });
  inject(ctx, 'after-staged-files', { purposeId: plan.purposeId });
  const committed = await commitStagedLedger(staged, { faultInjector: ctx.faultInjector });
  return committed.receiptSha256;
}

async function createLedger(ctx, plan) {
  if (plan.action === 'resume') await retireLeftovers(ctx, plan, 'resume', true);
  else if (plan.retireStaged) await retireLeftovers(ctx, plan, 'staged', false);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await stageAndCommit(ctx, plan, plan.registration);
    } catch (error) {
      rethrowTestCrash(error);
      // A staged database that did not close cleanly is retired and created again.
      if (error?.code !== 'SIDE_EFFECT_STAGING_INCOMPLETE' || attempt >= MAX_STAGING_ATTEMPTS) throw error;
      await retireLeftovers(ctx, plan, 'staged', false);
    }
  }
}

function receiptDigest(receiptPath) {
  const stat = fs.lstatSync(receiptPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size <= 0 || stat.size > MAX_RECEIPT_BYTES) {
    throw failure('LEDGER_RECEIPT_MISMATCH', 'file');
  }
  return crypto.createHash('sha256').update(fs.readFileSync(receiptPath)).digest('hex');
}

// ---------------------------------------------------------------------------
// Opening, with bounded retries for a ledger another process holds
// ---------------------------------------------------------------------------

function stopping(ctx) {
  if (ctx.isStopping() === true) return true;
  if (ctx.assertRunning) {
    try {
      ctx.assertRunning();
    } catch {
      return true;
    }
  }
  return false;
}

// Records a quarantine of an open ledger in its registration (the third place, beside the
// marker and the stamp). Already flagged, retired, or replaced registrations are left alone.
function quarantineHook(ctx, purposeId) {
  return (event) => ctx.book.apply([purposeId], (id, current) => {
    if (!current || current.state !== 'active' || current.ledgerId !== event.ledgerId || current.quarantine) return null;
    const reason = typeof event.reason === 'string' && QUARANTINE_REASON.test(event.reason)
      ? event.reason : 'retained-by-runtime';
    const requestedAtMs = Number.isSafeInteger(event.requestedAtMs) && event.requestedAtMs >= 0
      ? event.requestedAtMs : safeNow(ctx.now);
    return { ...current, quarantine: { requestedAtMs, reason, ledgerId: event.ledgerId } };
  });
}

function openRegistered(ctx, purposeId, registration) {
  return openRegisteredLedger({
    purposeId,
    kind: registration.kind,
    paths: registration.paths,
    receiptSha256: registration.receiptSha256,
    expected: {
      ledgerId: registration.ledgerId,
      botId: registration.botId,
      ownerId: registration.ownerId,
      runtimeMode: registration.runtimeMode,
      genesisMs: registration.genesisMs,
      cutoverMs: registration.cutoverMs,
      notBefore: registration.lastSeen
        ? { bootEpoch: registration.lastSeen.bootEpoch, beginSeq: registration.lastSeen.beginSeq,
          chainHead: registration.lastSeen.chainHead }
        : null,
    },
    now: () => ctx.now(),
    logger: ctx.logger,
    faultInjector: ctx.faultInjector,
    onQuarantine: quarantineHook(ctx, purposeId),
  });
}

async function openAll(ctx, entries) {
  const deadline = ctx.monotonic() + ctx.inUseDeadlineMs;
  let pending = entries;
  let delay = IN_USE_INITIAL_DELAY_MS;
  while (pending.length) {
    const locked = [];
    for (const entry of pending) {
      let ledger;
      try {
        ledger = openRegistered(ctx, entry.purposeId, entry.registration);
      } catch (error) {
        rethrowTestCrash(error);
        const described = describeFailure(error, 'LEDGER_OPEN_FAILED');
        if (described.code === 'LEDGER_IN_USE' && described.reason === 'locked') locked.push(entry);
        else entry.failed(described.code, described.reason);
        continue;
      }
      entry.opened(ledger);
    }
    if (!locked.length) return;
    const remaining = deadline - ctx.monotonic();
    if (remaining <= 0 || stopping(ctx)) {
      for (const entry of locked) entry.failed('LEDGER_IN_USE', remaining <= 0 ? 'locked' : 'stopping');
      return;
    }
    await ctx.sleep(Math.max(1, Math.min(delay, remaining)));
    delay = Math.min(delay * 2, IN_USE_MAX_DELAY_MS);
    if (stopping(ctx)) {
      for (const entry of locked) entry.failed('LEDGER_IN_USE', 'stopping');
      return;
    }
    pending = locked;
  }
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function lastSeenUpdate(ledger, current, atMs) {
  if (!ledger || !current || current.state !== 'active' || current.ledgerId !== ledger.ledgerId) return null;
  const counters = ledger.identityCounters;
  const previous = current.lastSeen;
  if (previous) {
    // Never moves backwards, and an unchanged ledger is not written again.
    if (counters.bootEpoch < previous.bootEpoch || counters.beginSeq < previous.beginSeq) return null;
    if (counters.bootEpoch === previous.bootEpoch && counters.beginSeq === previous.beginSeq &&
        counters.chainHead === previous.chainHead) return null;
  }
  return { ...current, lastSeen: { bootEpoch: counters.bootEpoch, beginSeq: counters.beginSeq,
    chainHead: counters.chainHead, atMs } };
}

function logReports(ctx, reports) {
  for (const item of reports) {
    const notices = item.notices.length ? ` notices=${item.notices.join(',')}` : '';
    if (item.status === 'failed') {
      ctx.logger.error(`[SAFETY_LEDGER] purpose=${item.purposeId} code=${item.code}` +
        `${item.reason ? ` reason=${item.reason}` : ''}${notices}`);
    } else if (item.status === 'ready') {
      ctx.logger.info(`[SAFETY_LEDGER] purpose=${item.purposeId} code=${item.code}${notices}`);
    }
  }
}

function buildResult(ctx, reports, ledgers, lastSeen, startedAtMs) {
  logReports(ctx, reports);
  const report = Object.freeze({
    version: REPORT_VERSION,
    protectedEffects: ctx.protectedEffects,
    runtimeMode: ['production', 'test-control'].includes(ctx.runtimeMode) ? ctx.runtimeMode : null,
    startedAtMs,
    finishedAtMs: Date.now(),
    legacyVariables: ctx.legacyVariables,
    lastSeen,
    purposes: Object.freeze(reports.map((item) => item.toJSON())),
  });
  // Writes lastSeen for every open ledger that is still healthy, in one durable write.
  const recordLastSeen = async () => {
    if (!ctx.book || !ledgers.size) return Object.freeze({ written: 0 });
    const atMs = safeNow(ctx.now);
    const healthy = [...ledgers].filter(([, ledger]) => !ledger.closed && !ledger.failed).map(([purposeId]) => purposeId);
    return ctx.book.apply(healthy, (purposeId, current) => lastSeenUpdate(ledgers.get(purposeId), current, atMs));
  };
  const close = () => {
    for (const ledger of ledgers.values()) {
      try { ledger.close(); } catch {}
    }
  };
  return Object.freeze({ report, ledgers: new Map(ledgers), recordLastSeen, close });
}

async function runBootstrap(ctx, reports, ledgers) {
  const byId = new Map(reports.map((item) => [item.purposeId, item]));
  const active = () => reports.filter((item) => !item.settled);
  if (!['production', 'test-control'].includes(ctx.runtimeMode)) {
    for (const item of reports) item.fail('LEDGER_CONFIGURATION_INVALID', 'runtime-mode');
    return 'skipped';
  }
  if (!SNOWFLAKE.test(ctx.botId)) {
    for (const item of reports) item.fail('LEDGER_IDENTITY_INVALID', 'bot');
    return 'skipped';
  }
  if (ctx.runtimeMode === 'test-control') {
    for (const item of reports) {
      if (TEST_CONTROL_DISABLED_PURPOSES.has(item.purposeId)) item.disable('LEDGER_POLICY_DISABLED');
    }
  }
  const owner = byId.get(OWNER_PURPOSE_ID);
  if (!owner.settled && (!SNOWFLAKE.test(ctx.ownerId) || ctx.ownerId === ctx.botId)) {
    owner.fail('LEDGER_IDENTITY_INVALID', 'owner');
  }
  if (!active().length) return 'skipped';

  try {
    ctx.directories = layout.resolveLedgerDirectories({ env: ctx.env, runtimeMode: ctx.runtimeMode, policy: ctx.policy,
      coinDbPath: ctx.coinDbPath === undefined ? coinDatabase.getCoinDatabasePath() : ctx.coinDbPath,
      projectRoot: ctx.projectRoot });
  } catch (error) {
    rethrowTestCrash(error);
    const described = describeFailure(error, 'LEDGER_PATH_INVALID');
    for (const item of active()) item.fail(described.code, described.reason);
    return 'skipped';
  }
  try {
    ctx.book = new RegistrationBook(ctx.registry, await ctx.registry.read());
  } catch (error) {
    rethrowTestCrash(error);
    for (const item of active()) item.fail('LEDGER_REGISTRATION_READ_FAILED');
    return 'skipped';
  }

  // Observe and plan every purpose before anything is written.
  const plans = new Map();
  for (const item of active()) {
    try {
      plans.set(item.purposeId, planPurpose(ctx, item.purposeId, item));
    } catch (error) {
      rethrowTestCrash(error);
      const described = describeFailure(error, 'LEDGER_INSPECTION_FAILED');
      item.fail(described.code, described.reason);
    }
  }
  const drop = (plan, code, reason) => {
    plan.report.fail(code, reason);
    plans.delete(plan.purposeId);
  };

  // A bot ID that only the configuration vouches for (it could not be read with the bot
  // token) may be another application's: a ledger created, completed, or reinitialized for
  // it would stay bound to that ID until a reinit. Only ledgers already registered active
  // open (planning checked that their registration names this bot); every other purpose
  // fails closed, nothing is written for it, and a pending reinit request stays for a start
  // that reads the bot ID with its token.
  if (!ctx.identityVerified) {
    for (const plan of [...plans.values()]) {
      if (plan.action !== 'open') drop(plan, 'LEDGER_IDENTITY_UNVERIFIED', 'configured');
    }
  }

  // Registration batch 1, before any ledger file is created: every new creating
  // registration (including those replacing a reinitialized ledger) and every released
  // quarantine flag, in one durable compare-and-set write.
  const nowMs = safeNow(ctx.now);
  const firstBatch = new Map();
  const replaceInvalid = new Set();
  for (const [purposeId, plan] of plans) {
    if (plan.action === 'create') firstBatch.set(purposeId, newRegistration(ctx, plan, nowMs));
    else if (plan.release && plan.observed?.quarantine) firstBatch.set(purposeId, { ...plan.observed, quarantine: null });
    if (plan.replacesInvalid && plan.action === 'create') replaceInvalid.add(purposeId);
  }
  if (firstBatch.size) {
    try {
      await ctx.book.apply([...firstBatch.keys()], (purposeId) => firstBatch.get(purposeId), { replaceInvalid });
    } catch (error) {
      rethrowTestCrash(error);
      const described = describeFailure(error, 'LEDGER_REGISTRATION_WRITE_FAILED');
      for (const purposeId of firstBatch.keys()) {
        drop(plans.get(purposeId), 'LEDGER_REGISTRATION_WRITE_FAILED', described.reason || 'write');
      }
    }
    inject(ctx, 'after-creating-registration');
  }
  for (const [purposeId, plan] of plans) {
    plan.registration = ctx.book.current(purposeId);
    plan.report.identify(plan.registration);
    const request = plan.reinit || plan.release;
    if (!request) continue;
    if (plan.reinit) plan.report.notice(plan.reinit.applied ? 'LEDGER_REINIT_CONSUMED' : 'LEDGER_REINIT_APPLIED');
    else plan.report.notice('LEDGER_QUARANTINE_RELEASED');
    try {
      await layout.consumeRequest(plan.reinit ? plan.paths.reinitRequest : plan.paths.releaseRequest,
        request.consumeInto, plan.reinit ? 'reinit' : 'release-quarantine');
    } catch (error) {
      rethrowTestCrash(error);
      // The request stays and is recognized as already applied at the next start. The
      // notice reaches the Owner notice and an escalation (ledgerAlerts.js).
      plan.report.notice('LEDGER_REQUEST_NOT_CONSUMED');
      ctx.logger.warn(`[SAFETY_LEDGER] purpose=${purposeId} code=LEDGER_REQUEST_NOT_CONSUMED`);
    }
  }

  // Creation: staged, then committed by renaming the database last.
  const toCreate = [...plans.values()].filter((plan) => plan.action === 'create' || plan.action === 'resume');
  if (toCreate.length) {
    let prepared = false;
    try {
      layout.ensureLedgerDirectories(ctx.directories);
      if (ctx.runtimeMode === 'test-control') {
        try {
          assertTestDataRootMarker(ctx.policy?.dataRoot, ctx.policy?.expectedApplicationId);
        } catch {
          throw failure('LEDGER_TEST_ROOT_INVALID', 'marker');
        }
      }
      prepared = true;
    } catch (error) {
      rethrowTestCrash(error);
      const described = describeFailure(error, 'LEDGER_PATH_INVALID');
      for (const plan of toCreate) drop(plan, described.code, described.reason);
    }
    if (prepared) {
      for (const plan of toCreate) {
        try {
          plan.receiptSha256 = await createLedger(ctx, plan);
        } catch (error) {
          rethrowTestCrash(error);
          drop(plan, 'LEDGER_CREATE_FAILED', describeFailure(error, 'LEDGER_CREATE_FAILED').reason);
        }
      }
    }
  }
  for (const plan of [...plans.values()]) {
    if (plan.action !== 'complete') continue;
    try {
      plan.receiptSha256 = receiptDigest(plan.paths.receipt);
    } catch (error) {
      rethrowTestCrash(error);
      const described = describeFailure(error, 'LEDGER_RECEIPT_MISMATCH');
      drop(plan, described.code, described.reason || 'file');
    }
  }

  // Registration batch 2: active, with the receipt digest, before any handle exists.
  const activations = [...plans.values()].filter((plan) => plan.receiptSha256);
  if (activations.length) {
    try {
      await ctx.book.apply(activations.map((plan) => plan.purposeId), (purposeId, current) => (
        current?.state === 'creating' && current.ledgerId === plans.get(purposeId).registration.ledgerId
          ? { ...current, state: 'active', receiptSha256: plans.get(purposeId).receiptSha256 } : null));
    } catch (error) {
      rethrowTestCrash(error);
      const described = describeFailure(error, 'LEDGER_REGISTRATION_WRITE_FAILED');
      for (const plan of activations) drop(plan, 'LEDGER_REGISTRATION_WRITE_FAILED', described.reason || 'write');
    }
    inject(ctx, 'after-active-registration');
  }

  // Open every ledger registered active.
  const entries = [];
  for (const [purposeId, plan] of plans) {
    const registration = ctx.book.current(purposeId);
    plan.report.identify(registration);
    if (registration?.state !== 'active') {
      drop(plan, 'LEDGER_REGISTRATION_WRITE_FAILED', 'state');
      continue;
    }
    const created = plan.action !== 'open';
    const code = plan.action === 'create' ? 'LEDGER_CREATED' : created ? 'LEDGER_CREATION_RESUMED' : 'LEDGER_READY';
    entries.push({
      purposeId,
      registration,
      opened: (ledger) => {
        ledgers.set(purposeId, ledger);
        plan.report.ready(code, created);
      },
      failed: (failedCode, reason) => plan.report.fail(failedCode, reason),
    });
  }
  if (entries.length) await openAll(ctx, entries);

  // Registration batch 3: lastSeen for every ledger that opened.
  if (!ledgers.size) return 'skipped';
  inject(ctx, 'before-last-seen');
  try {
    const atMs = safeNow(ctx.now);
    const written = await ctx.book.apply([...ledgers.keys()],
      (purposeId, current) => lastSeenUpdate(ledgers.get(purposeId), current, atMs));
    return written.written ? 'written' : 'unchanged';
  } catch (error) {
    rethrowTestCrash(error);
    // The registration only lags; detection of a later restore is weaker until the next
    // successful write, and nothing is disabled for it.
    ctx.logger.warn('[SAFETY_LEDGER] code=LEDGER_LAST_SEEN_WRITE_FAILED');
    return 'failed';
  }
}

async function bootstrapSafetyLedgers(options = {}) {
  const ctx = {
    ...normalizeBootstrapOptions(options),
    protectedEffects: 'on',
    book: null,
    directories: null,
  };
  ctx.legacyVariables = detectLegacyVariables(ctx.env);
  const startedAtMs = Date.now();
  const reports = layout.PURPOSE_IDS.map((purposeId) => new PurposeReport(purposeId));
  const ledgers = new Map();
  if (ctx.legacyVariables.length) {
    ctx.logger.warn(`[SAFETY_LEDGER] code=LEDGER_LEGACY_VARIABLES_IGNORED names=${ctx.legacyVariables.join(',')}`);
  }
  const effects = resolveProtectedEffects(ctx.env);
  if (effects.invalid) ctx.logger.warn('[SAFETY_LEDGER] code=LEDGER_PROTECTED_EFFECTS_INVALID treated=off');
  if (!effects.enabled) {
    // Kill switch: no file, directory, registration, or database is touched.
    ctx.protectedEffects = 'off';
    for (const item of reports) item.disable('LEDGER_PROTECTED_EFFECTS_OFF');
    ctx.logger.warn('[SAFETY_LEDGER] code=LEDGER_PROTECTED_EFFECTS_OFF');
    return buildResult(ctx, reports, ledgers, 'skipped', startedAtMs);
  }
  let lastSeen;
  try {
    lastSeen = await runBootstrap(ctx, reports, ledgers);
  } catch (error) {
    // A simulated crash leaves the files as they are; only this process's locks go away.
    for (const ledger of ledgers.values()) {
      try { ledger.close(); } catch {}
    }
    rethrowTestCrash(error);
    // Anything unexpected fails every purpose closed.
    ledgers.clear();
    for (const item of reports) {
      if (item.status !== 'disabled' && item.status !== 'failed') item.fail('LEDGER_BOOTSTRAP_FAILED');
    }
    ctx.logger.error('[SAFETY_LEDGER] code=LEDGER_BOOTSTRAP_FAILED');
    lastSeen = 'skipped';
  }
  return buildResult(ctx, reports, ledgers, lastSeen, startedAtMs);
}

// ---------------------------------------------------------------------------
// Read-only description for scripts/safety-ledger.js
// ---------------------------------------------------------------------------

// What status reports about one purpose without changing anything: its registration,
// which files exist (lstat only), the quarantine places, pending requests, and the
// receipt digest. The script adds the store inspection.
function describePurposeFiles(directories, purposeId, registrationEntry) {
  const paths = layout.purposePaths(directories, purposeId);
  let registration = null;
  let registrationProblem = null;
  if (registrationEntry) {
    try {
      registration = layout.decodeRegistration(purposeId, registrationEntry.value);
    } catch (error) {
      registrationProblem = error?.reason || 'invalid';
    }
  }
  const files = observeFiles(paths);
  let receiptSha256 = null;
  if (files.final.receipt) {
    try {
      receiptSha256 = receiptDigest(paths.receipt);
    } catch {
      receiptSha256 = null;
    }
  }
  return Object.freeze({ purposeId, paths, registration, registrationProblem, files, receiptSha256 });
}

module.exports = {
  IN_USE_DEADLINE_MS,
  LEGACY_LEDGER_VARIABLES,
  REPORT_VERSION,
  TEST_CONTROL_DISABLED_PURPOSES,
  TEST_CRASH_CODE,
  bootstrapSafetyLedgers,
  describeFailure,
  describePurposeFiles,
  detectLegacyVariables,
  resolveProtectedEffects,
};
