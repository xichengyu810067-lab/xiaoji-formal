'use strict';

// Characterization tests for the venue <-> work money flows.
//
// These tests pin the current behavior before the SQL that crosses the venue and work
// systems is moved and before the work reward port becomes injectable.
// Every flow runs against a fresh synthetic SQLite file inside a temporary directory,
// with Date frozen by the Node test runner's mock timers, and the resulting tables are
// compared with reviewed golden files in test/fixtures/.
//
// Golden files describe the reviewed behavior.  The questionable parts first pinned here
// (cancelled-status spelling, the waiter's refund reason after a late maker, sweep order,
// cancel wording and refund fields, admin-log job attribution, the pre-v22 waiter lookup and the
// legacy sweep time) are fixed, and the tests at the end of this file cover each of them.
// Regenerate the golden files only after reviewing an intended behavior change: set
// XIAOJI_VENUE_WORK_GOLDEN=update and rerun this file.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-venue-work-flows-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');

const {
  getCoinDatabasePath,
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const { adjustPlayerBalance } = require('../src/services/coinService');
const { ChipLedgerType, debitChipsForCasinoWithApi } = require('../src/services/chipService');
const {
  VENUE_BONUS_AMOUNT,
  VENUE_BONUS_THRESHOLD,
  cancelVenueOrderItem,
  completeVenueOrderItem,
  createVenueOrder,
  listVenueMenu,
  processExpiredVenueOrderItems,
  reassignVenueOrderItem,
  reassignVenueWaiter,
  refundCancelledOrderTipForTests,
  refundOverdueOrderTipForTests,
  serveVenueOrder,
} = require('../src/services/venueService');
const {
  TASK_STATUS,
  addPendingTask,
  captureLegacyJobBatch,
  deleteWorkSubmission,
  editWorkSubmission,
  listWorkTasks,
  processDueJobs,
  processExpiredWorkTasks,
  reportWork,
  reviewWorkSubmission,
  startVenueJobs,
} = require('../src/services/workService');
const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const { configureWorkRewardCoordinator } = require('../src/systems/work/workRewardPort');
const {
  assertMatchesGolden,
  buildGoldenDocument,
  createVenueWorkSnapshotter,
  describeGoldenDifferences,
} = require('./support/venueWorkSnapshot');

// Payroll pays through the coordinator the assembly root hands to the work system; here the test plays that root.
configureWorkRewardCoordinator(createRuntimeRewardCoordinator());

const GUILD_ID = '310000000000000001';
const VENUE_CHANNEL_ID = '310000000000000002';
const OPERATOR_ID = '310000000000000009';
const CUSTOMER_ID = '310000000000000011';
const WAITER_ID = '310000000000000021';
const UNIFORM_WAITER_ID = '310000000000000022';
const CHEF_ID = '310000000000000031';
const SECOND_CHEF_ID = '310000000000000032';
const BARTENDER_ID = '310000000000000041';
const LEGACY_WAITER_ID = '310000000000000051';
const LEGACY_CHEF_ID = '310000000000000061';
const LEGACY_BARTENDER_ID = '310000000000000071';
const USER_LABELS = Object.freeze({
  [CUSTOMER_ID]: 'customer',
  [WAITER_ID]: 'waiter',
  [UNIFORM_WAITER_ID]: 'uniform-waiter',
  [CHEF_ID]: 'chef',
  [SECOND_CHEF_ID]: 'second-chef',
  [BARTENDER_ID]: 'bartender',
  [LEGACY_WAITER_ID]: 'legacy-waiter',
  [LEGACY_CHEF_ID]: 'legacy-chef',
  [LEGACY_BARTENDER_ID]: 'legacy-bartender',
});

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const WAITER_OVERDUE_REASON = '服務生逾期未送達，由小吉完成並退還小費。';
const MAKER_OVERDUE_WAITER_REASON = '餐飲製作逾期由小吉接手，服務生不算逾期；小費已退還顧客。';
const CANCELLED_ORDER_WAITER_REASON = '訂單已取消，服務生任務一併取消；小費已退還顧客。';
const PRIMARY_OVERDUE_REASON = '逾期 24 小時未完成，由系統接手。';

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// Freeze Date for the whole test; the product code reads new Date() in many places.
function startClock(t, startIso) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(startIso) });
  return {
    at(isoString) {
      t.mock.timers.setTime(Date.parse(isoString));
    },
    advance(milliseconds) {
      t.mock.timers.tick(milliseconds);
    },
  };
}

function assertSyntheticPath(filePath) {
  const relative = path.relative(root, filePath);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `synthetic data must stay inside the temporary test root: ${filePath}`);
}

async function openSyntheticDatabase() {
  resetCoinDatabaseForTests();
  const databasePath = getCoinDatabasePath();
  assertSyntheticPath(databasePath);
  fs.rmSync(databasePath, { force: true });
  fs.rmSync(`${databasePath}.tmp`, { force: true });
  await initializeNewCoinDatabase({ expectedPath: databasePath });
  const snapshotter = createVenueWorkSnapshotter({ withCoinDatabase, userLabels: USER_LABELS });
  await snapshotter.recordUntrackedBaseline();
  return snapshotter;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function membership(userIds, { rosterComplete = false } = {}) {
  return { guildId: GUILD_ID, verifiedUserIds: [...userIds], rosterComplete };
}

function menuItem(menu, name) {
  const item = menu.find((entry) => entry.name === name);
  assert.ok(item, `default venue menu is missing ${name}`);
  return item;
}

async function seedCustomerCoins(amount) {
  const result = await adjustPlayerBalance(GUILD_ID, CUSTOMER_ID, {
    action: 'add',
    amount,
    operatorId: OPERATOR_ID,
    reason: '合成測試：顧客預存吉幣',
    operationId: 'venue-work-flows:seed-customer-coins',
  });
  assert.equal(result.after, amount);
}

async function selectVenueJobs(selections, days) {
  for (const [userId, selection] of selections) {
    const selected = await startVenueJobs(GUILD_ID, userId, { days, ...selection });
    assert.equal(selected.state, 'pending_legacy');
    assert.equal(selected.alreadySelected, false);
  }
}

async function readRows(sql, params = []) {
  return withCoinDatabase((api) => api.all(sql, params));
}

async function runExpiryHandlers(order) {
  if (order === 'venue-first') {
    const venue = await processExpiredVenueOrderItems();
    const work = await processExpiredWorkTasks(null);
    return { venue, work };
  }
  const work = await processExpiredWorkTasks(null);
  const venue = await processExpiredVenueOrderItems();
  return { venue, work };
}

// A rejected venue operation must leave every tracked table exactly as it was.
async function assertRejectedWithoutWrites(snapshotter, operation, code, message = null) {
  const before = await snapshotter.capture();
  await assert.rejects(operation, (error) => {
    assert.equal(error?.code, code);
    if (message !== null) assert.equal(error.message, message);
    return true;
  });
  assert.deepEqual(await snapshotter.capture(), before);
}

// Tip money conservation over every order and the chip ledger:
// - a settled tip (paid or refunded) has exactly one payout or one refund of the full tip, the
//   kind matching tip_status, and an escrowed tip has neither;
// - every chip escrowed for a tip is paid out, refunded or still escrowed, nothing more or less;
// - every chip account balance equals the sum of its ledger entries (no credit outside the ledger).
async function assertTipMoneyConserved() {
  const orders = await readRows('SELECT id, tip_amount, tip_status FROM casino_venue_orders ORDER BY id');
  const ledger = await readRows('SELECT user_id, entry_type, amount, metadata FROM chip_ledger ORDER BY id');
  const settlements = ledger.filter((entry) => ['tip_payout', 'tip_refund'].includes(entry.entry_type));
  for (const order of orders) {
    const entries = settlements.filter((entry) => JSON.parse(entry.metadata).orderId === order.id);
    const expected = { paid: ['tip_payout'], refunded: ['tip_refund'] }[order.tip_status] || [];
    assert.deepEqual(entries.map((entry) => entry.entry_type), expected, `order #${order.id} tip ${order.tip_status}`);
    for (const entry of entries) assert.equal(entry.amount, order.tip_amount, `order #${order.id} settles the full tip`);
  }
  const escrowed = -ledger.filter((entry) => entry.entry_type === 'tip_escrow').reduce((sum, entry) => sum + entry.amount, 0);
  const settled = settlements.reduce((sum, entry) => sum + entry.amount, 0);
  const stillEscrowed = orders.filter((order) => order.tip_status === 'escrowed')
    .reduce((sum, order) => sum + order.tip_amount, 0);
  assert.equal(escrowed, settled + stillEscrowed, 'escrowed chips = paid out + refunded + still escrowed');
  const accounts = await readRows('SELECT user_id, balance FROM chip_accounts_global ORDER BY user_id');
  for (const account of accounts) {
    const sum = ledger.filter((entry) => entry.user_id === account.user_id).reduce((total, entry) => total + entry.amount, 0);
    assert.equal(account.balance, sum, `chip balance of ${USER_LABELS[account.user_id] || account.user_id} matches its ledger`);
  }
}

async function countTipRefunds(orderId) {
  return (await readRows("SELECT metadata FROM chip_ledger WHERE entry_type = 'tip_refund' ORDER BY id"))
    .filter((entry) => JSON.parse(entry.metadata).orderId === orderId).length;
}

async function readTaskStatuses(messageId) {
  return (await readRows(
    'SELECT user_id, job_id, status FROM coin_work_tasks WHERE message_id = ? ORDER BY id', [messageId]
  )).map((row) => [row.user_id, row.job_id, row.status]);
}

test('primary venue order runs from order to payroll with task, tip escrow and maker bonus', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  const checkpoints = {};

  await seedCustomerCoins(5000);
  await selectVenueJobs([
    [WAITER_ID, { waiter: '服務生' }],
    [CHEF_ID, { chef: true }],
    [BARTENDER_ID, { bartender: true }],
  ], 2);

  clock.at('2026-03-02T14:00:00.000Z');
  const activation = await processDueJobs(null);
  assert.deepEqual(activation.activations, { checked: 3, activated: 3 });

  clock.at('2026-03-03T01:00:00.000Z');
  const menu = await listVenueMenu(GUILD_ID);
  const friedRice = menuItem(menu, '小吉炒飯');
  const steak = menuItem(menu, '皇家牛排');
  const sparkling = menuItem(menu, '星光氣泡飲');

  // Ten meals already completed on the same service date (made by NPC staff because no
  // chef is visible in the roster) put the next maker-made meal over the bonus threshold.
  assert.equal(VENUE_BONUS_THRESHOLD, 10);
  for (let index = 0; index < VENUE_BONUS_THRESHOLD; index += 1) {
    const filler = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
      mealId: friedRice.id,
      waiterId: WAITER_ID,
      tipAmount: 50,
      channelId: VENUE_CHANNEL_ID,
      membership: membership([CUSTOMER_ID, WAITER_ID], { rosterComplete: true }),
    });
    assert.deepEqual(filler.items.map((item) => [item.makerIsNpc, item.status]), [[true, 'completed']]);
    clock.advance(MINUTE_MS);
    await serveVenueOrder(GUILD_ID, WAITER_ID, filler.order.id);
    clock.advance(MINUTE_MS);
  }

  // Main order: explicit chef, bartender picked by the least-busy auto assignment.
  const placed = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
    mealId: steak.id,
    drinkId: sparkling.id,
    chefId: CHEF_ID,
    waiterId: WAITER_ID,
    tipAmount: 120,
    channelId: VENUE_CHANNEL_ID,
    membership: membership([CUSTOMER_ID, WAITER_ID, CHEF_ID, BARTENDER_ID], { rosterComplete: true }),
  });
  assert.equal(placed.order.tipStatus, 'escrowed');
  assert.equal(placed.tipDebit.autoTopUpAmount, 120);
  assert.deepEqual(placed.items.map((item) => [item.itemType, item.makerUserId, item.makerIsNpc, item.status]), [
    ['meal', CHEF_ID, false, 'pending'],
    ['drink', BARTENDER_ID, false, 'pending'],
  ]);
  await snapshotter.assertUntrackedTablesUnchanged('ordered');
  checkpoints.ordered = await snapshotter.capture();

  clock.advance(30 * MINUTE_MS);
  const meal = await completeVenueOrderItem(GUILD_ID, CHEF_ID, placed.items[0].id, {
    steps: '牛排兩面撒鹽與黑胡椒\n熱鍋煎至焦香\n加入奶油與香草\n靜置後切片擺盤',
  });
  assert.equal(meal.item.bonusAmount, VENUE_BONUS_AMOUNT);
  clock.advance(10 * MINUTE_MS);
  const drink = await completeVenueOrderItem(GUILD_ID, BARTENDER_ID, placed.items[1].id, {
    steps: '杯中加入冰塊與莓果糖漿\n倒入氣泡水\n用薄荷葉裝飾',
  });
  assert.equal(drink.item.bonusAmount, 0);
  // A primary maker's venue:make log names the maker's cycle (a cycle row has no job id).
  assert.deepEqual(
    (await readRows("SELECT details FROM coin_admin_logs WHERE action = 'venue:make' ORDER BY id"))
      .map((row) => JSON.parse(row.details)).map(({ orderItemId, jobId, globalCycleId }) => [orderItemId, jobId, globalCycleId]),
    [[meal.item.id, null, meal.item.globalCycleId], [drink.item.id, null, drink.item.globalCycleId]]
  );
  assert.ok(meal.item.globalCycleId && drink.item.globalCycleId && meal.item.globalCycleId !== drink.item.globalCycleId);
  clock.advance(10 * MINUTE_MS);
  const served = await serveVenueOrder(GUILD_ID, WAITER_ID, placed.order.id);
  assert.equal(served.order.tipStatus, 'paid');
  assert.equal(served.tipResult.payout.netAmount, 120);
  checkpoints.served = await snapshotter.capture();

  clock.at('2026-03-04T14:00:00.000Z');
  const settlement = await processDueJobs(null);
  assert.deepEqual(settlement.primaryCycles, { checked: 3, settled: 3, failed: 0, roleCleanupFailed: 0 });
  assert.deepEqual(
    (await readRows('SELECT user_id, gross_amount, paid_amount FROM coin_primary_cycle_payroll ORDER BY user_id'))
      .map((row) => [row.user_id, row.gross_amount, row.paid_amount]),
    [[WAITER_ID, 0, 0], [CHEF_ID, 160, 160], [BARTENDER_ID, 120, 120]]
  );
  await snapshotter.assertUntrackedTablesUnchanged('settled');
  checkpoints.settled = await snapshotter.capture();

  assertMatchesGolden('venueWorkPrimaryLifecycle.golden.json',
    buildGoldenDocument('primary-venue-lifecycle', checkpoints));
});

