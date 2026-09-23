const { BoardRuleError } = require('../contracts');
const { isTrustedSystemAction } = require('../trustedSystemActions');

const RULES_VERSION = '1.0.0';
const SIZE = 15;

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
    ruleError('INVALID_ACTION', 'Gomoku requires two distinct players.');
  }
  return [...players];
}

function assertRules(rules) {
  if (!rules || typeof rules !== 'object' || Array.isArray(rules) || Object.keys(rules).length !== 0) {
    ruleError('INVALID_ACTION', 'Gomoku does not accept custom rules.');
  }
}

function requirePlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) ruleError('INVALID_ACTION', 'Action must be an object.');
  return value;
}

function assertOnlyKeys(value, keys) {
  if (Object.keys(value).some((key) => !keys.includes(key))) ruleError('INVALID_ACTION', 'Action contains unsupported fields.');
}

function validateState(state) {
  if (!state || state.gameKey !== 'gomoku' || state.rulesVersion !== RULES_VERSION || !Array.isArray(state.players) ||
      !Array.isArray(state.board) || state.board.length !== SIZE || !Number.isInteger(state.turnIndex) ||
      !Number.isInteger(state.moveCount) || !Array.isArray(state.board) ||
      state.board.some((row) => !Array.isArray(row) || row.length !== SIZE || row.some((cell) => cell !== null && cell !== 'black' && cell !== 'white'))) {
    ruleError('INVALID_ACTION', 'Gomoku state is invalid.');
  }
  assertPlayers(state.players);
  if (state.turnIndex < 0 || state.turnIndex > 1 || state.moveCount < 0 || state.moveCount > SIZE * SIZE) {
    ruleError('INVALID_ACTION', 'Gomoku state is invalid.');
  }
}

function assertContext(state, context, { requireTurn = false } = {}) {
  if (!context || typeof context !== 'object' || !isIdentifier(context.actorId) || !Array.isArray(context.players) ||
      context.players.length !== 2 || context.players.some((player, index) => player !== state.players[index]) ||
      !Array.isArray(context.activePlayers) || !Array.isArray(context.retiredPlayers) || context.activePlayers.length !== 2 ||
      context.retiredPlayers.length !== 0 || context.activePlayers.some((player, index) => player !== state.players[index])) {
    ruleError('INVALID_ACTION', 'Gomoku context is invalid.');
  }
  if (!state.players.includes(context.actorId)) ruleError('ACTION_NOT_LEGAL', 'Only players may act in this game.');
  if (state.outcome) ruleError('ACTION_NOT_LEGAL', 'This game has already ended.');
  if (requireTurn && context.actorId !== state.players[state.turnIndex]) ruleError('NOT_YOUR_TURN', 'It is not your turn.');
}

function makeOutcome(type, winnerIds, loserIds, reason) {
  return { terminal: true, type, winnerIds, loserIds, reason };
}

function normalizeOptions(options = {}) {
  assertRules(options);
  return {};
}

function createInitialState({ players, rules, seed }) {
  const normalizedPlayers = assertPlayers(players);
  assertRules(rules);
  if (typeof seed !== 'string' || !seed) ruleError('INVALID_ACTION', 'Gomoku seed is invalid.');
  return {
    gameKey: 'gomoku',
    rulesVersion: RULES_VERSION,
    players: normalizedPlayers,
    seed,
    board: Array.from({ length: SIZE }, () => Array(SIZE).fill(null)),
    turnIndex: 0,
    moveCount: 0,
    drawOfferFrom: null,
    turn: { playerId: normalizedPlayers[0], phase: 'place' },
    outcome: null,
  };
}

function countDirection(board, x, y, dx, dy, stone) {
  let count = 0;
  for (let nextX = x + dx, nextY = y + dy;
    nextX >= 0 && nextX < SIZE && nextY >= 0 && nextY < SIZE && board[nextY][nextX] === stone;
    nextX += dx, nextY += dy) {
    count += 1;
  }
  return count;
}

function hasFiveOrMore(board, x, y, stone) {
  return [[1, 0], [0, 1], [1, 1], [1, -1]].some(([dx, dy]) =>
    1 + countDirection(board, x, y, dx, dy, stone) + countDirection(board, x, y, -dx, -dy, stone) >= 5);
}

function nextState(state, patch) {
  return { ...copy(state), ...patch };
}

