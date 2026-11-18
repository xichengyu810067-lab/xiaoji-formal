const logger = require('../../../../utils/logger');
const { getColumnNames, getRow, getRows, getTableDefinition, getTableNames, verifyIntegrity } = require('../sqlHelpers');

// The reward contract of the retired web game server, frozen as it was when that server wrote the
// game_sessions and game_rewards rows. The migration owns this copy instead of loading the live
// reward policy of the games system (src/systems/games/gameRewardPolicy.js): the economy does not
// load games code (R4), and a later change to the rewards of the Discord solo games must not make an
// old database with legacy rows fail to open. test/legacyGameRewardContract.test.js keeps both in step
// for the states the web server could store.
const LEGACY_REWARDS_BY_DIFFICULTY = Object.freeze({ easy: 20, normal: 30, complex: 50, hard: 100 });
const LEGACY_MAX_TETRIS_SCORE = 20_000;
const LEGACY_MAX_TETRIS_REWARD = 1_000;

function legacyRewardError(message) {
  const error = new Error(message);
  error.name = 'GameRewardPolicyError';
  error.code = 'REWARD_CONTRACT_INVALID';
  return error;
}

function isSolvedLegacySudoku(state) {
  const { entries, solution } = state;
  if (state.completed !== true || !Array.isArray(entries) || !Array.isArray(solution)) return false;
  if (entries.length !== 9 || solution.length !== 9) return false;
  for (let row = 0; row < 9; row += 1) {
    const expected = solution[row];
    const actual = entries[row];
    if (!Array.isArray(actual) || actual.length !== 9 || !Array.isArray(expected) || expected.length !== 9) return false;
    for (let column = 0; column < 9; column += 1) {
      const value = actual[column];
      if (!Number.isInteger(value) || value < 1 || value > 9 || value !== expected[column]) return false;
    }
  }
  return true;
}

// The reward a stored legacy game earned, or a thrown REWARD_CONTRACT_INVALID error.
function deriveLegacyGameReward({ gameType, difficulty, status, score, state }) {
  const knownDifficulty = Object.keys(LEGACY_REWARDS_BY_DIFFICULTY).includes(difficulty);
  const knownType = gameType === 'tetris' || gameType === 'number-match' || gameType === 'sudoku';
  if (!knownType || !knownDifficulty || status !== 'completed' || !state || typeof state !== 'object' || Array.isArray(state)) {
    throw legacyRewardError('Game session does not prove a completed supported game.');
  }
  if (gameType === 'tetris') {
    const points = Number(score);
    const statePoints = Number(state.score);
    const validPoints = Number.isSafeInteger(points) && points >= 0 && points <= LEGACY_MAX_TETRIS_SCORE;
    const finished = state.gameOver === true || points >= LEGACY_MAX_TETRIS_SCORE;
    if (!validPoints || !Number.isSafeInteger(statePoints) || statePoints !== points || !finished) {
      throw legacyRewardError('Tetris completion state or score is invalid.');
    }
    return Math.min(LEGACY_MAX_TETRIS_REWARD, Math.floor(points / 20));
  }
  if (gameType === 'number-match') {
    const { board } = state;
    if (state.completed === true && Array.isArray(board) && board.length > 0 && board.every((cell) => cell == null)) {
      return LEGACY_REWARDS_BY_DIFFICULTY[difficulty];
    }
    if (state.noMoves === true && state.completed === false) return 0;
    throw legacyRewardError('Number match state does not prove a completed game.');
  }
  if (!isSolvedLegacySudoku(state)) throw legacyRewardError('Sudoku state does not prove a completed puzzle.');
  return LEGACY_REWARDS_BY_DIFFICULTY[difficulty];
}

