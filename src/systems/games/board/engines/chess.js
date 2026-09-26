const { Chess } = require('chess.js');
const { BoardRuleError } = require('../../../../games/contracts');
const { isTrustedSystemAction } = require('../../../../games/trustedSystemActions');

const RULES_VERSION = '1.0.0';
const FILES = 'abcdefgh';
const PIECE_SYMBOLS = Object.freeze({
  w: Object.freeze({ p: '♙', n: '♘', b: '♗', r: '♖', q: '♕', k: '♔' }),
  b: Object.freeze({ p: '♟', n: '♞', b: '♝', r: '♜', q: '♛', k: '♚' }),
});

function ruleError(code, message) {
  throw new BoardRuleError(code, message);
}

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function isIdentifier(value) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 128;
}

function assertPlayers(players) {
  if (!Array.isArray(players) || players.length !== 2 || players.some((player) => !isIdentifier(player)) ||
      new Set(players).size !== 2) {
    ruleError('INVALID_ACTION', 'Chess requires two distinct players.');
  }
  return [...players];
}

function assertRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).length !== 0) {
    ruleError('INVALID_ACTION', 'Chess does not accept custom rules.');
  }
}

function requirePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    ruleError('INVALID_ACTION', 'Action must be an object.');
  }
  return value;
}

function assertOnlyKeys(value, keys) {
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    ruleError('INVALID_ACTION', 'Action contains unsupported fields.');
  }
}

function validateMove(move) {
  requirePlainObject(move);
  assertOnlyKeys(move, ['from', 'to', 'promotion']);
  if (typeof move.from !== 'string' || !/^[a-h][1-8]$/.test(move.from) ||
      typeof move.to !== 'string' || !/^[a-h][1-8]$/.test(move.to) ||
      (move.promotion != null && !['q', 'r', 'b', 'n'].includes(move.promotion))) {
    ruleError('INVALID_ACTION', 'Chess move coordinates are invalid.');
  }
  return move.promotion == null
    ? { from: move.from, to: move.to }
    : { from: move.from, to: move.to, promotion: move.promotion };
}

function repetitionKey(chess) {
  const [placement, turn, castling, enPassant] = chess.fen().split(' ');
  const hasLegalEnPassant = chess.moves({ verbose: true }).some((move) => move.flags.includes('e'));
  return `${placement} ${turn} ${castling} ${hasLegalEnPassant ? enPassant : '-'}`;
}

function reconstruct(state) {
  if (!state || state.gameKey !== 'chess' || state.rulesVersion !== RULES_VERSION ||
      !Array.isArray(state.players) || !Array.isArray(state.moveHistory) || !Array.isArray(state.positionHistory)) {
    ruleError('INVALID_ACTION', 'Chess state is invalid.');
  }
  const chess = new Chess();
  for (const move of state.moveHistory) {
    const normalized = validateMove(move);
    try {
      chess.move(normalized);
    } catch {
      ruleError('INVALID_ACTION', 'Chess move history is invalid.');
    }
  }
  if (state.fen !== chess.fen() || state.positionHistory.length !== state.moveHistory.length + 1 ||
      state.positionHistory[state.positionHistory.length - 1] !== repetitionKey(chess)) {
    ruleError('INVALID_ACTION', 'Chess state cannot be reconstructed.');
  }
  return chess;
}

function assertContext(state, context, { requireTurn = false } = {}) {
  if (!context || typeof context !== 'object' || !isIdentifier(context.actorId) ||
      !Array.isArray(context.players) || context.players.length !== 2 ||
      context.players.some((player, index) => player !== state.players[index]) ||
      !Array.isArray(context.activePlayers) || !Array.isArray(context.retiredPlayers) ||
      context.activePlayers.length !== 2 || context.retiredPlayers.length !== 0 ||
      context.activePlayers.some((player, index) => player !== state.players[index])) {
    ruleError('INVALID_ACTION', 'Chess context is invalid.');
  }
  if (!state.players.includes(context.actorId)) ruleError('ACTION_NOT_LEGAL', 'Only players may act in this game.');
  if (state.outcome) ruleError('ACTION_NOT_LEGAL', 'This game has already ended.');
  if (requireTurn && context.actorId !== state.players[reconstruct(state).turn() === 'w' ? 0 : 1]) {
    ruleError('NOT_YOUR_TURN', 'It is not your turn.');
  }
}

function makeOutcome(type, winnerIds, loserIds, reason) {
  return { terminal: true, type, winnerIds, loserIds, reason };
}

