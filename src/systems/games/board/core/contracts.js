const { createHash } = require('node:crypto');

const GAME_KEYS = Object.freeze([
  'turtle-soup',
  'chess',
  'gomoku',
  'go',
  'checkers',
  'xiangqi',
]);

const SESSION_STATUSES = Object.freeze([
  'lobby',
  'active',
  'completed',
  'cancelled',
  'expired',
]);

const LOBBY_TIMEOUT_MS = 10 * 60 * 1000;
const ACTIVE_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const BOARD_RULE_ERROR_CODES = Object.freeze([
  'INVALID_ACTION',
  'NOT_YOUR_TURN',
  'ACTION_NOT_LEGAL',
  'CLAIM_NOT_AVAILABLE',
]);

class BoardCoreError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'BoardCoreError';
    this.code = code;
    this.details = details;
  }
}

class BoardRuleError extends BoardCoreError {
  constructor(code, message) {
    if (!BOARD_RULE_ERROR_CODES.includes(code)) {
      throw new BoardCoreError('INVALID_ENGINE', 'BoardRuleError code is not supported.');
    }
    super(code, message);
    this.name = 'BoardRuleError';
  }
}

function cloneJson(value, label = 'value') {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError(`${label} is not JSON serializable.`);
    return JSON.parse(encoded);
  } catch (error) {
    if (error instanceof BoardCoreError) throw error;
    throw new BoardCoreError('INVALID_JSON', `${label} must be JSON serializable.`);
  }
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
}

function digestRequest(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function requireIdentifier(value, label, maxLength = 128) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new BoardCoreError('INVALID_REQUEST', `${label} is invalid.`);
  }
  return text;
}

function requireRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new BoardCoreError('INVALID_REVISION', 'expectedRevision must be a non-negative safe integer.');
  }
  return value;
}

function normalizeDate(value, label = 'time') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new BoardCoreError('INVALID_REQUEST', `${label} is invalid.`);
  return date;
}

function addMilliseconds(date, milliseconds) {
  return new Date(normalizeDate(date).getTime() + milliseconds).toISOString();
}

function isSessionExpired(session, now) {
  if (!session || !['lobby', 'active'].includes(session.status)) return false;
  const deadline = Date.parse(session.expiresAt);
  return Number.isFinite(deadline) && deadline <= normalizeDate(now).getTime();
}

function assertEngineContract(engine) {
  if (!engine || typeof engine !== 'object') throw new BoardCoreError('INVALID_ENGINE', 'Engine must be an object.');
  if (!GAME_KEYS.includes(engine.key)) throw new BoardCoreError('INVALID_ENGINE', 'Engine key is not supported.');
  requireIdentifier(engine.rulesVersion, 'engine.rulesVersion', 64);
  if (!Number.isInteger(engine.minPlayers) || !Number.isInteger(engine.maxPlayers) ||
      engine.minPlayers < 1 || engine.maxPlayers < engine.minPlayers || engine.maxPlayers > 25) {
    throw new BoardCoreError('INVALID_ENGINE', 'Engine player bounds are invalid.');
  }
  for (const method of ['createInitialState', 'applyAction', 'getPublicView']) {
    if (typeof engine[method] !== 'function') throw new BoardCoreError('INVALID_ENGINE', `Engine is missing ${method}().`);
  }
  if (engine.getLegalActions != null && typeof engine.getLegalActions !== 'function') {
    throw new BoardCoreError('INVALID_ENGINE', 'Engine getLegalActions must be a function when provided.');
  }
  if (engine.normalizeOptions != null && typeof engine.normalizeOptions !== 'function') {
    throw new BoardCoreError('INVALID_ENGINE', 'Engine normalizeOptions must be a function when provided.');
  }
  if (engine.allowedPlayerCounts != null) {
    if (!Array.isArray(engine.allowedPlayerCounts) || !engine.allowedPlayerCounts.length ||
        engine.allowedPlayerCounts.some((count) => !Number.isInteger(count) || count < engine.minPlayers || count > engine.maxPlayers)) {
      throw new BoardCoreError('INVALID_ENGINE', 'Engine allowedPlayerCounts are invalid.');
    }
  }
  return engine;
}

