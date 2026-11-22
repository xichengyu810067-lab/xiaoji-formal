'use strict';

// The content of the daily riddle and the daily discussion, written by Claude instead of taken from the fixed corpus
// (dailyRiddleCorpus.js, dailyDiscussionCorpus.js), one piece a day shared by every server.
//
// - One riddle and one discussion topic a day (Taipei date), the same in every server: the first server whose event is
//   claimed asks Claude, the others get what was written. A riddle carries its answer, the answers that also count and
//   a short explanation; a topic is one open question.
// - What Claude writes is checked before it is used (checkRiddle, checkTopic): the length and shape, plain text only
//   (no link, mention, markup or line break), not naming an AI provider, not the same as a recent day's or a corpus
//   entry, and for a riddle an answer that is short and not given away by the question. A piece that fails the check,
//   or a call that fails, is asked again, up to MAX_GENERATION_ATTEMPTS times in all; only when every attempt failed
//   (or Claude is not configured) is the day's corpus entry used, so the event still runs.
// - What was decided for a day, written or from the corpus, is kept in dailyGeneratedContent.json in the retained data
//   folder and written at once, so a restart, a later claim or the answer post later that day finds the same piece,
//   and Claude is asked at most once a day per kind whatever happens. Without Claude configured the corpus entry of the
//   day is used and nothing is written (the corpus pick depends on the date only). The last KEEP_DAYS days are kept; they are also
//   what Claude is told not to repeat.
// - Nothing about any member or server is sent to Claude: only the kind of content, the date and the recent questions.
//   The calls do not count against any server's AI quota, because the content belongs to no server.

const { createRetainedJsonFile } = require('../../../platform/retainedJsonFile');
const { retainedDataFile } = require('../../../platform/retainedDataSource');
const { getAnthropicClient, getAnthropicModel, recordClaudeOutcome } = require('../../conversation/provider');
const defaultLogger = require('../../../utils/logger');
const riddleCorpus = require('./dailyRiddleCorpus');
const discussionCorpus = require('./dailyDiscussionCorpus');

const FILE_NAME = 'dailyGeneratedContent.json';
const DOCUMENT_VERSION = 1;
const KINDS = Object.freeze(['riddle', 'discussion']);
const MAX_GENERATION_ATTEMPTS = 3;
const GENERATION_TIMEOUT_MS = 30_000;
const KEEP_DAYS = 60;
const RECENT_IN_PROMPT = 30;
const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const GENERATED_ID = Object.freeze({ riddle: /^gr\d{8}$/u, discussion: /^gd\d{8}$/u });
const ID_PREFIX = Object.freeze({ riddle: 'gr', discussion: 'gd' });

const LIMITS = Object.freeze({
  question: Object.freeze({ min: 6, max: 120 }),
  answer: Object.freeze({ min: 1, max: 12 }),
  aliases: 5,
  explanation: Object.freeze({ min: 4, max: 160 }),
  topic: Object.freeze({ min: 12, max: 80 }),
});

