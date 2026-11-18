// The round lifecycle the number chain and the word chain share: starting, stopping and reporting a round, the
// feature setting that points the message router at its channel, and the ✅ reaction a counted move earns.
//
// Each chain describes itself (defineChain) with its feature key, the name members read, the version its setting
// records, its error class and the statements on its own sessions table; what a move is, and how a round ends, stays
// in the chain's own service. Everything here runs inside the caller's transaction.
const { withCoinDatabase, withCoinTransaction } = require('../../economy/storage/coinDatabase');
const {
  enqueueFeatureOutboxWithApi,
  getGuildFeatureSettingRowWithApi,
  upsertGuildFeatureSettingWithApi,
} = require('../../../services/featurePlatformService');
const { REACTION_EVENT_TYPE, buildReactionOutboxPayload, dispatchImmediateChainReaction } = require('./chainReactionDelivery');
const {
  RESERVED_KEY,
  closeFence,
  getRuntime: getReactionRuntime,
  inactiveReactionAuthority,
  markCompletion,
  mergeReservedConfig,
  noteInactiveReactionAuthority,
  openFence,
  parseConfig,
  readChainConfig,
  requireChainConfig,
  purposeFor,
  revokeMetadata,
  verifyMetadata,
} = require('../../safety/chainReactionFence');
const { snowflakeTimestamp } = require('../../../platform/publicEffectGrant');
const logger = require('../../../utils/logger');

// The newest active round of each chain in a guild. A chain refuses a channel the other chain runs in, so each
// reads the other's sessions here.
const ACTIVE_ROUND_IN_GUILD = Object.freeze({
  number_chain: "SELECT id, channel_id FROM number_chain_sessions WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
  word_chain: "SELECT id, channel_id FROM text_chain_sessions WHERE guild_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1",
});

// featureKey, label (the name members read, 數字接龍 or 文字接龍), versionConfig (what the setting records next to the
// reaction authority), makeError(code, message), otherChain ({ featureKey, conflictMessage }) and sessions:
//   selectActive(api, guildId, channelId = null)    the newest active row, in the channel when one is given
//   selectLatestCompleted(api, guildId, channelId)  the newest completed round in the channel (id, created_at)
//   selectById(api, id), selectLastInserted(api)
//   stop(api, id, actorId, timestamp)               marks an active round stopped
//   map(row), mapRetired(row)                       the round as callers see it; mapRetired for a round just retired
function defineChain({ sessions, ...chain }) {
  return Object.freeze({ ...chain, sessions: Object.freeze({ ...sessions, mapRetired: sessions.mapRetired || sessions.map }) });
}

// Whether the chain featureKey runs in the channel: its newest active round is there, or its setting is enabled for it.
function chainOccupiesChannel(api, featureKey, guildId, channelId) {
  const session = api.get(ACTIVE_ROUND_IN_GUILD[featureKey], [guildId]);
  const setting = getGuildFeatureSettingRowWithApi(api, guildId, featureKey);
  return session?.channel_id === channelId || (Number(setting?.enabled) === 1 && setting.channel_id === channelId);
}

// reactionMetadata: undefined keeps the stored reaction authority, null removes it, anything else replaces it. A
// setting whose configuration cannot be read is only ever written to disable the chain (allowCorruptDisable).
function setChainFeatureSetting(api, chain, guildId, { enabled, channelId, now, reactionMetadata = undefined,
  allowCorruptDisable = false }) {
  const current = getGuildFeatureSettingRowWithApi(api, guildId, chain.featureKey);
  const parsed = readChainConfig(current?.config_json || '{}');
  if (!parsed.valid && !(allowCorruptDisable && enabled === false)) throw new Error('CHAIN_REACTION_CONFIG_INVALID');
  const currentConfig = parsed.valid ? parsed.config : {};
  const metadata = reactionMetadata === undefined ? currentConfig[RESERVED_KEY] : reactionMetadata;
  const configJson = JSON.stringify(mergeReservedConfig(currentConfig, metadata, chain.versionConfig));
  upsertGuildFeatureSettingWithApi(api, { guildId, featureKey: chain.featureKey, enabled, channelId, configJson,
    createdAt: current?.created_at || now, updatedAt: now });
}

