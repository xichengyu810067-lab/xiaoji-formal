const crypto = require('node:crypto');
const { withCoinDatabase, withCoinTransaction } = require('./coinDatabase');
const { getWalletPlayerWithApi, mutateWalletWithApi } = require('./coinWalletService');
const { ensureGuildEconomyRowWithApi, readGuildEconomyEnabledWithApi } = require('./coinService');
const { getTaipeiDateKey } = require('../utils/taipeiClock');
const { featureRewardReason } = require('../systems/economy/transactionReasons');

const FEATURE_KEYS = Object.freeze([
  'word_chain',
  'number_chain',
  'daily_riddle',
  'daily_discussion',
  'conversation_style',
  'tetris',
  'number_match',
  'sudoku',
  'romance',
  'public_website',
  'status_website',
  'release_announcements',
]);

const FEATURE_HEALTH_STATUSES = Object.freeze(['normal', 'maintenance', 'broken']);
const FEATURE_USAGE_METRIC_KEYS = Object.freeze([
  'attempt',
  'accepted',
  'completed',
  'failed',
  'message',
  'reward',
  'announcement',
  'api_request',
]);
const MAX_REWARD_AMOUNT = 9_000_000_000;
const MAX_COIN_VALUE = Number.MAX_SAFE_INTEGER;
const MAX_OUTBOX_CLAIM_LIMIT = 100;

class FeaturePlatformError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'FeaturePlatformError';
    this.code = code;
    this.details = details;
  }
}

function requireText(value, fieldName, maxLength = 200) {
  const normalized = String(value || '').trim();

  if (!normalized || normalized.length > maxLength) {
    throw new FeaturePlatformError('INVALID_ARGUMENT', `${fieldName} is required and must be at most ${maxLength} characters.`);
  }

  return normalized;
}

function requireFeatureKey(featureKey) {
  const normalized = requireText(featureKey, 'featureKey', 80);

  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) {
    throw new FeaturePlatformError('INVALID_FEATURE_KEY', 'featureKey must use lowercase letters, digits, and underscores.');
  }

  return normalized;
}

function requireDate(value, fieldName = 'date') {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);

  if (Number.isNaN(date.getTime())) {
    throw new FeaturePlatformError('INVALID_ARGUMENT', `${fieldName} must be a valid date.`);
  }

  return date;
}

function toIso(value = new Date(), fieldName = 'date') {
  return requireDate(value, fieldName).toISOString();
}

function serializeJson(value, fieldName) {
  try {
    return JSON.stringify(value ?? {});
  } catch (error) {
    throw new FeaturePlatformError('INVALID_JSON', `${fieldName} must be JSON serializable.`, error);
  }
}

function parseJson(value, fieldName) {
  try {
    return JSON.parse(value || '{}');
  } catch (error) {
    throw new FeaturePlatformError('CORRUPT_DATA', `${fieldName} contains invalid JSON.`, error);
  }
}

