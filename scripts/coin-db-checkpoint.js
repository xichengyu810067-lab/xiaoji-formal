#!/usr/bin/env node
'use strict';

/*
 * Prepares the coin database for a downgrade to a version that still runs on sql.js (before the
 * bot opened the database with node:sqlite in WAL mode). Such a version reads one self-contained
 * file; this script makes the file that:
 *
 *   node scripts/coin-db-checkpoint.js [--coin-db <absolute path>]
 *
 * The path defaults to COIN_DB_PATH (read from .env in the working folder, like the other
 * operations scripts) and must be absolute. The bot must be stopped: while it runs it holds the
 * database exclusively and the script stops with "database is locked". The script opens the file
 * (it never creates one), replays a -wal a crash left beside it, checks integrity, merges the WAL
 * into the file, switches it to the rollback journal (journal_mode=DELETE), checks it again,
 * closes it and confirms no -wal, -shm or -journal is left. The data does not change. A clean stop
 * of the bot already merges the WAL; the script is for a file a crash left with its -wal, and to
 * leave the file in the old journal mode before the old version is deployed.
 *
 * Exit codes: 0 done, 1 usage error or refused.
 */

const path = require('node:path');
const { checkpointCoinDatabaseFile } = require('../src/systems/economy/storage/coinDatabase');

class UsageError extends Error {}

function parseArguments(argv) {
  const options = { coinDb: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--coin-db' && options.coinDb === null && index + 1 < argv.length) {
      options.coinDb = argv[index + 1];
      index += 1;
      continue;
    }
    throw new UsageError('用法：coin-db-checkpoint.js [--coin-db <吉幣資料庫的絕對路徑>]（預設 COIN_DB_PATH）');
  }
  return options;
}

function resolveDatabasePath(options, env) {
  const value = options.coinDb ?? String(env.COIN_DB_PATH || '').trim();
  if (!value) throw new UsageError('請設定 COIN_DB_PATH，或用 --coin-db 指定吉幣資料庫的絕對路徑。');
  if (!path.isAbsolute(value)) throw new UsageError('吉幣資料庫路徑必須是絕對路徑（--coin-db 或 COIN_DB_PATH）。');
  return path.normalize(value);
}

function summary(result) {
  const before = result.sidecarsBefore.length
    ? `旁邊原有 ${result.sidecarsBefore.join('、')}（已併回主檔）`
    : '旁邊原本沒有其他檔案';
  return [
    `吉幣資料庫已整理成單一檔案，可以換回舊版：${result.path}`,
    `- schema 版本：v${result.schemaVersion}`,
    `- ${before}`,
    `- 日誌模式：${result.journalModeBefore === 'wal' ? 'WAL → DELETE' : 'DELETE（原本就是）'}`,
    '- 完整性檢查：ok（整理前後各一次）',
    `- 大小：${result.bytes} bytes，SHA-256：${result.sha256}`,
    '- 旁邊沒有 -wal、-shm、-journal。',
    '',
  ].join('\n');
}

function runCoinDbCheckpoint(argv, { env = process.env, stdout = process.stdout, stderr = process.stderr } = {}) {
  try {
    const dbPath = resolveDatabasePath(parseArguments(argv), env);
    stdout.write(summary(checkpointCoinDatabaseFile(dbPath)));
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      stderr.write(`${error.message}\n`);
      return 1;
    }
    stderr.write(`coin-db-checkpoint 失敗：${error?.name === 'CoinDatabaseError' ? error.message : (error?.code || 'UNEXPECTED_ERROR')}\n`);
    return 1;
  }
}

if (require.main === module) {
  require('dotenv').config({ quiet: true });
  process.exitCode = runCoinDbCheckpoint(process.argv.slice(2));
}

module.exports = { parseArguments, runCoinDbCheckpoint };
