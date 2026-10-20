'use strict';

// /economy audit type:inventory without a user used to list every row of the global inventory table: the ID,
// the item and the quantity of everybody who ever bought something, including people who never used the economy
// in the guild. Like the purchase audit, which keeps only the purchases made in the guild, it lists the players
// of the guild. These tests run the real service and command on a real, temporary coin database.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { makeRealTempDir } = require('./support/realTempDir');

const root = makeRealTempDir('xiaoji-inventory-audit-');
process.env.COIN_DB_PATH = path.join(root, 'inventory.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

require('../src/utils/moderation').ensureModerationAccess = async () => ({ ok: true });

const economyCommand = require('../src/commands/economy');
const { initializeNewCoinDatabase, resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const { createShopItem, getAllInventory, purchaseItem } = require('../src/services/coinService');
const { expectNoWrites, seedPlayer } = require('./support/coinDatabaseProbe');
const { createGuild, createSlashInteraction } = require('./support/fakeSlashInteraction');

const HOME = 'inventory-home-guild';
const OTHER = 'inventory-other-guild';
const NOT_A_MEMBER = '只能查詢目前在此伺服器的成員。';

const ADMIN = { id: 'inventory-admin', username: 'inventory-admin', globalName: '管理員' };
// Played in HOME and bought there.
const HOME_PLAYER = { id: 'inventory-home-player', username: 'home-player', globalName: '本群玩家' };
// Never used the economy in HOME; bought in OTHER only.
const OTHER_PLAYER = { id: 'inventory-other-player', username: 'other-player', globalName: '他群玩家' };
// Played in both guilds.
const BOTH_PLAYER = { id: 'inventory-both-player', username: 'both-player', globalName: '兩群玩家' };

const buy = async (guildId, user, item, quantity = 1) => {
  await seedPlayer({ guildId, userId: user.id, wallet: 1000 });
  await purchaseItem(guildId, user.id, item.id, quantity);
};

const audit = async (users = {}) => {
  const { interaction, replies } = createSlashInteraction({
    commandName: 'economy',
    subcommand: 'audit',
    guild: createGuild(HOME, [ADMIN.id, HOME_PLAYER.id, BOTH_PLAYER.id]),
    user: ADMIN,
    strings: { type: 'inventory' },
    users,
    integers: { limit: 25 },
  });
  await economyCommand.execute(interaction);
  assert.equal(replies.length, 1);
  return replies[0].content;
};

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  const homeItem = await createShopItem(HOME, {
    name: '本群紀念章', price: 10, type: 'collectible', stock: null, purchaseLimit: null, createdBy: ADMIN.id,
  });
  const otherItem = await createShopItem(OTHER, {
    name: '他群紀念章', price: 10, type: 'collectible', stock: null, purchaseLimit: null, createdBy: ADMIN.id,
  });
  await buy(HOME, HOME_PLAYER, homeItem, 2);
  await buy(OTHER, OTHER_PLAYER, otherItem, 3);
  await buy(OTHER, BOTH_PLAYER, otherItem, 1);
  await seedPlayer({ guildId: HOME, userId: BOTH_PLAYER.id, wallet: 900 });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

test('the inventory list of a guild holds only the players of that guild', async () => {
  const home = await getAllInventory(HOME, { limit: 25 });
  assert.deepEqual(home.map((row) => row.userId).sort(), [BOTH_PLAYER.id, HOME_PLAYER.id].sort());

  const other = await getAllInventory(OTHER, { limit: 25 });
  assert.deepEqual(other.map((row) => row.userId).sort(), [BOTH_PLAYER.id, OTHER_PLAYER.id].sort());
});

test('the inventory list of one user is that user\'s rows', async () => {
  const rows = await getAllInventory(HOME, { userId: HOME_PLAYER.id, limit: 25 });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].itemName, '本群紀念章');
  assert.equal(rows[0].quantity, 2);
});

test('/economy audit inventory lists the guild\'s players and nobody who never used the economy there', async () => {
  const content = await expectNoWrites(() => audit());

  assert.ok(content.includes(`<@${HOME_PLAYER.id}>`), content);
  assert.ok(content.includes('本群紀念章 x2'), content);
  assert.ok(content.includes(`<@${BOTH_PLAYER.id}>`), content);
  assert.equal(content.includes(OTHER_PLAYER.id), false, content);
  assert.equal(content.includes('x3'), false, content);
});

test('/economy audit inventory with a user shows a member and refuses somebody outside the server', async () => {
  const member = await expectNoWrites(() => audit({ user: HOME_PLAYER }));
  assert.ok(member.includes(`<@${HOME_PLAYER.id}>`), member);
  assert.ok(member.includes('本群紀念章 x2'), member);

  const outsider = await expectNoWrites(() => audit({ user: OTHER_PLAYER }));
  assert.equal(outsider, NOT_A_MEMBER);
});
