'use strict';

// Attack tests for text a member (or the owner) types into a command and the bot then shows to others: a poll, a
// reminder, a calendar event and a menu item of the casino restaurant. Every kind of hostile text is
// sent through the command that takes it, stored by the real services, shown again by the commands that list it
// and delivered by the reminder timer; whatever each of those answers is then turned into the request discord.js
// would send and passed through the real egress guard (src/platform/egressGuard.js), the last boundary before
// Discord. What reaches the transport has to hold no link that was not approved and no mention that would notify
// anybody, and its allowed_mentions must not allow everyone or roles.
//
// The strings use reserved example domains and synthetic IDs only; every invisible character is written as a
// \u{...} escape and never as a literal character.
//
// A plain test that passes is a defence that held. A test marked todo is a gap that is reported and not fixed here.

const test = require('node:test');
const assert = require('node:assert/strict');

const attack = require('./support/attackSession');

const session = attack.createAttackSession({ prefix: 'xiaoji-attack-public-text-' });

const coinService = require('../src/services/coinService');
const chipService = require('../src/services/chipService');
const reminderService = require('../src/services/reminderService');
const workService = require('../src/services/workService');
const { withCoinDatabase } = require('../src/services/coinDatabase');

const { IDS } = session;
const HOME = IDS.approvedGuild;
const LINK_REMOVED = '[連結已移除]';

test.before(async () => {
  await session.open();
  await coinService.setGuildEconomyEnabled(HOME, true, { operatorId: IDS.owner });
  for (const userId of [IDS.member, IDS.target, IDS.owner]) {
    await coinService.adjustPlayerBalance(HOME, userId, {
      action: 'add', amount: 1_000_000, operatorId: IDS.owner, reason: '公開文字攻擊測試初始資金', operationId: `attack-text-seed-${userId}`,
    });
    await chipService.buyChips(HOME, userId, 100_000);
  }
});

test.after(() => session.close());

// ---------------------------------------------------------------------------------------------------------
// the hostile text
// ---------------------------------------------------------------------------------------------------------

// [name, text, what it carries]. `links` marks the strings that hold a link, so the guard has to have rewritten them.
const HOSTILE = Object.freeze([
  ['@everyone', '大家好 @everyone 請看這裡', {}],
  ['@here', '大家好 @here 請看這裡', {}],
  ['@everyone with a zero-width space', '大家好 @\u{200b}everyone 請看這裡', {}],
  ['@here with a word joiner', '大家好 @\u{2060}here 請看這裡', {}],
  ['a role mention', '請 <@&763000000000000001> 注意', {}],
  ['a user mention', '請 <@760000000000000003> 注意', {}],
  ['a user mention with a nickname mark', '請 <@!760000000000000003> 注意', {}],
  ['a channel mention', '請到 <#762000000000000001> 集合', {}],
  ['a Discord invite', '加入 https://discord.gg/abcdefg 領獎', { links: true }],
  ['a bare Discord invite', '加入 discord.gg/abcdefg 領獎', { links: true }],
  ['a plain link', '詳情見 https://evil.example.com/path?x=1 謝謝', { links: true }],
  ['a bare domain', '詳情見 evil.example.com/path 謝謝', { links: true }],
  ['a markdown link', '[點我領獎](https://evil.example.com/login)', { links: true }],
  ['a markdown link that names another address', '[https://github.com/xichengyu810067-lab/xiaoji-formal/releases/tag/v1.1.2](https://evil.example.com/login)',
    { links: true }],
  ['an angle-bracket link', '<https://evil.example.com/a>', { links: true }],
  ['a link with a zero-width space', '見 https://evil\u{200b}.example.com/ 謝謝', { links: true }],
  ['a link split by a soft hyphen', '見 https://evil.exa\u{ad}mple.com/ 謝謝', { links: true }],
  ['a link written with full-width dots', '見 https://evil\u{ff0e}example\u{ff0e}com/ 謝謝', { links: true }],
  ['a bidirectional override', '檔案 \u{202e}gnp.exe\u{202c} 已上傳', {}],
  ['bidirectional isolates', '\u{2066}管理員\u{2069}說 \u{2067}ok\u{2069}', {}],
  ['line breaks', '第一行\n第二行\r\n第三行\n\n\n第七行', {}],
  ['markdown blocks', '# 大標題\n```js\nconsole.log(1)\n```\n> 引用\n||暗語||', {}],
  ['an enormous line', '長'.repeat(5_000), {}],
  ['control characters', '控制\u{0}\u{7}\u{1b}[31m字元\u{7f}', {}],
]);

