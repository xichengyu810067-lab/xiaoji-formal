'use strict';

// Configuration of the optional Jev second opinion (src/systems/conversation/jevClient.js): off unless fully and
// correctly set, a problem warns once without repeating a value, and the key never shows in the configuration.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-jev-config-suite-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const {
  COUNTERFEIT_SAFE_MAX,
  DEFAULT_ENDPOINT,
  DEFAULT_MODEL,
  DEFAULT_SAFE_MAX,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  isGuildEnabled,
  parseJevConfig,
} = require('../src/systems/conversation/jevClient');

const KEY = 'synthetic-jev-key-0123456789';
const GUILD_A = '111111111111111111';
const GUILD_B = '222222222222222222';

function baseEnv(overrides = {}) {
  return {
    JEV_MODE: 'enforce',
    JEV_API_KEY: KEY,
    JEV_POLICY_ACK: 'yes',
    JEV_GUILD_IDS: GUILD_A,
    ...overrides,
  };
}

function parse(env) {
  const warnings = [];
  const config = parseJevConfig(env, { loggerImpl: { warn: (line) => warnings.push(line) }, warned: new Set() });
  return { config, warnings };
}

test('nothing set, or mode off: the feature is off and says nothing', () => {
  for (const env of [{}, { JEV_MODE: 'off' }, { JEV_MODE: '  OFF ' }, baseEnv({ JEV_MODE: 'off' })]) {
    const { config, warnings } = parse(env);
    assert.equal(config, null);
    assert.deepEqual(warnings, []);
  }
});

test('a bad mode disables it with one warning that does not repeat the value', () => {
  const warned = new Set();
  const warnings = [];
  const options = { loggerImpl: { warn: (line) => warnings.push(line) }, warned };
  assert.equal(parseJevConfig(baseEnv({ JEV_MODE: 'turbo-secret' }), options), null);
  assert.equal(parseJevConfig(baseEnv({ JEV_MODE: 'turbo-secret' }), options), null);
  assert.equal(warnings.length, 1);
  assert.ok(!warnings[0].includes('turbo-secret'));
});

test('shadow and enforce need the owner confirmation JEV_POLICY_ACK=yes', () => {
  for (const mode of ['shadow', 'enforce']) {
    for (const ack of [undefined, '', 'no', 'true', '1', 'YES', 'yes please']) {
      const env = baseEnv({ JEV_MODE: mode });
      if (ack === undefined) delete env.JEV_POLICY_ACK; else env.JEV_POLICY_ACK = ack;
      const { config, warnings } = parse(env);
      assert.equal(config, null, `${mode} with ack ${JSON.stringify(ack)}`);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes('policy_ack_missing'));
    }
    assert.equal(parse(baseEnv({ JEV_MODE: mode })).config?.mode, mode);
  }
});

test('a missing or unusable key disables it and the warning never holds the key', () => {
  const unusable = [undefined, '', '   ', 'short', 'has space inside key', `line\nbreak${KEY}`, `tab\t${KEY}`, `${KEY}é`];
  for (const key of unusable) {
    const env = baseEnv();
    if (key === undefined) delete env.JEV_API_KEY; else env.JEV_API_KEY = key;
    const { config, warnings } = parse(env);
    assert.equal(config, null, JSON.stringify(key));
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes(KEY));
  }
});

test('the endpoint must be a plain https address and defaults to the documented one', () => {
  assert.equal(parse(baseEnv()).config.endpoint, DEFAULT_ENDPOINT);
  assert.equal(parse(baseEnv({ JEV_ENDPOINT: 'https://openrouter.example/api/alpha/decisions' })).config.endpoint,
    'https://openrouter.example/api/alpha/decisions');
  const bad = [
    'http://api.example.com/v1/systemone', 'ftp://api.example.com/x', 'api.example.com/v1', 'https://user:pass@api.example.com/x',
    `https://api.example.com/x?key=${KEY}`, 'https://api.example.com/x#frag', 'https://', 'javascript:alert(1)', 'file:///etc/passwd',
  ];
  for (const endpoint of bad) {
    const { config, warnings } = parse(baseEnv({ JEV_ENDPOINT: endpoint }));
    assert.equal(config, null, endpoint);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes('example.com'), 'the address is not repeated');
    assert.ok(!warnings[0].includes(KEY));
  }
});

