'use strict';

// Shared helpers for the economy and data-boundary attack tests (test/securityAttack*.test.js).
//
// Every attack here runs in this process against the real service layer and a synthetic SQLite file inside the
// operating system's temporary directory. Nothing in this file reads or writes the repository's data folder, a
// real database, a token or a Discord API; a test that cannot prove its database is inside its own temporary
// root stops before it opens anything.
//
// Order of use in a test file:
//   1. require this file and call createAttackEnvironment() before requiring any service, so every module that
//      reads its path from the environment while loading sees the temporary one;
//   2. require the services;
//   3. call openAttackDatabase(root) in a fresh test, then seed through the real services.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeRealTempDir } = require('./realTempDir');

// Amounts that no money entry may accept. "Accept" means the call returns without error; the attack tests then
// also demand that every table of the database is exactly as it was before the call.
const NEVER_ACCEPTED_AMOUNTS = Object.freeze([
  ['negative one', -1],
  ['negative large', -9_000_000_000],
  ['zero', 0],
  ['negative zero', -0],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['negative Infinity', Number.NEGATIVE_INFINITY],
  ['fraction 1.5', 1.5],
  ['fraction 0.1 + 0.2', 0.1 + 0.2],
  ['one above the 9e9 cap', 9_000_000_001],
  ['Number.MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
  ['2 ** 53', 2 ** 53],
  ['1e21', 1e21],
  ['text "1e21"', '1e21'],
  ['text "abc"', 'abc'],
  ['empty text', ''],
  ['blank text', '   '],
  ['text "-100"', '-100'],
  ['text "1.5"', '1.5'],
  ['text of an unsafe integer', '9007199254740993'],
  ['BigInt above the safe range', 9007199254740993n],
  ['plain object', {}],
  ['two element array', [1, 2]],
]);

// Values JavaScript's Number() turns into a whole number. A service may refuse them or take them, but when it
// takes one it has to apply exactly that whole number and not a different one.
const COERCIBLE_AMOUNTS = Object.freeze([
  ['text "100"', '100', 100],
  ['text " 7 "', ' 7 ', 7],
  ['text "1e3"', '1e3', 1000],
  ['text "0x10"', '0x10', 16],
  ['BigInt 10n', 10n, 10],
  ['true', true, 1],
  ['array [5]', [5], 5],
]);

function createAttackEnvironment(prefix, extraEnvironment = {}) {
  const root = makeRealTempDir(prefix);
  process.env.COIN_DB_PATH = path.join(root, 'attack.sqlite');
  process.env.COIN_TIMEZONE = 'Asia/Taipei';
  process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
  process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
  // The test-control mode sends every retained JSON store (guild quotas, link approvals, memory) to this
  // directory instead of src/data, so no service in this process can reach the repository's data folder.
  process.env.XIAOJI_RUNTIME_MODE = 'test-control';
  process.env.XIAOJI_TEST_DATA_ROOT = root;
  for (const [name, value] of Object.entries(extraEnvironment)) process.env[name] = value;
  return root;
}

function assertInsideRoot(root, filePath, label) {
  const relative = path.relative(root, filePath);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `${label} must stay inside the temporary test root`);
}

// Opens a brand-new, empty coin database inside `root`. Each call starts from nothing, so a test never inherits
// another test's rows.
async function openAttackDatabase(root) {
  const database = require('../../src/services/coinDatabase');
  database.resetCoinDatabaseForTests();
  const databasePath = database.getCoinDatabasePath();
  assertInsideRoot(root, databasePath, 'the coin database');
  fs.rmSync(databasePath, { force: true });
  fs.rmSync(`${databasePath}.tmp`, { force: true });
  await database.initializeNewCoinDatabase({ expectedPath: databasePath });
  return databasePath;
}

function closeAttackDatabase(root) {
  require('../../src/services/coinDatabase').resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
}

async function readRows(sql, params = []) {
  const { withCoinDatabase } = require('../../src/services/coinDatabase');
  return withCoinDatabase((api) => api.all(sql, params));
}

async function readRow(sql, params = []) {
  return (await readRows(sql, params))[0] || null;
}

// Every row of every table. "The ledger did not move" is only meaningful when no table, however unrelated it
// looks, changed.
async function snapshotAllTables() {
  const { withCoinDatabase } = require('../../src/services/coinDatabase');
  return withCoinDatabase((api) => {
    const snapshot = {};
    const tables = api.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name");
    for (const { name } of tables) snapshot[name] = api.all(`SELECT * FROM "${name}" ORDER BY rowid`);
    return snapshot;
  });
}

function changedTables(before, after) {
  return Object.keys({ ...before, ...after })
    .filter((name) => JSON.stringify(before[name]) !== JSON.stringify(after[name]))
    .sort();
}

