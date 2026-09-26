const test = require('node:test');
const assert = require('node:assert/strict');
const { createExtensionHost } = require('../src/extensions/extensionHost');

test('extension preflight propagates errors before command deployment or login', async () => {
  let checked = 0;
  const noExtension = createExtensionHost();
  await noExtension.preflight();
  const host = createExtensionHost([{ id: 'fixture', preflight: async ({ client }) => {
    assert.equal(client, 'fixture-client');
    checked += 1;
    throw new Error('private data unavailable');
  } }]);
  await assert.rejects(host.preflight({ client: 'fixture-client' }), /private data unavailable/);
  assert.equal(checked, 1);
});
