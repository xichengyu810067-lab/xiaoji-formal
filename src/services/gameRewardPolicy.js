const GAME_TYPES = Object.freeze(['tetris', 'number-match', 'sudoku']);
const DIFFICULTIES = Object.freeze(['easy', 'normal', 'complex', 'hard']);
const DIFFICULTY_REWARDS = Object.freeze({ easy: 20, normal: 30, complex: 50, hard: 100 });
const MAX_TETRIS_SCORE = 20_000;
const MAX_TETRIS_REWARD = 1_000;

class GameRewardPolicyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GameRewardPolicyError';
    this.code = 'REWARD_CONTRACT_INVALID';
  }
}

function fail(message) {
  throw new GameRewardPolicyError(message);
}

function isSolvedSudoku(state) {
  if (state?.completed !== true || !Array.isArray(state.entries) || !Array.isArray(state.solution) ||
      state.entries.length !== 9 || state.solution.length !== 9) return false;
  return state.entries.every((row, rowIndex) => Array.isArray(row) && row.length === 9 &&
    Array.isArray(state.solution[rowIndex]) && state.solution[rowIndex].length === 9 &&
    row.every((value, columnIndex) => Number.isInteger(value) && value >= 1 && value <= 9 &&
      value === state.solution[rowIndex][columnIndex]));
}

function deriveServerGameReward({ gameType, difficulty, status, score, state }) {
  if (!GAME_TYPES.includes(gameType) || !DIFFICULTIES.includes(difficulty) || status !== 'completed' ||
      !state || typeof state !== 'object' || Array.isArray(state)) {
    fail('Game session does not prove a completed supported game.');
  }

  if (gameType === 'tetris') {
    const sessionScore = Number(score);
    const stateScore = Number(state.score);
    if (!Number.isSafeInteger(sessionScore) || sessionScore < 0 || sessionScore > MAX_TETRIS_SCORE ||
        !Number.isSafeInteger(stateScore) || stateScore !== sessionScore ||
        (state.gameOver !== true && sessionScore < MAX_TETRIS_SCORE)) {
      fail('Tetris completion state or score is invalid.');
    }
    return Math.min(MAX_TETRIS_REWARD, Math.floor(sessionScore / 20));
  }

  if (gameType === 'number-match') {
    const cleared = state.completed === true && Array.isArray(state.board) && state.board.length > 0 &&
      state.board.every((value) => value == null);
    if (cleared) return DIFFICULTY_REWARDS[difficulty];
    if (state.noMoves === true && state.completed === false) return 0;
    fail('Number match state does not prove a completed game.');
  }

  if (!isSolvedSudoku(state)) fail('Sudoku state does not prove a completed puzzle.');
  return DIFFICULTY_REWARDS[difficulty];
}

module.exports = {
  DIFFICULTIES,
  DIFFICULTY_REWARDS,
  GAME_TYPES,
  GameRewardPolicyError,
  MAX_TETRIS_REWARD,
  MAX_TETRIS_SCORE,
  deriveServerGameReward,
};
