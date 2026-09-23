(function exposeGameClientCore(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.XiaojiGameClientCore = api;
})(typeof globalThis === 'object' ? globalThis : this, function createGameClientCore() {
  'use strict';

  const GAME_TYPES = new Set(['tetris', 'number-match', 'sudoku']);
  const DIFFICULTIES = new Set(['easy', 'normal', 'complex', 'hard']);
  const STATUSES = new Set(['active', 'completed', 'expired']);

  function normalizeApiBase(value, pageOrigin) {
    const configured = String(value || '/api/games').trim() || '/api/games';
    const url = new URL(configured, pageOrigin);
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.username || url.password || url.search || url.hash) {
      throw new Error('invalid_api_base');
    }
    return url.toString().replace(/\/$/, '');
  }

  function consumeLaunchToken(locationLike, historyLike) {
    const params = new URLSearchParams(String(locationLike.hash || '').replace(/^#/, ''));
    const token = params.get('token');
    historyLike.replaceState(null, '', `${locationLike.pathname}${locationLike.search || ''}`);
    if (!token || token.length > 256) throw new Error('missing_launch_token');
    return token;
  }

  function assertSessionPayload(payload, { requireAccessToken = false } = {}) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('invalid_session_payload');
    if (typeof payload.sessionId !== 'string' || payload.sessionId.length < 16 || payload.sessionId.length > 64) throw new Error('invalid_session_payload');
    if (!GAME_TYPES.has(payload.game) || !DIFFICULTIES.has(payload.difficulty) || !STATUSES.has(payload.status)) throw new Error('invalid_session_payload');
    if (!Number.isSafeInteger(payload.actionCount) || payload.actionCount < 0 || payload.actionCount > 500) throw new Error('invalid_session_payload');
    if (!payload.state || typeof payload.state !== 'object' || Array.isArray(payload.state)) throw new Error('invalid_session_payload');
    if (requireAccessToken && (typeof payload.accessToken !== 'string' || payload.accessToken.length < 32 || payload.accessToken.length > 256)) throw new Error('invalid_session_payload');
    return payload;
  }

  function createGameApi({
    fetchImpl,
    apiBase,
    timeoutMs = 8000,
    AbortControllerImpl = AbortController,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  }) {
    let sessionId = null;
    let accessToken = null;
    let expectedIndex = 0;

    async function post(path, body) {
      const controller = new AbortControllerImpl();
      const timeout = setTimeoutImpl(() => controller.abort(), timeoutMs);
      let response;
      try {
        response = await fetchImpl(`${apiBase}${path}`, {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } finally {
        clearTimeoutImpl(timeout);
      }
      let payload = null;
      try { payload = await response.json(); } catch (_error) { /* handled below */ }
      if (!response.ok) {
        const error = new Error('game_request_failed');
        error.code = typeof payload?.error === 'string' ? payload.error : 'game_unavailable';
        throw error;
      }
      return payload;
    }

    async function exchange(launchToken) {
      const payload = assertSessionPayload(await post('/session/exchange', { token: launchToken }), { requireAccessToken: true });
      sessionId = payload.sessionId;
      accessToken = payload.accessToken;
      expectedIndex = payload.actionCount;
      return payload;
    }

    async function submit(action) {
      if (!sessionId || !accessToken) throw new Error('session_not_started');
      const payload = assertSessionPayload(await post('/action', { sessionId, accessToken, expectedIndex, action }));
      expectedIndex = payload.actionCount;
      return payload;
    }

    return { exchange, submit };
  }

  return { assertSessionPayload, consumeLaunchToken, createGameApi, normalizeApiBase };
});
