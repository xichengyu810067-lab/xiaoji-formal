'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  FAILURES_TO_BREAK,
  FAILURE_MEMORY_MS,
  recordServiceOutcome,
  registerServiceConfiguration,
  resetServiceHealthForTests,
  serviceStatus,
} = require('../src/platform/serviceHealth');
const { buildPublicStatusSnapshot, createFeatureStatusWatcher } = require('../src/services/publicStatusService');
const { PUBLIC_FEATURE_CATALOG } = require('../src/platform/catalogs/statusData');

const NOW = Date.parse('2026-11-12T12:00:00Z');

function useHealth(t, configured = { claude: true, memory_store: true, weather: true }) {
  resetServiceHealthForTests();
  for (const [service, value] of Object.entries(configured)) registerServiceConfiguration(service, () => value);
  t.after(() => resetServiceHealthForTests());
}

// A ready client that has every command loaded.
const client = {
  isReady: () => true,
  commands: { has: () => true },
};

async function statuses(now = NOW) {
  const snapshot = await buildPublicStatusSnapshot(client, {
    now: new Date(now),
    healthReader: async () => [],
    usageReader: async () => [],
  });
  return Object.fromEntries(snapshot.features.map((feature) => [feature.key, feature.status]));
}

test('a service is broken after three failures in a row, and fine again after one success', (t) => {
  useHealth(t);
  for (let index = 1; index < FAILURES_TO_BREAK; index += 1) recordServiceOutcome('claude', false, NOW);
  assert.equal(serviceStatus('claude', NOW), 'normal');
  recordServiceOutcome('claude', false, NOW);
  assert.equal(serviceStatus('claude', NOW), 'broken');
  assert.equal(serviceStatus('claude', NOW + FAILURE_MEMORY_MS + 1), 'normal', 'an old failure is forgotten');
  recordServiceOutcome('claude', true, NOW);
  assert.equal(serviceStatus('claude', NOW), 'normal');
});

test('a service without its settings is under maintenance', (t) => {
  useHealth(t, { claude: false, memory_store: true, weather: true });
  assert.equal(serviceStatus('claude', NOW), 'maintenance');
});

test('the status page lists the new AI features', () => {
  const keys = PUBLIC_FEATURE_CATALOG.map((feature) => feature.key);
  for (const key of ['student', 'memory', 'image_reading', 'web_search']) assert.ok(keys.includes(key), key);
});

test('features follow what really happened with the services behind them', async (t) => {
  useHealth(t);
  assert.deepEqual(
    [(await statuses()).core_chat, (await statuses()).student, (await statuses()).memory, (await statuses()).weather],
    ['normal', 'normal', 'normal', 'normal']);
  for (let index = 0; index < FAILURES_TO_BREAK; index += 1) {
    recordServiceOutcome('claude', false, NOW);
    recordServiceOutcome('weather', false, NOW);
  }
  const broken = await statuses();
  for (const key of ['core_chat', 'student', 'image_reading', 'web_search', 'weather']) assert.equal(broken[key], 'broken', key);
  assert.equal(broken.memory, 'normal', 'a failing Claude does not touch memory');
  assert.equal(broken.poll, 'normal');
});

test('without a Claude key, chat still works (another provider) but the Claude-only features are under maintenance', async (t) => {
  useHealth(t, { claude: false, memory_store: false, weather: true });
  const result = await statuses();
  assert.equal(result.core_chat, 'normal');
  for (const key of ['student', 'image_reading', 'web_search', 'memory']) assert.equal(result[key], 'maintenance', key);
});

test('the watcher reports a change only once it holds on two checks, and never on the first check', async (t) => {
  useHealth(t);
  const reported = [];
  const watch = createFeatureStatusWatcher({
    client,
    onChange: (changes) => { reported.push(...changes); },
    build: (c, { now }) => buildPublicStatusSnapshot(c, { now, healthReader: async () => [], usageReader: async () => [] }),
  });
  assert.deepEqual(await watch(new Date(NOW)), []);
  for (let index = 0; index < FAILURES_TO_BREAK; index += 1) recordServiceOutcome('weather', false, NOW);
  assert.deepEqual(await watch(new Date(NOW + 60_000)), [], 'seen once: not yet');
  const changes = await watch(new Date(NOW + 120_000));
  assert.deepEqual(changes.map(({ key, from, to }) => [key, from, to]), [['weather', 'normal', 'broken']]);
  assert.equal(reported.length, 1);
  // Recovery is reported the same way.
  recordServiceOutcome('weather', true, NOW + 130_000);
  await watch(new Date(NOW + 180_000));
  const recovered = await watch(new Date(NOW + 240_000));
  assert.deepEqual(recovered.map(({ key, to }) => [key, to]), [['weather', 'normal']]);
});