async function runOverdueScenario(clock, expiryOrder) {
  clock.at('2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  const checkpoints = {};

  await seedCustomerCoins(1000);
  await selectVenueJobs([
    [WAITER_ID, { waiter: '服務生' }],
    [CHEF_ID, { chef: true }],
    [BARTENDER_ID, { bartender: true }],
  ], 3);
  clock.at('2026-03-02T14:00:00.000Z');
  assert.deepEqual((await processDueJobs(null)).activations, { checked: 3, activated: 3 });

  clock.at('2026-03-03T01:00:00.000Z');
  const menu = await listVenueMenu(GUILD_ID);
  const placed = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
    mealId: menuItem(menu, '招牌拉麵').id,
    drinkId: menuItem(menu, '翡翠檸檬茶').id,
    chefId: CHEF_ID,
    bartenderId: BARTENDER_ID,
    waiterId: WAITER_ID,
    tipAmount: 80,
    channelId: VENUE_CHANNEL_ID,
    membership: membership([WAITER_ID, CHEF_ID, BARTENDER_ID]),
  });
  clock.advance(HOUR_MS);
  await completeVenueOrderItem(GUILD_ID, BARTENDER_ID, placed.items[1].id, {
    steps: '泡好綠茶並冷卻\n加入檸檬汁與糖漿\n搖盪後倒入杯中',
  });
  checkpoints.waiting = await snapshotter.capture();

  // One millisecond before the 24-hour cutoff nothing may be taken over.
  clock.at('2026-03-04T00:59:59.999Z');
  const early = await runExpiryHandlers(expiryOrder);
  assert.deepEqual(early.venue, { checked: 0, completedByNpc: 0, penaltiesCreated: 0, waiterRefunded: 0 });
  assert.deepEqual(early.work.primary, { checked: 0, completed: 0, penalties: 0 });
  assert.deepEqual(await snapshotter.capture(), checkpoints.waiting);

  clock.at('2026-03-04T01:00:00.000Z');
  const due = await runExpiryHandlers(expiryOrder);
  checkpoints['taken-over'] = await snapshotter.capture();

  clock.at('2026-03-05T14:00:00.000Z');
  const settlement = await processDueJobs(null);
  assert.deepEqual(settlement.primaryCycles, { checked: 3, settled: 3, failed: 0, roleCleanupFailed: 0 });
  await snapshotter.assertUntrackedTablesUnchanged(`overdue ${expiryOrder}`);
  checkpoints.settled = await snapshotter.capture();
  return { checkpoints, due };
}

test('overdue venue work is taken over by NPC staff, refunds the tip and penalizes only the late maker, in either sweep order', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');

  // Scheduler order seen at startup: the venue sweep is a single queued transaction and
  // finishes before the multi-step work sweep reaches its primary-task query.
  const venueFirst = await runOverdueScenario(clock, 'venue-first');
  assert.deepEqual(venueFirst.due.venue, { checked: 1, completedByNpc: 1, penaltiesCreated: 0, waiterRefunded: 1 });
  assert.deepEqual(venueFirst.due.work.primary, { checked: 1, completed: 1, penalties: 1 });
  const penalties = await readRows('SELECT user_id, amount, status, applied_at FROM coin_primary_cycle_penalties ORDER BY id');
  assert.deepEqual(penalties.map((row) => [row.user_id, row.amount, row.status, row.applied_at]),
    [[CHEF_ID, 70, 'active', '2026-03-05T14:00:00.000Z']]);
  assert.deepEqual(
    (await readRows('SELECT user_id, gross_amount, paid_amount FROM coin_primary_cycle_payroll ORDER BY user_id'))
      .map((row) => [row.user_id, row.gross_amount, row.paid_amount]),
    [[WAITER_ID, 0, 0], [CHEF_ID, 0, 0], [BARTENDER_ID, 180, 180]]
  );
  const venueFirstDocument = buildGoldenDocument('overdue-npc-takeover', venueFirst.checkpoints);
  assertMatchesGolden('venueWorkOverdueNpc.golden.json', venueFirstDocument);

  // After settlement: the waiter could not serve before NPC staff made the late chef's meal, so
  // the waiter is not counted late (no penalty, a review reason that says so) and the tip went back
  // to the customer.  The chef's task was closed by the primary-task sweep with the cycle penalty;
  // the bartender's task was paid.
  const readCloseOuts = () => readRows(
    "SELECT user_id, task_type, status, review_reason FROM coin_work_tasks WHERE task_type LIKE 'casino_venue_%' ORDER BY id"
  );
  const closeOuts = [
    { user_id: WAITER_ID, task_type: 'casino_venue_service', status: 'system_completed', review_reason: MAKER_OVERDUE_WAITER_REASON },
    { user_id: CHEF_ID, task_type: 'casino_venue_meal', status: 'system_completed', review_reason: PRIMARY_OVERDUE_REASON },
    { user_id: BARTENDER_ID, task_type: 'casino_venue_drink', status: 'paid', review_reason: null },
  ];
  assert.deepEqual(await readCloseOuts(), closeOuts);
  assert.deepEqual(await readRows('SELECT tip_status, served_by FROM casino_venue_orders'),
    [{ tip_status: 'refunded', served_by: 'system' }]);
  assert.equal(await countTipRefunds(1), 1);
  await assertTipMoneyConserved();

  // The other interleaving: the primary-task sweep runs first.  It leaves the waiter task of the
  // still-escrowed order to the venue sweep, so every tracked table ends exactly as above.
  const workFirst = await runOverdueScenario(clock, 'work-first');
  assert.deepEqual(workFirst.due.venue, venueFirst.due.venue);
  assert.deepEqual(workFirst.due.work.primary, venueFirst.due.work.primary);
  assert.deepEqual(await readCloseOuts(), closeOuts);
  const workFirstDocument = buildGoldenDocument('overdue-npc-takeover', workFirst.checkpoints);
  assert.deepEqual(describeGoldenDifferences(venueFirstDocument, workFirstDocument, 100), []);
  await assertTipMoneyConserved();
});

test('primary cycle settlement grants once across a failed persist, overlapping runs, replays and restarts', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();

  await seedCustomerCoins(1000);
  await selectVenueJobs([[WAITER_ID, { waiter: '服務生' }], [CHEF_ID, { chef: true }]], 1);
  clock.at('2026-03-02T14:00:00.000Z');
  assert.deepEqual((await processDueJobs(null)).activations, { checked: 2, activated: 2 });

  clock.at('2026-03-03T01:00:00.000Z');
  const menu = await listVenueMenu(GUILD_ID);
  const placed = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
    mealId: menuItem(menu, '小吉炒飯').id,
    chefId: CHEF_ID,
    waiterId: WAITER_ID,
    tipAmount: 60,
    channelId: VENUE_CHANNEL_ID,
    membership: membership([WAITER_ID, CHEF_ID]),
  });
  clock.advance(10 * MINUTE_MS);
  await completeVenueOrderItem(GUILD_ID, CHEF_ID, placed.items[0].id, { steps: '熱鍋下油\n加入白飯拌炒\n盛盤' });
  clock.advance(10 * MINUTE_MS);
  await serveVenueOrder(GUILD_ID, WAITER_ID, placed.order.id);
  const beforeSettlement = await snapshotter.capture();

  clock.at('2026-03-03T14:00:00.000Z');
  const databasePath = getCoinDatabasePath();
  assertSyntheticPath(databasePath);
  const fileBeforeSettlement = sha256File(databasePath);

  // 1. The settlement commit cannot reach disk: the in-memory state is rolled back and
  //    the file is untouched, so no reward exists anywhere.
  const originalRenameSync = fs.renameSync;
  const crash = t.mock.method(fs, 'renameSync', function renameSync(from, to) {
    if (path.resolve(String(to)) === path.resolve(databasePath)) {
      throw Object.assign(new Error('synthetic crash before the settlement reached disk'), { code: 'EIO' });
    }
    return originalRenameSync.call(fs, from, to);
  });
  const crashed = await processDueJobs(null);
  crash.mock.restore();
  assert.deepEqual(crashed.primaryCycles, { checked: 2, settled: 0, failed: 2, roleCleanupFailed: 0 });
  assert.deepEqual(await snapshotter.capture(), beforeSettlement);
  assert.equal(sha256File(databasePath), fileBeforeSettlement);

  // 2. Restart, then two overlapping scheduler runs: every cycle settles exactly once.
  resetCoinDatabaseForTests();
  const overlapping = await Promise.all([processDueJobs(null), processDueJobs(null)]);
  assert.equal(overlapping[0].primaryCycles.settled + overlapping[1].primaryCycles.settled, 2);
  assert.equal(overlapping[0].primaryCycles.failed + overlapping[1].primaryCycles.failed, 0);
  const settled = await snapshotter.capture();
  const grants = await readRows('SELECT user_id, amount, operation_id, canonical_source_id FROM reward_grants_v2 ORDER BY id');
  assert.equal(grants.length, 1);
  assert.equal(grants[0].user_id, CHEF_ID);
  assert.equal(grants[0].amount, 70);

  // 3. Replays: another scheduler pass and both reward port entry points with the same
  //    identity report the existing receipt and write nothing new.
  const replay = await processDueJobs(null);
  assert.deepEqual(replay.primaryCycles, { checked: 0, settled: 0, failed: 0, roleCleanupFailed: 0 });
  const [chefCycle] = await readRows('SELECT cycle_id FROM coin_primary_job_cycles WHERE user_id = ?', [CHEF_ID]);
  const identity = {
    kind: 'work-settlement',
    canonicalSourceId: `primary:${chefCycle.cycle_id}`,
    rewardKind: 'salary',
    userId: CHEF_ID,
    sourceGuildId: GUILD_ID,
    amount: 70,
    operationId: `work-settlement:primary:${chefCycle.cycle_id}`,
  };
  assert.equal(grants[0].canonical_source_id, identity.canonicalSourceId);
  assert.equal(grants[0].operation_id, identity.operationId);
  const coordinator = createRuntimeRewardCoordinator();
  const replayedGrant = await coordinator.grant(identity);
  assert.equal(replayedGrant.alreadyGranted, true);
  const replayedInTransaction = await withCoinTransaction((api) => coordinator.grantInTransaction(api, identity));
  assert.equal(replayedInTransaction.alreadyGranted, true);
  assert.equal(replayedInTransaction.receipt.transactionId, replayedGrant.receipt.transactionId);
  assert.deepEqual(await snapshotter.capture(), settled);

  // 4. Restart and run the scheduler again: still exactly one grant.
  resetCoinDatabaseForTests();
  const afterRestart = await processDueJobs(null);
  assert.deepEqual(afterRestart.primaryCycles, { checked: 0, settled: 0, failed: 0, roleCleanupFailed: 0 });
  assert.deepEqual(await snapshotter.capture(), settled);
  await snapshotter.assertUntrackedTablesUnchanged('settlement replay');

  assertMatchesGolden('venueWorkSettlementReplay.golden.json',
    buildGoldenDocument('primary-settlement-replay', { settled }));
});

function lastInsertId(api) {
  return Number(api.get('SELECT last_insert_rowid() AS id').id);
}

// Legacy rows below mirror the pre-v22 (guild-scoped job) insert shapes that still exist
// as the non-global branches of venueService/workService; v24 can no longer create them.
function insertLegacyJob(api, { userId, jobName, dailySalary, workDays, startAt, payAt }) {
  api.run(
    `INSERT INTO coin_jobs (
      guild_id, user_id, job_name, job_role_id, daily_salary, work_days, total_salary,
      status, is_paid, start_at, pay_at, last_contribution_at, today_task_count,
      today_completed_task_count, no_work_available_today, payroll_status, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, ?, ?, ?, 'active', 0, ?, ?, NULL, 0, 0, 0, 'pending', ?, ?)`,
    [GUILD_ID, userId, jobName, dailySalary, workDays, dailySalary * workDays, startAt, payAt, startAt, startAt]
  );
  return lastInsertId(api);
}

