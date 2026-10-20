'use strict';

/*
 * The life cycle of the protected side effects; index.js only wires it.
 *
 * start(), inside the public preflight, after the coin database is open and before login:
 *   1. The bot identity: GET /users/@me with the bot token, at most 3 attempts within 10
 *      seconds (transient failures only). If it cannot be read, DISCORD_CLIENT_ID (or
 *      CLIENT_ID) stands in and is checked again at ready; then the bootstrap only opens
 *      ledgers that already exist and creates none (LEDGER_IDENTITY_UNVERIFIED), so no
 *      ledger is ever bound to an unverified ID. Without either ID every purpose fails
 *      closed (LEDGER_IDENTITY_INVALID). The token is never logged.
 *   2. bootstrapSafetyLedgers. A rejection fails every purpose closed
 *      (LEDGER_BOOTSTRAP_FAILED) and never stops the login. ledgerAlerts.prepare(report);
 *      a report it cannot classify is replaced by a failed one, and the ledgers are closed.
 *   3. The caller hands the delivered ledgers to the runtimes (owner, welcome, public).
 *   4. The hourly lastSeen refresh (background job safety.ledger-last-seen, unref'd; it
 *      writes only when a ledger moved).
 *   An identity read or an alert step that throws is handled like a failed bootstrap: the
 *   login never depends on any of them.
 * onClientReady(), from a prepended ClientReady listener, synchronously: the logged-in
 *   bot must be the one the ledgers were opened for. Then the runtimes are armed;
 *   otherwise every one is turned off and only an emergency notice is sent. The start's
 *   notices go out in the background (safety.ledger-alerts).
 * stop(): quiesce the runtimes (each waits for its send in flight, which its own dispatch
 *   timeout bounds); then, under one deadline that starts only now (5 s, or 3 s under
 *   test-control), write lastSeen and wait for quarantine flags; stop the runtimes
 *   (closing their ledgers); wait for the flags once more within what is left; report a
 *   quarantine that reached none of its places; close the ledgers no runtime took. Every
 *   step has its own bound and error handling, and stop() never rejects. The escalations
 *   reach settleLedgerShutdown through getLedgerEscalations().
 */

const { Routes } = require('discord.js');
const defaultLogger = require('../../utils/logger');
const { runWithBackgroundContext } = require('../../platform/hostOperationContext');
const { bootstrapSafetyLedgers, resolveProtectedEffects } = require('./ledgerBootstrap');
const { createLedgerAlerts, failedBootstrapReport } = require('./ledgerAlerts');

const SNOWFLAKE = /^\d{17,20}$/u;
const IDENTITY_ATTEMPTS = 3;
const IDENTITY_DEADLINE_MS = 10_000;
const IDENTITY_RETRY_DELAY_MS = 500;
const LAST_SEEN_INTERVAL_MS = 60 * 60 * 1_000;
const STOP_DEADLINE_MS = Object.freeze({ production: 5_000, 'test-control': 3_000 });
const TIMED_OUT = Symbol('timed out');

// A failure worth another attempt: no HTTP status (network, timeout), 429, or 5xx.
function transientRestFailure(error) {
  const status = Number(error?.status ?? error?.httpStatus);
  if (!Number.isInteger(status)) return true;
  return status === 429 || status >= 500;
}

// Resolves with TIMED_OUT if the promise has not settled within timeoutMs. The timer runs
// in a background job context and only settles; the promise itself keeps running.
function within(promise, timeoutMs, job) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => runWithBackgroundContext(job, () => resolve(TIMED_OUT)), Math.max(0, timeoutMs));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sleepFor(job) {
  return (ms) => new Promise((resolve) => {
    setTimeout(() => runWithBackgroundContext(job, resolve), Math.max(0, ms));
  });
}

const defaultSleep = sleepFor('safety.ledger-identity');