// v18: bounds of the server-authoritative game session tables; every stored reward is checked against
// the legacy reward contract above.
function migrateGameSessionsV18Bounds(db) {
  if (!getTableNames(db).has('game_sessions')) return false;
  const sessionColumns = [
    'id', 'launch_token_hash', 'access_token_hash', 'launch_consumed_at', 'user_id', 'guild_id', 'channel_id',
    'game_type', 'difficulty', 'seed', 'state_json', 'status', 'action_count', 'score', 'reward_amount', 'expires_at',
    'created_at', 'updated_at', 'completed_at',
  ];
  const actionColumns = ['session_id', 'action_index', 'action_hash', 'state_json', 'created_at'];
  const rewardColumns = ['session_id', 'reward_key', 'status', 'amount', 'created_at', 'updated_at'];
  const exactColumns = (tableName, expected) => {
    const actual = getColumnNames(db, tableName);
    return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
  };
  if (!exactColumns('game_sessions', sessionColumns) || !exactColumns('game_actions', actionColumns) || !exactColumns('game_rewards', rewardColumns)) {
    throw new Error('game tables have an incompatible v18 schema');
  }
  const definition = getTableDefinition(db, 'game_sessions');
  const rewardDefinition = getTableDefinition(db, 'game_rewards');
  const hasCurrentSessionBounds = definition.includes('check(score>=0andscore<=20000)') &&
    definition.includes('check(reward_amount>=0andreward_amount<=1000)');
  const hasLegacySessionBounds = definition.includes('check(score>=0)') && definition.includes('check(reward_amount>=0)');
  const hasCurrentRewardBounds = rewardDefinition.includes('check(amount>=0andamount<=1000)');
  const hasLegacyRewardBounds = rewardDefinition.includes('check(amount>=0)');
  if (!hasCurrentSessionBounds && !hasLegacySessionBounds) {
    throw new Error('game_sessions has incompatible score constraints');
  }
  if (!hasCurrentRewardBounds && !hasLegacyRewardBounds) {
    throw new Error('game_rewards has incompatible amount constraints');
  }
  const invalid = getRow(db, `SELECT id FROM game_sessions
    WHERE typeof(score) <> 'integer' OR score < 0 OR score > 20000
       OR typeof(reward_amount) <> 'integer' OR reward_amount < 0 OR reward_amount > 1000
    LIMIT 1`);
  if (invalid) throw new Error('game_sessions contains values outside the safe score contract');
  const invalidReward = getRow(db, `SELECT session_id FROM game_rewards
    WHERE typeof(amount) <> 'integer' OR amount < 0 OR amount > 1000
    LIMIT 1`);
  if (invalidReward) throw new Error('game_rewards contains values outside the safe reward contract');
  const persistedRewards = getRows(db, `SELECT reward.amount, reward.status AS reward_status,
    session.game_type, session.difficulty, session.status AS session_status, session.score,
    session.reward_amount, session.state_json
    FROM game_rewards AS reward
    JOIN game_sessions AS session ON session.id = reward.session_id`);
  for (const reward of persistedRewards) {
    let state;
    try { state = JSON.parse(reward.state_json); }
    catch (_error) { throw new Error('game reward state is not valid JSON'); }
    const expectedReward = deriveLegacyGameReward({
      gameType: reward.game_type,
      difficulty: reward.difficulty,
      status: reward.session_status,
      score: reward.score,
      state,
    });
    if (Number(reward.amount) !== expectedReward || Number(reward.reward_amount) !== expectedReward ||
        (expectedReward > 0 && !['pending', 'granted'].includes(reward.reward_status)) ||
        (expectedReward === 0 && reward.reward_status !== 'no_reward')) {
      throw new Error('game reward row does not match its server-authoritative completion state');
    }
  }
  if (hasCurrentSessionBounds && hasCurrentRewardBounds) return false;
  for (const tableName of ['game_sessions_v18_rebuild', 'game_actions_v18_rebuild', 'game_rewards_v18_rebuild']) {
    if (getTableNames(db).has(tableName)) throw new Error(`unexpected migration table already exists: ${tableName}`);
  }
  const before = {
    sessions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_sessions').count),
    actions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_actions').count),
    rewards: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_rewards').count),
  };
  let transactionStarted = false;
  try {
    db.exec('BEGIN IMMEDIATE');
    transactionStarted = true;
    db.exec(`
      CREATE TABLE game_sessions_v18_rebuild (
        id TEXT PRIMARY KEY NOT NULL,
        launch_token_hash TEXT NOT NULL UNIQUE,
        access_token_hash TEXT UNIQUE,
        launch_consumed_at TEXT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        game_type TEXT NOT NULL CHECK (game_type IN ('tetris', 'number-match', 'sudoku')),
        difficulty TEXT NOT NULL CHECK (difficulty IN ('easy', 'normal', 'complex', 'hard')),
        seed TEXT NOT NULL,
        state_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'expired', 'failed')),
        action_count INTEGER NOT NULL DEFAULT 0 CHECK (action_count >= 0 AND action_count <= 500),
        score INTEGER NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 20000),
        reward_amount INTEGER NOT NULL DEFAULT 0 CHECK (reward_amount >= 0 AND reward_amount <= 1000),
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE TABLE game_actions_v18_rebuild (
        session_id TEXT NOT NULL,
        action_index INTEGER NOT NULL CHECK (action_index >= 0 AND action_index < 500),
        action_hash TEXT NOT NULL,
        state_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (session_id, action_index),
        FOREIGN KEY (session_id) REFERENCES game_sessions_v18_rebuild(id) ON DELETE CASCADE
      );
      CREATE TABLE game_rewards_v18_rebuild (
        session_id TEXT PRIMARY KEY NOT NULL,
        reward_key TEXT NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'granted', 'no_reward')),
        amount INTEGER NOT NULL CHECK (amount >= 0 AND amount <= 1000),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (session_id) REFERENCES game_sessions_v18_rebuild(id) ON DELETE CASCADE
      );
      INSERT INTO game_sessions_v18_rebuild SELECT * FROM game_sessions;
      INSERT INTO game_actions_v18_rebuild SELECT * FROM game_actions;
      INSERT INTO game_rewards_v18_rebuild SELECT * FROM game_rewards;
      DROP TABLE game_actions;
      DROP TABLE game_rewards;
      DROP TABLE game_sessions;
      ALTER TABLE game_sessions_v18_rebuild RENAME TO game_sessions;
      ALTER TABLE game_actions_v18_rebuild RENAME TO game_actions;
      ALTER TABLE game_rewards_v18_rebuild RENAME TO game_rewards;
    `);
    const after = {
      sessions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_sessions').count),
      actions: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_actions').count),
      rewards: Number(getRow(db, 'SELECT COUNT(*) AS count FROM game_rewards').count),
    };
    if (JSON.stringify(after) !== JSON.stringify(before)) throw new Error('game migration row counts changed');
    verifyIntegrity(db);
    db.exec('COMMIT');
    transactionStarted = false;
    return true;
  } catch (error) {
    if (transactionStarted) {
      try { db.exec('ROLLBACK'); }
      catch (rollbackError) { logger.error('Game v18 bounds migration rollback failed', rollbackError); }
    }
    throw error;
  }
}

module.exports = {
  deriveLegacyGameReward,
  migrateGameSessionsV18Bounds,
};
