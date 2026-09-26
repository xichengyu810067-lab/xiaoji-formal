const { createHash } = require('node:crypto');
const { GameError } = require('./soloGameError');
const { MAX_TETRIS_SCORE } = require('../../services/gameRewardPolicy');

const MAX_ACTIONS = 500;

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

function nextTetrisShape(state) {
  const piece = Math.floor(seededNumber(state.seed, state.pieceIndex) * TETROMINOES.length);
  return TETROMINOES[piece].map(([x, y]) => [x, y]);
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

module.exports = { MAX_ACTIONS, GameError, applyNumberMatchAction, applySudokuAction, applyTetrisAction, buildSudoku, clearFullRows, countSudokuSolutions, hasNumberMatchPair, initialState, isNumberMatchPair, nextTetrisShape, publicState, scoreTetrisLock };
