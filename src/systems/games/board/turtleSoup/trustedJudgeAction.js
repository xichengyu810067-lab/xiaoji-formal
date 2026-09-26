const { TurtleSoupError } = require('./errors');
const { ALL_VERDICTS, GUESS_VERDICTS, QUESTION_VERDICTS } = require('./judgeOutput');

const trustedActions = new WeakSet();
const SAFE_ID_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

function createTrustedJudgeAction(payload) {
  if (!payload || !SAFE_ID_PATTERN.test(String(payload.judgmentId || '')) ||
      !SAFE_ID_PATTERN.test(String(payload.expectedActorId || '')) ||
      !SHA256_PATTERN.test(String(payload.inputDigest || '')) ||
      !['question', 'guess'].includes(payload.kind) || !ALL_VERDICTS.includes(payload.verdict)) {
    throw new TurtleSoupError('JUDGE_INVALID_RESULT', 'Trusted judgment payload is invalid.');
  }
  const allowed = payload.kind === 'question' ? QUESTION_VERDICTS : GUESS_VERDICTS;
  if (!allowed.includes(payload.verdict)) {
    throw new TurtleSoupError('JUDGE_INVALID_RESULT', 'Verdict does not match the judgment kind.');
  }
  const action = Object.freeze({
    type: 'record-judgment',
    judgmentId: payload.judgmentId,
    expectedActorId: payload.expectedActorId,
    inputDigest: payload.inputDigest,
    kind: payload.kind,
    verdict: payload.verdict,
  });
  trustedActions.add(action);
  return action;
}

function isTrustedJudgeAction(action) {
  return Boolean(action && trustedActions.has(action));
}

module.exports = {
  createTrustedJudgeAction,
  isTrustedJudgeAction,
};
