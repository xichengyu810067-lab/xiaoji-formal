'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const catalog = require('../src/platform/catalogs/commandCatalog');
const {
  FAILURES_TO_BREAK,
  SUSTAINED_FAILURE_MS,
  SERVICES,
  recordServiceOutcome,
  registerServiceConfiguration,
  resetServiceHealthForTests,
} = require('../src/platform/serviceHealth');
const {
  interactionSubcommand,
  recordCommandOutcome,
  resetCommandHealthForTests,
} = require('../src/platform/commandHealth');
const { COMMAND_DEPENDENCIES, listPublicCommands } = require('../src/platform/publicCommandStatus');
const { PUBLIC_FEATURES, buildPublicStatusSnapshot } = require('../src/services/publicStatusService');
const { createMarketData } = require('../src/systems/stocks/marketData');
const { describeHealthCheck, describeReason, indexStatusPayload, matchesStatusFilter } = require('../src/platform/catalogs/statusData');
const { TARGET, render } = require('../scripts/build-status-worker-commands');

const NOW = Date.parse('2026-11-14T12:00:00Z');
const worker = () => import('../cloudflare/status-worker/src/index.mjs');

function useHealth(t, configured = { claude: true, memory_store: true, weather: true }) {
  resetServiceHealthForTests();
  resetCommandHealthForTests();
  for (const [service, value] of Object.entries(configured)) registerServiceConfiguration(service, () => value);
  t.after(() => {
    resetServiceHealthForTests();
    resetCommandHealthForTests();
  });
}

function fakeClient({ ready = true, missing = [] } = {}) {
  return { isReady: () => ready, commands: { has: (name) => !missing.includes(name) } };
}

async function snapshot({ client = fakeClient(), healthRows = [], healthFails = false } = {}) {
  return buildPublicStatusSnapshot(client, {
    now: new Date(NOW),
    healthReader: async () => {
      if (healthFails) throw new Error('database down');
      return healthRows;
    },
    usageReader: async () => [],
  });
}

function command(result, name) {
  return result.commands.find((entry) => entry.key === name);
}

function sub(result, name, subcommand) {
  return command(result, name).subcommands.find((entry) => entry.key === subcommand);
}

test('every public command says what it depends on, and only on things that exist', () => {
  const featureKeys = new Set(PUBLIC_FEATURES.map((feature) => feature.key));
  const names = catalog.COMMAND_CATALOG.map((entry) => entry.name);
  assert.deepEqual(Object.keys(COMMAND_DEPENDENCIES).sort(), [...names].sort());
  for (const [name, needs] of Object.entries(COMMAND_DEPENDENCIES)) {
    const entries = [needs, ...Object.values(needs.subcommands || {})];
    for (const entry of entries) {
      for (const feature of entry.features || []) assert.ok(featureKeys.has(feature), `${name}: ${feature}`);
      for (const service of entry.services || []) assert.ok(SERVICES.includes(service), `${name}: ${service}`);
    }
    for (const subcommand of Object.keys(needs.subcommands || {})) {
      assert.ok(catalog.getCommand(name).subcommands.includes(subcommand), `${name} ${subcommand}`);
    }
  }
});

test('the status page lists the public commands and their subcommands, without the owner-only ones', () => {
  const commands = listPublicCommands();
  assert.equal(commands.length, catalog.COMMAND_CATALOG.length);
  const bank = commands.find((entry) => entry.name === 'bank');
  assert.ok(bank.subcommands.includes('deposit'));
  assert.ok(!bank.subcommands.includes('rate-set-demand'), 'owner only');
  assert.ok(!commands.find((entry) => entry.name === 'work').subcommands.includes('appeal-review'), 'owner only');
});

test('the worker carries the same command list as the bot', () => {
  assert.equal(fs.readFileSync(TARGET, 'utf8'), render(), 'run node scripts/build-status-worker-commands.js');
});

test('with nothing failing, every command and subcommand is normal', async (t) => {
  useHealth(t);
  const result = await snapshot();
  const notNormal = result.commands.flatMap((entry) => [entry, ...entry.subcommands]).filter((entry) => entry.status !== 'normal');
  assert.deepEqual(notNormal, []);
  assert.ok(result.commands.every((entry) => entry.reason === null));
  assert.equal(result.bot.status, 'operational');
});

