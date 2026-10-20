'use strict';

const crypto = require('node:crypto');
const { Routes } = require('discord.js');
const { assertDistinctDataPaths } = require('../../platform/dataPaths');
const { stableJson } = require('../../platform/publicEffectGrant');
const { installProtectedRest, outcomeCode, outcomeResult } = require('../../platform/protectedRest');
const { createLedgerEscalations, formatLedgerFailure } = require('./ledgerEscalation');
const { resolveProtectedEffects } = require('./ledgerBootstrap');

const PURPOSE_ID = 'welcome';
const SOURCE_NAMESPACE = 'discord.guildMemberAdd';
const ACTION = 'welcome-message.create';
const QUEUE_LIMIT = 128;
// Joins accepted before arm() wait in memory; at most this many. A join beyond it is
// dropped with a log line: not queued, not recorded, not sent, and not retried later.
const PRE_ARM_QUEUE_LIMIT = 32;
const WORKER_CONCURRENCY = 1;
const DISPATCH_TIMEOUT_MS = 15_000;
// The background job the deadline timer of a send runs as (protectedRest.js).
const PROTECTED_LABEL = 'safety.welcome';
const SNOWFLAKE = /^\d{17,20}$/u;

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

// The binding carries the join time as its source time, so the ledger itself answers a join
// at or below the cutover or its guild's watermark as terminal (computed, nothing written).
function buildWelcomeOperation(record) {
  if (record?.purposeId !== PURPOSE_ID || record?.sourceNamespace !== SOURCE_NAMESPACE ||
      record?.hostPurpose !== SOURCE_NAMESPACE || !SNOWFLAKE.test(record.botId || '') ||
      !SNOWFLAKE.test(record.guildId || '') || !SNOWFLAKE.test(record.memberId || '') ||
      !SNOWFLAKE.test(record.target || '') || record.action !== ACTION || record.method !== 'POST' ||
      record.route !== Routes.channelMessages(record.target) || !record.body ||
      !Number.isSafeInteger(record.joinedTimestamp) || record.joinedTimestamp < 0) return null;
  const seed = stableJson({
    schemaVersion: 1,
    purposeId: record.purposeId,
    botId: record.botId,
    sourceNamespace: record.sourceNamespace,
    scope: record.scope,
    guildId: record.guildId,
    memberId: record.memberId,
    joinedTimestamp: record.joinedTimestamp,
  });
  const operationId = `welcome-v1:${sha256(seed)}`;
  return Object.freeze({
    operationId,
    sourceKey: `${PURPOSE_ID}:${record.scope}`,
    sourceTimeMs: record.joinedTimestamp,
    sourceEventId: record.sourceEventId,
    hostPurpose: SOURCE_NAMESPACE,
    scope: record.scope,
    action: ACTION,
    target: record.target,
    budgetClass: 'none',
    mergeKey: operationId,
    payload: record.body,
  });
}

function exactEffectMatches(record, effect) {
  return record?.purposeId === effect?.purposeId && record?.action === effect?.action &&
    record?.target === effect?.target && record?.method === effect?.method &&
    record?.route === effect?.route && stableJson(record?.body) === stableJson(effect?.body);
}

class WelcomeSideEffectRuntime {
  #effectAuthority;
  #escalations = createLedgerEscalations();

