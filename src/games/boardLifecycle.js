const { BoardCoreError, normalizeDate } = require('./contracts');

function createBoardLifecycle({
  store,
  service,
  clock = () => new Date(),
  intervalMs = 60_000,
  logger = console,
} = {}) {
  if (!store || typeof store.listRecoverable !== 'function' || typeof store.getSessionById !== 'function' ||
      !service || typeof service.status !== 'function' || typeof service.recoverSession !== 'function') {
    throw new BoardCoreError('INVALID_REQUEST', 'Board lifecycle requires recovery-capable store and service instances.');
  }
  if (!Number.isInteger(intervalMs) || intervalMs < 1_000) {
    throw new BoardCoreError('INVALID_REQUEST', 'Board lifecycle interval must be at least one second.');
  }

  const tracked = new Map();
  let timer = null;
  let inFlight = null;

  function track(session) {
    if (!session?.id) return;
    if (['lobby', 'active'].includes(session.status)) {
      tracked.set(session.id, {
        id: session.id,
        guildId: session.guildId,
        channelId: session.channelId,
        hostId: session.hostId,
      });
    } else {
      tracked.delete(session.id);
    }
  }

  async function inspect(entry) {
    try {
      const result = await service.status({ guildId: entry.guildId, channelId: entry.channelId, actorId: entry.hostId });
      track(result.session);
      return result;
    } catch (error) {
      if (error?.code !== 'SESSION_NOT_FOUND') throw error;
      const latest = await store.getSessionById(entry.id);
      if (!latest) {
        tracked.delete(entry.id);
        return null;
      }
      track(latest);
      if (latest.messageId && !['lobby', 'active'].includes(latest.status)) {
        return service.recoverSession({ sessionId: latest.id, actorId: latest.hostId });
      }
      return null;
    }
  }

  async function tick() {
    if (inFlight) return inFlight;
    inFlight = (async () => {
      for (const entry of [...tracked.values()]) {
        try {
          await inspect(entry);
        } catch (error) {
          logger?.error?.('board lifecycle tick failed', error);
        }
      }
    })().finally(() => {
      inFlight = null;
    });
    return inFlight;
  }

  async function start() {
    if (timer) return { started: false, recovered: tracked.size };
    const now = normalizeDate(clock()).toISOString();
    const sessions = await store.listRecoverable({ now, limit: 500 });
    for (const session of sessions) {
      track(session);
      if (!session.messageId) continue;
      try {
        await service.recoverSession({ sessionId: session.id, actorId: session.hostId });
      } catch (error) {
        logger?.error?.('board lifecycle recovery failed', error);
      }
    }
    timer = setInterval(() => { void tick(); }, intervalMs);
    timer.unref?.();
    return { started: true, recovered: sessions.length };
  }

  async function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    if (inFlight) await inFlight;
    tracked.clear();
  }

  return Object.freeze({
    start,
    stop,
    tick,
    track,
    isStarted: () => timer !== null,
    trackedCount: () => tracked.size,
  });
}

module.exports = { createBoardLifecycle };
