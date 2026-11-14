// Xiaoji's judge voice: every public announcement the engine logs is posted, in order, in the discussion thread
// under the werewolf panel. The engine log is public text only (no roles unless the table reveals them).
//
// The posting cursor lives in memory. After a restart the cursor is unknown, so only announcements from the last
// two minutes are posted again instead of replaying the whole game into the thread.

const THREAD_NAME = '狼人殺討論區';
const RECOVERY_WINDOW_MS = 2 * 60 * 1000;
const FALLBACK_NOTICE = '⚠️ 小吉沒有建立討論串的權限，主持訊息改發在這個頻道，請直接在這裡討論。';

function createWerewolfNarrator({ transport, clock = () => new Date(), logger = console } = {}) {
  // A transport without thread support (a test double, for one) leaves the panel as the only output.
  const canPost = Boolean(transport) && typeof transport.post === 'function' && typeof transport.ensureThread === 'function';
  const cursors = new Map();
  const targets = new Map();

  async function resolveTarget(session) {
    const known = targets.get(session.id);
    if (known) return known;
    let target;
    try {
      const thread = await transport.ensureThread({
        guildId: session.guildId,
        channelId: session.channelId,
        messageId: session.messageId,
        name: THREAD_NAME,
      });
      target = { threadId: thread.id };
    } catch (error) {
      logger?.warn?.(`[WEREWOLF] discussion thread unavailable code=${String(error?.code || 'UNKNOWN').slice(0, 40)}`);
      target = { threadId: null };
      await transport.post({ guildId: session.guildId, channelId: session.channelId, content: FALLBACK_NOTICE });
    }
    targets.set(session.id, target);
    return target;
  }

  function startingCursor(log) {
    const cutoff = clock().getTime() - RECOVERY_WINDOW_MS;
    let cursor = 0;
    for (const entry of log) if (Date.parse(entry.at) < cutoff) cursor = Math.max(cursor, entry.seq);
    return cursor;
  }

  async function sync(session) {
    if (!canPost || session?.gameKey !== 'werewolf' || !session.messageId || !Array.isArray(session.state?.log)) return 0;
    const log = session.state.log;
    if (!cursors.has(session.id)) cursors.set(session.id, startingCursor(log));
    const pending = log.filter((entry) => entry.seq > cursors.get(session.id));
    let posted = 0;
    if (pending.length) {
      const target = await resolveTarget(session);
      for (const entry of pending) {
        await transport.post({
          guildId: session.guildId,
          channelId: session.channelId,
          threadId: target.threadId,
          content: entry.text,
          mentionUserIds: Array.isArray(entry.ping) ? entry.ping : [],
        });
        cursors.set(session.id, entry.seq);
        posted += 1;
      }
    }
    if (!['lobby', 'active'].includes(session.status)) {
      cursors.delete(session.id);
      targets.delete(session.id);
    }
    return posted;
  }

  return Object.freeze({ sync, THREAD_NAME });
}

module.exports = { FALLBACK_NOTICE, THREAD_NAME, createWerewolfNarrator };
