const { createHash } = require('node:crypto');
const {
  CONVERSATION_SAFETY_EVENT_CODES,
  emitConversationSafetyEvent,
} = require('./safetyEvents');
const { observe } = require('../../platform/testControlObservation');
const { createFixedCodeLog } = require('./fixedCodeLog');

const DEFAULT_PROVIDER_GUARD_CONFIG = Object.freeze({
  perUserWindowMs: 20_000,
  perUserMaxRequests: 4,
  duplicateWindowMs: 15_000,
  globalConcurrency: 4,
  timeoutMs: 20_000,
  noticeCooldownMs: 10_000,
  stateTtlMs: 60_000,
  // Counted in states, one per (quota namespace, player), so a player holds at most two (chat, turtle soup).
  maxTrackedUsers: 2_048,
});

const BLOCK_REASONS = Object.freeze({
  DUPLICATE: 'duplicate',
  GLOBAL_BUSY: 'global_busy',
  TIMEOUT: 'timeout',
  USER_BUSY: 'user_busy',
  USER_RATE: 'user_rate',
});

const EVENT_FOR_REASON = Object.freeze({
  [BLOCK_REASONS.DUPLICATE]: CONVERSATION_SAFETY_EVENT_CODES.PROVIDER_DUPLICATE,
  [BLOCK_REASONS.GLOBAL_BUSY]: CONVERSATION_SAFETY_EVENT_CODES.PROVIDER_GLOBAL_BUSY,
  [BLOCK_REASONS.TIMEOUT]: CONVERSATION_SAFETY_EVENT_CODES.PROVIDER_TIMEOUT,
  [BLOCK_REASONS.USER_BUSY]: CONVERSATION_SAFETY_EVENT_CODES.PROVIDER_USER_BUSY,
  [BLOCK_REASONS.USER_RATE]: CONVERSATION_SAFETY_EVENT_CODES.PROVIDER_USER_RATE,
});

class LocalProviderGuardError extends Error {
  constructor(reason, shouldNotify) {
    super('Local AI provider guard blocked the request.');
    this.name = 'LocalProviderGuardError';
    this.code = 'AI_LOCAL_GUARD_BLOCKED';
    this.reason = reason;
    this.eventCode = EVENT_FOR_REASON[reason];
    this.shouldNotify = Boolean(shouldNotify);
  }
}

function isLocalProviderGuardError(error) {
  return error instanceof LocalProviderGuardError || error?.code === 'AI_LOCAL_GUARD_BLOCKED';
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new TypeError(`${name} must be a positive integer.`);
  return number;
}

function normalizeConfig(config = {}) {
  const merged = { ...DEFAULT_PROVIDER_GUARD_CONFIG, ...config };
  return Object.freeze({
    perUserWindowMs: positiveInteger(merged.perUserWindowMs, 'perUserWindowMs'),
    perUserMaxRequests: positiveInteger(merged.perUserMaxRequests, 'perUserMaxRequests'),
    duplicateWindowMs: positiveInteger(merged.duplicateWindowMs, 'duplicateWindowMs'),
    globalConcurrency: positiveInteger(merged.globalConcurrency, 'globalConcurrency'),
    timeoutMs: positiveInteger(merged.timeoutMs, 'timeoutMs'),
    noticeCooldownMs: positiveInteger(merged.noticeCooldownMs, 'noticeCooldownMs'),
    stateTtlMs: positiveInteger(merged.stateTtlMs, 'stateTtlMs'),
    maxTrackedUsers: positiveInteger(merged.maxTrackedUsers, 'maxTrackedUsers'),
  });
}

function fingerprintInput(value) {
  const normalized = String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ')
    .toLocaleLowerCase('zh-Hant').slice(0, 1_500);
  return createHash('sha256').update(normalized).digest('hex');
}

// A player's per-user state (rate window, duplicate inputs, call in flight, busy-notice cooldown) is
// kept per quota namespace, so one feature cannot spend another's allowance. Chat and its fixed
// local replies use the default namespace; the turtle soup judge passes its own. Only that per-user
// state is split: the pool of concurrent calls and the cap on tracked states stay shared by all.
const DEFAULT_QUOTA_NAMESPACE = '';
const QUOTA_NAMESPACE_PATTERN = /^[a-z][a-z0-9-]{0,31}$/u;

// Every quota namespace a caller may name. A name that is not listed (a misspelling, say) is refused
// instead of quietly opening a separate, empty allowance beside the one it was meant to share.
const QUOTA_NAMESPACES = Object.freeze({ TURTLE_SOUP: 'turtle-soup' });
const KNOWN_QUOTA_NAMESPACES = new Set(Object.values(QUOTA_NAMESPACES));