test('the model is pinned to a fixed version by default and must look like a model name', () => {
  assert.equal(DEFAULT_MODEL, 'jev-1.13.0');
  assert.equal(parse(baseEnv()).config.model, DEFAULT_MODEL);
  assert.equal(parse(baseEnv({ JEV_MODEL: 'typesafe/jev-1.13' })).config.model, 'typesafe/jev-1.13');
  for (const model of ['jev latest', 'jev"1', '../x', 'a'.repeat(81)]) {
    assert.equal(parse(baseEnv({ JEV_MODEL: model })).config, null, model);
  }
});

test('the timeout defaults to 3000 ms, is capped at 5000 ms and a bad value falls back to the default', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 3000);
  assert.equal(MAX_TIMEOUT_MS, 5000);
  assert.equal(parse(baseEnv()).config.timeoutMs, 3000);
  assert.equal(parse(baseEnv({ JEV_TIMEOUT_MS: '1500' })).config.timeoutMs, 1500);
  assert.equal(parse(baseEnv({ JEV_TIMEOUT_MS: '5000' })).config.timeoutMs, 5000);
  assert.equal(parse(baseEnv({ JEV_TIMEOUT_MS: '60000' })).config.timeoutMs, 5000);
  assert.equal(parse(baseEnv({ JEV_TIMEOUT_MS: '9999999' })).config.timeoutMs, 5000);
  assert.equal(parse(baseEnv({ JEV_TIMEOUT_MS: '1' })).config.timeoutMs, 200);
  for (const value of ['abc', '0', '-5', '1.5', '1e9', '12345678']) {
    const { config, warnings } = parse(baseEnv({ JEV_TIMEOUT_MS: value }));
    assert.equal(config.timeoutMs, 3000, value);
    assert.equal(warnings.length, 1);
  }
});

test('the server list keeps valid IDs once each, ignores the rest, and an empty list enables no server', () => {
  const { config } = parse(baseEnv({ JEV_GUILD_IDS: ` ${GUILD_A} , ${GUILD_B},${GUILD_A},,not-an-id,123 ` }));
  assert.deepEqual([...config.guildIds], [GUILD_A, GUILD_B]);
  assert.ok(isGuildEnabled(config, GUILD_A));
  assert.ok(isGuildEnabled(config, GUILD_B));
  assert.ok(!isGuildEnabled(config, '333333333333333333'));
  assert.ok(!isGuildEnabled(config, null));
  assert.ok(!isGuildEnabled(config, undefined));
  assert.ok(!isGuildEnabled(null, GUILD_A));

  for (const value of [undefined, '', ' , ', 'abc,def']) {
    const env = baseEnv();
    if (value === undefined) delete env.JEV_GUILD_IDS; else env.JEV_GUILD_IDS = value;
    const result = parse(env);
    assert.equal(result.config, null, JSON.stringify(value));
    assert.ok(result.warnings.some((line) => line.includes('no_guilds')));
  }
});

test('the safe limit defaults to 0.10, the stricter limit for invented rules is 0.05, and a bad value falls back', () => {
  assert.equal(DEFAULT_SAFE_MAX, 0.1);
  assert.equal(COUNTERFEIT_SAFE_MAX, 0.05);
  const standard = parse(baseEnv()).config;
  assert.equal(standard.safeMax, 0.1);
  assert.equal(standard.counterfeitSafeMax, 0.05);
  const strict = parse(baseEnv({ JEV_SAFE_MAX: '0.02' })).config;
  assert.equal(strict.safeMax, 0.02);
  assert.equal(strict.counterfeitSafeMax, 0.02);
  assert.equal(parse(baseEnv({ JEV_SAFE_MAX: '0' })).config.safeMax, 0);
  assert.equal(parse(baseEnv({ JEV_SAFE_MAX: '.3' })).config.safeMax, 0.3);
  for (const value of ['0.9', '1', 'x', '-0.1', '0.1.2', '50%']) {
    const { config, warnings } = parse(baseEnv({ JEV_SAFE_MAX: value }));
    assert.equal(config.safeMax, 0.1, value);
    assert.equal(warnings.length, 1);
  }
});

test('the configuration is frozen, and the key is not an enumerable field', () => {
  const { config, warnings } = parse(baseEnv({ JEV_ENDPOINT: 'https://api.example.com/v1/systemone' }));
  assert.deepEqual(warnings, []);
  assert.ok(Object.isFrozen(config));
  assert.ok(Object.isFrozen(config.guildIds));
  assert.equal(config.apiKey, KEY, 'the client can read the key');
  assert.ok(!Object.keys(config).includes('apiKey'));
  assert.ok(!JSON.stringify(config).includes(KEY));
  assert.ok(!require('node:util').inspect(config).includes(KEY));
  assert.throws(() => { config.mode = 'off'; }, TypeError);
  assert.throws(() => { config.guildIds.push('1'); }, TypeError);
  assert.equal(config.mode, 'enforce');
});

