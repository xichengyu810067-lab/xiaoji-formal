const fs = require('node:fs');
const path = require('node:path');
const logger = require('../utils/logger');

const DEFAULT_HISTORY_PATH = path.join(__dirname, '..', '..', 'data', 'aiConversationHistory.json');
const DEFAULT_RETENTION_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
let cachedState = null;
let cachePath = null;
let storageWritable = true;
let storageError = null;
let writeQueue = Promise.resolve();
let retentionCleanupTimer = null;
let cancelRetentionCleanupTimer = null;

function boundedInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(value || String(fallback), 10);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

function getLimits() {
  return {
    maxTurns: boundedInteger(process.env.AI_MEMORY_MAX_TURNS, 10, 1, 50),
    maxConversations: boundedInteger(process.env.AI_MEMORY_MAX_CONVERSATIONS, 500, 1, 5000),
    maxBytes: boundedInteger(process.env.AI_MEMORY_MAX_BYTES, 2_000_000, 1024, 50_000_000),
    maxTextLength: boundedInteger(process.env.AI_MEMORY_MAX_TEXT_LENGTH, 2000, 100, 10_000),
    retentionDays: boundedInteger(process.env.AI_MEMORY_RETENTION_DAYS, 30, 1, 365),
  };
}

function getHistoryPath() {
  return path.resolve(process.env.AI_CONVERSATION_PATH || DEFAULT_HISTORY_PATH);
}

function emptyState() {
  return { version: 1, conversations: {} };
}

function getConversationKey({ guildId, channelId, userId, username }) {
  return [guildId || 'dm', channelId || 'unknown-channel', userId || username || 'unknown-user'].join(':');
}

function isValidTurn(turn) {
  return (
    turn &&
    typeof turn.user === 'string' &&
    typeof turn.assistant === 'string' &&
    typeof turn.createdAt === 'string' &&
    Number.isFinite(Date.parse(turn.createdAt))
  );
}

function validateState(value) {
  if (!value || value.version !== 1 || !value.conversations || typeof value.conversations !== 'object') {
    throw new Error('invalid conversation history root');
  }

  for (const conversation of Object.values(value.conversations)) {
    if (
      !conversation ||
      typeof conversation.guildId !== 'string' ||
      typeof conversation.channelId !== 'string' ||
      typeof conversation.userId !== 'string' ||
      typeof conversation.updatedAt !== 'string' ||
      !Array.isArray(conversation.turns) ||
      !conversation.turns.every(isValidTurn)
    ) {
      throw new Error('invalid conversation history entry');
    }
  }

  return value;
}

function loadState() {
  const historyPath = getHistoryPath();
  if (cachedState && cachePath === historyPath) {
    return cachedState;
  }

  cachePath = historyPath;
  storageWritable = true;
  storageError = null;

  if (!fs.existsSync(historyPath)) {
    cachedState = emptyState();
    return cachedState;
  }

  try {
    cachedState = validateState(JSON.parse(fs.readFileSync(historyPath, 'utf8')));
  } catch (error) {
    cachedState = emptyState();
    storageWritable = false;
    storageError = 'corrupt';
    logger.warn(`AI conversation history is corrupt; continuing without persistent history and preserving the file. ${error.message}`);
  }

  return cachedState;
}

function cloneState(state) {
  return JSON.parse(JSON.stringify(state));
}

function serializeState(state) {
  return `${JSON.stringify(state, null, 2)}\n`;
}

function pruneState(state, now = Date.now()) {
  const limits = getLimits();
  const cutoff = now - limits.retentionDays * 24 * 60 * 60 * 1000;

  for (const [key, conversation] of Object.entries(state.conversations)) {
    conversation.turns = conversation.turns
      .filter((turn) => Date.parse(turn.createdAt) >= cutoff)
      .slice(-limits.maxTurns);
    if (conversation.turns.length === 0 || Date.parse(conversation.updatedAt) < cutoff) {
      delete state.conversations[key];
    }
  }

  const orderedKeys = Object.entries(state.conversations)
    .sort(([, left], [, right]) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt))
    .map(([key]) => key);

  while (orderedKeys.length > limits.maxConversations) {
    delete state.conversations[orderedKeys.shift()];
  }

  while (orderedKeys.length > 0 && Buffer.byteLength(serializeState(state), 'utf8') > limits.maxBytes) {
    delete state.conversations[orderedKeys.shift()];
  }

  return state;
}

