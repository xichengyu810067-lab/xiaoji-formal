'use strict';

let runtime = null;
let issuer = null;
let authority = null;

function configurePublicEffectAdapter({ publicEffectRuntime = null, publicEffectIssuer = null,
  publicEffectAuthority = null } = {}) {
  runtime = publicEffectRuntime;
  issuer = publicEffectIssuer;
  authority = publicEffectAuthority;
}

function getPublicEffectRuntime() {
  return runtime;
}

function issueChainReactionGrant(eventGrant, input) {
  return issuer?.issueChainReaction?.(eventGrant, input) || null;
}

function issuePenaltyGrant(sourceProof, effect) {
  return issuer?.issuePenalty?.(sourceProof, effect) || null;
}

function issueStoredChainReactionGrant(sourceProof, effect) {
  return issuer?.issueStoredChainReaction?.(sourceProof, effect) || null;
}

function issueWorkReminderGrant(sourceProof, effect) {
  return issuer?.issueWorkReminder?.(sourceProof, effect) || null;
}

function consumeTrustedGuildJoinGrant(grant) {
  return authority?.consumeGuildJoin?.(grant) || null;
}

module.exports = {
  configurePublicEffectAdapter,
  consumeTrustedGuildJoinGrant,
  getPublicEffectRuntime,
  issueChainReactionGrant,
  issuePenaltyGrant,
  issueStoredChainReactionGrant,
  issueWorkReminderGrant,
};