function assertEngineState(state, { gameKey, rulesVersion }) {
  const cloned = cloneJson(state, 'engine state');
  if (!cloned || typeof cloned !== 'object' || Array.isArray(cloned)) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Engine state must be an object.');
  }
  if (cloned.gameKey !== gameKey || cloned.rulesVersion !== rulesVersion) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Engine state is not bound to this game and rules version.');
  }
  return cloned;
}

function assertParticipantList(values, label, playerSet) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string' || !value || !playerSet.has(value))) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', `${label} must contain only session players.`);
  }
  if (new Set(values).size !== values.length) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', `${label} must not contain duplicates.`);
  }
  return [...values];
}

function assertEngineOutcome(outcome, players) {
  if (outcome == null) return null;
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Engine outcome must be null or an object.');
  }
  const keys = Object.keys(outcome).sort();
  const required = ['loserIds', 'reason', 'terminal', 'type', 'winnerIds'];
  if (JSON.stringify(keys) !== JSON.stringify(required) || outcome.terminal !== true || !['win', 'draw'].includes(outcome.type)) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Engine outcome does not match the terminal outcome contract.');
  }
  const playerSet = new Set(players);
  const winnerIds = assertParticipantList(outcome.winnerIds, 'outcome.winnerIds', playerSet);
  const loserIds = assertParticipantList(outcome.loserIds, 'outcome.loserIds', playerSet);
  if (winnerIds.some((playerId) => loserIds.includes(playerId))) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Outcome winners and losers must be disjoint.');
  }
  if (outcome.type === 'win' && winnerIds.length === 0) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'A winning outcome must identify a winner.');
  }
  if (outcome.type === 'draw' && (winnerIds.length > 0 || loserIds.length > 0)) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'A draw cannot identify winners or losers.');
  }
  const reason = requireIdentifier(outcome.reason, 'outcome.reason', 160);
  return { terminal: true, type: outcome.type, winnerIds, loserIds, reason };
}

function assertEngineTransition(result, { gameKey, rulesVersion, players }) {
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'state')) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Engine action result is invalid.');
  }
  if (result.progressed !== true) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Engine transitions must explicitly progress the game.');
  }
  const state = assertEngineState(result.state, { gameKey, rulesVersion });
  const events = result.events == null ? [] : cloneJson(result.events, 'engine events');
  if (!Array.isArray(events) || events.some((event) => !event || typeof event !== 'object' || Array.isArray(event) ||
      typeof event.type !== 'string' || !event.type.trim())) {
    throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Engine events must be typed objects.');
  }
  const outcome = assertEngineOutcome(result.outcome, players);
  return { state, events, outcome, progressed: true };
}

function assertPlayerCount(engine, count) {
  if (!Number.isInteger(count) || count < engine.minPlayers || count > engine.maxPlayers ||
      (engine.allowedPlayerCounts && !engine.allowedPlayerCounts.includes(count))) {
    throw new BoardCoreError('INVALID_PLAYER_COUNT', 'The lobby player count is not supported by this game.');
  }
}

module.exports = {
  ACTIVE_TIMEOUT_MS,
  BOARD_RULE_ERROR_CODES,
  BoardCoreError,
  BoardRuleError,
  GAME_KEYS,
  LOBBY_TIMEOUT_MS,
  SESSION_STATUSES,
  addMilliseconds,
  assertEngineContract,
  assertEngineOutcome,
  assertEngineState,
  assertEngineTransition,
  assertPlayerCount,
  cloneJson,
  digestRequest,
  isSessionExpired,
  normalizeDate,
  requireIdentifier,
  requireRevision,
  stableJson,
};
