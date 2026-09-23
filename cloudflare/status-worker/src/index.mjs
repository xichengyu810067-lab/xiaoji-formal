const ALLOWED_ORIGIN = 'https://xiaoji-zeta.vercel.app';
const MAX_BODY_BYTES = 64 * 1024;
const MAX_SIGNATURE_AGE_SECONDS = 5 * 60;
const MAX_FUTURE_CLOCK_SKEW_SECONDS = 30;
const MAX_OBSERVED_TIMESTAMP_DRIFT_SECONDS = 5 * 60;
const FRESHNESS_MS = 120 * 1000;
const FEATURE_KEYS = Object.freeze([
  'core_chat', 'welcome', 'reminder', 'calendar', 'poll', 'weather', 'economy',
  'word_chain', 'number_chain', 'daily_riddle', 'daily_discussion', 'chat_style', 'romance',
  'tetris', 'number_match', 'sudoku', 'official_website', 'status_website',
]);
const FEATURE_STATUSES = new Set(['normal', 'maintenance', 'broken']);
const BOT_STATUSES = new Set(['operational', 'degraded', 'outage']);
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function securityHeaders(headers = new Headers()) {
  headers.set('Cache-Control', 'no-store');
  headers.set('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('X-Frame-Options', 'DENY');
  return headers;
}

function jsonResponse(payload, status = 200, { headOnly = false, cors = false } = {}) {
  const headers = securityHeaders();
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (cors) {
    headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Accept');
    headers.set('Vary', 'Origin');
  }
  return new Response(headOnly ? null : JSON.stringify(payload), { status, headers });
}

function emptyResponse(status, { cors = false } = {}) {
  const headers = securityHeaders();
  if (cors) {
    headers.set('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
    headers.set('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Accept');
    headers.set('Vary', 'Origin');
  }
  return new Response(null, { status, headers });
}

function hasOnlyKeys(value, allowed) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every((key) => allowed.includes(key));
}

function parseIsoTimestamp(value) {
  if (typeof value !== 'string' || value.length > 40) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) return null;
  return parsed;
}

function normalizeFeature(feature, { allowStored = false } = {}) {
  const inputKeys = ['key', 'name', 'category', 'status', 'detail', 'updatedAt', 'critical'];
  const storedKeys = ['key', 'name', 'category', 'status'];
  if (!hasOnlyKeys(feature, allowStored ? storedKeys : inputKeys)) return null;
  if (typeof feature.key !== 'string' || !FEATURE_KEYS.includes(feature.key)) return null;
  if (typeof feature.name !== 'string' || !feature.name || feature.name.length > 80) return null;
  if (typeof feature.category !== 'string' || !feature.category || feature.category.length > 80) return null;
  if (!FEATURE_STATUSES.has(feature.status)) return null;
  if (!allowStored && (parseIsoTimestamp(feature.updatedAt) === null || typeof feature.critical !== 'boolean')) {
    return null;
  }
  if (!allowStored && (typeof feature.detail !== 'string' || feature.detail.length > 120)) return null;
  return { key: feature.key, name: feature.name, category: feature.category, status: feature.status };
}