function applyAction(state, action, context) {
  validateState(state);
  const input = requirePlainObject(action);
  if (typeof input.type !== 'string') ruleError('INVALID_ACTION', 'Gomoku action type is invalid.');

  if (input.type === 'accept-draw') {
    assertOnlyKeys(input, ['type']);
    assertContext(state, context);
    if (!state.drawOfferFrom || state.drawOfferFrom === context.actorId) {
      ruleError('ACTION_NOT_LEGAL', 'There is no opponent draw offer to accept.');
    }
    const outcome = makeOutcome('draw', [], [], 'agreed-draw');
    const next = nextState(state, { drawOfferFrom: null, turn: null, outcome });
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
    const next = nextState(state, { drawOfferFrom: null, turn: null, outcome });
    return { state: next, outcome, events: [{ type: 'resigned', playerId: context.actorId }], progressed: true };
  }

  if (input.type === 'offer-draw') {
    assertOnlyKeys(input, ['type']);
    assertContext(state, context, { requireTurn: true });
    if (state.drawOfferFrom) ruleError('ACTION_NOT_LEGAL', 'A draw offer is already pending.');
    const next = nextState(state, { drawOfferFrom: context.actorId });
    return { state: next, outcome: null, events: [{ type: 'draw-offered', playerId: context.actorId }], progressed: true };
  }

  if (input.type !== 'place') ruleError('INVALID_ACTION', 'Gomoku action type is invalid.');
  assertOnlyKeys(input, ['type', 'x', 'y']);
  assertContext(state, context, { requireTurn: true });
  if (!Number.isInteger(input.x) || !Number.isInteger(input.y) || input.x < 0 || input.x >= SIZE || input.y < 0 || input.y >= SIZE) {
    ruleError('INVALID_ACTION', 'Gomoku coordinates are invalid.');
  }
  if (state.board[input.y][input.x] !== null) ruleError('ACTION_NOT_LEGAL', 'That intersection is already occupied.');

  const board = state.board.map((row) => [...row]);
  const stone = state.turnIndex === 0 ? 'black' : 'white';
  board[input.y][input.x] = stone;
  const moveCount = state.moveCount + 1;
  const nextTurnIndex = state.turnIndex === 0 ? 1 : 0;
  const next = nextState(state, {
    board,
    moveCount,
    turnIndex: nextTurnIndex,
    drawOfferFrom: null,
    turn: { playerId: state.players[nextTurnIndex], phase: 'place' },
  });
  let outcome = null;
  if (hasFiveOrMore(board, input.x, input.y, stone)) {
    outcome = makeOutcome('win', [context.actorId], [state.players.find((player) => player !== context.actorId)], 'five-in-a-row');
  } else if (moveCount === SIZE * SIZE) {
    outcome = makeOutcome('draw', [], [], 'board-full');
  }
  if (outcome) {
    next.outcome = outcome;
    next.turn = null;
  }
  return { state: next, outcome, events: [{ type: 'stone-placed', playerId: context.actorId, x: input.x, y: input.y, stone }], progressed: true };
}

function getPublicView(state) {
  validateState(state);
  const pieces = [];
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const stone = state.board[y][x];
      if (!stone) continue;
      pieces.push({ id: `${x},${y}`, ownerId: state.players[stone === 'black' ? 0 : 1], position: { x, y }, symbol: stone === 'black' ? '●' : '○' });
    }
  }
  const outcome = state.outcome || null;
  return {
    gameKey: 'gomoku',
    rulesVersion: RULES_VERSION,
    board: { kind: 'grid', width: SIZE, height: SIZE, points: [], pieces },
    turn: outcome ? null : { playerId: state.players[state.turnIndex], phase: 'place' },
    prompts: outcome ? [{ type: 'game-ended', text: '對局已結束。' }] : [{ type: 'turn', text: state.turnIndex === 0 ? '輪到黑方落子。' : '輪到白方落子。' }],
    outcome,
  };
}

function getLegalActions(state, viewerContext) {
  validateState(state);
  const actorId = viewerContext?.actorId || viewerContext?.viewerId;
  if (!state.players.includes(actorId) || state.outcome) return [];
  const actions = [{ type: 'resign' }];
  if (state.drawOfferFrom && state.drawOfferFrom !== actorId) actions.push({ type: 'accept-draw' });
  if (actorId !== state.players[state.turnIndex]) return actions;
  if (!state.drawOfferFrom) actions.push({ type: 'offer-draw' });
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      if (state.board[y][x] === null) actions.push({ type: 'place', x, y });
    }
  }
  return actions;
}

module.exports = {
  key: 'gomoku',
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
