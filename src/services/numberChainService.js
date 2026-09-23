const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const { enqueueFeatureOutbox } = require('./featurePlatformService');
const { evaluateNumberExpression } = require('./numberExpressionService');
const { REACTION_EMOJI, buildReactionPayload } = require('./wordChainService');
const logger = require('../utils/logger');

const FEATURE_KEY = 'number_chain';
const REACTION_EVENT_TYPE = 'discord_reaction';
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

function setNumberChainFeatureSetting(api, guildId, { enabled, channelId, now }) {
  const current = api.get('SELECT created_at FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?', [guildId, FEATURE_KEY]);
  api.run(
    `INSERT INTO feature_guild_settings
      (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, feature_key) DO UPDATE SET
       enabled = excluded.enabled, channel_id = excluded.channel_id, config_json = excluded.config_json, updated_at = excluded.updated_at`,
    [guildId, FEATURE_KEY, enabled ? 1 : 0, channelId, enabled ? JSON.stringify({ parserVersion: PARSER_VERSION }) : '{}', current?.created_at || now, now]
  );
}

async function startNumberChain({ guildId, channelId, actorId, target = DEFAULT_TARGET, now = new Date(), beforeCommit = null }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedActorId = requireId(actorId, 'actorId');
  const expectedTarget = requireTarget(target);
  const timestamp = new Date(now).toISOString();
  if (Number.isNaN(new Date(timestamp).getTime())) throw new NumberChainError('INVALID_ARGUMENT', 'now must be valid.');

  return withCoinTransaction((api) => {
    const wordSession = api.get(
      "SELECT id, channel_id FROM text_chain_sessions WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
      [normalizedGuildId]
    );
    const wordSetting = api.get(
      "SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'word_chain'",
      [normalizedGuildId]
    );
    if (
      wordSession?.channel_id === normalizedChannelId ||
      (Number(wordSetting?.enabled) === 1 && wordSetting.channel_id === normalizedChannelId)
    ) {
      throw new NumberChainError(
        'CHAIN_CHANNEL_CONFLICT',
        '這個頻道已有進行中的文字接龍，請先停止它再開始數字接龍。'
      );
    }
    const existing = selectActiveSession(api, normalizedGuildId);
    if (existing?.channel_id === normalizedChannelId) {
      setNumberChainFeatureSetting(api, normalizedGuildId, { enabled: true, channelId: normalizedChannelId, now: timestamp });
      return { alreadyActive: true, stoppedSession: null, session: mapSession(existing) };
    }
    if (existing) {
      api.run(
        `UPDATE number_chain_sessions
         SET status = 'stopped', stopped_by = ?, stopped_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND status = 'active'`,
        [normalizedActorId, timestamp, timestamp, existing.id]
      );
    }
    api.run(
      `INSERT INTO number_chain_sessions
        (guild_id, channel_id, status, expected_target, last_user_id, revision, started_by, created_at, updated_at)
       VALUES (?, ?, 'active', ?, NULL, 0, ?, ?, ?)`,
      [normalizedGuildId, normalizedChannelId, expectedTarget, normalizedActorId, timestamp, timestamp]
    );
    const session = mapSession(api.get('SELECT * FROM number_chain_sessions WHERE id = last_insert_rowid()'));
    setNumberChainFeatureSetting(api, normalizedGuildId, { enabled: true, channelId: normalizedChannelId, now: timestamp });
    if (typeof beforeCommit === 'function') beforeCommit();
    return {
      alreadyActive: false,
      stoppedSession: existing ? mapSession(api.get('SELECT * FROM number_chain_sessions WHERE id = ?', [existing.id])) : null,
      session,
    };
  });
}

async function stopNumberChain({ guildId, channelId, actorId, now = new Date() }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedActorId = requireId(actorId, 'actorId');
  const timestamp = new Date(now).toISOString();

  return withCoinTransaction((api) => {
    const session = selectActiveSession(api, normalizedGuildId, normalizedChannelId);
    if (!session) return { stopped: false, session: null };
    api.run(
      `UPDATE number_chain_sessions
       SET status = 'stopped', stopped_by = ?, stopped_at = ?, updated_at = ?, revision = revision + 1
       WHERE id = ? AND status = 'active'`,
      [normalizedActorId, timestamp, timestamp, session.id]
    );
    setNumberChainFeatureSetting(api, normalizedGuildId, { enabled: false, channelId: null, now: timestamp });
    return { stopped: true, session: mapSession(api.get('SELECT * FROM number_chain_sessions WHERE id = ?', [session.id])) };
  });
}

async function getNumberChainStatus(guildId, channelId) {
  return withCoinDatabase((api) => mapSession(selectActiveSession(api, requireId(guildId, 'guildId'), requireId(channelId, 'channelId'))));
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

    api.run(
      `INSERT INTO number_chain_entries (session_id, guild_id, channel_id, message_id, user_id, expression, result, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [session.id, normalizedGuildId, normalizedChannelId, normalizedMessageId, normalizedUserId, expression, Number(evaluated.value), timestamp]
    );
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
    if (completed) {
      setNumberChainFeatureSetting(api, normalizedGuildId, { enabled: false, channelId: null, now: timestamp });
    }
    return { ok: true, duplicate: false, completed, session: mapSession(api.get('SELECT * FROM number_chain_sessions WHERE id = ?', [session.id])) };
  });
}

async function enqueueReaction(message) {
  const payload = buildReactionPayload({ guildId: message.guildId, channelId: message.channelId, messageId: message.id });
  return enqueueFeatureOutbox({
    guildId: payload.guildId,
    featureKey: FEATURE_KEY,
    eventType: REACTION_EVENT_TYPE,
    dedupeKey: `reaction:${payload.messageId}`,
    payload,
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
  if (result.duplicate) return true;
  if (!result.ok) {
    await message.reply({ content: result.message, allowedMentions: { repliedUser: false } }).catch((error) => logger.warn('數字接龍拒絕訊息回覆失敗', error));
    return true;
  }
  await message.react(REACTION_EMOJI).catch(async (error) => {
    logger.warn('數字接龍確認反應失敗，已加入重試佇列', error);
    await enqueueReaction(message);
  });
  if (result.completed) {
    await message.reply({ content: '數字已到達安全上限，這一輪數字接龍完成！請管理員使用 /number-chain start 開新局。', allowedMentions: { repliedUser: false } })
      .catch((error) => logger.warn('數字接龍完成訊息回覆失敗', error));
  }
  return true;
}

module.exports = {
  DEFAULT_TARGET,
  FEATURE_KEY,
  MAX_TARGET,
  NumberChainError,
  acceptNumberChainMessage,
  getNumberChainStatus,
  handleNumberChainMessage,
  startNumberChain,
  stopNumberChain,
};
