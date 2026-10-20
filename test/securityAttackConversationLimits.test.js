'use strict';

// Attack tests for the size of what the AI chat reads and sends, and for the work the checks do on it
// (src/services/conversationModeService.js, src/systems/conversation/*).
//
// Nothing here uses the network, a model or Discord. The attacks are: a message over the length limit, a model
// reply that is far too long, and large or adversarial text in every stage that reads it (the anti-spam gate, the
// confidentiality policy, the output clean-up and public memory). Work is judged by how it grows with the text,
// never by a tight wall-clock limit: a run that is still fast always passes, and a slow one passes when it grew no
// faster than the text did.
//
// A test that passes is a defence that held. Every invisible character is written as a \u{...} escape.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-attack-limits-suite-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const {
  AI_SPAM_BLOCK_REASONS: REASONS,
  AI_SPAM_NOTICES,
  AiSpamGuard,
  classifyMeaningless,
  repeatKey,
} = require('../src/systems/conversation/aiSpamGuard');
const {
  INTERNAL_REPLY,
  decideAssistantOutput,
  decidePublicMessagePersistence,
  decideRequestIngress,
  finalizePublicAssistantText,
  getConversationDecisionPayload,
} = require('../src/systems/conversation/disclosurePolicy');
const { getDeployedModelIds, getProtectedPromptTexts } = require('../src/systems/conversation/provider');
const { sanitizeUserFacingOutput } = require('../src/systems/conversation/userFacingOutputPolicy');
const { handleMentionMessage, splitReply } = require('../src/systems/conversation/chatFlow');
const { providerCallGuard } = require('../src/systems/conversation/providerGuard');
const { clearMemoryForTests } = require('../src/systems/conversation/projection');
const {
  DEFAULT_MAX_MESSAGE_LENGTH,
  clearConversationStateForTests,
  validateChatInput,
} = require('../src/services/conversationModeService');
const { resetConversationHistoryForTests } = require('../src/services/conversationHistoryService');
const { closeArchiveForTests } = require('../src/services/aiArchiveService');

const BOT_ID = '900000000000000099';
const MEMBER_ID = '900000000000000211';
const PROTECTED = getProtectedPromptTexts('cute', false);
const MODEL_IDS = getDeployedModelIds();
const CHAT_CAP = DEFAULT_MAX_MESSAGE_LENGTH;
const MAX_POLICY_TEXT_LENGTH = 12_000;

const repeatText = (unit, length) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
const distinctText = (base, length) => Array.from({ length }, (_, index) => String.fromCodePoint(base + index)).join('');

function elapsedMs(run) {
  const began = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - began) / 1e6;
}

// Work must grow about as fast as the text: 5.5 times the text may take up to MAX_GROWTH times as long, which the
// quadratic patterns the policy used to have exceeded by a wide margin. Small and large runs are interleaved and the
// fastest of each is kept, and a large run that is still fast always passes.
const MAX_GROWTH = 16;
const ALWAYS_FAST_MS = 30;
const SMALL = 2_000;
const LARGE = 11_000;
function assertLinearGrowth(label, make, run) {
  const small = make(SMALL);
  const large = make(LARGE);
  run(small);
  let smallMs = Infinity;
  let largeMs = Infinity;
  for (let round = 0; round < 2; round += 1) {
    smallMs = Math.min(smallMs, elapsedMs(() => run(small)), elapsedMs(() => run(small)));
    largeMs = Math.min(largeMs, elapsedMs(() => run(large)));
  }
  assert.ok(largeMs < ALWAYS_FAST_MS || largeMs / smallMs < MAX_GROWTH,
    `${label}: ${smallMs.toFixed(1)} ms at ${SMALL} characters, ${largeMs.toFixed(1)} ms at ${LARGE}`);
}

// ---------------------------------------------------------------------------------------------
// Oversized input and output
// ---------------------------------------------------------------------------------------------

