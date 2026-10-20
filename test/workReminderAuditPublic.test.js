'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { StatementSync } = require('node:sqlite');

const { makeRealTempDir } = require('./support/realTempDir');
const root = makeRealTempDir('xiaoji-work-reminder-audit-');
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');

const {
  initializeNewCoinDatabase,
  normalizeWorkReminderTimestamp,
  readActiveWorkReminderSource,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const logger = require('../src/utils/logger');
const workCommand = require('../src/commands/work');
const { createPublicEffectAuthority } = require('../src/platform/publicEffectGrant');
const { configurePublicEffectAdapter } = require('../src/platform/publicEffectAdapter');
const { STATEMENT_SQL } = require('../src/systems/safety/ledgerStore');
const {
  PREPARE_RETRY_AFTER_MS,
  normalizeBinding,
} = require('../src/systems/safety/sideEffectLedger');
const {
  PublicSideEffectRuntime,
  QUEUE_LIMIT,
  buildPublicOperation,
} = require('../src/systems/safety/publicSideEffectRuntime');
const { initializePublicLedgers, openPublicLedgers } = require('./fixtures/publicLedgers');
const { createSyntheticRest } = require('./fixtures/syntheticRest');
const {
  createWorkReminderRetryTracker,
  processWorkReminders,
  resetWorkReminderRetryStateForTests,
} = require('../src/systems/work/workService');
const {
  buildDmChannelBinding,
  buildWorkReminderBody,
  normalizeReminderSource,
  proveWorkReminderPlanWithApi,
  proveWorkReminderSourceWithApi,
  reminderOperationId,
  validateCreatedDm,
} = require('../src/systems/safety/workReminderSource');
const { AuditStatus } = require('../src/services/auditService');

const BOT_ID = '10000000000000001';
const GUILD_ID = '10000000000000002';
const USER_ID = '10000000000000003';
const DM_CHANNEL_ID = '10000000000000004';
const MESSAGE_ID = '10000000000000005';
const HOUR_MS = 60 * 60 * 1000;
// processWorkReminders reads the wall clock, so every synthetic time is anchored to
// the test start instead of a fixed calendar date that would eventually expire.
const NOW_MS = Date.now();
const CUTOVER = Date.parse('2025-01-01T00:00:00.000Z');
const CREATED_AT = new Date(NOW_MS - 48 * HOUR_MS).toISOString();
const DUE_AT = new Date(NOW_MS - 36 * HOUR_MS).toISOString();
const FUTURE_AT = new Date(NOW_MS + 29 * 24 * HOUR_MS).toISOString();

function idFor(value) {
  return String(10_000_000_000_000_000n + BigInt(value));
}

function writeAdmission(audit = {}) {
  fs.writeFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, `${JSON.stringify(audit, null, 2)}\n`);
  fs.writeFileSync(process.env.XIAOJI_INVITER_WHITELIST_PATH, '[]\n');
}

function initializeLedgers(name, { cutovers = {} } = {}) {
  return initializePublicLedgers({ root, name, botId: BOT_ID, cutover: CUTOVER, cutovers });
}

// A runtime given the ledgers the way the bootstrap delivers them, and armed as at ready.
function createRuntime(name, rest, { ledgers = initializeLedgers(name), clockStart = NOW_MS, logger,
  faultInjector = null } = {}) {
  const authority = createPublicEffectAuthority();
  // The ledger clock advances by one on every reading; tests may also move it forward.
  const clock = { value: clockStart };
  const now = () => ++clock.value;
  const runtime = new PublicSideEffectRuntime({
    client: { rest: createSyntheticRest(rest) }, botId: BOT_ID, env: {}, now, effectAuthority: authority, logger,
  });
  assert.deepEqual(runtime.preflight({
    ledgers: openPublicLedgers(ledgers, { botId: BOT_ID, now, faultInjectorFor: () => faultInjector }),
  }).disabled, []);
  runtime.arm();
  configurePublicEffectAdapter({
    publicEffectRuntime: runtime,
    publicEffectIssuer: authority.createIssuer(),
    publicEffectAuthority: authority,
  });
  return { authority, runtime, ledgers, clock };
}

function successfulRest({ onCall = null } = {}) {
  const calls = [];
  return {
    calls,
    options: { retries: 0 },
    put: async () => ({}),
    delete: async (route) => { calls.push(['DELETE', route]); await onCall?.('DELETE', route); },
    post: async (route, options) => {
      calls.push(['POST', route, options?.body]);
      await onCall?.('POST', route);
      if (route === '/users/@me/channels') {
        const recipientId = String(options?.body?.recipient_id || '');
        return { id: idFor(BigInt(recipientId) % 1000n + 1000n), type: 1, recipients: [{ id: recipientId }] };
      }
      const channelId = route.split('/')[2];
      return { id: idFor(calls.length + 5000), channel_id: channelId };
    },
  };
}

function workClient(rest) {
  return {
    user: { id: BOT_ID },
    rest,
    guilds: {
      fetch: async (guildId) => guildId === GUILD_ID ? {
        id: GUILD_ID,
        members: { fetch: async (userId) => ({ id: userId, user: { id: userId } }) },
      } : null,
    },
  };
}

async function freshDatabase() {
  // A fresh database restarts task IDs, so per-task retry delays from earlier tests must go too.
  resetWorkReminderRetryStateForTests();
  resetCoinDatabaseForTests();
  fs.rmSync(process.env.COIN_DB_PATH, { force: true });
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
  // Guilds are not reviewed: no record of the guild is written, and a reminder does not read one.
  fs.rmSync(process.env.XIAOJI_AUDIT_DATA_PATH, { force: true });
}

async function seedLegacy(count = 1, { dueAt = DUE_AT, lastReminderAt = null, createdAt = CREATED_AT } = {}) {
  return withCoinTransaction((api) => {
    const tasks = [];
    for (let index = 0; index < count; index += 1) {
      const userId = idFor(100 + index);
      api.run(
        `INSERT INTO coin_jobs
          (guild_id,user_id,job_name,daily_salary,work_days,total_salary,status,is_paid,start_at,pay_at,
           last_contribution_at,last_reminder_at,today_task_count,today_completed_task_count,
           no_work_available_today,payroll_status,created_at,updated_at)
         VALUES (?,?,'測試',100,1,100,'active',0,?,?,NULL,?,0,0,0,'pending',?,?)`,
        [GUILD_ID, userId, createdAt, FUTURE_AT, lastReminderAt, createdAt, createdAt]
      );
      const jobId = Number(api.get('SELECT last_insert_rowid() AS id').id);
      api.run(
        `INSERT INTO coin_work_tasks
          (guild_id,user_id,job_id,job_name,task_type,status,description,created_at,due_at,updated_at,
           reminder_count,last_reminder_at)
         VALUES (?,?,?,'測試','work_report','pending','合成任務',?,?,?,?,?)`,
        [GUILD_ID, userId, jobId, createdAt, dueAt, createdAt, lastReminderAt ? 1 : 0, lastReminderAt]
      );
      tasks.push({ id: Number(api.get('SELECT last_insert_rowid() AS id').id), userId, jobId });
    }
    return tasks;
  });
}

async function seedGlobal(count = 1, { dueAt = DUE_AT, lastReminderAt = null, offset = 0 } = {}) {
  return withCoinTransaction((api) => {
    const tasks = [];
    for (let index = 0; index < count; index += 1) {
      const userId = idFor(500 + offset + index);
      const cycleId = `cycle-${offset + index}-${userId}`;
      api.run(
        `INSERT INTO coin_primary_jobs_global
          (user_id,job_name,work_days,source_guild_id,next_cycle_id,requested_at,effective_from,state,updated_at)
         VALUES (?,'測試',1,?,?,?,?,'active',?)`,
        [userId, GUILD_ID, cycleId, CREATED_AT, CREATED_AT, CREATED_AT]
      );
      api.run(
        `INSERT INTO coin_primary_job_cycles
          (cycle_id,user_id,job_name,work_days,source_guild_id,starts_at,ends_at,salary_rule_version,
           salary_snapshot_json,status,created_at,updated_at)
         VALUES (?,?,'測試',1,?,?,?,'v1','{}','active',?,?)`,
        [cycleId, userId, GUILD_ID, CREATED_AT, FUTURE_AT, CREATED_AT, CREATED_AT]
      );
      api.run(
        `INSERT INTO coin_work_tasks
          (guild_id,user_id,job_id,global_cycle_id,job_name,task_type,status,description,created_at,due_at,
           updated_at,reminder_count,last_reminder_at)
         VALUES (?,?,NULL,?,'測試','work_report','pending','合成全域任務',?,?,?,?,?)`,
        [GUILD_ID, userId, cycleId, CREATED_AT, dueAt, CREATED_AT, lastReminderAt ? 1 : 0, lastReminderAt]
      );
      tasks.push({ id: Number(api.get('SELECT last_insert_rowid() AS id').id), userId, cycleId });
    }
    return tasks;
  });
}

function sourceFor(task, scope, slot = 1) {
  return normalizeReminderSource({
    botId: BOT_ID, guildId: GUILD_ID, userId: task.userId, taskId: task.id,
    createdAt: CREATED_AT, scope, parentId: scope === 'legacy' ? task.jobId : task.cycleId, slot,
  });
}

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

