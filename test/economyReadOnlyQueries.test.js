'use strict';

// The read-only readers behind the owner's casino debt status and coin database status.
//
// readCasinoDebtStatus and readCoinDatabaseStats answer their questions without changing the database file.
//
// These tests run on a real temporary coin database and compare the whole database, and the file on disk, before
// and after each read.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-readonly-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
const DB_PATH = process.env.COIN_DB_PATH;

const {
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const {
  CoinServiceError,
  adjustPlayerBalance,
  getCoinDatabaseStats,
  readCoinDatabaseStats,
  setGuildEconomyEnabled,
} = require('../src/services/coinService');
const {
  applyLoanInterest,
  projectLoanInterest,
  readCasinoDebtStatus,
} = require('../src/systems/economy/loans');
const {
  count,
  expectNoWrites,
  rows,
  seedFixedDeposits,
  seedPlayer,
  snapshotDatabase,
} = require('./support/coinDatabaseProbe');

const HOME = '910000000000000001';
const OTHER = '910000000000000002';
// A guild whose coin system is switched off.
const OFF = '910000000000000004';

// 12:00 in Taipei on the given day.
const DAY = (isoDate) => new Date(`${isoDate}T04:00:00.000Z`);
const TODAY = DAY('2026-10-10');

let userSequence = 0;
const nextUser = () => `92000000000000${String(++userSequence).padStart(4, '0')}`;
// A guild nobody has used the coin system in, so it has no settings row. Each call gives a new one, because
// several of the tests below end by giving their guild a row.
let guildSequence = 0;
const nextColdGuild = () => `93000000000000${String(++guildSequence).padStart(4, '0')}`;

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: DB_PATH });
  await setGuildEconomyEnabled(OFF, false, { operatorId: 'seed-operator' });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const userRowCounts = async (userId) => ({
  wallets: await count('SELECT COUNT(*) AS count FROM coin_wallets WHERE user_id = ?', [userId]),
  guildPlayers: await count('SELECT COUNT(*) AS count FROM coin_guild_players WHERE user_id = ?', [userId]),
  banks: await count('SELECT COUNT(*) AS count FROM coin_bank_accounts_global WHERE user_id = ?', [userId]),
  chips: await count('SELECT COUNT(*) AS count FROM chip_accounts_global WHERE user_id = ?', [userId]),
});

const settingsRows = (guildId) =>
  count('SELECT COUNT(*) AS count FROM coin_guild_settings WHERE guild_id = ?', [guildId]);

// ---------------------------------------------------------------------------------------------------------
// Interest
// ---------------------------------------------------------------------------------------------------------

// The debt is worked out day by day: each day since last_interest_date adds the rate, rounded up. The figures
// are written out here and not computed by the code under test.
const INTEREST_CASES = [
  { name: 'interest already counted today', principal: 1000, rate: 0.03, lastDay: '2026-10-10', debt: 1000, days: 0 },
  { name: 'a last interest date later than today', principal: 1000, rate: 0.03, lastDay: '2099-12-31', debt: 1000, days: 0 },
  { name: 'one day behind', principal: 1000, rate: 0.03, lastDay: '2026-10-09', debt: 1030, days: 1 },
  { name: 'three days behind', principal: 1000, rate: 0.03, lastDay: '2026-10-07', debt: 1093, days: 3 },
  { name: 'rounding up on a small debt', principal: 7, rate: 0.03, lastDay: '2026-10-07', debt: 10, days: 3 },
  { name: 'a rate lowered by relief', principal: 1000, rate: 0.0285, lastDay: '2026-10-05', debt: 1154, days: 5 },
];

