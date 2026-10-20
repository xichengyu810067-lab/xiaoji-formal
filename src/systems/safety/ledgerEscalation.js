'use strict';

/*
 * Fixed, path-free descriptions of side-effect ledger failures, and the ledger
 * escalations that must reach an operator even where logs are hidden.
 *
 * Under test-control the launcher passes on only fixed [TEST_CONTROL] lines from the
 * bot's output, so a ledger log line never reaches the operator there. Three events are
 * therefore escalated: a quarantine marker that could not be written while running
 * (SIDE_EFFECT_QUARANTINE_PERSIST_FAILED, stage runtime), a marker still missing after
 * the ledger closed (the same code, stage close), and a rollback found when a ledger is
 * opened (SIDE_EFFECT_ROLLBACK_DETECTED with its reason, stage open). Each runtime
 * records them; on shutdown the process logs one line per escalation and exits with
 * LEDGER_ESCALATION_EXIT_CODE instead of 0. ledgerAlerts.js records the rest with
 * record(): a purpose the bootstrap failed closed (its LEDGER_* code), a reinit or release
 * request that could not be consumed, a lastSeen that could not be written, a bot identity
 * that differs at ready, and a quarantine that reached none of its three places.
 *
 * The exit code was chosen over an Owner notice or a health flag because it depends on
 * nothing that may itself be failing (the Owner ledger, the coin database, the network,
 * or a status page that test-control does not run), the test-control supervisor reports
 * any non-zero exit as TEST_CHILD_EXIT_NONZERO and TEST_RUNTIME_EXITED_FAILED, and a
 * service manager sees a failed stop. Only fixed codes are kept: never a path, an ID, or
 * message content.
 */

const LEDGER_ESCALATION_EXIT_CODE = 3;
const QUARANTINE_PERSIST_FAILED = 'SIDE_EFFECT_QUARANTINE_PERSIST_FAILED';
const ROLLBACK_DETECTED = 'SIDE_EFFECT_ROLLBACK_DETECTED';
const CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const REASON_TOKEN = /^[a-z][a-z0-9-]{0,31}$/u;
const PURPOSE_TOKEN = /^[A-Za-z0-9:._/-]{1,64}$/u;
const STAGES = new Set(['open', 'runtime', 'close']);
const SQLITE_PRIMARY_NAMES = Object.freeze({
  5: 'BUSY',
  6: 'LOCKED',
  10: 'IOERR',
  11: 'CORRUPT',
  13: 'FULL',
  14: 'CANTOPEN',
  26: 'NOTADB',
});

function failureCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (CODE_TOKEN.test(code)) return code;
  const message = typeof error?.message === 'string' ? error.message : '';
  return CODE_TOKEN.test(message) ? message : 'UNEXPECTED_ERROR';
}

// The error's own code (for the facade, the mapped SIDE_EFFECT_* code), plus what its
// causes add without exposing any text: the SQLite primary result (IOERR, CORRUPT, ...)
// and a store reason such as the kind of rollback. Messages and paths are never read.
function describeLedgerFailure(error) {
  const description = { code: failureCode(error) };
  let current = error;
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth += 1) {
    if (!description.sqlite && Number.isInteger(current.errcode)) {
      description.sqlite = SQLITE_PRIMARY_NAMES[current.errcode & 0xff] || 'OTHER';
    }
    const reason = current.detail?.reason;
    if (!description.reason && typeof reason === 'string' && REASON_TOKEN.test(reason)) {
      description.reason = reason;
    }
    current = current.cause;
  }
  return Object.freeze(description);
}

// Log fragment for a failure: "cause=CODE", then " sqlite=..." and " reason=..." if known.
function formatLedgerFailure(error) {
  const { code, sqlite, reason } = describeLedgerFailure(error);
  return `cause=${code}${sqlite ? ` sqlite=${sqlite}` : ''}${reason ? ` reason=${reason}` : ''}`;
}