// Every string a request body holds, except the identifier of a control (the bot's own code, read back as written).
function collectStrings(value, found = []) {
  if (typeof value === 'string') found.push(value);
  else if (Array.isArray(value)) for (const entry of value) collectStrings(entry, found);
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) if (key !== 'custom_id') collectStrings(entry, found);
  }
  return found;
}

const INVISIBLE = /[\u{ad}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2060}-\u{2064}\u{2066}-\u{2069}\u{feff}]/gu;
const LINK_LEFT = /https?:\/\/|discord\.gg|discord(?:app)?\.com\/invite|evil\.example|evil\u{ff0e}example|\bwww\./iu;
// The one address the bot itself may show: the page of the release it is (the egress guard is built with its tag).
const APPROVED_RELEASE_URL = `https://github.com/xichengyu810067-lab/xiaoji-formal/releases/tag/${attack.APPROVED_RELEASE_TAG}`;

function messageOf(sent) {
  return sent.body?.data && typeof sent.body.data === 'object' && !Array.isArray(sent.body.data) ? sent.body.data : sent.body;
}

// What reached the transport of every answer of `outcome`: nothing refused, no link that was not approved, and no
// mention that would notify anyone but `users`.
function assertWireSafe(label, outcome, { users = [] } = {}) {
  const sentMessages = outcome.wire.filter((sent) => sent.route);
  for (const sent of outcome.wire) {
    assert.equal(sent.unbuildable, undefined, `${label}: ${sent.unbuildable}`);
    assert.equal(sent.refused, undefined, `${label}: the egress guard refused ${sent.method} ${sent.route}: ${sent.refused}`);
  }
  // Before the guard: an answer the channel can read carries a mention rule of the command's own, which allows
  // neither everyone nor roles. (A private answer notifies nobody, so it may leave the rule to the guard.)
  for (const answer of outcome.publicAnswers) {
    const own = answer.allowedMentions;
    assert.ok(own && typeof own === 'object', `${label}: a public ${answer.method} has no allowedMentions of its own`);
    assert.ok(!(own.parse || []).includes('everyone') && !(own.parse || []).includes('roles'),
      `${label}: a public ${answer.method} allows everyone or roles`);
    assert.deepEqual(own.roles || [], [], `${label}: a public ${answer.method} names roles`);
  }
  let rewritten = 0;
  for (const sent of sentMessages) {
    const message = messageOf(sent);
    if (!message) continue;
    for (const text of collectStrings(message)) {
      const visible = text.replace(INVISIBLE, '').split(APPROVED_RELEASE_URL).join('');
      assert.doesNotMatch(visible, LINK_LEFT, `${label}: a link reached ${sent.route}: ${JSON.stringify(text.slice(0, 120))}`);
      if (text.includes(LINK_REMOVED)) rewritten += 1;
    }
    // Interaction callbacks that only acknowledge (deferred, update-deferred) carry no message.
    const hasMessage = ['content', 'embeds', 'components'].some((key) => Object.hasOwn(message, key));
    if (!hasMessage) continue;
    const allowed = message.allowed_mentions;
    assert.ok(allowed && typeof allowed === 'object', `${label}: ${sent.route} carries allowed_mentions`);
    assert.ok(!(allowed.parse || []).includes('everyone'), `${label}: allowed_mentions allows everyone`);
    assert.ok(!(allowed.parse || []).includes('roles'), `${label}: allowed_mentions allows roles`);
    assert.deepEqual(allowed.roles || [], [], `${label}: allowed_mentions names roles`);
    assert.notEqual(allowed.replied_user, true, `${label}: allowed_mentions pings the replied user`);
    const notified = attack.notifiedBy(message);
    assert.equal(notified.everyone, false, `${label}: ${sent.route} would notify everyone`);
    assert.deepEqual(notified.roles, [], `${label}: ${sent.route} would notify a role`);
    assert.deepEqual(notified.users.filter((id) => !users.includes(id)), [],
      `${label}: ${sent.route} would notify a user it should not`);
  }
  return { rewritten, sent: sentMessages.length };
}

// ---------------------------------------------------------------------------------------------------------
// the five entries
// ---------------------------------------------------------------------------------------------------------

function fit(text, option) {
  return Array.from(text).slice(0, option).join('');
}

const channelCounter = { value: 0 };
const nextChannel = (prefix) => session.channel(`${prefix}-${++channelCounter.value}`);

// A member may have three polls open at once; the clock is moved past the length of a poll (ten minutes) before each.
const POLL_SLOT_MS = 11 * 60 * 1000;

