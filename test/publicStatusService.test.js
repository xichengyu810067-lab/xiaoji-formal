const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PUBLIC_FEATURES,
  buildPublicOverviewSnapshot,
  buildPublicStatusSnapshot,
  recordPublicInteraction,
} = require('../src/services/publicStatusService');
const {
  createPublicStatusRequestHandler,
  parseAllowedOrigins,
  parseEnabled,
  parsePort,
} = require('../src/services/publicStatusServer');

function createClient({ ready = true, guildCount = 12, commands = [] } = {}) {
  return {
    isReady: () => ready,
    readyAt: ready ? new Date('2026-09-03T00:00:00.000Z') : null,
    ws: { ping: 42.4 },
    guilds: { cache: { size: guildCount } },
    commands: new Map(commands.map((name) => [name, {}])),
  };
}

function allImplementedCommands() {
  return [
    'set-welcome', 'remind', 'calendar', 'poll', 'weather',
    'coins', 'daily', 'economy', 'word-chain', 'number-chain', 'daily-riddle', 'daily-discussion',
    'chat-style', 'romance', 'games',
  ];
}

function createResponse() {
  return {
    headers: new Map(),
    statusCode: null,
    body: Buffer.alloc(0),
    setHeader(name, value) { this.headers.set(name.toLowerCase(), value); },
    end(body) { this.body = body ? Buffer.from(body) : Buffer.alloc(0); },
  };
}

test('public status snapshot exposes only aggregate counts and allowlisted feature states', async () => {
  const client = createClient({ commands: allImplementedCommands() });
  const snapshot = await buildPublicStatusSnapshot(client, {
    now: new Date('2026-09-03T03:04:05.000Z'),
    healthReader: async () => [
      { featureKey: 'daily_riddle', status: 'broken', detail: 'secret channel=123456789012345678', updatedAt: '2026-09-03T03:00:00.000Z' },
      { featureKey: 'tetris', status: 'normal', detail: null, updatedAt: '2026-09-03T03:00:00.000Z' },
      { featureKey: 'number_match', status: 'normal', detail: null, updatedAt: '2026-09-03T03:00:00.000Z' },
      { featureKey: 'sudoku', status: 'normal', detail: null, updatedAt: '2026-09-03T03:00:00.000Z' },
    ],
    usageReader: async () => [
      { featureKey: 'public_website', metricKey: 'accepted', usageCount: 321, updatedAt: '2026-09-03T03:00:00.000Z' },
    ],
  });

  assert.equal(snapshot.schemaVersion, 1);
  assert.equal(snapshot.guilds.adoptedCount, 12);
  assert.equal(snapshot.usage.date, '2026-09-03');
  assert.equal(snapshot.usage.todayInteractions, 321);
  assert.equal(snapshot.bot.status, 'degraded');
  assert.equal(snapshot.bot.latencyMs, 42);
  assert.equal(snapshot.features.length, PUBLIC_FEATURES.length);
  assert.equal(snapshot.features.find((feature) => feature.key === 'daily_riddle').status, 'broken');
  assert.equal(snapshot.features.find((feature) => feature.key === 'tetris').status, 'normal');
  assert.equal(snapshot.features.find((feature) => feature.key === 'number_match').status, 'normal');
  assert.equal(snapshot.features.find((feature) => feature.key === 'sudoku').status, 'normal');
  assert.doesNotMatch(JSON.stringify(snapshot), /secret|123456789012345678|guildId|userId|channelId/);
});

test('public overview uses Taipei calendar-day usage and fails unavailable aggregates closed', async () => {
  const overview = await buildPublicOverviewSnapshot(createClient({ commands: allImplementedCommands() }), {
    now: new Date('2026-09-03T16:00:00.000Z'),
    healthReader: async () => [],
    usageReader: async () => { throw new Error('private database path'); },
  });

  assert.equal(overview.usage.date, '2026-09-04');
  assert.equal(overview.usage.todayInteractions, null);
  assert.equal(overview.usage.available, false);
  assert.doesNotMatch(JSON.stringify(overview), /private database path/);
});

test('database reader failures downgrade the economy and overall service status', async () => {
  const snapshot = await buildPublicStatusSnapshot(createClient({ commands: allImplementedCommands() }), {
    healthReader: async () => { throw new Error('database unavailable'); },
    usageReader: async () => { throw new Error('database unavailable'); },
  });

  assert.equal(snapshot.features.find((feature) => feature.key === 'economy').status, 'maintenance');
  assert.equal(snapshot.bot.status, 'degraded');
  assert.equal(snapshot.usage.available, false);
  assert.equal(snapshot.usage.todayInteractions, null);
});

test('missing critical command is broken and disconnected client reports outage', async () => {
  const missingCommand = await buildPublicStatusSnapshot(createClient({ commands: [] }), {
    healthReader: async () => [],
    usageReader: async () => [],
  });
  const disconnected = await buildPublicStatusSnapshot(createClient({ ready: false, commands: allImplementedCommands() }), {
    healthReader: async () => [],
    usageReader: async () => [],
  });

  assert.equal(missingCommand.features.find((feature) => feature.key === 'economy').status, 'broken');
  assert.equal(missingCommand.bot.status, 'outage');
  assert.equal(disconnected.bot.status, 'outage');
  assert.equal(disconnected.features.find((feature) => feature.key === 'core_chat').status, 'broken');
});

