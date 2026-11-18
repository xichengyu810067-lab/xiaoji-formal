const { withCoinTransaction } = require('../../economy/storage/coinDatabase');
const { evaluateNumberExpression } = require('./numberExpressionService');
const { processChainReactionOutbox } = require('./chainReactionDelivery');
const {
  answerMove,
  authorizeMoveReaction,
  defineChain,
  getChainRoundStatus,
  settleCountedMove,
  startChainRound,
  stopChainRound,
} = require('./chainRound');

const FEATURE_KEY = 'number_chain';
const DEFAULT_TARGET = 1;
const MAX_ID_LENGTH = 80;
const MAX_TARGET = Number.MAX_SAFE_INTEGER;
const PARSER_VERSION = 'rational-v1';

class NumberChainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'NumberChainError';
    this.code = code;
  }
}

function requireId(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH) {
    throw new NumberChainError('INVALID_ARGUMENT', `${name} is required.`);
  }
  return normalized;
}

function requireTarget(value, name = 'target') {
  const target = Number(value);
  if (!Number.isSafeInteger(target) || target < 1 || target > MAX_TARGET) {
    throw new NumberChainError('INVALID_TARGET', `${name} must be a positive safe integer.`);
  }
  return target;
}

function mapSession(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    channelId: row.channel_id,
    status: row.status,
    expectedTarget: Number(row.expected_target),
    lastUserId: row.last_user_id || null,
    revision: Number(row.revision),
    startedBy: row.started_by,
    stoppedBy: row.stopped_by || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stoppedAt: row.stopped_at || null,
    completedAt: row.completed_at || null,
  };
}

function selectActiveSession(api, guildId, channelId = null) {
  return api.get(
    `SELECT * FROM number_chain_sessions
     WHERE guild_id = ?${channelId == null ? '' : ' AND channel_id = ?'} AND status = 'active'
     ORDER BY id DESC LIMIT 1`,
    channelId == null ? [guildId] : [guildId, channelId]
  );
}

const STOP_SESSION_SQL = `UPDATE number_chain_sessions
     SET status = 'stopped', stopped_by = ?, stopped_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND status = 'active'`;

const chain = defineChain({
  featureKey: FEATURE_KEY,
  label: '數字接龍',
  versionConfig: { parserVersion: PARSER_VERSION },
  makeError: (code, message) => new NumberChainError(code, message),
  otherChain: {
    featureKey: 'word_chain',
    conflictMessage: '這個頻道已有進行中的文字接龍，請先停止它再開始數字接龍。',
  },
  sessions: {
    selectActive: selectActiveSession,
    selectLatestCompleted: (api, guildId, channelId) => api.get(
      "SELECT id, created_at FROM number_chain_sessions WHERE guild_id = ? AND channel_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
      [guildId, channelId]
    ),
    selectById: (api, id) => api.get('SELECT * FROM number_chain_sessions WHERE id = ?', [id]),
    selectLastInserted: (api) => api.get('SELECT * FROM number_chain_sessions WHERE id = last_insert_rowid()'),
    stop: (api, id, actorId, timestamp) => api.run(STOP_SESSION_SQL, [actorId, timestamp, timestamp, id]),
    map: mapSession,
  },
});

async function startNumberChain({ guildId, channelId, actorId, target = DEFAULT_TARGET, now = new Date(), beforeCommit = null }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedActorId = requireId(actorId, 'actorId');
  const expectedTarget = requireTarget(target);
  const timestamp = new Date(now).toISOString();
  if (Number.isNaN(new Date(timestamp).getTime())) throw new NumberChainError('INVALID_ARGUMENT', 'now must be valid.');

  return startChainRound(chain, {
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    actorId: normalizedActorId,
    timestamp,
    beforeCommit,
    insertSession: (api) => api.run(
      `INSERT INTO number_chain_sessions
        (guild_id, channel_id, status, expected_target, last_user_id, revision, started_by, created_at, updated_at)
       VALUES (?, ?, 'active', ?, NULL, 0, ?, ?, ?)`,
      [normalizedGuildId, normalizedChannelId, expectedTarget, normalizedActorId, timestamp, timestamp]
    ),
  });
}

async function stopNumberChain({ guildId, channelId, actorId, now = new Date() }) {
  return stopChainRound(chain, {
    guildId: requireId(guildId, 'guildId'),
    channelId: requireId(channelId, 'channelId'),
    actorId: requireId(actorId, 'actorId'),
    timestamp: new Date(now).toISOString(),
  });
}

// The round in the channel, if any, with paused and reactionInactive (chainRound.js).
async function getNumberChainStatus(guildId, channelId) {
  return getChainRoundStatus(chain, {
    guildId: requireId(guildId, 'guildId'),
    channelId: requireId(channelId, 'channelId'),
  });
}

