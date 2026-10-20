const fs = require('node:fs');
const logger = require('../utils/logger');
const {
  getAdmissionDataConfiguration,
  initializeDefaultAdmissionDataFilesIfEmpty,
  readAdmissionDataFile,
  validateAdmissionData,
} = require('./admissionDataContract');

// Guilds are no longer reviewed: every guild the bot is in may use it, and nothing here decides, records
// or leaves a guild. What this module keeps is the read side of the data files the admission data
// contract still protects, so the records an earlier version wrote stay readable as they were (the
// `status` of each is history, never a gate).
const AuditStatus = {
  APPROVED: 'approved',
  PENDING: 'pending',
  DENIED: 'denied',
  UNKNOWN: 'unknown',
};

function getAuditDataPath() {
  return getAdmissionDataConfiguration().audit.filePath;
}

function getWhitelistDataPath() {
  return getAdmissionDataConfiguration().whitelist.filePath;
}

function readAuditData() {
  try {
    return readAdmissionDataFile(initializeDefaultAdmissionDataFilesIfEmpty().audit);
  } catch (error) {
    logger.error(`讀取信任驗證資料失敗 (${error.code || 'unknown'})。`);
    throw error;
  }
}

function readWhitelistData() {
  try {
    return readAdmissionDataFile(initializeDefaultAdmissionDataFilesIfEmpty().whitelist);
  } catch (error) {
    logger.error(`讀取白名單資料失敗 (${error.code || 'unknown'})。`);
    throw error;
  }
}

function writeWhitelistData(data) {
  const descriptor = getAdmissionDataConfiguration().whitelist;
  try {
    validateAdmissionData('whitelist', data);
    readAdmissionDataFile(descriptor);
    fs.writeFileSync(descriptor.filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (error) {
    logger.error(`寫入白名單資料失敗 (${error.code || 'unknown'})。`);
    throw error;
  }
}

// The record an earlier version kept for a guild, or null. Read-only: the public core writes no guild
// record any more.
function getGuildAudit(guildId) {
  const data = readAuditData();
  return data[guildId] || null;
}

// Whitelist methods. The whitelist no longer admits or refuses anyone in the public core; the list and
// these functions stay for the private management commands that still edit it.
function getWhitelist() {
  return readWhitelistData();
}

function isWhitelisted(userId) {
  const whitelist = getWhitelist();
  return whitelist.some((entry) => entry.userId === userId);
}

function addToWhitelist(userId, addedBy) {
  const whitelist = getWhitelist();
  if (whitelist.some((entry) => entry.userId === userId)) {
    return false;
  }

  whitelist.push({
    userId,
    addedBy,
    addedAt: new Date().toISOString(),
  });

  writeWhitelistData(whitelist);
  return true;
}

function removeFromWhitelist(userId) {
  const whitelist = getWhitelist();
  const initialLength = whitelist.length;
  const filtered = whitelist.filter((entry) => entry.userId !== userId);

  if (filtered.length === initialLength) {
    return false;
  }

  writeWhitelistData(filtered);
  return true;
}

module.exports = {
  AuditStatus,
  addToWhitelist,
  getAuditDataPath,
  getGuildAudit,
  getWhitelist,
  getWhitelistDataPath,
  isWhitelisted,
  removeFromWhitelist,
};
