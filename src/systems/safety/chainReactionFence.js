'use strict';

const crypto = require('node:crypto');
const logger = require('../../utils/logger');

const RESERVED_KEY = '_chainReaction';
const MAX_RESERVED_BYTES = 1_024;
// Guilds already warned that their stored ✅ authority no longer verifies (bounded).
const MAX_INACTIVE_WARNINGS = 4_096;
const inactiveAuthorityWarnings = new Set();
const PURPOSE_BY_FEATURE = Object.freeze({
  word_chain: 'word-chain.reaction',
  number_chain: 'number-chain.reaction',
});
const DISCORD_EPOCH = 1_420_070_400_000n;
const sourceProofs = new WeakMap();

let configuredRuntime = null;

function configureChainReactionFence(runtime) {
  configuredRuntime = runtime || null;
}

function getRuntime() {
  return configuredRuntime;
}

function purposeFor(featureKey) {
  const purposeId = PURPOSE_BY_FEATURE[featureKey];
  if (!purposeId) throw new Error('CHAIN_REACTION_FEATURE_INVALID');
  return purposeId;
}

function warningKey(purposeId, guildId) {
  return `${purposeId}|${guildId}`;
}

function stableSessionKey({ featureKey, guildId, channelId, sessionId, sessionCreatedAt }) {
  const purposeId = purposeFor(featureKey);
  const value = [purposeId, String(guildId), String(channelId), String(sessionId), String(sessionCreatedAt)].join('|');
  if (value.length > 300 || /[\u0000-\u001f\u007f]/u.test(value)) throw new Error('CHAIN_REACTION_SESSION_INVALID');
  return value;
}

function parseConfig(value) {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return { ...value };
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function readChainConfig(value) {
  if (!value) return Object.freeze({ valid: true, config: {} });
  if (typeof value === 'object' && !Array.isArray(value)) return Object.freeze({ valid: true, config: { ...value } });
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.freeze({ valid: false, config: {} });
    return Object.freeze({ valid: true, config: parsed });
  } catch {
    return Object.freeze({ valid: false, config: {} });
  }
}

function requireChainConfig(value) {
  const result = readChainConfig(value);
  if (!result.valid) throw new Error('CHAIN_REACTION_CONFIG_INVALID');
  return result.config;
}

function normalizeCompletion(value) {
  if (value == null) return null;
  const completion = {
    messageId: String(value.messageId || ''),
    entryId: Number(value.entryId),
    finalRevision: Number(value.finalRevision),
  };
  if (!/^\d{17,20}$/u.test(completion.messageId) || !Number.isSafeInteger(completion.entryId) ||
      completion.entryId < 1 || !Number.isSafeInteger(completion.finalRevision) || completion.finalRevision < 1) {
    throw new Error('CHAIN_REACTION_COMPLETION_INVALID');
  }
  return completion;
}

function buildMetadata({ ledgerId, fence, sessionId, sessionCreatedAt, completion = null, revoked = false }) {
  const value = {
    version: 1,
    ledgerId: String(ledgerId || ''),
    generation: Number(fence?.generation),
    session: { id: Number(sessionId), createdAt: String(sessionCreatedAt || '') },
    channelId: String(fence?.channelId || ''),
    sourceFence: String(fence?.sourceFence || ''),
    completion: normalizeCompletion(completion),
    revoked: revoked === true,
  };
  if (!value.ledgerId || !Number.isSafeInteger(value.generation) || value.generation < 1 ||
      !Number.isSafeInteger(value.session.id) || value.session.id < 1 || !value.session.createdAt ||
      !/^\d{17,20}$/u.test(value.channelId) || !/^[a-f0-9]{64}$/u.test(value.sourceFence)) {
    throw new Error('CHAIN_REACTION_METADATA_INVALID');
  }
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > MAX_RESERVED_BYTES) {
    throw new Error('CHAIN_REACTION_METADATA_TOO_LARGE');
  }
  return Object.freeze(value);
}

function mergeReservedConfig(current, metadata, defaults = {}) {
  const config = { ...parseConfig(current), ...defaults };
  delete config[RESERVED_KEY];
  if (metadata) config[RESERVED_KEY] = metadata;
  return config;
}

function preserveReservedConfig(current, replacement) {
  const existing = parseConfig(current);
  const next = parseConfig(replacement);
  if (existing[RESERVED_KEY]) next[RESERVED_KEY] = existing[RESERVED_KEY];
  else delete next[RESERVED_KEY];
  return next;
}