test('work reminder uses independent DM preparation, exact accounting, and no network inside a DB transaction', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  let databaseReadableDuringNetwork = false;
  const rest = successfulRest({ onCall: async () => {
    databaseReadableDuringNetwork = Boolean(await withCoinDatabase((api) => api.get(
      'SELECT id FROM coin_work_tasks WHERE id = ?', [task.id]
    )));
  } });
  const state = createRuntime('work-success', rest);
  const summary = await processWorkReminders(workClient(rest));
  assert.deepEqual(summary, { checked: 1, reminded: 1 });
  assert.equal(databaseReadableDuringNetwork, true);
  assert.deepEqual(rest.calls.map((call) => call[1]), [
    '/users/@me/channels', `/channels/${idFor(1100)}/messages`,
  ]);
  const durable = await withCoinDatabase((api) => ({
    task: api.get('SELECT reminder_count,last_reminder_at,updated_at FROM coin_work_tasks WHERE id = ?', [task.id]),
    job: api.get('SELECT last_reminder_at,updated_at FROM coin_jobs WHERE id = ?', [task.jobId]),
  }));
  assert.equal(durable.task.reminder_count, 1);
  assert.equal(durable.task.last_reminder_at, durable.task.updated_at);
  assert.equal(durable.job.last_reminder_at, durable.task.last_reminder_at);
  assert.equal(durable.job.updated_at, durable.task.last_reminder_at);
  const accounting = state.runtime.inspectWorkReminderAccounting(sourceFor(task, 'legacy'));
  assert.equal(accounting.kind, 'acked');
  assert.equal(accounting.plan.result.reason, 'message_confirmed');
  assert.equal(accounting.plan.result.completionAt, durable.task.last_reminder_at);
  assert.equal(accounting.ack.result.accountingApplied, true);
  await state.runtime.stop();
});

test('a reminder is sent whatever status the guild was recorded with, and the record is left as it was', async () => {
  const cases = [
    ['unknown', { guildId: GUILD_ID, status: AuditStatus.UNKNOWN, manualAudit: true }],
    ['denied', { guildId: GUILD_ID, status: AuditStatus.DENIED, reason: 'Audit timeout (24h)' }],
    ['pending', { guildId: GUILD_ID, status: AuditStatus.PENDING }],
    ['no record', null],
  ];
  for (const [label, record] of cases) {
    await freshDatabase();
    const [task] = await seedLegacy();
    if (record) writeAdmission({ [GUILD_ID]: record });
    const before = record ? fs.readFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, 'utf8') : null;
    const rest = successfulRest();
    const state = createRuntime(`work-status-${label.replace(' ', '-')}`, rest);
    assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 1 }, label);
    assert.deepEqual(rest.calls.map((call) => call[1]), [
      '/users/@me/channels', `/channels/${idFor(1100)}/messages`,
    ], label);
    assert.equal((await readTaskAndJob(task)).task.reminder_count, 1, label);
    if (record) assert.equal(fs.readFileSync(process.env.XIAOJI_AUDIT_DATA_PATH, 'utf8'), before, label);
    else assert.equal(fs.existsSync(process.env.XIAOJI_AUDIT_DATA_PATH), false, label);
    await state.runtime.stop();
  }
});

test('a forged DM preparation operation cannot authorize a reminder send', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const source = sourceFor(task, 'legacy');
  const effect = {
    purposeId: 'work.reminder.dm.send', action: 'work-reminder-message.create', target: DM_CHANNEL_ID,
    method: 'POST', route: `/channels/${DM_CHANNEL_ID}/messages`,
    body: buildWorkReminderBody({ id: task.id, task_type: 'work_report', description: '合成任務' }),
  };
  const channelBinding = buildDmChannelBinding({ operationId: `work.reminder.dm.prepare-v1:${'a'.repeat(64)}`,
    bindingDigest: 'b'.repeat(64) }, { id: DM_CHANNEL_ID, type: 1, recipients: [{ id: task.userId }] }, BOT_ID, task.userId);
  const proof = await withCoinDatabase((api) => proveWorkReminderSourceWithApi(api, {
    source, effect, nowIso: new Date(NOW_MS).toISOString(),
    cutoffIso: new Date(NOW_MS - 10 * HOUR_MS).toISOString(), force: false, channelBinding,
    preparationOperation: {
      status: 'confirmed', operationId: `work.reminder.dm.prepare-v1:${'c'.repeat(64)}`,
      bindingDigest: channelBinding.prepareBindingDigest,
    },
  }));
  assert.equal(proof, null);
});

test('Discord missing guild and member codes are terminal, while a transient lookup remains retryable', async () => {
  for (const scenario of [
    { name: 'guild', code: 10004, expected: { checked: 1, reminded: 0 }, terminal: true },
    { name: 'member', code: 10007, expected: { checked: 1, reminded: 0 }, terminal: true },
    { name: 'temporary', code: 50_001, expected: { checked: 1, reminded: 0, failed: 1 }, terminal: false },
  ]) {
    await freshDatabase();
    const [task] = await seedLegacy();
    const rest = successfulRest();
    const client = workClient(rest);
    if (scenario.name === 'guild' || scenario.name === 'temporary') {
      client.guilds.fetch = async () => { throw Object.assign(new Error(scenario.name), { code: scenario.code }); };
    } else {
      client.guilds.fetch = async () => ({
        id: GUILD_ID,
        members: { fetch: async () => { throw Object.assign(new Error(scenario.name), { code: scenario.code }); } },
      });
    }
    const state = createRuntime(`work-discord-${scenario.name}`, rest);
    assert.deepEqual(await processWorkReminders(client), scenario.expected, scenario.name);
    assert.deepEqual(rest.calls, [], scenario.name);
    const saved = await readTaskAndJob(task);
    assert.equal(Number(saved.task.reminder_count), scenario.terminal ? 1 : 0, scenario.name);
    await state.runtime.stop();
  }
});

test('unknown consumes one slot, keeps a fixed cooldown, and restart does not resend it', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  let messageCalls = 0;
  const rest = successfulRest();
  const originalPost = rest.post;
  rest.post = async (route, options) => {
    if (route !== '/users/@me/channels') { messageCalls += 1; throw new Error('lost response'); }
    return originalPost(route, options);
  };
  const first = createRuntime('work-unknown', rest);
  const firstSummary = await processWorkReminders(workClient(rest));
  assert.deepEqual(firstSummary, { checked: 1, reminded: 0 });
  assert.equal(messageCalls, 1);
  const source = sourceFor(task, 'legacy');
  const accounting = first.runtime.inspectWorkReminderAccounting(source);
  assert.equal(accounting.kind, 'acked');
  assert.equal(accounting.plan.result.reason, 'message_unknown');
  assert.equal(Date.parse(accounting.plan.result.recoveryNotBefore) -
    Date.parse(accounting.plan.result.attemptedAt), 10 * 60 * 60 * 1000);
  const fixedCooldown = accounting.plan.result.recoveryNotBefore;
  await first.runtime.stop();

  const replayRest = successfulRest();
  const replay = createRuntime('work-unknown-restart', replayRest, { ledgers: first.ledgers });
  assert.deepEqual(await processWorkReminders(workClient(replayRest)), { checked: 0, reminded: 0 });
  assert.equal(replayRest.calls.length, 0);
  assert.equal(replay.runtime.inspectWorkReminderAccounting(source).plan.result.recoveryNotBefore, fixedCooldown);
  await replay.runtime.stop();
});

test('DB success followed by accounting ACK failure repairs only the ACK and never increments or sends twice', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  const state = createRuntime('work-ack-repair', rest);
  const originalPersist = state.runtime.persistWorkReminderAccounting.bind(state.runtime);
  let persistCalls = 0;
  state.runtime.persistWorkReminderAccounting = (proof) => {
    persistCalls += 1;
    if (persistCalls === 2) {
      throw Object.assign(new Error('synthetic ACK write failure'), { code: 'SYNTHETIC_ACK_WRITE' });
    }
    return originalPersist(proof);
  };
  // The failure is isolated to this task and reported in the summary instead of aborting the batch.
  const failedRun = await captureLogs(() => processWorkReminders(workClient(rest)));
  assert.deepEqual(failedRun.result, { checked: 1, reminded: 0, failed: 1 });
  // It failed exactly at the ACK write: the plan (first write) persisted, the ACK (second) did not.
  assert.equal(persistCalls, 2);
  assert.equal(state.runtime.inspectWorkReminderAccounting(sourceFor(task, 'legacy')).kind, 'planned');
  assert.deepEqual(failedRun.entries.filter(([level]) => level === 'error'),
    [['error', `工作提醒處理失敗：task=${task.id} scope=legacy code=SYNTHETIC_ACK_WRITE`]]);
  assert.equal((await withCoinDatabase((api) => api.get(
    'SELECT reminder_count FROM coin_work_tasks WHERE id = ?', [task.id]
  ))).reminder_count, 1);
  const networkCalls = rest.calls.length;
  state.runtime.persistWorkReminderAccounting = originalPersist;
  const repaired = await processWorkReminders(workClient(rest), { force: true });
  assert.deepEqual(repaired, { checked: 1, reminded: 0 });
  assert.equal(rest.calls.length, networkCalls);
  assert.equal((await withCoinDatabase((api) => api.get(
    'SELECT reminder_count FROM coin_work_tasks WHERE id = ?', [task.id]
  ))).reminder_count, 1);
  assert.equal(state.runtime.inspectWorkReminderAccounting(sourceFor(task, 'legacy')).kind, 'acked');
  await state.runtime.stop();
});

// Every accounting row of the send ledger: its state and result code.
function accountingRows(runtime) {
  const snapshot = runtime.slots.get('work.reminder.dm.send').ledger.getSnapshotForTests();
  return Object.values(snapshot.operations)
    .filter((operation) => operation.action?.startsWith('work-reminder-accounting.'))
    .map((operation) => [operation.action, operation.state, operation.resultCode]);
}

