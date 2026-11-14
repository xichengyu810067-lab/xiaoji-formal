'use strict';

// The same store as the Turso one (store.js), kept in memory: for tests and offline checks. Documents are copied in and
// out, so a caller can never change a stored round without compareAndSet.

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function createMemoryStore() {
  const rows = new Map();
  return {
    rows,
    async get(id) {
      const row = rows.get(id);
      return row ? { version: row.version, round: copy(row.round) } : null;
    },
    async listActive(guildId = null) {
      return [...rows.values()]
        .filter((row) => ['signup', 'running'].includes(row.round.status) && (!guildId || row.round.guildId === guildId))
        .map((row) => ({ version: row.version, round: copy(row.round) }));
    },
    async create(round, now) {
      if (rows.has(round.id)) throw Object.assign(new Error('duplicate round'), { code: 'DUPLICATE' });
      rows.set(round.id, { version: 1, round: copy(round), updatedAt: now });
      return { version: 1, round: copy(round) };
    },
    async compareAndSet(round, version, now) {
      const row = rows.get(round.id);
      if (!row || row.version !== version) return false;
      rows.set(round.id, { version: version + 1, round: copy(round), updatedAt: now });
      return true;
    },
    async prune(now) {
      for (const [id, row] of rows) {
        if (['finished', 'cancelled'].includes(row.round.status) && row.updatedAt < now - RETENTION_MS) rows.delete(id);
      }
    },
  };
}

module.exports = { createMemoryStore };
