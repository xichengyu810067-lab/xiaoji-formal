const { BoardCoreError, cloneJson, requireIdentifier } = require('../../../../games/contracts');
const { parseBoardCustomId } = require('./boardCustomId');

function getInteractionIdentity(interaction) {
  return {
    interactionId: requireIdentifier(interaction?.id, 'interaction.id', 160),
    guildId: requireIdentifier(interaction?.guildId, 'interaction.guildId'),
    channelId: requireIdentifier(interaction?.channelId, 'interaction.channelId'),
    messageId: requireIdentifier(interaction?.message?.id, 'interaction.message.id'),
    actorId: requireIdentifier(interaction?.user?.id, 'interaction.user.id'),
  };
}

function getModalValue(interaction, name) {
  if (!interaction?.fields || typeof interaction.fields.getTextInputValue !== 'function') {
    throw new BoardCoreError('INVALID_INTERACTION', 'Modal fields are unavailable.');
  }
  return String(interaction.fields.getTextInputValue(name) || '').trim();
}

function parseGridCoordinate(value, board) {
  const text = String(value || '').trim().toUpperCase();
  let x;
  let y;
  const algebraic = /^([A-Z])(\d{1,2})$/u.exec(text);
  const numeric = /^(\d{1,2})\s*[,，]\s*(\d{1,2})$/u.exec(text);
  if (algebraic) {
    x = algebraic[1].charCodeAt(0) - 65;
    y = Number(algebraic[2]) - 1;
  } else if (numeric) {
    x = Number(numeric[1]);
    y = Number(numeric[2]);
  } else {
    throw new BoardCoreError('INVALID_COORDINATE', 'Coordinate must use A1 or x,y format.');
  }
  if (!Number.isInteger(board?.width) || !Number.isInteger(board?.height) || x < 0 || y < 0 || x >= board.width || y >= board.height) {
    throw new BoardCoreError('INVALID_COORDINATE', 'Coordinate is outside the board.');
  }
  return { x, y };
}

function createGridMoveParser({ fromField = 'from', toField = 'to', actionType = 'move' } = {}) {
  return ({ interaction, publicView }) => ({
    type: actionType,
    from: parseGridCoordinate(getModalValue(interaction, fromField), publicView.board),
    to: parseGridCoordinate(getModalValue(interaction, toField), publicView.board),
  });
}

function assertSessionBoundary(session, identity, decoded, verb) {
  if (!session || session.id !== decoded.sessionId) throw new BoardCoreError('SESSION_NOT_FOUND', 'The board session does not exist.');
  if (session.guildId !== identity.guildId || session.channelId !== identity.channelId) {
    throw new BoardCoreError('SESSION_SCOPE_MISMATCH', 'The interaction belongs to another server or channel.');
  }
  if (!session.messageId || session.messageId !== identity.messageId) {
    throw new BoardCoreError('MESSAGE_MISMATCH', 'The interaction came from another message.');
  }
  const player = session.players.find((entry) => entry.userId === identity.actorId) || null;
  if (['leave', 'begin', 'stop', 'status'].includes(verb) || verb.startsWith('act.')) {
    if (!player || player.status !== 'active') throw new BoardCoreError('NOT_A_PLAYER', 'The user is not an active player.');
  }
  return player;
}

function createDiscordBoardInteractionAdapter({ service, store, actionParsers = {} }) {
  if (!service || !store || typeof store.getSessionById !== 'function') {
    throw new BoardCoreError('INVALID_INTERACTION_ADAPTER', 'Board service and store are required.');
  }

  return Object.freeze({
    async handle(interaction) {
      const decoded = parseBoardCustomId(interaction?.customId);
      const identity = getInteractionIdentity(interaction);
      const session = await store.getSessionById(decoded.sessionId);
      assertSessionBoundary(session, identity, decoded, decoded.verb);
      const mutation = {
        guildId: identity.guildId,
        channelId: identity.channelId,
        actorId: identity.actorId,
        expectedRevision: decoded.revision,
        interactionId: identity.interactionId,
      };
      if (decoded.verb === 'join') return service.join(mutation);
      if (decoded.verb === 'leave') return service.leave(mutation);
      if (decoded.verb === 'begin') return service.begin(mutation);
      if (decoded.verb === 'stop') return service.stop(mutation);
      if (decoded.verb === 'status') {
        if (typeof service.refreshSession !== 'function') {
          throw new BoardCoreError('INVALID_INTERACTION_ADAPTER', 'Board refresh is unavailable.');
        }
        return service.refreshSession({
          sessionId: session.id,
          guildId: identity.guildId,
          channelId: identity.channelId,
          messageId: identity.messageId,
          actorId: identity.actorId,
        });
      }
      if (!decoded.verb.startsWith('act.')) throw new BoardCoreError('INVALID_CUSTOM_ID', 'Board interaction verb is unsupported.');
      const controlId = decoded.verb.slice(4);
      const parser = actionParsers[session.gameKey]?.[controlId];
      if (typeof parser !== 'function') throw new BoardCoreError('ACTION_NOT_AVAILABLE', 'This board action is not available.');
      const publicResult = await service.readSession({ sessionId: session.id, actorId: identity.actorId });
      const action = parser({ interaction, publicView: cloneJson(publicResult.game), session: cloneJson(publicResult.session) });
      if (action && typeof action.then === 'function') {
        throw new BoardCoreError('ASYNC_ACTION_PARSER_FORBIDDEN', 'Discord board action parsers must be synchronous.');
      }
      return service.submitAction({ ...mutation, messageId: identity.messageId, action: cloneJson(action, 'parsed board action') });
    },
  });
}

module.exports = {
  assertSessionBoundary,
  createDiscordBoardInteractionAdapter,
  createGridMoveParser,
  getInteractionIdentity,
  getModalValue,
  parseGridCoordinate,
};
