const { PermissionFlagsBits } = require('discord.js');

// 舊紀錄的 visibility/source 無法證明擷取當時的頻道權限。
const PUBLIC_CAPTURE_PROOF = 'everyone-view-history-at-capture-v2';
const ingressDecisions = new WeakMap();

function everyoneCanRead(channel, everyone) {
  if (!channel || !everyone) return false;
  try {
    const permissions = channel.permissionsFor?.(everyone);
    return Boolean(permissions?.has?.(PermissionFlagsBits.ViewChannel) &&
      permissions.has(PermissionFlagsBits.ReadMessageHistory));
  } catch {
    return false;
  }
}

function isCurrentPublicChannel(message) {
  return Boolean(message?.guildId && message.channelId &&
    everyoneCanRead(message.channel, message.guild?.roles?.everyone));
}

function captureIngressVisibility(message) {
  if (!message || typeof message !== 'object') return null;
  if (!ingressDecisions.has(message)) {
    ingressDecisions.set(message, Object.freeze({
      guildId: message.guildId || null,
      channelId: message.channelId || null,
      proof: isCurrentPublicChannel(message) ? PUBLIC_CAPTURE_PROOF : null,
    }));
  }
  return captureProofFor(message);
}

function captureProofFor(message) {
  const decision = message && typeof message === 'object' ? ingressDecisions.get(message) : null;
  return decision && decision.guildId === (message.guildId || null) &&
    decision.channelId === (message.channelId || null) ? decision.proof : null;
}

function hasPublicCaptureProof(record) {
  return record?.captureProof === PUBLIC_CAPTURE_PROOF;
}

module.exports = { captureIngressVisibility, captureProofFor, everyoneCanRead,
  hasPublicCaptureProof, isCurrentPublicChannel };