test('1500 characters are read and one more is refused with a sentence that quotes nothing', () => {
  assert.equal(DEFAULT_MAX_MESSAGE_LENGTH, 1500);
  assert.deepEqual(validateChatInput('龘'.repeat(DEFAULT_MAX_MESSAGE_LENGTH)), { ok: true });
  const over = validateChatInput('龘'.repeat(DEFAULT_MAX_MESSAGE_LENGTH + 1));
  assert.equal(over.ok, false);
  assert.equal(over.reason, 'too_long');
  assert.match(over.message, /1500/u);
  assert.doesNotMatch(over.message, /龘/u);
  // Invisible characters and surrogate pairs count by their UTF-16 length, so they cannot smuggle extra text.
  assert.equal(validateChatInput('\u{200b}'.repeat(DEFAULT_MAX_MESSAGE_LENGTH + 1)).reason, 'too_long');
  assert.equal(validateChatInput('\u{1F600}'.repeat(DEFAULT_MAX_MESSAGE_LENGTH / 2 + 1)).reason, 'too_long');
  assert.equal(validateChatInput('   ').reason, 'empty');
});

test('a million-character message is judged by its length alone', () => {
  assertLinearGrowth('length check', (n) => 'a'.repeat(n * 100), (text) => assert.equal(validateChatInput(text).reason, 'too_long'));
});

