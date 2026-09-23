const fs = require('node:fs');
const path = require('node:path');
const { getBotOwnerId, getEnv } = require('../utils/env');
const logger = require('../utils/logger');

const defaultAuditDataPath = path.join(__dirname, '..', 'data', 'guildAudit.json');
const defaultWhitelistDataPath = path.join(__dirname, '..', 'data', 'inviterWhitelist.json');

const AuditStatus = {
  APPROVED: 'approved',
  PENDING: 'pending',
  DENIED: 'denied',
  UNKNOWN: 'unknown',
};

function ensureDataFiles() {
  [
    { filePath: getAuditDataPath(), initialContent: '{}\n' },
    { filePath: getWhitelistDataPath(), initialContent: '[]\n' },
  ].forEach(({ filePath, initialContent }) => {
    const directory = path.dirname(filePath);
    if (!fs.existsSync(directory)) {
      fs.mkdirSync(directory, { recursive: true });
    }
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, initialContent, 'utf8');
      logger.info(`建立新的資料檔：${filePath}`);
    }
  });
}

function getAuditDataPath() {
  return path.resolve(getEnv('XIAOJI_AUDIT_DATA_PATH') || defaultAuditDataPath);
}

function getWhitelistDataPath() {
  return path.resolve(getEnv('XIAOJI_INVITER_WHITELIST_PATH') || defaultWhitelistDataPath);
}

function readAuditData() {
  const auditDataPath = getAuditDataPath();
  ensureDataFiles();
  try {
    const content = fs.readFileSync(auditDataPath, 'utf8');
    if (!content.trim()) {
      return {};
    }
    return JSON.parse(content);
  } catch (error) {
    logger.error(`讀取信任驗證資料失敗 (${auditDataPath})：`, error);
    // DO NOT return empty object silently if file exists but is corrupted
    if (fs.existsSync(auditDataPath)) {
      logger.warn('！！！警告：信任驗證資料檔可能損壞，請檢查該檔案。為保安全，目前所有伺服器將被視為未知狀態。');
    }
    return {};
  }
}

