'use strict';

// Attack tests for the AI chat anti-spam gate (src/systems/conversation/aiSpamGuard.js).
//
// The real gate, with a controlled clock, is attacked directly, and one case goes through the real chat flow with
// a stub provider. Nothing here uses the network, a model or Discord. The attacks are: sending right at the edge of
// every rate limit, sending the same words in disguise, walls of invisible or combining characters, custom emoji
// floods, and a crowd of different members and channels trying to make the gate forget a member in a cooldown.
//
// A test that passes is a defence that held. All IDs, names and links are synthetic, and every invisible character
// is written as a \u{...} escape, never as a literal character.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-attack-flood-suite-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const {
  AI_SPAM_BLOCK_REASONS: REASONS,
  AI_SPAM_LIMITS,
  AI_SPAM_NOTICES,
  AI_SPAM_PRESENCE_REPLY,
  AiSpamGuard,
  classifyMeaningless,
  isNearDuplicate,
  repeatKey,
} = require('../src/systems/conversation/aiSpamGuard');
const { handleMentionMessage } = require('../src/systems/conversation/chatFlow');
const { providerCallGuard } = require('../src/systems/conversation/providerGuard');
const { clearMemoryForTests } = require('../src/systems/conversation/projection');
const { clearConversationStateForTests } = require('../src/services/conversationModeService');
const { resetConversationHistoryForTests } = require('../src/services/conversationHistoryService');
const { closeArchiveForTests } = require('../src/services/aiArchiveService');

const MINUTE = 60_000;
const GUILD = '900000000000000001';
const CHANNEL = '900000000000000002';
const USER = '900000000000000003';
const BOT_ID = '900000000000000099';

const guildUserKey = (userId, guildId = GUILD) => `${guildId}\u0000${userId}`;
const syntheticUser = (index) => `9${String(index).padStart(17, '0')}`;
const syntheticChannel = (index) => `8${String(index).padStart(17, '0')}`;
const cjk = (offset) => String.fromCodePoint(0x4E00 + (offset % 20_000));
// Short questions that share nothing, so that only the rate limits can block them.
const unrelated = (index) => `問${cjk(index * 37)}${cjk(index * 53 + 7)}`;
const interleave = (text, mark) => Array.from(text).join(mark);
const repeatText = (unit, length) => unit.repeat(Math.ceil(length / unit.length)).slice(0, length);
const toFullWidth = (text) => text.replace(/[!-~]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0xFEE0))
  .replace(/ /g, '\u{3000}');

function makeGuard(limits = {}) {
  const clock = { value: 1_000_000 };
  const guard = new AiSpamGuard({
    limits,
    now: () => clock.value,
    logger: { info() {}, warn() {} },
    observe() {},
  });
  const ask = (text, { guildId = GUILD, channelId = CHANNEL, userId = USER, explicit = true } = {}) =>
    guard.evaluate({ guildId, channelId, userId, text, explicit });
  return { guard, clock, ask, start: clock.value };
}

function elapsedMs(run) {
  const began = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - began) / 1e6;
}

// Work must grow about as fast as the text. Small and large runs are interleaved and the fastest of each is kept,
// and a large run that is still fast always passes, so timer noise cannot fail the test on a fast machine.
const MAX_GROWTH = 16;
const ALWAYS_FAST_MS = 30;
function assertLinearGrowth(label, make, run, small = 500, large = 2_000) {
  const smallText = make(small);
  const largeText = make(large);
  run(smallText);
  let smallMs = Infinity;
  let largeMs = Infinity;
  for (let round = 0; round < 2; round += 1) {
    smallMs = Math.min(smallMs, elapsedMs(() => run(smallText)), elapsedMs(() => run(smallText)));
    largeMs = Math.min(largeMs, elapsedMs(() => run(largeText)));
  }
  assert.ok(largeMs < ALWAYS_FAST_MS || largeMs / smallMs < MAX_GROWTH,
    `${label}: ${smallMs.toFixed(2)} ms at ${small} characters, ${largeMs.toFixed(2)} ms at ${large}`);
}