test('a subcommand that keeps throwing is broken, its command with it, and one good run brings it back', async (t) => {
  useHealth(t);
  for (let index = 0; index < FAILURES_TO_BREAK; index += 1) recordCommandOutcome('bank', 'deposit', false, NOW);
  let result = await snapshot();
  assert.deepEqual(sub(result, 'bank', 'deposit'), { key: 'deposit', status: 'broken', reason: 'errors' });
  assert.equal(sub(result, 'bank', 'withdraw').status, 'normal');
  assert.deepEqual([command(result, 'bank').status, command(result, 'bank').reason], ['broken', 'errors']);
  assert.equal(result.bot.status, 'degraded', 'a broken command lowers the overall status');

  recordCommandOutcome('bank', 'deposit', true, NOW);
  result = await snapshot();
  assert.equal(command(result, 'bank').status, 'normal');
});

test('two failures are not enough, and a command without subcommands counts on its own', async (t) => {
  useHealth(t);
  for (let index = 1; index < FAILURES_TO_BREAK; index += 1) recordCommandOutcome('ping', null, false, NOW);
  assert.equal(command(await snapshot(), 'ping').status, 'normal');
  recordCommandOutcome('ping', null, false, NOW);
  assert.deepEqual(command(await snapshot(), 'ping'), { key: 'ping', status: 'broken', reason: 'errors', subcommands: [] });
});

test('a command that is not loaded is broken; an offline bot puts everything under maintenance', async (t) => {
  useHealth(t);
  const missing = await snapshot({ client: fakeClient({ missing: ['pawn'] }) });
  assert.deepEqual([command(missing, 'pawn').status, command(missing, 'pawn').reason], ['broken', 'not_loaded']);
  assert.ok(command(missing, 'pawn').subcommands.every((entry) => entry.reason === 'not_loaded'));

  const offline = await snapshot({ client: fakeClient({ ready: false }) });
  assert.ok(offline.commands.every((entry) => entry.status === 'maintenance' && entry.reason === 'offline'));
});

test('commands follow the services and features behind them', async (t) => {
  useHealth(t, { claude: false, memory_store: true, weather: true });
  // A service is broken once its calls have kept failing for SUSTAINED_FAILURE_MS (serviceHealth.js).
  for (let index = 0; index < FAILURES_TO_BREAK; index += 1) {
    recordServiceOutcome('market_data', false, NOW - SUSTAINED_FAILURE_MS + Math.round((SUSTAINED_FAILURE_MS * index) / (FAILURES_TO_BREAK - 1)));
  }
  const result = await snapshot({
    healthRows: [{ featureKey: 'number_chain', status: 'broken', updatedAt: new Date(NOW).toISOString() }],
  });
  assert.deepEqual([command(result, 'stock').status, command(result, 'stock').reason], ['broken', 'service']);
  assert.deepEqual([command(result, 'number-chain').status, command(result, 'number-chain').reason], ['broken', 'feature']);
  // Without a Claude key /student cannot work, but /food recipe still answers through another provider.
  assert.deepEqual([command(result, 'student').status, command(result, 'student').reason], ['maintenance', 'feature']);
  assert.equal(sub(result, 'food', 'recipe').status, 'normal');
  assert.equal(command(result, 'roll').status, 'normal');
});

test('commands that need the database are under maintenance when it cannot be read', async (t) => {
  useHealth(t);
  const result = await snapshot({ healthFails: true });
  assert.deepEqual([command(result, 'bank').status, command(result, 'bank').reason], ['maintenance', 'database']);
  assert.equal(sub(result, 'stock', 'quote').status, 'normal');
  assert.equal(sub(result, 'stock', 'watch-add').reason, 'database');
  assert.equal(command(result, 'roll').status, 'normal');
});

test('the snapshot with every subcommand stays well inside the worker limit', async (t) => {
  useHealth(t);
  assert.ok(Buffer.byteLength(JSON.stringify(await snapshot())) < 32 * 1024);
});

test('the subcommand an interaction ran is read from its options', () => {
  const options = (group, subcommand) => ({ options: { getSubcommandGroup: () => group, getSubcommand: () => subcommand } });
  assert.equal(interactionSubcommand(options(null, 'deposit')), 'deposit');
  assert.equal(interactionSubcommand(options('fixed', 'create')), 'fixed create');
  assert.equal(interactionSubcommand(options(null, null)), null);
  assert.equal(interactionSubcommand({ options: { getSubcommand: () => { throw new Error('none'); } } }), null);
  assert.equal(interactionSubcommand({}), null);
});

test('the quote sources report whether they answer, but not a pace limit or an unknown symbol', async () => {
  const outcomes = [];
  const reply = (status, body) => async () => ({ ok: status === 200, status, json: async () => body });
  const make = (fetchImpl) => createMarketData({ fetchImpl, apiKey: () => 'key', recordOutcome: (ok) => outcomes.push(ok) });

  await assert.rejects(make(async () => { throw new Error('offline'); }).quote('AAPL'));
  await assert.rejects(make(reply(429, {})).quote('AAPL'));
  await assert.rejects(make(reply(200, { status: 'error', code: 404 })).quote('ZZZZ'));
  await assert.rejects(make(reply(200, { status: 'error', code: 500 })).quote('AAPL'));
  assert.deepEqual(outcomes, [false, true, false]);
});

