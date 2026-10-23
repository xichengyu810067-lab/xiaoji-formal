const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.XIAOJI_RUNTIME_MODE = 'test-control';
const suiteDataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-ai-abuse-suite-'));
process.env.XIAOJI_TEST_DATA_ROOT = suiteDataRoot;
test.after(() => fs.rmSync(suiteDataRoot, { recursive: true, force: true }));

const {
  AI_LOCAL_BUSY_REPLY,
  INTERNAL_REPLY,
  decideAssistantOutput,
  decideLocalBusyOutput,
  decideRequestIngress,
  getConversationDecisionPayload,
} = require('../src/systems/conversation/disclosurePolicy');
const {
  BLOCK_REASONS,
  DEFAULT_PROVIDER_GUARD_CONFIG,
  LocalProviderGuardError,
  ProviderCallGuard,
  QUOTA_NAMESPACES,
  providerCallGuard,
} = require('../src/systems/conversation/providerGuard');
const {
  generateChatReply,
  isLocalProviderGuardError,
} = require('../src/systems/conversation/provider');
const {
  CONVERSATION_SAFETY_EVENT_CODES,
  clearConversationSafetyEventHandlerForTests,
  setConversationSafetyEventHandler,
} = require('../src/systems/conversation/safetyEvents');
const {
  approvedUrl,
  containsUnapprovedXiaojiReleaseUrl,
  sanitizeUserFacingOutput,
} = require('../src/systems/conversation/userFacingOutputPolicy');
const { replyInChunks } = require('../src/systems/conversation/chatFlow');
const { getWeatherMentionReply } = require('../src/coordinators/conversationCoordinator');
const { resolveMemberFacts } = require('../src/systems/conversation/memberFacts');

async function rejectedError(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail('Expected the promise to reject.');
}

function context(userId, guildId = null, channelId = `channel-${userId}`) {
  return { userId, guildId, channelId };
}

function immediate(value = 'ok') {
  return async () => value;
}

test('provider guard merges a user across guild and DM, applies to owner, and stays bounded', async () => {
  let now = 1_000;
  const events = [];
  const guard = new ProviderCallGuard({
    perUserWindowMs: 1_000,
    perUserMaxRequests: 2,
    duplicateWindowMs: 300,
    globalConcurrency: 4,
    timeoutMs: 500,
    noticeCooldownMs: 200,
    stateTtlMs: 2_000,
    maxTrackedUsers: 3,
  }, {
    now: () => now,
    onBlocked(code, scope, at) { events.push({ code, scope, at }); },
  });

  await guard.execute(context('owner-user', 'guild-a'), '第一題', immediate());
  now += 301;
  await guard.execute(context('owner-user', null, 'owner-dm'), '第二題', immediate());
  now += 1;
  const ownerBlocked = await rejectedError(
    guard.execute(context('owner-user', 'guild-b'), '第三題', immediate())
  );
  assert.equal(ownerBlocked.reason, BLOCK_REASONS.USER_RATE);
  assert.equal(isLocalProviderGuardError(ownerBlocked), true);

  await guard.execute(context('normal-user', 'guild-a'), '　Same   相同輸入　', immediate());
  const duplicate = await rejectedError(
    guard.execute(context('normal-user', 'guild-b'), 'same 相同輸入', immediate())
  );
  assert.equal(duplicate.reason, BLOCK_REASONS.DUPLICATE);
  assert.equal(duplicate.shouldNotify, true);
  const duplicateAgain = await rejectedError(
    guard.execute(context('normal-user', null, 'normal-dm'), 'same 相同輸入', immediate())
  );
  assert.equal(duplicateAgain.shouldNotify, false);

  now += 1;
  await guard.execute(context('another-user', 'guild-a'), '相同 輸入', immediate());
  for (let index = 0; index < 8; index += 1) {
    now += 1;
    await guard.execute(context(`bounded-${index}`, 'guild-a'), `問題-${index}`, immediate());
    assert.ok(guard.getStatsForTests().trackedUsers <= 3);
  }
  assert.ok(events.length >= 3);
  assert.equal(events.some((event) => Object.hasOwn(event, 'input')), false);
  assert.equal(events.some((event) => Object.hasOwn(event, 'text')), false);
});