// ---------------------------------------------------------------------------------------------
// Rate limits at their exact edges
// ---------------------------------------------------------------------------------------------

test('five requests a minute pass and the sixth waits until the first is a full minute old', () => {
  const { clock, ask, start } = makeGuard();
  [0, 1_000, 2_000, 3_000, 4_000].forEach((offset, index) => {
    clock.value = start + offset;
    assert.equal(ask(unrelated(index)).allowed, true, `request ${index + 1} is inside the limit`);
  });
  clock.value = start + MINUTE - 1;
  const sixth = ask(unrelated(5));
  assert.deepEqual([sixth.allowed, sixth.reason], [false, REASONS.USER_RATE]);
  assert.equal(sixth.notice, AI_SPAM_NOTICES[REASONS.USER_RATE]);
  assert.doesNotMatch(sixth.notice, /<@|@everyone|@here|https?:/u);
  // The first request is exactly a minute old now, so it no longer counts.
  clock.value = start + MINUTE;
  assert.equal(ask(unrelated(6)).allowed, true);
});

test('twenty requests in ten minutes pass at 29 s spacing and the 21st waits until the first is ten minutes old', () => {
  const { clock, ask, start } = makeGuard();
  for (let index = 0; index < AI_SPAM_LIMITS.userLongMaxRequests; index += 1) {
    clock.value = start + index * 29_000;
    assert.equal(ask(unrelated(index)).allowed, true, `request ${index + 1}`);
  }
  clock.value = start + 10 * MINUTE - 1;
  const over = ask(unrelated(20));
  assert.deepEqual([over.allowed, over.reason], [false, REASONS.USER_RATE]);
  clock.value = start + 10 * MINUTE;
  assert.equal(ask(unrelated(21)).allowed, true);
});

test('a patient member sending a new question every 7 seconds for an hour never beats either limit', () => {
  const { clock, ask, start } = makeGuard();
  const admitted = [];
  let cooldownsStarted = 0;
  for (let step = 0; step * 7_000 < 60 * MINUTE; step += 1) {
    clock.value = start + step * 7_000;
    const verdict = ask(unrelated(step));
    if (verdict.allowed) admitted.push(clock.value);
    if (verdict.cooldownStarted) cooldownsStarted += 1;
  }
  assert.ok(admitted.length > 0, 'the first requests are answered');
  for (const at of admitted) {
    const inLastMinute = admitted.filter((other) => other <= at && at - other < MINUTE).length;
    const inLastTen = admitted.filter((other) => other <= at && at - other < 10 * MINUTE).length;
    assert.ok(inLastMinute <= AI_SPAM_LIMITS.userShortMaxRequests, `${inLastMinute} in a minute at +${at - start}`);
    assert.ok(inLastTen <= AI_SPAM_LIMITS.userLongMaxRequests, `${inLastTen} in ten minutes at +${at - start}`);
  }
  assert.ok(admitted.length <= 6 * AI_SPAM_LIMITS.userLongMaxRequests, `${admitted.length} answered in an hour`);
  assert.ok(cooldownsStarted >= 1, 'blocked pushing ends in a cooldown');
});

// ---------------------------------------------------------------------------------------------
// The same words in disguise
// ---------------------------------------------------------------------------------------------

const ZH_BASE = '幫我推薦一首適合晚上聽的歌';
const EN_BASE = 'Please recommend a good song for tonight';

