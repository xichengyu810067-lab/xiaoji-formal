const path = require('node:path');
const crypto = require('node:crypto');
const { CoinDatabaseError } = require('./errors');
const { getRows, getRow, getTableNames } = require('./sqlHelpers');
const { openMemoryCopy, readStoppedDatabaseBytes } = require('./connection');

// ---------------------------------------------------------------------------
// Safety ledger registrations: coin_metadata keys "safety_ledger:<purposeId>"
// ---------------------------------------------------------------------------
// The coin database records which side-effect ledger each protected purpose uses (see
// src/systems/safety/ledgerBootstrap.js, which owns the JSON value format; this module
// only stores the strings). The registration lives in a different restore domain than
// the ledger files, so a ledger restored or replaced together with its witnesses can
// still be caught. Every write is compare-and-set against the value the caller last read: the
// read, the comparison and the write all happen in one BEGIN IMMEDIATE transaction on the coin
// database's operation queue, so nothing can change in between, and its COMMIT is the durable
// write (WAL, synchronous=FULL; see connection.js). A conflict throws
// SAFETY_REGISTRATION_CONFLICT and a failed write SAFETY_REGISTRATION_WRITE_FAILED; either way
// the transaction is rolled back and nothing of it is in the file or in the database.

const SAFETY_LEDGER_KEY_PREFIX = 'safety_ledger:';
const SAFETY_LEDGER_PURPOSE_PATTERN = /^[A-Za-z0-9:._/-]{1,64}$/u;
const SAFETY_LEDGER_VALUE_MAX_BYTES = 4_096;
const SAFETY_LEDGER_MAX_UPDATES = 16;

function safetyRegistrationError(code, message, cause) {
  const error = new CoinDatabaseError(message, cause);
  error.code = code;
  return error;
}

function readSafetyRegistrationRows(db) {
  return getRows(
    db,
    'SELECT key, value, updated_at FROM coin_metadata WHERE substr(key, 1, ?) = ? ORDER BY key',
    [SAFETY_LEDGER_KEY_PREFIX.length, SAFETY_LEDGER_KEY_PREFIX]
  );
}

function safetyRegistrationMap(rows) {
  const registrations = {};
  for (const row of rows) {
    registrations[String(row.key).slice(SAFETY_LEDGER_KEY_PREFIX.length)] = Object.freeze({
      value: String(row.value),
      updatedAt: String(row.updated_at),
    });
  }
  return Object.freeze(registrations);
}

function normalizeSafetyRegistrationUpdates(updates) {
  if (!Array.isArray(updates) || updates.length < 1 || updates.length > SAFETY_LEDGER_MAX_UPDATES) {
    throw safetyRegistrationError('SAFETY_REGISTRATION_INVALID', '安全帳本登記更新內容無效。');
  }
  const seen = new Set();
  return updates.map((update) => {
    const purposeId = typeof update?.purposeId === 'string' ? update.purposeId : '';
    const value = update?.value;
    const expectedValue = update?.expectedValue === undefined || update?.expectedValue === null
      ? null : update.expectedValue;
    if (!SAFETY_LEDGER_PURPOSE_PATTERN.test(purposeId) || seen.has(purposeId) || typeof value !== 'string' ||
        !value || Buffer.byteLength(value) > SAFETY_LEDGER_VALUE_MAX_BYTES ||
        (expectedValue !== null && typeof expectedValue !== 'string')) {
      throw safetyRegistrationError('SAFETY_REGISTRATION_INVALID', '安全帳本登記更新內容無效。');
    }
    seen.add(purposeId);
    return Object.freeze({ key: `${SAFETY_LEDGER_KEY_PREFIX}${purposeId}`, value, expectedValue });
  });
}

// ---------------------------------------------------------------------------
// Safety alert stamps: coin_metadata keys "safety_alert:<name>"
// ---------------------------------------------------------------------------
// When a notice that bypasses every ledger (the Owner emergency DM of
// src/systems/safety/ledgerAlerts.js, which owns the value format) was last sent. The
// coin database always exists before the bot starts, so the stamp survives a ledger
// directory that is itself the problem. Writes are compare-and-set and durable, exactly
// like the registrations above; a failed write throws SAFETY_ALERT_WRITE_FAILED with nothing
// written, and the caller then sends nothing.

const SAFETY_ALERT_KEY_PREFIX = 'safety_alert:';
const SAFETY_ALERT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const SAFETY_ALERT_VALUE_MAX_BYTES = 1_024;

function safetyAlertKey(name) {
  if (typeof name !== 'string' || !SAFETY_ALERT_NAME_PATTERN.test(name)) {
    throw safetyRegistrationError('SAFETY_ALERT_INVALID', '安全提示戳記名稱無效。');
  }
  return `${SAFETY_ALERT_KEY_PREFIX}${name}`;
}