function normalizeQuotaNamespace(value) {
  if (value === undefined || value === null) return DEFAULT_QUOTA_NAMESPACE;
  // The format check also keeps stateKeyFor unambiguous (no NUL), whatever the list ever holds.
  if (typeof value !== 'string' || !QUOTA_NAMESPACE_PATTERN.test(value) || !KNOWN_QUOTA_NAMESPACES.has(value)) {
    throw new TypeError('AI provider guard quota namespace is invalid or not listed.');
  }
  return value;
}

// A namespace never contains NUL, so the first NUL always ends it: two different (namespace, actor)
// pairs cannot share a key, whatever the actor id holds.
function stateKeyFor(actorId, quotaNamespace) {
  return `${quotaNamespace}\u0000${actorId}`;
}

function normalizeContext(context = {}) {
  const actorId = String(context.userId || context.actorId || '').trim();
  const channelId = String(context.channelId || '').trim();
  const guildId = context.guildId === null || context.guildId === undefined
    ? null
    : String(context.guildId).trim();
  if (!actorId || !channelId || guildId === '') {
    throw new TypeError('AI provider guard context is incomplete.');
  }
  return Object.freeze({ actorId, guildId, channelId });
}

// What a reported block leaves by default: a test-control observation (TEST_OBS_<code>), a fixed-code
// log line (at most one per code a minute) and the conversation safety event. The safety catalogue
// decides which of these events are an Owner notice (notifiesOwner); a member can cause any of them.
const guardLog = createFixedCodeLog();

function reportGuardBlock(code, context, at) {
  observe(`TEST_OBS_${code}`);
  guardLog.write(code, 'info', `[AI_GUARD] code=${code}`);
  return emitConversationSafetyEvent(code, context, at);
}

class ProviderCallGuard {
  constructor(config = {}, { now = () => Date.now(), onBlocked = reportGuardBlock } = {}) {
    this.config = normalizeConfig(config);
    this.now = now;
    this.onBlocked = onBlocked;
    this.users = new Map();
    this.activeCalls = 0;
  }

  currentTime() {
    const value = Number(this.now());
    if (!Number.isFinite(value)) throw new TypeError('AI provider guard clock returned an invalid time.');
    return value;
  }

  // `this.users` holds one state per (quota namespace, player); see stateKeyFor.
  cleanup(now) {
    for (const [stateKey, state] of this.users) {
      state.attempts = state.attempts.filter((at) => now - at < this.config.perUserWindowMs);
      for (const [fingerprint, at] of state.recentInputs) {
        if (now - at >= this.config.duplicateWindowMs) state.recentInputs.delete(fingerprint);
      }
      if (!state.inFlight && now - state.lastSeenAt >= this.config.stateTtlMs) this.users.delete(stateKey);
    }
  }

  evictIdleState() {
    let oldest = null;
    for (const [stateKey, state] of this.users) {
      if (state.inFlight) continue;
      if (!oldest || state.lastSeenAt < oldest.state.lastSeenAt) oldest = { stateKey, state };
    }
    if (oldest) this.users.delete(oldest.stateKey);
  }

  getOrCreateState(stateKey, now) {
    let state = this.users.get(stateKey);
    if (state) return state;
    while (this.users.size >= this.config.maxTrackedUsers) {
      const previousSize = this.users.size;
      this.evictIdleState();
      if (this.users.size === previousSize) return null;
    }
    state = {
      attempts: [],
      recentInputs: new Map(),
      inFlight: false,
      lastSeenAt: now,
      lastNoticeAt: null,
    };
    this.users.set(stateKey, state);
    return state;
  }

  // `emitEvent` only decides whether the block is reported to the safety-event hook (and so to the
  // owner). The block itself, the notice cooldown, and the error returned are the same either way.
  blocked(reason, state, context, now, emitEvent = true) {
    const shouldNotify = !state || state.lastNoticeAt === null ||
      now - state.lastNoticeAt >= this.config.noticeCooldownMs;
    if (state) {
      state.lastSeenAt = now;
      if (shouldNotify) state.lastNoticeAt = now;
    }
    if (emitEvent) this.onBlocked(EVENT_FOR_REASON[reason], context, now);
    return new LocalProviderGuardError(reason, shouldNotify);
  }

