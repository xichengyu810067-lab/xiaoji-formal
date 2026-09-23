const packageJson = require('../../package.json');
const { PUBLIC_FEATURE_CATALOG } = require('../../website/statusData');
const { getTaipeiDateKey } = require('../utils/taipeiClock');
const logger = require('../utils/logger');
const {
  listFeatureHealth,
  listFeatureUsageForDate,
  recordFeatureUsage,
} = require('./featurePlatformService');

const PUBLIC_STATUS_SCHEMA_VERSION = 1;
const PUBLIC_USAGE_FEATURE_KEY = 'public_website';
const PUBLIC_USAGE_METRIC_KEY = 'accepted';

const publicFeatureCatalogByKey = new Map(PUBLIC_FEATURE_CATALOG.map((feature) => [feature.key, feature]));

function publicFeature(key, attributes = {}) {
  const feature = publicFeatureCatalogByKey.get(key);
  if (!feature) throw new Error(`Unknown public feature catalog key: ${key}`);
  return Object.freeze({ ...feature, ...attributes });
}

const PUBLIC_FEATURES = Object.freeze([
  publicFeature('core_chat', { type: 'ready', critical: true }),
  publicFeature('welcome', { commands: ['set-welcome'] }),
  publicFeature('reminder', { commands: ['remind'] }),
  publicFeature('calendar', { commands: ['calendar'] }),
  publicFeature('poll', { commands: ['poll'] }),
  publicFeature('weather', { commands: ['weather'] }),
  publicFeature('economy', { commands: ['coins', 'daily', 'economy'], critical: true, requiresDatabase: true }),
  publicFeature('word_chain', { commands: ['word-chain'], healthKey: 'word_chain' }),
  publicFeature('number_chain', { commands: ['number-chain'], healthKey: 'number_chain' }),
  publicFeature('daily_riddle', { commands: ['daily-riddle'], healthKey: 'daily_riddle' }),
  publicFeature('daily_discussion', { commands: ['daily-discussion'], healthKey: 'daily_discussion' }),
  publicFeature('chat_style', { commands: ['chat-style'], healthKey: 'conversation_style' }),
  publicFeature('romance', { commands: ['romance'], healthKey: 'romance' }),
  publicFeature('tetris', { commands: ['games'], healthKey: 'tetris', requiresHealth: true }),
  publicFeature('number_match', { commands: ['games'], healthKey: 'number_match', requiresHealth: true }),
  publicFeature('sudoku', { commands: ['games'], healthKey: 'sudoku', requiresHealth: true }),
  publicFeature('official_website', { healthKey: 'public_website', staticReady: true }),
  publicFeature('status_website', { healthKey: 'status_website', staticReady: true }),
]);

const PUBLIC_STATUS_DETAILS = Object.freeze({
  normal: '功能目前可使用',
  maintenance: '功能正在維護或尚未啟用',
  broken: '功能目前發生異常',
});

function isClientReady(client) {
  try {
    return typeof client?.isReady === 'function' ? client.isReady() : Boolean(client?.readyAt);
  } catch (_error) {
    return false;
  }
}

function areCommandsLoaded(client, commandNames = []) {
  return commandNames.length > 0 && commandNames.every((commandName) => client?.commands?.has?.(commandName));
}

function normalizeHealthRows(rows) {
  const allowedStatuses = new Set(['normal', 'maintenance', 'broken']);
  const map = new Map();

  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.featureKey !== 'string' || !allowedStatuses.has(row.status)) continue;
    map.set(row.featureKey, {
      status: row.status,
      updatedAt: Number.isFinite(Date.parse(row.updatedAt)) ? new Date(row.updatedAt).toISOString() : null,
    });
  }

  return map;
}

function getProbeStatus(feature, client, ready) {
  if (feature.pending) return 'maintenance';
  if (feature.type === 'ready') return ready ? 'normal' : 'broken';
  if (!ready) return 'maintenance';
  if (feature.staticReady) return 'normal';
  return areCommandsLoaded(client, feature.commands) ? 'normal' : 'broken';
}

function buildFeatureStatuses(
  client,
  healthRows,
  { healthAvailable = true, databaseAvailable = healthAvailable, now = new Date() } = {}
) {
  const ready = isClientReady(client);
  const health = normalizeHealthRows(healthRows);

  return PUBLIC_FEATURES.map((feature) => {
    const override = feature.healthKey ? health.get(feature.healthKey) : null;
    const probeStatus = getProbeStatus(feature, client, ready);
    let status = probeStatus;

    if (override?.status === 'broken' || override?.status === 'maintenance') {
      status = override.status;
    } else if (override?.status === 'normal' && probeStatus === 'normal') {
      status = 'normal';
    }

    if (!healthAvailable && feature.healthKey && status === 'normal') {
      status = 'maintenance';
    }
    if (feature.requiresHealth && !override && status === 'normal') {
      status = 'maintenance';
    }
    if (!databaseAvailable && feature.requiresDatabase && status === 'normal') {
      status = 'maintenance';
    }

    return {
      key: feature.key,
      name: feature.name,
      category: feature.category,
      status,
      detail: PUBLIC_STATUS_DETAILS[status],
      updatedAt: override?.updatedAt || now.toISOString(),
      critical: Boolean(feature.critical),
    };
  });
}

