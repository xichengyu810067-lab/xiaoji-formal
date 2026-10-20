'use strict';

// Demand-deposit interest against a real, isolated coin database with a controlled clock. Interest for a
// date is paid from 23:00 (Taipei) of that date, one date per run, and only for days the account held a
// balance. Only the database file and the clock are synthetic.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { mock } = test;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-bank-interest-'));
process.env.COIN_DB_PATH = path.join(root, 'bank-interest.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

const { initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinDatabase } = require('../src/services/coinDatabase');
const { adjustPlayerBalance } = require('../src/services/coinService');
const {
  createFixedDeposit,
  deposit,
  processBankInterest,
  withdraw,
} = require('../src/services/bankService');

const GUILD_ID = 'bank-interest-guild';
const DEPOSIT = 1_000_000;
const DAILY = 300;
const QUARTER_HOUR_MS = 15 * 60 * 1000;

// Taipei wall-clock time as a UTC instant.
const taipei = (wallClock) => Date.parse(`${wallClock.replace(' ', 'T')}:00+08:00`);
const setClock = (wallClock) => mock.timers.setTime(taipei(wallClock));

test.before(async () => {
  mock.timers.enable({ apis: ['Date'], now: taipei('2026-09-30 00:00') });
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  mock.timers.reset();
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// One interest run every 15 minutes, like the scheduler, from `from` to `to` inclusive.
async function runEvery15Minutes(from, to) {
  for (let time = taipei(from); time <= taipei(to); time += QUARTER_HOUR_MS) {
    mock.timers.setTime(time);
    await processBankInterest();
  }
}

// Runs around the settlement time on each date from `first` to `last` (YYYY-MM-DD), for long stretches.
async function runDays(first, last) {
  for (let day = Date.parse(`${first}T00:00:00Z`); day <= Date.parse(`${last}T00:00:00Z`); day += 86_400_000) {
    const date = new Date(day).toISOString().slice(0, 10);
    await runEvery15Minutes(`${date} 10:00`, `${date} 10:00`);
    await runEvery15Minutes(`${date} 23:00`, `${date} 23:30`);
  }
}

async function fund(userId, amount) {
  setClock('2026-09-30 00:00');
  await adjustPlayerBalance(GUILD_ID, userId, {
    action: 'add', amount, operatorId: 'bank-admin', reason: '測試資料',
  });
}

const interestOf = (userId, { since = null } = {}) => withCoinDatabase((api) => api.all(
  `SELECT reason, amount FROM coin_transactions
   WHERE user_id = ? AND type = 'bank_interest' AND created_at >= ? ORDER BY id`,
  [userId, since === null ? '' : new Date(taipei(since)).toISOString()]
));
const reasonsOf = (rows) => rows.map((row) => row.reason);
const paidFor = (...dates) => dates.map((date) => `活存利息（${date}）`);
const bankOf = (userId) => withCoinDatabase((api) => Number(
  api.get('SELECT balance FROM coin_bank_accounts_global WHERE user_id = ?', [userId]).balance));

test('a funded account is paid once per day at 23:00, the same amount each day', async () => {
  const userId = 'interest-regular';
  await fund(userId, DEPOSIT);
  setClock('2026-10-01 12:00');
  await deposit(GUILD_ID, userId, DEPOSIT);
  await runEvery15Minutes('2026-10-01 12:00', '2026-10-01 23:45');

  // Three more whole days of runs every 15 minutes.
  await runEvery15Minutes('2026-10-02 00:00', '2026-10-04 23:45');

  const rows = await interestOf(userId, { since: '2026-10-02 00:00' });
  assert.deepEqual(reasonsOf(rows), paidFor('2026-10-02', '2026-10-03', '2026-10-04'));
  assert.deepEqual(rows.map((row) => row.amount), [DAILY, DAILY, DAILY]);
});

test('a first deposit is paid for the day it was made from 23:00, and not for the day before', async () => {
  const userId = 'interest-first-deposit';
  await fund(userId, DEPOSIT);
  setClock('2026-10-05 12:00');
  await deposit(GUILD_ID, userId, DEPOSIT);

  await runEvery15Minutes('2026-10-05 12:00', '2026-10-05 22:45');
  assert.deepEqual(await interestOf(userId), [], 'nothing is paid before 23:00');
  await runEvery15Minutes('2026-10-05 23:00', '2026-10-05 23:45');

  assert.deepEqual(reasonsOf(await interestOf(userId)), paidFor('2026-10-05'));
});

test('days an account sat empty earn nothing when a large amount is deposited much later', async () => {
  const userId = 'interest-emptied';
  await fund(userId, DEPOSIT);
  setClock('2026-10-10 12:00');
  await deposit(GUILD_ID, userId, DEPOSIT);
  await runEvery15Minutes('2026-10-10 12:00', '2026-10-10 23:45');

  // Everything is taken out and the account stays empty through days of runs.
  setClock('2026-10-11 10:00');
  await withdraw(GUILD_ID, userId, DEPOSIT);
  assert.equal(await bankOf(userId), 0);
  await runDays('2026-10-11', '2026-10-19');
  assert.deepEqual(await interestOf(userId, { since: '2026-10-11 10:00' }), []);

  // A large deposit much later: only the day it is held is paid, not the days it was missing.
  setClock('2026-10-20 10:00');
  await deposit(GUILD_ID, userId, DEPOSIT);
  await runEvery15Minutes('2026-10-20 10:00', '2026-10-20 23:45');
  await runEvery15Minutes('2026-10-21 00:00', '2026-10-21 08:00');

  assert.deepEqual(reasonsOf(await interestOf(userId, { since: '2026-10-11 10:00' })), paidFor('2026-10-20'));
});

test('an account that was funded while the bot was down is paid for every missed day, one per run', async () => {
  const userId = 'interest-downtime';
  await fund(userId, DEPOSIT);
  setClock('2026-10-25 12:00');
  await deposit(GUILD_ID, userId, DEPOSIT);
  await runEvery15Minutes('2026-10-25 12:00', '2026-10-25 23:45');

  // No runs from the 26th to the 29th. The bot is back on the 30th at 10:00.
  await runEvery15Minutes('2026-10-30 10:00', '2026-10-30 23:45');

  assert.deepEqual(
    reasonsOf(await interestOf(userId, { since: '2026-10-30 00:00' })),
    paidFor('2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30')
  );
});

test('taking everything out and putting money back the same day keeps that day paid', async () => {
  const userId = 'interest-same-day';
  await fund(userId, DEPOSIT);
  setClock('2026-11-01 12:00');
  await deposit(GUILD_ID, userId, DEPOSIT);
  await runEvery15Minutes('2026-11-01 12:00', '2026-11-01 23:45');

  setClock('2026-11-02 09:00');
  await withdraw(GUILD_ID, userId, DEPOSIT);
  setClock('2026-11-02 09:30');
  await deposit(GUILD_ID, userId, DEPOSIT);
  await runEvery15Minutes('2026-11-02 09:30', '2026-11-02 23:45');

  assert.deepEqual(reasonsOf(await interestOf(userId, { since: '2026-11-02 00:00' })), paidFor('2026-11-02'));
});

test('money put into an empty account after 23:00 starts earning the next day', async () => {
  const userId = 'interest-after-settlement';
  await fund(userId, DEPOSIT);
  setClock('2026-11-05 23:30');
  await deposit(GUILD_ID, userId, DEPOSIT);

  await runEvery15Minutes('2026-11-05 23:30', '2026-11-05 23:45');
  assert.deepEqual(await interestOf(userId), []);
  await runEvery15Minutes('2026-11-06 00:00', '2026-11-06 23:45');

  assert.deepEqual(reasonsOf(await interestOf(userId)), paidFor('2026-11-06'));
});

test('adding to an account that still has money does not move its interest date', async () => {
  const userId = 'interest-top-up';
  await fund(userId, 2 * DEPOSIT);
  setClock('2026-11-10 12:00');
  await deposit(GUILD_ID, userId, DEPOSIT);
  await runEvery15Minutes('2026-11-10 12:00', '2026-11-10 23:45');

  // No runs from the 11th to the 13th; a second deposit on the 14th before the first run of the day.
  setClock('2026-11-14 09:00');
  await deposit(GUILD_ID, userId, DEPOSIT);
  await runEvery15Minutes('2026-11-14 09:15', '2026-11-14 23:45');

  assert.deepEqual(
    reasonsOf(await interestOf(userId, { since: '2026-11-14 00:00' })),
    paidFor('2026-11-11', '2026-11-12', '2026-11-13', '2026-11-14')
  );
});

// Some ICU builds print midnight as 24:00 for `hour12: false`. This stand-in does that for that option alone
// and leaves every other formatter to the real one, so the code is checked against such a build.
async function withMidnightPrintedAs24(work) {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  Intl.DateTimeFormat = function DateTimeFormat(locale, options) {
    const formatter = new RealDateTimeFormat(locale, options);
    if (options && options.hour12 === false && options.hourCycle === undefined) {
      const format = formatter.format.bind(formatter);
      Object.defineProperty(formatter, 'format', {
        value: (date) => format(date).replace(/^0?0:/u, '24:'),
      });
    }
    return formatter;
  };
  try {
    return await work();
  } finally {
    Intl.DateTimeFormat = RealDateTimeFormat;
  }
}

test('the first hour of a day is not taken for the settlement hour, also on a formatter that prints 24', async () => {
  const userId = 'interest-midnight-runs';
  await fund(userId, DEPOSIT);
  setClock('2026-12-01 12:00');
  await deposit(GUILD_ID, userId, DEPOSIT);
  await runEvery15Minutes('2026-12-01 12:00', '2026-12-01 23:45');

  await withMidnightPrintedAs24(() => runEvery15Minutes('2026-12-02 00:00', '2026-12-02 00:45'));
  assert.deepEqual(await interestOf(userId, { since: '2026-12-02 00:00' }), [], 'nothing is paid at midnight');

  await runEvery15Minutes('2026-12-02 23:00', '2026-12-02 23:30');
  assert.deepEqual(reasonsOf(await interestOf(userId, { since: '2026-12-02 00:00' })), paidFor('2026-12-02'));
});

test('money put into an empty account just after midnight earns that day, also on a formatter that prints 24', async () => {
  const userId = 'interest-midnight-deposit';
  await fund(userId, DEPOSIT);
  setClock('2026-12-05 00:30');
  await withMidnightPrintedAs24(() => deposit(GUILD_ID, userId, DEPOSIT));

  await runEvery15Minutes('2026-12-05 00:30', '2026-12-05 23:45');

  assert.deepEqual(reasonsOf(await interestOf(userId)), paidFor('2026-12-05'));
});

test('deposit, withdraw and fixed deposit refuse an amount above the coin limit', async () => {
  const userId = 'interest-limit';
  await fund(userId, DEPOSIT);
  setClock('2026-11-20 12:00');
  const refused = (error) => error.code === 'INVALID_AMOUNT' && /9,000,000,000/u.test(error.message);

  await assert.rejects(() => deposit(GUILD_ID, userId, 9_000_000_001), refused);
  await assert.rejects(() => withdraw(GUILD_ID, userId, 9_000_000_001), refused);
  await assert.rejects(
    () => createFixedDeposit(GUILD_ID, userId, { amount: 9_000_000_001, termDays: 7 }), refused);
  // The limit itself is an amount like any other: it fails only for lack of money.
  await assert.rejects(() => deposit(GUILD_ID, userId, 9_000_000_000), (error) => error.code === 'INSUFFICIENT_FUNDS');
});
