const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  resetCoinDatabaseForTests, withCoinDatabase,
} = require('../src/services/coinDatabase');
const { adjustPlayerBalance, getPlayerBalance } = require('../src/services/coinService');
const casino = require('../src/services/casinoService');
const loans = require('../src/systems/economy/loans');
const ledger = require('../src/systems/economy/casinoLedger');

let fixtureDir;
let previousDbPath;

test.beforeEach(() => {
  previousDbPath = process.env.COIN_DB_PATH;
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-loans-boundary-'));
  process.env.COIN_DB_PATH = path.join(fixtureDir, 'coin.sqlite');
  resetCoinDatabaseForTests({ allowCreateOnNextOpen: true });
});

test.afterEach(() => {
  resetCoinDatabaseForTests();
  if (previousDbPath === undefined) delete process.env.COIN_DB_PATH;
  else process.env.COIN_DB_PATH = previousDbPath;
  const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
  if (fixtureDir && path.resolve(fixtureDir).startsWith(temporaryRoot)) {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  }
});

test('casino exposes the exact economy loan functions and shared ledger type', () => {
  for (const name of [
    'borrowCasinoLoan', 'repayCasinoLoan', 'getCasinoLoanStatus',
    'getCasinoDebtStatus', 'applyCasinoLoanRelief',
    'collectCasinoDebt', 'processCasinoLoanInterest',
  ]) assert.strictEqual(casino[name], loans[name], name);
  assert.strictEqual(casino.CasinoLedgerType, ledger.CasinoLedgerType);
});

test('game and scheduler use one atomic loan interest path without double accrual', async () => {
  const dayOne = new Date('2026-09-01T00:00:00.000Z');
  const dayTwo = new Date('2026-09-02T00:00:00.000Z');
  const dayThree = new Date('2026-09-03T00:00:00.000Z');
  await casino.borrowCasinoLoan('guild-a', 'user-1', { amount: 100, date: dayOne });

  await assert.rejects(casino.playDice('guild-a', 'user-1', {
    amount: 1, choice: 'invalid', date: dayTwo, rng: () => 0,
  }), { code: 'INVALID_DICE_CHOICE' });
  const rolledBack = await withCoinDatabase((api) => ({
    loan: api.get("SELECT current_debt_amount, last_interest_date FROM casino_loans WHERE status = 'active'"),
    entries: api.get("SELECT COUNT(*) AS count FROM casino_ledger WHERE entry_type = 'loan_interest'").count,
  }));
  assert.equal(Number(rolledBack.loan.current_debt_amount), 100);
  assert.equal(rolledBack.loan.last_interest_date, '2026-09-01');
  assert.equal(Number(rolledBack.entries), 0);

  assert.equal((await casino.processCasinoLoanInterest({ date: dayTwo })).interestAmount, 3);
  await casino.playDice('guild-a', 'user-1', {
    amount: 1, choice: 'big', date: dayTwo, rng: () => 0,
  });
  assert.equal((await casino.processCasinoLoanInterest({ date: dayTwo })).interestAmount, 0);
  assert.equal((await casino.getCasinoLoanStatus('guild-a', 'user-1', { date: dayTwo })).loan.currentDebtAmount, 103);

  await casino.playDice('guild-a', 'user-1', {
    amount: 1, choice: 'big', date: dayThree, rng: () => 0,
  });
  assert.equal((await casino.getCasinoLoanStatus('guild-a', 'user-1', { date: dayThree })).loan.currentDebtAmount, 107);
  const ledgerRows = await withCoinDatabase((api) =>
    api.all("SELECT amount FROM casino_ledger WHERE entry_type = 'loan_interest' ORDER BY id"));
  assert.deepEqual(ledgerRows.map((row) => Number(row.amount)), [3, 4]);
});

test('relief, collection, and repayment keep the loan and wallet in sync', async () => {
  const date = new Date('2026-09-01T00:00:00.000Z');
  await casino.borrowCasinoLoan('guild-a', 'user-1', { amount: 100, date });
  const relief = await casino.applyCasinoLoanRelief('guild-a', 'user-1', {
    operatorId: 'owner', reason: 'synthetic review', date,
  });
  assert.equal(relief.reliefCount, 1);
  await adjustPlayerBalance('guild-a', 'user-1', {
    action: 'add', amount: 20, operatorId: 'owner', reason: 'synthetic collection funds',
  });
  const collection = await casino.collectCasinoDebt('guild-a', 'user-1', {
    amount: 5, operatorId: 'owner', reason: 'synthetic review', date,
  });
  assert.equal(collection.debtAfter, 95);
  assert.equal((await getPlayerBalance('guild-a', 'user-1')).balance, 15);
  const repayment = await casino.repayCasinoLoan('guild-a', 'user-1', { amount: 10, date });
  assert.equal(repayment.loan.currentDebtAmount, 85);
  assert.equal((await casino.getCasinoDebtStatus('guild-a', 'user-1', { date })).loan.currentDebtAmount, 85);
  assert.equal((await casino.processCasinoLoanInterest({ date })).interestAmount, 0);
});