function describeNumberChainStatus(session) {
  const progress = `目前要接 ${session.expectedTarget}，已答對 ${session.revision} 次`;
  if (session.paused === true) {
    return `數字接龍已暫停：${progress}；進度已保留，管理員可在同一頻道再次使用 /board start 接續這一局。`;
  }
  return session.reactionInactive === true
    ? `數字接龍進行中：${progress}。✅ 未啟用，請在同頻道重新 /board start。`
    : `數字接龍進行中：${progress}。`;
}

async function acceptNumberChainMessage({ guildId, channelId, messageId, userId, content, expectedChannelId = channelId, now = new Date() }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedMessageId = requireId(messageId, 'messageId');
  const normalizedUserId = requireId(userId, 'userId');
  const normalizedExpectedChannelId = requireId(expectedChannelId, 'expectedChannelId');
  const expression = String(content ?? '').trim();
  const timestamp = new Date(now).toISOString();

  return withCoinTransaction((api) => {
    const duplicate = api.get('SELECT session_id FROM number_chain_entries WHERE message_id = ?', [normalizedMessageId]);
    if (duplicate) return { ok: true, duplicate: true, sessionId: Number(duplicate.session_id) };
    if (normalizedChannelId !== normalizedExpectedChannelId) {
      return { ok: false, code: 'WRONG_CHANNEL', message: '這一局數字接龍不在這個頻道進行喔。' };
    }
    const session = selectActiveSession(api, normalizedGuildId, normalizedChannelId);
    if (!session) {
      const anotherSession = api.get("SELECT id FROM number_chain_sessions WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [normalizedGuildId]);
      return { ok: false, code: anotherSession ? 'WRONG_CHANNEL' : 'NO_ACTIVE_SESSION', message: anotherSession ? '這一局數字接龍不在這個頻道進行喔。' : '目前沒有進行中的數字接龍。' };
    }
    if (session.last_user_id === normalizedUserId) {
      return { ok: false, code: 'SAME_USER', message: '數字接龍要輪到其他人作答才行喔。' };
    }
    const evaluated = evaluateNumberExpression(expression);
    if (!evaluated.ok) return evaluated;
    if (evaluated.value !== BigInt(session.expected_target)) {
      return { ok: false, code: 'TARGET_MISMATCH', message: `這一輪要接的數字是 ${session.expected_target} 喔。` };
    }

    const { reactionMetadata, reactionAuthority } = authorizeMoveReaction(api, chain, {
      guildId: normalizedGuildId, channelId: normalizedChannelId, messageId: normalizedMessageId, session, timestamp });

    api.run(
      `INSERT INTO number_chain_entries (session_id, guild_id, channel_id, message_id, user_id, expression, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [session.id, normalizedGuildId, normalizedChannelId, normalizedMessageId, normalizedUserId, expression, Number(evaluated.value), timestamp]
    );
    const entryId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    const completed = Number(session.expected_target) >= MAX_TARGET;
    const nextTarget = completed ? Number(session.expected_target) : Number(session.expected_target) + 1;
    api.run(
      `UPDATE number_chain_sessions
       SET expected_target = ?, last_user_id = ?, revision = revision + 1, updated_at = ?,
           status = CASE WHEN ? THEN 'completed' ELSE status END,
           completed_at = CASE WHEN ? THEN ? ELSE completed_at END
       WHERE id = ? AND status = 'active'`,
      [nextTarget, normalizedUserId, timestamp, completed ? 1 : 0, completed ? 1 : 0, timestamp, session.id]
    );
    const updatedSession = mapSession(api.get('SELECT * FROM number_chain_sessions WHERE id = ?', [session.id]));
    const reactionSource = settleCountedMove(api, chain, {
      guildId: normalizedGuildId, channelId: normalizedChannelId, messageId: normalizedMessageId,
      userId: normalizedUserId, now, timestamp, completed, entryId, finalRevision: updatedSession.revision,
      reactionMetadata, reactionAuthority,
    });
    return { ok: true, duplicate: false, completed, session: updatedSession, reactionSource };
  });
}

async function handleNumberChainMessage(message, setting) {
  const result = await acceptNumberChainMessage({
    guildId: message.guildId,
    channelId: message.channelId,
    messageId: message.id,
    userId: message.author.id,
    content: message.content,
    expectedChannelId: setting.channelId,
  });
  return answerMove(message, chain, result,
    () => '數字已到達安全上限，這一輪數字接龍完成！請管理員使用 /board start 開新局。');
}

async function processNumberChainReactionOutbox(client, options = {}) {
  return processChainReactionOutbox(client, FEATURE_KEY, options);
}

module.exports = {
  DEFAULT_TARGET,
  FEATURE_KEY,
  MAX_TARGET,
  NumberChainError,
  acceptNumberChainMessage,
  describeNumberChainStatus,
  getNumberChainStatus,
  handleNumberChainMessage,
  processNumberChainReactionOutbox,
  startNumberChain,
  stopNumberChain,
};