  // The ledger comes only from the bootstrap (ledgerBootstrap.js), through preflight();
  // this runtime never opens one. onPurposeDisabled('welcome', code), if given, hears a
  // delivered ledger preflight refused, or the runtime stop while running (ledgerAlerts.js),
  // once.
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
    this.ledger = null;
    this.cutoverJoinedTimestampMs = null;
    this.queue = [];
    this.pendingOperations = new Set();
    this.drainPromise = null;
    this.accepting = true;
    this.disabled = true;
    // Joins accepted before arm() (index.js, at ClientReady, after the bot identity check)
    // are claimed and queued in memory only; nothing is sent until then.
    this.armed = false;
    // The kill switch: no ledger is taken, read, or written in this process.
    this.protectedEffectsEnabled = resolveProtectedEffects(env).enabled;
  }

  // Codes only: a cause adds its fixed ledger code, never a message, path, or ID.
  log(code, cause = undefined) {
    const detail = cause === undefined ? '' : ` ${formatLedgerFailure(cause)}`;
    this.logger?.warn?.(`[WELCOME_SAFETY] code=${code}${detail}`);
  }

  // Stops welcome messages for the rest of this process; a runtime that was running tells
  // onPurposeDisabled once.
  #disable(code, cause = undefined) {
    const wasEnabled = !this.disabled && Boolean(this.ledger);
    this.disabled = true;
    this.log(code, cause);
    if (wasEnabled && this.accepting && this.onPurposeDisabled) {
      try {
        Promise.resolve(this.onPurposeDisabled(PURPOSE_ID, code)).catch(() => {});
      } catch {}
    }
  }

  // Usable while accepting and the ledger is open and still trusted. A ledger that failed
  // (in the facade or its store) or was quarantined disables welcome messages for the rest
  // of this process.
  #usable() {
    if (!this.protectedEffectsEnabled || !this.accepting || this.disabled || !this.ledger) return false;
    if (this.ledger.closed || this.ledger.failed || this.ledger.quarantined) {
      this.#disable(this.ledger.quarantined ? 'WELCOME_LEDGER_QUARANTINED' : 'WELCOME_LEDGER_FAILED');
      return false;
    }
    return true;
  }

  // Ready to send: usable and armed.
  isReady() {
    return this.armed && this.#usable();
  }

  // Ledger escalations recorded in this process, by code only (see ledgerEscalation.js).
  getLedgerEscalations() {
    return this.#escalations.list();
  }

  // Tells onPurposeDisabled about a delivered ledger preflight refused: the bootstrap
  // reported it ready, so the alerts would otherwise never hear why welcomes are off.
  #refused(code) {
    if (!this.onPurposeDisabled) return;
    try {
      Promise.resolve(this.onPurposeDisabled(PURPOSE_ID, code)).catch(() => {});
    } catch {}
  }

  // Takes the welcome ledger from `ledgers`, the map of open facades the bootstrap
  // delivered. Without one the runtime stays off; a ledger that does not fit is refused,
  // told to onPurposeDisabled, and left to the bootstrap to close.
  preflight({ reservedDescriptors = [], ledgers = null } = {}) {
    if (!this.protectedEffectsEnabled) {
      this.disabled = true;
      this.log('WELCOME_PROTECTED_EFFECTS_OFF');
      return Object.freeze({ enabled: false, code: 'WELCOME_PROTECTED_EFFECTS_OFF' });
    }
    const ledger = ledgers instanceof Map ? ledgers.get(PURPOSE_ID) : null;
    if (!ledger || !this.#effectAuthority || !SNOWFLAKE.test(this.botId) || !this.#installProtectedRest()) {
      this.disabled = true;
      this.log('WELCOME_LEDGER_DISABLED');
      if (ledger) this.#refused('WELCOME_LEDGER_DISABLED');
      return Object.freeze({ enabled: false, code: 'WELCOME_LEDGER_DISABLED' });
    }
    try {
      if (ledger.purposeId !== PURPOSE_ID || ledger.closed || ledger.failed || ledger.quarantined) {
        throw Object.assign(new Error('Welcome ledger is unusable.'), { code: 'WELCOME_LEDGER_UNUSABLE' });
      }
      assertDistinctDataPaths([
        ...reservedDescriptors,
        { filePath: ledger.locations.ledgerPath },
        { filePath: ledger.locations.anchorPath },
        { filePath: ledger.locations.receiptPath },
        { filePath: ledger.continuityWitness?.filePath },
      ]);
      const purpose = ledger.provenance?.purposeIdentity;
      if (purpose?.purposeId !== PURPOSE_ID || purpose?.sourceNamespace !== SOURCE_NAMESPACE ||
          purpose?.botId !== this.botId || !Number.isSafeInteger(purpose?.cutoverJoinedTimestampMs)) {
        throw Object.assign(new Error('Welcome purpose provenance is unavailable.'), { code: 'WELCOME_PURPOSE_INVALID' });
      }
      this.ledger = ledger;
      this.cutoverJoinedTimestampMs = purpose.cutoverJoinedTimestampMs;
      this.disabled = false;
      return Object.freeze({ enabled: true, code: 'WELCOME_LEDGER_READY' });
    } catch (error) {
      this.disabled = true;
      // The mapped ledger code (for example SIDE_EFFECT_FORMAT_OUTDATED) names the README step.
      this.log('WELCOME_LEDGER_UNAVAILABLE', error);
      this.#escalations.openFailed(PURPOSE_ID, error);
      this.#refused('WELCOME_LEDGER_UNAVAILABLE');
      return Object.freeze({ enabled: false, code: 'WELCOME_LEDGER_UNAVAILABLE' });
    }
  }

  // Lets queued and later joins be sent (index.js, at ClientReady, after the bot identity
  // check). Never after quiesce() or stop().
  arm() {
    if (!this.accepting) return;
    this.armed = true;
    if (this.queue.length) this.kickDrain();
  }

  // The logged-in bot is not the one the ledger was opened for: welcome messages stay off
  // for this process, and joins queued before the check end without being sent (nothing
  // durable is written). Reported by ledgerAlerts.js, not through onPurposeDisabled.
  disableAll(code = 'WELCOME_DISABLED') {
    if (!this.disabled) this.log(code);
    this.disabled = true;
    this.#finalizeQueued('disabled_before_dispatch');
  }

  #finalizeQueued(resultCode) {
    const queued = this.queue.splice(0);
    for (const task of queued) {
      this.pendingOperations.delete(task.binding.operationId);
      if (task.generation === null || !this.ledger) continue;
      try {
        this.ledger.finalizeClaim(task.binding.operationId, task.generation, resultCode);
      } catch (error) {
        this.#disable('WELCOME_SHUTDOWN_FINALIZE_FAILED', error);
        break;
      }
    }
  }

  accept(effectGrant, effect) {
    const record = this.#effectAuthority?.consumeEffect(effectGrant, effect);
    if (!record) {
      this.log('WELCOME_GRANT_DENIED');
      return false;
    }
    if (!this.#usable()) return false;
    if (!Number.isSafeInteger(record.joinedTimestamp) ||
        record.joinedTimestamp <= this.cutoverJoinedTimestampMs) {
      this.log('WELCOME_BEFORE_CUTOVER');
      return false;
    }
    const binding = buildWelcomeOperation(record);
    if (!binding || !exactEffectMatches(record, effect)) {
      this.log('WELCOME_BINDING_DENIED');
      return false;
    }
    try {
      if (this.pendingOperations.has(binding.operationId)) return false;
      if (!this.armed && this.queue.length >= PRE_ARM_QUEUE_LIMIT) {
        this.log('WELCOME_PRE_ARM_QUEUE_FULL');
        return false;
      }
      if (this.queue.length >= QUEUE_LIMIT) {
        if (!this.egressLimiter) this.ledger.suppress(binding, 'queue_full');
        this.log('WELCOME_QUEUE_FULL');
        return false;
      }
      let generation = null;
      if (!this.egressLimiter) {
        const claimed = this.ledger.claim(binding);
        if (claimed.kind !== 'claimed') return false;
        generation = claimed.operation.generation;
      }
      this.pendingOperations.add(binding.operationId);
      this.queue.push(Object.freeze({
        binding,
        generation,
        effect: Object.freeze({ ...effect, body: JSON.parse(stableJson(effect.body)) }),
        authorizedEffect: record,
      }));
      if (this.armed) this.kickDrain();
      return true;
    } catch (error) {
      this.#disable('WELCOME_LEDGER_FAILED', error);
      return false;
    }
  }

  issueGrant(eventGrant, effect) {
    return this.#effectAuthority?.issueEffect(eventGrant, effect) || null;
  }

  kickDrain() {
    if (this.drainPromise) return;
    this.drainPromise = Promise.resolve().then(() => this.drain())
      .catch((error) => this.log('WELCOME_WORKER_FAILED', error))
      .finally(() => {
        this.drainPromise = null;
        if (this.accepting && this.armed && this.queue.length) this.kickDrain();
      });
  }

  async drain() {
    while (this.accepting && this.armed && this.queue.length) await this.process(this.queue.shift());
  }

  // The protected channel of client.rest (protectedRest.js); false when this REST cannot
  // carry it. Installed before the ledger checks, so such a REST is refused like a runtime
  // that cannot take any ledger (WELCOME_LEDGER_DISABLED), never as a fault of the ledger.
  #installProtectedRest() {
    try {
      this.protectedRest = this.protectedRestFactory(this.client?.rest);
      return true;
    } catch {
      return false;
    }
  }

  // The one request of a welcome, exactly as authorized and bound; any other is never sent.
  requestFor(task) {
    if (!exactEffectMatches(task.authorizedEffect, task.effect) ||
        task.effect.method !== 'POST' || task.effect.route !== Routes.channelMessages(task.effect.target) ||
        stableJson(task.effect.body) !== stableJson(task.binding.payload)) {
      throw Object.assign(new Error('WELCOME_EFFECT_BINDING_MISMATCH'), { code: 'binding_mismatch' });
    }
    return { method: 'POST', fullRoute: task.effect.route, body: task.effect.body };
  }

  async process(task) {
    let reservation = null;
    try {
      // A runtime disabled after this task was queued never begins it.
      if (!this.accepting) {
        if (task.generation !== null) {
          try { this.ledger.finalizeClaim(task.binding.operationId, task.generation, 'shutdown_before_dispatch'); }
          catch (error) { this.#disable('WELCOME_SHUTDOWN_FINALIZE_FAILED', error); }
        }
        return;
      }
      if (!this.isReady()) return;
      let request;
      try {
        request = this.requestFor(task);
      } catch {
        // The binding no longer matches the authorized effect: never claimed or sent.
        return;
      }
      let generation = task.generation;
      if (generation === null && this.egressLimiter) {
        let reserved;
        try {
          reserved = this.egressLimiter.reserve(request);
        } catch (error) {
          this.#disable('WELCOME_EGRESS_FAILED', error);
          return;
        }
        if (!reserved.allowed) {
          this.log('WELCOME_EGRESS_DEFERRED');
          return;
        }
        reservation = reserved.reservation;
      }
      try {
        if (generation === null) {
          const claimed = this.ledger.claim(task.binding);
          if (claimed.kind !== 'claimed') return;
          generation = claimed.operation.generation;
          if (!this.accepting) {
            this.ledger.finalizeClaim(task.binding.operationId, generation, 'shutdown_before_dispatch');
            return;
          }
        } else {
          const renewed = this.ledger.renew(task.binding.operationId, generation);
          generation = renewed.generation;
          if (!this.accepting) {
            this.ledger.finalizeClaim(task.binding.operationId, generation, 'shutdown_before_dispatch');
            return;
          }
        }
      } catch (error) {
        this.#disable('WELCOME_ATTEMPT_PERSIST_FAILED', error);
        return;
      }
      let attempted = null;
      // At the network entry, in the same synchronous step as the send (protectedRest.js): a
      // runtime that stopped or was disabled meanwhile sends nothing, and the ledger begin is
      // the last step, so a row exists exactly when the welcome reached Discord.
      const enterNetwork = () => {
        if (!this.isReady()) throw Object.assign(new Error('WELCOME_NOT_READY'), { unavailable: true });
        attempted = this.ledger.beginDispatch(task.binding, generation);
      };
      const send = () => this.protectedRest.send(request, {
        deadlineMs: this.dispatchTimeoutMs, label: PROTECTED_LABEL, onNetworkEntry: enterNetwork,
      });
      const sent = reservation
        ? await this.egressLimiter.runWithReservation(reservation, send)
        : await send();
      if (!attempted) {
        this.#settleNotSent(task, generation, sent);
        return;
      }
      // Discord's answer: confirmed, rejected (a 4xx, never sent again), or unknown.
      const state = sent.kind === 'confirmed' ? 'confirmed' : sent.kind === 'rejected' ? 'rejected' : 'unknown';
      try {
        this.ledger.finish(task.binding.operationId, attempted.generation, state, outcomeCode('message', sent),
          outcomeResult(sent));
      } catch (error) {
        this.#disable('WELCOME_FINAL_PERSIST_FAILED', error);
      }
    } finally {
      if (reservation) this.egressLimiter?.cancel(reservation);
      this.pendingOperations.delete(task.binding.operationId);
    }
  }

  // A welcome that never reached Discord wrote nothing, so its claim ends in memory (a join
  // is not tried again). A begin refused at the network entry is settled as before: a join
  // made terminal by its guild's watermark after it was claimed (retention ran in between)
  // ends under the source's code and the ledger stays usable; any other ledger fault stops
  // the runtime.
  #settleNotSent(task, generation, sent) {
    const error = sent.entryError;
    if (sent.reason === 'entry_failed' && error?.unavailable !== true) {
      if (error?.code === 'SIDE_EFFECT_SOURCE_TERMINAL' && !this.ledger.failed) {
        this.#endUnsent(task, generation, error.storeDetail?.reason === 'cutover' ? 'before_cutover' : 'source_watermark');
        return;
      }
      this.#disable('WELCOME_ATTEMPT_PERSIST_FAILED', error);
      return;
    }
    this.#endUnsent(task, generation, sent.reason === 'entry_failed' ? 'shutdown_before_dispatch'
      : sent.reason === 'rate_limited' ? 'rate_limited_before_dispatch'
        : sent.reason === 'deadline' ? 'deadline_before_dispatch' : 'refused_before_dispatch');
  }

  #endUnsent(task, generation, code) {
    try {
      this.ledger.finalizeClaim(task.binding.operationId, generation, code);
    } catch (error) {
      this.#disable('WELCOME_ATTEMPT_PERSIST_FAILED', error);
    }
  }

  // The first step of a stop: no new join is taken, queued joins end without being sent
  // (nothing durable is written), and the one in flight is waited for (its dispatch
  // timeout bounds it). The ledger stays open until stop().
  async quiesce() {
    if (!this.accepting) {
      if (this.drainPromise) await this.drainPromise;
      return;
    }
    this.accepting = false;
    this.armed = false;
    this.#finalizeQueued('shutdown_before_dispatch');
    if (this.drainPromise) await this.drainPromise;
  }

  async stop() {
    if (!this.accepting && !this.ledger) return;
    await this.quiesce();
    if (this.ledger) {
      this.ledger.close();
      this.#escalations.closed(PURPOSE_ID, this.ledger);
    }
    this.ledger = null;
    this.disabled = true;
  }

  getStatsForTests() {
    return Object.freeze({
      accepting: this.accepting,
      disabled: this.disabled,
      queueLength: this.queue.length,
      workerConcurrency: WORKER_CONCURRENCY,
      cutoverJoinedTimestampMs: this.cutoverJoinedTimestampMs,
    });
  }

  async waitForIdleForTests() {
    while (this.drainPromise) await this.drainPromise;
  }
}

module.exports = {
  ACTION,
  DISPATCH_TIMEOUT_MS,
  PURPOSE_ID,
  PRE_ARM_QUEUE_LIMIT,
  QUEUE_LIMIT,
  SOURCE_NAMESPACE,
  WORKER_CONCURRENCY,
  WelcomeSideEffectRuntime,
  buildWelcomeOperation,
  exactEffectMatches,
};
