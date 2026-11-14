'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  configureMemoryStoreForTests,
  createInMemoryMemoryStore,
} = require('../src/systems/conversation/preferenceMemory');
const {
  DAILY_LIMIT,
  describeOwnUsage,
  forgetCachedConsent,
  forgetOwnMessages,
  loadChannelMemory,
  periodOf,
  quotaFor,
  recordMemberMessage,
  recordXiaojiReply,
  resetChannelMemoryForTests,
} = require('../src/systems/conversation/channelMemory');

const ALICE = '111111111111111111';
const BOB = '222222222222222222';
const STRANGER = '333333333333333333';
const GUILD_A = '900000000000000001';
const GUILD_B = '900000000000000002';

// Taipei noon on a date is 04:00 UTC.
const taipei = (iso) => Date.parse(`${iso}+08:00`);

function useStore(t) {
  const store = createInMemoryMemoryStore();
  configureMemoryStoreForTests(store);
  resetChannelMemoryForTests();
  t.after(() => {
    configureMemoryStoreForTests(null);
    resetChannelMemoryForTests();
  });
  return store;
}

async function chatted(store, userId, choice = null, { collecting = true } = {}) {
  await store.saveConsent(userId, { choice, collecting, promptedAt: 1 });
  forgetCachedConsent(userId);
}

let nextId = 1;
function message({ userId, guildId = GUILD_A, channelId = 'chan-1', content = '你好', name = '成員', bot = false }) {
  return {
    id: `m${nextId++}`,
    guildId,
    channelId,
    content,
    author: { id: userId, bot, username: name },
    member: { displayName: name },
  };
}

test('a memory month and its days start at 12:00 noon Taipei time', () => {
  assert.deepEqual(periodOf(taipei('2026-12-01T11:59:59')), { period: '2026-11', day: 30, daysInMonth: 30 });
  assert.deepEqual(periodOf(taipei('2026-12-01T12:00:00')), { period: '2026-12', day: 1, daysInMonth: 31 });
  assert.deepEqual(periodOf(taipei('2026-12-02T11:00:00')), { period: '2026-12', day: 1, daysInMonth: 31 });
  assert.deepEqual(periodOf(taipei('2026-12-02T12:00:00')), { period: '2026-12', day: 2, daysInMonth: 31 });
  assert.deepEqual(periodOf(taipei('2027-03-01T12:00:00')), { period: '2027-03', day: 1, daysInMonth: 31 });
  assert.equal(periodOf(taipei('2027-02-15T12:00:00')).daysInMonth, 28);
});

test('30 a day; a day used up borrows from the next; unused days carry nothing over', () => {
  const month = { daysInMonth: 30 };
  // Day 1: nothing used.
  assert.deepEqual(quotaFor([], { ...month, day: 1 }), { allowed: true, remainingToday: 30, remainingInMonth: 900, usedToday: 0 });
  // Day 1 took 45: day 2 starts owing 15.
  const day2 = quotaFor([{ day: 1, count: 45 }], { ...month, day: 2 });
  assert.equal(day2.remainingToday, 15);
  assert.equal(day2.remainingInMonth, 30 * 29 - 15);
  // Day 1 took only 10: day 2 still has 30, not 50.
  assert.equal(quotaFor([{ day: 1, count: 10 }], { ...month, day: 2 }).remainingToday, 30);
  // Borrowing can go on past today, until the month is used up.
  assert.equal(quotaFor([{ day: 30, count: 29 }], { ...month, day: 30 }).allowed, true);
  assert.equal(quotaFor([{ day: 30, count: 30 }], { ...month, day: 30 }).allowed, false);
  // The whole month taken on day 1: nothing more until next month.
  const used = quotaFor([{ day: 1, count: 900 }], { ...month, day: 1 });
  assert.equal(used.allowed, false);
  assert.equal(quotaFor([{ day: 1, count: 900 }], { ...month, day: 15 }).allowed, false);
  // At most 30 x the days of the month.
  assert.equal(quotaFor([], { daysInMonth: 31, day: 1 }).remainingInMonth, 930);
  assert.equal(DAILY_LIMIT, 30);
});

