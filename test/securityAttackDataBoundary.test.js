'use strict';

// Attack tests for what one guild can see or change of another guild's data.
//
// A guild's administrator is not the bot owner, so the question for every query and every setting is "does
// guild A's call stay inside guild A, or inside data the player owns across guilds on purpose?". Wallet, bank,
// chips, loans and fixed deposits are shared by all of a player's guilds by design (README, economy section);
// the guild only decides which switch applies, which roster the player is listed in and where a record is filed.
// The tests pin those rules and attack everything that is meant to stay inside one guild, through the services
// and through the real commands, with only Discord replaced by a small fake.
//
// A plain test that passes is a defence that held.

const test = require('node:test');
const assert = require('node:assert/strict');

const harness = require('./support/securityAttackHarness');

const root = harness.createAttackEnvironment('xiaoji-attack-boundary-');

// The administrator check is not what these tests are about; it answers yes.
require('../src/utils/moderation').ensureModerationAccess = async () => ({ ok: true });

const bankCommand = require('../src/commands/bank');
const coinsCommand = require('../src/commands/coins');
const economyCommand = require('../src/commands/economy');
const workCommand = require('../src/commands/work');
const coin = require('../src/services/coinService');
const bankService = require('../src/services/bankService');
const casinoService = require('../src/services/casinoService');
const workService = require('../src/services/workService');
const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const { configureWorkRewardCoordinator } = require('../src/systems/work/workRewardPort');
const { withCoinTransaction } = require('../src/services/coinDatabase');
const { createGuild, createSlashInteraction } = require('./support/fakeSlashInteraction');

configureWorkRewardCoordinator(createRuntimeRewardCoordinator());

const GUILD_A = '830000000000000001';
const GUILD_B = '830000000000000002';
const SHARED = '830000000000000011'; // a member of both guilds
const B_ONLY = '830000000000000012'; // never joined guild A
const A_ONLY = '830000000000000013'; // never joined guild B
const ADMIN = '830000000000000014'; // the administrator who asks in guild A
const OPERATOR = '830000000000000099';
const START = '2026-03-02T01:00:00.000Z';
const NOT_A_MEMBER = '只能查詢目前在此伺服器的成員。';
const OTHER_SERVER = '其他伺服器';

const previousOwner = process.env.BOT_OWNER_ID;
process.env.BOT_OWNER_ID = OPERATOR;

test.after(() => {
  if (previousOwner === undefined) delete process.env.BOT_OWNER_ID;
  else process.env.BOT_OWNER_ID = previousOwner;
  harness.closeAttackDatabase(root);
});

let fundings = 0;
async function fund(guildId, userId, amount) {
  fundings += 1;
  return coin.adjustPlayerBalance(guildId, userId, {
    action: 'add', amount, operatorId: OPERATOR, reason: 'attack seed', operationId: `attack-boundary-fund-${fundings}`,
  });
}

// Rows the application can no longer create (the guild-scoped jobs of before the global primary job) are
// inserted the way they are stored, so the old queries still have something to refuse to leak.
async function insertLegacyJob({ guildId, userId, jobName, dailySalary, workDays }) {
  await withCoinTransaction((api) => api.run(
    `INSERT INTO coin_jobs (
      guild_id, user_id, job_name, job_role_id, daily_salary, work_days, total_salary,
      status, is_paid, start_at, pay_at, last_contribution_at, today_task_count,
      today_completed_task_count, no_work_available_today, payroll_status, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'active', 0, ?, ?, NULL, 0, 0, 0, 'pending', ?, ?)`,
    [guildId, userId, jobName, dailySalary, workDays, dailySalary * workDays, START, '2026-03-20T14:00:00.000Z', START, START]
  ));
}