// The log line of one escalation.
function formatLedgerEscalation({ purposeId, code, stage, reason }) {
  return `[SIDE_EFFECT_LEDGER] code=LEDGER_ESCALATION purpose=${purposeId} cause=${code} ` +
    `stage=${stage}${reason ? ` reason=${reason}` : ''}`;
}

// Per-runtime record of escalations, kept until shutdown. Each distinct
// (purpose, code, stage, reason) is kept once; onRecord, if given, sees each new one at
// the moment it is recorded (ledgerAlerts.js logs it then, not only at shutdown).
function createLedgerEscalations({ onRecord = null } = {}) {
  const entries = new Map();
  const record = (purposeId, code, stage, reason = null) => {
    const purpose = String(purposeId || '');
    if (!PURPOSE_TOKEN.test(purpose) || !CODE_TOKEN.test(String(code || '')) || !STAGES.has(stage)) return;
    const safeReason = typeof reason === 'string' && REASON_TOKEN.test(reason) ? reason : null;
    const key = `${purpose}|${code}|${stage}|${safeReason || ''}`;
    if (entries.has(key)) return;
    const entry = Object.freeze({ purposeId: purpose, code, stage, reason: safeReason });
    entries.set(key, entry);
    if (typeof onRecord === 'function') {
      try { onRecord(entry); } catch {}
    }
  };
  return Object.freeze({
    // The runtime could not write the quarantine marker of a ledger it had to stop.
    quarantineFailed(purposeId) {
      record(purposeId, QUARANTINE_PERSIST_FAILED, 'runtime');
    },
    // Opening a ledger failed; only a detected rollback is escalated.
    openFailed(purposeId, error) {
      const { code, reason } = describeLedgerFailure(error);
      if (code === ROLLBACK_DETECTED) record(purposeId, code, 'open', reason || null);
    },
    // After close(): a quarantine the marker never reached will not block the next start.
    closed(purposeId, ledger) {
      if (ledger?.quarantineFailure) record(purposeId, QUARANTINE_PERSIST_FAILED, 'close');
    },
    // Any other fixed code (the bootstrap's LEDGER_* failures, a bot identity that differs
    // at ready, a lastSeen that could not be written): purposeId may be 'all'.
    record(purposeId, code, stage, reason = null) {
      record(purposeId, code, stage, reason);
    },
    list() {
      return Object.freeze([...entries.values()]);
    },
  });
}

// Logs every escalation recorded by the given runtimes and returns how many there were.
function reportLedgerEscalations(sources, logger) {
  const escalations = [];
  for (const source of sources) {
    try {
      const listed = source?.getLedgerEscalations?.();
      if (Array.isArray(listed)) escalations.push(...listed);
    } catch {}
  }
  for (const escalation of escalations) logger?.error?.(formatLedgerEscalation(escalation));
  return escalations.length;
}

// A clean shutdown still exits non-zero when any ledger escalation is pending; an exit
// code that already reports a failure is kept.
function shutdownExitCode(exitCode, escalationCount) {
  return exitCode === 0 && escalationCount > 0 ? LEDGER_ESCALATION_EXIT_CODE : exitCode;
}

// Reports the escalations of the given runtimes and records the resulting exit code on
// processRef.exitCode at once, before any later shutdown step can throw and skip
// process.exit. A failure code already chosen by the caller, or already set on
// processRef.exitCode (for example by an uncaught exception), is kept; only an otherwise
// clean exit becomes LEDGER_ESCALATION_EXIT_CODE. Returns the code.
function settleLedgerShutdown({ sources, logger, processRef, exitCode = 0 }) {
  const count = reportLedgerEscalations(sources, logger);
  const code = shutdownExitCode(Number(exitCode) || Number(processRef.exitCode) || 0, count);
  processRef.exitCode = code;
  return code;
}

module.exports = {
  LEDGER_ESCALATION_EXIT_CODE,
  createLedgerEscalations,
  describeLedgerFailure,
  formatLedgerEscalation,
  formatLedgerFailure,
  reportLedgerEscalations,
  settleLedgerShutdown,
  shutdownExitCode,
};