function insertLegacyPendingTask(api, { userId, jobId, jobName, taskType, description, messageId, createdAt }) {
  api.run(
    `INSERT INTO coin_work_tasks (
      guild_id, user_id, job_id, job_name, task_type, status, description,
      attachment_urls, expected_channel_id, expected_channel_name, message_id,
      external_server_count, external_server_ids, created_at, due_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?, '[]', ?, ?, ?, 0, '[]', ?, ?, ?)`,
    [GUILD_ID, userId, jobId, jobName, taskType, description, VENUE_CHANNEL_ID, jobName, messageId,
      createdAt, new Date(Date.parse(createdAt) + 10 * HOUR_MS).toISOString(), createdAt]
  );
  api.run('UPDATE coin_jobs SET today_task_count = today_task_count + 1, updated_at = ? WHERE id = ?', [createdAt, jobId]);
}

function insertLegacyOrder(api, { jobs, item, makerId, makerJobId, makerJobName, tipAmount, createdAt }) {
  debitChipsForCasinoWithApi(api, GUILD_ID, CUSTOMER_ID, tipAmount, {
    entryType: ChipLedgerType.TIP_ESCROW,
    reason: '場館訂單服務生小費保管',
    topUpReason: '場館小費自動補足籌碼',
    metadata: { waiterId: LEGACY_WAITER_ID, waiterJobName: '服務生' },
    timestamp: createdAt,
  });
  api.run(
    `INSERT INTO casino_venue_orders (
      guild_id, customer_id, channel_id, waiter_user_id, waiter_job_id, waiter_job_name,
      waiter_assigned_at, waiter_due_at, tip_amount, tip_status, status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, '服務生', ?, ?, ?, 'escrowed', 'pending', ?, ?)`,
    [GUILD_ID, CUSTOMER_ID, VENUE_CHANNEL_ID, LEGACY_WAITER_ID, jobs.waiter, createdAt,
      new Date(Date.parse(createdAt) + 24 * HOUR_MS).toISOString(), tipAmount, createdAt, createdAt]
  );
  const orderId = lastInsertId(api);
  insertLegacyPendingTask(api, {
    userId: LEGACY_WAITER_ID,
    jobId: jobs.waiter,
    jobName: '服務生',
    taskType: 'casino_venue_service',
    description: `訂單 #${orderId} 待送達，小費 ${tipAmount} 籌碼。`,
    messageId: `venue-order-${orderId}`,
    createdAt,
  });
  api.run(
    `INSERT INTO casino_venue_order_items (
      guild_id, order_id, item_type, menu_item_id, item_name, standard_steps,
      maker_user_id, maker_job_id, maker_job_name, maker_is_npc, status, actual_steps,
      service_date, bonus_amount, created_at, assigned_at, completed_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 'pending', NULL, NULL, 0, ?, ?, NULL, ?)`,
    [GUILD_ID, orderId, item.itemType, item.id, item.name, item.steps, makerId, makerJobId, makerJobName,
      createdAt, createdAt, createdAt]
  );
  const itemId = lastInsertId(api);
  insertLegacyPendingTask(api, {
    userId: makerId,
    jobId: makerJobId,
    jobName: makerJobName,
    taskType: item.itemType === 'meal' ? 'casino_venue_meal' : 'casino_venue_drink',
    description: `訂單 #${orderId}｜${item.name} 待製作`,
    messageId: `venue-item-${itemId}`,
    createdAt,
  });
  return { orderId, itemId };
}

async function seedLegacyVenueState(clock) {
  clock.at('2026-03-01T01:00:00.000Z');
  const menu = await listVenueMenu(GUILD_ID);
  await seedCustomerCoins(1000);
  const startAt = '2026-03-01T01:00:00.000Z';
  const payAt = '2026-03-03T14:00:00.000Z';
  const jobs = await withCoinTransaction((api) => ({
    waiter: insertLegacyJob(api, { userId: LEGACY_WAITER_ID, jobName: '服務生', dailySalary: 0, workDays: 2, startAt, payAt }),
    chef: insertLegacyJob(api, { userId: LEGACY_CHEF_ID, jobName: '廚師', dailySalary: 70, workDays: 2, startAt, payAt }),
    bartender: insertLegacyJob(api, { userId: LEGACY_BARTENDER_ID, jobName: '調酒師', dailySalary: 60, workDays: 2, startAt, payAt }),
  }));

  // A meal finished before the cutover whose venue bonus is still unpaid.
  clock.at('2026-03-01T03:30:00.000Z');
  const steak = menuItem(menu, '皇家牛排');
  await withCoinTransaction((api) => {
    api.run(
      `INSERT INTO casino_venue_orders (
        guild_id, customer_id, channel_id, waiter_user_id, waiter_job_id, waiter_job_name,
        waiter_assigned_at, waiter_due_at, tip_amount, tip_status, served_at, served_by, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, '服務生', ?, ?, 0, 'none', ?, ?, 'completed', ?, ?)`,
      [GUILD_ID, CUSTOMER_ID, VENUE_CHANNEL_ID, LEGACY_WAITER_ID, jobs.waiter, '2026-03-01T02:00:00.000Z',
        '2026-03-02T02:00:00.000Z', '2026-03-01T03:30:00.000Z', LEGACY_WAITER_ID,
        '2026-03-01T02:00:00.000Z', '2026-03-01T03:30:00.000Z']
    );
    const orderId = lastInsertId(api);
    const actualSteps = '牛排撒鹽與黑胡椒\n煎至焦香\n切片擺盤';
    api.run(
      `INSERT INTO casino_venue_order_items (
        guild_id, order_id, item_type, menu_item_id, item_name, standard_steps,
        maker_user_id, maker_job_id, maker_job_name, maker_is_npc, status, actual_steps,
        service_date, bonus_amount, created_at, assigned_at, completed_at, updated_at
      ) VALUES (?, ?, 'meal', ?, ?, ?, ?, ?, '廚師', 0, 'completed', ?, '2026-03-01', 20, ?, ?, ?, ?)`,
      [GUILD_ID, orderId, steak.id, steak.name, steak.steps, LEGACY_CHEF_ID, jobs.chef, actualSteps,
        '2026-03-01T02:00:00.000Z', '2026-03-01T02:00:00.000Z', '2026-03-01T03:00:00.000Z', '2026-03-01T03:00:00.000Z']
    );
    api.run(
      `INSERT INTO coin_work_tasks (
        guild_id, user_id, job_id, job_name, task_type, status, description,
        attachment_urls, expected_channel_id, expected_channel_name, message_id,
        external_server_count, external_server_ids, created_at, due_at, completed_at, updated_at
      ) VALUES (?, ?, ?, '廚師', 'casino_venue_meal', 'completed', ?, '[]', NULL, '廚師', NULL, 0, '[]', ?, ?, ?, ?)`,
      [GUILD_ID, LEGACY_CHEF_ID, jobs.chef, `${steak.name} 製作完成\n${actualSteps}`,
        '2026-03-01T03:00:00.000Z', '2026-03-01T03:00:00.000Z', '2026-03-01T03:00:00.000Z', '2026-03-01T03:00:00.000Z']
    );
    api.run(
      `UPDATE coin_jobs SET last_contribution_at = ?, today_task_count = today_task_count + 1,
         today_completed_task_count = today_completed_task_count + 1, updated_at = ? WHERE id = ?`,
      ['2026-03-01T03:00:00.000Z', '2026-03-01T03:00:00.000Z', jobs.chef]
    );
  });

  // Two orders still in flight when the global-work cutover happened.
  clock.at('2026-03-02T03:00:00.000Z');
  const mealOrder = await withCoinTransaction((api) => insertLegacyOrder(api, {
    jobs, item: menuItem(menu, '招牌拉麵'), makerId: LEGACY_CHEF_ID, makerJobId: jobs.chef, makerJobName: '廚師',
    tipAmount: 50, createdAt: '2026-03-02T03:00:00.000Z',
  }));
  clock.at('2026-03-02T03:05:00.000Z');
  const drinkOrder = await withCoinTransaction((api) => insertLegacyOrder(api, {
    jobs, item: menuItem(menu, '午夜無酒精調飲'), makerId: LEGACY_BARTENDER_ID, makerJobId: jobs.bartender,
    makerJobName: '調酒師', tipAmount: 50, createdAt: '2026-03-02T03:05:00.000Z',
  }));
  return { jobs, mealOrder, drinkOrder };
}