function writeStateAtomically(state) {
  const historyPath = getHistoryPath();
  const directory = path.dirname(historyPath);
  const temporaryPath = `${historyPath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(directory, { recursive: true });

  try {
    fs.writeFileSync(temporaryPath, serializeState(validateState(state)), 'utf8');
    fs.renameSync(temporaryPath, historyPath);
  } finally {
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function enqueueMutation(mutator) {
  const operation = writeQueue.catch(() => undefined).then(() => {
    const current = loadState();
    if (!storageWritable) {
      return { persisted: false, reason: storageError || 'unavailable' };
    }

    const next = pruneState(mutator(cloneState(current)) || cloneState(current));
    writeStateAtomically(next);
    cachedState = next;
    cachePath = getHistoryPath();
    storageWritable = true;
    storageError = null;
    return { persisted: true };
  });
  writeQueue = operation;
  return operation;
}

function getRecentConversationTurns(identity) {
  const state = pruneState(cloneState(loadState()));
  const key = getConversationKey(identity);
  return (state.conversations[key]?.turns || []).map(({ user, assistant }) => ({ user, assistant }));
}

function truncateText(value) {
  return String(value || '').trim().slice(0, getLimits().maxTextLength);
}

function rememberConversationTurn(identity, userText, assistantText, now = new Date()) {
  const guildId = String(identity.guildId || 'dm');
  const channelId = String(identity.channelId || 'unknown-channel');
  const userId = String(identity.userId || identity.username || 'unknown-user');
  const key = getConversationKey({ guildId, channelId, userId });
  const timestamp = now.toISOString();

  return enqueueMutation((state) => {
    const conversation = state.conversations[key] || {
      guildId,
      channelId,
      userId,
      updatedAt: timestamp,
      turns: [],
    };
    conversation.updatedAt = timestamp;
    conversation.turns.push({
      user: truncateText(userText),
      assistant: truncateText(assistantText),
      createdAt: timestamp,
    });
    state.conversations[key] = conversation;
    return state;
  });
}

function clearConversationHistory(identity) {
  const key = getConversationKey(identity);
  return enqueueMutation((state) => {
    delete state.conversations[key];
    return state;
  });
}

function clearExpiredConversationHistory(now = Date.now()) {
  return enqueueMutation((state) => pruneState(state, now));
}

function startConversationHistoryCleanupScheduler({
  intervalMs = DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
  setIntervalFn = setInterval,
  clearIntervalFn = clearInterval,
} = {}) {
  if (retentionCleanupTimer) {
    return retentionCleanupTimer;
  }

  const runCleanup = async () => {
    try {
      return await clearExpiredConversationHistory();
    } catch (error) {
      logger.error('AI conversation history retention cleanup failed.', error);
      return { persisted: false, reason: 'cleanup_failed' };
    }
  };

  const timer = setIntervalFn(runCleanup, intervalMs);
  timer.unref?.();
  retentionCleanupTimer = timer;
  cancelRetentionCleanupTimer = () => clearIntervalFn(timer);
  return timer;
}

function stopConversationHistoryCleanupScheduler() {
  if (!retentionCleanupTimer) {
    return false;
  }

  const cancel = cancelRetentionCleanupTimer;
  retentionCleanupTimer = null;
  cancelRetentionCleanupTimer = null;
  cancel?.();
  return true;
}

function getConversationHistoryStatus() {
  const state = loadState();
  return {
    path: getHistoryPath(),
    conversationCount: Object.keys(state.conversations).length,
    writable: storageWritable,
    error: storageError,
    limits: getLimits(),
  };
}

async function resetConversationHistoryForTests() {
  stopConversationHistoryCleanupScheduler();
  await writeQueue.catch(() => undefined);
  cachedState = null;
  cachePath = null;
  storageWritable = true;
  storageError = null;
  writeQueue = Promise.resolve();
}

module.exports = {
  DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
  clearConversationHistory,
  clearExpiredConversationHistory,
  getConversationHistoryStatus,
  getConversationKey,
  getHistoryPath,
  getRecentConversationTurns,
  rememberConversationTurn,
  resetConversationHistoryForTests,
  startConversationHistoryCleanupScheduler,
  stopConversationHistoryCleanupScheduler,
};