// The bot user the token logs in as. A response without a usable ID, or a failure that is
// not transient, is not retried. Falls back to the configured application ID.
async function resolveBotIdentity({ rest, configuredClientId, logger, attempts = IDENTITY_ATTEMPTS,
  deadlineMs = IDENTITY_DEADLINE_MS, monotonic = () => performance.now(), sleep = defaultSleep } = {}) {
  const configured = SNOWFLAKE.test(String(configuredClientId || '')) ? String(configuredClientId) : null;
  const deadline = monotonic() + deadlineMs;
  for (let attempt = 1; attempt <= attempts && typeof rest?.get === 'function'; attempt += 1) {
    const remaining = deadline - monotonic();
    if (remaining <= 0) break;
    let failure = null;
    let user;
    try {
      // Routes.user() is GET /users/@me (test-control's egress allows it).
      user = await within(Promise.resolve(rest.get(Routes.user())), remaining, 'safety.ledger-identity');
    } catch (error) {
      failure = error;
    }
    if (user === TIMED_OUT) break;
    if (!failure) {
      const id = String(user?.id || '');
      if (!SNOWFLAKE.test(id)) break;
      if (configured && configured !== id) logger?.warn?.('[SAFETY_LEDGER] code=LEDGER_CLIENT_ID_DIFFERS');
      return Object.freeze({ botId: id, source: 'token' });
    }
    if (!transientRestFailure(failure) || attempt === attempts) break;
    const wait = Math.min(IDENTITY_RETRY_DELAY_MS * attempt, deadline - monotonic());
    if (wait <= 0) break;
    await sleep(wait);
  }
  if (configured) {
    logger?.warn?.('[SAFETY_LEDGER] code=LEDGER_BOT_IDENTITY_FALLBACK source=configured');
    return Object.freeze({ botId: configured, source: 'configured' });
  }
  logger?.error?.('[SAFETY_LEDGER] code=LEDGER_BOT_IDENTITY_UNAVAILABLE');
  return Object.freeze({ botId: null, source: 'none' });
}