test('legacy pre-cutover venue orders finish, expire and settle through the legacy payroll', async (t) => {
  const clock = startClock(t, '2026-03-01T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  const checkpoints = {};
  const { jobs, mealOrder, drinkOrder } = await seedLegacyVenueState(clock);

  clock.at('2026-03-02T04:00:00.000Z');
  assert.deepEqual(await captureLegacyJobBatch(), { users: 3, snapshots: 3, nextUserId: null });

  clock.at('2026-03-02T05:00:00.000Z');
  const made = await completeVenueOrderItem(GUILD_ID, LEGACY_CHEF_ID, mealOrder.itemId, {
    steps: '煮滾高湯\n麵條煮至彈牙\n放入叉燒與配菜',
  });
  assert.equal(made.item.status, 'completed');
  assert.equal(made.item.makerJobId, jobs.chef);
  assert.equal(made.item.globalCycleId, null);
  const [legacyMakeLog] = await readRows("SELECT details FROM coin_admin_logs WHERE action = 'venue:make'");
  assert.deepEqual(JSON.parse(legacyMakeLog.details), {
    orderId: mealOrder.orderId, orderItemId: mealOrder.itemId, itemType: 'meal', itemName: '招牌拉麵',
    jobId: jobs.chef, taskId: made.taskId,
  });
  clock.at('2026-03-02T05:10:00.000Z');
  const served = await serveVenueOrder(GUILD_ID, LEGACY_WAITER_ID, mealOrder.orderId);
  assert.equal(served.order.tipStatus, 'paid');
  clock.at('2026-03-02T06:00:00.000Z');
  const nextPrimary = await startVenueJobs(GUILD_ID, LEGACY_CHEF_ID, { days: 1, chef: true });
  assert.equal(nextPrimary.notBeforeAt, '2026-03-03T14:00:00.000Z');
  assert.equal(nextPrimary.legacyCount, 1);
  checkpoints.served = await snapshotter.capture();

  // The drink order was created at 03:05; one millisecond earlier nothing is due.
  clock.at('2026-03-03T03:04:59.999Z');
  const early = await runExpiryHandlers('venue-first');
  assert.deepEqual(early.venue, { checked: 0, completedByNpc: 0, penaltiesCreated: 0, waiterRefunded: 0 });
  assert.deepEqual(await snapshotter.capture(), checkpoints.served);

  clock.at('2026-03-03T03:05:00.000Z');
  const due = await runExpiryHandlers('venue-first');
  assert.deepEqual(due.venue, { checked: 1, completedByNpc: 1, penaltiesCreated: 1, waiterRefunded: 1 });
  assert.equal(due.work.checked, 0);
  assert.deepEqual(due.work.primary, { checked: 0, completed: 0, penalties: 0 });
  const drinkItem = await readRows('SELECT maker_is_npc, status FROM casino_venue_order_items WHERE id = ?', [drinkOrder.itemId]);
  assert.deepEqual(drinkItem, [{ maker_is_npc: 1, status: 'completed' }]);
  // The legacy bartender was 24 hours late, so the legacy waiter is not counted late either.
  assert.deepEqual(await readRows('SELECT status, review_reason FROM coin_work_tasks WHERE message_id = ?',
    [`venue-order-${drinkOrder.orderId}`]), [{ status: 'system_completed', review_reason: MAKER_OVERDUE_WAITER_REASON }]);
  assert.equal(await countTipRefunds(drinkOrder.orderId), 1);
  await assertTipMoneyConserved();
  checkpoints['taken-over'] = await snapshotter.capture();

  clock.at('2026-03-03T14:00:00.000Z');
  const payroll = await processDueJobs(null);
  assert.deepEqual([payroll.processed, payroll.success, payroll.fail], [3, 3, 0]);
  assert.deepEqual(payroll.activations, { checked: 1, activated: 1 });
  assert.deepEqual(
    (await readRows('SELECT user_id, base_salary, total_tasks, paid_amount FROM coin_payroll_history ORDER BY id'))
      .map((row) => [row.user_id, row.base_salary, row.total_tasks, row.paid_amount]),
    [[LEGACY_WAITER_ID, 0, 1, 0], [LEGACY_CHEF_ID, 140, 2, 160], [LEGACY_BARTENDER_ID, 120, 0, 0]]
  );
  await snapshotter.assertUntrackedTablesUnchanged('legacy settled');
  checkpoints.settled = await snapshotter.capture();

  assertMatchesGolden('venueWorkLegacyLifecycle.golden.json',
    buildGoldenDocument('legacy-venue-lifecycle', checkpoints));
});

test('primary reassign and cancel close the original venue task as cancelled and keep payroll consistent', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  const checkpoints = {};

  await seedCustomerCoins(2000);
  await selectVenueJobs([
    [WAITER_ID, { waiter: '服務生' }],
    [UNIFORM_WAITER_ID, { waiter: '制服服務生' }],
    [CHEF_ID, { chef: true }],
    [SECOND_CHEF_ID, { chef: true }],
    [BARTENDER_ID, { bartender: true }],
  ], 2);
  clock.at('2026-03-02T14:00:00.000Z');
  assert.deepEqual((await processDueJobs(null)).activations, { checked: 5, activated: 5 });

  clock.at('2026-03-03T01:00:00.000Z');
  const menu = await listVenueMenu(GUILD_ID);
  const placeOrder = async (mealName, drinkName, tipAmount) => {
    const placed = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
      mealId: menuItem(menu, mealName).id,
      drinkId: drinkName ? menuItem(menu, drinkName).id : null,
      chefId: CHEF_ID,
      bartenderId: drinkName ? BARTENDER_ID : null,
      waiterId: WAITER_ID,
      tipAmount,
      channelId: VENUE_CHANNEL_ID,
      membership: membership([WAITER_ID, CHEF_ID, BARTENDER_ID]),
    });
    clock.advance(MINUTE_MS);
    return placed;
  };
  const reassigned = await placeOrder('皇家牛排', '星光氣泡飲', 120); // maker and waiter are reassigned
  const fullyCancelled = await placeOrder('小吉炒飯', null, 60); // its only item is cancelled
  const partlyCancelled = await placeOrder('招牌拉麵', '翡翠檸檬茶', 80); // meal cancelled, drink served
  const blocked = await placeOrder('小吉炒飯', null, 50); // its task expires before the venue sweep

  // Maker reassignment cancels the original pending task (stored as TASK_STATUS.CANCELED).
  clock.at('2026-03-03T01:10:00.000Z');
  const movedItem = await reassignVenueOrderItem(GUILD_ID, reassigned.items[0].id, SECOND_CHEF_ID, {
    operatorId: OPERATOR_ID, reason: '原廚師忙碌，改派', membership: membership([SECOND_CHEF_ID]),
  });
  assert.deepEqual([movedItem.makerUserId, movedItem.status], [SECOND_CHEF_ID, 'pending']);
  assert.deepEqual(await readTaskStatuses(`venue-item-${reassigned.items[0].id}`), [
    [CHEF_ID, null, 'cancelled'],
    [SECOND_CHEF_ID, null, 'pending'],
  ]);

  // Waiter reassignment to a uniform waiter (minimum tip 100) works for a 120 tip...
  clock.at('2026-03-03T01:15:00.000Z');
  const movedOrder = await reassignVenueWaiter(GUILD_ID, reassigned.order.id, UNIFORM_WAITER_ID, {
    operatorId: OPERATOR_ID, reason: '改由制服服務生送餐', membership: membership([UNIFORM_WAITER_ID]),
  });
  assert.deepEqual([movedOrder.waiterUserId, movedOrder.waiterJobName, movedOrder.tipStatus],
    [UNIFORM_WAITER_ID, '制服服務生', 'escrowed']);
  assert.deepEqual(await readTaskStatuses(`venue-order-${reassigned.order.id}`), [
    [WAITER_ID, null, 'cancelled'],
    [UNIFORM_WAITER_ID, null, 'pending'],
  ]);
  // ...and is rejected without writes when the escrowed tip is below that minimum.
  await assertRejectedWithoutWrites(snapshotter, () => reassignVenueWaiter(GUILD_ID, fullyCancelled.order.id,
    UNIFORM_WAITER_ID, { operatorId: OPERATOR_ID, reason: '小費不足', membership: membership([UNIFORM_WAITER_ID]) }),
  'VENUE_TIP_TOO_SMALL');

  // Cancelling the only item cancels the order and refunds the escrowed tip.  The order was not
  // served, so served_at and served_by stay empty, and the waiter task is cancelled with a
  // cancellation reason (not closed as an overdue delivery).
  clock.at('2026-03-03T01:20:00.000Z');
  const cancelledItem = await cancelVenueOrderItem(GUILD_ID, fullyCancelled.items[0].id, {
    operatorId: OPERATOR_ID, reason: '顧客取消餐點',
  });
  assert.equal(cancelledItem.status, 'cancelled');
  assert.deepEqual(await readRows(
    'SELECT status, tip_status, tip_refunded_at, served_at, served_by FROM casino_venue_orders WHERE id = ?',
    [fullyCancelled.order.id]
  ), [{ status: 'cancelled', tip_status: 'refunded', tip_refunded_at: '2026-03-03T01:20:00.000Z', served_at: null, served_by: null }]);
  assert.deepEqual(await readRows(
    'SELECT user_id, status, review_reason, completed_at FROM coin_work_tasks WHERE message_id = ?',
    [`venue-order-${fullyCancelled.order.id}`]
  ), [{ user_id: WAITER_ID, status: 'cancelled', review_reason: CANCELLED_ORDER_WAITER_REASON, completed_at: null }]);
  assert.equal(await countTipRefunds(fullyCancelled.order.id), 1);
  // Cancelling one of two items keeps the order open for the remaining drink.
  clock.at('2026-03-03T01:25:00.000Z');
  await cancelVenueOrderItem(GUILD_ID, partlyCancelled.items[0].id, { operatorId: OPERATOR_ID, reason: '食材不足' });
  assert.deepEqual(await readRows('SELECT status, tip_status FROM casino_venue_orders WHERE id = ?',
    [partlyCancelled.order.id]), [{ status: 'pending', tip_status: 'escrowed' }]);

  // Every cancelled venue task is stored as TASK_STATUS.CANCELED, so the /work "已取消" filter
  // finds the maker tasks of the reassignment and both item cancellations, and the waiter tasks
  // of the waiter reassignment and the cancelled order.
  assert.equal(TASK_STATUS.CANCELED, 'cancelled');
  assert.deepEqual(await readRows("SELECT id FROM coin_work_tasks WHERE status = 'canceled'"), []);
  assert.deepEqual(
    (await listWorkTasks(GUILD_ID, { userId: CHEF_ID, status: TASK_STATUS.CANCELED })).map((task) => [task.messageId, task.status]),
    [partlyCancelled, fullyCancelled, reassigned].map((placed) => [`venue-item-${placed.items[0].id}`, 'cancelled'])
  );
  assert.deepEqual(
    (await listWorkTasks(GUILD_ID, { userId: WAITER_ID, status: TASK_STATUS.CANCELED })).map((task) => task.messageId),
    [fullyCancelled, reassigned].map((placed) => `venue-order-${placed.order.id}`)
  );
  await assertTipMoneyConserved();
  await snapshotter.assertUntrackedTablesUnchanged('reassigned and cancelled');
  checkpoints['reassigned-and-cancelled'] = await snapshotter.capture();

  clock.at('2026-03-03T01:30:00.000Z');
  await completeVenueOrderItem(GUILD_ID, SECOND_CHEF_ID, reassigned.items[0].id, {
    steps: '牛排兩面撒鹽與黑胡椒\n熱鍋煎至焦香\n靜置後切片擺盤',
  });
  clock.at('2026-03-03T01:35:00.000Z');
  await completeVenueOrderItem(GUILD_ID, BARTENDER_ID, reassigned.items[1].id, {
    steps: '杯中加入冰塊與莓果糖漿\n倒入氣泡水\n用薄荷葉裝飾',
  });
  clock.at('2026-03-03T01:40:00.000Z');
  const servedByUniform = await serveVenueOrder(GUILD_ID, UNIFORM_WAITER_ID, reassigned.order.id);
  assert.equal(servedByUniform.tipResult.payout.netAmount, 120);
  clock.at('2026-03-03T01:45:00.000Z');
  await completeVenueOrderItem(GUILD_ID, BARTENDER_ID, partlyCancelled.items[1].id, {
    steps: '泡好綠茶並冷卻\n加入檸檬汁與糖漿\n倒入杯中加檸檬片',
  });
  clock.at('2026-03-03T01:50:00.000Z');
  const servedPartly = await serveVenueOrder(GUILD_ID, WAITER_ID, partlyCancelled.order.id);
  assert.equal(servedPartly.tipResult.payout.netAmount, 80);
  // Finished or served work can no longer be reassigned or cancelled.
  await assertRejectedWithoutWrites(snapshotter, () => cancelVenueOrderItem(GUILD_ID, reassigned.items[0].id, {
    operatorId: OPERATOR_ID, reason: '已完成後取消',
  }), 'VENUE_ORDER_ITEM_NOT_PENDING');
  await assertRejectedWithoutWrites(snapshotter, () => reassignVenueOrderItem(GUILD_ID, reassigned.items[0].id, CHEF_ID, {
    operatorId: OPERATOR_ID, reason: '已完成後改派', membership: membership([CHEF_ID]),
  }), 'VENUE_ORDER_ITEM_NOT_PENDING');
  await assertRejectedWithoutWrites(snapshotter, () => reassignVenueWaiter(GUILD_ID, reassigned.order.id, WAITER_ID, {
    operatorId: OPERATOR_ID, reason: '已送達後改派', membership: membership([WAITER_ID]),
  }), 'VENUE_ORDER_ALREADY_SERVED');
  // The cancelled order has nothing to serve, and its refunded tip cannot be paid out.
  await assertRejectedWithoutWrites(snapshotter, () => serveVenueOrder(GUILD_ID, WAITER_ID, fullyCancelled.order.id),
    'VENUE_ORDER_CANCELLED');
  checkpoints.served = await snapshotter.capture();

  // The primary-task sweep runs before the venue sweep.  It closes the late chef's task of the
  // last order with the cycle penalty, and leaves that order's waiter task to the venue sweep
  // because the tip is still escrowed.  In that window the chef's task can no longer be verified,
  // so reassign and cancel both fail closed without writes, each in its own words; the venue
  // sweep then hands the item to NPC staff and refunds the tip without blaming the waiter.
  clock.at('2026-03-04T01:03:00.000Z');
  const workSweep = await processExpiredWorkTasks(null);
  assert.deepEqual(workSweep.primary, { checked: 1, completed: 1, penalties: 1 });
  assert.deepEqual(await readTaskStatuses(`venue-order-${blocked.order.id}`), [[WAITER_ID, null, 'pending']]);
  await assertRejectedWithoutWrites(snapshotter, () => reassignVenueOrderItem(GUILD_ID, blocked.items[0].id, SECOND_CHEF_ID, {
    operatorId: OPERATOR_ID, reason: '逾期後改派', membership: membership([SECOND_CHEF_ID]),
  }), 'VENUE_TASK_MISSING', '原場館待辦無法核對，暫停改派。');
  await assertRejectedWithoutWrites(snapshotter, () => cancelVenueOrderItem(GUILD_ID, blocked.items[0].id, {
    operatorId: OPERATOR_ID, reason: '逾期後取消',
  }), 'VENUE_TASK_MISSING', '原場館待辦無法核對，暫停取消。');
  const venueSweep = await processExpiredVenueOrderItems();
  assert.deepEqual(venueSweep, { checked: 1, completedByNpc: 1, penaltiesCreated: 0, waiterRefunded: 1 });
  assert.deepEqual(await readRows(
    'SELECT status, review_reason FROM coin_work_tasks WHERE message_id = ?', [`venue-order-${blocked.order.id}`]
  ), [{ status: 'system_completed', review_reason: MAKER_OVERDUE_WAITER_REASON }]);
  // The cancelled order is older than 24 hours as well, but its tip was refunded once, at the
  // cancellation; the sweep does not refund it again, and a second sweep finds nothing to do.
  assert.equal(await countTipRefunds(fullyCancelled.order.id), 1);
  assert.equal(await countTipRefunds(blocked.order.id), 1);
  checkpoints['taken-over'] = await snapshotter.capture();
  assert.deepEqual(await processExpiredVenueOrderItems(),
    { checked: 0, completedByNpc: 0, penaltiesCreated: 0, waiterRefunded: 0 });
  assert.deepEqual(await snapshotter.capture(), checkpoints['taken-over']);
  await assertTipMoneyConserved();

  clock.at('2026-03-04T14:00:00.000Z');
  const settlement = await processDueJobs(null);
  assert.deepEqual(settlement.primaryCycles, { checked: 5, settled: 5, failed: 0, roleCleanupFailed: 0 });
  assert.deepEqual(
    (await readRows('SELECT user_id, gross_amount, paid_amount FROM coin_primary_cycle_payroll ORDER BY user_id'))
      .map((row) => [row.user_id, row.gross_amount, row.paid_amount]),
    [[WAITER_ID, 0, 0], [UNIFORM_WAITER_ID, 0, 0], [CHEF_ID, 0, 0], [SECOND_CHEF_ID, 140, 140], [BARTENDER_ID, 120, 120]]
  );
  await snapshotter.assertUntrackedTablesUnchanged('reassign and cancel settled');
  checkpoints.settled = await snapshotter.capture();

  assertMatchesGolden('venueWorkReassignCancel.golden.json',
    buildGoldenDocument('primary-reassign-cancel', checkpoints));
});

