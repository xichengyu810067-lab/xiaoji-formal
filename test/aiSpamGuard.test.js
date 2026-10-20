'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-ai-spam-suite-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const {
  AI_SPAM_BLOCK_REASONS: REASONS,
  AI_SPAM_LIMITS,
  AI_SPAM_NOTICES,
  AI_SPAM_PRESENCE_REPLY,
  AiSpamGuard,
  TURTLE_SOUP_SPAM_LIMITS,
  aiSpamGuard,
  classifyMeaningless,
  isNearDuplicate,
  repeatKey,
  turtleSoupSpamGuard,
} = require('../src/systems/conversation/aiSpamGuard');
const { MENTION_OUTCOME, handleMentionMessage } = require('../src/systems/conversation/chatFlow');
const { providerCallGuard } = require('../src/systems/conversation/providerGuard');
const {
  clearConversationSafetyEventHandlerForTests,
  setConversationSafetyEventHandler,
} = require('../src/systems/conversation/safetyEvents');
const { setSafetyEventHandler } = require('../src/platform/safetyEventCatalog');
const { sanitizeUserFacingOutput } = require('../src/systems/conversation/userFacingOutputPolicy');
const testControlObservation = require('../src/platform/testControlObservation');
const logger = require('../src/utils/logger');
const { clearMemoryForTests } = require('../src/systems/conversation/projection');
const {
  getRecentConversationTurns,
  resetConversationHistoryForTests,
} = require('../src/services/conversationHistoryService');
const {
  clearConversationStateForTests,
  hasActiveConversation,
  isConversationSilenced,
} = require('../src/services/conversationModeService');
const { openArchive } = require('../src/systems/conversation/aiArchive');
const {
  ARCHIVE_POLICY_VERSION,
  closeArchiveForTests,
  configureArchivePathResolver,
  getArchive,
} = require('../src/services/aiArchiveService');

const MINUTE = 60_000;
const GUILD = '111111111111111111';
const OTHER_GUILD = '121212121212121212';
const CHANNEL = '222222222222222222';
const OTHER_CHANNEL = '232323232323232323';
const USER = '333333333333333333';

// ---------------------------------------------------------------------------------------------
// Meaningless content
// ---------------------------------------------------------------------------------------------

// Ordinary short messages, Chinese and English, that must reach 小吉.
const ALLOWED_CORPUS = Object.freeze([
  '嗨', '早安', '？', '在嗎', '謝謝', '哈哈', '你好', '晚安', '好', '嗯', '哈哈哈', '哈哈哈哈哈', '謝謝謝謝',
  '測試測試測試', '在嗎？？', '早安～～～', '今天天氣如何？', '推薦一首歌', '小吉你好可愛😂', '👍好喔', '666', '66666', '88',
  '1+1=?', '??', '？？？', 'hi', 'Hello!', 'ok', 'lol', 'XD', 'Thanks!!', 'what?', 'abcabc',
  '<:pepe:123456789012345678> 你好', '<@123456789012345678> 你覺得呢',
]);

// Nothing but marks, or one character or short piece over and over.
const BLOCKED_CORPUS = Object.freeze([
  ['aaaaaaa', 'repeated'],
  ['哈哈哈哈哈哈哈哈哈哈', 'repeated'],
  ['。。。。', 'empty'],
  ['666666', 'repeated'],
  ['', 'empty'],
  ['   ', 'empty'],
  ['😂😂😂', 'empty'],
  ['👍', 'empty'],
  ['❤️', 'empty'],
  ['🇹🇼', 'empty'],
  ['<:pepe:123456789012345678>', 'empty'],
  ['<a:dance:123456789012345678> <a:dance:123456789012345678>', 'empty'],
  ['<@123456789012345678> <@&234567890123456789> <#345678901234567890>', 'empty'],
  ['@everyone', 'empty'],
  ['!!!!!!', 'empty'],
  ['!', 'empty'],
  ['......', 'empty'],
  ['…', 'empty'],
  ['～～～', 'empty'],
  ['？？？？？？', 'empty'],
  ['???????', 'empty'],
  ['1111111', 'repeated'],
  ['ㄏㄏㄏㄏㄏㄏ', 'repeated'],
  ['ｗｗｗｗｗｗ', 'repeated'],
  ['wwwwwwww', 'repeated'],
  ['對對對對對對', 'repeated'],
  ['哈囉哈囉哈囉哈囉', 'repeated'],
  ['abababab', 'repeated'],
  ['lolololol', 'repeated'],
  ['HAHAHAHAHAHA', 'repeated'],
  ['test test test test', 'repeated'],
  ['哈哈哈哈哈哈 😂😂 <:lol:123456789012345678>', 'repeated'],
]);

test('ordinary short messages are not meaningless, in Chinese and in English', () => {
  assert.ok(ALLOWED_CORPUS.length >= 15);
  for (const text of ALLOWED_CORPUS) assert.equal(classifyMeaningless(text), null, text);
});

test('marks only, or one character or short piece over and over, is meaningless', () => {
  assert.ok(BLOCKED_CORPUS.length >= 15);
  for (const [text, kind] of BLOCKED_CORPUS) assert.equal(classifyMeaningless(text), kind, text);
});

test('the meaningless thresholds sit exactly where the limits say', () => {
  const single = AI_SPAM_LIMITS.singleCharacterRunToBlock;
  assert.equal(classifyMeaningless('哈'.repeat(single - 1)), null);
  assert.equal(classifyMeaningless('哈'.repeat(single)), 'repeated');
  const units = AI_SPAM_LIMITS.shortUnitRepeatsToBlock;
  assert.equal(classifyMeaningless('哈囉'.repeat(units - 1)), null);
  assert.equal(classifyMeaningless('哈囉'.repeat(units)), 'repeated');
  // A piece longer than the short-unit limit repeated any number of times is left alone.
  assert.equal(classifyMeaningless('早安你好啊'.repeat(10)), null);
  // Up to three question marks are a question; more are not.
  assert.equal(classifyMeaningless('?'.repeat(AI_SPAM_LIMITS.questionOnlyMaxLength)), null);
  assert.equal(classifyMeaningless('?'.repeat(AI_SPAM_LIMITS.questionOnlyMaxLength + 1)), 'empty');
  assert.equal(classifyMeaningless('!?'), null);
  assert.equal(classifyMeaningless('!!'), 'empty');
});

// ---------------------------------------------------------------------------------------------
// The gate on its own, with a controlled clock
// ---------------------------------------------------------------------------------------------

function makeGuard(limits = {}) {
  const clock = { value: 1_000_000 };
  const logs = [];
  const observed = [];
  const guard = new AiSpamGuard({
    limits,
    now: () => clock.value,
    logger: { info: (line) => logs.push(line), warn: (line) => logs.push(line) },
    observe: (code) => observed.push(code),
  });
  const ask = (text, { guildId = GUILD, channelId = CHANNEL, userId = USER, explicit = true } = {}) =>
    guard.evaluate({ guildId, channelId, userId, text, explicit });
  return { guard, clock, logs, observed, ask };
}

test('the same or nearly the same words a third time within ten minutes are blocked', () => {
  const { clock, ask } = makeGuard();
  assert.equal(ask('幫我推薦一首歌').allowed, true);
  clock.value += 2 * MINUTE;
  // Spacing, punctuation, case and emoji do not make the words new.
  assert.equal(ask('幫我 推薦一首歌！！😂').allowed, true);
  clock.value += 2 * MINUTE;
  const third = ask('幫我推薦一首歌吧');
  assert.deepEqual([third.allowed, third.reason], [false, REASONS.REPEAT]);
  assert.equal(third.notice, AI_SPAM_NOTICES[REASONS.REPEAT]);

  // Different words are not repeats.
  assert.equal(ask('今天晚上吃什麼').allowed, true);
  // Once the first copy is ten minutes old, the words may be said again.
  clock.value += 6 * MINUTE + 1;
  assert.equal(ask('幫我推薦一首歌').allowed, true);
});