test('reminder accounting is one durable decision: a failed write leaves no row, never an unknown one', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  let failures = 0;
  // The first accounting decision fails inside its transaction, before the commit.
  const faultInjector = ({ label, phase }) => {
    if (label === 'record-not-sent' && phase === 'before-commit' && failures === 0) {
      failures += 1;
      throw Object.assign(new Error('synthetic decision failure'), { code: 'SYNTHETIC_DECISION_FAILURE' });
    }
  };
  const state = createRuntime('work-accounting-decision', rest, { faultInjector });
  // The failed write stops the send purpose for the rest of this process.
  assert.deepEqual(await processWorkReminders(workClient(rest)),
    { checked: 1, reminded: 0, failed: 1, guardDisabled: true });
  assert.equal(failures, 1);
  assert.equal(rest.calls.length, 2, 'the DM itself went out once');
  assert.equal(state.runtime.isPurposeReady('work.reminder.dm.send'), false);
  await assertReminderUntouched(task);
  await state.runtime.stop();

  // After a restart the confirmed DM is accounted from the ledger, without a second DM, and
  // every accounting row is a settled decision: none is attempted or unknown.
  resetWorkReminderRetryStateForTests();
  const replayRest = successfulRest();
  const replay = createRuntime('work-accounting-decision-restart', replayRest, { ledgers: state.ledgers });
  assert.deepEqual(accountingRows(replay.runtime), []);
  assert.deepEqual(await processWorkReminders(workClient(replayRest)), { checked: 1, reminded: 1 });
  assert.equal(replayRest.calls.length, 0);
  assert.equal((await readTaskAndJob(task)).task.reminder_count, 1);
  assert.deepEqual(accountingRows(replay.runtime), [
    ['work-reminder-accounting.plan', 'not_sent', 'accounting_plan'],
    ['work-reminder-accounting.ack', 'not_sent', 'accounting_applied'],
  ]);
  await replay.runtime.stop();
});

test('a full ledger refusing reminder accounting keeps the purpose ready and accounts it later', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const lines = [];
  const captured = { info() {}, warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)) };
  let state;
  // The ledger is declared full while the DM is on the wire, after its begin committed.
  const rest = successfulRest({ onCall: async (method, route) => {
    if (route !== '/users/@me/channels') state.runtime.slots.get('work.reminder.dm.send').ledger.maximumLedgerBytes = 1;
  } });
  state = createRuntime('work-accounting-full', rest, { logger: captured });
  const send = state.runtime.slots.get('work.reminder.dm.send').ledger;
  const limit = send.maximumLedgerBytes;
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 0, failed: 1 });
  // A second try inside the relief interval is refused again (throttled) the same way.
  assert.deepEqual(await processWorkReminders(workClient(rest), { force: true }),
    { checked: 1, reminded: 0, failed: 1 });
  assert.equal(lines.filter((line) => line.includes('code=ACCOUNTING_CAPACITY_EXCEEDED')).length, 2, lines.join('\n'));
  assert.equal(state.runtime.isPurposeReady('work.reminder.dm.send'), true);
  assert.equal(send.failed, false);
  assert.deepEqual(accountingRows(state.runtime), []);
  await assertReminderUntouched(task);

  send.maximumLedgerBytes = limit;
  assert.deepEqual(await processWorkReminders(workClient(rest), { force: true }), { checked: 1, reminded: 1 });
  assert.equal(rest.calls.length, 2, 'the DM is never sent twice');
  assert.equal((await readTaskAndJob(task)).task.reminder_count, 1);
  await state.runtime.stop();
});

test('legacy and global skip blocked rows without losing later batch capacity, and force keeps global eligibility', async () => {
  await freshDatabase();
  await seedLegacy(26);
  await seedGlobal(26);
  configurePublicEffectAdapter({ publicEffectRuntime: { isPurposeReady: () => false } });
  assert.deepEqual(await processWorkReminders(workClient(successfulRest())),
    { checked: 52, reminded: 0, guardDisabled: true });

  await freshDatabase();
  await seedLegacy(1, { dueAt: FUTURE_AT });
  await seedGlobal(1, { dueAt: FUTURE_AT, offset: 100 });
  assert.deepEqual(await processWorkReminders(workClient(successfulRest()), { force: true }),
    { checked: 1, reminded: 0, guardDisabled: true });
});

test('fake APIs cannot mint reminder authority and wrong DM recipient fails closed as unknown', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const source = sourceFor(task, 'legacy');
  const effect = {
    purposeId: 'work.reminder.dm.prepare', action: 'work-reminder-dm-channel.prepare',
    target: task.userId, method: 'POST', route: '/users/@me/channels', body: { recipient_id: task.userId },
  };
  assert.equal(proveWorkReminderSourceWithApi({ get: () => ({}) }, {
    source, effect, nowIso: new Date(NOW_MS).toISOString(),
    cutoffIso: new Date(NOW_MS - 10 * 60 * 60 * 1000).toISOString(), force: false,
  }), null);
  const rest = successfulRest();
  rest.post = async (route, options) => route === '/users/@me/channels'
    ? { id: DM_CHANNEL_ID, type: 1, recipients: [{ id: idFor(999) }] }
    : { id: MESSAGE_ID, channel_id: DM_CHANNEL_ID };
  const state = createRuntime('work-wrong-recipient', rest);
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 0 });
  assert.equal((await withCoinDatabase((api) => api.get(
    'SELECT reminder_count FROM coin_work_tasks WHERE id = ?', [task.id]
  ))).reminder_count, 1);
  assert.equal(state.runtime.inspectWorkReminderAccounting(source).plan.result.reason, 'prepare_unknown');
  await state.runtime.stop();
});

test('not-found consumes exactly three distinct slots and never creates a DM', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  const state = createRuntime('work-not-found-slots', rest);
  const client = { user: { id: BOT_ID }, rest, guilds: { fetch: async () => null } };
  for (let slot = 1; slot <= 3; slot += 1) {
    assert.deepEqual(await processWorkReminders(client, { force: true }), { checked: 1, reminded: 0 });
    assert.equal((await withCoinDatabase((api) => api.get(
      'SELECT reminder_count FROM coin_work_tasks WHERE id = ?', [task.id]
    ))).reminder_count, slot);
  }
  assert.deepEqual(await processWorkReminders(client, { force: true }), { checked: 0, reminded: 0 });
  assert.equal(rest.calls.length, 0);
  await state.runtime.stop();
});

test('same reminder operation ID rejects a different immutable accounting plan', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  const state = createRuntime('work-plan-conflict', rest);
  const source = sourceFor(task, 'legacy');
  const firstProof = await withCoinTransaction((api) => proveWorkReminderPlanWithApi(api, {
    source,
    dmOperationId: reminderOperationId(source),
    outcome: { reason: 'recipient_not_found', attemptedAt: CREATED_AT, fixedAt: CREATED_AT },
  }));
  assert.equal(state.runtime.persistWorkReminderAccounting(firstProof).kind, 'persisted');
  const conflictingProof = await withCoinTransaction((api) => proveWorkReminderPlanWithApi(api, {
    source,
    dmOperationId: reminderOperationId(source),
    outcome: { reason: 'message_unknown', attemptedAt: DUE_AT, fixedAt: DUE_AT },
  }));
  assert.throws(() => state.runtime.persistWorkReminderAccounting(conflictingProof),
    /different binding/u);
  await state.runtime.stop();
});

test('DM evidence rejects group, extra-recipient, and wrong-recipient responses', () => {
  assert.equal(validateCreatedDm({ id: DM_CHANNEL_ID, type: 3, recipients: [{ id: USER_ID }] }, USER_ID), false);
  assert.equal(validateCreatedDm({ id: DM_CHANNEL_ID, type: 1,
    recipients: [{ id: USER_ID }, { id: idFor(999) }] }, USER_ID), false);
  assert.equal(validateCreatedDm({ id: DM_CHANNEL_ID, type: 1,
    recipients: [{ id: idFor(999) }] }, USER_ID), false);
});

async function seedLegacySiblings(dueTimes) {
  return withCoinTransaction((api) => {
    const userId = idFor(700);
    api.run(
      `INSERT INTO coin_jobs
        (guild_id,user_id,job_name,daily_salary,work_days,total_salary,status,is_paid,start_at,pay_at,
         last_contribution_at,last_reminder_at,today_task_count,today_completed_task_count,
         no_work_available_today,payroll_status,created_at,updated_at)
       VALUES (?,?,'測試',100,1,100,'active',0,?,?,NULL,NULL,0,0,0,'pending',?,?)`,
      [GUILD_ID, userId, CREATED_AT, FUTURE_AT, CREATED_AT, CREATED_AT]
    );
    const jobId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    return dueTimes.map((dueAt, index) => {
      api.run(
        `INSERT INTO coin_work_tasks
          (guild_id,user_id,job_id,job_name,task_type,status,description,created_at,due_at,updated_at,
           reminder_count,last_reminder_at)
         VALUES (?,?,?,'測試','work_report','pending',?,?,?,?,0,NULL)`,
        [GUILD_ID, userId, jobId, `同工作任務 ${index + 1}`, CREATED_AT, dueAt, CREATED_AT]
      );
      return { id: Number(api.get('SELECT last_insert_rowid() AS id').id), userId, jobId };
    });
  });
}

function readLegacyReminderState(tasks) {
  return withCoinDatabase((api) => ({
    tasks: tasks.map((task) => api.get(
      'SELECT reminder_count,last_reminder_at FROM coin_work_tasks WHERE id = ?', [task.id]
    )),
    job: api.get('SELECT last_reminder_at,updated_at FROM coin_jobs WHERE id = ?', [tasks[0].jobId]),
  }));
}

test('sibling tasks of one legacy job are reminded in the same batch without revoking each other', async () => {
  await freshDatabase();
  const tasks = await seedLegacySiblings([DUE_AT, new Date(Date.parse(DUE_AT) + 60_000).toISOString()]);
  const rest = successfulRest();
  const state = createRuntime('work-legacy-siblings', rest);
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 2, reminded: 2 });
  assert.deepEqual(rest.calls.map((call) => call[1]), [
    '/users/@me/channels', `/channels/${idFor(1700)}/messages`, `/channels/${idFor(1700)}/messages`,
  ]);
  const durable = await readLegacyReminderState(tasks);
  assert.deepEqual(durable.tasks.map((task) => task.reminder_count), [1, 1]);
  assert.ok(Date.parse(durable.tasks[1].last_reminder_at) >= Date.parse(durable.tasks[0].last_reminder_at));
  assert.equal(durable.job.last_reminder_at, durable.tasks[1].last_reminder_at);
  for (const task of tasks) {
    assert.equal(state.runtime.inspectWorkReminderAccounting(sourceFor(task, 'legacy')).kind, 'acked');
  }
  await state.runtime.stop();
});

