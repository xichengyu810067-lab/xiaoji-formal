'use strict';

/*
 * The Owner DM start guard: after three starts in a row failed, the next start sends nothing to
 * the Owner's DMs until it has itself succeeded.
 *
 * A start begins with the process and succeeds once Discord is ready and the process has kept
 * running for STABLE_AFTER_READY_MS (10 minutes) since, without a stop. A process that ends
 * before that for any reason (a failed start, a non-zero exit, a crash, a kill) is a failed
 * start. A stop asked for with SIGINT or SIGTERM before that is neither: the count is put back
 * as it was.
 *
 * The count is kept across processes in one small JSON file in the ledger base
 * (ledgerLayout.resolveLedgerBase: XIAOJI_DATA_ROOT, or the coin database's folder), under the
 * same rules as the ledgers: an existing local folder, no junction or link, outside the program
 * folder, and never a folder carrying the test-control marker:
 *   <base>/owner-dm-start-guard.json   {"schema":1,"consecutiveFailures":N,"updatedAtMs":T}
 * It is written as <file>.tmp, fsynced, and renamed over the file, so it is never half written.
 *
 * begin() runs synchronously before anything else in index.js can fail. It reads N, the starts
 * that failed in a row before this one, and writes N + 1 at once: this start already counts as
 * failed, so a process that ends in any way before it succeeds needs no last write. Then:
 *   - N < 3: Owner DMs as usual.
 *   - N >= 3: no Owner DM at all during this start (safety notices, ledger notices, the
 *     emergency DM). Each one is dropped by the code that would have sent it, with a fixed log
 *     line (at most one a minute per kind, counting the lines left out), takes nothing from the
 *     Owner notice budget, and is never sent later. One line at the start says so.
 * noteReady() (ClientReady) starts the ten-minute wait; when it ends the count is written as 0
 * and Owner DMs resume in this process. noteSignalStop() writes N back.
 *
 * Nothing here can stop a start. What cannot be relied on degrades:
 *   - No usable location (the base is missing, inside the program folder, linked, remote, or a
 *     test-control data root): nothing is counted and Owner DMs go on as before, with one log
 *     line. The Owner ledger needs the same base, so it cannot open either; the only DM left is
 *     the emergency DM, which its own durable stamp already holds to one per 6 hours.
 *   - A file that cannot be read or trusted, or a count that cannot be written at the start:
 *     this start is treated as past the threshold (no Owner DM), with a log line, because a loop
 *     of failing starts could otherwise go uncounted. A start that succeeds writes 0 again.
 * Under test-control nothing is read or written: test-control sends no Owner DM at all.
 * Log lines carry fixed codes and numbers only, never a path or any content.
 */

const fs = require('node:fs');
const path = require('node:path');
const defaultLogger = require('../../utils/logger');
const { runWithBackgroundContext } = require('../../platform/hostOperationContext');
const { getCoinDatabasePath } = require('../../services/coinDatabase');
const { resolveLedgerBase } = require('./ledgerLayout');
const { fsyncDirectory } = require('./ledgerStore');

const GUARD_FILE_NAME = 'owner-dm-start-guard.json';
const GUARD_SCHEMA = 1;
const GUARD_KEYS = 'consecutiveFailures,schema,updatedAtMs';
// Starts that failed in a row, before this one, from which a start sends no Owner DM.
const FAILURE_THRESHOLD = 3;
const STABLE_AFTER_READY_MS = 10 * 60 * 1_000;
const MAX_FAILURE_COUNT = 1_000_000;
const MAX_FILE_BYTES = 1_024;
// A rename refused on Windows (a scanner holding the file a moment) is retried this often,
// waiting synchronously: begin() must finish before the next line of index.js can fail.
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const BACKGROUND_JOB = 'safety.owner-dm-start-guard';
const CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const REASON_TOKEN = /^[a-z][a-z0-9-]{0,31}$/u;