for (const scenario of INTEREST_CASES) {
  test(`projected interest matches the interest the stored accrual leaves: ${scenario.name}`, async () => {
    const userId = nextUser();
    await seedPlayer({ guildId: HOME, userId, wallet: 100, loan: scenario.principal, loanDate: DAY(scenario.lastDay) });
    if (scenario.rate !== 0.03) {
      await withCoinTransaction((api) => api.run(
        'UPDATE casino_loans SET interest_rate = ? WHERE user_id = ?', [scenario.rate, userId]
      ));
    }
    const [row] = await rows('SELECT * FROM casino_loans WHERE user_id = ?', [userId]);

    // The projection is pure: it reads a frozen row and returns the figures.
    const projection = projectLoanInterest(Object.freeze({ ...row }), TODAY);
    assert.equal(projection.debt, scenario.debt);
    assert.equal(projection.daysApplied, scenario.days);
    assert.equal(projection.interestAmount, scenario.debt - scenario.principal);
    assert.equal(projection.today, '2026-10-10');

    // The read-only status shows exactly that, and stores nothing.
    const status = await expectNoWrites(() => readCasinoDebtStatus(HOME, userId, { date: TODAY }));
    assert.equal(status.loan.currentDebtAmount, scenario.debt);
    assert.equal(status.pendingDays, scenario.days);
    assert.equal(status.pendingInterest, scenario.debt - scenario.principal);
    assert.equal(status.loan.lastInterestDate, scenario.days === 0 ? scenario.lastDay : '2026-10-10');
    const [untouched] = await rows('SELECT * FROM casino_loans WHERE user_id = ?', [userId]);
    assert.deepEqual(untouched, row, 'the stored loan is exactly as it was');

    // Storing the accrual afterwards leaves the loan the status showed.
    const stored = await withCoinTransaction((api) => applyLoanInterest(api, HOME, userId, TODAY));
    assert.deepEqual(stored.loan, status.loan);
    assert.equal(stored.interestAmount, status.pendingInterest);
    assert.equal(stored.daysApplied, status.pendingDays);
  });
}

// ---------------------------------------------------------------------------------------------------------
// readCasinoDebtStatus
// ---------------------------------------------------------------------------------------------------------

test('the read-only debt status returns the expected projected balance figures without writes', async () => {
  const userId = nextUser();
  await seedPlayer({ guildId: HOME, userId, wallet: 800, bank: 300, loan: 1000, loanDate: DAY('2026-10-07') });
  await seedFixedDeposits(userId, HOME, [
    { principal: 500, expectedInterest: 20, maturityAt: '2026-12-01T00:00:00.000Z' },
    { principal: 200, expectedInterest: 8, maturityAt: '2026-10-05T00:00:00.000Z' },
  ]);

  const read = await expectNoWrites(() => readCasinoDebtStatus(HOME, userId, { date: TODAY }));
  assert.deepEqual(
    {
      pendingInterest: read.pendingInterest,
      pendingDays: read.pendingDays,
      walletBalance: read.walletBalance,
      bankBalance: read.bankBalance,
      chipBalance: read.chipBalance,
      collectableAmount: read.collectableAmount,
      maxCollectableAmount: read.maxCollectableAmount,
      fixedPrincipal: read.fixedPrincipal,
      fixedExpectedInterest: read.fixedExpectedInterest,
      fixedClaimable: read.fixedClaimable,
    },
    {
      pendingInterest: 93,
      pendingDays: 3,
      walletBalance: 800,
      bankBalance: 300,
      chipBalance: 1000,
      collectableAmount: 1100,
      maxCollectableAmount: 1093,
      fixedPrincipal: 700,
      fixedExpectedInterest: 28,
      fixedClaimable: 208,
    }
  );

});

test('a player with no rows reads as zeros and creates nothing', async () => {
  const guildId = nextColdGuild();
  const stranger = nextUser();
  const read = await expectNoWrites(() => readCasinoDebtStatus(guildId, stranger, { date: TODAY }));
  assert.deepEqual(read, {
    loan: null,
    pendingInterest: 0,
    pendingDays: 0,
    walletBalance: 0,
    bankBalance: 0,
    chipBalance: 0,
    collectableAmount: 0,
    maxCollectableAmount: 0,
    fixedPrincipal: 0,
    fixedExpectedInterest: 0,
    fixedClaimable: 0,
  });
  assert.deepEqual(await userRowCounts(stranger), { wallets: 0, guildPlayers: 0, banks: 0, chips: 0 });
  assert.equal(await settingsRows(guildId), 0);

});

test('the guild only supplies the coin switch: every guild with the switch on gives the same answer', async () => {
  const userId = nextUser();
  await seedPlayer({ guildId: HOME, userId, wallet: 640, bank: 90, loan: 400, loanDate: DAY('2026-10-09') });
  await setGuildEconomyEnabled(OTHER, true, { operatorId: 'seed-operator' });
  const cold = nextColdGuild();

  const home = await readCasinoDebtStatus(HOME, userId, { date: TODAY });
  assert.equal(home.loan.currentDebtAmount, 412);
  const other = await expectNoWrites(() => readCasinoDebtStatus(OTHER, userId, { date: TODAY }));
  assert.deepEqual(other, home);
  // A guild without a settings row counts as switched on, and the read does not give it one.
  const unused = await expectNoWrites(() => readCasinoDebtStatus(cold, userId, { date: TODAY }));
  assert.deepEqual(unused, home);
  assert.equal(await settingsRows(cold), 0);
});

