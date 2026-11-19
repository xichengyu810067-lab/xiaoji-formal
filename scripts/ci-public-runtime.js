const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const expected = fs.readFileSync(path.join(__dirname, '..', '.node-version'), 'utf8').trim();
  assert.equal(process.version, `v${expected}`, 'CI must use the fixed Node.js version');

  for (const name of ['XIAOJI_PRIVATE_EXTENSION_PATH', 'XIAOJI_EXTENSION_ASSEMBLY_MANIFEST_PATH']) {
    assert.equal(process.env[name], undefined, `Public runtime must not configure ${name}`);
  }
  const { loadCommands, loadCommandData } = require('../src/loadCommands');
  const commands = loadCommands();
  assert.ok(commands.size > 0);
  assert.equal(commands.size, loadCommandData().length);

  const { Resvg } = require('@resvg/resvg-js');
  const png = new Resvg('<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="blue"/></svg>').render().asPng();
  assert.ok(png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])));

  // The SQLite the coin database runs on: Node's built-in node:sqlite, on a file in WAL mode.
  const { DatabaseSync } = require('node:sqlite');
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-ci-sqlite-'));
  try {
    const file = path.join(folder, 'ledger.sqlite');
    const first = new DatabaseSync(file);
    first.exec('PRAGMA locking_mode = EXCLUSIVE; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL');
    first.exec('CREATE TABLE ledger (amount INTEGER NOT NULL)');
    first.exec('BEGIN IMMEDIATE');
    first.prepare('INSERT INTO ledger VALUES (?)').run(7);
    first.exec('COMMIT');
    first.close();
    assert.deepEqual(fs.readdirSync(folder), ['ledger.sqlite'], 'a clean close leaves no -wal');
    const reopened = new DatabaseSync(file, { readOnly: true });
    assert.deepEqual(reopened.prepare('SELECT amount FROM ledger').all().map((row) => row.amount), [7]);
    reopened.close();
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  console.log(`Public runtime passed: ${commands.size} commands, PNG render, SQLite transaction and reopen.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