function guardError(code) {
  return Object.assign(new Error(code), { code });
}

function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return CODE_TOKEN.test(code) ? code : 'UNEXPECTED_ERROR';
}

function blockingPause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The count in a file's text, or null when the text is not exactly a version-1 record.
function parseGuardState(text) {
  let value;
  try {
    value = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== GUARD_KEYS ||
      value.schema !== GUARD_SCHEMA || !Number.isSafeInteger(value.consecutiveFailures) || value.consecutiveFailures < 0 ||
      value.consecutiveFailures > MAX_FAILURE_COUNT || !Number.isSafeInteger(value.updatedAtMs) || value.updatedAtMs < 0) {
    return null;
  }
  return value.consecutiveFailures;
}

// { kind: 'absent' }, { kind: 'ok', failures }, or { kind: 'invalid' } (not a regular file, too
// large, or not a version-1 record). Any other error reading it is thrown.
function readGuardFile(filePath, filesystem = fs) {
  let stat;
  try {
    stat = filesystem.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ kind: 'absent' });
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return Object.freeze({ kind: 'invalid' });
  const failures = parseGuardState(filesystem.readFileSync(filePath, 'utf8'));
  return failures === null ? Object.freeze({ kind: 'invalid' }) : Object.freeze({ kind: 'ok', failures });
}