  acquire(context, input, { emitSafetyEvents = true, quotaNamespace } = {}) {
    const normalizedContext = normalizeContext(context);
    const stateKey = stateKeyFor(normalizedContext.actorId, normalizeQuotaNamespace(quotaNamespace));
    const now = this.currentTime();
    this.cleanup(now);
    const state = this.getOrCreateState(stateKey, now);
    if (!state) throw this.blocked(BLOCK_REASONS.GLOBAL_BUSY, null, normalizedContext, now, emitSafetyEvents);
    state.lastSeenAt = now;
    const fingerprint = fingerprintInput(input);

    if (state.inFlight) throw this.blocked(BLOCK_REASONS.USER_BUSY, state, normalizedContext, now, emitSafetyEvents);
    if (state.recentInputs.has(fingerprint)) {
      throw this.blocked(BLOCK_REASONS.DUPLICATE, state, normalizedContext, now, emitSafetyEvents);
    }
    if (state.attempts.length >= this.config.perUserMaxRequests) {
      throw this.blocked(BLOCK_REASONS.USER_RATE, state, normalizedContext, now, emitSafetyEvents);
    }
    if (this.activeCalls >= this.config.globalConcurrency) {
      throw this.blocked(BLOCK_REASONS.GLOBAL_BUSY, state, normalizedContext, now, emitSafetyEvents);
    }

    state.inFlight = true;
    state.attempts.push(now);
    state.recentInputs.set(fingerprint, now);
    this.activeCalls += 1;
    let released = false;
    return {
      context: normalizedContext,
      state,
      release: () => {
        if (released) return;
        released = true;
        state.inFlight = false;
        state.lastSeenAt = this.currentTime();
        this.activeCalls = Math.max(0, this.activeCalls - 1);
      },
    };
  }

  // Counts one fixed local reply (no provider call) against the per-user rate and duplicate windows.
  // It only enforces DUPLICATE and USER_RATE and never occupies or waits for an in-flight or global
  // slot. A block still emits the safety event but does not spend the busy-notice budget
  // (shouldNotify is always false and lastNoticeAt is untouched). Only chat sends fixed replies, so
  // this always counts in the default quota namespace, next to chat's own provider calls.
  admit(context, input) {
    const normalizedContext = normalizeContext(context);
    const now = this.currentTime();
    this.cleanup(now);
    const state = this.getOrCreateState(stateKeyFor(normalizedContext.actorId, DEFAULT_QUOTA_NAMESPACE), now);
    const reject = (reason) => {
      if (state) state.lastSeenAt = now;
      this.onBlocked(EVENT_FOR_REASON[reason], normalizedContext, now);
      return new LocalProviderGuardError(reason, false);
    };
    // Only reachable if every tracked user is in flight; fail closed instead of skipping the count.
    if (!state) throw reject(BLOCK_REASONS.USER_RATE);
    const fingerprint = fingerprintInput(input);
    if (state.recentInputs.has(fingerprint)) throw reject(BLOCK_REASONS.DUPLICATE);
    if (state.attempts.length >= this.config.perUserMaxRequests) throw reject(BLOCK_REASONS.USER_RATE);
    state.attempts.push(now);
    state.recentInputs.set(fingerprint, now);
    state.lastSeenAt = now;
  }

  // `options.emitSafetyEvents === false` keeps every limit, duplicate check, timeout and returned
  // error exactly as they are, but does not report this call's blocks to the safety-event hook, so
  // routine traffic (a game player resending or asking too fast) cannot use up the owner's
  // notification budget. Any other value, including leaving it out, reports as before.
  //
  // `options.quotaNamespace` names the feature whose per-user limits this call counts against (see
  // stateKeyFor). Leaving it out, or passing null, is the default namespace that chat uses; any
  // other value must be one of QUOTA_NAMESPACES, or the call is refused with a TypeError before
  // anything is counted.
  async execute(context, input, operation, options = {}) {
    if (typeof operation !== 'function') throw new TypeError('AI provider operation must be a function.');
    const emitSafetyEvents = options?.emitSafetyEvents !== false;
    const lease = this.acquire(context, input, { emitSafetyEvents, quotaNamespace: options?.quotaNamespace });
    const controller = new AbortController();
    let timer;
    let timedOut = false;
    const operationPromise = Promise.resolve().then(() => operation(controller.signal));
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(this.blocked(BLOCK_REASONS.TIMEOUT, lease.state, lease.context, this.currentTime(), emitSafetyEvents));
      }, this.config.timeoutMs);
    });
    try {
      return await Promise.race([operationPromise, timeout]);
    } finally {
      clearTimeout(timer);
      if (timedOut) {
        // Keep the per-user and global slots occupied until a provider that ignored
        // AbortSignal really settles. This caps orphaned requests at the pool limit.
        void operationPromise.then(lease.release, lease.release);
      } else {
        lease.release();
      }
    }
  }

  resetForTests() {
    this.users.clear();
    this.activeCalls = 0;
  }

  getStatsForTests() {
    return Object.freeze({
      activeCalls: this.activeCalls,
      // States, not players: one per (quota namespace, player), so one player can count twice.
      trackedUsers: this.users.size,
      // In-flight states, in the same unit: a chat call and a judge question in flight count twice.
      inFlightUsers: [...this.users.values()].filter((state) => state.inFlight).length,
    });
  }
}

const providerCallGuard = new ProviderCallGuard();

module.exports = {
  BLOCK_REASONS,
  DEFAULT_PROVIDER_GUARD_CONFIG,
  LocalProviderGuardError,
  ProviderCallGuard,
  QUOTA_NAMESPACES,
  isLocalProviderGuardError,
  providerCallGuard,
};
