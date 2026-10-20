'use strict';

// Helpers for tests that run against a real, temporary coin database and have to prove that something wrote
// nothing, or wrote only where it should. Require this file only after the test has set COIN_DB_PATH: the coin
// database reads its path when it loads.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { withCoinDatabase, withCoinTransaction } = require('../../src/services/coinDatabase');
const { adjustPlayerBalance } = require('../../src/services/coinService');
const { borrowCasinoLoan } = require('../../src/systems/economy/loans');

// Every row of every table, so that "wrote nothing" covers the whole database and not only the tables somebody
// thought of when writing the test.
async function snapshotDatabase() {
  return withCoinDatabase((api) => {
    const tables = api.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    const snapshot = {};
    for (const { name } of tables) snapshot[name] = api.all(`SELECT * FROM "${name}" ORDER BY rowid`);
    return snapshot;
  });
}

function changedTables(before, after) {
  return Object.keys({ ...before, ...after })
    .filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
    .sort();
}

// Names the tables that changed, because "two big objects differ" does not say where to look.
function assertNothingWritten(before, after, label = 'the database') {
  assert.deepEqual(changedTables(before, after), [], `${label} must not change any table`);
}

// The database file as the disk holds it. A read that rewrote the file would change the time even when no row
// changed, so the file is first given an old time that only a rewrite could replace.
function ageDatabaseFile(dbPath) {
  const old = new Date('2020-01-01T00:00:00.000Z');
  fs.utimesSync(dbPath, old, old);
}

function fingerprintDatabaseFile(dbPath) {
  return {
    sha256: crypto.createHash('sha256').update(fs.readFileSync(dbPath)).digest('hex'),
    modifiedMs: fs.statSync(dbPath).mtimeMs,
  };
}

// Runs `action` and proves it changed neither a row of any table nor the database file on disk. Returns what the
// action returned.
async function expectNoWrites(action) {
  const dbPath = process.env.COIN_DB_PATH;
  const before = await snapshotDatabase();
  ageDatabaseFile(dbPath);
  const file = fingerprintDatabaseFile(dbPath);
  const result = await action();
  assertNothingWritten(before, await snapshotDatabase());
  assert.deepEqual(fingerprintDatabaseFile(dbPath), file, 'the database file must not be rewritten');
  return result;
}

// A player the way the economy leaves one: a wallet balance set through the admin path (which also files the
// player under the guild), a bank balance, and optionally a casino loan taken on `loanDate`.
async function seedPlayer({ guildId, userId, wallet = 0, bank = 0, loan = 0, loanDate = new Date() }) {
  await adjustPlayerBalance(guildId, userId, { action: 'set', amount: wallet, operatorId: 'seed-operator', reason: 'seed' });
  if (bank > 0) {
    await withCoinTransaction((api) => api.run(
      'UPDATE coin_bank_accounts_global SET balance = ? WHERE user_id = ?', [bank, userId]
    ));
  }
  if (loan > 0) await borrowCasinoLoan(guildId, userId, { amount: loan, date: loanDate });
}

// Fixed deposits are read by the debt status; there is no short way to make them through the bank, so they are
// inserted the way the bank stores them.
async function seedFixedDeposits(userId, guildId, deposits) {
  await withCoinTransaction((api) => {
    for (const deposit of deposits) {
      api.run(
        `INSERT INTO coin_fixed_deposits
          (guild_id, user_id, principal, term_days, rate, expected_interest, source, status, created_at, maturity_at)
         VALUES (?, ?, ?, 7, 0.01, ?, 'wallet', 'active', '2026-10-01T00:00:00.000Z', ?)`,
        [guildId, userId, deposit.principal, deposit.expectedInterest, deposit.maturityAt]
      );
    }
  });
}

const rows = (sql, params = []) => withCoinDatabase((api) => api.all(sql, params));
const count = (sql, params = []) => withCoinDatabase((api) => Number(api.get(sql, params).count));

module.exports = {
  ageDatabaseFile,
  assertNothingWritten,
  changedTables,
  count,
  expectNoWrites,
  fingerprintDatabaseFile,
  rows,
  seedFixedDeposits,
  seedPlayer,
  snapshotDatabase,
};
