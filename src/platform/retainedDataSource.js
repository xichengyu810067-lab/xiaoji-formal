'use strict';

const fs = require('node:fs');
const path = require('node:path');

const defaultRoot = path.resolve(__dirname, '..', '..');
let configuredRoot = null;
let resolved = false;

function identity(value) {
  const normalized = path.resolve(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

// A verified launcher may keep the stores outside the program folder and name that folder before any store
// loads. There is deliberately no environment-variable override: only the launcher's command line (below) or
// code that runs first (the tests) can name it.
function configureRetainedDataSourceRoot(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) {
    throw new Error('Retained data source must be an absolute directory.');
  }
  const absolute = path.resolve(root);
  const stat = fs.lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || identity(fs.realpathSync(absolute)) !== identity(absolute)) {
    throw new Error('Retained data source must be a real directory without links.');
  }
  if (configuredRoot !== null) throw new Error('Retained data source cannot be reconfigured.');
  if (resolved) throw new Error('Retained data source must be configured before stores load.');
  configuredRoot = absolute;
  return configuredRoot;
}

// A host launcher may keep the JSON stores in a folder of its own, outside
// the program folder, so a new release folder does not start without them, and passes it to src/index.js as
// --retained-data-root=<absolute folder> (the stores are then in <folder>/src/data, as in a program folder). Given
// once at most; a folder that is not absolute, not real or a link stops the start. Without it the stores stay in
// this program folder's src/data, as before. The result is the configured folder, or null.
const ROOT_ARGUMENT = '--retained-data-root=';

function configureRetainedDataSourceRootFromArgs(args = []) {
  const values = (Array.isArray(args) ? args : [])
    .filter((argument) => typeof argument === 'string' && argument.startsWith(ROOT_ARGUMENT))
    .map((argument) => argument.slice(ROOT_ARGUMENT.length));
  if (values.length === 0) return null;
  if (values.length > 1) throw new Error('Retained data source can be given only once.');
  return configureRetainedDataSourceRoot(values[0]);
}

function getRetainedDataSourceRoot() {
  resolved = true;
  return configuredRoot || defaultRoot;
}

function retainedDataFile(name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*\.json$/u.test(name)) {
    throw new Error('Retained data filename must be a plain JSON filename.');
  }
  if (process.env.XIAOJI_RUNTIME_MODE === 'test-control') {
    const testRoot = String(process.env.XIAOJI_TEST_DATA_ROOT || '').trim();
    if (!path.isAbsolute(testRoot)) throw new Error('Test-control data root must be absolute.');
    return path.join(testRoot, name);
  }
  return path.join(getRetainedDataSourceRoot(), 'src', 'data', name);
}

module.exports = {
  ROOT_ARGUMENT,
  configureRetainedDataSourceRoot,
  configureRetainedDataSourceRootFromArgs,
  getRetainedDataSourceRoot,
  retainedDataFile,
};