test('Hangul fillers between the characters do not make a repeat new', () => {
  const { clock, ask } = makeGuard();
  const base = '幫我推薦一首適合晚上聽的歌';
  const filled = [...base].join(String.fromCodePoint(0x3164));
  assert.equal(ask(base).allowed, true);
  clock.value += 2 * MINUTE;
  assert.equal(ask(filled).allowed, true);
  clock.value += 2 * MINUTE;
  const third = ask(filled);
  assert.deepEqual([third.allowed, third.reason], [false, REASONS.REPEAT]);
  // Every Hangul filler is left out of the repeat key.
  for (const filler of [0x115f, 0x1160, 0x3164, 0xffa0]) {
    assert.equal(repeatKey([...base].join(String.fromCodePoint(filler))).hash, repeatKey(base).hash);
  }
  // Different words stay different.
  assert.equal(isNearDuplicate(repeatKey(filled), repeatKey('今天晚上吃什麼')), false);
});

test('Japanese voiced marks and Vietnamese letters keep words apart in the repeat check', () => {
  const { clock, ask } = makeGuard();
  // Five different Japanese requests a minute apart; が is not か and ぎ is not き.
  for (const text of ['かきが食べたい', 'かぎが食べたい', 'がきが食べたい', 'がぎが食べたい', 'かきか食べたい']) {
    assert.equal(ask(text).allowed, true, text);
    clock.value += MINUTE;
  }
  for (const [first, second] of [['がっこう', 'かっこう'], ['ぱん', 'はん'], ['ばか', 'はか'], ['phở', 'phố'], ['việt', 'viet'],
    ['ăn', 'an']]) {
    assert.notEqual(repeatKey(first).hash, repeatKey(second).hash, `${first} ${second}`);
  }
});

test('the repeat check compares a bounded head and keeps different questions apart', () => {
  assert.equal(isNearDuplicate(repeatKey('台北明天天氣如何'), repeatKey('台中明天天氣如何')), false);
  assert.equal(isNearDuplicate(repeatKey('1+1等於多少'), repeatKey('1+2等於多少')), false);
  assert.equal(isNearDuplicate(repeatKey('推薦一首歌給我'), repeatKey('推薦一首歌給我吧')), true);
  assert.equal(isNearDuplicate(repeatKey('早安'), repeatKey('晚安')), false);
  assert.equal(isNearDuplicate(repeatKey('Hello there!'), repeatKey('hello   THERE')), true);
  // Arithmetic signs are kept, so different sums are different questions.
  const sums = ['1*1=?', '1-1=?', '1+1=?', '1/1=?', '1^1=?', '1%1=?', '1<1?', '1>1?', '1=1?'];
  assert.equal(new Set(sums.map((sum) => repeatKey(sum).head)).size, sums.length);
  assert.equal(isNearDuplicate(repeatKey('請問 12*34 等於多少'), repeatKey('請問 12-34 等於多少')), false);
  assert.equal(isNearDuplicate(repeatKey('1 * 1 = ?'), repeatKey('1*1=？')), true);
  const long = '很長的內容'.repeat(400);
  assert.equal(repeatKey(long).head.length, AI_SPAM_LIMITS.repeatEndLength);
  assert.equal(repeatKey(long).tail.length, AI_SPAM_LIMITS.repeatEndLength);
  assert.equal(repeatKey(long).length, 2_000);
});

test('one member is limited to five requests a minute and twenty in ten minutes, per guild', () => {
  const { clock, ask } = makeGuard();
  const perMinute = AI_SPAM_LIMITS.userShortMaxRequests;
  for (let index = 0; index < perMinute; index += 1) assert.equal(ask(`第${index}個問題是什麼`).allowed, true);
  const over = ask('第九個問題是什麼');
  assert.deepEqual([over.allowed, over.reason], [false, REASONS.USER_RATE]);
  // Sums that differ only in their sign are not repeats of each other.
  const { ask: sumAsk } = makeGuard();
  for (const sum of ['1*1=?', '1-1=?', '1/1=?']) assert.equal(sumAsk(sum).allowed, true, sum);
  // Another guild is counted on its own.
  assert.equal(ask('另一個伺服器的問題', { guildId: OTHER_GUILD }).allowed, true);
  // A minute later the member may ask again.
  clock.value += MINUTE;
  assert.equal(ask('一分鐘後的問題').allowed, true);

  // Twenty in ten minutes: spread out so that the per-minute limit never applies.
  const { clock: slowClock, ask: slowAsk } = makeGuard();
  // Short questions with nothing in common, so that only the rate can block them.
  const question = (index) => `問${String.fromCodePoint(0x4E00 + index * 37)}${String.fromCodePoint(0x6E00 + index * 53)}`;
  for (let index = 0; index < AI_SPAM_LIMITS.userLongMaxRequests; index += 1) {
    assert.equal(slowAsk(question(index)).allowed, true, String(index));
    slowClock.value += 25_000;
  }
  const overLong = slowAsk(question(99));
  assert.deepEqual([overLong.allowed, overLong.reason], [false, REASONS.USER_RATE]);
});

test('everyone in one channel together is limited to ten requests a minute, without blaming anyone', () => {
  const { clock, ask } = makeGuard();
  for (let index = 0; index < AI_SPAM_LIMITS.channelMaxRequests; index += 1) {
    assert.equal(ask(`成員${index}的問題`, { userId: `4000000000000000${10 + index}` }).allowed, true);
  }
  const flooded = ask('第十一位成員的問題', { userId: '400000000000000099' });
  assert.deepEqual([flooded.allowed, flooded.reason], [false, REASONS.CHANNEL_FLOOD]);
  assert.equal(flooded.notice, AI_SPAM_NOTICES[REASONS.CHANNEL_FLOOD]);
  // One flood notice per channel per window, whoever asks next.
  const again = ask('第十二位成員的問題', { userId: '400000000000000098' });
  assert.equal(again.reason, REASONS.CHANNEL_FLOOD);
  assert.equal(again.notice, null);
  // A flood is not the member's fault: it never leads to a cooldown.
  for (let index = 0; index < 5; index += 1) ask(`又一個問題${index}`, { userId: '400000000000000099' });
  // Another channel is not affected.
  assert.equal(ask('別的頻道的問題', { channelId: OTHER_CHANNEL, userId: '400000000000000099' }).allowed, true);
  clock.value += MINUTE;
  assert.equal(ask('一分鐘後的問題', { userId: '400000000000000099' }).allowed, true);
});

test('three blocks in ten minutes start a cooldown of 10 minutes, then 30 minutes, then 2 hours at most', () => {
  const { clock, ask, observed, logs } = makeGuard();
  const startCooldown = () => {
    const results = ['', '', ''].map(() => ask('。。。'));
    assert.deepEqual(results.map((result) => result.reason), [REASONS.MEANINGLESS, REASONS.MEANINGLESS,
      REASONS.MEANINGLESS]);
    assert.deepEqual(results.map((result) => result.cooldownStarted), [false, false, true]);
    return results;
  };

  const first = startCooldown();
  assert.equal(first[0].notice, AI_SPAM_NOTICES[REASONS.MEANINGLESS]);
  assert.equal(first[1].notice, null);
  assert.equal(first[2].notice, '短時間內被擋下太多次，你的 AI 對話暫停 10 分鐘。');
  // Even an ordinary question waits for the cooldown, silently.
  const during = ask('現在可以聊天了嗎');
  assert.deepEqual([during.allowed, during.reason, during.notice], [false, REASONS.COOLDOWN, null]);
  clock.value += 10 * MINUTE - 1;
  assert.equal(ask('還在冷卻嗎').reason, REASONS.COOLDOWN);
  clock.value += 1;
  assert.equal(ask('冷卻結束了吧').allowed, true);

  clock.value += MINUTE;
  assert.equal(startCooldown()[2].notice, '短時間內被擋下太多次，你的 AI 對話暫停 30 分鐘。');
  clock.value += 30 * MINUTE;
  assert.equal(startCooldown()[2].notice, '短時間內被擋下太多次，你的 AI 對話暫停 2 小時。');
  clock.value += 2 * 60 * MINUTE;
  // The steps stop at the last one.
  assert.equal(startCooldown()[2].notice, '短時間內被擋下太多次，你的 AI 對話暫停 2 小時。');

  // A day after the last cooldown ended without another, the member starts from the first step again.
  clock.value += 2 * 60 * MINUTE + AI_SPAM_LIMITS.cooldownLevelResetMs;
  assert.equal(startCooldown()[2].notice, '短時間內被擋下太多次，你的 AI 對話暫停 10 分鐘。');

  assert.equal(observed.filter((code) => code === 'TEST_OBS_AI_SPAM_COOLDOWN_STARTED').length, 5);
  assert.ok(observed.includes('TEST_OBS_AI_SPAM_COOLDOWN'));
  const cooldownLines = logs.filter((line) => line.includes('AI_SPAM_COOLDOWN_STARTED'));
  assert.ok(cooldownLines.length > 0);
  assert.match(cooldownLines[0], /^\[AI_SPAM\] code=AI_SPAM_COOLDOWN_STARTED level=1 minutes=10 guild=\d+ user=\d+$/u);
});