// Guild A knows A_ONLY, SHARED and its administrator; guild B knows B_ONLY and SHARED. SHARED chose its primary
// job in guild B, B_ONLY chose one in guild B, A_ONLY chose one in guild A, and each guild also holds an old job.
async function openTwoGuilds() {
  await harness.openAttackDatabase(root);
  await fund(GUILD_A, SHARED, 1_000);
  await fund(GUILD_B, SHARED, 1_000);
  await fund(GUILD_B, B_ONLY, 2_000);
  await fund(GUILD_A, A_ONLY, 3_000);
  await fund(GUILD_A, ADMIN, 10);
  await workService.startJob(GUILD_B, SHARED, '會計師', 3);
  await workService.startJob(GUILD_B, B_ONLY, '老師', 2);
  await workService.startJob(GUILD_A, A_ONLY, '清潔工', 2);
  await insertLegacyJob({ guildId: GUILD_B, userId: B_ONLY, jobName: '廚師', dailySalary: 70, workDays: 5 });
  await insertLegacyJob({ guildId: GUILD_A, userId: A_ONLY, jobName: '迎賓員', dailySalary: 50, workDays: 5 });
}

const person = (id, name) => ({ id, username: id, globalName: name, tag: `${id}#0001` });
const guildAMembers = () => createGuild(GUILD_A, [SHARED, A_ONLY, ADMIN]);

async function run(command, options) {
  const { interaction, replies } = createSlashInteraction(options);
  await command.execute(interaction);
  assert.equal(replies.length, 1, `${options.commandName} ${options.subcommand || ''} gave one answer`);
  return replies[0].content;
}

const bankAsAdmin = (subcommand, target) => run(bankCommand, {
  commandName: 'bank', subcommand, guild: guildAMembers(), user: person(ADMIN, 'admin'), users: { user: target },
});
const economyAsAdmin = (subcommand, options = {}) => run(economyCommand, {
  commandName: 'economy', subcommand, guild: guildAMembers(), user: person(ADMIN, 'admin'), ...options,
});

// ---------------------------------------------------------------------------------------------------------
// The work overview of one guild
// ---------------------------------------------------------------------------------------------------------

test('the guild-wide work overview needs the guild\'s own member list and never lists another guild\'s old jobs', async () => {
  await openTwoGuilds();
  for (const visibleUserIds of [undefined, null]) {
    await assert.rejects(workService.getAllWorkStatuses(GUILD_A, { limit: 25, visibleUserIds }),
      { code: 'WORK_VISIBILITY_REQUIRED' });
  }
  const rows = await workService.getAllWorkStatuses(GUILD_A, { limit: 25, visibleUserIds: [SHARED, A_ONLY] });
  const legacy = rows.filter((row) => row.scope === 'legacy');
  assert.deepEqual(legacy.map((row) => [row.guildId, row.userId, row.jobName]), [[GUILD_A, A_ONLY, '迎賓員']]);
  assert.equal(rows.some((row) => row.userId === B_ONLY),
    false, 'a member who is only in guild B (primary job and old job alike) is not shown to guild A');
  assert.equal(rows.some((row) => row.jobName === '廚師' || row.jobName === '老師'), false);
});

test('the member list is the filter: an empty list shows no global primary job, a list shows exactly its members', async () => {
  await openTwoGuilds();
  const emptyList = await workService.getAllWorkStatuses(GUILD_A, { limit: 25, visibleUserIds: [] });
  assert.deepEqual(emptyList.filter((row) => row.scope === 'primary'), []);
  // The list the caller passes is the whole boundary, so it is the caller's job to pass the guild's own members.
  const named = await workService.getAllWorkStatuses(GUILD_A, { limit: 25, visibleUserIds: [B_ONLY] });
  assert.deepEqual(named.filter((row) => row.scope === 'primary').map((row) => row.userId), [B_ONLY]);
  // The command hands over members.keys(), an iterator, not an array.
  const members = new Map([[A_ONLY, {}], [SHARED, {}]]);
  const viaIterator = await workService.getAllWorkStatuses(GUILD_A, { limit: 25, visibleUserIds: members.keys() });
  assert.deepEqual(viaIterator.filter((row) => row.scope === 'primary').map((row) => row.userId).sort(), [A_ONLY, SHARED].sort());
  const oversized = await workService.getAllWorkStatuses(GUILD_A, { limit: 1e9, visibleUserIds: [SHARED, A_ONLY] });
  assert.ok(oversized.length <= 25);
});