// The session was created by this very start call, so there is no earlier progress to protect: retire it together
// with the feature setting. previousRoundEnded tells the caller that a round in another channel was already retired
// by the same call (a channel switch), which the administrator has to be told.
function failClosedStart(api, chain, { guildId, sessionId, actorId, now, previousRoundEnded = false }) {
  chain.sessions.stop(api, sessionId, actorId, now);
  setChainFeatureSetting(api, chain, guildId, { enabled: false, channelId: null, now,
    reactionMetadata: null, allowCorruptDisable: true });
  return { fenceOpenFailed: true, previousRoundEnded };
}

// Re-running start on a channel whose round is already in progress must not end that round. The reaction fence only
// authorizes the public reaction (every dispatch re-verifies it against the stored metadata and the open fence), not
// the stored entries, so a fence that cannot be opened disables the feature setting while the session row stays
// untouched; running start again once the fence works resumes the same round.
// The stored reaction authority is kept on purpose: the startup reconcile re-enables the setting of a guild that still
// has an active round, and if the ledger fence verifies against the kept authority the reaction is sent again
// without anybody running start. An authority that no longer verifies simply yields no reaction.
function pauseAfterFenceFailure(api, chain, { guildId, now }) {
  setChainFeatureSetting(api, chain, guildId, { enabled: false, channelId: null, now, allowCorruptDisable: true });
  return { fenceOpenFailed: true, sessionKept: true };
}

// A stored reaction authority only becomes a reaction source while the live fence still verifies it, with the same
// check the dispatch repeats later. A purpose that is unavailable, or a fence that was closed or replaced, yields none,
// so no reaction is queued that could not be delivered or that would run without protection.
function liveReactionAuthority(chain, metadata, { guildId, channelId, session }) {
  if (!metadata || metadata.revoked === true) return null;
  try {
    return verifyMetadata({ featureKey: chain.featureKey, guildId, channelId, sessionId: Number(session.id),
      sessionCreatedAt: session.created_at, metadata, sourceFence: metadata.sourceFence });
  } catch {
    return null;
  }
}

// insertSession(api) adds the new active round; ids are normalized and timestamp is an ISO string.
async function startChainRound(chain, { guildId, channelId, actorId, timestamp, beforeCommit = null, insertSession }) {
  const { featureKey, sessions } = chain;
  const result = await withCoinTransaction((api) => {
    const initialSetting = getGuildFeatureSettingRowWithApi(api, guildId, featureKey);
    requireChainConfig(initialSetting?.config_json || '{}');
    if (chainOccupiesChannel(api, chain.otherChain.featureKey, guildId, channelId)) {
      throw chain.makeError('CHAIN_CHANNEL_CONFLICT', chain.otherChain.conflictMessage);
    }
    const existing = sessions.selectActive(api, guildId);
    if (existing?.channel_id === channelId) {
      const session = sessions.map(existing);
      const opened = openFence({ featureKey, guildId, channelId, sessionId: session.id,
        sessionCreatedAt: session.createdAt });
      if (!opened.metadata) return pauseAfterFenceFailure(api, chain, { guildId, now: timestamp });
      setChainFeatureSetting(api, chain, guildId, { enabled: true, channelId, now: timestamp,
        reactionMetadata: opened.metadata });
      return { alreadyActive: true, stoppedSession: null, session };
    }
    if (existing) {
      const previousSetting = getGuildFeatureSettingRowWithApi(api, guildId, featureKey);
      const previousMetadata = requireChainConfig(previousSetting?.config_json || '{}')[RESERVED_KEY];
      closeFence({ featureKey, guildId, channelId: existing.channel_id, generation: previousMetadata?.generation });
      sessions.stop(api, existing.id, actorId, timestamp);
    }
    insertSession(api);
    const session = sessions.map(sessions.selectLastInserted(api));
    const opened = openFence({ featureKey, guildId, channelId, sessionId: session.id,
      sessionCreatedAt: session.createdAt });
    if (!opened.metadata) return failClosedStart(api, chain, { guildId, sessionId: session.id, actorId,
      now: timestamp, previousRoundEnded: Boolean(existing) });
    setChainFeatureSetting(api, chain, guildId, { enabled: true, channelId, now: timestamp,
      reactionMetadata: opened.metadata });
    if (typeof beforeCommit === 'function') beforeCommit();
    const stoppedSession = existing ? sessions.mapRetired(sessions.selectById(api, existing.id)) : null;
    return { alreadyActive: false, stoppedSession, session };
  });
  if (result?.fenceOpenFailed) {
    const sessionKept = result.sessionKept === true;
    const previousRoundEnded = result.previousRoundEnded === true;
    const error = chain.makeError('REACTION_FENCE_OPEN_FAILED', sessionKept
      ? `${chain.label}的公開回應安全狀態無法建立，已暫停此頻道的接龍；進度已保留，修復後重新開局即可繼續。`
      : previousRoundEnded
        ? `${chain.label}的公開回應安全狀態無法建立，沒有開始新的一局，原頻道的那一局已結束，接龍保持停用。`
        : `${chain.label}的公開回應安全狀態無法建立，已保持停用。`);
    error.sessionKept = sessionKept;
    error.previousRoundEnded = previousRoundEnded;
    throw error;
  }
  return result;
}

