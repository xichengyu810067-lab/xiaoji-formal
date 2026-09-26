const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { TurtleSoupError } = require('./errors');
const { normalizeScenarioReference, validateScenario } = require('./scenarioSchema');

const INDEX_FILE_NAME = 'retrieval-index.v1.json';

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function getRealRoot(rootDir) {
  const resolved = path.resolve(rootDir);
  try {
    return fs.realpathSync(resolved);
  } catch {
    throw new TurtleSoupError('CORPUS_UNAVAILABLE', 'Turtle soup corpus is unavailable.', { retryable: true });
  }
}

function walkJsonFiles(rootDir) {
  const result = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolutePath = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(absolutePath);
      else if (entry.isFile() && entry.name.endsWith('.json') &&
               entry.name !== 'manifest.json' && entry.name !== INDEX_FILE_NAME) result.push(absolutePath);
    }
  };
  visit(rootDir);
  return result.sort();
}

function readScenarioFile(filePath) {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    throw new TurtleSoupError('CORPUS_INVALID', 'Scenario document could not be read.');
  }
  return validateScenario(parsed);
}

function buildScenarioIndex({ rootDir, indexFile = path.join(rootDir, INDEX_FILE_NAME), write = true }) {
  const realRoot = getRealRoot(rootDir);
  const entries = [];
  const references = new Set();

  for (const filePath of walkJsonFiles(realRoot)) {
    const realFile = fs.realpathSync(filePath);
    if (!isPathInside(realRoot, realFile)) {
      throw new TurtleSoupError('CORPUS_INVALID', 'Scenario document escaped the corpus root.');
    }
    const scenario = readScenarioFile(realFile);
    const key = `${scenario.id}@${scenario.version}`;
    if (references.has(key)) {
      throw new TurtleSoupError('CORPUS_INVALID', 'Duplicate scenario reference detected.');
    }
    references.add(key);
    entries.push({ id: scenario.id, version: scenario.version, relativePath: path.relative(realRoot, realFile).replaceAll('\\', '/') });
  }

  entries.sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version);
  const index = { schemaVersion: 1, scenarios: entries };
  if (write) {
    const outputPath = path.resolve(indexFile);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, outputPath);
  }
  return index;
}

function validateIndex(index) {
  if (!index || index.schemaVersion !== 1 || !Array.isArray(index.scenarios)) {
    throw new TurtleSoupError('CORPUS_INVALID', 'Scenario index is invalid.');
  }
  const entries = new Map();
  for (const entry of index.scenarios) {
    const reference = normalizeScenarioReference(entry?.id, entry?.version);
    if (typeof entry.relativePath !== 'string' || !entry.relativePath || path.isAbsolute(entry.relativePath)) {
      throw new TurtleSoupError('CORPUS_INVALID', 'Scenario index path is invalid.');
    }
    const key = `${reference.scenarioId}@${reference.scenarioVersion}`;
    if (entries.has(key)) throw new TurtleSoupError('CORPUS_INVALID', 'Scenario index contains duplicate references.');
    entries.set(key, entry.relativePath);
  }
  return entries;
}

function createFileScenarioProvider({ rootDir, indexFile = path.join(rootDir, INDEX_FILE_NAME) }) {
  const realRoot = getRealRoot(rootDir);
  let index;
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
  } catch {
    throw new TurtleSoupError('CORPUS_UNAVAILABLE', 'Turtle soup index is unavailable.', { retryable: true });
  }
  const entries = validateIndex(index);
  const references = Object.freeze([...entries.keys()].map((key) => {
    const separator = key.lastIndexOf('@');
    return Object.freeze({ scenarioId: key.slice(0, separator), scenarioVersion: Number(key.slice(separator + 1)) });
  }));

  return Object.freeze({
    listScenarioReferences() {
      return references.map((reference) => ({ ...reference }));
    },
    selectScenarioReference({ randomInteger = randomInt } = {}) {
      if (!references.length) {
        throw new TurtleSoupError('CORPUS_UNAVAILABLE', 'Turtle soup corpus contains no scenarios.', { retryable: true });
      }
      const selectedIndex = randomInteger(references.length);
      if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= references.length) {
        throw new TurtleSoupError('CORPUS_INVALID', 'Scenario selector returned an invalid index.');
      }
      return { ...references[selectedIndex] };
    },
    loadScenario({ scenarioId, scenarioVersion }) {
      const reference = normalizeScenarioReference(scenarioId, scenarioVersion);
      const relativePath = entries.get(`${reference.scenarioId}@${reference.scenarioVersion}`);
      if (!relativePath) {
        const hasOtherVersion = [...entries.keys()].some((key) => key.startsWith(`${reference.scenarioId}@`));
        throw new TurtleSoupError(
          hasOtherVersion ? 'SCENARIO_VERSION_MISMATCH' : 'SCENARIO_NOT_FOUND',
          hasOtherVersion ? 'Scenario version does not match the session.' : 'Scenario was not found.'
        );
      }
      const candidate = path.resolve(realRoot, relativePath);
      if (!isPathInside(realRoot, candidate)) {
        throw new TurtleSoupError('CORPUS_INVALID', 'Scenario index path escaped the corpus root.');
      }
      let realFile;
      try {
        realFile = fs.realpathSync(candidate);
      } catch {
        throw new TurtleSoupError('CORPUS_UNAVAILABLE', 'Scenario document is unavailable.', { retryable: true });
      }
      if (!isPathInside(realRoot, realFile)) {
        throw new TurtleSoupError('CORPUS_INVALID', 'Scenario document escaped the corpus root.');
      }
      const scenario = readScenarioFile(realFile);
      if (scenario.id !== reference.scenarioId || scenario.version !== reference.scenarioVersion) {
        throw new TurtleSoupError('SCENARIO_VERSION_MISMATCH', 'Scenario document does not match the session.');
      }
      return scenario;
    },
  });
}

module.exports = {
  INDEX_FILE_NAME,
  buildScenarioIndex,
  createFileScenarioProvider,
};