test('a later legacy sibling outcome never moves the shared job reminder time backwards', async () => {
  await freshDatabase();
  const tasks = await seedLegacySiblings([DUE_AT, new Date(Date.parse(DUE_AT) + 60_000).toISOString()]);
  const rest = successfulRest();
  // The protected dispatch clock runs ahead of the batch start time, so the first
  // sibling's confirmed reminder is newer than the second sibling's fixed time.
  const state = createRuntime('work-legacy-sibling-order', rest, { clockStart: NOW_MS + HOUR_MS });
  let memberLookups = 0;
  const client = {
    user: { id: BOT_ID },
    rest,
    guilds: { fetch: async () => ({ id: GUILD_ID, members: { fetch: async (userId) => {
      memberLookups += 1;
      return memberLookups === 1 ? { id: userId, user: { id: userId } } : null;
    } } }) },
  };
  assert.deepEqual(await processWorkReminders(client), { checked: 2, reminded: 1 });
  const durable = await readLegacyReminderState(tasks);
  assert.deepEqual(durable.tasks.map((task) => task.reminder_count), [1, 1]);
  assert.ok(Date.parse(durable.tasks[0].last_reminder_at) > Date.parse(durable.tasks[1].last_reminder_at));
  assert.equal(durable.job.last_reminder_at, durable.tasks[0].last_reminder_at);
  assert.equal(state.runtime.inspectWorkReminderAccounting(sourceFor(tasks[1], 'legacy')).plan.result.reason,
    'recipient_not_found');
  await state.runtime.stop();
});

test('an unknown reminder keeps its fixed cooldown even for a forced administrator or Owner run', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  let failMessages = true;
  const rest = successfulRest();
  const originalPost = rest.post;
  rest.post = async (route, options) => {
    if (failMessages && route !== '/users/@me/channels') {
      rest.calls.push(['POST', route, options?.body]);
      throw new Error('lost response');
    }
    return originalPost(route, options);
  };
  const recent = createRuntime('work-unknown-force', rest);
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 0 });
  const messageCalls = () => rest.calls.filter((call) => call[1] !== '/users/@me/channels').length;
  assert.equal(messageCalls(), 1);
  failMessages = false;
  assert.deepEqual(await processWorkReminders(workClient(rest), { force: true }), { checked: 1, reminded: 0 });
  assert.equal(messageCalls(), 1);
  assert.equal((await withCoinDatabase((api) => api.get(
    'SELECT reminder_count FROM coin_work_tasks WHERE id = ?', [task.id]
  ))).reminder_count, 1);
  await recent.runtime.stop();

  await freshDatabase();
  const [elapsedTask] = await seedLegacy();
  failMessages = true;
  rest.calls.length = 0;
  const elapsed = createRuntime('work-unknown-force-elapsed', rest, { clockStart: NOW_MS - 11 * HOUR_MS });
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 0 });
  failMessages = false;
  assert.deepEqual(await processWorkReminders(workClient(rest), { force: true }), { checked: 1, reminded: 1 });
  assert.equal(messageCalls(), 2);
  assert.equal((await withCoinDatabase((api) => api.get(
    'SELECT reminder_count FROM coin_work_tasks WHERE id = ?', [elapsedTask.id]
  ))).reminder_count, 2);
  await elapsed.runtime.stop();
});

async function captureLogs(callback) {
  const entries = [];
  const original = { info: logger.info, warn: logger.warn, error: logger.error };
  for (const level of Object.keys(original)) {
    logger[level] = (message) => { entries.push([level, String(message)]); };
  }
  try {
    return { result: await callback(), entries };
  } finally {
    Object.assign(logger, original);
  }
}

async function runAdminRemind(client, { force = false } = {}) {
  const replies = [];
  const interaction = {
    commandName: 'work',
    guildId: GUILD_ID,
    user: { id: USER_ID },
    client,
    memberPermissions: { has: () => true },
    guild: { id: GUILD_ID, members: { fetch: async () => null, me: { permissions: { has: () => true } } } },
    options: { getSubcommand: () => 'admin-remind', getBoolean: (name) => (name === 'force' ? force : null) },
    inGuild: () => true,
    deferReply: async (payload) => { interaction.deferred = true; replies.push(['defer', payload]); },
    editReply: async (payload) => { replies.push(['edit', payload]); },
    reply: async (payload) => { replies.push(['reply', payload]); },
    followUp: async (payload) => { replies.push(['followUp', payload]); },
  };
  await workCommand.execute(interaction);
  return replies;
}

function readTaskAndJob(task) {
  return withCoinDatabase((api) => ({
    task: api.get('SELECT reminder_count,last_reminder_at,updated_at FROM coin_work_tasks WHERE id = ?', [task.id]),
    job: task.jobId == null ? null : api.get(
      'SELECT last_reminder_at,updated_at,last_contribution_at FROM coin_jobs WHERE id = ?', [task.jobId]
    ),
  }));
}

test('one failing reminder task is isolated, logged only by ID and code, and never blocks later or global tasks', async () => {
  await freshDatabase();
  const [failing, healthy] = await seedLegacy(2);
  const [globalTask] = await seedGlobal(1);
  // The failing task sorts first, as a broken row would in every hourly batch.
  await withCoinTransaction((api) => api.run('UPDATE coin_work_tasks SET due_at = ? WHERE id = ?',
    [new Date(Date.parse(DUE_AT) - HOUR_MS).toISOString(), failing.id]));
  const rest = successfulRest();
  const state = createRuntime('work-isolation', rest);
  const inspect = state.runtime.inspectWorkReminderAccounting.bind(state.runtime);
  state.runtime.inspectWorkReminderAccounting = (source) => (Number(source?.taskId) === failing.id
    ? Object.freeze({ kind: 'conflict' }) : inspect(source));

  const { result, entries } = await captureLogs(() => processWorkReminders(workClient(rest)));
  assert.deepEqual(result, { checked: 3, reminded: 2, failed: 1 });
  assert.equal((await readTaskAndJob(failing)).task.reminder_count, 0);
  assert.equal((await readTaskAndJob(healthy)).task.reminder_count, 1);
  assert.equal((await readTaskAndJob(globalTask)).task.reminder_count, 1);
  assert.deepEqual(entries.filter(([level]) => level === 'error'), [[
    'error', `工作提醒處理失敗：task=${failing.id} scope=legacy code=WORK_REMINDER_ACCOUNTING_STATE_CONFLICT`,
  ]]);
  assert.equal(entries.some(([, message]) => message.includes('合成') || message.includes(failing.userId)), false);
  await state.runtime.stop();
});

test('a failing legacy batch query is logged and never stops the global batch', async () => {
  await freshDatabase();
  await seedLegacy();
  const [globalTask] = await seedGlobal(1);
  const rest = successfulRest();
  const state = createRuntime('work-legacy-query-failure', rest);
  // Only the legacy query joins coin_jobs, so hiding that table breaks the legacy batch alone.
  await withCoinTransaction((api) => api.run('ALTER TABLE coin_jobs RENAME TO coin_jobs_unavailable'));
  let run;
  try {
    run = await captureLogs(() => processWorkReminders(workClient(rest)));
  } finally {
    await withCoinTransaction((api) => api.run('ALTER TABLE coin_jobs_unavailable RENAME TO coin_jobs'));
  }
  assert.deepEqual(run.result, { checked: 1, reminded: 1, failed: 1 });
  assert.equal((await readTaskAndJob(globalTask)).task.reminder_count, 1);
  assert.deepEqual(run.entries.filter(([level]) => level === 'error'),
    [['error', '工作提醒批次讀取失敗：scope=legacy code=UNEXPECTED_ERROR']]);
  await state.runtime.stop();
});

test('a task failing in this process waits for later scheduled runs, while a forced admin run retries it now', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  const state = createRuntime('work-retry-delay', rest);
  const inspect = state.runtime.inspectWorkReminderAccounting.bind(state.runtime);
  let failAccounting = true;
  state.runtime.inspectWorkReminderAccounting = (source) => (failAccounting && Number(source?.taskId) === task.id
    ? Object.freeze({ kind: 'conflict' }) : inspect(source));

  const first = await captureLogs(() => runAdminRemind(workClient(rest)));
  assert.deepEqual(first.result.at(-1), ['edit',
    '提醒檢查完成：檢查 1 筆，成功送出 0 筆。\n另有 1 項處理失敗，部分提醒可能已送出，詳情已記錄在本機 log。']);
  const scheduled = await captureLogs(() => processWorkReminders(workClient(rest)));
  assert.deepEqual(scheduled.result, { checked: 0, reminded: 0, deferred: 1 });
  assert.equal(scheduled.entries.some(([level]) => level === 'error'), false);
  // A non-forced admin run tells the administrator that force retries the delayed task.
  assert.deepEqual((await runAdminRemind(workClient(rest))).at(-1), ['edit',
    '提醒檢查完成：檢查 0 筆，成功送出 0 筆。\n另有 1 筆因先前失敗暫緩，可改用 force 重試。']);
  assert.equal(rest.calls.length, 0);

  failAccounting = false;
  assert.deepEqual(await processWorkReminders(workClient(rest), { force: true }), { checked: 1, reminded: 1 });
  assert.equal((await readTaskAndJob(task)).task.reminder_count, 1);
  assert.equal(rest.calls.length, 2);
  await state.runtime.stop();
});

