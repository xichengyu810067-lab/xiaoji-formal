const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_MODEL,
  AI_PROVIDER_RATE_LIMIT_REPLY,
  OWNER_BACKGROUND,
  ProviderRateLimitError,
  buildOwnerContext,
  buildConversationInput,
  buildGroqCompletionRequest,
  buildStyledDeveloperInstructions,
  developerInstructions,
  finalizeAssistantReply,
  generateGroqReply,
  generateOpenAIReply,
  generateChatReply,
  getGroqBaseUrl,
  getGroqModel,
  getMemoryKey,
  normalizeAssistantIdentity,
} = require('../src/services/aiService');
const { getRecentConversationTurns, resetConversationHistoryForTests } = require('../src/services/conversationHistoryService');
const {
  CHAT_STYLES,
  CHAT_STYLE_NAMES,
  STYLE_SAFETY_BOUNDARY,
} = require('../src/services/chatStyleService');
const {
  ROMANCE_SAFETY_BOUNDARY,
  buildRomanceInstructions,
} = require('../src/services/romanceModeService');

test('AI short-term memory key is isolated by Discord user ID before username', () => {
  assert.equal(
    getMemoryKey({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1', username: 'same-name' }),
    'guild-1:channel-1:user-1'
  );
  assert.equal(
    getMemoryKey({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-2', username: 'same-name' }),
    'guild-1:channel-1:user-2'
  );
  assert.notEqual(
    getMemoryKey({ guildId: 'guild-1', channelId: 'channel-1', userId: 'user-1' }),
    getMemoryKey({ guildId: 'guild-1', channelId: 'channel-2', userId: 'user-1' })
  );
});

test('AI conversation input uses display name and never exposes the raw Discord user ID', () => {
  const userId = '123456789012345678';
  const input = buildConversationInput({
    userText: `你好，我的內部 ID 是 ${userId}`,
    displayName: '市長大人',
    username: 'account-name',
    userId,
    guildId: 'guild-1',
    channelId: 'channel-1',
    recentTurns: [{ user: `舊訊息 ${userId}`, assistant: '舊回覆' }],
    privateMemoryContext: `跨服記憶 ${userId}`,
  });

  assert.match(input, /Discord 顯示名稱：市長大人/);
  assert.doesNotMatch(input, /account-name/);
  assert.doesNotMatch(input, new RegExp(userId));
  assert.doesNotMatch(input, /Discord userId/i);
});

test('assistant identity normalization fixes only clear self-naming mistakes', () => {
  assert.equal(normalizeAssistantIdentity('你好，我是小雞，很高興認識你。'), '你好，我是小吉，很高興認識你。');
  assert.equal(normalizeAssistantIdentity('我叫做小雞。'), '我叫做小吉。');
  assert.equal(normalizeAssistantIdentity('我的名字是「小幾」。'), '我的名字是「小吉」。');
  assert.equal(
    normalizeAssistantIdentity('你好！小雞是一個 Discord 助手。'),
    '你好！小吉是一個 Discord 助手。'
  );
  assert.equal(normalizeAssistantIdentity('小機在這裡，可以幫你。'), '小吉在這裡，可以幫你。');
  assert.equal(normalizeAssistantIdentity('Hi, I am Xiaoji.'), 'Hi, I am 小吉.');
  assert.equal(normalizeAssistantIdentity("I'm Xiaochi, your assistant."), "I'm 小吉, your assistant.");
  assert.equal(normalizeAssistantIdentity('我喜歡吃小雞燉蘑菇。'), '我喜歡吃小雞燉蘑菇。');
  assert.equal(normalizeAssistantIdentity('今晚想煮小雞燉湯，也想買小雞造型玩偶。'), '今晚想煮小雞燉湯，也想買小雞造型玩偶。');
  assert.match(developerInstructions, /唯一名稱是「小吉」/);
  assert.match(developerInstructions, /絕對不可自稱小幾、小雞、小機/);
});

test('assistant reply finalization redacts Discord IDs and normalizes self-name together', () => {
  const userId = '123456789012345678';
  const result = finalizeAssistantReply(`我是小雞。你的 Discord ID 是 ${userId}。`, userId);

  assert.match(result, /我是小吉/);
  assert.doesNotMatch(result, new RegExp(userId));
  assert.match(result, /識別碼已隱藏/);
});

test('all six chat styles add bounded system instructions without weakening safety', () => {
  assert.deepEqual(CHAT_STYLE_NAMES, ['cute', 'mature_sister', 'ceo', 'cold', 'tsundere', 'yandere']);
  for (const style of CHAT_STYLE_NAMES) {
    const instructions = buildStyledDeveloperInstructions(style);
    assert.match(instructions, new RegExp(CHAT_STYLES[style].label));
    assert.match(instructions, /任何自我稱呼都只能使用「小吉」/);
    assert.match(instructions, /不得威脅、控制、跟蹤、隔離、情緒勒索/);
    assert.ok(instructions.endsWith(STYLE_SAFETY_BOUNDARY));
  }
  assert.match(buildStyledDeveloperInstructions('invalid-style'), /清純可愛妹妹風/);
});

test('romance prompt composes with all six styles only after explicit opt-in', () => {
  assert.equal(buildRomanceInstructions(false), '');
  for (const style of CHAT_STYLE_NAMES) {
    const normal = buildStyledDeveloperInstructions(style, false);
    const romantic = buildStyledDeveloperInstructions(style, true);
    assert.match(normal, new RegExp(CHAT_STYLES[style].label));
    assert.doesNotMatch(normal, /文字戀愛模式只是一種虛構/);
    assert.match(romantic, new RegExp(CHAT_STYLES[style].label));
    assert.match(romantic, /使用者明確開啟文字戀愛模式/);
    assert.match(romantic, /不得色情化或暗示未成年人/);
    assert.match(romantic, /不得鼓勵依賴小吉/);
    assert.ok(romantic.endsWith(ROMANCE_SAFETY_BOUNDARY));
  }
});

test('owner background is injected only for the trusted configured owner ID', () => {
  const previousOwnerId = process.env.BOT_OWNER_ID;
  const previousLegacyOwnerId = process.env.OWNER_ID;

  try {
    process.env.BOT_OWNER_ID = 'trusted-owner';
    process.env.OWNER_ID = 'legacy-owner';

    assert.equal(buildOwnerContext('trusted-owner'), OWNER_BACKGROUND);
    assert.match(buildOwnerContext('trusted-owner'), /小吉的開發者與擁有者/);
    assert.match(buildOwnerContext('trusted-owner'), /Godot 4\.7 Mayor Simulator/);
    assert.equal(buildOwnerContext('attacker-who-says-they-are-owner'), '');
    assert.equal(buildOwnerContext('legacy-owner'), '');
  } finally {
    if (previousOwnerId === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = previousOwnerId;
    if (previousLegacyOwnerId === undefined) delete process.env.OWNER_ID;
    else process.env.OWNER_ID = previousLegacyOwnerId;
  }
});

test('Groq uses the fixed GPT OSS 120B chat completions contract', () => {
  const previousModel = process.env.GROQ_MODEL;
  const previousBaseUrl = process.env.GROQ_BASE_URL;

  try {
    process.env.GROQ_MODEL = 'retired-deployment-override';
    process.env.GROQ_BASE_URL = 'https://untrusted.invalid/v1';

    const request = buildGroqCompletionRequest({
      userText: '你好',
      username: 'user',
      userId: 'user-1',
      guildId: 'guild-1',
      channelId: 'channel-1',
      recentTurns: [],
      chatStyle: 'cute',
      romanceEnabled: true,
    });

    assert.equal(DEFAULT_GROQ_MODEL, 'openai/gpt-oss-120b');
    assert.equal(getGroqModel(), DEFAULT_GROQ_MODEL);
    assert.equal(DEFAULT_GROQ_BASE_URL, 'https://api.groq.com/openai/v1');
    assert.equal(getGroqBaseUrl(), DEFAULT_GROQ_BASE_URL);
    assert.equal(request.model, DEFAULT_GROQ_MODEL);
    assert.equal(request.max_completion_tokens, 500);
    assert.equal(request.max_tokens, undefined);
    assert.equal(request.temperature, 0.8);
    assert.deepEqual(request.messages.map((message) => message.role), ['system', 'user']);
    assert.match(request.messages[0].content, /明確開啟文字戀愛模式/);
  } finally {
    if (previousModel === undefined) delete process.env.GROQ_MODEL;
    else process.env.GROQ_MODEL = previousModel;
    if (previousBaseUrl === undefined) delete process.env.GROQ_BASE_URL;
    else process.env.GROQ_BASE_URL = previousBaseUrl;
  }
});

test('Groq errors fail closed without logging API secrets', async () => {
  const previousKey = process.env.GROQ_API_KEY;
  const secret = 'synthetic-test-secret-should-never-leak';
  const warnings = [];

  try {
    process.env.GROQ_API_KEY = secret;
    const result = await generateGroqReply(
      {
        userText: '你好',
        username: 'user',
        userId: 'user-1',
        guildId: 'guild-1',
        channelId: 'channel-1',
        recentTurns: [],
      },
      {
        client: {
          chat: {
            completions: {
              create: async () => {
                throw new Error(`request failed with Bearer ${secret} and token=${secret}`);
              },
            },
          },
        },
        loggerImpl: { warn: (message) => warnings.push(message) },
      }
    );

    assert.equal(result, null);
    assert.equal(warnings.length, 1);
    assert.doesNotMatch(warnings[0], new RegExp(secret));
    assert.match(warnings[0], /\[REDACTED\]/);
    assert.match(warnings[0], /using keyword fallback/);
  } finally {
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  }
});

test('Groq and OpenAI expose only explicit provider rate-limit responses as an internal error', async () => {
  const cases = [
    {
      name: 'Groq HTTP 429',
      generate: generateGroqReply,
      client: { chat: { completions: { create: async () => { throw Object.assign(new Error('busy'), { status: 429 }); } } } },
    },
    {
      name: 'Groq structured rate-limit code',
      generate: generateGroqReply,
      client: { chat: { completions: { create: async () => { throw { code: 'rate_limit_exceeded' }; } } } },
    },
    {
      name: 'OpenAI structured quota type',
      generate: generateOpenAIReply,
      client: { responses: { create: async () => { throw { type: 'insufficient_quota' }; } } },
    },
  ];

  for (const entry of cases) {
    await assert.rejects(
      entry.generate({ userText: '你好', userId: 'user-1', recentTurns: [] }, { client: entry.client, loggerImpl: { warn() {} } }),
      (error) => error instanceof ProviderRateLimitError && error.code === 'AI_PROVIDER_RATE_LIMIT',
      entry.name
    );
  }
});

test('provider authentication and server errors still use the normal null fallback contract', async () => {
  const errors = [
    Object.assign(new Error('unauthorized'), { status: 401 }),
    Object.assign(new Error('upstream unavailable'), { status: 503 }),
  ];
  const warnings = [];

  for (const error of errors) {
    const result = await generateOpenAIReply(
      { userText: '你好', userId: 'user-1', recentTurns: [] },
      { client: { responses: { create: async () => { throw error; } } }, loggerImpl: { warn: (message) => warnings.push(message) } }
    );
    assert.equal(result, null);
  }

  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((message) => message.includes('using keyword fallback')));
});

test('provider rate limits do not write a recent conversation turn', async () => {
  const previousGroqKey = process.env.GROQ_API_KEY;
  const previousHistoryPath = process.env.AI_CONVERSATION_PATH;
  const historyPath = path.join(__dirname, '.tmp-ai-rate-limit-history.json');
  const identity = { guildId: 'guild-rate', channelId: 'channel-rate', userId: 'user-rate' };

  try {
    process.env.GROQ_API_KEY = 'synthetic-groq-key';
    process.env.AI_CONVERSATION_PATH = historyPath;
    fs.rmSync(historyPath, { force: true });
    await resetConversationHistoryForTests();

    await assert.rejects(
      generateChatReply(
        { userText: '你好', displayName: '測試者', ...identity },
        { groqClient: { chat: { completions: { create: async () => { throw { type: 'rate_limit_error' }; } } } }, loggerImpl: { warn() {} } }
      ),
      ProviderRateLimitError
    );

    assert.deepEqual(getRecentConversationTurns(identity), []);
    assert.equal(fs.existsSync(historyPath), false);
  } finally {
    await resetConversationHistoryForTests();
    fs.rmSync(historyPath, { force: true });
    if (previousGroqKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroqKey;
    if (previousHistoryPath === undefined) delete process.env.AI_CONVERSATION_PATH;
    else process.env.AI_CONVERSATION_PATH = previousHistoryPath;
  }
});

test('the rate-limit reply is an exact fixed message independent of conversational settings', () => {
  assert.equal(AI_PROVIDER_RATE_LIMIT_REPLY, '小吉有點累了，請稍後再跟我聊天');
});

test('Groq normalizes a provider self-name mistake without changing food references', async () => {
  const userId = '123456789012345678';
  const result = await generateGroqReply(
    {
      userText: '介紹你自己，也聊聊料理',
      displayName: '測試者',
      userId,
      recentTurns: [],
    },
    {
      client: {
        chat: {
          completions: {
            create: async () => ({
              choices: [{ message: { content: `我是小幾。你的 Discord ID 是 ${userId}。我也知道小雞燉蘑菇這道料理。` } }],
            }),
          },
        },
      },
    }
  );

  assert.match(result, /^我是小吉。/);
  assert.doesNotMatch(result, new RegExp(userId));
  assert.match(result, /小雞燉蘑菇/);
});

test('OpenAI uses the same bounded identity and Discord ID finalizer as Groq', async () => {
  const userId = '987654321098765432';
  let request;
  const result = await generateOpenAIReply(
    {
      userText: '介紹你自己',
      displayName: '測試者',
      userId,
      recentTurns: [],
      chatStyle: 'yandere',
      romanceEnabled: true,
    },
    {
      client: {
        responses: {
          create: async (value) => {
            request = value;
            return { output_text: `Hi, I am Xiaoji. Your Discord ID is ${userId}.` };
          },
        },
      },
    }
  );

  assert.match(result, /I am 小吉/);
  assert.doesNotMatch(result, new RegExp(userId));
  assert.match(result, /識別碼已隱藏/);
  assert.match(request.instructions, /病嬌風/);
  assert.match(request.instructions, /禁止佔有威脅、傷害、跟蹤、孤立或情緒勒索/);
  assert.match(request.instructions, /不得色情化或暗示未成年人/);
});

test('retired Groq model identifier is absent from tracked release sources', () => {
  const root = path.resolve(__dirname, '..');
  const retiredIdentifier = ['llama-3.3', '70b-versatile'].join('-');
  const trackedTextFiles = [
    '.env.example',
    'README.md',
    'src/services/aiService.js',
    'scripts/check-project.js',
  ];

  for (const relativePath of trackedTextFiles) {
    assert.doesNotMatch(fs.readFileSync(path.join(root, relativePath), 'utf8'), new RegExp(retiredIdentifier));
  }
});
