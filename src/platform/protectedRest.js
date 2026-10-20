'use strict';

/*
 * The protected channel of client.rest. Protected side effects (the public effects, the
 * welcome messages, the Owner notices, and the emergency DM) are sent through send(), on
 * the same REST as every other request: one queue, one set of rate-limit buckets, one
 * global request count, and the same wrappers around rest.request (test-control, the egress
 * guard, and the egress limiter). No second REST is made.
 *
 * installProtectedRest(rest) puts two things on the REST, once per REST:
 * - A gate as rest.options.makeRequest, the one call @discordjs/rest makes for every
 *   request that goes to the network. A request outside a protected attempt passes
 *   through untouched. For a protected attempt the gate lets exactly one request through,
 *   and only while the time kept for Discord's answer is still left before the attempt's
 *   deadline (responseReserveFor: a third of the deadline, at most RESPONSE_RESERVE_MS, so
 *   5 s of the runtimes' 15 s): an attempt that is closed, whose signal was aborted, that
 *   has less than that time left, or that already reached the network is refused before
 *   anything is sent (not_sent, deadline; it can be sent again). So neither a retry inside
 *   discord.js (5xx, timeout, reset, whatever rest.options.retries says) nor a request that
 *   waited in the queue or behind a rate limit too long is ever sent, and a request that is
 *   sent has the kept time for its answer. The gate cannot be replaced afterwards: the
 *   makeRequest and options properties become read-only.
 * - A rate-limit filter as rest.options.rejectOnRateLimit. A protected attempt that meets
 *   a rate limit discord.js already knows (a bucket, or the REST's global limit of 50
 *   requests a second, which every request of the bot counts against) waits it out where
 *   it stands in the queue when the wait ends while the time kept for the answer is still
 *   left, and is refused at once as not_sent (rate_limited) when it does not. A 429 from
 *   Discord itself ends the attempt as rejected; it is never sent again. Every other
 *   request keeps the policy it had.
 *
 * send(request, { deadlineMs, label, onNetworkEntry }) never rejects. request is
 * { method, fullRoute, body } and nothing else (no files, headers, signal, or auth
 * options); label names the attempt and the background job its deadline timer runs in.
 * The answer is frozen and one of:
 * - { kind: 'confirmed', entered: true, value, httpStatus }: Discord answered 2xx.
 * - { kind: 'not_sent', entered: false, reason, ... }: nothing reached the network.
 *   reason: invalid_request; tampered (the gate is not in place); rate_limited (with
 *   retryAfterMs); deadline (the deadline passed first, or the request was aborted in the
 *   queue); entry_failed (with entryError, what onNetworkEntry threw); refused (with
 *   cause, what a layer above the network threw, and causeCode, terminal, retryAfterMs
 *   when the cause carries them).
 * - { kind: 'rejected', entered: true, reason, httpStatus, discordCode }: Discord refused
 *   it (4xx), so it did not take effect. reason: rate_limited (429, with retryAfterMs),
 *   permission (403), not_found (404), or client_error.
 * - { kind: 'unknown', entered: true, reason, httpStatus }: it may have taken effect.
 *   reason: server_error (5xx), timeout (no answer before the deadline or the REST's own
 *   timeout), network, response_invalid (a 2xx whose body could not be read), or
 *   unexpected_status.
 *
 * onNetworkEntry, if given, runs synchronously in the gate when the request is let
 * through, right before the network, and never for a request that is refused. It runs
 * outside the protected context. If it throws, nothing is sent (entry_failed). A runtime
 * puts its ledger begin there, as the last step, so a ledger row exists exactly when the
 * request reached the network.
 *
 * For the wrappers around rest.request (the egress guard and the egress limiter):
 * - currentProtectedAttempt() answers { label } on the path of a protected request (for
 *   example inside a rest.request wrapper) and null anywhere else.
 * - runOutsideProtectedAttempt(fn) runs fn outside the attempt, so an event a wrapper emits
 *   does not carry the attempt into the work it starts.
 * - A wrapper refuses by throwing; the attempt is not_sent with that error as its cause. A
 *   cause may carry terminal: true, a retryAfterMs, and a code; the runtimes read them.
 * - A wrapper calls the next layer at most once per call: a second request of the same
 *   attempt is refused by the gate.
 */

