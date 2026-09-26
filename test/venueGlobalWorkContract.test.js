const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-venue-v22-'));
process.env.COIN_DB_PATH = path.join(temporaryDirectory, 'coins.sqlite');

const { initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinDatabase, withCoinTransaction } = require('../src/services/coinDatabase');
const { creditChipsWithApi } = require('../src/services/chipService');
const { calculateGlobalPayrollWithApi } = require('../src/systems/work/payroll');
const { captureLegacyJobBatch, processDuePrimaryCycles } = require('../src/services/workService');
const { verifyVenueMembers } = require('../src/platform/venueMembership');
const { createVenueOrder, completeVenueOrderItem, reassignVenueOrderItem, serveVenueOrder } = require('../src/services/venueService');

const GUILD = '2001';
const ORDER_AT = new Date('2026-09-25T17:00:00.000Z');
const START_AT = '2026-09-25T00:00:00.000Z';
const END_AT = '2026-09-25T18:00:00.000Z';

function member(id) {
  return { id, guild: { id: GUILD }, user: { bot: false } };
}

function memberGuild(ids, memberCount = ids.length) {
  const roster = new Map(ids.map((id) => [id, member(id)]));
  return { id: GUILD, memberCount, members: { async fetch(id) { return id ? roster.get(id) : roster; } } };
}

function insertActiveCycle(api, { userId, jobName, sourceGuildId, salary }) {
  const cycleId = `cycle-${userId}`;
  api.run(
    "INSERT INTO coin_primary_jobs_global (user_id,job_name,work_days,source_guild_id,next_cycle_id,requested_at,not_before_at,effective_from,effective_until,state,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'active',?)",
    [userId, jobName, 1, sourceGuildId, cycleId, START_AT, START_AT, START_AT, END_AT, START_AT]
  );
  api.run(
    "INSERT INTO coin_primary_job_cycles (cycle_id,user_id,job_name,work_days,source_guild_id,starts_at,ends_at,salary_rule_version,salary_snapshot_json,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,'active',?,?)",
    [cycleId, userId, jobName, 1, sourceGuildId, START_AT, END_AT, 'primary-v1',
      JSON.stringify({ version: 'primary-v1', dailySalary: salary, basicRatio: 0.75, translatorBonus: 0 }), START_AT, START_AT]
  );
  return cycleId;
}

