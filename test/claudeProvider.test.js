'use strict';

// The Claude provider (src/systems/conversation/provider.js): the request it sends (model, server-side fallback,
// effort, tools, no sampling parameters), how it reads the answer (text, a refusal, a paused web search, a reply
// that is only a tool call), the extra quota a web search takes, and that a rate limit is still a rate limit.
// Every call goes to a fake client; nothing reaches the network.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const retainedRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-claude-provider-')));
require('../src/platform/retainedDataSource').configureRetainedDataSourceRoot(retainedRoot);
test.after(() => fs.rmSync(retainedRoot, { recursive: true, force: true }));

const {
  ANTHROPIC_FALLBACK_BETA,
  DEFAULT_ANTHROPIC_MODEL,
  ProviderRateLimitError,
  completeWithProvider,
  developerInstructions,
  generateChatReply,
  getDeployedModelIds,
  getProtectedPromptTexts,
} = require('../src/systems/conversation/provider');
const { providerCallGuard } = require('../src/systems/conversation/providerGuard');
const { getGuildQuota, setGuildQuota } = require('../src/services/quotaService');

const GUILD = '111111111111111111';

function fakeClaude(responses) {
  const requests = [];
  return {
    requests,
    client: {
      beta: {
        messages: {
          create: async (request) => {
            requests.push(request);
            const next = responses.shift();
            if (next instanceof Error) throw next;
            return next;
          },
        },
      },
    },
  };
}

const text = (value, extra = {}) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: value }], usage: {}, ...extra });

function ask(client, overrides = {}) {
  providerCallGuard.resetForTests();
  return generateChatReply({
    userText: '推薦一部電影', displayName: '甲', userId: '222222222222222222', channelId: 'dm-channel', guildId: null,
    chatStyle: 'cute', romanceEnabled: false, ...overrides,
  }, { anthropicClient: client });
}

test('a Claude request pins the model, asks for the server-side fallback and low effort, and sends no sampling parameter', async () => {
  const fake = fakeClaude([text('推薦你看《神隱少女》！')]);
  assert.equal(await ask(fake.client), '推薦你看《神隱少女》！');
  const [request] = fake.requests;
  assert.equal(request.model, DEFAULT_ANTHROPIC_MODEL);
  assert.equal(request.model, 'claude-opus-5-5');
  assert.deepEqual(request.betas, [ANTHROPIC_FALLBACK_BETA]);
  assert.equal(request.fallbacks, 'default');
  assert.deepEqual(request.output_config, { effort: 'low' });
  for (const name of ['temperature', 'top_p', 'top_k', 'thinking']) assert.equal(name in request, false, name);
  assert.deepEqual(request.tools.map((tool) => tool.name), ['web_search', 'propose_poll']);
  assert.equal(request.tools[0].type, 'web_search_20260209');
  assert.equal(request.tools[0].max_uses, 3);
  assert.equal(request.tools[1].strict, true);
  assert.equal(request.tools[1].input_schema.additionalProperties, false);
  // The tool lines replace the "cannot search / use /poll" lines, and no memory line without memory.
  assert.match(request.system, /web_search/u);
  assert.match(request.system, /propose_poll/u);
  assert.doesNotMatch(request.system, /remember_preference/u);
  assert.doesNotMatch(request.system, /說明你無法即時上網/u);
});

test('the memory tool and its instruction are added only when memory is enabled, with the remembered preferences as data', async () => {
  const fake = fakeClaude([text('好呀')]);
  await ask(fake.client, { memoryEnabled: true, rememberedPreferences: [{ category: 'food', value: '喜歡拉麵' }] });
  const [request] = fake.requests;
  assert.deepEqual(request.tools.map((tool) => tool.name), ['web_search', 'propose_poll', 'remember_preference']);
  assert.match(request.system, /remember_preference/u);
  const input = JSON.parse(request.messages[0].content);
  assert.deepEqual(input.untrustedData.rememberedPreferences, [{ category: 'food', value: '喜歡拉麵' }]);
});

test('a reply that is only a tool call is asked for its text once, with the tool results, and returns the tool inputs', async () => {
  const fake = fakeClaude([
    {
      stop_reason: 'tool_use',
      content: [
        { type: 'thinking', thinking: '' },
        { type: 'tool_use', id: 'poll-1', name: 'propose_poll', input: { question: '午餐吃什麼', options: ['飯', '麵'], duration_minutes: 10 } },
        { type: 'tool_use', id: 'mem-1', name: 'remember_preference', input: { category: 'food', preference: '喜歡麵' } },
      ],
      usage: {},
    },
    text('小吉準備好投票了，請按確認！'),
  ]);
  const reply = await ask(fake.client, { memoryEnabled: true });
  assert.equal(fake.requests.length, 2);
  const second = fake.requests[1].messages;
  assert.equal(second.length, 3);
  assert.equal(second[1].role, 'assistant');
  // The assistant turn goes back unchanged, thinking block included.
  assert.equal(second[1].content[0].type, 'thinking');
  assert.deepEqual(second[2].content.map((block) => [block.type, block.tool_use_id]), [['tool_result', 'poll-1'], ['tool_result', 'mem-1']]);
  assert.deepEqual(reply, {
    text: '小吉準備好投票了，請按確認！',
    pollProposal: { question: '午餐吃什麼', options: ['飯', '麵'], duration_minutes: 10 },
    preferences: [{ category: 'food', preference: '喜歡麵' }],
  });
});

