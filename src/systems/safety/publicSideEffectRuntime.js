'use strict';

/*
 * Public side effects (penalty notices, work reminder DMs, automatic guild leaves, chain
 * reactions), one ledger per purpose and one worker per purpose.
 *
 * Every answer has a kind: confirmed, unknown, inflight, retryable_before_attempt,
 * deferred, unavailable, or terminal. A terminal answer also names its basis:
 * - durable: a ledger row decided it (a settled attempt or a recorded "never sent");
 * - computed: the source itself is at or below the ledger cutover or its source
 *   watermark (reason before_cutover or source_watermark). Nothing is written, and every
 *   process and every restart computes the same answer;
 * - volatile: a decision kept only in this process's memory, or a binding that can never
 *   be formed. It is forgotten on restart, so callers must not treat it as settled.
 *
 * An attempt's ledger begin is written at its network entry (protectedRest.js), in the same
 * synchronous step as the send, not when the caller calls begin(): begin() is the caller's
 * word that its final authorization passed. An attempt that never reaches Discord (stopped,
 * deferred, refused above the network, rate limited before sending, or still waiting at its
 * deadline) writes nothing, and the same operation can be tried again. One that reached
 * Discord is recorded confirmed, rejected (a 4xx: terminal under its result code, never
 * sent again), or unknown (it may have taken effect: terminal as well).
 *
 * Each binding carries the event time of its source (sourceTimeMs): the join time for
 * welcomes, the message snowflake time for chain reactions, the zoned created_at of a
 * penalty, the task's created_at for a reminder DM, and the guild join time for an
 * automatic leave. DM preparations carry none (one preparation serves every task of a
 * recipient); their cutover is checked here against the task that triggered them.
 */

const crypto = require('node:crypto');
const { assertDistinctDataPaths } = require('../../platform/dataPaths');
const { stableJson } = require('../../platform/publicEffectGrant');
const { installProtectedRest, outcomeCode, outcomeResult } = require('../../platform/protectedRest');
const { createLedgerEscalations, formatLedgerFailure } = require('./ledgerEscalation');
const { resolveProtectedEffects } = require('./ledgerBootstrap');
const {
  ackOperationId,
  buildDmChannelBinding,
  consumeWorkReminderAccountingProof,
  planOperationId,
  reminderOperationId,
  validateCreatedDm,
  validateDmChannelBindingForOperation,
} = require('./workReminderSource');

const QUEUE_LIMIT = 128;
const WORKER_CONCURRENCY = 1;
const DISPATCH_TIMEOUT_MS = 15_000;
// The background job the deadline timer of a send runs as (protectedRest.js).
const PROTECTED_LABEL = 'safety.public-effects';
const SNOWFLAKE = /^\d{17,20}$/u;
// Ledger errors that describe the binding itself, not the ledger: the same input can never
// be dispatched, so the caller may treat the event as terminal. Every other ledger error
// (closed, failed, quarantined, unreadable, corrupt) disables the purpose and is reported
// as unavailable, never as terminal.
const TERMINAL_BINDING_CODES = new Set([
  'SIDE_EFFECT_BINDING_CONFLICT',
  'SIDE_EFFECT_BINDING_INVALID',
  'SIDE_EFFECT_BINDING_TOO_LARGE',
]);
// Reaction-fence opens the store refused on a ledger that is still healthy, without
// changing any fence: the fence row, begin_seq, the chain head, and every witness are
// exactly as before. (A soft-limit refusal first runs and commits one bounded accelerated
// prune, which only deletes expired terminal rows and raises their watermarks, and then
// rolls the refused fence write back; the other refusals write nothing.) So only this open
// fails (its caller keeps the game disabled) and the purpose stays usable for every other
// guild. Any other open failure, and every close failure, may leave the fence on disk in
// an unknown state or still open when it should be closed, so the ledger is quarantined at
// once.
const PLAIN_FENCE_OPEN_REJECTIONS = new Set([
  'SIDE_EFFECT_CAPACITY_EXCEEDED',
  'SIDE_EFFECT_FENCE_INVALID',
  'SIDE_EFFECT_BINDING_INVALID',
  'SIDE_EFFECT_BINDING_TOO_LARGE',
]);
// A fence read refused only because its guild ID is not a snowflake: nothing was read.
const INPUT_REJECTIONS = new Set(['SIDE_EFFECT_FENCE_INVALID']);
// An inspection refused only for its own input (an invalid source key or time): nothing was read.
const INSPECT_INPUT_REJECTIONS = new Set(['SIDE_EFFECT_BINDING_INVALID']);
const NO_CODES = new Set();
// Result codes of a terminal answer computed from the source itself (cutover or watermark).
const SOURCE_TERMINAL_CODES = new Set(['before_cutover', 'source_watermark']);
const DM_PREPARE = 'work.reminder.dm.prepare';
const AUTO_LEAVE = 'audit.guild.leave';
// Automatic guild leaves per rolling window, counted on the ledger clock from the ledger's
// own rows (attempted, confirmed, unknown and rejected; never not_sent), so a restart keeps
// the count. No option, Owner action or extension raises them.
const AUTO_LEAVE_LIMITS = Object.freeze([
  Object.freeze({ windowMs: 60 * 60 * 1_000, maximum: 3 }),
  Object.freeze({ windowMs: 24 * 60 * 60 * 1_000, maximum: 10 }),
]);
// DM channel creation is intentionally durable too: it is a Discord side effect and a
// process restart must not turn a one-hour cap into a fresh budget.  A confirmed channel
// is reused by the reminder flow, so normal reminder volume does not consume this cap repeatedly.
const DM_PREPARE_LIMITS = Object.freeze([
  Object.freeze({ windowMs: 60 * 60 * 1_000, maximum: 30 }),
]);
const DM_CHANNEL_REUSE_MS = 24 * 60 * 60 * 1_000;
// A capped leave released in memory is not claimed again before this wait (ledger clock);
// every later dispatch counts again anyway.
const AUTO_LEAVE_RETRY_AFTER_MS = 5 * 60 * 1_000;
// The result code of a preparation released without being counted (a deferral).
const DEFERRED_CODE = 'deferred';
const UNAVAILABLE = Object.freeze({ kind: 'unavailable' });
const RETRYABLE = Object.freeze({ kind: 'retryable_before_attempt' });
// A binding that can never be formed (or that conflicts with a recorded one): terminal for
// this event, but backed by no ledger decision.
const TERMINAL_UNBOUND = Object.freeze({ kind: 'terminal', basis: 'volatile' });
const PURPOSES = Object.freeze({
  'work.penalty.announce': Object.freeze({
    sourceNamespace: 'db.coin_work_penalties',
    action: 'work-penalty-message.create',
    method: 'POST',
  }),
  'work.reminder.dm.prepare': Object.freeze({
    sourceNamespace: 'discord.work-reminder-recipient',
    action: 'work-reminder-dm-channel.prepare',
    method: 'POST',
  }),
  'work.reminder.dm.send': Object.freeze({
    sourceNamespace: 'db.coin_work_tasks.reminder',
    action: 'work-reminder-message.create',
    method: 'POST',
  }),
  'audit.guild.leave': Object.freeze({
    sourceNamespace: 'discord.guild-audit.join',
    action: 'audit-guild.leave',
    method: 'DELETE',
  }),
  'word-chain.reaction': Object.freeze({
    sourceNamespace: 'discord.messageCreate',
    action: 'chain-reaction.put',
    method: 'PUT',
    featureKey: 'word_chain',
  }),
  'number-chain.reaction': Object.freeze({
    sourceNamespace: 'discord.messageCreate',
    action: 'chain-reaction.put',
    method: 'PUT',
    featureKey: 'number_chain',
  }),
});

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sourceTimestamp(record) {
  return Number(record?.sourceTimestampMs);
}

