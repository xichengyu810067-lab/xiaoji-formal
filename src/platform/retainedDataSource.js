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

// A verified launcher may retain the previous release's data origin before
// loading any stores. There is deliberately no environment-variable override.
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

function getRetainedDataSourceRoot() {
  resolved = true;
  return configuredRoot || defaultRoot;
}

function retainedDataFile(name) {
  if (typeof name !== 'string' || !/^[A-Za-z][A-Za-z0-9-]*\.json$/u.test(name)) {
    throw new Error('Retained data filename must be a plain JSON filename.');
  }
  return path.join(getRetainedDataSourceRoot(), 'src', 'data', name);
}

module.exports = { configureRetainedDataSourceRoot, getRetainedDataSourceRoot, retainedDataFile };
