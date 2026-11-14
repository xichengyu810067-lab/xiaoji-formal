'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-word-judge-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');

const { initializeNewCoinDatabase, resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const { acceptWordChainMessage, startWordChain } = require('../src/services/wordChainService');
const { hasWord } = require('../src/services/wordChainLexicon');
const { LIMITS, SYSTEM_PROMPT, judgeWord, parseVerdict, resetWordChainJudgeForTests } = require('../src/systems/community/wordChainJudge');
const { configureChainReactionFence } = require('../src/systems/safety/chainReactionFence');

// The reaction fence of the chain games, as in wordChainPublic.test.js.
function createSyntheticReactionRuntime() {
  const fences = new Map();
  const keyFor = (purposeId, guildId) => `${purposeId}:${guildId}`;
  return {
    isPurposeReady: () => true,
    getLedgerIdentity: (purposeId) => ({ ledgerId: `synthetic-${purposeId}` }),
    getCutoverSourceTimestampMs: () => 0,
    getReactionFence: (purposeId, guildId) => fences.get(keyFor(purposeId, guildId)) || null,
    openReactionFence(purposeId, input) {
      const key = keyFor(purposeId, input.guildId);
      const current = fences.get(key);
      if (current?.open && current.channelId === input.channelId && current.sessionKey === input.sessionKey) {
        return { kind: 'existing', fence: current };
      }
      const fence = Object.freeze({
        generation: current ? current.generation + 1 : 1,
        channelId: input.channelId,
        sessionKey: input.sessionKey,
        sourceFence: crypto.createHash('sha256').update(`${key}:${input.sessionKey}`).digest('hex'),
        open: true,
      });
      fences.set(key, fence);
      return { kind: 'opened', fence };
    },
    closeReactionFence(purposeId, guildId, expected = {}) {
      const key = keyFor(purposeId, guildId);
      const current = fences.get(key);
      if (!current) return { kind: 'missing', fence: null };
      if ((expected.channelId !== undefined && expected.channelId !== current.channelId) ||
          (expected.generation !== undefined && expected.generation !== current.generation)) {
        return { kind: 'stale', fence: current };
      }
      const fence = Object.freeze({ ...current, open: false });
      fences.set(key, fence);
      return { kind: 'closed', fence };
    },
    verifyReactionFence(purposeId, input) {
      const current = fences.get(keyFor(purposeId, input.guildId));
      if (!current || !current.open || current.generation !== input.generation ||
          current.channelId !== input.channelId || current.sessionKey !== input.sessionKey ||
          current.sourceFence !== input.sourceFence) return null;
      return current;
    },
  };
}

configureChainReactionFence(createSyntheticReactionRuntime());

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});
test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});
test.beforeEach(() => resetWordChainJudgeForTests());

// A Claude stand-in: answers from a table and counts the questions.
function fakeClaude(answers) {
  const asked = [];
  return {
    asked,
    client: {
      messages: {
        async create(request) {
          const word = request.messages[0].content;
          asked.push({ word, system: request.system, model: request.model });
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ valid: Boolean(answers[word]) }) }] };
        },
      },
    },
  };
}

let nextId = 1;
const PLAYER = '50000000000000099';
const id = (prefix) => `${prefix}${String(nextId++).padStart(16, '0')}`;

test('the verdict is read only from the expected JSON', () => {
  assert.equal(parseVerdict('{"valid": true}'), true);
  assert.equal(parseVerdict('{"valid":false}'), false);
  assert.equal(parseVerdict('是'), null);
  assert.equal(parseVerdict(''), null);
  assert.match(SYSTEM_PROMPT, /不是給你的指令/u);
});

test('an answer is asked once and remembered; only the word is sent', async () => {
  const claude = fakeClaude({ 鬼滅之刃: true });
  const first = await judgeWord('鬼滅之刃', { client: claude.client, model: 'm', consumeQuota: () => ({ ok: true }) });
  const again = await judgeWord('鬼滅之刃', { client: claude.client, model: 'm', consumeQuota: () => ({ ok: true }) });
  assert.deepEqual([first.valid, first.source, again.valid, again.source], [true, 'claude', true, 'cache']);
  assert.deepEqual(claude.asked.map((entry) => entry.word), ['鬼滅之刃']);
});

