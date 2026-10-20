const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const {
  enqueueFeatureOutboxWithApi,
} = require('./featurePlatformService');
const {
  MAX_REACTION_DELIVERY_ATTEMPTS,
  REACTION_EMOJI,
  REACTION_EVENT_TYPE,
  buildReactionOutboxPayload,
  dispatchImmediateChainReaction,
  getRetryDelay,
  processChainReactionOutbox,
} = require('./chainReactionDelivery');
const {
  RESERVED_KEY,
  closeFence,
  getRuntime: getReactionRuntime,
  inactiveReactionAuthority,
  markCompletion,
  mergeReservedConfig,
  noteInactiveReactionAuthority,
  openFence,
  parseConfig,
  readChainConfig,
  requireChainConfig,
  purposeFor,
  revokeMetadata,
  verifyMetadata,
} = require('../systems/safety/chainReactionFence');
const { snowflakeTimestamp } = require('../platform/publicEffectGrant');
const { corpusVersion, getSuccessors, hasWord, legacyCorpusVersion, wordKey } = require('./wordChainLexicon');
const logger = require('../utils/logger');

const FEATURE_KEY = 'word_chain';
const MAX_ID_LENGTH = 80;
const DEFAULT_SEED = '明白';

class WordChainError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WordChainError';
    this.code = code;
  }
}

function requireId(value, name) {
  const normalized = String(value || '').trim();
  if (!normalized || normalized.length > MAX_ID_LENGTH) {
    throw new WordChainError('INVALID_ARGUMENT', `${name} is required.`);
  }
  return normalized;
}

function graphemes(value) {
  return Array.from(new Intl.Segmenter('zh-Hant', { granularity: 'grapheme' }).segment(value), ({ segment }) => segment);
}

function validateWord(input, version = corpusVersion) {
  const normalized = String(input ?? '').normalize('NFC').trim();
  const segments = graphemes(normalized);

  if (segments.length < 2 || segments.length > 6) {
    return { ok: false, code: 'INVALID_LENGTH', message: '請輸入 2 到 6 個中文字。' };
  }
  if (!/^\p{Script=Han}+$/u.test(normalized)) {
    return { ok: false, code: 'INVALID_CHARACTERS', message: '文字接龍只接受純中文詞彙喔。' };
  }
  // The word is stored as it was typed; only the comparison treats written variants of a character (台 and 臺) alike.
  if (!hasWord(normalized, version)) {
    return { ok: false, code: 'UNKNOWN_WORD', message: '這不是小吉詞庫中的完整常用詞，請換一個 2 到 6 字的詞。' };
  }

  return { ok: true, word: normalized, graphemes: segments };
}

function requireSessionCorpusVersion(version) {
  if (version !== corpusVersion && version !== legacyCorpusVersion) {
    throw new WordChainError('INVALID_CORPUS_VERSION', '這局文字接龍的詞庫版本異常，暫時無法繼續。');
  }
  return version;
}

function getActiveCorpusVersion(version) {
  const storedVersion = requireSessionCorpusVersion(version);
  return storedVersion === legacyCorpusVersion ? corpusVersion : storedVersion;
}

// allowUnknownCorpus is only for reporting a session that stop/start has just retired: it will never be played
// again, so an unrecognized corpus label must not roll back the transaction that closes it. Every other caller
// keeps the validation, which is what stops a session with an unknown version from accepting new words.
function mapSession(row, { allowUnknownCorpus = false } = {}) {
  if (!row) return null;
  return {
    id: Number(row.id),
    guildId: row.guild_id,
    channelId: row.channel_id,
    status: row.status,
    corpusVersion: allowUnknownCorpus ? row.corpus_version : requireSessionCorpusVersion(row.corpus_version),
    currentWord: row.current_word,
    lastWord: row.last_word,
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
    `SELECT * FROM text_chain_sessions
     WHERE guild_id = ?${channelId == null ? '' : ' AND channel_id = ?'} AND status = 'active'
     ORDER BY id DESC LIMIT 1`,
    channelId == null ? [guildId] : [guildId, channelId]
  );
}

