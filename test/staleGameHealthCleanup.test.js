'use strict';

// Every open of the coin database deletes the maintenance rows the retired web game server left in
// feature_health (tetris, number_match, sudoku with detail game_server_disabled) and nothing else,
// without changing the schema version, so an older release can still open the file.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const test = require('node:test');
const coin = require('../src/systems/economy/storage/coinDatabase');
const { schemaSql } = require('../src/systems/economy/storage/schema');
const { removeStaleWebGameHealthRows } = require('../src/systems/economy/storage/migrations/staleGameHealthCleanup');

const STAMP = '2026-09-01T00:00:00.000Z';

function healthRows(db) {
  return db.prepare('SELECT feature_key, status, detail FROM feature_health ORDER BY feature_key').all()
    .map((row) => ({ ...row }));
}

function insertHealth(db, rows) {
  const insert = db.prepare('INSERT INTO feature_health (feature_key, status, detail, updated_at) VALUES (?, ?, ?, ?)');
  for (const [featureKey, status, detail] of rows) insert.run(featureKey, status, detail, STAMP);
}

test('only the maintenance rows of the retired web game server are deleted, and a second run deletes nothing', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schemaSql);
    insertHealth(db, [
      ['tetris', 'maintenance', 'game_server_disabled'],
      ['number_match', 'maintenance', 'game_server_disabled'],
      ['sudoku', 'maintenance', 'game_server_disabled'],
      ['daily_riddle', 'maintenance', 'game_server_disabled'],
      ['word_chain', 'broken', 'outbox dead letter: x'],
    ]);
    assert.equal(removeStaleWebGameHealthRows(db), 3);
    assert.deepEqual(healthRows(db), [
      { feature_key: 'daily_riddle', status: 'maintenance', detail: 'game_server_disabled' },
      { feature_key: 'word_chain', status: 'broken', detail: 'outbox dead letter: x' },
    ]);
    assert.equal(removeStaleWebGameHealthRows(db), 0);
    assert.equal(healthRows(db).length, 2);
  } finally {
    db.close();
  }
});

test('a solo game row with another status or detail is kept', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(schemaSql);
    const kept = [
      ['number_match', 'maintenance', 'operator_pause'],
      ['sudoku', 'broken', 'game_server_disabled'],
      ['tetris', 'broken', 'reward_contract_invalid'],
    ];
    insertHealth(db, kept);
    assert.equal(removeStaleWebGameHealthRows(db), 0);
    assert.deepEqual(healthRows(db), kept.map(([featureKey, status, detail]) => ({ feature_key: featureKey, status, detail })));

    // A row without a detail is not the server's row either.
    db.exec('DELETE FROM feature_health');
    insertHealth(db, [['tetris', 'maintenance', null]]);
    assert.equal(removeStaleWebGameHealthRows(db), 0);
    assert.equal(healthRows(db).length, 1);
  } finally {
    db.close();
  }
});

test('opening a v24 file deletes the stale rows, keeps schema 24, writes no backup, and the next open deletes nothing', async (t) => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-coin-stale-health-')));
  const previous = process.env.COIN_DB_PATH;
  const dbPath = path.join(root, 'xiaoji.sqlite');
  process.env.COIN_DB_PATH = dbPath;
  coin.resetCoinDatabaseForTests();
  t.after(() => {
    coin.resetCoinDatabaseForTests();
    if (previous === undefined) delete process.env.COIN_DB_PATH;
    else process.env.COIN_DB_PATH = previous;
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  });

  const info = await coin.initializeNewCoinDatabase({ expectedPath: dbPath });
  assert.equal(info.schemaVersion, 24);
  await coin.closeCoinDatabase();
  const file = new DatabaseSync(dbPath);
  try {
    insertHealth(file, [
      ['tetris', 'maintenance', 'game_server_disabled'],
      ['number_match', 'maintenance', 'game_server_disabled'],
      ['sudoku', 'broken', 'reward_contract_invalid'],
      ['daily_riddle', 'maintenance', 'paused'],
    ]);
  } finally {
    file.close();
  }

  const expected = [
    { feature_key: 'daily_riddle', status: 'maintenance', detail: 'paused' },
    { feature_key: 'sudoku', status: 'broken', detail: 'reward_contract_invalid' },
  ];
  const storedVersion = () => coin.withCoinDatabase((api) => api.get(
    "SELECT value, updated_at FROM coin_metadata WHERE key = 'schema_version'"));
  const backups = () => fs.readdirSync(root).filter((name) => /\.pre-v\d+-/u.test(name));

  coin.resetCoinDatabaseForTests();
  await coin.initializeCoinDatabase();
  assert.deepEqual(await coin.withCoinDatabase((api) => healthRows(api.db)), expected);
  const version = await storedVersion();
  assert.equal(version.value, '24');
  assert.equal(await coin.withCoinDatabase((api) => coin.readCoinSchemaVersionWithApi(api)), 24);
  assert.deepEqual(backups(), [], 'a current schema needs no migration backup');
  await coin.closeCoinDatabase();

  coin.resetCoinDatabaseForTests();
  await coin.initializeCoinDatabase();
  assert.deepEqual(await coin.withCoinDatabase((api) => healthRows(api.db)), expected);
  assert.deepEqual(await storedVersion(), version);
  assert.deepEqual(backups(), []);
});
