const { BoardRuleError } = require('../../../../games/contracts');
const { isTrustedSystemAction } = require('../../../../games/trustedSystemActions');

const KEY = 'go';
const RULES_VERSION = '1';
const SIZE = 9;
const KOMI = 7.5;
const COLORS = ['black', 'white'];

function reject(code, message) {
  throw new BoardRuleError(code, message);
}

function other(color) { return color === 'black' ? 'white' : 'black'; }
function keyOf(x, y) { return `${x},${y}`; }
function parseKey(key) { return key.split(',').map(Number); }
function emptyBoard() { return Array.from({ length: SIZE }, () => Array(SIZE).fill(null)); }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function boardHash(board) { return board.map((row) => row.map((cell) => cell === 'black' ? 'b' : cell === 'white' ? 'w' : '.').join('')).join('/'); }
function inBounds(x, y) { return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < SIZE && y >= 0 && y < SIZE; }
function neighbors(x, y) {
  return [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]].filter(([nx, ny]) => inBounds(nx, ny));
}
function requirePlayers(players) {
  if (!Array.isArray(players) || players.length !== 2 || players.some((id) => typeof id !== 'string' || !id.trim()) || new Set(players).size !== 2) {
    reject('INVALID_ACTION', '圍棋需要兩位不同玩家。');
  }
  return [...players];
}
function requireCoordinate(value) {
  const x = value?.x;
  const y = value?.y;
  if (!inBounds(x, y)) reject('INVALID_ACTION', '座標必須是棋盤內的整數。');
  return { x, y };
}
function groupAt(board, x, y) {
  const color = board[y][x];
  if (!color) return { color: null, stones: [], liberties: new Set() };
  const pending = [[x, y]];
  const seen = new Set();
  const stones = [];
  const liberties = new Set();
  while (pending.length) {
    const [cx, cy] = pending.pop();
    const currentKey = keyOf(cx, cy);
    if (seen.has(currentKey)) continue;
    seen.add(currentKey);
    stones.push([cx, cy]);
    for (const [nx, ny] of neighbors(cx, cy)) {
      if (board[ny][nx] === null) liberties.add(keyOf(nx, ny));
      else if (board[ny][nx] === color && !seen.has(keyOf(nx, ny))) pending.push([nx, ny]);
    }
  }
  return { color, stones, liberties };
}
function normalizeDeadSelection(board, coordinates) {
  if (!Array.isArray(coordinates)) reject('INVALID_ACTION', '死子提案必須是座標陣列。');
  const selected = new Set();
  for (const point of coordinates) {
    const { x, y } = requireCoordinate(point);
    if (!board[y][x]) reject('ACTION_NOT_LEGAL', '只能選擇現有棋子作為死子。');
    for (const [gx, gy] of groupAt(board, x, y).stones) selected.add(keyOf(gx, gy));
  }
  return [...selected].sort();
}
function sameSet(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function outcomeForResignation(state, actorId) {
  const winnerId = state.players.find((id) => id !== actorId);
  return { terminal: true, type: 'win', winnerIds: [winnerId], loserIds: [actorId], reason: 'resignation' };
}
function scoreBoard(board, deadKeys) {
  const scoringBoard = board.map((row) => [...row]);
  for (const key of deadKeys) {
    const [x, y] = parseKey(key);
    scoringBoard[y][x] = null;
  }
  const stones = { black: 0, white: 0 };
  const territory = { black: 0, white: 0 };
  const visited = new Set();
  for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) {
    if (scoringBoard[y][x] === 'black' || scoringBoard[y][x] === 'white') {
      stones[scoringBoard[y][x]] += 1;
      continue;
    }
    if (visited.has(keyOf(x, y))) continue;
    const pending = [[x, y]];
    const area = [];
    const borders = new Set();
    while (pending.length) {
      const [cx, cy] = pending.pop();
      const currentKey = keyOf(cx, cy);
      if (visited.has(currentKey)) continue;
      visited.add(currentKey);
      area.push([cx, cy]);
      for (const [nx, ny] of neighbors(cx, cy)) {
        const occupant = scoringBoard[ny][nx];
        if (occupant === null && !visited.has(keyOf(nx, ny))) pending.push([nx, ny]);
        else if (occupant) borders.add(occupant);
      }
    }
    if (borders.size === 1) territory[[...borders][0]] += area.length;
  }
  const totals = { black: stones.black + territory.black, white: stones.white + territory.white + KOMI };
  return { stones, territory, totals };
}
function finishScoring(state) {
  const dead = state.deadProposal.black;
  const score = scoreBoard(state.board, dead);
  const blackId = state.players[0];
  const whiteId = state.players[1];
  const outcome = score.totals.black === score.totals.white
    ? { terminal: true, type: 'draw', winnerIds: [], loserIds: [], reason: 'area-score-tie' }
    : score.totals.black > score.totals.white
      ? { terminal: true, type: 'win', winnerIds: [blackId], loserIds: [whiteId], reason: 'area-score' }
      : { terminal: true, type: 'win', winnerIds: [whiteId], loserIds: [blackId], reason: 'area-score' };
  return { ...state, phase: 'finished', turn: null, outcome, score };
}
function assertState(state) {
  if (!state || state.gameKey !== KEY || state.rulesVersion !== RULES_VERSION || !Array.isArray(state.board) || state.board.length !== SIZE) {
    reject('INVALID_ACTION', '圍棋狀態無效。');
  }
  return state;
}
function playerColor(state, actorId) { return state.players[0] === actorId ? 'black' : state.players[1] === actorId ? 'white' : null; }
function assertParticipant(state, actorId) { if (!playerColor(state, actorId)) reject('ACTION_NOT_LEGAL', '只有對局玩家可以操作。'); }
function assertLive(state) { if (state.outcome) reject('ACTION_NOT_LEGAL', '本局已結束。'); }
function event(type, extra = {}) { return { type, ...extra }; }

function normalizeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) reject('INVALID_ACTION', '規則選項無效。');
  return { size: SIZE, komi: KOMI, scoring: 'chinese-area', superko: 'positional' };
}

function createInitialState({ players, rules, seed }) {
  const normalizedPlayers = requirePlayers(players);
  const normalizedRules = normalizeOptions(rules);
  if (typeof seed !== 'string' || !seed.trim()) reject('INVALID_ACTION', 'seed 無效。');
  const board = emptyBoard();
  return {
    gameKey: KEY, rulesVersion: RULES_VERSION, players: normalizedPlayers, rules: normalizedRules, seed,
    board, phase: 'play', turn: { playerId: normalizedPlayers[0], phase: 'play' }, currentColor: 'black',
    consecutivePasses: 0, positionHistory: [boardHash(board)], captures: { black: 0, white: 0 },
    deadProposal: { black: [], white: [] }, deadConfirmed: { black: false, white: false }, score: null, outcome: null,
  };
}

function applyAction(inputState, action, context) {
  const state = clone(assertState(inputState));
  const actorId = context?.actorId;
  assertParticipant(state, actorId);
  assertLive(state);
  if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string') reject('INVALID_ACTION', '動作無效。');
  const color = playerColor(state, actorId);
  if (action.type === 'player-retired' || action.type === 'resign') {
    if (action.type === 'player-retired' && !isTrustedSystemAction(action, 'player-retired')) reject('INVALID_ACTION', '退賽動作只能由棋盤核心建立。');
    if (action.type === 'player-retired' && action.playerId !== actorId) reject('ACTION_NOT_LEGAL', '只能代自己認輸。');
    const outcome = outcomeForResignation(state, actorId);
    return { state: { ...state, phase: 'finished', turn: null, outcome }, outcome, events: [event('resigned', { playerId: actorId })], progressed: true };
  }
  if (state.phase === 'play') {
    if (state.turn?.playerId !== actorId) reject('NOT_YOUR_TURN', '尚未輪到你落子。');
    if (action.type === 'move') {
      const { x, y } = requireCoordinate(action);
      if (state.board[y][x] !== null) reject('ACTION_NOT_LEGAL', '此處已有棋子。');
      const board = state.board.map((row) => [...row]);
      board[y][x] = color;
      let captured = 0;
      for (const [nx, ny] of neighbors(x, y)) {
        if (board[ny][nx] !== other(color)) continue;
        const group = groupAt(board, nx, ny);
        if (group.liberties.size === 0) {
          for (const [gx, gy] of group.stones) board[gy][gx] = null;
          captured += group.stones.length;
        }
      }
      if (groupAt(board, x, y).liberties.size === 0) reject('ACTION_NOT_LEGAL', '禁止自殺。');
      const nextHash = boardHash(board);
      if (state.positionHistory.includes(nextHash)) reject('ACTION_NOT_LEGAL', '此手違反全局局面超劫。');
      const nextColor = other(color);
      const next = { ...state, board, currentColor: nextColor, turn: { playerId: state.players[nextColor === 'black' ? 0 : 1], phase: 'play' }, consecutivePasses: 0,
        positionHistory: [...state.positionHistory, nextHash], captures: { ...state.captures, [color]: state.captures[color] + captured } };
      return { state: next, outcome: null, events: [event('stone-played', { playerId: actorId, color, x, y, captured })], progressed: true };
    }
    if (action.type === 'pass') {
      const passes = state.consecutivePasses + 1;
      const nextColor = other(color);
      const next = passes >= 2
        ? { ...state, phase: 'scoring', turn: null, currentColor: nextColor, consecutivePasses: passes, deadProposal: { black: [], white: [] }, deadConfirmed: { black: false, white: false } }
        : { ...state, currentColor: nextColor, consecutivePasses: passes, turn: { playerId: state.players[nextColor === 'black' ? 0 : 1], phase: 'play' } };
      return { state: next, outcome: null, events: [event(passes >= 2 ? 'scoring-started' : 'passed', { playerId: actorId })], progressed: true };
    }
    reject('INVALID_ACTION', '此階段不支援該動作。');
  }
  if (state.phase !== 'scoring') reject('ACTION_NOT_LEGAL', '本局已結束。');
  if (action.type === 'resume-play') {
    const next = { ...state, phase: 'play', turn: { playerId: state.players[state.currentColor === 'black' ? 0 : 1], phase: 'play' }, consecutivePasses: 0,
      deadProposal: { black: [], white: [] }, deadConfirmed: { black: false, white: false } };
    return { state: next, outcome: null, events: [event('play-resumed', { playerId: actorId })], progressed: true };
  }
  if (action.type === 'propose-dead') {
    const proposal = normalizeDeadSelection(state.board, action.coordinates);
    const next = { ...state, deadProposal: { ...state.deadProposal, [color]: proposal }, deadConfirmed: { black: false, white: false } };
    return { state: next, outcome: null, events: [event('dead-stones-proposed', { playerId: actorId, count: proposal.length })], progressed: true };
  }
  if (action.type === 'confirm-dead') {
    const own = state.deadProposal[color];
    const opponent = state.deadProposal[other(color)];
    if (!sameSet(own, opponent)) reject('ACTION_NOT_LEGAL', '雙方必須先提出完全相同的死子集合。');
    const confirmed = { ...state.deadConfirmed, [color]: true };
    const next = { ...state, deadConfirmed: confirmed };
    if (confirmed.black && confirmed.white) {
      const finished = finishScoring(next);
      return { state: finished, outcome: finished.outcome, events: [event('scoring-confirmed')], progressed: true };
    }
    return { state: next, outcome: null, events: [event('scoring-confirmed-by-player', { playerId: actorId })], progressed: true };
  }
  reject('INVALID_ACTION', '計分階段不支援該動作。');
}