test('a paused web search is continued, a refusal returns nothing, and an empty reply returns nothing', async () => {
  const paused = fakeClaude([
    { stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } }], usage: {} },
    text('根據中央氣象署，明天會下雨。'),
  ]);
  assert.equal(await ask(paused.client), '根據中央氣象署，明天會下雨。');
  assert.equal(paused.requests[1].messages.at(-1).role, 'assistant');

  const refused = fakeClaude([{ stop_reason: 'refusal', content: [{ type: 'text', text: '部分內容' }], stop_details: { category: 'cyber' }, usage: {} }]);
  assert.equal(await ask(refused.client), null);

  const empty = fakeClaude([{ stop_reason: 'end_turn', content: [], usage: {} }]);
  assert.equal(await ask(empty.client), null);
});

test('each web search takes one more unit of the guild quota after the one the call took', async () => {
  setGuildQuota(GUILD, 10, 0);
  const fake = fakeClaude([text('查到了', { usage: { server_tool_use: { web_search_requests: 2 } } })]);
  const message = null;
  await ask(fake.client, { guildId: GUILD, channelId: 'channel-1', message });
  assert.equal(getGuildQuota(GUILD).used, 3);
});

test('a rate limit from Claude is the provider rate limit, as from the other providers', async () => {
  const limited = Object.assign(new Error('rate limited'), { status: 429 });
  const fake = fakeClaude([limited]);
  await assert.rejects(ask(fake.client), (error) => error instanceof ProviderRateLimitError);
  const fakeText = fakeClaude([Object.assign(new Error('rate limited'), { status: 429 })]);
  await assert.rejects(completeWithProvider({ system: 's', input: 'i' }, { anthropicClient: fakeText.client }),
    (error) => error instanceof ProviderRateLimitError);
});

test('completeWithProvider gives Claude no web search or poll tool, and the memory tool only when asked', async () => {
  const fake = fakeClaude([text('第一個問題？'), text('第二個問題？')]);
  assert.deepEqual(await completeWithProvider({ system: 's', input: 'i' }, { anthropicClient: fake.client }),
    { text: '第一個問題？', preferences: [] });
  await completeWithProvider({ system: 's', input: 'i', memoryEnabled: true }, { anthropicClient: fake.client });
  assert.equal('tools' in fake.requests[0], false);
  assert.deepEqual(fake.requests[1].tools.map((tool) => tool.name), ['remember_preference']);
});

test('the Claude model is a deployed model id, and both prompt variants are protected from being copied out', () => {
  assert.ok(getDeployedModelIds().includes('claude-opus-5-5'));
  const protectedTexts = getProtectedPromptTexts('cute', false);
  assert.ok(protectedTexts.some((value) => value.includes(developerInstructions)));
  assert.ok(protectedTexts.some((value) => value.includes('propose_poll') && value.includes('remember_preference')));
});

test('a reply that names a public command such as /memory is the command list, while any other name is still read as written', () => {
  const {
    INTERNAL_REPLY, decideAssistantOutput, decideRequestIngress, finalizePublicAssistantText, getConversationDecisionPayload,
  } = require('../src/systems/conversation/disclosurePolicy');
  const kind = (reply) => (finalizePublicAssistantText(reply) === INTERNAL_REPLY ? 'refusal' : getConversationDecisionPayload(
    decideAssistantOutput({ ingressDecision: decideRequestIngress({ userText: '你好' }), rawCandidate: reply, source: 'provider' })).kind);
  assert.equal(kind('我是小吉！輸入 /memory 指令可以查看小吉記住的喜好喔'), 'allowed');
  assert.equal(kind('我是小吉！輸入 /student 指令可以玩好奇寶寶喔'), 'allowed');
  // A name that only starts like a public command is not masked.
  assert.equal(kind('我是小吉！輸入 /memory-tools 指令可以做事喔'), 'refusal');
  assert.equal(kind('我的 memory 存在資料庫裡'), 'refusal');
});

test('a placeholder Claude key from the template is treated as no key', async () => {
  const previous = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = 'your_anthropic_api_key';
  try {
    const { getAnthropicClient } = require('../src/systems/conversation/provider');
    assert.equal(getAnthropicClient(), null);
  } finally {
    if (previous === undefined) delete process.env.ANTHROPIC_API_KEY; else process.env.ANTHROPIC_API_KEY = previous;
  }
});

test('preferences asked for in a reply that searched the web are dropped', async () => {
  const fake = fakeClaude([{
    stop_reason: 'end_turn',
    content: [
      { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'x' } },
      { type: 'text', text: '查到了！' },
      { type: 'tool_use', id: 'm1', name: 'remember_preference', input: { category: 'food', preference: '喜歡拉麵' } },
    ],
    usage: { server_tool_use: { web_search_requests: 1 } },
  }]);
  assert.equal(await ask(fake.client, { memoryEnabled: true }), '查到了！');
});