test('the work replies of guild A leave out a primary job chosen in guild B whole: no id of B, no "other server", no job name', async (t) => {
  const clock = harness.startClock(t, START);
  await openTwoGuilds();
  clock.at('2026-03-02T14:00:00.000Z');
  assert.deepEqual((await workService.processDueJobs(null)).activations, { checked: 3, activated: 3 });
  await workService.reportWork(GUILD_B, SHARED, { description: 'report made for guild B', channelName: '會計師' });
  clock.at('2026-03-05T14:00:01.000Z');
  assert.equal((await workService.processDueJobs(null)).primaryCycles.settled >= 1, true);

  const statusAll = await run(workCommand, {
    commandName: 'work', subcommand: 'status-all', guild: guildAMembers(), user: person(ADMIN, 'admin'),
    integers: { limit: 25 },
  });
  const audit = await economyAsAdmin('audit', { strings: { type: 'work' }, integers: { limit: 25 } });
  const memberAudit = await economyAsAdmin('audit', { strings: { type: 'work' }, users: { user: person(SHARED, 'shared') } });
  const report = await economyAsAdmin('user', { users: { user: person(SHARED, 'shared') } });

  for (const [name, text] of Object.entries({ statusAll, audit, memberAudit, report })) {
    assert.equal(text.includes(GUILD_B), false, `${name} carries the id of guild B: ${text.slice(0, 300)}`);
    assert.equal(text.includes(B_ONLY), false, `${name} lists a member who only belongs to guild B`);
    assert.equal(text.includes('廚師') || text.includes('老師'), false, `${name} shows a job chosen only in guild B`);
    assert.equal(text.includes(OTHER_SERVER), false, `${name} names another server as the source of a job`);
    assert.equal(text.includes('會計師'), false, `${name} shows the global primary job chosen in guild B`);
  }
  assert.ok(memberAudit.includes('本伺服器沒有進行中的工作'), memberAudit);
  assert.ok(statusAll.includes(GUILD_A), 'a job chosen in this guild keeps showing this guild\'s id');
});

// ---------------------------------------------------------------------------------------------------------
// Switches, records and quotas stay inside their guild
// ---------------------------------------------------------------------------------------------------------

test('the wallet, bank and chips are one player account seen from every guild, by design', async () => {
  await openTwoGuilds();
  await fund(GUILD_A, SHARED, 500);
  assert.equal((await coin.getPlayerBalance(GUILD_B, SHARED)).balance, 2_500, 'guild B sees what guild A paid');
  await bankService.deposit(GUILD_B, SHARED, 300);
  assert.equal((await coin.getPlayerBalance(GUILD_A, SHARED)).bankBalance, 300);
  assert.equal((await coin.getPlayerBalance(GUILD_A, SHARED)).balance, 2_200);
});

test('switching the coin system off in guild A refuses guild A only; guild B and the wallet keep working', async () => {
  await openTwoGuilds();
  const settingsBefore = await coin.getGuildCoinSettings(GUILD_B);
  await coin.setGuildEconomyEnabled(GUILD_A, false, { operatorId: OPERATOR });
  assert.deepEqual(await coin.getGuildCoinSettings(GUILD_B), settingsBefore, "guild B's settings row is untouched");

  const shopItem = await coin.createShopItem(GUILD_B, { name: 'sold in B', price: 10, createdBy: OPERATOR });
  await assert.rejects(coin.dailyCheckin(GUILD_A, SHARED, new Date(START)), { code: 'COIN_DISABLED' });
  await assert.rejects(bankService.deposit(GUILD_A, SHARED, 10), { code: 'COIN_DISABLED' });
  await assert.rejects(coin.purchaseItem(GUILD_A, SHARED, shopItem.id, 1), { code: 'COIN_DISABLED' });
  await assert.rejects(casinoService.playDice(GUILD_A, SHARED, { amount: 10, choice: 'big' }), { code: 'COIN_DISABLED' });
  await assert.rejects(workService.startJob(GUILD_A, B_ONLY, '會計師', 1),
    (error) => ['COIN_DISABLED', 'PRIMARY_JOB_EXISTS'].includes(error.code));

  const bought = await coin.purchaseItem(GUILD_B, SHARED, shopItem.id, 1);
  assert.equal(bought.totalPrice, 10);
  await bankService.deposit(GUILD_B, SHARED, 10);
  await coin.setGuildEconomyEnabled(GUILD_A, true, { operatorId: OPERATOR });
  assert.equal((await coin.getPlayerBalance(GUILD_A, SHARED)).balance, 1_000 + 1_000 - 10 - 10);
  await harness.assertMoneyLedgersConsistent('guild switch');
});

