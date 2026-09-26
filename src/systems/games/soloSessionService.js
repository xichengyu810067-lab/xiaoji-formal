const { createHash, randomBytes } = require('node:crypto');
const { GameError } = require('./soloGameError');
const { MAX_ACTIONS, applyNumberMatchAction, applySudokuAction, applyTetrisAction, initialState } = require('./soloGameRules');
const { DIFFICULTIES, GAME_TYPES, MAX_TETRIS_SCORE, deriveServerGameReward } = require('../../services/gameRewardPolicy');

const SESSION_TTL_MS = 30 * 60 * 1000;

function requireId(value, label) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9_-]{1,100}$/u.test(text)) throw new GameError('INVALID_REQUEST', `${label} is invalid.`);
  return text;
}

function requireClock(now) {
  const value = new Date(now);
  if (Number.isNaN(value.getTime())) throw new GameError('INVALID_REQUEST', 'Clock is invalid.');
  return value;
}

function makeRewardKey({ sessionId, userId }) {
  const canonicalSourceId = `discord:${requireId(sessionId, 'sessionId')}`;
  const tuple = ['game', canonicalSourceId, 'completion', requireId(userId, 'userId')];
  return `reward:v1:${createHash('sha256').update(JSON.stringify(tuple)).digest('hex')}`;
}

function publicSession(row) {
  if (!row) return null;
  const state = JSON.parse(row.state_json);
  if (row.game_type === 'sudoku') delete state.solution;
  return {
    id: row.id,
    userId: row.user_id,
    guildId: row.source_guild_id,
    channelId: row.channel_id,
    messageId: row.message_id,
    gameType: row.game_type,
    difficulty: row.difficulty,
    status: row.status,
    revision: Number(row.revision),
    actionCount: Number(row.action_count),
    score: Number(row.score),
    rewardAmount: Number(row.reward_amount),
    expiresAt: row.expires_at,
    state,
  };
}

function assertBoundary(row, { actorId, guildId, channelId, messageId = null }) {
  if (!row) throw new GameError('SESSION_NOT_FOUND', 'Solo game was not found.');
  if (row.user_id !== requireId(actorId, 'actorId')) throw new GameError('NOT_OWNER', 'Only the game owner may act.');
  if (row.source_guild_id !== requireId(guildId, 'guildId') || row.channel_id !== requireId(channelId, 'channelId')) {
    throw new GameError('SESSION_SCOPE_MISMATCH', 'Solo game source does not match.');
  }
  if (messageId !== null && (!row.message_id || row.message_id !== requireId(messageId, 'messageId'))) {
    throw new GameError('MESSAGE_MISMATCH', 'Solo game message does not match.');
  }
}

function nextGameState(row, action) {
  const state = JSON.parse(row.state_json);
  let next;
  if (row.game_type === 'tetris') next = applyTetrisAction(state, action);
  else if (row.game_type === 'number-match') next = applyNumberMatchAction(state, action);
  else if (row.game_type === 'sudoku') next = applySudokuAction(state, action);
  else throw new GameError('INVALID_STATE', 'Unsupported stored game.');
  let status = 'active';
  if (row.game_type === 'tetris' && (next.gameOver || next.score >= MAX_TETRIS_SCORE)) status = 'completed';
  if (row.game_type === 'number-match' && (next.completed || next.noMoves)) status = 'completed';
  if (row.game_type === 'sudoku' && next.completed) status = 'completed';
  const score = Number(next.score || 0);
  const rewardAmount = status === 'completed' ? deriveServerGameReward({
    gameType: row.game_type, difficulty: row.difficulty, status, score, state: next,
  }) : 0;
  return { next, status, score, rewardAmount };
}