test('blocks spread over more than ten minutes do not add up to a cooldown', () => {
  const { clock, ask } = makeGuard();
  ask('。。。');
  clock.value += 6 * MINUTE;
  ask('。。。');
  clock.value += 6 * MINUTE;
  const third = ask('。。。');
  assert.equal(third.cooldownStarted, false);
  assert.equal(ask('正常的問題喔').allowed, true);
});

test('a message that only continues a conversation is never answered with a notice and never counts toward a cooldown', () => {
  const { ask } = makeGuard();
  for (let index = 0; index < 10; index += 1) {
    const result = ask('哈哈哈哈哈哈哈哈', { explicit: false });
    assert.deepEqual([result.allowed, result.reason, result.notice, result.cooldownStarted],
      [false, REASONS.MEANINGLESS, null, false]);
  }
  assert.equal(ask('正常的問題喔').allowed, true);
});

test('notices: one per member per cooldown or ten minutes, and at most three in a channel a minute', () => {
  const { clock, ask } = makeGuard();
  const first = ask('');
  assert.equal(first.notice, AI_SPAM_NOTICES[REASONS.MEANINGLESS]);
  clock.value += 11 * MINUTE;
  // Ten minutes later the same member may be told again.
  assert.equal(ask('').notice, AI_SPAM_NOTICES[REASONS.MEANINGLESS]);

  const { ask: crowdAsk, clock: crowdClock } = makeGuard();
  const notices = [];
  for (let index = 0; index < 8; index += 1) {
    notices.push(crowdAsk('', { userId: `5000000000000000${10 + index}` }).notice);
  }
  assert.equal(notices.filter(Boolean).length, AI_SPAM_LIMITS.channelNoticeMaxPerWindow);
  crowdClock.value += MINUTE;
  assert.equal(crowdAsk('', { userId: '500000000000000099' }).notice, AI_SPAM_NOTICES[REASONS.MEANINGLESS]);
});

test('a member told nothing when a cooldown started, because the channel was out of notices, is told once later', () => {
  const { ask } = makeGuard({ channelNoticeMaxPerWindow: 1 });
  // Another member uses the channel's only notice of the minute.
  assert.ok(ask('', { userId: '600000000000000001' }).notice);
  const results = ['', '', ''].map(() => ask(''));
  assert.equal(results[2].cooldownStarted, true);
  assert.deepEqual(results.map((result) => result.notice), [null, null, null]);
  const { ask: laterAsk, clock } = makeGuard({ channelNoticeMaxPerWindow: 1 });
  laterAsk('', { userId: '600000000000000001' });
  ['', '', ''].forEach(() => laterAsk(''));
  clock.value += MINUTE;
  assert.equal(laterAsk('冷卻中可以說話嗎').notice, '你的 AI 對話暫停中，約 9 分鐘後恢復。');
  assert.equal(laterAsk('冷卻中可以說話嗎二').notice, null);
});

test('memory stays bounded: capped members and channels, expired state swept, cooldowns kept longest', () => {
  const { guard, clock, ask } = makeGuard({ maxTrackedUsers: 20, maxTrackedChannels: 10 });
  const cooling = '700000000000000001';
  ['', '', ''].forEach(() => ask('', { userId: cooling }));
  assert.equal(ask('冷卻中', { userId: cooling }).reason, REASONS.COOLDOWN);
  // Five thousand members, each counted once, spread over more channels than are tracked.
  for (let index = 0; index < 5_000; index += 1) {
    const result = ask(`第${index}位成員的問題`,
      { userId: `8${String(index).padStart(17, '0')}`, channelId: `9${String(index % 50).padStart(17, '0')}` });
    assert.equal(result.allowed, true, String(index));
  }
  assert.deepEqual(guard.getStatsForTests(), { trackedUsers: 20, trackedChannels: 10 });
  // The member cooling down was not evicted by the crowd.
  assert.equal(ask('還在冷卻嗎', { userId: cooling }).reason, REASONS.COOLDOWN);

  // With both maps full, a newcomer in a new channel is counted from the first request on.
  const newcomer = { userId: '700000000000000003', channelId: '700000000000000004' };
  for (let index = 0; index < AI_SPAM_LIMITS.userShortMaxRequests; index += 1) {
    assert.equal(ask(`新來的成員第${index}題`, newcomer).allowed, true);
  }
  assert.equal(ask('新來的成員第九題', newcomer).reason, REASONS.USER_RATE);
  assert.deepEqual(guard.getStatsForTests(), { trackedUsers: 20, trackedChannels: 10 });

  // Once everything has expired, a sweep forgets it all.
  clock.value += AI_SPAM_LIMITS.cooldownLevelResetMs + 3 * 60 * MINUTE;
  ask('最後一個問題', { userId: '700000000000000002' });
  assert.deepEqual(guard.getStatsForTests(), { trackedUsers: 1, trackedChannels: 1 });
});

test('log lines are throttled per reason and carry neither the words nor a name', () => {
  const { clock, ask, logs, observed } = makeGuard();
  const crowd = (from, count) => {
    for (let index = from; index < from + count; index += 1) {
      ask('秘密內容秘密內容秘密內容', { userId: `8${String(index).padStart(17, '0')}`, explicit: false });
    }
  };
  // Ten fill the channel for the minute; the other ninety are blocked, and logged once.
  crowd(0, 100);
  const blockedLines = logs.filter((line) => line.includes('code=AI_SPAM_BLOCKED'));
  assert.deepEqual(blockedLines, ['[AI_SPAM] code=AI_SPAM_BLOCKED reason=channel_flood']);
  // A minute later the next block is logged with the count of the lines left out.
  clock.value += MINUTE;
  crowd(100, 11);
  assert.equal(logs.at(-1), '[AI_SPAM] code=AI_SPAM_BLOCKED reason=channel_flood suppressed=89');
  for (const line of logs) assert.doesNotMatch(line, /秘密|甲/u);
  assert.equal(observed.filter((code) => code === 'TEST_OBS_AI_SPAM_BLOCKED').length, 91);
  assert.equal(observed.filter((code) => code === 'TEST_OBS_AI_SPAM_CHANNEL_FLOOD').length, 91);
});

test('the limits are named constants in one frozen place', () => {
  assert.equal(Object.isFrozen(AI_SPAM_LIMITS), true);
  assert.deepEqual(
    [AI_SPAM_LIMITS.userShortMaxRequests, AI_SPAM_LIMITS.userShortWindowMs, AI_SPAM_LIMITS.userLongMaxRequests,
      AI_SPAM_LIMITS.userLongWindowMs, AI_SPAM_LIMITS.channelMaxRequests, AI_SPAM_LIMITS.channelWindowMs,
      AI_SPAM_LIMITS.repeatWindowMs, AI_SPAM_LIMITS.strikesToCooldown, AI_SPAM_LIMITS.strikeWindowMs],
    [5, MINUTE, 20, 10 * MINUTE, 10, MINUTE, 10 * MINUTE, 3, 10 * MINUTE]);
  assert.deepEqual(AI_SPAM_LIMITS.cooldownStepsMs, [10 * MINUTE, 30 * MINUTE, 120 * MINUTE]);
  assert.equal(AI_SPAM_LIMITS.presenceReplyWindowMs, 10 * MINUTE);
  // The judge: the same meaningless and repeat rules, wider rate limits.
  assert.equal(Object.isFrozen(TURTLE_SOUP_SPAM_LIMITS), true);
  assert.deepEqual([TURTLE_SOUP_SPAM_LIMITS.userShortMaxRequests, TURTLE_SOUP_SPAM_LIMITS.userShortWindowMs,
    TURTLE_SOUP_SPAM_LIMITS.userLongMaxRequests, TURTLE_SOUP_SPAM_LIMITS.userLongWindowMs,
    TURTLE_SOUP_SPAM_LIMITS.repeatWindowMs, TURTLE_SOUP_SPAM_LIMITS.repeatEarlierCopiesToBlock],
  [6, MINUTE, 40, 10 * MINUTE, 10 * MINUTE, 2]);
  assert.throws(() => new AiSpamGuard({ limits: { userShortMaxRequests: 0 } }), TypeError);
  assert.throws(() => new AiSpamGuard({ limits: { cooldownStepsMs: [] } }), TypeError);
});

