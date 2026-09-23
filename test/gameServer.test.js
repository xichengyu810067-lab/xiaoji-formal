const test = require('node:test');
const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const {
  MAX_BODY_BYTES,
  RATE_LIMIT,
  createGameRequestHandler,
  parseAllowedOrigins,
  parseEnabled,
  parseHost,
  parsePort,
  startGameServer,
} = require('../src/services/gameServer');

function createRequest({ method = 'POST', url = '/api/games/session/exchange', origin, body = '{}', contentType = 'application/json', remoteAddress = '127.0.0.1' } = {}) {
  const request = Readable.from([Buffer.from(body)]);
  request.method = method;
  request.url = url;
  request.headers = {};
  if (origin) request.headers.origin = origin;
  if (contentType) request.headers['content-type'] = contentType;
  request.socket = { remoteAddress };
  return request;
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

async function invoke(handler, requestOptions) {
  const response = createResponse();
  await handler(createRequest(requestOptions), response);
  return { response, json: response.body.length ? JSON.parse(response.body.toString('utf8')) : null };
}

test('game HTTP handler exposes only exact POST routes with exact CORS and privacy-safe output', async () => {
  const calls = [];
  const handler = createGameRequestHandler({
    allowedOrigins: new Set(['https://games.example']),
    secret: 'synthetic-game-session-secret-32-bytes-minimum',
    exchange: async (token) => {
      calls.push(token);
      return { sessionId: 'opaque-session', accessToken: 'opaque-access', game: 'sudoku', difficulty: 'hard', state: { puzzle: [[1]], entries: [[1]] } };
    },
    submit: async () => ({ sessionId: 'opaque-session', status: 'active' }),
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    loggerImpl: { warn() {} },
  });

  const allowed = await invoke(handler, { origin: 'https://games.example', body: JSON.stringify({ token: 'opaque-launch' }) });
  assert.equal(allowed.response.statusCode, 200);
  assert.equal(allowed.response.headers.get('access-control-allow-origin'), 'https://games.example');
  assert.equal(allowed.response.headers.get('cache-control'), 'no-store');
  assert.equal(allowed.response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(calls, ['opaque-launch']);
  assert.doesNotMatch(JSON.stringify(allowed.json), /userId|guildId|channelId|123456789012345678/);

  assert.equal((await invoke(handler, { origin: 'https://evil.example' })).response.statusCode, 403);
  assert.equal((await invoke(handler, { method: 'GET' })).response.statusCode, 405);
  assert.equal((await invoke(handler, { url: '/api/games/private' })).response.statusCode, 404);
  assert.equal((await invoke(handler, { url: '/api/games/action?debug=true' })).response.statusCode, 404);
  assert.equal((await invoke(handler, { method: 'OPTIONS', origin: 'https://games.example' })).response.statusCode, 204);
  assert.equal((await invoke(handler, { contentType: 'text/plain' })).response.statusCode, 415);
});

test('game HTTP handler caps request bodies and rates each opaque token independently', async () => {
  const handler = createGameRequestHandler({
    secret: 'synthetic-game-session-secret-32-bytes-minimum',
    exchange: async () => ({ ok: true }),
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    loggerImpl: { warn() {} },
  });
  const oversized = await invoke(handler, { body: JSON.stringify({ token: 'x'.repeat(MAX_BODY_BYTES + 1) }) });
  assert.equal(oversized.response.statusCode, 413);
  assert.deepEqual(oversized.json, { error: 'body_too_large' });

  for (let index = 0; index < RATE_LIMIT; index += 1) {
    const result = await invoke(handler, { remoteAddress: '127.0.0.2', body: JSON.stringify({ token: 'token-a' }) });
    assert.equal(result.response.statusCode, 200);
  }
  const otherToken = await invoke(handler, { remoteAddress: '127.0.0.2', body: JSON.stringify({ token: 'token-b' }) });
  assert.equal(otherToken.response.statusCode, 200);
  const limited = await invoke(handler, { remoteAddress: '127.0.0.2', body: JSON.stringify({ token: 'token-a' }) });
  assert.equal(limited.response.statusCode, 429);
  assert.deepEqual(limited.json, { error: 'rate_limited' });
});

test('inactive sessions map to a stable conflict response', async () => {
  const handler = createGameRequestHandler({
    secret: 'synthetic-game-session-secret-32-bytes-minimum',
    submit: async () => { throw Object.assign(new Error('internal state detail'), { code: 'SESSION_NOT_ACTIVE' }); },
    now: () => new Date('2026-09-03T00:00:00.000Z'),
    loggerImpl: { warn() { throw new Error('409 must not be logged as an internal failure'); } },
  });
  const result = await invoke(handler, {
    url: '/api/games/action',
    body: JSON.stringify({ sessionId: 'opaque', accessToken: 'access-a', expectedIndex: 0, action: { type: 'set' } }),
  });
  assert.equal(result.response.statusCode, 409);
  assert.deepEqual(result.json, { error: 'session_not_active' });
});

test('game HTTP environment parsing is fail closed', () => {
  assert.equal(parseEnabled('TRUE'), true);
  assert.equal(parseEnabled('1'), false);
  assert.equal(parseHost('localhost'), 'localhost');
  assert.throws(() => parseHost('0.0.0.0'), /loopback/);
  assert.equal(parsePort('9011'), 9011);
  assert.deepEqual([...parseAllowedOrigins('https://games.example,http://127.0.0.1:4173')], [
    'https://games.example',
    'http://127.0.0.1:4173',
  ]);
  assert.throws(() => parseAllowedOrigins('*'));
  assert.throws(() => parseAllowedOrigins('http://games.example'));
  assert.throws(() => parseAllowedOrigins('https://games.example/path'));
});

test('disabled game server stays closed without parsing inactive unsafe configuration', async () => {
  const health = [];
  const result = await startGameServer({
    enabled: false,
    host: '0.0.0.0',
    allowedOrigins: new Set(['*']),
    healthReporter: async (...args) => { health.push(args); },
    loggerImpl: { info() {}, warn() {} },
  });
  assert.deepEqual(result, { started: false, reason: 'disabled' });
  assert.deepEqual(health.map(([feature, status]) => [feature, status]), [
    ['tetris', 'maintenance'],
    ['number_match', 'maintenance'],
    ['sudoku', 'maintenance'],
  ]);
});

test('enabled game server rejects a short secret before opening a listener', async () => {
  const health = [];
  await assert.rejects(() => startGameServer({
    enabled: true,
    host: '127.0.0.1',
    port: 8790,
    allowedOrigins: new Set(['https://games.example']),
    secret: 'short',
    healthReporter: async (...args) => { health.push(args); },
    loggerImpl: { info() {}, warn() {} },
  }), /at least 32 bytes/);
  assert.deepEqual(health.map(([feature, status]) => [feature, status]), [
    ['tetris', 'broken'],
    ['number_match', 'broken'],
    ['sudoku', 'broken'],
  ]);
});
