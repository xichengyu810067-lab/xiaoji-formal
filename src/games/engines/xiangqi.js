const { BoardRuleError } = require('../contracts');
const { isTrustedSystemAction } = require('../trustedSystemActions');

const KEY = 'xiangqi';
const RULES_VERSION = '1';
const WIDTH = 9;
const HEIGHT = 10;
const COLORS = ['red', 'black'];
const PIECES = ['general', 'advisor', 'elephant', 'horse', 'rook', 'cannon', 'soldier'];
const SYMBOLS = Object.freeze({
  red: { general: '帥', advisor: '仕', elephant: '相', horse: '馬', rook: '車', cannon: '炮', soldier: '兵' },
  black: { general: '將', advisor: '士', elephant: '象', horse: '馬', rook: '車', cannon: '炮', soldier: '卒' },
});

function reject(code, message) { throw new BoardRuleError(code, message); }
function other(color) { return color === 'red' ? 'black' : 'red'; }
function clone(value) { return JSON.parse(JSON.stringify(value)); }
function inside(x, y) { return Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT; }
function keyOf(x, y) { return `${x},${y}`; }
function inPalace(color, x, y) { return x >= 3 && x <= 5 && (color === 'red' ? y >= 7 && y <= 9 : y >= 0 && y <= 2); }
function crossedRiver(color, y) { return color === 'red' ? y <= 4 : y >= 5; }
function boardHash(board, turn) {
  return `${board.map((row) => row.map((piece) => piece ? `${piece.color[0]}${piece.type[0]}` : '--').join(',')).join('/')}|${turn}`;
}
function emptyBoard() { return Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null)); }
function place(board, x, y, color, type) { board[y][x] = { color, type }; }
function initialBoard() {
  const board = emptyBoard();
  const back = ['rook', 'horse', 'elephant', 'advisor', 'general', 'advisor', 'elephant', 'horse', 'rook'];
  back.forEach((type, x) => { place(board, x, 0, 'black', type); place(board, x, 9, 'red', type); });
  place(board, 1, 2, 'black', 'cannon'); place(board, 7, 2, 'black', 'cannon');
  place(board, 1, 7, 'red', 'cannon'); place(board, 7, 7, 'red', 'cannon');
  [0, 2, 4, 6, 8].forEach((x) => { place(board, x, 3, 'black', 'soldier'); place(board, x, 6, 'red', 'soldier'); });
  return board;
}
function requirePlayers(players) {
  if (!Array.isArray(players) || players.length !== 2 || players.some((id) => typeof id !== 'string' || !id.trim()) || new Set(players).size !== 2) reject('INVALID_ACTION', '象棋需要兩位不同玩家。');
  return [...players];
}
function requirePoint(point, label) {
  if (!point || typeof point !== 'object' || Array.isArray(point) || !inside(point.x, point.y)) reject('INVALID_ACTION', `${label} 必須是棋盤內的整數座標。`);
  return { x: point.x, y: point.y };
}
function playerColor(state, actorId) { return state.players[0] === actorId ? 'red' : state.players[1] === actorId ? 'black' : null; }
function requireParticipant(state, actorId) { if (!playerColor(state, actorId)) reject('ACTION_NOT_LEGAL', '只有對局玩家可以操作。'); }
function requireState(state) {
  if (!state || state.gameKey !== KEY || state.rulesVersion !== RULES_VERSION || !Array.isArray(state.board) || state.board.length !== HEIGHT || state.board.some((row) => !Array.isArray(row) || row.length !== WIDTH)) reject('INVALID_ACTION', '象棋狀態無效。');
  return state;
}
function clearLine(board, from, to) {
  const dx = Math.sign(to.x - from.x); const dy = Math.sign(to.y - from.y);
  let x = from.x + dx; let y = from.y + dy; let count = 0;
  while (x !== to.x || y !== to.y) { if (board[y][x]) count += 1; x += dx; y += dy; }
  return count;
}
function generalPosition(board, color) {
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    const piece = board[y][x]; if (piece?.color === color && piece.type === 'general') return { x, y };
  }
  return null;
}
function canReach(board, from, to, piece) {
  const dx = to.x - from.x; const dy = to.y - from.y; const ax = Math.abs(dx); const ay = Math.abs(dy);
  if (!inside(to.x, to.y) || (dx === 0 && dy === 0)) return false;
  switch (piece.type) {
    case 'general': {
      if (inPalace(piece.color, to.x, to.y) && ax + ay === 1) return true;
      const target = board[to.y][to.x];
      return target?.type === 'general' && target.color !== piece.color && from.x === to.x && clearLine(board, from, to) === 0;
    }
    case 'advisor': return inPalace(piece.color, to.x, to.y) && ax === 1 && ay === 1;
    case 'elephant': {
      if (ax !== 2 || ay !== 2 || (piece.color === 'red' ? to.y < 5 : to.y > 4)) return false;
      return !board[from.y + dy / 2][from.x + dx / 2];
    }
    case 'horse': {
      if (!((ax === 1 && ay === 2) || (ax === 2 && ay === 1))) return false;
      return ax === 2 ? !board[from.y][from.x + dx / 2] : !board[from.y + dy / 2][from.x];
    }
    case 'rook': return (dx === 0 || dy === 0) && clearLine(board, from, to) === 0;
    case 'cannon': {
      if (dx !== 0 && dy !== 0) return false;
      const screens = clearLine(board, from, to);
      return board[to.y][to.x] ? screens === 1 : screens === 0;
    }
    case 'soldier': {
      const forward = piece.color === 'red' ? -1 : 1;
      return dy === forward && dx === 0 || crossedRiver(piece.color, from.y) && dy === 0 && ax === 1;
    }
    default: return false;
  }
}
function attackedBy(board, square, attackerColor) {
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    const piece = board[y][x];
    if (piece?.color === attackerColor && canReach(board, { x, y }, square, piece)) return true;
  }
  return false;
}
function isInCheck(board, color) {
  const general = generalPosition(board, color);
  return !general || attackedBy(board, general, other(color));
}
function moveBoard(board, from, to) {
  const next = board.map((row) => row.map((piece) => piece ? { ...piece } : null));
  next[to.y][to.x] = next[from.y][from.x];
  next[from.y][from.x] = null;
  return next;
}
function validMove(board, from, to, color) {
  const piece = board[from.y][from.x];
  const target = board[to.y][to.x];
  if (!piece || piece.color !== color || target?.color === color || target?.type === 'general') return false;
  if (!canReach(board, from, to, piece)) return false;
  return !isInCheck(moveBoard(board, from, to), color);
}
function allLegalMoves(board, color) {
  const moves = [];
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    if (board[y][x]?.color !== color) continue;
    for (let ty = 0; ty < HEIGHT; ty += 1) for (let tx = 0; tx < WIDTH; tx += 1) {
      if (validMove(board, { x, y }, { x: tx, y: ty }, color)) moves.push({ from: { x, y }, to: { x: tx, y: ty } });
    }
  }
  return moves;
}
function completed(state, outcome) { return { ...state, phase: 'finished', turn: null, drawOfferBy: null, outcome }; }
function event(type, extra = {}) { return { type, ...extra }; }
function terminalAfterMove(state, board, moverColor) {
  const nextColor = other(moverColor);
  const nextPlayer = state.players[nextColor === 'red' ? 0 : 1];
  const hash = boardHash(board, nextColor);
  const history = [...state.positionHistory, hash];
  const repeated = history.filter((entry) => entry === hash).length;
  let next = { ...state, board, currentColor: nextColor, turn: { playerId: nextPlayer, phase: 'play' }, positionHistory: history, drawOfferBy: null };
  if (repeated >= 3) {
    const outcome = { terminal: true, type: 'draw', winnerIds: [], loserIds: [], reason: 'threefold-repetition' };
    return { state: completed(next, outcome), outcome };
  }
  const replies = allLegalMoves(board, nextColor);
  if (replies.length === 0) {
    const winnerId = state.players[moverColor === 'red' ? 0 : 1];
    const loserId = state.players[nextColor === 'red' ? 0 : 1];
    const outcome = { terminal: true, type: 'win', winnerIds: [winnerId], loserIds: [loserId], reason: isInCheck(board, nextColor) ? 'checkmate' : 'stalemate' };
    return { state: completed(next, outcome), outcome };
  }
  return { state: next, outcome: null };
}

