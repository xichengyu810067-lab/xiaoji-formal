'use strict';

// A log of fixed codes: at most one line per key per interval, and the lines left out in between are
// counted on the next one (suppressed=<n>), so a flood of the same event cannot flood the log. Callers
// write only codes and identifiers, never what a member wrote. A clock that goes back starts a new line.

const defaultLogger = require('../../utils/logger');

function createFixedCodeLog({ intervalMs = 60_000, now = () => Date.now(), logger = defaultLogger } = {}) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new TypeError('Fixed code log interval is invalid.');
  const entries = new Map();
  return Object.freeze({
    write(key, level, line) {
      const at = Number(now());
      const entry = entries.get(key);
      if (entry && at >= entry.lastAt && at - entry.lastAt < intervalMs) {
        entry.suppressed += 1;
        return false;
      }
      const suffix = entry?.suppressed ? ` suppressed=${entry.suppressed}` : '';
      entries.set(key, { lastAt: at, suppressed: 0 });
      try {
        logger?.[level]?.(`${line}${suffix}`);
      } catch {
        // Logging never changes a decision.
      }
      return true;
    },
    clear() {
      entries.clear();
    },
  });
}

module.exports = { createFixedCodeLog };