function setWordChainFeatureSetting(api, guildId, { enabled, channelId, now, reactionMetadata = undefined,
  allowCorruptDisable = false }) {
  const current = api.get('SELECT * FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?', [guildId, FEATURE_KEY]);
  const parsed = readChainConfig(current?.config_json || '{}');
  if (!parsed.valid && !(allowCorruptDisable && enabled === false)) throw new Error('CHAIN_REACTION_CONFIG_INVALID');
  const currentConfig = parsed.valid ? parsed.config : {};
  const metadata = reactionMetadata === undefined ? currentConfig[RESERVED_KEY] : reactionMetadata;
  const configJson = JSON.stringify(mergeReservedConfig(currentConfig, metadata, { corpusVersion }));
  api.run(
    `INSERT INTO feature_guild_settings
      (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, feature_key) DO UPDATE SET
       enabled = excluded.enabled, channel_id = excluded.channel_id, config_json = excluded.config_json, updated_at = excluded.updated_at`,
    [guildId, FEATURE_KEY, enabled ? 1 : 0, channelId, configJson, current?.created_at || now, now]
  );
}

// The session was created by this very start call, so there is no earlier progress to protect: retire it together
// with the feature setting. previousRoundEnded tells the caller that a round in another channel was already retired
// by the same call (a channel switch), which the administrator has to be told.
function failClosedWordChainStart(api, { guildId, sessionId, actorId, now, previousRoundEnded = false }) {
  api.run(
    `UPDATE text_chain_sessions
     SET status = 'stopped', stopped_by = ?, stopped_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND status = 'active'`,
    [actorId, now, now, sessionId]
  );
  setWordChainFeatureSetting(api, guildId, { enabled: false, channelId: null, now,
    reactionMetadata: null, allowCorruptDisable: true });
  return { fenceOpenFailed: true, previousRoundEnded };
}

// Re-running start on a channel whose round is already in progress must not end that round. The reaction fence only
// authorizes the public reaction (every dispatch re-verifies it against the stored metadata and the open fence), not
// the stored entries, so a fence that cannot be opened disables the feature setting while the session row stays
// untouched; running start again once the fence works resumes the same round.
// The stored reaction authority is kept on purpose: the startup reconcile re-enables the setting of a guild that still
// has an active round, and if the ledger fence verifies against the kept authority the reaction is sent again
// without anybody running start. An authority that no longer verifies simply yields no reaction.
function pauseWordChainAfterFenceFailure(api, { guildId, now }) {
  setWordChainFeatureSetting(api, guildId, { enabled: false, channelId: null, now, allowCorruptDisable: true });
  return { fenceOpenFailed: true, sessionKept: true };
}

// A stored reaction authority only becomes a reaction source while the live fence still verifies it, with the same
// check the dispatch repeats later. A purpose that is unavailable, or a fence that was closed or replaced, yields none,
// so no reaction is queued that could not be delivered or that would run without protection.
function liveReactionAuthority(metadata, { guildId, channelId, session }) {
  if (!metadata || metadata.revoked === true) return null;
  try {
    return verifyMetadata({ featureKey: FEATURE_KEY, guildId, channelId, sessionId: Number(session.id),
      sessionCreatedAt: session.created_at, metadata, sourceFence: metadata.sourceFence });
  } catch {
    return null;
  }
}

