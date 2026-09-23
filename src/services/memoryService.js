const fs = require('node:fs');
const path = require('node:path');
const { getGuildConfig } = require('../utils/guildConfig');
const logger = require('../utils/logger');

const defaultMemoryPath = path.join(__dirname, '..', '..', 'data', 'xiaojiMemory.json');
const MAX_PRIVATE_RECORDS_PER_USER = 100;
const MAX_PUBLIC_RECORDS_PER_GUILD = 2000;
const MAX_RECENT_PUBLIC_MESSAGES = 100;
const DEFAULT_AI_PRIVATE_CONTEXT_RECORDS = 12;
const DEFAULT_AI_PRIVATE_CONTEXT_CHARACTERS = 2400;
const recentPublicMessages = new Map();

const memoryQueryTerms = [
  '剛剛',
  '之前',
  '昨天',
  '有沒有說',
  '是不是說',
  '誰說',
  '聊什麼',
  '說過什麼',
  '記得我',
  '還記得',
  '私下',
  '私人',
];

const knownKeywords = ['晚安', '睡覺', '要睡', '抱抱', '公告', '你好', '嗨'];

function ensureMemoryFile() {
  const memoryPath = getMemoryPath();
  const directory = path.dirname(memoryPath);

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true });
  }

  if (!fs.existsSync(memoryPath)) {
    fs.writeFileSync(memoryPath, JSON.stringify({ private_user_memory: {}, public_channel_memory: {} }, null, 2), 'utf8');
  }
}

function getMemoryPath() {
  return path.resolve(process.env.XIAOJI_MEMORY_PATH || defaultMemoryPath);
}

function getEmptyMemory() {
  return {
    private_user_memory: {},
    public_channel_memory: {},
  };
}

function readMemoryState() {
  const memoryPath = getMemoryPath();

  try {
    ensureMemoryFile();
    const parsed = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));

    return {
      memory: {
        private_user_memory: parsed.private_user_memory || {},
        public_channel_memory: parsed.public_channel_memory || {},
      },
      writable: true,
    };
  } catch (error) {
    logger.warn(`memory file read failed; using empty memory. ${error?.message || error}`);
    return { memory: getEmptyMemory(), writable: false };
  }
}

function readMemory() {
  return readMemoryState().memory;
}

