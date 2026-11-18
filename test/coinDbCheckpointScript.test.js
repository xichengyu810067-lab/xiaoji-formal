'use strict';

// scripts/coin-db-checkpoint.js: makes the coin database one self-contained rollback-journal file
// before a downgrade to a version that runs on sql.js.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const coin = require('../src/systems/economy/storage/coinDatabase');
const { parseArguments, runCoinDbCheckpoint } = require('../scripts/coin-db-checkpoint');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'coin-db-checkpoint.js');
const STAMP = '2026-11-17T00:00:00.000Z';

function tempRoot(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `xiaoji-coin-checkpoint-${prefix}-`)));
  // after hooks run in the order they were added, so this one runs before openCoinHere's: close the coin
  // database first, because Windows cannot remove a folder that holds an open file.
  t.after(() => {
    coin.resetCoinDatabaseForTests();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return root;
}

// A new coin database at <root>/live/xiaoji.sqlite, open in this process like the running bot.
async function openCoinHere(t, root) {
  const directory = path.join(root, 'live');
  fs.mkdirSync(directory);
  const dbPath = path.join(directory, 'xiaoji.sqlite');
  const previous = process.env.COIN_DB_PATH;
  process.env.COIN_DB_PATH = dbPath;
  coin.resetCoinDatabaseForTests();
  t.after(() => {
    coin.resetCoinDatabaseForTests();
    if (previous === undefined) delete process.env.COIN_DB_PATH;
    else process.env.COIN_DB_PATH = previous;
  });
  await coin.initializeNewCoinDatabase({ expectedPath: dbPath });
  return dbPath;
}

function insertMarker(key) {
  return coin.withCoinTransaction((api) => api.run(
    'INSERT INTO coin_metadata (key, value, updated_at) VALUES (?, ?, ?)', [key, '1', STAMP]
  ));
}

// Copies a file from another process. While this process holds the coin database, it never opens
// the file itself: on POSIX systems closing any descriptor of a file drops every lock the process
// holds on it, SQLite's exclusive lock included.
function copyInChild(source, target) {
  const result = spawnSync(process.execPath, ['-e', 'require("node:fs").copyFileSync(process.argv[1], process.argv[2])', source, target]);
  assert.equal(result.status, 0);
}

// Size and modification time, without opening the file.
function signature(filePath) {
  const stat = fs.statSync(filePath);
  return `${stat.size}:${stat.mtimeMs}`;
}

// The script as another process, from a folder without any .env file.
function runScript(cwd, args, extraEnv = {}) {
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: os.tmpdir(), TMP: os.tmpdir(), ...extraEnv };
  const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd, env, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

// The value of a coin_metadata key in the file alone, read from an in-memory copy of its bytes
// (the file must be a rollback-journal file, which an in-memory database opens as it is).
function valueInFile(dbPath, key) {
  const db = new DatabaseSync(':memory:');
  try {
    db.deserialize(fs.readFileSync(dbPath));
    return db.prepare('SELECT value FROM coin_metadata WHERE key = ?').get(key)?.value ?? null;
  } finally {
    db.close();
  }
}

test('a database a crash left with its -wal becomes one rollback-journal file with every committed transaction', async (t) => {
  const root = tempRoot(t, 'crash');
  const live = await openCoinHere(t, root);
  await insertMarker('before-crash');
  assert.ok(fs.statSync(`${live}-wal`).size > 0, 'the transaction is still in the -wal');
  // A crash: the file and its -wal stay as they are while the bot holds them.
  const crashed = path.join(root, 'crashed');
  fs.mkdirSync(crashed);
  const dbPath = path.join(crashed, 'xiaoji.sqlite');
  copyInChild(live, dbPath);
  copyInChild(`${live}-wal`, `${dbPath}-wal`);
  coin.resetCoinDatabaseForTests();

  const result = runScript(root, ['--coin-db', dbPath]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /可以換回舊版/u);
  assert.match(result.stdout, /schema 版本：v24/u);
  assert.match(result.stdout, /旁邊原有 -wal（已併回主檔）/u);
  assert.match(result.stdout, /WAL → DELETE/u);
  assert.deepEqual(fs.readdirSync(crashed), ['xiaoji.sqlite']);
  const header = fs.readFileSync(dbPath);
  assert.deepEqual([header[18], header[19]], [1, 1], 'a rollback-journal header');
  assert.equal(valueInFile(dbPath, 'before-crash'), '1');

  // The current version opens the file again and switches it back to WAL.
  process.env.COIN_DB_PATH = dbPath;
  coin.resetCoinDatabaseForTests();
  await coin.initializeCoinDatabase();
  assert.equal(await coin.withCoinDatabase((api) => api.get("SELECT value FROM coin_metadata WHERE key = 'before-crash'").value), '1');
  await coin.closeCoinDatabase();
  assert.equal(fs.readFileSync(dbPath)[18], 2);
  assert.deepEqual(fs.readdirSync(crashed), ['xiaoji.sqlite']);
});

test('a cleanly stopped database is switched to the rollback journal; a second run changes nothing', async (t) => {
  const root = tempRoot(t, 'clean');
  const dbPath = await openCoinHere(t, root);
  await insertMarker('clean-stop');
  await coin.closeCoinDatabase();
  assert.deepEqual(fs.readdirSync(path.dirname(dbPath)), ['xiaoji.sqlite']);
  assert.equal(fs.readFileSync(dbPath)[18], 2);

  const out = [];
  const err = [];
  const io = { env: { COIN_DB_PATH: dbPath }, stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) } };
  assert.equal(runCoinDbCheckpoint([], io), 0, err.join(''));
  assert.match(out.join(''), /旁邊原本沒有其他檔案/u);
  assert.equal(fs.readFileSync(dbPath)[18], 1);
  assert.equal(valueInFile(dbPath, 'clean-stop'), '1');
  const bytes = fs.readFileSync(dbPath);

  out.length = 0;
  assert.equal(runCoinDbCheckpoint([], io), 0, err.join(''));
  assert.match(out.join(''), /DELETE（原本就是）/u);
  assert.deepEqual(fs.readFileSync(dbPath), bytes);
  assert.deepEqual(fs.readdirSync(path.dirname(dbPath)), ['xiaoji.sqlite']);
});