const { AsyncLocalStorage } = require('node:async_hooks');
const { runWithBackgroundContext } = require('./hostOperationContext');

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const REQUEST_FIELDS = new Set(['method', 'fullRoute', 'body']);
const MAX_DEADLINE_MS = 120_000;
const MAX_ROUTE_LENGTH = 2_048;
// The background job rule of hostOperationContext.js: the deadline timer runs as that job.
const LABEL = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const MAX_LABEL_LENGTH = 64;
const CODE = /^[A-Za-z0-9:._-]{1,64}$/u;
// The time kept for Discord's answer at most: a request reaches the network only while at
// least the kept time is left before its deadline, and a known rate limit is waited out only
// if it ends by then (see responseReserveFor).
const RESPONSE_RESERVE_MS = 5_000;

const storage = new AsyncLocalStorage();
const installations = new WeakMap();

// Thrown by the gate; discord.js passes it on unchanged (its name is not AbortError and
// its message never names a connection reset, so it is not retried).
class ProtectedRestRefusal extends Error {
  constructor(reason) {
    super('The protected request was refused before the network.');
    this.name = 'ProtectedRestRefusal';
    this.code = `PROTECTED_REST_${reason.toUpperCase()}`;
    this.reason = reason;
  }
}

function monotonicNow() {
  return performance.now();
}

function nonNegativeMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(Math.ceil(number), Number.MAX_SAFE_INTEGER) : null;
}

function plainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function shapeRequest(request) {
  if (!plainObject(request) || Object.keys(request).some((key) => !REQUEST_FIELDS.has(key))) return null;
  const { method, fullRoute, body } = request;
  if (typeof method !== 'string' || !METHODS.has(method)) return null;
  if (typeof fullRoute !== 'string' || !fullRoute.startsWith('/') || fullRoute.length > MAX_ROUTE_LENGTH ||
      /\s/u.test(fullRoute)) return null;
  if (body !== undefined && body !== null && !plainObject(body)) return null;
  return { method, fullRoute, body: body === undefined ? null : body };
}

// The time a send keeps for Discord's answer: a third of its deadline, at most
// RESPONSE_RESERVE_MS (5 s of the 15 s the runtimes give a send). A test chooses it through
// the deadline it gives.
function responseReserveFor(deadlineMs) {
  return Math.min(RESPONSE_RESERVE_MS, Math.floor(deadlineMs / 3));
}

function validDeadline(deadlineMs) {
  return Number.isSafeInteger(deadlineMs) && deadlineMs > 0 && deadlineMs <= MAX_DEADLINE_MS;
}

function validLabel(label) {
  return typeof label === 'string' && label.length <= MAX_LABEL_LENGTH && LABEL.test(label);
}

function answer(fields) {
  return Object.freeze(fields);
}

function notSent(reason, extra = {}) {
  return answer({ kind: 'not_sent', entered: false, reason, ...extra });
}

function unsupported() {
  return Object.assign(new TypeError('The REST client cannot carry protected requests.'),
    { code: 'PROTECTED_REST_UNSUPPORTED' });
}

// What a refusal above the network carries for the runtime: the error itself, and its
// code, terminal flag, and retry wait when it names them.
function refusedBy(cause) {
  const code = typeof cause?.code === 'string' && CODE.test(cause.code) ? cause.code : null;
  const retryAfterMs = Number.isSafeInteger(cause?.retryAfterMs) && cause.retryAfterMs >= 0 ? cause.retryAfterMs : null;
  return notSent('refused', {
    cause: cause ?? null,
    causeCode: code,
    terminal: cause?.terminal === true,
    ...(retryAfterMs === null ? {} : { retryAfterMs }),
  });
}

function rejectedReason(status) {
  if (status === 403) return 'permission';
  if (status === 404) return 'not_found';
  return 'client_error';
}

function discordCodeOf(error) {
  return Number.isSafeInteger(error?.code) ? error.code : null;
}

// The request was answered (the REST resolved it).
function classifyValue(attempt, value) {
  if (!attempt.entered) return refusedBy(null);
  const status = attempt.httpStatus;
  if (Number.isInteger(status) && status >= 200 && status < 300) {
    return answer({ kind: 'confirmed', entered: true, value, httpStatus: status });
  }
  return answer({ kind: 'unknown', entered: true, reason: 'unexpected_status',
    httpStatus: Number.isInteger(status) ? status : null });
}

