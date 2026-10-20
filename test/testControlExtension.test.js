'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { selectExtensionHost } = require('../src/platform/testControlExtension');

test('test policy selects empty host without loading private extension side effects', () => {
  let privateLoads = 0;
  const empty = { extensions: [] };
  const result = selectExtensionHost({ mode: 'test-control' }, {
    createEmpty: () => empty,
    loadPrivate: () => { privateLoads += 1; return { extensions: ['private'] }; },
  });
  assert.equal(result, empty);
  assert.equal(privateLoads, 0);
});

test('production still loads the configured private extension path', () => {
  let privateLoads = 0;
  selectExtensionHost(null, { createEmpty: () => ({}), loadPrivate: () => { privateLoads += 1; return {}; } });
  assert.equal(privateLoads, 1);
});
