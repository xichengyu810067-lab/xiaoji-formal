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

const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_ACTIONS = 500;

class GameError extends Error {
  constructor(code, message) { super(message); this.name = 'GameError'; this.code = code; }
}

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

function seededNumber(seed, index) {
  const digest = createHash('sha256').update(`${seed}:${index}`).digest();
  return digest.readUInt32BE(0) / 0x100000000;
}

function scoreTetrisLock(streak, clearedLines, remainingScore = MAX_TETRIS_SCORE) {
  if (!Number.isSafeInteger(streak) || streak < 0 || streak > MAX_ACTIONS * 4) throw new GameError('INVALID_ACTION', 'Invalid clear streak.');
  if (!Number.isInteger(clearedLines) || clearedLines < 0 || clearedLines > 4) throw new GameError('INVALID_ACTION', 'Invalid clear count.');
  if (!Number.isSafeInteger(remainingScore) || remainingScore < 0 || remainingScore > MAX_TETRIS_SCORE) throw new GameError('INVALID_ACTION', 'Invalid remaining score.');
  if (clearedLines === 0) return { points: 0, streak: 0 };
  let points = 0;
  for (let index = 0; index < clearedLines; index += 1) {
    const available = remainingScore - points;
    if (available <= 0) break;
    const calculated = Math.round(20 * (1.4 ** (streak + index)));
    const linePoints = Number.isSafeInteger(calculated) ? calculated : available;
    points += Math.min(linePoints, available);
  }
  return { points, streak: streak + clearedLines };
}

function clearFullRows(board) {
  const width = board[0].length;
  const remaining = board.filter((row) => row.some((cell) => !cell));
  const cleared = board.length - remaining.length;
  while (remaining.length < board.length) remaining.unshift(Array(width).fill(0));
  return { board: remaining, cleared };
}

const TETROMINOES = Object.freeze([
  [[0, 0], [1, 0], [2, 0], [3, 0]],
  [[0, 0], [1, 0], [0, 1], [1, 1]],
  [[0, 0], [1, 0], [2, 0], [1, 1]],
  [[0, 0], [1, 0], [1, 1], [2, 1]],
  [[1, 0], [2, 0], [0, 1], [1, 1]],
  [[0, 0], [0, 1], [1, 1], [2, 1]],
  [[2, 0], [0, 1], [1, 1], [2, 1]],
]);

function rotateShape(shape, rotations) {
  let result = shape.map(([x, y]) => [x, y]);
  for (let turn = 0; turn < rotations; turn += 1) result = result.map(([x, y]) => [-y, x]);
  const minX = Math.min(...result.map(([x]) => x));
  const minY = Math.min(...result.map(([, y]) => y));
  return result.map(([x, y]) => [x - minX, y - minY]);
}

function applyTetrisAction(state, action) {
  if (action?.type !== 'lock' || !Number.isInteger(action.column) || !Number.isInteger(action.rotation)) {
    throw new GameError('INVALID_ACTION', 'Invalid tetris action.');
  }
  const piece = Math.floor(seededNumber(state.seed, state.pieceIndex) * TETROMINOES.length);
  const shape = rotateShape(TETROMINOES[piece], ((action.rotation % 4) + 4) % 4);
  const width = Math.max(...shape.map(([x]) => x)) + 1;
  if (action.column < 0 || action.column + width > 10) throw new GameError('INVALID_ACTION', 'Piece is outside the board.');
  const canPlace = (row) => shape.every(([x, y]) => row + y < 20 && !state.board[row + y]?.[action.column + x]);
  if (!canPlace(0)) return { ...state, gameOver: true };
  let row = 0;
  while (canPlace(row + 1)) row += 1;
  const board = state.board.map((line) => [...line]);
  for (const [x, y] of shape) board[row + y][action.column + x] = 1;
  const cleared = clearFullRows(board);
  if (!Number.isSafeInteger(state.score) || state.score < 0 || state.score > MAX_TETRIS_SCORE) {
    throw new GameError('INVALID_ACTION', 'Invalid tetris score state.');
  }
  const scoring = scoreTetrisLock(state.streak, cleared.cleared, MAX_TETRIS_SCORE - state.score);
  return {
    ...state,
    board: cleared.board,
    score: Math.min(MAX_TETRIS_SCORE, state.score + scoring.points),
    streak: scoring.streak,
    pieceIndex: state.pieceIndex + 1,
    lastCleared: cleared.cleared,
  };
}

