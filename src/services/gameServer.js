const http = require('node:http');
const { createHash } = require('node:crypto');
const { getEnv } = require('../utils/env');
const logger = require('../utils/logger');
const { setFeatureHealth } = require('./featurePlatformService');
const { exchangeLaunchToken, submitGameAction } = require('./gameService');

const DEFAULT_GAME_HOST = '127.0.0.1';
const DEFAULT_GAME_PORT = 8790;
const MAX_BODY_BYTES = 8192;
const MAX_URL_LENGTH = 512;
const RATE_LIMIT = 60;
let activeServer = null;

function parseEnabled(value) { return String(value || '').trim().toLowerCase() === 'true'; }
function parsePort(value) { const port = Number.parseInt(String(value || ''), 10); return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_GAME_PORT; }
function parseHost(value) {
  const host = String(value || DEFAULT_GAME_HOST).trim().toLowerCase();
  if (!['127.0.0.1', '::1', 'localhost'].includes(host)) throw new Error('GAME_SERVER_HOST must be loopback.');
  return host;
}
function parseAllowedOrigins(value) {
  const items = String(value || '').split(',').map((item) => item.trim()).filter(Boolean);
  if (items.length > 8) throw new Error('GAME_CORS_ORIGINS supports at most 8 origins.');
  return new Set(items.map((item) => {
    const url = new URL(item);
    const loopback = url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if ((url.protocol !== 'https:' && !loopback) || url.pathname !== '/' || url.search || url.hash) throw new Error('GAME_CORS_ORIGINS must contain exact HTTPS or loopback HTTP origins.');
    return url.origin;
  }));
}
function setSecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  response.setHeader('Cross-Origin-Resource-Policy', 'same-site');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
}
function writeJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload)); response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8'); response.setHeader('Content-Length', String(body.length)); response.end(body);
}
function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = []; let exceeded = false;
    request.on('data', (chunk) => { size += chunk.length; if (size > MAX_BODY_BYTES) exceeded = true; else chunks.push(chunk); });
    request.on('end', () => {
      if (exceeded) { reject(Object.assign(new Error('body too large'), { code: 'BODY_TOO_LARGE' })); return; }
      try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); resolve(value); }
      catch (_error) { reject(Object.assign(new Error('bad json'), { code: 'BAD_JSON' })); }
    });
    request.on('error', reject);
  });
}

function createGameRequestHandler({ allowedOrigins = new Set(), secret, exchange = exchangeLaunchToken, submit = submitGameAction, now = () => new Date(), loggerImpl = logger } = {}) {
  const rate = new Map();
  return async function handle(request, response) {
    setSecurityHeaders(response);
    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : null;
    if (origin && !allowedOrigins.has(origin)) { writeJson(response, 403, { error: 'origin_not_allowed' }); return; }
    if (origin) { response.setHeader('Access-Control-Allow-Origin', origin); response.setHeader('Vary', 'Origin'); response.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS'); response.setHeader('Access-Control-Allow-Headers', 'Content-Type'); }
    if (typeof request.url !== 'string' || request.url.length > MAX_URL_LENGTH) { writeJson(response, 400, { error: 'bad_request' }); return; }
    let url; try { url = new URL(request.url, 'http://localhost'); } catch (_error) { writeJson(response, 400, { error: 'bad_request' }); return; }
    const routes = new Set(['/api/games/session/exchange', '/api/games/action']);
    if (url.search || url.hash || !routes.has(url.pathname)) { writeJson(response, 404, { error: 'not_found' }); return; }
    if (request.method === 'OPTIONS') { response.statusCode = 204; response.end(); return; }
    if (request.method !== 'POST') { response.setHeader('Allow', 'POST, OPTIONS'); writeJson(response, 405, { error: 'method_not_allowed' }); return; }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) { writeJson(response, 415, { error: 'unsupported_media_type' }); return; }
    try {
      const body = await readJsonBody(request);
      const credential = url.pathname.endsWith('/exchange') ? body.token : body.accessToken;
      const key = `${url.pathname}:${createHash('sha256').update(typeof credential === 'string' ? credential : '').digest('hex')}`;
      const current = now(); const bucket = rate.get(key);
      if (!bucket || current.getTime() - bucket.startedAt >= 60000) rate.set(key, { startedAt: current.getTime(), count: 1 });
      else if (++bucket.count > RATE_LIMIT) { writeJson(response, 429, { error: 'rate_limited' }); return; }
      if (rate.size > 1000) rate.clear();
      let payload;
      if (url.pathname.endsWith('/exchange')) payload = await exchange(body.token, { secret, now: current });
      else payload = await submit({ sessionId: body.sessionId, accessToken: body.accessToken, expectedIndex: body.expectedIndex, action: body.action, secret, now: current });
      writeJson(response, 200, payload);
    } catch (error) {
      const status = error?.code === 'BODY_TOO_LARGE' ? 413 : error?.code === 'BAD_JSON' || error?.code === 'INVALID_ACTION' || error?.code === 'INVALID_REQUEST' ? 400 : error?.code === 'TOKEN_INVALID' ? 401 : error?.code === 'SESSION_EXPIRED' ? 410 : error?.code === 'REPLAY_MISMATCH' || error?.code === 'SESSION_NOT_ACTIVE' ? 409 : 503;
      if (status === 503) loggerImpl.warn('[GAME_SERVER] Request failed with a fixed internal error.');
      writeJson(response, status, { error: status === 503 ? 'game_unavailable' : String(error.code || 'bad_request').toLowerCase() });
    }
  };
}

