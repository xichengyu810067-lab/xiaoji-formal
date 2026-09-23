const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-ai-history-test-'));
process.env.AI_CONVERSATION_PATH = path.join(testRoot, 'history.json');
process.env.AI_MEMORY_MAX_TURNS = '2';
process.env.AI_MEMORY_MAX_CONVERSATIONS = '3';
process.env.AI_MEMORY_RETENTION_DAYS = '7';

const {
  DEFAULT_RETENTION_CLEANUP_INTERVAL_MS,
  clearConversationHistory,
  clearExpiredConversationHistory,
  getConversationHistoryStatus,
  getRecentConversationTurns,
  rememberConversationTurn,
  resetConversationHistoryForTests,
  startConversationHistoryCleanupScheduler,
  stopConversationHistoryCleanupScheduler,
} = require('../src/services/conversationHistoryService');

const identity = { guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' };

test.beforeEach(async () => {
  fs.rmSync(process.env.AI_CONVERSATION_PATH, { force: true });
  await resetConversationHistoryForTests();
});

test.after(async () => {
  await resetConversationHistoryForTests();
  fs.rmSync(testRoot, { recursive: true, force: true });
  delete process.env.AI_CONVERSATION_PATH;
  delete process.env.AI_MEMORY_MAX_TURNS;
  delete process.env.AI_MEMORY_MAX_CONVERSATIONS;
  delete process.env.AI_MEMORY_RETENTION_DAYS;
});

test('recent conversation survives cache reset and keeps only configured turns', async () => {
  await rememberConversationTurn(identity, 'one', 'reply one');
  await rememberConversationTurn(identity, 'two', 'reply two');
  await rememberConversationTurn(identity, 'three', 'reply three');
  await resetConversationHistoryForTests();

  assert.deepEqual(getRecentConversationTurns(identity), [
    { user: 'two', assistant: 'reply two' },
    { user: 'three', assistant: 'reply three' },
  ]);
});

test('history is isolated by guild, channel, and user', async () => {
  await rememberConversationTurn(identity, 'secret one', 'private reply');

  assert.equal(getRecentConversationTurns({ ...identity, userId: 'user-2' }).length, 0);
  assert.equal(getRecentConversationTurns({ ...identity, channelId: 'channel-2' }).length, 0);
  assert.equal(getRecentConversationTurns({ ...identity, guildId: 'guild-2' }).length, 0);
  assert.equal(getRecentConversationTurns(identity)[0].user, 'secret one');
});

test('serialized concurrent writes do not lose turns', async () => {
  await Promise.all([
    rememberConversationTurn(identity, 'first', 'a'),
    rememberConversationTurn(identity, 'second', 'b'),
  ]);
  assert.deepEqual(getRecentConversationTurns(identity).map((turn) => turn.user), ['first', 'second']);
});

test('conversation count and total serialized size are bounded', async () => {
  process.env.AI_MEMORY_MAX_CONVERSATIONS = '10';
  process.env.AI_MEMORY_MAX_BYTES = '1024';
  process.env.AI_MEMORY_MAX_TEXT_LENGTH = '400';
  const baseTime = Date.now();

  try {
    for (let index = 0; index < 6; index += 1) {
      await rememberConversationTurn(
        { guildId: 'guild-1', channelId: 'channel-1', userId: `user-${index}` },
        `${index}-${'x'.repeat(390)}`,
        `${index}-${'y'.repeat(390)}`,
        new Date(baseTime + index)
      );
    }

    const stats = fs.statSync(process.env.AI_CONVERSATION_PATH);
    assert.ok(stats.size <= 1024);
    assert.ok(getConversationHistoryStatus().conversationCount < 6);
    assert.equal(getRecentConversationTurns({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-0' }).length, 0);
  } finally {
    delete process.env.AI_MEMORY_MAX_BYTES;
    delete process.env.AI_MEMORY_MAX_TEXT_LENGTH;
    process.env.AI_MEMORY_MAX_CONVERSATIONS = '3';
  }
});

test('oldest conversation is evicted at the configured conversation limit', async () => {
  const baseTime = Date.now();
  for (let index = 0; index < 4; index += 1) {
    await rememberConversationTurn(
      { guildId: 'guild-1', channelId: 'channel-1', userId: `bounded-${index}` },
      `message ${index}`,
      `reply ${index}`,
      new Date(baseTime + index)
    );
  }

  assert.equal(getConversationHistoryStatus().conversationCount, 3);
  assert.equal(getRecentConversationTurns({ guildId: 'guild-1', channelId: 'channel-1', userId: 'bounded-0' }).length, 0);
  assert.equal(getRecentConversationTurns({ guildId: 'guild-1', channelId: 'channel-1', userId: 'bounded-3' }).length, 1);
});

test('corrupt history is preserved and persistence fails safe', async () => {
  fs.writeFileSync(process.env.AI_CONVERSATION_PATH, '{broken', 'utf8');
  await resetConversationHistoryForTests();

  assert.deepEqual(getRecentConversationTurns(identity), []);
  const result = await rememberConversationTurn(identity, 'must not overwrite', 'reply');
  assert.equal(result.persisted, false);
  assert.equal(fs.readFileSync(process.env.AI_CONVERSATION_PATH, 'utf8'), '{broken');
  assert.equal(getConversationHistoryStatus().error, 'corrupt');
});

test('clear APIs remove one conversation and expired conversations', async () => {
  await rememberConversationTurn(identity, 'current', 'reply');
  await clearConversationHistory(identity);
  assert.equal(getRecentConversationTurns(identity).length, 0);

  const old = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
  await rememberConversationTurn(identity, 'old', 'reply', old);
  await clearExpiredConversationHistory();
  assert.equal(getRecentConversationTurns(identity).length, 0);
});

test('startup retention cleanup persists expired removal without a later AI reply', async () => {
  const now = Date.now();
  const expiredAt = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
  const currentAt = new Date(now).toISOString();
  const expiredKey = 'guild-1:channel-1:expired-user';
  const currentKey = 'guild-1:channel-1:current-user';
  fs.writeFileSync(
    process.env.AI_CONVERSATION_PATH,
    `${JSON.stringify(
      {
        version: 1,
        conversations: {
          [expiredKey]: {
            guildId: 'guild-1',
            channelId: 'channel-1',
            userId: 'expired-user',
            updatedAt: expiredAt,
            turns: [{ user: 'old', assistant: 'old reply', createdAt: expiredAt }],
          },
          [currentKey]: {
            guildId: 'guild-1',
            channelId: 'channel-1',
            userId: 'current-user',
            updatedAt: currentAt,
            turns: [{ user: 'current', assistant: 'current reply', createdAt: currentAt }],
          },
        },
      },
      null,
      2
    )}\n`,
    'utf8'
  );
  await resetConversationHistoryForTests();

  const result = await clearExpiredConversationHistory(now);
  assert.equal(result.persisted, true);
  const persisted = JSON.parse(fs.readFileSync(process.env.AI_CONVERSATION_PATH, 'utf8'));
  assert.equal(persisted.conversations[expiredKey], undefined);
  assert.equal(persisted.conversations[currentKey].turns.length, 1);

  await resetConversationHistoryForTests();
  assert.equal(
    getRecentConversationTurns({ guildId: 'guild-1', channelId: 'channel-1', userId: 'expired-user' }).length,
    0
  );
});

test('startup retention cleanup preserves a corrupt history file', async () => {
  fs.writeFileSync(process.env.AI_CONVERSATION_PATH, '{broken', 'utf8');
  await resetConversationHistoryForTests();

  const result = await clearExpiredConversationHistory();
  assert.equal(result.persisted, false);
  assert.equal(result.reason, 'corrupt');
  assert.equal(fs.readFileSync(process.env.AI_CONVERSATION_PATH, 'utf8'), '{broken');
});

test('retention scheduler is low-frequency, unrefed, idempotent, and stoppable', () => {
  let scheduledCallback;
  let scheduledInterval;
  let setCalls = 0;
  let unrefCalls = 0;
  let clearCalls = 0;
  const fakeTimer = {
    unref: () => {
      unrefCalls += 1;
    },
  };
  const options = {
    setIntervalFn: (callback, intervalMs) => {
      setCalls += 1;
      scheduledCallback = callback;
      scheduledInterval = intervalMs;
      return fakeTimer;
    },
    clearIntervalFn: (timer) => {
      assert.equal(timer, fakeTimer);
      clearCalls += 1;
    },
  };

  const first = startConversationHistoryCleanupScheduler(options);
  const duplicate = startConversationHistoryCleanupScheduler(options);
  assert.equal(first, fakeTimer);
  assert.equal(duplicate, fakeTimer);
  assert.equal(typeof scheduledCallback, 'function');
  assert.equal(scheduledInterval, DEFAULT_RETENTION_CLEANUP_INTERVAL_MS);
  assert.equal(setCalls, 1);
  assert.equal(unrefCalls, 1);
  assert.equal(stopConversationHistoryCleanupScheduler(), true);
  assert.equal(clearCalls, 1);
  assert.equal(stopConversationHistoryCleanupScheduler(), false);
});

test('scheduled retention tick persists cleanup and preserves corrupt storage', async () => {
  const now = Date.now();
  const expiredAt = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
  const expiredKey = 'guild-1:channel-1:expired-user';
  fs.writeFileSync(
    process.env.AI_CONVERSATION_PATH,
    `${JSON.stringify({
      version: 1,
      conversations: {
        [expiredKey]: {
          guildId: 'guild-1',
          channelId: 'channel-1',
          userId: 'expired-user',
          updatedAt: expiredAt,
          turns: [{ user: 'old', assistant: 'old reply', createdAt: expiredAt }],
        },
      },
    })}\n`,
    'utf8'
  );
  await resetConversationHistoryForTests();

  let scheduledCallback;
  startConversationHistoryCleanupScheduler({
    setIntervalFn: (callback) => {
      scheduledCallback = callback;
      return { unref: () => undefined };
    },
    clearIntervalFn: () => undefined,
  });
  const cleanupResult = await scheduledCallback();
  assert.equal(cleanupResult.persisted, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(process.env.AI_CONVERSATION_PATH, 'utf8')).conversations, {});

  stopConversationHistoryCleanupScheduler();
  fs.writeFileSync(process.env.AI_CONVERSATION_PATH, '{broken', 'utf8');
  await resetConversationHistoryForTests();
  startConversationHistoryCleanupScheduler({
    setIntervalFn: (callback) => {
      scheduledCallback = callback;
      return { unref: () => undefined };
    },
    clearIntervalFn: () => undefined,
  });
  const corruptResult = await scheduledCallback();
  assert.equal(corruptResult.persisted, false);
  assert.equal(corruptResult.reason, 'corrupt');
  assert.equal(fs.readFileSync(process.env.AI_CONVERSATION_PATH, 'utf8'), '{broken');
});
