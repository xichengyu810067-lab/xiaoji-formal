const { createHash, createHmac, randomBytes } = require('node:crypto');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const { grantRewardOnce, setFeatureHealth } = require('./featurePlatformService');
const {
  DIFFICULTIES,
  DIFFICULTY_REWARDS,
  GAME_TYPES,
  MAX_TETRIS_REWARD,
  MAX_TETRIS_SCORE,
  deriveServerGameReward,
} = require('./gameRewardPolicy');

const { MAX_ACTIONS, GameError, applyNumberMatchAction, applySudokuAction, applyTetrisAction, buildSudoku, clearFullRows, countSudokuSolutions, hasNumberMatchPair, initialState, isNumberMatchPair, publicState, scoreTetrisLock } = require('../systems/games/soloGameRules');

const SESSION_TTL_MS = 30 * 60 * 1000;
function requireText(value, label, max = 120) {
  const text = String(value || '').trim();
  if (!text || text.length > max) throw new GameError('INVALID_REQUEST', `${label} is invalid.`);
  return text;
}

function requireSecret(secret) {
  const value = requireText(secret, 'secret', 512);
  if (Buffer.byteLength(value) < 32) throw new GameError('SERVER_NOT_CONFIGURED', 'Game secret is too short.');
  return value;
}

function hashToken(token, secret) {
  return createHmac('sha256', requireSecret(secret)).update(requireText(token, 'token', 256)).digest('hex');
}

function hashAction(action) {
  return createHash('sha256').update(JSON.stringify(action)).digest('hex');
}

async function createGameSession({ userId, guildId, channelId, gameType, difficulty, secret, now = new Date() }) {
  const type = String(gameType || ''); const level = String(difficulty || '');
  if (!GAME_TYPES.includes(type) || !DIFFICULTIES.includes(level)) throw new GameError('INVALID_REQUEST', 'Unsupported game or difficulty.');
  const normalizedSecret = requireSecret(secret);
  const timestamp = new Date(now); if (Number.isNaN(timestamp.getTime())) throw new GameError('INVALID_REQUEST', 'Invalid time.');
  const id = randomBytes(16).toString('hex'); const launchToken = randomBytes(32).toString('base64url'); const seed = randomBytes(16).toString('hex');
  const expiresAt = new Date(timestamp.getTime() + SESSION_TTL_MS).toISOString();
  const state = initialState(type, level, seed);
  await withCoinTransaction((api) => api.run(
    `INSERT INTO game_sessions (id, launch_token_hash, user_id, guild_id, channel_id, game_type, difficulty, seed, state_json, status, action_count, score, reward_amount, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', 0, 0, 0, ?, ?, ?)`,
    [id, hashToken(launchToken, normalizedSecret), requireText(userId, 'userId'), requireText(guildId, 'guildId'), requireText(channelId, 'channelId'), type, level, seed, JSON.stringify(state), expiresAt, timestamp.toISOString(), timestamp.toISOString()]
  ));
  return { launchToken, sessionId: id, game: type, difficulty: level, expiresAt };
}

async function exchangeLaunchToken(launchToken, { secret, now = new Date() }) {
  const tokenHash = hashToken(launchToken, secret); const timestamp = new Date(now);
  const accessToken = randomBytes(32).toString('base64url');
  return withCoinTransaction((api) => {
    const row = api.get('SELECT * FROM game_sessions WHERE launch_token_hash = ?', [tokenHash]);
    if (!row || row.launch_consumed_at) throw new GameError('TOKEN_INVALID', 'Launch token is invalid or already used.');
    if (Date.parse(row.expires_at) <= timestamp.getTime()) throw new GameError('SESSION_EXPIRED', 'Session expired.');
    api.run('UPDATE game_sessions SET access_token_hash = ?, launch_consumed_at = ?, updated_at = ? WHERE id = ? AND launch_consumed_at IS NULL', [hashToken(accessToken, secret), timestamp.toISOString(), timestamp.toISOString(), row.id]);
    const updated = { ...row, access_token_hash: hashToken(accessToken, secret), launch_consumed_at: timestamp.toISOString() };
    return { accessToken, ...publicState(updated, JSON.parse(row.state_json)) };
  });
}