// Runs `action`, expects it to throw, and proves that no table changed. Returns the error for further checks.
async function assertRejectedWithoutWrites(action, label) {
  const before = await snapshotAllTables();
  let error = null;
  try {
    await action();
  } catch (caught) {
    error = caught;
  }
  const after = await snapshotAllTables();
  assert.ok(error, `${label}: the call was accepted but must be refused`);
  assert.deepEqual(changedTables(before, after), [], `${label}: a refused call must not change any table`);
  return error;
}

// Money has to add up wherever it is kept: every wallet equals the sum of its own transactions, every chip
// account equals the sum of its ledger, and nothing is negative.
async function assertMoneyLedgersConsistent(label = 'ledger') {
  const wallets = await readRows('SELECT user_id, balance, total_earned, total_spent FROM coin_wallets ORDER BY user_id');
  const transactions = await readRows('SELECT user_id, SUM(amount) AS total FROM coin_transactions GROUP BY user_id');
  const sums = new Map(transactions.map((row) => [row.user_id, Number(row.total)]));
  for (const wallet of wallets) {
    assert.ok(wallet.balance >= 0, `${label}: wallet ${wallet.user_id} is negative`);
    assert.equal(wallet.balance, sums.get(wallet.user_id) || 0,
      `${label}: wallet ${wallet.user_id} must equal the sum of its transactions`);
    assert.ok(Number.isSafeInteger(wallet.balance) && Number.isSafeInteger(wallet.total_earned) &&
      Number.isSafeInteger(wallet.total_spent), `${label}: wallet ${wallet.user_id} left the safe integer range`);
  }
  const chips = await readRows('SELECT user_id, balance FROM chip_accounts_global ORDER BY user_id');
  const chipLedger = await readRows('SELECT user_id, SUM(amount) AS total FROM chip_ledger GROUP BY user_id');
  const chipSums = new Map(chipLedger.map((row) => [row.user_id, Number(row.total)]));
  for (const account of chips) {
    assert.ok(account.balance >= 0, `${label}: chips of ${account.user_id} are negative`);
    assert.equal(account.balance, chipSums.get(account.user_id) || 0,
      `${label}: chips of ${account.user_id} must equal the sum of their ledger`);
  }
  const bank = await readRows('SELECT user_id, balance FROM coin_bank_accounts_global WHERE balance < 0');
  assert.deepEqual(bank, [], `${label}: no bank account may be negative`);
}

async function readWallet(userId) {
  const row = await readRow('SELECT balance, total_earned, total_spent FROM coin_wallets WHERE user_id = ?', [userId]);
  return row ? { balance: row.balance, totalEarned: row.total_earned, totalSpent: row.total_spent } : null;
}

async function readChipBalance(userId) {
  return (await readRow('SELECT balance FROM chip_accounts_global WHERE user_id = ?', [userId]))?.balance ?? 0;
}

async function readBankBalance(userId) {
  return (await readRow('SELECT balance FROM coin_bank_accounts_global WHERE user_id = ?', [userId]))?.balance ?? 0;
}

// Failure injection at the database layer. A trigger makes the next matching write fail with a real SQLite
// error, in the middle of the service's own transaction, so what the test sees is the service's real unwinding
// and not a stand-in. `when` is a SQL condition on NEW; the returned function removes the trigger.
async function armFault({ name, table, when = '1', event = 'INSERT' }) {
  const { withCoinTransaction } = require('../../src/services/coinDatabase');
  assert.match(name, /^[a-z0-9_]+$/u, 'fault names are plain identifiers');
  assert.match(table, /^[a-z0-9_]+$/u, 'fault tables are plain identifiers');
  await withCoinTransaction((api) => api.run(
    `CREATE TRIGGER ${name} BEFORE ${event} ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'synthetic fault ${name}'); END`
  ));
  return async function disarm() {
    await withCoinTransaction((api) => api.run(`DROP TRIGGER IF EXISTS ${name}`));
  };
}

function startClock(t, startIso) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(startIso) });
  return {
    at(isoString) { t.mock.timers.setTime(Date.parse(isoString)); },
    advance(milliseconds) { t.mock.timers.tick(milliseconds); },
  };
}

module.exports = {
  COERCIBLE_AMOUNTS,
  NEVER_ACCEPTED_AMOUNTS,
  armFault,
  assertInsideRoot,
  assertMoneyLedgersConsistent,
  assertRejectedWithoutWrites,
  changedTables,
  closeAttackDatabase,
  createAttackEnvironment,
  openAttackDatabase,
  readBankBalance,
  readChipBalance,
  readRow,
  readRows,
  readWallet,
  snapshotAllTables,
  startClock,
};
