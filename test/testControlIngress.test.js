'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { authorizeInteraction, authorizeMessage } = require('../src/platform/testControlIngress');
const { loadTestControlPolicy } = require('../src/platform/testControlPolicy');
const { IDS, createFixture } = require('./testControlSupport');

test('interaction scope is checked before binding any reply capability', () => {
  const fixture = createFixture();
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    let bound = 0;
    const client = { testControlPolicy: policy, testControlEgress: { bindInteraction() { bound += 1; } } };
    const allowed = { client, id: IDS.interaction, token: 'token', guildId: IDS.guild, channelId: IDS.channel,
      user: { id: IDS.actor }, commandName: 'ping', isChatInputCommand: () => true, isAutocomplete: () => false };
    assert.equal(authorizeInteraction(allowed), true);
    assert.equal(bound, 1);
    assert.equal(authorizeInteraction({ ...allowed, channelId: IDS.otherChannel }), false);
    assert.equal(bound, 1);
    assert.equal(authorizeInteraction({ ...allowed, commandName: 'work' }), false);
    assert.equal(bound, 1);
  } finally { fixture.cleanup(); }
});

test('messages require allowed scope, actor, and explicit feature', () => {
  const fixture = createFixture({ XIAOJI_TEST_ALLOWED_MESSAGE_FEATURES: 'word_chain' });
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const client = { testControlPolicy: policy, user: { id: IDS.app } };
    const message = { client, guildId: IDS.guild, channelId: IDS.channel, author: { id: IDS.actor },
      mentions: { has: () => false } };
    assert.equal(authorizeMessage(message).allowed, true);
    assert.equal(authorizeMessage({ ...message, author: { id: IDS.formal } }).allowed, false);
  } finally { fixture.cleanup(); }
});

test('conversation message feature permits non-mentions only with an AI provider', () => {
  const missingProvider = createFixture({ XIAOJI_TEST_ALLOWED_MESSAGE_FEATURES: 'conversation' });
  try {
    assert.throws(() => loadTestControlPolicy(missingProvider.env, { cwd: process.cwd() }),
      (error) => error.code === 'TEST_AI_PROVIDER_REQUIRED');
  } finally { missingProvider.cleanup(); }

  const fixture = createFixture({
    XIAOJI_TEST_ALLOWED_MESSAGE_FEATURES: 'conversation', OPENAI_API_KEY: 'synthetic-test-provider',
  });
  try {
    const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
    const client = { testControlPolicy: policy, user: { id: IDS.app } };
    const message = { client, guildId: IDS.guild, channelId: IDS.channel, author: { id: IDS.actor },
      mentions: { has: () => false } };
    assert.deepEqual(authorizeMessage(message), { allowed: true, mention: false });
  } finally { fixture.cleanup(); }
});