async function settleGameReward(sessionId) {
  const row = await withCoinDatabase((api) => api.get(`SELECT reward.*, session.guild_id, session.user_id, session.game_type, session.difficulty,
    session.status AS session_status, session.score AS session_score, session.reward_amount AS session_reward_amount,
    session.state_json AS session_state_json
    FROM game_rewards AS reward JOIN game_sessions AS session ON session.id = reward.session_id WHERE reward.session_id = ?`, [sessionId]));
  if (!row || row.status !== 'pending') return row;
  const amount = Number(row.amount);
  const sessionReward = Number(row.session_reward_amount);
  let expectedReward = null;
  try {
    expectedReward = deriveServerGameReward({
      gameType: row.game_type,
      difficulty: row.difficulty,
      status: row.session_status,
      score: row.session_score,
      state: JSON.parse(row.session_state_json),
    });
  } catch (_error) { /* handled by the shared fail-closed branch below */ }
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > MAX_TETRIS_REWARD ||
      !Number.isSafeInteger(sessionReward) || sessionReward < 0 || sessionReward > MAX_TETRIS_REWARD ||
      !Number.isSafeInteger(expectedReward) || expectedReward <= 0 ||
      amount !== sessionReward || amount !== expectedReward) {
    const healthKey = row.game_type === 'number-match' ? 'number_match' : row.game_type;
    try { await setFeatureHealth(healthKey, 'broken', { detail: 'reward_contract_invalid' }); }
    catch (_error) { /* reward rejection remains fail-closed even if health persistence fails */ }
    throw new GameError('REWARD_CONTRACT_INVALID', 'Stored game reward violates the server reward contract.');
  }
  let result;
  try {
    result = await grantRewardOnce(row.guild_id, row.user_id, 'game', row.session_id, 'completion', amount, { game: row.game_type, difficulty: row.difficulty });
  } catch (error) {
    if (error?.code !== 'COIN_DISABLED') throw error;
    await withCoinTransaction((api) => api.run(
      "UPDATE game_rewards SET status = 'no_reward', updated_at = ? WHERE session_id = ? AND status = 'pending'",
      [new Date().toISOString(), sessionId]
    ));
    return { status: 'no_reward', alreadyGranted: false };
  }
  await withCoinTransaction((api) => api.run("UPDATE game_rewards SET status = 'granted', updated_at = ? WHERE session_id = ? AND status = 'pending'", [new Date().toISOString(), sessionId]));
  return { status: 'granted', alreadyGranted: result.alreadyGranted };
}