// The event time a binding carries: undefined for DM preparations (none), null when the
// record has no usable time (the binding cannot be formed).
function bindingSourceTime(record) {
  if (record?.purposeId === DM_PREPARE) return undefined;
  const value = sourceTimestamp(record);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

// Source keys group the watermarks that retention leaves behind: per guild for every
// purpose (the reminder DM included, so pruned rows never leave one watermark per task),
// per recipient for DM preparations.
function sourceKeyFor(record) {
  return record.purposeId === DM_PREPARE
    ? `${record.purposeId}:bot:${record.botId}:recipient:${record.userId}`
    : `${record.purposeId}:guild:${record.guildId}`;
}

// What the ledger needs to inspect a source without a binding: operation ID, source key
// and (except for DM preparations) source time; null when the record cannot form one.
function sourceIdentity(record) {
  const operationId = operationIdFor(record);
  const sourceTimeMs = bindingSourceTime(record);
  if (!operationId || sourceTimeMs === null || !SNOWFLAKE.test(String(record?.guildId || ''))) return null;
  return Object.freeze({ operationId, sourceKey: sourceKeyFor(record),
    ...(sourceTimeMs === undefined ? {} : { sourceTimeMs }) });
}

function operationSeed(record) {
  if (record?.purposeId === 'work.penalty.announce') {
    return {
      schemaVersion: 1,
      purposeId: record.purposeId,
      botId: record.botId,
      sourceNamespace: record.sourceNamespace,
      guildId: record.guildId,
      penaltyId: record.penaltyId,
      createdAt: record.createdAt,
    };
  }
  if (record?.purposeId === 'work.reminder.dm.prepare') {
    return {
      schemaVersion: 1,
      purposeId: record.purposeId,
      botId: record.botId,
      sourceNamespace: record.sourceNamespace,
      recipientId: record.userId,
      dmOperationId: record.dmOperationId,
    };
  }
  if (record?.purposeId === 'work.reminder.dm.send') {
    return {
      schemaVersion: 1,
      purposeId: record.purposeId,
      botId: record.botId,
      sourceNamespace: record.sourceNamespace,
      guildId: record.guildId,
      userId: record.userId,
      taskId: record.taskId,
      createdAt: record.createdAt,
      parentKind: record.taskScope,
      parentId: record.parentId,
      slot: record.slot,
    };
  }
  if (record?.purposeId === 'audit.guild.leave') {
    return {
      schemaVersion: 1,
      purposeId: record.purposeId,
      botId: record.botId,
      sourceNamespace: record.sourceNamespace,
      guildId: record.guildId,
      joinedAt: record.joinedAt,
      joinLineageDigest: record.joinLineageDigest,
    };
  }
  return {
    schemaVersion: 1,
    purposeId: record?.purposeId,
    botId: record?.botId,
    featureKey: record?.featureKey,
    guildId: record?.guildId,
    channelId: record?.channelId,
    messageId: record?.messageId,
    emoji: '✅',
  };
}

function operationIdFor(record) {
  const purposeId = String(record?.purposeId || '');
  if (!PURPOSES[purposeId]) return null;
  return `${purposeId}-v1:${sha256(stableJson(operationSeed(record)))}`;
}

function buildPublicOperation(record, effect) {
  const definition = PURPOSES[record?.purposeId];
  const operationId = operationIdFor(record);
  const sourceTimeMs = bindingSourceTime(record);
  if (!definition || !operationId || sourceTimeMs === null || record.sourceNamespace !== definition.sourceNamespace ||
      !SNOWFLAKE.test(String(record.botId || '')) || !SNOWFLAKE.test(String(record.guildId || '')) ||
      effect?.purposeId !== record.purposeId || effect?.action !== definition.action ||
      String(effect?.method || '').toUpperCase() !== definition.method ||
      effect?.route !== record.route || String(effect?.target || '') !== String(record.target || '') ||
      stableJson(effect?.body) !== stableJson(record.body)) return null;
  return Object.freeze({
    operationId,
    sourceKey: sourceKeyFor(record),
    ...(sourceTimeMs === undefined ? {} : { sourceTimeMs }),
    sourceEventId: String(record.sourceEventId),
    hostPurpose: definition.sourceNamespace,
    scope: String(record.scope),
    action: definition.action,
    target: String(record.target),
    budgetClass: 'none',
    mergeKey: operationId,
    payload: { method: definition.method, route: record.route, body: record.body },
  });
}

// The basis of a terminal operation view: a ledger row, the source itself (cutover or
// watermark, whether computed now or kept in memory under that code), or memory alone.
function terminalBasis(operation) {
  if (operation?.durable === true) return 'durable';
  return SOURCE_TERMINAL_CODES.has(operation?.resultCode) ? 'computed' : 'volatile';
}

function classifyOperation(operation) {
  if (!operation) return Object.freeze({ kind: 'retryable_before_attempt', operation: null });
  if (operation.status === 'confirmed') return Object.freeze({ kind: 'confirmed', operation, result: operation.result || null });
  if (operation.status === 'unknown' || operation.status === 'attempted') return Object.freeze({ kind: 'unknown', operation });
  if (operation.status === 'claimed') return Object.freeze({ kind: 'inflight', operation });
  // A released preparation (a counted failure or an uncounted deferral) may be dispatched
  // again; dispatch itself keeps its retry wait.
  if (operation.status === 'prepare_failed') return Object.freeze({ kind: 'retryable_before_attempt', operation });
  const basis = terminalBasis(operation);
  // A terminal computed from the source, and a rejection by Discord (also when replayed),
  // carry their reason: the result code.
  const named = basis === 'computed' || operation.status === 'rejected';
  return Object.freeze({ kind: 'terminal', basis, operation, ...(named ? { reason: operation.resultCode } : {}) });
}

// A terminal answer computed from the source alone (no operation view behind it).
function computedTerminal(reason) {
  return Object.freeze({ kind: 'terminal', basis: 'computed', reason, operation: null });
}

class PublicSideEffectRuntime {
  #effectAuthority;
  #escalations = createLedgerEscalations();

  // Ledgers come only from the bootstrap (ledgerBootstrap.js), through preflight(); this
  // runtime never opens one. onPurposeDisabled(purposeId, code), if given, hears each
  // delivered ledger preflight refused and each purpose stopped while running
  // (ledgerAlerts.js), once.
  constructor({ client, botId, logger, env = process.env, now = () => Date.now(), effectAuthority,
    protectedRestFactory = installProtectedRest, dispatchTimeoutMs = DISPATCH_TIMEOUT_MS,
    onPurposeDisabled = null, egressLimiter = null } = {}) {
    this.client = client;
    this.botId = String(botId || '').trim();
    this.logger = logger;
    this.now = now;
    this.#effectAuthority = effectAuthority;
    this.protectedRestFactory = protectedRestFactory;
    this.dispatchTimeoutMs = dispatchTimeoutMs;
    this.egressLimiter = egressLimiter || client?.egressLimiter || null;
    this.onPurposeDisabled = typeof onPurposeDisabled === 'function' ? onPurposeDisabled : null;
    this.protectedRest = null;
    this.slots = new Map(Object.keys(PURPOSES).map((purposeId) => [purposeId, {
      ledger: null, cutoverSourceTimestampMs: null, disabled: true, retainLock: false,
      queue: [], draining: false,
    }]));
    this.accepting = true;
    // Nothing is ready until arm() (index.js calls it at ClientReady, once the logged-in
    // bot is known to be the one the ledgers were opened for): before that every purpose
    // answers unavailable, so work started too early is only delayed.
    this.armed = false;
    // The kill switch (XIAOJI_PROTECTED_EFFECTS=off, or any value but on/off): every purpose
    // stays off and no ledger is read or written in this process.
    this.protectedEffectsEnabled = resolveProtectedEffects(env).enabled;
  }

  // Codes only: a cause adds its fixed ledger code (see formatLedgerFailure), never a
  // message, path, or ID.
  log(purposeId, code, cause = undefined) {
    const detail = cause === undefined ? '' : ` ${formatLedgerFailure(cause)}`;
    this.logger?.warn?.(`[PUBLIC_EFFECT] purpose=${purposeId} code=${code}${detail}`);
  }

  // Takes each purpose's ledger from `ledgers`, the map of open facades the bootstrap
  // delivered (purpose ID -> ledger). A purpose with no delivered ledger stays off; a
  // delivered ledger that does not fit (another purpose, bot, or namespace, already failed,
  // or sharing a path with reserved data) is refused and left to the bootstrap to close.
  // The bootstrap reported a delivered ledger ready, so each refusal is told to
  // onPurposeDisabled (ledgerAlerts.js), like a purpose stopped while running.
  preflight({ reservedDescriptors = [], ledgers = null } = {}) {
    if (!this.protectedEffectsEnabled) {
      for (const purposeId of Object.keys(PURPOSES)) this.log(purposeId, 'PROTECTED_EFFECTS_OFF');
      return Object.freeze({ enabled: [], disabled: Object.keys(PURPOSES) });
    }
    const refuseAll = () => {
      for (const purposeId of Object.keys(PURPOSES)) {
        if (ledgers instanceof Map && ledgers.has(purposeId)) this.#notifyDisabled(purposeId, 'PUBLIC_EFFECT_LEDGER_DISABLED');
      }
      return Object.freeze({ enabled: [], disabled: Object.keys(PURPOSES) });
    };
    if (!this.#effectAuthority || !SNOWFLAKE.test(this.botId)) {
      for (const purposeId of Object.keys(PURPOSES)) this.log(purposeId, 'LEDGER_DISABLED');
      return refuseAll();
    }
    // Every send goes through the protected channel of client.rest (protectedRest.js): one
    // network entry per attempt, never after its deadline. A REST that cannot carry it keeps
    // every purpose off.
    try { this.protectedRest = this.protectedRestFactory(this.client?.rest); } catch {
      for (const purposeId of Object.keys(PURPOSES)) this.log(purposeId, 'LEDGER_DISABLED');
      return refuseAll();
    }
    const claimedDescriptors = [...reservedDescriptors];
    const enabled = [];
    const disabled = [];
    for (const [purposeId, definition] of Object.entries(PURPOSES)) {
      const slot = this.slots.get(purposeId);
      const ledger = ledgers instanceof Map ? ledgers.get(purposeId) : null;
      if (!ledger) {
        disabled.push(purposeId);
        this.log(purposeId, 'LEDGER_NOT_DELIVERED');
        continue;
      }
      try {
        if (ledger.purposeId !== purposeId || ledger.closed || ledger.failed || ledger.quarantined) {
          throw new Error('PUBLIC_EFFECT_LEDGER_UNUSABLE');
        }
        const descriptors = [
          { filePath: ledger.locations.ledgerPath },
          { filePath: ledger.locations.anchorPath },
          { filePath: ledger.locations.receiptPath },
          { filePath: ledger.continuityWitness?.filePath },
        ];
        assertDistinctDataPaths([...claimedDescriptors, ...descriptors]);
        const purpose = ledger.provenance?.purposeIdentity;
        if (purpose?.purposeId !== purposeId || purpose?.sourceNamespace !== definition.sourceNamespace ||
            purpose?.botId !== this.botId || !Number.isSafeInteger(purpose?.cutoverSourceTimestampMs)) {
          throw new Error('PUBLIC_EFFECT_PURPOSE_INVALID');
        }
        slot.ledger = ledger;
        slot.cutoverSourceTimestampMs = purpose.cutoverSourceTimestampMs;
        slot.disabled = false;
        claimedDescriptors.push(...descriptors);
        enabled.push(purposeId);
      } catch (error) {
        slot.ledger = null;
        slot.disabled = true;
        disabled.push(purposeId);
        // The mapped ledger code (for example SIDE_EFFECT_FORMAT_OUTDATED or
        // SIDE_EFFECT_LEDGER_QUARANTINED) tells the operator which README step applies.
        this.log(purposeId, 'LEDGER_UNAVAILABLE', error);
        this.#escalations.openFailed(purposeId, error);
        this.#notifyDisabled(purposeId, 'PUBLIC_EFFECT_LEDGER_UNAVAILABLE');
      }
    }
    return Object.freeze({ enabled, disabled });
  }

  // From now on purposes may be ready (index.js, at ClientReady, after the bot identity
  // check). Never after quiesce() or stop().
  arm() {
    if (this.accepting) this.armed = true;
  }

  // The logged-in bot is not the one the ledgers were opened for: every purpose stays off
  // for this process. Ledgers stay open until stop(); nothing is quarantined, and the
  // event is reported by ledgerAlerts.js, not through onPurposeDisabled.
  disableAll(code = 'DISABLED') {
    for (const [purposeId, slot] of this.slots) {
      for (const task of slot.queue.splice(0)) task.resolve(UNAVAILABLE);
      if (!slot.disabled) this.log(purposeId, code);
      slot.disabled = true;
    }
  }

  // Ready only while the runtime is armed and accepts work and the purpose's ledger is open
  // and still trusted. A ledger that failed (a persistence fault, or an unreadable or
  // corrupt file seen by any read, in the facade or its store) or was quarantined is never
  // used again in this process; its purpose is disabled the first time this is noticed.
  isPurposeReady(purposeId) {
    // With protected effects off nothing below is consulted: no ledger exists to look at.
    if (!this.protectedEffectsEnabled || !this.armed) return false;
    const slot = this.slots.get(purposeId);
    if (!this.accepting || !slot || slot.disabled || !slot.ledger) return false;
    const { ledger } = slot;
    if (ledger.closed || ledger.failed || ledger.quarantined) {
      this.disablePurpose(purposeId, { code: ledger.quarantined ? 'LEDGER_QUARANTINED' : 'LEDGER_FAILED' });
      return false;
    }
    return true;
  }

  // The ledger's own read-only identity: nothing is read from the file.
  getLedgerIdentity(purposeId) {
    if (!this.protectedEffectsEnabled) return null;
    const ledger = this.slots.get(purposeId)?.ledger;
    return ledger ? Object.freeze({ ledgerId: ledger.ledgerId }) : null;
  }

  getCutoverSourceTimestampMs(purposeId) {
    const slot = this.slots.get(purposeId);
    return this.isPurposeReady(purposeId) ? slot.cutoverSourceTimestampMs : null;
  }

  // A failed read disables the purpose and returns null; the purpose is then no longer
  // ready, so a caller that checks readiness or the cutover afterwards (the adopt paths
  // do) sees it as unavailable, never as a missing fence it could adopt.
  getReactionFence(purposeId, guildId) {
    if (!this.isPurposeReady(purposeId) || !PURPOSES[purposeId]?.featureKey) return null;
    try {
      return this.slots.get(purposeId).ledger.getReactionFence(guildId);
    } catch (error) {
      this.#readFailed(purposeId, 'REACTION_FENCE_READ_FAILED', error, INPUT_REJECTIONS);
      return null;
    }
  }

  // Zero-write view of one source (LedgerStore.inspectOperation through the facade): its
  // durable row, the in-memory decision of this process, or a terminal answer computed from
  // the cutover or its source watermark; otherwise retryable.
  inspectSource(record) {
    const purposeId = record?.purposeId;
    const slot = this.slots.get(purposeId);
    if (!this.isPurposeReady(purposeId)) return UNAVAILABLE;
    const identity = sourceIdentity(record);
    if (!identity) return TERMINAL_UNBOUND;
    if (purposeId === DM_PREPARE && sourceTimestamp(record) <= slot.cutoverSourceTimestampMs) {
      return computedTerminal('before_cutover');
    }
    let inspected;
    try {
      inspected = slot.ledger.inspect(identity);
    } catch (error) {
      this.#readFailed(purposeId, 'INSPECT_FAILED', error, INSPECT_INPUT_REJECTIONS);
      return this.isPurposeReady(purposeId) ? TERMINAL_UNBOUND : UNAVAILABLE;
    }
    if (inspected.kind === 'terminal') return computedTerminal(inspected.resultCode);
    return classifyOperation(inspected.operation);
  }

  // A recent confirmed preparation may be referenced by a different reminder for the same
  // recipient.  The returned proof remains tied to its original operation and binding
  // digest, so the send path can re-check those values before it creates a message.
  findReusableWorkReminderChannel({ botId, recipientId } = {}) {
    const purposeId = DM_PREPARE;
    const slot = this.slots.get(purposeId);
    if (!this.isPurposeReady(purposeId) || !SNOWFLAKE.test(String(botId || '')) ||
        !SNOWFLAKE.test(String(recipientId || ''))) return UNAVAILABLE;
    try {
      const now = slot.ledger.observedNow();
      const operation = slot.ledger.findLatestConfirmedBySourceKey({
        sourceKey: `${purposeId}:bot:${botId}:recipient:${recipientId}`,
        target: recipientId,
        sinceMs: Math.max(0, now - DM_CHANNEL_REUSE_MS),
      });
      if (!operation) return Object.freeze({ kind: 'none' });
      const channelId = validateDmChannelBindingForOperation(operation.result, operation, String(botId), String(recipientId));
      return channelId ? Object.freeze({ kind: 'confirmed', operation, result: operation.result, channelId })
        : Object.freeze({ kind: 'none' });
    } catch (error) {
      this.#readFailed(purposeId, 'DM_PREPARE_CACHE_READ_FAILED', error);
      return UNAVAILABLE;
    }
  }

  // The purpose ledger's own monotonic clock (observedNow, no file access), or null when the
  // purpose is not ready. Deadlines of a source are judged on this clock.
  getObservedNow(purposeId) {
    if (!this.isPurposeReady(purposeId)) return null;
    try {
      return this.slots.get(purposeId).ledger.observedNow();
    } catch (error) {
      this.#readFailed(purposeId, 'CLOCK_READ_FAILED', error);
      return null;
    }
  }

  openReactionFence(purposeId, input, options) {
    if (!this.isPurposeReady(purposeId) || !PURPOSES[purposeId]?.featureKey) throw new Error('REACTION_PURPOSE_UNAVAILABLE');
    const { ledger } = this.slots.get(purposeId);
    try {
      return ledger.openReactionFence(input, options);
    } catch (error) {
      this.#fenceFailed(purposeId, 'open', error);
      throw error;
    }
  }

  closeReactionFence(purposeId, guildId, expected) {
    if (!this.isPurposeReady(purposeId) || !PURPOSES[purposeId]?.featureKey) throw new Error('REACTION_PURPOSE_UNAVAILABLE');
    const { ledger } = this.slots.get(purposeId);
    try {
      return ledger.closeReactionFence(guildId, expected);
    } catch (error) {
      this.#fenceFailed(purposeId, 'close', error);
      throw error;
    }
  }

  verifyReactionFence(purposeId, input) {
    if (!this.isPurposeReady(purposeId) || !PURPOSES[purposeId]?.featureKey) return null;
    try {
      return this.slots.get(purposeId).ledger.verifyReactionFence(input);
    } catch (error) {
      this.#readFailed(purposeId, 'REACTION_FENCE_READ_FAILED', error);
      return null;
    }
  }

  #isBindingRejection(slot, error) {
    return TERMINAL_BINDING_CODES.has(error?.code) && Boolean(slot.ledger) && !slot.ledger.failed;
  }

  // null while another automatic leave may start; otherwise the deferred answer, with the
  // ledger-clock time before which a leave released in memory is not claimed again. Zero
  // writes; a read failure throws.
  #autoLeaveDeferral(slot) {
    for (const { windowMs, maximum } of AUTO_LEAVE_LIMITS) {
      if (slot.ledger.countAttempts({ windowMs }) >= maximum) {
        return Object.freeze({ kind: 'deferred', reason: 'auto_leave_cap',
          retryNotBeforeMs: slot.ledger.observedNow() + AUTO_LEAVE_RETRY_AFTER_MS });
      }
    }
    return null;
  }

  #dmPreparationDeferral(slot) {
    for (const { windowMs, maximum } of DM_PREPARE_LIMITS) {
      if (slot.ledger.countAttempts({ windowMs }) >= maximum) {
        return Object.freeze({ kind: 'deferred', reason: 'dm_prepare_cap',
          retryNotBeforeMs: slot.ledger.observedNow() + AUTO_LEAVE_RETRY_AFTER_MS });
      }
    }
    return null;
  }

  // A read through the purpose's ledger threw. Unless it only rejected its input on a
  // ledger that is still trusted, the purpose is disabled with the specific code.
  #readFailed(purposeId, code, error, inputRejections = NO_CODES) {
    const ledger = this.slots.get(purposeId)?.ledger;
    if (inputRejections.has(error?.code) && ledger && !ledger.failed) return;
    this.disablePurpose(purposeId, { code, cause: error });
  }

  // A reaction-fence write failed. A plain open refusal on a healthy ledger only fails
  // that open (PLAIN_FENCE_OPEN_REJECTIONS); every other failure disables the purpose and
  // quarantines its ledger at once.
  #fenceFailed(purposeId, operation, error) {
    const ledger = this.slots.get(purposeId)?.ledger;
    if (operation === 'open' && ledger && !ledger.failed && PLAIN_FENCE_OPEN_REJECTIONS.has(error?.code)) {
      this.log(purposeId, 'REACTION_FENCE_OPEN_REJECTED', error);
      return;
    }
    this.disablePurpose(purposeId, { retainLock: true, cause: error,
      code: operation === 'open' ? 'REACTION_FENCE_OPEN_FAILED' : 'REACTION_FENCE_CLOSE_FAILED' });
  }

  // Stops a purpose for the rest of this process. retainLock also quarantines its ledger
  // at once: the marker is written and fsynced now, not at stop, so a crash cannot lose
  // it, and every later open is refused until an operator removes it. If the marker
  // cannot be written, the purpose stays disabled, close() tries again, and the failure
  // is escalated (ledgerEscalation.js).
  disablePurpose(purposeId, { retainLock = false, code = 'DISABLED', cause = undefined } = {}) {
    const slot = this.slots.get(purposeId);
    if (!slot) return;
    const wasEnabled = !slot.disabled && Boolean(slot.ledger);
    slot.disabled = true;
    slot.retainLock ||= retainLock;
    this.log(purposeId, code, cause);
    if (retainLock) this.#quarantineNow(purposeId, slot.ledger, code);
    if (wasEnabled && this.accepting) this.#notifyDisabled(purposeId, code);
  }

  #notifyDisabled(purposeId, code) {
    if (!this.onPurposeDisabled) return;
    try {
      Promise.resolve(this.onPurposeDisabled(purposeId, code)).catch(() => {});
    } catch {}
  }

  #quarantineNow(purposeId, ledger, code) {
    if (!ledger || ledger.closed) return;
    try {
      ledger.quarantine(code);
    } catch (error) {
      this.log(purposeId, 'QUARANTINE_PERSIST_FAILED', error);
      this.#escalations.quarantineFailed(purposeId);
    }
  }

  // Ledger escalations recorded in this process, by code only (see ledgerEscalation.js).
  getLedgerEscalations() {
    return this.#escalations.list();
  }

  dispatch(effectGrant, effect, options = {}) {
    const record = this.#effectAuthority?.consumeEffect(effectGrant, effect);
    const purposeId = record?.purposeId;
    const slot = this.slots.get(purposeId);
    if (!record || !slot || !this.isPurposeReady(purposeId)) return Promise.resolve(UNAVAILABLE);
    const binding = buildPublicOperation(record, effect);
    if (!binding) return Promise.resolve(TERMINAL_UNBOUND);
    // A DM preparation carries no source time, so the task that triggered it is checked
    // against the cutover here. Every other source is judged by the ledger itself
    // (verifyBinding below), from the event time its binding carries.
    if (purposeId === DM_PREPARE && sourceTimestamp(record) <= slot.cutoverSourceTimestampMs) {
      return Promise.resolve(computedTerminal('before_cutover'));
    }
    let existing;
    try {
      // A recorded row, a decision of this process, or a terminal answer computed from the
      // cutover or the source watermark; nothing is written.
      existing = slot.ledger.verifyBinding(binding);
    } catch (error) {
      // Only a conflicting or invalid binding is terminal. A read or state error (a failed,
      // quarantined, closed, unreadable, or corrupt ledger) says nothing about the event.
      if (this.#isBindingRejection(slot, error)) return Promise.resolve(TERMINAL_UNBOUND);
      this.disablePurpose(purposeId, { code: 'VERIFY_FAILED', cause: error });
      return Promise.resolve(UNAVAILABLE);
    }
    if (existing) {
      // A released preparation is queued and claimed again once its retry wait has passed;
      // until then it is reported as retryable without being queued.
      if (existing.status !== 'prepare_failed' || existing.durable !== false) {
        return Promise.resolve(classifyOperation(existing));
      }
      let now;
      try {
        now = slot.ledger.observedNow();
      } catch (error) {
        this.disablePurpose(purposeId, { code: 'VERIFY_FAILED', cause: error });
        return Promise.resolve(UNAVAILABLE);
      }
      if (Number.isSafeInteger(existing.retryNotBeforeMs) && now < existing.retryNotBeforeMs) {
        return Promise.resolve(existing.resultCode === DEFERRED_CODE
          ? Object.freeze({ kind: 'deferred', retryNotBeforeMs: existing.retryNotBeforeMs, operation: existing })
          : classifyOperation(existing));
      }
    }
    // An automatic leave over its cap is deferred before anything is claimed or queued: no
    // write, no memory, and the next check counts again. (The cap is checked once more at
    // the begin, which decides.)
    if (purposeId === AUTO_LEAVE) {
      let deferral;
      try {
        deferral = this.#autoLeaveDeferral(slot);
      } catch (error) {
        this.#readFailed(purposeId, 'AUTO_LEAVE_CAP_READ_FAILED', error);
        return Promise.resolve(UNAVAILABLE);
      }
      if (deferral) return Promise.resolve(deferral);
    }
    if (purposeId === DM_PREPARE) {
      let deferral;
      try {
        deferral = this.#dmPreparationDeferral(slot);
      } catch (error) {
        this.#readFailed(purposeId, 'DM_PREPARE_CAP_READ_FAILED', error);
        return Promise.resolve(UNAVAILABLE);
      }
      if (deferral) return Promise.resolve(deferral);
    }
    // A full queue is back-pressure on a healthy purpose: nothing is claimed, remembered, or
    // written, and the event is retryable. (Remembering it as suppressed_queue used to make
    // it terminal, which dead-lettered a ✅ and also settled the same operation still
    // waiting in the queue.)
    if (slot.queue.length >= QUEUE_LIMIT) return Promise.resolve(RETRYABLE);
    return new Promise((resolve) => {
      slot.queue.push({ record, effect: Object.freeze({ ...effect }), binding, options, resolve });
      this.kickDrain(purposeId);
    });
  }

  kickDrain(purposeId) {
    const slot = this.slots.get(purposeId);
    if (!slot || slot.draining) return;
    slot.draining = true;
    Promise.resolve().then(async () => {
      while (this.accepting && slot.queue.length) {
        const task = slot.queue.shift();
        // The waiting caller always gets an answer, even if processing throws.
        let outcome = UNAVAILABLE;
        try {
          outcome = await this.process(purposeId, task);
        } catch (error) {
          this.disablePurpose(purposeId, { code: 'WORKER_FAILED', cause: error });
        } finally {
          task.resolve(outcome);
        }
      }
    }).catch((error) => this.disablePurpose(purposeId, { code: 'WORKER_FAILED', cause: error })).finally(() => {
      slot.draining = false;
      if (this.accepting && slot.queue.length) this.kickDrain(purposeId);
    });
  }

  async process(purposeId, task) {
    const slot = this.slots.get(purposeId);
    // A purpose disabled after this task was queued never claims it.
    if (!this.isPurposeReady(purposeId)) return UNAVAILABLE;
    // Build and reserve the exact request before the in-memory ledger claim.  A full
    // output window therefore leaves neither an attempt row nor a remembered claim.
    let request;
    try {
      request = this.requestFor(purposeId, task);
    } catch (error) {
      return error?.terminal ? TERMINAL_UNBOUND : UNAVAILABLE;
    }
    let reservation = null;
    if (this.egressLimiter) {
      let reserved;
      try {
        reserved = this.egressLimiter.reserve(request);
      } catch (error) {
        return error?.deferred ? Object.freeze({ kind: 'deferred', retryAfterMs: error.retryAfterMs }) : TERMINAL_UNBOUND;
      }
      if (!reserved.allowed) return Object.freeze({ kind: 'deferred', retryAfterMs: reserved.retryAfterMs });
      reservation = reserved.reservation;
    }
    try {
    let claimed;
    try {
      claimed = slot.ledger.claim(task.binding);
      if (claimed.kind !== 'claimed') return classifyOperation(claimed.operation);
    } catch (error) {
      this.disablePurpose(purposeId, { code: 'CLAIM_FAILED', cause: error });
      return UNAVAILABLE;
    }
    const { generation } = claimed.operation;

    // What a begin decided before refusing (the automatic-leave cap, or a failed read of it)
    // and the ledger begin's own error, kept here so the answer never depends on the caller
    // passing the thrown error on unchanged: a caller may wrap it, replace it, or swallow it.
    const refusal = { beginError: null, beginDeferral: null, beginCapError: null };
    // The checks of a begin, run when the caller calls begin() and again at the network
    // entry. Stopping or a disabled purpose says nothing about the event: unavailable, never
    // terminal. The automatic-leave cap decides in the same synchronous step as the ledger
    // begin (one worker per purpose), so leaves queued together can never pass it together.
    const checkBegin = () => {
      if (!this.accepting || slot.disabled) {
        throw Object.assign(new Error('PUBLIC_EFFECT_UNAVAILABLE'), { unavailable: true });
      }
      if (purposeId !== AUTO_LEAVE && purposeId !== DM_PREPARE) return;
      let deferral;
      try {
        deferral = purposeId === AUTO_LEAVE ? this.#autoLeaveDeferral(slot) : this.#dmPreparationDeferral(slot);
      } catch (error) {
        refusal.beginCapError = error;
        throw error;
      }
      if (deferral) {
        refusal.beginDeferral = deferral;
        throw Object.assign(new Error('PUBLIC_EFFECT_DEFERRED'), {
          deferred: true, retryNotBeforeMs: deferral.retryNotBeforeMs,
        });
      }
    };
    // begin() is the caller's word that its final authorization passed. It writes nothing:
    // the ledger begin waits for the network entry (enterNetwork below), so an attempt that
    // never reaches Discord leaves no row, and the same operation can be tried again.
    let authorized = false;
    const begin = () => {
      checkBegin();
      authorized = true;
    };
    try {
      if (typeof task.options.beforeAttempt !== 'function') {
        throw Object.assign(new Error('PUBLIC_EFFECT_FINAL_AUTHORIZATION_REQUIRED'), {
          terminal: true,
          code: 'final_authorization_required',
        });
      }
      await task.options.beforeAttempt(begin, task.record);
      if (!authorized) throw Object.assign(new Error('PUBLIC_EFFECT_BEGIN_REQUIRED'), { terminal: true });
      // Stopped or disabled while the caller authorized: nothing was written or sent.
      if (!this.accepting || slot.disabled) {
        throw Object.assign(new Error('PUBLIC_EFFECT_UNAVAILABLE'), { unavailable: true });
      }
      // The lease starts again here, so a long final authorization cannot let it lapse
      // before the network entry.
      slot.ledger.renew(task.binding.operationId, generation);
    } catch (error) {
      return this.#settleUnsent(purposeId, slot, task, generation, error, refusal);
    }

    let attempted = null;
    // At the network entry, in the same synchronous step as the send (protectedRest.js): the
    // begin's checks once more, then the ledger begin, last.
    const enterNetwork = () => {
      checkBegin();
      try {
        attempted = slot.ledger.beginDispatch(task.binding, generation);
      } catch (error) {
        refusal.beginError = error;
        throw error;
      }
    };
    const send = () => this.protectedRest.send(request, {
      deadlineMs: this.dispatchTimeoutMs, label: PROTECTED_LABEL, onNetworkEntry: enterNetwork,
    });
    const sent = reservation
      ? await this.egressLimiter.runWithReservation(reservation, send)
      : await send();
    if (!attempted) return this.#settleNotSent(purposeId, slot, task, generation, sent, refusal);
    return this.#settleSent(purposeId, slot, task, attempted, sent);
    } finally {
      if (reservation) this.egressLimiter.cancel(reservation);
    }
  }

  // An attempt that ended before its ledger begin (the caller's final authorization, the
  // begin's checks, or the begin itself refused it): nothing was sent and nothing durable
  // was written, so the claim is released, deferred, or ended in memory.
  #settleUnsent(purposeId, slot, task, generation, error, { beginError, beginDeferral, beginCapError }) {
    // The ledger failed while preparing (for example the begin could not be committed):
    // nothing was sent, the purpose stops, and the event is unavailable, not terminal.
    if (slot.ledger?.failed && !slot.disabled) {
      this.disablePurpose(purposeId, { code: 'BEGIN_FAILED', cause: beginError || error });
    }
    // The cap could not be read at the begin: the purpose stops, as at dispatch.
    if (beginCapError && !slot.disabled) {
      this.#readFailed(purposeId, 'AUTO_LEAVE_CAP_READ_FAILED', beginCapError);
    }
    if (error?.unavailable === true || !this.isPurposeReady(purposeId)) return UNAVAILABLE;
    // The begin found the source already terminal by the cutover or its watermark (a
    // watermark raised by retention after the claim): the source decides, so the claim
    // ends under that code and is not counted as a preparation failure.
    const sourceTerminalCode = beginError?.code === 'SIDE_EFFECT_SOURCE_TERMINAL'
      ? (beginError.storeDetail?.reason === 'cutover' ? 'before_cutover' : 'source_watermark') : null;
    const { operationId } = task.binding;
    let deferred = null;
    try {
      if (sourceTerminalCode) {
        slot.ledger.finalizeClaim(operationId, generation, sourceTerminalCode);
      } else if (beginDeferral || (error?.deferred === true && !error?.terminal)) {
        // A deferral (the automatic-leave cap, or a caller's own reason to wait) is not a
        // preparation failure: released without counting, nothing written. The wait is an
        // absolute ledger-clock time (the default retry wait when none is given). The cap's
        // own deferral wins over whatever the caller made of it.
        const retryNotBeforeMs = beginDeferral ? beginDeferral.retryNotBeforeMs : error.retryNotBeforeMs;
        deferred = slot.ledger.releasePreparation(operationId, generation, DEFERRED_CODE, { counted: false,
          ...(Number.isSafeInteger(retryNotBeforeMs) ? { retryNotBeforeMs } : {}) });
      } else if (error?.terminal) {
        // The source codes stay reserved for the ledger's own answer, so a caller's decision
        // can never pass for one computed from the source.
        const code = String(error.code || 'authorization_revoked').replace(/[^A-Za-z0-9._:-]/gu, '_').slice(0, 64);
        slot.ledger.finalizeClaim(operationId, generation, SOURCE_TERMINAL_CODES.has(code) ? 'caller_terminal' : code);
      } else {
        // Retried after PREPARE_RETRY_AFTER_MS; a begin refused only for capacity (even while
        // the relief is throttled) is not counted toward the two failures that settle the
        // event (sideEffectLedger.js).
        slot.ledger.releasePreparation(operationId, generation, 'prepare_failed');
      }
    } catch (releaseError) {
      this.disablePurpose(purposeId, { code: 'PREPARE_FINALIZE_FAILED', cause: releaseError });
      return UNAVAILABLE;
    }
    if (sourceTerminalCode) return computedTerminal(sourceTerminalCode);
    if (deferred) return Object.freeze({ kind: 'deferred', retryNotBeforeMs: deferred.retryNotBeforeMs });
    return error?.terminal ? TERMINAL_UNBOUND : RETRYABLE;
  }

  // The send never reached Discord (protectedRest.js), so nothing was written and the claim
  // is settled in memory. A refused network entry is settled like a refused begin. A rate
  // limit waits for its reset without counting, as does a refusal that names its own wait; a
  // refusal that calls itself terminal ends the event in memory; the deadline and any other
  // refusal (test-control, a missing token) count as a failed preparation, tried again after
  // PREPARE_RETRY_AFTER_MS (the second one settles the event in memory).
  #settleNotSent(purposeId, slot, task, generation, sent, refusal) {
    if (sent.reason === 'entry_failed') {
      return this.#settleUnsent(purposeId, slot, task, generation, sent.entryError, refusal);
    }
    if (!this.isPurposeReady(purposeId)) return UNAVAILABLE;
    const { operationId } = task.binding;
    try {
      if (sent.reason === 'refused' && sent.terminal) {
        const code = sent.causeCode || 'refused_before_dispatch';
        slot.ledger.finalizeClaim(operationId, generation, SOURCE_TERMINAL_CODES.has(code) ? 'caller_terminal' : code);
        return TERMINAL_UNBOUND;
      }
      if (Number.isSafeInteger(sent.retryAfterMs)) {
        slot.ledger.releasePreparation(operationId, generation, sent.reason === 'rate_limited' ? 'rate_limited' : 'refused',
          { counted: false, retryNotBeforeMs: slot.ledger.observedNow() + sent.retryAfterMs });
      } else {
        slot.ledger.releasePreparation(operationId, generation, sent.reason === 'deadline' ? 'deadline' : 'refused');
      }
    } catch (error) {
      this.disablePurpose(purposeId, { code: 'PREPARE_FINALIZE_FAILED', cause: error });
      return UNAVAILABLE;
    }
    return RETRYABLE;
  }

  // The attempt reached Discord: its answer is recorded on the row its network entry began.
  // A confirmed answer is still recorded unknown when the runtime stopped or the purpose was
  // disabled meanwhile, or when its result does not fit the binding. A rejection is
  // terminal for the event, under its result code.
  #settleSent(purposeId, slot, task, attempted, sent) {
    const confirmed = sent.kind === 'confirmed' && this.accepting && !slot.disabled;
    let result;
    if (confirmed) {
      try { result = this.normalizeConfirmedResult(purposeId, sent.value, task.record, attempted); }
      catch { result = null; }
      if (!result) {
        try { slot.ledger.finish(task.binding.operationId, attempted.generation, 'unknown', 'response_invalid'); }
        catch (error) { this.disablePurpose(purposeId, { code: 'FINAL_PERSIST_FAILED', cause: error }); }
        return Object.freeze({ kind: 'unknown' });
      }
    }
    const state = confirmed ? 'confirmed' : sent.kind === 'rejected' ? 'rejected' : 'unknown';
    const resultCode = sent.kind === 'confirmed' && !confirmed ? 'effect_unknown' : outcomeCode('effect', sent);
    try {
      const operation = slot.ledger.finish(task.binding.operationId, attempted.generation, state, resultCode,
        confirmed ? result : outcomeResult(sent));
      if (state === 'rejected') return classifyOperation(operation);
      return Object.freeze({ kind: state, operation, result: result || null });
    } catch (error) {
      this.disablePurpose(purposeId, { code: 'FINAL_PERSIST_FAILED', cause: error });
      return Object.freeze({ kind: 'unknown' });
    }
  }

  normalizePenaltyResult(value, record) {
    const messageId = String(value?.id || '');
    const channelId = String(value?.channel_id || value?.channelId || record.target || '');
    if (!SNOWFLAKE.test(messageId) || channelId !== record.target) return null;
    return Object.freeze({ messageId, channelId, announcedAt: new Date(this.now()).toISOString() });
  }

  normalizeConfirmedResult(purposeId, value, record, operation) {
    if (purposeId === 'work.penalty.announce') return this.normalizePenaltyResult(value, record);
    if (purposeId === 'work.reminder.dm.prepare') {
      if (!validateCreatedDm(value, record.userId)) return null;
      return buildDmChannelBinding(operation, value, record.botId, record.userId);
    }
    if (purposeId === 'work.reminder.dm.send') {
      const messageId = String(value?.id || '');
      const channelId = String(value?.channel_id || value?.channelId || record.target || '');
      if (!SNOWFLAKE.test(messageId) || channelId !== record.target) return null;
      return Object.freeze({
        messageId,
        channelId,
        recipientId: record.recipientId,
        preparationOperationId: record.preparationOperationId,
        preparationBindingDigest: record.preparationBindingDigest,
        channelBindingProof: record.channelBindingProof,
        completedAt: new Date(this.now()).toISOString(),
      });
    }
    if (purposeId === 'audit.guild.leave') {
      return Object.freeze({
        guildId: record.guildId,
        joinedAt: record.joinedAt,
        joinLineageDigest: record.joinLineageDigest,
        completedAt: new Date(this.now()).toISOString(),
      });
    }
    return { reactedAt: new Date(this.now()).toISOString() };
  }

  // The one request of an attempt, exactly as bound: the binding's method and route, with
  // its body (a reaction and a leave carry none). A binding that no longer matches its
  // effect is never sent.
  requestFor(purposeId, task) {
    const definition = PURPOSES[purposeId];
    const payload = task.binding.payload;
    if (payload.method !== definition.method || payload.route !== task.effect.route ||
        stableJson(payload.body) !== stableJson(task.effect.body)) {
      throw Object.assign(new Error('PUBLIC_EFFECT_BINDING_MISMATCH'), { terminal: true, code: 'binding_mismatch' });
    }
    if (definition.method === 'PUT') return { method: 'PUT', fullRoute: payload.route, body: null };
    if (definition.method === 'DELETE' && purposeId === 'audit.guild.leave') {
      return { method: 'DELETE', fullRoute: payload.route, body: null };
    }
    return { method: 'POST', fullRoute: payload.route, body: payload.body };
  }

  inspectWorkReminderAccounting(source) {
    if (!this.isPurposeReady('work.reminder.dm.send')) return Object.freeze({ kind: 'unavailable' });
    const dmOperationId = reminderOperationId(source);
    if (!dmOperationId) return Object.freeze({ kind: 'conflict' });
    const ledger = this.slots.get('work.reminder.dm.send').ledger;
    let plan;
    let ack;
    try {
      plan = ledger.getOperation(planOperationId(dmOperationId));
      ack = ledger.getOperation(ackOperationId(dmOperationId));
    } catch (error) {
      this.disablePurpose('work.reminder.dm.send', { code: 'ACCOUNTING_READ_FAILED', cause: error });
      return UNAVAILABLE;
    }
    if (plan && (plan.status !== 'final' || plan.resultCode !== 'accounting_plan' ||
        plan.result?.dmOperationId !== dmOperationId)) return Object.freeze({ kind: 'conflict' });
    if (ack && (ack.status !== 'final' || ack.resultCode !== 'accounting_applied' ||
        ack.result?.dmOperationId !== dmOperationId || ack.result?.planOperationId !== plan?.operationId ||
        ack.result?.planResultDigest !== plan?.resultDigest || ack.result?.accountingApplied !== true)) {
      return Object.freeze({ kind: 'conflict' });
    }
    return Object.freeze({ kind: ack ? 'acked' : plan ? 'planned' : 'none', dmOperationId,
      plan: plan || null, ack: ack || null });
  }

  persistWorkReminderAccounting(proof) {
    const trusted = consumeWorkReminderAccountingProof(proof);
    if (!trusted || !this.isPurposeReady('work.reminder.dm.send')) {
      return Object.freeze({ kind: 'unavailable' });
    }
    const ledger = this.slots.get('work.reminder.dm.send').ledger;
    const isPlan = trusted.kind === 'plan';
    const result = isPlan ? trusted.plan : trusted.ack;
    const dmOperationId = result.dmOperationId;
    const operationId = isPlan ? planOperationId(dmOperationId) : ackOperationId(dmOperationId);
    const binding = Object.freeze({
      operationId,
      sourceKey: `work.reminder.accounting:task:${trusted.source.taskId}`,
      sourceEventId: dmOperationId,
      hostPurpose: 'db.coin_work_tasks.reminder',
      scope: `guild:${trusted.source.guildId}:user:${trusted.source.userId}`,
      action: isPlan ? 'work-reminder-accounting.plan' : 'work-reminder-accounting.ack',
      target: trusted.source.userId,
      budgetClass: 'none',
      mergeKey: operationId,
      payload: result,
    });
    const resultCode = isPlan ? 'accounting_plan' : 'accounting_applied';
    // One durable "never sent" decision (recordNotSent): a single transaction writes the
    // row already settled, so accounting can never be left attempted and become unknown.
    let decided;
    try {
      decided = ledger.recordNotSent(binding, resultCode, result);
    } catch (error) {
      // A full ledger refused the decision (throttled or not): nothing was written, the
      // purpose stays usable, and the next reminder run accounts for the reminder.
      if (error?.code === 'SIDE_EFFECT_CAPACITY_EXCEEDED' && !ledger.failed) {
        this.log('work.reminder.dm.send', 'ACCOUNTING_CAPACITY_EXCEEDED', error);
        return Object.freeze({ kind: 'unavailable' });
      }
      // Anything else (another plan under the same ID, a live claim holding it, or a write
      // that failed) stops the purpose, as before.
      this.disablePurpose('work.reminder.dm.send', { code: 'ACCOUNTING_PERSIST_FAILED', cause: error });
      throw error;
    }
    const operation = decided.operation;
    if (decided.kind === 'recorded') return Object.freeze({ kind: 'persisted', operation });
    if (decided.kind === 'existing' && operation?.status === 'final' && operation.resultCode === resultCode &&
        stableJson(operation.result) === stableJson(result)) {
      return Object.freeze({ kind: 'existing', operation });
    }
    // An existing row of another kind, or a terminal answer (impossible without a source time).
    return Object.freeze({ kind: 'conflict' });
  }

  async waitForIdleForTests() {
    while ([...this.slots.values()].some((slot) => slot.draining || slot.queue.length)) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  // The first step of a stop: no new work is taken, queued tasks are answered unavailable,
  // and the task in flight is waited for (its dispatch timeout bounds it). Ledgers stay
  // open, so lastSeen and quarantine flags can still be written before stop() closes them.
  async quiesce() {
    this.accepting = false;
    this.armed = false;
    for (const slot of this.slots.values()) {
      for (const task of slot.queue.splice(0)) task.resolve(UNAVAILABLE);
    }
    for (const slot of this.slots.values()) {
      while (slot.draining) await new Promise((resolve) => setImmediate(resolve));
    }
  }

  async stop() {
    await this.quiesce();
    for (const [purposeId, slot] of this.slots) {
      if (slot.ledger) {
        const { ledger } = slot;
        ledger.close({ retainLock: slot.retainLock });
        // A quarantine whose marker still could not be written will not block the next start.
        this.#escalations.closed(purposeId, ledger);
        slot.ledger = null;
      }
      slot.disabled = true;
      this.log(purposeId, 'STOPPED');
    }
  }
}

module.exports = {
  DISPATCH_TIMEOUT_MS,
  PURPOSES,
  PublicSideEffectRuntime,
  QUEUE_LIMIT,
  WORKER_CONCURRENCY,
  buildPublicOperation,
  classifyOperation,
  operationIdFor,
};