test('venue and edit updates after a persisted plan no longer make reminder accounting conflict', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  const state = createRuntime('work-venue-drift', rest);
  const source = sourceFor(task, 'legacy');
  const fixedAt = new Date(NOW_MS - 2 * HOUR_MS).toISOString();
  // The process stopped after persisting the plan, before applying or acknowledging it.
  const planProof = await withCoinTransaction((api) => proveWorkReminderPlanWithApi(api, {
    source, dmOperationId: reminderOperationId(source),
    outcome: { reason: 'recipient_not_found', attemptedAt: fixedAt, fixedAt },
  }));
  assert.equal(state.runtime.persistWorkReminderAccounting(planProof).kind, 'persisted');
  // Same columns as a venue completion on the shared job, plus an edit of the task itself.
  const laterAt = new Date(NOW_MS - HOUR_MS).toISOString();
  await withCoinTransaction((api) => {
    api.run(
      `UPDATE coin_jobs
       SET last_contribution_at = ?, today_completed_task_count = today_completed_task_count + 1, updated_at = ?
       WHERE id = ?`,
      [laterAt, laterAt, task.jobId]
    );
    api.run('UPDATE coin_work_tasks SET updated_at = ? WHERE id = ?', [laterAt, task.id]);
  });

  const { result, entries } = await captureLogs(() => processWorkReminders(workClient(rest), { force: true }));
  assert.deepEqual(result, { checked: 1, reminded: 0 });
  assert.equal(entries.some(([, message]) => message.includes('CONFLICT')), false);
  assert.equal(rest.calls.length, 0);
  const durable = await readTaskAndJob(task);
  assert.equal(durable.task.reminder_count, 1);
  assert.equal(durable.task.last_reminder_at, fixedAt);
  assert.equal(durable.task.updated_at, laterAt);
  assert.equal(durable.job.last_reminder_at, fixedAt);
  assert.equal(durable.job.updated_at, laterAt);
  assert.equal(durable.job.last_contribution_at, laterAt);
  assert.equal(state.runtime.inspectWorkReminderAccounting(source).kind, 'acked');
  await state.runtime.stop();
});

test('a DM preparation that failed long ago is accounted at the current time, never in the past', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  rest.post = async (route, options) => {
    rest.calls.push(['POST', route, options?.body]);
    throw new Error('lost response');
  };
  // The protected dispatch clock records the lost DM preparation 30 days ago.
  const state = createRuntime('work-old-prepare', rest, { clockStart: NOW_MS - 30 * 24 * HOUR_MS });
  const batchStart = Date.now();
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 0 });
  assert.deepEqual(rest.calls.map((call) => call[1]), ['/users/@me/channels']);
  const plan = state.runtime.inspectWorkReminderAccounting(sourceFor(task, 'legacy')).plan.result;
  assert.equal(plan.reason, 'prepare_unknown');
  assert.ok(Date.parse(plan.attemptedAt) >= batchStart);
  const durable = await readTaskAndJob(task);
  assert.equal(durable.task.reminder_count, 1);
  assert.ok(Date.parse(durable.task.last_reminder_at) >= batchStart);
  assert.equal(durable.task.updated_at, durable.task.last_reminder_at);
  assert.equal(durable.job.last_reminder_at, durable.task.last_reminder_at);
  await state.runtime.stop();
});

// Makes reads of the DM preparation ledger fail inside SQLite: a disk I/O error (IOERR) or a
// row whose stored digest no longer matches (LEDGER_CORRUPT), for `limit` reads after `skip`.
function failPreparationReads({ kind, skip = 0, limit = Infinity }) {
  const original = StatementSync.prototype.get;
  let seen = 0;
  let failed = 0;
  StatementSync.prototype.get = function failingGet(...args) {
    if (this.sourceSQL === STATEMENT_SQL.selectOperation && args[0] === 'work.reminder.dm.prepare') {
      seen += 1;
      if (seen > skip && failed < limit) {
        failed += 1;
        if (kind === 'corrupt') {
          return { ...original.apply(this, args), binding_json: '{}', binding_digest: '0'.repeat(64) };
        }
        throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR', errcode: 10, errstr: 'disk I/O error' });
      }
    }
    return original.apply(this, args);
  };
  return { failures: () => failed, restore: () => { StatementSync.prototype.get = original; } };
}

function warningLog(lines) {
  return { warn: (line) => lines.push(String(line)), error: (line) => lines.push(String(line)), info() {} };
}

async function assertReminderUntouched(task) {
  const durable = await readTaskAndJob(task);
  assert.equal(durable.task.reminder_count, 0);
  assert.equal(durable.task.last_reminder_at, null);
  assert.equal(durable.job.last_reminder_at, null);
}

for (const kind of ['corrupt', 'ioerr']) {
  const cause = kind === 'corrupt' ? 'cause=SIDE_EFFECT_FILE_CORRUPT' : 'cause=SIDE_EFFECT_PERSIST_FAILED sqlite=IOERR';

  test(`a ${kind} DM preparation read while dispatching never accounts the reminder slot`, async () => {
    await freshDatabase();
    const [task] = await seedLegacy();
    const rest = successfulRest();
    const logs = [];
    const state = createRuntime(`work-prepare-verify-${kind}`, rest, { logger: warningLog(logs) });
    // The inspection read succeeds; the read that verifies the dispatch fails.
    const reads = failPreparationReads({ kind, skip: 1 });
    let summary;
    try {
      summary = await processWorkReminders(workClient(rest));
    } finally {
      reads.restore();
    }
    assert.equal(reads.failures(), 1);
    assert.deepEqual(summary, { checked: 1, reminded: 0, guardDisabled: true });
    assert.deepEqual(rest.calls, []);
    await assertReminderUntouched(task);
    assert.equal(state.runtime.isPurposeReady('work.reminder.dm.prepare'), false);
    assert.equal(state.runtime.inspectWorkReminderAccounting(sourceFor(task, 'legacy')).kind, 'none');
    assert.ok(logs.includes(`[PUBLIC_EFFECT] purpose=work.reminder.dm.prepare code=VERIFY_FAILED ${cause}`),
      logs.join('\n'));
    await state.runtime.stop();
  });

  test(`after one ${kind} DM preparation read, no later recipient has a reminder slot accounted`, async () => {
    await freshDatabase();
    const [first, second] = await seedLegacy(2);
    await withCoinTransaction((api) => api.run('UPDATE coin_work_tasks SET due_at = ? WHERE id = ?',
      [new Date(Date.parse(DUE_AT) - HOUR_MS).toISOString(), first.id]));
    const rest = successfulRest();
    const logs = [];
    const state = createRuntime(`work-prepare-earlier-${kind}`, rest, { logger: warningLog(logs) });
    // Only the first recipient's read fails; the ledger stays failed for the second.
    const reads = failPreparationReads({ kind, limit: 1 });
    let summary;
    try {
      summary = await processWorkReminders(workClient(rest));
    } finally {
      reads.restore();
    }
    assert.equal(reads.failures(), 1);
    assert.deepEqual(summary, { checked: 2, reminded: 0, guardDisabled: true });
    assert.deepEqual(rest.calls, []);
    await assertReminderUntouched(first);
    await assertReminderUntouched(second);
    assert.equal(state.runtime.inspectWorkReminderAccounting(sourceFor(second, 'legacy')).kind, 'none');
    assert.ok(logs.includes(`[PUBLIC_EFFECT] purpose=work.reminder.dm.prepare code=INSPECT_FAILED ${cause}`),
      logs.join('\n'));
    await state.runtime.stop();
  });
}

// Replaces the final proof of successive DM preparation attempts: 'throw' fails like a
// transient database error, 'revoke' like a proof that no longer holds.
function scriptPreparationAttempts(runtime, outcomes) {
  const dispatch = runtime.dispatch.bind(runtime);
  let attempts = 0;
  runtime.dispatch = (grant, effect, options = {}) => {
    if (effect?.purposeId !== 'work.reminder.dm.prepare') return dispatch(grant, effect, options);
    return dispatch(grant, effect, {
      ...options,
      beforeAttempt: async (begin, record) => {
        const outcome = outcomes[attempts];
        attempts += 1;
        if (outcome === 'throw') throw new Error('SYNTHETIC_PREPARATION_PROOF_FAILURE');
        if (outcome === 'revoke') {
          throw Object.assign(new Error('WORK_REMINDER_AUTHORIZATION_REVOKED'), {
            terminal: true, code: 'authorization_revoked',
          });
        }
        return options.beforeAttempt(begin, record);
      },
    });
  };
  return { attempts: () => attempts };
}

// Fills a purpose's queue to its limit while its worker looks busy, as if QUEUE_LIMIT
// dispatches were already waiting; release() removes the placeholders and resumes the worker.
function holdFullQueue(runtime, purposeId) {
  const slot = runtime.slots.get(purposeId);
  slot.draining = true;
  while (slot.queue.length < QUEUE_LIMIT) slot.queue.push({ placeholder: true, resolve() {} });
  return () => {
    slot.queue = slot.queue.filter((task) => !task.placeholder);
    slot.draining = false;
    runtime.kickDrain(purposeId);
  };
}

async function assertSiblingsUntouched(state, tasks) {
  const stored = await readLegacyReminderState(tasks);
  assert.deepEqual(stored.tasks.map((row) => ({ count: row.reminder_count, last: row.last_reminder_at })),
    tasks.map(() => ({ count: 0, last: null })));
  assert.equal(stored.job.last_reminder_at, null);
  for (const task of tasks) {
    assert.equal(state.runtime.inspectWorkReminderAccounting(sourceFor(task, 'legacy')).kind, 'none');
  }
}

// The error lines of a batch that held tasks back because their answer lives only in memory.
function heldLines(entries) {
  return entries.filter(([level, line]) => level === 'error' && line.endsWith('code=WORK_REMINDER_HELD_IN_MEMORY'))
    .map(([, line]) => line);
}

// Durable rows of the DM preparation ledger. A preparation must never get a durable
// "never sent" decision: that would use up the reminder that owns the operation.
function durablePreparations(runtime) {
  return Object.values(runtime.slots.get('work.reminder.dm.prepare').ledger.getSnapshotForTests().operations)
    .filter((operation) => operation.durable);
}

