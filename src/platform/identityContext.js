'use strict';

class IdentityContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'IdentityContextError';
    this.code = code;
  }
}

function requireDiscordId(value, field) {
  if (typeof value !== 'string' || !/^\d{1,20}$/.test(value)) {
    throw new IdentityContextError('IDENTITY_INVALID', `${field} must be a Discord ID string.`);
  }
  return value;
}

function optionalDiscordId(value, field) {
  return value == null ? null : requireDiscordId(value, field);
}

function createIdentityContext({ userId, sourceGuildId = null, channelId = null, actorUserId = null, operationId } = {}) {
  if (typeof operationId !== 'string' || operationId.length === 0 || operationId.length > 256 || !/^[\x21-\x7e]+$/.test(operationId)) {
    throw new IdentityContextError('OPERATION_ID_INVALID', 'operationId must be a stable printable ASCII string.');
  }
  return Object.freeze({
    userId: requireDiscordId(userId, 'userId'),
    sourceGuildId: optionalDiscordId(sourceGuildId, 'sourceGuildId'),
    channelId: optionalDiscordId(channelId, 'channelId'),
    actorUserId: optionalDiscordId(actorUserId, 'actorUserId'),
    operationId,
  });
}

module.exports = { IdentityContextError, createIdentityContext };
