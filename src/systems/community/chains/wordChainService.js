const { withCoinDatabase, withCoinTransaction } = require('../../economy/storage/coinDatabase');
const {
  MAX_REACTION_DELIVERY_ATTEMPTS,
  REACTION_EMOJI,
  REACTION_EVENT_TYPE,
  getRetryDelay,
  processChainReactionOutbox,
} = require('./chainReactionDelivery');
const {
  answerMove,
  authorizeMoveReaction,
  defineChain,
  getChainRoundStatus,
  settleCountedMove,
  startChainRound,
  stopChainRound,
} = require('./chainRound');
const { corpusVersion, getSuccessors, hasWord, legacyCorpusVersion, wordKey } = require('./wordChainLexicon');
const { judgeWord } = require('./wordChainJudge');
const logger = require('../../../utils/logger');

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

// judged: the answer of the word chain judge (wordChainJudge.js) for a word that is not in the dictionary index, or null.
function validateWord(input, version = corpusVersion, { judged = null } = {}) {
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
    if (judged?.word === normalized && judged.valid === true) {
      return { ok: true, word: normalized, graphemes: segments, judgedBy: 'claude' };
    }
    if (judged?.word === normalized && judged.valid === false) {
      return { ok: false, code: 'UNKNOWN_WORD', message: `小吉查過了，「${normalized}」不是常用的詞語，請換一個 2 到 6 字的詞。` };
    }
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

const STOP_SESSION_SQL = `UPDATE text_chain_sessions
     SET status = 'stopped', stopped_by = ?, stopped_at = ?, updated_at = ?, revision = revision + 1
     WHERE id = ? AND status = 'active'`;

const chain = defineChain({
  featureKey: FEATURE_KEY,
  label: '文字接龍',
  versionConfig: { corpusVersion },
  makeError: (code, message) => new WordChainError(code, message),
  otherChain: {
    featureKey: 'number_chain',
    conflictMessage: '這個頻道已有進行中的數字接龍，請先停止它再開始文字接龍。',
  },
  sessions: {
    selectActive: selectActiveSession,
    selectLatestCompleted: (api, guildId, channelId) => api.get(
      "SELECT id, created_at FROM text_chain_sessions WHERE guild_id = ? AND channel_id = ? AND status = 'completed' ORDER BY id DESC LIMIT 1",
      [guildId, channelId]
    ),
    selectById: (api, id) => api.get('SELECT * FROM text_chain_sessions WHERE id = ?', [id]),
    selectLastInserted: (api) => api.get('SELECT * FROM text_chain_sessions WHERE id = last_insert_rowid()'),
    stop: (api, id, actorId, timestamp) => api.run(STOP_SESSION_SQL, [actorId, timestamp, timestamp, id]),
    map: (row) => mapSession(row),
    mapRetired: (row) => mapSession(row, { allowUnknownCorpus: true }),
  },
});

async function startWordChain({ guildId, channelId, actorId, seed = DEFAULT_SEED, now = new Date(), beforeCommit = null }) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedActorId = requireId(actorId, 'actorId');
  const checkedSeed = validateWord(seed);
  if (!checkedSeed.ok) throw new WordChainError(checkedSeed.code, checkedSeed.message);
  const timestamp = new Date(now).toISOString();
  if (Number.isNaN(new Date(timestamp).getTime())) throw new WordChainError('INVALID_ARGUMENT', 'now must be valid.');

  return startChainRound(chain, {
    guildId: normalizedGuildId,
    channelId: normalizedChannelId,
    actorId: normalizedActorId,
    timestamp,
    beforeCommit,
    insertSession: (api) => api.run(
      `INSERT INTO text_chain_sessions
       (guild_id, channel_id, status, corpus_version, current_word, last_word, last_user_id, revision, started_by, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?, ?, NULL, 0, ?, ?, ?)`,
      [normalizedGuildId, normalizedChannelId, corpusVersion, checkedSeed.word, checkedSeed.word, normalizedActorId, timestamp, timestamp]
    ),
  });
}