function isNumberMatchPair(a, b) { return Number.isInteger(a) && Number.isInteger(b) && (a === b || a + b === 10); }

function hasNumberMatchPair(board, rows, columns) {
  for (let index = 0; index < board.length; index += 1) {
    if (board[index] == null) continue;
    const right = index % columns < columns - 1 ? index + 1 : -1;
    const down = Math.floor(index / columns) < rows - 1 ? index + columns : -1;
    if ((right >= 0 && isNumberMatchPair(board[index], board[right])) ||
        (down >= 0 && isNumberMatchPair(board[index], board[down]))) return true;
  }
  return false;
}

function applyNumberMatchAction(state, action) {
  if (action?.type !== 'pair' || !Number.isInteger(action.first) || !Number.isInteger(action.second)) {
    throw new GameError('INVALID_ACTION', 'Invalid number match action.');
  }
  const { first, second } = action;
  if (first < 0 || second < 0 || first >= state.board.length || second >= state.board.length || first === second) {
    throw new GameError('INVALID_ACTION', 'Pair is outside the board.');
  }
  const rowDistance = Math.abs(Math.floor(first / state.columns) - Math.floor(second / state.columns));
  const columnDistance = Math.abs((first % state.columns) - (second % state.columns));
  if (rowDistance + columnDistance !== 1 || !isNumberMatchPair(state.board[first], state.board[second])) {
    throw new GameError('INVALID_ACTION', 'Numbers are not an eligible adjacent pair.');
  }
  const compact = state.board.filter((_value, index) => index !== first && index !== second);
  while (compact.length < state.board.length) compact.push(null);
  const completed = compact.every((value) => value == null);
  return { ...state, board: compact, completed, noMoves: !completed && !hasNumberMatchPair(compact, state.rows, state.columns) };
}

const SUDOKU_SOLUTION = Object.freeze([
  [5,3,4,6,7,8,9,1,2],[6,7,2,1,9,5,3,4,8],[1,9,8,3,4,2,5,6,7],
  [8,5,9,7,6,1,4,2,3],[4,2,6,8,5,3,7,9,1],[7,1,3,9,2,4,8,5,6],
  [9,6,1,5,3,7,2,8,4],[2,8,7,4,1,9,6,3,5],[3,4,5,2,8,6,1,7,9],
]);
const SUDOKU_PUZZLE = Object.freeze([
  [5,3,0,0,7,0,0,0,0],[6,0,0,1,9,5,0,0,0],[0,9,8,0,0,0,0,6,0],
  [8,0,0,0,6,0,0,0,3],[4,0,0,8,0,3,0,0,1],[7,0,0,0,2,0,0,0,6],
  [0,6,0,0,0,0,2,8,0],[0,0,0,4,1,9,0,0,5],[0,0,0,0,8,0,0,7,9],
]);