test('guild A\'s histories, rosters and boards do not list what happened only in guild B', async () => {
  await openTwoGuilds();
  const itemB = await coin.createShopItem(GUILD_B, { name: 'bought in B', price: 10, createdBy: OPERATOR });
  await coin.purchaseItem(GUILD_B, B_ONLY, itemB.id, 1);
  const itemA = await coin.createShopItem(GUILD_A, { name: 'bought in A', price: 10, createdBy: OPERATOR });
  await coin.purchaseItem(GUILD_A, A_ONLY, itemA.id, 1);
  const roster = [A_ONLY, ADMIN, SHARED].sort();

  const transactionsOfA = await coin.getAllTransactions(GUILD_A, { limit: 25 });
  assert.ok(transactionsOfA.length > 0);
  assert.ok(transactionsOfA.every((row) => row.guildId === GUILD_A), 'only guild A\'s transactions');
  assert.equal(transactionsOfA.some((row) => row.userId === B_ONLY), false);
  assert.deepEqual(await coin.getTransactions(GUILD_A, B_ONLY, { limit: 25 }), []);
  const purchasesOfA = await coin.getAllPurchaseHistory(GUILD_A, { limit: 25 });
  assert.deepEqual(purchasesOfA.map((row) => [row.guildId, row.userId]), [[GUILD_A, A_ONLY]]);
  assert.deepEqual((await coin.getAllPlayers(GUILD_A, { limit: 25 })).map((row) => row.userId).sort(), roster);
  assert.deepEqual((await coin.getLeaderboard(GUILD_A, { limit: 25 })).players.map((row) => row.userId).sort(), roster);
  assert.deepEqual((await bankService.getAllBalanceSummaries(GUILD_A, { limit: 25 })).map((row) => row.userId).sort(), roster);
  assert.deepEqual(await workService.listWorkTasks(GUILD_A, { limit: 25 }), []);
  assert.deepEqual(await workService.getPayrollHistory(GUILD_A, { limit: 25 }), []);
});

test('the inventory list of a guild holds only the players of that guild', async () => {
  await openTwoGuilds();
  const item = await coin.createShopItem(GUILD_B, { name: 'held only by a guild B member', price: 10, createdBy: OPERATOR });
  await coin.purchaseItem(GUILD_B, B_ONLY, item.id, 2);
  const own = await coin.createShopItem(GUILD_A, { name: 'held by a guild A member', price: 10, createdBy: OPERATOR });
  await coin.purchaseItem(GUILD_A, A_ONLY, own.id, 1);

  const shown = await coin.getAllInventory(GUILD_A, { limit: 25 });
  assert.deepEqual(shown.map((row) => [row.userId, row.itemName, row.quantity]), [[A_ONLY, 'held by a guild A member', 1]]);
  const ofB = await coin.getAllInventory(GUILD_B, { limit: 25 });
  assert.deepEqual(ofB.map((row) => row.userId), [B_ONLY]);
});

test('a work submission of guild B cannot be read, edited, deleted or reviewed with guild A\'s id', async (t) => {
  const clock = harness.startClock(t, START);
  await openTwoGuilds();
  clock.at('2026-03-02T14:00:00.000Z');
  await workService.processDueJobs(null);
  clock.advance(60_000);
  const submitted = await workService.reportWork(GUILD_B, B_ONLY, { description: 'secret b report', channelName: '老師' });
  const submissionId = submitted.task.id;
  const before = await harness.snapshotAllTables();

  assert.deepEqual(await workService.listWorkTasks(GUILD_A, { userId: B_ONLY, limit: 25 }), []);
  await assert.rejects(workService.editWorkSubmission(GUILD_A, B_ONLY, submissionId, { description: 'changed' }),
    { code: 'SUBMISSION_NOT_FOUND' });
  await assert.rejects(workService.editWorkSubmission(GUILD_A, OPERATOR, submissionId, { description: 'changed', canManage: true }),
    { code: 'SUBMISSION_NOT_FOUND' }, 'a guild A manager is not a manager of guild B');
  await assert.rejects(workService.deleteWorkSubmission(GUILD_A, OPERATOR, submissionId, { canManage: true }),
    { code: 'SUBMISSION_NOT_FOUND' });
  await assert.rejects(workService.reviewWorkSubmission(GUILD_A, OPERATOR, submissionId, { action: 'approved' }),
    { code: 'SUBMISSION_NOT_FOUND' });
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);

  // In its own guild the same calls find it, which proves the refusals above are about the guild.
  await assert.rejects(workService.editWorkSubmission(GUILD_B, SHARED, submissionId, { description: 'changed' }),
    { code: 'NOT_OWN_SUBMISSION' });
  const reviewed = await workService.reviewWorkSubmission(GUILD_B, OPERATOR, submissionId, { action: 'approved' });
  assert.equal(reviewed.status, 'approved');
});