function openFence({ featureKey, guildId, channelId, sessionId, sessionCreatedAt, adoptOnlyIfMissing = false }) {
  const runtime = getRuntime();
  const purposeId = purposeFor(featureKey);
  if (!runtime?.isPurposeReady?.(purposeId)) return { kind: 'unavailable', metadata: null, fence: null };
  const sessionKey = stableSessionKey({ featureKey, guildId, channelId, sessionId, sessionCreatedAt });
  let result;
  try {
    result = runtime.openReactionFence(purposeId, { guildId, channelId, sessionKey }, { adoptOnlyIfMissing });
  } catch (error) {
    // The runtime has already handled the failure: a plain refusal on a healthy ledger only
    // fails this open, and anything else disabled the purpose and quarantined its ledger.
    return { kind: 'failed', metadata: null, fence: null, error };
  }
  try {
    const ledgerId = runtime.getLedgerIdentity(purposeId)?.ledgerId;
    const metadata = buildMetadata({ ledgerId, fence: result.fence, sessionId, sessionCreatedAt });
    inactiveAuthorityWarnings.delete(warningKey(purposeId, guildId));
    return { kind: result.kind, fence: result.fence, metadata };
  } catch (error) {
    // The fence is open but no authority can be stored for it: quarantine the ledger rather
    // than leave an open fence that nothing accounts for.
    runtime.disablePurpose?.(purposeId, { retainLock: true, code: 'REACTION_FENCE_METADATA_FAILED' });
    return { kind: 'failed', metadata: null, fence: null, error };
  }
}

function closeFence({ featureKey, guildId, channelId = undefined, generation = undefined }) {
  const runtime = getRuntime();
  const purposeId = purposeFor(featureKey);
  if (!runtime?.isPurposeReady?.(purposeId)) return { kind: 'unavailable', fence: null };
  try {
    return runtime.closeReactionFence(purposeId, guildId, { channelId, generation });
  } catch (error) {
    // The runtime has already disabled the purpose and quarantined its ledger.
    return { kind: 'failed', fence: null, error };
  }
}

function markCompletion(metadata, completion) {
  if (!metadata) return null;
  return buildMetadata({
    ledgerId: metadata.ledgerId,
    fence: metadata,
    sessionId: metadata.session?.id,
    sessionCreatedAt: metadata.session?.createdAt,
    completion,
    revoked: false,
  });
}

function revokeMetadata(metadata) {
  if (!metadata) return null;
  return Object.freeze({ ...metadata, revoked: true });
}

function verifyMetadata({ featureKey, guildId, channelId, sessionId, sessionCreatedAt, metadata, sourceFence }) {
  const runtime = getRuntime();
  const purposeId = purposeFor(featureKey);
  if (!runtime?.isPurposeReady?.(purposeId) || !metadata || metadata.revoked === true ||
      metadata.ledgerId !== runtime.getLedgerIdentity(purposeId)?.ledgerId ||
      Number(metadata.session?.id) !== Number(sessionId) || metadata.session?.createdAt !== sessionCreatedAt ||
      metadata.channelId !== channelId || metadata.sourceFence !== sourceFence) return null;
  const sessionKey = stableSessionKey({ featureKey, guildId, channelId, sessionId, sessionCreatedAt });
  return runtime.verifyReactionFence(purposeId, {
    guildId,
    channelId,
    sessionKey,
    generation: metadata.generation,
    sourceFence,
  });
}

// Why a round's ✅ stays off although its reaction purpose is ready, as a fixed code; null
// when there is nothing to report: the purpose is unavailable (not configured, failed, or
// stopping) or no authority is stored and no fence exists yet, so the next answer may
// adopt one. Call it only after the stored authority failed to verify.
function inactiveReactionReason({ featureKey, guildId, metadata }) {
  const runtime = getRuntime();
  const purposeId = purposeFor(featureKey);
  if (!runtime?.isPurposeReady?.(purposeId)) return null;
  let reason;
  if (!metadata) reason = runtime.getReactionFence?.(purposeId, guildId) ? 'AUTHORITY_MISSING' : null;
  else if (metadata.revoked === true) reason = 'AUTHORITY_REVOKED';
  else if (metadata.ledgerId !== runtime.getLedgerIdentity?.(purposeId)?.ledgerId) reason = 'LEDGER_CHANGED';
  else reason = 'FENCE_CHANGED';
  // A read that failed on the way disabled the purpose: that is unavailability, not this.
  return reason && runtime.isPurposeReady(purposeId) ? reason : null;
}

// The reason a round's stored ✅ authority yields no reaction while the purpose is ready,
// or null when it verifies or there is nothing to report (see inactiveReactionReason).
function inactiveReactionAuthority({ featureKey, guildId, channelId, sessionId, sessionCreatedAt, metadata }) {
  let verified = null;
  if (metadata && metadata.revoked !== true) {
    try {
      verified = verifyMetadata({ featureKey, guildId, channelId, sessionId, sessionCreatedAt, metadata,
        sourceFence: metadata.sourceFence });
    } catch {
      verified = null;
    }
  }
  return verified ? null : inactiveReactionReason({ featureKey, guildId, metadata });
}

