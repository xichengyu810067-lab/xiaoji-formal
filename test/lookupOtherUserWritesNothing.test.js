'use strict';

// Looking at somebody else's bank figures or economy report must not file them under the guild. Filing
// is what puts a user on the guild's leaderboard, so a lookup that filed would let any member (or, for the
// administrator reports, any administrator) put any user there just by looking them up. The administrator
// lookups of one user's global figures (wallet, bank, fixed deposits) are also only for a member of the server.
//
// These tests run the real commands on a real, temporary coin database and compare the whole database, and the
// file on disk, before and after each lookup. Only Discord is faked.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { makeRealTempDir } = require('./support/realTempDir');

const root = makeRealTempDir('xiaoji-lookup-');
process.env.COIN_DB_PATH = path.join(root, 'lookup.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

// The administrator check is not what these tests are about; it answers yes.
require('../src/utils/moderation').ensureModerationAccess = async () => ({ ok: true });

const bankCommand = require('../src/commands/bank');
const coinsCommand = require('../src/commands/coins');
const economyCommand = require('../src/commands/economy');
const { initializeNewCoinDatabase, resetCoinDatabaseForTests } = require('../src/services/coinDatabase');
const {
  createShopItem,
  getLeaderboard,
  purchaseItem,
  setGuildEconomyEnabled,
} = require('../src/services/coinService');
const { count, expectNoWrites, seedFixedDeposits, seedPlayer } = require('./support/coinDatabaseProbe');
const { createGuild, createSlashInteraction } = require('./support/fakeSlashInteraction');

const HOME = 'lookup-home-guild';
const OTHER = 'lookup-other-guild';
const OFF = 'lookup-off-guild';
const NOT_A_MEMBER = '只能查詢目前在此伺服器的成員。';
const COIN_SYSTEM_OFF = '這個伺服器的吉幣系統目前停用。';

const person = (id) => ({ id, username: id, globalName: `名稱-${id}`, tag: `${id}#0001` });
const CALLER = person('lookup-caller');
const ADMIN = person('lookup-admin');
// Never used the economy anywhere.
const UNSEEN = person('lookup-unseen-member');
// A member of HOME whose coins, bank and fixed deposits are all from another guild.
const MEMBER = person('lookup-member-with-assets');
// Not a member of HOME, with coins from another guild.
const OUTSIDER = person('lookup-outsider');

const MEMBER_IDS = [CALLER.id, ADMIN.id, UNSEEN.id, MEMBER.id];
const coinsText = (amount) => `${amount.toLocaleString('zh-TW')} 吉幣`;

const homeGuild = () => createGuild(HOME, MEMBER_IDS);

// What the economy holds for one user in HOME, counted straight from the tables.
async function rowsOf(userId, guildId = HOME) {
  return {
    wallets: await count('SELECT COUNT(*) AS count FROM coin_wallets WHERE user_id = ?', [userId]),
    guildPlayers: await count(
      'SELECT COUNT(*) AS count FROM coin_guild_players WHERE user_id = ? AND guild_id = ?', [userId, guildId]
    ),
    banks: await count('SELECT COUNT(*) AS count FROM coin_bank_accounts_global WHERE user_id = ?', [userId]),
  };
}

async function run(command, options) {
  const { interaction, replies } = createSlashInteraction(options);
  await command.execute(interaction);
  assert.equal(replies.length, 1, `${options.commandName} ${options.subcommand || ''} gave one answer`);
  return replies[0];
}

const coinsLookup = (guild, caller, target) => run(coinsCommand, {
  commandName: 'coins', guild, user: caller, users: target ? { user: target } : {},
});
const bankLookup = (subcommand, target) => run(bankCommand, {
  commandName: 'bank', subcommand, guild: homeGuild(), user: ADMIN, users: { user: target },
});
const economyAudit = (type, target) => run(economyCommand, {
  commandName: 'economy', subcommand: 'audit', guild: homeGuild(), user: ADMIN,
  strings: { type }, users: target ? { user: target } : {},
});
const economyUser = (target) => run(economyCommand, {
  commandName: 'economy', subcommand: 'user', guild: homeGuild(), user: ADMIN, users: { user: target },
});

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  // HOME has a player and a settings row.
  await seedPlayer({ guildId: HOME, userId: CALLER.id, wallet: 50 });
  await seedPlayer({ guildId: OTHER, userId: MEMBER.id, wallet: 500, bank: 120 });
  await seedFixedDeposits(MEMBER.id, OTHER, [
    { principal: 2000, expectedInterest: 40, maturityAt: '2027-01-01T00:00:00.000Z' },
  ]);
  await seedPlayer({ guildId: OTHER, userId: OUTSIDER.id, wallet: 777, bank: 33 });
  await seedFixedDeposits(OUTSIDER.id, OTHER, [
    { principal: 5000, expectedInterest: 90, maturityAt: '2027-01-01T00:00:00.000Z' },
  ]);
  await setGuildEconomyEnabled(OFF, false, { operatorId: 'seed-operator' });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------------------------------------
// /coins: the caller's own balance only
// ---------------------------------------------------------------------------------------------------------

test('/coins has no user option, so nobody else\'s balance can be looked up through it', async () => {
  assert.deepEqual(coinsCommand.data.toJSON().options || [], []);

  // Even a user handed in anyway (an old client, a forged payload) is not read: the answer is the caller's own, and
  // the other user stays where they were.
  const reply = await coinsLookup(homeGuild(), CALLER, OUTSIDER);

  assert.ok(reply.content.includes(`目前餘額：${coinsText(50)}`), reply.content);
  assert.doesNotMatch(reply.content, /777/u, reply.content);
  assert.equal(reply.content.includes(OUTSIDER.id), false);
  assert.deepEqual(await rowsOf(OUTSIDER.id, HOME), { wallets: 1, guildPlayers: 0, banks: 1 });
  const board = await getLeaderboard(HOME);
  assert.equal(board.players.some((player) => player.userId === OUTSIDER.id), false);
});

test('/coins is still refused in a guild whose coin system is off, and writes nothing', async () => {
  const reply = await expectNoWrites(() => coinsLookup(createGuild(OFF, [CALLER.id, UNSEEN.id]), CALLER, null));

  assert.equal(reply.content, COIN_SYSTEM_OFF);
});

test('/coins on oneself still files the user under the guild, as before', async () => {
  const newcomer = person('lookup-newcomer');
  assert.deepEqual(await rowsOf(newcomer.id), { wallets: 0, guildPlayers: 0, banks: 0 });

  const reply = await coinsLookup(createGuild(HOME, [newcomer.id]), newcomer, null);
  assert.ok(reply.content.includes('目前餘額：0 吉幣'), reply.content);

  assert.deepEqual(await rowsOf(newcomer.id), { wallets: 1, guildPlayers: 1, banks: 1 });
});

// ---------------------------------------------------------------------------------------------------------
// /bank balance-user and fixed-user
// ---------------------------------------------------------------------------------------------------------

test('/bank balance-user shows a member\'s global figures and files nobody under the guild', async () => {
  const withAssets = await expectNoWrites(() => bankLookup('balance-user', MEMBER));
  assert.ok(withAssets.content.includes(`錢包吉幣：${coinsText(500)}`), withAssets.content);
  assert.ok(withAssets.content.includes(`活存金額：${coinsText(120)}`), withAssets.content);
  assert.ok(withAssets.content.includes(`定存本金：${coinsText(2000)}`), withAssets.content);
  assert.deepEqual(await rowsOf(MEMBER.id, HOME), { wallets: 1, guildPlayers: 0, banks: 1 });

  const unseen = await expectNoWrites(() => bankLookup('balance-user', UNSEEN));
  assert.ok(unseen.content.includes(`錢包吉幣：${coinsText(0)}`), unseen.content);
  assert.ok(unseen.content.includes(`總資產：${coinsText(0)}`), unseen.content);
  assert.deepEqual(await rowsOf(UNSEEN.id), { wallets: 0, guildPlayers: 0, banks: 0 });
});

test('/bank balance-user and fixed-user refuse a user who is not in the server, and write nothing', async () => {
  for (const subcommand of ['balance-user', 'fixed-user']) {
    const reply = await expectNoWrites(() => bankLookup(subcommand, OUTSIDER));

    assert.equal(reply.content, NOT_A_MEMBER, subcommand);
    assert.equal(reply.ephemeral, true, subcommand);
    assert.doesNotMatch(reply.content, /777|5,000|lookup-outsider/u, subcommand);
  }
});

test('/bank fixed-user lists the fixed deposits of a member of the server', async () => {
  const reply = await expectNoWrites(() => bankLookup('fixed-user', MEMBER));

  assert.ok(reply.content.includes(`本金：${coinsText(2000)}`), reply.content);
  assert.ok(reply.content.includes(`<@${MEMBER.id}>`), reply.content);
});

// ---------------------------------------------------------------------------------------------------------
// /economy audit and /economy user
// ---------------------------------------------------------------------------------------------------------

test('/economy audit with a user refuses somebody outside the server for balances, fixed deposits and inventory', async () => {
  for (const type of ['balances', 'fixed', 'inventory']) {
    const reply = await expectNoWrites(() => economyAudit(type, OUTSIDER));

    assert.equal(reply.content, NOT_A_MEMBER, type);
    assert.doesNotMatch(reply.content, /777|5,000|lookup-outsider/u, type);
  }
});

test('/economy audit balances and fixed with a member show that member and write nothing', async () => {
  const balances = await expectNoWrites(() => economyAudit('balances', MEMBER));
  assert.ok(balances.content.includes(`<@${MEMBER.id}>`), balances.content);
  assert.ok(balances.content.includes(`錢包 ${coinsText(500)}`), balances.content);
  assert.ok(balances.content.includes(`定存本金 ${coinsText(2000)}`), balances.content);
  assert.deepEqual(await rowsOf(MEMBER.id, HOME), { wallets: 1, guildPlayers: 0, banks: 1 });

  const unseen = await expectNoWrites(() => economyAudit('balances', UNSEEN));
  assert.ok(unseen.content.includes(`錢包 ${coinsText(0)}`), unseen.content);
  assert.deepEqual(await rowsOf(UNSEEN.id), { wallets: 0, guildPlayers: 0, banks: 0 });

  const fixed = await expectNoWrites(() => economyAudit('fixed', MEMBER));
  assert.ok(fixed.content.includes(`<@${MEMBER.id}>`), fixed.content);
  assert.ok(fixed.content.includes(coinsText(2000)), fixed.content);
});

test('/economy user on a member the economy has not seen writes nothing, not even for the inventory', async () => {
  const reply = await expectNoWrites(() => economyUser(UNSEEN));

  assert.ok(reply.content.includes(`名稱-${UNSEEN.id} 經濟資料`), reply.content);
  assert.ok(reply.content.includes(`錢包 ${coinsText(0)}`), reply.content);
  assert.ok(reply.content.includes('擁有商品：0 種'), reply.content);
  assert.deepEqual(await rowsOf(UNSEEN.id), { wallets: 0, guildPlayers: 0, banks: 0 });
});

test('/economy user refuses somebody outside the server and writes nothing', async () => {
  const reply = await expectNoWrites(() => economyUser(OUTSIDER));

  assert.equal(reply.content, NOT_A_MEMBER);
});

test('/economy user counts only the purchases made in this server', async () => {
  const buyer = person('lookup-buyer');
  const homeItem = await createShopItem(HOME, {
    name: '本群徽章', price: 5, type: 'collectible', stock: null, purchaseLimit: null, createdBy: ADMIN.id,
  });
  const otherItem = await createShopItem(OTHER, {
    name: '他群徽章', price: 5, type: 'collectible', stock: null, purchaseLimit: null, createdBy: ADMIN.id,
  });
  await seedPlayer({ guildId: OTHER, userId: buyer.id, wallet: 100 });
  await purchaseItem(OTHER, buyer.id, otherItem.id, 1);
  await purchaseItem(OTHER, buyer.id, otherItem.id, 1);
  await purchaseItem(HOME, buyer.id, homeItem.id, 1);

  const reply = await expectNoWrites(() => run(economyCommand, {
    commandName: 'economy',
    subcommand: 'user',
    guild: createGuild(HOME, [ADMIN.id, buyer.id]),
    user: ADMIN,
    users: { user: buyer },
  }));

  assert.ok(reply.content.includes('購買紀錄：最近 1 筆'), reply.content);
  // The inventory is global and lists both items; the purchases are the ones made here.
  const purchases = reply.content.split('**最近購買**\n')[1].split('\n\n**擁有商品**')[0];
  assert.ok(purchases.includes('本群徽章'), purchases);
  assert.equal(purchases.includes('他群徽章'), false, purchases);
});
