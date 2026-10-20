'use strict';

// Reads the sentence lists of a corpus test file (they are constants inside the test module, not exports) without
// running its tests: node:test is replaced by a no-op, the names to export are appended, and the source is compiled
// as a virtual module at its real path, so its relative requires resolve as usual. Nothing is written to src or test.
// The test modules create a temporary data folder for themselves; those folders are removed by dispose(), and the
// data-root variable they set is put back as it was.

const Module = require('node:module');
const fs = require('node:fs');
const path = require('node:path');

const NO_OP_TEST_MODULE = `(() => {
  const noop = () => {};
  const testStub = noop;
  testStub.after = (callback) => { globalThis.__corpusLoaderCleanups.push(callback); };
  for (const name of ['before', 'todo', 'skip', 'only', 'describe', 'it', 'afterEach', 'beforeEach', 'mock']) testStub[name] = noop;
  return testStub;
})()`;

function loadCorpusConstants(testFile, exportNames) {
  const file = path.resolve(testFile);
  const original = fs.readFileSync(file, 'utf8');
  if (!original.includes("require('node:test')")) throw new Error(`Not a node:test file: ${path.basename(file)}`);
  const source = `${original.replace("require('node:test')", NO_OP_TEST_MODULE)}\nmodule.exports = { ${exportNames.join(', ')} };\n`;

  const previousRoot = process.env.XIAOJI_TEST_DATA_ROOT;
  const previousCleanups = globalThis.__corpusLoaderCleanups;
  const cleanups = [];
  globalThis.__corpusLoaderCleanups = cleanups;
  try {
    const virtualModule = new Module(file, null);
    virtualModule.filename = file;
    virtualModule.paths = Module._nodeModulePaths(path.dirname(file));
    virtualModule._compile(source, file);
    return {
      constants: virtualModule.exports,
      dispose() {
        for (const cleanup of cleanups.splice(0)) {
          try { cleanup(); } catch { /* a leftover temporary folder is harmless */ }
        }
      },
    };
  } finally {
    if (previousRoot === undefined) delete process.env.XIAOJI_TEST_DATA_ROOT; else process.env.XIAOJI_TEST_DATA_ROOT = previousRoot;
    if (previousCleanups === undefined) delete globalThis.__corpusLoaderCleanups; else globalThis.__corpusLoaderCleanups = previousCleanups;
  }
}

// The lists the second-opinion tests and the evaluation tool need, from the three corpus test files.
function loadReplyCorpora(testDirectory) {
  const loads = [
    loadCorpusConstants(path.join(testDirectory, 'aiPolicyNegativeCorpus.test.js'), ['ORDINARY_GROUPS']),
    loadCorpusConstants(path.join(testDirectory, 'aiPolicyAttackCorpus.test.js'), ['ATTACK_GROUPS', 'VARIANTS']),
    loadCorpusConstants(path.join(testDirectory, 'aiConfidentialityCorpus.test.js'), ['REPLY_BLOCK', 'REPLY_ALLOW']),
  ];
  const [negative, attack, confidentiality] = loads.map((load) => load.constants);
  return {
    ORDINARY_GROUPS: negative.ORDINARY_GROUPS,
    ATTACK_GROUPS: attack.ATTACK_GROUPS,
    VARIANTS: attack.VARIANTS,
    REPLY_BLOCK: confidentiality.REPLY_BLOCK,
    REPLY_ALLOW: confidentiality.REPLY_ALLOW,
    dispose() { for (const load of loads) load.dispose(); },
  };
}

module.exports = { loadCorpusConstants, loadReplyCorpora };