test('two failed DM preparations are retried without using up either reminder', async () => {
  await freshDatabase();
  const tasks = await seedLegacySiblings([new Date(Date.parse(DUE_AT) - HOUR_MS).toISOString(), DUE_AT]);
  const rest = successfulRest();
  const state = createRuntime('work-prepare-twice', rest);
  const script = scriptPreparationAttempts(state.runtime, ['throw', 'throw']);
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 2, reminded: 0 });
  await assertSiblingsUntouched(state, tasks);
  // Each reminder owns its preparation. Once its retry delay expires, both can send;
  // the second one safely reuses the first confirmed channel.
  state.clock.value += PREPARE_RETRY_AFTER_MS;
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 2, reminded: 2 });
  assert.equal(script.attempts(), 3);
  assert.equal(rest.calls.filter(([, route]) => route === '/users/@me/channels').length, 1);
  const messageRoutes = rest.calls.filter(([, route]) => route.includes('/messages')).map(([, route]) => route);
  assert.equal(messageRoutes.length, 2);
  assert.equal(messageRoutes[0], messageRoutes[1]);
  assert.equal(durablePreparations(state.runtime).length, 1);
  assert.equal((await readLegacyReminderState(tasks)).tasks.every((task) => task.reminder_count === 1), true);
  await state.runtime.stop();
});

test('a revoked final authorization holds only its own preparation and resumes after restart', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  const state = createRuntime('work-prepare-revoked', rest);
  const script = scriptPreparationAttempts(state.runtime, ['revoke']);
  // Final authorization failed before begin(), so no durable decision or accounting row
  // may prevent the same reminder from being retried after restart.
  const first = await captureLogs(() => processWorkReminders(workClient(rest)));
  assert.deepEqual(first.result, { checked: 1, reminded: 0, failed: 1 });
  assert.deepEqual(heldLines(first.entries), [`工作提醒處理失敗：task=${task.id} scope=legacy code=WORK_REMINDER_HELD_IN_MEMORY`]);
  await assertReminderUntouched(task);
  assert.equal(script.attempts(), 1);
  await state.runtime.stop();

  resetWorkReminderRetryStateForTests();
  const replayRest = successfulRest();
  const replay = createRuntime('work-prepare-revoked-restart', replayRest, { ledgers: state.ledgers });
  assert.deepEqual(await processWorkReminders(workClient(replayRest)), { checked: 1, reminded: 1 });
  assert.equal((await readTaskAndJob(task)).task.reminder_count, 1);
  await replay.runtime.stop();
});

test('a task created before the ledger cutover is still retired without a DM', async () => {
  await freshDatabase();
  const createdAt = new Date(CUTOVER - 24 * HOUR_MS).toISOString();
  const [task] = await seedLegacy(1, { createdAt });
  const rest = successfulRest();
  const state = createRuntime('work-before-cutover', rest);
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 0 });
  assert.deepEqual(rest.calls, []);
  const durable = await readTaskAndJob(task);
  assert.equal(durable.task.reminder_count, 1);
  assert.ok(durable.task.last_reminder_at);
  const source = normalizeReminderSource({ botId: BOT_ID, guildId: GUILD_ID, userId: task.userId, taskId: task.id,
    createdAt, scope: 'legacy', parentId: task.jobId, slot: 1 });
  // The reminder DM's own source time is at or below the cutover: the ledger computes it as
  // terminal before any preparation, and that consumes the slot.
  assert.equal(state.runtime.inspectWorkReminderAccounting(source).plan.result.reason, 'message_terminal');
  await state.runtime.stop();
});

// The binding a dispatch forms for a reminder effect, through a fresh proof and grant.
async function reminderBinding(authority, source, effect, options = {}) {
  const proof = await withCoinTransaction((api) => proveWorkReminderSourceWithApi(api, {
    source, effect, nowIso: new Date(NOW_MS).toISOString(),
    cutoffIso: new Date(NOW_MS - 10 * HOUR_MS).toISOString(), force: false, ...options,
  }));
  const record = authority.consumeEffect(authority.createIssuer().issueWorkReminder(proof, effect), effect);
  return buildPublicOperation(record, effect);
}

test('reminder bindings are formed again identically; two tasks of one recipient have independent DM preparations',
  async () => {
    await freshDatabase();
    const tasks = await seedLegacySiblings([new Date(Date.parse(DUE_AT) - HOUR_MS).toISOString(), DUE_AT]);
    // The second task was created an hour later: a task time in the preparation binding would
    // make the two tasks' preparations conflict.
    const laterCreatedAt = new Date(Date.parse(CREATED_AT) + HOUR_MS).toISOString();
    await withCoinTransaction((api) => api.run('UPDATE coin_work_tasks SET created_at = ? WHERE id = ?',
      [laterCreatedAt, tasks[1].id]));
    const sources = [sourceFor(tasks[0], 'legacy'), { ...sourceFor(tasks[1], 'legacy'), createdAt: laterCreatedAt }];
    const userId = tasks[0].userId;
    const prepare = { purposeId: 'work.reminder.dm.prepare', action: 'work-reminder-dm-channel.prepare', target: userId,
      method: 'POST', route: '/users/@me/channels', body: { recipient_id: userId } };
    const channelBinding = buildDmChannelBinding({ operationId: `work.reminder.dm.prepare-v1:${'a'.repeat(64)}`,
      bindingDigest: 'b'.repeat(64) }, { id: DM_CHANNEL_ID, type: 1, recipients: [{ id: userId }] }, BOT_ID, userId);
    const preparationOperation = { status: 'confirmed', operationId: channelBinding.prepareOperationId,
      bindingDigest: channelBinding.prepareBindingDigest };
    const send = { purposeId: 'work.reminder.dm.send', action: 'work-reminder-message.create', target: DM_CHANNEL_ID,
      method: 'POST', route: `/channels/${DM_CHANNEL_ID}/messages`,
      body: buildWorkReminderBody({ id: tasks[0].id, task_type: 'work_report', description: '同工作任務 1' }) };
    const build = async (authority) => ({
      prepareFirst: await reminderBinding(authority, sources[0], prepare),
      prepareSecond: await reminderBinding(authority, sources[1], prepare),
      send: await reminderBinding(authority, sources[0], send, { channelBinding, preparationOperation }),
    });
    const first = createRuntime('bindings-first', successfulRest());
    const before = await build(first.authority);
    await first.runtime.stop();
    const restarted = createRuntime('bindings-restart', successfulRest(), { ledgers: first.ledgers });
    const after = await build(restarted.authority);
    for (const key of Object.keys(before)) {
      assert.ok(before[key], key);
      assert.equal(normalizeBinding(after[key]).bindingDigest, normalizeBinding(before[key]).bindingDigest, key);
    }
    // Every send has its own preparation operation. A recent confirmed channel may later be
    // reused, but a task cannot substitute another task's preparation proof.
    assert.notEqual(normalizeBinding(before.prepareSecond).bindingDigest, normalizeBinding(before.prepareFirst).bindingDigest);
    assert.equal('sourceTimeMs' in before.prepareFirst, false);
    assert.equal(before.prepareFirst.sourceKey, `work.reminder.dm.prepare:bot:${BOT_ID}:recipient:${userId}`);
    // The DM carries its source time under one source key per guild.
    assert.deepEqual([before.send.sourceKey, before.send.sourceTimeMs],
      [`work.reminder.dm.send:guild:${GUILD_ID}`, Date.parse(CREATED_AT)]);
    await restarted.runtime.stop();
  });

test('a reminder of an old task whose guild watermark passed it is accounted as terminal without a DM', async () => {
  await freshDatabase();
  const olderCreatedAt = new Date(Date.parse(CREATED_AT) - HOUR_MS).toISOString();
  const [older] = await seedLegacy(1, { createdAt: olderCreatedAt, dueAt: FUTURE_AT });
  const [newer] = await seedGlobal(1);
  const rest = successfulRest();
  const first = createRuntime('work-watermark-first', rest);
  // Only the newer task of the guild is due: its DM is sent and recorded under its created_at.
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 1 });
  assert.equal((await readTaskAndJob(newer)).task.reminder_count, 1);
  await first.runtime.stop();

  // 31 days later the next start prunes that DM row; its created_at becomes the guild's
  // watermark, which covers the older task once it is due.
  await withCoinTransaction((api) => api.run('UPDATE coin_work_tasks SET due_at = ? WHERE id = ?', [DUE_AT, older.id]));
  const replayRest = successfulRest();
  const replay = createRuntime('work-watermark-restart', replayRest,
    { ledgers: first.ledgers, clockStart: first.clock.value + 31 * 24 * HOUR_MS });
  assert.deepEqual(await processWorkReminders(workClient(replayRest)), { checked: 1, reminded: 0 });
  assert.deepEqual(replayRest.calls, []);
  assert.equal((await readTaskAndJob(older)).task.reminder_count, 1);
  const source = normalizeReminderSource({ botId: BOT_ID, guildId: GUILD_ID, userId: older.userId, taskId: older.id,
    createdAt: olderCreatedAt, scope: 'legacy', parentId: older.jobId, slot: 1 });
  assert.equal(replay.runtime.inspectWorkReminderAccounting(source).plan.result.reason, 'message_terminal');
  await replay.runtime.stop();
});

test('blocked reminders leave the 25-task batch to a later eligible task', async () => {
  await freshDatabase();
  const siblings = await seedLegacySiblings(Array.from({ length: 25 },
    (_, index) => new Date(Date.parse(DUE_AT) - (index + 2) * HOUR_MS).toISOString()));
  const [later] = await seedLegacy(1);
  const rest = successfulRest();
  const state = createRuntime('work-held-batch', rest);
  // Each of the first 25 preparations loses final authorization in memory. They are
  // deferred without spending a batch slot, so the unrelated later task still runs.
  scriptPreparationAttempts(state.runtime, Array.from({ length: 25 }, () => 'revoke'));
  const first = await captureLogs(() => processWorkReminders(workClient(rest)));
  assert.deepEqual(first.result, { checked: 26, reminded: 1, failed: 25 });
  assert.equal(heldLines(first.entries).length, 25);
  assert.equal((await readTaskAndJob(later)).task.reminder_count, 1);
  await assertSiblingsUntouched(state, siblings);
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 0, reminded: 0, deferred: 25 });
  await state.runtime.stop();
});