test('legacy venue work reassigned or cancelled after the cutover moves to primary cycles or is refunded', async (t) => {
  const clock = startClock(t, '2026-03-01T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  const checkpoints = {};

  const menu = await listVenueMenu(GUILD_ID);
  await seedCustomerCoins(1000);
  const startAt = '2026-03-01T01:00:00.000Z';
  const payAt = '2026-03-04T14:00:00.000Z';
  const jobs = await withCoinTransaction((api) => ({
    waiter: insertLegacyJob(api, { userId: LEGACY_WAITER_ID, jobName: '服務生', dailySalary: 0, workDays: 3, startAt, payAt }),
    chef: insertLegacyJob(api, { userId: LEGACY_CHEF_ID, jobName: '廚師', dailySalary: 70, workDays: 3, startAt, payAt }),
    bartender: insertLegacyJob(api, { userId: LEGACY_BARTENDER_ID, jobName: '調酒師', dailySalary: 60, workDays: 3, startAt, payAt }),
  }));
  clock.at('2026-03-02T03:00:00.000Z');
  const mealOrder = await withCoinTransaction((api) => insertLegacyOrder(api, {
    jobs, item: menuItem(menu, '皇家牛排'), makerId: LEGACY_CHEF_ID, makerJobId: jobs.chef, makerJobName: '廚師',
    tipAmount: 100, createdAt: '2026-03-02T03:00:00.000Z',
  }));
  clock.at('2026-03-02T03:05:00.000Z');
  const drinkOrder = await withCoinTransaction((api) => insertLegacyOrder(api, {
    jobs, item: menuItem(menu, '星光氣泡飲'), makerId: LEGACY_BARTENDER_ID, makerJobId: jobs.bartender,
    makerJobName: '調酒師', tipAmount: 50, createdAt: '2026-03-02T03:05:00.000Z',
  }));
  clock.at('2026-03-02T04:00:00.000Z');
  assert.deepEqual(await captureLegacyJobBatch(), { users: 3, snapshots: 3, nextUserId: null });
  clock.at('2026-03-02T05:00:00.000Z');
  await selectVenueJobs([[WAITER_ID, { waiter: '服務生' }], [CHEF_ID, { chef: true }]], 2);
  clock.at('2026-03-02T14:00:00.000Z');
  assert.deepEqual((await processDueJobs(null)).activations, { checked: 2, activated: 2 });

  // The legacy maker task is checked against the frozen cutover snapshot, cancelled as
  // TASK_STATUS.CANCELED, and the item moves to the new maker's primary cycle.
  clock.at('2026-03-02T15:00:00.000Z');
  const movedItem = await reassignVenueOrderItem(GUILD_ID, mealOrder.itemId, CHEF_ID, {
    operatorId: OPERATOR_ID, reason: '舊廚師待辦改派新主職', membership: membership([CHEF_ID]),
  });
  assert.deepEqual([movedItem.makerUserId, movedItem.makerJobId], [CHEF_ID, null]);
  assert.ok(movedItem.globalCycleId);
  assert.deepEqual(await readTaskStatuses(`venue-item-${mealOrder.itemId}`), [
    [LEGACY_CHEF_ID, jobs.chef, 'cancelled'],
    [CHEF_ID, null, 'pending'],
  ]);
  clock.at('2026-03-02T15:05:00.000Z');
  const movedOrder = await reassignVenueWaiter(GUILD_ID, mealOrder.orderId, WAITER_ID, {
    operatorId: OPERATOR_ID, reason: '舊服務生待辦改派新主職', membership: membership([WAITER_ID]),
  });
  assert.deepEqual([movedOrder.waiterUserId, movedOrder.waiterJobId], [WAITER_ID, null]);
  assert.ok(movedOrder.waiterGlobalCycleId);
  assert.deepEqual(await readTaskStatuses(`venue-order-${mealOrder.orderId}`), [
    [LEGACY_WAITER_ID, jobs.waiter, 'cancelled'],
    [WAITER_ID, null, 'pending'],
  ]);
  // Cancelling the only legacy item refunds its tip once and cancels the legacy waiter task; the
  // unserved order keeps served_at and served_by empty.
  clock.at('2026-03-02T15:10:00.000Z');
  await cancelVenueOrderItem(GUILD_ID, drinkOrder.itemId, { operatorId: OPERATOR_ID, reason: '顧客取消飲料' });
  assert.deepEqual(await readTaskStatuses(`venue-item-${drinkOrder.itemId}`), [
    [LEGACY_BARTENDER_ID, jobs.bartender, 'cancelled'],
  ]);
  assert.deepEqual(await readTaskStatuses(`venue-order-${drinkOrder.orderId}`), [
    [LEGACY_WAITER_ID, jobs.waiter, 'cancelled'],
  ]);
  assert.deepEqual(await readRows('SELECT status, tip_status, served_at, served_by FROM casino_venue_orders WHERE id = ?',
    [drinkOrder.orderId]), [{ status: 'cancelled', tip_status: 'refunded', served_at: null, served_by: null }]);
  assert.equal(await countTipRefunds(drinkOrder.orderId), 1);
  await assertTipMoneyConserved();
  await snapshotter.assertUntrackedTablesUnchanged('legacy reassigned and cancelled');
  checkpoints['reassigned-and-cancelled'] = await snapshotter.capture();

  clock.at('2026-03-02T16:00:00.000Z');
  await completeVenueOrderItem(GUILD_ID, CHEF_ID, mealOrder.itemId, {
    steps: '牛排兩面撒鹽與黑胡椒\n熱鍋煎至焦香\n靜置後切片擺盤',
  });
  clock.at('2026-03-02T16:10:00.000Z');
  const served = await serveVenueOrder(GUILD_ID, WAITER_ID, mealOrder.orderId);
  assert.equal(served.tipResult.payout.netAmount, 100);
  checkpoints.served = await snapshotter.capture();

  // Legacy payroll and the new primary cycles settle in the same scheduler pass.
  clock.at('2026-03-04T14:00:00.000Z');
  const payroll = await processDueJobs(null);
  assert.deepEqual([payroll.processed, payroll.success, payroll.fail], [3, 3, 0]);
  assert.deepEqual(payroll.primaryCycles, { checked: 2, settled: 2, failed: 0, roleCleanupFailed: 0 });
  assert.deepEqual(
    (await readRows('SELECT user_id, total_tasks, paid_amount FROM coin_payroll_history ORDER BY id'))
      .map((row) => [row.user_id, row.total_tasks, row.paid_amount]),
    [[LEGACY_WAITER_ID, 0, 0], [LEGACY_CHEF_ID, 0, 0], [LEGACY_BARTENDER_ID, 0, 0]]
  );
  assert.deepEqual(
    (await readRows('SELECT user_id, gross_amount, paid_amount FROM coin_primary_cycle_payroll ORDER BY user_id'))
      .map((row) => [row.user_id, row.gross_amount, row.paid_amount]),
    [[WAITER_ID, 0, 0], [CHEF_ID, 140, 140]]
  );
  await snapshotter.assertUntrackedTablesUnchanged('legacy reassign and cancel settled');
  checkpoints.settled = await snapshotter.capture();

  assertMatchesGolden('venueWorkLegacyReassignCancel.golden.json',
    buildGoldenDocument('legacy-reassign-cancel', checkpoints));
});

// The tests below cover the behavior that was first pinned here as questionable and is now fixed:
// the waiter's refund reason, sweep order, the cancelled-status spelling, the pre-v22 waiter lookup
// and the legacy sweep time.  Cancel wording, cancel refund fields and admin-log job attribution
// are asserted in the flows above.

async function runWaiterOverdueScenario(clock, expiryOrder) {
  clock.at('2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  await seedCustomerCoins(1000);
  await selectVenueJobs([[WAITER_ID, { waiter: '服務生' }], [CHEF_ID, { chef: true }]], 3);
  clock.at('2026-03-02T14:00:00.000Z');
  assert.deepEqual((await processDueJobs(null)).activations, { checked: 2, activated: 2 });

  clock.at('2026-03-03T01:00:00.000Z');
  const menu = await listVenueMenu(GUILD_ID);
  // Made by the chef within the hour.
  const madeOnTime = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
    mealId: menuItem(menu, '皇家牛排').id,
    chefId: CHEF_ID,
    waiterId: WAITER_ID,
    tipAmount: 70,
    channelId: VENUE_CHANNEL_ID,
    membership: membership([WAITER_ID, CHEF_ID]),
  });
  // Made by NPC staff when it was placed, because no bartender is on duty.
  const madeAtOrder = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
    drinkId: menuItem(menu, '星光氣泡飲').id,
    waiterId: WAITER_ID,
    tipAmount: 60,
    channelId: VENUE_CHANNEL_ID,
    membership: membership([CUSTOMER_ID, WAITER_ID, CHEF_ID], { rosterComplete: true }),
  });
  assert.deepEqual(madeAtOrder.items.map((item) => [item.makerUserId, item.makerIsNpc, item.status]),
    [[null, true, 'completed']]);
  clock.advance(HOUR_MS);
  await completeVenueOrderItem(GUILD_ID, CHEF_ID, madeOnTime.items[0].id, {
    steps: '牛排兩面撒鹽與黑胡椒\n熱鍋煎至焦香\n靜置後切片擺盤',
  });

  clock.at('2026-03-04T01:00:00.000Z');
  const due = await runExpiryHandlers(expiryOrder);
  return {
    due,
    orderIds: [madeOnTime.order.id, madeAtOrder.order.id],
    document: buildGoldenDocument('waiter-overdue', { 'taken-over': await snapshotter.capture() }),
  };
}

test('a waiter who leaves a ready order unserved for 24 hours is counted late, in either sweep order, and refunded once', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const readWaiterOutcome = async () => ({
    tasks: await readRows(
      "SELECT message_id, status, review_reason FROM coin_work_tasks WHERE task_type = 'casino_venue_service' ORDER BY id"
    ),
    orders: await readRows('SELECT id, tip_status, served_by FROM casino_venue_orders ORDER BY id'),
    refunds: await readRows("SELECT user_id, amount, reason FROM chip_ledger WHERE entry_type = 'tip_refund' ORDER BY id"),
  });

  const venueFirst = await runWaiterOverdueScenario(clock, 'venue-first');
  assert.deepEqual(venueFirst.due.venue, { checked: 0, completedByNpc: 0, penaltiesCreated: 0, waiterRefunded: 2 });
  assert.deepEqual(venueFirst.due.work.primary, { checked: 0, completed: 0, penalties: 0 });
  const [onTimeId, atOrderId] = venueFirst.orderIds;
  const expected = {
    tasks: [onTimeId, atOrderId].map((id) => ({
      message_id: `venue-order-${id}`, status: 'system_completed', review_reason: WAITER_OVERDUE_REASON,
    })),
    orders: [onTimeId, atOrderId].map((id) => ({ id, tip_status: 'refunded', served_by: 'system' })),
    refunds: [[onTimeId, 70], [atOrderId, 60]].map(([id, amount]) => ({
      user_id: CUSTOMER_ID, amount, reason: `場館訂單 #${id} 服務生逾期未送達，退還小費。`,
    })),
  };
  assert.deepEqual(await readWaiterOutcome(), expected);
  // A waiter has no daily salary, so being late adds no penalty row.
  assert.deepEqual(await readRows('SELECT id FROM coin_primary_cycle_penalties'), []);
  await assertTipMoneyConserved();
  // More sweeps, two of them run together, refund nothing again.
  const again = await Promise.all([processExpiredVenueOrderItems(), processExpiredVenueOrderItems()]);
  assert.deepEqual(again.map((result) => result.waiterRefunded), [0, 0]);
  assert.deepEqual((await processExpiredWorkTasks(null)).primary, { checked: 0, completed: 0, penalties: 0 });
  assert.deepEqual(await readWaiterOutcome(), expected);
  await assertTipMoneyConserved();

  const workFirst = await runWaiterOverdueScenario(clock, 'work-first');
  assert.deepEqual(workFirst.due, venueFirst.due);
  assert.deepEqual(await readWaiterOutcome(), expected);
  assert.deepEqual(describeGoldenDifferences(venueFirst.document, workFirst.document, 100), []);
});

test('the /work cancelled filter reads both spellings of the cancelled task status and rewrites none', async (t) => {
  startClock(t, '2026-03-02T01:00:00.000Z');
  await openSyntheticDatabase();
  // Rows stored as 'canceled' before the spelling fix stay as they are.
  await withCoinTransaction((api) => {
    const jobId = insertLegacyJob(api, {
      userId: CHEF_ID, jobName: '廚師', dailySalary: 70, workDays: 2,
      startAt: '2026-03-02T01:00:00.000Z', payAt: '2026-03-03T14:00:00.000Z',
    });
    for (const [index, createdAt] of ['2026-03-02T01:00:00.000Z', '2026-03-02T01:01:00.000Z', '2026-03-02T01:02:00.000Z'].entries()) {
      insertLegacyPendingTask(api, {
        userId: CHEF_ID, jobId, jobName: '廚師', taskType: 'casino_venue_meal',
        description: `合成待辦 ${index + 1}`, messageId: `venue-item-${index + 1}`, createdAt,
      });
    }
    api.run("UPDATE coin_work_tasks SET status = 'canceled' WHERE message_id = 'venue-item-1'");
    api.run("UPDATE coin_work_tasks SET status = 'cancelled' WHERE message_id = 'venue-item-2'");
  });
  const stored = [['venue-item-1', 'canceled'], ['venue-item-2', 'cancelled'], ['venue-item-3', 'pending']];
  const readStored = async () => (await readRows('SELECT message_id, status FROM coin_work_tasks ORDER BY id'))
    .map((row) => [row.message_id, row.status]);
  assert.deepEqual(await readStored(), stored);

  for (const status of [TASK_STATUS.CANCELED, 'canceled']) {
    assert.deepEqual(
      (await listWorkTasks(GUILD_ID, { userId: CHEF_ID, status })).map((task) => [task.messageId, task.status]),
      [['venue-item-2', 'cancelled'], ['venue-item-1', 'cancelled']],
      `filter ${status}`
    );
  }
  assert.deepEqual((await listWorkTasks(GUILD_ID, { status: TASK_STATUS.PENDING })).map((task) => task.messageId),
    ['venue-item-3']);
  assert.deepEqual((await listWorkTasks(GUILD_ID)).map((task) => task.status), ['pending', 'cancelled', 'cancelled']);
  assert.deepEqual(await readStored(), stored);
});