test('v22 venue binds verified cross-guild staff to original cycles and settles once', async () => {
  try {
    await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
    await withCoinTransaction((api) => {
      insertActiveCycle(api, { userId: '1001', jobName: '服務生', sourceGuildId: '2999', salary: 0 });
      insertActiveCycle(api, { userId: '1002', jobName: '廚師', sourceGuildId: '2888', salary: 70 });
      insertActiveCycle(api, { userId: '1003', jobName: '廚師', sourceGuildId: '2777', salary: 70 });
      creditChipsWithApi(api, GUILD, '3001', 500);
    });
    const verified = await verifyVenueMembers(memberGuild(['1001', '1002', '1003', '3001']), {
      userIds: ['1001', '1002'], completeRoster: true,
    });
    await assert.rejects(
      createVenueOrder(GUILD, '3001', { mealId: 1, waiterId: '1001', chefId: '1002', tipAmount: 50, date: ORDER_AT }),
      { code: 'VENUE_MEMBERSHIP_UNVERIFIED' }
    );
    const created = await createVenueOrder(GUILD, '3001', {
      mealId: 1, waiterId: '1001', chefId: '1002', tipAmount: 50, date: ORDER_AT, membership: verified,
    });
    assert.equal(created.order.waiterGlobalCycleId, 'cycle-1001');
    assert.equal(created.order.waiterJobId, null);
    assert.equal(created.items[0].globalCycleId, 'cycle-1002');
    assert.equal(created.items[0].makerJobId, null);
    const originalTasks = await withCoinDatabase((api) => api.all(
      'SELECT user_id,job_id,global_cycle_id,status,message_id FROM coin_work_tasks WHERE guild_id = ? ORDER BY id', [GUILD]
    ));
    assert.deepEqual(originalTasks.map((row) => row.global_cycle_id), ['cycle-1001', 'cycle-1002']);
    assert.equal(originalTasks.every((row) => row.job_id === null && row.status === 'pending'), true);

    const moved = await reassignVenueOrderItem(GUILD, created.items[0].id, '1003', {
      operatorId: '4001', date: new Date('2026-09-25T17:01:00.000Z'),
      membership: await verifyVenueMembers(memberGuild(['1003']), { userIds: ['1003'] }),
    });
    assert.equal(moved.globalCycleId, 'cycle-1003');
    const makerTasks = await withCoinDatabase((api) => api.all(
      "SELECT user_id,global_cycle_id,status FROM coin_work_tasks WHERE message_id = ? ORDER BY id",
      [`venue-item-${moved.id}`]
    ));
    assert.deepEqual(makerTasks.map((row) => [row.user_id, row.global_cycle_id, row.status]), [
      ['1002', 'cycle-1002', 'canceled'], ['1003', 'cycle-1003', 'pending'],
    ]);

    await completeVenueOrderItem(GUILD, '1003', moved.id, {
      steps: '熱鍋下油；加入配料；盛盤', date: new Date('2026-09-25T17:05:00.000Z'),
    });
    const served = await serveVenueOrder(GUILD, '1001', created.order.id, {
      date: new Date('2026-09-25T17:10:00.000Z'),
    });
    assert.equal(served.order.tipStatus, 'paid');
    assert.equal(served.tipResult.taskId, 1);
    const beforeSettlement = await withCoinDatabase((api) => ({
      waiter: calculateGlobalPayrollWithApi(api, api.get("SELECT * FROM coin_primary_job_cycles WHERE cycle_id = 'cycle-1001'")),
      maker: calculateGlobalPayrollWithApi(api, api.get("SELECT * FROM coin_primary_job_cycles WHERE cycle_id = 'cycle-1003'")),
    }));
    assert.equal(beforeSettlement.waiter.waiterOrderIds.includes(created.order.id), true);
    assert.equal(beforeSettlement.maker.paidAmount, 70);
    assert.equal((await processDuePrimaryCycles()).failed, 0);
    const settled = await withCoinDatabase((api) => ({
      payrolls: api.all('SELECT cycle_id,paid_amount FROM coin_primary_cycle_payroll ORDER BY cycle_id'),
      grants: Number(api.get("SELECT COUNT(*) AS count FROM reward_grants_v2 WHERE kind = 'work-settlement'").count),
      tip: api.get("SELECT balance FROM chip_accounts_global WHERE user_id = '1001'")?.balance,
    }));
    assert.equal(settled.payrolls.length, 3);
    assert.equal(settled.grants, 1);
    assert.equal(settled.tip, 50);
    assert.equal((await processDuePrimaryCycles()).settled, 0);
  } finally {
    resetCoinDatabaseForTests();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});

test('v22 completes only snapshotted pre-cutover venue obligations', async () => {
  fs.mkdirSync(temporaryDirectory, { recursive: true });
  try {
    await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
    await withCoinTransaction((api) => {
      creditChipsWithApi(api, GUILD, '3001', 50);
      for (const [userId, jobName, salary] of [['1001', '服務生', 0], ['1002', '廚師', 70]]) {
        api.run(
          "INSERT INTO coin_jobs (guild_id,user_id,job_name,daily_salary,work_days,total_salary,status,is_paid,start_at,pay_at,created_at,updated_at) VALUES (?,?,?,?,?,?,'active',0,?,?,?,?)",
          [GUILD, userId, jobName, salary, 1, salary, START_AT, END_AT, START_AT, START_AT]
        );
      }
      api.run(
        "INSERT INTO casino_venue_orders (id,guild_id,customer_id,waiter_user_id,waiter_job_id,waiter_job_name,waiter_assigned_at,waiter_due_at,tip_amount,tip_status,status,created_at,updated_at) VALUES (1,?,?,?,?,?,?,?,?,?,'pending',?,?)",
        [GUILD, '3001', '1001', 1, '服務生', START_AT, END_AT, 50, 'escrowed', START_AT, START_AT]
      );
      api.run(
          "INSERT INTO casino_venue_order_items (id,guild_id,order_id,item_type,item_name,standard_steps,maker_user_id,maker_job_id,maker_job_name,maker_is_npc,status,bonus_amount,created_at,assigned_at,updated_at) VALUES (1,?,1,'meal','舊餐點','加熱;盛盤','1002',2,'廚師',0,'pending',0,?,?,?)",
        [GUILD, START_AT, START_AT, START_AT]
      );
      for (const [userId, jobId, jobName, taskType, messageId] of [
        ['1001', 1, '服務生', 'casino_venue_service', 'venue-order-1'],
        ['1002', 2, '廚師', 'casino_venue_meal', 'venue-item-1'],
      ]) {
        api.run(
          "INSERT INTO coin_work_tasks (guild_id,user_id,job_id,job_name,task_type,status,description,attachment_urls,expected_channel_name,message_id,external_server_count,external_server_ids,created_at,due_at,updated_at) VALUES (?,?,?,?,?,'pending','舊場館待辦','[]',?,?,0,'[]',?,?,?)",
          [GUILD, userId, jobId, jobName, taskType, jobName, messageId, START_AT, END_AT, START_AT]
        );
      }
    });
    await assert.rejects(
      completeVenueOrderItem(GUILD, '1002', 1, { steps: '加熱;盛盤', date: ORDER_AT }),
      { code: 'VENUE_LEGACY_SNAPSHOT_REQUIRED' }
    );
    const captured = await captureLegacyJobBatch({ limit: 10 });
    assert.equal(captured.snapshots, 2);
    assert.equal(captured.nextUserId, null);
    const completed = await completeVenueOrderItem(GUILD, '1002', 1, { steps: '加熱;盛盤', date: ORDER_AT });
    const served = await serveVenueOrder(GUILD, '1001', 1, { date: new Date('2026-09-25T17:10:00.000Z') });
    assert.equal(completed.item.makerJobId, 2);
    assert.equal(completed.item.globalCycleId, null);
    assert.equal(served.order.waiterJobId, 1);
    assert.equal(served.order.waiterGlobalCycleId, null);
    assert.equal(served.order.tipStatus, 'paid');
    const tasks = await withCoinDatabase((api) => api.all('SELECT job_id,global_cycle_id,status FROM coin_work_tasks ORDER BY id'));
    assert.deepEqual(tasks.map((task) => task.status), ['completed', 'completed']);
    assert.equal(tasks.every((task) => task.job_id != null && task.global_cycle_id === null), true);
  } finally {
    resetCoinDatabaseForTests();
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
});