test('a full DM preparation queue leaves the reminder for a later batch instead of using up its slot', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  const state = createRuntime('work-prepare-queue-full', rest);
  const release = holdFullQueue(state.runtime, 'work.reminder.dm.prepare');
  let summary;
  try {
    summary = await processWorkReminders(workClient(rest));
  } finally {
    release();
  }
  assert.deepEqual(summary, { checked: 1, reminded: 0 });
  assert.deepEqual(rest.calls, []);
  await assertReminderUntouched(task);
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 1 });
  assert.equal((await readTaskAndJob(task)).task.reminder_count, 1);
  await state.runtime.stop();
});

test('recovered reminder accounting keeps a later task updated_at instead of moving it back', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  const state = createRuntime('work-later-updated-at', rest, { clockStart: NOW_MS - 2 * HOUR_MS });
  const originalPersist = state.runtime.persistWorkReminderAccounting.bind(state.runtime);
  state.runtime.persistWorkReminderAccounting = () => {
    throw Object.assign(new Error('synthetic plan write failure'), { code: 'SYNTHETIC_PLAN_WRITE' });
  };
  const failedRun = await captureLogs(() => processWorkReminders(workClient(rest)));
  assert.deepEqual(failedRun.result, { checked: 1, reminded: 0, failed: 1 });
  assert.ok(failedRun.entries.some(([level, message]) => level === 'error' &&
    message === `工作提醒處理失敗：task=${task.id} scope=legacy code=SYNTHETIC_PLAN_WRITE`));
  const editedAt = new Date(NOW_MS - HOUR_MS).toISOString();
  await withCoinTransaction((api) => api.run('UPDATE coin_work_tasks SET updated_at = ? WHERE id = ?', [editedAt, task.id]));

  state.runtime.persistWorkReminderAccounting = originalPersist;
  assert.deepEqual(await processWorkReminders(workClient(rest), { force: true }), { checked: 1, reminded: 1 });
  assert.equal(rest.calls.length, 2);
  const durable = await readTaskAndJob(task);
  assert.equal(durable.task.reminder_count, 1);
  assert.ok(Date.parse(durable.task.last_reminder_at) < Date.parse(editedAt));
  assert.equal(durable.task.updated_at, editedAt);
  await state.runtime.stop();
});

test('only one reminder batch runs at a time and an overlapping admin run gets a private busy reply', async () => {
  await freshDatabase();
  await seedLegacy();
  let releasePreparation;
  const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
  let markPreparationStarted;
  const preparationStarted = new Promise((resolve) => { markPreparationStarted = resolve; });
  const rest = successfulRest({ onCall: async (method, route) => {
    if (route === '/users/@me/channels') {
      markPreparationStarted();
      await preparationGate;
    }
  } });
  const state = createRuntime('work-single-flight', rest);
  const running = processWorkReminders(workClient(rest));
  let firstRun;
  try {
    await preparationStarted;
    assert.deepEqual(await processWorkReminders(workClient(rest), { force: true }),
      { checked: 0, reminded: 0, busy: true });
    assert.deepEqual(await runAdminRemind(workClient(rest), { force: true }), [
      ['defer', { ephemeral: true }],
      ['edit', '工作提醒正在處理中，請稍後再試。'],
    ]);
    assert.equal(rest.calls.length, 1);
  } finally {
    // Never leave the batch (and its process-wide lock) blocked for later tests.
    releasePreparation();
    firstRun = await running;
  }
  assert.deepEqual(firstRun, { checked: 1, reminded: 1 });
  assert.equal(rest.calls.length, 2);
  // The batch released its lock, so the next trigger runs normally.
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 0, reminded: 0 });
  await state.runtime.stop();
});

test('the admin reminder reply explains a disabled guard without internal details', async () => {
  await freshDatabase();
  await seedLegacy();
  configurePublicEffectAdapter({ publicEffectRuntime: { isPurposeReady: () => false } });
  const replies = await runAdminRemind(workClient(successfulRest()), { force: true });
  assert.deepEqual(replies, [
    ['defer', { ephemeral: true }],
    ['edit', '工作提醒防護目前未啟用，未送出任何提醒。'],
  ]);
  const adminRemind = workCommand.data.toJSON().options.find((option) => option.name === 'admin-remind');
  const forceOption = adminRemind.options.find((option) => option.name === 'force');
  assert.equal(forceOption.description, '是否忽略 10 小時間隔直接提醒（結果不明後的冷卻仍然有效）');
});

test('reminder sources accept another spelling of the same created_at instant and still fail closed on a mismatch', async () => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const storedSpelling = CREATED_AT.replace('Z', '+00:00');
  await withCoinTransaction((api) => api.run('UPDATE coin_work_tasks SET created_at = ? WHERE id = ?',
    [storedSpelling, task.id]));
  const source = sourceFor(task, 'legacy');
  const records = await withCoinTransaction((api) => ({
    same: readActiveWorkReminderSource(api, source),
    otherInstant: readActiveWorkReminderSource(api, {
      ...source, createdAt: new Date(Date.parse(CREATED_AT) + 1).toISOString(),
    }),
    missing: readActiveWorkReminderSource(api, { ...source, createdAt: null }),
  }));
  assert.equal(records.same?.task.id, task.id);
  assert.equal(records.otherInstant, null);
  assert.equal(records.missing, null);

  const rest = successfulRest();
  const state = createRuntime('work-created-at-spelling', rest);
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 1 });
  const stored = await withCoinDatabase((api) => api.get(
    'SELECT reminder_count,created_at FROM coin_work_tasks WHERE id = ?', [task.id]
  ));
  assert.deepEqual({ ...stored }, { reminder_count: 1, created_at: storedSpelling });
  assert.equal(state.runtime.inspectWorkReminderAccounting(source).kind, 'acked');

  await withCoinTransaction((api) => api.run('UPDATE coin_work_tasks SET created_at = ? WHERE id = ?',
    ['not-a-timestamp', task.id]));
  assert.equal(await withCoinTransaction((api) => readActiveWorkReminderSource(api, source)), null);
  await state.runtime.stop();
});

const REPO_ROOT = path.join(__dirname, '..');
const MINUTE_MS = 60 * 1000;

// Finds SQL that writes reminder_count or last_reminder_at: UPDATE ... SET and upsert
// DO UPDATE SET clauses (up to WHERE or the end of the literal), INSERT/REPLACE column
// lists, and SET fragments assembled at runtime such as updates.push('reminder_count = ?').
function findReminderColumnWrites(text) {
  const writes = [];
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  const assignment = /\b(?:reminder_count|last_reminder_at)\s*=(?!=)/u;
  const column = /\b(?:reminder_count|last_reminder_at)\b/u;
  const setClauses = /\b(?:UPDATE\s+(?:OR\s+[A-Z]+\s+)?[A-Za-z_][\w.]*|DO\s+UPDATE)\s+SET\b([\s\S]*?)(?=\bWHERE\b|\bRETURNING\b|\bFROM\b|[`";]|$)/giu;
  for (const match of text.matchAll(setClauses)) {
    if (assignment.test(match[1])) writes.push(`${lineOf(match.index)}:update`);
  }
  const insertColumns = /\b(?:INSERT|REPLACE)\s+(?:OR\s+[A-Z]+\s+)?INTO\s+[A-Za-z_][\w.]*\s*\(([^)]*)\)/giu;
  for (const match of text.matchAll(insertColumns)) {
    if (column.test(match[1])) writes.push(`${lineOf(match.index)}:insert`);
  }
  for (const match of text.matchAll(/[`'"]\s*(?:reminder_count|last_reminder_at)\s*=(?!=)/gu)) {
    writes.push(`${lineOf(match.index)}:fragment`);
  }
  return writes;
}

function listJavaScriptFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : listJavaScriptFiles(fullPath);
    return entry.isFile() && entry.name.endsWith('.js') ? [fullPath] : [];
  });
}

test('only the reminder accounting module writes reminder_count or last_reminder_at', () => {
  // The detector itself must catch every write shape and ignore reads, filters and schema.
  for (const snippet of [
    'api.run(`UPDATE coin_work_tasks SET reminder_count = ? WHERE id = ?`)',
    "api.run('UPDATE coin_jobs\n SET updated_at = ?,\n last_reminder_at = ? WHERE id = ?')",
    "api.run(`UPDATE coin_work_tasks SET status = 'paid', last_reminder_at = NULL`)",
    "api.run('INSERT INTO coin_work_tasks (guild_id,\n reminder_count) VALUES (?, ?)')",
    'api.run(`INSERT INTO coin_jobs (id) VALUES (?) ON CONFLICT(id) DO UPDATE SET last_reminder_at = excluded.last_reminder_at`)',
    "updates.push('reminder_count = ?')",
  ]) {
    assert.notDeepEqual(findReminderColumnWrites(snippet), [], snippet);
  }
  for (const snippet of [
    "api.all('SELECT * FROM coin_work_tasks WHERE reminder_count < 3 AND last_reminder_at <= ?')",
    "api.run('UPDATE coin_work_tasks SET status = ? WHERE id = ? AND reminder_count = ?')",
    'CREATE TABLE coin_jobs (last_reminder_at TEXT, reminder_count INTEGER NOT NULL DEFAULT 0)',
    "addColumnIfMissing(db, 'coin_jobs', 'last_reminder_at', 'TEXT')",
    'const lastReminderAt = row.last_reminder_at || null;',
  ]) {
    assert.deepEqual(findReminderColumnWrites(snippet), [], snippet);
  }

  const writers = {};
  for (const file of [...listJavaScriptFiles(path.join(REPO_ROOT, 'src')), ...listJavaScriptFiles(path.join(REPO_ROOT, 'scripts'))]) {
    const writes = findReminderColumnWrites(fs.readFileSync(file, 'utf8'));
    if (writes.length) writers[path.relative(REPO_ROOT, file).replaceAll('\\', '/')] = writes;
  }
  // Relaxed accounting matching relies on this: nothing else may move these columns.
  assert.deepEqual(Object.keys(writers), ['src/systems/work/workReminderAccounting.js']);
  assert.deepEqual(writers['src/systems/work/workReminderAccounting.js'].map((write) => write.split(':')[1]),
    ['update', 'update']);
});