test('the script refuses while the bot holds the database (database is locked) and changes nothing', async (t) => {
  const root = tempRoot(t, 'held');
  const dbPath = await openCoinHere(t, root);
  await insertMarker('held');
  const before = signature(dbPath);
  const walBefore = signature(`${dbPath}-wal`);

  // Another process: SQLite's exclusive lock refuses it.
  const result = runScript(root, ['--coin-db', dbPath]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /database is locked/u);
  assert.match(result.stderr, /請先正常停止小吉/u);
  // This process: refused before any connection is opened.
  const err = [];
  assert.equal(runCoinDbCheckpoint(['--coin-db', dbPath], { env: {}, stdout: { write() {} }, stderr: { write: (text) => err.push(text) } }), 1);
  assert.match(err.join(''), /database is locked/u);

  assert.equal(signature(dbPath), before);
  assert.equal(signature(`${dbPath}-wal`), walBefore);
  assert.deepEqual(fs.readdirSync(path.dirname(dbPath)), ['xiaoji.sqlite', 'xiaoji.sqlite-wal']);
  // The bot keeps working.
  await insertMarker('after-refusal');
});

test('the script never creates a database and refuses a relative, missing or unknown path argument', (t) => {
  const root = tempRoot(t, 'usage');
  const missing = path.join(root, 'nothing.sqlite');
  const missingResult = runScript(root, ['--coin-db', missing]);
  assert.equal(missingResult.status, 1);
  assert.match(missingResult.stderr, /不會建立新的資料庫/u);
  assert.deepEqual(fs.readdirSync(root), []);

  const notSqlite = path.join(root, 'empty.sqlite');
  fs.writeFileSync(notSqlite, '');
  const emptyResult = runScript(root, [], { COIN_DB_PATH: notSqlite });
  assert.equal(emptyResult.status, 1);
  assert.match(emptyResult.stderr, /不是 SQLite 資料庫/u);
  assert.deepEqual(fs.readdirSync(root), ['empty.sqlite']);
  assert.equal(fs.statSync(notSqlite).size, 0);

  assert.equal(runScript(root, ['--coin-db', 'relative.sqlite']).status, 1);
  assert.match(runScript(root, []).stderr, /COIN_DB_PATH/u);
  assert.match(runScript(root, ['--force']).stderr, /用法/u);
  assert.throws(() => parseArguments(['--coin-db']), /用法/u);
  assert.throws(() => parseArguments(['--coin-db', 'a', '--coin-db', 'b']), /用法/u);
  assert.deepEqual(parseArguments(['--coin-db', '/x/y.sqlite']), { coinDb: '/x/y.sqlite' });
  assert.deepEqual(fs.readdirSync(root), ['empty.sqlite']);
});
