'use strict';

// How the outside services 小吉 depends on are doing, from what really happened: every call records whether it worked.
// The public status page (publicStatusService.js) reads it, so a feature shows "異常" when the service behind it keeps
// failing, not only when the bot is offline or a command is missing.
//
// A service is:
// - 'maintenance' when it is not configured (no key);
// - 'broken' when its calls have kept failing for at least 5 minutes: 3 failed calls or more in a row, with no call
//   that worked in between, the first and the last of them at least 5 minutes apart, and the last within 15 minutes.
//   A burst of failures in a few seconds (one slow moment of the network, which makes every call waiting on it time
//   out together) is not enough, and neither is a burst followed by silence: the service must still be failing
//   5 minutes later;
// - 'normal' after a call that worked, and when nothing has been called yet (no evidence of a problem).
// A failure older than 15 minutes with nothing since is forgotten, so a quiet service is not shown broken forever.
// Only outcomes are kept, in memory: no request, answer or user data.

// market_data: the quote sources behind /stock (src/systems/stocks/marketData.js).
const SERVICES = Object.freeze(['claude', 'memory_store', 'weather', 'market_data']);
const FAILURES_TO_BREAK = 3;
const SUSTAINED_FAILURE_MS = 5 * 60 * 1000;
const FAILURE_MEMORY_MS = 15 * 60 * 1000;

const state = new Map();
const configuredChecks = new Map();

function entry(service) {
  if (!SERVICES.includes(service)) throw new TypeError(`Unknown service: ${service}`);
  if (!state.has(service)) {
    state.set(service, { consecutiveFailures: 0, firstFailureAt: null, lastFailureAt: null, lastSuccessAt: null });
  }
  return state.get(service);
}

function recordServiceOutcome(service, ok, at = Date.now()) {
  const current = entry(service);
  if (ok) {
    current.consecutiveFailures = 0;
    current.firstFailureAt = null;
    current.lastSuccessAt = at;
  } else {
    // A failure long after the last one starts a new run: what failed then says nothing about now.
    if (current.consecutiveFailures === 0 || current.lastFailureAt === null || at - current.lastFailureAt > FAILURE_MEMORY_MS) {
      current.consecutiveFailures = 0;
      current.firstFailureAt = at;
    }
    current.consecutiveFailures += 1;
    current.lastFailureAt = at;
  }
}

// configured: a function telling whether the service has its settings (registered by the module that uses it).
function registerServiceConfiguration(service, configured) {
  entry(service);
  configuredChecks.set(service, configured);
}

function serviceStatus(service, now = Date.now()) {
  const current = entry(service);
  const configured = configuredChecks.get(service);
  try {
    if (configured && !configured()) return 'maintenance';
  } catch {
    return 'maintenance';
  }
  if (current.consecutiveFailures >= FAILURES_TO_BREAK && current.lastFailureAt !== null &&
      current.firstFailureAt !== null && current.lastFailureAt - current.firstFailureAt >= SUSTAINED_FAILURE_MS &&
      now - current.lastFailureAt <= FAILURE_MEMORY_MS) {
    return 'broken';
  }
  return 'normal';
}

function resetServiceHealthForTests() {
  state.clear();
  configuredChecks.clear();
}

module.exports = {
  FAILURES_TO_BREAK,
  FAILURE_MEMORY_MS,
  SERVICES,
  SUSTAINED_FAILURE_MS,
  recordServiceOutcome,
  registerServiceConfiguration,
  resetServiceHealthForTests,
  serviceStatus,
};
