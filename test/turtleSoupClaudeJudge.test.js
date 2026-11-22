'use strict';

// v1.3.4: the turtle soup judge needed a Groq or OpenAI key even where chat already ran on Claude, so a host with
// only ANTHROPIC_API_KEY started with judgeReadiness=JUDGE_NOT_CONFIGURED. The judge now uses Claude whenever an
// Anthropic key is set (as chat does) and falls back to Groq, then OpenAI. The verdict is held to the same fixed
// values by structured outputs and still parsed strictly; the provider guard, the anti-spam gate and the time limit
// still apply.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  DEFAULT_ANTHROPIC_MODEL,
  SYSTEM_INSTRUCTIONS,
  createAnthropicRequest,
  createJudgeProvider,
} = require('../src/systems/games/board/turtleSoup/providerAdapter');

const EVIDENCE = [{ id: 'f1', statement: '他是燈塔看守人。', source: 'solution', solution: true, extra: 'dropped' }];
const ASKER = { userId: '100000000000000101', guildId: '100000000000000201', channelId: '100000000000000301' };

const ENV_NAMES = ['ANTHROPIC_API_KEY', 'GROQ_API_KEY', 'OPENAI_API_KEY'];

// Saves the provider keys once and puts them back when the test ends; setEnv then replaces them.
function keepEnv(t) {
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}

function setEnv(values) {
  for (const name of ENV_NAMES) {
    if (values[name] === undefined) delete process.env[name];
    else process.env[name] = values[name];
  }
}

function recordingGuard() {
  const calls = [];
  return {
    calls,
    async execute(context, input, operation, options) {
      calls.push({ context, input, options });
      return operation(undefined);
    },
  };
}

function openGate() {
  const forgotten = [];
  return {
    forgotten,
    evaluate: () => ({ allowed: true, ticket: 'ticket-1' }),
    forgetRepeat: (ticket) => forgotten.push(ticket),
  };
}

function claudeClient(reply) {
  const requests = [];
  return {
    requests,
    beta: {
      messages: {
        async create(request) {
          requests.push(request);
          if (reply instanceof Error) throw reply;
          return reply;
        },
      },
    },
  };
}

function textReply(text, extra = {}) {
  return { stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '' }, { type: 'text', text }], ...extra };
}

test('an Anthropic key alone is enough for the judge; a Groq or OpenAI key passed in options still picks that provider', (t) => {
  keepEnv(t);
  setEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-only' });
  assert.equal(createJudgeProvider({ logger: null }).provider, 'anthropic');
  assert.equal(createJudgeProvider({ logger: null, groqApiKey: 'gsk-test-only' }).provider, 'groq');
  assert.equal(createJudgeProvider({ logger: null, openaiApiKey: 'sk-test-only' }).provider, 'openai');

  setEnv({ ANTHROPIC_API_KEY: 'sk-ant-test-only', GROQ_API_KEY: 'gsk-test-only' });
  assert.equal(createJudgeProvider({ logger: null }).provider, 'anthropic', 'Claude comes first, as in chat');

  setEnv({ ANTHROPIC_API_KEY: '   ', GROQ_API_KEY: 'gsk-test-only' });
  assert.equal(createJudgeProvider({ logger: null }).provider, 'groq', 'a blank Anthropic key is no key');

  setEnv({});
  assert.equal(createJudgeProvider({ logger: null, anthropicApiKey: 'sk-ant-test-only' }).provider, 'anthropic');
  assert.throws(() => createJudgeProvider({ logger: null }), (error) => error.code === 'JUDGE_NOT_CONFIGURED');
});