test('the process environment is read through the shared reader when no environment is passed', () => {
  const names = ['JEV_MODE', 'JEV_API_KEY', 'JEV_POLICY_ACK', 'JEV_GUILD_IDS'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(baseEnv({ JEV_MODE: 'shadow' }))) process.env[name] = ` ${value} `;
    const { config } = (() => {
      const warnings = [];
      return { config: parseJevConfig(process.env, { loggerImpl: { warn: (line) => warnings.push(line) }, warned: new Set() }) };
    })();
    assert.equal(config.mode, 'shadow');
    assert.equal(config.apiKey, KEY);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
  }
});

test('the placeholder of the env template is not a key', () => {
  for (const key of ['your_jev_api_key', 'YOUR_JEV_API_KEY', 'your_key_here_123']) {
    const { config, warnings } = parse(baseEnv({ JEV_API_KEY: key }));
    assert.equal(config, null, key);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].includes('bad_api_key'));
    assert.ok(!warnings[0].includes(key));
  }
  assert.ok(parse(baseEnv({ JEV_API_KEY: 'my_your_key_0123456789' })).config, 'only a leading your_ is a placeholder');
});

test('the endpoint may not be a local, private or link-local host', () => {
  const refused = [
    'https://localhost/v1', 'https://LOCALHOST:8443/v1', 'https://api.localhost/v1', 'https://printer.local/v1', 'https://127.0.0.1/v1',
    'https://127.1/v1', 'https://0x7f.1/v1', 'https://2130706433/v1', 'https://10.0.0.5/v1', 'https://172.16.0.1/v1', 'https://172.31.255.255/v1',
    'https://192.168.1.10/v1', 'https://169.254.169.254/latest', 'https://0.0.0.0/v1', 'https://[::1]/v1', 'https://[fd00::1]/v1',
    'https://[fe80::1]/v1', 'https://[::ffff:127.0.0.1]/v1',
  ];
  for (const endpoint of refused) {
    const { config, warnings } = parse(baseEnv({ JEV_ENDPOINT: endpoint }));
    assert.equal(config, null, endpoint);
    assert.equal(warnings.length, 1, endpoint);
    assert.ok(warnings[0].includes('bad_endpoint'));
  }
  for (const endpoint of ['https://api.example.com/v1', 'https://172.32.0.1/v1', 'https://8.8.8.8/v1', 'https://openrouter.ai/api/alpha/decisions']) {
    assert.ok(parse(baseEnv({ JEV_ENDPOINT: endpoint })).config, endpoint);
  }
});

test('JEV_LINK_RISK is an opt-in of its own: only the exact value yes turns the link-risk use on, and it changes nothing else', () => {
  const base = { JEV_MODE: 'shadow', JEV_API_KEY: 'k'.repeat(24), JEV_GUILD_IDS: '111111111111111111', JEV_POLICY_ACK: 'yes' };
  const parse = (extra) => parseJevConfig({ ...base, ...extra }, { loggerImpl: null, warned: new Set() });
  assert.equal(parse({}).linkRisk, false);
  assert.equal(parse({ JEV_LINK_RISK: '' }).linkRisk, false);
  for (const value of ['no', 'true', '1', 'YES ', 'on', 'yess']) {
    assert.equal(parse({ JEV_LINK_RISK: value }).linkRisk, value.trim() === 'yes', value);
  }
  assert.equal(parse({ JEV_LINK_RISK: 'yes' }).linkRisk, true);
  assert.equal(parse({ JEV_LINK_RISK: ' yes ' }).linkRisk, true);
  // The opt-in alone turns nothing on, and the rest of the configuration is the same with or without it.
  assert.equal(parseJevConfig({ JEV_LINK_RISK: 'yes', JEV_MODE: 'off' }, { loggerImpl: null, warned: new Set() }), null);
  assert.equal(parseJevConfig({ ...base, JEV_POLICY_ACK: undefined, JEV_LINK_RISK: 'yes' }, { loggerImpl: null, warned: new Set() }), null);
  const { linkRisk: _a, ...withOptIn } = parse({ JEV_LINK_RISK: 'yes' });
  const { linkRisk: _b, ...without } = parse({});
  assert.deepEqual(withOptIn, without);
});