export function validatePublicSnapshot(value, { allowStored = false } = {}) {
  if (!hasOnlyKeys(value, ['schemaVersion', 'updatedAt', 'timezone', 'bot', 'guilds', 'usage', 'summary', 'features'])) return null;
  if (value.schemaVersion !== 1 || value.timezone !== 'Asia/Taipei' || parseIsoTimestamp(value.updatedAt) === null) return null;
  if (!hasOnlyKeys(value.bot, ['status', 'version', 'latencyMs']) || !BOT_STATUSES.has(value.bot.status)
    || typeof value.bot.version !== 'string' || value.bot.version.length > 40
    || !(value.bot.latencyMs === null || (Number.isSafeInteger(value.bot.latencyMs) && value.bot.latencyMs >= 0))) return null;
  if (!hasOnlyKeys(value.guilds, ['adoptedCount'])
    || !(value.guilds.adoptedCount === null || (Number.isSafeInteger(value.guilds.adoptedCount) && value.guilds.adoptedCount >= 0))) return null;
  if (!hasOnlyKeys(value.usage, ['date', 'todayInteractions', 'available']) || !ISO_DATE_PATTERN.test(value.usage.date)
    || typeof value.usage.available !== 'boolean'
    || !(value.usage.todayInteractions === null || (Number.isSafeInteger(value.usage.todayInteractions) && value.usage.todayInteractions >= 0))
    || (value.usage.available !== (value.usage.todayInteractions !== null))) return null;
  if (!hasOnlyKeys(value.summary, ['normal', 'maintenance', 'broken'])) return null;
  if (!Array.isArray(value.features) || value.features.length !== FEATURE_KEYS.length) return null;

  const features = value.features.map((feature) => normalizeFeature(feature, { allowStored }));
  if (features.some((feature) => feature === null)) return null;
  const keys = new Set(features.map((feature) => feature.key));
  if (keys.size !== FEATURE_KEYS.length || FEATURE_KEYS.some((key) => !keys.has(key))) return null;
  const summary = features.reduce((result, feature) => {
    result[feature.status] += 1;
    return result;
  }, { normal: 0, maintenance: 0, broken: 0 });
  if (!Object.entries(summary).every(([key, count]) => value.summary[key] === count)) return null;

  return {
    schemaVersion: 1,
    updatedAt: value.updatedAt,
    timezone: 'Asia/Taipei',
    bot: { status: value.bot.status, version: value.bot.version, latencyMs: value.bot.latencyMs },
    guilds: { adoptedCount: value.guilds.adoptedCount },
    usage: { date: value.usage.date, todayInteractions: value.usage.todayInteractions, available: value.usage.available },
    summary,
    features,
  };
}

function signingBytes(keyId, timestamp, body) {
  const prefix = new TextEncoder().encode(`${keyId}\n${timestamp}\n`);
  const result = new Uint8Array(prefix.length + body.length);
  result.set(prefix);
  result.set(body, prefix.length);
  return result;
}

function base64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function constantTimeEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function verifySignature({ keyId, timestamp, signature, body, env }) {
  if (!KEY_ID_PATTERN.test(keyId) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const timestampNumber = Number(timestamp);
  if (!/^\d{10}$/.test(timestamp) || !Number.isSafeInteger(timestampNumber)) return false;
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (timestampNumber < nowSeconds - MAX_SIGNATURE_AGE_SECONDS
    || timestampNumber > nowSeconds + MAX_FUTURE_CLOCK_SKEW_SECONDS) return false;

  let secret = null;
  if (keyId === env.STATUS_HMAC_CURRENT_KEY_ID) secret = env.STATUS_HMAC_CURRENT_SECRET;
  if (!secret && keyId === env.STATUS_HMAC_PREVIOUS_KEY_ID) secret = env.STATUS_HMAC_PREVIOUS_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) return false;

  const cryptoKey = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const expected = base64Url(new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, signingBytes(keyId, timestamp, body))));
  return constantTimeEqual(expected, signature);
}

function isObservedAtAcceptable(observedAt, signedTimestamp) {
  const observedAtMs = parseIsoTimestamp(observedAt);
  const signedAtMs = Number(signedTimestamp) * 1000;
  if (observedAtMs === null || !Number.isFinite(signedAtMs)) return false;
  if (observedAtMs > Date.now() + MAX_FUTURE_CLOCK_SKEW_SECONDS * 1000) return false;
  return Math.abs(observedAtMs - signedAtMs) <= MAX_OBSERVED_TIMESTAMP_DRIFT_SECONDS * 1000;
}

async function readBodyLimited(request) {
  const statedLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(statedLength) && statedLength > MAX_BODY_BYTES) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function unknownSnapshot() {
  return {
    schemaVersion: 1,
    updatedAt: null,
    timezone: 'Asia/Taipei',
    bot: { status: 'unknown', version: null, latencyMs: null },
    guilds: { adoptedCount: null },
    usage: { date: null, todayInteractions: null, available: false },
    summary: { normal: 0, maintenance: 0, broken: 0 },
    features: [],
  };
}

function staleSnapshot(snapshot) {
  const features = snapshot.features.map((feature) => ({
    ...feature,
    status: feature.status === 'broken' ? 'broken' : 'maintenance',
  }));
  const summary = features.reduce((result, feature) => {
    result[feature.status] += 1;
    return result;
  }, { normal: 0, maintenance: 0, broken: 0 });
  return {
    ...snapshot,
    bot: { ...snapshot.bot, status: snapshot.bot.status === 'outage' ? 'outage' : 'degraded' },
    guilds: { adoptedCount: null },
    usage: { date: snapshot.usage.date, todayInteractions: null, available: false },
    summary,
    features,
  };
}

