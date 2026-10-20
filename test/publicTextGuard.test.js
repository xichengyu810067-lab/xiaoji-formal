const test = require('node:test');
const assert = require('node:assert/strict');
const { findInternalReferences, findPublicTextIssues } = require('../scripts/check-public-text');

test('public export contains no internal planning or review codes', () => {
  assert.deepEqual(findPublicTextIssues(), []);
});

test('public text guard recognizes internal codes in comments and identifiers', () => {
  const comment = `// phase ${'B7'}`;
  const identifier = `{ id: '${'R4c'}' }`;
  assert.ok(findInternalReferences(comment).length >= 1);
  assert.equal(findInternalReferences(identifier).length, 1);
  assert.deepEqual(findInternalReferences('棋盤座標 A1 B2；架構規則 R6。'), []);
});
