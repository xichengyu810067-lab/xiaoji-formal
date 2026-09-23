const { createHmac } = require('node:crypto');
const { buildPublicStatusSnapshot } = require('./publicStatusService');
const { getEnv } = require('../utils/env');
const logger = require('../utils/logger');

const PUBLISH_INTERVAL_MS = 60_000;
const PUBLISH_TIMEOUT_MS = 5_000;
const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MIN_SECRET_LENGTH = 32;
let activePublisher = null;

function readEnv(env, name) {
  const value = env === process.env ? getEnv(name) : env?.[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function parseStatusSnapshotPublisherConfig(env = process.env) {
  const endpoint = readEnv(env, 'STATUS_SNAPSHOT_PUBLISHER_URL');
  const keyId = readEnv(env, 'STATUS_SNAPSHOT_PUBLISHER_KEY_ID');
  const secret = readEnv(env, 'STATUS_SNAPSHOT_PUBLISHER_SECRET');
  if (!endpoint || !keyId || !secret) return null;
  if (!KEY_ID_PATTERN.test(keyId) || secret.length < MIN_SECRET_LENGTH) return null;

  let url;
  try {
    url = new URL(endpoint);
  } catch (_error) {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash
    || url.pathname !== '/internal/status-snapshot') return null;
  return Object.freeze({ endpoint: url.toString(), keyId, secret });
}

function buildSignature(keyId, timestamp, body, secret) {
  return createHmac('sha256', secret)
    .update(keyId, 'utf8')
    .update('\n', 'utf8')
    .update(timestamp, 'utf8')
    .update('\n', 'utf8')
    .update(body)
    .digest('base64url');
}

function createStatusSnapshotPublisher(client, {
  config = parseStatusSnapshotPublisherConfig(),
  snapshotBuilder = buildPublicStatusSnapshot,
  fetchImpl = globalThis.fetch,
  loggerImpl = logger,
  now = () => new Date(),
  setIntervalImpl = setInterval,
  clearIntervalImpl = clearInterval,
  AbortControllerImpl = globalThis.AbortController,
  timeoutMs = PUBLISH_TIMEOUT_MS,
  intervalMs = PUBLISH_INTERVAL_MS,
} = {}) {
  let timer = null;
  let inFlight = false;
  let warnedFetchUnavailable = false;

  async function publish() {
    if (!config || inFlight) return false;
    if (typeof fetchImpl !== 'function' || typeof AbortControllerImpl !== 'function') {
      if (!warnedFetchUnavailable) {
        warnedFetchUnavailable = true;
        loggerImpl.warn('[STATUS_PUBLISHER] Disabled: HTTPS fetch is unavailable.');
      }
      return false;
    }

    inFlight = true;
    const controller = new AbortControllerImpl();
    let rejectDeadline;
    const deadline = new Promise((_, reject) => {
      rejectDeadline = reject;
    });
    const timeout = setTimeout(() => {
      controller.abort();
      rejectDeadline(new Error('status_snapshot_publish_timeout'));
    }, timeoutMs);
    try {
      // The builder reads aggregate health data and can itself stall. Race the
      // full operation, not just fetch, so a stuck read cannot permanently
      // keep inFlight true and suppress every later interval tick.
      const snapshot = await Promise.race([Promise.resolve().then(() => snapshotBuilder(client)), deadline]);
      const body = Buffer.from(JSON.stringify(snapshot));
      const timestamp = String(Math.floor(now().getTime() / 1000));
      const signature = buildSignature(config.keyId, timestamp, body, config.secret);
      const response = await fetchImpl(config.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Xiaoji-Key-Id': config.keyId,
          'X-Xiaoji-Timestamp': timestamp,
          'X-Xiaoji-Signature': signature,
        },
        body,
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response?.ok) {
        loggerImpl.warn('[STATUS_PUBLISHER] Snapshot upload was rejected or unavailable.');
        return false;
      }
      return true;
    } catch (_error) {
      loggerImpl.warn('[STATUS_PUBLISHER] Snapshot upload failed; the bot will keep running.');
      return false;
    } finally {
      clearTimeout(timeout);
      inFlight = false;
    }
  }

  function start() {
    if (!config) {
      loggerImpl.warn('[STATUS_PUBLISHER] Disabled: set STATUS_SNAPSHOT_PUBLISHER_URL, STATUS_SNAPSHOT_PUBLISHER_KEY_ID, and STATUS_SNAPSHOT_PUBLISHER_SECRET.');
      return { started: false, reason: 'missing_or_invalid_configuration' };
    }
    void publish();
    timer = setIntervalImpl(() => void publish(), intervalMs);
    timer.unref?.();
    return { started: true };
  }

  function stop() {
    if (!timer) return false;
    clearIntervalImpl(timer);
    timer = null;
    return true;
  }

  return { publish, start, stop };
}

function startStatusSnapshotPublisher(client, options = {}) {
  activePublisher?.stop();
  activePublisher = createStatusSnapshotPublisher(client, options);
  return activePublisher.start();
}

function stopStatusSnapshotPublisher() {
  const publisher = activePublisher;
  activePublisher = null;
  return publisher?.stop() || false;
}

module.exports = {
  MIN_SECRET_LENGTH,
  PUBLISH_INTERVAL_MS,
  PUBLISH_TIMEOUT_MS,
  buildSignature,
  createStatusSnapshotPublisher,
  parseStatusSnapshotPublisherConfig,
  startStatusSnapshotPublisher,
  stopStatusSnapshotPublisher,
};