function createProtectedEffects({
  runtimeMode,
  env = process.env,
  logger = defaultLogger,
  reporter = null,
  ownerId = null,
  configuredClientId = null,
  policy = null,
  rest = null,
  isStopping = () => false,
  assertRunning = () => true,
  bootstrap = bootstrapSafetyLedgers,
  bootstrapOptions = {},
  resolveIdentity = resolveBotIdentity,
  alerts = null,
  alertOptions = {},
  lastSeenIntervalMs = LAST_SEEN_INTERVAL_MS,
  stopDeadlineMs = STOP_DEADLINE_MS[runtimeMode] ?? STOP_DEADLINE_MS.production,
  monotonic = () => performance.now(),
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  const ledgerAlerts = alerts || createLedgerAlerts({ runtimeMode, logger, reporter, ownerId, ...alertOptions });
  const runtimes = { owner: null, welcome: null, public: null };
  const list = () => [runtimes.owner, runtimes.welcome, runtimes.public].filter(Boolean);
  const state = {
    started: false,
    identity: null,
    result: null,
    timer: null,
    stopping: false,
    readyHandled: false,
    flush: null,
    stop: null,
    report: null,
  };

  function noteRuntimeDisabled(purposeId, code) {
    try {
      Promise.resolve(ledgerAlerts.noteRuntimeDisabled(purposeId, code)).catch(() => {});
    } catch {}
  }

  async function refreshLastSeen() {
    if (state.stopping || !state.result) return;
    try {
      await state.result.recordLastSeen();
    } catch {
      logger?.warn?.('[SAFETY_LEDGER] code=LEDGER_LAST_SEEN_WRITE_FAILED stage=runtime');
      ledgerAlerts.noteLastSeenFailed('runtime');
    }
  }

  // A report for a start whose ledgers could not be used at all: every purpose failed
  // closed, or disabled when the kill switch is set (then nothing is told to anyone).
  function failedReport() {
    return failedBootstrapReport({ runtimeMode,
      protectedEffects: resolveProtectedEffects(env).enabled ? 'on' : 'off' });
  }

  // ledgerAlerts.prepare(), which classifies a whole report before it records anything:
  // true when it took the report.
  function prepareAlerts(report) {
    try {
      ledgerAlerts.prepare(report);
      return true;
    } catch {
      logger?.error?.('[SAFETY_LEDGER] code=LEDGER_ALERTS_FAILED stage=prepare');
      return false;
    }
  }

  return Object.freeze({
    // The three runtimes this life cycle drives. Each tells it about a purpose it had to
    // stop while running (ledgerAlerts.noteRuntimeDisabled).
    attachRuntimes({ owner = null, welcome = null, public: publicRuntime = null } = {}) {
      Object.assign(runtimes, { owner, welcome, public: publicRuntime });
      for (const runtime of list()) runtime.onPurposeDisabled = noteRuntimeDisabled;
    },

    // Before login. Returns the ledgers to hand to the runtimes' preflights (a Map from
    // purpose ID to ledger; empty when nothing could be opened). Never rejects for a
    // ledger problem: those fail their purposes closed.
    async start({ coinDbPath } = {}) {
      if (state.started) throw new Error('Protected effects were already started.');
      state.started = true;
      try {
        state.identity = await resolveIdentity({ rest, configuredClientId, logger });
      } catch {
        // Handled like an identity that cannot be read at all: the bootstrap then fails
        // every purpose closed (LEDGER_IDENTITY_INVALID) without touching a file.
        logger?.error?.('[SAFETY_LEDGER] code=LEDGER_BOT_IDENTITY_UNAVAILABLE');
        state.identity = Object.freeze({ botId: null, source: 'none' });
      }
      if (state.identity?.botId) {
        for (const runtime of list()) runtime.botId = state.identity.botId;
      }
      let result = null;
      try {
        result = await bootstrap({
          env,
          runtimeMode,
          botId: state.identity?.botId || '',
          // Only an ID read with the bot token may have ledgers created for it.
          identityVerified: state.identity?.source === 'token',
          ownerId,
          policy,
          logger,
          isStopping,
          assertRunning,
          // The waits for a ledger another process holds run in a background job context.
          sleep: sleepFor('safety.ledger-bootstrap'),
          ...(coinDbPath === undefined ? {} : { coinDbPath }),
          ...bootstrapOptions,
        });
      } catch {
        logger?.error?.('[SAFETY_LEDGER] code=LEDGER_BOOTSTRAP_FAILED stage=start');
      }
      const reported = result?.report || failedReport();
      if (prepareAlerts(reported)) {
        state.report = reported;
      } else {
        // A report that cannot be classified: nothing protected runs in this process.
        try { result?.close(); } catch {}
        result = null;
        state.report = failedReport();
        prepareAlerts(state.report);
      }
      state.result = result;
      if (result?.ledgers?.size && !state.stopping) {
        state.timer = setIntervalFn(() => runWithBackgroundContext('safety.ledger-last-seen', refreshLastSeen),
          lastSeenIntervalMs);
        state.timer?.unref?.();
      }
      return result?.ledgers instanceof Map ? result.ledgers : new Map();
    },

    // The prepended ClientReady listener; synchronous so it runs before any ready.js work.
    // Returns the background delivery of the start's notices (for tests).
    onClientReady(client) {
      if (state.readyHandled) return state.flush;
      state.readyHandled = true;
      const expected = state.identity?.botId || null;
      const loggedIn = String(client?.user?.id || '');
      try {
        if (expected && loggedIn === expected) {
          for (const runtime of list()) runtime.arm();
        } else if (expected) {
          for (const runtime of list()) runtime.disableAll('LEDGER_BOT_MISMATCH');
          logger?.error?.('[SAFETY_LEDGER] code=LEDGER_BOT_MISMATCH');
          Promise.resolve(ledgerAlerts.noteBotMismatch()).catch(() => {});
        }
      } catch {
        logger?.error?.('[SAFETY_LEDGER] code=LEDGER_READY_CHECK_FAILED');
      }
      state.flush = runWithBackgroundContext('safety.ledger-alerts', () => ledgerAlerts.flush({
        notifier: runtimes.owner, rest: client?.rest || rest,
      })).catch(() => {
        logger?.error?.('[SAFETY_LEDGER] code=LEDGER_ALERTS_FAILED');
        return null;
      });
      return state.flush;
    },

    noteRuntimeDisabled,

    async stop() {
      if (state.stop) return state.stop;
      state.stop = (async () => {
        state.stopping = true;
        if (state.timer) {
          clearIntervalFn(state.timer);
          state.timer = null;
        }
        ledgerAlerts.beginStop();
        for (const runtime of list()) {
          try {
            await runtime.quiesce();
          } catch {
            logger?.error?.('[SAFETY_LEDGER] code=LEDGER_STOP_STEP_FAILED step=quiesce');
          }
        }
        // The deadline starts once the runtimes are quiet: a send still in flight is waited
        // for above (each runtime's dispatch timeout bounds it) and must not use up the time
        // lastSeen and the quarantine flags have.
        const deadline = monotonic() + stopDeadlineMs;
        const remaining = () => Math.max(0, deadline - monotonic());
        const ledgers = state.result?.ledgers instanceof Map ? [...state.result.ledgers.values()] : [];
        const flags = () => ledgers.filter((ledger) => ledger.quarantined && ledger.quarantineFlag)
          .map((ledger) => ledger.quarantineFlag);
        if (state.result) {
          const lastSeen = Promise.resolve().then(() => state.result.recordLastSeen());
          const written = await within(Promise.allSettled([lastSeen, ...flags()]), remaining(), 'safety.ledger-stop');
          if (written === TIMED_OUT || written[0].status === 'rejected') {
            logger?.warn?.('[SAFETY_LEDGER] code=LEDGER_LAST_SEEN_WRITE_FAILED stage=close');
            ledgerAlerts.noteLastSeenFailed('close');
          }
        }
        for (const runtime of list()) {
          try {
            await runtime.stop();
          } catch {
            logger?.error?.('[SAFETY_LEDGER] code=LEDGER_STOP_STEP_FAILED step=stop');
          }
        }
        const pending = flags();
        if (pending.length) await within(Promise.allSettled(pending), remaining(), 'safety.ledger-stop');
        for (const ledger of ledgers) {
          if (!ledger.quarantined) continue;
          const persisted = ledger.quarantinePersistence;
          if (!persisted.marker && !persisted.stamp && persisted.registration !== true) {
            ledgerAlerts.noteQuarantineUnpersisted(ledger.purposeId);
          }
        }
        try {
          state.result?.close();
        } catch {
          logger?.error?.('[SAFETY_LEDGER] code=LEDGER_STOP_STEP_FAILED step=close');
        }
      })().catch(() => {
        logger?.error?.('[SAFETY_LEDGER] code=LEDGER_STOP_STEP_FAILED step=unexpected');
      });
      return state.stop;
    },

    // The status card override of welcome, word_chain, and number_chain (publicStatusService).
    featureStatus(featureKey) {
      try {
        return ledgerAlerts.featureStatus(featureKey);
      } catch {
        return null;
      }
    },

    getLedgerEscalations() {
      return ledgerAlerts.getLedgerEscalations();
    },

    // The bot identity used for the ledgers ({ botId, source }), for tests and logs.
    get identity() {
      return state.identity;
    },

    // The bootstrap report this start's alerts were prepared from (ledgerBootstrap.js, format
    // version 1), or null before start(). Read only; the liveness record reads the signs of a
    // restored backup in it (outageMonitor.restoreSignsOf).
    get bootReport() {
      return state.report;
    },
  });
}

module.exports = {
  IDENTITY_ATTEMPTS,
  IDENTITY_DEADLINE_MS,
  LAST_SEEN_INTERVAL_MS,
  STOP_DEADLINE_MS,
  createProtectedEffects,
  resolveBotIdentity,
};
