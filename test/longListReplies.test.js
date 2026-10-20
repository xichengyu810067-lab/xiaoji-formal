'use strict';

// Every command that joins stored rows into one reply has to answer inside Discord's 2000 characters, however long
// the stored text is and however many rows the list holds. For each such command (test/support/longListFixtures.js):
//   - a list that fits is answered exactly as it was before the length guard (the golden replies of
//     test/fixtures/longListReplies.golden.json are what the commands answered then);
//   - the longest list its options and stores allow still fits one message, its rows are the first ones in order,
//     and the reply says that text was shortened ("…") or how many rows were left out ("另有 N …未顯示").
// The services are replaced by the fixture of the run; everything from the command to the reply is the real code.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { SERVICE_FUNCTIONS, SITES, USER_ID, fakeInteraction } = require('./support/longListFixtures');

process.env.BOT_OWNER_ID = USER_ID;

const GOLDEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'longListReplies.golden.json'), 'utf8'));

// What a service function answers during a run is set per test; the stub calls whatever is set.
const state = {};
for (const [service, names] of Object.entries(SERVICE_FUNCTIONS)) {
  const file = require.resolve(`../src/services/${service}`);
  const real = require(file);
  const stubs = Object.fromEntries(names.map((name) => [name, (...args) => state[name](...args)]));
  require.cache[file].exports = { ...real, ...stubs };
}

const commands = {};
for (const name of new Set([...SITES.map((site) => site.command), 'casino-venue', 'remind'])) {
  commands[name] = require(`../src/commands/${name}`);
}

async function run({ command, subcommand = null, ints, strings, user }, data) {
  Object.assign(state, data);
  const { interaction, replies } = fakeInteraction({ commandName: command, subcommand, ints, strings, user });
  await commands[command].execute(interaction);
  assert.equal(replies.length, 1, `/${command} answers once`);
  return replies[0];
}

const SHORT_TEXT = '短文字';
// Longer than any option or stored text allows, so that a builder takes as much of it as it can.
const LONGEST_TEXT = '掃描長文字測試，'.repeat(130);

const omittedOf = (content) => {
  const match = /另有 (\d+) [^\s，。（）]{1,12}未顯示（訊息長度已達上限）/u.exec(content);
  return match ? Number(match[1]) : 0;
};