async function stopChainRound(chain, { guildId, channelId, actorId, timestamp }) {
  const { featureKey, sessions } = chain;
  return withCoinTransaction((api) => {
    const session = sessions.selectActive(api, guildId, channelId);
    const activeSession = sessions.selectActive(api, guildId);
    const setting = getGuildFeatureSettingRowWithApi(api, guildId, featureKey);
    const metadata = parseConfig(setting?.config_json || '{}')[RESERVED_KEY];
    const completed = session ? null : sessions.selectLatestCompleted(api, guildId, channelId);
    const targetOwnsCurrentLineage = session
      ? Number(activeSession?.id) === Number(session.id) &&
        (!setting?.channel_id || setting.channel_id === channelId) &&
        (!metadata?.channelId || metadata.channelId === channelId)
      : Boolean(completed) && !activeSession &&
        (!setting?.channel_id || setting.channel_id === channelId) &&
        (!metadata?.channelId || metadata.channelId === channelId) &&
        (!metadata?.session?.id || Number(metadata.session.id) === Number(completed.id));
    if (!targetOwnsCurrentLineage) return { stopped: false, reactionRevoked: false, session: null };
    const closed = closeFence({ featureKey, guildId, channelId, generation: metadata?.generation });
    if (session) sessions.stop(api, session.id, actorId, timestamp);
    setChainFeatureSetting(api, chain, guildId, { enabled: false, channelId: null, now: timestamp,
      reactionMetadata: metadata ? revokeMetadata(metadata) : null, allowCorruptDisable: true });
    return { stopped: Boolean(session), reactionRevoked: closed.kind === 'closed' || closed.kind === 'failed',
      session: session ? sessions.mapRetired(sessions.selectById(api, session.id)) : null };
  });
}

// The round in the channel, if any. paused is true while the round is still active but its feature setting is disabled
// (or points elsewhere), so the router ignores the channel: a paused round must not be reported as running.
async function getChainRoundStatus(chain, { guildId, channelId }) {
  const { featureKey, sessions } = chain;
  return withCoinDatabase((api) => {
    const session = sessions.map(sessions.selectActive(api, guildId, channelId));
    if (!session) return null;
    const setting = getGuildFeatureSettingRowWithApi(api, guildId, featureKey);
    const paused = !(Number(setting?.enabled) === 1 && setting.channel_id === session.channelId);
    // A running round whose stored ✅ authority no longer verifies while the purpose is ready
    // (for example the ledger was re-initialized) gets no reaction until start runs again.
    const reactionInactive = !paused && Boolean(inactiveReactionAuthority({ featureKey,
      guildId, channelId: session.channelId, sessionId: session.id,
      sessionCreatedAt: session.createdAt, metadata: readChainConfig(setting?.config_json || '{}').config[RESERVED_KEY] || null }));
    return { ...session, paused, reactionInactive };
  });
}

