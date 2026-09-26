#!/usr/bin/env node

require('dotenv').config({ quiet: true });

const fs = require('node:fs');
const path = require('node:path');
const {
  getAdmissionDataConfiguration,
  initializeAdmissionDataFiles,
} = require('../src/services/admissionDataContract');
const { createReminderSystem } = require('../src/services/reminderService');
const { createCalendarSystem } = require('../src/services/calendarService');
const { createProvenance, personalDataTarget, provenancePath } = require('../src/platform/personalDataPaths');

const projectRoot = path.resolve(__dirname, '..');
const realProjectRoot = fs.realpathSync(projectRoot);

function isInsideProject(filePath, root = projectRoot) {
  const relative = path.relative(root, filePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function realTargetLocation(filePath) {
  let ancestor = path.dirname(filePath);
  while (!fs.existsSync(ancestor)) {
    const parent = path.dirname(ancestor);
    if (parent === ancestor) throw new Error('資料路徑的上層目錄無法確認。');
    ancestor = parent;
  }
  return path.join(fs.realpathSync(ancestor), path.relative(ancestor, filePath));
}

function existsIncludingBrokenLink(filePath) {
  try {
    fs.lstatSync(filePath);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function initializePublicData() {
  const admission = getAdmissionDataConfiguration({ projectRoot, cwd: projectRoot });
  const descriptors = [admission.audit, admission.whitelist];
  const admissionTargets = descriptors.map(({ filePath }) => realTargetLocation(filePath));
  const reminder = personalDataTarget('reminders');
  const calendar = personalDataTarget('calendar');
  const coinPath = String(process.env.COIN_DB_PATH || '').trim();
  const archivePath = String(process.env.XIAOJI_ARCHIVE_DB_PATH || '').trim();
  if (descriptors.some(({ explicit, absoluteOverride, filePath }) =>
    !explicit || !absoluteOverride || isInsideProject(filePath)) ||
      admissionTargets.some((filePath) => isInsideProject(filePath, realProjectRoot)) ||
      !reminder.protectedTarget || !calendar.protectedTarget ||
      !path.isAbsolute(coinPath) || (archivePath && !path.isAbsolute(archivePath))) {
    throw new Error('首次安裝須設定專案外受保護的個人資料路徑、兩個審核絕對路徑與絕對 COIN_DB_PATH。');
  }
  const allLocations = [...admissionTargets, realTargetLocation(reminder.filePath),
    realTargetLocation(calendar.filePath), realTargetLocation(coinPath),
    ...(archivePath ? [realTargetLocation(archivePath)] : [])];
  if (new Set(allLocations.map((filePath) => process.platform === 'win32' ? filePath.toLowerCase() : filePath)).size !== allLocations.length) {
    throw new Error('執行期資料路徑互相重疊，已停止初始化。');
  }
  const allFiles = [...descriptors.map(({ filePath }) => filePath), reminder.filePath, calendar.filePath];
  const legacyFiles = [reminder.legacyPath, calendar.legacyPath];
  if (allFiles.some((filePath) => existsIncludingBrokenLink(filePath) ||
      existsIncludingBrokenLink(`${filePath}.legacy-v1.bak`) ||
      existsIncludingBrokenLink(`${filePath}.migration-v1.receipt.json`) ||
      existsIncludingBrokenLink(`${filePath}.lock`) ||
      existsIncludingBrokenLink(provenancePath(filePath))) ||
      legacyFiles.some((filePath) => existsIncludingBrokenLink(filePath) ||
        existsIncludingBrokenLink(`${filePath}.legacy-v1.bak`) ||
        existsIncludingBrokenLink(`${filePath}.migration-v1.receipt.json`))) {
    throw new Error('初始化需要四份資料都不存在；既有或部分資料請保留並人工查明。');
  }

  initializeAdmissionDataFiles({ projectRoot, cwd: projectRoot });
  if (!createReminderSystem({ filePath: reminder.filePath }).initializeReminderStore() ||
      !createCalendarSystem({ filePath: calendar.filePath }).initializeCalendarStore()) {
    throw new Error('個人資料初始化未完成；已停止。請保留並人工檢查已建立的資料，不要再次初始化。');
  }
  const reminderReceipt = createProvenance('reminders', reminder.filePath);
  const calendarReceipt = createProvenance('calendar', calendar.filePath);
  process.stdout.write('審核、白名單、提醒與行事曆資料已首次建立。請將以下 SHA-256 明確保存到 .env：\n');
  process.stdout.write(`XIAOJI_REMINDERS_PROVENANCE_SHA256=${reminderReceipt.sha256}\n`);
  process.stdout.write(`XIAOJI_CALENDAR_PROVENANCE_SHA256=${calendarReceipt.sha256}\n`);
}

if (require.main === module) {
  try {
    initializePublicData();
  } catch (error) {
    process.stderr.write(`${error.message} 若已有部分資料建立，請保留並人工檢查，不要再次初始化。\n`);
    process.exitCode = 1;
  }
}

module.exports = { initializePublicData };