test('the Claude request carries the same instructions and evidence and holds the verdict to the fixed values', () => {
  const question = createAnthropicRequest({ kind: 'question', input: '他是被殺的嗎？', evidence: EVIDENCE });
  assert.equal(question.system, SYSTEM_INSTRUCTIONS);
  assert.equal(question.messages.length, 1);
  assert.equal(question.messages[0].role, 'user');
  assert.deepEqual(JSON.parse(question.messages[0].content), {
    task: 'question',
    untrustedPlayerInput: '他是被殺的嗎？',
    scenarioScopedEvidence: [{ id: 'f1', statement: '他是燈塔看守人。', source: 'solution', solution: true }],
  });
  assert.deepEqual(question.output_config, {
    effort: 'low',
    format: {
      type: 'json_schema',
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { verdict: { type: 'string', enum: ['是', '否', '無關', '無法判定'] } },
        required: ['verdict'],
      },
    },
  });
  assert.ok(!('temperature' in question), 'this model rejects sampling parameters');
  assert.ok(!('thinking' in question));
  assert.deepEqual(question.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(question.fallbacks, 'default');
  const guess = createAnthropicRequest({ kind: 'guess', input: '燈塔熄了', evidence: EVIDENCE });
  assert.deepEqual(guess.output_config.format.schema.properties.verdict.enum, ['答對', '未答對', '無法判定']);
});

test('a Claude verdict goes through the guard (with a longer cut-off) and the gate, and is parsed strictly', async () => {
  const guard = recordingGuard();
  const spamGuard = openGate();
  const client = claudeClient(textReply('{"verdict":"否"}'));
  const judge = createJudgeProvider({ client, provider: 'anthropic', guard, spamGuard, logger: null });
  assert.equal(judge.provider, 'anthropic');
  assert.deepEqual(await judge.judge({ kind: 'question', input: '他是被殺的嗎？', evidence: EVIDENCE, context: ASKER }), { verdict: '否' });
  assert.equal(client.requests[0].model, DEFAULT_ANTHROPIC_MODEL);
  assert.equal(DEFAULT_ANTHROPIC_MODEL, 'claude-opus-5-5');
  assert.equal(guard.calls.length, 1);
  assert.deepEqual(guard.calls[0].context, ASKER);
  assert.equal(guard.calls[0].input, 'turtle-soup:question:他是被殺的嗎？');
  assert.deepEqual(guard.calls[0].options, { emitSafetyEvents: false, quotaNamespace: guard.calls[0].options.quotaNamespace, timeoutMs: 30_000 });
});

test('a declined, malformed, off-schema or rate-limited Claude reply gives no verdict and lets the player ask again', async () => {
  const cases = [
    [{ stop_reason: 'refusal', content: [] }, 'JUDGE_UNAVAILABLE'],
    [textReply('{"verdict":"是"} 因為……'), 'JUDGE_INVALID_OUTPUT'],
    [textReply('{"verdict":"答對"}'), 'JUDGE_INVALID_OUTPUT'],
    [textReply('{"verdict":"是","why":"x"}'), 'JUDGE_INVALID_OUTPUT'],
    [{ stop_reason: 'end_turn', content: [] }, 'JUDGE_INVALID_OUTPUT'],
    [Object.assign(new Error('rate limited'), { status: 429 }), 'JUDGE_RATE_LIMITED'],
    [Object.assign(new Error('timed out'), { name: 'APIConnectionTimeoutError' }), 'JUDGE_TIMEOUT'],
  ];
  for (const [reply, code] of cases) {
    const spamGuard = openGate();
    const judge = createJudgeProvider({
      client: claudeClient(reply), provider: 'anthropic', guard: recordingGuard(), spamGuard, logger: null,
    });
    await assert.rejects(judge.judge({ kind: 'question', input: '是意外嗎？', evidence: EVIDENCE, context: ASKER }),
      (error) => error.code === code, code);
    assert.deepEqual(spamGuard.forgotten, ['ticket-1'], `${code}: asking again is not a repeat`);
  }
});

test('the anti-spam gate still holds a Claude judgment back before any model call', async () => {
  const client = claudeClient(textReply('{"verdict":"是"}'));
  const judge = createJudgeProvider({
    client, provider: 'anthropic', guard: recordingGuard(), logger: null,
    spamGuard: { evaluate: () => ({ allowed: false, reason: 'repeat' }) },
  });
  await assert.rejects(judge.judge({ kind: 'question', input: '是是是', evidence: EVIDENCE, context: ASKER }),
    (error) => error.code === 'JUDGE_SPAM_BLOCKED');
  assert.equal(client.requests.length, 0);
});