// ---- The status worker ---------------------------------------------------------------------------------------------

async function botSnapshot(t) {
  useHealth(t);
  for (let index = 0; index < FAILURES_TO_BREAK; index += 1) recordCommandOutcome('bank', 'deposit', false, Date.now());
  const result = await buildPublicStatusSnapshot(fakeClient(), { healthReader: async () => [], usageReader: async () => [] });
  return JSON.parse(JSON.stringify(result));
}

test('the worker keeps the public commands and drops any name it does not know', async (t) => {
  const { validatePublicSnapshot } = await worker();
  const value = await botSnapshot(t);
  value.commands.push({ key: 'not-a-public-command', status: 'normal', reason: null, subcommands: [] });
  command(value, 'bank').subcommands.push({ key: 'secret-sub', status: 'normal', reason: null });
  command(value, 'roll').status = 'maintenance';
  command(value, 'roll').reason = 'some_future_reason';

  const accepted = validatePublicSnapshot(value);
  assert.ok(accepted);
  assert.equal(accepted.commands.length, catalog.COMMAND_CATALOG.length);
  assert.equal(command(accepted, 'not-a-public-command'), undefined, 'a name outside the public list is never stored');
  assert.ok(!command(accepted, 'bank').subcommands.some((entry) => entry.key === 'secret-sub'));
  assert.deepEqual(sub(accepted, 'bank', 'deposit'), { key: 'deposit', status: 'broken', reason: 'errors' });
  assert.equal(command(accepted, 'roll').reason, null, 'an unknown reason is dropped, the status kept');
  assert.ok(validatePublicSnapshot(JSON.parse(JSON.stringify(accepted)), { allowStored: true }), 'the stored form reads back');
});

test('the worker still accepts a bot that sends no commands, and rejects a malformed list', async (t) => {
  const { validatePublicSnapshot } = await worker();
  const value = await botSnapshot(t);
  const { commands, ...older } = value;
  assert.deepEqual(validatePublicSnapshot(older).commands, []);

  for (const broken of [
    { ...value, commands: 'all fine' },
    { ...value, commands: [{ key: 'roll', status: 'great', reason: null, subcommands: [] }] },
    { ...value, commands: [{ key: 'roll', status: 'normal', reason: null }] },
    { ...value, commands: [{ key: 'roll', status: 'normal', reason: 'Not Allowed!', subcommands: [] }] },
    { ...value, commands: [{ key: 'roll', status: 'normal', reason: null, subcommands: [], extra: 1 }] },
  ]) {
    assert.equal(validatePublicSnapshot(broken), null, JSON.stringify(broken.commands).slice(0, 80));
  }
});

function fakeDb(row) {
  return { prepare: () => ({ first: async () => row }) };
}

test('the public status shows command statuses, marks them stale when snapshots stop, and the overview leaves them out', async (t) => {
  const { default: handler, validatePublicSnapshot } = await worker();
  const stored = validatePublicSnapshot(await botSnapshot(t));
  const read = async (path, observedAt) => {
    const response = await handler.fetch(new Request(`https://status.example${path}`), {
      STATUS_DB: fakeDb({ observed_at: observedAt, payload_json: JSON.stringify(stored) }),
    });
    return response.json();
  };

  const fresh = await read('/api/public/status', new Date().toISOString());
  assert.deepEqual(sub(fresh, 'bank', 'deposit'), { key: 'deposit', status: 'broken', reason: 'errors' });
  assert.equal(command(fresh, 'roll').status, 'normal');

  const stale = await read('/api/public/status', new Date(Date.now() - 10 * 60 * 1000).toISOString());
  assert.deepEqual([command(stale, 'roll').status, command(stale, 'roll').reason], ['maintenance', 'stale']);
  assert.equal(sub(stale, 'bank', 'deposit').status, 'broken', 'a broken command stays broken');

  const overview = await read('/api/public/overview', new Date().toISOString());
  assert.equal(overview.commands, undefined);
  assert.equal(overview.features, undefined);
});

// ---- The status page --------------------------------------------------------------------------------------------------

