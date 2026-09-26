const test = require('node:test');
const assert = require('node:assert/strict');

const coinDatabase = require('../src/services/coinDatabase');
const originalRead = coinDatabase.withCoinDatabase;
let api;
coinDatabase.withCoinDatabase = async (read) => read(api);
const { getActiveJobs, getAllWorkStatuses, getWorkStatus } = require('../src/services/workService');
coinDatabase.withCoinDatabase = originalRead;

const legacy = {
  id: 4, guild_id: 'guild-b', user_id: 'user-old', job_name: '老師',
  daily_salary: 100, work_days: 2, total_salary: 200, status: 'active',
  is_paid: 0, start_at: '2026-09-24T14:00:00.000Z',
  pay_at: '2026-09-26T14:00:00.000Z', updated_at: '2026-09-25T00:00:00.000Z',
};
const primary = [
  { user_id: 'user-a', source_guild_id: 'guild-a', job_name: '翻譯官',
    work_days: 2, next_cycle_id: 'cycle-a', state: 'active',
    requested_at: '2026-09-24T00:00:00.000Z',
    not_before_at: '2026-09-24T14:00:00.000Z',
    effective_from: '2026-09-24T14:00:00.000Z',
    updated_at: '2026-09-25T02:00:00.000Z' },
  { user_id: 'user-b', source_guild_id: 'guild-c', job_name: '老師',
    work_days: 1, next_cycle_id: 'cycle-b', state: 'pending_legacy',
    requested_at: '2026-09-25T00:00:00.000Z',
    not_before_at: '2026-09-26T14:00:00.000Z',
    updated_at: '2026-09-25T01:00:00.000Z' },
];
const cycle = {
  cycle_id: 'cycle-a', user_id: 'user-a', status: 'active',
  ends_at: '2026-09-26T14:00:00.000Z',
};

function syntheticReadApi() {
  return {
    run() { throw new Error('Work status must be read only'); },
    get(sql, params) {
      if (sql.includes('coin_primary_jobs_global')) return primary.find((row) => row.user_id === params[0]) || null;
      if (sql.includes('coin_primary_job_cycles')) return params[0] === cycle.cycle_id ? { ...cycle } : null;
      if (sql.includes('coin_primary_cycle_payroll')) return null;
      if (sql.includes('coin_payroll_history')) return null;
      throw new Error('Unexpected work status get: ' + sql);
    },
    all(sql, params = []) {
      if (sql.includes('FROM coin_primary_jobs_global p')) {
        return primary.map((row) => ({ ...row,
          cycle_cycle_id: row.user_id === 'user-a' ? cycle.cycle_id : null,
          cycle_user_id: row.user_id === 'user-a' ? cycle.user_id : null,
          cycle_status: row.user_id === 'user-a' ? cycle.status : null,
          cycle_ends_at: row.user_id === 'user-a' ? cycle.ends_at : null,
        }));
      }
      if (sql.includes('FROM coin_jobs')) {
        return params[0] === 'guild-b' && (!sql.includes('user_id = ?') || params[1] === legacy.user_id)
          ? [{ ...legacy }] : [];
      }
      if (sql.includes('FROM coin_work_tasks')) return [];
      throw new Error('Unexpected work status all: ' + sql);
    },
  };
}

test('global active job is one read only user view across guilds with source and trigger identities', async () => {
  api = syntheticReadApi();
  const jobs = await getActiveJobs('guild-b', 'user-a');
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].id, 'primary:cycle-a');
  assert.equal(jobs[0].sourceGuildId, 'guild-a');
  assert.equal(jobs[0].triggerGuildId, 'guild-b');
  assert.equal(jobs[0].roleSyncEligible, false);
  const status = await getWorkStatus('guild-b', 'user-a');
  assert.equal(status.activeJob.id, 'primary:cycle-a');
  assert.equal(status.activeJobs.length, 0);
  assert.equal(status.primaryStatusView.settledAmount, null);
});

test('guild roster scope includes other source guilds once and keeps pending legacy distinct', async () => {
  api = syntheticReadApi();
  await assert.rejects(() => getAllWorkStatuses('guild-b'), /須先核對/);
  const rows = await getAllWorkStatuses('guild-b', {
    limit: 10, visibleUserIds: ['user-a', 'user-b'],
  });
  assert.deepEqual(rows.filter((row) => row.scope === 'primary').map((row) => row.id).sort(),
    ['primary:cycle-a', 'primary:cycle-b']);
  assert.equal(rows.find((row) => row.userId === 'user-b').status, 'pending_legacy');
  assert.equal(rows.filter((row) => row.scope === 'legacy').length, 1);
  assert.equal(rows.find((row) => row.scope === 'legacy').sourceGuildId, 'guild-b');
  const hidden = await getAllWorkStatuses('guild-b', { visibleUserIds: ['user-b'] });
  assert.equal(hidden.some((row) => row.userId === 'user-a'), false);
});
