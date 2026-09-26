const fs = require('node:fs');
const path = require('node:path');
const { getCoinDatabasePath, initializeCoinDatabase } = require('../services/coinDatabase');
const { getAdmissionDataConfiguration, readAdmissionDataFile } = require('../services/admissionDataContract');
const { readReminders } = require('../services/reminderService');
const { readCalendarEvents } = require('../services/calendarService');
const { getArchivePath, isArchiveCaptureEnabled, preflightArchive } = require('../services/aiArchiveService');
const { assertDistinctDataPaths } = require('./dataPaths');
const { resolvePersonalDataPath } = require('./personalDataPaths');

function requireExistingCoinDatabase(filePath, filesystem = fs) {
  let stat;
  try {
    stat = filesystem.lstatSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error('吉幣資料庫尚未明確初始化；已停止登入。', { cause: error });
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0) {
    throw new Error('吉幣資料庫不是可用的既有檔案；已停止登入。');
  }
}

async function preflightRuntimeData({
  coinPath = getCoinDatabasePath(),
  filesystem = fs,
  admission = getAdmissionDataConfiguration(),
  readAdmission = readAdmissionDataFile,
  readReminderData = readReminders,
  readCalendarData = readCalendarEvents,
  resolvePersonalDescriptors = () => [resolvePersonalDataPath('reminders'), resolvePersonalDataPath('calendar')],
  captureEnabled = isArchiveCaptureEnabled,
  checkArchive = preflightArchive,
  initializeCoins = initializeCoinDatabase,
} = {}) {
  requireExistingCoinDatabase(coinPath, filesystem);
  const descriptors = [{ filePath: coinPath }, admission.audit, admission.whitelist,
    ...resolvePersonalDescriptors()];
  const archivePath = isArchiveCaptureEnabled() ? getArchivePath() : null;
  if (archivePath) {
    const archiveIdentity = process.platform === 'win32'
      ? path.resolve(archivePath).toLowerCase() : path.resolve(archivePath);
    if (descriptors.some(({ filePath }) => (process.platform === 'win32'
      ? path.resolve(filePath).toLowerCase() : path.resolve(filePath)) === archiveIdentity)) {
      throw new Error('AI archive 與其他執行期資料路徑重疊。');
    }
    if (filesystem.existsSync(archivePath)) descriptors.push({ filePath: archivePath });
  }
  assertDistinctDataPaths(descriptors, { filesystem });
  readAdmission(admission.audit);
  readAdmission(admission.whitelist);
  readReminderData();
  readCalendarData();
  if (captureEnabled() && !await checkArchive()) {
    throw new Error('AI archive 無法使用；已停止登入。');
  }
  await initializeCoins();
}

module.exports = { preflightRuntimeData, requireExistingCoinDatabase };
