'use strict';

// Direct messages: the client receives them (src/index.js asks Discord for the DirectMessages intent and Channel
// partials, without which discord.js never emits messageCreate for a DM), and src/events/messageCreate.js hands them to
// the extensions only. Chat, /student, channel memory and the public projection stay server-only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { loadTestControlPolicy } = require('../src/platform/testControlPolicy');
const { IDS, createFixture } = require('./testControlSupport');

const SRC = path.join(__dirname, '..', 'src');

// Loads messageCreate with every server-only step replaced by a spy (it reads them when it is required).
function loadMessageCreate(t) {
  const calls = [];
  const replace = (relative, names) => {
    const file = require.resolve(path.join(SRC, relative));
    const real = require(file);
    const original = require.cache[file].exports;
    const spied = { ...real };
    for (const name of names) {
      spied[name] = async () => { calls.push(name); return name === 'routeMessageFeatures' ? { handled: false } : undefined; };
    }
    require.cache[file].exports = spied;
    t.after(() => { require.cache[file].exports = original; });
  };
  replace('systems/conversation/chatFlow.js', ['handleMentionMessage']);
  replace('systems/conversation/student.js', ['handleStudentMessage']);
  replace('systems/conversation/channelMemory.js', ['recordMemberMessage']);
  replace('systems/conversation/projection.js', ['recordPublicMessage']);
  replace('systems/community/messageFeatureRouter.js', ['routeMessageFeatures']);
  replace('services/publicStatusService.js', ['recordPublicInteraction']);
  const eventFile = require.resolve(path.join(SRC, 'events/messageCreate.js'));
  delete require.cache[eventFile];
  t.after(() => { delete require.cache[eventFile]; });
  return { messageCreate: require(eventFile), calls };
}

function message({ guildId, content, handled = false, hooks, authorId = '7200000000000000002', testControlPolicy }) {
  return {
    id: '7200000000000000001',
    content,
    author: { id: authorId, username: '甲', bot: false },
    client: {
      ...(testControlPolicy ? { testControlPolicy } : {}),
      user: { id: '7200000000000000003' },
      extensionHost: {
        async runHook(name, payload) {
          hooks.push({ name, guildId: payload.message.guildId, content: payload.message.content });
          return [{ result: { handled } }];
        },
      },
    },
    guildId,
    guild: guildId ? { id: guildId, name: '測試伺服器' } : null,
    channelId: '7200000000000000004',
    createdTimestamp: Date.now(),
    stickers: { size: 0 },
    attachments: { size: 0 },
    mentions: { has: () => false },
    channel: { send: async () => {}, messages: { async fetch() { return null; } } },
  };
}

test('a direct message reaches the extensions and nothing else, even when no extension handles it', async (t) => {
  const { messageCreate, calls } = loadMessageCreate(t);
  const hooks = [];
  await messageCreate.execute(message({ guildId: null, content: '小吉 你好', hooks }));
  assert.deepEqual(hooks, [{ name: 'messageCreate', guildId: null, content: '小吉 你好' }]);
  assert.deepEqual(calls, [], 'no chat, /student, feature routing, channel memory, projection or usage count for a direct message');
});

test('a stranger\'s direct message that calls 小吉, replies or asks to decrypt reaches no chat and is kept nowhere', async (t) => {
  const { messageCreate, calls } = loadMessageCreate(t);
  const hooks = [];
  for (const content of ['小吉 你好', '<@7200000000000000003> 在嗎', '解碼', '小吉請解密']) {
    await messageCreate.execute(message({ guildId: null, content, hooks, authorId: '7200000000000000009' }));
  }
  assert.equal(hooks.length, 4);
  assert.deepEqual(calls, []);
});

test('in test-control a direct message is denied before anything, even from the allowed actor with chat on', async (t) => {
  const fixture = createFixture({
    XIAOJI_TEST_ALLOWED_MESSAGE_FEATURES: 'conversation,mention', OPENAI_API_KEY: 'synthetic-test-provider',
  });
  t.after(() => fixture.cleanup());
  const policy = loadTestControlPolicy(fixture.env, { cwd: process.cwd() });
  const { messageCreate, calls } = loadMessageCreate(t);
  const hooks = [];
  await messageCreate.execute(message({ guildId: null, content: '解碼', hooks, authorId: IDS.actor, testControlPolicy: policy }));
  assert.deepEqual(hooks, [], 'not even the extensions see it');
  assert.deepEqual(calls, []);
  assert.equal(policy.reporter.count('TEST_MESSAGE_SCOPE_DENIED', 'message_ingress'), 1);
});

test('a direct message an extension handles stops there', async (t) => {
  const { messageCreate, calls } = loadMessageCreate(t);
  const hooks = [];
  await messageCreate.execute(message({ guildId: null, content: '解碼', handled: true, hooks }));
  assert.equal(hooks.length, 1);
  assert.deepEqual(calls, []);
});

test('a server message still goes on to chat and channel memory after the extensions', async (t) => {
  const { messageCreate, calls } = loadMessageCreate(t);
  const hooks = [];
  await messageCreate.execute(message({ guildId: '7200000000000000005', content: '大家好', hooks }));
  assert.equal(hooks.length, 1);
  assert.ok(calls.includes('handleMentionMessage'), calls.join(','));
  assert.ok(calls.includes('recordMemberMessage'), calls.join(','));
});

test('the client asks Discord for direct messages (intent and Channel partials)', () => {
  const source = fs.readFileSync(path.join(SRC, 'index.js'), 'utf8');
  const options = source.slice(source.indexOf('const client = new Client('), source.indexOf('client.testControlPolicy ='));
  assert.match(options, /GatewayIntentBits\.DirectMessages\b/u);
  assert.match(options, /Partials\.Channel\b/u);
});
