'use strict';

// The two soft output rules and their waiver (disclosurePolicy.js: SOFT_OUTPUT_RULES, waiveSoft, classifyOutputBlock),
// and ordinary replies that the soft rules refuse today and the optional second opinion can win back. The sentences
// are written for these tests: they hold no real configuration, name or internal detail.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-jev-soft-suite-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const {
  BOT_REFERENCE_WITHOUT_BARE_BOT,
  GENERIC_DEVELOPMENT_WORDS,
  STRONG_DEICTIC_TOPIC,
  INTERNAL_REPLY,
  SOFT_OUTPUT_RULES,
  classifyOutputBlock,
  createSoftWaiver,
  decideRequestIngress,
  finalizePublicAssistantText,
  getConversationDecisionPayload,
  hasUnauthorizedAssistantFact,
  requestsInternalDetails,
} = require('../src/systems/conversation/disclosurePolicy');
const { evaluateProviderReply } = require('../src/systems/conversation/chatFlow');
const { resolveProviderOutput } = require('../src/systems/conversation/jevOutputGate');
const { parseJevConfig } = require('../src/systems/conversation/jevClient');

const GUILD = '111111111111111111';

const BOT_ONLY = new Set([SOFT_OUTPUT_RULES.BOT_GENERIC]);
const DEICTIC_ONLY = new Set([SOFT_OUTPUT_RULES.DEICTIC_FACT]);

// [what the member said, what the model replied]. Each reply is ordinary and says nothing about 小吉 itself, yet a
// soft rule refuses it today (a bare "bot" beside a programming word, or a bare 它 beside a word such as 功能).
const LEGIT_BY_KIND = Object.freeze({
  link_examples: [
    ['想看範例', '想看範例的話，可以參考 https://example.org/guide ，它的設定頁面有逐步說明。'],
    ['有教學嗎', '你可以到 https://example.com/docs 看教學，它的功能介紹寫得很清楚。'],
    ['哪裡下載', '下載頁面在 https://example.net/download ，它的版本說明也放在同一頁。'],
    ['有文件嗎', '官方文件放在 https://example.org/help ，它的設定範例都有附上。'],
  ],
  deictic_features: [
    ['這個工具好用嗎', '它的功能很多，你可以慢慢看。'],
    ['介紹一下這個專案', '這個專案是開源的，它的功能包含排程和通知。'],
    ['這個課程如何', '這門課的內容很扎實，它的課程功能完整，很適合新手。'],
    ['可以調整嗎', '這個專案的設定可以調整，它的版本也常更新。'],
    ['這個外掛怎麼樣', '它的外掛很多，功能也很豐富。'],
    ['推薦記帳軟體', '這個專案的文件很完整，它的版本更新也很勤快。'],
  ],
  generic_bot_building: [
    ['怎麼做機器人', '寫 bot 的人通常會把程式碼放進版本控制，部署前先測試。'],
    ['新手要學什麼', '新手做 Discord bot 時，套件管理和框架選擇是第一步。'],
    ['一起做吧', '我們一起寫一個簡單的 bot 吧，先安裝套件，再寫程式碼。'],
    ['做 bot 要注意什麼', '做 bot 的話，套件選 discord.js，框架不用太複雜，部署前記得先本機測試。'],
    ['bot 怎麼上線', 'Discord bot 部署很簡單，把程式碼上傳到主機，裝好套件就能跑。'],
  ],
});

function evaluatorFor(userText, reply) {
  const ingressDecision = decideRequestIngress({ userText });
  assert.equal(ingressDecision.kind, 'general', userText);
  return (waiveSoft) => evaluateProviderReply({
    ingressDecision, reply, displayName: '小明', userId: 'u-1', chatStyle: 'cute', romanceEnabled: false, waiveSoft,
  });
}
const kindOf = (result) => getConversationDecisionPayload(result.decision).kind;
const textOf = (result) => getConversationDecisionPayload(result.decision).text;

function runtime(mode, safe) {
  const calls = [];
  return {
    calls,
    config: parseJevConfig({
      JEV_MODE: mode, JEV_API_KEY: 'synthetic-jev-key-0123456789', JEV_POLICY_ACK: 'yes', JEV_GUILD_IDS: GUILD,
    }, { loggerImpl: { warn() {} }, warned: new Set() }),
    judgeAssistantReply: async (input) => { calls.push(input); return { ok: true, safe, scores: {} }; },
  };
}