test('provider guard counts each quota namespace apart while the pool and the actor identity stay shared', async () => {
  let now = 1_000;
  const events = [];
  const guard = new ProviderCallGuard({
    perUserWindowMs: 1_000,
    perUserMaxRequests: 2,
    duplicateWindowMs: 300,
    globalConcurrency: 2,
    timeoutMs: 500,
    noticeCooldownMs: 200,
    stateTtlMs: 2_000,
    maxTrackedUsers: 10,
  }, {
    now: () => now,
    onBlocked(code, scope) { events.push({ code, actorId: scope.actorId }); },
  });
  const turtle = { quotaNamespace: QUOTA_NAMESPACES.TURTLE_SOUP };

  // Rate and duplicates: spending one namespace leaves the same player's other namespace alone, and
  // the same words are no duplicate there. Guild and DM calls of a player share one namespace state.
  await guard.execute(context('p1', 'guild-a'), 'one', immediate());
  await guard.execute(context('p1', null, 'p1-dm'), 'two', immediate());
  const chatBlocked = await rejectedError(guard.execute(context('p1'), 'three', immediate()));
  assert.equal(chatBlocked.reason, BLOCK_REASONS.USER_RATE);
  await guard.execute(context('p1', 'guild-a'), 'one', immediate(), turtle);
  await guard.execute(context('p1', null, 'p1-dm'), 'two', immediate(), turtle);
  const turtleBlocked = await rejectedError(guard.execute(context('p1'), 'three', immediate(), turtle));
  assert.equal(turtleBlocked.reason, BLOCK_REASONS.USER_RATE);
  const turtleDuplicate = await rejectedError(guard.execute(context('p1', 'guild-b'), 'one', immediate(), turtle));
  assert.equal(turtleDuplicate.reason, BLOCK_REASONS.DUPLICATE);

  // The busy-notice cooldown is kept per namespace too: each side's first block may notify, and a
  // repeat inside the cooldown may not.
  assert.deepEqual([chatBlocked.shouldNotify, turtleBlocked.shouldNotify], [true, true]);
  const chatBlockedAgain = await rejectedError(guard.execute(context('p1'), 'four', immediate()));
  assert.equal(chatBlockedAgain.shouldNotify, false);

  // In flight: a call on one side does not make the player busy on the other, but each side allows
  // only one, and both draw on the one pool (of two here), whichever side another player uses.
  now += 2_000;
  const releases = [];
  const hold = () => new Promise((resolve) => releases.push(resolve));
  const heldChat = guard.execute(context('p2'), 'held chat', hold);
  const heldTurtle = guard.execute(context('p2'), 'held turtle', hold, turtle);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(releases.length, 2);
  assert.deepEqual(guard.getStatsForTests(), { activeCalls: 2, trackedUsers: 2, inFlightUsers: 2 });
  assert.equal((await rejectedError(guard.execute(context('p2'), 'again', immediate()))).reason, BLOCK_REASONS.USER_BUSY);
  assert.equal(
    (await rejectedError(guard.execute(context('p2'), 'again', immediate(), turtle))).reason,
    BLOCK_REASONS.USER_BUSY
  );
  assert.equal((await rejectedError(guard.execute(context('p3'), 'other', immediate()))).reason, BLOCK_REASONS.GLOBAL_BUSY);
  assert.equal(
    (await rejectedError(guard.execute(context('p3'), 'other', immediate(), turtle))).reason,
    BLOCK_REASONS.GLOBAL_BUSY
  );
  releases.splice(0).forEach((release) => release('done'));
  await Promise.all([heldChat, heldTurtle]);
  assert.equal(guard.getStatsForTests().activeCalls, 0);

  // A reported block names the real player, never an internal key built from the namespace.
  assert.ok(events.length > 0);
  assert.equal(events.every((event) => ['p1', 'p2', 'p3'].includes(event.actorId)), true);
});

