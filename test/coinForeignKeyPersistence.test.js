const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const initSqlJs = require('sql.js');
const {
  initializeCoinDatabase, initializeNewCoinDatabase, resetCoinDatabaseForTests,
  withCoinDatabase, withCoinTransaction,
} = require('../src/services/coinDatabase');

const timestamp = '2026-09-26T00:00:00.000Z';
const payrollSql = `INSERT INTO coin_primary_cycle_payroll
  (cycle_id, user_id, source_guild_id, gross_amount, paid_amount, pay_ratio,
   settlement_reason, reward_key, settled_at)
  VALUES (?, 'user-a', 'guild-a', 10, 10, 1, 'fixture', ?, ?)`;

async function assertForeignKeysOn() {
  await withCoinDatabase((api) => {
    assert.equal(Number(api.get('PRAGMA foreign_keys').foreign_keys), 1);
    assert.equal(api.get('PRAGMA foreign_key_check'), null);
  });
}

test('real v22 file keeps foreign keys on across exports, rollback, restart, and write recovery', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-fk-persist-'));
  const dbPath = path.join(directory, 'coins.sqlite');
  const previousPath = process.env.COIN_DB_PATH;
  resetCoinDatabaseForTests();
  process.env.COIN_DB_PATH = dbPath;
  t.after(() => {
    resetCoinDatabaseForTests();
    if (previousPath === undefined) delete process.env.COIN_DB_PATH;
    else process.env.COIN_DB_PATH = previousPath;
    fs.rmSync(directory, { recursive: true, force: true });
  });

  await initializeNewCoinDatabase({ expectedPath: dbPath });
  await assertForeignKeysOn();
  await withCoinTransaction((api) => {
    api.run('INSERT INTO coin_wallets (user_id, created_at, updated_at) VALUES (?, ?, ?)',
      ['user-a', timestamp, timestamp]);
    api.run('INSERT INTO coin_guild_players (guild_id, user_id, created_at, updated_at) VALUES (?, ?, ?, ?)',
      ['guild-a', 'user-a', timestamp, timestamp]);
  });
  await assertForeignKeysOn();
  await withCoinTransaction((api) => {
    api.run(`INSERT INTO coin_primary_jobs_global
      (user_id, job_name, work_days, requested_at, state, updated_at)
      VALUES ('user-a', 'fixture-job', 1, ?, 'active', ?)`, [timestamp, timestamp]);
    api.run(`INSERT INTO coin_primary_job_cycles
      (cycle_id, user_id, job_name, work_days, source_guild_id, starts_at, ends_at,
       salary_rule_version, salary_snapshot_json, status, created_at, updated_at)
      VALUES ('cycle-a', 'user-a', 'fixture-job', 1, 'guild-a', ?, ?, 'v1', '{}', 'active', ?, ?)`,
    [timestamp, timestamp, timestamp, timestamp]);
    api.run(payrollSql, ['cycle-a', 'payroll-a', timestamp]);
  });
  await assertForeignKeysOn();

  const beforeRejectedTransaction = fs.readFileSync(dbPath);
  await assert.rejects(withCoinTransaction((api) => {
    api.run('INSERT INTO coin_wallets (user_id, created_at, updated_at) VALUES (?, ?, ?)',
      ['rollback-user', timestamp, timestamp]);
    api.run(payrollSql, ['nonexistent-cycle', 'payroll-invalid', timestamp]);
  }), /FOREIGN KEY constraint failed/);
  assert.deepEqual(fs.readFileSync(dbPath), beforeRejectedTransaction);
  await assertForeignKeysOn();
  await withCoinDatabase((api) => {
    assert.equal(api.get('SELECT user_id FROM coin_wallets WHERE user_id = ?', ['rollback-user']), null);
    assert.equal(api.get('SELECT cycle_id FROM coin_primary_cycle_payroll WHERE reward_key = ?', ['payroll-invalid']), null);
  });

  await withCoinDatabase((api) => {
    api.run('INSERT INTO coin_wallets (user_id, created_at, updated_at) VALUES (?, ?, ?)',
      ['persist-user', timestamp, timestamp]);
  }, { persist: true });
  await assertForeignKeysOn();

  resetCoinDatabaseForTests();
  await initializeCoinDatabase();
  await assertForeignKeysOn();
  await withCoinDatabase((api) => {
    assert.ok(api.get('SELECT user_id FROM coin_wallets WHERE user_id = ?', ['persist-user']));
    assert.ok(api.get('SELECT cycle_id FROM coin_primary_cycle_payroll WHERE reward_key = ?', ['payroll-a']));
  });
  await assert.rejects(withCoinTransaction((api) => {
    api.run(payrollSql, ['nonexistent-cycle', 'payroll-after-restart', timestamp]);
  }), /FOREIGN KEY constraint failed/);
  await assertForeignKeysOn();

  const beforeWriteFailure = fs.readFileSync(dbPath);
  const originalRename = fs.renameSync;
  fs.renameSync = (source, target) => {
    if (source === `${dbPath}.tmp` && target === dbPath) throw new Error('synthetic rename failure');
    return originalRename(source, target);
  };
  try {
    await assert.rejects(withCoinTransaction((api) => {
      api.run('INSERT INTO coin_wallets (user_id, created_at, updated_at) VALUES (?, ?, ?)',
        ['failed-write-user', timestamp, timestamp]);
    }), /落盤失敗/);
  } finally {
    fs.renameSync = originalRename;
  }
  assert.deepEqual(fs.readFileSync(dbPath), beforeWriteFailure);
  await assertForeignKeysOn();
  await withCoinDatabase((api) => {
    assert.equal(api.get('SELECT user_id FROM coin_wallets WHERE user_id = ?', ['failed-write-user']), null);
  });
  await withCoinTransaction((api) => {
    api.run('INSERT INTO coin_wallets (user_id, created_at, updated_at) VALUES (?, ?, ?)',
      ['after-recovery-user', timestamp, timestamp]);
  });
  await assertForeignKeysOn();

  resetCoinDatabaseForTests();
  const SQL = await initSqlJs({ locateFile: (name) => path.join(path.dirname(require.resolve('sql.js')), name) });
  const corrupted = new SQL.Database(fs.readFileSync(dbPath));
  corrupted.run('PRAGMA foreign_keys = OFF');
  corrupted.run(payrollSql, ['nonexistent-cycle', 'existing-violation', timestamp]);
  fs.writeFileSync(dbPath, Buffer.from(corrupted.export()));
  corrupted.close();
  const invalidSourceBytes = fs.readFileSync(dbPath);
  await assert.rejects(initializeCoinDatabase(), (error) =>
    error.cause?.message.includes('foreign key violation'));
  assert.deepEqual(fs.readFileSync(dbPath), invalidSourceBytes);
});
