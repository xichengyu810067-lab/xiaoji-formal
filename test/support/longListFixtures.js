'use strict';

// Data for test/longListReplies.test.js: every command that joins stored rows into one reply, with a builder for what
// the services return (data(rows, text): `rows` rows whose free text is `text`) and the largest sizes the options and
// the stores allow (maxRows, textMax). Only plain data lives here, so the same fixtures can be run against any build
// of the commands.

const USER_ID = '123456789012345678';
const TARGET = Object.freeze({
  id: '523456789012345678',
  username: 'target',
  globalName: '目標使用者',
  tag: 'target#0002',
  toString() { return '<@523456789012345678>'; },
});

const iso = (index) => new Date(Date.UTC(2026, 0, 1 + (index % 28), 12, index % 60)).toISOString();
const itemId = (index) => `shop-item-${String(index).padStart(28, '0')}`;
const snowflake = (index) => String(300000000000000000n + BigInt(index));

const plain = (rows, make) => Array.from({ length: rows }, (_, index) => make(index + 1));

const shopItem = (text) => (index) => ({
  id: itemId(index), name: text, price: 10 * index, type: 'collectible', enabled: true, stock: null, purchaseLimit: null,
  roleId: null, description: text,
});
const purchase = (text) => (index) => ({
  id: index, userId: USER_ID, itemName: text, quantity: 1, totalPrice: 10 * index, itemType: 'collectible', status: 'active',
  expiresAt: null, createdAt: iso(index),
});
const luxuryPurchase = (text) => (index) => ({
  id: index, itemName: text, quantity: 1, unitPrice: 100 * index, totalPrice: 100 * index, createdAt: iso(index),
});
const summary = () => (index) => ({
  userId: snowflake(index), walletBalance: 1000 * index, bankBalance: 500 * index, interestRemainder: 0.25,
  fixedPrincipal: 2000 * index, fixedExpectedInterest: 20 * index, fixedClaimable: 0, totalAssets: 3500 * index,
});
const fixedDeposit = () => (index) => ({
  id: index, userId: snowflake(index), principal: 1000 * index, termDays: 30, rate: 0.02, displayStatus: 'active',
  status: 'active', source: 'wallet', createdAt: iso(index), maturityAt: iso(index + 30), expectedInterest: 20 * index,
  claimableAmount: 1020 * index,
});
const rateChange = (text) => (index) => ({
  id: index, rateKey: index % 2 ? 'demand' : 'fixed_30', oldRate: 0.0003, newRate: 0.0004, operatorId: snowflake(index),
  createdAt: iso(index), isEvent: index % 2 === 1, eventEndsAt: iso(index + 3), reason: text,
});
const transaction = (text) => (index) => ({
  id: index, userId: USER_ID, type: 'admin_add', amount: 100 * index, balanceBefore: 1000, balanceAfter: 1000 + 100 * index,
  reason: text, createdAt: iso(index),
});
const ownedItem = (text) => (index) => ({
  id: index, userId: USER_ID, itemId: itemId(index), itemName: text, quantity: 2, acquiredAt: iso(index),
});
const task = (text) => (index) => ({
  id: index, userId: USER_ID, jobName: '服務生', status: 'pending', description: text, taskType: 'work_submit',
  expectedChannelName: 'work-report', externalServerCount: 0, attachmentUrls: [], paidAt: null, createdAt: iso(index),
  updatedAt: null,
});
const payroll = (text) => (index) => ({
  id: index, userId: USER_ID, jobName: '服務生', paidAmount: 500 * index, payRatio: 0.8, completedTasks: 4, totalTasks: 5,
  createdAt: iso(index), reason: text,
});
const preview = (text) => (index) => ({
  job: { userId: USER_ID, jobName: '服務生', totalSalary: 3000, payAt: iso(index) },
  paidAmount: 2400, baseSalary: 3000, payRatio: 0.8, completedTasks: 4, totalTasks: 5, externalServerCount: 0, reason: text,
});
const job = () => (index) => ({
  scope: 'legacy', id: index, userId: snowflake(index), jobName: '廚師', status: 'active', totalSalary: 3000,
  dailySalary: 100, todayCompletedTaskCount: 1, todayTaskCount: 2, payAt: iso(index), startAt: iso(index), workDays: 30,
});
const primaryJob = () => ({
  scope: 'primary', userId: USER_ID, jobName: '服務生', status: 'active', sourceGuildId: '223456789012345678',
  settledAmount: null, payAt: iso(3), globalCycleId: 'cycle-1', workDays: 30, startAt: iso(1), notBeforeAt: iso(1),
});
const penalty = (text) => (index) => ({
  id: index, userId: USER_ID, jobName: '服務生', penaltyAmount: 100 * index, status: 'pending', appealDeadlineAt: iso(index + 3),
  appliedAt: null, reason: text,
});
const primaryPenalty = (text) => (index) => ({
  id: index, amount: 100 * index, status: 'pending', appealDeadline: iso(index + 3), reason: text,
});
// The server every fake interaction runs in. The latest primary pay of a member is shown to an administrator only when its cycle
// was started in the server asking, so the fixture's pay comes from this server.
const FIXTURE_GUILD_ID = '223456789012345678';
const primarySettlement = (text) => (index) => ({
  jobName: '服務生', paidAmount: 500 * index, payRatio: 0.8, settledAt: iso(index), reason: text,
});
const pawnRecord = (text) => (index) => ({
  id: index, itemName: text, quantity: 3, remainingQuantity: 2, pawnUnitPrice: 80, payoutAmount: 240, redeemedQuantity: 1,
  redeemedAmount: 100, status: 'active', createdAt: iso(index),
});
const chipRow = () => (index) => (index === 2
  ? { id: index, entryType: 'buy', amount: 2000, balanceBefore: 0, balanceAfter: 2000, createdAt: iso(index), coinAmount: 0, fee: 0 }
  : { id: index, entryType: 'cashout', amount: -(1_000_000 * index), balanceBefore: 5_000_000 * index, balanceAfter: 4_000_000 * index,
    createdAt: iso(index), coinAmount: 950_000 * index, fee: 50_000 * index });