test('a guild whose coin system is off refuses the read, and the refusal writes nothing', async () => {
  const userId = nextUser();
  await seedPlayer({ guildId: HOME, userId, wallet: 10, loan: 100 });

  await expectNoWrites(async () => {
    await assert.rejects(
      readCasinoDebtStatus(OFF, userId, { date: TODAY }),
      (error) => error instanceof CoinServiceError
        && error.code === 'COIN_DISABLED'
        && error.message === '這個伺服器的吉幣系統目前停用。'
    );
  });
});

test('the read refuses a missing guild or user with fixed errors', async () => {
  await assert.rejects(readCasinoDebtStatus('', nextUser()), (error) => error.code === 'GUILD_REQUIRED');
  await assert.rejects(readCasinoDebtStatus(HOME, ''), (error) => error.code === 'USER_REQUIRED');
});

// ---------------------------------------------------------------------------------------------------------
// readCoinDatabaseStats
// ---------------------------------------------------------------------------------------------------------

const comparable = (stats) => ({
  info: {
    path: stats.databaseInfo.path,
    exists: stats.databaseInfo.exists,
    existed: stats.databaseInfo.existed,
    createdDatabase: stats.databaseInfo.createdDatabase,
    schemaVersion: stats.databaseInfo.schemaVersion,
  },
  players: stats.players,
  shopItems: stats.shopItems,
  transactions: stats.transactions,
  purchases: stats.purchases,
  adminLogs: stats.adminLogs,
  lastTransaction: stats.lastTransaction,
});

test('the read-only database status counts what the storing one counts, for one guild and for every guild', async () => {
  const first = nextUser();
  const second = nextUser();
  await seedPlayer({ guildId: HOME, userId: first, wallet: 50 });
  await seedPlayer({ guildId: HOME, userId: second, wallet: 60 });
  // The same person in a second guild: one wallet, two guild player rows.
  await adjustPlayerBalance(OTHER, first, { action: 'add', amount: 5, operatorId: 'seed-operator', reason: 'seed' });

  // Worked out straight from the tables, so neither reader is its own oracle.
  const homePlayers = await count('SELECT COUNT(*) AS count FROM coin_guild_players WHERE guild_id = ?', [HOME]);
  const allPlayers = await count('SELECT COUNT(*) AS count FROM coin_guild_players');
  const homeTransactions = await count('SELECT COUNT(*) AS count FROM coin_transactions WHERE guild_id = ?', [HOME]);
  const allTransactions = await count('SELECT COUNT(*) AS count FROM coin_transactions');
  assert.ok(homePlayers >= 2 && allPlayers > homePlayers, 'the fixture has players in more than one guild');

  const home = await expectNoWrites(() => readCoinDatabaseStats(HOME));
  assert.equal(home.players, homePlayers);
  assert.equal(home.transactions, homeTransactions);
  assert.deepEqual(
    [home.settings.enabled, home.settings.recorded, home.settings.guildId],
    [true, true, HOME]
  );

  const everyGuild = await expectNoWrites(() => readCoinDatabaseStats(null));
  assert.equal(everyGuild.players, allPlayers);
  assert.equal(everyGuild.transactions, allTransactions);
  assert.equal(everyGuild.settings, null);
  const noArgument = await expectNoWrites(() => readCoinDatabaseStats());
  assert.deepEqual(comparable(noArgument), comparable(everyGuild));

  // The storing status counts the same numbers.
  const storedHome = await getCoinDatabaseStats(HOME);
  assert.deepEqual(comparable(home), comparable(storedHome));
  assert.deepEqual({ ...storedHome.settings, recorded: true }, home.settings);
  const storedEvery = await getCoinDatabaseStats(null);
  assert.deepEqual(comparable(everyGuild), comparable(storedEvery));
  assert.equal(storedEvery.settings, null);
});

test('the read-only database status reports a guild without a settings row as on, and does not write a row for it', async () => {
  const guildId = nextColdGuild();
  const stats = await expectNoWrites(() => readCoinDatabaseStats(guildId));
  assert.deepEqual(stats.settings, { guildId, enabled: true, recorded: false });
  assert.equal(stats.players, 0);
  assert.equal(stats.transactions, 0);
  assert.equal(await settingsRows(guildId), 0);

  // The storing status gives the guild a row.
  const stored = await getCoinDatabaseStats(guildId);
  assert.equal(stored.settings.enabled, true);
  assert.equal(await settingsRows(guildId), 1);
});

test('the read-only database status shows a guild whose coin system is off instead of refusing it', async () => {
  const stats = await expectNoWrites(() => readCoinDatabaseStats(OFF));
  assert.equal(stats.settings.enabled, false);
  assert.equal(stats.settings.recorded, true);
});