test('provider guard treats a missing quota namespace as the default one and admit counts there', async () => {
  for (const options of [undefined, null, {}, { quotaNamespace: undefined }, { quotaNamespace: null }]) {
    const guard = new ProviderCallGuard({ perUserMaxRequests: 1 }, { now: () => 1_000, onBlocked() {} });
    await guard.execute(context('p1'), 'first', immediate());
    const blocked = await rejectedError(guard.execute(context('p1'), 'second', immediate(), options));
    assert.equal(blocked.reason, BLOCK_REASONS.USER_RATE, JSON.stringify(options));
  }

  // Fixed local replies are admitted in the default namespace, so they count against that side only.
  const guard = new ProviderCallGuard({ perUserMaxRequests: 1 }, { now: () => 1_000, onBlocked() {} });
  guard.admit(context('p1'), 'fixed reply');
  const blocked = await rejectedError(guard.execute(context('p1'), 'chat call', immediate()));
  assert.equal(blocked.reason, BLOCK_REASONS.USER_RATE);
  const turtle = { quotaNamespace: QUOTA_NAMESPACES.TURTLE_SOUP };
  assert.equal(await guard.execute(context('p1'), 'turtle call', immediate(), turtle), 'ok');
});

test('provider guard lists its quota namespaces and refuses any other name before counting anything', async () => {
  assert.deepEqual(QUOTA_NAMESPACES, { TURTLE_SOUP: 'turtle-soup', STUDENT: 'student' });
  assert.equal(Object.isFrozen(QUOTA_NAMESPACES), true);

  // One request is allowed per player and side, so a call that had been counted would show up below.
  const guard = new ProviderCallGuard({ perUserMaxRequests: 1 }, { now: () => 1_000, onBlocked() {} });
  for (const quotaNamespace of [
    // A misspelling of the listed name, and names that are well formed but not listed.
    'turtle-soop', 'turtle-sou', 'turtle-soup-2', 'game-a', 'a', 'game2', 'a'.repeat(32),
    // Names that are not well formed, whether or not they look like the listed one.
    '', ' ', 'Turtle-Soup', 'turtle soup', 'turtle-soup ', 'turtle-soup\u0000', '-turtle', '1turtle', 'a'.repeat(33),
    // Values that are not names at all.
    0, 7, false, true, {}, ['turtle-soup'],
  ]) {
    const error = await rejectedError(guard.execute(context('p1'), 'x', immediate(), { quotaNamespace }));
    assert.equal(error instanceof TypeError, true, JSON.stringify(quotaNamespace));
    assert.equal(isLocalProviderGuardError(error), false, JSON.stringify(quotaNamespace));
  }

  // Nothing was tracked or counted: the refused calls left no state, and the player still has the
  // whole allowance, for the same words, on the default side and on the listed side.
  assert.deepEqual(guard.getStatsForTests(), { activeCalls: 0, trackedUsers: 0, inFlightUsers: 0 });
  assert.equal(await guard.execute(context('p1'), 'x', immediate()), 'ok');
  const turtle = { quotaNamespace: QUOTA_NAMESPACES.TURTLE_SOUP };
  assert.equal(await guard.execute(context('p1'), 'x', immediate(), turtle), 'ok');
});