// Format, control and mark characters that carry no letter. Every one of them has to be ignored by the repeat key.
const INVISIBLE = Object.freeze([
  '\u{200b}', '\u{200c}', '\u{200d}', '\u{2060}', '\u{feff}', '\u{ad}', '\u{200e}', '\u{200f}', '\u{202a}', '\u{202b}',
  '\u{202c}', '\u{202d}', '\u{202e}', '\u{2061}', '\u{2062}', '\u{2063}', '\u{2064}', '\u{2066}', '\u{2067}', '\u{2068}',
  '\u{2069}', '\u{206a}', '\u{180e}', '\u{fe0f}', '\u{34f}', '\u{61c}', '\u{e0001}', '\u{e0041}', '\u{0}', '\u{7}',
  '\u{7f}', '\u{85}', '\u{2028}', '\u{2029}',
]);
// Hangul fillers are letters by category and blank to the eye.
const HANGUL_FILLERS = Object.freeze(['\u{115f}', '\u{1160}', '\u{3164}', '\u{ffa0}']);

const DISGUISES = Object.freeze({
  'trailing punctuation': (text) => `${text}！！！`,
  'punctuation inside the sentence': (text) => Array.from(text).map((c, index) => (index % 4 === 3 ? `${c}，。` : c)).join(''),
  'upper case': (text) => text.toUpperCase(),
  'lower case': (text) => text.toLowerCase(),
  'full-width letters and spaces': toFullWidth,
  'a space between every character': (text) => interleave(text, ' '),
  'newlines and tabs between every character': (text) => interleave(text, '\n\t'),
  'non-breaking and ideographic spaces': (text) => text.replace(/ /g, '\u{a0}\u{3000}'),
  'emoji tail': (text) => `${text} 😂😂🔥`,
  'emoji between every character': (text) => interleave(text, '😂'),
  'custom emoji, mention and broadcast markup': (text) =>
    `<:wow:123456789012345678> ${text} <@123456789012345678> <a:dance:1> @everyone`,
  'zero-width characters between every character': (text) => interleave(text, '\u{200b}\u{200d}'),
  'Hangul fillers between every character': (text) => interleave(text, '\u{3164}'),
  'accents on every Latin vowel': (text) => text.replace(/[aeiou]/g, (c) => `${c}\u{301}`),
  'underscores': (text) => text.replace(/ /g, '_'),
  'dots': (text) => text.replace(/ /g, '.'),
});

test('punctuation, width, case, spacing, emoji, markup, zero-width characters, fillers and accents are the same words', () => {
  for (const base of [ZH_BASE, EN_BASE]) {
    const baseKey = repeatKey(base);
    for (const [name, disguise] of Object.entries(DISGUISES)) {
      const disguised = disguise(base);
      assert.equal(isNearDuplicate(baseKey, repeatKey(disguised)), true, `${name}: ${JSON.stringify(disguised.slice(0, 40))}`);
    }
  }
  // Marks on Chinese characters have nothing to combine with, so they simply fall away.
  const marked = Array.from(ZH_BASE).map((c) => `${c}\u{301}\u{302}\u{303}`).join('');
  assert.equal(repeatKey(marked).hash, repeatKey(ZH_BASE).hash);
});

test('every invisible format, control or mark character leaves the repeat key and the meaningless check unchanged', () => {
  const baseKey = repeatKey(ZH_BASE);
  for (const mark of INVISIBLE) {
    const code = mark.codePointAt(0).toString(16);
    assert.equal(repeatKey(interleave(ZH_BASE, mark)).hash, baseKey.hash, `U+${code}`);
    assert.equal(repeatKey(`${mark}${EN_BASE}${mark}`).hash, repeatKey(EN_BASE).hash, `U+${code} around`);
    assert.equal(classifyMeaningless(`哈${mark}`.repeat(8)), 'repeated', `U+${code} repeated laugh`);
    assert.equal(classifyMeaningless(mark.repeat(40)), 'empty', `U+${code} alone`);
  }
  for (const filler of HANGUL_FILLERS) {
    const code = filler.codePointAt(0).toString(16);
    assert.equal(repeatKey(interleave(ZH_BASE, filler)).hash, baseKey.hash, `U+${code}`);
    assert.equal(repeatKey(`${filler}${EN_BASE}${filler}`).hash, repeatKey(EN_BASE).hash, `U+${code} around`);
  }
});