// Startup always migrates a stored database to the latest version, so only a database still below
// v22 takes the guild-scoped job branches of the venue code.  These tests lower the stored version
// to reach them; each one exercises one caller of the pre-v22 waiter lookup.
async function openPreV22Venue() {
  await openSyntheticDatabase();
  const menu = await listVenueMenu(GUILD_ID);
  await seedCustomerCoins(1000);
  const startAt = '2026-03-02T01:00:00.000Z';
  const payAt = '2026-03-04T14:00:00.000Z';
  const jobs = await withCoinTransaction((api) => {
    api.run("UPDATE coin_metadata SET value = '21' WHERE key = 'schema_version'");
    return {
      waiter: insertLegacyJob(api, { userId: LEGACY_WAITER_ID, jobName: '服務生', dailySalary: 0, workDays: 2, startAt, payAt }),
      uniformWaiter: insertLegacyJob(api, {
        userId: UNIFORM_WAITER_ID, jobName: '制服服務生', dailySalary: 0, workDays: 2, startAt, payAt,
      }),
      chef: insertLegacyJob(api, { userId: LEGACY_CHEF_ID, jobName: '廚師', dailySalary: 70, workDays: 2, startAt, payAt }),
    };
  });
  return { menu, jobs };
}

async function insertPreV22Order(menu, jobs, tipAmount) {
  return withCoinTransaction((api) => insertLegacyOrder(api, {
    jobs, item: menuItem(menu, '招牌拉麵'), makerId: LEGACY_CHEF_ID, makerJobId: jobs.chef, makerJobName: '廚師',
    tipAmount, createdAt: '2026-03-02T01:00:00.000Z',
  }));
}

test('before schema v22, createVenueOrder looks up the waiter\'s active guild job', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const { menu, jobs } = await openPreV22Venue();
  const mealId = menuItem(menu, '招牌拉麵').id;

  clock.at('2026-03-02T02:00:00.000Z');
  await assert.rejects(createVenueOrder(GUILD_ID, CUSTOMER_ID, {
    mealId, chefId: LEGACY_CHEF_ID, waiterId: BARTENDER_ID, tipAmount: 120, channelId: VENUE_CHANNEL_ID,
  }), (error) => error.code === 'VENUE_WAITER_JOB_REQUIRED');
  const placed = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
    mealId, chefId: LEGACY_CHEF_ID, waiterId: LEGACY_WAITER_ID, tipAmount: 120, channelId: VENUE_CHANNEL_ID,
  });
  assert.deepEqual(
    [placed.order.waiterJobId, placed.order.waiterJobName, placed.order.waiterGlobalCycleId, placed.order.tipStatus],
    [jobs.waiter, '服務生', null, 'escrowed']
  );
  assert.deepEqual(placed.items.map((item) => [item.makerUserId, item.makerJobId, item.status]),
    [[LEGACY_CHEF_ID, jobs.chef, 'pending']]);
  assert.deepEqual(await readTaskStatuses(`venue-order-${placed.order.id}`), [[LEGACY_WAITER_ID, jobs.waiter, 'pending']]);
  await assertTipMoneyConserved();
});

test('before schema v22, reassignVenueWaiter looks up the new waiter\'s active guild job', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const { menu, jobs } = await openPreV22Venue();
  const order = await insertPreV22Order(menu, jobs, 120);

  clock.at('2026-03-02T01:10:00.000Z');
  await assert.rejects(reassignVenueWaiter(GUILD_ID, order.orderId, BARTENDER_ID, {
    operatorId: OPERATOR_ID, reason: '沒有服務生工作',
  }), (error) => error.code === 'VENUE_WAITER_JOB_REQUIRED');
  const moved = await reassignVenueWaiter(GUILD_ID, order.orderId, UNIFORM_WAITER_ID, {
    operatorId: OPERATOR_ID, reason: '改由制服服務生送餐',
  });
  assert.deepEqual([moved.waiterUserId, moved.waiterJobId, moved.waiterJobName, moved.tipStatus],
    [UNIFORM_WAITER_ID, jobs.uniformWaiter, '制服服務生', 'escrowed']);
  assert.deepEqual(await readTaskStatuses(`venue-order-${order.orderId}`), [
    [LEGACY_WAITER_ID, jobs.waiter, 'cancelled'],
    [UNIFORM_WAITER_ID, jobs.uniformWaiter, 'pending'],
  ]);
  await assertTipMoneyConserved();
});

test('before schema v22, serveVenueOrder checks the serving waiter\'s active guild job and pays the tip once', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const { menu, jobs } = await openPreV22Venue();
  const order = await insertPreV22Order(menu, jobs, 80);
  clock.at('2026-03-02T01:20:00.000Z');
  await completeVenueOrderItem(GUILD_ID, LEGACY_CHEF_ID, order.itemId, { steps: '煮滾高湯\n麵條煮至彈牙\n放入叉燒與配菜' });

  // A waiter whose guild job is no longer active cannot serve.
  clock.at('2026-03-02T01:30:00.000Z');
  const setWaiterJobStatus = (status) => withCoinTransaction((api) => {
    api.run('UPDATE coin_jobs SET status = ? WHERE id = ?', [status, jobs.waiter]);
  });
  await setWaiterJobStatus('paid');
  await assert.rejects(serveVenueOrder(GUILD_ID, LEGACY_WAITER_ID, order.orderId),
    (error) => error.code === 'VENUE_WAITER_JOB_REQUIRED');
  await setWaiterJobStatus('active');

  const served = await serveVenueOrder(GUILD_ID, LEGACY_WAITER_ID, order.orderId);
  assert.equal(served.order.tipStatus, 'paid');
  assert.equal(served.tipResult.payout.netAmount, 80);
  assert.deepEqual(await readTaskStatuses(`venue-order-${order.orderId}`), [[LEGACY_WAITER_ID, jobs.waiter, 'completed']]);
  await assert.rejects(serveVenueOrder(GUILD_ID, LEGACY_WAITER_ID, order.orderId),
    (error) => error.code === 'VENUE_ORDER_ALREADY_SERVED');
  await assertTipMoneyConserved();
});

async function openActiveWaiterAndChef(clock) {
  clock.at('2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  await seedCustomerCoins(5000);
  await selectVenueJobs([[WAITER_ID, { waiter: '服務生' }], [CHEF_ID, { chef: true }]], 3);
  clock.at('2026-03-02T14:00:00.000Z');
  assert.deepEqual((await processDueJobs(null)).activations, { checked: 2, activated: 2 });
  clock.at('2026-03-03T01:00:00.000Z');
  const menu = await listVenueMenu(GUILD_ID);
  const placeMadeOrder = async (tipAmount = 50) => {
    const placed = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
      mealId: menuItem(menu, '小吉炒飯').id,
      chefId: CHEF_ID,
      waiterId: WAITER_ID,
      tipAmount,
      channelId: VENUE_CHANNEL_ID,
      membership: membership([WAITER_ID, CHEF_ID]),
    });
    await completeVenueOrderItem(GUILD_ID, CHEF_ID, placed.items[0].id, { steps: '熱鍋下油\n加入白飯拌炒\n盛盤' });
    return placed;
  };
  return { snapshotter, menu, placeMadeOrder };
}

test('the primary-task sweep closes the waiter task of every damaged order the venue sweep will not close', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const { placeMadeOrder } = await openActiveWaiterAndChef(clock);
  const notEscrowed = await placeMadeOrder();
  const servedButEscrowed = await placeMadeOrder();
  const zeroTip = await placeMadeOrder();
  // Damaged orders whose waiter task was left pending: the tip is no longer escrowed; the tip is
  // still escrowed but the order is marked served; the tip is escrowed with an amount of 0.  The
  // venue sweep only closes escrowed, unserved orders with a positive tip, so the primary-task sweep
  // must close these waiter tasks or they would stay pending and block the waiter's settlement.
  await withCoinTransaction((api) => {
    api.run("UPDATE casino_venue_orders SET tip_status = 'none' WHERE id = ?", [notEscrowed.order.id]);
    api.run("UPDATE casino_venue_orders SET served_at = ?, served_by = 'system' WHERE id = ?",
      ['2026-03-03T02:00:00.000Z', servedButEscrowed.order.id]);
    api.run('UPDATE casino_venue_orders SET tip_amount = 0 WHERE id = ?', [zeroTip.order.id]);
  });
  const damaged = [notEscrowed, servedButEscrowed, zeroTip].map((placed) => placed.order.id);

  clock.at('2026-03-04T01:00:00.000Z');
  const { venue, work } = await runExpiryHandlers('venue-first');
  assert.deepEqual(venue, { checked: 0, completedByNpc: 0, penaltiesCreated: 0, waiterRefunded: 0 });
  assert.deepEqual(work.primary, { checked: 3, completed: 3, penalties: 0 });
  for (const orderId of damaged) {
    assert.deepEqual(await readRows('SELECT status, review_reason FROM coin_work_tasks WHERE message_id = ?',
      [`venue-order-${orderId}`]), [{ status: 'system_completed', review_reason: PRIMARY_OVERDUE_REASON }], `order #${orderId}`);
    assert.equal(await countTipRefunds(orderId), 0, `order #${orderId}`);
  }
  assert.deepEqual(await readRows("SELECT id FROM coin_work_tasks WHERE status = 'pending'"), []);
});

test('more than 50 waiter tasks left to the venue sweep never take the places of other overdue tasks', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  await openActiveWaiterAndChef(clock);
  const cycles = Object.fromEntries((await readRows(
    "SELECT user_id, cycle_id FROM coin_primary_job_cycles WHERE status = 'active'"
  )).map((row) => [row.user_id, row.cycle_id]));
  const createdAt = '2026-03-03T01:00:00.000Z';
  const dueAt = '2026-03-03T11:00:00.000Z';
  const waiterTasks = 55;
  await withCoinTransaction((api) => {
    // Open orders with an escrowed tip and their pending waiter tasks, all older than the chef's task.
    for (let index = 0; index < waiterTasks; index += 1) {
      api.run(
        `INSERT INTO casino_venue_orders (
          guild_id, customer_id, channel_id, waiter_user_id, waiter_job_id, waiter_global_cycle_id, waiter_job_name,
          waiter_assigned_at, waiter_due_at, tip_amount, tip_status, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, '服務生', ?, ?, 50, 'escrowed', 'pending', ?, ?)`,
        [GUILD_ID, CUSTOMER_ID, VENUE_CHANNEL_ID, WAITER_ID, cycles[WAITER_ID], createdAt, dueAt, createdAt, createdAt]
      );
      const orderId = lastInsertId(api);
      api.run(
        `INSERT INTO coin_work_tasks (
          guild_id, user_id, job_id, global_cycle_id, job_name, task_type, status, description,
          attachment_urls, expected_channel_id, expected_channel_name, message_id,
          external_server_count, external_server_ids, created_at, due_at, updated_at
        ) VALUES (?, ?, NULL, ?, '服務生', 'casino_venue_service', 'pending', ?, '[]', ?, '服務生', ?, 0, '[]', ?, ?, ?)`,
        [GUILD_ID, WAITER_ID, cycles[WAITER_ID], `訂單 #${orderId} 待送達`, VENUE_CHANNEL_ID, `venue-order-${orderId}`,
          createdAt, dueAt, createdAt]
      );
    }
    // Another worker's ordinary task, a minute later, so it sorts after every waiter task.
    api.run(
      `INSERT INTO coin_work_tasks (
        guild_id, user_id, job_id, global_cycle_id, job_name, task_type, status, description,
        attachment_urls, expected_channel_id, expected_channel_name, message_id,
        external_server_count, external_server_ids, created_at, due_at, updated_at
      ) VALUES (?, ?, NULL, ?, '廚師', 'work_report', 'pending', '整理廚房', '[]', ?, '廚師', NULL, 0, '[]', ?, ?, ?)`,
      [GUILD_ID, CHEF_ID, cycles[CHEF_ID], VENUE_CHANNEL_ID, '2026-03-03T01:01:00.000Z', dueAt, '2026-03-03T01:01:00.000Z']
    );
  });

  clock.at('2026-03-04T01:01:00.000Z');
  for (let round = 0; round < 2; round += 1) {
    const { primary } = await processExpiredWorkTasks(null);
    assert.deepEqual(primary, round === 0 ? { checked: 1, completed: 1, penalties: 1 } : { checked: 0, completed: 0, penalties: 0 },
      `round ${round + 1}`);
  }
  assert.deepEqual(await readRows("SELECT status FROM coin_work_tasks WHERE user_id = ? AND task_type = 'work_report'", [CHEF_ID]),
    [{ status: 'system_completed' }]);
  assert.equal(Number((await readRows(
    "SELECT COUNT(*) AS count FROM coin_work_tasks WHERE task_type = 'casino_venue_service' AND status = 'pending'"
  ))[0].count), waiterTasks);
  // The venue sweep then closes every one of those waiter tasks with its refund.
  assert.equal((await processExpiredVenueOrderItems()).waiterRefunded, waiterTasks);
  assert.deepEqual(await readRows("SELECT id FROM coin_work_tasks WHERE status = 'pending'"), []);
});