// After an accepted answer got no reaction authority: warn once per guild and purpose,
// with fixed codes only (no message content), and return the reason or null.
function noteInactiveReactionAuthority({ featureKey, guildId, metadata }) {
  const reason = inactiveReactionReason({ featureKey, guildId, metadata });
  if (!reason) return null;
  const purposeId = purposeFor(featureKey);
  const key = warningKey(purposeId, guildId);
  if (!inactiveAuthorityWarnings.has(key)) {
    if (inactiveAuthorityWarnings.size >= MAX_INACTIVE_WARNINGS) inactiveAuthorityWarnings.clear();
    inactiveAuthorityWarnings.add(key);
    logger.warn(`[CHAIN_REACTION] purpose=${purposeId} code=CHAIN_REACTION_AUTHORITY_INACTIVE reason=${reason}`);
  }
  return reason;
}

function snowflakeTimestamp(messageId) {
  try {
    const value = String(messageId || '');
    if (!/^\d{17,20}$/u.test(value)) return null;
    const timestamp = Number((BigInt(value) >> 22n) + DISCORD_EPOCH);
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
  } catch {
    return null;
  }
}

function proveReactionSourceWithApi(api, { featureKey, guildId, channelId, messageId, authorId, sourceFence }) {
  const runtime = getRuntime();
  const purposeId = purposeFor(featureKey);
  const definition = featureKey === 'word_chain'
    ? { entryTable: 'text_chain_entries', sessionTable: 'text_chain_sessions' }
    : { entryTable: 'number_chain_entries', sessionTable: 'number_chain_sessions' };
  const setting = api.get('SELECT enabled, channel_id, config_json FROM feature_guild_settings WHERE guild_id = ? AND feature_key = ?',
    [guildId, featureKey]);
  const config = parseConfig(setting?.config_json || '{}');
  const metadata = config[RESERVED_KEY];
  const entry = api.get(`SELECT id, session_id, guild_id, channel_id, message_id, user_id FROM ${definition.entryTable} WHERE message_id = ?`,
    [messageId]);
  if (!entry || entry.guild_id !== guildId || entry.channel_id !== channelId || entry.user_id !== authorId) return null;
  const session = api.get(`SELECT id, guild_id, channel_id, status, revision, created_at FROM ${definition.sessionTable} WHERE id = ?`,
    [entry.session_id]);
  if (!session || session.guild_id !== guildId || session.channel_id !== channelId) return null;
  const fence = verifyMetadata({ featureKey, guildId, channelId, sessionId: Number(session.id),
    sessionCreatedAt: session.created_at, metadata, sourceFence });
  if (!fence) return null;
  const completion = metadata.completion;
  const isCompletion = session.status === 'completed' && completion?.messageId === messageId &&
    Number(completion.entryId) === Number(entry.id) && Number(completion.finalRevision) === Number(session.revision);
  const isActive = session.status === 'active' && Number(setting?.enabled) === 1 && setting.channel_id === channelId;
  if (!isActive && !isCompletion) return null;
  const timestamp = snowflakeTimestamp(messageId);
  const cutover = runtime?.getCutoverSourceTimestampMs?.(purposeId);
  const identity = runtime?.getLedgerIdentity?.(purposeId);
  if (!Number.isSafeInteger(timestamp) || !Number.isSafeInteger(cutover) || timestamp <= cutover || !identity) return null;
  const proof = Object.freeze({ kind: 'trusted-chain-reaction-source' });
  sourceProofs.set(proof, Object.freeze({
    botId: runtime.botId,
    purposeId,
    featureKey,
    guildId,
    channelId,
    messageId,
    authorId,
    sourceTimestampMs: timestamp,
    sessionKey: stableSessionKey({ featureKey, guildId, channelId, sessionId: Number(session.id), sessionCreatedAt: session.created_at }),
    sourceFence,
    generation: fence.generation,
    entryId: Number(entry.id),
    finalRevision: Number(session.revision),
    completion: isCompletion,
  }));
  return proof;
}

function consumeReactionSourceProof(proof) {
  const record = sourceProofs.get(proof) || null;
  if (record) sourceProofs.delete(proof);
  return record;
}

function sourceFenceHash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

module.exports = {
  MAX_RESERVED_BYTES,
  PURPOSE_BY_FEATURE,
  RESERVED_KEY,
  buildMetadata,
  closeFence,
  consumeReactionSourceProof,
  configureChainReactionFence,
  getRuntime,
  inactiveReactionAuthority,
  markCompletion,
  noteInactiveReactionAuthority,
  mergeReservedConfig,
  openFence,
  parseConfig,
  preserveReservedConfig,
  proveReactionSourceWithApi,
  readChainConfig,
  requireChainConfig,
  purposeFor,
  revokeMetadata,
  sourceFenceHash,
  stableSessionKey,
  verifyMetadata,
};