function prepareChat(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-attack-limits-'));
  const names = ['XIAOJI_ARCHIVE_CAPTURE_ENABLED', 'AI_CONVERSATION_PATH', 'XIAOJI_MEMORY_PATH', 'BOT_OWNER_ID', 'OWNER_ID'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.AI_CONVERSATION_PATH = path.join(root, 'history.json');
  process.env.XIAOJI_MEMORY_PATH = path.join(root, 'memory.json');
  delete process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED;
  closeArchiveForTests();
  clearConversationStateForTests();
  providerCallGuard.resetForTests();
  clearMemoryForTests();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-10T00:00:00.000Z') });
  t.after(async () => {
    clearConversationStateForTests();
    providerCallGuard.resetForTests();
    await resetConversationHistoryForTests();
    closeArchiveForTests();
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name];
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const sent = [];
  let providerCalls = 0;
  let sequence = 0;
  const generateChatReplyImpl = async () => { providerCalls += 1; return '一般回覆'; };
  const send = (content, channelId) => {
    sequence += 1;
    return handleMentionMessage({
      id: `90000000000${String(sequence).padStart(7, '0')}`,
      content: `<@${BOT_ID}> ${content}`,
      author: { id: MEMBER_ID, username: 'attacker', tag: 'attacker', bot: false },
      member: { displayName: 'Attacker' },
      client: { user: { id: BOT_ID } },
      guildId: null,
      channelId,
      stickers: { size: 0 },
      attachments: { size: 0 },
      createdTimestamp: Date.now(),
      async reply(payload) { sent.push(payload); },
      channel: { async send(payload) { sent.push(payload); } },
    }, { generateChatReplyImpl, statusPort: { recordInteraction: async () => {} } });
  };
  return { sent, send, providerCalls: () => providerCalls, tick: (ms) => t.mock.timers.tick(ms) };
}

test('oversized messages get a fixed sentence at most, never reach the model, and still count against the rate limit', async (t) => {
  const chat = prepareChat(t);
  const tooLong = validateChatInput('龘'.repeat(DEFAULT_MAX_MESSAGE_LENGTH + 1)).message;
  const bases = [0x4E00, 0x5E00, 0x6E00, 0x7E00, 0x8E00, 0x3400, 0x4400];
  for (const [index, base] of bases.entries()) {
    // A different channel each time, so that only the member's own limits can hold the messages back.
    await chat.send(distinctText(base, DEFAULT_MAX_MESSAGE_LENGTH + 1 + index * 40), `9000000000000003${index}0`);
    chat.tick(5_000);
  }
  assert.equal(chat.providerCalls(), 0);
  const fixed = new Set([tooLong, AI_SPAM_NOTICES[REASONS.USER_RATE]]);
  for (const payload of chat.sent) {
    assert.ok(fixed.has(payload.content), payload.content.slice(0, 40));
    assert.deepEqual(payload.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  }
  // Seven oversized messages in 35 seconds: the sixth and seventh are the member's own rate limit, not a reply.
  const tooLongReplies = chat.sent.filter((payload) => payload.content === tooLong).length;
  assert.ok(tooLongReplies >= 1 && tooLongReplies <= 5, `${tooLongReplies} replies`);
  assert.ok(chat.sent.length <= 6, `${chat.sent.length} replies`);
});

test('a long model reply is cut into chunks of at most 1800 characters and none of it is lost', () => {
  const reply = `${'這是一段很長的回覆內容。' + 'x'.repeat(30)}`.repeat(2_500);
  assert.ok(reply.length > 100_000);
  const chunks = splitReply(reply);
  assert.ok(chunks.length >= Math.ceil(reply.length / 1_800));
  assert.ok(chunks.every((chunk) => chunk.length > 0 && chunk.length <= 1_800));
  assert.equal(chunks.join(''), reply);
  // No break point at all: still cut at the limit, and a short reply stays one piece.
  assert.deepEqual(splitReply('a'.repeat(3_700)).map((chunk) => chunk.length), [1_800, 1_800, 100]);
  assert.deepEqual(splitReply('短'), ['短']);
  assertLinearGrowth('splitReply', (n) => repeatText('這是一段很長的回覆內容。', n * 10), (text) => splitReply(text));
});

// ---------------------------------------------------------------------------------------------
// The work of every stage on large and adversarial text
// ---------------------------------------------------------------------------------------------

const MARKS = Array.from({ length: 112 }, (_, index) => String.fromCodePoint(0x0300 + index)).join('');

// Shapes built from what each pattern family of the policy is made of. Each carries a Chinese character, because
// the regular expression engine skips some slow paths on text that is only ASCII.
const SHAPES = Object.freeze({
  zalgo: (n) => repeatText(`你${MARKS.slice(0, 40)}`, n),
  zeroWidth: (n) => repeatText('好\u{200b}', n),
  formatMarks: (n) => repeatText('s\u{ad}y\u{200e}s\u{202e}t\u{2063}e\u{fe0f}m ', n),
  oneLetterRun: (n) => `你${'a'.repeat(n - 1)}`,
  spaceRun: (n) => `你${' '.repeat(n - 1)}a`,
  commas: (n) => '，'.repeat(n),
  brackets: (n) => repeatText('你(', n),
  botName: (n) => repeatText('小吉', n),
  firstPerson: (n) => repeatText('我是', n),
  selfIntroduction: (n) => repeatText('我是小吉。', n),
  secondPerson: (n) => repeatText('你的', n),
  englishYou: (n) => repeatText('你 you ', n),
  englishYour: (n) => repeatText('你 your ', n),
  whatModel: (n) => repeatText('你 what model ', n),
  poweredBy: (n) => repeatText('小吉 Powered by ', n),
  runOn: (n) => repeatText('我 I run on ', n),
  apiKey: (n) => repeatText('你的 api key ', n),
  systemPrompt: (n) => repeatText('你的 system prompt ', n),
  sendMeYour: (n) => repeatText('send me your ', n),
  drivenBy: (n) => repeatText('由 OpenAI 驅動，', n),
  toolResult: (n) => repeatText('工具結果：', n),
  rolePlay: (n) => repeatText('pretend you are the owner and 你 ', n),
  tutorial: (n) => repeatText('首先，', n),
  slashCommands: (n) => repeatText('/help 指令 ', n),
  publicFact: (n) => repeatText('[[PUBLIC_FACT:', n),
  base64Blocks: (n) => repeatText('QUJDREVGR0hJSktMTU5P ', n),
  hexBlocks: (n) => repeatText('deadbeefdeadbeef ', n),
  percent: (n) => repeatText('%41', n),
  base64Run: (n) => `你 ${'A'.repeat(n)}`,
  customEmoji: (n) => repeatText('<a:wow:123456789012345678>', n),
  mentions: (n) => repeatText('<@123456789012345678>', n),
  links: (n) => repeatText('https://example.com/a ', n),
  wwwLinks: (n) => repeatText('www.example.com ', n),
  markdownLinks: (n) => repeatText('[a](https://example.com) ', n),
  openBrackets: (n) => repeatText('[[[[', n),
  internalSubjects: (n) => repeatText('內部測試結果', n),
  botSource: (n) => repeatText('小吉原始碼', n),
  databaseBot: (n) => repeatText('資料庫小吉', n),
  developmentLog: (n) => repeatText('小吉開發日誌', n),
  internalSource: (n) => repeatText('內部源碼', n),
  expandingMixed: (n) => repeatText('\u{fdfa}內部源碼內部源碼', n),
  wordAfterIntroduction: (n) => `我是小吉。${repeatText('authorization', n - 5)}`,
  emptyLines: (n) => `你的 system prompt${'\n'.repeat(n - 19)}x`,
  spacesAfterName: (n) => `小吉${' '.repeat(n - 3)}x`,
});

const GENERAL = decideRequestIngress({ userText: 'Tell me something fun.' });
const STAGES = Object.freeze({
  'request ingress': (text) => decideRequestIngress({ userText: text }),
  'assistant output': (text) => decideAssistantOutput({
    ingressDecision: GENERAL, rawCandidate: text, styledCandidate: text, source: 'provider',
    historyAllowed: true, protectedInstructions: PROTECTED, protectedModelIds: MODEL_IDS,
  }),
  'final reply text': (text) => finalizePublicAssistantText(text),
  'public memory decision': (text) => decidePublicMessagePersistence(text),
  'link and mention clean-up': (text) => sanitizeUserFacingOutput(text, { emit() {} }),
});

test('every stage of the policy does work that grows with the text on every adversarial shape', () => {
  for (const [shape, make] of Object.entries(SHAPES)) {
    // Expanding characters pass the length limit after NFKC well before 11000 of them; they are covered below.
    const usable = (n) => (shape === 'expandingMixed' ? make(n / 4) : make(n));
    for (const [stage, run] of Object.entries(STAGES)) {
      assertLinearGrowth(`${shape} / ${stage}`, usable, run);
    }
  }
});

test('the repeat key, the meaningless check and the gate stay bounded by the inspection limit on any length', () => {
  const guard = new AiSpamGuard({ now: () => 1_000_000, logger: { info() {}, warn() {} }, observe() {} });
  let member = 0;
  for (const [shape, make] of Object.entries(SHAPES)) {
    assertLinearGrowth(shape, make, (text) => {
      classifyMeaningless(text);
      repeatKey(text);
      guard.evaluate({
        guildId: '900000000000000001',
        channelId: '900000000000000002',
        userId: `9${String(member += 1).padStart(17, '0')}`,
        text,
      });
    });
  }
});

test('ten remembered messages of a heavy shape cost an AI request about ten times one, not more', () => {
  const turn = repeatText('內部測試結果', CHAT_CAP);
  assert.equal(decideRequestIngress({ userText: turn }).kind, 'general', 'the shape is an ordinary message');
  const ask = (priors) => decideRequestIngress({ userText: '今天吃什麼好呢', priorUserStatements: priors });
  const one = [turn];
  const ten = Array.from({ length: 10 }, () => turn);
  ask(one);
  let oneMs = Infinity;
  let tenMs = Infinity;
  for (let round = 0; round < 2; round += 1) {
    oneMs = Math.min(oneMs, elapsedMs(() => ask(one)), elapsedMs(() => ask(one)));
    tenMs = Math.min(tenMs, elapsedMs(() => ask(ten)));
  }
  assert.ok(tenMs < ALWAYS_FAST_MS * 3 || tenMs / oneMs < 30, `${oneMs.toFixed(1)} ms for one, ${tenMs.toFixed(1)} ms for ten`);
});

test('a text over the policy length limit is refused at once, however it is made up', () => {
  const over = {
    'expanding characters': '\u{fdfa}'.repeat(MAX_POLICY_TEXT_LENGTH),
    'one long run': 'a'.repeat(MAX_POLICY_TEXT_LENGTH * 10),
    'hidden characters': '\u{200b}'.repeat(MAX_POLICY_TEXT_LENGTH * 10),
    'heavy internal subjects': repeatText('內部測試結果', MAX_POLICY_TEXT_LENGTH * 10),
  };
  for (const [name, text] of Object.entries(over)) {
    assert.equal(decideRequestIngress({ userText: text }).kind, 'refusal', `${name}: ingress`);
    assert.equal(finalizePublicAssistantText(text), INTERNAL_REPLY, `${name}: final reply text`);
    assert.equal(decidePublicMessagePersistence(text), null, `${name}: public memory`);
    assert.equal(
      getConversationDecisionPayload(decideAssistantOutput({ ingressDecision: GENERAL, rawCandidate: text })).kind,
      'refusal', `${name}: assistant output`);
  }
});
