const test = require('node:test');
const assert = require('node:assert/strict');
const { assertSessionPayload, consumeLaunchToken, createGameApi, normalizeApiBase } = require('../website/games/gameClientCore');

function session(overrides = {}) {
  return {
    sessionId: '0123456789abcdef0123456789abcdef',
    accessToken: 'a'.repeat(43),
    game: 'sudoku', difficulty: 'easy', status: 'active', actionCount: 0,
    state: { puzzle: [], entries: [] },
    ...overrides,
  };
}

test('game client consumes the fragment token without sending it in a URL', () => {
  const replacements = [];
  const token = consumeLaunchToken(
    { hash: '#token=opaque-once', pathname: '/games/sudoku', search: '?difficulty=easy' },
    { replaceState: (...args) => replacements.push(args) }
  );
  assert.equal(token, 'opaque-once');
  assert.deepEqual(replacements, [[null, '', '/games/sudoku?difficulty=easy']]);
});

test('game client accepts only safe API bases and bounded allowlisted state', () => {
  assert.equal(normalizeApiBase('/api/games', 'https://xiaoji.example'), 'https://xiaoji.example/api/games');
  assert.equal(normalizeApiBase('http://127.0.0.1:8790/api/games/', 'http://127.0.0.1:4173'), 'http://127.0.0.1:8790/api/games');
  assert.throws(() => normalizeApiBase('http://public.example/api/games', 'https://xiaoji.example'));
  assert.throws(() => normalizeApiBase('https://name:secret@xiaoji.example/api/games', 'https://xiaoji.example'));
  assert.equal(assertSessionPayload(session(), { requireAccessToken: true }).game, 'sudoku');
  assert.throws(() => assertSessionPayload(session({ game: 'admin' })));
  assert.throws(() => assertSessionPayload(session({ actionCount: 501 })));
});

test('game client submits only server action data and advances from server actionCount', async () => {
  const requests = [];
  const payloads = [session(), session({ accessToken: undefined, actionCount: 1 })];
  const api = createGameApi({
    apiBase: 'https://xiaoji.example/api/games',
    fetchImpl: async (url, options) => {
      requests.push({ url, body: JSON.parse(options.body) });
      return { ok: true, json: async () => payloads.shift() };
    },
  });
  await api.exchange('launch-token');
  await api.submit({ type: 'set', row: 0, column: 2, value: 4 });
  assert.deepEqual(requests, [
    { url: 'https://xiaoji.example/api/games/session/exchange', body: { token: 'launch-token' } },
    { url: 'https://xiaoji.example/api/games/action', body: {
      sessionId: '0123456789abcdef0123456789abcdef', accessToken: 'a'.repeat(43), expectedIndex: 0,
      action: { type: 'set', row: 0, column: 2, value: 4 },
    } },
  ]);
  assert.doesNotMatch(JSON.stringify(requests), /score|reward|userId|guildId|channelId/);
});