// The request failed (the REST rejected it), before or after the network.
function classifyError(attempt, error) {
  if (!attempt.entered) {
    if (attempt.entryError) return notSent('entry_failed', { entryError: attempt.entryError.error });
    if (attempt.rateLimit && !attempt.rateLimit.afterEntry) {
      return notSent('rate_limited', { retryAfterMs: attempt.rateLimit.retryAfterMs ?? 0 });
    }
    // The gate refused it at the deadline, or the deadline aborted it in the queue.
    if (error instanceof ProtectedRestRefusal || attempt.closed) return notSent('deadline');
    return refusedBy(error);
  }
  const status = attempt.httpStatus;
  // Only Discord's own 429 is a rate limit here. A known limit met by a retry inside
  // discord.js (after a 5xx, a reset, or a timeout) is refused by the filter, but the first
  // answer decides what happened.
  if (status === 429) {
    return answer({ kind: 'rejected', entered: true, reason: 'rate_limited', httpStatus: 429, discordCode: null,
      retryAfterMs: attempt.rateLimit?.retryAfterMs ?? 0 });
  }
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    return answer({ kind: 'rejected', entered: true, reason: rejectedReason(status), httpStatus: status,
      discordCode: discordCodeOf(error) });
  }
  if (Number.isInteger(status) && status >= 500 && status < 600) {
    return answer({ kind: 'unknown', entered: true, reason: 'server_error', httpStatus: status });
  }
  if (Number.isInteger(status) && status >= 200 && status < 300) {
    return answer({ kind: 'unknown', entered: true, reason: 'response_invalid', httpStatus: status });
  }
  if (Number.isInteger(status)) {
    return answer({ kind: 'unknown', entered: true, reason: 'unexpected_status', httpStatus: status });
  }
  const networkError = attempt.networkError?.error;
  const timedOut = networkError?.name === 'AbortError' || attempt.closed;
  return answer({ kind: 'unknown', entered: true, reason: timedOut ? 'timeout' : 'network', httpStatus: null });
}

function createGate(inner) {
  return function protectedRestGate(url, init) {
    const attempt = storage.getStore();
    if (!attempt) return inner.call(this, url, init);
    // One request per attempt: a second one is a retry inside discord.js.
    if (attempt.entered) throw new ProtectedRestRefusal('second_entry');
    // Less than the time kept for the answer is left: not sent, so it can be sent again.
    if (attempt.closed || init?.signal?.aborted || monotonicNow() > attempt.entryCutoffAt) {
      throw new ProtectedRestRefusal('deadline');
    }
    if (attempt.onNetworkEntry) {
      try {
        storage.exit(() => attempt.onNetworkEntry());
      } catch (error) {
        attempt.entryError = { error };
        throw new ProtectedRestRefusal('entry_failed');
      }
    }
    // Nothing that can throw lies between the entry hook and the transport.
    attempt.entered = true;
    let pending;
    try {
      pending = inner.call(this, url, init);
    } catch (error) {
      attempt.networkError = { error };
      throw error;
    }
    return Promise.resolve(pending).then((response) => {
      attempt.httpStatus = Number.isInteger(response?.status) ? response.status : null;
      return response;
    }, (error) => {
      attempt.networkError = { error };
      throw error;
    });
  };
}

function createRateLimitFilter(previous) {
  return async function protectedRestRateLimitFilter(rateLimitData) {
    const attempt = storage.getStore();
    if (attempt) {
      const retryAfterMs = nonNegativeMs(rateLimitData?.retryAfter) ?? nonNegativeMs(rateLimitData?.timeToReset) ?? 0;
      // Not on the network yet: a wait that ends while the kept time is still left is
      // waited out.
      if (!attempt.entered && !attempt.closed && monotonicNow() + retryAfterMs <= attempt.entryCutoffAt) {
        return false;
      }
      attempt.rateLimit = Object.freeze({ afterEntry: attempt.entered, retryAfterMs });
      return true;
    }
    if (typeof previous === 'function') return Boolean(await previous(rateLimitData));
    if (Array.isArray(previous)) {
      return previous.some((route) => String(rateLimitData?.route || '').startsWith(String(route).toLowerCase()));
    }
    return false;
  };
}

