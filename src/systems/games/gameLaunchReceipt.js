'use strict';

const { createHash } = require('node:crypto');

class GameLaunchReceiptError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GameLaunchReceiptError';
    this.code = code;
  }
}

function requireText(value, name, maxLength = 256) {
  const text = String(value || '').trim();
  if (!text || text.length > maxLength) throw new GameLaunchReceiptError('INVALID_LAUNCH', `${name} is invalid.`);
  return text;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function hashLaunchPayload(payload) {
  return createHash('sha256').update(stableJson(payload ?? null)).digest('hex');
}

function applyGameLaunchOnce(api, {
  interactionId = null, kind, userId, guildId, channelId = null, payload,
}, apply) {
  if (typeof apply !== 'function') throw new GameLaunchReceiptError('INVALID_LAUNCH', 'Launch callback is required.');
  if (!interactionId) return { ...apply(), alreadyApplied: false };
  const operationId = requireText(interactionId, 'interactionId');
  const normalizedKind = requireText(kind, 'kind', 80);
  const normalizedUserId = requireText(userId, 'userId', 80);
  const normalizedGuildId = requireText(guildId, 'guildId', 80);
  const normalizedChannelId = channelId == null ? null : requireText(channelId, 'channelId', 80);
  const payloadHash = hashLaunchPayload(payload);
  const existing = api.get('SELECT * FROM game_launch_receipts WHERE interaction_id = ?', [operationId]);
  if (existing) {
    if (existing.kind !== normalizedKind || existing.user_id !== normalizedUserId ||
        existing.guild_id !== normalizedGuildId || existing.channel_id !== normalizedChannelId ||
        existing.payload_hash !== payloadHash) {
      throw new GameLaunchReceiptError('OPERATION_CONFLICT', '同一互動識別碼對應不同的遊戲開局內容。');
    }
    let result;
    try { result = JSON.parse(existing.result_json); }
    catch { throw new GameLaunchReceiptError('RECEIPT_CORRUPT', '遊戲開局收據已損壞。'); }
    return { ...result, alreadyApplied: true };
  }
  const result = apply();
  api.run(`INSERT INTO game_launch_receipts
    (interaction_id, kind, user_id, guild_id, channel_id, payload_hash, result_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [
    operationId, normalizedKind, normalizedUserId, normalizedGuildId, normalizedChannelId,
    payloadHash, JSON.stringify(result), new Date().toISOString(),
  ]);
  return { ...result, alreadyApplied: false };
}

module.exports = { GameLaunchReceiptError, applyGameLaunchOnce, hashLaunchPayload };
