const assert = require('node:assert/strict');
const fs = require('node:fs');
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

  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const first = new SQL.Database();
  first.run('CREATE TABLE ledger (amount INTEGER NOT NULL)');
  first.run('BEGIN TRANSACTION');
  first.run('INSERT INTO ledger VALUES (7)');
  first.run('COMMIT');
  const saved = first.export();
  first.close();
  const reopened = new SQL.Database(saved);
  assert.deepEqual(reopened.exec('SELECT amount FROM ledger')[0].values, [[7]]);
  reopened.close();
  console.log(`Public runtime passed: ${commands.size} commands, PNG render, SQLite transaction and reopen.`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