function terminalOutcome(chess, state) {
  const nextPlayer = state.players[chess.turn() === 'w' ? 0 : 1];
  const previousPlayer = state.players[chess.turn() === 'w' ? 1 : 0];
  if (chess.isCheckmate()) return makeOutcome('win', [previousPlayer], [nextPlayer], 'checkmate');
  if (chess.isStalemate()) return makeOutcome('draw', [], [], 'stalemate');
  if (chess.isInsufficientMaterial()) return makeOutcome('draw', [], [], 'insufficient-material');

  const latestKey = state.positionHistory[state.positionHistory.length - 1];
  const repetitions = state.positionHistory.filter((key) => key === latestKey).length;
  if (repetitions >= 5) return makeOutcome('draw', [], [], 'fivefold-repetition');
  const halfmoveClock = Number(chess.fen().split(' ')[4]);
  if (halfmoveClock >= 150) return makeOutcome('draw', [], [], 'seventy-five-move-rule');
  return null;
}

function drawClaimAvailable(chess, state) {
  const currentKey = repetitionKey(chess);
  const repetitions = state.positionHistory.filter((key) => key === currentKey).length;
  const halfmoveClock = Number(chess.fen().split(' ')[4]);
  if (repetitions >= 3) return 'threefold-repetition';
  if (halfmoveClock >= 100) return 'fifty-move-rule';
  return null;
}

function plannedDrawClaim(chess, state, move) {
  const normalizedMove = validateMove(move);
  const planned = new Chess(chess.fen());
  try {
    planned.move(normalizedMove);
  } catch {
    ruleError('ACTION_NOT_LEGAL', 'That chess move is not legal.');
  }
  const nextKey = repetitionKey(planned);
  const repetitions = state.positionHistory.filter((key) => key === nextKey).length + 1;
  const halfmoveClock = Number(planned.fen().split(' ')[4]);
  if (repetitions >= 3) return 'threefold-repetition';
  if (halfmoveClock >= 100) return 'fifty-move-rule';
  return null;
}

function nextState(state, chess, patch = {}) {
  return {
    ...copy(state),
    ...patch,
    fen: chess.fen(),
  };
}

function turnFor(chess, players) {
  return { playerId: players[chess.turn() === 'w' ? 0 : 1], phase: 'move' };
}

function normalizeOptions(options = {}) {
  assertRules(options);
  return {};
}

function createInitialState({ players, rules, seed }) {
  const normalizedPlayers = assertPlayers(players);
  assertRules(rules);
  if (typeof seed !== 'string' || !seed) ruleError('INVALID_ACTION', 'Chess seed is invalid.');
  const chess = new Chess();
  return {
    gameKey: 'chess',
    rulesVersion: RULES_VERSION,
    players: normalizedPlayers,
    seed,
    fen: chess.fen(),
    moveHistory: [],
    positionHistory: [repetitionKey(chess)],
    drawOfferFrom: null,
    turn: turnFor(chess, normalizedPlayers),
    outcome: null,
  };
}

