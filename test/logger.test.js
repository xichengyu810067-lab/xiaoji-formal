const test = require('node:test');
const assert = require('node:assert/strict');
const { redactText } = require('../src/utils/logger');

test('redactText removes known environment secrets', () => {
  process.env.TEST_TOKEN = 'this-is-a-secret-token';
  assert.equal(redactText('token=this-is-a-secret-token'), 'token=[redacted-secret]');
  delete process.env.TEST_TOKEN;
});

test('redactText removes API key patterns', () => {
  assert.equal(redactText('key sk-test_abcdefghijklmnopqrstuvwxyz123456'), 'key [redacted-api-key]');
});
