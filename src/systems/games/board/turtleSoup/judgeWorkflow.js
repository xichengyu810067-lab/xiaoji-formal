const { createHash } = require('node:crypto');
const { TurtleSoupError } = require('./errors');
const { validateJudgeResult } = require('./judgeOutput');
const { isUnsafeInstruction, normalizeJudgeInput, retrieveEvidence } = require('./retriever');
const { createTrustedJudgeAction } = require('./trustedJudgeAction');

function requireSessionIdentity(value, label) {
  const text = String(value || '').trim();
  if (!text || text.length > 128 || /[\u0000-\u001f\u007f]/u.test(text)) {
    throw new TurtleSoupError('SESSION_MISMATCH', `${label} is invalid.`);
  }
  return text;
}

function sessionPlayerIds(session, { activeOnly = false } = {}) {
  if (!Array.isArray(session?.players)) return [];
  return session.players.map((player) => {
    if (typeof player === 'string') return { userId: player, status: 'active' };
    return { userId: player?.userId, status: player?.status };
  }).filter((player) => typeof player.userId === 'string' && player.userId &&
    (!activeOnly || player.status === 'active')).map((player) => player.userId);
}

function assertTurtleSoupSession(session, request, { requireActive = true } = {}) {
  if (!session || session.gameKey !== 'turtle-soup') {
    throw new TurtleSoupError('SESSION_MISMATCH', 'Turtle soup session was not found.');
  }
  for (const field of ['id', 'guildId', 'channelId']) {
    if (requireSessionIdentity(session[field], `session.${field}`) !== requireSessionIdentity(request[field], field)) {
      throw new TurtleSoupError('SESSION_MISMATCH', 'Session identity does not match.');
    }
  }
  if (request.messageId !== undefined && requireSessionIdentity(session.messageId, 'session.messageId') !==
      requireSessionIdentity(request.messageId, 'messageId')) {
    throw new TurtleSoupError('SESSION_MISMATCH', 'Session message does not match.');
  }
  if (requireActive && session.status !== 'active') {
    throw new TurtleSoupError('SESSION_NOT_ACTIVE', 'Turtle soup session is not active.');
  }
  if (!sessionPlayerIds(session).includes(request.actorId)) {
    throw new TurtleSoupError('NOT_PARTICIPANT', 'Only session participants can submit judgments.');
  }
  if (requireActive && !sessionPlayerIds(session, { activeOnly: true }).includes(request.actorId)) {
    throw new TurtleSoupError('NOT_PARTICIPANT', 'Only active session participants can submit judgments.');
  }
  if (!Number.isSafeInteger(session.revision) || session.revision < 0) {
    throw new TurtleSoupError('SESSION_MISMATCH', 'Session revision is invalid.');
  }
  if (request.expectedRevision !== undefined && session.revision !== request.expectedRevision) {
    throw new TurtleSoupError('SESSION_STALE', 'Session changed before judgment could be applied.', { retryable: true });
  }
  const scenarioId = session.state?.scenarioId;
  const scenarioVersion = session.state?.scenarioVersion;
  if (!scenarioId || !Number.isSafeInteger(scenarioVersion)) {
    throw new TurtleSoupError('SESSION_MISMATCH', 'Session scenario reference is invalid.');
  }
  return { scenarioId, scenarioVersion };
}

function digestInput(kind, input) {
  return createHash('sha256').update(`${kind}\u0000${input}`, 'utf8').digest('hex');
}

function buildPreparedIdentity(request) {
  const kind = request.kind;
  if (!['question', 'guess'].includes(kind)) {
    throw new TurtleSoupError('INVALID_JUDGE_INPUT', 'Judgment kind is invalid.');
  }
  if (!Number.isSafeInteger(request.expectedRevision) || request.expectedRevision < 0) {
    throw new TurtleSoupError('SESSION_STALE', 'Session revision is invalid.');
  }
  const input = normalizeJudgeInput(request.input);
  return Object.freeze({
    sessionId: requireSessionIdentity(request.id, 'id'),
    guildId: requireSessionIdentity(request.guildId, 'guildId'),
    channelId: requireSessionIdentity(request.channelId, 'channelId'),
    messageId: requireSessionIdentity(request.messageId, 'messageId'),
    expectedRevision: request.expectedRevision,
    actorId: requireSessionIdentity(request.actorId, 'actorId'),
    judgmentId: requireSessionIdentity(request.interactionId, 'interactionId'),
    inputDigest: digestInput(kind, input),
    kind,
  });
}

