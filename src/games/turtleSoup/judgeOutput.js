const { TurtleSoupError } = require('./errors');

const QUESTION_VERDICTS = Object.freeze(['是', '否', '無關', '無法判定']);
const GUESS_VERDICTS = Object.freeze(['答對', '未答對', '無法判定']);
const ALL_VERDICTS = Object.freeze([...new Set([...QUESTION_VERDICTS, ...GUESS_VERDICTS])]);

function parseJudgeOutput(value, kind) {
  if (typeof value !== 'string' || value.length > 200) {
    throw new TurtleSoupError('JUDGE_INVALID_OUTPUT', 'Judge returned an invalid result.');
  }
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TurtleSoupError('JUDGE_INVALID_OUTPUT', 'Judge returned an invalid result.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
      Object.keys(parsed).length !== 1 || !Object.hasOwn(parsed, 'verdict')) {
    throw new TurtleSoupError('JUDGE_INVALID_OUTPUT', 'Judge returned an invalid result.');
  }
  const allowed = kind === 'question' ? QUESTION_VERDICTS : kind === 'guess' ? GUESS_VERDICTS : [];
  if (!allowed.includes(parsed.verdict)) {
    throw new TurtleSoupError('JUDGE_INVALID_OUTPUT', 'Judge returned an unsupported result.');
  }
  return Object.freeze({ verdict: parsed.verdict });
}

function validateJudgeResult(value, kind) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 1 || !Object.hasOwn(value, 'verdict')) {
    throw new TurtleSoupError('JUDGE_INVALID_OUTPUT', 'Judge returned an invalid result.');
  }
  const allowed = kind === 'question' ? QUESTION_VERDICTS : kind === 'guess' ? GUESS_VERDICTS : [];
  if (!allowed.includes(value.verdict)) {
    throw new TurtleSoupError('JUDGE_INVALID_OUTPUT', 'Judge returned an unsupported result.');
  }
  return Object.freeze({ verdict: value.verdict });
}

module.exports = {
  ALL_VERDICTS,
  GUESS_VERDICTS,
  QUESTION_VERDICTS,
  parseJudgeOutput,
  validateJudgeResult,
};