function writeMemory(memory) {
  const memoryPath = getMemoryPath();
  const temporaryPath = `${memoryPath}.${process.pid}.${Date.now()}.tmp`;
  ensureMemoryFile();

  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(memory, null, 2)}\n`, 'utf8');
    fs.renameSync(temporaryPath, memoryPath);
  } finally {
    if (fs.existsSync(temporaryPath)) {
      fs.unlinkSync(temporaryPath);
    }
  }
}

function normalizeText(value) {
  return String(value || '')
    .replace(/<@!?\d+>/g, '')
    .replace(/<@&\d+>/g, '')
    .replace(/<#\d+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeContent(content, maxLength = 120) {
  const normalized = normalizeText(content);
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function getDisplayName(message) {
  return message.member?.displayName || message.author?.globalName || message.author?.username || '未知使用者';
}

function getPublicCacheKey(guildId, channelId) {
  return `${guildId}:${channelId}`;
}

function appendRecentPublicMessage(record) {
  const key = getPublicCacheKey(record.guildId, record.channelId);
  const records = recentPublicMessages.get(key) || [];

  records.push(record);
  recentPublicMessages.set(key, records.slice(-MAX_RECENT_PUBLIC_MESSAGES));
}

function recordPublicMessage(message) {
  if (!message.guildId || !message.channelId || message.author?.bot) {
    return null;
  }

  const content = normalizeText(message.content);

  if (!content) {
    return null;
  }

  const record = {
    guildId: message.guildId,
    channelId: message.channelId,
    userId: message.author.id,
    displayName: getDisplayName(message),
    username: message.author.username,
    contentSummary: summarizeContent(content),
    originalContent: content,
    timestamp: new Date(message.createdTimestamp || Date.now()).toISOString(),
    visibility: 'public',
    source: 'public_channel',
  };

  appendRecentPublicMessage(record);

  const loaded = readMemoryState();
  if (!loaded.writable) {
    logger.warn('public memory write skipped because memory storage is unavailable or corrupt.');
    return record;
  }

  const memory = loaded.memory;
  const guildRecords = memory.public_channel_memory[message.guildId] || [];
  guildRecords.push(record);
  memory.public_channel_memory[message.guildId] = guildRecords.slice(-MAX_PUBLIC_RECORDS_PER_GUILD);
  try {
    writeMemory(memory);
  } catch (error) {
    logger.warn(`public memory write failed; continuing without persistence. ${error?.message || error}`);
  }

  return record;
}

function recordPrivateInteraction({ guildId, channelId, userId, displayName, userText, assistantText }) {
  if (!userId || (!userText && !assistantText)) {
    return null;
  }

  const loaded = readMemoryState();
  if (!loaded.writable) {
    logger.warn('private memory write skipped because memory storage is unavailable or corrupt.');
    return null;
  }

  const memory = loaded.memory;
  const records = memory.private_user_memory[userId] || [];
  const record = {
    guildId: guildId || null,
    channelId: channelId || null,
    userId,
    displayName: displayName || '未知使用者',
    userContentSummary: summarizeContent(userText),
    assistantContentSummary: summarizeContent(assistantText),
    timestamp: new Date().toISOString(),
    visibility: 'private',
    source: 'private_user_memory',
  };

  records.push(record);
  memory.private_user_memory[userId] = records.slice(-MAX_PRIVATE_RECORDS_PER_USER);
  try {
    writeMemory(memory);
  } catch (error) {
    logger.warn(`private memory write failed; continuing without persistence. ${error?.message || error}`);
    return null;
  }

  return record;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function getPrivateMemoryContext(
  userId,
  {
    maxRecords = DEFAULT_AI_PRIVATE_CONTEXT_RECORDS,
    maxCharacters = DEFAULT_AI_PRIVATE_CONTEXT_CHARACTERS,
  } = {}
) {
  if (!userId) {
    return '';
  }

  const recordLimit = boundedInteger(maxRecords, DEFAULT_AI_PRIVATE_CONTEXT_RECORDS, 1, 30);
  const characterLimit = boundedInteger(maxCharacters, DEFAULT_AI_PRIVATE_CONTEXT_CHARACTERS, 200, 6000);
  const records = getPrivateRecords(userId).slice(0, recordLimit).reverse();
  const formatted = records
    .map((record) => {
      const userSummary = summarizeContent(record.userContentSummary, 180);
      const assistantSummary = summarizeContent(record.assistantContentSummary, 180);
      const parts = [];

      if (userSummary) {
        parts.push(`${record.displayName || '這位使用者'}曾說：「${userSummary}」`);
      }
      if (assistantSummary) {
        parts.push(`小吉當時回覆：「${assistantSummary}」`);
      }

      return parts.join('；');
    })
    .filter(Boolean)
    .join('\n');

  return formatted.length > characterLimit ? formatted.slice(-characterLimit) : formatted;
}

function isMemoryQuery(text) {
  const normalized = normalizeText(text);
  return memoryQueryTerms.some((term) => normalized.includes(term));
}

function asksPrivateAboutOther(text) {
  const normalized = normalizeText(text);
  return /(私下|私人|私訊|dm|DM).*(說|聊|講|告訴|跟你說)/.test(normalized);
}

function asksWholeChannel(text) {
  const normalized = normalizeText(text);
  return normalized.includes('有人') || normalized.includes('誰') || normalized.includes('這個頻道') || normalized.includes('聊什麼');
}

function asksSelf(text) {
  const normalized = normalizeText(text);
  return normalized.includes('我') || normalized.includes('自己');
}

function extractKeyword(text) {
  const normalized = normalizeText(text);
  const known = knownKeywords.find((keyword) => normalized.includes(keyword));

  if (known) {
    return known;
  }

  const quoted = normalized.match(/[「『"']([^」』"']{1,40})[」』"']/);
  if (quoted) {
    return quoted[1].trim();
  }

  const said = normalized.match(/(?:說|講|叫你|跟你說)(.{1,30})(?:嗎|了|$)/);
  if (said) {
    return said[1].replace(/[？?。！!，,]/g, '').trim();
  }

  return '';
}

function getMentionedUserId(text) {
  return String(text || '').match(/<@!?(\d+)>/)?.[1] || null;
}

function matchesTarget(record, targetText, targetUserId) {
  if (targetUserId) {
    return record.userId === targetUserId;
  }

  if (!targetText) {
    return false;
  }

  const normalizedTarget = normalizeText(targetText).toLowerCase();
  return [record.displayName, record.username, record.userId]
    .filter(Boolean)
    .some((value) => String(value).toLowerCase().includes(normalizedTarget));
}

function extractTargetText(text, keyword) {
  let normalized = normalizeText(text);

  for (const word of ['剛剛', '之前', '昨天', '有沒有', '是不是', '是否']) {
    normalized = normalized.replaceAll(word, '');
  }

  if (keyword) {
    normalized = normalized.replace(keyword, '');
  }

  normalized = normalized
    .replace(/<@!?\d+>/g, '')
    .replace(/[？?。！!，,]/g, '')
    .replace(/(說|講|叫你|跟你|跟你說|了|嗎|有|沒有|是不是|是否|私下|私人|私訊|dm|DM)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!normalized || normalized === '我' || normalized === '有人' || normalized === '誰' || normalized === '這個頻道') {
    return '';
  }

  return normalized;
}

function contentMatches(record, keyword) {
  if (!keyword) {
    return true;
  }

  return `${record.contentSummary || ''} ${record.originalContent || ''}`.includes(keyword);
}

function sortNewestFirst(records) {
  return records.slice().sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

function getPublicRecords({ guildId, channelId, includeGuildWide = false }) {
  if (!guildId) {
    return [];
  }

  const memory = readMemory();
  const stored = memory.public_channel_memory[guildId] || [];
  const cache = channelId ? recentPublicMessages.get(getPublicCacheKey(guildId, channelId)) || [] : [];
  const all = [...stored, ...cache];
  const seen = new Set();

  return sortNewestFirst(
    all.filter((record) => {
      if (!includeGuildWide && record.channelId !== channelId) {
        return false;
      }

      const key = `${record.guildId}:${record.channelId}:${record.userId}:${record.timestamp}:${record.originalContent}`;
      if (seen.has(key)) {
        return false;
      }

      seen.add(key);
      return true;
    })
  );
}

function getPrivateRecords(userId) {
  if (!userId) {
    return [];
  }

  const memory = readMemory();
  return sortNewestFirst(memory.private_user_memory[userId] || []);
}

function getAllPrivateRecords() {
  const memory = readMemory();
  return sortNewestFirst(Object.values(memory.private_user_memory).flat());
}

function canSearchGuildWide(guildId) {
  if (!guildId) {
    return false;
  }

  return Boolean(getGuildConfig(guildId).memory.sharePublicAcrossChannels);
}

function findPrivateSelfMemory({ userId, keyword }) {
  return getPrivateRecords(userId).find((record) => {
    if (!keyword) {
      return true;
    }

    return `${record.userContentSummary || ''} ${record.assistantContentSummary || ''}`.includes(keyword);
  });
}

function findPrivateOtherMemory({ requesterId, targetUserId, targetText, keyword }) {
  return getAllPrivateRecords().find((record) => {
    if (record.userId === requesterId) {
      return false;
    }

    if (!matchesTarget(record, targetText, targetUserId)) {
      return false;
    }

    if (!keyword) {
      return true;
    }

    return `${record.userContentSummary || ''} ${record.assistantContentSummary || ''}`.includes(keyword);
  });
}

function findPublicMemory({ guildId, channelId, targetUserId, targetText, keyword, includeGuildWide }) {
  return getPublicRecords({ guildId, channelId, includeGuildWide }).find((record) => {
    if (targetUserId || targetText) {
      if (!matchesTarget(record, targetText, targetUserId)) {
        return false;
      }
    }

    return contentMatches(record, keyword);
  });
}

function formatPublicFound(record, keyword) {
  const what = keyword ? `說過${keyword}` : `說過「${record.contentSummary}」`;
  return `有喔，${record.displayName} 剛剛在${record.channelId ? '這個頻道' : '伺服器'}${what}。`;
}

function formatPrivateFound(record, keyword) {
  const what = keyword ? `說過${keyword}` : `跟我說過「${record.userContentSummary}」`;
  return `有喔，我記得你剛剛${what}。`;
}

function answerMemoryQuery({ text, message }) {
  if (!isMemoryQuery(text)) {
    return null;
  }

  const guildId = message.guildId;
  const channelId = message.channelId;
  const requesterId = message.author.id;
  const mentionedUserId = getMentionedUserId(text);
  const keyword = extractKeyword(text);
  const targetText = extractTargetText(text, keyword);
  const isSelf = asksSelf(text) && !mentionedUserId && !targetText;
  const wholeChannel = asksWholeChannel(text) && !mentionedUserId && !targetText && !isSelf;

  if (asksPrivateAboutOther(text) && !isSelf) {
    return '這可能屬於他跟我的私人對話，我不能直接公開喔。';
  }

  if (isSelf) {
    const privateRecord = findPrivateSelfMemory({ userId: requesterId, keyword });

    if (privateRecord) {
      return formatPrivateFound(privateRecord, keyword);
    }

    const publicRecord = findPublicMemory({
      guildId,
      channelId,
      targetUserId: requesterId,
      keyword,
      includeGuildWide: false,
    });

    if (publicRecord) {
      return formatPublicFound(publicRecord, keyword);
    }

    return '我目前沒有在可查的公開紀錄中找到，不代表真的沒有發生喔。';
  }

  if (wholeChannel) {
    const publicRecord = findPublicMemory({ guildId, channelId, keyword, includeGuildWide: false });

    if (publicRecord) {
      return formatPublicFound(publicRecord, keyword);
    }

    return '我目前沒有在可查的公開紀錄中找到，不代表真的沒有發生喔。';
  }

  const targetUserId = mentionedUserId;
  const target = targetText;

  if (targetUserId || target) {
    const sameChannelRecord = findPublicMemory({
      guildId,
      channelId,
      targetUserId,
      targetText: target,
      keyword,
      includeGuildWide: false,
    });

    if (sameChannelRecord) {
      return formatPublicFound(sameChannelRecord, keyword);
    }

    if (canSearchGuildWide(guildId)) {
      const guildRecord = findPublicMemory({
        guildId,
        channelId,
        targetUserId,
        targetText: target,
        keyword,
        includeGuildWide: true,
      });

      if (guildRecord) {
        return formatPublicFound(guildRecord, keyword);
      }
    }

    if (findPrivateOtherMemory({ requesterId, targetUserId, targetText: target, keyword })) {
      return '這可能屬於他跟我的私人對話，我不能直接公開喔。';
    }

    return '我目前沒有在可查的公開紀錄中找到，不代表真的沒有發生喔。';
  }

  return null;
}

function clearMemoryForTests() {
  recentPublicMessages.clear();
  writeMemory(getEmptyMemory());
}

module.exports = {
  DEFAULT_AI_PRIVATE_CONTEXT_CHARACTERS,
  DEFAULT_AI_PRIVATE_CONTEXT_RECORDS,
  answerMemoryQuery,
  clearMemoryForTests,
  extractKeyword,
  getMemoryPath,
  getPrivateMemoryContext,
  recordPrivateInteraction,
  recordPublicMessage,
};