test('a full state table evicts the idlest state of either side, resets its counts and refuses nobody for want of room', async () => {
  let now = 1_000;
  const guard = new ProviderCallGuard({
    perUserWindowMs: 60_000,
    perUserMaxRequests: 1,
    duplicateWindowMs: 60_000,
    globalConcurrency: 4,
    timeoutMs: 500,
    noticeCooldownMs: 100,
    stateTtlMs: 120_000,
    maxTrackedUsers: 3,
  }, { now: () => now, onBlocked() {} });
  const turtle = { quotaNamespace: QUOTA_NAMESPACES.TURTLE_SOUP };
  const tracked = () => guard.getStatsForTests().trackedUsers;
  // One call, a millisecond after the last, answered with 'ok' or the guard's block reason. The long
  // windows and state lifetime mean that only the size of the table can remove a state here.
  const call = async (userId, input, options) => {
    now += 1;
    try {
      await guard.execute(context(userId), input, immediate(), options);
      return 'ok';
    } catch (error) {
      return error.reason;
    }
  };

  // Three states on two sides fill the table, and each is at its one-request limit.
  assert.equal(await call('a', 'a1'), 'ok'); // A, chat: the idlest state
  assert.equal(await call('a', 'a2', turtle), 'ok'); // A, turtle soup
  assert.equal(await call('b', 'b1'), 'ok'); // B, chat
  assert.equal(tracked(), 3);

  // A turtle soup newcomer finds the table full: it is accepted, and the idlest state (A's chat one)
  // is the one that goes. The three states that stayed keep their counts, so each is still at its limit.
  assert.equal(await call('c', 'c1', turtle), 'ok');
  assert.equal(tracked(), 3);
  assert.equal(await call('a', 'a3', turtle), BLOCK_REASONS.USER_RATE);
  assert.equal(await call('b', 'b2'), BLOCK_REASONS.USER_RATE);
  assert.equal(await call('c', 'c2', turtle), BLOCK_REASONS.USER_RATE);

  // The evicted state starts over, so A's chat allowance is back. That chat call is a newcomer to a
  // full table too, and the idlest state is now a turtle soup one (A's), so that is the one evicted.
  assert.equal(await call('a', 'a4'), 'ok');
  assert.equal(tracked(), 3);
  // A's turtle soup allowance has started over as well. This newcomer evicts the idlest state, B's chat one.
  assert.equal(await call('a', 'a5', turtle), 'ok');
  assert.equal(tracked(), 3);

  // The states that stayed still hold their counts, and B's chat allowance is the one that started over.
  assert.equal(await call('c', 'c3', turtle), BLOCK_REASONS.USER_RATE);
  assert.equal(await call('a', 'a6'), BLOCK_REASONS.USER_RATE);
  assert.equal(await call('a', 'a7', turtle), BLOCK_REASONS.USER_RATE);
  assert.equal(await call('b', 'b3'), 'ok');
  assert.equal(tracked(), 3);
});

test('a full state table never evicts a state with a call in flight and refuses a newcomer only when none is idle', async () => {
  const guard = new ProviderCallGuard({ maxTrackedUsers: 2, timeoutMs: 500 }, { onBlocked() {} });
  const turtle = { quotaNamespace: QUOTA_NAMESPACES.TURTLE_SOUP };
  const releases = [];
  const hold = () => new Promise((resolve) => releases.push(resolve));

  // One player has a chat call and a turtle soup call in flight, so both tracked states are busy.
  const heldChat = guard.execute(context('a'), 'a1', hold);
  const heldTurtle = guard.execute(context('a'), 'a2', hold, turtle);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(guard.getStatsForTests(), { activeCalls: 2, trackedUsers: 2, inFlightUsers: 2 });

  // Nothing is idle to evict, so a newcomer on either side is refused, and nothing is disturbed.
  assert.equal((await rejectedError(guard.execute(context('b'), 'b1', immediate()))).reason, BLOCK_REASONS.GLOBAL_BUSY);
  assert.equal(
    (await rejectedError(guard.execute(context('b'), 'b2', immediate(), turtle))).reason,
    BLOCK_REASONS.GLOBAL_BUSY
  );
  assert.deepEqual(guard.getStatsForTests(), { activeCalls: 2, trackedUsers: 2, inFlightUsers: 2 });

  // Once the chat call finishes its state is idle, and it is the one evicted for a turtle soup
  // newcomer. The state of the call still in flight stays.
  releases[0]('chat done');
  assert.equal(await heldChat, 'chat done');
  assert.equal(await guard.execute(context('b'), 'b3', immediate(), turtle), 'ok');
  assert.deepEqual(guard.getStatsForTests(), { activeCalls: 1, trackedUsers: 2, inFlightUsers: 1 });
  releases[1]('turtle done');
  assert.equal(await heldTurtle, 'turtle done');
});

