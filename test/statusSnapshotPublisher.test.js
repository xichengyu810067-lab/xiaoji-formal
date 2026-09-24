const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const {
  buildSignature,
  createStatusSnapshotPublisher,
  parseStatusSnapshotPublisherConfig,
} = require('../src/services/statusSnapshotPublisher');

const workerModuleUrl = pathToFileURL(path.join(__dirname, '..', 'cloudflare/status-worker/src/index.mjs')).href;
const featureKeys = [
  'core_chat', 'welcome', 'reminder', 'calendar', 'poll', 'weather', 'economy',
  'word_chain', 'number_chain', 'daily_riddle', 'daily_discussion', 'chat_style', 'romance',
  'tetris', 'number_match', 'sudoku', 'official_website', 'status_website',
];
const secret = 'status-publisher-test-secret-that-is-long-enough';

function makeSnapshot({ updatedAt = new Date().toISOString(), brokenKey = null } = {}) {
  const features = featureKeys.map((key) => ({
    key,
    name: `功能 ${key}`,
    category: '測試',
    status: key === brokenKey ? 'broken' : 'normal',
    detail: key === brokenKey ? '功能目前發生異常' : '功能目前可使用',
    updatedAt,
    critical: key === 'core_chat' || key === 'economy',
  }));
  return {
    schemaVersion: 1,
    updatedAt,
    timezone: 'Asia/Taipei',
    bot: { status: brokenKey ? 'degraded' : 'operational', version: '1.0.0', latencyMs: 12 },
    guilds: { adoptedCount: 3 },
    usage: { date: '2026-09-04', todayInteractions: 9, available: true },
    summary: {
      normal: brokenKey ? featureKeys.length - 1 : featureKeys.length,
      maintenance: 0,
      broken: brokenKey ? 1 : 0,
    },
    features,
  };
}

function makeDatabase() {
  let row = null;
  return {
    get row() { return row; },
    prepare(query) {
      return {
        bind(...values) {
          return {
            async first() { return row; },
            async run() {
              const [observedAt, receivedAt, payloadJson] = values;
              if (row && observedAt <= row.observed_at) return { meta: { changes: 0 } };
              row = { observed_at: observedAt, received_at: receivedAt, payload_json: payloadJson };
              return { meta: { changes: 1 } };
            },
          };
        },
        async first() { return row; },
      };
    },
  };
}

function signRequest(snapshot, { keyId = 'current-key', timestamp = String(Math.floor(Date.now() / 1000)) } = {}) {
  const body = Buffer.from(JSON.stringify(snapshot));
  const signature = createHmac('sha256', secret)
    .update(keyId).update('\n').update(timestamp).update('\n').update(body)
    .digest('base64url');
  return new Request('https://worker.example/internal/status-snapshot', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Xiaoji-Key-Id': keyId,
      'X-Xiaoji-Timestamp': timestamp,
      'X-Xiaoji-Signature': signature,
    },
    body,
  });
}

function makeEnvironment(database = makeDatabase()) {
  return {
    STATUS_DB: database,
    STATUS_HMAC_CURRENT_KEY_ID: 'current-key',
    STATUS_HMAC_CURRENT_SECRET: secret,
    STATUS_HMAC_PREVIOUS_KEY_ID: 'previous-key',
    STATUS_HMAC_PREVIOUS_SECRET: secret,
  };
}

test('Cloudflare Worker verifies HMAC, writes only validated snapshots, and limits CORS', async () => {
  const worker = (await import(workerModuleUrl)).default;
  const database = makeDatabase();
  const env = makeEnvironment(database);
  const snapshot = makeSnapshot({ updatedAt: new Date(Date.now() - 1_000).toISOString() });
  const accepted = await worker.fetch(signRequest(snapshot), env);
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: true });
  assert.doesNotMatch(database.row.payload_json, /guildId|channelId|userId|messageId|secret/i);

  const rotatedSnapshot = makeSnapshot({ updatedAt: new Date().toISOString() });
  assert.equal((await worker.fetch(signRequest(rotatedSnapshot, { keyId: 'previous-key' }), env)).status, 202);

  const publicResponse = await worker.fetch(new Request('https://worker.example/api/public/status', {
    headers: { Origin: 'https://xiaoji-zeta.vercel.app' },
  }), env);
  assert.equal(publicResponse.status, 200);
  assert.equal(publicResponse.headers.get('access-control-allow-origin'), 'https://xiaoji-zeta.vercel.app');
  assert.equal(publicResponse.headers.get('cache-control'), 'no-store');
  assert.equal((await publicResponse.json()).guilds.adoptedCount, 3);

  const deniedOrigin = await worker.fetch(new Request('https://worker.example/api/public/status', {
    headers: { Origin: 'https://evil.example' },
  }), env);
  assert.equal(deniedOrigin.status, 404);
  assert.equal(deniedOrigin.headers.get('access-control-allow-origin'), null);

  const internalCors = await worker.fetch(new Request('https://worker.example/internal/status-snapshot', { method: 'OPTIONS' }), env);
  assert.equal(internalCors.status, 404);
  assert.equal(internalCors.headers.get('access-control-allow-origin'), null);

  const oversized = await worker.fetch(new Request('https://worker.example/internal/status-snapshot', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': String(64 * 1024 + 1) },
    body: '{}',
  }), env);
  assert.equal(oversized.status, 413);
  assert.deepEqual(await oversized.json(), { error: 'request_rejected' });
});

