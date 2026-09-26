const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-archive-mention-'));
process.env.COIN_DB_PATH = path.join(root, 'coins.sqlite');
process.env.AI_CONVERSATION_PATH = path.join(root, 'projection.json');
process.env.XIAOJI_MEMORY_PATH = path.join(root, 'memory.json');
process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED = 'true';
process.env.XIAOJI_ARCHIVE_POLICY_VERSION = '1.1.0';

const { ProviderRateLimitError, AI_PROVIDER_RATE_LIMIT_REPLY } = require('../src/services/aiService');
const { handleMentionMessage, isPublicPersistenceSuppressed } = require('../src/services/mentionService');
const { ARCHIVE_UNAVAILABLE_REPLY, configureArchivePathResolver,
  closeArchiveForTests, getArchive } = require('../src/services/aiArchiveService');
configureArchivePathResolver(() => ({ filePath: path.join(root, 'archive.sqlite'), source: 'explicit' }));
require('../src/systems/conversation/aiArchive').initializeArchive({
  filePath: path.join(root, 'archive.sqlite'), initializationId: 'fixture-mention',
}).close();

test.after(() => {
  closeArchiveForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

test('provider 429 keeps the fixed reply out of raw archive and prompt projection', async () => {
  const sent = [];
  const message = {
    id: 'message-rate-1', content: '<@bot-1> 測試限流', createdTimestamp: Date.parse('2026-09-26T00:00:00Z'),
    author: { id: 'user-rate-1', username: '虛構使用者', tag: 'fixture' },
    guildId: null, channelId: 'dm-rate-1',
    mentions: { has: () => true },
    client: { user: { id: 'bot-1' } },
    reply: async (payload) => { sent.push(payload.content); },
  };
  const result = await handleMentionMessage(message, {
    generateChatReplyImpl: async () => { throw new ProviderRateLimitError('fixture'); },
  });
  assert.equal(isPublicPersistenceSuppressed(result), true);
  assert.deepEqual(sent, [AI_PROVIDER_RATE_LIMIT_REPLY]);
  assert.equal(getArchive().listEvents({ userId: 'user-rate-1' }).rows.length, 0);
  assert.equal(fs.existsSync(process.env.AI_CONVERSATION_PATH), false);
});

test('failed Discord send leaves a generated reply pending and out of prompt memory', async () => {
  configureArchivePathResolver(() => ({ filePath: path.join(root, 'archive.sqlite'), source: 'explicit' }));
  const message = {
    id: 'message-send-fail', content: '<@bot-1> 測試送出失敗', createdTimestamp: Date.parse('2026-09-26T00:02:00Z'),
    author: { id: 'user-send-fail', username: '虛構使用者', tag: 'fixture' },
    guildId: null, channelId: 'dm-send-fail', mentions: { has: () => true },
    client: { user: { id: 'bot-1' } },
    reply: async () => { throw new Error('fixture send failure'); },
  };
  await assert.rejects(handleMentionMessage(message, {
    generateChatReplyImpl: async () => '不應視為已送達',
  }), /fixture send failure/);
  const rows = getArchive().listEvents({ userId: 'user-send-fail' }).rows;
  assert.equal(rows.find((row) => row.role === 'assistant').delivery_state, 'pending');
  assert.equal(getArchive().listEvents({ userId: 'user-send-fail' }, { kind: 'summary' }).rows.length, 0);
  assert.equal(fs.existsSync(process.env.AI_CONVERSATION_PATH), false);
});

test('partially sent Discord reply is marked partial and excluded from prompt memory', async () => {
  configureArchivePathResolver(() => ({ filePath: path.join(root, 'archive.sqlite'), source: 'explicit' }));
  const message = {
    id: 'message-partial', content: '<@bot-1> 測試部分送出', createdTimestamp: Date.parse('2026-09-26T00:03:00Z'),
    author: { id: 'user-partial', username: '虛構使用者', tag: 'fixture' },
    guildId: null, channelId: 'dm-partial', mentions: { has: () => true },
    client: { user: { id: 'bot-1' } },
    reply: async () => undefined,
    channel: { send: async () => { throw new Error('fixture second chunk failure'); } },
  };
  await assert.rejects(handleMentionMessage(message, {
    generateChatReplyImpl: async () => '長'.repeat(2200),
  }), /fixture second chunk failure/);
  const rows = getArchive().listEvents({ userId: 'user-partial' }).rows;
  assert.equal(rows.find((row) => row.role === 'assistant').delivery_state, 'partial');
  assert.equal(getArchive().listEvents({ userId: 'user-partial' }, { kind: 'summary' }).rows.length, 0);
  assert.equal(fs.existsSync(process.env.AI_CONVERSATION_PATH), false);
});

test('successful Discord send confirms delivery before adding prompt memory', async () => {
  configureArchivePathResolver(() => ({ filePath: path.join(root, 'archive.sqlite'), source: 'explicit' }));
  let sawPendingBeforeSend = false;
  const message = {
    id: 'message-success', content: '<@bot-1> 測試成功', createdTimestamp: Date.parse('2026-09-26T00:04:00Z'),
    author: { id: 'user-success', username: '虛構使用者', tag: 'fixture' },
    guildId: null, channelId: 'dm-success', mentions: { has: () => true },
    client: { user: { id: 'bot-1' } },
    reply: async () => {
      sawPendingBeforeSend = getArchive().listEvents({ userId: 'user-success' }).rows
        .some((row) => row.role === 'assistant' && row.delivery_state === 'pending');
      assert.equal(fs.existsSync(process.env.AI_CONVERSATION_PATH), false);
    },
  };
  await handleMentionMessage(message, { generateChatReplyImpl: async () => '已送達' });
  assert.equal(sawPendingBeforeSend, true);
  assert.equal(getArchive().listEvents({ userId: 'user-success' }).rows
    .find((row) => row.role === 'assistant').delivery_state, 'delivered');
  assert.equal(getArchive().listEvents({ userId: 'user-success' }, { kind: 'summary' }).rows.length, 1);
  assert.equal(fs.existsSync(process.env.AI_CONVERSATION_PATH), true);
});

test('archive preflight failure pauses AI before calling the provider', async () => {
  configureArchivePathResolver(() => { throw new Error('fixture archive unavailable'); });
  let providerCalled = false;
  const sent = [];
  const message = {
    id: 'message-fail-1', content: '<@bot-1> 測試保存', createdTimestamp: Date.parse('2026-09-26T00:01:00Z'),
    author: { id: 'user-fail-1', username: '虛構使用者', tag: 'fixture' },
    guildId: null, channelId: 'dm-fail-1', mentions: { has: () => true },
    client: { user: { id: 'bot-1' } }, reply: async (payload) => { sent.push(payload.content); },
  };
  const result = await handleMentionMessage(message, {
    generateChatReplyImpl: async () => { providerCalled = true; return '不應產生'; },
  });
  assert.equal(providerCalled, false);
  assert.equal(isPublicPersistenceSuppressed(result), true);
  assert.deepEqual(sent, [ARCHIVE_UNAVAILABLE_REPLY]);
});