const casinoRow = () => (index) => ({
  id: 1234567000 + index, entryType: 'loan_forced_collection', gameId: null, loanId: 1234567000 + index, currency: 'coin',
  amount: -9_000_000_000, createdAt: iso(index),
});
const weapon = (text) => (index) => ({ itemId: itemId(index), itemName: text, quantity: index });
const duelRun = (text) => (index) => ({
  id: index, floor: index, status: 'win', weaponName: text, netAmount: 100 * index, createdAt: iso(index),
});
const menuItem = (text) => (index) => ({ id: index, itemType: index % 2 ? 'meal' : 'drink', name: text });
const venueItem = (text) => (index) => ({
  id: index, itemType: 'meal', itemName: text, status: 'completed', makerIsNpc: false, makerUserId: snowflake(index),
  createdAt: iso(index),
});
const reminder = (text) => (index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`, status: index % 3 === 0 ? 'failed' : 'pending',
  remindAt: 1_800_000_000_000 + index * 60_000, message: text, failureReason: index % 3 === 0 ? text : '',
});

// The three lists of /economy user and the lists of the work commands come with a whole status, not a list.
const economyUser = (rows, text) => ({
  readBalanceSummary: async () => summary()(1),
  listFixedDeposits: async () => plain(rows, fixedDeposit()),
  getAllPurchaseHistory: async () => plain(rows, purchase(text)),
  readInventory: async () => plain(rows, ownedItem(text)),
  getWorkStatus: async () => ({ activePrimaryJob: null, activeJob: null, primaryStatusView: null }),
  getPayrollHistory: async () => [],
});
const workStatus = (rows, text) => ({
  getWorkStatus: async () => ({
    primaryStatusView: primaryJob(),
    activeJobs: plain(Math.min(rows, 2), job()),
    latestPayroll: payroll(text)(1),
    latestPrimaryPayroll: { ...primarySettlement(text)(1), sourceGuildId: FIXTURE_GUILD_ID },
    recentTasks: plain(rows, task(text)),
  }),
});

// name: the line of the test; the golden reply of a small list is kept under it in the test.
// `ints` and `strings` are the option values of the run; maxRows and textMax the most rows and the longest free text.
const SITES = Object.freeze([
  { name: '/shop list', marker: /^#shop-item-(\d{28}) /gmu, command: 'shop', subcommand: 'list', ints: { page: 1 }, maxRows: 10, textMax: 500,
    data: (rows, text) => ({ listShopItems: async () => ({ page: 1, limit: 10, items: plain(rows, shopItem(text)) }) }) },
  { name: '/shop purchases', marker: /^#(\d+)｜/gmu, command: 'shop', subcommand: 'purchases', ints: { limit: 25 }, maxRows: 25, textMax: 80,
    data: (rows, text) => ({ getPurchaseHistory: async () => plain(rows, purchase(text)) }) },
  { name: '/shop purchases-user', marker: /^#(\d+)｜/gmu, command: 'shop', subcommand: 'purchases-user', ints: { limit: 25 }, user: TARGET, maxRows: 25,
    textMax: 80, data: (rows, text) => ({ getAllPurchaseHistory: async () => plain(rows, purchase(text)) }) },
  { name: '/shop purchases-all', marker: /^#(\d+)｜/gmu, command: 'shop', subcommand: 'purchases-all', ints: { limit: 25 }, maxRows: 25, textMax: 80,
    data: (rows, text) => ({ getAllPurchaseHistory: async () => plain(rows, purchase(text)) }) },
  { name: '/luxury list', marker: /^#shop-item-(\d{28}) /gmu, command: 'luxury', subcommand: 'list', ints: { page: 1 }, maxRows: 10, textMax: 500,
    data: (rows, text) => ({ listLuxuryItems: async () => ({ page: 1, limit: 10, items: plain(rows, shopItem(text)) }) }) },
  { name: '/luxury history', marker: /^#(\d+) /gmu, command: 'luxury', subcommand: 'history', ints: { limit: 25 }, maxRows: 25, textMax: 80,
    data: (rows, text) => ({ getLuxuryPurchaseHistory: async () => plain(rows, luxuryPurchase(text)) }) },
  { name: '/remind list', noHeading: true, marker: /^`[0-9a-f-]{23}-(\d{12})`/gmu, command: 'remind', subcommand: 'list', maxRows: 10, textMax: 1000,
    data: (rows, text) => ({ listUserReminders: () => plain(rows, reminder(text)) }) },
  { name: '/bank balance-all', marker: /^使用者：<@3000000000000000(\d{2})>/gmu, command: 'bank', subcommand: 'balance-all', ints: { limit: 25 }, maxRows: 25, textMax: 0,
    data: (rows) => ({ getAllBalanceSummaries: async () => plain(rows, summary()) }) },
  { name: '/bank fixed-all', marker: /^#(\d+) <@/gmu, command: 'bank', subcommand: 'fixed-all', ints: { limit: 25 }, maxRows: 25, textMax: 0,
    data: (rows) => ({ listFixedDeposits: async () => plain(rows, fixedDeposit()) }) },
  { name: '/bank rate-history', marker: /^#(\d+) /gmu, command: 'bank', subcommand: 'rate-history', ints: { limit: 25 }, maxRows: 25, textMax: 200,
    data: (rows, text) => ({ getRateHistory: async () => plain(rows, rateChange(text)) }) },
  { name: '/economy audit balances', marker: /^(\d+)\.｜<@/gmu, command: 'economy', subcommand: 'audit', strings: { type: 'balances' }, ints: { limit: 25 },
    maxRows: 25, textMax: 0, data: (rows) => ({ getAllBalanceSummaries: async () => plain(rows, summary()) }) },
  { name: '/economy audit purchases', marker: /^#(\d+)｜/gmu, command: 'economy', subcommand: 'audit', strings: { type: 'purchases' }, ints: { limit: 25 },
    maxRows: 25, textMax: 80, data: (rows, text) => ({ getAllPurchaseHistory: async () => plain(rows, purchase(text)) }) },
  { name: '/economy audit fixed', marker: /^#(\d+)｜/gmu, command: 'economy', subcommand: 'audit', strings: { type: 'fixed' }, ints: { limit: 25 },
    maxRows: 25, textMax: 0, data: (rows) => ({ listFixedDeposits: async () => plain(rows, fixedDeposit()) }) },
  { name: '/economy audit inventory', marker: /^#(\d+)｜/gmu, command: 'economy', subcommand: 'audit', strings: { type: 'inventory' }, ints: { limit: 25 },
    maxRows: 25, textMax: 80, data: (rows, text) => ({ getAllInventory: async () => plain(rows, ownedItem(text)) }) },
  { name: '/economy audit work', marker: /^#(\d+)｜/gmu, command: 'economy', subcommand: 'audit', strings: { type: 'work' }, ints: { limit: 25 },
    maxRows: 25, textMax: 0, data: (rows) => ({ getAllWorkStatuses: async () => plain(rows, job()) }) },
  { name: '/economy audit tasks', marker: /^#(\d+)｜/gmu, command: 'economy', subcommand: 'audit', strings: { type: 'tasks' }, ints: { limit: 25 },
    maxRows: 25, textMax: 1000, data: (rows, text) => ({ listWorkTasks: async () => plain(rows, task(text)) }) },
  { name: '/economy audit payroll', marker: /^#(\d+)｜/gmu, command: 'economy', subcommand: 'audit', strings: { type: 'payroll' }, ints: { limit: 25 },
    maxRows: 25, textMax: 300, data: (rows, text) => ({ getPayrollHistory: async () => plain(rows, payroll(text)) }) },
  { name: '/economy audit transactions', marker: /^#(\d+)｜/gmu, command: 'economy', subcommand: 'audit', strings: { type: 'transactions' }, ints: { limit: 25 },
    maxRows: 25, textMax: 300, data: (rows, text) => ({ getAllTransactions: async () => plain(rows, transaction(text)) }) },
  { name: '/economy audit rates', marker: /^#(\d+)｜/gmu, command: 'economy', subcommand: 'audit', strings: { type: 'rates' }, ints: { limit: 25 },
    maxRows: 25, textMax: 200, data: (rows, text) => ({ getRateHistory: async () => plain(rows, rateChange(text)) }) },
  { name: '/economy audit work of one member', command: 'economy', subcommand: 'audit', strings: { type: 'work' }, ints: { limit: 25 },
    user: TARGET, maxRows: 25, textMax: 1000,
    data: (rows, text) => ({ getWorkStatus: async () => ({
      primaryStatusView: primaryJob(), activeJobs: plain(2, job()), recentTasks: plain(rows, task(text)),
    }) }) },
  { name: '/economy user', command: 'economy', subcommand: 'user', user: TARGET, maxRows: 25, textMax: 80, data: economyUser },
  { name: '/coin-admin history', marker: /^#(\d+) <t:/gmu, command: 'coin-admin', subcommand: 'history', ints: { limit: 25 }, user: TARGET, maxRows: 25,
    textMax: 300, data: (rows, text) => ({ getTransactions: async () => plain(rows, transaction(text)) }) },
  { name: '/work status', command: 'work', subcommand: 'status', maxRows: 5, textMax: 1000, data: workStatus },
  { name: '/work status-user', command: 'work', subcommand: 'status-user', user: TARGET, maxRows: 8, textMax: 1000, data: workStatus },
  { name: '/work status-all', marker: /^使用者：<@3000000000000000(\d{2})>/gmu, command: 'work', subcommand: 'status-all', ints: { limit: 25 }, maxRows: 25, textMax: 0,
    data: (rows) => ({ getAllWorkStatuses: async () => plain(rows, job()) }) },
  { name: '/work submissions', marker: /^#(\d+)｜/gmu, command: 'work', subcommand: 'submissions', ints: { limit: 25 }, maxRows: 25, textMax: 1000,
    data: (rows, text) => ({ listWorkTasks: async () => plain(rows, task(text)) }) },
  { name: '/work tasks', marker: /^#(\d+)｜/gmu, command: 'work', subcommand: 'tasks', ints: { limit: 25 }, maxRows: 25, textMax: 1000,
    data: (rows, text) => ({ listWorkTasks: async () => plain(rows, task(text)) }) },
  { name: '/work tasks-all', marker: /^#(\d+)｜/gmu, command: 'work', subcommand: 'tasks-all', ints: { limit: 25 }, maxRows: 25, textMax: 1000,
    data: (rows, text) => ({ listWorkTasks: async () => plain(rows, task(text)) }) },
  { name: '/work pending', marker: /^#(\d+)｜/gmu, command: 'work', subcommand: 'pending', ints: { limit: 25 }, maxRows: 25, textMax: 1000,
    data: (rows, text) => ({ listPendingWorkSubmissions: async () => plain(rows, task(text)) }) },
  { name: '/work payroll-preview', marker: /^<@\d+>｜/gmu, command: 'work', subcommand: 'payroll-preview', ints: { limit: 25 }, maxRows: 25, textMax: 300,
    data: (rows, text) => ({ previewPayroll: async () => plain(rows, preview(text)) }) },
  { name: '/work payroll-history', marker: /^#(\d+)｜/gmu, command: 'work', subcommand: 'payroll-history', ints: { limit: 25 }, maxRows: 25, textMax: 300,
    data: (rows, text) => ({ getPayrollHistory: async () => plain(rows, payroll(text)) }) },
  { name: '/work payroll', command: 'work', subcommand: 'payroll', ints: { limit: 25 }, maxRows: 25, textMax: 300,
    data: (rows, text) => ({
      getPayrollHistory: async () => plain(rows, payroll(text)),
      previewPayroll: async () => plain(Math.min(rows, 3), preview(text)),
      getPrimaryPayrollHistory: async () => plain(rows, primarySettlement(text)),
    }) },
  { name: '/work penalties', command: 'work', subcommand: 'penalties', ints: { limit: 25 }, maxRows: 25, textMax: 300,
    data: (rows, text) => ({
      listWorkPenalties: async () => plain(rows, penalty(text)),
      listPrimaryPenalties: async () => plain(rows, primaryPenalty(text)),
    }) },
  { name: '/pawn active', marker: /^#(\d+) /gmu, command: 'pawn', subcommand: 'active', ints: { limit: 25 }, maxRows: 25, textMax: 80,
    data: (rows, text) => ({ listPawnRecords: async () => plain(rows, pawnRecord(text)) }) },
  { name: '/pawn history', marker: /^#(\d+) /gmu, command: 'pawn', subcommand: 'history', ints: { limit: 25 }, maxRows: 25, textMax: 80,
    data: (rows, text) => ({ listPawnRecords: async () => plain(rows, pawnRecord(text)) }) },
  { name: '/inventory', marker: /^#shop-item-(\d{28}) /gmu, command: 'inventory', subcommand: null, maxRows: 40, textMax: 80,
    data: (rows, text) => ({ getInventory: async () => plain(rows, ownedItem(text)) }) },
  { name: '/exchange history', marker: /^#(\d+)｜/gmu, command: 'exchange', subcommand: 'history', ints: { limit: 25 }, maxRows: 25, textMax: 0,
    data: (rows) => ({ getChipHistory: async () => plain(rows, chipRow()) }) },
  { name: '/casino history', marker: /^#1234567(\d{3})｜/gmu, command: 'casino', subcommand: 'history', ints: { limit: 25 }, maxRows: 25, textMax: 0,
    data: (rows) => ({ listCasinoHistory: async () => plain(rows, casinoRow()) }) },
  { name: '/duel-tower weapons', marker: /^#shop-item-(\d{28}) /gmu, command: 'duel-tower', subcommand: 'weapons', maxRows: 30, textMax: 80,
    data: (rows, text) => ({ listOwnedBattleWeapons: async () => plain(rows, weapon(text)) }) },
  { name: '/duel-tower history', marker: /^#(\d+)｜/gmu, command: 'duel-tower', subcommand: 'history', ints: { limit: 25 }, maxRows: 25, textMax: 80,
    data: (rows, text) => ({ getDuelTowerHistory: async () => plain(rows, duelRun(text)) }) },
  { name: '/casino-venue menu', marker: /^#(\d+)｜/gmu, command: 'casino-venue', subcommand: 'menu', maxRows: 40, textMax: 80,
    data: (rows, text) => ({ listVenueMenu: async () => plain(rows, menuItem(text)) }) },
  { name: '/casino-venue history', marker: /^#(\d+)｜/gmu, command: 'casino-venue', subcommand: 'history', ints: { limit: 25 }, maxRows: 25, textMax: 80,
    data: (rows, text) => ({ listVenueHistory: async () => plain(rows, venueItem(text)) }) },
]);

// The functions each command reads from the services, by the service file: they are replaced by the test with
// functions that answer from the fixture of the run.
const SERVICE_FUNCTIONS = Object.freeze({
  coinService: ['listShopItems', 'getPurchaseHistory', 'getAllPurchaseHistory', 'getAllTransactions', 'getAllInventory',
    'readInventory', 'getInventory', 'getTransactions', 'readCoinDatabaseStats'],
  luxuryService: ['listLuxuryItems', 'getLuxuryPurchaseHistory', 'listPawnRecords'],
  reminderService: ['listUserReminders', 'deleteUserReminder', 'createReminder', 'addReminder', 'parseReminderDuration'],
  bankService: ['getAllBalanceSummaries', 'readBalanceSummary', 'listFixedDeposits', 'getRateHistory'],
  workService: ['getWorkStatus', 'getAllWorkStatuses', 'listWorkTasks', 'listPendingWorkSubmissions', 'previewPayroll',
    'getPayrollHistory', 'getPrimaryPayrollHistory', 'listWorkPenalties', 'listPrimaryPenalties'],
  chipService: ['getChipHistory'],
  casinoService: ['listCasinoHistory'],
  casinoFacilityService: ['listOwnedBattleWeapons', 'getDuelTowerHistory'],
  venueService: ['listVenueMenu', 'listVenueHistory', 'addVenueMenuItem', 'getVenueRecipe', 'completeVenueOrderItem'],
});

// An interaction of a member who may do everything (administrator and owner of the bot), in a guild of three members.
function fakeInteraction({ commandName, subcommand, ints = {}, strings = {}, user = null }) {
  const replies = [];
  const members = new Map([['m1', {}], ['m2', {}], ['m3', {}]]);
  const interaction = {
    commandName,
    id: '323456789012345678',
    guildId: FIXTURE_GUILD_ID,
    channelId: '423456789012345678',
    user: { id: USER_ID, username: '測試使用者', tag: '測試使用者#0001', toString() { return `<@${USER_ID}>`; } },
    memberPermissions: { has: () => true },
    guild: {
      id: '223456789012345678',
      name: '測試伺服器',
      memberCount: members.size,
      members: {
        fetch: async (id) => (id === undefined ? members : { id, permissions: { has: () => true }, displayName: '成員' }),
        me: { permissions: { has: () => true } },
        cache: new Map(),
      },
    },
    channel: { isTextBased: () => true, name: 'general' },
    client: { users: { fetch: async () => null } },
    replied: false,
    deferred: false,
    inGuild: () => true,
    options: {
      getSubcommand: () => subcommand,
      getInteger: (name) => ints[name] ?? null,
      getString: (name) => strings[name] ?? null,
      getBoolean: () => null,
      getUser: (name) => (name === 'user' ? user : null),
      getMember: () => null,
      getRole: () => null,
      getAttachment: () => null,
    },
    async reply(payload) { replies.push(payload); interaction.replied = true; },
    async followUp(payload) { replies.push(payload); },
    async editReply(payload) { replies.push(payload); },
    async deferReply() { interaction.deferred = true; },
  };
  return { interaction, replies };
}

module.exports = { SERVICE_FUNCTIONS, SITES, TARGET, USER_ID, fakeInteraction };
