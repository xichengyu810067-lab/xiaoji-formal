// One timer per running werewolf table, set for the current phase's deadline. When it fires, the session service
// ends the phase if it is still due (a phase every player already finished has moved on by itself). The board
// lifecycle tick is the fallback for a timer lost to a restart.

const MAX_TIMEOUT_MS = 2 ** 31 - 1;
const SETTLE_DELAY_MS = 750;

function createPhaseTimers({
  advance,
  clock = () => new Date(),
  logger = console,
  runScheduled = (work) => work(),
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  if (typeof advance !== 'function') throw new TypeError('Phase timers need an advance(sessionId) function.');
  const timers = new Map();

  function clear(sessionId) {
    const entry = timers.get(sessionId);
    if (entry) clearTimer(entry.handle);
    timers.delete(sessionId);
  }

  function schedule(sessionId, deadline) {
    const due = Date.parse(String(deadline || ''));
    if (!sessionId || !Number.isFinite(due)) {
      clear(sessionId);
      return false;
    }
    const existing = timers.get(sessionId);
    if (existing?.due === due) return true;
    clear(sessionId);
    const delay = Math.min(MAX_TIMEOUT_MS, Math.max(0, due - clock().getTime()) + SETTLE_DELAY_MS);
    const handle = setTimer(() => {
      if (timers.get(sessionId)?.handle === handle) timers.delete(sessionId);
      void runScheduled(async () => {
        try {
          await advance(sessionId);
        } catch (error) {
          logger?.error?.('werewolf phase timer failed', error);
        }
      });
    }, delay);
    handle?.unref?.();
    timers.set(sessionId, { handle, due });
    return true;
  }

  function stopAll() {
    for (const sessionId of [...timers.keys()]) clear(sessionId);
  }

  return Object.freeze({ clear, schedule, stopAll, size: () => timers.size });
}

module.exports = { createPhaseTimers };
