#!/usr/bin/env node

const path = require('node:path');
const coinDatabase = require('../src/services/coinDatabase');
const { settleLedgerShutdown } = require('../src/systems/safety/ledgerEscalation');

const { getCoinDatabasePath, initializeNewCoinDatabase } = coinDatabase;

async function main() {
  const configuredPath = String(process.env.COIN_DB_PATH || '').trim();
  const requestedPath = process.argv[2];
  if (process.argv.length !== 3 || !configuredPath || !path.isAbsolute(configuredPath) ||
      !path.isAbsolute(requestedPath || '') ||
      path.resolve(requestedPath) !== path.resolve(getCoinDatabasePath())) {
    throw new Error('初裝須先設定絕對 COIN_DB_PATH，並以該相同路徑執行 init-coin-db.js <absolute-db-path>。');
  }
  const result = await initializeNewCoinDatabase({ expectedPath: requestedPath });
  process.stdout.write(`吉幣資料庫已初次建立：${result.path}（schema v${result.schemaVersion}）\n`);
  // The database exists now, but a directory sync that failed after it was created leaves
  // it unconfirmed on disk: reported like at the bot's stop, one line per escalation, and the
  // run ends with the escalation exit code instead of 0.
  settleLedgerShutdown({
    sources: [coinDatabase],
    logger: { error: (line) => process.stderr.write(`${line}\n`) },
    processRef: process,
    exitCode: 0,
  });
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
