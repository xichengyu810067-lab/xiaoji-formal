const { TurtleSoupError } = require('./errors');

const MAX_INPUT_LENGTH = 1200;
const MAX_QUESTION_EVIDENCE = 4;
const UNSAFE_INSTRUCTION_PATTERNS = [
  /忽略(?:先前|上面|所有|系統)?(?:的)?(?:規則|指令|限制)/iu,
  /(?:顯示|列出|洩漏|輸出|告訴我).{0,12}(?:完整)?(?:湯底|全部(?:故事|腳本)|系統提示|system prompt)/iu,
  /(?:切換|扮演|改成).{0,12}(?:system|developer|assistant|管理員|另一題)/iu,
  /(?:讀取|改用|載入).{0,12}(?:其他|另一)(?:篇|題|故事)/iu,
];

function normalizeJudgeInput(value) {
  const text = String(value || '').replace(/[\u0000-\u001f\u007f]/gu, ' ').replace(/\s+/gu, ' ').trim();
  if (!text || text.length > MAX_INPUT_LENGTH) {
    throw new TurtleSoupError('INVALID_JUDGE_INPUT', 'Question or guess is invalid.');
  }
  return text;
}

function isUnsafeInstruction(value) {
  const text = normalizeJudgeInput(value);
  return UNSAFE_INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text));
}

function tokenize(value) {
  const normalized = String(value || '').normalize('NFKC').toLocaleLowerCase('zh-TW');
  const tokens = new Set(normalized.match(/[\p{Script=Han}]{1,4}|[a-z0-9]{2,}/gu) || []);
  const hanRuns = normalized.match(/[\p{Script=Han}]+/gu) || [];
  for (const run of hanRuns) {
    for (let index = 0; index < run.length - 1; index += 1) tokens.add(run.slice(index, index + 2));
  }
  return tokens;
}

function scoreEvidence(inputText, statement, keywords = []) {
  const input = inputText.normalize('NFKC').toLocaleLowerCase('zh-TW');
  const inputTokens = tokenize(input);
  const evidenceTokens = tokenize(`${statement} ${keywords.join(' ')}`);
  let score = 0;
  for (const keyword of keywords) {
    const normalizedKeyword = String(keyword).normalize('NFKC').toLocaleLowerCase('zh-TW').trim();
    if (normalizedKeyword && input.includes(normalizedKeyword)) score += 5;
  }
  for (const token of inputTokens) if (evidenceTokens.has(token)) score += token.length >= 2 ? 2 : 1;
  return score;
}

function retrieveEvidence(scenario, input, kind) {
  const text = normalizeJudgeInput(input);
  if (!['question', 'guess'].includes(kind)) {
    throw new TurtleSoupError('INVALID_JUDGE_INPUT', 'Judgment kind is invalid.');
  }

  const solutionIds = new Set(scenario.solutionFactIds);
  const candidates = [
    ...scenario.facts.map((fact) => ({
      id: fact.id,
      statement: fact.statement,
      source: 'fact',
      solution: solutionIds.has(fact.id),
      score: scoreEvidence(text, fact.statement, fact.keywords),
    })),
    ...scenario.contradictions.map((entry) => ({
      id: entry.id,
      statement: entry.statement,
      source: 'contradiction',
      solution: false,
      score: scoreEvidence(text, entry.statement),
    })),
  ];

  let selected;
  if (kind === 'guess') {
    selected = candidates.filter((entry) => entry.solution || entry.score > 0);
  } else {
    selected = candidates.filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, MAX_QUESTION_EVIDENCE);
  }

  return Object.freeze(selected.map(({ id, statement, source, solution }) => Object.freeze({ id, statement, source, solution })));
}

module.exports = {
  MAX_INPUT_LENGTH,
  isUnsafeInstruction,
  normalizeJudgeInput,
  retrieveEvidence,
  tokenize,
};