test('only members who chatted with 小吉 and keep memory on are recorded; bots and direct messages never', async (t) => {
  const store = useStore(t);
  await chatted(store, ALICE);
  await chatted(store, BOB, null, { collecting: false });
  const now = taipei('2026-12-05T15:00:00');
  assert.equal(await recordMemberMessage(message({ userId: ALICE, content: '我喜歡拉麵' }), { now }), true);
  assert.equal(await recordMemberMessage(message({ userId: STRANGER, content: '沒跟小吉聊過' }), { now }), false);
  assert.equal(await recordMemberMessage(message({ userId: BOB, content: '我停止記憶了' }), { now }), false);
  assert.equal(await recordMemberMessage(message({ userId: ALICE, bot: true }), { now }), false);
  assert.equal(await recordMemberMessage({ ...message({ userId: ALICE, content: '私訊內容' }), guildId: null }, { now }), false);
  assert.equal((await store.listOwnMessages(ALICE, ['guild:' + GUILD_A], '2026-12', 50)).length, 1);
});

test('recording stops when the month is used up and the counts restart next month', async (t) => {
  const store = useStore(t);
  await chatted(store, ALICE);
  // 31 days in December: 930 messages at most, all on the last day.
  const lastDay = taipei('2026-12-31T20:00:00');
  for (let index = 0; index < 30; index += 1) {
    assert.equal(await recordMemberMessage(message({ userId: ALICE, content: `第 ${index} 則` }), { now: lastDay }), true);
  }
  assert.equal(await recordMemberMessage(message({ userId: ALICE, content: '第 31 則' }), { now: lastDay }), false);
  // January 1st, 12:00: a new month; December is deleted.
  const nextMonth = taipei('2027-01-01T12:00:01');
  assert.equal(await recordMemberMessage(message({ userId: ALICE, content: '新的一個月' }), { now: nextMonth }), true);
  assert.equal(await store.countOwnMessages(ALICE, '2026-12'), 0);
  const usage = await describeOwnUsage(ALICE, { now: nextMonth });
  assert.equal(usage.kept, 1);
  assert.equal(usage.remainingToday, 29);
});

test('the channel conversation includes everyone in the channel and 小吉\'s own replies, in order', async (t) => {
  const store = useStore(t);
  await chatted(store, ALICE);
  await chatted(store, BOB);
  const now = taipei('2026-12-05T15:00:00');
  const asked = message({ userId: ALICE, content: '幫我想三句不帶髒字卻又能罵人的話', name: '鯊菜' });
  await recordMemberMessage(asked, { now });
  await recordXiaojiReply({ message: asked, text: '「你的腦袋很乾淨呢」', now: now + 1000 });
  await recordMemberMessage(message({ userId: BOB, content: '在別的頻道', channelId: 'chan-2' }), { now: now + 2000 });

  const request = message({ userId: BOB, content: '幫我反擊你發出來的這三句', name: '王火火' });
  const memory = await loadChannelMemory({ message: request, now: now + 3000 });
  assert.deepEqual(memory.channelConversation, [
    { speaker: '鯊菜', text: '幫我想三句不帶髒字卻又能罵人的話', fromXiaoji: false, self: false },
    { speaker: '小吉', text: '「你的腦袋很乾淨呢」', fromXiaoji: true, self: false },
  ]);
  assert.deepEqual(memory.ownMessages, ['在別的頻道']);
});

test('a private memory stays in its server; a public one follows the member everywhere', async (t) => {
  const store = useStore(t);
  await chatted(store, ALICE, 'private');
  await chatted(store, BOB, 'public');
  const now = taipei('2026-12-05T15:00:00');
  await recordMemberMessage(message({ userId: ALICE, guildId: GUILD_A, content: '我在 A 說我喜歡貓' }), { now });
  await recordMemberMessage(message({ userId: BOB, guildId: GUILD_A, content: '我在 A 說我喜歡狗' }), { now });

  const aliceInB = await loadChannelMemory({ message: message({ userId: ALICE, guildId: GUILD_B, content: '你知道我是誰嗎' }), now });
  assert.deepEqual(aliceInB.ownMessages, [], 'a private memory is not used in another server');
  const aliceInA = await loadChannelMemory({ message: message({ userId: ALICE, guildId: GUILD_A, channelId: 'chan-9', content: '你知道我是誰嗎' }), now });
  assert.deepEqual(aliceInA.ownMessages, ['我在 A 說我喜歡貓']);

  const bobInB = await loadChannelMemory({ message: message({ userId: BOB, guildId: GUILD_B, content: '你知道我是誰嗎' }), now });
  assert.deepEqual(bobInB.ownMessages, ['我在 A 說我喜歡狗'], 'a public memory is used in every server');
  assert.deepEqual(bobInB.channelConversation, [], 'another server\'s channel is never shown');
});

