const test = require('node:test');
const assert = require('node:assert/strict');
const {
  calculateGlobalPayrollWithApi,
  calculatePrimaryPenaltyRefundAmount,
  completeWorkTaskWithApi,
  reviewPrimaryPenaltyAppealWithApi,
  hasOpenPrimaryWaiterOrderWithApi,
  nextTaiwanPayBoundary,
} = require('../src/systems/economy/workSystem');

function cycle(jobName = '老師') {
  return {
    cycle_id: 'cycle-a', user_id: 'user-a', job_name: jobName, work_days: 2,
    salary_snapshot_json: JSON.stringify({
      version: 'primary-v1', dailySalary: ['服務生', '制服服務生'].includes(jobName) ? 0 : 100,
      basicRatio: 0.75, translatorBonus: 200,
    }),
  };
}

function payApi({ tasks = [], venueItems = [], waiterOrders = [], penalties = [],
  unlinkedVenue = false, unlinkedWaiter = false, openWaiter = false } = {}) {
  return {
    get(sql, params) {
      if (sql.includes('FROM casino_venue_orders')) {
        if (sql.includes('waiter_global_cycle_id = ?')) {
          assert.deepEqual(params, ['cycle-a', 'user-a']);
          return openWaiter ? { found: 1 } : null;
        }
        assert.match(sql, /waiter_global_cycle_id IS NULL/);
        assert.deepEqual(params, ['user-a']);
        return unlinkedWaiter ? { found: 1 } : null;
      }
      assert.match(sql, /global_cycle_id IS NULL/);
      assert.equal(params[0], 'user-a');
      return unlinkedVenue ? { found: 1 } : null;
    },
    all(sql, params) {
      assert.equal(params[0], 'cycle-a');
      if (sql.includes('coin_work_tasks')) return tasks;
      if (sql.includes('casino_venue_orders')) return waiterOrders;
      if (sql.includes('casino_venue_order_items')) return venueItems;
      if (sql.includes('coin_primary_cycle_penalties')) return penalties;
      throw new Error('Unexpected payroll query');
    },
  };
}

test('next primary period starts after Taiwan 22:00 boundary', () => {
  assert.equal(nextTaiwanPayBoundary(new Date('2026-09-25T13:59:00Z')), '2026-09-25T14:00:00.000Z');
  assert.equal(nextTaiwanPayBoundary(new Date('2026-09-25T14:00:00Z')), '2026-09-26T14:00:00.000Z');
});

test('new cycle pays zero without effective work or no-work report', () => {
  const result = calculateGlobalPayrollWithApi(payApi(), cycle());
  assert.equal(result.baseSalary, 200);
  assert.equal(result.paidAmount, 0);
  assert.equal(result.payRatio, 0);
});

test('new cycle pays 75 percent only after a no-work report', () => {
  const result = calculateGlobalPayrollWithApi(payApi({
    tasks: [{ id: 1, status: 'no_work_available', created_at: '2026-09-25T00:00:00Z' }],
  }), cycle());
  assert.equal(result.paidAmount, 150);
  assert.equal(result.payRatio, 0.75);
});

test('new cycle applies fixed translator bonus and debt-compatible gross reward', () => {
  const result = calculateGlobalPayrollWithApi(payApi({
    tasks: [
      { id: 1, status: 'approved', external_server_count: 1, external_server_ids: '["external-a"]', created_at: '2026-09-25T00:00:00Z' },
      { id: 2, status: 'approved', external_server_count: 1, external_server_ids: '["external-a"]', created_at: '2026-09-25T01:00:00Z' },
    ],
    penalties: [{ id: 3, amount: 50 }],
  }), cycle('翻譯官'));
  assert.equal(result.externalServerCount, 1);
  assert.equal(result.grossAmount, 400);
  assert.equal(result.paidAmount, 350);
  assert.deepEqual(result.penaltyIds, [3]);
});

test('new venue bonus is counted only through the explicit cycle query', () => {
  const result = calculateGlobalPayrollWithApi(payApi({
    tasks: [{ id: 1, status: 'approved', created_at: '2026-09-25T00:00:00Z' }],
    venueItems: [{ id: 4, bonus_amount: 70 }],
  }), cycle('廚師'));
  assert.equal(result.venueBonus, 70);
  assert.equal(result.paidAmount, 270);
  assert.deepEqual(result.venueItemIds, [4]);
});

test('completed venue order alone counts as effective work', () => {
  const result = calculateGlobalPayrollWithApi(payApi({
    venueItems: [{ id: 4, bonus_amount: 70 }],
  }), cycle('廚師'));
  assert.equal(result.payRatio, 1);
  assert.equal(result.paidAmount, 270);
});

test('invalid translator task count stops cycle payroll', () => {
  assert.throws(() => calculateGlobalPayrollWithApi(payApi({
    tasks: [{ id: 1, status: 'approved', external_server_count: 2,
      external_server_ids: '["external-a"]', created_at: '2026-09-25T00:00:00Z' }],
  }), cycle('翻譯官')), /資料無法核對/);
});

