'use strict';

// How the outside services 小吉 depends on are doing, from what really happened: every call records whether it worked.
// The public status page (publicStatusService.js) reads it, so a feature shows "異常" when the service behind it keeps
// failing, not only when the bot is offline or a command is missing.
//
// A service is:
// - 'maintenance' when it is not configured (no key);
// - 'broken' after 3 failed calls in a row, the last of them within 15 minutes;
// - 'normal' after a call that worked, and when nothing has been called yet (no evidence of a problem).
// A failure older than 15 minutes with nothing since is forgotten, so a quiet service is not shown broken forever.
// Only outcomes are kept, in memory: no request, answer or user data.

// market_data: the quote sources behind /stock (src/systems/stocks/marketData.js).
const SERVICES = Object.freeze(['claude', 'memory_store', 'weather', 'market_data']);
const FAILURES_TO_BREAK = 3;
const FAILURE_MEMORY_MS = 15 * 60 * 1000;

const state = new Map();
const configuredChecks = new Map();

function entry(service) {
  if (!SERVICES.includes(service)) throw new TypeError(`Unknown service: ${service}`);
  if (!state.has(service)) state.set(service, { consecutiveFailures: 0, lastFailureAt: null, lastSuccessAt: null });
  return state.get(service);
}

function recordServiceOutcome(service, ok, at = Date.now()) {
  const current = entry(service);
  if (ok) {
    current.consecutiveFailures = 0;
    current.lastSuccessAt = at;
  } else {
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
  recordServiceOutcome,
  registerServiceConfiguration,
  resetServiceHealthForTests,
  serviceStatus,
};
