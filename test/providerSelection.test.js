const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_OPENAI_MODEL,
  isProviderRateLimitResponse,
  selectOpenAICompatibleProvider,
} = require('../src/systems/conversation/providerSelection');

test('Groq wins when it has a key, then OpenAI, then nothing', () => {
  assert.deepEqual(selectOpenAICompatibleProvider({ env: { GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o' } }),
    { provider: 'groq', apiKey: 'g', baseURL: DEFAULT_GROQ_BASE_URL, model: DEFAULT_GROQ_MODEL });
  assert.deepEqual(selectOpenAICompatibleProvider({ env: { OPENAI_API_KEY: 'o' } }),
    { provider: 'openai', apiKey: 'o', model: DEFAULT_OPENAI_MODEL });
  assert.equal(selectOpenAICompatibleProvider({ env: {} }), null);
});

test('keys and models passed in replace the environment, and OPENAI_MODEL sits between them and the default', () => {
  const env = { GROQ_API_KEY: 'g', OPENAI_API_KEY: 'o', OPENAI_MODEL: 'env-model' };
  assert.equal(selectOpenAICompatibleProvider({ env, groqApiKey: '' }).model, 'env-model');
  assert.equal(selectOpenAICompatibleProvider({ env, groqApiKey: '', openaiModel: 'given' }).model, 'given');
  assert.equal(selectOpenAICompatibleProvider({ env, groqApiKey: '', openaiApiKey: '' }), null);
  assert.equal(selectOpenAICompatibleProvider({ env: {}, groqApiKey: 'G', groqModel: 'gm' }).model, 'gm');
});

test('a provider rate limit is a 429 or a rate-limit code or type anywhere in the error', () => {
  assert.equal(isProviderRateLimitResponse({ status: 429 }), true);
  assert.equal(isProviderRateLimitResponse({ response: { status: '429' } }), true);
  assert.equal(isProviderRateLimitResponse({ error: { type: 'insufficient_quota' } }), true);
  assert.equal(isProviderRateLimitResponse({ response: { data: { error: { code: ' Quota_Exceeded ' } } } }), true);
  assert.equal(isProviderRateLimitResponse({ status: 500, code: 'server_error' }), false);
  assert.equal(isProviderRateLimitResponse(null), false);
});
