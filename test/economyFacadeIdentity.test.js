const test = require('node:test');
const assert = require('node:assert/strict');

const economyModules = [
  'coinWalletService',
  'coinService',
  'bankService',
  'chipService',
  'luxuryService',
  'coinCampaignService',
];

test('legacy economy service paths preserve exact public export identity', () => {
  for (const name of economyModules) {
    const legacy = require('../src/services/' + name);
    const domain = require('../src/systems/economy/' + name);
    assert.strictEqual(legacy, domain, name);
    const keys = Reflect.ownKeys(domain);
    assert.ok(keys.length > 0, name + ' has public exports');
    for (const key of keys) assert.strictEqual(legacy[key], domain[key], name + '.' + String(key));
  }
});