function getLegalActions(state, viewerContext = {}) {
  assertState(state);
  if (state.outcome || !viewerContext.isActivePlayer) return [];
  const color = playerColor(state, viewerContext.viewerId);
  if (!color) return [];
  if (state.phase === 'scoring') return [{ type: 'propose-dead' }, { type: 'confirm-dead' }, { type: 'resume-play' }, { type: 'resign' }];
  if (state.turn?.playerId !== viewerContext.viewerId) return [];
  return [{ type: 'move' }, { type: 'pass' }, { type: 'resign' }];
}

function getPublicView(state) {
  assertState(state);
  const pieces = [];
  for (let y = 0; y < SIZE; y += 1) for (let x = 0; x < SIZE; x += 1) {
    const color = state.board[y][x];
    if (color) pieces.push({ id: `stone-${x}-${y}`, ownerId: state.players[color === 'black' ? 0 : 1], position: { x, y }, symbol: color === 'black' ? '●' : '○' });
  }
  const prompts = state.outcome ? [{ type: 'result', text: '本局圍棋已結束。' }]
    : state.phase === 'scoring' ? [{ type: 'scoring', text: '雙方請提出相同的完整死子集合後確認；有爭議可恢復落子。' }]
      : [{ type: 'turn', text: `${state.currentColor === 'black' ? '黑方' : '白方'}落子，可選擇停一手。` }];
  return { gameKey: KEY, rulesVersion: RULES_VERSION, board: { kind: 'grid', width: SIZE, height: SIZE,
    points: Array.from({ length: SIZE * SIZE }, (_, index) => ({ id: `p-${index % SIZE}-${Math.floor(index / SIZE)}`, x: index % SIZE, y: Math.floor(index / SIZE) })), pieces },
    turn: state.turn, prompts, outcome: state.outcome,
    captures: { ...state.captures }, phase: state.phase, komi: KOMI,
    scoring: state.phase === 'scoring' ? { proposedDead: { black: [...state.deadProposal.black], white: [...state.deadProposal.white] }, confirmed: { ...state.deadConfirmed } } : null,
    score: state.score,
  };
}

module.exports = { key: KEY, rulesVersion: RULES_VERSION, minPlayers: 2, maxPlayers: 2, allowedPlayerCounts: [2], normalizeOptions, createInitialState, applyAction, getPublicView, getLegalActions };
