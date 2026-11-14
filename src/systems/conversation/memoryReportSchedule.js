'use strict';

// The weekly memory report: 168 hours after the bot started, and every 168 hours after that, the host runs the
// weeklyMemoryReport hook of an extension that handles it (docs/EXTENSION_CONTRACT.md) with the window of the report:
// `since` (the start of the bot for the first report, then the end of the previous window) and `until` (now). The
// window lives in memory only, so a restart starts the count again. With no extension, nothing happens. The report
// itself (what is new in the preference and channel memory, as one HTML file to the bot owner) is the extension's;
// the request boundary admits that one file only from this hook (src/platform/memoryReportFile.js).

const { MEMORY_REPORT_HOOK, MEMORY_REPORT_INTERVAL_MS } = require('../../platform/memoryReportFile');

function startMemoryReportSchedule({
  runHook,
  intervalMs = MEMORY_REPORT_INTERVAL_MS,
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (timer) => clearTimeout(timer),
  logger = console,
} = {}) {
  if (typeof runHook !== 'function') throw new TypeError('runHook is required.');
  let since = now();
  let timer = null;
  let stopped = false;

  async function fire() {
    if (stopped) return;
    const until = now();
    const window = { since, until };
    since = until;
    try {
      await runHook(MEMORY_REPORT_HOOK, window);
    } catch (error) {
      logger.warn?.(`[MEMORY_REPORT] code=MEMORY_REPORT_HOOK_FAILED reason=${String(error?.code || error?.name || 'unknown').slice(0, 60)}`);
    }
    arm();
  }

  function arm() {
    if (stopped) return;
    timer = setTimer(() => { void fire(); }, intervalMs);
    timer?.unref?.();
  }

  arm();
  return Object.freeze({
    stop() {
      stopped = true;
      if (timer) clearTimer(timer);
      timer = null;
    },
    // For tests: the start of the next window.
    get since() {
      return since;
    },
  });
}

module.exports = { startMemoryReportSchedule };
