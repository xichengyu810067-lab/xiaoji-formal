const { BoardRuleError } = require('../contracts');
const { isTrustedJudgeAction } = require('../turtleSoup/trustedJudgeAction');

const key = 'turtle-soup';
const rulesVersion = '1';
const minPlayers = 1;
const maxPlayers = 20;
const allowedPlayerCounts = Object.freeze(Array.from({ length: maxPlayers }, (_, index) => index + 1));
const MAX_JUDGMENTS = 500;
const SCENARIO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;

function invalidAction(message = 'This turtle soup action is not valid.') {
  throw new BoardRuleError('INVALID_ACTION', message);
}

function normalizeOptions(options = {}) {
  const scenarioId = String(options.scenarioId || '').trim();
  const scenarioVersion = options.scenarioVersion;
  if (!SCENARIO_ID_PATTERN.test(scenarioId) || !Number.isSafeInteger(scenarioVersion) || scenarioVersion < 1) {
    invalidAction('Turtle soup scenario reference is invalid.');
  }
  return Object.freeze({ scenarioId, scenarioVersion });
}

function validatePlayers(players) {
  if (!Array.isArray(players) || players.length < minPlayers || players.length > maxPlayers ||
      players.some((player) => typeof player !== 'string' || !player.trim()) ||
      new Set(players).size !== players.length) invalidAction('Turtle soup players are invalid.');
  return [...players];
}

function validateState(state) {
  if (!state || state.gameKey !== key || state.rulesVersion !== rulesVersion ||
      !SCENARIO_ID_PATTERN.test(String(state.scenarioId || '')) ||
      !Number.isSafeInteger(state.scenarioVersion) || state.scenarioVersion < 1 ||
      !Array.isArray(state.players) || !Array.isArray(state.judgments) || state.judgments.length > MAX_JUDGMENTS ||
      (state.outcome !== null && state.outcome?.terminal !== true)) invalidAction('Turtle soup state is invalid.');
  return state;
}

function createInitialState({ players, rules, seed }) {
  if (typeof seed !== 'string' || !seed) invalidAction('Turtle soup seed is invalid.');
  const normalizedRules = normalizeOptions(rules);
  return {
    gameKey: key,
    rulesVersion,
    scenarioId: normalizedRules.scenarioId,
    scenarioVersion: normalizedRules.scenarioVersion,
    players: validatePlayers(players),
    judgments: [],
    outcome: null,
  };
}

function applyAction(stateValue, action, context) {
  const state = validateState(stateValue);
  if (!context || !state.players.includes(context.actorId) || !context.activePlayers?.includes(context.actorId)) {
    throw new BoardRuleError('ACTION_NOT_LEGAL', 'Only active turtle soup participants can act.');
  }
  if (state.outcome) throw new BoardRuleError('CLAIM_NOT_AVAILABLE', 'This turtle soup session has already ended.');
  if (!isTrustedJudgeAction(action) || action.type !== 'record-judgment' || action.expectedActorId !== context.actorId) {
    invalidAction('Turtle soup judgments must come from the trusted judge adapter.');
  }

  const existing = state.judgments.find((entry) => entry.judgmentId === action.judgmentId);
  if (existing) {
    if (existing.inputDigest !== action.inputDigest || existing.kind !== action.kind ||
        existing.verdict !== action.verdict || existing.actorId !== context.actorId) {
      invalidAction('Judgment identifier was reused with different content.');
    }
    return { state, outcome: state.outcome, events: [], progressed: false };
  }
  if (state.judgments.length >= MAX_JUDGMENTS) {
    throw new BoardRuleError('ACTION_NOT_LEGAL', 'This turtle soup session reached its judgment limit.');
  }

  const judgment = Object.freeze({
    judgmentId: action.judgmentId,
    actorId: context.actorId,
    inputDigest: action.inputDigest,
    kind: action.kind,
    verdict: action.verdict,
  });
  const outcome = action.verdict === '答對' ? {
    terminal: true,
    type: 'win',
    winnerIds: [context.actorId],
    loserIds: [],
    reason: 'turtle-soup-solved',
  } : null;
  const nextState = {
    ...state,
    players: [...state.players],
    judgments: [...state.judgments, judgment],
    outcome,
  };
  return {
    state: nextState,
    outcome,
    events: [{
      type: 'turtle-soup-judged',
      judgmentId: action.judgmentId,
      actorId: context.actorId,
      kind: action.kind,
      verdict: action.verdict,
    }],
    progressed: true,
  };
}

function getPublicView(stateValue) {
  const state = validateState(stateValue);
  return {
    gameKey: key,
    rulesVersion,
    board: { kind: 'narrative', width: null, height: null, points: [], pieces: [] },
    turn: null,
    prompts: state.outcome ? [] : [{ type: 'turtle-soup-modal', text: '請使用專用提問或猜題視窗。' }],
    outcome: state.outcome,
    judgmentCount: state.judgments.length,
    judgments: state.judgments.map(({ judgmentId, actorId, kind, verdict }) => ({ judgmentId, actorId, kind, verdict })),
  };
}

function getLegalActions(stateValue, viewerContext = {}) {
  const state = validateState(stateValue);
  if (state.outcome || viewerContext.isActivePlayer !== true || !state.players.includes(viewerContext.viewerId)) return [];
  return ['submit-question', 'submit-guess'];
}

module.exports = {
  allowedPlayerCounts,
  applyAction,
  createInitialState,
  getLegalActions,
  getPublicView,
  key,
  maxPlayers,
  minPlayers,
  normalizeOptions,
  rulesVersion,
};