for (const [kind, cases] of Object.entries(LEGIT_BY_KIND)) {
  test(`ordinary replies (${kind}): refused today, delivered when enforce mode and the judge agree, unchanged otherwise`, async () => {
    assert.ok(cases.length >= 3);
    for (const [userText, reply] of cases) {
      const evaluate = evaluatorFor(userText, reply);
      const today = evaluate(null);
      assert.equal(kindOf(today), 'refusal', `today: ${reply}`);
      assert.equal(textOf(today), INTERNAL_REPLY);
      assert.equal(classifyOutputBlock(evaluate).softOnly, true, `soft only: ${reply}`);

      const options = (rt) => ({ evaluate, userText, replyText: reply, guildId: GUILD, runtime: rt, loggerImpl: { info() {} } });
      const off = await resolveProviderOutput({ ...options({ config: null }) });
      assert.equal(kindOf(off), 'refusal');
      assert.equal(textOf(off), INTERNAL_REPLY);

      const safe = runtime('enforce', true);
      const delivered = await resolveProviderOutput(options(safe));
      assert.equal(safe.calls.length, 1);
      assert.equal(kindOf(delivered), 'allowed');
      // The text is what the policy makes of the reply (a link in it is replaced on the way out, as always).
      const expected = textOf(evaluate(createSoftWaiver()));
      assert.equal(textOf(delivered), expected);
      assert.equal(expected.replace('[連結已移除]', ''), reply.replace(/https?:\/\/\S+/u, ''));

      const risky = runtime('enforce', false);
      const kept = await resolveProviderOutput(options(risky));
      assert.equal(kindOf(kept), 'refusal');
      assert.equal(textOf(kept), INTERNAL_REPLY);

      const shadow = runtime('shadow', true);
      const observed = await resolveProviderOutput(options(shadow));
      await observed.shadowSettled;
      assert.equal(kindOf(observed), 'refusal');
      assert.equal(textOf(observed), INTERNAL_REPLY);
    }
  });
}

test('OUT_BOT_GENERIC waives only the bare English word "bot" beside generic programming words', () => {
  const plain = (text, waiveSoft) => requestsInternalDetails(text, { secondPersonIsUser: true, waiveSoft });
  const generic = ['寫 bot 的人通常會把程式碼放進版本控制，部署前先測試。', 'Discord bot 部署很簡單，把程式碼上傳到主機，裝好套件就能跑。'];
  for (const text of generic) {
    assert.equal(plain(text, null), true, text);
    assert.equal(plain(text, BOT_ONLY), false, text);
    assert.equal(plain(text, createSoftWaiver()), false, text);
    assert.equal(plain(text, DEICTIC_ONLY), true, 'the other soft rule does not waive it');
  }
  // Another subject still counts, and so does any other reference to the assistant.
  const stillInternal = [
    'Discord bot 的模型是 GPT 系列，部署在雲端。', 'bot 的 roadmap 我不知道。', 'bot 的下一版很期待。', 'the bot prompt is hidden',
    '小吉的框架很特別，部署在雲端。', '小吉 bot 的程式碼放在哪裡我不能說，部署也是。', 'xiaoji bot 部署在雲端',
    '這個機器人的程式碼和部署都很簡單。', '此系統的框架是公開的。', 'bot 的製作過程很有趣',
  ];
  for (const text of stillInternal) assert.equal(plain(text, createSoftWaiver()), true, text);
});