test('interaction aggregate failure is contained and logs no user context', async () => {
  const warnings = [];
  const result = await recordPublicInteraction(new Date('2026-09-03T04:00:00.000Z'), {
    recorder: async () => { throw new Error('user=123456789012345678'); },
    loggerImpl: { warn: (message) => warnings.push(message) },
  });

  assert.equal(result, false);
  assert.deepEqual(warnings, ['[PUBLIC_STATUS] Interaction aggregate update failed.']);
});

test('public status handler allows only exact read routes and exact CORS origins', async () => {
  const snapshot = {
    schemaVersion: 1,
    updatedAt: '2026-09-03T04:00:00.000Z',
    bot: { status: 'operational', version: '1.0.0', latencyMs: 10 },
    guilds: { adoptedCount: 2 },
    usage: { date: '2026-09-03', todayInteractions: 4, available: true },
    summary: { normal: 1, maintenance: 0, broken: 0 },
    features: [{ key: 'core_chat', name: '小吉聊天', category: '核心服務', status: 'normal', detail: '功能目前可使用' }],
  };
  const handler = createPublicStatusRequestHandler(createClient(), {
    allowedOrigins: new Set(['https://xiaoji.example']),
    overviewBuilder: async () => snapshot,
    statusBuilder: async () => snapshot,
    loggerImpl: { warn() {}, error() {} },
  });

  const allowed = createResponse();
  await handler({ method: 'GET', url: '/api/public/status', headers: { origin: 'https://xiaoji.example' } }, allowed);
  assert.equal(allowed.statusCode, 200);
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://xiaoji.example');
  assert.equal(allowed.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(JSON.parse(allowed.body.toString()), snapshot);

  const denied = createResponse();
  await handler({ method: 'GET', url: '/api/public/status', headers: { origin: 'https://evil.example' } }, denied);
  assert.equal(denied.statusCode, 403);
  assert.deepEqual(JSON.parse(denied.body.toString()), { error: 'origin_not_allowed' });

  const writeAttempt = createResponse();
  await handler({ method: 'POST', url: '/api/public/status', headers: {} }, writeAttempt);
  assert.equal(writeAttempt.statusCode, 405);

  const missing = createResponse();
  await handler({ method: 'GET', url: '/api/public/private', headers: {} }, missing);
  assert.equal(missing.statusCode, 404);

  const unknownOptions = createResponse();
  await handler({ method: 'OPTIONS', url: '/api/public/private', headers: {} }, unknownOptions);
  assert.equal(unknownOptions.statusCode, 404);

  const queryRoute = createResponse();
  await handler({ method: 'GET', url: '/api/public/status?probe=true', headers: {} }, queryRoute);
  assert.equal(queryRoute.statusCode, 404);

  const exactOptions = createResponse();
  await handler({ method: 'OPTIONS', url: '/api/public/status', headers: {} }, exactOptions);
  assert.equal(exactOptions.statusCode, 204);

  const deniedHead = createResponse();
  await handler({ method: 'HEAD', url: '/api/public/status', headers: { origin: 'https://evil.example' } }, deniedHead);
  assert.equal(deniedHead.statusCode, 403);
  assert.equal(deniedHead.body.length, 0);
});

test('public status environment parsing rejects wildcard and non-loopback HTTP origins', () => {
  assert.equal(parseEnabled('TRUE'), true);
  assert.equal(parseEnabled('1'), false);
  assert.equal(parsePort('9010'), 9010);
  assert.equal(parsePort('70000'), 8787);
  assert.deepEqual([...parseAllowedOrigins('https://xiaoji.example,http://127.0.0.1:4173')], [
    'https://xiaoji.example',
    'http://127.0.0.1:4173',
  ]);
  assert.throws(() => parseAllowedOrigins('*'));
  assert.throws(() => parseAllowedOrigins('http://xiaoji.example'));
  assert.throws(() => parseAllowedOrigins('https://xiaoji.example/path'));
});

test('gateway paths record aggregate interactions while the public API remains read only', () => {
  const root = path.resolve(__dirname, '..');
  const interactionEvent = fs.readFileSync(path.join(root, 'src/events/interactionCreate.js'), 'utf8');
  const messageEvent = fs.readFileSync(path.join(root, 'src/events/messageCreate.js'), 'utf8');
  const mentionService = fs.readFileSync(path.join(root, 'src/services/mentionService.js'), 'utf8');
  const publicServer = fs.readFileSync(path.join(root, 'src/services/publicStatusServer.js'), 'utf8');

  assert.match(interactionEvent, /await recordPublicInteraction\(\)/);
  assert.match(messageEvent, /featureResult\.handled[\s\S]+await recordPublicInteraction\(\)/);
  assert.match(mentionService, /await recordPublicInteraction\(\)/);
  assert.doesNotMatch(publicServer, /recordFeatureUsage|recordPublicInteraction|INSERT|UPDATE|DELETE/i);
});