test('the status page reads command statuses and words their reasons', () => {
  const index = indexStatusPayload({
    features: [{ key: 'weather', status: 'normal' }],
    commands: [{ key: 'bank', status: 'broken', reason: 'errors', subcommands: [{ key: 'deposit', status: 'broken', reason: 'errors' }] }],
  });
  assert.deepEqual(index.features.get('weather'), { status: 'normal', reason: '' });
  assert.deepEqual(index.commands.get('bank').subcommands.get('deposit'), { status: 'broken', reason: '最近連續執行失敗' });
  assert.equal(index.reportsCommands, true);
  assert.equal(indexStatusPayload({ features: [] }).reportsCommands, false, 'a bot without command statuses');
  assert.equal(indexStatusPayload({ commands: [{ key: 'x', status: 'odd' }] }).commands.get('x').status, 'unknown');

  assert.equal(describeReason('maintenance', 'service'), '外部服務尚未設定');
  assert.equal(describeReason('broken', 'service'), '依賴的外部服務異常');
  assert.equal(describeReason('normal', 'errors'), '');
  assert.equal(describeReason('broken', 'constructor'), '');
});

test('the status page filter matches words and keeps only the rows that need a look', () => {
  const row = { search: '/bank 小吉銀行 deposit', status: 'broken' };
  assert.equal(matchesStatusFilter(row, { query: 'BANK' }), true);
  assert.equal(matchesStatusFilter(row, { query: '天氣' }), false);
  assert.equal(matchesStatusFilter({ ...row, status: 'normal' }, { issuesOnly: true }), false);
  assert.equal(matchesStatusFilter({ ...row, status: 'unknown' }, { issuesOnly: true }), false);
  assert.equal(matchesStatusFilter({ ...row, status: 'maintenance' }, { issuesOnly: true }), true);
});

test('the status page lists every public command and subcommand, and no owner-only one', () => {
  const page = fs.readFileSync(require.resolve('../website/status.html'), 'utf8');
  for (const entry of listPublicCommands()) {
    assert.match(page, new RegExp(`data-kind="command" data-key="${entry.name}"`));
    for (const subcommand of entry.subcommands) assert.ok(page.includes(`data-key="${subcommand}"`), `${entry.name} ${subcommand}`);
  }
  assert.ok(!page.includes('rate-set-demand'));
  assert.ok(!page.includes('appeal-review'));
});

// ---- The last release's health check -------------------------------------------------------------------------------

test('the health check reaches the website with public paths only, and pass or fail only', () => {
  const { buildHealthCheck, render } = require('../scripts/build-status-health-check');
  const healthCheck = buildHealthCheck({
    checkedAt: '2026-11-14T03:00:00Z',
    commands: [
      { path: '/bank deposit', status: 'pass' },
      { path: '/bank withdraw', status: 'fail' },
      { path: '/bank rate-set-demand', status: 'pass' },
      { path: '/not-a-public-command', status: 'pass' },
      { path: '/ping', status: 'pass' },
      { path: '/roll', status: 'skip' },
      { path: '/fortune', status: 'warn' },
      { path: '/bank   deposit', status: 'pass' },
    ],
  }, { version: '1.3.2' });
  assert.deepEqual(healthCheck.commands, {
    ping: { subcommands: {}, status: 'pass' },
    bank: { subcommands: { deposit: 'pass', withdraw: 'fail' } },
  });
  assert.equal(healthCheck.dropped, 3, 'an owner-only subcommand, a private name and a malformed path');
  assert.throws(() => buildHealthCheck({ checkedAt: '下午三點', commands: [] }), /checkedAt/u);

  const file = render(healthCheck);
  assert.ok(!file.includes('rate-set-demand') && !file.includes('not-a-public-command'));
  const loaded = new Function('module', `${file}; return module.exports;`)({ exports: {} });
  assert.equal(loaded.version, '1.3.2');
  assert.equal(describeHealthCheck(loaded, 'bank'), '上次版本健檢（v1.3.2，11/14）：未通過');
  assert.equal(describeHealthCheck(loaded, 'bank', 'deposit'), '上次版本健檢（v1.3.2，11/14）：通過');
  assert.equal(describeHealthCheck(loaded, 'ping'), '上次版本健檢（v1.3.2，11/14）：通過');
  assert.equal(describeHealthCheck(loaded, 'roll'), '', 'a command that was not checked says nothing');
  assert.equal(describeHealthCheck(null, 'bank'), '');
});

test('the website carries a health check that is empty or only public', () => {
  const healthCheck = require('../website/statusHealthCheck');
  if (healthCheck === null) return;
  const commands = new Map(listPublicCommands().map((entry) => [entry.name, entry.subcommands]));
  for (const [name, entry] of Object.entries(healthCheck.commands)) {
    assert.ok(commands.has(name), name);
    for (const subcommand of Object.keys(entry.subcommands)) assert.ok(commands.get(name).includes(subcommand), `${name} ${subcommand}`);
  }
});