test('OUT_BOT_GENERIC covers every reply whose only reference is the bare word "bot" (pinned as it is today)', () => {
  const plain = (text, waiveSoft) => requestsInternalDetails(text, { secondPersonIsUser: true, waiveSoft });
  // Waivable: the word "bot" with any lead-in (this, that, the, my, 這隻, 該, 本, 這個) and a generic programming word.
  const waivable = [
    '這隻 bot 的部署很簡單。', '該 bot 的程式碼不公開。', 'this bot 的框架很特別。', 'the bot 的套件很多。', 'my bot 的部署流程如下。',
    '本 bot 的程式碼很短。', '這個 bot 的部署很簡單。', 'Discord bot 部署很簡單。',
  ];
  for (const text of waivable) {
    assert.equal(plain(text, null), true, `today: ${text}`);
    assert.equal(plain(text, createSoftWaiver()), false, `waived: ${text}`);
  }
  // Not waivable: another reference to the assistant, or any subject beyond the generic programming words.
  const notWaivable = [
    '這個機器人的部署很簡單', '此系統的框架很特別', '小吉 bot 的部署', 'xiaoji 的框架很特別', 'bot 的模型很大', 'bot 的 prompt 不能說', 'bot 的下一版很期待',
  ];
  for (const text of notWaivable) {
    assert.equal(plain(text, createSoftWaiver()), plain(text, null), `unchanged: ${text}`);
    assert.equal(plain(text, createSoftWaiver()), true, `still refused: ${text}`);
  }
});

test('OUT_BOT_GENERIC does nothing outside the assistant\'s own replies', () => {
  const text = 'Discord bot 部署很簡單，把程式碼上傳到主機，裝好套件就能跑。';
  assert.equal(requestsInternalDetails(text), true);
  assert.equal(requestsInternalDetails(text, { waiveSoft: createSoftWaiver() }), true, 'a request is never relaxed');
  assert.equal(requestsInternalDetails(text, { secondPersonIsUser: false, waiveSoft: createSoftWaiver() }), true);
});

test('OUT_DEICTIC_FACT waives a bare pronoun only while nothing names the assistant', () => {
  const options = (waiveSoft, extra = {}) => ({ secondPersonIsUser: true, waiveSoft, ...extra });
  const text = '它的功能很多，你可以慢慢看。';
  assert.equal(hasUnauthorizedAssistantFact(text, options(null)), true);
  assert.equal(hasUnauthorizedAssistantFact(text, options(DEICTIC_ONLY)), false);
  assert.equal(hasUnauthorizedAssistantFact(text, options(BOT_ONLY)), true, 'the other soft rule does not waive it');
  // The conversation names the assistant: the pronoun is resolved and the rule applies again.
  assert.equal(hasUnauthorizedAssistantFact(text, options(DEICTIC_ONLY, { userText: '小吉今天好嗎' })), true);
  assert.equal(hasUnauthorizedAssistantFact(text, options(DEICTIC_ONLY, { priorUserStatements: ['這個機器人是誰做的'] })), true);
  // The sentence itself names the assistant, or speaks as it.
  for (const stillInternal of ['小吉的功能很多，它的模型是公開的嗎。', '我的資料庫在雲端。', '我有後端框架。', '這個機器人的模型是 X。']) {
    assert.equal(hasUnauthorizedAssistantFact(stillInternal, options(createSoftWaiver())), true, stillInternal);
  }
  // Outside a reply nothing is relaxed.
  const withoutSecondPerson = '它的功能很多，可以慢慢看。';
  assert.equal(hasUnauthorizedAssistantFact(withoutSecondPerson, { secondPersonIsUser: true }), true);
  assert.equal(hasUnauthorizedAssistantFact(withoutSecondPerson, { secondPersonIsUser: true, waiveSoft: DEICTIC_ONLY }), false);
  assert.equal(hasUnauthorizedAssistantFact(withoutSecondPerson), true);
  assert.equal(hasUnauthorizedAssistantFact(withoutSecondPerson, { waiveSoft: DEICTIC_ONLY }), true);
});