function createSoloSessionService({ withTransaction, withDatabase, grantRewardOnceV2WithApi, clock = () => new Date(),
  idFactory = () => randomBytes(16).toString('hex'), seedFactory = () => randomBytes(16).toString('hex') } = {}) {
  if (typeof withTransaction !== 'function' || typeof withDatabase !== 'function') {
    throw new GameError('STORE_NOT_CONFIGURED', 'Solo game database is unavailable.');
  }

  async function create({ userId, guildId, channelId, gameType, difficulty }) {
    const type = String(gameType || '');
    const level = String(difficulty || '');
    if (!GAME_TYPES.includes(type) || !DIFFICULTIES.includes(level)) throw new GameError('INVALID_REQUEST', 'Unsupported game or difficulty.');
    const timestamp = requireClock(clock());
    const id = requireId(idFactory(), 'sessionId');
    const seed = requireId(seedFactory(), 'seed');
    const row = {
      id, user_id: requireId(userId, 'userId'), source_guild_id: requireId(guildId, 'guildId'),
      channel_id: requireId(channelId, 'channelId'), message_id: null, game_type: type, difficulty: level, seed,
      state_json: JSON.stringify(initialState(type, level, seed)), status: 'active', revision: 0, action_count: 0,
      score: 0, reward_amount: 0, expires_at: new Date(timestamp.getTime() + SESSION_TTL_MS).toISOString(),
      created_at: timestamp.toISOString(), updated_at: timestamp.toISOString(), completed_at: null,
    };
    await withTransaction((api) => api.run(`INSERT INTO discord_game_sessions
      (id,user_id,source_guild_id,channel_id,message_id,game_type,difficulty,seed,state_json,status,revision,action_count,score,reward_amount,expires_at,created_at,updated_at,completed_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`, [row.id, row.user_id, row.source_guild_id, row.channel_id, row.message_id,
      row.game_type, row.difficulty, row.seed, row.state_json, row.status, row.revision, row.action_count, row.score,
      row.reward_amount, row.expires_at, row.created_at, row.updated_at, row.completed_at]));
    return publicSession(row);
  }

  async function get({ sessionId, actorId, guildId, channelId, messageId = null }) {
    return withDatabase((api) => {
      const row = api.get('SELECT * FROM discord_game_sessions WHERE id = ?', [requireId(sessionId, 'sessionId')]);
      assertBoundary(row, { actorId, guildId, channelId, messageId });
      if (row.status === 'active' && Date.parse(row.expires_at) <= requireClock(clock()).getTime()) row.status = 'expired';
      const session = publicSession(row);
      if (row.status === 'completed') {
        session.rewardStatus = api.get('SELECT status FROM discord_game_rewards WHERE session_id = ?', [row.id])?.status || 'pending';
      }
      return session;
    });
  }

  async function findLatest({ actorId, guildId, channelId }) {
    return withDatabase((api) => {
      const row = api.get(`SELECT * FROM discord_game_sessions WHERE user_id = ? AND source_guild_id = ? AND channel_id = ?
        AND status = 'active' AND expires_at > ? ORDER BY created_at DESC LIMIT 1`,
      [requireId(actorId, 'actorId'), requireId(guildId, 'guildId'), requireId(channelId, 'channelId'), requireClock(clock()).toISOString()]);
      return row ? publicSession(row) : null;
    });
  }

  async function bindMessage({ sessionId, actorId, guildId, channelId, messageId }) {
    return withTransaction((api) => {
      const id = requireId(sessionId, 'sessionId');
      const row = api.get('SELECT * FROM discord_game_sessions WHERE id = ?', [id]);
      assertBoundary(row, { actorId, guildId, channelId });
      const message = requireId(messageId, 'messageId');
      if (row.message_id && row.message_id !== message) throw new GameError('MESSAGE_MISMATCH', 'Solo game is already bound.');
      if (!row.message_id) {
        api.run('UPDATE discord_game_sessions SET message_id = ?, updated_at = ? WHERE id = ? AND message_id IS NULL', [message, requireClock(clock()).toISOString(), id]);
        if (Number(api.get('SELECT changes() AS count').count) !== 1) throw new GameError('STALE_REVISION', 'Solo game binding changed.');
      }
      return publicSession({ ...row, message_id: message });
    });
  }

  async function rebindMessage({ sessionId, actorId, guildId, channelId, oldMessageId, newMessageId, expectedRevision }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) {
      throw new GameError('INVALID_REQUEST', 'Invalid solo game revision.');
    }
    return withTransaction((api) => {
      const id = requireId(sessionId, 'sessionId');
      const row = api.get('SELECT * FROM discord_game_sessions WHERE id = ?', [id]);
      assertBoundary(row, { actorId, guildId, channelId, messageId: oldMessageId });
      if (Number(row.revision) !== expectedRevision) throw new GameError('STALE_REVISION', 'Solo game changed.');
      const message = requireId(newMessageId, 'newMessageId');
      api.run('UPDATE discord_game_sessions SET message_id = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ? AND message_id = ?',
        [message, requireClock(clock()).toISOString(), id, expectedRevision, oldMessageId]);
      if (Number(api.get('SELECT changes() AS count').count) !== 1) throw new GameError('STALE_REVISION', 'Solo game changed.');
      return publicSession({ ...row, message_id: message, revision: expectedRevision + 1 });
    });
  }

  async function apply({ sessionId, actorId, guildId, channelId, messageId, expectedRevision, interactionId, action }) {
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER ||
        !action || typeof action !== 'object' || Array.isArray(action)) throw new GameError('INVALID_ACTION', 'Invalid solo game action.');
    const id = requireId(sessionId, 'sessionId');
    const interaction = requireId(interactionId, 'interactionId');
    const actionHash = createHash('sha256').update(JSON.stringify([expectedRevision, action])).digest('hex');
    const outcome = await withTransaction((api) => {
      const row = api.get('SELECT * FROM discord_game_sessions WHERE id = ?', [id]);
      assertBoundary(row, { actorId, guildId, channelId, messageId });
      const replay = api.get('SELECT action_hash,result_json FROM discord_game_actions WHERE interaction_id = ?', [interaction]);
      if (replay) {
        if (replay.action_hash !== actionHash) throw new GameError('REPLAY_MISMATCH', 'Interaction replay differs.');
        const result = JSON.parse(replay.result_json);
        if (result.id !== id) throw new GameError('REPLAY_MISMATCH', 'Interaction belongs to another game.');
        return { ...result, replayed: true };
      }
      const timestamp = requireClock(clock());
      if (Date.parse(row.expires_at) <= timestamp.getTime()) {
        if (row.status === 'active') api.run("UPDATE discord_game_sessions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'", [timestamp.toISOString(), id]);
        return { expired: true };
      }
      if (row.status !== 'active') throw new GameError('SESSION_NOT_ACTIVE', 'Solo game has ended.');
      if (Number(row.revision) !== expectedRevision) throw new GameError('STALE_REVISION', 'Solo game changed.');
      const actionCount = Number(row.action_count);
      if (!Number.isSafeInteger(actionCount) || actionCount < 0 || actionCount > MAX_ACTIONS) {
        throw new GameError('INVALID_STATE', 'Stored solo game action count is invalid.');
      }
      if (actionCount >= MAX_ACTIONS) throw new GameError('ACTION_LIMIT_REACHED', 'Solo game action limit reached.');
      const { next, status, score, rewardAmount } = nextGameState(row, action);
      const revision = expectedRevision + 1;
      const nextActionCount = actionCount + 1;
      api.run(`UPDATE discord_game_sessions SET state_json = ?, status = ?, revision = ?, action_count = ?, score = ?, reward_amount = ?,
        updated_at = ?, completed_at = ? WHERE id = ? AND revision = ? AND status = 'active'`,
      [JSON.stringify(next), status, revision, nextActionCount, score, rewardAmount, timestamp.toISOString(), status === 'completed' ? timestamp.toISOString() : null, id, expectedRevision]);
      if (Number(api.get('SELECT changes() AS count').count) !== 1) throw new GameError('STALE_REVISION', 'Solo game changed.');
      let rewardStatus = 'none';
      if (status === 'completed') {
        const rewardKey = makeRewardKey({ sessionId: id, userId: row.user_id });
        let receiptId = null;
        const coinSettings = api.get('SELECT enabled FROM coin_guild_settings WHERE guild_id = ?', [row.source_guild_id]);
        if (rewardAmount > 0 && Number(coinSettings?.enabled ?? 1) === 1) {
          if (typeof grantRewardOnceV2WithApi !== 'function') throw new GameError('REWARD_NOT_CONFIGURED', 'Reward coordinator is unavailable.');
          const receipt = grantRewardOnceV2WithApi(api, {
            kind: 'game', canonicalSourceId: `discord:${id}`, rewardKind: 'completion', userId: row.user_id,
            sourceGuildId: row.source_guild_id, amount: rewardAmount,
            metadata: { game: row.game_type, difficulty: row.difficulty },
          });
          if (receipt && typeof receipt.then === 'function') throw new GameError('REWARD_CONTRACT_INVALID', 'Reward grant must complete inside the transaction.');
          receiptId = receipt?.receipt?.id || receipt?.receiptId || null;
          rewardStatus = 'granted';
        } else rewardStatus = 'no_reward';
        api.run(`INSERT INTO discord_game_rewards (session_id,reward_key,status,amount,receipt_id,created_at,updated_at)
          VALUES (?,?,?,?,?,?,?)`, [id, rewardKey, rewardStatus, rewardAmount, receiptId, timestamp.toISOString(), timestamp.toISOString()]);
      }
      const result = { ...publicSession({ ...row, state_json: JSON.stringify(next), status, revision, action_count: nextActionCount,
        score, reward_amount: rewardAmount, updated_at: timestamp.toISOString(), completed_at: status === 'completed' ? timestamp.toISOString() : null }),
      rewardStatus, replayed: false };
      api.run(`INSERT INTO discord_game_actions (session_id,revision,interaction_id,action_hash,result_json,created_at)
        VALUES (?,?,?,?,?,?)`, [id, revision, interaction, actionHash, JSON.stringify(result), timestamp.toISOString()]);
      return result;
    });
    if (outcome.expired) throw new GameError('SESSION_EXPIRED', 'Solo game has expired.');
    return outcome;
  }

  return Object.freeze({ create, get, findLatest, bindMessage, rebindMessage, apply });
}

module.exports = { SESSION_TTL_MS, assertBoundary, createSoloSessionService, makeRewardKey, publicSession };
