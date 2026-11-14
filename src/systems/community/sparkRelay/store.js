'use strict';

// Where 星火接續 rounds are kept: one JSON document per round, in the Turso database of preference memory
// (TURSO_DATABASE_URL and TURSO_AUTH_TOKEN, *.turso.io only). Without both the feature is off.
//
// Every change is a compare-and-set on the round's version: read, change in memory (rules.js), write back only if
// nobody wrote in between, else read again and retry. So two members pressing 報名 at the same moment, or the clock
// and a member's check, never overwrite each other. Finished and cancelled rounds are deleted 30 days after they end.

const { createMemoryStore } = require('./memoryStore');

const STORE_TIMEOUT_MS = 4000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const TURSO_URL = /^(?:libsql|https):\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.turso\.io\/?$/iu;

function rowValue(row, name, index) {
  if (Array.isArray(row)) return row[index];
  return row?.[name];
}

function toRecord(row) {
  if (!row) return null;
  return { version: Number(rowValue(row, 'version', 0)), round: JSON.parse(String(rowValue(row, 'doc', 1))) };
}

function createTursoSparkRelayStore({ url, authToken, createClientImpl } = {}) {
  const createClient = createClientImpl || require('@libsql/client/web').createClient;
  const client = createClient({
    url,
    authToken,
    fetch: (resource, init = {}) => fetch(resource, { ...init, signal: AbortSignal.timeout(STORE_TIMEOUT_MS) }),
  });
  let ready = null;
  const ensureSchema = () => {
    ready ||= client.batch([
      `CREATE TABLE IF NOT EXISTS xiaoji_spark_relay_rounds (
        id TEXT PRIMARY KEY, guild_id TEXT NOT NULL, status TEXT NOT NULL, version INTEGER NOT NULL,
        doc TEXT NOT NULL, updated_at INTEGER NOT NULL)`,
      'CREATE INDEX IF NOT EXISTS xiaoji_spark_relay_rounds_status ON xiaoji_spark_relay_rounds (status, guild_id)',
    ], 'write').catch((error) => {
      ready = null;
      throw error;
    });
    return ready;
  };
  const execute = async (sql, args = []) => {
    await ensureSchema();
    return client.execute({ sql, args });
  };
  return {
    async get(id) {
      const result = await execute('SELECT version, doc FROM xiaoji_spark_relay_rounds WHERE id = ?', [id]);
      return toRecord(result.rows[0]);
    },
    // The rounds in sign-up or running, of one guild or (guildId null) of all.
    async listActive(guildId = null) {
      const result = guildId
        ? await execute(`SELECT version, doc FROM xiaoji_spark_relay_rounds
            WHERE status IN ('signup', 'running') AND guild_id = ?`, [guildId])
        : await execute("SELECT version, doc FROM xiaoji_spark_relay_rounds WHERE status IN ('signup', 'running')");
      return result.rows.map(toRecord);
    },
    async create(round, now) {
      await execute(`INSERT INTO xiaoji_spark_relay_rounds (id, guild_id, status, version, doc, updated_at)
        VALUES (?, ?, ?, 1, ?, ?)`, [round.id, round.guildId, round.status, JSON.stringify(round), now]);
      return { version: 1, round };
    },
    // true when written; false when another write came first.
    async compareAndSet(round, version, now) {
      const result = await execute(`UPDATE xiaoji_spark_relay_rounds SET status = ?, version = ?, doc = ?, updated_at = ?
        WHERE id = ? AND version = ?`, [round.status, version + 1, JSON.stringify(round), now, round.id, version]);
      return Number(result.rowsAffected) === 1;
    },
    async prune(now) {
      await execute(`DELETE FROM xiaoji_spark_relay_rounds
        WHERE status IN ('finished', 'cancelled') AND updated_at < ?`, [now - RETENTION_MS]);
    },
  };
}

let configuredStore = null;
let storeOverride = null;

function getSparkRelayStore() {
  if (storeOverride) return storeOverride;
  const url = String(process.env.TURSO_DATABASE_URL || '').trim();
  const authToken = String(process.env.TURSO_AUTH_TOKEN || '').trim();
  if (!url || !authToken || !TURSO_URL.test(url)) return null;
  configuredStore ||= createTursoSparkRelayStore({ url, authToken });
  return configuredStore;
}

function configureSparkRelayStoreForTests(store) {
  storeOverride = store;
}

module.exports = {
  RETENTION_MS,
  configureSparkRelayStoreForTests,
  createMemoryStore,
  createTursoSparkRelayStore,
  getSparkRelayStore,
};
