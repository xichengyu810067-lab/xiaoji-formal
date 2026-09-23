const { TurtleSoupError } = require('./errors');
const { assertTurtleSoupSession } = require('./judgeWorkflow');

function createTurtleSoupRevealService({ loadSession, scenarioProvider }) {
  if (typeof loadSession !== 'function' || !scenarioProvider || typeof scenarioProvider.loadScenario !== 'function') {
    throw new TurtleSoupError('CORPUS_UNAVAILABLE', 'Turtle soup reveal dependencies are unavailable.');
  }
  return Object.freeze({
    async getReveal(request) {
      if (typeof request?.messageId !== 'string' || !request.messageId.trim()) {
        throw new TurtleSoupError('SESSION_MISMATCH', 'Session message is required for a reveal.');
      }
      const session = await loadSession({ id: request.id, guildId: request.guildId, channelId: request.channelId });
      const reference = assertTurtleSoupSession(session, request, { requireActive: false });
      if (!['completed', 'cancelled', 'expired'].includes(session.status)) {
        throw new TurtleSoupError('REVEAL_NOT_AVAILABLE', 'The reveal is available only after the session ends.');
      }
      const scenario = scenarioProvider.loadScenario(reference);
      return Object.freeze({
        ephemeral: true,
        scenarioId: scenario.id,
        scenarioVersion: scenario.version,
        revealText: scenario.revealText,
      });
    },
  });
}

module.exports = { createTurtleSoupRevealService };