async function loadSnapshot(env) {
  const row = await env.STATUS_DB.prepare(
    'SELECT observed_at, payload_json FROM public_status_snapshot WHERE singleton = 1'
  ).first();
  if (!row || typeof row.observed_at !== 'string' || typeof row.payload_json !== 'string') return unknownSnapshot();
  let snapshot;
  try {
    snapshot = validatePublicSnapshot(JSON.parse(row.payload_json), { allowStored: true });
  } catch (_error) {
    snapshot = null;
  }
  const observedAt = parseIsoTimestamp(row.observed_at);
  if (!snapshot || observedAt === null) return unknownSnapshot();
  const age = Date.now() - observedAt;
  return age >= 0 && age <= FRESHNESS_MS ? snapshot : staleSnapshot(snapshot);
}

function publicOverview(snapshot) {
  const { features, ...overview } = snapshot;
  return overview;
}

async function handlePublish(request, env) {
  if (request.method !== 'POST') return jsonResponse({ error: 'not_found' }, 404);
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    return jsonResponse({ error: 'request_rejected' }, 401);
  }
  const body = await readBodyLimited(request);
  if (body === null) return jsonResponse({ error: 'request_rejected' }, 413);
  const keyId = request.headers.get('X-Xiaoji-Key-Id') || '';
  const timestamp = request.headers.get('X-Xiaoji-Timestamp') || '';
  const signature = request.headers.get('X-Xiaoji-Signature') || '';
  if (!await verifySignature({ keyId, timestamp, signature, body, env })) {
    return jsonResponse({ error: 'request_rejected' }, 401);
  }
  let snapshot;
  try {
    snapshot = validatePublicSnapshot(JSON.parse(new TextDecoder().decode(body)));
  } catch (_error) {
    snapshot = null;
  }
  if (!snapshot) return jsonResponse({ error: 'request_rejected' }, 400);
  if (!isObservedAtAcceptable(snapshot.updatedAt, timestamp)) return jsonResponse({ error: 'request_rejected' }, 400);

  const result = await env.STATUS_DB.prepare(
    `INSERT INTO public_status_snapshot (singleton, observed_at, received_at, payload_json)
     VALUES (1, ?1, ?2, ?3)
     ON CONFLICT(singleton) DO UPDATE SET
       observed_at = excluded.observed_at,
       received_at = excluded.received_at,
       payload_json = excluded.payload_json
     WHERE excluded.observed_at > public_status_snapshot.observed_at`
  ).bind(snapshot.updatedAt, new Date().toISOString(), JSON.stringify(snapshot)).run();
  if (Number(result?.meta?.changes) !== 1) return jsonResponse({ error: 'request_rejected' }, 409);
  return jsonResponse({ accepted: true }, 202);
}

async function handlePublicRead(request, env, pathname) {
  const origin = request.headers.get('Origin');
  if (origin && origin !== ALLOWED_ORIGIN) return jsonResponse({ error: 'not_found' }, 404, { headOnly: request.method === 'HEAD' });
  const cors = origin === ALLOWED_ORIGIN;
  if (request.method === 'OPTIONS') return cors ? emptyResponse(204, { cors: true }) : jsonResponse({ error: 'not_found' }, 404);
  if (!['GET', 'HEAD'].includes(request.method)) return jsonResponse({ error: 'not_found' }, 404, { headOnly: request.method === 'HEAD', cors });
  try {
    const snapshot = await loadSnapshot(env);
    return jsonResponse(pathname.endsWith('/overview') ? publicOverview(snapshot) : snapshot, 200, {
      headOnly: request.method === 'HEAD', cors,
    });
  } catch (_error) {
    return jsonResponse(unknownSnapshot(), 503, { headOnly: request.method === 'HEAD', cors });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.search || url.hash) return jsonResponse({ error: 'not_found' }, 404);
    if (url.pathname === '/internal/status-snapshot') return handlePublish(request, env);
    if (url.pathname === '/api/public/overview' || url.pathname === '/api/public/status') {
      return handlePublicRead(request, env, url.pathname);
    }
    return jsonResponse({ error: 'not_found' }, 404, { headOnly: request.method === 'HEAD' });
  },
};