test('a poll question and options with hostile text show no link and ping no one, when created and when voted on', async () => {
  let rewritten = 0;
  for (const [name, text, { links }] of HOSTILE) {
    // The clock only goes forward in this file: a poll made at a later time is open again at an earlier one.
    session.clockOffset += POLL_SLOT_MS;
    const channel = nextChannel('text-poll');
    const created = await session.run('poll', {
      as: 'member', channel,
      options: { question: fit(text, 200), option1: `${fit(text, 90)} 甲`, option2: `${fit(text, 90)} 乙`, option3: `${fit(text, 90)} 丙` },
    });
    attack.assertRanCleanly(created, `poll with ${name}`);
    const made = assertWireSafe(`poll with ${name}`, created);
    assert.ok(made.sent >= 2, `poll with ${name}: the poll was shown`);
    assert.ok(created.publicAnswers.length > 0, `poll with ${name}: the poll is a public answer`);
    if (links) assert.ok(made.rewritten > 0, `poll with ${name}: the link was rewritten`);
    rewritten += made.rewritten;
    const panel = session.panelOf(created);
    assert.ok(panel, `poll with ${name}: a poll message with buttons`);
    const [first] = session.controlsOf(panel.message);
    const voted = await session.press(first.custom_id, { as: 'target', message: panel.message, channel });
    attack.assertRanCleanly(voted, `vote on a poll with ${name}`);
    assertWireSafe(`vote on a poll with ${name}`, voted);
  }
  assert.ok(rewritten > 0, 'the guard rewrote links');
});

test('a reminder with hostile text is stored, listed and delivered without a link or a ping of anyone but its author', async () => {
  for (const [name, text, { links }] of HOSTILE) {
    const channel = nextChannel('text-remind');
    const added = await session.run('remind add', { as: 'member', channel, options: { time: '10m', message: fit(text, 1000) } });
    attack.assertRanCleanly(added, `remind add with ${name}`);
    assert.match(added.last, /^提醒已設定/u, name);
    assertWireSafe(`remind add with ${name}`, added);

    const listed = await session.run('remind list', { as: 'member', channel });
    attack.assertRanCleanly(listed, `remind list with ${name}`);
    const shown = assertWireSafe(`remind list with ${name}`, listed);
    if (links) assert.ok(shown.rewritten > 0, `remind list with ${name}: the link was rewritten`);

    const [stored] = reminderService.listUserReminders({ userId: IDS.member }).filter((reminder) => reminder.deliveryChannelId === channel.id);
    assert.ok(stored, `${name}: the reminder is stored`);
    assert.ok(stored.message.length <= 1000, `${name}: stored within 1000 characters`);

    // The timer's delivery, as the reminder system makes it: the author is mentioned on purpose.
    const delivered = await session.act(`deliver reminder with ${name}`, async () => {
      await reminderService.sendReminder(session.world.client, stored.id);
    });
    attack.assertRanCleanly(delivered, `delivery of the reminder with ${name}`);
    const sent = assertWireSafe(`delivery of the reminder with ${name}`, delivered, { users: [IDS.member] });
    assert.equal(sent.sent, 1, `${name}: one message was delivered`);
    if (links) assert.ok(sent.rewritten > 0, `delivery with ${name}: the link was rewritten`);
    const [message] = delivered.wire.map((entry) => entry.body);
    assert.deepEqual(message.allowed_mentions.users, [IDS.member], `${name}: only the author may be notified`);
    assert.deepEqual(attack.notifiedBy(message).users, [IDS.member], `${name}: and the author is`);
    assert.equal(reminderService.readReminders()[stored.id].status, 'delivered');
  }
});

test('a calendar title and description with hostile text are stored and listed without a link or a ping', async () => {
  for (const [name, text, { links }] of HOSTILE) {
    const added = await session.run('calendar add', {
      as: 'member', channel: nextChannel('text-calendar'),
      options: { title: fit(text, 100), 'starts-at': '2026-03-03 20:00', description: fit(text, 1000) },
    });
    attack.assertRanCleanly(added, `calendar add with ${name}`);
    assert.match(added.last, /^已新增個人行事曆事件/u, name);
    const made = assertWireSafe(`calendar add with ${name}`, added);
    if (links) assert.ok(made.rewritten > 0, `calendar add with ${name}: the link was rewritten`);
    const listed = await session.run('calendar list', { as: 'member', options: { days: 30 } });
    attack.assertRanCleanly(listed, `calendar list with ${name}`);
    assertWireSafe(`calendar list with ${name}`, listed);
    // The event is the member's own; the list is private to them.
    const first = listed.run.events.find((event) => event.method === 'reply');
    assert.equal(first.body.ephemeral, true, `${name}: the list is private`);
  }
});

