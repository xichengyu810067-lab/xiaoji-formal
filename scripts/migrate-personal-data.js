#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createReminderSystem } = require('../src/services/reminderService');
const { createCalendarSystem } = require('../src/services/calendarService');
const { createProvenance, personalDataTarget, provenancePath, realTargetLocation } = require('../src/platform/personalDataPaths');

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function fileEvidence(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('來源、快照與目標必須是真實檔案。');
  return { filePath, realPath: fs.realpathSync(filePath),
    fileIdentity: `${stat.dev}:${stat.ino}`, sha256: sha256(filePath) };
}

function exists(filePath) {
  try { fs.lstatSync(filePath); return true; }
  catch (error) { if (error?.code === 'ENOENT') return false; throw error; }
}

function assertLegacySidecarsSafe(kind, sourcePath) {
  const directory = path.dirname(sourcePath);
  const prefix = `${path.basename(sourcePath)}.`;
  const sidecars = fs.readdirSync(directory).filter((name) => name.startsWith(prefix));
  if (sidecars.length === 0) return;
  const backupPath = `${sourcePath}.legacy-v1.bak`;
  const receiptPath = `${sourcePath}.migration-v1.receipt.json`;
  const expected = [path.basename(backupPath), path.basename(receiptPath)].sort();
  if (sidecars.sort().join('\0') !== expected.join('\0')) {
    throw new Error('舊來源有不成對或未知的遷移側檔；保留證據並停止，不得刪除後重跑。');
  }
  const backup = fileEvidence(backupPath);
  const receiptFile = fileEvidence(receiptPath);
  let receipt;
  let records;
  let current;
  try {
    receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const system = kind === 'reminders' ? createReminderSystem : createCalendarSystem;
    const read = kind === 'reminders' ? 'readReminders' : 'readCalendarEvents';
    records = system({ filePath: backupPath })[read]();
    current = system({ filePath: sourcePath })[read]();
  } catch {
    throw new Error('舊來源遷移證據或資料格式無法驗證；保留側檔並停止。');
  }
  const normalized = Object.fromEntries(Object.entries(records).map(([id, record]) => [
    id, { ...record, schemaVersion: 1 },
  ]));
  const expectedText = `${JSON.stringify(normalized, null, 2)}\n`;
  if (receipt?.version !== 1 ||
      receipt.sourceHash !== backup.sha256 || receipt.targetHash !== sha256(sourcePath) ||
      receipt.targetHash !== hashBytes(expectedText) ||
      receipt.recordCount !== Object.keys(records).length ||
      Object.keys(current).sort().join('\0') !== Object.keys(records).sort().join('\0')) {
    throw new Error('舊來源與備份/收據不一致；保留全部證據並停止。');
  }
  return { backup, receiptFile };
}

