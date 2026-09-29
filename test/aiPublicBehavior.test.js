const test = require('node:test');
const assert = require('node:assert/strict');
const { AI_PROVIDER_RATE_LIMIT_REPLY, finalizeAssistantReply, getMemoryKey } = require('../src/services/aiService');

test('chat memory separates people and channels', () => {
  const first = getMemoryKey({ guildId: 'guild-a', channelId: 'room-a', userId: 'person-a' });
  assert.notEqual(first, getMemoryKey({ guildId: 'guild-a', channelId: 'room-a', userId: 'person-b' }));
  assert.notEqual(first, getMemoryKey({ guildId: 'guild-a', channelId: 'room-b', userId: 'person-a' }));
});

test('public chat reply hides a person identifier and keeps the assistant name', () => {
  const userId = '123456789012345678';
  const reply = finalizeAssistantReply(`我是小雞。你的編號是 ${userId}。`, userId);
  assert.match(reply, /我是小吉/);
  assert.doesNotMatch(reply, new RegExp(userId));
});

test('temporary chat limit has one fixed public reply', () => {
  assert.equal(AI_PROVIDER_RATE_LIMIT_REPLY, '小吉有點累了，請稍後再跟我聊天');
});
