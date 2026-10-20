const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-chat-egress-suite-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const { MENTION_OUTCOME, handleMentionMessage } = require('../src/systems/conversation/chatFlow');
const { EgressRateLimitError } = require('../src/platform/egressLimiter');
const { clearMemoryForTests, getPrivateMemoryContext } = require('../src/systems/conversation/projection');
const {
  getRecentConversationTurns,
  resetConversationHistoryForTests,
} = require('../src/services/conversationHistoryService');
const { clearConversationStateForTests } = require('../src/services/conversationModeService');
const { openArchive } = require('../src/systems/conversation/aiArchive');
const {
  ARCHIVE_POLICY_VERSION,
  closeArchiveForTests,
  configureArchivePathResolver,
  getArchive,
} = require('../src/services/aiArchiveService');

const BOT_ID = '999999999999999999';
const USER_ID = 'egress-flow-user';
const CHANNEL_ID = 'egress-flow-dm';

// A provider answer long enough to be sent as more than one Discord message.
const LONG_ANSWER = '這是一段很長的安全說明。'.repeat(400);

async function prepare(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-chat-egress-'));
  const archivePath = path.join(root, 'conversations.sqlite');
  openArchive({ filePath: archivePath, initialize: { initializationId: 'chat-egress-test' } }).close();
  const previous = {
    enabled: process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED,
    version: process.env.XIAOJI_ARCHIVE_POLICY_VERSION,
    history: process.env.AI_CONVERSATION_PATH,
    memory: process.env.XIAOJI_MEMORY_PATH,
  };
  process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED = 'true';
  process.env.XIAOJI_ARCHIVE_POLICY_VERSION = ARCHIVE_POLICY_VERSION;
  process.env.AI_CONVERSATION_PATH = path.join(root, 'history.json');
  process.env.XIAOJI_MEMORY_PATH = path.join(root, 'memory.json');
  configureArchivePathResolver(() => ({ filePath: archivePath }));
  closeArchiveForTests();
  clearConversationStateForTests();
  await resetConversationHistoryForTests();
  clearMemoryForTests();
  t.after(async () => {
    clearConversationStateForTests();
    await resetConversationHistoryForTests();
    closeArchiveForTests();
    for (const [name, value] of [
      ['XIAOJI_ARCHIVE_CAPTURE_ENABLED', previous.enabled],
      ['XIAOJI_ARCHIVE_POLICY_VERSION', previous.version],
      ['AI_CONVERSATION_PATH', previous.history],
      ['XIAOJI_MEMORY_PATH', previous.memory],
    ]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
}

function buildMessage({ failFirst = false, failFollowUp = false } = {}) {
  const sent = [];
  const limited = () => new EgressRateLimitError('rate_limited', { retryAfterMs: 5_000 });
  return {
    sent,
    message: {
      id: 'egress-flow-message',
      content: `<@${BOT_ID}> 請說明一件很長的事情`,
      author: { id: USER_ID, username: '甲', tag: '甲', bot: false },
      member: { displayName: '甲' },
      client: { user: { id: BOT_ID } },
      guildId: null,
      channelId: CHANNEL_ID,
      createdTimestamp: Date.parse('2026-09-30T00:00:00.000Z'),
      async reply(payload) {
        if (failFirst) throw limited();
        sent.push(payload.content);
      },
      channel: {
        async send(payload) {
          if (failFollowUp) throw limited();
          sent.push(payload.content);
        },
      },
    },
  };
}

async function runFlow({ failFirst = false, failFollowUp = false } = {}) {
  const { message, sent } = buildMessage({ failFirst, failFollowUp });
  let statusRecorded = 0;
  const result = await handleMentionMessage(message, {
    generateChatReplyImpl: async () => LONG_ANSWER,
    statusPort: { recordInteraction: async () => { statusRecorded += 1; } },
  });
  return { result, sent, statusRecorded };
}

function archiveState() {
  const filter = { userId: USER_ID, scope: 'dm', channelId: CHANNEL_ID };
  const archive = getArchive();
  const assistant = archive.listEvents(filter).rows.find((row) => row.role === 'assistant');
  return {
    assistantState: assistant ? assistant.delivery_state : null,
    summaries: archive.listEvents(filter, { kind: 'summary' }).rows.length,
  };
}

function persistedTurns() {
  return getRecentConversationTurns({ userId: USER_ID, guildId: null, channelId: CHANNEL_ID }).length;
}

test('control: a fully delivered multi-part reply is confirmed, remembered and counted', async (t) => {
  await prepare(t);
  const { result, sent, statusRecorded } = await runFlow();

  assert.ok(sent.length > 1, 'the answer must be sent in more than one part');
  assert.equal(result, undefined);
  assert.deepEqual(archiveState(), { assistantState: 'delivered', summaries: 1 });
  assert.equal(persistedTurns(), 1);
  assert.equal(statusRecorded, 1);
  assert.notEqual(getPrivateMemoryContext(USER_ID, { guildId: null, channelId: CHANNEL_ID }), '');
});

test('a first part blocked by the output rate limit is not confirmed, remembered or counted', async (t) => {
  await prepare(t);
  const { result, sent, statusRecorded } = await runFlow({ failFirst: true });

  assert.deepEqual(sent, []);
  const state = archiveState();
  assert.notEqual(state.assistantState, 'delivered');
  assert.notEqual(state.assistantState, 'partial', 'nothing was sent, so nothing was partly delivered');
  assert.equal(state.summaries, 0);
  assert.equal(persistedTurns(), 0);
  assert.equal(statusRecorded, 0);
  assert.equal(getPrivateMemoryContext(USER_ID, { guildId: null, channelId: CHANNEL_ID }), '');
  assert.deepEqual(result, { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
});

test('a later part blocked by the output rate limit is marked partial and never confirmed or remembered', async (t) => {
  await prepare(t);
  const { result, sent, statusRecorded } = await runFlow({ failFollowUp: true });

  assert.equal(sent.length, 1, 'only the first part went out');
  assert.deepEqual(archiveState(), { assistantState: 'partial', summaries: 0 });
  assert.equal(persistedTurns(), 0);
  assert.equal(statusRecorded, 0);
  assert.equal(getPrivateMemoryContext(USER_ID, { guildId: null, channelId: CHANNEL_ID }), '');
  assert.deepEqual(result, { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
});