test('reminder timestamps must end in Z or a ±HH:MM offset on both normalization paths', async () => {
  const instant = '2026-09-30T12:00:00.000Z';
  const zoned = ['2026-09-30T12:00:00.000Z', '2026-09-30T20:00:00.000+08:00', '2026-09-30T07:00:00.000-05:00'];
  const unzoned = ['2026-09-30T12:00:00.000', '2026-09-30 12:00:00', '2026-09-30T12:00:00+0800', '2026-09-30'];
  for (const value of zoned) assert.equal(normalizeWorkReminderTimestamp(value), instant, value);
  for (const value of [...unzoned, Date.parse(instant), new Date(instant), null, '']) {
    assert.equal(normalizeWorkReminderTimestamp(value), null, String(value));
  }

  await freshDatabase();
  const [task] = await seedLegacy();
  const base = {
    botId: BOT_ID, guildId: GUILD_ID, userId: task.userId, taskId: task.id, scope: 'legacy', parentId: task.jobId, slot: 1,
  };
  for (const value of zoned) assert.equal(normalizeReminderSource({ ...base, createdAt: value })?.createdAt, instant);
  for (const value of unzoned) assert.equal(normalizeReminderSource({ ...base, createdAt: value }), null, value);

  const source = normalizeReminderSource({ ...base, createdAt: instant });
  const readWithStored = async (stored, lookup = source) => {
    await withCoinTransaction((api) => api.run('UPDATE coin_work_tasks SET created_at = ? WHERE id = ?', [stored, task.id]));
    return withCoinTransaction((api) => readActiveWorkReminderSource(api, lookup));
  };
  for (const stored of zoned) assert.equal((await readWithStored(stored))?.task.id, task.id, stored);
  for (const stored of unzoned) {
    assert.equal(await readWithStored(stored), null, stored);
    // Even an exact copy of an unzoned stored value is not accepted as a lookup key.
    assert.equal(await readWithStored(stored, { ...source, createdAt: stored }), null, stored);
  }

  // End to end, an unzoned created_at fails closed for that task alone, without any DM.
  await withCoinTransaction((api) => api.run('UPDATE coin_work_tasks SET created_at = ? WHERE id = ?',
    ['2026-09-30 12:00:00', task.id]));
  const rest = successfulRest();
  const state = createRuntime('work-unzoned-created-at', rest);
  const { result, entries } = await captureLogs(() => processWorkReminders(workClient(rest)));
  assert.deepEqual(result, { checked: 1, reminded: 0, failed: 1 });
  assert.equal(rest.calls.length, 0);
  assert.ok(entries.some(([level, message]) => level === 'error' &&
    message === `工作提醒處理失敗：task=${task.id} scope=legacy code=WORK_REMINDER_SOURCE_INVALID`));
  await state.runtime.stop();
});

test('a reminder batch holding the lock for over two hours is reported once as probably stuck', async (t) => {
  await freshDatabase();
  await seedLegacy();
  let releasePreparation;
  const preparationGate = new Promise((resolve) => { releasePreparation = resolve; });
  let markPreparationStarted;
  const preparationStarted = new Promise((resolve) => { markPreparationStarted = resolve; });
  const rest = successfulRest({ onCall: async (method, route) => {
    if (route === '/users/@me/channels') {
      markPreparationStarted();
      await preparationGate;
    }
  } });
  const state = createRuntime('work-stuck-lock', rest);
  const startedAtMs = Date.now();
  const running = processWorkReminders(workClient(rest));
  let firstRun;
  try {
    await preparationStarted;
    t.mock.timers.enable({ apis: ['Date'], now: startedAtMs + HOUR_MS });
    const early = await captureLogs(() => processWorkReminders(workClient(rest)));
    assert.deepEqual(early.result, { checked: 0, reminded: 0, busy: true });
    assert.deepEqual(early.entries, [['info', '工作提醒仍在處理上一輪，略過這次觸發。']]);

    t.mock.timers.setTime(startedAtMs + 2 * HOUR_MS + MINUTE_MS);
    const stuck = await captureLogs(() => processWorkReminders(workClient(rest)));
    assert.deepEqual(stuck.result, { checked: 0, reminded: 0, busy: true });
    assert.equal(stuck.entries.length, 1);
    assert.equal(stuck.entries[0][0], 'warn');
    assert.match(stuck.entries[0][1], /^工作提醒批次已執行 12\d 分鐘仍未結束，可能卡住；/u);

    // Later overlapping triggers stay quiet instead of repeating the warning every hour.
    for (const hours of [3, 4]) {
      t.mock.timers.setTime(startedAtMs + hours * HOUR_MS);
      const later = await captureLogs(() => runAdminRemind(workClient(rest)));
      assert.deepEqual(later.result.at(-1), ['edit', '工作提醒正在處理中，請稍後再試。']);
      assert.deepEqual(later.entries, []);
    }
  } finally {
    t.mock.timers.reset();
    releasePreparation();
    firstRun = await running;
  }
  assert.deepEqual(firstRun, { checked: 1, reminded: 1 });
  await state.runtime.stop();
});

test('the reminder retry delay expires, doubles to 24 hours with one warning, and keeps at most 500 tasks', () => {
  const warnings = [];
  const tracker = createWorkReminderRetryTracker({ log: { warn: (message) => warnings.push(message) } });
  const start = Date.parse('2026-01-01T00:00:00.000Z');

  assert.equal(tracker.recordFailure(7, start).delayMs, 90 * MINUTE_MS);
  assert.deepEqual(tracker.deferredTaskIds(start + 90 * MINUTE_MS - 1), [7]);
  assert.deepEqual(tracker.deferredTaskIds(start + 90 * MINUTE_MS), []);

  const delays = [];
  for (let failure = 2; failure <= 7; failure += 1) delays.push(tracker.recordFailure(7, start).delayMs / MINUTE_MS);
  assert.deepEqual(delays, [180, 360, 720, 1440, 1440, 1440]);
  assert.deepEqual(warnings, ['工作提醒任務 #7 已連續失敗 5 次，之後每 24 小時才重試一次；請檢查本機 log。']);
  assert.deepEqual(tracker.deferredTaskIds(start + 24 * HOUR_MS - 1), [7]);
  assert.deepEqual(tracker.deferredTaskIds(start + 24 * HOUR_MS), []);
  tracker.recordSuccess(7);
  assert.equal(tracker.get(7), null);
  assert.equal(tracker.recordFailure(7, start).delayMs, 90 * MINUTE_MS);

  tracker.clear();
  for (let taskId = 1; taskId <= 501; taskId += 1) tracker.recordFailure(taskId, start);
  assert.equal(tracker.size, 500);
  assert.equal(tracker.get(1), null);
  assert.equal(tracker.get(2)?.failures, 1);
  assert.equal(tracker.get(501)?.failures, 1);
  assert.equal(tracker.deferredTaskIds(start).includes(1), false);
  // A repeated failure refreshes the task, so the next task forgotten is the oldest other one.
  tracker.recordFailure(2, start);
  tracker.recordFailure(502, start);
  assert.equal(tracker.get(2)?.failures, 2);
  assert.equal(tracker.get(3), null);
  assert.equal(tracker.size, 500);
});

test('a delayed reminder task is retried by a scheduled run once its delay expires', async (t) => {
  await freshDatabase();
  const [task] = await seedLegacy();
  const rest = successfulRest();
  const state = createRuntime('work-retry-expiry', rest);
  const inspect = state.runtime.inspectWorkReminderAccounting.bind(state.runtime);
  let failAccounting = true;
  state.runtime.inspectWorkReminderAccounting = (source) => (failAccounting && Number(source?.taskId) === task.id
    ? Object.freeze({ kind: 'conflict' }) : inspect(source));
  const firstRunAt = Date.now();
  assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 0, failed: 1 });
  failAccounting = false;
  try {
    t.mock.timers.enable({ apis: ['Date'], now: firstRunAt + 89 * MINUTE_MS });
    assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 0, reminded: 0, deferred: 1 });
    t.mock.timers.setTime(firstRunAt + 91 * MINUTE_MS);
    assert.deepEqual(await processWorkReminders(workClient(rest)), { checked: 1, reminded: 1 });
  } finally {
    t.mock.timers.reset();
  }
  assert.equal((await readTaskAndJob(task)).task.reminder_count, 1);
  assert.equal(rest.calls.length, 2);
  await state.runtime.stop();
});

test('the reminder lock is released even when the batch itself throws', async () => {
  await freshDatabase();
  await seedLegacy();
  configurePublicEffectAdapter({ publicEffectRuntime: {
    isPurposeReady: () => { throw new Error('synthetic runtime failure'); },
  } });
  const failed = await captureLogs(() => assert.rejects(processWorkReminders(workClient(successfulRest())),
    /synthetic runtime failure/u));
  assert.ok(failed.entries.some(([level, message]) => level === 'error' && message.endsWith('code=UNEXPECTED_ERROR')));
  configurePublicEffectAdapter({ publicEffectRuntime: { isPurposeReady: () => false } });
  assert.deepEqual(await processWorkReminders(workClient(successfulRest()), { force: true }),
    { checked: 1, reminded: 0, guardDisabled: true });
});