// ---------------------------------------------------------------------------------------------
// Through the chat flow
// ---------------------------------------------------------------------------------------------

const BOT_ID = '999999999999999999';
const CHAT_USER = '444444444444444444';
const DM_CHANNEL = '555555555555555555';

async function prepareChat(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-ai-spam-'));
  const archivePath = path.join(root, 'conversations.sqlite');
  openArchive({ filePath: archivePath, initialize: { initializationId: 'ai-spam-test' } }).close();
  const names = ['XIAOJI_ARCHIVE_CAPTURE_ENABLED', 'XIAOJI_ARCHIVE_POLICY_VERSION', 'AI_CONVERSATION_PATH',
    'XIAOJI_MEMORY_PATH', 'BOT_OWNER_ID', 'OWNER_ID'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED = 'true';
  process.env.XIAOJI_ARCHIVE_POLICY_VERSION = ARCHIVE_POLICY_VERSION;
  process.env.AI_CONVERSATION_PATH = path.join(root, 'history.json');
  process.env.XIAOJI_MEMORY_PATH = path.join(root, 'memory.json');
  // The member is the Owner: the gate makes no exception for anyone.
  process.env.BOT_OWNER_ID = CHAT_USER;
  configureArchivePathResolver(() => ({ filePath: archivePath }));
  closeArchiveForTests();
  clearConversationStateForTests();
  providerCallGuard.resetForTests();
  await resetConversationHistoryForTests();
  clearMemoryForTests();
  const conversationEvents = [];
  const safetyEvents = [];
  const restoreConversation = setConversationSafetyEventHandler((event) => conversationEvents.push(event));
  const restoreSafety = setSafetyEventHandler((event) => safetyEvents.push(event));
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-10T00:00:00.000Z') });
  t.after(async () => {
    restoreConversation();
    restoreSafety();
    clearConversationSafetyEventHandlerForTests();
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
  let statusRecorded = 0;
  let sequence = 0;
  // The provider spends the real provider guard, as the production provider does.
  const generateChatReplyImpl = async ({ userId, guildId, channelId, userText }) => {
    providerCalls += 1;
    return providerCallGuard.execute({ userId, guildId, channelId }, userText, async () => `小吉回覆第${providerCalls}則`);
  };
  const send = (content, { mention = true, stickers = 0, impl = generateChatReplyImpl, reply = false } = {}) => {
    sequence += 1;
    return handleMentionMessage({
      ...(reply ? { reference: { messageId: '600000000000009999' } } : {}),
      stickers: { size: stickers },
      attachments: { size: 0 },
      id: `60000000000000${String(sequence).padStart(4, '0')}`,
      content: mention ? `<@${BOT_ID}> ${content}` : content,
      author: { id: CHAT_USER, username: '甲', tag: '甲', bot: false },
      member: { displayName: '甲' },
      client: { user: { id: BOT_ID } },
      guildId: null,
      channelId: DM_CHANNEL,
      createdTimestamp: Date.now(),
      async reply(payload) { sent.push(payload); },
      channel: {
        async send(payload) { sent.push(payload); },
        // The message replied to is one of 小吉's.
        messages: { async fetch() { return { author: { id: BOT_ID } }; } },
      },
    }, {
      generateChatReplyImpl: impl,
      statusPort: { recordInteraction: async () => { statusRecorded += 1; } },
    });
  };
  const attempts = () => providerCallGuard.users.get(`\u0000${CHAT_USER}`)?.attempts.length ?? 0;
  const turns = () => getRecentConversationTurns({ userId: CHAT_USER, guildId: null, channelId: DM_CHANNEL }).length;
  const archived = () => getArchive().listEvents({ userId: CHAT_USER, scope: 'dm', channelId: DM_CHANNEL }).rows.length;
  return {
    sent, send, attempts, turns, archived, conversationEvents, safetyEvents,
    providerCalls: () => providerCalls,
    statusRecorded: () => statusRecorded,
    tick: (ms) => t.mock.timers.tick(ms),
  };
}

test('ordinary conversation is answered as before', async (t) => {
  const chat = await prepareChat(t);
  for (const text of ['嗨', '早安', '在嗎', '謝謝', '哈哈', '？']) {
    assert.equal(await chat.send(text), undefined, text);
    chat.tick(MINUTE);
  }
  assert.equal(chat.providerCalls(), 6);
  assert.equal(chat.sent.length, 6);
  chat.sent.forEach((payload, index) => assert.match(payload.content, new RegExp(`小吉回覆第${index + 1}則`, 'u')));
  assert.equal(chat.statusRecorded(), 6);
  assert.equal(chat.turns(), 6);
});

test('a blocked request calls no model, spends no AI quota and writes nothing; only the cooldown it starts is told to the Owner', async (t) => {
  const chat = await prepareChat(t);
  // Five ordinary requests in a minute: answered and counted.
  for (const text of ['第一個問題是什麼', '第二個問題是什麼', '第三個問題是什麼', '第四個問題是什麼', '第五個問題是什麼']) {
    assert.equal(await chat.send(text), undefined);
    chat.tick(5_000);
  }
  const before = {
    providerCalls: chat.providerCalls(), attempts: chat.attempts(), turns: chat.turns(), archived: chat.archived(),
    statusRecorded: chat.statusRecorded(), replies: chat.sent.length,
  };
  assert.deepEqual({ ...before, archived: before.archived > 0, attempts: before.attempts > 0 },
    { providerCalls: 5, attempts: true, turns: 5, archived: true, statusRecorded: 5, replies: 5 });

  // A sixth in the same minute, then meaningless content, then the first question again (still too fast).
  const results = [];
  for (const text of ['第六個問題是什麼', '哈哈哈哈哈哈哈哈哈哈', '第一個問題是什麼']) {
    results.push(await chat.send(text));
    chat.tick(1_000);
  }
  for (const result of results) assert.deepEqual(result, { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
  assert.equal(chat.providerCalls(), before.providerCalls);
  assert.equal(chat.attempts(), before.attempts);
  assert.equal(chat.turns(), before.turns);
  assert.equal(chat.archived(), before.archived);
  assert.equal(chat.statusRecorded(), before.statusRecorded);
  assert.deepEqual(chat.conversationEvents, []);
  // The third block started a cooldown: that, and nothing else of the blocks, is reported (as one flood alert); a
  // meaningless message, a repeat or a rate limit by itself is routine.
  assert.deepEqual(chat.safetyEvents.map((event) => [event.code, event.notice?.alertKind]),
    [[SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT, 'flood']]);

  // The third block started a cooldown; the member heard two short fixed notices, neither of which pings.
  const notices = chat.sent.slice(before.replies);
  assert.deepEqual(notices.map((payload) => payload.content),
    [AI_SPAM_NOTICES[REASONS.USER_RATE], '短時間內被擋下太多次，你的 AI 對話暫停 10 分鐘。']);
  for (const payload of notices) {
    assert.deepEqual(payload.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
    assert.doesNotMatch(payload.content, /<@|@everyone|@here|https?:/u);
  }

  // During the cooldown, even ordinary questions are dropped silently.
  for (let index = 0; index < 5; index += 1) {
    assert.deepEqual(await chat.send(`冷卻中的問題${index}`), { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
    chat.tick(10_000);
  }
  assert.equal(chat.sent.length, before.replies + 2);
  assert.equal(chat.providerCalls(), before.providerCalls);

  // After the cooldown the member is answered again.
  chat.tick(10 * MINUTE);
  assert.equal(await chat.send('冷卻結束後的問題'), undefined);
  assert.equal(chat.providerCalls(), before.providerCalls + 1);
});

test('a bare mention or a bare 小吉 gets one fixed line in ten minutes, never the model, never a cooldown', async (t) => {
  const chat = await prepareChat(t);
  assert.deepEqual(await chat.send(''), { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
  chat.tick(5_000);
  // More bare calls inside ten minutes are ignored, and however many there are, none counts against the member.
  for (let index = 0; index < 6; index += 1) {
    assert.deepEqual(await chat.send('小吉', { mention: false }), { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
    assert.deepEqual(await chat.send(''), { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
    chat.tick(5_000);
  }
  assert.equal(chat.providerCalls(), 0);
  assert.equal(chat.attempts(), 0);
  assert.deepEqual(chat.sent.map((payload) => payload.content), [AI_SPAM_PRESENCE_REPLY]);
  assert.deepEqual(chat.sent[0].allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  // The line opens a conversation: the next message needs no mention, and it is answered.
  assert.equal(await chat.send('今天過得好嗎', { mention: false }), undefined);
  assert.equal(chat.providerCalls(), 1);
  chat.tick(5_000);
  // Ten minutes after the line, a bare call is answered again.
  chat.tick(10 * MINUTE);
  await chat.send('');
  assert.deepEqual(chat.sent.map((payload) => payload.content).filter((text) => text === AI_SPAM_PRESENCE_REPLY).length, 2);
  // A message that starts with 小吉 and says something is a request like a mention.
  chat.tick(5_000);
  assert.equal(await chat.send('小吉，你喜歡什麼歌', { mention: false }), undefined);
  assert.equal(chat.providerCalls(), 2);
});

test('a mention with a sticker is meaningless, and only repeated blocks start a cooldown', async (t) => {
  const chat = await prepareChat(t);
  assert.deepEqual(await chat.send('', { stickers: 1 }), { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
  assert.deepEqual(chat.sent.map((payload) => payload.content), [AI_SPAM_NOTICES[REASONS.MEANINGLESS]]);
  chat.tick(5_000);
  // One block is only a notice: the member is answered right after.
  assert.equal(await chat.send('推薦一首輕鬆的歌'), undefined);
  chat.tick(5_000);
  await chat.send('😂', { stickers: 1 });
  chat.tick(5_000);
  await chat.send('哈哈哈哈哈哈哈哈');
  // The third block within ten minutes starts the cooldown.
  assert.equal(chat.sent.at(-1).content, '短時間內被擋下太多次，你的 AI 對話暫停 10 分鐘。');
  assert.equal(chat.providerCalls(), 1);
});

test('a mention or 小吉 with only punctuation or emoji is a bare call; with question marks it is a question', async (t) => {
  const chat = await prepareChat(t);
  const bareCalls = [['小吉！', false], ['小吉～', false], ['~', true], ['小吉...', false], ['😂😂😂', true],
    ['<:pepe:123456789012345678>', true], ['。。。。', true], ['小吉 !!!', false]];
  for (const [text, mention] of bareCalls) {
    assert.deepEqual(await chat.send(text, { mention }), { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE }, text);
    chat.tick(5_000);
  }
  // One fixed line in ten minutes, never the model, and never a cooldown.
  assert.deepEqual(chat.sent.map((payload) => payload.content), [AI_SPAM_PRESENCE_REPLY]);
  assert.equal(chat.providerCalls(), 0);
  // "小吉？" asks something: it is a request like any other.
  chat.tick(5_000);
  assert.equal(await chat.send('小吉？', { mention: false }), undefined);
  assert.equal(chat.providerCalls(), 1);
});

test('a continuing message is gated silently and a stop request during a cooldown is not acknowledged', async (t) => {
  const chat = await prepareChat(t);
  assert.equal(await chat.send('我們來聊天吧'), undefined);
  chat.tick(5_000);
  // In a conversation, a message without a mention is a request too; a meaningless one is dropped silently.
  assert.deepEqual(await chat.send('哈哈哈哈哈哈哈哈', { mention: false }), { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
  chat.tick(5_000);
  assert.equal(await chat.send('對啊我也這麼覺得', { mention: false }), undefined);
  assert.equal(chat.providerCalls(), 2);
  assert.equal(chat.sent.length, 2);

  // Three meaningless mentions start a cooldown, which also ends the conversation.
  for (let index = 0; index < 3; index += 1) {
    await chat.send('哈哈哈哈哈哈哈哈');
    chat.tick(1_000);
  }
  const probe = { guildId: null, channelId: DM_CHANNEL, author: { id: CHAT_USER } };
  assert.equal(hasActiveConversation(probe), false);
  const repliesBefore = chat.sent.length;
  // A stop request still silences 小吉, but is not acknowledged while cooling down.
  assert.deepEqual(await chat.send('閉嘴'), { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
  assert.equal(isConversationSilenced(probe), true);
  assert.equal(chat.sent.length, repliesBefore);
});

test('a stop request repeated to flood the channel is gated like any other request', async (t) => {
  const chat = await prepareChat(t);
  // Six seconds apart, so neither the 3-second channel cooldown nor the provider guard's own rate
  // (4 in 20 seconds) holds an acknowledgement back: only the gate does.
  for (let index = 0; index < 8; index += 1) {
    await chat.send(`你可以安靜一點嗎${index}`);
    chat.tick(6_000);
  }
  assert.deepEqual(chat.sent.map((payload) => payload.content), [
    ...Array(AI_SPAM_LIMITS.userShortMaxRequests).fill('好，我先安靜。'),
    AI_SPAM_NOTICES[REASONS.USER_RATE], '短時間內被擋下太多次，你的 AI 對話暫停 10 分鐘。']);
  assert.equal(chat.providerCalls(), 0);
  assert.deepEqual(chat.conversationEvents, []);
});

test('test-control observes blocks and AI reply clean-ups, which are logged once a minute and not sent to the Owner', async (t) => {
  const symbol = Symbol.for('xiaoji.testControlRuntimeController');
  const previousController = globalThis[symbol];
  const previousContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = '1';
  globalThis[symbol] = Object.freeze({ active: true });
  testControlObservation._testReset();
  const warnings = [];
  t.mock.method(logger, 'warn', (line) => { warnings.push(line); });
  t.mock.method(logger, 'info', () => {});
  t.after(() => {
    testControlObservation._testReset();
    if (previousController === undefined) delete globalThis[symbol]; else globalThis[symbol] = previousController;
    if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = previousContext;
  });

  const chat = await prepareChat(t);
  await chat.send('哈哈哈哈哈哈哈哈');
  assert.equal(testControlObservation.snapshot().TEST_OBS_AI_SPAM_BLOCKED, 1);
  assert.equal(testControlObservation.snapshot().TEST_OBS_AI_SPAM_MEANINGLESS, 1);
  assert.equal(testControlObservation.snapshot().TEST_OBS_AI_SPAM_NOTICE, 1);

  // A minute past any earlier line of the clean-up log in this process.
  chat.tick(10 * MINUTE);
  for (let index = 0; index < 20; index += 1) {
    assert.equal(sanitizeUserFacingOutput(`看 https://evil.example/${index} @here`), '看 [連結已移除] [提及已移除]');
  }
  const snapshot = testControlObservation.snapshot();
  assert.equal(snapshot.TEST_OBS_AI_OUTPUT_URL_BLOCKED, 20);
  assert.equal(snapshot.TEST_OBS_AI_OUTPUT_MENTION_BLOCKED, 20);
  assert.deepEqual(warnings.filter((line) => line.startsWith('[AI_OUTPUT]')),
    ['[AI_OUTPUT] code=AI_OUTPUT_URL_BLOCKED', '[AI_OUTPUT] code=AI_OUTPUT_MENTION_BLOCKED']);
  chat.tick(MINUTE);
  sanitizeUserFacingOutput('看 https://evil.example/later');
  assert.equal(warnings.filter((line) => line.startsWith('[AI_OUTPUT]')).at(-1),
    '[AI_OUTPUT] code=AI_OUTPUT_URL_BLOCKED suppressed=19');
  for (const line of warnings) assert.doesNotMatch(line, /evil\.example/u);
  // The events themselves are still reported to the hook; the catalogue keeps them from the Owner.
  assert.equal(chat.conversationEvents.length, 41);
});

test('the shared gate is the one the chat flow uses and the conversation test reset clears it', () => {
  const guard = aiSpamGuard;
  ['', '', ''].forEach(() => guard.evaluate({ guildId: GUILD, channelId: CHANNEL, userId: USER, text: '' }));
  assert.ok(guard.getStatsForTests().trackedUsers > 0);
  clearConversationStateForTests();
  assert.deepEqual(guard.getStatsForTests(), { trackedUsers: 0, trackedChannels: 0 });
});

test('the gate makes no exception for the Owner, a guild or an extension: it loads nothing that could tell them apart', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'systems', 'conversation', 'aiSpamGuard.js'), 'utf8');
  const requires = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/gu)].map((match) => match[1]);
  assert.deepEqual(requires.sort(),
    ['../../platform/testControlObservation', '../../utils/logger', './fixedCodeLog', 'node:crypto']);
  assert.doesNotMatch(source.replace(/^\s*\/\/.*$/gmu, ''), /process\.env|isBotOwner|ownerId|protected|extension/iu);
  // A guild listed as protected is limited like any other.
  const previous = process.env.XIAOJI_PROTECTED_GUILD_IDS;
  process.env.XIAOJI_PROTECTED_GUILD_IDS = GUILD;
  try {
    const { ask } = makeGuard();
    for (let index = 0; index < AI_SPAM_LIMITS.userShortMaxRequests; index += 1) {
      assert.equal(ask(`受保護伺服器的問題${index}號`).allowed, true);
    }
    assert.equal(ask('受保護伺服器的問題九號').reason, REASONS.USER_RATE);
  } finally {
    if (previous === undefined) delete process.env.XIAOJI_PROTECTED_GUILD_IDS; else process.env.XIAOJI_PROTECTED_GUILD_IDS = previous;
  }
});

// ---------------------------------------------------------------------------------------------
// Owner notices a member can cause, the guild AI quota and the turtle soup judge
// ---------------------------------------------------------------------------------------------

const { SAFETY_EVENT_CODES } = require('../src/platform/safetyEventCatalog');
const { INTERNAL_REPLY } = require('../src/systems/conversation/disclosurePolicy');
const {
  GuildQuotaExhaustedError,
  QUOTA_EXHAUSTED_MESSAGE,
  generateChatReply,
} = require('../src/systems/conversation/provider');
const { ProviderCallGuard } = require('../src/systems/conversation/providerGuard');
const { getGuildQuota, quotaPath, resetGuildQuota, setGuildQuota } = require('../src/services/quotaService');
const { createJudgeProvider } = require('../src/systems/games/board/turtleSoup/providerAdapter');
const {
  SPAM_BLOCKED_MESSAGES,
  safeJudgeFailure,
} = require('../src/systems/games/board/discord/turtleSoupDiscordAdapter');

test('a refused request is reported as a dev-info security alert, never as the old per-member refusal code', async (t) => {
  const chat = await prepareChat(t);
  for (let index = 0; index < 50; index += 1) {
    assert.deepEqual(await chat.send('What model are you?'), { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
    // Eleven minutes apart, so the anti-spam gate never calls it a repeat; fifty of them stay within a day.
    chat.tick(11 * MINUTE);
  }
  assert.equal(chat.sent.length, 50);
  assert.ok(chat.sent.every((payload) => payload.content === INTERNAL_REPLY));
  const refusals = chat.safetyEvents.filter((event) => [SAFETY_EVENT_CODES.AI_REQUEST_REFUSED,
    SAFETY_EVENT_CODES.AI_PROMPT_INJECTION_BLOCKED].includes(event.code));
  assert.deepEqual(refusals, [], 'the old refusal codes are no longer raised');
  // Every refusal is an alert; the notifier merges them (one DM per guild and kind an hour), so the count here is
  // the number of refusals and the DM count is tested with the real notifier.
  const alerts = chat.safetyEvents.filter((event) => event.code === SAFETY_EVENT_CODES.OWNER_EVENT_SECURITY_ALERT);
  assert.equal(alerts.length, 50);
  assert.ok(alerts.every((event) => event.notice.alertKind === 'dev-info' && event.actorId === CHAT_USER));
  assert.equal(chat.providerCalls(), 0);
});

function quotaTestEnvironment(t) {
  const previousGroq = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  providerCallGuard.resetForTests();
  t.after(() => {
    if (previousGroq === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = previousGroq;
    providerCallGuard.resetForTests();
    resetGuildQuota(GUILD, { clearLimit: true });
  });
  let calls = 0;
  let failing = false;
  const client = {
    responses: {
      async create() {
        calls += 1;
        if (failing) throw new Error('synthetic provider failure');
        return { output_text: '模型回覆' };
      },
    },
  };
  const ask = (userText, { userId = '440000000000000001', guildId = GUILD, openaiClient = client } = {}) =>
    generateChatReply({ userText, displayName: '甲', userId, channelId: CHANNEL, guildId }, { openaiClient, loggerImpl: { warn() {} } });
  return { ask, calls: () => calls, fail: (value) => { failing = value; } };
}

test('the guild AI quota is spent once per real model call and stops the call when it is used up', async (t) => {
  const quota = quotaTestEnvironment(t);
  // With no quota file no guild has a limit, and a model call does not create the file to find that out.
  assert.equal(fs.existsSync(quotaPath), false);
  assert.equal(await quota.ask('還沒有額度檔', { userId: '440000000000000009' }), '模型回覆');
  assert.equal(fs.existsSync(quotaPath), false);
  setGuildQuota(GUILD, 3, 0);

  assert.equal(await quota.ask('第一個問題'), '模型回覆');
  assert.equal(getGuildQuota(GUILD).used, 1);
  // Held back by the provider guard (the same words again at once): no call, nothing spent.
  await assert.rejects(() => quota.ask('第一個問題'), (error) => error.code === 'AI_LOCAL_GUARD_BLOCKED');
  assert.equal(getGuildQuota(GUILD).used, 1);
  // No provider configured: a fixed reply, nothing spent.
  assert.equal(await quota.ask('沒有供應商時', { openaiClient: null }), null);
  assert.equal(getGuildQuota(GUILD).used, 1);
  // A call that fails is still one call, spent once.
  quota.fail(true);
  assert.equal(await quota.ask('會失敗的問題', { userId: '440000000000000002' }), null);
  quota.fail(false);
  assert.equal(getGuildQuota(GUILD).used, 2);
  assert.equal(await quota.ask('第三個問題', { userId: '440000000000000003' }), '模型回覆');
  assert.equal(getGuildQuota(GUILD).used, 3);
  assert.equal(quota.calls(), 4);

  // Used up: the model is not called and nothing more is counted.
  await assert.rejects(() => quota.ask('用完以後', { userId: '440000000000000004' }),
    (error) => error instanceof GuildQuotaExhaustedError);
  assert.equal(quota.calls(), 4);
  assert.equal(getGuildQuota(GUILD).used, 3);

  // A guild without a limit, and a direct message, are never counted.
  assert.equal(await quota.ask('另一個伺服器', { userId: '440000000000000005', guildId: OTHER_GUILD }), '模型回覆');
  assert.equal(await quota.ask('私訊', { userId: '440000000000000006', guildId: null }), '模型回覆');
  assert.deepEqual(getGuildQuota(OTHER_GUILD), { limit: null, used: 0, updatedAt: null });
  assert.equal(getGuildQuota(GUILD).used, 3);
});

test('a chat request over the guild AI quota gets the fixed line and is not persisted', async (t) => {
  const chat = await prepareChat(t);
  const exhausted = async () => { throw new GuildQuotaExhaustedError(); };
  assert.deepEqual(await chat.send('今天天氣好嗎', { impl: exhausted }),
    { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
  assert.deepEqual(chat.sent.map((payload) => payload.content), [QUOTA_EXHAUSTED_MESSAGE]);
  assert.equal(chat.turns(), 0);
  assert.equal(chat.statusRecorded(), 0);
});

test('provider guard blocks are routine: one log line a minute and an observation each, still reported to the hook', (t) => {
  const symbol = Symbol.for('xiaoji.testControlRuntimeController');
  const previousController = globalThis[symbol];
  const previousContext = process.env.NODE_TEST_CONTEXT;
  process.env.NODE_TEST_CONTEXT = '1';
  globalThis[symbol] = Object.freeze({ active: true });
  testControlObservation._testReset();
  const lines = [];
  t.mock.method(logger, 'info', (line) => { lines.push(line); });
  const events = [];
  const restore = setConversationSafetyEventHandler((event) => events.push(event.code));
  t.after(() => {
    restore();
    testControlObservation._testReset();
    if (previousController === undefined) delete globalThis[symbol]; else globalThis[symbol] = previousController;
    if (previousContext === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = previousContext;
  });

  // Past any line an earlier test of this file left in the same minute.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 10 * MINUTE });
  const guard = new ProviderCallGuard();
  const scope = { userId: '450000000000000001', guildId: GUILD, channelId: CHANNEL };
  guard.admit(scope, '同一句話');
  for (let index = 0; index < 3; index += 1) {
    assert.throws(() => guard.admit(scope, '同一句話'), (error) => error.reason === 'duplicate');
  }
  assert.deepEqual(events, ['AI_GUARD_DUPLICATE', 'AI_GUARD_DUPLICATE', 'AI_GUARD_DUPLICATE']);
  assert.deepEqual(lines.filter((line) => line.startsWith('[AI_GUARD]')), ['[AI_GUARD] code=AI_GUARD_DUPLICATE']);
  assert.equal(testControlObservation.snapshot().TEST_OBS_AI_GUARD_DUPLICATE, 3);
});

function judgeFixture(t) {
  turtleSoupSpamGuard.resetForTests();
  t.after(() => turtleSoupSpamGuard.resetForTests());
  const guard = new ProviderCallGuard({
    perUserWindowMs: MINUTE, perUserMaxRequests: 1_000, duplicateWindowMs: 1, globalConcurrency: 4,
    timeoutMs: 5_000, noticeCooldownMs: 1, stateTtlMs: MINUTE, maxTrackedUsers: 100,
  }, { onBlocked: () => {} });
  let modelCalls = 0;
  const judge = createJudgeProvider({
    model: 'synthetic-judge',
    guard,
    logger: null,
    client: { chat: { completions: { async create(request) {
      modelCalls += 1;
      const task = JSON.parse(request.messages[1].content).task;
      return { choices: [{ message: { content: JSON.stringify({ verdict: task === 'guess' ? '未答對' : '是' }) } }] };
    } } } },
  });
  const ask = (input, { kind = 'question', userId = '460000000000000001' } = {}) => judge.judge({
    kind,
    input,
    evidence: [{ id: 'fact', statement: '合成證據', source: 'fact', solution: true }],
    context: { userId, guildId: GUILD, channelId: CHANNEL },
  });
  const blocked = (promise) => promise.then(() => assert.fail('the question should be held back'), (error) => error);
  return { guard, ask, blocked, modelCalls: () => modelCalls };
}

test('the turtle soup judge has its own gate: six a minute, then a private reply, with no model call or judge allowance spent', async (t) => {
  const { guard, ask, blocked, modelCalls } = judgeFixture(t);
  const question = (index) => `他是${String.fromCodePoint(0x4E00 + index * 41)}${String.fromCodePoint(0x6E00 + index * 59)}嗎`;
  for (let index = 0; index < TURTLE_SOUP_SPAM_LIMITS.userShortMaxRequests; index += 1) {
    assert.deepEqual(await ask(question(index)), { verdict: '是' });
  }
  const error = await blocked(ask(question(50)));
  assert.deepEqual([error.code, error.reason, error.retryable], ['JUDGE_SPAM_BLOCKED', 'user_rate', true]);
  assert.equal(modelCalls(), 6);
  assert.equal(guard.users.get(`turtle-soup\u0000460000000000000001`).attempts.length, 6);
  assert.deepEqual(safeJudgeFailure(error), {
    ok: false, ephemeral: true, content: SPAM_BLOCKED_MESSAGES.user_rate, preserveSession: true, code: 'JUDGE_SPAM_BLOCKED',
  });
  // Chat keeps its own counts: the same player is not limited in chat by the game.
  assert.equal(aiSpamGuard.evaluate({ guildId: GUILD, channelId: CHANNEL, userId: '460000000000000001', text: '聊天' }).allowed, true);
  aiSpamGuard.resetForTests();
});

test('the turtle soup judge refuses meaningless and repeated questions, but a guess is not a repeat of a question', async (t) => {
  const { ask, blocked, modelCalls } = judgeFixture(t);
  const meaningless = await blocked(ask('？？？？？？', { userId: '460000000000000002' }));
  assert.equal(meaningless.reason, 'meaningless');
  assert.equal(safeJudgeFailure(meaningless).content, SPAM_BLOCKED_MESSAGES.meaningless);

  assert.deepEqual(await ask('紅門有上鎖嗎', { userId: '460000000000000003' }), { verdict: '是' });
  assert.deepEqual(await ask('紅門 有上鎖嗎？', { userId: '460000000000000003' }), { verdict: '是' });
  const repeated = await blocked(ask('紅門有上鎖嗎！', { userId: '460000000000000003' }));
  assert.equal(repeated.reason, 'repeat');
  assert.equal(safeJudgeFailure(repeated).content, SPAM_BLOCKED_MESSAGES.repeat);
  assert.deepEqual(await ask('紅門有上鎖嗎', { kind: 'guess', userId: '460000000000000003' }), { verdict: '未答對' });
  assert.equal(modelCalls(), 3);
});

test('the turtle soup limits: forty in ten minutes, no channel limit, no cooldown and no notice', () => {
  const clock = { value: 1_000_000 };
  const guard = new AiSpamGuard({
    limits: TURTLE_SOUP_SPAM_LIMITS, now: () => clock.value, logger: null, observe: () => {},
    channelFlood: false, cooldowns: false, notices: false,
  });
  const ask = (text, userId = '470000000000000001') => guard.evaluate({ guildId: GUILD, channelId: CHANNEL, userId, text });
  const question = (index) => `問${String.fromCodePoint(0x4E00 + index * 37)}${String.fromCodePoint(0x6E00 + index * 53)}`;
  for (let index = 0; index < TURTLE_SOUP_SPAM_LIMITS.userLongMaxRequests; index += 1) {
    assert.equal(ask(question(index)).allowed, true, String(index));
    clock.value += 12_000;
  }
  assert.equal(ask(question(99)).reason, 'user_rate');
  // Many blocks never start a cooldown, and no notice text comes from the gate.
  for (let index = 0; index < 10; index += 1) {
    const result = ask('哈哈哈哈哈哈哈哈');
    assert.deepEqual([result.reason, result.notice, result.cooldownStarted], ['meaningless', null, false]);
  }
  // Twenty other players in one channel within a minute are not a flood here.
  for (let index = 0; index < 20; index += 1) {
    assert.equal(ask(`玩家${index}的問題`, `48000000000000${String(index).padStart(4, '0')}`).allowed, true);
  }
  assert.equal(guard.getStatsForTests().trackedChannels, 0);
});

// ---------------------------------------------------------------------------------------------
// Sums, bare calls, long and very short messages, and requests that got no answer
// ---------------------------------------------------------------------------------------------

const { isBareCall } = require('../src/systems/conversation/aiSpamGuard');
const { LocalProviderGuardError } = require('../src/systems/conversation/providerGuard');
const { createFixedCodeLog } = require('../src/systems/conversation/fixedCodeLog');

test('a sum with a digit and an arithmetic sign is never a repetition; digits alone still are', () => {
  for (const sum of ['111×111=?', '1111+1111=?', '1212+1212', '1+1=?', '1 + 1 = ?', '1111÷1111', '１１１１＋１１１１', '6666*6666', '8888-8888=0',
    '1111/1111', '22^2222', '1111%1111', '1111<1111', '1+1+1+1+1+1']) {
    assert.equal(classifyMeaningless(sum), null, sum);
  }
  for (const [text, kind] of [['666666', 'repeated'], ['88888888', 'repeated'], ['１１１１１１', 'repeated'],
    // A tilde is laughter, not a sign; and a sign without a digit on both sides makes no sum.
    ['哈哈哈哈哈哈～', 'repeated'], ['哈哈哈哈哈哈+', 'repeated'], ['++++++', 'empty'], ['666666 :-)', 'repeated'],
    ['-666666', 'repeated'], ['88888888+', 'repeated'], ['哈1哈1哈1哈1 >_<', 'repeated'], ['=666666=', 'repeated']]) {
    assert.equal(classifyMeaningless(text), kind, text);
  }
});

test('a bare call is only punctuation, emoji or mentions; one to three question marks are a question', () => {
  for (const text of ['', '！', '～', '~', '...', '。。。。', '😂', '👍👍', '<:pepe:123456789012345678>', '????', '!?!?']) {
    assert.equal(isBareCall(text), true, JSON.stringify(text));
  }
  for (const text of ['？', '??', '???', '!?', '嗨', '在嗎', 'hi', '1+1=?', '哈哈哈哈哈哈']) {
    assert.equal(isBareCall(text), false, text);
  }
});

test('long messages: the whole text decides "the same", and both ends decide "nearly the same"', () => {
  const { clock, ask } = makeGuard();
  const opening = '我想請小吉幫我看看這段說明寫得清不清楚，內容是關於下週社團活動的集合時間、地點、要帶的東西與注意事項，'.repeat(2);
  const endings = ['第一版的結尾是請大家準時在校門口集合不要遲到喔', '第二版改成請大家提早十分鐘到體育館門口報到', '第三版則是寫自行前往活動中心並記得攜帶學生證'];
  const messages = endings.map((ending) => `${opening}${ending}`);
  assert.ok(messages.every((message) => message.length >= 100 && message.length <= 130), messages.map((m) => m.length).join());
  // Three long messages that share their beginning but end differently are not repeats.
  for (const message of messages) {
    assert.equal(ask(message).allowed, true);
    clock.value += MINUTE;
  }
  // The same long message a third time is.
  assert.equal(ask(messages[0]).allowed, true);
  clock.value += MINUTE;
  assert.equal(ask(messages[0]).reason, REASONS.REPEAT);
  // One extra character at the end of a long message is still nearly the same.
  assert.equal(isNearDuplicate(repeatKey(messages[1]), repeatKey(`${messages[1]}啦`)), true);
  assert.equal(isNearDuplicate(repeatKey(messages[1]), repeatKey(messages[2])), false);
});

test('very short replies are never repeats, but the rate limits still count them', () => {
  const { clock, ask } = makeGuard();
  for (const text of ['好', '好', '好', 'ok', 'ok', 'ok', '哈哈', '哈哈', '嗯嗯']) {
    assert.equal(ask(text).allowed, true, text);
    clock.value += 20_000;
  }
  // Three-character words are compared again.
  assert.equal(ask('好的呀').allowed, true);
  clock.value += 20_000;
  assert.equal(ask('好的呀').allowed, true);
  clock.value += 20_000;
  assert.equal(ask('好的呀').reason, REASONS.REPEAT);
  // Inside one minute, the sixth short reply is held back by the rate.
  const { ask: fastAsk } = makeGuard();
  for (let index = 0; index < AI_SPAM_LIMITS.userShortMaxRequests; index += 1) assert.equal(fastAsk('好').allowed, true);
  assert.equal(fastAsk('好').reason, REASONS.USER_RATE);
});

test('a request that got no answer is taken back out of the repeat history', () => {
  const { clock, guard, ask } = makeGuard();
  const first = ask('同一個問題再問一次');
  guard.forgetRepeat(first.ticket);
  clock.value += MINUTE;
  const second = ask('同一個問題再問一次');
  guard.forgetRepeat(second.ticket);
  clock.value += MINUTE;
  // Neither unanswered try counts: this is the first answered one, then the second.
  assert.equal(ask('同一個問題再問一次').allowed, true);
  clock.value += MINUTE;
  assert.equal(ask('同一個問題再問一次').allowed, true);
  clock.value += MINUTE;
  assert.equal(ask('同一個問題再問一次').reason, REASONS.REPEAT);
  // Forgetting twice, or a short reply without a ticket, changes nothing.
  guard.forgetRepeat(first.ticket);
  guard.forgetRepeat(null);
  assert.equal(ask('好').ticket, null);
});

test('in chat, a resend after a failed call, the 3-second cooldown or a used-up quota is not "said before"', async (t) => {
  const chat = await prepareChat(t);
  const failing = async () => { throw new Error('synthetic model failure'); };
  const busy = async () => { throw new LocalProviderGuardError('user_busy', false); };
  const exhausted = async () => { throw new GuildQuotaExhaustedError(); };
  // Three failures of the same question, one after another: each is tried again, none is a repeat.
  for (const impl of [failing, busy, exhausted]) {
    assert.notDeepEqual(chat.sent.at(-1)?.content, AI_SPAM_NOTICES[REASONS.REPEAT]);
    await chat.send('推薦一部輕鬆的電影', { impl });
    // Twenty seconds apart, so the per-minute limit stays out of the way.
    chat.tick(20_000);
  }
  // A resend inside the 3-second cooldown is dropped and not counted either.
  assert.equal(await chat.send('推薦一部輕鬆的電影'), undefined);
  chat.tick(1_000);
  assert.equal(await chat.send('推薦一部輕鬆的電影'), undefined);
  chat.tick(19_000);
  assert.equal(await chat.send('推薦一部輕鬆的電影'), undefined);
  chat.tick(20_000);
  // Two answered copies now: the third is the repeat.
  assert.deepEqual(await chat.send('推薦一部輕鬆的電影'), { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE });
  assert.equal(chat.sent.at(-1).content, AI_SPAM_NOTICES[REASONS.REPEAT]);
  assert.ok(chat.sent.every((payload) => payload.content !== AI_SPAM_NOTICES[REASONS.REPEAT] ||
    payload === chat.sent.at(-1)));
  assert.equal(chat.providerCalls(), 2);
});

test('a judge question that got no verdict is not a repeat when it is asked again', async (t) => {
  turtleSoupSpamGuard.resetForTests();
  t.after(() => turtleSoupSpamGuard.resetForTests());
  let fail = true;
  const judge = createJudgeProvider({
    model: 'synthetic-judge',
    // A guard that lets every call through, so only the anti-spam gate is under test.
    guard: { execute: (_context, _input, operation) => operation(undefined) },
    logger: null,
    client: { chat: { completions: { async create() {
      if (fail) throw new Error('synthetic judge failure');
      return { choices: [{ message: { content: '{"verdict":"否"}' } }] };
    } } } },
  });
  const ask = () => judge.judge({
    kind: 'question',
    input: '兇手是管家嗎',
    evidence: [{ id: 'fact', statement: '合成證據', source: 'fact', solution: true }],
    context: { userId: '490000000000000001', guildId: GUILD, channelId: CHANNEL },
  });
  for (let index = 0; index < 3; index += 1) {
    await assert.rejects(ask, (error) => error.code === 'JUDGE_UNAVAILABLE');
  }
  fail = false;
  assert.deepEqual(await ask(), { verdict: '否' });
  assert.deepEqual(await ask(), { verdict: '否' });
  await assert.rejects(ask, (error) => error.code === 'JUDGE_SPAM_BLOCKED' && error.reason === 'repeat');
});

test('the fixed-code log writes one line a minute and is not stuck when the clock goes back', () => {
  const clock = { value: 10 * MINUTE };
  const lines = [];
  const log = createFixedCodeLog({ now: () => clock.value, logger: { warn: (line) => lines.push(line) } });
  assert.equal(log.write('CODE', 'warn', '[TEST] code=CODE'), true);
  assert.equal(log.write('CODE', 'warn', '[TEST] code=CODE'), false);
  // The system clock is set back an hour: a new line, not an hour of silence.
  clock.value -= 60 * MINUTE;
  assert.equal(log.write('CODE', 'warn', '[TEST] code=CODE'), true);
  assert.equal(log.write('CODE', 'warn', '[TEST] code=CODE'), false);
  clock.value += MINUTE;
  assert.equal(log.write('CODE', 'warn', '[TEST] code=CODE'), true);
  assert.deepEqual(lines, ['[TEST] code=CODE', '[TEST] code=CODE suppressed=1', '[TEST] code=CODE suppressed=1']);
});

test('a reply to 小吉 with only emoji or punctuation is ignored: no notice, no strike, no model', async (t) => {
  const chat = await prepareChat(t);
  for (const text of ['👍', '😂😂', '。。。', '!!', '<:pepe:123456789012345678>', '～', '👍', '😂😂']) {
    assert.deepEqual(await chat.send(text, { mention: false, reply: true }),
      { outcome: MENTION_OUTCOME.SUPPRESS_PUBLIC_PERSISTENCE }, text);
    chat.tick(5_000);
  }
  assert.deepEqual(chat.sent, []);
  assert.equal(chat.providerCalls(), 0);
  // Eight of them started no cooldown: a reply with words is answered right away.
  assert.equal(await chat.send('謝謝你的推薦', { mention: false, reply: true }), undefined);
  assert.equal(chat.providerCalls(), 1);
  chat.tick(5_000);
  // A question mark is still a question, and a sticker is still meaningless.
  assert.equal(await chat.send('？', { mention: false, reply: true }), undefined);
  assert.equal(chat.providerCalls(), 2);
  chat.tick(5_000);
  await chat.send('', { mention: false, reply: true, stickers: 1 });
  assert.equal(chat.sent.at(-1).content, AI_SPAM_NOTICES[REASONS.MEANINGLESS]);
  assert.equal(chat.providerCalls(), 2);
});
