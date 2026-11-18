const OpenAI = require('openai');

// Choosing the OpenAI-compatible model provider (Groq, then OpenAI) from the environment, building its client, and
// recognising a provider rate limit. Chat (provider.js) and the turtle soup judge share this; Claude, which only chat
// uses, is chosen in provider.js before it gets here.

const DEFAULT_OPENAI_MODEL = 'gpt-4.1-mini';
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
// The Groq key is only ever sent here, never to a deployment-provided endpoint.
const DEFAULT_GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_PROVIDER_TIMEOUT_MS = 15000;

const PROVIDER_RATE_LIMIT_MARKERS = new Set([
  'rate_limit',
  'rate_limit_error',
  'rate_limit_exceeded',
  'model_rate_limit_exceeded',
  'insufficient_quota',
  'quota_exceeded',
]);

// The OpenAI model: OPENAI_MODEL when set, otherwise the default. (The Groq model is pinned and has no variable.)
function getConfiguredOpenAIModel(env = process.env) {
  return env.OPENAI_MODEL || DEFAULT_OPENAI_MODEL;
}

// Which OpenAI-compatible provider to call: Groq when it has a key, otherwise OpenAI when it has one, otherwise null.
// A key or model passed in replaces the environment's (a key passed as '' counts as set, and empty).
// Returns { provider, apiKey, model, baseURL? }.
function selectOpenAICompatibleProvider({ groqApiKey, openaiApiKey, groqModel, openaiModel, env = process.env } = {}) {
  const groqKey = groqApiKey ?? env.GROQ_API_KEY;
  if (groqKey) {
    return { provider: 'groq', apiKey: groqKey, baseURL: DEFAULT_GROQ_BASE_URL, model: groqModel || DEFAULT_GROQ_MODEL };
  }
  const openaiKey = openaiApiKey ?? env.OPENAI_API_KEY;
  if (openaiKey) {
    return { provider: 'openai', apiKey: openaiKey, model: openaiModel || getConfiguredOpenAIModel(env) };
  }
  return null;
}

// The SDK client for a selection: one retry, the given timeout, and Groq's base URL when the selection has one.
function createOpenAICompatibleClient({ apiKey, baseURL }, { timeoutMs = DEFAULT_PROVIDER_TIMEOUT_MS } = {}) {
  return new OpenAI(baseURL
    ? { apiKey, baseURL, maxRetries: 1, timeout: timeoutMs }
    : { apiKey, maxRetries: 1, timeout: timeoutMs });
}

function getProviderErrorValues(error) {
  const details = [
    error,
    error?.error,
    error?.rawError,
    error?.response?.data?.error,
  ];

  return details.flatMap((detail) => [detail?.code, detail?.type]);
}

// Whether the provider refused the call for a rate or quota limit: HTTP 429, or a rate-limit code or type in the error.
function isProviderRateLimitResponse(error) {
  const statuses = [error?.status, error?.statusCode, error?.response?.status]
    .map((value) => Number(value));

  if (statuses.includes(429)) {
    return true;
  }

  return getProviderErrorValues(error)
    .some((value) => PROVIDER_RATE_LIMIT_MARKERS.has(String(value || '').trim().toLowerCase()));
}

module.exports = {
  DEFAULT_GROQ_BASE_URL,
  DEFAULT_GROQ_MODEL,
  DEFAULT_OPENAI_MODEL,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  createOpenAICompatibleClient,
  getConfiguredOpenAIModel,
  isProviderRateLimitResponse,
  selectOpenAICompatibleProvider,
};
