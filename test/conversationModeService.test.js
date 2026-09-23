const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_TTL_MS,
  DEFAULT_SILENCE_MS,
  checkCooldown,
  clearConversationStateForTests,
  endConversation,
  hasActiveConversation,
  isConversationSilenced,
  isLikelyAddressedElsewhere,
  isStopConversationCommand,
  refreshConversation,
  silenceConversation,
  startConversation,
  validateChatInput,
} = require('../src/services/conversationModeService');

function createMessage({ guildId = 'guild-1', channelId = 'channel-1', userId = 'user-1' } = {}) {
  return {
    guildId,
    channelId,
    author: {
      id: userId,
    },
  };
}

test('conversation mode is scoped to same guild channel and user', () => {
  clearConversationStateForTests();
  const message = createMessage();

  startConversation(message, 1000);

  assert.equal(hasActiveConversation(message, 2000), true);
  assert.equal(hasActiveConversation(createMessage({ userId: 'user-2' }), 2000), false);
  assert.equal(hasActiveConversation(createMessage({ channelId: 'channel-2' }), 2000), false);
  assert.equal(hasActiveConversation(createMessage({ guildId: 'guild-2' }), 2000), false);
});

test('conversation mode expires and can be refreshed', () => {
  clearConversationStateForTests();
  const message = createMessage();

  startConversation(message, 1000);
  assert.equal(hasActiveConversation(message, 1000 + DEFAULT_TTL_MS - 1), true);
  assert.equal(hasActiveConversation(message, 1000 + DEFAULT_TTL_MS + 1), false);

  startConversation(message, 2000);
  refreshConversation(message, 3000);
  assert.equal(hasActiveConversation(message, 3000 + DEFAULT_TTL_MS - 1), true);
});

test('conversation mode can be ended by stop phrases', () => {
  clearConversationStateForTests();
  const message = createMessage();

  startConversation(message, 1000);
  assert.equal(isStopConversationCommand('小吉閉嘴'), true);
  assert.equal(isStopConversationCommand('不用回復'), true);
  assert.equal(isStopConversationCommand('先不要說話'), true);
  endConversation(message);
  assert.equal(hasActiveConversation(message, 2000), false);
});

test('stop phrases silence conversation briefly after ending it', () => {
  clearConversationStateForTests();
  const message = createMessage();

  startConversation(message, 1000);
  silenceConversation(message, 2000);

  assert.equal(hasActiveConversation(message, 2001), false);
  assert.equal(isConversationSilenced(message, 2001), true);
  assert.equal(isConversationSilenced(message, 2000 + DEFAULT_SILENCE_MS + 1), false);
});

test('conversation guard rejects too long and obviously addressed elsewhere messages', () => {
  assert.equal(validateChatInput('a'.repeat(1501)).reason, 'too_long');
  assert.equal(isLikelyAddressedElsewhere('<@123> 你覺得呢'), true);
  assert.equal(validateChatInput('<@123> 你覺得呢').reason, 'addressed_elsewhere');
});

test('conversation cooldown blocks repeated user triggers briefly', () => {
  clearConversationStateForTests();
  const message = createMessage();

  assert.equal(checkCooldown(message, 1000).ok, true);
  assert.equal(checkCooldown(message, 2000).ok, false);
  assert.equal(checkCooldown(message, 5000).ok, true);
});