function migratePersonalData(kind) {
  if (!['reminders', 'calendar'].includes(kind)) throw new Error('只允許明確選擇 reminders 或 calendar。');
  const target = personalDataTarget(kind);
  if (!target.protectedTarget) throw new Error('遷移需先設定專案外受保護的資料目標。');
  const sourcePath = target.legacyPath;
  const targetPath = target.filePath;
  const snapshotPath = `${targetPath}.source-snapshot.json`;
  const receiptPath = provenancePath(targetPath);
  const system = kind === 'reminders' ? createReminderSystem : createCalendarSystem;
  const readName = kind === 'reminders' ? 'readReminders' : 'readCalendarEvents';
  const migrateName = kind === 'reminders' ? 'migrateLegacyReminderStore' : 'migrateLegacyCalendarStore';

  if ([targetPath, snapshotPath, receiptPath, `${targetPath}.lock`,
    `${targetPath}.legacy-v1.bak`, `${targetPath}.migration-v1.receipt.json`].some(exists)) {
    throw new Error('目標或遷移證據已存在；保留全部檔案並人工查明，絕不覆蓋。');
  }
  const sourceMigrationEvidence = assertLegacySidecarsSafe(kind, sourcePath);
  const source = fileEvidence(sourcePath);
  const locations = [sourcePath, targetPath, snapshotPath, receiptPath].map(realTargetLocation);
  if (new Set(locations.map((value) => process.platform === 'win32' ? value.toLowerCase() : value)).size !== locations.length) {
    throw new Error('來源、快照、目標或收據路徑重疊。');
  }
  const original = JSON.parse(fs.readFileSync(sourcePath, 'utf8'));
  if (!original || typeof original !== 'object' || Array.isArray(original)) {
    throw new Error('來源資料根目錄格式錯誤。');
  }
  const originalIds = Object.keys(original).sort();
  const readSource = system({ filePath: sourcePath })[readName]();
  if (Object.keys(readSource).sort().join('\0') !== originalIds.join('\0')) {
    throw new Error('來源資料識別碼不一致。');
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, snapshotPath, fs.constants.COPYFILE_EXCL);
  fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
  if (sha256(snapshotPath) !== source.sha256 || sha256(targetPath) !== source.sha256 ||
      sha256(sourcePath) !== source.sha256) {
    throw new Error('來源或複本在複製時變更；保留部分檔案並停止。');
  }
  const destination = system({ filePath: targetPath });
  destination[migrateName]();
  const migrated = destination[readName]();
  if (Object.keys(migrated).sort().join('\0') !== originalIds.join('\0') ||
      sha256(sourcePath) !== source.sha256) {
    throw new Error('遷移後識別碼或來源資料變更；保留全部證據並停止。');
  }
  for (const id of originalIds) {
    for (const [key, value] of Object.entries(original[id])) {
      if (['userId', 'startsAt', 'remindAt'].includes(key)) continue;
      if (JSON.stringify(migrated[id][key]) !== JSON.stringify(value)) {
        throw new Error('遷移後欄位內容不同；保留全部證據並停止。');
      }
    }
  }
  let legacyMigrationEvidence = null;
  if (sourceMigrationEvidence) {
    const backupPath = `${targetPath}.legacy-v1.bak`;
    const legacyReceiptPath = `${targetPath}.migration-v1.receipt.json`;
    fs.copyFileSync(sourceMigrationEvidence.backup.filePath, backupPath, fs.constants.COPYFILE_EXCL);
    fs.copyFileSync(sourceMigrationEvidence.receiptFile.filePath, legacyReceiptPath, fs.constants.COPYFILE_EXCL);
    if (sha256(sourceMigrationEvidence.backup.filePath) !== sourceMigrationEvidence.backup.sha256 ||
        sha256(sourceMigrationEvidence.receiptFile.filePath) !== sourceMigrationEvidence.receiptFile.sha256 ||
        sha256(backupPath) !== sourceMigrationEvidence.backup.sha256 ||
        sha256(legacyReceiptPath) !== sourceMigrationEvidence.receiptFile.sha256) {
      throw new Error('舊來源的備份或收據在保護複製時變更；保留全部證據並停止。');
    }
    legacyMigrationEvidence = { backup: fileEvidence(backupPath), receipt: fileEvidence(legacyReceiptPath) };
  }
  const receipt = createProvenance(kind, targetPath, {
    source: fileEvidence(snapshotPath), origin: source, legacyMigrationEvidence,
  });
  process.stdout.write(`${kind} 遷移已建立；保留舊來源與受保護快照。請把以下 SHA-256 明確保存到 .env：\n`);
  process.stdout.write(`${kind === 'reminders' ? 'XIAOJI_REMINDERS' : 'XIAOJI_CALENDAR'}_PROVENANCE_SHA256=${receipt.sha256}\n`);
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4 || process.argv[3] !== '--writers-stopped') {
      throw new Error('請先停止所有寫入與提醒計時器，再執行 migrate-personal-data.js <reminders|calendar> --writers-stopped。');
    }
    migratePersonalData(process.argv[2]);
  } catch (error) {
    process.stderr.write(`${error.message} 若有部分檔案已建立，請保留來源、快照與目標人工檢查，不要重跑覆蓋。\n`);
    process.exitCode = 1;
  }
}

module.exports = { migratePersonalData };
