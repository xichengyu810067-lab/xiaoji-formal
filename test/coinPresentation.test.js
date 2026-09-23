const test = require('node:test');
const assert = require('node:assert/strict');

const { formatUser } = require('../src/utils/coinPresentation');

test('formatUser uses guild/member display name and avoids user id', () => {
  assert.equal(formatUser({ displayName: '奶昔女王' }), '奶昔女王');
  assert.equal(formatUser({ globalName: 'global-小吉', username: 'ignored' }), 'global-小吉');
  assert.equal(formatUser({ username: '小吉' }), '小吉');
});

test('formatUser hides mention-like symbols and unknown input', () => {
  assert.equal(formatUser({ displayName: '[@evil]<user>' }), '[evil]user');
  assert.equal(formatUser({ id: '123456789' }), '未知使用者');
  assert.equal(formatUser(null), '未知使用者');
});