async function reportGameHealth(status, detail, healthReporter, loggerImpl) {
  for (const feature of ['tetris', 'number_match', 'sudoku']) {
    try { await healthReporter(feature, status, { detail }); }
    catch (_error) { loggerImpl.warn('[GAME_SERVER] Health status update failed.'); }
  }
}

async function startGameServer(options = {}) {
  const enabled = options.enabled ?? parseEnabled(getEnv('GAME_SERVER_ENABLED'));
  const loggerImpl = options.loggerImpl || logger;
  const healthReporter = options.healthReporter || setFeatureHealth;
  if (!enabled) {
    await reportGameHealth('maintenance', 'game_server_disabled', healthReporter, loggerImpl);
    return { started: false, reason: 'disabled' };
  }
  const host = parseHost(options.host ?? getEnv('GAME_SERVER_HOST'));
  const port = parsePort(options.port ?? getEnv('GAME_SERVER_PORT'));
  const allowedOrigins = options.allowedOrigins || parseAllowedOrigins(getEnv('GAME_CORS_ORIGINS'));
  const secret = options.secret ?? getEnv('GAME_SESSION_SECRET');
  if (activeServer) return { started: true, reused: true, port: activeServer.address()?.port || port };
  if (!secret || Buffer.byteLength(String(secret)) < 32) {
    await reportGameHealth('broken', 'game_server_configuration_invalid', healthReporter, loggerImpl);
    throw new Error('GAME_SESSION_SECRET must contain at least 32 bytes when game server is enabled.');
  }
  const server = http.createServer(createGameRequestHandler({ allowedOrigins, secret, loggerImpl }));
  server.requestTimeout = 5000; server.headersTimeout = 6000; server.keepAliveTimeout = 3000;
  try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.once('listening', resolve); server.listen(port, host); });
  } catch (error) {
    await reportGameHealth('broken', 'game_server_start_failed', healthReporter, loggerImpl);
    throw error;
  }
  activeServer = server; const actualPort = server.address()?.port || port;
  await reportGameHealth('normal', 'game_server_ready', healthReporter, loggerImpl);
  loggerImpl.info(`[GAME_SERVER] Listening on ${host}:${actualPort}.`);
  return { started: true, reused: false, host, port: actualPort };
}
async function stopGameServer() { const server = activeServer; activeServer = null; if (!server) return false; await new Promise((resolve) => server.close(resolve)); return true; }

module.exports = { DEFAULT_GAME_HOST, DEFAULT_GAME_PORT, MAX_BODY_BYTES, MAX_URL_LENGTH, RATE_LIMIT, createGameRequestHandler, parseAllowedOrigins, parseEnabled, parseHost, parsePort, startGameServer, stopGameServer };