async function submitGameAction({ sessionId, accessToken, expectedIndex, action, secret, now = new Date() }) {
  const id = requireText(sessionId, 'sessionId', 64); const tokenHash = hashToken(accessToken, secret);
  if (!Number.isInteger(expectedIndex) || expectedIndex < 0 || expectedIndex >= MAX_ACTIONS || !action || typeof action !== 'object' || Array.isArray(action)) throw new GameError('INVALID_ACTION', 'Invalid action request.');
  const actionHash = hashAction(action); const timestamp = new Date(now);
  const result = await withCoinTransaction((api) => {
    const session = api.get('SELECT * FROM game_sessions WHERE id = ? AND access_token_hash = ?', [id, tokenHash]);
    if (!session) throw new GameError('TOKEN_INVALID', 'Session token is invalid.');
    if (Date.parse(session.expires_at) <= timestamp.getTime()) {
      api.run("UPDATE game_sessions SET status = 'expired', updated_at = ? WHERE id = ? AND status = 'active'", [timestamp.toISOString(), id]);
      return { expired: true };
    }
    if (expectedIndex < Number(session.action_count)) {
      const previous = api.get('SELECT action_hash FROM game_actions WHERE session_id = ? AND action_index = ?', [id, expectedIndex]);
      if (!previous || previous.action_hash !== actionHash) throw new GameError('REPLAY_MISMATCH', 'Action replay does not match.');
      return { session, state: JSON.parse(session.state_json), replayed: true };
    }
    if (expectedIndex !== Number(session.action_count) || session.status !== 'active') throw new GameError('SESSION_NOT_ACTIVE', 'Session is not active.');
    const state = JSON.parse(session.state_json); let next;
    if (session.game_type === 'tetris') next = applyTetrisAction(state, action);
    else if (session.game_type === 'number-match') next = applyNumberMatchAction(state, action);
    else next = applySudokuAction(state, action);
    let status = 'active'; let reward = 0;
    if (session.game_type === 'tetris' && (next.gameOver || next.score >= MAX_TETRIS_SCORE)) status = 'completed';
    if (session.game_type === 'number-match' && (next.completed || next.noMoves)) status = 'completed';
    if (session.game_type === 'sudoku' && next.completed) status = 'completed';
    if (status === 'completed') reward = deriveServerGameReward({
      gameType: session.game_type,
      difficulty: session.difficulty,
      status,
      score: Number(next.score || 0),
      state: next,
    });
    const nextCount = expectedIndex + 1;
    api.run('INSERT INTO game_actions (session_id, action_index, action_hash, state_json, created_at) VALUES (?, ?, ?, ?, ?)', [id, expectedIndex, actionHash, JSON.stringify(next), timestamp.toISOString()]);
    api.run('UPDATE game_sessions SET state_json = ?, status = ?, action_count = ?, score = ?, reward_amount = ?, updated_at = ?, completed_at = ? WHERE id = ?', [JSON.stringify(next), status, nextCount, Number(next.score || 0), reward, timestamp.toISOString(), status === 'completed' ? timestamp.toISOString() : null, id]);
    if (status === 'completed') api.run(`INSERT INTO game_rewards (session_id, reward_key, status, amount, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(session_id) DO NOTHING`, [id, `game:${id}:completion`, reward > 0 ? 'pending' : 'no_reward', reward, timestamp.toISOString(), timestamp.toISOString()]);
    return { session: { ...session, status, action_count: nextCount, score: Number(next.score || 0), reward_amount: reward, updated_at: timestamp.toISOString() }, state: next, replayed: false };
  });
  if (result.expired) throw new GameError('SESSION_EXPIRED', 'Session expired.');
  let rewardStatus = null;
  if (result.session.status === 'completed' && Number(result.session.reward_amount) > 0) {
    try { rewardStatus = await settleGameReward(id); }
    catch (_error) { rewardStatus = { status: 'pending' }; }
  }
  return {
    ...publicState(result.session, result.state),
    replayed: result.replayed,
    reward: Number(result.session.reward_amount),
    rewardGranted: rewardStatus?.status === 'granted',
  };
}

async function resumePendingGameRewards() {
  const ids = await withCoinDatabase((api) => api.all("SELECT session_id FROM game_rewards WHERE status = 'pending' ORDER BY created_at LIMIT 50").map((row) => row.session_id));
  for (const id of ids) { try { await settleGameReward(id); } catch (_error) { /* bounded retry on next startup */ } }
  return ids.length;
}

async function getLegacyGameDrainState({ now = new Date() } = {}) {
  const timestamp = new Date(now);
  if (Number.isNaN(timestamp.getTime())) throw new GameError('INVALID_REQUEST', 'Invalid drain clock.');
  const cutoff = timestamp.toISOString();
  return withCoinTransaction((api) => {
    api.run("UPDATE game_sessions SET status = 'expired', updated_at = ? WHERE status = 'active' AND expires_at <= ?", [cutoff, cutoff]);
    const active = Number(api.get("SELECT COUNT(*) AS count FROM game_sessions WHERE status = 'active' AND expires_at > ?", [cutoff]).count);
    const pendingRewards = Number(api.get("SELECT COUNT(*) AS count FROM game_rewards WHERE status = 'pending'").count);
    return { active, pendingRewards, drained: active === 0 && pendingRewards === 0 };
  });
}

module.exports = { DIFFICULTIES, DIFFICULTY_REWARDS, GAME_TYPES, GameError, MAX_ACTIONS, MAX_TETRIS_REWARD, MAX_TETRIS_SCORE, SESSION_TTL_MS, applyNumberMatchAction, applySudokuAction, applyTetrisAction, buildSudoku, clearFullRows, countSudokuSolutions, createGameSession, exchangeLaunchToken, getLegacyGameDrainState, hasNumberMatchPair, isNumberMatchPair, resumePendingGameRewards, scoreTetrisLock, submitGameAction };
