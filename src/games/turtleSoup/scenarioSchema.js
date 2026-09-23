const { TurtleSoupError } = require('./errors');

const SCENARIO_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u;
const DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

function assertPlainObject(value, code, message) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TurtleSoupError(code, message);
  }
}

function normalizeScenarioReference(scenarioId, scenarioVersion) {
  const id = String(scenarioId || '').trim();
  if (!SCENARIO_ID_PATTERN.test(id)) {
    throw new TurtleSoupError('INVALID_SCENARIO_REFERENCE', 'Scenario reference is invalid.');
  }
  if (!Number.isSafeInteger(scenarioVersion) || scenarioVersion < 1) {
    throw new TurtleSoupError('INVALID_SCENARIO_REFERENCE', 'Scenario version is invalid.');
  }
  return { scenarioId: id, scenarioVersion };
}

function validateText(value, label, { allowEmpty = false, maxLength = 20000 } = {}) {
  if (typeof value !== 'string' || value.length > maxLength || (!allowEmpty && !value.trim())) {
    throw new TurtleSoupError('CORPUS_INVALID', `${label} is invalid.`);
  }
  return value;
}

function validateStringArray(value, label, maxItems = 100) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new TurtleSoupError('CORPUS_INVALID', `${label} is invalid.`);
  }
  return value.map((item, index) => validateText(item, `${label}[${index}]`, { maxLength: 500 }));
}

function validateScenario(value) {
  assertPlainObject(value, 'CORPUS_INVALID', 'Scenario document is invalid.');
  const reference = normalizeScenarioReference(value.id, value.version);
  if (value.schemaVersion !== 1 || value.locale !== 'zh-TW' || !DIFFICULTIES.has(value.difficulty)) {
    throw new TurtleSoupError('CORPUS_INVALID', 'Scenario metadata is invalid.');
  }
  if (!Array.isArray(value.facts) || value.facts.length < 1 || value.facts.length > 100) {
    throw new TurtleSoupError('CORPUS_INVALID', 'Scenario facts are invalid.');
  }

  const factIds = new Set();
  const facts = value.facts.map((fact, index) => {
    assertPlainObject(fact, 'CORPUS_INVALID', `facts[${index}] is invalid.`);
    const id = validateText(fact.id, `facts[${index}].id`, { maxLength: 80 }).trim();
    if (!SCENARIO_ID_PATTERN.test(id) || factIds.has(id)) {
      throw new TurtleSoupError('CORPUS_INVALID', 'Scenario fact identifiers are invalid.');
    }
    factIds.add(id);
    return Object.freeze({
      id,
      statement: validateText(fact.statement, `facts[${index}].statement`, { maxLength: 4000 }),
      keywords: Object.freeze(validateStringArray(fact.keywords, `facts[${index}].keywords`, 50)),
    });
  });

  const solutionFactIds = validateStringArray(value.solutionFactIds, 'solutionFactIds', 100);
  if (!solutionFactIds.length || new Set(solutionFactIds).size !== solutionFactIds.length ||
      solutionFactIds.some((id) => !factIds.has(id))) {
    throw new TurtleSoupError('CORPUS_INVALID', 'Scenario solution facts are invalid.');
  }

  if (!Array.isArray(value.contradictions) || value.contradictions.length > 100) {
    throw new TurtleSoupError('CORPUS_INVALID', 'Scenario contradictions are invalid.');
  }
  const contradictionIds = new Set();
  const contradictions = value.contradictions.map((entry, index) => {
    assertPlainObject(entry, 'CORPUS_INVALID', `contradictions[${index}] is invalid.`);
    const id = validateText(entry.id, `contradictions[${index}].id`, { maxLength: 80 }).trim();
    if (!SCENARIO_ID_PATTERN.test(id) || contradictionIds.has(id)) {
      throw new TurtleSoupError('CORPUS_INVALID', 'Scenario contradiction identifiers are invalid.');
    }
    contradictionIds.add(id);
    return Object.freeze({
      id,
      statement: validateText(entry.statement, `contradictions[${index}].statement`, { maxLength: 4000 }),
    });
  });

  return Object.freeze({
    schemaVersion: 1,
    id: reference.scenarioId,
    version: reference.scenarioVersion,
    locale: 'zh-TW',
    difficulty: value.difficulty,
    title: validateText(value.title, 'title', { maxLength: 500 }),
    publicPrompt: validateText(value.publicPrompt, 'publicPrompt', { maxLength: 10000 }),
    revealText: validateText(value.revealText, 'revealText', { maxLength: 20000 }),
    facts: Object.freeze(facts),
    solutionFactIds: Object.freeze(solutionFactIds),
    contradictions: Object.freeze(contradictions),
    tags: Object.freeze(validateStringArray(value.tags, 'tags', 100)),
  });
}

module.exports = {
  SCENARIO_ID_PATTERN,
  normalizeScenarioReference,
  validateScenario,
};
