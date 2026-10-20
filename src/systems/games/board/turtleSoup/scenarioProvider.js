const fs = require('node:fs');
const path = require('node:path');
const { randomInt } = require('node:crypto');
const { TurtleSoupError } = require('./errors');
const { normalizeScenarioReference, validateScenario } = require('./scenarioSchema');

const INDEX_FILE_NAME = 'retrieval-index.v1.json';
const CORPUS_READY = 'CORPUS_READY';
const CORPUS_NOT_CONFIGURED = 'CORPUS_NOT_CONFIGURED';
// Each failure code names one thing an operator can fix. Only these tokens (never a path, a
// file name, or story text) may leave this module.
const CORPUS_ROOT_MISSING = 'CORPUS_ROOT_MISSING';
const CORPUS_INDEX_MISSING = 'CORPUS_INDEX_MISSING';
const CORPUS_PERMISSION_DENIED = 'CORPUS_PERMISSION_DENIED';
const CORPUS_EMPTY = 'CORPUS_EMPTY';
const CORPUS_UNAVAILABLE = 'CORPUS_UNAVAILABLE';
const CORPUS_INVALID = 'CORPUS_INVALID';
const CORPUS_FAILURE_CODES = new Set([
  CORPUS_ROOT_MISSING,
  CORPUS_INDEX_MISSING,
  CORPUS_PERMISSION_DENIED,
  CORPUS_EMPTY,
  CORPUS_UNAVAILABLE,
  CORPUS_INVALID,
]);

function isPathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

// Classifies a filesystem failure. The raw error is dropped on purpose: its message embeds the
// private corpus path, so only a stable code and a fixed message may escape.
function corpusFileError(error, { missingCode, message }) {
  const errno = error?.code;
  if (errno === 'ENOENT' || errno === 'ENOTDIR') {
    return new TurtleSoupError(missingCode, message, { retryable: true });
  }
  if (errno === 'EACCES' || errno === 'EPERM') {
    return new TurtleSoupError(CORPUS_PERMISSION_DENIED, 'Turtle soup corpus is not readable.', { retryable: true });
  }
  return new TurtleSoupError(CORPUS_UNAVAILABLE, message, { retryable: true });
}

function getRealRoot(rootDir) {
  let realRoot;
  try {
    realRoot = fs.realpathSync(path.resolve(rootDir));
    if (!fs.statSync(realRoot).isDirectory()) {
      throw new TurtleSoupError(CORPUS_ROOT_MISSING, 'Turtle soup corpus root is not a directory.', { retryable: true });
    }
  } catch (error) {
    if (error instanceof TurtleSoupError) throw error;
    throw corpusFileError(error, { missingCode: CORPUS_ROOT_MISSING, message: 'Turtle soup corpus root is unavailable.' });
  }
  return realRoot;
}

function walkJsonFiles(rootDir) {
  const result = [];
  const visit = (directory) => {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error) {
      throw corpusFileError(error, { missingCode: CORPUS_UNAVAILABLE, message: 'Turtle soup corpus directory is unavailable.' });
    }
    for (const entry of entries) {
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
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    // Unreadable is not the same as corrupt: report permissions and vanished files separately.
    throw corpusFileError(error, { missingCode: CORPUS_UNAVAILABLE, message: 'Scenario document is unavailable.' });
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new TurtleSoupError(CORPUS_INVALID, 'Scenario document could not be read.');
  }
  return validateScenario(parsed);
}

function readIndexFile(indexFile) {
  let text;
  try {
    text = fs.readFileSync(indexFile, 'utf8');
  } catch (error) {
    throw corpusFileError(error, { missingCode: CORPUS_INDEX_MISSING, message: 'Turtle soup index is unavailable.' });
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TurtleSoupError(CORPUS_INVALID, 'Scenario index is invalid.');
  }
}

// Replaces the index atomically (temporary file, then rename). Any failure is classified like the
// reads above, so a read-only corpus reports a permission problem instead of a corrupt one.
function writeIndexFile(index, indexFile) {
  const outputPath = path.resolve(indexFile);
  try {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporaryPath = `${outputPath}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(index, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, outputPath);
  } catch (error) {
    throw corpusFileError(error, { missingCode: CORPUS_UNAVAILABLE, message: 'Turtle soup index could not be written.' });
  }
}

// A corpus with no scenarios is refused (CORPUS_EMPTY) before anything is written, so an empty or
// misplaced directory can never overwrite a good index. A caller that really wants an empty index
// must say so with `allowEmpty: true`.
function buildScenarioIndex({ rootDir, indexFile = path.join(rootDir, INDEX_FILE_NAME), write = true, allowEmpty = false }) {
  const realRoot = getRealRoot(rootDir);
  const entries = [];
  const references = new Set();

  for (const filePath of walkJsonFiles(realRoot)) {
    let realFile;
    try {
      realFile = fs.realpathSync(filePath);
    } catch (error) {
      throw corpusFileError(error, { missingCode: CORPUS_UNAVAILABLE, message: 'Scenario document is unavailable.' });
    }
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

  if (!allowEmpty && !entries.length) {
    throw new TurtleSoupError(CORPUS_EMPTY, 'Turtle soup corpus contains no scenarios.');
  }
  entries.sort((left, right) => left.id.localeCompare(right.id) || left.version - right.version);
  const index = { schemaVersion: 1, scenarios: entries };
  if (write) writeIndexFile(index, indexFile);
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
  const entries = validateIndex(readIndexFile(indexFile));
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
      } catch (error) {
        throw corpusFileError(error, { missingCode: CORPUS_UNAVAILABLE, message: 'Scenario document is unavailable.' });
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

function corpusReadiness(ready, code, scenarioCount = 0) {
  return Object.freeze({ ready, code, scenarioCount });
}

// Known corpus failures keep their specific code; anything unexpected (a schema mismatch, a
// stale index entry, a bug) is reported as invalid content rather than guessed at.
function normalizeReadinessError(error) {
  return CORPUS_FAILURE_CODES.has(error?.code) ? error.code : CORPUS_INVALID;
}

function prepareFileScenarioProvider({ rootDir } = {}) {
  const configuredRoot = typeof rootDir === 'string' ? rootDir.trim() : '';
  if (!configuredRoot) {
    return Object.freeze({
      provider: null,
      readiness: corpusReadiness(false, CORPUS_NOT_CONFIGURED),
    });
  }

  try {
    const provider = createFileScenarioProvider({ rootDir: configuredRoot });
    const references = provider.listScenarioReferences();
    if (!references.length) {
      return Object.freeze({
        provider: null,
        readiness: corpusReadiness(false, CORPUS_EMPTY),
      });
    }

    // Validate every indexed document before exposing the provider to the runtime.
    // Only the count and a stable status code leave this module.
    for (const reference of references) provider.loadScenario(reference);
    return Object.freeze({
      provider,
      readiness: corpusReadiness(true, CORPUS_READY, references.length),
    });
  } catch (error) {
    return Object.freeze({
      provider: null,
      readiness: corpusReadiness(false, normalizeReadinessError(error)),
    });
  }
}

module.exports = {
  CORPUS_EMPTY,
  CORPUS_INDEX_MISSING,
  CORPUS_INVALID,
  CORPUS_NOT_CONFIGURED,
  CORPUS_PERMISSION_DENIED,
  CORPUS_READY,
  CORPUS_ROOT_MISSING,
  CORPUS_UNAVAILABLE,
  INDEX_FILE_NAME,
  buildScenarioIndex,
  createFileScenarioProvider,
  getRealRoot,
  normalizeReadinessError,
  prepareFileScenarioProvider,
};
