'use strict';

const assert = require('node:assert/strict');
const Module = require('node:module');
const test = require('node:test');
const { loadTestControlPolicy } = require('../src/platform/testControlPolicy');
const { IDS, createFixture } = require('./testControlSupport');

async function withMessageCreateFakes(state, callback) {
  const modules = [
    ['../src/services/mentionService', {
      handleMentionMessage: async () => { state.mentionCalls += 1; },
      isPublicPersistenceSuppressed: () => false,
    }],
    ['../src/services/messageFeatureRouter', { routeMessageFeatures: async () => ({ handled: false }) }],
    ['../src/services/memoryService', { recordPublicMessage() {} }],
    ['../src/services/publicStatusService', { recordPublicInteraction: async () => {} }],
    ['../src/utils/logger', { error() {} }],
    ['../src/extensions/extensionHost', { getClientExtensionHost: () => ({ runHook: async () => [] }) }],
    ['../src/systems/conversation/publicVisibility', { captureIngressVisibility() {} }],
    ['../src/coordinators/conversationCoordinator', { createConversationPorts: () => Object.freeze({}) }],
  ];
  const eventPath = require.resolve('../src/events/messageCreate');
  const previousEvent = require.cache[eventPath];
  const replacements = modules.map(([request, replacement]) => {
    const resolved = require.resolve(request);
    const previous = require.cache[resolved] || null;
    const entry = new Module(resolved, module);
    entry.filename = resolved;
    entry.loaded = true;
    entry.exports = replacement;
    require.cache[resolved] = entry;
    return Object.freeze({ resolved, previous });
  });
  delete require.cache[eventPath];
  try {
    return await callback(require(eventPath));
  } finally {
    delete require.cache[eventPath];
    if (previousEvent) require.cache[eventPath] = previousEvent;
    for (const { resolved, previous } of replacements) {
      if (previous) require.cache[resolved] = previous;
      else delete require.cache[resolved];
    }
  }
}

function messageFor(policy) {
  return {
    author: { id: IDS.actor, bot: false },
    channelId: IDS.channel,
    client: { testControlPolicy: policy, user: { id: IDS.app } },
    content: '直接叫小吉',
    guildId: IDS.guild,
    mentions: { has: () => false },
    reply: async () => assert.fail('an approved guild conversation should use the normal chat flow'),
  };
}

test('conversation flag reaches the normal message flow for a non-mention in test-control', async () => {
  const fixture = createFixture({
    XIAOJI_TEST_ALLOWED_MESSAGE_FEATURES: 'conversation', OPENAI_API_KEY: 'synthetic-test-provider',
  });
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const state = { mentionCalls: 0 };
    await withMessageCreateFakes(state, async (listener) => listener.execute(messageFor(policy)));
    assert.equal(state.mentionCalls, 1);
  } finally { fixture.cleanup(); }
});

test('without conversation flag a non-mention remains outside the chat flow in test-control', async () => {
  const fixture = createFixture({ OPENAI_API_KEY: 'synthetic-test-provider' });
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const state = { mentionCalls: 0 };
    await withMessageCreateFakes(state, async (listener) => listener.execute(messageFor(policy)));
    assert.equal(state.mentionCalls, 0);
  } finally { fixture.cleanup(); }
});
