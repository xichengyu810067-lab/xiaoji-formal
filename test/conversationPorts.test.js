const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const environmentNames = ['XIAOJI_RUNTIME_MODE', 'XIAOJI_TEST_DATA_ROOT', 'XIAOJI_MEMORY_PATH', 'COIN_DB_PATH'];
const previousEnvironment = Object.fromEntries(environmentNames.map((name) => [name, process.env[name]]));
process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-conversation-ports-'));
process.env.XIAOJI_TEST_DATA_ROOT = dataRoot;
process.env.XIAOJI_MEMORY_PATH = path.join(dataRoot, 'memory.json');
process.env.COIN_DB_PATH = path.join(dataRoot, 'coin.sqlite');

const { createConversationPorts } = require('../src/coordinators/conversationCoordinator');
const { handleMentionMessage } = require('../src/systems/conversation/chatFlow');
const { clearConversationStateForTests } = require('../src/services/conversationModeService');

test.after(() => {
  for (const name of environmentNames) {
    if (previousEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = previousEnvironment[name];
  }
  fs.rmSync(dataRoot, { recursive: true, force: true });
});

test('conversation coordinator assembles weather and status ports', () => {
  const ports = createConversationPorts();

  assert.equal(Object.isFrozen(ports), true);
  assert.equal(typeof ports.weatherPort.getMentionReply, 'function');
  assert.equal(typeof ports.weatherPort.isQuery, 'function');
  assert.equal(typeof ports.statusPort.recordInteraction, 'function');
  assert.doesNotMatch(
    fs.readFileSync(path.join(__dirname, '..', 'src', 'systems', 'conversation', 'chatFlow.js'), 'utf8'),
    /coordinators[\\/]/
  );
});

test('chat flow uses injected weather and status ports without invoking the provider', async (t) => {
  clearConversationStateForTests();
  t.after(() => clearConversationStateForTests());

  const replies = [];
  let weatherCalls = 0;
  let statusCalls = 0;
  let providerCalls = 0;
  const result = await handleMentionMessage({
    id: 'conversation-port-message',
    content: '<@999999999999999999> 臺北市天氣',
    author: { id: 'conversation-port-user', username: '測試者', tag: '測試者', bot: false },
    client: { user: { id: '999999999999999999' } },
    guildId: null,
    channelId: 'conversation-port-dm',
    channel: {},
    createdTimestamp: Date.parse('2026-10-05T00:00:00.000Z'),
    async reply(payload) { replies.push(payload.content); },
  }, {
    generateChatReplyImpl: async () => {
      providerCalls += 1;
      return '不應呼叫一般聊天提供者。';
    },
    weatherPort: {
      isQuery: () => true,
      async getMentionReply(userText) {
        weatherCalls += 1;
        assert.equal(userText, '臺北市天氣');
        return '臺北市今天天氣：晴。';
      },
    },
    statusPort: {
      async recordInteraction() {
        statusCalls += 1;
      },
    },
  });

  assert.equal(result, undefined);
  assert.equal(weatherCalls, 1);
  assert.equal(statusCalls, 1);
  assert.equal(providerCalls, 0);
  assert.equal(replies.length, 1);
  assert.match(replies[0], /臺北市今天天氣：晴。/);
});