test('reviewed 20-second and 15-second windows have explicit boundary behavior', async () => {
  let now = 0;
  const guard = new ProviderCallGuard({}, { now: () => now, onBlocked() {} });
  for (let index = 0; index < 4; index += 1) {
    now = index;
    await guard.execute(context('window-user'), `unique-${index}`, immediate());
  }
  now = 4;
  const fifth = await rejectedError(guard.execute(context('window-user'), 'unique-4', immediate()));
  assert.equal(fifth.reason, BLOCK_REASONS.USER_RATE);
  now = 20_000;
  await guard.execute(context('window-user'), 'after-window', immediate());

  now = 30_000;
  await guard.execute(context('duplicate-boundary-user'), 'Same   Input', immediate());
  now = 44_999;
  const duplicate = await rejectedError(
    guard.execute(context('duplicate-boundary-user'), 'same input', immediate())
  );
  assert.equal(duplicate.reason, BLOCK_REASONS.DUPLICATE);
  now = 45_000;
  await guard.execute(context('duplicate-boundary-user'), 'same input', immediate());
});

test('provider guard enforces in-flight and global limits and releases throw or abort paths', async () => {
  let now = 10_000;
  const guard = new ProviderCallGuard({
    perUserWindowMs: 5_000,
    perUserMaxRequests: 10,
    duplicateWindowMs: 100,
    globalConcurrency: 2,
    timeoutMs: 500,
    noticeCooldownMs: 100,
    stateTtlMs: 10_000,
    maxTrackedUsers: 10,
  }, { now: () => now, onBlocked() {} });
  const releases = [];
  let providerCalls = 0;
  const hold = () => {
    providerCalls += 1;
    return new Promise((resolve) => releases.push(resolve));
  };

  const first = guard.execute(context('user-a', 'guild-a'), 'a', hold);
  await new Promise((resolve) => setImmediate(resolve));
  const sameUser = await rejectedError(guard.execute(context('user-a', 'guild-b'), 'b', hold));
  assert.equal(sameUser.reason, BLOCK_REASONS.USER_BUSY);
  const second = guard.execute(context('user-b', null, 'dm-b'), 'b', hold);
  await new Promise((resolve) => setImmediate(resolve));
  const global = await rejectedError(guard.execute(context('user-c', 'guild-c'), 'c', hold));
  assert.equal(global.reason, BLOCK_REASONS.GLOBAL_BUSY);
  assert.equal(providerCalls, 2);
  releases.splice(0).forEach((release) => release('done'));
  await Promise.all([first, second]);
  assert.equal(guard.getStatsForTests().activeCalls, 0);

  now += 200;
  await assert.rejects(
    guard.execute(context('throw-user'), 'throw', async () => { throw new Error('synthetic failure'); }),
    /synthetic failure/
  );
  await guard.execute(context('throw-user'), 'after-throw', immediate());
  now += 200;
  const aborted = new Error('synthetic abort');
  aborted.name = 'AbortError';
  await assert.rejects(
    guard.execute(context('abort-user'), 'abort', async () => { throw aborted; }),
    /synthetic abort/
  );
  await guard.execute(context('abort-user'), 'after-abort', immediate());
  assert.equal(guard.getStatsForTests().activeCalls, 0);
});