test('unlinked venue order stops cycle payroll', () => {
  assert.throws(
    () => calculateGlobalPayrollWithApi(payApi({ unlinkedVenue: true }), cycle('廚師')),
    /週期歸屬/
  );
});

function waiterOrder(overrides = {}) {
  return {
    id: 10, guild_id: 'guild-a', waiter_user_id: 'user-a', waiter_job_id: null,
    waiter_job_name: '服務生', tip_amount: 80, tip_status: 'paid', ...overrides,
  };
}

function waiterTask(overrides = {}) {
  return {
    id: 12, guild_id: 'guild-a', user_id: 'user-a', job_id: null, job_name: '服務生',
    task_type: 'casino_venue_service',
    message_id: 'venue-order-10', status: 'completed',
    completed_at: '2026-09-25T02:00:00Z', ...overrides,
  };
}

test('linked waiter parent order counts as work without adding chip tip to coin salary', () => {
  const result = calculateGlobalPayrollWithApi(payApi({
    tasks: [waiterTask()], waiterOrders: [waiterOrder()],
    venueItems: [{ id: 99, bonus_amount: 70 }],
  }), cycle('服務生'));
  assert.deepEqual(result.waiterOrderIds, [10]);
  assert.deepEqual(result.venueItemIds, []);
  assert.equal(result.completedTasks, 1);
  assert.equal(result.payRatio, 1);
  assert.equal(result.venueBonus, 0);
  assert.equal(result.grossAmount, 0);
  assert.equal(result.paidAmount, 0);
});

test('waiter payroll rejects an unlinked parent instead of inferring a cycle', () => {
  assert.throws(
    () => calculateGlobalPayrollWithApi(payApi({ unlinkedWaiter: true }), cycle('服務生')),
    /週期歸屬/
  );
});

test('waiter payroll rejects parent and task ownership mismatches', () => {
  assert.throws(() => calculateGlobalPayrollWithApi(payApi({
    tasks: [waiterTask()], waiterOrders: [waiterOrder({ waiter_user_id: 'user-b' })],
  }), cycle('服務生')), /主職或小費結算狀態不一致/);
  assert.throws(() => calculateGlobalPayrollWithApi(payApi({
    tasks: [waiterTask({ message_id: 'venue-order-11' })], waiterOrders: [waiterOrder()],
  }), cycle('服務生')), /父訂單週期不一致/);
  assert.throws(() => calculateGlobalPayrollWithApi(payApi({
    tasks: [waiterTask({ job_id: 5 })], waiterOrders: [waiterOrder()],
  }), cycle('服務生')), /父訂單週期不一致/);
  assert.throws(() => calculateGlobalPayrollWithApi(payApi({
    waiterOrders: [waiterOrder()],
  }), cycle('服務生')), /缺少本週期完成任務/);
});

test('unsettled linked waiter parent defers the cycle while other roles are unaffected', () => {
  assert.equal(hasOpenPrimaryWaiterOrderWithApi(payApi({ openWaiter: true }), cycle('服務生')), true);
  assert.equal(hasOpenPrimaryWaiterOrderWithApi(payApi({ openWaiter: false }), cycle('制服服務生')), false);
  assert.equal(hasOpenPrimaryWaiterOrderWithApi(payApi({ openWaiter: true }), cycle('廚師')), false);
});

test('appeal refunds only salary actually deducted from each penalty', () => {
  const payroll = { gross_amount: 100, paid_amount: 0 };
  assert.equal(calculatePrimaryPenaltyRefundAmount(payroll, { amount: 80 }, 0), 80);
  assert.equal(calculatePrimaryPenaltyRefundAmount(payroll, { amount: 80 }, 80), 20);
  assert.equal(calculatePrimaryPenaltyRefundAmount(payroll, { amount: 80 }, 160), 0);
  assert.equal(calculatePrimaryPenaltyRefundAmount({ gross_amount: 0, paid_amount: 0 }, { amount: 80 }, 0), 0);
  assert.throws(() => calculatePrimaryPenaltyRefundAmount({ gross_amount: 20, paid_amount: 30 }, { amount: 80 }, 0));
});