// A leftover temporary file (a write that was cut off) is replaced; anything at that name that
// is not a regular file is refused.
function openTemporary(tempPath, filesystem) {
  try {
    return filesystem.openSync(tempPath, 'wx', 0o600);
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = filesystem.lstatSync(tempPath);
  if (!stat.isFile()) throw guardError('OWNER_DM_GUARD_FILE_INVALID');
  filesystem.unlinkSync(tempPath);
  return filesystem.openSync(tempPath, 'wx', 0o600);
}

function renameInto(from, to, { filesystem, platform, pause }) {
  let delay = 20;
  for (let attempt = 1; ; attempt += 1) {
    try {
      filesystem.renameSync(from, to);
      return;
    } catch (error) {
      if (platform !== 'win32' || !RENAME_RETRY_CODES.has(error?.code) || attempt >= RENAME_ATTEMPTS) throw error;
      pause(delay);
      delay *= 2;
    }
  }
}

// Writes the count durably: <file>.tmp, fsync, rename over the file, then the folder's fsync
// (best effort; Windows journals it). Refuses a file name taken by anything but a regular file.
function writeGuardFile(filePath, failures, nowMs, { filesystem = fs, platform = process.platform,
  pause = blockingPause, syncDirectory = fsyncDirectory } = {}) {
  if (!Number.isSafeInteger(failures) || failures < 0 || failures > MAX_FAILURE_COUNT ||
      !Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw guardError('OWNER_DM_GUARD_VALUE_INVALID');
  }
  let existing = null;
  try {
    existing = filesystem.lstatSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing && !existing.isFile()) throw guardError('OWNER_DM_GUARD_FILE_INVALID');
  const tempPath = `${filePath}.tmp`;
  const content = `${JSON.stringify({ schema: GUARD_SCHEMA, consecutiveFailures: failures, updatedAtMs: nowMs })}\n`;
  const descriptor = openTemporary(tempPath, filesystem);
  let renamed = false;
  try {
    try {
      filesystem.writeSync(descriptor, content);
      filesystem.fsyncSync(descriptor);
    } finally {
      filesystem.closeSync(descriptor);
    }
    renameInto(tempPath, filePath, { filesystem, platform, pause });
    renamed = true;
  } finally {
    if (!renamed) {
      try { filesystem.unlinkSync(tempPath); } catch {}
    }
  }
  try { syncDirectory(path.dirname(filePath)); } catch {}
}

function guardPathIn(base) {
  return path.join(base, GUARD_FILE_NAME);
}

// What the next start will find in <base> (safety-ledger status). Read only.
function inspectOwnerDmStartGuard(base, { filesystem = fs } = {}) {
  let read;
  try {
    read = readGuardFile(guardPathIn(base), filesystem);
  } catch (error) {
    return Object.freeze({ state: 'unreadable', cause: errorCode(error), consecutiveFailures: null,
      threshold: FAILURE_THRESHOLD, suppressNextStart: true });
  }
  const failures = read.kind === 'ok' ? read.failures : read.kind === 'absent' ? 0 : null;
  return Object.freeze({ state: read.kind, cause: null, consecutiveFailures: failures, threshold: FAILURE_THRESHOLD,
    suppressNextStart: failures === null || failures >= FAILURE_THRESHOLD });
}

// Sets the count in <base> back to 0 (safety-ledger reset-start-failures, with the bot stopped).
// An absent file is left absent. Returns what was there before.
function resetOwnerDmStartGuard(base, { filesystem = fs, now = () => Date.now(), ...writeOptions } = {}) {
  const before = inspectOwnerDmStartGuard(base, { filesystem });
  if (before.state === 'absent') return Object.freeze({ before, written: false });
  writeGuardFile(guardPathIn(base), 0, now(), { filesystem, ...writeOptions });
  return Object.freeze({ before, written: true });
}

function createOwnerDmStartGuard({
  runtimeMode = 'production',
  env = process.env,
  coinDbPath = null,
  projectRoot = null,
  logger = defaultLogger,
  now = () => Date.now(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  stableAfterReadyMs = STABLE_AFTER_READY_MS,
  filesystem = fs,
  platform = process.platform,
  pause = blockingPause,
  syncDirectory = fsyncDirectory,
} = {}) {
  const writeOptions = { filesystem, platform, pause, syncDirectory };
  const state = {
    // idle (begin() not run yet), inactive (test-control), unavailable (no usable location),
    // or active.
    mode: 'idle',
    filePath: null,
    previousFailures: null,
    wroteAtStart: false,
    suppressed: false,
    // starting, succeeded (ready for the whole wait), or stopped (SIGINT or SIGTERM first).
    phase: 'starting',
    timer: null,
  };

  const line = (code, detail = '') => `[OWNER_DM_GUARD] code=${code}${detail}`;
  const warn = (code, detail) => {
    try { logger?.warn?.(line(code, detail)); } catch {}
  };
  const info = (code, detail) => {
    try { logger?.info?.(line(code, detail)); } catch {}
  };

  function write(failures, stage) {
    try {
      writeGuardFile(state.filePath, failures, now(), writeOptions);
      return true;
    } catch (error) {
      warn('OWNER_DM_GUARD_WRITE_FAILED', ` stage=${stage} cause=${errorCode(error)}`);
      return false;
    }
  }

  function snapshot() {
    return Object.freeze({ mode: state.mode, phase: state.phase, previousFailures: state.previousFailures,
      suppressed: state.mode === 'active' && state.suppressed, threshold: FAILURE_THRESHOLD });
  }

  function succeed() {
    if (state.mode !== 'active' || state.phase !== 'starting') return;
    state.phase = 'succeeded';
    const wasSuppressed = state.suppressed;
    const written = write(0, 'reset');
    // A process that kept running for the whole wait is not in a loop of failing starts, so its
    // Owner DMs resume even when the 0 could not be written (the next start then finds the
    // old count and holds its DMs back until it succeeds as well).
    state.suppressed = false;
    if (wasSuppressed) info('OWNER_DM_GUARD_RESUMED', ` failures=${state.previousFailures}`);
    else if (written && state.previousFailures > 0) info('OWNER_DM_GUARD_RESET', ` failures=${state.previousFailures}`);
  }

  function begin() {
    if (state.mode !== 'idle') return snapshot();
    if (runtimeMode === 'test-control') {
      state.mode = 'inactive';
      return snapshot();
    }
    let base;
    try {
      base = resolveLedgerBase({ env, runtimeMode: 'production', coinDbPath: coinDbPath ?? getCoinDatabasePath(),
        ...(projectRoot ? { projectRoot } : {}) });
    } catch (error) {
      state.mode = 'unavailable';
      const reason = typeof error?.reason === 'string' && REASON_TOKEN.test(error.reason) ? ` reason=${error.reason}` : '';
      warn('OWNER_DM_GUARD_UNAVAILABLE', ` cause=${errorCode(error)}${reason}`);
      return snapshot();
    }
    state.mode = 'active';
    state.filePath = guardPathIn(base);
    let read;
    try {
      read = readGuardFile(state.filePath, filesystem);
    } catch (error) {
      read = Object.freeze({ kind: 'unreadable', cause: errorCode(error) });
    }
    // A count that cannot be known is taken as the threshold: a loop of failing starts might be
    // behind it.
    const previous = read.kind === 'ok' ? read.failures : read.kind === 'absent' ? 0 : FAILURE_THRESHOLD;
    state.previousFailures = previous;
    let reason = read.kind === 'invalid' ? 'state-invalid' : read.kind === 'unreadable' ? 'state-unreadable'
      : previous >= FAILURE_THRESHOLD ? 'start-failures' : null;
    state.wroteAtStart = write(Math.min(previous + 1, MAX_FAILURE_COUNT), 'start');
    if (!state.wroteAtStart && !reason) reason = 'write-failed';
    if (reason) {
      state.suppressed = true;
      warn('OWNER_DM_GUARD_SUPPRESSING', ` reason=${reason} failures=${previous} threshold=${FAILURE_THRESHOLD}` +
        `${read.kind === 'unreadable' ? ` cause=${read.cause}` : ''}`);
    }
    return snapshot();
  }

  return Object.freeze({
    // Synchronous; never throws.
    begin() {
      try {
        return begin();
      } catch (error) {
        // Only an unexpected fault gets here, and the start goes on. Once the file was found, a
        // count that may not have been written holds the DMs back, as a failed write does;
        // before that, there is no location, as when none is usable.
        if (state.mode === 'active') {
          state.suppressed = true;
          warn('OWNER_DM_GUARD_SUPPRESSING', ` reason=unexpected threshold=${FAILURE_THRESHOLD} cause=${errorCode(error)}`);
        } else {
          state.mode = 'unavailable';
          warn('OWNER_DM_GUARD_UNAVAILABLE', ` cause=${errorCode(error)}`);
        }
        return snapshot();
      }
    },

    // ClientReady: the start succeeds once the process has run for the whole wait after it.
    noteReady() {
      if (state.mode !== 'active' || state.phase !== 'starting' || state.timer) return;
      try {
        state.timer = setTimer(() => runWithBackgroundContext(BACKGROUND_JOB, () => {
          state.timer = null;
          succeed();
        }), stableAfterReadyMs);
        state.timer?.unref?.();
      } catch {
        state.timer = null;
      }
    },

    // SIGINT or SIGTERM: a stop asked for is neither a failed nor a successful start, so the
    // count goes back to what this start found. After the start succeeded nothing changes.
    noteSignalStop() {
      if (state.mode !== 'active' || state.phase !== 'starting') return;
      state.phase = 'stopped';
      if (state.timer) {
        try { clearTimer(state.timer); } catch {}
        state.timer = null;
      }
      if (state.wroteAtStart) write(state.previousFailures, 'stop');
    },

    // Whether an Owner DM may be sent now. False only while a start held back by the guard has
    // not yet succeeded.
    allowsOwnerDm() {
      return !(state.mode === 'active' && state.suppressed);
    },

    status: snapshot,
  });
}

module.exports = {
  FAILURE_THRESHOLD,
  GUARD_FILE_NAME,
  STABLE_AFTER_READY_MS,
  createOwnerDmStartGuard,
  inspectOwnerDmStartGuard,
  parseGuardState,
  readGuardFile,
  resetOwnerDmStartGuard,
  writeGuardFile,
};