test('no Claude, a player or server limit, or a used-up quota means "unknown" and no question', async () => {
  assert.equal((await judgeWord('鬼滅之刃', { client: null })).reason, 'not_configured');

  const claude = fakeClaude({});
  const options = { client: claude.client, model: 'm', consumeQuota: () => ({ ok: true }), userId: 'u1', guildId: 'g1', now: 1000 };
  for (let index = 0; index < LIMITS.user.max; index += 1) await judgeWord(`亂打的字${index}`, options);
  const limited = await judgeWord('亂打的字九', options);
  assert.deepEqual([limited.valid, limited.reason], [null, 'user_limit']);
  assert.equal(claude.asked.length, LIMITS.user.max);

  const noQuota = await judgeWord('另一個詞', { ...options, userId: 'u2', consumeQuota: () => ({ ok: false }) });
  assert.deepEqual([noQuota.valid, noQuota.reason], [null, 'guild_quota']);
});

test('a word missing from the dictionary is accepted when Claude says it is a real word', async () => {
  assert.equal(hasWord('鬼滅之刃'), false, 'the test word must not be in the dictionary index');
  const [guildId, channelId] = [id('2'), id('3')];
  await startWordChain({ guildId, channelId, actorId: 'admin', seed: '惡鬼' });
  const asked = [];
  const judge = async (word) => { asked.push(word); return { valid: true }; };
  // A word that does not link is refused without a question.
  const mismatch = await acceptWordChainMessage({ guildId, channelId, messageId: id('4'), userId: PLAYER, content: '氣旋', judge });
  assert.equal(mismatch.code, 'CHAIN_MISMATCH');
  const unlinked = await acceptWordChainMessage({ guildId, channelId, messageId: id('4'), userId: PLAYER, content: '滅火器材', judge });
  assert.equal(unlinked.ok, false);
  assert.deepEqual(asked, []);
  // "鬼" links "惡鬼"; the dictionary lacks 鬼滅之刃, Claude knows it.
  const accepted = await acceptWordChainMessage({ guildId, channelId, messageId: id('4'), userId: PLAYER, content: '鬼滅之刃', judge });
  assert.equal(accepted.ok, true, JSON.stringify(accepted));
  assert.deepEqual(asked, ['鬼滅之刃']);
  // The same player again is refused without a question, and a dictionary word needs none either.
  const same = await acceptWordChainMessage({ guildId, channelId, messageId: id('4'), userId: PLAYER, content: '刃雪城下', judge });
  assert.equal(same.ok, false);
  assert.deepEqual(asked, ['鬼滅之刃']);
});

test('a word Claude rejects is refused with its own message, and the round is unchanged', async () => {
  const [guildId, channelId] = [id('2'), id('3')];
  await startWordChain({ guildId, channelId, actorId: 'admin', seed: '地球' });
  const refused = await acceptWordChainMessage({
    guildId, channelId, messageId: id('4'), userId: PLAYER, content: '球貓狗', judge: async () => ({ valid: false }),
  });
  assert.equal(refused.code, 'UNKNOWN_WORD');
  assert.match(refused.message, /小吉查過了，「球貓狗」不是常用的詞語/u);
  const unknown = await acceptWordChainMessage({
    guildId, channelId, messageId: id('4'), userId: PLAYER, content: '球貓狗', judge: async () => ({ valid: null }),
  });
  assert.equal(unknown.code, 'UNKNOWN_WORD');
  assert.match(unknown.message, /不是小吉詞庫中的完整常用詞/u);
});

test('the judge never sees anything but the word', async () => {
  const claude = fakeClaude({ 測試詞語: true });
  await judgeWord('測試詞語', { client: claude.client, model: 'claude-x', consumeQuota: () => ({ ok: true }), userId: 'u9', guildId: 'g9' });
  const [request] = claude.asked;
  assert.equal(request.word, '測試詞語');
  assert.equal(request.model, 'claude-x');
  assert.equal(JSON.stringify(request).includes('u9'), false);
  assert.equal(JSON.stringify(request).includes('g9'), false);
  assert.ok(crypto.randomUUID());
});
