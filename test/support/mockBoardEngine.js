const { BoardRuleError } = require('../../src/games/contracts');
const { isTrustedSystemAction } = require('../../src/games/trustedSystemActions');

function createMockBoardEngine({ key = 'chess', allowedPlayerCounts = [2] } = {}) {
  return {
    key,
    rulesVersion: 'mock-1',
    minPlayers: Math.min(...allowedPlayerCounts),
    maxPlayers: Math.max(...allowedPlayerCounts),
    allowedPlayerCounts,
    normalizeOptions(options) {
      return { target: Number.isInteger(options.target) ? options.target : 3 };
    },
    createInitialState({ players, rules, seed }) {
      return {
        gameKey: key,
        rulesVersion: 'mock-1',
        players: [...players],
        retired: [],
        value: 0,
        target: rules.target,
        seed,
        turn: { playerId: players[0], phase: 'move' },
      };
    },
    applyAction(state, action, context) {
      if (action.type === 'player-retired') {
        if (!isTrustedSystemAction(action, 'player-retired') || action.playerId !== context.actorId) {
          throw new BoardRuleError('INVALID_ACTION', 'Retirement must come from the trusted core.');
        }
        const active = context.activePlayers.filter((playerId) => playerId !== action.playerId);
        const next = { ...state, retired: [...state.retired, action.playerId] };
        if (active.length === 1) {
          next.turn = null;
          return {
            state: next,
            events: [{ type: 'player-retired', playerId: action.playerId }],
            outcome: { terminal: true, type: 'win', winnerIds: [active[0]], loserIds: [action.playerId], reason: 'last-player-standing' },
            progressed: true,
          };
        }
        next.turn = { playerId: active[0], phase: 'move' };
        return { state: next, events: [{ type: 'player-retired', playerId: action.playerId }], outcome: null, progressed: true };
      }
      if (action.type !== 'move' || !Number.isInteger(action.amount) || action.amount < 1) {
        throw new BoardRuleError('INVALID_ACTION', 'Move is invalid.');
      }
      if (state.turn.playerId !== context.actorId) throw new BoardRuleError('NOT_YOUR_TURN', 'It is not your turn.');
      const nextValue = state.value + action.amount;
      const opponent = context.activePlayers.find((playerId) => playerId !== context.actorId) || context.actorId;
      const won = nextValue >= state.target;
      return {
        state: { ...state, value: nextValue, turn: won ? null : { playerId: opponent, phase: 'move' } },
        events: [{ type: 'moved', playerId: context.actorId, amount: action.amount }],
        outcome: won
          ? { terminal: true, type: 'win', winnerIds: [context.actorId], loserIds: [opponent], reason: 'target-reached' }
          : null,
        progressed: true,
      };
    },
    getPublicView(state) {
      return {
        gameKey: key,
        rulesVersion: 'mock-1',
        board: {
          kind: 'grid',
          width: 2,
          height: 2,
          points: [],
          pieces: state.players.filter((playerId) => !state.retired.includes(playerId)).map((playerId, index) => ({
            id: `piece-${index}`,
            ownerId: playerId,
            position: { x: index, y: index },
            symbol: index === 0 ? '♔' : '♚',
          })),
        },
        turn: state.turn,
        prompts: [],
        outcome: null,
        value: state.value,
      };
    },
    getLegalActions(state, viewer) {
      return state.turn?.playerId === viewer.viewerId ? [{ type: 'move', amount: 1 }] : [];
    },
  };
}

module.exports = { createMockBoardEngine };