test('a fixed deposit is its owner\'s in every guild and nobody else\'s in any guild', async (t) => {
  const clock = harness.startClock(t, START);
  await openTwoGuilds();
  const deposit = await bankService.createFixedDeposit(GUILD_B, SHARED, { amount: 1_000, termDays: 7 });
  clock.at('2026-03-10T01:00:00.000Z');
  for (const guildId of [GUILD_A, GUILD_B]) {
    await assert.rejects(bankService.claimFixedDeposit(guildId, A_ONLY, deposit.id), { code: 'FIXED_DEPOSIT_NOT_FOUND' });
    await assert.rejects(bankService.cancelFixedDeposit(guildId, B_ONLY, deposit.id), { code: 'FIXED_DEPOSIT_NOT_FOUND' });
  }
  const claimed = await bankService.claimFixedDeposit(GUILD_A, SHARED, deposit.id);
  assert.equal(claimed.status, 'claimed', 'the owner may collect it through any guild, as the README says');
  await harness.assertMoneyLedgersConsistent('fixed deposit scope');
});

test('guild quotas are separate per guild, refuse bad numbers, and a missing guild is not limited', async () => {
  const quotas = require('../src/services/quotaService');
  quotas.resetGuildQuota(GUILD_A, { clearLimit: true });
  quotas.resetGuildQuota(GUILD_B, { clearLimit: true });
  quotas.setGuildQuota(GUILD_A, 2);
  assert.equal(quotas.tryConsumeGuildQuota(GUILD_A, 1).ok, true);
  assert.equal(quotas.tryConsumeGuildQuota(GUILD_A, 1).ok, true);
  assert.equal(quotas.tryConsumeGuildQuota(GUILD_A, 1).ok, false, 'guild A is out of quota');
  assert.equal(quotas.tryConsumeGuildQuota(GUILD_B, 1000).ok, true, "guild A's quota is not guild B's");
  assert.deepEqual(quotas.getGuildQuota(GUILD_B), { limit: null, used: 0, updatedAt: null });
  assert.equal(quotas.tryConsumeGuildQuota(null, 1).ok, true);
  assert.equal(quotas.getGuildQuota(GUILD_A).used, 2);

  const before = JSON.stringify(quotas.readAllQuotas());
  for (const limit of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, {}, 'abc', Number.MAX_SAFE_INTEGER + 2]) {
    assert.throws(() => quotas.setGuildQuota(GUILD_B, limit), /integer/u, `limit ${String(limit)}`);
  }
  for (const amount of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, {}, 'abc']) {
    assert.throws(() => quotas.tryConsumeGuildQuota(GUILD_A, amount), /integer/u, `amount ${String(amount)}`);
  }
  assert.equal(JSON.stringify(quotas.readAllQuotas()), before, 'refused numbers leave the quota file as it was');
});

// ---------------------------------------------------------------------------------------------------------
// An administrator of guild A asking about a player who never joined guild A
// ---------------------------------------------------------------------------------------------------------