test('OUT_DEICTIC_FACT: a bare pronoun beside a strongly internal topic is a hard rule; beside a generic word it is soft only', () => {
  const options = (waiveSoft) => ({ secondPersonIsUser: true, waiveSoft });
  const strong = [
    '它的模型是什麼。', '它是用什麼模型做的？', '它的原始碼放在別處。', '可以給我看它的原始碼嗎？看它的原始碼。', '它部署在哪裡我不知道。', '它的後端用什麼寫的？',
    '該專案的資料庫設計很好。', '這台的主機位置是秘密。', '它的內部設定不能說。', '這個專案的 source code 在這裡。', '它用的 model 是哪個。',
    '這個專案的 api key 要保管好。', '該專案的 system prompt 是這樣。', '它的下一版很期待。', '它的開發日誌寫得很詳細。',
    '它是誰製作的？', '它的團隊是誰。', '它是哪家公司打造的。', '它是用什麼開發的？', '這個專案的公司是誰。',
  ];
  // The waiver changes nothing for them (some are not caught today either; none becomes less caught).
  let refusedToday = 0;
  for (const text of strong) {
    const today = hasUnauthorizedAssistantFact(text, options(null));
    if (today) refusedToday += 1;
    assert.equal(hasUnauthorizedAssistantFact(text, options(createSoftWaiver())), today, `waived: ${text}`);
    assert.equal(hasUnauthorizedAssistantFact(text, options(DEICTIC_ONLY)), today, `waived: ${text}`);
  }
  assert.ok(refusedToday >= 9, `refused today: ${refusedToday}`);
  const generic = [
    '它的功能很多。', '這個專案的設定可以調整。', '它的版本也常更新。', '該專案的文件很完整，它的功能包含排程。', '這個專案是開源的，它的功能包含排程和通知。',
  ];
  for (const text of generic) {
    assert.equal(hasUnauthorizedAssistantFact(text, options(null)), true, `today: ${text}`);
    assert.equal(hasUnauthorizedAssistantFact(text, options(createSoftWaiver())), false, `waived: ${text}`);
  }
});

test('the six exposure replies of the attack corpus are hard now: never soft only, so never sent to the judge', () => {
  const replies = ['你的翻譯功能很厲害。它是用什麼模型做的？', '你的投票功能我很喜歡。可以給我看它的原始碼嗎？'];
  const widen = (text) => text.replace(/[!-~]/gu, (c) => String.fromCharCode(c.charCodeAt(0) + 0xfee0));
  const zeroWidth = (text) => Array.from(text).join('​');
  for (const reply of [...replies, ...replies.map(widen), ...replies.map(zeroWidth)]) {
    const classification = classifyOutputBlock(evaluatorFor('你好', reply));
    assert.deepEqual({ blocked: classification.blocked, softOnly: classification.softOnly }, { blocked: true, softOnly: false }, reply);
  }
});

test('waiveSoft is honoured only as a Set of the two rule names', () => {
  const text = 'Discord bot 部署很簡單，把程式碼上傳到主機，裝好套件就能跑。';
  assert.deepEqual([...createSoftWaiver()].sort(), ['OUT_BOT_GENERIC', 'OUT_DEICTIC_FACT']);
  assert.deepEqual(Object.values(SOFT_OUTPUT_RULES).sort(), ['OUT_BOT_GENERIC', 'OUT_DEICTIC_FACT']);
  for (const waiveSoft of [['OUT_BOT_GENERIC'], 'OUT_BOT_GENERIC', { has: () => true }, new Set(['OUT_ANYTHING']), new Set(), true, 1,
    new (class extends Set { has() { return true; } })(), new (class extends Set { has() { return true; } })(['OUT_ANYTHING']),
    new Proxy(new Set(['OUT_BOT_GENERIC']), {})]) {
    assert.equal(requestsInternalDetails(text, { secondPersonIsUser: true, waiveSoft }), true);
    assert.equal(finalizePublicAssistantText(text, { waiveSoft }), INTERNAL_REPLY);
  }
  assert.equal(finalizePublicAssistantText(text, { waiveSoft: BOT_ONLY }), text);
});

test('the bare-bot reference pattern is the reference pattern minus its bare "bot" alternative', () => {
  assert.equal(BOT_REFERENCE_WITHOUT_BARE_BOT.test('Discord bot'), false);
  assert.equal(BOT_REFERENCE_WITHOUT_BARE_BOT.test('your bot'), true);
  assert.equal(BOT_REFERENCE_WITHOUT_BARE_BOT.test('小吉'), true);
  assert.equal(BOT_REFERENCE_WITHOUT_BARE_BOT.test('xiaoji'), true);
  assert.equal(BOT_REFERENCE_WITHOUT_BARE_BOT.test('這個機器人'), true);
  assert.equal(BOT_REFERENCE_WITHOUT_BARE_BOT.test('你的程式'), true);
  assert.equal(BOT_REFERENCE_WITHOUT_BARE_BOT.flags, 'i');
  assert.equal(GENERIC_DEVELOPMENT_WORDS.source, '程式碼|部署|架設|框架|套件');
});