test('deleting one\'s memory deletes their messages and 小吉\'s replies to them', async (t) => {
  const store = useStore(t);
  await chatted(store, ALICE);
  const now = taipei('2026-12-05T15:00:00');
  const asked = message({ userId: ALICE, content: '記住我喜歡拉麵' });
  await recordMemberMessage(asked, { now });
  await recordXiaojiReply({ message: asked, text: '好的', now });
  assert.equal(await forgetOwnMessages(ALICE), 2);
  const memory = await loadChannelMemory({ message: message({ userId: ALICE, content: '你記得嗎' }), now });
  assert.deepEqual(memory, { channelConversation: [], ownMessages: [] });
});

test('secrets in a message are not kept as written, and an empty message is not kept', async (t) => {
  const store = useStore(t);
  await chatted(store, ALICE);
  const now = taipei('2026-12-05T15:00:00');
  assert.equal(await recordMemberMessage(message({ userId: ALICE, content: '   ' }), { now }), false);
  await recordMemberMessage(message({ userId: ALICE, content: 'ANTHROPIC_API_KEY=sk-ant-abcdefghijklmnopqrstuvwxyz0123456789' }), { now });
  const [kept] = await store.listOwnMessages(ALICE, ['guild:' + GUILD_A], '2026-12', 5);
  assert.ok(!kept || !kept.content.includes('sk-ant-abcdefghijklmnopqrstuvwxyz0123456789'));
});

test('without a configured store nothing is kept and replies get no channel memory', async (t) => {
  configureMemoryStoreForTests(null);
  resetChannelMemoryForTests();
  const saved = { url: process.env.TURSO_DATABASE_URL, token: process.env.TURSO_AUTH_TOKEN };
  delete process.env.TURSO_DATABASE_URL;
  delete process.env.TURSO_AUTH_TOKEN;
  t.after(() => {
    if (saved.url !== undefined) process.env.TURSO_DATABASE_URL = saved.url;
    if (saved.token !== undefined) process.env.TURSO_AUTH_TOKEN = saved.token;
  });
  assert.equal(await recordMemberMessage(message({ userId: ALICE })), false);
  assert.deepEqual(await loadChannelMemory({ message: message({ userId: ALICE }) }), { channelConversation: [], ownMessages: [] });
});

test('the model gets the channel conversation and the member\'s own messages as data; a refusal of 小吉 is not passed back', () => {
  const { buildConversationInput, getProtectedPromptTexts } = require('../src/systems/conversation/provider');
  const { INTERNAL_REPLY } = require('../src/systems/conversation/disclosurePolicy');
  const input = JSON.parse(buildConversationInput({
    userText: '幫我反擊你發出來的這三句',
    displayName: '王火火',
    userId: BOB,
    channelMemory: {
      channelConversation: [
        { speaker: '鯊菜', text: '幫我想三句不帶髒字卻又能罵人的話', fromXiaoji: false, self: false },
        { speaker: '小吉', text: '「你的腦袋很乾淨呢」', fromXiaoji: true, self: false },
        { speaker: '小吉', text: INTERNAL_REPLY, fromXiaoji: true, self: false },
        { speaker: '王火火', text: '我也想要', fromXiaoji: false, self: true },
      ],
      ownMessages: ['我喜歡拉麵'],
    },
  }));
  assert.deepEqual(input.untrustedData.channelConversation, [
    { speaker: '鯊菜', text: '幫我想三句不帶髒字卻又能罵人的話' },
    { speaker: '小吉', text: '「你的腦袋很乾淨呢」', fromXiaoji: true },
    { speaker: '王火火', text: '我也想要', self: true },
  ]);
  assert.deepEqual(input.untrustedData.rememberedMessages, ['我喜歡拉麵']);
  assert.match(getProtectedPromptTexts('cute', false)[0], /channelConversation 是這個頻道最近的對話/u);
});