test('a refund handed an outdated order row in the same transaction credits the tip only once', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const { placeMadeOrder } = await openActiveWaiterAndChef(clock);
  const overdueTwice = await placeMadeOrder(60);
  const cancelledTwice = await placeMadeOrder(70);
  const overdueThenCancelled = await placeMadeOrder(80);
  const readOrder = (placed) => readRows('SELECT * FROM casino_venue_orders WHERE id = ?', [placed.order.id]).then(([row]) => row);
  const stale = {
    overdueTwice: await readOrder(overdueTwice),
    cancelledTwice: await readOrder(cancelledTwice),
    overdueThenCancelled: await readOrder(overdueThenCancelled),
  };
  for (const row of Object.values(stale)) assert.equal(row.tip_status, 'escrowed');

  clock.at('2026-03-04T01:00:00.000Z');
  const timestamp = '2026-03-04T01:00:00.000Z';
  const results = await withCoinTransaction((api) => ({
    overdueTwice: [
      refundOverdueOrderTipForTests(api, stale.overdueTwice, { cause: 'waiter_overdue', timestamp }),
      refundOverdueOrderTipForTests(api, stale.overdueTwice, { cause: 'waiter_overdue', timestamp }),
    ],
    cancelledTwice: [
      refundCancelledOrderTipForTests(api, stale.cancelledTwice, { timestamp }),
      refundCancelledOrderTipForTests(api, stale.cancelledTwice, { timestamp }),
    ],
    overdueThenCancelled: [
      refundOverdueOrderTipForTests(api, stale.overdueThenCancelled, { cause: 'maker_overdue', timestamp }),
      refundCancelledOrderTipForTests(api, stale.overdueThenCancelled, { timestamp }),
    ],
  }));
  for (const [name, [first, second]] of Object.entries(results)) {
    assert.ok(first, `${name}: the first refund credits`);
    assert.equal(second, null, `${name}: the second refund credits nothing`);
  }
  for (const placed of [overdueTwice, cancelledTwice, overdueThenCancelled]) {
    assert.equal(await countTipRefunds(placed.order.id), 1, `order #${placed.order.id}`);
  }
  // The second call changed nothing else either: the waiter task keeps the first close-out.
  assert.deepEqual(await readRows(
    "SELECT message_id, status, review_reason FROM coin_work_tasks WHERE task_type = 'casino_venue_service' ORDER BY id"
  ), [
    { message_id: `venue-order-${overdueTwice.order.id}`, status: 'system_completed', review_reason: WAITER_OVERDUE_REASON },
    { message_id: `venue-order-${cancelledTwice.order.id}`, status: 'cancelled', review_reason: CANCELLED_ORDER_WAITER_REASON },
    { message_id: `venue-order-${overdueThenCancelled.order.id}`, status: 'system_completed', review_reason: MAKER_OVERDUE_WAITER_REASON },
  ]);
  await assertTipMoneyConserved();
});

test('editing a work task is refused once it was cancelled, expired or closed by the system', async (t) => {
  startClock(t, '2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  const statuses = ['pending', 'approved', 'rejected', 'completed', 'no_work_available',
    'cancelled', 'canceled', 'expired', 'system_completed', 'deleted', 'paid'];
  const taskIds = await withCoinTransaction((api) => {
    const jobId = insertLegacyJob(api, {
      userId: CHEF_ID, jobName: '廚師', dailySalary: 70, workDays: 3,
      startAt: '2026-03-02T01:00:00.000Z', payAt: '2026-03-05T14:00:00.000Z',
    });
    return Object.fromEntries(statuses.map((status, index) => {
      insertLegacyPendingTask(api, {
        userId: CHEF_ID, jobId, jobName: '廚師', taskType: 'work_submit', description: `合成任務 ${status}`,
        messageId: null, createdAt: new Date(Date.parse('2026-03-02T01:00:00.000Z') + index * MINUTE_MS).toISOString(),
      });
      const taskId = lastInsertId(api);
      const completedAt = ['cancelled', 'canceled', 'pending'].includes(status) ? null : '2026-03-02T02:00:00.000Z';
      api.run('UPDATE coin_work_tasks SET status = ?, completed_at = ? WHERE id = ?', [status, completedAt, taskId]);
      return [status, taskId];
    }));
  });
  const edit = (status) => editWorkSubmission(GUILD_ID, CHEF_ID, taskIds[status], { description: '改寫的內容' });

  const refusals = {
    cancelled: 'SUBMISSION_NOT_EDITABLE',
    canceled: 'SUBMISSION_NOT_EDITABLE',
    expired: 'SUBMISSION_NOT_EDITABLE',
    system_completed: 'SUBMISSION_NOT_EDITABLE',
    deleted: 'SUBMISSION_DELETED',
    paid: 'SUBMISSION_ALREADY_PAID',
  };
  for (const [status, code] of Object.entries(refusals)) {
    await assertRejectedWithoutWrites(snapshotter, () => edit(status), code,
      code === 'SUBMISSION_NOT_EDITABLE' ? '這筆工作已取消、逾期或由小吉接手完成，不能再修改。' : null);
  }
  // A submission may still be edited before payroll, and the edit sends it back to review.
  for (const status of ['pending', 'approved', 'rejected', 'completed', 'no_work_available']) {
    const edited = await edit(status);
    assert.deepEqual([edited.status, edited.description, edited.reviewReason], ['pending', '改寫的內容', null], status);
  }
});

test('deleting a work task is refused once it was cancelled, expired or closed by the system, and its penalty stays', async (t) => {
  startClock(t, '2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  const statuses = ['pending', 'approved', 'rejected', 'completed', 'no_work_available',
    'cancelled', 'canceled', 'expired', 'system_completed', 'deleted', 'paid'];
  const { taskIds, overdueTaskId } = await withCoinTransaction((api) => {
    const jobId = insertLegacyJob(api, {
      userId: CHEF_ID, jobName: '廚師', dailySalary: 70, workDays: 3,
      startAt: '2026-03-01T00:00:00.000Z', payAt: '2026-03-05T14:00:00.000Z',
    });
    // A task the legacy overdue sweep will close with a penalty.
    insertLegacyPendingTask(api, {
      userId: CHEF_ID, jobId, jobName: '廚師', taskType: 'work_report', description: '逾期的合成任務',
      messageId: null, createdAt: '2026-03-01T00:00:00.000Z',
    });
    const overdue = lastInsertId(api);
    const ids = Object.fromEntries(statuses.map((status, index) => {
      insertLegacyPendingTask(api, {
        userId: CHEF_ID, jobId, jobName: '廚師', taskType: 'work_submit', description: `合成任務 ${status}`,
        messageId: null, createdAt: new Date(Date.parse('2026-03-02T01:00:00.000Z') + index * MINUTE_MS).toISOString(),
      });
      const taskId = lastInsertId(api);
      const completedAt = ['cancelled', 'canceled', 'pending'].includes(status) ? null : '2026-03-02T02:00:00.000Z';
      api.run('UPDATE coin_work_tasks SET status = ?, completed_at = ? WHERE id = ?', [status, completedAt, taskId]);
      return [status, taskId];
    }));
    return { taskIds: ids, overdueTaskId: overdue };
  });
  // Only the older task is 24 hours overdue at this sweep time.
  const sweep = await processExpiredWorkTasks(null, { date: new Date('2026-03-02T01:00:00.000Z') });
  assert.deepEqual([sweep.checked, sweep.completedBySystem, sweep.penaltiesCreated], [1, 1, 1]);
  const readOverdueRecord = async () => ({
    task: await readRows('SELECT status, review_reason, deleted_at FROM coin_work_tasks WHERE id = ?', [overdueTaskId]),
    penalties: await readRows('SELECT task_id, penalty_amount, status FROM coin_work_penalties ORDER BY id'),
  });
  const overdueRecord = {
    task: [{ status: 'system_completed', review_reason: '逾期 24 小時未完成，由小吉系統接手完成。', deleted_at: null }],
    penalties: [{ task_id: overdueTaskId, penalty_amount: 70, status: 'active' }],
  };
  assert.deepEqual(await readOverdueRecord(), overdueRecord);

  const remove = (taskId) => deleteWorkSubmission(GUILD_ID, CHEF_ID, taskId, { reason: '合成刪除' });
  const refusedMessage = '這筆工作已取消、逾期或由小吉接手完成，不能刪除。';
  // The overdue close-out cannot be deleted: its record and its penalty stay as they were.
  await assertRejectedWithoutWrites(snapshotter, () => remove(overdueTaskId), 'SUBMISSION_NOT_DELETABLE', refusedMessage);
  assert.deepEqual(await readOverdueRecord(), overdueRecord);

  const refusals = {
    cancelled: 'SUBMISSION_NOT_DELETABLE',
    canceled: 'SUBMISSION_NOT_DELETABLE',
    expired: 'SUBMISSION_NOT_DELETABLE',
    system_completed: 'SUBMISSION_NOT_DELETABLE',
    deleted: 'SUBMISSION_DELETED',
    paid: 'SUBMISSION_ALREADY_PAID',
  };
  for (const [status, code] of Object.entries(refusals)) {
    await assertRejectedWithoutWrites(snapshotter, () => remove(taskIds[status]), code,
      code === 'SUBMISSION_NOT_DELETABLE' ? refusedMessage : null);
  }
  // A submission may still be deleted before payroll.
  for (const status of ['pending', 'approved', 'rejected', 'completed', 'no_work_available']) {
    const deleted = await remove(taskIds[status]);
    assert.deepEqual([deleted.status, deleted.reviewReason], ['deleted', '合成刪除'], status);
    assert.ok(deleted.deletedAt, status);
  }
  assert.deepEqual(await readOverdueRecord(), overdueRecord);
});

test('venue tasks are managed by the system: editing or deleting them is refused and payroll still settles', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  await seedCustomerCoins(1000);
  await selectVenueJobs([[WAITER_ID, { waiter: '服務生' }], [CHEF_ID, { chef: true }], [BARTENDER_ID, { bartender: true }]], 1);
  clock.at('2026-03-02T14:00:00.000Z');
  assert.deepEqual((await processDueJobs(null)).activations, { checked: 3, activated: 3 });

  clock.at('2026-03-03T01:00:00.000Z');
  const menu = await listVenueMenu(GUILD_ID);
  const placed = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
    mealId: menuItem(menu, '小吉炒飯').id,
    drinkId: menuItem(menu, '星光氣泡飲').id,
    chefId: CHEF_ID,
    bartenderId: BARTENDER_ID,
    waiterId: WAITER_ID,
    tipAmount: 60,
    channelId: VENUE_CHANNEL_ID,
    membership: membership([WAITER_ID, CHEF_ID, BARTENDER_ID]),
  });
  const taskOf = async (messageId) => (await readRows('SELECT id, user_id, status FROM coin_work_tasks WHERE message_id = ?', [messageId]))[0];
  const refused = { code: 'VENUE_TASK_SYSTEM_MANAGED', message: '場館任務由系統管理，不能修改或刪除。' };
  const assertRefused = async (task) => {
    for (const canManage of [false, true]) {
      await assertRejectedWithoutWrites(snapshotter, () => editWorkSubmission(GUILD_ID, task.user_id, task.id, {
        description: '手動改寫', canManage,
      }), refused.code, refused.message);
      await assertRejectedWithoutWrites(snapshotter, () => deleteWorkSubmission(GUILD_ID, task.user_id, task.id, {
        reason: '手動刪除', canManage,
      }), refused.code, refused.message);
    }
  };

  // Pending venue tasks of the waiter, the chef and the bartender.
  for (const messageId of [`venue-order-${placed.order.id}`, ...placed.items.map((item) => `venue-item-${item.id}`)]) {
    const task = await taskOf(messageId);
    assert.equal(task.status, 'pending', messageId);
    await assertRefused(task);
  }

  clock.advance(10 * MINUTE_MS);
  await completeVenueOrderItem(GUILD_ID, CHEF_ID, placed.items[0].id, { steps: '熱鍋下油\n加入白飯拌炒\n盛盤' });
  await completeVenueOrderItem(GUILD_ID, BARTENDER_ID, placed.items[1].id, { steps: '加冰\n倒入氣泡水\n裝飾' });
  clock.advance(10 * MINUTE_MS);
  await serveVenueOrder(GUILD_ID, WAITER_ID, placed.order.id);

  // Completed venue tasks: deleting the served order's waiter task would leave the paid tip without
  // its task and stop the waiter's settlement.
  for (const messageId of [`venue-order-${placed.order.id}`, ...placed.items.map((item) => `venue-item-${item.id}`)]) {
    const task = await taskOf(messageId);
    assert.equal(task.status, 'completed', messageId);
    await assertRefused(task);
  }

  clock.at('2026-03-03T14:00:00.000Z');
  const settlement = await processDueJobs(null);
  assert.deepEqual(settlement.primaryCycles, { checked: 3, settled: 3, failed: 0, roleCleanupFailed: 0 });
  assert.deepEqual(
    (await readRows('SELECT user_id, paid_amount FROM coin_primary_cycle_payroll ORDER BY user_id'))
      .map((row) => [row.user_id, row.paid_amount]),
    [[WAITER_ID, 0], [CHEF_ID, 70], [BARTENDER_ID, 60]]
  );
  await assertTipMoneyConserved();
});