test('timed-out providers keep their slot until an abort-ignoring operation really settles', async () => {
  const guard = new ProviderCallGuard({
    perUserWindowMs: 1_000,
    perUserMaxRequests: 10,
    duplicateWindowMs: 100,
    globalConcurrency: 1,
    timeoutMs: 20,
    noticeCooldownMs: 100,
    stateTtlMs: 1_000,
    maxTrackedUsers: 10,
  }, { onBlocked() {} });
  let settleOrphan;
  let observedSignal;
  const timedOut = guard.execute(context('timeout-user'), 'slow', async (signal) => {
    observedSignal = signal;
    return new Promise((resolve) => { settleOrphan = resolve; });
  });
  const timeoutError = await rejectedError(timedOut);
  assert.equal(timeoutError.reason, BLOCK_REASONS.TIMEOUT);
  assert.equal(observedSignal.aborted, true);
  assert.deepEqual(guard.getStatsForTests(), { activeCalls: 1, trackedUsers: 1, inFlightUsers: 1 });
  const whileOrphaned = await rejectedError(
    guard.execute(context('other-user'), 'other', immediate())
  );
  assert.equal(whileOrphaned.reason, BLOCK_REASONS.GLOBAL_BUSY);
  settleOrphan('late result');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(guard.getStatsForTests().activeCalls, 0);
  await guard.execute(context('other-user'), 'after-settle', immediate());
});

