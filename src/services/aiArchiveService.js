const { getBotOwnerId } = require('../utils/env');
const logger = require('../utils/logger');
const { configureArchivePathResolver, getArchivePath, openArchive } = require('../systems/conversation/aiArchive');

const ARCHIVE_UNAVAILABLE_REPLY = '小吉目前無法安全保存這次對話，請稍後再試。';
const ARCHIVE_POLICY_VERSION = '1.1.0';
const OWNER_ALERT = '小吉的對話保存暫時失敗，需檢查 AI archive；需要保存的 AI 回覆已暫停。';
let archive = null;
let currentPath = null;
let alerted = false;
let capturePaused = false;

function isArchiveCaptureEnabled() {
  return process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED === 'true' &&
    process.env.XIAOJI_ARCHIVE_POLICY_VERSION === ARCHIVE_POLICY_VERSION;
}

function getArchive() {
  const filePath = getArchivePath();
  if (archive && currentPath === filePath) return archive;
  if (archive) archive.close();
  archive = openArchive({ filePath });
  currentPath = filePath;
  alerted = false;
  return archive;
}

async function alertOwner(client) {
  capturePaused = true;
  if (alerted) return;
  alerted = true;
  logger.error('[AI_ARCHIVE] Persistence unavailable; AI replies requiring storage are paused.');
  const ownerId = getBotOwnerId();
  if (!ownerId || !client?.users?.fetch) return;
  try {
    const owner = await client.users.fetch(ownerId);
    await owner?.send?.(OWNER_ALERT);
  } catch (_error) {
    logger.warn('[AI_ARCHIVE] Owner alert could not be delivered.');
  }
}

async function preflightArchive(client) {
  if (!isArchiveCaptureEnabled()) return true;
  if (capturePaused) return false;
  try {
    getArchive().assertWritable();
    return true;
  } catch (_error) {
    await alertOwner(client);
    return false;
  }
}

function summary(value) {
  return String(value || '').replace(/<@!?\d+>|<@&\d+>|<#\d+>/g, '')
    .replace(/\s+/g, ' ').trim().slice(0, 120);
}

async function archiveInteraction(message, { userText, assistantText }) {
  if (!isArchiveCaptureEnabled()) return true;
  try {
    const store = getArchive();
    const interactionKey = `discord:${message.id}`;
    const scope = {
      interactionKey,
      sourceId: String(message.id),
      userId: String(message.author.id),
      guildId: message.guildId || null,
      channelId: String(message.channelId),
      happenedAt: new Date(message.createdTimestamp).toISOString(),
      userContent: String(message.content || ''),
      assistantContent: String(assistantText || ''),
    };
    const saved = store.appendInteraction(scope);
    if (!saved.persisted) throw new Error(`Archive rejected interaction: ${saved.reason}`);
    return true;
  } catch (_error) {
    await alertOwner(message?.client);
    return false;
  }
}

async function confirmArchiveInteraction(message, { userText, assistantText }) {
  if (!isArchiveCaptureEnabled()) return true;
  try {
    const interactionKey = `discord:${message.id}`;
    const saved = getArchive().markDeliveredAndSummary({ interactionKey, summary: {
      summaryKey: interactionKey,
      userId: String(message.author.id), guildId: message.guildId || null,
      channelId: String(message.channelId),
      happenedAt: new Date(message.createdTimestamp).toISOString(),
      userSummary: summary(userText), assistantSummary: summary(assistantText),
    } });
    if (!saved.persisted) throw new Error('Archive delivery confirmation failed.');
    return true;
  } catch (_error) {
    await alertOwner(message?.client);
    return false;
  }
}

async function markArchivePartialDelivery(message) {
  if (!isArchiveCaptureEnabled()) return true;
  try {
    getArchive().markPartialDelivery(`discord:${message.id}`);
    return true;
  } catch (_error) {
    await alertOwner(message?.client);
    return false;
  }
}

function archivePublicMessage(message, content) {
  if (!isArchiveCaptureEnabled()) return true;
  try {
    const result = getArchive().appendPublicMessage({
      messageId: String(message.id),
      userId: String(message.author.id),
      guildId: String(message.guildId),
      channelId: String(message.channelId),
      happenedAt: new Date(message.createdTimestamp).toISOString(),
      content: String(content),
    });
    if (!result.persisted) throw new Error(`Archive rejected public message: ${result.reason}`);
    return true;
  } catch (_error) {
    void alertOwner(message?.client);
    return false;
  }
}

function closeArchiveForTests() {
  archive?.close();
  archive = null;
  currentPath = null;
  alerted = false;
  capturePaused = false;
}

module.exports = {
  ARCHIVE_UNAVAILABLE_REPLY,
  ARCHIVE_POLICY_VERSION,
  archiveInteraction,
  confirmArchiveInteraction,
  archivePublicMessage,
  closeArchiveForTests,
  configureArchivePathResolver,
  getArchive,
  isArchiveCaptureEnabled,
  markArchivePartialDelivery,
  preflightArchive,
};
