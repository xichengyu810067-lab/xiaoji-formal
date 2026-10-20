'use strict';

// A bot picked as waiter, chef, bartender or new assignee in /casino-venue.
//
// Discord's user picker lists every member of the server, bots included, and a slash-command user option has no
// autocomplete the bot could filter, so the picker may well offer a bot first. The command must refuse a bot plainly,
// naming the role, before it looks anything up. Only fake Discord objects and a temporary database path are used; no
// case here reaches the venue tables.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-venue-bot-staff-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.BOT_OWNER_ID = 'owner-user';

const { resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const logger = require('../src/utils/logger');
const venueCommand = require('../src/commands/casino-venue');

const GUILD_ID = '760000000000000001';
const CUSTOMER_ID = '760000000000000011';
const ADMIN_ID = '760000000000000012';
const HUMAN_ID = '760000000000000021';
const OTHER_HUMAN_ID = '760000000000000022';
const BOT_ID = '760000000000000099';

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

const human = (id) => ({ id, bot: false, toString: () => `<@${id}>` });
const bot = (id = BOT_ID) => ({ id, bot: true, toString: () => `<@${id}>` });

// Every id the command asks the guild about is recorded in `fetched`; replies are collected in order.
function createInteraction({ subcommand, users = {}, integers = {}, userId = CUSTOMER_ID, admin = false }) {
  const replies = [];
  const fetched = [];
  const interaction = {
    commandName: 'casino-venue',
    guildId: GUILD_ID,
    channelId: 'room',
    user: human(userId),
    memberPermissions: { has: () => admin },
    guild: {
      id: GUILD_ID,
      memberCount: 4,
      members: {
        me: { id: 'bot-self', permissions: { has: () => true } },
        async fetch(id) {
          fetched.push(id ?? 'ROSTER');
          if (!id) throw new Error('no roster in this test');
          return { id, guild: { id: GUILD_ID }, user: { bot: id === BOT_ID }, permissions: { has: () => admin } };
        },
      },
    },
    deferred: false,
    replied: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getUser: (name) => users[name] ?? null,
      getInteger: (name) => integers[name] ?? null,
      getString: () => null,
    },
    reply: async (payload) => { replies.push(payload); },
    followUp: async (payload) => { replies.push(payload); },
  };
  return { interaction, replies, fetched };
}

async function quietly(run) {
  const original = { warn: logger.warn, error: logger.error };
  logger.warn = () => {};
  logger.error = () => {};
  try {
    return await run();
  } finally {
    Object.assign(logger, original);
  }
}

test('/casino-venue order refuses a bot as the waiter, plainly, before any member lookup', async () => {
  const { interaction, replies, fetched } = createInteraction({
    subcommand: 'order', users: { waiter: bot() }, integers: { tip: 5, meal: 1 },
  });

  await quietly(() => venueCommand.execute(interaction));

  assert.deepEqual(replies, [{ content: '服務生不能是機器人，請改選真人成員。', ephemeral: true }]);
  // No member lookup and no roster fetch happened for the refused order.
  assert.deepEqual(fetched, []);
});

test('/casino-venue order also refuses a bot as the chef or the bartender, naming that role', async () => {
  for (const [option, role] of [['chef', '廚師'], ['bartender', '調酒師']]) {
    const { interaction, replies, fetched } = createInteraction({
      subcommand: 'order', users: { waiter: human(HUMAN_ID), [option]: bot() }, integers: { tip: 5, meal: 1, drink: 2 },
    });

    await quietly(() => venueCommand.execute(interaction));

    assert.deepEqual(replies, [{ content: `${role}不能是機器人，請改選真人成員。`, ephemeral: true }], option);
    assert.deepEqual(fetched, [], option);
  }
});

test('/casino-venue order lets a human waiter through the bot check to the member lookup', async () => {
  const { interaction, replies, fetched } = createInteraction({
    subcommand: 'order',
    users: { waiter: human(HUMAN_ID), chef: human(OTHER_HUMAN_ID) },
    integers: { tip: 5, meal: 1 },
  });

  await quietly(() => venueCommand.execute(interaction));

  // The humans were looked up, and whatever stopped the order afterwards (no venue data here) is not the bot refusal.
  assert.deepEqual(fetched, [HUMAN_ID, OTHER_HUMAN_ID]);
  assert.equal(replies.length, 1);
  assert.doesNotMatch(replies[0].content, /機器人/u);
});

test('/casino-venue reassign and reassign-waiter refuse a bot as the new assignee, naming the role', async () => {
  for (const [subcommand, role] of [['reassign', '新的製作者'], ['reassign-waiter', '新的服務生']]) {
    const { interaction, replies, fetched } = createInteraction({
      subcommand, users: { user: bot() }, integers: { 'order-item-id': 1, 'order-id': 1 }, userId: ADMIN_ID, admin: true,
    });

    await quietly(() => venueCommand.execute(interaction));

    assert.deepEqual(replies, [{ content: `${role}不能是機器人，請改選真人成員。`, ephemeral: true }], subcommand);
    // Only the administrator's own permission lookup happened; the bot was never looked up.
    assert.deepEqual(fetched, [ADMIN_ID], subcommand);
  }
});

test('/casino-venue reassign and reassign-waiter still look up a human assignee', async () => {
  for (const subcommand of ['reassign', 'reassign-waiter']) {
    const { interaction, replies, fetched } = createInteraction({
      subcommand, users: { user: human(HUMAN_ID) }, integers: { 'order-item-id': 1, 'order-id': 1 }, userId: ADMIN_ID, admin: true,
    });

    await quietly(() => venueCommand.execute(interaction));

    assert.deepEqual(fetched, [ADMIN_ID, HUMAN_ID], subcommand);
    assert.equal(replies.length, 1);
    assert.doesNotMatch(replies[0].content, /機器人/u, subcommand);
  }
});