test('the status worker accepts the old and the new feature list, and nothing else', async () => {
  const { validatePublicSnapshot } = await import('../cloudflare/status-worker/src/index.mjs');
  const snapshot = (features) => ({
    schemaVersion: 1,
    updatedAt: new Date(NOW).toISOString(),
    timezone: 'Asia/Taipei',
    bot: { status: 'operational', version: '1.3.0', latencyMs: null },
    guilds: { adoptedCount: null },
    usage: { date: '2026-11-12', todayInteractions: 0, available: true },
    summary: { normal: features.length, maintenance: 0, broken: 0 },
    features: features.map((key) => ({
      key, name: key, category: 'c', status: 'normal', detail: 'd', updatedAt: new Date(NOW).toISOString(), critical: false,
    })),
  });
  const current = (await buildPublicStatusSnapshot(client, { now: new Date(NOW), healthReader: async () => [], usageReader: async () => [] }))
    .features.map((feature) => feature.key);
  const legacy = current.filter((key) => !['student', 'memory', 'image_reading', 'web_search'].includes(key));
  assert.ok(validatePublicSnapshot(snapshot(current)), 'the list this bot sends');
  assert.ok(validatePublicSnapshot(snapshot(legacy)), 'the list the bot before it sends');
  assert.equal(validatePublicSnapshot(snapshot([...legacy.slice(1), 'student'])), null, 'a mixed list');
});

test('the README status badge tells only the overall state', async () => {
  const { publicBadge } = await import('../cloudflare/status-worker/src/index.mjs');
  const view = (status, summary, updatedAt = '2026-11-14T00:00:00Z') => publicBadge({ updatedAt, bot: { status }, summary });
  const message = (badge) => [badge.label, badge.message, badge.color];
  assert.deepEqual(message(view('operational', { normal: 22, maintenance: 0, broken: 0 })), ['小吉狀態', '正常運作', '3f9c80']);
  assert.deepEqual(message(view('operational', { normal: 20, maintenance: 0, broken: 2 })), ['小吉狀態', '2 項功能異常', 'e05d44']);
  assert.deepEqual(message(view('operational', { normal: 21, maintenance: 1, broken: 0 })), ['小吉狀態', '1 項維護中', 'f0a020']);
  assert.deepEqual(message(view('degraded', { normal: 22, maintenance: 0, broken: 0 })), ['小吉狀態', '部分功能異常', 'f0a020']);
  assert.deepEqual(message(view('outage', { normal: 0, maintenance: 0, broken: 0 })), ['小吉狀態', '暫停服務', 'e05d44']);
  assert.deepEqual(message(view('unknown', { normal: 0, maintenance: 0, broken: 0 }, null)), ['小吉狀態', '暫時無法確認', 'lightgrey']);
  assert.equal(view('operational', { normal: 1, maintenance: 0, broken: 0 }).schemaVersion, 1);
});

test('the solo games played through /board are normal without a report from the retired web game server', async (t) => {
  useHealth(t);
  const now = await statuses();
  for (const key of ['tetris', 'number_match', 'sudoku']) assert.equal(now[key], 'normal', key);

  // A reward that broke its contract still lowers the card.
  const snapshot = await buildPublicStatusSnapshot(client, {
    now: new Date(NOW),
    healthReader: async () => [{ featureKey: 'sudoku', status: 'broken', updatedAt: new Date(NOW).toISOString() }],
    usageReader: async () => [],
  });
  assert.equal(snapshot.features.find((feature) => feature.key === 'sudoku').status, 'broken');
});

test('a maintenance row for a solo game is shown, now that the coin database deletes the stale ones on open', async (t) => {
  useHealth(t);
  const at = '2026-11-12T11:00:00.000Z';
  const snapshot = await buildPublicStatusSnapshot(client, {
    now: new Date(NOW),
    healthReader: async () => [
      { featureKey: 'tetris', status: 'broken', detail: 'reward_contract_invalid', updatedAt: at },
      { featureKey: 'number_match', status: 'maintenance', detail: 'operator_pause', updatedAt: at },
      { featureKey: 'daily_riddle', status: 'maintenance', detail: 'paused', updatedAt: at },
    ],
    usageReader: async () => [],
  });
  const cards = Object.fromEntries(snapshot.features.map((feature) => [feature.key, feature]));
  assert.equal(cards.tetris.status, 'broken');
  assert.equal(cards.number_match.status, 'maintenance');
  assert.equal(cards.number_match.updatedAt, at);
  assert.equal(cards.sudoku.status, 'normal');
  assert.equal(cards.daily_riddle.status, 'maintenance');
});

test('no public code reports health for the solo games on its own', () => {
  // featurePlatformService.js stores whatever a caller reports, and the coin database storage creates and migrates the
  // table; every other writer reports for its own feature key. None of them names a solo game key, so a maintenance row
  // for these cards can only come from an operator.
  const root = path.join(__dirname, '..', 'src');
  const files = [];
  const walk = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.js')) files.push(full);
    }
  };
  walk(root);
  const relative = (file) => path.relative(root, file).split(path.sep).join('/');
  const store = 'services/featurePlatformService.js';
  const writers = files.filter((file) => {
    const name = relative(file);
    if (name === store || name.startsWith('systems/economy/storage/')) return false;
    const source = fs.readFileSync(file, 'utf8');
    return /setFeatureHealth|healthReporter|(?:INSERT INTO|UPDATE)\s+feature_health/u.test(source);
  });
  assert.ok(writers.length >= 4, writers.map(relative).join(', '));
  for (const file of writers) {
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /['"`](?:tetris|number_match|sudoku)['"`]/u, relative(file));
  }
  assert.doesNotMatch(fs.readFileSync(path.join(root, store), 'utf8'), /(?:INSERT INTO|UPDATE)\s+feature_health[^`]*(?:tetris|number_match|sudoku)/u);
});

test('with every service configured and nothing failing, every card is normal', async (t) => {
  useHealth(t);
  const now = await statuses();
  assert.deepEqual(Object.entries(now).filter(([, status]) => status !== 'normal'), []);
});