async function prepareTurtleSoupJudgment({ session, request, scenarioProvider, judgeProvider }) {
  if (!scenarioProvider || typeof scenarioProvider.loadScenario !== 'function' ||
      !judgeProvider || typeof judgeProvider.judge !== 'function') {
    throw new TurtleSoupError('JUDGE_UNAVAILABLE', 'Turtle soup judge dependencies are unavailable.', { retryable: true });
  }
  const reference = assertTurtleSoupSession(session, request);
  const kind = request.kind;
  if (!['question', 'guess'].includes(kind)) {
    throw new TurtleSoupError('INVALID_JUDGE_INPUT', 'Judgment kind is invalid.');
  }
  const input = normalizeJudgeInput(request.input);
  const judgmentId = requireSessionIdentity(request.interactionId, 'interactionId');
  const scenario = scenarioProvider.loadScenario(reference);
  const evidence = retrieveEvidence(scenario, input, kind);

  let result;
  if (isUnsafeInstruction(input) || evidence.length === 0) {
    result = { verdict: '無法判定' };
  } else {
    result = await judgeProvider.judge({ kind, input, evidence });
  }
  result = validateJudgeResult(result, kind);

  return Object.freeze({
    sessionId: session.id,
    guildId: session.guildId,
    channelId: session.channelId,
    messageId: session.messageId,
    expectedRevision: session.revision,
    actorId: request.actorId,
    judgmentId,
    inputDigest: digestInput(kind, input),
    kind,
    verdict: result.verdict,
    scenarioId: reference.scenarioId,
    scenarioVersion: reference.scenarioVersion,
  });
}

function revalidateAndApplyJudgment({ latestSession, prepared, engine, now = new Date().toISOString() }) {
  const request = {
    id: prepared.sessionId,
    guildId: prepared.guildId,
    channelId: prepared.channelId,
    messageId: prepared.messageId,
    actorId: prepared.actorId,
    expectedRevision: prepared.expectedRevision,
  };
  const reference = assertTurtleSoupSession(latestSession, request);
  if (reference.scenarioId !== prepared.scenarioId || reference.scenarioVersion !== prepared.scenarioVersion) {
    throw new TurtleSoupError('SESSION_STALE', 'Session scenario changed before judgment could be applied.', { retryable: true });
  }
  if (!engine || engine.key !== 'turtle-soup' || typeof engine.applyAction !== 'function') {
    throw new TurtleSoupError('JUDGE_UNAVAILABLE', 'Turtle soup engine is unavailable.', { retryable: true });
  }
  const action = createTrustedJudgeAction({
    judgmentId: prepared.judgmentId,
    expectedActorId: prepared.actorId,
    inputDigest: prepared.inputDigest,
    kind: prepared.kind,
    verdict: prepared.verdict,
  });
  return engine.applyAction(latestSession.state, action, {
    actorId: prepared.actorId,
    players: sessionPlayerIds(latestSession),
    activePlayers: sessionPlayerIds(latestSession, { activeOnly: true }),
    retiredPlayers: Array.isArray(latestSession.retiredPlayers)
      ? [...latestSession.retiredPlayers]
      : (latestSession.players || []).filter((player) => player?.status === 'retired').map((player) => player.userId),
    revision: latestSession.revision,
    now,
  });
}

function createTurtleSoupJudgeWorkflow({ loadSession, scenarioProvider, judgeProvider, commitPrepared, engine, clock = () => new Date() }) {
  if (typeof loadSession !== 'function' || typeof commitPrepared !== 'function') {
    throw new TurtleSoupError('JUDGE_UNAVAILABLE', 'Turtle soup session adapters are unavailable.');
  }
  return Object.freeze({
    async submit(request) {
      const preparedIdentity = buildPreparedIdentity(request);
      if (typeof commitPrepared.probeReplay === 'function') {
        const replay = await commitPrepared.probeReplay(preparedIdentity);
        if (replay) return replay;
      }
      const session = await loadSession({
        id: request.id,
        guildId: request.guildId,
        channelId: request.channelId,
      });
      const prepared = await prepareTurtleSoupJudgment({ session, request, scenarioProvider, judgeProvider });
      return commitPrepared({
        prepared,
        apply(latestSession) {
          return revalidateAndApplyJudgment({ latestSession, prepared, engine, now: clock().toISOString() });
        },
      });
    },
  });
}

module.exports = {
  assertTurtleSoupSession,
  buildPreparedIdentity,
  createTurtleSoupJudgeWorkflow,
  digestInput,
  prepareTurtleSoupJudgment,
  revalidateAndApplyJudgment,
  sessionPlayerIds,
};