function send(rest, gate, request, { deadlineMs, label = 'safety.protected-rest', onNetworkEntry = null } = {}) {
  const shaped = shapeRequest(request);
  if (!shaped || !validDeadline(deadlineMs) || !validLabel(label) ||
      (onNetworkEntry !== null && typeof onNetworkEntry !== 'function')) {
    return Promise.resolve(notSent('invalid_request'));
  }
  if (rest.options?.makeRequest !== gate) return Promise.resolve(notSent('tampered'));
  const controller = new AbortController();
  const startedAt = monotonicNow();
  const attempt = {
    label,
    deadlineAt: startedAt + deadlineMs,
    // The last moment the request may reach the network: the kept time is left after it.
    entryCutoffAt: startedAt + deadlineMs - responseReserveFor(deadlineMs),
    onNetworkEntry,
    closed: false,
    entered: false,
    entryError: null,
    networkError: null,
    httpStatus: null,
    rateLimit: null,
  };
  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      attempt.closed = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    // The deadline answers for the attempt even when discord.js is still waiting; the
    // request it leaves behind is refused if it ever reaches the gate.
    timer = setTimeout(() => runWithBackgroundContext(label, () => {
      attempt.closed = true;
      controller.abort();
      finish(attempt.entered
        ? answer({ kind: 'unknown', entered: true, reason: 'timeout', httpStatus: attempt.httpStatus })
        : notSent('deadline'));
    }), deadlineMs);
    let pending;
    try {
      pending = storage.run(attempt, () => rest.request({ ...shaped, signal: controller.signal }));
    } catch (error) {
      pending = Promise.reject(error);
    }
    Promise.resolve(pending).then(
      (value) => finish(classifyValue(attempt, value)),
      (error) => finish(classifyError(attempt, error)),
    );
  });
}

function installProtectedRest(rest) {
  if (!rest || typeof rest !== 'object' || typeof rest.request !== 'function' || !rest.options ||
      typeof rest.options !== 'object' || typeof rest.options.makeRequest !== 'function') {
    throw unsupported();
  }
  const existing = installations.get(rest);
  if (existing) return existing;
  const { options } = rest;
  const gate = createGate(options.makeRequest);
  try {
    Object.defineProperty(options, 'makeRequest', { value: gate, writable: false, configurable: false, enumerable: true });
    Object.defineProperty(rest, 'options', { value: options, writable: false, configurable: false, enumerable: true });
  } catch {
    throw unsupported();
  }
  options.rejectOnRateLimit = createRateLimitFilter(options.rejectOnRateLimit);
  const channel = Object.freeze({
    send: (request, sendOptions) => send(rest, gate, request, sendOptions),
  });
  installations.set(rest, channel);
  return channel;
}

// The result code a runtime records for an answer that reached the network:
// <prefix>_confirmed, <prefix>_rate_limited (429), <prefix>_rejected_permission (403),
// <prefix>_rejected_not_found (404), <prefix>_rejected (any other 4xx), <prefix>_timeout,
// or <prefix>_unknown.
function outcomeCode(prefix, outcome) {
  if (outcome?.kind === 'confirmed') return `${prefix}_confirmed`;
  if (outcome?.kind === 'rejected') {
    if (outcome.reason === 'rate_limited') return `${prefix}_rate_limited`;
    if (outcome.reason === 'permission') return `${prefix}_rejected_permission`;
    if (outcome.reason === 'not_found') return `${prefix}_rejected_not_found`;
    return `${prefix}_rejected`;
  }
  return outcome?.reason === 'timeout' ? `${prefix}_timeout` : `${prefix}_unknown`;
}

// What a runtime records with a rejection: Discord's status and error code, numbers only.
function outcomeResult(outcome) {
  if (outcome?.kind !== 'rejected') return undefined;
  return { httpStatus: outcome.httpStatus, discordCode: outcome.discordCode ?? null };
}

function currentProtectedAttempt() {
  const attempt = storage.getStore();
  return attempt ? Object.freeze({ label: attempt.label }) : null;
}

function runOutsideProtectedAttempt(fn) {
  if (typeof fn !== 'function') throw new TypeError('A callback is required.');
  return storage.exit(fn);
}

module.exports = {
  MAX_DEADLINE_MS,
  RESPONSE_RESERVE_MS,
  currentProtectedAttempt,
  installProtectedRest,
  outcomeCode,
  outcomeResult,
  responseReserveFor,
  runOutsideProtectedAttempt,
};