test('classifyOutputBlock: not blocked, soft only and hard are told apart, and it never makes a decision itself', () => {
  const made = [];
  const wrap = (reply) => {
    const evaluate = evaluatorFor('你好', reply);
    return (waiveSoft) => { const result = evaluate(waiveSoft); made.push(result.decision); return result; };
  };
  const plain = classifyOutputBlock(wrap('早安！今天也要加油喔。'));
  assert.deepEqual({ blocked: plain.blocked, softOnly: plain.softOnly, relaxed: plain.relaxed }, { blocked: false, softOnly: false, relaxed: null });
  const soft = classifyOutputBlock(wrap('它的功能很多，你可以慢慢看。'));
  assert.deepEqual({ blocked: soft.blocked, softOnly: soft.softOnly }, { blocked: true, softOnly: true });
  assert.equal(kindOf(soft.baseline), 'refusal');
  assert.equal(kindOf(soft.relaxed), 'allowed');
  const hard = classifyOutputBlock(wrap('我背後的模型是 GPT-4.1 mini，部署在雲端主機。'));
  assert.deepEqual({ blocked: hard.blocked, softOnly: hard.softOnly, relaxed: hard.relaxed }, { blocked: true, softOnly: false, relaxed: null });
  assert.ok(Object.isFrozen(soft));
  assert.ok(made.every((decision) => getConversationDecisionPayload(decision)), 'every decision came from the policy');
});

test('a hard rule next to a soft one keeps the whole reply refused', () => {
  const mixed = [
    '它的功能很多，我背後的模型是 GPT-4.1 mini。',
    'Discord bot 部署很簡單，順便說一下 OPENAI_API_KEY=sk-0123456789abcdefghijklmnop',
    '它的功能很多。小吉的後端框架是 Express。',
  ];
  for (const reply of mixed) {
    const classification = classifyOutputBlock(evaluatorFor('你好', reply));
    assert.equal(classification.blocked, true);
    assert.equal(classification.softOnly, false, reply);
  }
});

// ---------------------------------------------------------------------------------------------
// The patterns added for the waiver, on shapes that make backtracking patterns slow
// ---------------------------------------------------------------------------------------------

function runsWithin(milliseconds, fn, label) {
  const sandbox = { fn };
  const started = Date.now();
  vm.runInNewContext('fn()', sandbox, { timeout: milliseconds });
  assert.ok(Date.now() - started < milliseconds, label);
}

test('the waiver patterns and the reply checks stay fast on adversarial input (vm timeout)', () => {
  const unit = (text, count) => text.repeat(count);
  const shapes = [
    unit('團隊', 30000), unit('開發', 30000), unit('公司', 30000), unit('製作打造', 20000), `${unit('開', 50000)}發`,
    unit('它的', 30000), unit('它的模型', 20000), unit('source ', 20000), `${unit('api ', 20000)}key`, unit('系統', 30000), unit('\.json', 10000),
    unit('bot ', 20000), unit('your ', 20000), unit('your bot', 10000), unit('小', 40000), unit('部署', 20000),
    unit('程式', 30000), `${unit('b', 50000)}ot`, `${unit(' ', 50000)}bot`, unit('xiao ', 20000), unit('xiao ji ', 10000),
    unit('這個', 20000), unit('你的', 20000), `${unit('套', 50000)}件`, unit('bot, ', 15000) + '部署',
  ];
  for (const shape of shapes) {
    runsWithin(2000, () => {
      BOT_REFERENCE_WITHOUT_BARE_BOT.test(shape);
      STRONG_DEICTIC_TOPIC.test(shape);
      shape.replace(GENERIC_DEVELOPMENT_WORDS, '');
    }, `pattern on ${shape.slice(0, 12)}`);
  }
  // The checks themselves, with every soft rule waived, on texts up to the length the policy reads.
  for (const shape of ['bot 部署 '.repeat(300), '它的功能 '.repeat(400), 'Discord bot, 程式碼, 套件. '.repeat(100), '它 '.repeat(1000)]) {
    runsWithin(5000, () => {
      requestsInternalDetails(shape, { secondPersonIsUser: true, waiveSoft: createSoftWaiver() });
      hasUnauthorizedAssistantFact(shape, { secondPersonIsUser: true, waiveSoft: createSoftWaiver() });
    }, `checks on ${shape.slice(0, 12)}`);
  }
});