test('Cloudflare Worker fails closed for invalid authentication, stale data, missing data, and out-of-order snapshots', async () => {
  const worker = (await import(workerModuleUrl)).default;
  const database = makeDatabase();
  const env = makeEnvironment(database);
  const fresh = makeSnapshot({ updatedAt: new Date().toISOString(), brokenKey: 'daily_riddle' });
  assert.equal((await worker.fetch(signRequest(fresh), env)).status, 202);

  const old = makeSnapshot({ updatedAt: new Date(Date.now() - 1_000).toISOString() });
  assert.equal((await worker.fetch(signRequest(old), env)).status, 409);

  const invalid = await worker.fetch(new Request('https://worker.example/internal/status-snapshot', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  }), env);
  assert.equal(invalid.status, 401);
  assert.deepEqual(await invalid.json(), { error: 'request_rejected' });

  const staleDatabase = makeDatabase();
  const staleEnv = makeEnvironment(staleDatabase);
  const stale = makeSnapshot({ updatedAt: new Date(Date.now() - 121_000).toISOString(), brokenKey: 'daily_riddle' });
  assert.equal((await worker.fetch(signRequest(stale, {
    timestamp: String(Math.floor((Date.now() - 121_000) / 1000)),
  }), staleEnv)).status, 202);
  const staleStatus = await worker.fetch(new Request('https://worker.example/api/public/status'), staleEnv);
  const stalePayload = await staleStatus.json();
  assert.equal(stalePayload.guilds.adoptedCount, null);
  assert.equal(stalePayload.usage.todayInteractions, null);
  assert.equal(stalePayload.features.find((feature) => feature.key === 'daily_riddle').status, 'broken');
  assert.equal(stalePayload.features.find((feature) => feature.key === 'core_chat').status, 'maintenance');

  const unknown = await worker.fetch(new Request('https://worker.example/api/public/overview'), makeEnvironment(makeDatabase()));
  const unknownPayload = await unknown.json();
  assert.equal(unknownPayload.bot.status, 'unknown');
  assert.equal(unknownPayload.guilds.adoptedCount, null);
  assert.equal(unknownPayload.features, undefined);

  const futureDatabase = makeDatabase();
  const futureEnv = makeEnvironment(futureDatabase);
  const future = makeSnapshot({ updatedAt: new Date(Date.now() + 31_000).toISOString() });
  assert.equal((await worker.fetch(signRequest(future), futureEnv)).status, 400);
  assert.equal((await worker.fetch(signRequest(makeSnapshot()), futureEnv)).status, 202);
});

test('status snapshot publisher signs the exact body, starts immediately, and contains failures', async () => {
  const calls = [];
  const timers = [];
  const warnings = [];
  const snapshot = makeSnapshot({ updatedAt: '2026-09-04T00:00:00.000Z' });
  const config = parseStatusSnapshotPublisherConfig({
    STATUS_SNAPSHOT_PUBLISHER_URL: 'https://worker.example/internal/status-snapshot',
    STATUS_SNAPSHOT_PUBLISHER_KEY_ID: 'current-key',
    STATUS_SNAPSHOT_PUBLISHER_SECRET: secret,
  });
  assert(config);
  const publisher = createStatusSnapshotPublisher({}, {
    config,
    snapshotBuilder: async () => snapshot,
    now: () => new Date('2026-09-04T00:00:30.000Z'),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return new Response(null, { status: 202 });
    },
    loggerImpl: { warn: (message) => warnings.push(message) },
    setIntervalImpl: (callback, interval) => {
      const timer = { callback, interval, unref() {} };
      timers.push(timer);
      return timer;
    },
    clearIntervalImpl: (timer) => { timer.cleared = true; },
  });
  assert.deepEqual(publisher.start(), { started: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://worker.example/internal/status-snapshot');
  const timestamp = calls[0].options.headers['X-Xiaoji-Timestamp'];
  const sentBody = Buffer.from(calls[0].options.body);
  assert.equal(calls[0].options.headers['X-Xiaoji-Signature'], buildSignature('current-key', timestamp, sentBody, secret));
  assert.equal(calls[0].options.redirect, 'error');
  assert.equal(timers[0].interval, 60_000);
  assert.equal(publisher.stop(), true);
  assert.equal(timers[0].cleared, true);
  assert.deepEqual(warnings, []);

  const failedWarnings = [];
  const failingPublisher = createStatusSnapshotPublisher({}, {
    config,
    snapshotBuilder: async () => snapshot,
    fetchImpl: async () => { throw new Error('do not disclose this secret'); },
    loggerImpl: { warn: (message) => failedWarnings.push(message) },
  });
  assert.equal(await failingPublisher.publish(), false);
  assert.deepEqual(failedWarnings, ['[STATUS_PUBLISHER] Snapshot upload failed; the bot will keep running.']);

  let snapshotAttempts = 0;
  const deadlineWarnings = [];
  const deadlinePublisher = createStatusSnapshotPublisher({}, {
    config,
    timeoutMs: 5,
    snapshotBuilder: async () => {
      snapshotAttempts += 1;
      if (snapshotAttempts === 1) return new Promise(() => {});
      return snapshot;
    },
    fetchImpl: async () => new Response(null, { status: 202 }),
    loggerImpl: { warn: (message) => deadlineWarnings.push(message) },
  });
  assert.equal(await deadlinePublisher.publish(), false);
  assert.equal(await deadlinePublisher.publish(), true);
  assert.equal(snapshotAttempts, 2);
  assert.deepEqual(deadlineWarnings, ['[STATUS_PUBLISHER] Snapshot upload failed; the bot will keep running.']);
  assert.equal(parseStatusSnapshotPublisherConfig({}), null);
});
