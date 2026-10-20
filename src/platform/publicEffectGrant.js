'use strict';

const crypto = require('node:crypto');

const SNOWFLAKE = /^\d{17,20}$/u;
const DISCORD_EPOCH = 1_420_070_400_000n;
const REACTION_PURPOSES = Object.freeze({
  word_chain: 'word-chain.reaction',
  number_chain: 'number-chain.reaction',
});
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(stableValue(value));
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isExactWelcomeBody(body, memberId) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'allowed_mentions,content' ||
      body.content !== `歡迎 <@${memberId}> 加入伺服器！小吉在這裡向你打招呼～`) return false;
  const mentions = body.allowed_mentions;
  return Boolean(mentions && typeof mentions === 'object' && !Array.isArray(mentions) &&
    Object.keys(mentions).sort().join(',') === 'parse,replied_user,roles,users' &&
    Array.isArray(mentions.parse) && mentions.parse.length === 0 &&
    Array.isArray(mentions.users) && mentions.users.length === 1 && mentions.users[0] === memberId &&
    Array.isArray(mentions.roles) && mentions.roles.length === 0 && mentions.replied_user === false);
}

function snowflakeTimestamp(value) {
  if (!SNOWFLAKE.test(String(value || ''))) return null;
  try {
    const timestamp = Number((BigInt(value) >> 22n) + DISCORD_EPOCH);
    return Number.isSafeInteger(timestamp) && timestamp >= 0 ? timestamp : null;
  } catch {
    return null;
  }
}

function isExactReactionEffect(effect, source) {
  const encodedEmoji = encodeURIComponent('✅');
  return effect?.purposeId === REACTION_PURPOSES[source.featureKey] &&
    effect?.action === 'chain-reaction.put' && effect?.target === source.channelId &&
    String(effect?.method || '').toUpperCase() === 'PUT' &&
    effect?.route === `/channels/${source.channelId}/messages/${source.messageId}/reactions/${encodedEmoji}/@me` &&
    effect?.body === null;
}