// Plain text only: no link of any kind, mention, channel or role reference, markup, code or control character.
const FORBIDDEN_TEXT = /https?:|www\.|discord\.(?:gg|com)|[a-z0-9-]+\.(?:com|net|org|io|gg|tw|cn|me)\b|[@<>#`*_~|\\[\]{}]|[\u0000-\u001f\u007f]/iu;
// The bot never names the AI service behind it (disclosurePolicy.js); a generated piece that does is not used.
const PROVIDER_NAMES = /claude|anthropic|openai|chatgpt|gpt|groq|gemini|llama|人工智慧模型|語言模型/iu;
const HAN = /\p{Script=Han}/u;

const RIDDLE_PROMPT = [
  '你為一個台灣 Discord 社群出每日猜謎題。請出一題「答案明確、唯一、簡短」的繁體中文謎語或生活常識題，適合所有年齡，',
  '不涉及政治、宗教、暴力、色情、歧視、真實人物或時事，不需要上網查詢就能作答。',
  '答案必須是 1 到 12 個字的名詞或數字，不能出現在題目裡；另外列出最多 5 個也算正確的寫法（同義詞、數字的中文寫法）。',
  '解說用一兩句話說明為什麼是這個答案。',
  '只回答一個 JSON 物件，不要有其他文字：{"question": "題目", "answer": "答案", "aliases": ["也算對的寫法"], "explanation": "解說"}',
].join('\n');

const DISCUSSION_PROMPT = [
  '你為一個台灣 Discord 社群出每日討論題。請出一個繁體中文的開放式問題，讓不同背景的人都能分享經驗與看法，',
  '主題可以是生活、學習、興趣、科技使用、社群相處或城市生活；不涉及政治立場、宗教、暴力、色情、歧視、真實人物或時事爭議，',
  '沒有標準答案，不要求分享個人隱私。問題 12 到 80 個字，以問號結尾。',
  '只回答一個 JSON 物件，不要有其他文字：{"topic": "討論題"}',
].join('\n');

function normalizeForCompare(value) {
  return String(value ?? '').normalize('NFKC').toLocaleLowerCase('zh-TW').replace(/[\s\p{P}\p{S}]+/gu, '');
}

function cleanLine(value) {
  return typeof value === 'string' ? value.normalize('NFC').replace(/\s+/gu, ' ').trim() : '';
}

function withinLength(value, { min, max }) {
  const length = [...value].length;
  return length >= min && length <= max;
}

function plainText(value) {
  return !FORBIDDEN_TEXT.test(value) && !PROVIDER_NAMES.test(value);
}

// A written riddle as the riddle service uses it ({ question, canonicalAnswer, acceptedAliases, explanation }), or
// null with the reason it was not used.
function checkRiddle(raw, { recent = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { riddle: null, reason: 'shape' };
  const question = cleanLine(raw.question);
  const answer = cleanLine(raw.answer);
  const explanation = cleanLine(raw.explanation);
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.map(cleanLine).filter(Boolean) : [];
  if (!withinLength(question, LIMITS.question) || !withinLength(answer, LIMITS.answer) ||
      !withinLength(explanation, LIMITS.explanation) || aliases.length > LIMITS.aliases ||
      aliases.some((alias) => !withinLength(alias, LIMITS.answer))) return { riddle: null, reason: 'length' };
  if (!HAN.test(question) || !HAN.test(explanation)) return { riddle: null, reason: 'language' };
  if (![question, answer, explanation, ...aliases].every(plainText)) return { riddle: null, reason: 'content' };
  const normalizedAnswer = normalizeForCompare(answer);
  if (!normalizedAnswer) return { riddle: null, reason: 'length' };
  if (normalizeForCompare(question).includes(normalizedAnswer)) return { riddle: null, reason: 'answer_in_question' };
  const seen = new Set([...riddleCorpus.riddles.map((entry) => entry.question), ...recent].map(normalizeForCompare));
  if (seen.has(normalizeForCompare(question))) return { riddle: null, reason: 'repeated' };
  const acceptedAliases = [...new Set(aliases.filter((alias) => normalizeForCompare(alias) !== normalizedAnswer))];
  return { riddle: { question, canonicalAnswer: answer, acceptedAliases, explanation }, reason: null };
}

// A written topic as the discussion service uses it ({ question, safetyReminder }), or null with the reason.
function checkTopic(raw, { recent = [] } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { topic: null, reason: 'shape' };
  const question = cleanLine(raw.topic);
  if (!withinLength(question, LIMITS.topic) || !/[？?]$/u.test(question)) return { topic: null, reason: 'length' };
  if (!HAN.test(question)) return { topic: null, reason: 'language' };
  if (!plainText(question)) return { topic: null, reason: 'content' };
  const seen = new Set([...discussionCorpus.topics.map((entry) => entry.question), ...recent].map(normalizeForCompare));
  if (seen.has(normalizeForCompare(question))) return { topic: null, reason: 'repeated' };
  return { topic: { question, safetyReminder: discussionCorpus.safetyReminder }, reason: null };
}

function parseJsonObject(text) {
  const match = String(text || '').match(/\{[\s\S]*\}/u);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function textOf(response) {
  return (response?.content || []).filter((block) => block?.type === 'text').map((block) => block.text).join('');
}

function generatedId(kind, localDate) {
  return `${ID_PREFIX[kind]}${localDate.replace(/-/gu, '')}`;
}

function corpusEntryFor(kind, localDate) {
  return kind === 'riddle' ? riddleCorpus.selectRiddleForDate(localDate) : discussionCorpus.selectDiscussionForDate(localDate);
}

function corpusEntryById(kind, id) {
  const entries = kind === 'riddle' ? riddleCorpus.riddles : discussionCorpus.topics;
  return entries.find((entry) => entry.id === id) || null;
}

// The stored form of one day: { kind, localDate, source: 'claude', id, ...content } or { kind, localDate,
// source: 'corpus', id }. Anything else in the file is dropped when it is loaded.
function validEntry(entry) {
  if (!entry || typeof entry !== 'object' || !KINDS.includes(entry.kind) || !LOCAL_DATE.test(String(entry.localDate))) return null;
  if (entry.source === 'corpus') {
    return corpusEntryById(entry.kind, entry.id) ? { kind: entry.kind, localDate: entry.localDate, source: 'corpus', id: entry.id } : null;
  }
  if (entry.source !== 'claude' || entry.id !== generatedId(entry.kind, entry.localDate)) return null;
  if (entry.kind === 'riddle') {
    const { riddle } = checkRiddle({ question: entry.question, answer: entry.canonicalAnswer, aliases: entry.acceptedAliases,
      explanation: entry.explanation });
    return riddle ? { kind: 'riddle', localDate: entry.localDate, source: 'claude', id: entry.id, ...riddle } : null;
  }
  const { topic } = checkTopic({ topic: entry.question });
  return topic ? { kind: 'discussion', localDate: entry.localDate, source: 'claude', id: entry.id, question: topic.question } : null;
}

function freezeContent(entry) {
  if (entry.source === 'corpus') return corpusEntryById(entry.kind, entry.id);
  if (entry.kind === 'riddle') {
    return Object.freeze({
      id: entry.id,
      question: entry.question,
      canonicalAnswer: entry.canonicalAnswer,
      acceptedAliases: Object.freeze([...entry.acceptedAliases]),
      explanation: entry.explanation,
      generated: true,
    });
  }
  return Object.freeze({ id: entry.id, question: entry.question, safetyReminder: discussionCorpus.safetyReminder, generated: true });
}

function createDailyContentGenerator({
  filePath = null,
  logger = defaultLogger,
  clientFactory = getAnthropicClient,
  modelFactory = getAnthropicModel,
  recordOutcome = recordClaudeOutcome,
  maxAttempts = MAX_GENERATION_ATTEMPTS,
  ...fileOptions
} = {}) {
  const file = createRetainedJsonFile({
    name: 'DAILY_GENERATED_CONTENT',
    resolvePath: () => filePath ?? retainedDataFile(FILE_NAME),
    logger,
    ...fileOptions,
  });
  // `${kind}:${localDate}` -> stored entry, in date order once loaded.
  const entries = new Map();
  const inFlight = new Map();
  let loaded = false;

  const keyOf = (kind, localDate) => `${kind}:${localDate}`;

  function absorb(document) {
    for (const entry of document) if (!entries.has(keyOf(entry.kind, entry.localDate))) entries.set(keyOf(entry.kind, entry.localDate), entry);
  }

  function ensureLoaded() {
    if (loaded) return;
    loaded = true;
    const result = file.load((value) => {
      if (!value || value.version !== DOCUMENT_VERSION || !Array.isArray(value.entries)) return null;
      return value.entries.map(validEntry).filter(Boolean);
    }, { merge: absorb });
    if (result?.state === 'loaded') absorb(result.value);
  }

  function prune() {
    for (const kind of KINDS) {
      const dates = [...entries.values()].filter((entry) => entry.kind === kind).map((entry) => entry.localDate).sort();
      for (const localDate of dates.slice(0, Math.max(0, dates.length - KEEP_DAYS))) entries.delete(keyOf(kind, localDate));
    }
  }

  function remember(entry) {
    entries.set(keyOf(entry.kind, entry.localDate), entry);
    prune();
    file.markDirty(() => ({
      version: DOCUMENT_VERSION,
      entries: [...entries.values()].sort((left, right) => left.localDate.localeCompare(right.localDate) ||
        left.kind.localeCompare(right.kind)),
    }));
    // Written at once: a server may already have its event under this ID.
    file.flush();
  }

  function recentQuestions(kind) {
    return [...entries.values()]
      .filter((entry) => entry.kind === kind && entry.source === 'claude')
      .sort((left, right) => right.localDate.localeCompare(left.localDate))
      .slice(0, RECENT_IN_PROMPT)
      .map((entry) => entry.question);
  }

  async function ask(kind, localDate, client, recent) {
    const avoid = recent.length ? `\n最近出過的題目（不要重複，也不要只是換句話說）：\n${recent.map((item) => `- ${item}`).join('\n')}` : '';
    const response = await recordOutcome(() => client.messages.create({
      model: modelFactory(),
      max_tokens: 600,
      system: kind === 'riddle' ? RIDDLE_PROMPT : DISCUSSION_PROMPT,
      messages: [{ role: 'user', content: `日期：${localDate}${avoid}` }],
      output_config: { effort: 'low' },
    }, { signal: AbortSignal.timeout(GENERATION_TIMEOUT_MS) }));
    if (response?.stop_reason === 'refusal') return { content: null, reason: 'refusal' };
    const parsed = parseJsonObject(textOf(response));
    if (kind === 'riddle') {
      const { riddle, reason } = checkRiddle(parsed, { recent });
      return { content: riddle, reason };
    }
    const { topic, reason } = checkTopic(parsed, { recent });
    return { content: topic, reason };
  }

  async function decide(kind, localDate) {
    let client = null;
    try { client = clientFactory(); } catch { client = null; }
    if (client) {
      const recent = recentQuestions(kind);
      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        let outcome;
        try {
          outcome = await ask(kind, localDate, client, recent);
        } catch (error) {
          outcome = { content: null, reason: `call_${String(error?.status || error?.code || 'failed').replace(/[^\w-]/gu, '').slice(0, 30)}` };
        }
        if (outcome.content) {
          const entry = { kind, localDate, source: 'claude', id: generatedId(kind, localDate), ...outcome.content };
          if (kind === 'riddle') entry.acceptedAliases = [...entry.acceptedAliases];
          delete entry.safetyReminder;
          logger.info(`[DAILY_CONTENT] code=DAILY_CONTENT_GENERATED kind=${kind} attempt=${attempt}`);
          return { entry, persist: true };
        }
        logger.warn(`[DAILY_CONTENT] code=DAILY_CONTENT_REJECTED kind=${kind} attempt=${attempt} reason=${outcome.reason}`);
      }
    }
    const entry = { kind, localDate, source: 'corpus', id: corpusEntryFor(kind, localDate).id };
    if (!client) return { entry, persist: false };
    logger.warn(`[DAILY_CONTENT] code=DAILY_CONTENT_CORPUS kind=${kind} reason=attempts_exhausted`);
    return { entry, persist: true };
  }

  // The day's riddle or topic, written by Claude or from the corpus; the same every time it is asked for that day.
  async function contentForDate(kind, localDate) {
    if (!KINDS.includes(kind)) throw new TypeError('Unknown daily content kind.');
    if (!LOCAL_DATE.test(String(localDate))) throw new TypeError('localDate must use YYYY-MM-DD.');
    ensureLoaded();
    const key = keyOf(kind, localDate);
    if (entries.has(key)) return freezeContent(entries.get(key));
    if (!inFlight.has(key)) {
      // Without Claude the corpus entry of the day is used and nothing is written: it is the same on every call.
      inFlight.set(key, decide(kind, localDate)
        .then(({ entry, persist }) => {
          if (!persist) return entry;
          if (!entries.has(key)) remember(entry);
          return entries.get(key);
        })
        .finally(() => inFlight.delete(key)));
    }
    return freezeContent(await inFlight.get(key));
  }

  // The riddle or topic an event was claimed with: a corpus ID, or the ID of a written one. null when it is neither.
  function contentForId(kind, id) {
    if (!KINDS.includes(kind)) throw new TypeError('Unknown daily content kind.');
    const value = String(id ?? '');
    if (!GENERATED_ID[kind].test(value)) return corpusEntryById(kind, value);
    ensureLoaded();
    const entry = [...entries.values()].find((candidate) => candidate.kind === kind && candidate.id === value);
    return entry ? freezeContent(entry) : null;
  }

  return Object.freeze({ contentForDate, contentForId, flush: () => file.flush() });
}

let defaultGenerator = null;

function getDailyContentGenerator() {
  if (!defaultGenerator) defaultGenerator = createDailyContentGenerator();
  return defaultGenerator;
}

function setDailyContentGeneratorForTests(generator) {
  defaultGenerator = generator;
}

module.exports = {
  FILE_NAME,
  KEEP_DAYS,
  MAX_GENERATION_ATTEMPTS,
  checkRiddle,
  checkTopic,
  createDailyContentGenerator,
  getDailyContentGenerator,
  parseJsonObject,
  setDailyContentGeneratorForTests,
};
