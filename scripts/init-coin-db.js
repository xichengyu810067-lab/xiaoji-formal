#!/usr/bin/env node

const path = require('node:path');
const { getCoinDatabasePath, initializeNewCoinDatabase } = require('../src/services/coinDatabase');

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
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