function applyAction(state, action, context) {
  const chess = reconstruct(state);
  const input = requirePlainObject(action);
  if (typeof input.type !== 'string') ruleError('INVALID_ACTION', 'Chess action type is invalid.');

  if (input.type === 'accept-draw') {
    assertOnlyKeys(input, ['type']);
    assertContext(state, context);
    if (!state.drawOfferFrom || state.drawOfferFrom === context.actorId) {
      ruleError('ACTION_NOT_LEGAL', 'There is no opponent draw offer to accept.');
    }
    const outcome = makeOutcome('draw', [], [], 'agreed-draw');
    const next = nextState(state, chess, { drawOfferFrom: null, turn: null, outcome });
    return { state: next, outcome, events: [{ type: 'draw-agreed', playerId: context.actorId }], progressed: true };
  }

  if (input.type === 'resign' || input.type === 'player-retired') {
    assertOnlyKeys(input, input.type === 'resign' ? ['type'] : ['type', 'playerId']);
    assertContext(state, context);
    if (input.type === 'player-retired' && !isTrustedSystemAction(input, 'player-retired')) {
      ruleError('INVALID_ACTION', 'Player retirement must come from the board session service.');
    }
    if (input.type === 'player-retired' && input.playerId !== context.actorId) {
      ruleError('ACTION_NOT_LEGAL', 'A player may only retire themselves.');
    }
    const winnerId = state.players.find((player) => player !== context.actorId);
    const outcome = makeOutcome('win', [winnerId], [context.actorId], 'resignation');
    const next = nextState(state, chess, { drawOfferFrom: null, turn: null, outcome });
    return { state: next, outcome, events: [{ type: 'resigned', playerId: context.actorId }], progressed: true };
  }

  if (input.type === 'offer-draw') {
    assertOnlyKeys(input, ['type']);
    assertContext(state, context, { requireTurn: true });
    if (state.drawOfferFrom) ruleError('ACTION_NOT_LEGAL', 'A draw offer is already pending.');
    const next = nextState(state, chess, { drawOfferFrom: context.actorId });
    return { state: next, outcome: null, events: [{ type: 'draw-offered', playerId: context.actorId }], progressed: true };
  }

  if (input.type === 'claim-draw') {
    assertOnlyKeys(input, ['type', 'move']);
    assertContext(state, context, { requireTurn: true });
    const reason = drawClaimAvailable(chess, state) || (input.move ? plannedDrawClaim(chess, state, input.move) : null);
    if (!reason) ruleError('CLAIM_NOT_AVAILABLE', 'A draw claim is not available.');
    const outcome = makeOutcome('draw', [], [], reason);
    const next = nextState(state, chess, { drawOfferFrom: null, turn: null, outcome });
    return { state: next, outcome, events: [{ type: 'draw-claimed', playerId: context.actorId, reason }], progressed: true };
  }

  if (input.type !== 'move') ruleError('INVALID_ACTION', 'Chess action type is invalid.');
  assertOnlyKeys(input, ['type', 'from', 'to', 'promotion']);
  assertContext(state, context, { requireTurn: true });
  const move = validateMove({ from: input.from, to: input.to, ...(input.promotion != null ? { promotion: input.promotion } : {}) });
  let applied;
  try {
    applied = chess.move(move);
  } catch {
    ruleError('ACTION_NOT_LEGAL', 'That chess move is not legal.');
  }
  const moveHistory = [...state.moveHistory, move];
  const positionHistory = [...state.positionHistory, repetitionKey(chess)];
  const next = nextState(state, chess, { moveHistory, positionHistory, drawOfferFrom: null, turn: turnFor(chess, state.players) });
  const outcome = terminalOutcome(chess, next);
  if (outcome) {
    next.outcome = outcome;
    next.turn = null;
  }
  return {
    state: next,
    outcome,
    events: [{ type: 'move-made', playerId: context.actorId, from: applied.from, to: applied.to, promotion: applied.promotion || null, san: applied.san }],
    progressed: true,
  };
}

function getPublicView(state) {
  const chess = reconstruct(state);
  const pieces = [];
  for (const row of chess.board()) {
    for (const piece of row) {
      if (!piece) continue;
      const x = FILES.indexOf(piece.square[0]);
      const y = 8 - Number(piece.square[1]);
      pieces.push({
        id: piece.square,
        ownerId: state.players[piece.color === 'w' ? 0 : 1],
        position: { x, y },
        symbol: PIECE_SYMBOLS[piece.color][piece.type],
      });
    }
  }
  const outcome = state.outcome || null;
  const playerId = outcome ? null : state.players[chess.turn() === 'w' ? 0 : 1];
  return {
    gameKey: 'chess',
    rulesVersion: RULES_VERSION,
    board: { kind: 'grid', width: 8, height: 8, points: [], pieces },
    turn: playerId ? { playerId, phase: 'move' } : null,
    prompts: outcome ? [{ type: 'game-ended', text: '對局已結束。' }] : [{ type: 'turn', text: chess.turn() === 'w' ? '輪到白方。' : '輪到黑方。' }],
    outcome,
  };
}

function getLegalActions(state, viewerContext) {
  const chess = reconstruct(state);
  const actorId = viewerContext?.actorId || viewerContext?.viewerId;
  if (!state.players.includes(actorId) || state.outcome) return [];
  const isTurn = actorId === state.players[chess.turn() === 'w' ? 0 : 1];
  const actions = [{ type: 'resign' }];
  if (state.drawOfferFrom && state.drawOfferFrom !== actorId) actions.push({ type: 'accept-draw' });
  if (!isTurn) return actions;
  if (!state.drawOfferFrom) actions.push({ type: 'offer-draw' });
  if (drawClaimAvailable(chess, state)) actions.push({ type: 'claim-draw' });
  for (const move of chess.moves({ verbose: true })) {
    actions.push({ type: 'move', from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion } : {}) });
  }
  return actions;
}

module.exports = {
  key: 'chess',
  rulesVersion: RULES_VERSION,
  minPlayers: 2,
  maxPlayers: 2,
  allowedPlayerCounts: [2],
  normalizeOptions,
  createInitialState,
  applyAction,
  getPublicView,
  getLegalActions,
};