function normalizeOptions(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) reject('INVALID_ACTION', '規則選項無效。');
  return { repetition: 3, longCheckAdjudication: 'not-supported' };
}
function createInitialState({ players, rules, seed }) {
  const normalizedPlayers = requirePlayers(players); const normalizedRules = normalizeOptions(rules);
  if (typeof seed !== 'string' || !seed.trim()) reject('INVALID_ACTION', 'seed 無效。');
  const board = initialBoard();
  return { gameKey: KEY, rulesVersion: RULES_VERSION, players: normalizedPlayers, rules: normalizedRules, seed, board,
    phase: 'play', currentColor: 'red', turn: { playerId: normalizedPlayers[0], phase: 'play' }, positionHistory: [boardHash(board, 'red')], drawOfferBy: null, outcome: null };
}
function applyAction(inputState, action, context) {
  const state = clone(requireState(inputState)); const actorId = context?.actorId; requireParticipant(state, actorId);
  if (state.outcome) reject('ACTION_NOT_LEGAL', '本局已結束。');
  if (!action || typeof action !== 'object' || Array.isArray(action) || typeof action.type !== 'string') reject('INVALID_ACTION', '動作無效。');
  const color = playerColor(state, actorId);
  if (action.type === 'player-retired' || action.type === 'resign') {
    if (action.type === 'player-retired' && !isTrustedSystemAction(action, 'player-retired')) reject('INVALID_ACTION', '退賽動作只能由棋盤核心建立。');
    if (action.type === 'player-retired' && action.playerId !== actorId) reject('ACTION_NOT_LEGAL', '只能代自己認輸。');
    const opponentId = state.players[color === 'red' ? 1 : 0];
    const outcome = { terminal: true, type: 'win', winnerIds: [opponentId], loserIds: [actorId], reason: 'resignation' };
    return { state: completed(state, outcome), outcome, events: [event('resigned', { playerId: actorId })], progressed: true };
  }
  if (action.type === 'offer-draw') {
    if (state.drawOfferBy === actorId) reject('ACTION_NOT_LEGAL', '你已提出和棋。');
    return { state: { ...state, drawOfferBy: actorId }, outcome: null, events: [event('draw-offered', { playerId: actorId })], progressed: true };
  }
  if (action.type === 'decline-draw') {
    if (!state.drawOfferBy || state.drawOfferBy === actorId) reject('ACTION_NOT_LEGAL', '沒有可拒絕的對手和棋邀請。');
    return { state: { ...state, drawOfferBy: null }, outcome: null, events: [event('draw-declined', { playerId: actorId })], progressed: true };
  }
  if (action.type === 'accept-draw') {
    if (!state.drawOfferBy || state.drawOfferBy === actorId) reject('ACTION_NOT_LEGAL', '沒有可接受的對手和棋邀請。');
    const outcome = { terminal: true, type: 'draw', winnerIds: [], loserIds: [], reason: 'agreed-draw' };
    return { state: completed(state, outcome), outcome, events: [event('draw-agreed')], progressed: true };
  }
  if (action.type !== 'move') reject('INVALID_ACTION', '不支援的象棋動作。');
  if (state.turn?.playerId !== actorId) reject('NOT_YOUR_TURN', '尚未輪到你走棋。');
  const from = requirePoint(action.from, '起點'); const to = requirePoint(action.to, '終點');
  if (!validMove(state.board, from, to, color)) reject('ACTION_NOT_LEGAL', '此棋步不合法，或會讓己方將帥受攻擊。');
  const captured = state.board[to.y][to.x];
  const result = terminalAfterMove(state, moveBoard(state.board, from, to), color);
  return { state: result.state, outcome: result.outcome, events: [event('piece-moved', { playerId: actorId, from, to, captured: captured?.type || null })], progressed: true };
}
function getLegalActions(state, viewerContext = {}) {
  requireState(state);
  if (state.outcome || !viewerContext.isActivePlayer || !playerColor(state, viewerContext.viewerId)) return [];
  const actions = [{ type: 'offer-draw' }, { type: 'resign' }];
  if (state.drawOfferBy && state.drawOfferBy !== viewerContext.viewerId) actions.push({ type: 'accept-draw' }, { type: 'decline-draw' });
  if (state.turn?.playerId === viewerContext.viewerId) actions.unshift(...allLegalMoves(state.board, playerColor(state, viewerContext.viewerId)).map((move) => ({ type: 'move', ...move })));
  return actions;
}
function getPublicView(state) {
  requireState(state);
  const pieces = [];
  for (let y = 0; y < HEIGHT; y += 1) for (let x = 0; x < WIDTH; x += 1) {
    const piece = state.board[y][x];
    if (piece) pieces.push({ id: `${piece.color}-${piece.type}-${x}-${y}`, ownerId: state.players[piece.color === 'red' ? 0 : 1], position: { x, y }, symbol: SYMBOLS[piece.color][piece.type] });
  }
  const prompts = state.outcome ? [{ type: 'result', text: '本局象棋已結束。' }]
    : [{ type: 'turn', text: `${state.currentColor === 'red' ? '紅方' : '黑方'}行棋；本版採三次重複和棋，不裁判長將長捉。` }];
  if (state.drawOfferBy) prompts.push({ type: 'draw-offer', text: '對手已提出和棋邀請。' });
  return { gameKey: KEY, rulesVersion: RULES_VERSION, board: { kind: 'grid', width: WIDTH, height: HEIGHT,
    points: Array.from({ length: WIDTH * HEIGHT }, (_, index) => ({ id: `p-${index % WIDTH}-${Math.floor(index / WIDTH)}`, x: index % WIDTH, y: Math.floor(index / WIDTH) })), pieces },
    turn: state.turn, prompts, outcome: state.outcome, phase: state.phase, drawOfferBy: state.drawOfferBy,
    boardHints: { riverBetweenRows: [4, 5], palaces: [{ color: 'black', x: 3, y: 0, width: 3, height: 3 }, { color: 'red', x: 3, y: 7, width: 3, height: 3 }] },
  };
}

module.exports = { key: KEY, rulesVersion: RULES_VERSION, minPlayers: 2, maxPlayers: 2, allowedPlayerCounts: [2], normalizeOptions, createInitialState, applyAction, getPublicView, getLegalActions };