test('the read-only lookups answer for a stranger without filing them under guild A, and write nothing', async () => {
  await openTwoGuilds();
  const item = await coin.createShopItem(GUILD_B, { name: 'a stranger\'s item', price: 10, createdBy: OPERATOR });
  await coin.purchaseItem(GUILD_B, B_ONLY, item.id, 1);
  await bankService.createFixedDeposit(GUILD_B, B_ONLY, { amount: 1_000, termDays: 7 });
  const unseen = '830000000000000077';

  const before = await harness.snapshotAllTables();
  const summary = await bankService.readBalanceSummary(GUILD_A, B_ONLY);
  const balance = await coin.readPlayerBalance(GUILD_A, B_ONLY);
  const inventory = await coin.readInventory(GUILD_A, B_ONLY);
  const nobody = await bankService.readBalanceSummary(GUILD_A, unseen);
  const nobodyBalance = await coin.readPlayerBalance(GUILD_A, unseen);
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), [],
    'looking at somebody must not write a single row, not even a settings row');

  assert.equal(summary.walletBalance, 990, 'the stranger\'s global wallet is read');
  assert.equal(balance.balance, 990);
  assert.equal(inventory.length, 1);
  assert.deepEqual([nobody.walletBalance, nobody.bankBalance, nobody.fixedPrincipal, nobodyBalance.balance], [0, 0, 0, 0],
    'a user the economy has not seen reads as zeros');
  const roster = (await coin.getAllPlayers(GUILD_A, { limit: 25 })).map((row) => row.userId);
  assert.equal(roster.includes(B_ONLY) || roster.includes(unseen), false);
  const board = (await coin.getLeaderboard(GUILD_A, { limit: 25 })).players.map((row) => row.userId);
  assert.equal(board.includes(B_ONLY) || board.includes(unseen), false);
});

test('an administrator asking about a stranger is refused by every command path and nothing is written', async () => {
  await openTwoGuilds();
  const item = await coin.createShopItem(GUILD_B, { name: 'a stranger\'s item', price: 10, createdBy: OPERATOR });
  await coin.purchaseItem(GUILD_B, B_ONLY, item.id, 1);
  await bankService.createFixedDeposit(GUILD_B, B_ONLY, { amount: 1_000, termDays: 7 });
  const stranger = person(B_ONLY, 'stranger');
  const member = person(SHARED, 'member');

  const before = await harness.snapshotAllTables();
  assert.equal(await bankAsAdmin('balance-user', stranger), NOT_A_MEMBER);
  assert.equal(await bankAsAdmin('fixed-user', stranger), NOT_A_MEMBER);
  for (const type of ['balances', 'fixed', 'inventory']) {
    assert.equal(await economyAsAdmin('audit', { strings: { type }, users: { user: stranger } }), NOT_A_MEMBER, type);
  }
  assert.equal(await economyAsAdmin('user', { users: { user: stranger } }), NOT_A_MEMBER);
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), [],
    'refusing a stranger must not write anything, the refusal comes before any lookup');

  // The same questions about a member are answered, and answering does not file anyone either.
  const afterRefusals = await harness.snapshotAllTables();
  assert.match(await bankAsAdmin('balance-user', member), /錢包吉幣：2,000/u);
  assert.match(await economyAsAdmin('audit', { strings: { type: 'balances' }, users: { user: member } }), /2,000/u);
  assert.deepEqual(harness.changedTables(afterRefusals, await harness.snapshotAllTables()), []);
});

test('/coins offers no user option and answers only about the caller, even when a stranger is named', async () => {
  await openTwoGuilds();
  assert.deepEqual(coinsCommand.data.toJSON().options || [], []);
  const before = await harness.snapshotAllTables();
  const text = await run(coinsCommand, {
    commandName: 'coins', guild: guildAMembers(), user: person(SHARED, 'member'), users: { user: person(B_ONLY, 'stranger') },
  });
  // SHARED's own wallet (1,000 from each guild) is one account for both guilds.
  assert.ok(text.includes('member 的吉幣資料'), text);
  assert.ok(text.includes('目前餘額：2,000'), text);
  assert.equal(text.includes('stranger'), false, text);
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);
  const roster = (await coin.getAllPlayers(GUILD_A, { limit: 25 })).map((row) => row.userId);
  assert.equal(roster.includes(B_ONLY), false);
});

test('the read-only debt and database status queries add nobody to any guild and write nothing', async () => {
  await openTwoGuilds();
  const before = await harness.snapshotAllTables();
  const status = await casinoService.readCasinoDebtStatus(GUILD_A, B_ONLY);
  assert.equal(status.loan, null);
  await coin.readCoinDatabaseStats(GUILD_A);
  await coin.readCoinDatabaseStats(null);
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);
  assert.equal((await coin.getAllPlayers(GUILD_A, { limit: 25 })).some((row) => row.userId === B_ONLY), false);
});