function mapGuildSetting(row, featureKey = null, guildId = null) {
  if (!row) {
    return {
      guildId,
      featureKey,
      enabled: false,
      channelId: null,
      config: {},
      persisted: false,
      createdAt: null,
      updatedAt: null,
    };
  }

  return {
    guildId: row.guild_id,
    featureKey: row.feature_key,
    enabled: Number(row.enabled) === 1,
    channelId: row.channel_id || null,
    config: parseJson(row.config_json, 'feature_guild_settings.config_json'),
    persisted: true,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOutbox(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    guildId: row.guild_id,
    featureKey: row.feature_key,
    eventType: row.event_type,
    dedupeKey: row.dedupe_key,
    payload: parseJson(row.payload_json, 'feature_outbox.payload_json'),
    status: row.status,
    availableAt: row.available_at,
    attemptCount: Number(row.attempt_count),
    claimedBy: row.claimed_by || null,
    claimedAt: row.claimed_at || null,
    leaseUntil: row.lease_until || null,
    deliveredAt: row.delivered_at || null,
    lastError: row.last_error || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapGrant(row) {
  if (!row) {
    return null;
  }

  return {
    id: Number(row.id),
    guildId: row.guild_id,
    userId: row.user_id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    rewardKind: row.reward_kind,
    amount: Number(row.amount),
    debtOffset: Number(row.debt_offset || 0),
    netAmount: Number(row.net_amount || 0),
    metadata: parseJson(row.metadata, 'reward_grants.metadata'),
    transactionId: row.transaction_id == null ? null : Number(row.transaction_id),
    createdAt: row.created_at,
  };
}

function makeRewardKey({ kind, canonicalSourceId, rewardKind, userId }) {
  const values = [kind, canonicalSourceId, rewardKind, userId];
  return `reward:v1:${crypto.createHash('sha256').update(JSON.stringify(values)).digest('hex')}`;
}

function mapRewardReceiptV2(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    rewardKey: row.reward_key,
    operationId: row.operation_id,
    kind: row.kind,
    canonicalSourceId: row.canonical_source_id,
    rewardKind: row.reward_kind,
    userId: row.user_id,
    sourceGuildId: row.source_guild_id,
    amount: Number(row.amount),
    transactionId: row.transaction_id == null ? null : Number(row.transaction_id),
    legacyGrantId: row.legacy_grant_id == null ? null : Number(row.legacy_grant_id),
    createdAt: row.created_at,
  };
}

function grantRewardOnceV2WithApi(api, input) {
  const kind = requireText(input.kind, 'kind', 80);
  if (!['game', 'work-settlement', 'owner-campaign', 'feature'].includes(kind)) {
    throw new FeaturePlatformError('INVALID_REWARD_KIND', 'Unsupported reward kind.');
  }
  const canonicalSourceId = requireText(input.canonicalSourceId, 'canonicalSourceId', 200);
  const rewardKind = requireText(input.rewardKind, 'rewardKind', 80);
  const userId = requireText(input.userId, 'userId', 80);
  const sourceGuildId = input.sourceGuildId == null ? null : requireText(input.sourceGuildId, 'sourceGuildId', 80);
  const amount = Number(input.amount);
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_REWARD_AMOUNT) {
    throw new FeaturePlatformError('INVALID_REWARD_AMOUNT', `amount must be an integer from 1 to ${MAX_REWARD_AMOUNT}.`);
  }
  const rewardKey = makeRewardKey({ kind, canonicalSourceId, rewardKind, userId });
  const operationId = input.operationId == null ? rewardKey : requireText(input.operationId, 'operationId', 200);
  const payloadHash = crypto.createHash('sha256')
    .update(JSON.stringify([kind, canonicalSourceId, rewardKind, userId, amount])).digest('hex');
  const metadataJson = serializeJson(input.metadata || {}, 'metadata');
  const byOperation = api.get('SELECT * FROM reward_grants_v2 WHERE operation_id = ?', [operationId]);
  if (byOperation && byOperation.reward_key !== rewardKey) {
    throw new FeaturePlatformError('OPERATION_CONFLICT', 'Operation ID belongs to another reward.');
  }
  const existing = api.get('SELECT * FROM reward_grants_v2 WHERE reward_key = ?', [rewardKey]);
  if (existing) {
    if (existing.payload_hash !== payloadHash) {
      throw new FeaturePlatformError('REWARD_KEY_CONFLICT', 'Reward key has a different amount or recipient.');
    }
    const player = getWalletPlayerWithApi(api, sourceGuildId || existing.source_guild_id || '__global__', userId);
    return {
      alreadyGranted: true,
      receipt: mapRewardReceiptV2(existing),
      balance: player.balance,
      totalEarned: player.totalEarned,
      grossAmount: Number(existing.amount),
      netAmount: Number(existing.net_amount),
      debtOffset: Number(existing.debt_offset),
    };
  }
  const transactionGuildId = sourceGuildId || '__global__';
  if (sourceGuildId && kind !== 'work-settlement') {
    const timestamp = new Date().toISOString();
    ensureGuildEconomyRowWithApi(api, sourceGuildId, timestamp);
    if (Number(readGuildEconomyEnabledWithApi(api, sourceGuildId)) !== 1) {
      throw new FeaturePlatformError('COIN_DISABLED', 'The source guild coin system is disabled.');
    }
  }
  const current = getWalletPlayerWithApi(api, transactionGuildId, userId);
  if (!Number.isSafeInteger(current.totalEarned + amount)) {
    throw new FeaturePlatformError('REWARD_TOTAL_EARNED_LIMIT', 'The reward would exceed the supported total earned limit.');
  }
  const timestamp = new Date().toISOString();
  const mutation = mutateWalletWithApi(api, {
    guildId: transactionGuildId,
    userId,
    type: 'system_reward',
    balanceDelta: amount,
    totalEarnedDelta: amount,
    operatorId: input.actorUserId || null,
    reason: `${kind}:${rewardKind}`,
    metadata: { rewardKey, canonicalSourceId, ...input.metadata },
    createdAt: timestamp,
  });
  api.run(
    `INSERT INTO reward_grants_v2
      (reward_key, operation_id, kind, canonical_source_id, reward_kind, user_id,
       source_guild_id, amount, payload_hash, metadata_json, debt_offset, net_amount,
       transaction_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [rewardKey, operationId, kind, canonicalSourceId, rewardKind, userId,
      sourceGuildId, amount, payloadHash, metadataJson, mutation.debtOffset,
      mutation.netAmount, mutation.transactionId, timestamp]
  );
  const receipt = mapRewardReceiptV2(api.get('SELECT * FROM reward_grants_v2 WHERE reward_key = ?', [rewardKey]));
  return {
    alreadyGranted: false,
    receipt,
    balance: mutation.after.balance,
    totalEarned: mutation.after.totalEarned,
    grossAmount: amount,
    netAmount: mutation.netAmount,
    debtOffset: mutation.debtOffset,
  };
}

async function grantRewardOnceV2(input) {
  return withCoinTransaction((api) => grantRewardOnceV2WithApi(api, input));
}

async function getRewardReceiptV2({ rewardKey = null, operationId = null } = {}) {
  if (!rewardKey && !operationId) throw new FeaturePlatformError('INVALID_ARGUMENT', 'rewardKey or operationId is required.');
  return withCoinDatabase((api) => mapRewardReceiptV2(api.get(
    rewardKey ? 'SELECT * FROM reward_grants_v2 WHERE reward_key = ?' : 'SELECT * FROM reward_grants_v2 WHERE operation_id = ?',
    [rewardKey || operationId]
  )));
}

// Reward ledger transaction ports for other systems. Each one runs on
// the api of the caller's withCoinDatabase or withCoinTransaction and never opens, commits
// or rolls back a transaction. Read ports return stored rows unchanged (snake_case
// columns; null when there is no row) so each caller keeps its own rules. The SQL text was
// moved here unchanged from coinCampaignService and soloSessionService.

function getRewardReceiptByKeyWithApi(api, rewardKey) {
  return api.get('SELECT * FROM reward_grants_v2 WHERE reward_key = ?', [rewardKey]);
}

// Only the debt split of one receipt: { debt_offset, net_amount } or null.
function getRewardReceiptDebtSplitByKeyWithApi(api, rewardKey) {
  return api.get('SELECT debt_offset, net_amount FROM reward_grants_v2 WHERE reward_key = ?', [rewardKey]);
}

// Records the receipt of an owner-campaign payment that was made before the ledger knew
// about it (an imported history record); nothing is paid. The statement fixes the kind to
// 'owner-campaign' and the reward kind to 'campaign', and the reward key is also the
// operation id. The caller supplies every value, including the time.
function importOwnerCampaignReceiptWithApi(api, receipt) {
  api.run(`INSERT INTO reward_grants_v2
        (reward_key, operation_id, kind, canonical_source_id, reward_kind, user_id,
         source_guild_id, amount, payload_hash, metadata_json, debt_offset, net_amount,
         transaction_id, created_at)
        VALUES (?, ?, 'owner-campaign', ?, 'campaign', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  [receipt.rewardKey, receipt.rewardKey, receipt.canonicalSourceId, receipt.userId, receipt.sourceGuildId,
    receipt.amount, receipt.payloadHash, receipt.metadataJson, receipt.debtOffset, receipt.netAmount,
    receipt.transactionId, receipt.createdAt]);
}

// Owner-campaign receipts, found by campaign and recipient.
function getOwnerCampaignReceiptWithApi(api, campaignId, userId) {
  return api.get(`SELECT * FROM reward_grants_v2 WHERE kind = 'owner-campaign'
        AND canonical_source_id = ? AND reward_kind = 'campaign' AND user_id = ?`,
  [campaignId, userId]);
}

// Only the payment link of the receipt: { transaction_id, metadata_json } or null.
function getOwnerCampaignReceiptTransactionWithApi(api, campaignId, userId) {
  return api.get(`SELECT transaction_id, metadata_json FROM reward_grants_v2
      WHERE kind = 'owner-campaign' AND canonical_source_id = ?
        AND reward_kind = 'campaign' AND user_id = ?`, [campaignId, userId]);
}

// Answers only whether the receipt exists (true or false).
function hasOwnerCampaignReceiptWithApi(api, campaignId, userId) {
  return Boolean(api.get(`SELECT 1 FROM reward_grants_v2 WHERE kind = 'owner-campaign'
        AND canonical_source_id = ? AND reward_kind = 'campaign' AND user_id = ?`,
  [campaignId, userId]));
}

// Every receipt of one campaign as [{ user_id, amount }]. Campaign preview and apply used
// this same statement with different line breaks; both now share this one text.
function listOwnerCampaignReceiptAmountsWithApi(api, campaignId) {
  return api.all(`SELECT user_id, amount FROM reward_grants_v2
      WHERE kind = 'owner-campaign' AND canonical_source_id = ? AND reward_kind = 'campaign'`,
  [campaignId]);
}

// Legacy (v1) reward grants of one user, oldest first.
function listLegacyRewardGrantsByUserWithApi(api, userId) {
  return api.all('SELECT * FROM reward_grants WHERE user_id = ? ORDER BY id', [userId]);
}

async function getGuildFeatureSetting(guildId, featureKey) {
  const normalizedGuildId = requireText(guildId, 'guildId', 80);
  const normalizedFeatureKey = requireFeatureKey(featureKey);

  return withCoinDatabase((api) => {
    const row = api.get('SELECT * FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?', [
      normalizedGuildId,
      normalizedFeatureKey,
    ]);
    return mapGuildSetting(row, normalizedFeatureKey, normalizedGuildId);
  });
}

async function listGuildFeatureSettings(guildId) {
  const normalizedGuildId = requireText(guildId, 'guildId', 80);

  return withCoinDatabase((api) => {
    const rows = api.all('SELECT * FROM feature_guild_settings WHERE guild_id = ? ORDER BY feature_key', [normalizedGuildId]);
    const stored = new Map(rows.map((row) => [row.feature_key, mapGuildSetting(row)]));
    const known = FEATURE_KEYS.map(
      (featureKey) => stored.get(featureKey) || mapGuildSetting(null, featureKey, normalizedGuildId)
    );
    const custom = rows.filter((row) => !FEATURE_KEYS.includes(row.feature_key)).map(mapGuildSetting);
    return [...known, ...custom];
  });
}

async function setGuildFeatureSetting(guildId, featureKey, changes = {}) {
  const normalizedGuildId = requireText(guildId, 'guildId', 80);
  const normalizedFeatureKey = requireFeatureKey(featureKey);

  const transactionResult = await withCoinTransaction((api) => {
    const current = api.get('SELECT * FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?', [
      normalizedGuildId,
      normalizedFeatureKey,
    ]);
    if (Object.prototype.hasOwnProperty.call(changes, 'enabled') && typeof changes.enabled !== 'boolean') {
      throw new FeaturePlatformError('INVALID_ARGUMENT', 'enabled must be a boolean.');
    }

    const enabled = Object.prototype.hasOwnProperty.call(changes, 'enabled')
      ? changes.enabled === true
      : Number(current?.enabled || 0) === 1;
    const channelId = Object.prototype.hasOwnProperty.call(changes, 'channelId')
      ? changes.channelId == null || changes.channelId === ''
        ? null
        : requireText(changes.channelId, 'channelId', 80)
      : current?.channel_id || null;
    const chainFeature = normalizedFeatureKey === 'word_chain' || normalizedFeatureKey === 'number_chain';
    const explicitDisable = Object.prototype.hasOwnProperty.call(changes, 'enabled') && changes.enabled === false;
    const explicitEnable = Object.prototype.hasOwnProperty.call(changes, 'enabled') && changes.enabled === true;
    let effectiveEnabled = enabled;
    let effectiveChannelId = channelId;
    let fenceOpenFailed = false;
    let currentConfig;
    if (chainFeature) {
      const { closeFence, readChainConfig } = require('../systems/safety/chainReactionFence');
      const parsed = readChainConfig(current?.config_json || '{}');
      if (!parsed.valid) {
        if (!explicitDisable) {
          throw new FeaturePlatformError('CORRUPT_DATA', 'feature_guild_settings.config_json contains invalid chain configuration.');
        }
        currentConfig = {};
        closeFence({ featureKey: normalizedFeatureKey, guildId: normalizedGuildId });
      } else {
        currentConfig = parsed.config;
      }
    } else {
      currentConfig = parseJson(current?.config_json || '{}', 'feature_guild_settings.config_json');
    }
    let nextConfig = Object.prototype.hasOwnProperty.call(changes, 'config') ? changes.config : currentConfig;
    if (chainFeature) {
      const { closeFence, openFence, preserveReservedConfig, readChainConfig, revokeMetadata } = require('../systems/safety/chainReactionFence');
      if (Object.prototype.hasOwnProperty.call(changes, 'config')) {
        const replacement = readChainConfig(changes.config);
        if (!replacement.valid) throw new FeaturePlatformError('INVALID_JSON', 'config must be a JSON object.');
        nextConfig = replacement.config;
      }
      nextConfig = preserveReservedConfig(currentConfig, nextConfig);
      const versionKey = normalizedFeatureKey === 'word_chain' ? 'corpusVersion' : 'parserVersion';
      if (currentConfig[versionKey] !== undefined && nextConfig[versionKey] === undefined) {
        nextConfig[versionKey] = currentConfig[versionKey];
      }
      const previousEnabled = Number(current?.enabled || 0) === 1;
      const previousChannelId = current?.channel_id || null;
      const shouldRevoke = (previousEnabled && !enabled) ||
        (previousChannelId && channelId && previousChannelId !== channelId);
      if (shouldRevoke) {
        const metadata = currentConfig._chainReaction;
        const closed = closeFence({ featureKey: normalizedFeatureKey, guildId: normalizedGuildId,
          channelId: previousChannelId, generation: metadata?.generation });
        if (closed.kind === 'failed') nextConfig._chainReaction = revokeMetadata(metadata);
        else if (metadata) nextConfig._chainReaction = revokeMetadata(metadata);
      }
      if (enabled && (explicitEnable || !previousEnabled || previousChannelId !== channelId)) {
        const table = normalizedFeatureKey === 'word_chain' ? 'text_chain_sessions' : 'number_chain_sessions';
        const session = api.get(`SELECT id, channel_id, created_at FROM ${table}
          WHERE guild_id = ? AND channel_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
          [normalizedGuildId, channelId]);
        if (session) {
          const opened = openFence({ featureKey: normalizedFeatureKey, guildId: normalizedGuildId,
            channelId, sessionId: Number(session.id), sessionCreatedAt: session.created_at });
          if (opened.metadata) nextConfig._chainReaction = opened.metadata;
          else fenceOpenFailed = true;
        } else {
          fenceOpenFailed = true;
        }
        if (fenceOpenFailed) {
          effectiveEnabled = false;
          effectiveChannelId = null;
          delete nextConfig._chainReaction;
        }
      }
    }
    const configJson = serializeJson(nextConfig, 'config');
    const timestamp = toIso(changes.now || new Date(), 'now');

    api.run(
      `INSERT INTO feature_guild_settings
        (guild_id, feature_key, enabled, channel_id, config_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, feature_key) DO UPDATE SET
         enabled = excluded.enabled,
         channel_id = excluded.channel_id,
         config_json = excluded.config_json,
         updated_at = excluded.updated_at`,
      [normalizedGuildId, normalizedFeatureKey, effectiveEnabled ? 1 : 0, effectiveChannelId,
        configJson, current?.created_at || timestamp, timestamp]
    );

    return { fenceOpenFailed, setting: mapGuildSetting(
      api.get('SELECT * FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?', [
        normalizedGuildId,
        normalizedFeatureKey,
      ])
    ) };
  });
  if (transactionResult.fenceOpenFailed) {
    throw new FeaturePlatformError('REACTION_FENCE_OPEN_FAILED', 'Chain reaction safety state could not be opened; the feature remains disabled.');
  }
  return transactionResult.setting;
}

async function grantRewardOnce(guildId, userId, sourceType, sourceId, rewardKind, amount, metadata = {}) {
  const normalizedGuildId = requireText(guildId, 'guildId', 80);
  const normalizedUserId = requireText(userId, 'userId', 80);
  const normalizedSourceType = requireText(sourceType, 'sourceType', 80);
  const normalizedSourceId = requireText(sourceId, 'sourceId', 160);
  const normalizedRewardKind = requireText(rewardKind, 'rewardKind', 80);

  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_REWARD_AMOUNT) {
    throw new FeaturePlatformError('INVALID_REWARD_AMOUNT', `amount must be an integer from 1 to ${MAX_REWARD_AMOUNT}.`);
  }

  const metadataJson = serializeJson(metadata, 'metadata');

  return withCoinTransaction((api) => {
    const timestamp = new Date().toISOString();
    const existingGrant = api.get(
      `SELECT * FROM reward_grants
       WHERE guild_id = ? AND user_id = ? AND source_type = ? AND source_id = ? AND reward_kind = ?`,
      [normalizedGuildId, normalizedUserId, normalizedSourceType, normalizedSourceId, normalizedRewardKind]
    );

    if (existingGrant) {
      const player = getWalletPlayerWithApi(api, normalizedGuildId, normalizedUserId);
      return {
        alreadyGranted: true,
        grant: mapGrant(existingGrant),
        balance: player == null ? null : player.balance,
        totalEarned: player == null ? null : player.totalEarned,
      };
    }

    ensureGuildEconomyRowWithApi(api, normalizedGuildId, timestamp);

    if (Number(readGuildEconomyEnabledWithApi(api, normalizedGuildId)) !== 1) {
      throw new FeaturePlatformError('COIN_DISABLED', 'The guild coin system is disabled.');
    }

    const currentPlayer = getWalletPlayerWithApi(api, normalizedGuildId, normalizedUserId);
    if (!Number.isSafeInteger(currentPlayer.balance + amount) || currentPlayer.balance + amount > MAX_COIN_VALUE) {
      throw new FeaturePlatformError('REWARD_BALANCE_LIMIT', 'The reward would exceed the supported coin balance limit.');
    }
    if (!Number.isSafeInteger(currentPlayer.totalEarned + amount) || currentPlayer.totalEarned + amount > MAX_COIN_VALUE) {
      throw new FeaturePlatformError('REWARD_TOTAL_EARNED_LIMIT', 'The reward would exceed the supported total earned limit.');
    }

    api.run(
      `INSERT INTO reward_grants
        (guild_id, user_id, source_type, source_id, reward_kind, amount, metadata, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, user_id, source_type, source_id, reward_kind) DO NOTHING`,
      [
        normalizedGuildId,
        normalizedUserId,
        normalizedSourceType,
        normalizedSourceId,
        normalizedRewardKind,
        amount,
        metadataJson,
        timestamp,
      ]
    );

    const inserted = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    const grant = api.get(
      `SELECT * FROM reward_grants
       WHERE guild_id = ? AND user_id = ? AND source_type = ? AND source_id = ? AND reward_kind = ?`,
      [normalizedGuildId, normalizedUserId, normalizedSourceType, normalizedSourceId, normalizedRewardKind]
    );

    if (!inserted) {
      const player = getWalletPlayerWithApi(api, normalizedGuildId, normalizedUserId);
      return {
        alreadyGranted: true,
        grant: mapGrant(grant),
        balance: player == null ? null : player.balance,
        totalEarned: player == null ? null : player.totalEarned,
      };
    }

    const mutation = mutateWalletWithApi(api, {
      guildId: normalizedGuildId,
      userId: normalizedUserId,
      type: 'system_reward',
      balanceDelta: amount,
      totalEarnedDelta: amount,
      operatorId: null,
      reason: featureRewardReason(normalizedRewardKind),
      metadata: {
        rewardGrantId: Number(grant.id),
        sourceType: normalizedSourceType,
        sourceId: normalizedSourceId,
        rewardKind: normalizedRewardKind,
        metadata,
      },
      createdAt: timestamp,
    });
    const transactionId = mutation.transactionId;
    api.run('UPDATE reward_grants SET transaction_id = ? WHERE id = ?', [transactionId, grant.id]);

    return {
      alreadyGranted: false,
      grant: mapGrant({ ...grant, transaction_id: transactionId }),
      balance: mutation.after.balance,
      totalEarned: mutation.after.totalEarned,
    };
  });
}

function enqueueFeatureOutboxWithApi(api, {
  guildId,
  featureKey,
  eventType,
  dedupeKey,
  payload = {},
  availableAt = new Date(),
  now = new Date(),
}) {
  const normalizedGuildId = requireText(guildId, 'guildId', 80);
  const normalizedFeatureKey = requireFeatureKey(featureKey);
  const normalizedEventType = requireText(eventType, 'eventType', 80);
  const normalizedDedupeKey = requireText(dedupeKey, 'dedupeKey', 200);
  const payloadJson = serializeJson(payload, 'payload');
  const availableAtIso = toIso(availableAt, 'availableAt');
  const timestamp = toIso(now, 'now');

  api.run(
      `INSERT INTO feature_outbox
        (guild_id, feature_key, event_type, dedupe_key, payload_json, available_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(guild_id, feature_key, event_type, dedupe_key) DO NOTHING`,
      [
        normalizedGuildId,
        normalizedFeatureKey,
        normalizedEventType,
        normalizedDedupeKey,
        payloadJson,
        availableAtIso,
        timestamp,
        timestamp,
      ]
  );
  const inserted = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
  const row = api.get(
      `SELECT * FROM feature_outbox
       WHERE guild_id = ? AND feature_key = ? AND event_type = ? AND dedupe_key = ?`,
      [normalizedGuildId, normalizedFeatureKey, normalizedEventType, normalizedDedupeKey]
  );
  return { alreadyEnqueued: !inserted, event: mapOutbox(row) };
}

async function enqueueFeatureOutbox(input) {
  return withCoinTransaction((api) => enqueueFeatureOutboxWithApi(api, input));
}

async function claimFeatureOutbox({ workerId, eventType = null, featureKey = null, limit = 25, leaseMs = 60_000, now = new Date() }) {
  const normalizedWorkerId = requireText(workerId, 'workerId', 120);
  const normalizedEventType = eventType == null ? null : requireText(eventType, 'eventType', 80);
  const normalizedFeatureKey = featureKey == null ? null : requireFeatureKey(featureKey);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTBOX_CLAIM_LIMIT) {
    throw new FeaturePlatformError('INVALID_CLAIM_LIMIT', `limit must be from 1 to ${MAX_OUTBOX_CLAIM_LIMIT}.`);
  }

  if (!Number.isInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 24 * 60 * 60 * 1000) {
    throw new FeaturePlatformError('INVALID_LEASE', 'leaseMs must be from 1000 to 86400000.');
  }

  const claimedAt = requireDate(now, 'now');
  const claimedAtIso = claimedAt.toISOString();
  const leaseUntilIso = new Date(claimedAt.getTime() + leaseMs).toISOString();

  return withCoinTransaction((api) => {
    api.run(
      `UPDATE feature_outbox
       SET status = 'pending', claimed_by = NULL, claimed_at = NULL, lease_until = NULL, updated_at = ?
       WHERE status = 'processing' AND lease_until <= ?${normalizedFeatureKey ? ' AND feature_key = ?' : ''}`,
      normalizedFeatureKey ? [claimedAtIso, claimedAtIso, normalizedFeatureKey] : [claimedAtIso, claimedAtIso]
    );
    const filters = [];
    const filterParams = [claimedAtIso];
    if (normalizedEventType) { filters.push('event_type = ?'); filterParams.push(normalizedEventType); }
    if (normalizedFeatureKey) { filters.push('feature_key = ?'); filterParams.push(normalizedFeatureKey); }
    filterParams.push(limit);
    const candidates = api.all(
      `SELECT id FROM feature_outbox
       WHERE status = 'pending' AND available_at <= ?${filters.length ? ` AND ${filters.join(' AND ')}` : ''}
       ORDER BY available_at ASC, id ASC
       LIMIT ?`,
      filterParams
    );

    for (const candidate of candidates) {
      api.run(
        `UPDATE feature_outbox
         SET status = 'processing', attempt_count = attempt_count + 1,
             claimed_by = ?, claimed_at = ?, lease_until = ?, updated_at = ?
         WHERE id = ? AND status = 'pending'`,
        [normalizedWorkerId, claimedAtIso, leaseUntilIso, claimedAtIso, candidate.id]
      );
    }

    if (candidates.length === 0) {
      return [];
    }

    const placeholders = candidates.map(() => '?').join(', ');
    return api
      .all(`SELECT * FROM feature_outbox WHERE id IN (${placeholders}) ORDER BY available_at ASC, id ASC`, candidates.map((row) => row.id))
      .map(mapOutbox);
  });
}

async function markFeatureOutboxDelivered(id, { workerId, now = new Date() }) {
  const eventId = Number(id);
  const normalizedWorkerId = requireText(workerId, 'workerId', 120);
  const timestamp = toIso(now, 'now');

  if (!Number.isSafeInteger(eventId) || eventId < 1) {
    throw new FeaturePlatformError('INVALID_OUTBOX_ID', 'id must be a positive integer.');
  }

  return withCoinTransaction((api) => {
    api.run(
      `UPDATE feature_outbox
       SET status = 'delivered', delivered_at = ?, claimed_by = NULL, claimed_at = NULL,
           lease_until = NULL, last_error = NULL, updated_at = ?
       WHERE id = ? AND status = 'processing' AND claimed_by = ? AND lease_until > ?`,
      [timestamp, timestamp, eventId, normalizedWorkerId, timestamp]
    );
    const updated = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    return { updated, event: mapOutbox(api.get('SELECT * FROM feature_outbox WHERE id = ?', [eventId])) };
  });
}

async function markFeatureOutboxDeliveredByDedupe({ guildId, featureKey, eventType, dedupeKey, now = new Date() }) {
  const normalizedGuildId = requireText(guildId, 'guildId', 80);
  const normalizedFeatureKey = requireFeatureKey(featureKey);
  const normalizedEventType = requireText(eventType, 'eventType', 80);
  const normalizedDedupeKey = requireText(dedupeKey, 'dedupeKey', 200);
  const timestamp = toIso(now, 'now');
  return withCoinTransaction((api) => {
    api.run(
      `UPDATE feature_outbox
       SET status = 'delivered', delivered_at = ?, claimed_by = NULL, claimed_at = NULL,
           lease_until = NULL, last_error = NULL, updated_at = ?
       WHERE guild_id = ? AND feature_key = ? AND event_type = ? AND dedupe_key = ?
         AND status = 'pending'`,
      [timestamp, timestamp, normalizedGuildId, normalizedFeatureKey, normalizedEventType, normalizedDedupeKey]
    );
    return { updated: Number(api.get('SELECT changes() AS count')?.count || 0) === 1 };
  });
}

// uncounted: the attempt this claim added is given back (the event was not tried, for
// example because its feature was unavailable), so it never moves the event toward its
// attempt limit.
async function retryFeatureOutbox(id, { workerId, error, delayMs = 0, now = new Date(), uncounted = false }) {
  const eventId = Number(id);
  const normalizedWorkerId = requireText(workerId, 'workerId', 120);
  const retryAt = requireDate(now, 'now');

  if (!Number.isSafeInteger(eventId) || eventId < 1) {
    throw new FeaturePlatformError('INVALID_OUTBOX_ID', 'id must be a positive integer.');
  }

  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 7 * 24 * 60 * 60 * 1000) {
    throw new FeaturePlatformError('INVALID_RETRY_DELAY', 'delayMs must be from 0 to 604800000.');
  }

  if (typeof uncounted !== 'boolean') {
    throw new FeaturePlatformError('INVALID_RETRY_COUNT', 'uncounted must be a boolean.');
  }

  const timestamp = retryAt.toISOString();
  const availableAt = new Date(retryAt.getTime() + delayMs).toISOString();
  const lastError = String(error instanceof Error ? error.message : error || 'delivery failed').slice(0, 500);

  return withCoinTransaction((api) => {
    api.run(
      `UPDATE feature_outbox
       SET status = 'pending', available_at = ?, claimed_by = NULL, claimed_at = NULL,
           lease_until = NULL, last_error = ?, updated_at = ?,
           attempt_count = CASE WHEN ? = 1 AND attempt_count > 0 THEN attempt_count - 1 ELSE attempt_count END
       WHERE id = ? AND status = 'processing' AND claimed_by = ? AND lease_until > ?`,
      [availableAt, lastError, timestamp, uncounted ? 1 : 0, eventId, normalizedWorkerId, timestamp]
    );
    const updated = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    return { updated, event: mapOutbox(api.get('SELECT * FROM feature_outbox WHERE id = ?', [eventId])) };
  });
}

// affectsHealth: false closes the event without marking its feature broken (an event that
// only aged out says nothing about the feature).
async function deadLetterFeatureOutbox(id, { workerId, error, reason, now = new Date(), affectsHealth = true }) {
  const eventId = Number(id);
  const normalizedWorkerId = requireText(workerId, 'workerId', 120);
  const timestamp = toIso(now, 'now');
  const deadLetterReason = requireText(reason, 'reason', 120);
  const lastError = String(error instanceof Error ? error.message : error || 'delivery failed').slice(0, 500);

  if (!Number.isSafeInteger(eventId) || eventId < 1) {
    throw new FeaturePlatformError('INVALID_OUTBOX_ID', 'id must be a positive integer.');
  }

  if (typeof affectsHealth !== 'boolean') {
    throw new FeaturePlatformError('INVALID_DEAD_LETTER_HEALTH', 'affectsHealth must be a boolean.');
  }

  return withCoinTransaction((api) => {
    const event = api.get(
      `SELECT * FROM feature_outbox
       WHERE id = ? AND status = 'processing' AND claimed_by = ? AND lease_until > ?`,
      [eventId, normalizedWorkerId, timestamp]
    );
    if (!event) return { updated: false, event: null };

    api.run(
      `INSERT INTO feature_outbox_dead_letters
        (original_event_id, guild_id, feature_key, event_type, dedupe_key, payload_json, attempt_count, last_error, dead_letter_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(original_event_id) DO NOTHING`,
      [
        event.id,
        event.guild_id,
        event.feature_key,
        event.event_type,
        event.dedupe_key,
        event.payload_json,
        event.attempt_count,
        lastError,
        deadLetterReason,
        timestamp,
      ]
    );
    const inserted = Number(api.get('SELECT changes() AS count')?.count || 0) === 1;
    if (!inserted) return { updated: false, event: mapOutbox(event) };

    if (affectsHealth) {
      api.run(
        `INSERT INTO feature_health (feature_key, status, detail, updated_at)
         VALUES (?, 'broken', ?, ?)
         ON CONFLICT(feature_key) DO UPDATE SET status = excluded.status, detail = excluded.detail, updated_at = excluded.updated_at`,
        [event.feature_key, `outbox dead letter: ${deadLetterReason}`.slice(0, 500), timestamp]
      );
    }
    api.run('DELETE FROM feature_outbox WHERE id = ?', [eventId]);
    return { updated: true, event: mapOutbox(event) };
  });
}

// Closes, as dead letters, the waiting events of one feature and event type that were
// created at or before createdBefore (wall clock): pending events, and claims whose lease
// has run out. Oldest first, at most `limit` per call; the feature's health is not changed.
// For a feature that cannot judge its events on its own clock right now (for example while
// its ✅ ledger is unavailable), so its events do not pile up without end.
async function expireFeatureOutbox({ featureKey, eventType, createdBefore, reason = 'expired', error = null,
  limit = 25, now = new Date() }) {
  const normalizedFeatureKey = requireFeatureKey(featureKey);
  const normalizedEventType = requireText(eventType, 'eventType', 80);
  const cutoff = toIso(createdBefore, 'createdBefore');
  const deadLetterReason = requireText(reason, 'reason', 120);
  const timestamp = toIso(now, 'now');
  const lastError = String(error instanceof Error ? error.message : error || deadLetterReason).slice(0, 500);

  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_OUTBOX_CLAIM_LIMIT) {
    throw new FeaturePlatformError('INVALID_EXPIRE_LIMIT', `limit must be from 1 to ${MAX_OUTBOX_CLAIM_LIMIT}.`);
  }

  return withCoinTransaction((api) => {
    const events = api.all(
      `SELECT * FROM feature_outbox
       WHERE feature_key = ? AND event_type = ? AND created_at <= ?
         AND (status = 'pending' OR (status = 'processing' AND lease_until <= ?))
       ORDER BY created_at ASC, id ASC
       LIMIT ?`,
      [normalizedFeatureKey, normalizedEventType, cutoff, timestamp, limit]
    );
    let expired = 0;
    for (const event of events) {
      api.run(
        `INSERT INTO feature_outbox_dead_letters
          (original_event_id, guild_id, feature_key, event_type, dedupe_key, payload_json, attempt_count, last_error, dead_letter_reason, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(original_event_id) DO NOTHING`,
        [
          event.id,
          event.guild_id,
          event.feature_key,
          event.event_type,
          event.dedupe_key,
          event.payload_json,
          event.attempt_count,
          lastError,
          deadLetterReason,
          timestamp,
        ]
      );
      if (Number(api.get('SELECT changes() AS count')?.count || 0) !== 1) continue;
      api.run('DELETE FROM feature_outbox WHERE id = ?', [event.id]);
      expired += 1;
    }
    return { expired };
  });
}

async function recordFeatureUsage(featureKey, metricKey, increment = 1, now = new Date()) {
  const normalizedFeatureKey = requireFeatureKey(featureKey);
  const normalizedMetricKey = requireText(metricKey, 'metricKey', 80);

  if (!FEATURE_USAGE_METRIC_KEYS.includes(normalizedMetricKey)) {
    throw new FeaturePlatformError(
      'INVALID_USAGE_METRIC',
      `metricKey must be one of: ${FEATURE_USAGE_METRIC_KEYS.join(', ')}.`
    );
  }

  if (!Number.isSafeInteger(increment) || increment < 1 || increment > 1_000_000) {
    throw new FeaturePlatformError('INVALID_USAGE_INCREMENT', 'increment must be from 1 to 1000000.');
  }

  const usageDate = getTaipeiDateKey(now);
  const timestamp = toIso(now, 'now');

  return withCoinTransaction((api) => {
    api.run(
      `INSERT INTO feature_usage_daily (usage_date, feature_key, metric_key, usage_count, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(usage_date, feature_key, metric_key) DO UPDATE SET
         usage_count = usage_count + excluded.usage_count,
         updated_at = excluded.updated_at`,
      [usageDate, normalizedFeatureKey, normalizedMetricKey, increment, timestamp]
    );
    const row = api.get(
      'SELECT * FROM feature_usage_daily WHERE usage_date = ? AND feature_key = ? AND metric_key = ?',
      [usageDate, normalizedFeatureKey, normalizedMetricKey]
    );
    return {
      usageDate: row.usage_date,
      featureKey: row.feature_key,
      metricKey: row.metric_key,
      usageCount: Number(row.usage_count),
      updatedAt: row.updated_at,
    };
  });
}

async function listFeatureUsageForDate(usageDate) {
  const normalizedDate = String(usageDate || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalizedDate)) {
    throw new FeaturePlatformError('INVALID_ARGUMENT', 'usageDate must use YYYY-MM-DD.');
  }

  return withCoinDatabase((api) =>
    api.all(
      `SELECT feature_key, metric_key, usage_count, updated_at
       FROM feature_usage_daily
       WHERE usage_date = ?
       ORDER BY feature_key, metric_key`,
      [normalizedDate]
    ).map((row) => ({
      usageDate: normalizedDate,
      featureKey: row.feature_key,
      metricKey: row.metric_key,
      usageCount: Number(row.usage_count),
      updatedAt: row.updated_at,
    }))
  );
}

async function setFeatureHealth(featureKey, status, { detail = null, now = new Date() } = {}) {
  const normalizedFeatureKey = requireFeatureKey(featureKey);

  if (!FEATURE_HEALTH_STATUSES.includes(status)) {
    throw new FeaturePlatformError('INVALID_HEALTH_STATUS', `status must be one of: ${FEATURE_HEALTH_STATUSES.join(', ')}.`);
  }

  const normalizedDetail = detail == null || detail === '' ? null : requireText(detail, 'detail', 500);
  const timestamp = toIso(now, 'now');

  return withCoinTransaction((api) => {
    api.run(
      `INSERT INTO feature_health (feature_key, status, detail, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(feature_key) DO UPDATE SET
         status = excluded.status,
         detail = excluded.detail,
         updated_at = excluded.updated_at`,
      [normalizedFeatureKey, status, normalizedDetail, timestamp]
    );
    const row = api.get('SELECT * FROM feature_health WHERE feature_key = ?', [normalizedFeatureKey]);
    return {
      featureKey: row.feature_key,
      status: row.status,
      detail: row.detail || null,
      updatedAt: row.updated_at,
    };
  });
}

async function listFeatureHealth() {
  return withCoinDatabase((api) =>
    api.all('SELECT * FROM feature_health ORDER BY feature_key').map((row) => ({
      featureKey: row.feature_key,
      status: row.status,
      detail: row.detail || null,
      updatedAt: row.updated_at,
    }))
  );
}

module.exports = {
  FEATURE_HEALTH_STATUSES,
  FEATURE_KEYS,
  FEATURE_USAGE_METRIC_KEYS,
  FeaturePlatformError,
  claimFeatureOutbox,
  deadLetterFeatureOutbox,
  enqueueFeatureOutbox,
  enqueueFeatureOutboxWithApi,
  expireFeatureOutbox,
  getGuildFeatureSetting,
  grantRewardOnce,
  grantRewardOnceV2,
  grantRewardOnceV2WithApi,
  getRewardReceiptV2,
  getRewardReceiptByKeyWithApi,
  getRewardReceiptDebtSplitByKeyWithApi,
  importOwnerCampaignReceiptWithApi,
  getOwnerCampaignReceiptWithApi,
  getOwnerCampaignReceiptTransactionWithApi,
  hasOwnerCampaignReceiptWithApi,
  listOwnerCampaignReceiptAmountsWithApi,
  listLegacyRewardGrantsByUserWithApi,
  makeRewardKey,
  listFeatureHealth,
  listFeatureUsageForDate,
  listGuildFeatureSettings,
  markFeatureOutboxDelivered,
  markFeatureOutboxDeliveredByDedupe,
  recordFeatureUsage,
  retryFeatureOutbox,
  setFeatureHealth,
  setGuildFeatureSetting,
};
