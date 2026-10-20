'use strict';

/*
 * The liveness record of the bot, and what it says about an outage that ended: a stop nobody
 * asked for that lasted at least ten minutes, or a loss of the Discord connection that did.
 *
 * Nothing here sends anything. It keeps one small JSON file and decides, at ready and on a
 * heartbeat, whether an outage has to be announced; the one that announces (outageNotice.js) is
 * handed over with attachDelivery() and only runs once the bot has been steady again.
 *
 * The file is <base>/outage-state.json, in the same base as the Owner DM start guard
 * (ledgerLayout.resolveLedgerBase: an existing local folder, no junction or link, outside the
 * program folder, never a folder carrying the test-control marker), written as <file>.tmp,
 * fsynced and renamed over the file, so it is never half written. It is not a ledger and has no
 * place in the coin database:
 *   { schema, bootId, startedAtMs, readyAtMs, lastHealthyAtMs, stop: { kind, atMs },
 *     pending, guildNoticeAtMs }
 *   - stop.kind is 'running' from the start of a process and becomes 'signal' when a stop is
 *     asked for by signal (SIGINT and SIGTERM, and on Windows SIGHUP and SIGBREAK), synchronously,
 *     before the stop itself begins. A process that is killed, crashes, loses its host or is cut
 *     off from the power leaves 'running' behind.
 *   - lastHealthyAtMs is the last heartbeat (every minute) at which the gateway was healthy
 *     (gatewayHealthy: the client ready and every shard Ready, which isReady() alone does not say:
 *     discord.js never resets it when a shard loses its connection). It is carried over untouched
 *     by a start that never became ready, so a run of failing starts measures its outage from the
 *     last time the bot really was up.
 *   - pending is the outage waiting to be told (see below), guildNoticeAtMs the time the last
 *     public notice was claimed for each server (kept 48 hours, at most 200), and restoreSeen the
 *     set of signs of a restored backup that was told last (and when).
 *
 * begin(), first thing in index.js and synchronous, reads the previous record and classifies the
 * previous run:
 *   absent, unreadable, not a version-1 record, or a clock set back: unknown, nothing is told;
 *   stop.kind 'signal': planned, nothing is told, and the measuring starts again at this start;
 *   stop.kind 'running': unplanned, the outage is lastHealthyAtMs to the moment of ClientReady.
 * noteReady() makes it a pending outage when it lasted at least MIN_OUTAGE_MS (10 minutes), and
 * extends one that is waiting to be told however short the new gap is (a start that crashes again
 * before the wait was over is the same outage; its start stays, its end moves). A pending that was
 * told in part, or that is still there after a run that was connected for the whole wait after it
 * was noted, is only waiting for the Owner: an outage that begins after that replaces it instead
 * of continuing it, so a notice that cannot be delivered never keeps later outages from being
 * told, and a short gap after it is a restart, which neither extends it nor makes a new one. A
 * heartbeat that finds the gateway healthy again after a gap makes a 'connection' outage the
 * same way, when the monotonic clock says ten minutes passed since the last healthy heartbeat; the
 * wall clock only places it in time, and a wall clock that moved more than the monotonic one is
 * only logged (it is neither an outage nor part of one's length). Evidence that the data was
 * restored (the ledger bootstrap report, see restoreEvidenceOf) makes a pending of kind
 * 'restore', which is told to the Owner only, and a set of signs is not told again for a week
 * (a restored backup shows the same signs at every start until reinit); a restore that never
 * reached the Owner and is dropped (replaced, expired) forgets its signs, so the next start tells
 * them.
 *
 * A pending outage is delivered, once, when the process has been ready for the 10 minutes of
 * the Owner DM start guard plus 30 seconds, the client is ready, and the guard allows Owner DMs.
 * A pending that is not delivered 72 hours after it ended is dropped with a log line.
 *
 * Nothing here can stop a start. What cannot be relied on degrades: without a usable base, or
 * under test-control (which reads and writes nothing), the monitor is off and says so once.
 * Log lines carry fixed codes and numbers only, never a path or content.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { Status } = require('discord.js');
const defaultLogger = require('../../utils/logger');
const { runWithBackgroundContext } = require('../../platform/hostOperationContext');
const { getCoinDatabasePath } = require('../../services/coinDatabase');
const { resolveLedgerBase } = require('./ledgerLayout');
const { fsyncDirectory } = require('./ledgerStore');
const { STABLE_AFTER_READY_MS: START_GUARD_STABLE_MS } = require('./ownerDmStartGuard');
const { resolveProtectedEffects } = require('./ledgerBootstrap');

const STATE_FILE_NAME = 'outage-state.json';
const STATE_SCHEMA = 1;
// Room for 200 entries in each of the two server maps, with the rest of the record.
const MAX_FILE_BYTES = 32 * 1_024;
const HEARTBEAT_MS = 60 * 1_000;
const MIN_OUTAGE_MS = 10 * 60 * 1_000;
// The Owner DM start guard calls a start successful after ten minutes of readiness; the notice
// waits for the same standard and a little longer, so the guard has settled first.
const STABLE_AFTER_READY_MS = START_GUARD_STABLE_MS + 30 * 1_000;
const PENDING_EXPIRES_MS = 72 * 60 * 60 * 1_000;
const CLOCK_TOLERANCE_MS = 5 * 60 * 1_000;
const GUILD_NOTICE_KEEP_MS = 48 * 60 * 60 * 1_000;
const MAX_GUILD_ENTRIES = 200;
const MAX_RECOVERY_CODES = 8;
// The signs of a restored backup stay there until the ledgers are reinitialized, so every start
// shows the same ones. A set that was told is not told again for this long; a sign that was not in
// it is told at once.
const RESTORE_REPEAT_MS = 7 * 24 * 60 * 60 * 1_000;
const MAX_RESTORE_KEYS = 16;
const MAX_TIME_MS = 8_640_000_000_000_000;
const MAX_DELIVERY_FAILURES = 5;
const WRITE_LOG_INTERVAL_MS = 10 * 60 * 1_000;
const RENAME_ATTEMPTS = 5;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);
const BACKGROUND_JOB = 'safety.outage-monitor';

const OUTAGE_KINDS = Object.freeze(['crash', 'connection', 'restore']);
const OWNER_STATES = Object.freeze(['none', 'queued']);
const STATE_KEYS = 'bootId,guildNoticeAtMs,lastHealthyAtMs,pending,readyAtMs,restoreSeen,schema,startedAtMs,stop';
// A record written before restoreSeen existed: accepted, with restoreSeen empty.
const LEGACY_STATE_KEYS = 'bootId,guildNoticeAtMs,lastHealthyAtMs,pending,readyAtMs,schema,startedAtMs,stop';
const RESTORE_SEEN_KEYS = 'atMs,keys';
const STOP_KEYS = 'atMs,kind';
const PENDING_KEYS = 'createdAtMs,endedAtMs,guilds,id,kind,owner,recovery,startedAtMs';
const HEX32 = /^[a-f0-9]{32}$/u;
const SNOWFLAKE = /^\d{17,20}$/u;
const GUILD_STATUS = /^(?:claimed|sent|unknown|rejected|skipped:[a-z][a-z0-9-]{0,31})$/u;
const RECOVERY_CODE = /^[A-Z][A-Z0-9_]{1,63}(?::[a-z][a-z0-9-]{0,31})?$/u;
// What a sign is remembered by: its code (and reason) and a short digest of the purpose it is of (so
// the same code of another purpose is another sign), or for a reinit a digest of the purpose and the
// ledger it made (so one reinit is one event, and a second one is another). A key written before the
// purpose was part of it has no digest; it matches nothing now, which at worst tells a set once more.
const RESTORE_KEY = /^[A-Z][A-Z0-9_]{1,63}(?::[a-z0-9][a-z0-9-]{0,31})?(?:#[a-f0-9]{8})?$/u;
const CODE_TOKEN = /^[A-Z][A-Z0-9_]{1,63}$/u;
const REASON_TOKEN = /^[a-z][a-z0-9-]{0,31}$/u;

// What the ledger bootstrap reports when a ledger is older than what the bot recorded elsewhere,
// or is missing, or is only partly there: the signs of a restored backup. LEDGER_MISSING (the
// store's own code) is deliberately not one: it also names a file that was never created.
const RESTORE_FAILURE_CODES = new Set(['LEDGER_ROLLBACK', 'LEDGER_REGISTRATION_MISSING', 'LEDGER_FILES_MISSING',
  'LEDGER_PARTIAL']);
const RESTORE_NOTICE_CODES = new Set(['LEDGER_REINIT_APPLIED', 'LEDGER_REINIT_CONSUMED']);

const EMPTY_EVIDENCE = Object.freeze({ signs: Object.freeze([]), keys: Object.freeze([]) });

function stateError(code) {
  return Object.assign(new Error(code), { code });
}

function errorCode(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  return CODE_TOKEN.test(code) ? code : 'UNEXPECTED_ERROR';
}

function blockingPause(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isTime(value) {
  return Number.isSafeInteger(value) && value >= 0 && value <= MAX_TIME_MS;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sortedKeys(value) {
  return Object.keys(value).sort().join(',');
}

function outageIdFor(startedAtMs) {
  return crypto.createHash('sha256').update(`outage-v1:${startedAtMs}`).digest('hex').slice(0, 32);
}

// The pending outage in a record, or undefined when it is not exactly what this module writes.
function parsePending(value) {
  if (!isPlainObject(value) || sortedKeys(value) !== PENDING_KEYS) return undefined;
  if (!isTime(value.startedAtMs) || !isTime(value.endedAtMs) || value.endedAtMs < value.startedAtMs ||
      !isTime(value.createdAtMs) || !OUTAGE_KINDS.includes(value.kind) || !OWNER_STATES.includes(value.owner) ||
      value.id !== outageIdFor(value.startedAtMs)) return undefined;
  if (!Array.isArray(value.recovery) || value.recovery.length > MAX_RECOVERY_CODES ||
      !value.recovery.every((code) => typeof code === 'string' && RECOVERY_CODE.test(code))) return undefined;
  if (!isPlainObject(value.guilds)) return undefined;
  const entries = Object.entries(value.guilds);
  if (entries.length > MAX_GUILD_ENTRIES ||
      !entries.every(([id, status]) => SNOWFLAKE.test(id) && typeof status === 'string' && GUILD_STATUS.test(status))) {
    return undefined;
  }
  return {
    id: value.id,
    startedAtMs: value.startedAtMs,
    endedAtMs: value.endedAtMs,
    kind: value.kind,
    recovery: [...value.recovery],
    createdAtMs: value.createdAtMs,
    owner: value.owner,
    guilds: Object.fromEntries(entries),
  };
}

// The record in a file's text, or null when the text is not exactly a version-1 record.
function parseStateText(text) {
  let value;
  try {
    value = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!isPlainObject(value) ||
      (sortedKeys(value) !== STATE_KEYS && sortedKeys(value) !== LEGACY_STATE_KEYS) || value.schema !== STATE_SCHEMA ||
      typeof value.bootId !== 'string' || !HEX32.test(value.bootId) || !isTime(value.startedAtMs) ||
      !(value.readyAtMs === null || isTime(value.readyAtMs)) ||
      !(value.lastHealthyAtMs === null || isTime(value.lastHealthyAtMs))) return null;
  // What was told of a restored backup last: absent (an older record) is empty.
  let restoreSeen = null;
  if (Object.hasOwn(value, 'restoreSeen') && value.restoreSeen !== null) {
    const seen = value.restoreSeen;
    if (!isPlainObject(seen) || sortedKeys(seen) !== RESTORE_SEEN_KEYS || !isTime(seen.atMs) ||
        !Array.isArray(seen.keys) || seen.keys.length > MAX_RESTORE_KEYS ||
        !seen.keys.every((key) => typeof key === 'string' && RESTORE_KEY.test(key))) return null;
    restoreSeen = { atMs: seen.atMs, keys: [...seen.keys] };
  }
  const stop = value.stop;
  if (!isPlainObject(stop) || sortedKeys(stop) !== STOP_KEYS || !['running', 'signal'].includes(stop.kind) ||
      !isTime(stop.atMs)) return null;
  const pending = value.pending === null ? null : parsePending(value.pending);
  if (pending === undefined) return null;
  const notices = value.guildNoticeAtMs;
  if (!isPlainObject(notices)) return null;
  const noticeEntries = Object.entries(notices);
  if (noticeEntries.length > MAX_GUILD_ENTRIES ||
      !noticeEntries.every(([id, at]) => SNOWFLAKE.test(id) && isTime(at))) return null;
  return {
    bootId: value.bootId,
    startedAtMs: value.startedAtMs,
    readyAtMs: value.readyAtMs,
    lastHealthyAtMs: value.lastHealthyAtMs,
    stop: { kind: stop.kind, atMs: stop.atMs },
    pending,
    guildNoticeAtMs: Object.fromEntries(noticeEntries),
    restoreSeen,
  };
}

function serializeState(record) {
  const pending = record.pending ? {
    id: record.pending.id,
    startedAtMs: record.pending.startedAtMs,
    endedAtMs: record.pending.endedAtMs,
    kind: record.pending.kind,
    recovery: [...record.pending.recovery],
    createdAtMs: record.pending.createdAtMs,
    owner: record.pending.owner,
    guilds: { ...record.pending.guilds },
  } : null;
  const text = `${JSON.stringify({
    schema: STATE_SCHEMA,
    bootId: record.bootId,
    startedAtMs: record.startedAtMs,
    readyAtMs: record.readyAtMs,
    lastHealthyAtMs: record.lastHealthyAtMs,
    stop: { kind: record.stop.kind, atMs: record.stop.atMs },
    pending,
    guildNoticeAtMs: { ...record.guildNoticeAtMs },
    restoreSeen: record.restoreSeen ? { atMs: record.restoreSeen.atMs, keys: [...record.restoreSeen.keys] } : null,
  })}\n`;
  if (Buffer.byteLength(text) > MAX_FILE_BYTES) throw stateError('OUTAGE_STATE_TOO_LARGE');
  return text;
}

// { kind: 'absent' }, { kind: 'ok', record }, or { kind: 'invalid' } (not a regular file, too
// large, or not a version-1 record). Any other error reading it is thrown.
function readStateFile(filePath, filesystem = fs) {
  let stat;
  try {
    stat = filesystem.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') return Object.freeze({ kind: 'absent' });
    throw error;
  }
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return Object.freeze({ kind: 'invalid' });
  const record = parseStateText(filesystem.readFileSync(filePath, 'utf8'));
  return record === null ? Object.freeze({ kind: 'invalid' }) : Object.freeze({ kind: 'ok', record });
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
  if (!stat.isFile()) throw stateError('OUTAGE_STATE_FILE_INVALID');
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

// Writes the record: <file>.tmp, fsync, rename over the file, and, when syncDirectory is a
// function, the folder's fsync (best effort; Windows journals it). A file name taken by anything
// but a regular file is refused. A heartbeat passes no syncDirectory: the rename is atomic and a
// folder entry lost to a power cut only costs one minute of age.
function writeStateFile(filePath, record, { filesystem = fs, platform = process.platform, pause = blockingPause,
  syncDirectory = fsyncDirectory } = {}) {
  const content = serializeState(record);
  let existing = null;
  try {
    existing = filesystem.lstatSync(filePath);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (existing && !existing.isFile()) throw stateError('OUTAGE_STATE_FILE_INVALID');
  const tempPath = `${filePath}.tmp`;
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
  if (typeof syncDirectory === 'function') {
    try { syncDirectory(path.dirname(filePath)); } catch {}
  }
}

function safeReason(value) {
  return typeof value === 'string' && REASON_TOKEN.test(value) ? value : null;
}

// The signs of a restored backup in one ledger bootstrap report (ledgerBootstrap.js, format
// version 1), as fixed tokens: a failed purpose's code with its reason, or a reinit notice.
// Sorted and without repeats; empty when there is none or the report cannot be read. Only the
// Owner is told of them, never the public.
function restoreSignsOf(report) {
  return restoreEvidenceOf(report).signs;
}

// The same signs, and the keys they are told once by: a failure's key is its sign and a short digest
// of the purpose (a code of a second purpose is a new sign), and a reinit notice's key names the
// ledger the reinit made (so the same reinit seen again, as applied and then as consumed, is one
// event, and a later reinit of the same purpose is another).
function restoreEvidenceOf(report) {
  const signs = new Set();
  const keys = new Set();
  try {
    if (!isPlainObject(report) || report.version !== 1 || report.protectedEffects === 'off' ||
        !Array.isArray(report.purposes)) return EMPTY_EVIDENCE;
    for (const item of report.purposes) {
      if (!isPlainObject(item)) continue;
      if (item.status === 'failed' && RESTORE_FAILURE_CODES.has(item.code)) {
        const reason = safeReason(item.reason);
        const sign = reason ? `${item.code}:${reason}` : item.code;
        const purpose = crypto.createHash('sha256').update(`restore-purpose-v1:${String(item.purposeId)}`)
          .digest('hex').slice(0, 8);
        signs.add(sign);
        keys.add(`${sign}#${purpose}`);
      }
      if (Array.isArray(item.notices) && item.notices.some((notice) => RESTORE_NOTICE_CODES.has(notice))) {
        for (const notice of item.notices) if (RESTORE_NOTICE_CODES.has(notice)) signs.add(notice);
        const identity = `${String(item.purposeId)}|${typeof item.ledgerId === 'string' ? item.ledgerId : ''}`;
        const digest = crypto.createHash('sha256').update(`restore-reinit-v1:${identity}`).digest('hex').slice(0, 15);
        keys.add(`LEDGER_REINIT:r${digest}`);
      }
    }
  } catch {
    return EMPTY_EVIDENCE;
  }
  return Object.freeze({
    signs: Object.freeze([...signs].sort().slice(0, MAX_RECOVERY_CODES)),
    keys: Object.freeze([...keys].sort().slice(0, MAX_RESTORE_KEYS)),
  });
}

// Whether the client is connected to Discord right now. client.isReady() alone says too little:
// discord.js sets the manager's status to Ready once, when the client first turns ready, and never
// resets it, so a shard that lost its connection (close code 1006) leaves isReady() true while the
// shard's own status goes on to Connecting, Identifying or Resuming. Healthy is ready, and every
// shard Ready; a client with no shard at all is not healthy. A client that shows no shards (one that is
// not a discord.js client) can only be judged by isReady().
function defaultGatewayHealthy(client) {
  try {
    if (client?.isReady?.() !== true) return false;
    const shards = client.ws?.shards;
    if (!shards || typeof shards.values !== 'function') return true;
    let count = 0;
    for (const shard of shards.values()) {
      count += 1;
      if (shard?.status !== Status.Ready) return false;
    }
    return count > 0;
  } catch {
    return false;
  }
}

function clockValue(now) {
  try {
    const value = now();
    return isTime(value) ? value : null;
  } catch {
    return null;
  }
}

function createOutageMonitor({
  runtimeMode = 'production',
  env = process.env,
  coinDbPath = null,
  projectRoot = null,
  logger = defaultLogger,
  now = () => Date.now(),
  // A clock that only moves forward and is not set (performance.now()): the wall clock can be set by a
  // time service or a restored virtual machine, which must not look like an outage.
  monotonic = () => performance.now(),
  // (client) => boolean: whether the client is connected to Discord (defaultGatewayHealthy).
  gatewayHealthy = defaultGatewayHealthy,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
  heartbeatMs = HEARTBEAT_MS,
  minOutageMs = MIN_OUTAGE_MS,
  stableAfterReadyMs = STABLE_AFTER_READY_MS,
  pendingExpiresMs = PENDING_EXPIRES_MS,
  // The Owner DM start guard (ownerDmStartGuard.js): a pending is delivered only while its
  // allowsOwnerDm() is true.
  ownerDmGate = null,
  // () => boolean; the kill switch XIAOJI_PROTECTED_EFFECTS by default.
  protectedEffectsEnabled = () => resolveProtectedEffects(env).enabled === true,
  filesystem = fs,
  platform = process.platform,
  pause = blockingPause,
  syncDirectory = fsyncDirectory,
  randomBytes = crypto.randomBytes,
} = {}) {
  const writeOptions = { filesystem, platform, pause };
  const state = {
    // idle (begin() not run yet), inactive (test-control), unavailable (no usable location),
    // or active.
    mode: 'idle',
    filePath: null,
    bootId: null,
    startedAtMs: 0,
    readyAtMs: null,
    lastHealthyAtMs: null,
    stop: { kind: 'running', atMs: 0 },
    pending: null,
    guildNoticeAtMs: {},
    // What was told of a restored backup last: { keys, atMs }, or null.
    restoreSeen: null,
    // { kind: 'planned' | 'unplanned' | 'unknown', lastHealthyAtMs } about the run before this.
    previous: { kind: 'unknown', lastHealthyAtMs: null },
    ready: false,
    // On the monotonic clock: when the last healthy heartbeat was, and when the connection (or the start)
    // last became steady.
    lastHealthyMono: null,
    stableSinceMono: null,
    stopping: false,
    timer: null,
    client: null,
    delivery: null,
    delivering: false,
    deliveryRest: false,
    deliveryFailures: 0,
    claimUndo: new Map(),
    lastWriteLogAtMs: null,
    clockLogged: false,
  };

  const line = (code, detail = '') => `[OUTAGE_MONITOR] code=${code}${detail}`;
  const info = (code, detail) => {
    try { logger?.info?.(line(code, detail)); } catch {}
  };
  const warn = (code, detail) => {
    try { logger?.warn?.(line(code, detail)); } catch {}
  };

  function snapshot() {
    return Object.freeze({
      mode: state.mode,
      ready: state.ready,
      previous: state.previous.kind,
      pending: Boolean(state.pending),
      stopped: state.stop.kind === 'signal',
    });
  }

  function record() {
    return {
      bootId: state.bootId,
      startedAtMs: state.startedAtMs,
      readyAtMs: state.readyAtMs,
      lastHealthyAtMs: state.lastHealthyAtMs,
      stop: state.stop,
      pending: state.pending,
      guildNoticeAtMs: state.guildNoticeAtMs,
      restoreSeen: state.restoreSeen,
    };
  }

  // The monotonic clock, or the wall clock when it gives nothing usable.
  function monotonicValue(fallback) {
    try {
      const value = monotonic();
      if (Number.isFinite(value) && value >= 0) return value;
    } catch {}
    return fallback;
  }

  function connected() {
    try {
      return gatewayHealthy(state.client) === true;
    } catch {
      return false;
    }
  }

  // The delivery had its chance at this pending: it handed the Owner's notice over, or ended some
  // server's. What is left of it is only the Owner's part (or the servers still held back).
  function isSettled(pending) {
    return Boolean(pending) && (pending.owner !== 'none' || Object.keys(pending.guilds).length > 0);
  }

  // A pending outage that goes away without being delivered (it expired, a later outage replaced
  // it, or the kill switch dropped it). A restore that never reached the Owner was not told: the
  // set of signs it came from is forgotten, so the next start that shows them tells it.
  function discardPending(code, detail) {
    const dropped = state.pending;
    state.pending = null;
    if (dropped && dropped.recovery.length > 0 && dropped.owner === 'none') state.restoreSeen = null;
    warn(code, detail);
  }

  // Writes the record. durable: also the folder's fsync (a state change); a heartbeat is not.
  // Returns whether it was written; a failure is logged (at most once in ten minutes) and never
  // thrown.
  function persist(durable, stage) {
    if (state.mode !== 'active') return false;
    try {
      writeStateFile(state.filePath, record(), { ...writeOptions, syncDirectory: durable ? syncDirectory : null });
      return true;
    } catch (error) {
      const at = clockValue(now);
      if (state.lastWriteLogAtMs === null || at === null || at < state.lastWriteLogAtMs ||
          at - state.lastWriteLogAtMs >= WRITE_LOG_INTERVAL_MS) {
        state.lastWriteLogAtMs = at;
        warn('OUTAGE_STATE_WRITE_FAILED', ` stage=${stage} cause=${errorCode(error)}`);
      }
      return false;
    }
  }

  function pruneNotices(atMs) {
    const entries = Object.entries(state.guildNoticeAtMs).filter(([, at]) => at >= atMs - GUILD_NOTICE_KEEP_MS);
    entries.sort((left, right) => right[1] - left[1]);
    state.guildNoticeAtMs = Object.fromEntries(entries.slice(0, MAX_GUILD_ENTRIES));
  }

  function hasOutage(pending) {
    return Boolean(pending) && pending.endedAtMs - pending.startedAtMs >= minOutageMs;
  }

  function pendingView(pending) {
    return Object.freeze({
      id: pending.id,
      startedAtMs: pending.startedAtMs,
      endedAtMs: pending.endedAtMs,
      kind: pending.kind,
      recovery: Object.freeze([...pending.recovery]),
      createdAtMs: pending.createdAtMs,
      owner: pending.owner,
      guilds: Object.freeze({ ...pending.guilds }),
      // Whether there is an outage to tell the servers of (a restore alone is the Owner's).
      announce: hasOutage(pending),
    });
  }

  function newPending(kind, startedAtMs, endedAtMs, atMs) {
    return { id: outageIdFor(startedAtMs), startedAtMs, endedAtMs, kind, recovery: [], createdAtMs: atMs,
      owner: 'none', guilds: {} };
  }

  function markPendingChanged() {
    state.deliveryRest = false;
    state.deliveryFailures = 0;
  }

  // An outage that ended at endMs after starting at startMs. One already waiting is continued
  // however short the new gap is (a start that crashed again before it was steady is the same
  // outage): its end moves. Otherwise the gap is a new outage only when it lasted minOutageMs;
  // a restore that was noted alone gains the interval and keeps its signs and its kind. Returns
  // whether the pending changed.
  function noteOutage(kind, startMs, endMs, atMs) {
    const current = state.pending;
    if (hasOutage(current)) {
      if (endMs <= current.endedAtMs) return false;
      current.endedAtMs = endMs;
      markPendingChanged();
      return true;
    }
    if (endMs - startMs < minOutageMs) return false;
    if (current) {
      current.startedAtMs = startMs;
      current.endedAtMs = endMs;
      current.id = outageIdFor(startMs);
    } else {
      state.pending = newPending(kind, startMs, endMs, atMs);
    }
    markPendingChanged();
    info('OUTAGE_DETECTED', ` kind=${kind} minutes=${Math.floor((endMs - startMs) / 60_000)}`);
    return true;
  }

  // The signs of a restored backup this start found (signs: what the pending records; keys: what a
  // sign is told once by). They are told when one of them was not in the set told last, or the set
  // told last is a week old: a restored backup shows the same signs at every start until the
  // ledgers are reinitialized, and each of those starts is not a new event.
  function noteRecovery(codes, keysGiven, atMs) {
    const list = (Array.isArray(codes) ? codes : []).filter((code) => typeof code === 'string' && RECOVERY_CODE.test(code));
    if (!list.length) return false;
    const keys = (Array.isArray(keysGiven) && keysGiven.length ? keysGiven : list)
      .filter((key) => typeof key === 'string' && RESTORE_KEY.test(key));
    const seen = state.restoreSeen;
    const trusted = Boolean(seen) && atMs >= seen.atMs - CLOCK_TOLERANCE_MS && atMs - seen.atMs < RESTORE_REPEAT_MS;
    const known = new Set(trusted ? seen.keys : []);
    if (keys.length && keys.every((key) => known.has(key))) {
      info('OUTAGE_RESTORE_REPEATED', ` signs=${list.length}`);
      return false;
    }
    state.restoreSeen = { keys: [...new Set(keys)].sort().slice(0, MAX_RESTORE_KEYS), atMs };
    if (!state.pending) state.pending = newPending('restore', atMs, atMs, atMs);
    const merged = [...new Set([...state.pending.recovery, ...list])].sort().slice(0, MAX_RECOVERY_CODES);
    state.pending.recovery = merged;
    state.pending.kind = 'restore';
    markPendingChanged();
    warn('OUTAGE_RESTORE_DETECTED', ` signs=${merged.length}`);
    return true;
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
      const reason = safeReason(error?.reason);
      warn('OUTAGE_MONITOR_UNAVAILABLE', ` cause=${errorCode(error)}${reason ? ` reason=${reason}` : ''}`);
      return snapshot();
    }
    const at = clockValue(now);
    if (at === null) {
      state.mode = 'unavailable';
      warn('OUTAGE_MONITOR_UNAVAILABLE', ' cause=CLOCK_INVALID');
      return snapshot();
    }
    state.mode = 'active';
    state.filePath = path.join(base, STATE_FILE_NAME);
    state.bootId = randomBytes(16).toString('hex');
    state.startedAtMs = at;
    let read;
    try {
      read = readStateFile(state.filePath, filesystem);
    } catch (error) {
      read = Object.freeze({ kind: 'unreadable', cause: errorCode(error) });
    }
    let previousRecord = null;
    if (read.kind === 'ok') {
      previousRecord = read.record;
    } else if (read.kind === 'absent') {
      info('OUTAGE_PREVIOUS_ABSENT');
    } else if (read.kind === 'invalid') {
      warn('OUTAGE_PREVIOUS_INVALID');
    } else {
      warn('OUTAGE_PREVIOUS_UNREADABLE', ` cause=${read.cause}`);
    }
    if (previousRecord) {
      state.pending = previousRecord.pending;
      state.guildNoticeAtMs = previousRecord.guildNoticeAtMs;
      state.restoreSeen = previousRecord.restoreSeen;
      pruneNotices(at);
      if (previousRecord.stop.kind === 'signal') {
        // A stop that was asked for: the measuring starts again at this start, so a later
        // failure to become ready is not counted from before the planned stop.
        state.previous = { kind: 'planned', lastHealthyAtMs: previousRecord.lastHealthyAtMs };
        state.lastHealthyAtMs = at;
      } else if (previousRecord.lastHealthyAtMs === null) {
        // Never seen healthy: there is nothing to measure from.
        state.previous = { kind: 'unknown', lastHealthyAtMs: null };
        info('OUTAGE_PREVIOUS_UNKNOWN', ' reason=never-healthy');
      } else if (at < previousRecord.lastHealthyAtMs - CLOCK_TOLERANCE_MS) {
        state.previous = { kind: 'unknown', lastHealthyAtMs: null };
        state.lastHealthyAtMs = at;
        warn('OUTAGE_CLOCK_BEHIND', ' stage=start');
      } else {
        // steady: that run was connected for the whole wait after its pending outage was last
        // noted (a connection outage ends, and its wait starts, when the connection comes back; a
        // crash ends when the run is ready), so what could be told of it then was (see noteReady).
        const anchor = Math.max(previousRecord.readyAtMs ?? 0, previousRecord.pending?.endedAtMs ?? 0);
        const steady = previousRecord.readyAtMs !== null &&
          previousRecord.lastHealthyAtMs - anchor >= stableAfterReadyMs;
        state.previous = { kind: 'unplanned', lastHealthyAtMs: previousRecord.lastHealthyAtMs, steady };
        state.lastHealthyAtMs = previousRecord.lastHealthyAtMs;
      }
    }
    // A claim the last process made and never settled may have reached Discord: it is never
    // sent again.
    if (state.pending) {
      let unsettled = 0;
      for (const [guildId, status] of Object.entries(state.pending.guilds)) {
        if (status === 'claimed') {
          state.pending.guilds[guildId] = 'unknown';
          unsettled += 1;
        }
      }
      if (unsettled) warn('OUTAGE_NOTICE_CLAIM_UNSETTLED', ` guilds=${unsettled}`);
      if (at - state.pending.endedAtMs > pendingExpiresMs) discardPending('OUTAGE_PENDING_EXPIRED', ' stage=start');
    }
    state.stop = { kind: 'running', atMs: at };
    persist(true, 'start');
    return snapshot();
  }

  // The heartbeat: the connection being healthy (gatewayHealthy) is the only thing that moves
  // lastHealthyAtMs. When it is healthy again after a gap, the gap is a lost connection when the
  // monotonic clock says minOutageMs passed since the last healthy heartbeat (a connection that was
  // seen lost, or a process that was frozen, for that long); the wall clock only gives the outage its
  // place in time (it ended now, and lasted what the monotonic clock says). A wall clock that moved
  // more than the monotonic one (a time service, a restored virtual machine) is only a clock that was
  // set: logged, and no outage by itself, and no part of an outage's length when one is found too.
  // A host that was suspended does not move the monotonic clock either, so its sleep is no outage.
  function heartbeat() {
    const at = clockValue(now);
    if (at === null || !state.client) return false;
    const mono = monotonicValue(at);
    if (!connected()) return false;
    let durable = false;
    if (state.lastHealthyAtMs !== null && state.lastHealthyMono !== null) {
      const wallGap = at - state.lastHealthyAtMs;
      const monoGap = mono - state.lastHealthyMono;
      if (monoGap >= minOutageMs) {
        // A pending that was told in part, or that the delivery gave up on in this process (it told the
        // servers and could not tell the Owner), is not extended by an outage that came after it:
        // that one is another outage.
        if (state.pending && (state.deliveryRest || isSettled(state.pending))) {
          discardPending('OUTAGE_PENDING_SUPERSEDED', ' stage=heartbeat');
        }
        if (noteOutage('connection', at - Math.floor(monoGap), at, at)) durable = true;
        state.stableSinceMono = mono;
      } else if (wallGap < -CLOCK_TOLERANCE_MS) {
        if (!state.clockLogged) {
          state.clockLogged = true;
          warn('OUTAGE_CLOCK_BEHIND', ' stage=heartbeat');
        }
      } else if (wallGap - monoGap > CLOCK_TOLERANCE_MS) {
        warn('OUTAGE_CLOCK_JUMP', ` seconds=${Math.floor((wallGap - monoGap) / 1_000)}`);
      }
    }
    state.lastHealthyAtMs = at;
    state.lastHealthyMono = mono;
    persist(durable, 'heartbeat');
    return true;
  }

  const store = Object.freeze({
    // The pending outage as a frozen copy, or null.
    pending() {
      return state.pending ? pendingView(state.pending) : null;
    },
    isStopping() {
      return state.stopping;
    },
    now() {
      return clockValue(now);
    },
    // When the last public notice was claimed for the server, or null.
    lastNoticeAtMs(guildId) {
      return Object.hasOwn(state.guildNoticeAtMs, guildId) ? state.guildNoticeAtMs[guildId] : null;
    },
    // Called at the network entry of a notice: durably records the claim (and the time) before
    // anything leaves. false when it cannot be recorded; then nothing may be sent.
    claimGuild(guildId, atMs) {
      const pending = state.pending;
      if (state.mode !== 'active' || !pending || state.stopping || !SNOWFLAKE.test(String(guildId)) || !isTime(atMs) ||
          Object.hasOwn(pending.guilds, guildId) ||
          Object.keys(pending.guilds).length >= MAX_GUILD_ENTRIES) return false;
      const hadNotice = Object.hasOwn(state.guildNoticeAtMs, guildId);
      const priorNoticeAt = hadNotice ? state.guildNoticeAtMs[guildId] : null;
      const priorNotices = state.guildNoticeAtMs;
      pending.guilds[guildId] = 'claimed';
      state.guildNoticeAtMs = { ...priorNotices, [guildId]: atMs };
      pruneNotices(atMs);
      if (!persist(true, 'claim')) {
        delete pending.guilds[guildId];
        state.guildNoticeAtMs = priorNotices;
        return false;
      }
      state.claimUndo.set(guildId, priorNoticeAt);
      return true;
    },
    // The end of a server's notice: 'sent', 'unknown', 'rejected' or 'skipped:<reason>'. Never
    // changes a status that already ended.
    settleGuild(guildId, status) {
      const pending = state.pending;
      if (!pending || !GUILD_STATUS.test(String(status)) || status === 'claimed') return false;
      const current = Object.hasOwn(pending.guilds, guildId) ? pending.guilds[guildId] : undefined;
      if (current !== undefined && current !== 'claimed') return false;
      if (current === undefined && Object.keys(pending.guilds).length >= MAX_GUILD_ENTRIES) return false;
      pending.guilds[guildId] = status;
      state.claimUndo.delete(guildId);
      persist(true, 'settle');
      return true;
    },
    // A claim that turned out not to have reached Discord (or that Discord answered with a rate
    // limit): given back, with the time it had put in the 24-hour memory.
    releaseGuild(guildId) {
      const pending = state.pending;
      if (!pending || pending.guilds[guildId] !== 'claimed') return false;
      delete pending.guilds[guildId];
      if (state.claimUndo.has(guildId)) {
        const prior = state.claimUndo.get(guildId);
        state.claimUndo.delete(guildId);
        const next = { ...state.guildNoticeAtMs };
        if (prior === null) delete next[guildId]; else next[guildId] = prior;
        state.guildNoticeAtMs = next;
      }
      persist(true, 'release');
      return true;
    },
    // The Owner notice is handed over: recorded before it is, so it is never handed over twice.
    markOwnerQueued() {
      const pending = state.pending;
      if (state.mode !== 'active' || !pending || pending.owner !== 'none') return false;
      pending.owner = 'queued';
      if (!persist(true, 'owner')) {
        pending.owner = 'none';
        return false;
      }
      return true;
    },
  });

  async function deliverIfDue() {
    const pending = state.pending;
    if (!pending || state.delivering || state.stopping) return null;
    const at = clockValue(now);
    if (at === null) return null;
    if (at - pending.endedAtMs > pendingExpiresMs) {
      discardPending('OUTAGE_PENDING_EXPIRED', ' stage=run');
      persist(true, 'expire');
      return 'expired';
    }
    let enabled = false;
    try { enabled = protectedEffectsEnabled() === true; } catch { enabled = false; }
    if (!enabled) {
      discardPending('OUTAGE_NOTICE_DISABLED', ' reason=protected-effects-off');
      persist(true, 'disabled');
      return 'disabled';
    }
    if (!state.delivery || state.deliveryRest) return null;
    if (!connected()) return null;
    // Steady is measured on the monotonic clock: a wall clock set forward is not time spent steady.
    const mono = monotonicValue(at);
    if (state.stableSinceMono === null || mono < state.stableSinceMono ||
        mono - state.stableSinceMono < stableAfterReadyMs) {
      return null;
    }
    if (ownerDmGate && typeof ownerDmGate.allowsOwnerDm === 'function') {
      let allows = false;
      try { allows = ownerDmGate.allowsOwnerDm() === true; } catch { allows = false; }
      if (!allows) return null;
    }
    state.delivering = true;
    try {
      const outcome = await state.delivery(store);
      state.deliveryFailures = 0;
      if (outcome === 'complete') {
        // Only the outage this run was told of ends; one that was noted meanwhile stays.
        if (state.pending && state.pending.id === pending.id) {
          state.pending = null;
          persist(true, 'complete');
          info('OUTAGE_NOTICE_COMPLETE');
        }
      } else if (outcome === 'idle') {
        state.deliveryRest = true;
      }
      return outcome;
    } catch (error) {
      state.deliveryFailures += 1;
      warn('OUTAGE_NOTICE_FAILED', ` cause=${errorCode(error)}`);
      if (state.deliveryFailures >= MAX_DELIVERY_FAILURES) state.deliveryRest = true;
      return 'failed';
    } finally {
      state.delivering = false;
    }
  }

  async function tick() {
    try {
      if (state.mode !== 'active' || !state.ready || state.stopping) return null;
      heartbeat();
      return await deliverIfDue();
    } catch (error) {
      warn('OUTAGE_MONITOR_TICK_FAILED', ` cause=${errorCode(error)}`);
      return null;
    }
  }

  function stopTimer() {
    if (!state.timer) return;
    try { clearIntervalFn(state.timer); } catch {}
    state.timer = null;
  }

  return Object.freeze({
    // Synchronous; never throws.
    begin() {
      try {
        return begin();
      } catch (error) {
        if (state.mode !== 'active') state.mode = 'unavailable';
        warn('OUTAGE_MONITOR_UNAVAILABLE', ` cause=${errorCode(error)}`);
        return snapshot();
      }
    },

    // ClientReady: the previous run's end is measured and the heartbeat starts. bootReport is the
    // ledger bootstrap report (protectedEffects.bootReport), whose signs of a restored backup are
    // read here; recovery is a list of signs given directly. Synchronous; never throws.
    noteReady(client, { bootReport = null, recovery = [] } = {}) {
      try {
        if (state.mode !== 'active' || state.ready || state.stopping) return snapshot();
        state.ready = true;
        state.client = client || null;
        const at = clockValue(now);
        if (at === null) return snapshot();
        if (state.previous.kind === 'unplanned') {
          const from = state.previous.lastHealthyAtMs;
          if (at < from - CLOCK_TOLERANCE_MS) {
            warn('OUTAGE_CLOCK_BEHIND', ' stage=ready');
          } else if (state.previous.steady || isSettled(state.pending)) {
            // The pending outage that is still there (if any) had its chance: the run before this
            // was connected for the whole wait after it was noted, or the delivery already ended
            // some of it. All that is left of it is the Owner's part. An outage that begins after
            // that is another one and replaces it; a short gap after it is a restart, which neither
            // extends it nor makes a new one.
            if (at - from >= minOutageMs) {
              if (state.pending) discardPending('OUTAGE_PENDING_SUPERSEDED', ' stage=ready');
              noteOutage('crash', from, at, at);
            }
          } else {
            // A start that failed again before the wait was over: the same outage goes on, however
            // short the new gap (its start stays, its end moves); with none waiting, a gap of
            // minOutageMs or more is a new one.
            noteOutage('crash', from, at, at);
          }
        }
        const evidence = restoreEvidenceOf(bootReport);
        const given = (Array.isArray(recovery) ? recovery : []).filter((code) => typeof code === 'string');
        noteRecovery([...new Set([...evidence.signs, ...given])].sort().slice(0, MAX_RECOVERY_CODES),
          [...new Set([...evidence.keys, ...given])].sort().slice(0, MAX_RESTORE_KEYS), at);
        state.readyAtMs = at;
        state.lastHealthyAtMs = at;
        state.lastHealthyMono = monotonicValue(at);
        state.stableSinceMono = state.lastHealthyMono;
        persist(true, 'ready');
        if (!state.timer && !state.stopping) {
          state.timer = setIntervalFn(() => runWithBackgroundContext(BACKGROUND_JOB, tick), heartbeatMs);
          state.timer?.unref?.();
        }
        return snapshot();
      } catch (error) {
        warn('OUTAGE_MONITOR_UNAVAILABLE', ` cause=${errorCode(error)} stage=ready`);
        return snapshot();
      }
    },

    // SIGINT or SIGTERM: a stop that was asked for. Written at once and synchronously, since the
    // host may kill the process a few seconds after the signal. Nothing changes it back.
    noteSignalStop() {
      try {
        if (state.mode !== 'active' || state.stop.kind === 'signal') return;
        state.stopping = true;
        stopTimer();
        state.stop = { kind: 'signal', atMs: clockValue(now) ?? state.stop.atMs };
        persist(true, 'signal');
      } catch {}
    },

    // The stop itself (shutdown()): no heartbeat and no delivery from here on. The record is not
    // touched: whether the stop was asked for was decided by the signal.
    stop() {
      try {
        state.stopping = true;
        stopTimer();
      } catch {}
    },

    // The one that tells the outage (outageNotice.js): async delivery(store) answering
    // 'complete' (the pending ends), 'waiting' (try again at the next heartbeat) or 'idle' (keep
    // the pending for a later start and stop trying in this process).
    attachDelivery(delivery) {
      if (typeof delivery !== 'function') throw new TypeError('The outage delivery must be a function.');
      state.delivery = delivery;
    },

    status: snapshot,
    // For tests and the delivery's own checks.
    store,
    tick,
  });
}

module.exports = {
  CLOCK_TOLERANCE_MS,
  HEARTBEAT_MS,
  MAX_FILE_BYTES,
  MAX_GUILD_ENTRIES,
  MIN_OUTAGE_MS,
  OUTAGE_KINDS,
  PENDING_EXPIRES_MS,
  RESTORE_REPEAT_MS,
  STABLE_AFTER_READY_MS,
  STATE_FILE_NAME,
  createOutageMonitor,
  defaultGatewayHealthy,
  outageIdFor,
  parseStateText,
  readStateFile,
  restoreEvidenceOf,
  restoreSignsOf,
  writeStateFile,
};