test('a casino menu item with hostile text is listed and ordered without a link or a ping', async () => {
  let ordered = 0;
  // The member waits tables: a venue job chosen now starts three days on, so the clock is moved and the scheduler's
  // due activations are run the way it runs them. The kitchen is the venue's own (a meal without a chosen chef is
  // made by its staff).
  await workService.startVenueJobs(HOME, IDS.member, { days: 1, waiter: '服務生' });
  session.clockOffset += 3 * 24 * 60 * 60 * 1000;
  session.nextTime();
  await workService.processDueJobs(null);
  for (const [name, text, { links }] of HOSTILE) {
    // An order is limited to ten a minute for each customer.
    session.clockOffset += 61_000;
    const added = await session.run('casino-venue add-menu', {
      as: 'member', channel: nextChannel('text-venue'),
      options: { type: 'meal', name: fit(text, 80), steps: `${fit(text, 400)}\n${fit(text, 400)}` },
    });
    attack.assertRanCleanly(added, `add-menu with ${name}`);
    assert.match(added.last, /^已新增菜單/u, name);
    const made = assertWireSafe(`add-menu with ${name}`, added);
    if (links) assert.ok(made.rewritten > 0, `add-menu with ${name}: the link was rewritten`);

    const menu = await session.run('casino-venue menu', { as: 'target', options: { type: 'meal' } });
    attack.assertRanCleanly(menu, `menu with ${name}`);
    assertWireSafe(`menu with ${name}`, menu);

    // The menu item the member just added, found by its stored name.
    const rows = await withCoinDatabase((api) => api.all(
      'SELECT id, name, steps FROM casino_venue_menu WHERE guild_id = ? AND created_by = ? ORDER BY id DESC LIMIT 1', [HOME, IDS.member]
    ));
    assert.equal(rows.length, 1, name);
    assert.ok(rows[0].name.length <= 80, `${name}: a stored name within 80 characters`);
    assert.ok(rows[0].steps.length <= 1000, `${name}: stored steps within 1000 characters`);
    const order = await session.run('casino-venue order', {
      as: 'target', channel: nextChannel('text-venue-order'),
      options: { meal: rows[0].id, waiter: session.person('member'), tip: 100 },
    });
    attack.assertRanCleanly(order, `order of the item with ${name}`);
    if (/^\*\*小吉賭場｜訂單/u.test(order.last)) {
      ordered += 1;
      assert.ok(order.publicAnswers.length > 0, `order with ${name}: the order is a public answer`);
      // The public order names the item and mentions its people: the customer, the waiter and the makers.
      assertWireSafe(`order of the item with ${name}`, order, { users: [IDS.target, IDS.member] });
    }
  }
  assert.ok(ordered > 0, 'at least one hostile item could be ordered');
});

test('a shop item with hostile text, made through the service, is listed in the reply without a link or a ping', async () => {
  // The command that creates shop items is a private command; what the public /shop list shows of stored text is not.
  for (const [name, text] of HOSTILE) {
    await coinService.createShopItem(HOME, {
      name: fit(text, 80), price: 10, type: 'collectible', description: fit(text, 500), createdBy: IDS.owner,
    });
    const listed = await session.run('shop list', { as: 'target', channel: nextChannel('text-shop-list') });
    attack.assertRanCleanly(listed, `shop list with ${name}`);
    assertWireSafe(`shop list with ${name}`, listed);
  }
});

test('text over the limit a client would stop is cut by the service and still safe at the boundary', async () => {
  // Discord stops a message option longer than its maximum before it reaches the bot; a hand-made interaction does
  // not, so the commands and services have to cut it themselves.
  const long = `${'長'.repeat(3_000)} @everyone https://evil.example.com/tail`;
  session.clockOffset += POLL_SLOT_MS;
  const poll = await session.run('poll', {
    as: 'member', channel: nextChannel('text-over'),
    options: { question: long, option1: long, option2: `${long} 乙` },
  });
  attack.assertRanCleanly(poll, 'an over-long poll');
  assertWireSafe('an over-long poll', poll);
  const embedTitle = poll.wire.map((entry) => messageOf(entry)).flatMap((message) => message?.embeds || []).map((embed) => embed.title).filter(Boolean);
  assert.ok(embedTitle.length > 0 && embedTitle.every((title) => title.length <= 256), 'the poll title fits an embed title');

  const reminder = await session.run('remind add', { as: 'member', channel: nextChannel('text-over'), options: { time: '1h', message: long } });
  attack.assertRanCleanly(reminder, 'an over-long reminder');
  const [stored] = reminderService.listUserReminders({ userId: IDS.member }).filter((entry) => entry.message.startsWith('長'.repeat(50)));
  assert.ok(stored.message.length <= 1000, `a reminder is stored within 1000 characters (${stored.message.length})`);

});
