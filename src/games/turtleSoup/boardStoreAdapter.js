const {
  ACTIVE_TIMEOUT_MS,
  BoardCoreError,
  BoardRuleError,
  addMilliseconds,
  assertEngineTransition,
  cloneJson,
  digestRequest,
  stableJson,
} = require('../contracts');
const { TurtleSoupError } = require('./errors');

function normalizeTime(clock) {
  const value = clock();
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) throw new TurtleSoupError('JUDGE_UNAVAILABLE', 'Judge clock is invalid.');
  return date;
}

function buildMutationRequest(prepared) {
  const requestDigest = digestRequest({
    operation: 'turtle-soup-judgment',
    sessionId: prepared.sessionId,
    guildId: prepared.guildId,
    channelId: prepared.channelId,
    messageId: prepared.messageId,
    actorId: prepared.actorId,
    expectedRevision: prepared.expectedRevision,
    judgmentId: prepared.judgmentId,
    inputDigest: prepared.inputDigest,
    kind: prepared.kind,
  });
  return {
    guildId: prepared.guildId,
    channelId: prepared.channelId,
    expectedRevision: prepared.expectedRevision,
    interactionId: prepared.judgmentId,
    requestDigest,
  };
}

function createBoardStoreJudgeCommitter({ store, clock = () => new Date() }) {
  if (!store || typeof store.mutate !== 'function') {
    throw new TurtleSoupError('JUDGE_UNAVAILABLE', 'Board store does not support turtle soup judgments.');
  }
  const commitPrepared = async function commitPrepared({ prepared, apply }) {
    if (!prepared || typeof apply !== 'function') {
      throw new TurtleSoupError('JUDGE_INVALID_RESULT', 'Prepared judgment is invalid.');
    }
    return store.mutate(buildMutationRequest(prepared), (latestSession) => {
      const now = normalizeTime(clock);
      const before = stableJson(latestSession);
      let rawTransition;
      try {
        rawTransition = apply(latestSession);
      } catch (error) {
        if (error instanceof BoardRuleError || error instanceof BoardCoreError || error instanceof TurtleSoupError) throw error;
        throw new BoardCoreError('ENGINE_FAILURE', 'The turtle soup engine failed.');
      }
      if (stableJson(latestSession) !== before) {
        throw new BoardCoreError('ENGINE_CONTRACT_VIOLATION', 'Turtle soup judgment mutated the stored session input.');
      }
      const transition = assertEngineTransition(rawTransition, {
        gameKey: latestSession.gameKey,
        rulesVersion: latestSession.rulesVersion,
        players: latestSession.players.map((player) => typeof player === 'string' ? player : player.userId),
      });
      const next = cloneJson(latestSession);
      next.state = transition.state;
      next.turn = cloneJson(transition.state.turn ?? null);
      next.outcome = transition.outcome;
      if (transition.outcome?.terminal === true) {
        next.status = 'completed';
        next.endedAt = now.toISOString();
        next.endReason = transition.outcome.reason;
      }
      next.revision += 1;
      next.updatedAt = now.toISOString();
      next.lastProgressAt = now.toISOString();
      next.expiresAt = addMilliseconds(now, ACTIVE_TIMEOUT_MS);
      return {
        session: next,
        events: transition.events,
        action: {
          type: 'turtle-soup-judgment',
          actorId: prepared.actorId,
          judgmentId: prepared.judgmentId,
          inputDigest: prepared.inputDigest,
          kind: prepared.kind,
          verdict: prepared.verdict,
        },
      };
    });
  };
  commitPrepared.probeReplay = async (preparedIdentity) => {
    try {
      return await store.mutate(buildMutationRequest(preparedIdentity), () => {
        throw new TurtleSoupError('REPLAY_NOT_FOUND', 'No stored judgment replay exists.');
      });
    } catch (error) {
      if (error?.code === 'REPLAY_NOT_FOUND') return null;
      throw error;
    }
  };
  return commitPrepared;
}

module.exports = { buildMutationRequest, createBoardStoreJudgeCommitter };