test('the third copy is blocked whichever two disguises carried the second and the third', () => {
  const names = Object.keys(DISGUISES);
  names.forEach((firstName, index) => {
    const secondName = names[(index + 1) % names.length];
    const { clock, ask } = makeGuard();
    assert.equal(ask(EN_BASE).allowed, true);
    clock.value += 2 * MINUTE;
    assert.equal(ask(DISGUISES[firstName](EN_BASE)).allowed, true, `${firstName} is the second copy`);
    clock.value += 2 * MINUTE;
    const third = ask(DISGUISES[secondName](EN_BASE));
    assert.deepEqual([third.allowed, third.reason], [false, REASONS.REPEAT], `${firstName} then ${secondName}`);
    assert.equal(third.notice, AI_SPAM_NOTICES[REASONS.REPEAT]);
  });
});

test('the same Chinese question sent with a Hangul filler between every character is blocked the third time', () => {
  for (const filler of HANGUL_FILLERS) {
    const { clock, ask } = makeGuard();
    assert.equal(ask(ZH_BASE).allowed, true);
    clock.value += MINUTE;
    assert.equal(ask(interleave(ZH_BASE, filler)).allowed, true);
    clock.value += MINUTE;
    const third = ask(interleave(ZH_BASE, filler));
    assert.deepEqual([third.allowed, third.reason], [false, REASONS.REPEAT], `U+${filler.codePointAt(0).toString(16)}`);
  }
});

test('the same English question with accents on its vowels is blocked the third time', () => {
  const accented = (text) => text.replace(/[aeiou]/g, (c) => `${c}\u{301}`);
  const { clock, ask } = makeGuard();
  assert.equal(ask(EN_BASE).allowed, true);
  clock.value += MINUTE;
  assert.equal(ask(accented(EN_BASE)).allowed, true);
  clock.value += MINUTE;
  const third = ask(accented(EN_BASE).toUpperCase());
  assert.deepEqual([third.allowed, third.reason], [false, REASONS.REPEAT]);
});

test('a different question is not a repeat of the disguised one', () => {
  const { ask } = makeGuard();
  assert.equal(ask(ZH_BASE).allowed, true);
  assert.equal(ask(DISGUISES['full-width letters and spaces']('今天台北會下雨嗎')).allowed, true);
  assert.equal(ask('今天高雄會下雨嗎？').allowed, true);
});

// ---------------------------------------------------------------------------------------------
// Walls of zalgo, zero-width and expanding characters
// ---------------------------------------------------------------------------------------------

const MARKS = Array.from({ length: 112 }, (_, index) => String.fromCodePoint(0x0300 + index)).join('');
const zalgoOf = (units, perUnit, cap = AI_SPAM_LIMITS.inspectMaxLength) => {
  let out = '';
  for (const unit of units) {
    out += unit + MARKS.slice(0, perUnit);
    if (out.length >= cap) break;
  }
  return out.slice(0, cap);
};

test('zalgo and zero-width walls of text are judged by the letters they carry, not their length', () => {
  const max = AI_SPAM_LIMITS.inspectMaxLength;
  // Marks and zero-width characters are not words: nothing but those is empty content.
  assert.equal(classifyMeaningless(MARKS.repeat(Math.ceil(max / MARKS.length)).slice(0, max)), 'empty');
  assert.equal(classifyMeaningless('\u{200b}'.repeat(max)), 'empty');
  assert.equal(classifyMeaningless('\u{200d}\u{200c}\u{2060}\u{feff}'.repeat(max / 4)), 'empty');
  // One letter on top of a pile of marks is still one letter.
  assert.equal(classifyMeaningless(zalgoOf(['哈'], 111, max)), null);
  // The same laugh over and over under zalgo is a repeat.
  assert.equal(classifyMeaningless(zalgoOf(Array(400).fill('哈'), 4, max)), 'repeated');
  assert.equal(classifyMeaningless('A\u{200b}'.repeat(max / 2)), 'repeated');
  // A real sentence wrapped in marks or zero-width characters is the same sentence.
  const wrapped = zalgoOf(Array.from(ZH_BASE), 100, max);
  assert.ok(wrapped.length <= max);
  assert.equal(classifyMeaningless(wrapped), null);
  assert.equal(repeatKey(wrapped).hash, repeatKey(ZH_BASE).hash);
  assert.equal(repeatKey(interleave(ZH_BASE, '\u{200b}'.repeat(100))).hash, repeatKey(ZH_BASE).hash);
});

