const fs = require('node:fs');
const path = require('node:path');
const { TurtleSoupError } = require('./errors');
const { INDEX_FILE_NAME, buildScenarioIndex, createFileScenarioProvider } = require('./scenarioProvider');

function buildAndVerifyScenarioIndex({ rootDir }) {
  let canonicalRoot;
  try {
    canonicalRoot = fs.realpathSync(path.resolve(rootDir));
  } catch {
    throw new TurtleSoupError('CORPUS_UNAVAILABLE', 'Turtle soup corpus root is unavailable.', { retryable: true });
  }
  const indexFile = path.join(canonicalRoot, INDEX_FILE_NAME);
  const index = buildScenarioIndex({ rootDir: canonicalRoot, indexFile });
  const provider = createFileScenarioProvider({ rootDir: canonicalRoot, indexFile });
  const references = provider.listScenarioReferences();
  for (const reference of references) provider.loadScenario(reference);
  if (references.length !== index.scenarios.length) {
    throw new TurtleSoupError('CORPUS_INVALID', 'Turtle soup index verification count did not match.');
  }
  return Object.freeze({ rootDir: canonicalRoot, indexFile, scenarioCount: references.length });
}

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
    const code = error instanceof TurtleSoupError ? error.code : 'CORPUS_INVALID';
    output.error(`Turtle soup private index failed: ${code}.`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = { buildAndVerifyScenarioIndex, main };