test('legacy venue tasks, including ones without a message id, cannot be edited or deleted either', async (t) => {
  startClock(t, '2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  const taskIds = await withCoinTransaction((api) => {
    const jobId = insertLegacyJob(api, {
      userId: LEGACY_CHEF_ID, jobName: '廚師', dailySalary: 70, workDays: 2,
      startAt: '2026-03-02T01:00:00.000Z', payAt: '2026-03-03T14:00:00.000Z',
    });
    return ['casino_venue_meal', 'casino_venue_drink', 'casino_venue_service'].map((taskType) => {
      insertLegacyPendingTask(api, {
        userId: LEGACY_CHEF_ID, jobId, jobName: '廚師', taskType, description: `舊場館任務 ${taskType}`,
        messageId: null, createdAt: '2026-03-02T01:00:00.000Z',
      });
      const taskId = lastInsertId(api);
      api.run("UPDATE coin_work_tasks SET status = 'completed', completed_at = ? WHERE id = ?", ['2026-03-02T02:00:00.000Z', taskId]);
      return taskId;
    });
  });
  for (const taskId of taskIds) {
    await assertRejectedWithoutWrites(snapshotter, () => editWorkSubmission(GUILD_ID, LEGACY_CHEF_ID, taskId, {
      description: '手動改寫',
    }), 'VENUE_TASK_SYSTEM_MANAGED', '場館任務由系統管理，不能修改或刪除。');
    await assertRejectedWithoutWrites(snapshotter, () => deleteWorkSubmission(GUILD_ID, LEGACY_CHEF_ID, taskId),
      'VENUE_TASK_SYSTEM_MANAGED', '場館任務由系統管理，不能修改或刪除。');
  }
});

test('venue task types cannot be made by hand and venue tasks cannot be reviewed; payroll still settles', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  await seedCustomerCoins(1000);
  await selectVenueJobs([[WAITER_ID, { waiter: '服務生' }], [CHEF_ID, { chef: true }], [BARTENDER_ID, { bartender: true }]], 1);
  clock.at('2026-03-02T14:00:00.000Z');
  assert.deepEqual((await processDueJobs(null)).activations, { checked: 3, activated: 3 });
  clock.at('2026-03-03T01:00:00.000Z');

  // Neither /work submit, /work report nor an administrator's task-add can make a venue task type.
  const reserved = { code: 'VENUE_TASK_TYPE_RESERVED', message: '場館任務類型由系統保留，不能自行建立。' };
  for (const taskType of ['casino_venue_service', 'casino_venue_meal', 'casino_venue_drink', ' CASINO_VENUE_Service ', 'casino_venue_other']) {
    await assertRejectedWithoutWrites(snapshotter, () => reportWork(GUILD_ID, WAITER_ID, {
      taskType, description: '假冒的場館任務', channelName: '服務生',
    }), reserved.code, reserved.message);
    await assertRejectedWithoutWrites(snapshotter, () => addPendingTask(GUILD_ID, WAITER_ID, {
      taskType, description: '假冒的場館待辦',
    }), reserved.code, reserved.message);
  }
  // Other task types are made as before.
  const report = await reportWork(GUILD_ID, WAITER_ID, { taskType: 'work_report', description: '整理桌面', channelName: '服務生' });
  assert.deepEqual([report.task.taskType, report.task.status], ['work_report', 'pending']);

  // The venue flow still makes its own tasks.
  const menu = await listVenueMenu(GUILD_ID);
  const placed = await createVenueOrder(GUILD_ID, CUSTOMER_ID, {
    mealId: menuItem(menu, '小吉炒飯').id,
    drinkId: menuItem(menu, '星光氣泡飲').id,
    chefId: CHEF_ID,
    bartenderId: BARTENDER_ID,
    waiterId: WAITER_ID,
    tipAmount: 60,
    channelId: VENUE_CHANNEL_ID,
    membership: membership([WAITER_ID, CHEF_ID, BARTENDER_ID]),
  });
  const messageIds = [`venue-order-${placed.order.id}`, ...placed.items.map((item) => `venue-item-${item.id}`)];
  const readVenueTasks = async () => Promise.all(messageIds.map(async (messageId) => (
    await readRows('SELECT id, task_type, status FROM coin_work_tasks WHERE message_id = ?', [messageId]))[0]));
  assert.deepEqual((await readVenueTasks()).map((task) => [task.task_type, task.status]), [
    ['casino_venue_service', 'pending'], ['casino_venue_meal', 'pending'], ['casino_venue_drink', 'pending'],
  ]);

  // No review action changes a venue task, pending or completed.
  const refusedReview = async () => {
    for (const task of await readVenueTasks()) {
      for (const action of ['approved', 'rejected']) {
        await assertRejectedWithoutWrites(snapshotter, () => reviewWorkSubmission(GUILD_ID, OPERATOR_ID, task.id, {
          action, reason: '手動審核',
        }), 'VENUE_TASK_SYSTEM_MANAGED', '場館任務由系統管理，不能審核。');
      }
    }
  };
  await refusedReview();
  clock.advance(10 * MINUTE_MS);
  await completeVenueOrderItem(GUILD_ID, CHEF_ID, placed.items[0].id, { steps: '熱鍋下油\n加入白飯拌炒\n盛盤' });
  await completeVenueOrderItem(GUILD_ID, BARTENDER_ID, placed.items[1].id, { steps: '加冰\n倒入氣泡水\n裝飾' });
  clock.advance(10 * MINUTE_MS);
  await serveVenueOrder(GUILD_ID, WAITER_ID, placed.order.id);
  assert.deepEqual((await readVenueTasks()).map((task) => task.status), ['completed', 'completed', 'completed']);
  await refusedReview();

  clock.at('2026-03-03T14:00:00.000Z');
  const settlement = await processDueJobs(null);
  assert.deepEqual(settlement.primaryCycles, { checked: 3, settled: 3, failed: 0, roleCleanupFailed: 0 });
  assert.deepEqual(
    (await readRows('SELECT user_id, paid_amount FROM coin_primary_cycle_payroll ORDER BY user_id'))
      .map((row) => [row.user_id, row.paid_amount]),
    [[WAITER_ID, 0], [CHEF_ID, 70], [BARTENDER_ID, 60]]
  );
  await assertTipMoneyConserved();
});

test('a frozen legacy venue task can only be finished through its order, not by task id', async (t) => {
  const clock = startClock(t, '2026-03-01T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  const { jobs, mealOrder } = await seedLegacyVenueState(clock);
  // An ordinary frozen legacy task of the same chef, for comparison.
  const ordinaryTaskId = await withCoinTransaction((api) => {
    insertLegacyPendingTask(api, {
      userId: LEGACY_CHEF_ID, jobId: jobs.chef, jobName: '廚師', taskType: 'admin_task', description: '整理廚房',
      messageId: null, createdAt: '2026-03-02T03:10:00.000Z',
    });
    return lastInsertId(api);
  });
  clock.at('2026-03-02T04:00:00.000Z');
  assert.deepEqual(await captureLegacyJobBatch(), { users: 3, snapshots: 3, nextUserId: null });
  const [mealTask] = await readRows('SELECT id, status FROM coin_work_tasks WHERE message_id = ?', [`venue-item-${mealOrder.itemId}`]);
  assert.equal(mealTask.status, 'pending');

  clock.at('2026-03-02T05:00:00.000Z');
  await assertRejectedWithoutWrites(snapshotter, () => reportWork(GUILD_ID, LEGACY_CHEF_ID, {
    taskId: mealTask.id, description: '手動完成場館待辦', channelName: '廚師',
  }), 'VENUE_TASK_REQUIRES_ORDER', '場館待辦須透過原場館訂單流程完成。');
  const ordinary = await reportWork(GUILD_ID, LEGACY_CHEF_ID, { taskId: ordinaryTaskId, description: '廚房整理好了', channelName: '廚師' });
  assert.equal(ordinary.legacyCompletion, true);
  assert.ok(ordinary.task.completedAt);
  // The order flow still finishes the venue task.
  const made = await completeVenueOrderItem(GUILD_ID, LEGACY_CHEF_ID, mealOrder.itemId, { steps: '煮滾高湯\n麵條煮至彈牙\n放入叉燒與配菜' });
  assert.equal(made.taskId, mealTask.id);
  assert.deepEqual(await readRows('SELECT status FROM coin_work_tasks WHERE id = ?', [mealTask.id]), [{ status: 'completed' }]);
});

test('reviewing a work task is refused once it was cancelled, expired or closed by the system', async (t) => {
  startClock(t, '2026-03-02T01:00:00.000Z');
  const snapshotter = await openSyntheticDatabase();
  const statuses = ['pending', 'approved', 'rejected', 'completed', 'no_work_available',
    'cancelled', 'canceled', 'expired', 'system_completed', 'deleted', 'paid'];
  const { taskIds, overdueTaskId } = await withCoinTransaction((api) => {
    const jobId = insertLegacyJob(api, {
      userId: CHEF_ID, jobName: '廚師', dailySalary: 70, workDays: 3,
      startAt: '2026-03-01T00:00:00.000Z', payAt: '2026-03-05T14:00:00.000Z',
    });
    insertLegacyPendingTask(api, {
      userId: CHEF_ID, jobId, jobName: '廚師', taskType: 'work_report', description: '逾期的合成任務',
      messageId: null, createdAt: '2026-03-01T00:00:00.000Z',
    });
    const overdue = lastInsertId(api);
    const ids = Object.fromEntries(statuses.map((status, index) => {
      insertLegacyPendingTask(api, {
        userId: CHEF_ID, jobId, jobName: '廚師', taskType: 'work_submit', description: `合成任務 ${status}`,
        messageId: null, createdAt: new Date(Date.parse('2026-03-02T01:00:00.000Z') + index * MINUTE_MS).toISOString(),
      });
      const taskId = lastInsertId(api);
      const completedAt = ['cancelled', 'canceled', 'pending'].includes(status) ? null : '2026-03-02T02:00:00.000Z';
      api.run('UPDATE coin_work_tasks SET status = ?, completed_at = ? WHERE id = ?', [status, completedAt, taskId]);
      return [status, taskId];
    }));
    return { taskIds: ids, overdueTaskId: overdue };
  });
  // A real overdue close-out with its penalty.
  const sweep = await processExpiredWorkTasks(null, { date: new Date('2026-03-02T01:00:00.000Z') });
  assert.deepEqual([sweep.completedBySystem, sweep.penaltiesCreated], [1, 1]);

  const review = (taskId, action) => reviewWorkSubmission(GUILD_ID, OPERATOR_ID, taskId, { action, reason: '合成審核' });
  const refusedMessage = '這筆工作已取消、逾期或由小吉接手完成，不能審核。';
  const refusals = [
    [overdueTaskId, 'SUBMISSION_NOT_REVIEWABLE'],
    [taskIds.cancelled, 'SUBMISSION_NOT_REVIEWABLE'],
    [taskIds.canceled, 'SUBMISSION_NOT_REVIEWABLE'],
    [taskIds.expired, 'SUBMISSION_NOT_REVIEWABLE'],
    [taskIds.system_completed, 'SUBMISSION_NOT_REVIEWABLE'],
    [taskIds.deleted, 'SUBMISSION_DELETED'],
    [taskIds.paid, 'SUBMISSION_ALREADY_PAID'],
  ];
  for (const [taskId, code] of refusals) {
    for (const action of ['approved', 'rejected']) {
      await assertRejectedWithoutWrites(snapshotter, () => review(taskId, action), code,
        code === 'SUBMISSION_NOT_REVIEWABLE' ? refusedMessage : null);
    }
  }
  assert.deepEqual(await readRows('SELECT status, review_reason FROM coin_work_tasks WHERE id = ?', [overdueTaskId]),
    [{ status: 'system_completed', review_reason: '逾期 24 小時未完成，由小吉系統接手完成。' }]);
  // Submissions are still reviewed as before.
  for (const [status, action] of [['pending', 'approved'], ['approved', 'rejected'], ['rejected', 'approved'],
    ['completed', 'approved'], ['no_work_available', 'rejected']]) {
    const reviewed = await review(taskIds[status], action);
    assert.equal(reviewed.status, action, status);
  }
});

test('the legacy branch of processExpiredWorkTasks stamps the sweep time it is given, not the wall clock', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  await openSyntheticDatabase();
  await withCoinTransaction((api) => {
    const jobId = insertLegacyJob(api, {
      userId: CHEF_ID, jobName: '廚師', dailySalary: 70, workDays: 3,
      startAt: '2026-03-02T01:00:00.000Z', payAt: '2026-03-05T14:00:00.000Z',
    });
    insertLegacyPendingTask(api, {
      userId: CHEF_ID, jobId, jobName: '廚師', taskType: 'work_report', description: '整理廚房',
      messageId: null, createdAt: '2026-03-02T01:00:00.000Z',
    });
  });

  // The wall clock is days after the sweep time the caller passes.
  clock.at('2026-03-06T09:00:00.000Z');
  const sweptAt = '2026-03-03T02:00:00.000Z';
  const result = await processExpiredWorkTasks(null, { date: new Date(sweptAt) });
  assert.deepEqual([result.checked, result.completedBySystem, result.penaltiesCreated], [1, 1, 1]);
  assert.deepEqual(await readRows('SELECT status, completed_at, updated_at FROM coin_work_tasks'),
    [{ status: 'system_completed', completed_at: sweptAt, updated_at: sweptAt }]);
  assert.deepEqual(await readRows('SELECT penalty_date, appeal_deadline_at, created_at, updated_at FROM coin_work_penalties'),
    [{ penalty_date: '2026-03-02', appeal_deadline_at: '2026-03-17T02:00:00.000Z', created_at: sweptAt, updated_at: sweptAt }]);
  assert.deepEqual(await readRows("SELECT action, created_at FROM coin_admin_logs WHERE action LIKE 'work:%' ORDER BY id"), [
    { action: 'work:penalty-created', created_at: sweptAt },
    { action: 'work:system-completed', created_at: sweptAt },
  ]);
});