function createPublicEffectAuthority() {
  const eventGrants = new WeakMap();
  const effectGrants = new WeakMap();
  const guildJoinGrants = new WeakMap();

  function captureGuildJoin({ sourceNamespace, botId, guildId, joinedTimestamp }) {
    const timestamp = Number(joinedTimestamp);
    const normalized = {
      schemaVersion: 1,
      sourceNamespace: String(sourceNamespace || ''),
      botId: String(botId || ''),
      guildId: String(guildId || ''),
      joinedTimestamp: timestamp,
      joinedAt: Number.isSafeInteger(timestamp) ? new Date(timestamp).toISOString() : null,
    };
    if (!['discord.guildCreate', 'discord.ready'].includes(normalized.sourceNamespace) ||
        !SNOWFLAKE.test(normalized.botId) || !SNOWFLAKE.test(normalized.guildId) ||
        !Number.isSafeInteger(timestamp) || timestamp < 0) return null;
    const grant = Object.freeze({ kind: 'trusted-discord-guild-join' });
    guildJoinGrants.set(grant, Object.freeze({
      ...normalized,
      sourceEventId: `${normalized.guildId}.${timestamp}`,
      lineageDigest: sha256(stableJson(normalized)),
    }));
    return grant;
  }

  function consumeGuildJoin(grant) {
    const record = guildJoinGrants.get(grant) || null;
    if (record) guildJoinGrants.delete(grant);
    return record;
  }

  function captureGuildMemberAdd({ botId, guildId, memberId, joinedTimestamp }) {
    if (typeof joinedTimestamp !== 'number') return null;
    const normalized = {
      botId: String(botId || ''),
      guildId: String(guildId || ''),
      memberId: String(memberId || ''),
      joinedTimestamp: Number(joinedTimestamp),
    };
    if (!SNOWFLAKE.test(normalized.botId) || !SNOWFLAKE.test(normalized.guildId) ||
        !SNOWFLAKE.test(normalized.memberId) || !Number.isSafeInteger(normalized.joinedTimestamp) ||
        normalized.joinedTimestamp < 0) return null;
    const grant = Object.freeze({ kind: 'trusted-guild-member-add' });
    eventGrants.set(grant, Object.freeze({
      ...normalized,
      purposeId: 'welcome',
      sourceNamespace: 'discord.guildMemberAdd',
      hostPurpose: 'discord.guildMemberAdd',
      scope: `guild:${normalized.guildId}`,
      sourceEventId: `${normalized.guildId}.${normalized.memberId}.${normalized.joinedTimestamp}`,
    }));
    return grant;
  }

  function captureMessageCreate({ botId, guildId, channelId, messageId, authorId, createdTimestamp }) {
    const timestamp = createdTimestamp == null ? snowflakeTimestamp(messageId) : Number(createdTimestamp);
    const normalized = {
      botId: String(botId || ''),
      guildId: String(guildId || ''),
      channelId: String(channelId || ''),
      messageId: String(messageId || ''),
      authorId: String(authorId || ''),
      sourceTimestampMs: timestamp,
    };
    if (![normalized.botId, normalized.guildId, normalized.channelId, normalized.messageId,
      normalized.authorId].every((value) => SNOWFLAKE.test(value)) ||
      !Number.isSafeInteger(timestamp) || timestamp < 0) return null;
    const grant = Object.freeze({ kind: 'trusted-message-create' });
    eventGrants.set(grant, Object.freeze({
      ...normalized,
      sourceNamespace: 'discord.messageCreate',
      hostPurpose: 'discord.messageCreate',
      scope: `guild:${normalized.guildId}:channel:${normalized.channelId}`,
      sourceEventId: normalized.messageId,
    }));
    return grant;
  }

  function inspectEvent(grant) {
    return eventGrants.get(grant) || null;
  }

  function issueEffect(eventGrant, effect) {
    const source = eventGrants.get(eventGrant);
    if (!source) return null;
    const target = String(effect?.target || '');
    const method = String(effect?.method || '').toUpperCase();
    const route = String(effect?.route || '');
    const expectedRoute = `/channels/${target}/messages`;
    if (effect?.purposeId !== source.purposeId || effect?.action !== 'welcome-message.create' ||
        !SNOWFLAKE.test(target) || method !== 'POST' || route !== expectedRoute ||
        !isExactWelcomeBody(effect?.body, source.memberId)) return null;
    eventGrants.delete(eventGrant);
    let body;
    let payloadDigest;
    try {
      body = stableValue(effect.body);
      payloadDigest = sha256(stableJson(effect.body));
    } catch {
      return null;
    }
    const record = Object.freeze({ ...source, action: effect.action, target, method, route,
      body, payloadDigest });
    const grant = Object.freeze({ kind: 'trusted-public-effect' });
    effectGrants.set(grant, record);
    return grant;
  }

  function createIssuer() {
    function grantReaction(record, effect) {
      const purposeId = REACTION_PURPOSES[record?.featureKey];
      if (!purposeId || record.purposeId !== purposeId || !isExactReactionEffect(effect, record)) return null;
      const authorized = Object.freeze({ ...record, purposeId,
        sourceNamespace: 'discord.messageCreate', hostPurpose: 'discord.messageCreate',
        sourceEventId: record.messageId, scope: `guild:${record.guildId}:channel:${record.channelId}`,
        action: effect.action, target: effect.target, method: String(effect.method).toUpperCase(),
        route: effect.route, body: null, payloadDigest: sha256(stableJson(null)) });
      const grant = Object.freeze({ kind: 'trusted-public-effect' });
      effectGrants.set(grant, authorized);
      return grant;
    }

    function issueChainReaction(eventGrant, { sourceProof, effect } = {}) {
      const eventSource = eventGrants.get(eventGrant);
      const { consumeReactionSourceProof } = require('../systems/safety/chainReactionFence');
      const record = consumeReactionSourceProof(sourceProof);
      if (!eventSource || !record || eventSource.sourceNamespace !== 'discord.messageCreate' ||
          eventSource.guildId !== record.guildId || eventSource.channelId !== record.channelId ||
          eventSource.messageId !== record.messageId || eventSource.authorId !== record.authorId ||
          eventSource.sourceTimestampMs !== record.sourceTimestampMs) return null;
      eventGrants.delete(eventGrant);
      return grantReaction(record, effect);
    }

    function issueStoredChainReaction(sourceProof, effect) {
      const { consumeReactionSourceProof } = require('../systems/safety/chainReactionFence');
      const record = consumeReactionSourceProof(sourceProof);
      return record ? grantReaction(record, effect) : null;
    }

    function issuePenalty(sourceProof, effect) {
      const { consumeWorkPenaltySourceProof } = require('../systems/safety/workPenaltySource');
      const record = consumeWorkPenaltySourceProof(sourceProof);
      if (!record || effect?.purposeId !== record.purposeId || effect?.action !== record.action ||
          String(effect?.target || '') !== record.target || String(effect?.method || '').toUpperCase() !== record.method ||
          effect?.route !== record.route || sha256(stableJson(effect?.body)) !== record.payloadDigest) return null;
      const grant = Object.freeze({ kind: 'trusted-public-effect' });
      effectGrants.set(grant, record);
      return grant;
    }

    function issueWorkReminder(sourceProof, effect) {
      const { consumeWorkReminderSourceProof } = require('../systems/safety/workReminderSource');
      const record = consumeWorkReminderSourceProof(sourceProof);
      if (!record || effect?.purposeId !== record.purposeId || effect?.action !== record.action ||
          String(effect?.target || '') !== record.target || String(effect?.method || '').toUpperCase() !== record.method ||
          effect?.route !== record.route || sha256(stableJson(effect?.body)) !== record.payloadDigest) return null;
      const grant = Object.freeze({ kind: 'trusted-public-effect' });
      effectGrants.set(grant, record);
      return grant;
    }

    return Object.freeze({ issueChainReaction, issuePenalty,
      issueStoredChainReaction, issueWorkReminder });
  }

  function consumeEffect(grant, effect) {
    const record = effectGrants.get(grant);
    if (!record) return null;
    effectGrants.delete(grant);
    let candidate;
    try {
      candidate = {
        purposeId: effect?.purposeId,
        action: effect?.action,
        target: String(effect?.target || ''),
        method: String(effect?.method || '').toUpperCase(),
        route: String(effect?.route || ''),
        payloadDigest: sha256(stableJson(effect?.body)),
      };
    } catch {
      return null;
    }
    if (candidate.purposeId !== record.purposeId || candidate.action !== record.action ||
        candidate.target !== record.target || candidate.method !== record.method ||
        candidate.route !== record.route || candidate.payloadDigest !== record.payloadDigest) return null;
    return record;
  }

  return Object.freeze({ captureGuildJoin, captureGuildMemberAdd, captureMessageCreate,
    consumeEffect, consumeGuildJoin, createIssuer, inspectEvent, issueEffect });
}

module.exports = {
  createPublicEffectAuthority,
  sha256,
  snowflakeTimestamp,
  stableJson,
};