function summarizeFeatures(features) {
  return features.reduce(
    (summary, feature) => {
      summary[feature.status] += 1;
      return summary;
    },
    { normal: 0, maintenance: 0, broken: 0 }
  );
}

function getOverallBotStatus(client, features) {
  if (!isClientReady(client)) return 'outage';
  if (features.some((feature) => feature.critical && feature.status === 'broken')) return 'outage';
  if (features.some((feature) => feature.status === 'broken')) return 'degraded';
  if (features.some((feature) => feature.critical && feature.status === 'maintenance')) return 'degraded';
  return 'operational';
}

function getTodayInteractionCount(rows) {
  const row = (Array.isArray(rows) ? rows : []).find(
    (item) => item?.featureKey === PUBLIC_USAGE_FEATURE_KEY && item?.metricKey === PUBLIC_USAGE_METRIC_KEY
  );
  return Number.isSafeInteger(row?.usageCount) && row.usageCount >= 0 ? row.usageCount : 0;
}

async function loadPublicStatusData(now, { healthReader = listFeatureHealth, usageReader = listFeatureUsageForDate } = {}) {
  const usageDate = getTaipeiDateKey(now);
  const [healthResult, usageResult] = await Promise.allSettled([healthReader(), usageReader(usageDate)]);

  return {
    usageDate,
    healthRows: healthResult.status === 'fulfilled' ? healthResult.value : [],
    healthAvailable: healthResult.status === 'fulfilled',
    usageRows: usageResult.status === 'fulfilled' ? usageResult.value : [],
    usageAvailable: usageResult.status === 'fulfilled',
  };
}

async function buildPublicStatusSnapshot(client, { now = new Date(), healthReader, usageReader } = {}) {
  const safeNow = now instanceof Date && !Number.isNaN(now.getTime()) ? new Date(now.getTime()) : new Date();
  const data = await loadPublicStatusData(safeNow, { healthReader, usageReader });
  const features = buildFeatureStatuses(client, data.healthRows, {
    healthAvailable: data.healthAvailable,
    databaseAvailable: data.healthAvailable && data.usageAvailable,
    now: safeNow,
  });
  const ping = Number(client?.ws?.ping);

  return {
    schemaVersion: PUBLIC_STATUS_SCHEMA_VERSION,
    updatedAt: safeNow.toISOString(),
    timezone: 'Asia/Taipei',
    bot: {
      status: getOverallBotStatus(client, features),
      version: packageJson.version,
      latencyMs: Number.isFinite(ping) && ping >= 0 ? Math.round(ping) : null,
    },
    guilds: {
      adoptedCount: Number.isSafeInteger(client?.guilds?.cache?.size) && client.guilds.cache.size >= 0
        ? client.guilds.cache.size
        : null,
    },
    usage: {
      date: data.usageDate,
      todayInteractions: data.usageAvailable ? getTodayInteractionCount(data.usageRows) : null,
      available: data.usageAvailable,
    },
    summary: summarizeFeatures(features),
    features,
  };
}

async function buildPublicOverviewSnapshot(client, options = {}) {
  const snapshot = await buildPublicStatusSnapshot(client, options);
  return {
    schemaVersion: snapshot.schemaVersion,
    updatedAt: snapshot.updatedAt,
    timezone: snapshot.timezone,
    bot: snapshot.bot,
    guilds: snapshot.guilds,
    usage: snapshot.usage,
    summary: snapshot.summary,
  };
}

async function recordPublicInteraction(now = new Date(), { recorder = recordFeatureUsage, loggerImpl = logger } = {}) {
  try {
    await recorder(PUBLIC_USAGE_FEATURE_KEY, PUBLIC_USAGE_METRIC_KEY, 1, now);
    return true;
  } catch (_error) {
    loggerImpl.warn('[PUBLIC_STATUS] Interaction aggregate update failed.');
    return false;
  }
}

module.exports = {
  PUBLIC_FEATURES,
  PUBLIC_STATUS_SCHEMA_VERSION,
  PUBLIC_USAGE_FEATURE_KEY,
  PUBLIC_USAGE_METRIC_KEY,
  buildFeatureStatuses,
  buildPublicOverviewSnapshot,
  buildPublicStatusSnapshot,
  recordPublicInteraction,
};
