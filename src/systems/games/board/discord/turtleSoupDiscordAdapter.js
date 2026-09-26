const { BoardCoreError } = require('../../../../games/contracts');
const { parseBoardCustomId } = require('./boardCustomId');
const { assertSessionBoundary, getInteractionIdentity, getModalValue } = require('./boardInteractionAdapter');

const RATE_LIMIT_MESSAGE = '小吉有點累了，請稍後再跟我聊天';
const JUDGE_UNAVAILABLE_MESSAGE = '小吉暫時無法判題，棋局已保留，請稍後再試。';
const REVEAL_UNAVAILABLE_MESSAGE = '小吉暫時無法揭曉湯底，請稍後再試。';

const SAFE_JUDGE_FAILURE_CODES = new Set([
  'JUDGE_UNAVAILABLE',
  'JUDGE_TIMEOUT',
  'JUDGE_INVALID_OUTPUT',
  'JUDGE_INVALID_RESULT',
  'CORPUS_UNAVAILABLE',
]);

function safeJudgeFailure(error) {
  if (error?.code === 'JUDGE_RATE_LIMITED') {
    return { ok: false, ephemeral: true, content: RATE_LIMIT_MESSAGE, preserveSession: true, code: error.code };
  }
  if (SAFE_JUDGE_FAILURE_CODES.has(error?.code)) {
    return { ok: false, ephemeral: true, content: JUDGE_UNAVAILABLE_MESSAGE, preserveSession: true, code: error.code };
  }
  return null;
}

function judgmentReply(committed) {
  const event = committed?.events?.find((entry) => entry?.type === 'turtle-soup-judged');
  const verdict = event?.verdict;
  if (verdict === '答對') return '答對了！可以使用私密揭曉查看湯底。';
  if (['是', '否', '無關'].includes(verdict)) return verdict;
  return '目前無法判定，棋局已保留。';
}

function createTurtleSoupDiscordAdapter({ workflow, revealService, service, store }) {
  if (!workflow || typeof workflow.submit !== 'function' || !revealService || typeof revealService.getReveal !== 'function' ||
      !service || typeof service.recoverSession !== 'function' || !store || typeof store.getSessionById !== 'function') {
    throw new BoardCoreError('INVALID_INTERACTION_ADAPTER', 'Turtle soup Discord dependencies are unavailable.');
  }
  return Object.freeze({
    async handle(interaction) {
      const decoded = parseBoardCustomId(interaction?.customId);
      const identity = getInteractionIdentity(interaction);
      const session = await store.getSessionById(decoded.sessionId);
      assertSessionBoundary(session, identity, decoded, decoded.verb);
      if (session.gameKey !== 'turtle-soup') throw new BoardCoreError('SESSION_MISMATCH', 'This is not a turtle soup session.');

      if (decoded.verb === 'reveal') {
        try {
          return await revealService.getReveal({
            id: session.id,
            guildId: identity.guildId,
            channelId: identity.channelId,
            messageId: identity.messageId,
            actorId: identity.actorId,
          });
        } catch (error) {
          if (error?.code === 'CORPUS_UNAVAILABLE') {
            return { ok: false, ephemeral: true, content: REVEAL_UNAVAILABLE_MESSAGE, preserveSession: true, code: error.code };
          }
          throw error;
        }
      }

      const kind = decoded.verb === 'act.ask' ? 'question' : decoded.verb === 'act.guess' ? 'guess' : null;
      if (!kind) throw new BoardCoreError('INVALID_CUSTOM_ID', 'Turtle soup interaction verb is unsupported.');
      const request = {
        id: session.id,
        guildId: identity.guildId,
        channelId: identity.channelId,
        messageId: identity.messageId,
        actorId: identity.actorId,
        expectedRevision: decoded.revision,
        interactionId: identity.interactionId,
        kind,
        input: getModalValue(interaction, 'input'),
      };
      let committed;
      try {
        committed = await workflow.submit(request);
      } catch (error) {
        const safe = safeJudgeFailure(error);
        if (safe) return safe;
        throw error;
      }
      const board = await service.recoverSession({ sessionId: session.id, actorId: identity.actorId });
      return {
        ok: true,
        ephemeral: true,
        content: judgmentReply(committed),
        replayed: committed.replayed === true,
        board,
      };
    },
  });
}

module.exports = {
  JUDGE_UNAVAILABLE_MESSAGE,
  RATE_LIMIT_MESSAGE,
  REVEAL_UNAVAILABLE_MESSAGE,
  SAFE_JUDGE_FAILURE_CODES,
  createTurtleSoupDiscordAdapter,
  judgmentReply,
  safeJudgeFailure,
};
