const { BoardRuleError } = require('../../../../games/contracts');
const { isTrustedSystemAction } = require('../../../../games/trustedSystemActions');
const {
  AXIAL_DIRECTIONS,
  BOARD_POINTS,
  CAMP_ASSIGNMENTS,
  CAMP_BY_ID,
  CAMPS,
  OPPOSITE_CAMP,
  POINT_BY_ID,
  pointId,
} = require('./checkers/board');

const RULES_VERSION = '1.0.0';
const ALLOWED_PLAYER_COUNTS = Object.freeze([2, 3, 4, 6]);
const PLAYER_COLORS = Object.freeze([
  '#d83a3a',
  '#2d78d4',
  '#2f9d57',
  '#d39c19',
  '#8b5bd6',
  '#d5682d',
]);

function ruleError(code, message) {
  throw new BoardRuleError(code, message);
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizeOptions(options = {}) {
  if (!isPlainObject(options) || Object.keys(options).length > 0) {
    ruleError('INVALID_ACTION', 'Chinese checkers does not accept custom rule options.');
  }
  return {};
}

function requirePlayers(players) {
  if (!Array.isArray(players) || !ALLOWED_PLAYER_COUNTS.includes(players.length)) {
    ruleError('INVALID_ACTION', 'Chinese checkers requires exactly 2, 3, 4, or 6 players.');
  }
  const normalized = players.map((player) => String(player || '').trim());
  if (normalized.some((player) => !player) || new Set(normalized).size !== normalized.length) {
    ruleError('INVALID_ACTION', 'Players must be unique non-empty identifiers.');
  }
  return normalized;
}

function campPointSet(campId) {
  const camp = CAMP_BY_ID.get(campId);
  if (!camp) throw new Error(`Unknown Chinese checkers camp ${campId}.`);
  return new Set(camp.pointIds);
}

function createInitialState({ players, rules, seed } = {}) {
  const playerIds = requirePlayers(players);
  normalizeOptions(rules || {});
  if (typeof seed !== 'string' || !seed.trim()) ruleError('INVALID_ACTION', 'A server-generated seed is required.');

  const campIds = CAMP_ASSIGNMENTS[playerIds.length];
  const statePlayers = playerIds.map((id, seat) => ({
    id,
    seat,
    campId: campIds[seat],
    targetCampId: OPPOSITE_CAMP[campIds[seat]],
    color: PLAYER_COLORS[seat],
    symbol: '●',
  }));
  const pieces = statePlayers.flatMap((player) => CAMP_BY_ID.get(player.campId).pointIds.map((pointIdValue, index) => ({
    id: `s${player.seat}-${index}`,
    ownerId: player.id,
    pointId: pointIdValue,
  })));
  return {
    gameKey: 'checkers',
    rulesVersion: RULES_VERSION,
    seed,
    players: statePlayers,
    pieces,
    retiredPlayerIds: [],
    turn: { playerId: playerIds[0], phase: 'move' },
    outcome: null,
    moveCount: 0,
  };
}

function playerFor(state, playerId) {
  return state.players.find((player) => player.id === playerId) || null;
}

function activePlayerIds(state) {
  const retired = new Set(state.retiredPlayerIds);
  return state.players.filter((player) => !retired.has(player.id)).map((player) => player.id);
}

function assertActiveActor(state, context) {
  const actorId = String(context?.actorId || '');
  if (!playerFor(state, actorId) || state.retiredPlayerIds.includes(actorId)) {
    ruleError('ACTION_NOT_LEGAL', 'This player is not active in this game.');
  }
  if (!Array.isArray(context?.activePlayers) || !context.activePlayers.includes(actorId)) {
    ruleError('ACTION_NOT_LEGAL', 'This player is not active in this session.');
  }
  return actorId;
}

function nextPlayerId(state, currentPlayerId, activeIds) {
  const currentIndex = state.players.findIndex((player) => player.id === currentPlayerId);
  if (currentIndex < 0) throw new Error('Current player is missing from game state.');
  for (let offset = 1; offset <= state.players.length; offset += 1) {
    const candidate = state.players[(currentIndex + offset) % state.players.length].id;
    if (activeIds.includes(candidate)) return candidate;
  }
  return null;
}

function resolvePath(state, actorId, path) {
  if (!Array.isArray(path) || path.length < 2 || path.some((entry) => typeof entry !== 'string')) {
    ruleError('INVALID_ACTION', 'A move path must contain at least a start and destination point.');
  }
  if (new Set(path).size !== path.length || path.some((id) => !POINT_BY_ID.has(id))) {
    ruleError('ACTION_NOT_LEGAL', 'Move points must be unique points on the Chinese checkers board.');
  }
  const startId = path[0];
  const piece = state.pieces.find((entry) => entry.pointId === startId);
  if (!piece || piece.ownerId !== actorId) {
    ruleError('ACTION_NOT_LEGAL', 'The move must start from one of your pieces.');
  }

  const occupied = new Map(state.pieces.map((entry) => [entry.pointId, entry.ownerId]));
  occupied.delete(startId);
  let moveKind = null;
  for (let index = 1; index < path.length; index += 1) {
    const from = POINT_BY_ID.get(path[index - 1]);
    const to = POINT_BY_ID.get(path[index]);
    const deltaQ = to.q - from.q;
    const deltaR = to.r - from.r;
    const isStep = AXIAL_DIRECTIONS.some((direction) => direction.q === deltaQ && direction.r === deltaR);
    const isJump = AXIAL_DIRECTIONS.some((direction) => direction.q * 2 === deltaQ && direction.r * 2 === deltaR);
    if (!isStep && !isJump) ruleError('ACTION_NOT_LEGAL', 'Each move segment must be an adjacent step or a straight jump.');
    const segmentKind = isStep ? 'step' : 'jump';
    if (moveKind && moveKind !== segmentKind) {
      ruleError('ACTION_NOT_LEGAL', 'A move cannot mix adjacent steps and jumps.');
    }
    if (segmentKind === 'step' && path.length !== 2) {
      ruleError('ACTION_NOT_LEGAL', 'An adjacent step must end the move.');
    }
    if (occupied.has(to.id)) ruleError('ACTION_NOT_LEGAL', 'A move cannot land on an occupied point.');
    if (segmentKind === 'jump') {
      const middleId = pointId(from.q + (deltaQ / 2), from.r + (deltaR / 2));
      if (!occupied.has(middleId)) ruleError('ACTION_NOT_LEGAL', 'Every jump must cross an occupied point.');
    }
    moveKind = segmentKind;
  }
  return piece;
}

function winnerAfterMove(state, playerId) {
  const player = playerFor(state, playerId);
  const targetPoints = campPointSet(player.targetCampId);
  const ownedPieces = state.pieces.filter((piece) => piece.ownerId === playerId);
  return ownedPieces.length === 10 && ownedPieces.every((piece) => targetPoints.has(piece.pointId));
}

function winOutcome(winnerIds, loserIds, reason) {
  return { terminal: true, type: 'win', winnerIds, loserIds, reason };
}

function applyMove(state, action, context) {
  const actorId = assertActiveActor(state, context);
  if (!state.turn || state.turn.playerId !== actorId) {
    ruleError('NOT_YOUR_TURN', 'It is not your turn.');
  }
  const piece = resolvePath(state, actorId, action.path);
  const next = cloneJson(state);
  const movingPiece = next.pieces.find((entry) => entry.id === piece.id);
  movingPiece.pointId = action.path.at(-1);
  next.moveCount += 1;

  let outcome = null;
  if (winnerAfterMove(next, actorId)) {
    const losers = activePlayerIds(next).filter((id) => id !== actorId);
    outcome = winOutcome([actorId], losers, 'all-pieces-in-target-camp');
    next.outcome = outcome;
    next.turn = null;
  } else {
    next.turn = { playerId: nextPlayerId(next, actorId, activePlayerIds(next)), phase: 'move' };
  }
  return {
    state: next,
    outcome,
    events: [{ type: 'piece-moved', playerId: actorId, path: [...action.path] }],
    progressed: true,
  };
}

function applyResignation(state, action, context) {
  const actorId = assertActiveActor(state, context);
  if (action.type === 'player-retired') {
    if (!isTrustedSystemAction(action, 'player-retired')) {
      ruleError('INVALID_ACTION', 'Retirement is reserved for the board session service.');
    }
    if (action.playerId !== actorId) {
      ruleError('INVALID_ACTION', 'A retirement action can only retire its actor.');
    }
  }
  const next = cloneJson(state);
  next.retiredPlayerIds.push(actorId);
  next.pieces = next.pieces.filter((piece) => piece.ownerId !== actorId);
  const remaining = activePlayerIds(next);
  let outcome = null;

  if (state.players.length === 2) {
    outcome = winOutcome(remaining, [actorId], 'resignation');
  } else if (remaining.length === 1) {
    outcome = winOutcome(remaining, [actorId], 'last-active-player');
  }
  if (outcome) {
    next.outcome = outcome;
    next.turn = null;
  } else if (state.turn?.playerId === actorId) {
    next.turn = { playerId: nextPlayerId(next, actorId, remaining), phase: 'move' };
  }
  return {
    state: next,
    outcome,
    events: [{ type: 'player-resigned', playerId: actorId }],
    progressed: true,
  };
}

function applyAction(state, action, context) {
  if (!isPlainObject(state) || state.gameKey !== 'checkers' || state.rulesVersion !== RULES_VERSION) {
    throw new TypeError('Invalid Chinese checkers state.');
  }
  if (state.outcome) ruleError('ACTION_NOT_LEGAL', 'This game is already complete.');
  if (!isPlainObject(action)) ruleError('INVALID_ACTION', 'An action object is required.');
  if (action.type === 'move') return applyMove(state, action, context);
  if (action.type === 'resign' || action.type === 'player-retired') return applyResignation(state, action, context);
  ruleError('INVALID_ACTION', 'Unknown Chinese checkers action.');
}

function getPublicView(state) {
  if (!isPlainObject(state) || state.gameKey !== 'checkers') throw new TypeError('Invalid Chinese checkers state.');
  const retired = new Set(state.retiredPlayerIds);
  const players = state.players.map((player) => ({
    id: player.id,
    seat: player.seat,
    campId: player.campId,
    targetCampId: player.targetCampId,
    color: player.color,
    symbol: player.symbol,
    status: retired.has(player.id) ? 'retired' : 'active',
  }));
  const playerById = new Map(players.map((player) => [player.id, player]));
  const outcome = state.outcome ? cloneJson(state.outcome) : null;
  return {
    gameKey: 'checkers',
    rulesVersion: RULES_VERSION,
    board: {
      kind: 'graph',
      width: 12,
      height: 14,
      points: BOARD_POINTS.map(({ id, x, y }) => ({ id, x, y })),
      pieces: state.pieces.map((piece) => ({
        id: piece.id,
        ownerId: piece.ownerId,
        position: { pointId: piece.pointId },
        symbol: playerById.get(piece.ownerId)?.symbol || '●',
      })),
      coordinateSystem: {
        format: 'q{q}r{r}',
        description: 'Point IDs use axial hex coordinates: q increases right and r increases down-right in the rendered star.',
      },
      camps: CAMPS.map((camp) => ({ id: camp.id, label: camp.label, pointIds: [...camp.pointIds] })),
    },
    players,
    turn: state.turn ? cloneJson(state.turn) : null,
    prompts: outcome
      ? [{ type: 'game-over', text: '本局跳棋已結束。' }]
      : [
        { type: 'turn', text: `輪到 ${state.turn.playerId} 行棋。` },
        { type: 'move-format', text: '移動請提交 pointId 路徑；一步為兩點，連跳必須逐段列出。' },
      ],
    outcome,
  };
}

module.exports = {
  key: 'checkers',
  rulesVersion: RULES_VERSION,
  minPlayers: 2,
  maxPlayers: 6,
  allowedPlayerCounts: ALLOWED_PLAYER_COUNTS,
  normalizeOptions,
  createInitialState,
  applyAction,
  getPublicView,
};