function assignedTaskApi() {
  const row = {
    id: 7, guild_id: 'guild-a', user_id: 'user-a', job_id: null,
    global_cycle_id: 'cycle-a', job_name: '老師', task_type: 'admin_task',
    status: 'pending', completed_at: null, is_paid: 0,
    description: '指定任務', expected_channel_name: '老師',
    expected_channel_id: null, attachment_urls: null, message_id: null,
    created_at: '2026-09-25T00:00:00.000Z',
  };
  let changes = 0;
  return {
    row,
    get(sql, params) {
      if (sql.includes('SELECT changes()')) return { count: changes };
      if (sql.includes('FROM coin_work_tasks')) {
        if (sql.includes('WHERE id = ? AND guild_id = ? AND user_id = ?')) {
          if (params[0] !== row.id || params[1] !== row.guild_id || params[2] !== row.user_id) return null;
          return { ...row };
        }
        return params[0] === row.id ? { ...row } : null;
      }
      if (sql.includes('FROM coin_primary_jobs_global')) {
        return { user_id: 'user-a', state: 'active', next_cycle_id: 'cycle-a' };
      }
      if (sql.includes('FROM coin_primary_job_cycles')) {
        return { cycle_id: 'cycle-a', user_id: 'user-a', job_name: '老師',
          work_days: 2, source_guild_id: 'guild-a', status: 'active',
          starts_at: '2026-09-24T14:00:00.000Z', ends_at: '2026-09-27T14:00:00.000Z' };
      }
      throw new Error('Unexpected work task query');
    },
    run(sql, params) {
      assert.match(sql, /global_cycle_id = \? AND job_id IS NULL AND status = 'pending'/);
      changes = row.status === 'pending' && !row.completed_at ? 1 : 0;
      if (changes) {
        row.description = params[0];
        row.attachment_urls = params[1];
        row.expected_channel_id = params[2];
        row.message_id = params[3];
        row.external_server_count = params[4];
        row.external_server_ids = params[5];
        row.completed_at = params[6];
      }
    },
  };
}

test('assigned primary task completes once in its source guild and channel', () => {
  const api = assignedTaskApi();
  const input = {
    guildId: 'guild-a', userId: 'user-a', taskId: 7,
    description: '完成指定任務', channelId: 'channel-a', channelName: '老師',
    timestamp: '2026-09-25T10:00:00.000Z',
  };
  const result = completeWorkTaskWithApi(api, input);
  assert.equal(result.scope, 'primary');
  assert.equal(result.task.completed_at, input.timestamp);
  assert.equal(result.task.description, input.description);
  assert.throws(() => completeWorkTaskWithApi(api, input), /已完成/);
});

test('assigned primary task rejects other guilds, users, channels and expiry', () => {
  const api = assignedTaskApi();
  const input = {
    guildId: 'guild-a', userId: 'user-a', taskId: 7,
    description: '完成', channelName: '老師', timestamp: '2026-09-25T10:00:00.000Z',
  };
  assert.throws(() => completeWorkTaskWithApi(api, { ...input, guildId: 'guild-b' }), /找不到/);
  assert.throws(() => completeWorkTaskWithApi(api, { ...input, userId: 'user-b' }), /找不到/);
  assert.throws(() => completeWorkTaskWithApi(api, { ...input, channelName: '其他' }), /指定的工作回報頻道/);
  assert.throws(() => completeWorkTaskWithApi(api, {
    ...input, timestamp: '2026-09-26T00:00:00.000Z',
  }), /24 小時/);
  assert.equal(api.row.completed_at, null);
});

test('approved appeal has one refund and a repeat review cannot credit again', () => {
  const appeal = { id: 3, penalty_id: 7, user_id: 'user-a', status: 'pending' };
  const penalty = { id: 7, cycle_id: 'cycle-a', user_id: 'user-a',
    status: 'active', amount: 40, applied_at: '2026-09-25T00:00:00.000Z', refunded_at: null };
  const wallet = { balance: 10, debt: 100 };
  let changes = 0;
  const api = {
    get(sql) {
      if (sql.includes('SELECT changes()')) return { count: changes };
      if (sql.includes('coin_primary_cycle_penalty_appeals')) return { ...appeal };
      if (sql.includes('coin_primary_cycle_penalties') && sql.includes('SUM')) return { amount: 0 };
      if (sql.includes('coin_primary_cycle_penalties')) return { ...penalty };
      if (sql.includes('coin_primary_job_cycles')) return { cycle_id: 'cycle-a', source_guild_id: 'guild-a' };
      if (sql.includes('coin_primary_cycle_payroll')) return { gross_amount: 100, paid_amount: 60 };
      throw new Error('Unexpected appeal query');
    },
    run(sql, params) {
      if (sql.includes('UPDATE coin_primary_cycle_penalty_appeals')) {
        changes = appeal.status === 'pending' ? 1 : 0;
        if (changes) appeal.status = params[0];
      } else if (sql.includes("SET status = 'canceled'")) {
        changes = penalty.status === 'active' ? 1 : 0;
        if (changes) penalty.status = 'canceled';
      } else if (sql.includes('SET refunded_at')) {
        penalty.refunded_at = params[0];
        changes = 1;
      } else throw new Error('Unexpected appeal update');
    },
  };
  const input = {
    reviewerId: 'owner-a', appealId: 3, action: 'approved',
    timestamp: '2026-09-25T10:00:00.000Z',
    refundWithApi(_api, refund) {
      wallet.balance += refund.amount;
      return { amount: refund.amount };
    },
  };
  const result = reviewPrimaryPenaltyAppealWithApi(api, input);
  assert.equal(result.refund.amount, 40);
  assert.deepEqual(wallet, { balance: 50, debt: 100 });
  assert.throws(() => reviewPrimaryPenaltyAppealWithApi(api, input), /找不到待審/);
  assert.deepEqual(wallet, { balance: 50, debt: 100 });
});