async function startWordChain({ guildId, channelId, actorId, seed = DEFAULT_SEED, now = new Date(), beforeCommit = null }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedActorId = requireId(actorId, 'actorId');
  const checkedSeed = validateWord(seed);
  if (!checkedSeed.ok) throw new WordChainError(checkedSeed.code, checkedSeed.message);
  const timestamp = new Date(now).toISOString();
  if (Number.isNaN(new Date(timestamp).getTime())) throw new WordChainError('INVALID_ARGUMENT', 'now must be valid.');

  const result = await withCoinTransaction((api) => {
    const initialSetting = api.get('SELECT config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
      [normalizedGuildId, FEATURE_KEY]);
    requireChainConfig(initialSetting?.config_json || '{}');
    const numberSession = api.get(
      "SELECT id, channel_id FROM number_chain_sessions WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
      [normalizedGuildId]
    );
    const numberSetting = api.get(
      "SELECT enabled, channel_id FROM feature_guild_settings WHERE guild_id = ? AND feature_key = 'number_chain'",
      [normalizedGuildId]
    );
    if (
      numberSession?.channel_id === normalizedChannelId ||
      (Number(numberSetting?.enabled) === 1 && numberSetting.channel_id === normalizedChannelId)
    ) {
      throw new WordChainError(
        'CHAIN_CHANNEL_CONFLICT',
        '這個頻道已有進行中的數字接龍，請先停止它再開始文字接龍。'
      );
    }
    const existing = selectActiveSession(api, normalizedGuildId);
    if (existing?.channel_id === normalizedChannelId) {
      const session = mapSession(existing);
      const opened = openFence({ featureKey: FEATURE_KEY, guildId: normalizedGuildId,
        channelId: normalizedChannelId, sessionId: session.id, sessionCreatedAt: session.createdAt });
      if (!opened.metadata) return pauseWordChainAfterFenceFailure(api, { guildId: normalizedGuildId,
        now: timestamp });
      setWordChainFeatureSetting(api, normalizedGuildId, { enabled: true, channelId: normalizedChannelId,
        now: timestamp, reactionMetadata: opened.metadata });
      return { alreadyActive: true, stoppedSession: null, session };
    }
    if (existing) {
      const previousSetting = api.get('SELECT config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
        [normalizedGuildId, FEATURE_KEY]);
      const previousMetadata = requireChainConfig(previousSetting?.config_json || '{}')[RESERVED_KEY];
      closeFence({ featureKey: FEATURE_KEY, guildId: normalizedGuildId,
        channelId: existing.channel_id, generation: previousMetadata?.generation });
      api.run(
        `UPDATE text_chain_sessions
         SET status = 'stopped', stopped_by = ?, stopped_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND status = 'active'`,
        [normalizedActorId, timestamp, timestamp, existing.id]
      );
    }

    api.run(
      `INSERT INTO text_chain_sessions
       (guild_id, channel_id, status, corpus_version, current_word, last_word, last_user_id, revision, started_by, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, NULL, 0, ?, ?, ?)`,
      [normalizedGuildId, normalizedChannelId, corpusVersion, checkedSeed.word, checkedSeed.word, normalizedActorId, timestamp, timestamp]
    );
    const session = mapSession(api.get('SELECT * FROM text_chain_sessions WHERE id = last_insert_rowid()'));
    const opened = openFence({ featureKey: FEATURE_KEY, guildId: normalizedGuildId,
      channelId: normalizedChannelId, sessionId: session.id, sessionCreatedAt: session.createdAt });
    if (!opened.metadata) return failClosedWordChainStart(api, { guildId: normalizedGuildId,
      sessionId: session.id, actorId: normalizedActorId, now: timestamp, previousRoundEnded: Boolean(existing) });
    setWordChainFeatureSetting(api, normalizedGuildId, { enabled: true, channelId: normalizedChannelId,
      now: timestamp, reactionMetadata: opened.metadata });
    if (typeof beforeCommit === 'function') beforeCommit();
    const stoppedSession = existing
      ? mapSession(api.get('SELECT * FROM text_chain_sessions WHERE id = ?', [existing.id]), { allowUnknownCorpus: true })
      : null;
    return { alreadyActive: false, stoppedSession, session };
  });
  if (result?.fenceOpenFailed) {
    const sessionKept = result.sessionKept === true;
    const previousRoundEnded = result.previousRoundEnded === true;
    const error = new WordChainError('REACTION_FENCE_OPEN_FAILED', sessionKept
      ? '文字接龍的公開回應安全狀態無法建立，已暫停此頻道的接龍；進度已保留，修復後重新開局即可繼續。'
      : previousRoundEnded
        ? '文字接龍的公開回應安全狀態無法建立，沒有開始新的一局，原頻道的那一局已結束，接龍保持停用。'
        : '文字接龍的公開回應安全狀態無法建立，已保持停用。');
    error.sessionKept = sessionKept;
    error.previousRoundEnded = previousRoundEnded;
    throw error;
  }
  return result;
}

