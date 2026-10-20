'use strict';

const { getTestControlPolicy } = require('./testControlPolicy');

function reject(policy, code, operation) {
  policy.reporter.deny(code, operation);
  return false;
}

function authorizeInteraction(interaction) {
  const policy = getTestControlPolicy(interaction?.client);
  if (!policy) return true;
  if (!policy.allowsGuild(interaction?.guildId) || !policy.allowsChannel(interaction?.channelId) ||
      !policy.allowsActor(interaction?.user?.id)) {
    return reject(policy, 'TEST_INTERACTION_SCOPE_DENIED', 'interaction_ingress');
  }
  if ((interaction.isChatInputCommand?.() || interaction.isAutocomplete?.()) &&
      !policy.allowsCommand(interaction.commandName)) {
    return reject(policy, 'TEST_COMMAND_DENIED', 'interaction_ingress');
  }
  const resolvedChannels = [...(interaction?.options?.resolved?.channels?.values?.() || [])];
  if (resolvedChannels.some((channel) => !policy.allowsChannel(channel?.id) || !policy.allowsGuild(channel?.guildId))) {
    return reject(policy, 'TEST_OPTION_SCOPE_DENIED', 'interaction_ingress');
  }
  const resolvedActors = [
    ...(interaction?.options?.resolved?.users?.values?.() || []),
    ...(interaction?.options?.resolved?.members?.values?.() || []),
  ];
  if (resolvedActors.some((actor) => !policy.allowsActor(actor?.id || actor?.user?.id))) {
    return reject(policy, 'TEST_OPTION_SCOPE_DENIED', 'interaction_ingress');
  }
  if (!interaction.isChatInputCommand?.() && !interaction.isAutocomplete?.() &&
      !policy.allowsComponent(interaction.customId)) {
    return reject(policy, 'TEST_COMPONENT_DENIED', 'interaction_ingress');
  }
  try {
    interaction.client.testControlEgress.bindInteraction(interaction);
  } catch {
    return false;
  }
  return true;
}

function authorizeMessage(message) {
  const policy = getTestControlPolicy(message?.client);
  if (!policy) return { allowed: true, mention: false };
  if (!policy.allowsGuild(message?.guildId) || !policy.allowsChannel(message?.channelId) ||
      !policy.allowsActor(message?.author?.id)) {
    return { allowed: reject(policy, 'TEST_MESSAGE_SCOPE_DENIED', 'message_ingress'), mention: false };
  }
  const mention = Boolean(message?.client?.user?.id && message?.mentions?.has?.(message.client.user.id));
  if (mention && !policy.allowsMessageFeature('mention')) {
    return { allowed: reject(policy, 'TEST_MESSAGE_FEATURE_DENIED', 'message_ingress'), mention };
  }
  if (!mention && !['conversation', 'word_chain', 'number_chain', 'daily_riddle', 'daily_discussion']
    .some((name) => policy.allowsMessageFeature(name))) {
    return { allowed: reject(policy, 'TEST_MESSAGE_FEATURE_DENIED', 'message_ingress'), mention };
  }
  return { allowed: true, mention };
}

function authorizeEvent(client, eventName, { guildId, channelId = null } = {}) {
  const policy = getTestControlPolicy(client);
  if (!policy) return true;
  if (!policy.allowsEvent(eventName) || !policy.allowsGuild(guildId) ||
      (channelId && !policy.allowsChannel(channelId))) {
    return reject(policy, 'TEST_EVENT_DENIED', 'event_ingress');
  }
  return true;
}

module.exports = { authorizeEvent, authorizeInteraction, authorizeMessage };