function countSudokuSolutions(input, limit = 2) {
  const board = input.map((row) => [...row]);
  let count = 0;
  function solve() {
    if (count >= limit) return;
    let target = null;
    let choices = null;
    for (let row = 0; row < 9; row += 1) for (let column = 0; column < 9; column += 1) {
      if (board[row][column]) continue;
      const used = new Set([...board[row], ...board.map((line) => line[column])]);
      const boxRow = Math.floor(row / 3) * 3;
      const boxColumn = Math.floor(column / 3) * 3;
      for (let y = boxRow; y < boxRow + 3; y += 1) for (let x = boxColumn; x < boxColumn + 3; x += 1) used.add(board[y][x]);
      const available = [1,2,3,4,5,6,7,8,9].filter((value) => !used.has(value));
      if (!available.length) return;
      if (!choices || available.length < choices.length) { target = [row, column]; choices = available; }
    }
    if (!target) { count += 1; return; }
    for (const value of choices) { board[target[0]][target[1]] = value; solve(); board[target[0]][target[1]] = 0; }
  }
  solve();
  return count;
}

function buildSudoku(seed, difficulty) {
  const shift = Math.floor(seededNumber(seed, 0) * 9);
  const map = (value) => value ? ((value + shift - 1) % 9) + 1 : 0;
  const solution = SUDOKU_SOLUTION.map((row) => row.map(map));
  let puzzle = SUDOKU_PUZZLE.map((row) => row.map(map));
  const extras = { easy: 14, normal: 8, complex: 3, hard: 0 }[difficulty];
  let added = 0;
  for (let index = 0; index < 81 && added < extras; index += 1) {
    const row = Math.floor(index / 9); const column = index % 9;
    if (!puzzle[row][column]) { puzzle[row][column] = solution[row][column]; added += 1; }
  }
  return { puzzle, solution, entries: puzzle.map((row) => [...row]), completed: false };
}

function applySudokuAction(state, action) {
  if (action?.type !== 'set' || !Number.isInteger(action.row) || !Number.isInteger(action.column) ||
      !Number.isInteger(action.value) || action.row < 0 || action.row > 8 || action.column < 0 ||
      action.column > 8 || action.value < 0 || action.value > 9) throw new GameError('INVALID_ACTION', 'Invalid sudoku action.');
  if (state.puzzle[action.row][action.column] !== 0) throw new GameError('GIVEN_LOCKED', 'Sudoku given cells cannot change.');
  const entries = state.entries.map((row) => [...row]);
  entries[action.row][action.column] = action.value;
  const completed = entries.every((row, y) => row.every((value, x) => value === state.solution[y][x]));
  return { ...state, entries, completed };
}

function initialState(gameType, difficulty, seed) {
  if (gameType === 'tetris') return { seed, board: Array.from({ length: 20 }, () => Array(10).fill(0)), score: 0, streak: 0, pieceIndex: 0, lastCleared: 0, gameOver: false };
  if (gameType === 'number-match') {
    const values = { easy: [1,9,5,5], normal: [1,9,2,8,5,5], complex: [1,9,2,8,3,7,4,6,5,5,1,9], hard: [1,9,2,8,3,7,4,6,5,5,1,9,2,8,3,7] }[difficulty];
    const columns = difficulty === 'easy' ? 2 : difficulty === 'normal' ? 3 : 4;
    return { board: values, rows: values.length / columns, columns, completed: false, noMoves: false };
  }
  return buildSudoku(seed, difficulty);
}

function publicState(session, state) {
  const base = { sessionId: session.id, game: session.game_type, difficulty: session.difficulty, status: session.status, actionCount: Number(session.action_count), expiresAt: session.expires_at };
  if (session.game_type === 'sudoku') return { ...base, state: { puzzle: state.puzzle, entries: state.entries, completed: state.completed } };
  return { ...base, state };
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

module.exports = { DIFFICULTIES, DIFFICULTY_REWARDS, GAME_TYPES, GameError, MAX_ACTIONS, MAX_TETRIS_REWARD, MAX_TETRIS_SCORE, SESSION_TTL_MS, applyNumberMatchAction, applySudokuAction, applyTetrisAction, buildSudoku, clearFullRows, countSudokuSolutions, createGameSession, exchangeLaunchToken, hasNumberMatchPair, isNumberMatchPair, resumePendingGameRewards, scoreTetrisLock, submitGameAction };