// The functions that use the open coin database. coinDatabase.js, which holds that database, creates
// them once with its own operation queue (withCoinDatabase) and its compare-and-set coin_metadata
// transaction (commitCoinMetadata).
function createSafetyRegistrationStore({ withCoinDatabase, commitCoinMetadata }) {
  // { [purposeId]: { value, updatedAt } } for every safety_ledger:* key, read from the open
  // coin database in operation order with every other coin database call.
  async function readSafetyLedgerRegistrations() {
    return withCoinDatabase((api) => safetyRegistrationMap(readSafetyRegistrationRows(api.db)));
  }

  // Writes every update in one transaction, or nothing. Each update names the value its
  // caller last read (expectedValue; null when the key was absent); if any key differs now,
  // SAFETY_REGISTRATION_CONFLICT is thrown and nothing changes. A failed write throws
  // SAFETY_REGISTRATION_WRITE_FAILED, also with nothing changed.
  async function writeSafetyLedgerRegistrations(updates) {
    const normalized = normalizeSafetyRegistrationUpdates(updates);
    return withCoinDatabase(async (api) => {
      const updatedAt = await commitCoinMetadata(api, normalized, {
        check: (transaction) => {
          const current = new Map(readSafetyRegistrationRows(transaction.db)
            .map((row) => [String(row.key), String(row.value)]));
          for (const update of normalized) {
            if ((current.get(update.key) ?? null) !== update.expectedValue) {
              throw safetyRegistrationError('SAFETY_REGISTRATION_CONFLICT', '安全帳本登記在讀取後已變更，未寫入任何內容。');
            }
          }
        },
        failure: (error) => safetyRegistrationError('SAFETY_REGISTRATION_WRITE_FAILED', '安全帳本登記寫入失敗。', error),
      });
      return Object.freeze({ written: normalized.length, updatedAt });
    });
  }

  // { value, updatedAt } of one stamp, or null when it was never written.
  async function readSafetyAlertStamp(name) {
    const key = safetyAlertKey(name);
    return withCoinDatabase((api) => {
      const row = getRow(api.db, 'SELECT value, updated_at FROM coin_metadata WHERE key = ?', [key]);
      return row ? Object.freeze({ value: String(row.value), updatedAt: String(row.updated_at) }) : null;
    });
  }

  // Replaces one stamp if it still holds expectedValue (null: absent); otherwise
  // SAFETY_ALERT_CONFLICT is thrown and nothing changes.
  async function writeSafetyAlertStamp(name, { value, expectedValue = null } = {}) {
    const key = safetyAlertKey(name);
    if (typeof value !== 'string' || !value || Buffer.byteLength(value) > SAFETY_ALERT_VALUE_MAX_BYTES ||
        (expectedValue !== null && typeof expectedValue !== 'string')) {
      throw safetyRegistrationError('SAFETY_ALERT_INVALID', '安全提示戳記內容無效。');
    }
    return withCoinDatabase(async (api) => {
      const updatedAt = await commitCoinMetadata(api, [{ key, value }], {
        check: (transaction) => {
          const row = getRow(transaction.db, 'SELECT value FROM coin_metadata WHERE key = ?', [key]);
          if ((row ? String(row.value) : null) !== expectedValue) {
            throw safetyRegistrationError('SAFETY_ALERT_CONFLICT', '安全提示戳記在讀取後已變更，未寫入任何內容。');
          }
        },
        failure: (error) => safetyRegistrationError('SAFETY_ALERT_WRITE_FAILED', '安全提示戳記寫入失敗。', error),
      });
      return Object.freeze({ written: 1, updatedAt });
    });
  }

  // Read-only, for scripts/safety-ledger.js: reads a stopped bot's coin database file once into
  // an in-memory copy and returns its safety ledger registrations (connection.js: refused while a
  // -wal lies beside the file). Nothing is ever written, nothing is created beside the file, and
  // the running bot's database (if any) is not involved.
  async function inspectSafetyRegistrationsFromFile(dbPath) {
    if (!path.isAbsolute(String(dbPath || ''))) throw new CoinDatabaseError('吉幣資料庫路徑必須是絕對路徑。');
    const absolutePath = path.resolve(dbPath);
    const bytes = readStoppedDatabaseBytes(absolutePath);
    const db = openMemoryCopy(bytes);
    try {
      const hasMetadata = getTableNames(db).has('coin_metadata');
      const versionRow = hasMetadata ? getRow(db, "SELECT value FROM coin_metadata WHERE key = 'schema_version'") : null;
      return Object.freeze({
        path: absolutePath,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        schemaVersion: versionRow ? Number(versionRow.value) : null,
        registrations: hasMetadata ? safetyRegistrationMap(readSafetyRegistrationRows(db)) : Object.freeze({}),
      });
    } finally {
      db.close();
    }
  }

  return {
    readSafetyLedgerRegistrations,
    writeSafetyLedgerRegistrations,
    readSafetyAlertStamp,
    writeSafetyAlertStamp,
    inspectSafetyRegistrationsFromFile,
  };
}

module.exports = {
  SAFETY_ALERT_KEY_PREFIX,
  SAFETY_LEDGER_KEY_PREFIX,
  createSafetyRegistrationStore,
};