// For a move that is about to be counted: the stored reaction authority (adopting the open fence of a round that
// started before the ledger cutover), and whether it still verifies. Decided before the move is stored, so only
// the authority that verifies now may queue a reaction. session is the stored row.
function authorizeMoveReaction(api, chain, { guildId, channelId, messageId, session, timestamp }) {
  const { featureKey } = chain;
  const setting = getGuildFeatureSettingRowWithApi(api, guildId, featureKey);
  const chainConfig = readChainConfig(setting?.config_json || '{}');
  let reactionMetadata = chainConfig.config[RESERVED_KEY] || null;
  if (chainConfig.valid && !reactionMetadata) {
    const runtime = getReactionRuntime();
    const purposeId = purposeFor(featureKey);
    const sourceTime = snowflakeTimestamp(messageId);
    // A fence read that fails disables the purpose and returns null, so the cutover is read
    // afterwards: it is null once the purpose is unavailable, and nothing is adopted.
    const fenceMissing = Boolean(runtime?.isPurposeReady?.(purposeId)) &&
      !runtime.getReactionFence(purposeId, guildId);
    const cutover = fenceMissing ? runtime.getCutoverSourceTimestampMs(purposeId) : null;
    if (fenceMissing && Number.isSafeInteger(cutover) && Number.isSafeInteger(sourceTime) && sourceTime > cutover) {
      const adopted = openFence({ featureKey, guildId, channelId, sessionId: Number(session.id),
        sessionCreatedAt: session.created_at, adoptOnlyIfMissing: true });
      reactionMetadata = adopted.metadata;
      if (reactionMetadata) {
        setChainFeatureSetting(api, chain, guildId, { enabled: true, channelId, now: timestamp, reactionMetadata });
      }
    }
  }
  const reactionAuthority = liveReactionAuthority(chain, reactionMetadata, { guildId, channelId, session });
  if (!reactionAuthority) {
    noteInactiveReactionAuthority({ featureKey, guildId, metadata: reactionMetadata });
  }
  return { reactionMetadata, reactionAuthority };
}

// After the move is stored: a move that completed the round marks the authority complete and disables the chain,
// and a move with a live authority queues its reaction. Returns the reaction source, or null.
function settleCountedMove(api, chain, { guildId, channelId, messageId, userId, now, timestamp, completed, entryId,
  finalRevision, reactionMetadata, reactionAuthority }) {
  let metadata = reactionMetadata;
  if (completed && metadata) metadata = markCompletion(metadata, { messageId, entryId, finalRevision });
  if (completed) setChainFeatureSetting(api, chain, guildId, { enabled: false, channelId: null, now: timestamp,
    reactionMetadata: metadata });
  if (!reactionAuthority) return null;
  const reactionSource = Object.freeze({ guildId, channelId, messageId, authorId: userId,
    sourceFence: metadata.sourceFence });
  enqueueFeatureOutboxWithApi(api, {
    guildId,
    featureKey: chain.featureKey,
    eventType: REACTION_EVENT_TYPE,
    dedupeKey: `reaction:${messageId}`,
    payload: buildReactionOutboxPayload(reactionSource),
    availableAt: now,
    now,
  });
  return reactionSource;
}

// What a member sees after a message in the chain channel: the reason a move was refused, the ✅ of a counted move,
// and completionContent(result) when it completed the round. The message is always taken.
async function answerMove(message, chain, result, completionContent) {
  if (result.duplicate) return true;
  if (!result.ok) {
    await message.reply({ content: result.message, allowedMentions: { repliedUser: false } })
      .catch((error) => logger.warn(`${chain.label}拒絕訊息回覆失敗`, error));
    return true;
  }
  if (result.reactionSource) {
    const reaction = await dispatchImmediateChainReaction(message.client, chain.featureKey, result.reactionSource);
    if (reaction.kind !== 'confirmed') logger.warn(`${chain.label}確認反應未確認。code=${reaction.kind}`);
  }
  if (result.completed) {
    await message.reply({ content: completionContent(result), allowedMentions: { repliedUser: false } })
      .catch((error) => logger.warn(`${chain.label}完成訊息回覆失敗`, error));
  }
  return true;
}

module.exports = {
  answerMove,
  authorizeMoveReaction,
  defineChain,
  getChainRoundStatus,
  settleCountedMove,
  startChainRound,
  stopChainRound,
};