async function stopWordChain({ guildId, channelId, actorId, now = new Date() }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedActorId = requireId(actorId, 'actorId');
  const timestamp = new Date(now).toISOString();

  return withCoinTransaction((api) => {
    const session = selectActiveSession(api, normalizedGuildId, normalizedChannelId);
    const activeSession = selectActiveSession(api, normalizedGuildId);
    const setting = api.get('SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
      [normalizedGuildId, FEATURE_KEY]);
    const metadata = parseConfig(setting?.config_json || '{}')[RESERVED_KEY];
    const completed = session ? null : api.get(
      "SELECT id, created_at FROM text_chain_sessions WHERE guild_id = ? AND channel_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
      [normalizedGuildId, normalizedChannelId]
    );
    const targetOwnsCurrentLineage = session
      ? Number(activeSession?.id) === Number(session.id) &&
        (!setting?.channel_id || setting.channel_id === normalizedChannelId) &&
        (!metadata?.channelId || metadata.channelId === normalizedChannelId)
      : Boolean(completed) && !activeSession &&
        (!setting?.channel_id || setting.channel_id === normalizedChannelId) &&
        (!metadata?.channelId || metadata.channelId === normalizedChannelId) &&
        (!metadata?.session?.id || Number(metadata.session.id) === Number(completed.id));
    if (!targetOwnsCurrentLineage) return { stopped: false, reactionRevoked: false, session: null };
    const closed = closeFence({ featureKey: FEATURE_KEY, guildId: normalizedGuildId,
      channelId: normalizedChannelId, generation: metadata?.generation });
    if (session) {
      api.run(
        `UPDATE text_chain_sessions
         SET status = 'stopped', stopped_by = ?, stopped_at = ?, updated_at = ?, revision = revision + 1
         WHERE id = ? AND status = 'active'`,
        [normalizedActorId, timestamp, timestamp, session.id]
      );
    }
    setWordChainFeatureSetting(api, normalizedGuildId, { enabled: false, channelId: null, now: timestamp,
      reactionMetadata: metadata ? revokeMetadata(metadata) : null, allowCorruptDisable: true });
    return { stopped: Boolean(session), reactionRevoked: closed.kind === 'closed' || closed.kind === 'failed',
      session: session
        ? mapSession(api.get('SELECT * FROM text_chain_sessions WHERE id = ?', [session.id]), { allowUnknownCorpus: true })
        : null };
  });
}

// The round in the channel, if any. paused is true while the round is still active but its feature setting is disabled
// (or points elsewhere), so the router ignores the channel: a paused round must not be reported as running.
async function getWordChainStatus(guildId, channelId) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  return withCoinDatabase((api) => {
    const session = mapSession(selectActiveSession(api, normalizedGuildId, normalizedChannelId));
    if (!session) return null;
    const setting = api.get('SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
      [normalizedGuildId, FEATURE_KEY]);
    const paused = !(Number(setting?.enabled) === 1 && setting.channel_id === session.channelId);
    // A running round whose stored ✅ authority no longer verifies while the purpose is ready
    // (for example the ledger was re-initialized) gets no reaction until start runs again.
    const reactionInactive = !paused && Boolean(inactiveReactionAuthority({ featureKey: FEATURE_KEY,
      guildId: normalizedGuildId, channelId: session.channelId, sessionId: session.id,
      sessionCreatedAt: session.createdAt, metadata: readChainConfig(setting?.config_json || '{}').config[RESERVED_KEY] || null }));
    return { ...session, paused, reactionInactive };
  });
}

function describeWordChainStatus(session) {
  const progress = `目前詞為「${session.currentWord}」，已接 ${session.revision} 次`;
  if (session.paused === true) {
    return `文字接龍已暫停：${progress}；進度已保留，管理員可在同一頻道再次使用 /board start 接續這一局。`;
  }
  return session.reactionInactive === true
    ? `文字接龍進行中：${progress}。✅ 未啟用，請在同頻道重新 /board start。`
    : `文字接龍進行中：${progress}。`;
}