async function stopWordChain({ guildId, channelId, actorId, now = new Date() }) {
  return stopChainRound(chain, {
    guildId: requireId(guildId, 'guildId'),
    channelId: requireId(channelId, 'channelId'),
    actorId: requireId(actorId, 'actorId'),
    timestamp: new Date(now).toISOString(),
  });
}

// The round in the channel, if any, with paused and reactionInactive (chainRound.js).
async function getWordChainStatus(guildId, channelId) {
  return getChainRoundStatus(chain, {
    guildId: requireId(guildId, 'guildId'),
    channelId: requireId(channelId, 'channelId'),
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

// A move whose word is not in the dictionary index, and which is otherwise valid now (an active round in this channel,
// another player's turn, the right first character, not used before), is asked of the judge before the transaction.
// Anything else returns null at once, so a wrong move never costs a question. The transaction checks it all again.
async function judgeUnknownMove({ guildId, channelId, userId, expectedChannelId, messageId, content, judge }) {
  if (typeof judge !== 'function' || channelId !== expectedChannelId) return null;
  const normalized = String(content ?? '').normalize('NFC').trim();
  const segments = graphemes(normalized);
  if (segments.length < 2 || segments.length > 6 || !/^\p{Script=Han}+$/u.test(normalized)) return null;
  const move = await withCoinDatabase((api) => {
    if (api.get('SELECT session_id FROM text_chain_entries WHERE message_id = ?', [messageId])) return null;
    const session = selectActiveSession(api, guildId, channelId);
    if (!session || session.last_user_id === userId) return null;
    let version;
    try {
      version = getActiveCorpusVersion(session.corpus_version);
    } catch {
      return null;
    }
    if (hasWord(normalized, version)) return null;
    if (wordKey(segments[0]) !== wordKey(graphemes(session.current_word).at(-1))) return null;
    const used = api.all('SELECT word FROM text_chain_entries WHERE session_id = ?', [session.id])
      .some((entry) => wordKey(entry.word) === wordKey(normalized));
    return used ? null : { word: normalized };
  });
  if (!move) return null;
  const verdict = await judge(move.word, { guildId, userId });
  return { word: move.word, valid: verdict?.valid ?? null };
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
  // Asked for a word that is not in the dictionary index (wordChainJudge.js); tests pass their own.
  judge = judgeWord,
}) {
  const normalizedGuildId = requireId(guildId, 'guildId');
  const normalizedChannelId = requireId(channelId, 'channelId');
  const normalizedMessageId = requireId(messageId, 'messageId');
  const normalizedUserId = requireId(userId, 'userId');
  const normalizedExpectedChannelId = requireId(expectedChannelId, 'expectedChannelId');
  const timestamp = new Date(now).toISOString();
  const judged = await judgeUnknownMove({
    guildId: normalizedGuildId, channelId: normalizedChannelId, userId: normalizedUserId,
    expectedChannelId: normalizedExpectedChannelId, messageId: normalizedMessageId, content, judge,
  });

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
    const checkedWord = validateWord(content, sessionVersion, { judged });
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

    const { reactionMetadata, reactionAuthority } = authorizeMoveReaction(api, chain, {
      guildId: normalizedGuildId, channelId: normalizedChannelId, messageId: normalizedMessageId, session, timestamp });

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
    const reactionSource = settleCountedMove(api, chain, {
      guildId: normalizedGuildId, channelId: normalizedChannelId, messageId: normalizedMessageId,
      userId: normalizedUserId, now, timestamp, completed, entryId, finalRevision: updatedSession.revision,
      reactionMetadata, reactionAuthority,
    });
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

  return answerMove(message, chain, result, ({ session }) =>
    `這一輪文字接龍完成啦～最後一詞是「${session.currentWord}」！想再玩可以請管理員使用 /board start 開新局。`);
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