function writeAuditData(data) {
  const auditDataPath = getAuditDataPath();
  try {
    ensureDataFiles();
    fs.writeFileSync(auditDataPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (error) {
    logger.error(`寫入信任驗證資料失敗 (${auditDataPath})：`, error);
  }
}

function readWhitelistData() {
  const whitelistDataPath = getWhitelistDataPath();
  ensureDataFiles();
  try {
    return JSON.parse(fs.readFileSync(whitelistDataPath, 'utf8'));
  } catch (error) {
    logger.error(`讀取白名單資料失敗 (${whitelistDataPath})：`, error);
    return [];
  }
}

function writeWhitelistData(data) {
  const whitelistDataPath = getWhitelistDataPath();
  try {
    ensureDataFiles();
    fs.writeFileSync(whitelistDataPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  } catch (error) {
    logger.error(`寫入白名單資料失敗 (${whitelistDataPath})：`, error);
  }
}

// Guild Audit Methods
function getGuildAudit(guildId) {
  const data = readAuditData();
  return data[guildId] || null;
}

function isGuildApproved(guildId) {
  const audit = getGuildAudit(guildId);
  return audit?.status === AuditStatus.APPROVED;
}

function setGuildAudit(guildId, { status, name, inviterId, reason, manualAudit, joinedAt }) {
  const data = readAuditData();
  const now = new Date().toISOString();
  
  // Use Discord's joinedAt if available, otherwise fallback to existing addedAt or now
  let actualJoinedAt;
  let isDiscordTime = data[guildId]?.isDiscordTime || false;

  if (joinedAt) {
    actualJoinedAt = new Date(joinedAt).toISOString();
    isDiscordTime = true;
  } else {
    actualJoinedAt = data[guildId]?.addedAt || now;
  }

  data[guildId] = {
    guildId,
    name: name || data[guildId]?.name || null,
    status,
    inviterId: inviterId || data[guildId]?.inviterId || null,
    addedAt: actualJoinedAt,
    isDiscordTime,
    updatedAt: now,
    approvedAt: status === AuditStatus.APPROVED ? (data[guildId]?.approvedAt || now) : (data[guildId]?.approvedAt || null),
    deniedAt: status === AuditStatus.DENIED ? (data[guildId]?.deniedAt || now) : (data[guildId]?.deniedAt || null),
    reason: reason || data[guildId]?.reason || null,
    manualAudit: manualAudit !== undefined ? manualAudit : data[guildId]?.manualAudit || false,
  };
  
  writeAuditData(data);
  return data[guildId];
}

async function syncExistingGuilds(client) {
  logger.info(`信任資料路徑：${getAuditDataPath()}`);
  
  const guilds = client.guilds.cache;
  let syncCount = 0;
  let updateCount = 0;
  let unknownCount = 0;
  
  for (const guild of guilds.values()) {
    const audit = getGuildAudit(guild.id);
    if (!audit) {
      setGuildAudit(guild.id, {
        status: AuditStatus.UNKNOWN,
        name: guild.name,
        manualAudit: true, // Legacy servers require manual owner action, no auto-leave
        joinedAt: guild.joinedAt,
      });
      syncCount++;
      unknownCount++;
    } else {
      // Proactively update to actual Discord joinedAt if we don't have it yet
      if (!audit.isDiscordTime && guild.joinedAt) {
        setGuildAudit(guild.id, {
          ...audit,
          joinedAt: guild.joinedAt,
        });
        updateCount++;
      }
      
      if (audit.status === AuditStatus.UNKNOWN) {
        unknownCount++;
      }
    }
  }
  
  if (syncCount > 0) {
    logger.info(`同步了 ${syncCount} 個新發現的伺服器。`);
  }
  if (updateCount > 0) {
    logger.info(`更新了 ${updateCount} 個伺服器的實際加入時間。`);
  }
  
  if (unknownCount > 0) {
    logger.warn(`！！！注意：目前有 ${unknownCount} 個伺服器處於「未知」狀態，需要擁有者審核。`);
    logger.warn('請透過已安裝的私有管理擴充查看待審核清單。');
  }
}

// Whitelist Methods
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

async function checkAndAutoLeave(client) {
  const data = readAuditData();
  const now = Date.now();
  const limitMs = 24 * 60 * 60 * 1000; // 24 hours
  
  for (const guildId of Object.keys(data)) {
    const audit = data[guildId];
    if (audit.manualAudit) {
      continue;
    }

    if (audit.status === AuditStatus.PENDING || audit.status === AuditStatus.UNKNOWN) {
      const addedAt = new Date(audit.addedAt).getTime();
      if (now - addedAt > limitMs) {
        logger.info(`Auto-leaving guild ${guildId} due to audit timeout`);
        
        try {
          const guild = await client.guilds.fetch(guildId).catch(() => null);
          if (guild) {
            await guild.leave();
            setGuildAudit(guildId, {
              status: AuditStatus.DENIED,
              reason: 'Audit timeout (24h)',
            });
            
            // Notify owner
            const ownerId = getBotOwnerId();
            if (ownerId) {
              const owner = await client.users.fetch(ownerId).catch(() => null);
              if (owner) {
                await owner.send(`小吉已自動離開伺服器 **${audit.name || guildId}**，因為超過 24 小時未被批准。`).catch(() => null);
              }
            }
          }
        } catch (error) {
          logger.error(`Failed to auto-leave guild ${guildId}`, error);
        }
      }
    }
  }
}

module.exports = {
  AuditStatus,
  addToWhitelist,
  checkAndAutoLeave,
  getAuditDataPath,
  getGuildAudit,
  getWhitelist,
  getWhitelistDataPath,
  isGuildApproved,
  isWhitelisted,
  removeFromWhitelist,
  setGuildAudit,
  syncExistingGuilds,
};