test('the gate reads at most its inspection limit of a very long text', () => {
  const max = AI_SPAM_LIMITS.inspectMaxLength;
  const head = '台'.repeat(30) + '北'.repeat(30);
  const shared = head.repeat(Math.ceil(max / head.length)).slice(0, max);
  assert.equal(repeatKey(`${shared}甲甲甲`).hash, repeatKey(`${shared}乙乙乙`).hash);
  assert.equal(repeatKey('你'.repeat(10_000)).length, max);
});

test('NFKC expansion is bounded: 2000 expanding characters become at most 18 times as many', () => {
  const max = AI_SPAM_LIMITS.inspectMaxLength;
  const expanding = '\u{fdfa}'.repeat(max);
  const key = repeatKey(expanding);
  assert.ok(key.length > max, 'the compatibility form is longer than the input');
  assert.ok(key.length <= max * 18, `${key.length} characters`);
  assert.equal(key.head.length, AI_SPAM_LIMITS.repeatEndLength);
  assert.equal(classifyMeaningless(expanding), null);
});

test('the work of the gate grows with the text on walls of zalgo, zero-width, expanding and distinct characters', () => {
  let member = 0;
  const walls = {
    zalgo: (n) => zalgoOf(Array.from(ZH_BASE.repeat(200)), 20, n),
    zeroWidth: (n) => interleave(ZH_BASE.repeat(200), '\u{200b}').slice(0, n),
    zeroWidthOnly: (n) => '\u{200b}'.repeat(n),
    expanding: (n) => '\u{fdfa}'.repeat(n),
    squared: (n) => '\u{3392}'.repeat(n),
    emoji: (n) => '😂'.repeat(n / 2),
    customEmoji: (n) => repeatText('<a:wow:123456789012345678>', n),
    spaces: (n) => `${' '.repeat(n - 1)}好`,
    allDistinct: (n) => Array.from({ length: n }, (_, index) => cjk(index)).join(''),
  };
  for (const [name, make] of Object.entries(walls)) {
    const { ask } = makeGuard();
    // A new member for every run, so that the gate does the whole job each time.
    assertLinearGrowth(name, make, (text) => {
      classifyMeaningless(text);
      repeatKey(text);
      ask(text, { userId: syntheticUser(member += 1) });
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Custom emoji floods
// ---------------------------------------------------------------------------------------------

test('custom emoji, mention and timestamp markup carries no words, however it is packed', () => {
  const shapes = [
    '<:wow:123456789012345678>',
    '<a:dance:123456789012345678>'.repeat(40),
    `${'<:a:1>'.repeat(300)}`,
    '<:long_name_with_digits_123:12345678901234567890>'.repeat(30),
    '<:x:1> \n <a:y:22> \t <:z:333>'.repeat(50),
    '<@123456789012345678><@!123456789012345678><@&123456789012345678><#123456789012345678>'.repeat(20),
    '</help:123456789012345678> <t:1700000000:R> <t:-5> @everyone @here'.repeat(20),
    `${'<:wow:123456789012345678>'.repeat(70)}`.slice(0, AI_SPAM_LIMITS.inspectMaxLength),
  ];
  for (const text of shapes) {
    assert.equal(classifyMeaningless(text), 'empty', text.slice(0, 50));
    const { ask } = makeGuard();
    const verdict = ask(text);
    assert.deepEqual([verdict.allowed, verdict.reason], [false, REASONS.MEANINGLESS]);
  }
  // Markup around one real word is the word.
  assert.equal(classifyMeaningless('<:wow:123456789012345678> 你好嗎'), null);
  assert.equal(classifyMeaningless('<:wow:123456789012345678>好'), null);
});

test('three emoji floods in a row are three blocks and start the cooldown', () => {
  const { ask } = makeGuard();
  const flood = '<:wow:123456789012345678>'.repeat(30);
  const verdicts = [flood, `${flood}<a:x:1>`, `${flood}<a:y:2>`].map((text) => ask(text));
  assert.deepEqual(verdicts.map((verdict) => verdict.reason), Array(3).fill(REASONS.MEANINGLESS));
  assert.equal(verdicts[2].cooldownStarted, true);
  assert.equal(ask('現在可以問問題嗎').reason, REASONS.COOLDOWN);
});

function prepareChat(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-attack-flood-'));
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
  const generateChatReplyImpl = async () => { providerCalls += 1; return `小吉回覆第${providerCalls}則`; };
  const send = (content, { channelId = '900000000000000010', userId = '900000000000000011' } = {}) => {
    sequence += 1;
    return handleMentionMessage({
      id: `90000000000${String(sequence).padStart(7, '0')}`,
      content: `<@${BOT_ID}> ${content}`,
      author: { id: userId, username: 'attacker', tag: 'attacker', bot: false },
      member: { displayName: 'Attacker' },
      client: { user: { id: BOT_ID } },
      guildId: null,
      channelId,
      stickers: { size: 0 },
      attachments: { size: 0 },
      createdTimestamp: Date.now(),
      async reply(payload) { sent.push(payload); },
      channel: { async send(payload) { sent.push(payload); } },
    }, {
      generateChatReplyImpl,
      statusPort: { recordInteraction: async () => {} },
    });
  };
  return { sent, send, providerCalls: () => providerCalls, tick: (ms) => t.mock.timers.tick(ms) };
}

test('a mentioned custom-emoji flood gets at most one fixed line, never reaches the model and earns no strike', async (t) => {
  const chat = prepareChat(t);
  const flood = '<:wow:123456789012345678>'.repeat(50);
  for (let index = 0; index < 8; index += 1) {
    await chat.send(index % 2 ? `${flood}<a:dance:1>` : flood);
    chat.tick(5_000);
  }
  assert.equal(chat.providerCalls(), 0);
  assert.ok(chat.sent.length <= 1, `${chat.sent.length} replies`);
  for (const payload of chat.sent) {
    assert.equal(payload.content, AI_SPAM_PRESENCE_REPLY);
    assert.deepEqual(payload.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  }
  // The flood never counted against the member: an ordinary question right after is answered.
  await chat.send('今天晚上吃什麼好呢');
  assert.equal(chat.providerCalls(), 1);
});

// ---------------------------------------------------------------------------------------------
// A crowd of members and channels, and the member in a cooldown
// ---------------------------------------------------------------------------------------------

test('a crowd of distinct members and channels cannot grow the gate past its caps or evict a cooldown', (t) => {
  const { guard, clock, ask } = makeGuard();
  const cooling = Array.from({ length: 10 }, (_, index) => syntheticUser(900_000 + index));
  for (const userId of cooling) {
    for (let strike = 0; strike < 3; strike += 1) ask('。。。', { userId, channelId: syntheticChannel(1) });
  }
  const crowd = AI_SPAM_LIMITS.maxTrackedUsers + 600;
  const channels = AI_SPAM_LIMITS.maxTrackedChannels + 500;
  const began = process.hrtime.bigint();
  for (let index = 0; index < crowd; index += 1) {
    clock.value += 5;
    const verdict = ask(`第${index}位成員的問題是什麼呢`, { userId: syntheticUser(index), channelId: syntheticChannel(index % channels) });
    assert.equal(verdict.allowed, true, String(index));
  }
  const elapsedTotal = Number(process.hrtime.bigint() - began) / 1e6;
  assert.deepEqual(guard.getStatsForTests(),
    { trackedUsers: AI_SPAM_LIMITS.maxTrackedUsers, trackedChannels: AI_SPAM_LIMITS.maxTrackedChannels });
  // The members that were cooling down outlasted the whole crowd.
  for (const userId of cooling) assert.equal(ask('還在冷卻嗎', { userId }).reason, REASONS.COOLDOWN, userId);
  t.diagnostic(`${crowd} distinct members in ${elapsedTotal.toFixed(0)} ms`);
});

test('the oldest channel is forgotten first', () => {
  const { guard, clock, ask } = makeGuard({ maxTrackedChannels: 6 });
  for (let index = 0; index < 20; index += 1) {
    clock.value += 1_000;
    ask(`問題${index}號是什麼`, { userId: syntheticUser(index), channelId: syntheticChannel(index) });
  }
  assert.equal(guard.getStatsForTests().trackedChannels, 6);
  for (let index = 14; index < 20; index += 1) assert.equal(guard.channels.has(syntheticChannel(index)), true, `channel ${index}`);
  assert.equal(guard.channels.has(syntheticChannel(0)), false);
});

test('a crowd of newcomers never evicts a member in a cooldown, and the cooldown that ends soonest goes first', () => {
  const cap = 4;
  const startCooldown = (ask, userId) => {
    for (let strike = 0; strike < 3; strike += 1) ask('。。。', { userId, channelId: syntheticChannel(7) });
  };
  // The gate keeps its members in a map keyed by guild and member; the tests read it directly.
  const tracked = (guard, userId) => guard.users.has(guildUserKey(userId));

  // Two members with an expired cooldown (level kept for a day) and two cooling down; a newcomer evicts the
  // expired level that was seen first, and a long stream of newcomers only ever replaces the newcomer.
  {
    const { guard, clock, ask } = makeGuard({ maxTrackedUsers: cap });
    startCooldown(ask, 'level-one');
    clock.value += 1_000;
    startCooldown(ask, 'level-two');
    clock.value += 11 * MINUTE;
    startCooldown(ask, 'cool-one');
    clock.value += 1_000;
    startCooldown(ask, 'cool-two');
    assert.equal(guard.getStatsForTests().trackedUsers, cap);
    clock.value += 1_000;
    ask('新來的問題一', { userId: 'newcomer-0', channelId: syntheticChannel(8) });
    assert.deepEqual(['level-one', 'level-two', 'cool-one', 'cool-two'].map((id) => tracked(guard, id)),
      [false, true, true, true]);
    for (let index = 1; index <= 200; index += 1) {
      clock.value += 100;
      ask(`新來的問題${index}`, { userId: `newcomer-${index}`, channelId: syntheticChannel(8) });
    }
    assert.deepEqual(['level-two', 'cool-one', 'cool-two'].map((id) => tracked(guard, id)), [true, true, true]);
    assert.equal(guard.getStatsForTests().trackedUsers, cap);
  }

  // Everyone is cooling down: the cooldown that ends soonest is the one given up, the others stay.
  {
    const { guard, clock, ask } = makeGuard({ maxTrackedUsers: 3 });
    for (const id of ['cool-a', 'cool-b', 'cool-c']) {
      startCooldown(ask, id);
      clock.value += 1_000;
    }
    ask('新來的問題', { userId: 'newcomer', channelId: syntheticChannel(8) });
    assert.deepEqual(['cool-a', 'cool-b', 'cool-c', 'newcomer'].map((id) => tracked(guard, id)),
      [false, true, true, true]);
    // The evicted member is simply counted from scratch.
    assert.equal(ask('我回來了', { userId: 'cool-a', channelId: syntheticChannel(8) }).allowed, true);
  }
});