for (const site of SITES) {
  test(site.name, async (t) => {
    assert.ok(GOLDEN[site.name], 'a golden reply is kept for this command');

    await t.test('a list that fits is answered exactly as before', async () => {
      const reply = await run(site, site.data(2, SHORT_TEXT));
      assert.equal(reply.content, GOLDEN[site.name]);
      assert.equal(reply.ephemeral, true);
    });

    await t.test('the longest list fits one message and says what was shortened or left out', async () => {
      const reply = await run(site, site.data(site.maxRows, LONGEST_TEXT.slice(0, site.textMax)));
      const { content } = reply;
      assert.equal(reply.ephemeral, true);
      assert.ok(content.length <= 2000, `${content.length} characters`);
      if (!site.noHeading) assert.equal(content.split('\n')[0], GOLDEN[site.name].split('\n')[0], 'the heading stays');

      const omitted = omittedOf(content);
      assert.ok(omitted > 0 || content.includes('…'), 'the reply says that something was shortened or left out');
      assert.doesNotMatch(content, /undefined|NaN|\[object/u);

      if (site.marker) {
        const ids = [...content.matchAll(site.marker)].map((match) => match[1]);
        if (ids.length > 0 && ids[0] !== undefined) {
          assert.deepEqual(ids.map(Number), ids.map((_, index) => index + 1), 'the first rows are shown, in their order');
        }
        assert.equal(ids.length + omitted, site.maxRows, `${ids.length} rows shown and ${omitted} left out`);
      }
    });
  });
}

test('/remind list: ten reminders at most, as before, each cut to fit when they are long', async () => {
  const site = { command: 'remind', subcommand: 'list' };
  const reminder = (index, message) => ({
    id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, status: 'pending',
    remindAt: 1_800_000_000_000 + index * 60_000, message, failureReason: '',
  });
  const many = (count, message) => Array.from({ length: count }, (_, index) => reminder(index + 1, message));

  const twelveShort = await run(site, { listUserReminders: () => many(12, '短提醒') });
  assert.equal(twelveShort.content, GOLDEN['remind list with twelve short reminders']);

  const states = [
    { id: 'a'.repeat(36), status: 'failed', remindAt: 1_800_000_000_000, message: '失敗的提醒', failureReason: '提醒被輸出政策拒絕，未送出。' },
    { id: 'b'.repeat(36), status: 'sending', remindAt: 1_800_000_060_000, message: '送出中的提醒', failureReason: '' },
    { id: 'c'.repeat(36), status: 'failed', remindAt: 1_800_000_120_000, message: '沒有原因的失敗', failureReason: '' },
  ];
  const withStates = await run(site, { listUserReminders: () => states });
  assert.equal(withStates.content, GOLDEN['remind list with a failed and a sending reminder']);

  // Twelve reminders of a thousand characters: the ten that are listed are each cut to the same length so that they
  // fit, and nothing is said about the two past the tenth, as it was not before.
  const twelveLong = await run(site, { listUserReminders: () => many(12, LONGEST_TEXT.slice(0, 1000)) });
  assert.ok(twelveLong.content.length <= 2000, `${twelveLong.content.length} characters`);
  const lines = twelveLong.content.split('\n');
  assert.equal(lines.length, 10);
  assert.ok(lines.every((line) => line.endsWith('…')));
  assert.equal(new Set(lines.map((line) => line.length)).size, 1, 'every reminder is cut to the same length');
  assert.equal(omittedOf(twelveLong.content), 0);
});

test('/remind: only a failure of the reminder data is reported as unreadable data', async () => {
  const site = { command: 'remind', subcommand: 'list' };
  const unreadable = '提醒資料目前無法安全讀寫，請聯絡管理員檢查資料檔與初始化狀態。';

  // The data cannot be read: that is what the message is for.
  const data = await run(site, { listUserReminders: () => { throw new Error('Reminder data is empty.'); } });
  assert.deepEqual(data, { content: unreadable, ephemeral: true });

  // A reminder past the limit of twenty has its own text.
  const full = await run({ command: 'remind', subcommand: 'add', strings: { time: '10m', message: '喝水' } }, {
    parseReminderDuration: () => ({ ms: 600_000 }),
    createReminder: () => ({ id: 'r1', remindAt: 1_800_000_000_000 }),
    addReminder: () => { throw Object.assign(new Error('limit'), { code: 'REMINDER_ACTIVE_LIMIT' }); },
  });
  assert.deepEqual(full, {
    content: '你目前已有 20 則進行中的提醒；請先完成或刪除一則後再新增。',
    ephemeral: true,
  });

  // Discord refusing the reply is not the reminder data: the error goes to the handler, and no second reply tells the
  // member that the data is unreadable.
  state.listUserReminders = () => [];
  const sent = [];
  const { interaction } = fakeInteraction({ commandName: 'remind', subcommand: 'list' });
  interaction.reply = async (payload) => {
    sent.push(payload);
    throw Object.assign(new Error('Invalid Form Body'), { code: 50035 });
  };
  interaction.followUp = async (payload) => sent.push(payload);
  await assert.rejects(commands.remind.execute(interaction), { code: 50035 });
  assert.equal(sent.length, 1, 'no second reply was tried');
  assert.doesNotMatch(JSON.stringify(sent), /無法安全讀寫/u);
});

test('/casino-venue steps: a recipe that fits is answered as before, and hundreds of short steps are cut with a count', async () => {
  const steps = '備料\n下鍋翻炒;盛盤';
  const added = await run({ command: 'casino-venue', subcommand: 'add-menu', strings: { type: 'meal', name: '蛋炒飯', steps } }, {
    addVenueMenuItem: async () => ({ id: 7, itemType: 'meal', name: '蛋炒飯', steps: '備料\n下鍋翻炒\n盛盤' }),
  });
  assert.equal(added.content, GOLDEN['casino-venue add-menu with three steps']);

  const recipe = await run({ command: 'casino-venue', subcommand: 'recipe', ints: { 'order-item-id': 1 } }, {
    getVenueRecipe: async () => ({ itemName: '蛋炒飯', standardSteps: '備料\n下鍋翻炒\n盛盤' }),
  });
  assert.equal(recipe.content, GOLDEN['casino-venue recipe with three steps']);

  const empty = await run({ command: 'casino-venue', subcommand: 'recipe', ints: { 'order-item-id': 1 } }, {
    getVenueRecipe: async () => ({ itemName: '蛋炒飯', standardSteps: '' }),
  });
  assert.equal(empty.content, GOLDEN['casino-venue recipe without steps']);

  const made = await run({ command: 'casino-venue', subcommand: 'make', ints: { 'order-item-id': 1 }, strings: { steps: '備料\n翻炒;盛盤' } }, {
    completeVenueOrderItem: async () => ({
      item: { itemName: '蛋炒飯', id: 9, actualSteps: '備料\n翻炒;盛盤' }, order: { customerId: '623456789012345678' },
    }),
  });
  assert.equal(made.content, GOLDEN['casino-venue make with three steps']);

  // A thousand characters can be five hundred one-character steps, which numbered are far past 2000 characters.
  const crowded = Array.from({ length: 500 }, () => 'a').join(';');
  assert.equal(crowded.length, 999);
  const normalized = crowded.split(';').join('\n');
  const replies = [
    await run({ command: 'casino-venue', subcommand: 'add-menu', strings: { type: 'meal', name: '長菜單', steps: crowded } }, {
      addVenueMenuItem: async () => ({ id: 7, itemType: 'meal', name: '長菜單', steps: normalized }),
    }),
    await run({ command: 'casino-venue', subcommand: 'recipe', ints: { 'order-item-id': 1 } }, {
      getVenueRecipe: async () => ({ itemName: '長菜單', standardSteps: normalized }),
    }),
    await run({ command: 'casino-venue', subcommand: 'make', ints: { 'order-item-id': 1 }, strings: { steps: crowded } }, {
      completeVenueOrderItem: async () => ({
        item: { itemName: '長菜單', id: 9, actualSteps: crowded }, order: { customerId: '623456789012345678' },
      }),
    }),
  ];
  for (const reply of replies) {
    assert.ok(reply.content.length <= 2000, `${reply.content.length} characters`);
    const numbered = [...reply.content.matchAll(/^(\d+)\. a$/gmu)].map((match) => Number(match[1]));
    assert.ok(numbered.length > 100 && numbered.length < 500, `${numbered.length} steps shown`);
    assert.deepEqual(numbered, numbered.map((_, index) => index + 1), 'the first steps, in order');
    assert.equal(reply.content.split('\n').at(-1), `另有 ${500 - numbered.length} 個步驟未顯示（訊息長度已達上限）。`);
  }
});
