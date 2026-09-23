const http = require('node:http');
const { getEnv } = require('../utils/env');
const logger = require('../utils/logger');
const {
  buildPublicOverviewSnapshot,
  buildPublicStatusSnapshot,
} = require('./publicStatusService');

const DEFAULT_PUBLIC_STATUS_HOST = '127.0.0.1';
const DEFAULT_PUBLIC_STATUS_PORT = 8787;
const MAX_URL_LENGTH = 2048;
let activeServer = null;

function parseEnabled(value) {
  return String(value || '').trim().toLowerCase() === 'true';
}

function parsePort(value) {
  const port = Number.parseInt(String(value || ''), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_PUBLIC_STATUS_PORT;
}

function parseAllowedOrigins(value) {
  const origins = String(value || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  if (origins.length > 8) throw new Error('PUBLIC_STATUS_CORS_ORIGINS supports at most 8 origins.');

  return new Set(origins.map((origin) => {
    const parsed = new URL(origin);
    const isLoopbackHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if ((parsed.protocol !== 'https:' && !isLoopbackHttp) || parsed.pathname !== '/' || parsed.search || parsed.hash) {
      throw new Error('PUBLIC_STATUS_CORS_ORIGINS must contain exact HTTPS origins or loopback HTTP origins.');
    }
    return parsed.origin;
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

function writeJson(response, statusCode, payload, { headOnly = false } = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  response.statusCode = statusCode;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(body.length));
  response.end(headOnly ? undefined : body);
}

function createPublicStatusRequestHandler(
  client,
  {
    allowedOrigins = new Set(),
    overviewBuilder = buildPublicOverviewSnapshot,
    statusBuilder = buildPublicStatusSnapshot,
    loggerImpl = logger,
  } = {}
) {
  return async function handlePublicStatusRequest(request, response) {
    setSecurityHeaders(response);
    const headOnly = request.method === 'HEAD';
    const allowedMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
    if (!allowedMethods.has(request.method)) {
      response.setHeader('Allow', 'GET, HEAD, OPTIONS');
      writeJson(response, 405, { error: 'method_not_allowed' }, { headOnly });
      return;
    }

    if (typeof request.url !== 'string' || request.url.length > MAX_URL_LENGTH) {
      writeJson(response, 400, { error: 'bad_request' }, { headOnly });
      return;
    }

    let requestUrl;
    try {
      requestUrl = new URL(request.url, 'http://localhost');
    } catch (_error) {
      writeJson(response, 400, { error: 'bad_request' }, { headOnly });
      return;
    }

    const exactRoutes = new Set(['/api/public/overview', '/api/public/status']);
    if (requestUrl.search || requestUrl.hash || !exactRoutes.has(requestUrl.pathname)) {
      writeJson(response, 404, { error: 'not_found' }, { headOnly });
      return;
    }

    const origin = typeof request.headers.origin === 'string' ? request.headers.origin : null;

    if (origin) {
      if (!allowedOrigins.has(origin)) {
        writeJson(response, 403, { error: 'origin_not_allowed' }, { headOnly });
        return;
      }
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Vary', 'Origin');
      response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      response.setHeader('Access-Control-Allow-Headers', 'Accept');
    }

    if (request.method === 'OPTIONS') {
      response.statusCode = 204;
      response.end();
      return;
    }

    try {
      let payload;
      if (requestUrl.pathname === '/api/public/overview') {
        payload = await overviewBuilder(client);
      } else if (requestUrl.pathname === '/api/public/status') {
        payload = await statusBuilder(client);
      }

      writeJson(response, 200, payload, { headOnly });
    } catch (_error) {
      loggerImpl.error('[PUBLIC_STATUS] Snapshot generation failed.');
      writeJson(response, 503, { error: 'status_unavailable' }, { headOnly });
    }
  };
}

async function startPublicStatusServer(
  client,
  {
    enabled = parseEnabled(getEnv('PUBLIC_STATUS_ENABLED')),
    host = getEnv('PUBLIC_STATUS_HOST') || DEFAULT_PUBLIC_STATUS_HOST,
    port = parsePort(getEnv('PUBLIC_STATUS_PORT')),
    allowedOrigins = parseAllowedOrigins(getEnv('PUBLIC_STATUS_CORS_ORIGINS')),
    loggerImpl = logger,
  } = {}
) {
  if (!enabled) return { started: false, reason: 'disabled' };
  if (activeServer) return { started: true, reused: true, host, port: activeServer.address()?.port || port };

  const server = http.createServer(createPublicStatusRequestHandler(client, { allowedOrigins, loggerImpl }));
  server.requestTimeout = 5000;
  server.headersTimeout = 6000;
  server.keepAliveTimeout = 5000;

  await new Promise((resolve, reject) => {
    const handleError = (error) => {
      server.off('listening', handleListening);
      reject(error);
    };
    const handleListening = () => {
      server.off('error', handleError);
      resolve();
    };
    server.once('error', handleError);
    server.once('listening', handleListening);
    server.listen(port, host);
  });

  activeServer = server;
  const actualPort = server.address()?.port || port;
  loggerImpl.info(`[PUBLIC_STATUS] Server listening on ${host}:${actualPort}.`);
  return { started: true, reused: false, host, port: actualPort };
}

async function stopPublicStatusServer() {
  const server = activeServer;
  activeServer = null;
  if (!server) return false;
  await new Promise((resolve) => server.close(() => resolve()));
  return true;
}

module.exports = {
  DEFAULT_PUBLIC_STATUS_HOST,
  DEFAULT_PUBLIC_STATUS_PORT,
  createPublicStatusRequestHandler,
  parseAllowedOrigins,
  parseEnabled,
  parsePort,
  startPublicStatusServer,
  stopPublicStatusServer,
};
