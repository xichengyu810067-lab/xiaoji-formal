const path = require('node:path');
const { TurtleSoupError } = require('./errors');
const {
  CORPUS_INVALID,
  INDEX_FILE_NAME,
  buildScenarioIndex,
  createFileScenarioProvider,
  getRealRoot,
  normalizeReadinessError,
} = require('./scenarioProvider');

function buildAndVerifyScenarioIndex({ rootDir }) {
  // Same classification as the runtime: a missing root, a permission problem, and so on each
  // get their own code instead of one catch-all.
  const canonicalRoot = getRealRoot(rootDir);
  const indexFile = path.join(canonicalRoot, INDEX_FILE_NAME);
  // An empty corpus is refused (CORPUS_EMPTY) before anything is written.
  const index = buildScenarioIndex({ rootDir: canonicalRoot, indexFile, allowEmpty: false });
  const provider = createFileScenarioProvider({ rootDir: canonicalRoot, indexFile });
  const references = provider.listScenarioReferences();
  for (const reference of references) provider.loadScenario(reference);
  if (references.length !== index.scenarios.length) {
    throw new TurtleSoupError(CORPUS_INVALID, 'Turtle soup index verification count did not match.');
  }
  return Object.freeze({ rootDir: canonicalRoot, indexFile, scenarioCount: references.length });
}

// Prints only a count on success and only a status code on failure: never a path, a file name,
// or any scenario text.
function main(argv = process.argv.slice(2), output = console) {
  if (argv.length !== 1 || !String(argv[0] || '').trim()) {
    output.error('Usage: node src/games/turtleSoup/buildIndexCli.js <private-corpus-root>');
    return 1;
  }
  try {
    const result = buildAndVerifyScenarioIndex({ rootDir: argv[0] });
    output.log(`Turtle soup private index verified: ${result.scenarioCount} scenarios.`);
    return 0;
  } catch (error) {
    output.error(`Turtle soup private index failed: ${normalizeReadinessError(error)}.`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { buildAndVerifyScenarioIndex, main };