test('actual chat provider path uses one shared guard for owner, cross-guild and global concurrency', async (t) => {
  const previousGroq = process.env.GROQ_API_KEY;
  const previousOwner = process.env.BOT_OWNER_ID;
  const previousMemory = process.env.XIAOJI_MEMORY_PATH;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-provider-guard-'));
  delete process.env.GROQ_API_KEY;
  process.env.BOT_OWNER_ID = 'owner-user';
  process.env.XIAOJI_MEMORY_PATH = path.join(root, 'memory.json');
  providerCallGuard.resetForTests();
  t.after(() => {
    providerCallGuard.resetForTests();
    if (previousGroq === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousGroq;
    if (previousOwner === undefined) delete process.env.BOT_OWNER_ID;
    else process.env.BOT_OWNER_ID = previousOwner;
    if (previousMemory === undefined) delete process.env.XIAOJI_MEMORY_PATH;
    else process.env.XIAOJI_MEMORY_PATH = previousMemory;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const releases = [];
  const requests = [];
  const client = { responses: { create(request, options) {
    requests.push({ request, signal: options?.signal });
    return new Promise((resolve) => releases.push(() => resolve({ output_text: '一般回覆' })));
  } } };
  const call = (userId, guildId, channelId, userText) => generateChatReply({
    userText, displayName: '甲', userId, guildId, channelId,
    chatStyle: 'cute', romanceEnabled: false, memberFacts: [],
  }, { openaiClient: client, loggerImpl: { warn() {} } });

  const noProvider = await generateChatReply({
    userText: '沒有供應商時使用 fallback', displayName: '甲', userId: 'no-provider-user',
    guildId: null, channelId: 'no-provider-dm', chatStyle: 'cute', romanceEnabled: false, memberFacts: [],
  }, { openaiClient: null, loggerImpl: { warn() {} } });
  assert.equal(noProvider, null);
  assert.deepEqual(providerCallGuard.getStatsForTests(), { activeCalls: 0, trackedUsers: 0, inFlightUsers: 0 });

  const ownerFirst = call('owner-user', 'guild-a', 'channel-a', '擁有者第一題');
  await new Promise((resolve) => setImmediate(resolve));
  const ownerSecondError = await rejectedError(
    call('owner-user', 'guild-b', 'channel-b', '擁有者第二題')
  );
  assert.equal(ownerSecondError.reason, BLOCK_REASONS.USER_BUSY);
  assert.equal(requests.length, 1);
  releases.shift()();
  await ownerFirst;

  providerCallGuard.resetForTests();
  const active = [0, 1, 2, 3].map((index) =>
    call(`user-${index}`, index % 2 ? null : `guild-${index}`, `channel-${index}`, `問題-${index}`)
  );
  await new Promise((resolve) => setImmediate(resolve));
  const fifthError = await rejectedError(call('user-5', 'guild-5', 'channel-5', '問題-5'));
  assert.equal(fifthError.reason, BLOCK_REASONS.GLOBAL_BUSY);
  assert.equal(requests.length, 5);
  assert.equal(requests.every((item) => item.signal instanceof AbortSignal), true);
  releases.splice(0).forEach((release) => release());
  await Promise.all(active);
});

test('weather and member lookups do not consume the general chat provider pool', async () => {
  providerCallGuard.resetForTests();
  const before = providerCallGuard.getStatsForTests();
  const weather = await getWeatherMentionReply('東區天氣');
  assert.match(weather, /模糊|縣市/);
  const memberId = '123456789012345678';
  const member = { displayName: '測試成員', user: { username: 'member', bot: false } };
  const resolved = await resolveMemberFacts({
    guildId: 'guild-a',
    client: { user: { id: '999999999999999999' } },
    guild: { members: { cache: new Map([[memberId, member]]) } },
    mentions: { members: new Map([[memberId, member]]) },
  }, `這位 <@${memberId}> 是誰？`);
  assert.ok(resolved.reply || resolved.facts.length);
  assert.deepEqual(providerCallGuard.getStatsForTests(), before);
});

test('user-facing output policy preserves only evidenced HTTPS links and strips mention triggers', () => {
  for (const url of [
    'https://github.com/xichengyu810067-lab/xiaoji-formal/releases',
    'https://github.com/xichengyu810067-lab/xiaoji-formal/releases/tag/v1.1.1',
    'https://discord.gg/TqkCx9kYmk',
    'https://opendata.cwa.gov.tw/dist/opendata-swagger.html',
    'https://data.gov.tw/dataset/102011',
    'https://xiaoji-public-status.xichengyu810067.workers.dev/',
  ]) {
    assert.ok(approvedUrl(url), url);
    assert.match(sanitizeUserFacingOutput(`公開資料：${url}`), /公開資料：https:\/\//);
  }
  for (const url of [
    'https://github.com/xichengyu810067-lab/xiaoji-formal/releases/tag/v1.1.2',
    'https://github.com/xichengyu810067-lab/xiaoji-formal/releases/tag/unapproved-build',
    'https://github.com/xichengyu810067-lab/xiaoji-formal/releases/tag/v9.9.9',
    'https://github.com/xichengyu810067-lab/xiaoji-formal/compare/v1.1.1...v1.1.2',
    'https://github.com/xichengyu810067-lab/xiaoji-formal/releases/tag/v1.1.1?redirect=1',
  ]) {
    assert.equal(approvedUrl(url), null, url);
    assert.equal(containsUnapprovedXiaojiReleaseUrl(`請見 ${url}`), true, url);
  }

  const events = [];
  const restore = setConversationSafetyEventHandler((event) => events.push(event));
  try {
    const unsafe = [
      'https://user@github.com/xichengyu810067-lab/xiaoji-formal/releases',
      'https://github.com.evil.example/xichengyu810067-lab/xiaoji-formal/releases',
      'https://github。com/xichengyu810067-lab/xiaoji-formal/releases',
      'https://xn--e1awd7f.com/path',
      'https://github.com:444/xichengyu810067-lab/xiaoji-formal/releases',
      'https://github.com/xichengyu810067-lab/xiaoji-formal/releases/%2f..',
      '[安全標籤](https://evil.example/redirect)',
      '<https://evil.example/autolink>',
      'https://redirect.example/?to=https://github.com/xichengyu810067-lab/xiaoji-formal/releases',
      'http://github.com/xichengyu810067-lab/xiaoji-formal/releases',
      'www.evil.example/path',
    ].join('；');
    const sanitized = sanitizeUserFacingOutput(
      `正常說明；${unsafe}；@everyone @here <@&123456789012345678> <@123456789012345678>`,
      { context: { actorId: 'user-a', guildId: 'guild-a', channelId: 'channel-a', messageId: 'message-a' } }
    );
    assert.match(sanitized, /正常說明/);
    assert.match(sanitized, /安全標籤/);
    assert.doesNotMatch(sanitized, /evil\.example|redirect\.example|github。com|xn--|@everyone|@here|<@/i);
    assert.ok(events.some((event) => event.code === CONVERSATION_SAFETY_EVENT_CODES.OUTPUT_URL_BLOCKED));
    assert.ok(events.some((event) => event.code === CONVERSATION_SAFETY_EVENT_CODES.OUTPUT_MENTION_BLOCKED));
    for (const event of events) {
      assert.deepEqual(Object.keys(event).sort(), ['actorId', 'at', 'channelId', 'code', 'guildId', 'messageId']);
      assert.equal(JSON.stringify(event).includes('evil.example'), false);
    }
  } finally {
    restore();
    clearConversationSafetyEventHandlerForTests();
  }
});

test('output policy runs before persistence while confidentiality and local-busy contracts stay distinct', () => {
  const ingress = decideRequestIngress({ userText: '一般問題' });
  const candidate = '正常文字 [查看](https://evil.example/redirect) @everyone <@&123456789012345678>';
  const payload = getConversationDecisionPayload(decideAssistantOutput({
    ingressDecision: ingress,
    rawCandidate: candidate,
    styledCandidate: candidate,
    source: 'provider',
    historyAllowed: true,
  }));
  assert.equal(payload.kind, 'allowed');
  assert.equal(payload.archiveAllowed, true);
  assert.equal(payload.historyAllowed, true);
  assert.doesNotMatch(payload.text, /evil\.example|@everyone|<@&/);

  const confidentiality = getConversationDecisionPayload(decideAssistantOutput({
    ingressDecision: ingress,
    rawCandidate: '小吉的內部資料庫有 42 筆資料，詳見 https://evil.example/',
    styledCandidate: '小吉的內部資料庫有 42 筆資料，詳見 https://evil.example/',
    source: 'provider',
    historyAllowed: true,
  }));
  assert.equal(confidentiality.text, INTERNAL_REPLY);
  assert.equal(confidentiality.archiveAllowed, false);

  const localBusy = getConversationDecisionPayload(decideLocalBusyOutput(ingress));
  assert.equal(localBusy.text, AI_LOCAL_BUSY_REPLY);
  assert.notEqual(localBusy.text, '小吉有點累了，請稍後再跟我聊天');
  assert.deepEqual(
    [localBusy.archiveAllowed, localBusy.historyAllowed, localBusy.privateMemoryAllowed,
      localBusy.publicPersistenceAllowed],
    [false, false, false, false]
  );
  const typed = new LocalProviderGuardError(BLOCK_REASONS.GLOBAL_BUSY, true);
  assert.equal(typed.code, 'AI_LOCAL_GUARD_BLOCKED');
});

test('chat replies disable every automatic mention class by default', async () => {
  const payloads = [];
  const message = {
    async reply(payload) { payloads.push(payload); },
    channel: { async send(payload) { payloads.push(payload); } },
  };
  await replyInChunks(message, '第一段。'.repeat(500));
  assert.ok(payloads.length > 1);
  for (const payload of payloads) {
    assert.deepEqual(payload.allowedMentions, { parse: [], users: [], roles: [], repliedUser: false });
  }
});

test('default production guard constants remain the reviewed finite policy', () => {
  assert.deepEqual(DEFAULT_PROVIDER_GUARD_CONFIG, {
    perUserWindowMs: 20_000,
    perUserMaxRequests: 4,
    duplicateWindowMs: 15_000,
    globalConcurrency: 4,
    timeoutMs: 20_000,
    noticeCooldownMs: 10_000,
    stateTtlMs: 60_000,
    maxTrackedUsers: 2_048,
  });
});