async function acceptWordChainMessage({
  guildId,
  channelId,
  messageId,
  userId,
  content,
  expectedChannelId = channelId,
  now = new Date(),
  beforeCommit = null,
}) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedMessageId = requireId(messageId, 'messageId');
  const normalizedUserId = requireId(userId, 'userId');
  const normalizedExpectedChannelId = requireId(expectedChannelId, 'expectedChannelId');
  const timestamp = new Date(now).toISOString();

  return withCoinTransaction((api) => {
    const duplicate = api.get('SELECT session_id FROM text_chain_entries WHERE message_id = ?', [normalizedMessageId]);
    if (duplicate) return { ok: true, duplicate: true, sessionId: Number(duplicate.session_id) };
    if (normalizedChannelId !== normalizedExpectedChannelId) {
      return { ok: false, code: 'WRONG_CHANNEL', message: '這一局文字接龍不在這個頻道進行喔。' };
    }
    const session = selectActiveSession(api, normalizedGuildId, normalizedChannelId);
    if (!session) {
      const anotherSession = api.get(
        "SELECT id FROM text_chain_sessions WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
        [normalizedGuildId]
      );
      return {
        ok: false,
        code: anotherSession ? 'WRONG_CHANNEL' : 'NO_ACTIVE_SESSION',
        message: anotherSession ? '這一局文字接龍不在這個頻道進行喔。' : '目前沒有進行中的文字接龍。',
      };
    }
    const sessionVersion = getActiveCorpusVersion(session.corpus_version);
    const checkedWord = validateWord(content, sessionVersion);
    if (!checkedWord.ok) return checkedWord;
    if (session.last_user_id === normalizedUserId) {
      return { ok: false, code: 'SAME_USER', message: '要輪到其他人接詞才行喔。' };
    }
    // The link and the repeat check compare keys, so a word written 台灣 follows a 臺 and counts as 臺灣 used before.
    // The message names the character as the previous word wrote it.
    const expectedFirst = graphemes(session.current_word).at(-1);
    if (wordKey(checkedWord.graphemes[0]) !== wordKey(expectedFirst)) {
      return { ok: false, code: 'CHAIN_MISMATCH', message: `這一輪要從「${expectedFirst}」字開始接喔。` };
    }
    const usedKeys = new Set(
      api.all('SELECT word FROM text_chain_entries WHERE session_id = ?', [session.id]).map((entry) => wordKey(entry.word))
    );
    if (usedKeys.has(wordKey(checkedWord.word))) {
      return { ok: false, code: 'REPEATED_WORD', message: '這個詞已經接過了，換一個新的詞吧。' };
    }

    const setting = api.get('SELECT config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
      [normalizedGuildId, FEATURE_KEY]);
    const chainConfig = readChainConfig(setting?.config_json || '{}');
    let reactionMetadata = chainConfig.config[RESERVED_KEY] || null;
    if (chainConfig.valid && !reactionMetadata) {
      const runtime = getReactionRuntime();
      const purposeId = purposeFor(FEATURE_KEY);
      const sourceTime = snowflakeTimestamp(normalizedMessageId);
      // A fence read that fails disables the purpose and returns null, so the cutover is read
      // afterwards: it is null once the purpose is unavailable, and nothing is adopted.
      const fenceMissing = Boolean(runtime?.isPurposeReady?.(purposeId)) &&
        !runtime.getReactionFence(purposeId, normalizedGuildId);
      const cutover = fenceMissing ? runtime.getCutoverSourceTimestampMs(purposeId) : null;
      if (fenceMissing && Number.isSafeInteger(cutover) && Number.isSafeInteger(sourceTime) && sourceTime > cutover) {
        const adopted = openFence({ featureKey: FEATURE_KEY, guildId: normalizedGuildId,
          channelId: normalizedChannelId, sessionId: Number(session.id), sessionCreatedAt: session.created_at,
          adoptOnlyIfMissing: true });
        reactionMetadata = adopted.metadata;
        if (reactionMetadata) {
          setWordChainFeatureSetting(api, normalizedGuildId, { enabled: true, channelId: normalizedChannelId,
            now: timestamp, reactionMetadata });
        }
      }
    }
    // Decided before the completion marker is added: only the authority that verifies now may queue a reaction.
    const reactionAuthority = liveReactionAuthority(reactionMetadata, {
      guildId: normalizedGuildId, channelId: normalizedChannelId, session });
    if (!reactionAuthority) {
      noteInactiveReactionAuthority({ featureKey: FEATURE_KEY, guildId: normalizedGuildId, metadata: reactionMetadata });
    }

    api.run(
      `INSERT INTO text_chain_entries (session_id, guild_id, channel_id, message_id, user_id, word, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [session.id, normalizedGuildId, normalizedChannelId, normalizedMessageId, normalizedUserId, checkedWord.word, timestamp]
    );
    const entryId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    usedKeys.add(wordKey(checkedWord.word));
    const completed = !getSuccessors(checkedWord.word, sessionVersion)
      .some((candidate) => !usedKeys.has(wordKey(candidate)));
    api.run(
      `UPDATE text_chain_sessions
       SET corpus_version = ?, current_word = ?, last_word = ?, last_user_id = ?, revision = revision + 1, updated_at = ?,
           status = CASE WHEN ? THEN 'completed' ELSE status END,
           completed_at = CASE WHEN ? THEN ? ELSE completed_at END
       WHERE id = ? AND status = 'active'`,
      [sessionVersion, checkedWord.word, checkedWord.word, normalizedUserId, timestamp,
        completed ? 1 : 0, completed ? 1 : 0, timestamp, session.id]
    );
    const updatedSession = mapSession(api.get('SELECT * FROM text_chain_sessions WHERE id = ?', [session.id]));
    if (completed && reactionMetadata) {
      reactionMetadata = markCompletion(reactionMetadata, {
        messageId: normalizedMessageId,
        entryId,
        finalRevision: updatedSession.revision,
      });
    }
    if (completed) setWordChainFeatureSetting(api, normalizedGuildId, { enabled: false, channelId: null,
      now: timestamp, reactionMetadata });
    let reactionSource = null;
    if (reactionAuthority) {
      reactionSource = Object.freeze({ guildId: normalizedGuildId, channelId: normalizedChannelId,
        messageId: normalizedMessageId, authorId: normalizedUserId, sourceFence: reactionMetadata.sourceFence });
      enqueueFeatureOutboxWithApi(api, {
        guildId: normalizedGuildId,
        featureKey: FEATURE_KEY,
        eventType: REACTION_EVENT_TYPE,
        dedupeKey: `reaction:${normalizedMessageId}`,
        payload: buildReactionOutboxPayload(reactionSource),
        availableAt: now,
        now,
      });
    }
    if (typeof beforeCommit === 'function') beforeCommit();
    return {
      ok: true,
      duplicate: false,
      completed,
      session: updatedSession,
      reactionSource,
    };
  });
}

function buildReactionPayload({ guildId, channelId, messageId, emoji = REACTION_EMOJI }) {
  const payload = {
    guildId: requireId(guildId, 'guildId'),
    channelId: requireId(channelId, 'channelId'),
    messageId: requireId(messageId, 'messageId'),
    emoji,
  };
  if (payload.emoji !== REACTION_EMOJI || Buffer.byteLength(JSON.stringify(payload), 'utf8') > 300) {
    throw new WordChainError('INVALID_REACTION_PAYLOAD', 'Invalid word-chain reaction payload.');
  }
  return payload;
}

async function handleWordChainMessage(message, setting) {
  let result;
  try {
    result = await acceptWordChainMessage({
      guildId: message.guildId,
      channelId: message.channelId,
      messageId: message.id,
      userId: message.author.id,
      content: message.content,
      expectedChannelId: setting.channelId,
    });
  } catch (error) {
    if (error?.code !== 'INVALID_CORPUS_VERSION') throw error;
    logger.warn(`文字接龍暫時無法判詞。code=${error.code}`);
    await message.reply({
      content: '這局文字接龍目前無法繼續，請稍後再試。',
      allowedMentions: { repliedUser: false },
    }).catch((replyError) => logger.warn('文字接龍暫停訊息回覆失敗', replyError));
    return true;
  }

  if (result.duplicate) return true;
  if (!result.ok) {
    await message.reply({ content: result.message, allowedMentions: { repliedUser: false } }).catch((error) => {
      logger.warn('文字接龍拒絕訊息回覆失敗', error);
    });
    return true;
  }

  if (result.reactionSource) {
    const reaction = await dispatchImmediateChainReaction(message.client, FEATURE_KEY, result.reactionSource);
    if (reaction.kind !== 'confirmed') logger.warn(`文字接龍確認反應未確認。code=${reaction.kind}`);
  }
  if (result.completed) {
    await message.reply({
      content: `這一輪文字接龍完成啦～最後一詞是「${result.session.currentWord}」！想再玩可以請管理員使用 /board start 開新局。`,
      allowedMentions: { repliedUser: false },
    }).catch((error) => logger.warn('文字接龍完成訊息回覆失敗', error));
  }
  return true;
}

async function processWordChainReactionOutbox(client, {
  workerId,
  limit,
  claim,
  markDelivered,
  retry,
  deadLetter,
  expire,
  permissionCheck,
  now,
} = {}) {
  return processChainReactionOutbox(client, FEATURE_KEY, {
    ...(workerId ? { workerId } : {}),
    ...(limit ? { limit } : {}),
    ...(claim ? { claim } : {}),
    ...(markDelivered ? { markDelivered } : {}),
    ...(retry ? { retry } : {}),
    ...(deadLetter ? { deadLetter } : {}),
    ...(expire ? { expire } : {}),
    ...(permissionCheck ? { permissionCheck } : {}),
    ...(now ? { now } : {}),
  });
}

module.exports = {
  FEATURE_KEY,
  DEFAULT_SEED,
  MAX_REACTION_DELIVERY_ATTEMPTS,
  REACTION_EMOJI,
  REACTION_EVENT_TYPE,
  WordChainError,
  acceptWordChainMessage,
  buildReactionPayload,
  describeWordChainStatus,
  getRetryDelay,
  getWordChainStatus,
  graphemes,
  handleWordChainMessage,
  processWordChainReactionOutbox,
  startWordChain,
  stopWordChain,
  validateWord,
};
