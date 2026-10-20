'use strict';

// What the work system hands to an extension host when it asks about job roles.
//
// test/extensionScopePins.test.js pins the hook names, payloads and default replies as an extension receives them. This
// file pins the boundary in front of it: the plain object the core finds at client.extensionHost and what it does with
// that object. The host here is a bare recorder, not createExtensionHost(), so the exact arguments of every runHook
// call, the reading of the answer, a client with no host at all, and a host that fails are all visible. The tests name
// neither the coordinator (src/coordinators/workRoleCoordinator.js) nor the port (src/systems/work/workRolePort.js) that
// the calls are routed through, so they hold however the calls are routed.
//   - /work role-sync (src/commands/work.js) asks for syncAllJobRoles; /work cancel asks for nothing, because
//     resigning is not offered;
//   - the primary-cycle cleanup (runPrimaryRoleCleanupAfterCommit) asks for clearPrimaryJobRoleForMember;
//   - the legacy payroll (processDueJobs) asks for removeJobRoleForMember and ignores the answer.
// Only a synthetic coin database in a temporary directory is used, and every Discord object is an in-memory fake.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-work-role-host-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.BOT_OWNER_ID = 'owner-user';

const {
  getCoinDatabasePath,
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const workService = require('../src/services/workService');
const logger = require('../src/utils/logger');

const GUILD_ID = '740000000000000001';
const OTHER_GUILD_ID = '740000000000000002';
const ADMIN_ID = '740000000000000010';
const BOT_ID = '740000000000000099';
const FAILURE_REPLY = '系統暫時無法處理吉幣資料，請稍後再試。';

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// The logger is silenced while the callback runs. Returns what the callback returned and every line logged.
async function withQuietLogs(run) {
  const lines = [];
  const original = { info: logger.info, warn: logger.warn, error: logger.error };
  for (const level of ['info', 'warn', 'error']) {
    logger[level] = (...args) => { lines.push([level, ...args]); };
  }
  try {
    return { value: await run(), lines };
  } finally {
    Object.assign(logger, original);
  }
}

// A bare stand-in for the extension host. `answer` is the reply of runHook (or a function computing it); every call is
// recorded with all of its arguments.
function recordingHost(answer = []) {
  const calls = [];
  return {
    calls,
    async runHook(...args) {
      calls.push(args);
      return typeof answer === 'function' ? answer(...args) : answer;
    },
  };
}

const answers = (...results) => results.map((result, index) => ({ extensionId: `extension-${index}`, result }));

function createMember(id) {
  return { id, toString: () => `<@${id}>` };
}

function createGuild(memberIds = [], id = GUILD_ID) {
  const members = new Map(memberIds.map((memberId) => [memberId, createMember(memberId)]));
  return {
    id,
    members: {
      me: { id: BOT_ID, permissions: { has: () => true } },
      fetch: async (userId) => members.get(userId) ?? null,
    },
    memberOf: (userId) => members.get(userId),
  };
}

// A /work subcommand run by a server administrator. Replies are collected in order.
function runWorkSubcommand(command, { subcommand, client, guild }) {
  const replies = [];
  const interaction = {
    client,
    guild,
    guildId: guild.id,
    channelId: 'room',
    commandName: 'work',
    user: { id: ADMIN_ID },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    inGuild: () => true,
    options: { getSubcommand: () => subcommand, getUser: () => null },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => { replies.push(payload); },
    reply: async (payload) => { replies.push(payload); },
  };
  return withQuietLogs(() => command.execute(interaction)).then(({ lines }) => ({ replies, lines }));
}

const workCommand = require('../src/commands/work');

// ---- /work role-sync without a user: syncAllJobRoles ------------------------------------------

test('/work role-sync asks the host for workRole.syncAllJobRoles with the guild only', async () => {
  const guild = createGuild();
  const summary = { total: 3, synced: 2, cleaned: 1, warnings: ['first warning'] };
  const host = recordingHost(answers(undefined, summary, { total: 9, synced: 9, warnings: [] }));

  const { replies } = await runWorkSubcommand(workCommand, { subcommand: 'role-sync', client: { extensionHost: host }, guild });

  // One call, two arguments: the full hook name and a payload that holds the guild and nothing else.
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].length, 2);
  assert.equal(host.calls[0][0], 'workRole.syncAllJobRoles');
  assert.deepEqual(Object.keys(host.calls[0][1]), ['guild']);
  assert.equal(host.calls[0][1].guild, guild);
  // The first answer that is not undefined is the one that counts; a later extension is not read.
  assert.deepEqual(replies, [['工作身分組同步完成：2/3', '已清理結束週期角色：1', '**身分組提醒**', '• first warning'].join('\n')]);
});

test('/work role-sync says the sync is paused, not complete, when the extension stopped it early', async () => {
  const guild = createGuild();
  const stopReason = '身分組變更已達上限，請稍後再同步。';
  const stopped = [
    // The request boundary deferred a role change for its budget.
    { total: 5, synced: 2, cleaned: 1, warnings: [stopReason, 'later warning'], rateLimited: true },
    // The guild's role queue was too long to wait for; the stop reason goes first as well.
    { total: 5, synced: 2, warnings: [stopReason], rateLimited: true, queueFull: true },
    // Either flag alone is enough.
    { total: 5, synced: 2, warnings: [stopReason], queueFull: true },
  ];

  for (const summary of stopped) {
    const host = recordingHost(answers(summary));
    const { replies } = await runWorkSubcommand(workCommand, { subcommand: 'role-sync', client: { extensionHost: host }, guild });
    assert.equal(replies.length, 1);
    const lines = replies[0].split('\n');
    assert.equal(lines[0], '工作身分組同步已暫停，尚未全部完成：2/5', JSON.stringify(summary));
    assert.doesNotMatch(replies[0], /同步完成/u);
    // The reason the extension gave stays the first warning.
    assert.equal(lines[lines.indexOf('**身分組提醒**') + 1], `• ${stopReason}`);
  }
});

test('/work role-sync keeps the complete title when the stop flags are absent or false', async () => {
  const guild = createGuild();
  for (const flags of [{}, { rateLimited: false }, { queueFull: false }, { rateLimited: false, queueFull: false }]) {
    const host = recordingHost(answers({ total: 4, synced: 4, warnings: [], ...flags }));
    const { replies } = await runWorkSubcommand(workCommand, { subcommand: 'role-sync', client: { extensionHost: host }, guild });
    assert.deepEqual(replies, ['工作身分組同步完成：4/4'], JSON.stringify(flags));
  }
});

test('/work role-sync falls back to the empty summary when the first defined answer is falsy, or no host answers', async () => {
  const guild = createGuild();
  const empty = ['工作身分組同步完成：0/0'];
  const later = { total: 5, synced: 5, warnings: [] };

  // The first defined answer wins even when it is falsy, and then the default replaces it.
  for (const falsy of [null, 0, '', false]) {
    const host = recordingHost(answers(undefined, falsy, later));
    const { replies } = await runWorkSubcommand(workCommand, { subcommand: 'role-sync', client: { extensionHost: host }, guild });
    assert.deepEqual(replies, empty, `a first defined answer of ${JSON.stringify(falsy)}`);
    assert.equal(host.calls.length, 1);
  }
  // No extension has the hook, or none answers.
  for (const noAnswer of [[], answers(undefined, undefined)]) {
    const { replies } = await runWorkSubcommand(workCommand, {
      subcommand: 'role-sync', client: { extensionHost: recordingHost(noAnswer) }, guild,
    });
    assert.deepEqual(replies, empty);
  }
  // A client with no host at all, or a host property that is not set, is the same as an empty host.
  for (const client of [{}, { extensionHost: undefined }, { extensionHost: null }]) {
    const { replies } = await runWorkSubcommand(workCommand, { subcommand: 'role-sync', client, guild });
    assert.deepEqual(replies, empty);
  }
});

test('a host that fails during /work role-sync reaches the command\'s own error handling', async () => {
  const failure = new Error('synthetic host failure');
  const host = recordingHost(() => { throw failure; });

  const { replies, lines } = await runWorkSubcommand(workCommand, {
    subcommand: 'role-sync', client: { extensionHost: host }, guild: createGuild(),
  });

  assert.deepEqual(replies, [FAILURE_REPLY]);
  const logged = lines.filter(([level]) => level === 'error');
  assert.equal(logged.length, 1);
  assert.equal(logged[0][1], '/work coin command failed');
  assert.equal(logged[0][2], failure);
});

// ---- /work cancel: resigning is not offered -----------------------------------------------------

test('/work cancel only explains that resigning is not offered and asks the host for nothing', async () => {
  const refusal = { content: '目前不開放辭職。已開始的工作會在選定的天數期滿時自動結算薪水並結束。', ephemeral: true };
  const guild = createGuild([ADMIN_ID]);

  const host = recordingHost(answers({ ok: false, warnings: ['never read'] }));
  const withHost = await runWorkSubcommand(workCommand, { subcommand: 'cancel', client: { extensionHost: host }, guild });
  assert.deepEqual(withHost.replies, [refusal]);
  assert.deepEqual(host.calls, []);

  // A client with no host at all gets the same reply.
  const bare = await runWorkSubcommand(workCommand, { subcommand: 'cancel', client: {}, guild });
  assert.deepEqual(bare.replies, [refusal]);

  // The command answers by itself, not through an error: nothing is logged as a failure.
  assert.deepEqual(withHost.lines.filter(([level]) => level === 'error'), []);

  // The command has no path left that would remove job roles on resigning.
  assert.doesNotMatch(fs.readFileSync(require.resolve('../src/commands/work'), 'utf8'), /removeJobRolesForMember/u);
  // cancelJob refuses with the same text the command replies with.
  assert.equal(refusal.content, workService.RESIGNATION_UNAVAILABLE_MESSAGE);
  await assert.rejects(workService.cancelJob(), (error) => error.code === 'WORK_CUTOVER_CANCEL_REVIEW' &&
    error.message === refusal.content);
});

test('/work cancel replies with the refusal even if cancelJob were to return without refusing', async () => {
  const commandPath = require.resolve('../src/commands/work');
  const realCancelJob = workService.cancelJob;
  let standInCalls = 0;
  delete require.cache[commandPath];
  workService.cancelJob = async () => { standInCalls += 1; return { jobName: '合成職業甲' }; };
  try {
    const command = require(commandPath);
    const { replies } = await runWorkSubcommand(command, { subcommand: 'cancel', client: {}, guild: createGuild([ADMIN_ID]) });
    assert.deepEqual(replies, [{ content: workService.RESIGNATION_UNAVAILABLE_MESSAGE, ephemeral: true }]);
    assert.equal(standInCalls, 0);
  } finally {
    workService.cancelJob = realCancelJob;
    delete require.cache[commandPath];
  }
});

// ---- The primary-cycle cleanup: clearPrimaryJobRoleForMember ----------------------------------

const IDENTITY = Object.freeze({ cycleId: 'synthetic-cycle-1', userId: '740000000000000011', sourceGuildId: GUILD_ID });

test('the primary-cycle cleanup asks the host with the client and the three identity fields, and nothing more', async () => {
  const host = recordingHost([]);
  const client = { extensionHost: host };

  await workService.runPrimaryRoleCleanupAfterCommit(client, { ...IDENTITY, calculated: { paid: 1 }, extra: 'ignored' });

  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].length, 2);
  assert.equal(host.calls[0][0], 'workRole.clearPrimaryJobRoleForMember');
  assert.deepEqual(Object.keys(host.calls[0][1]).sort(), ['client', 'cycleId', 'sourceGuildId', 'userId']);
  assert.equal(host.calls[0][1].client, client);
  assert.deepEqual({ ...host.calls[0][1], client: undefined }, { ...IDENTITY, client: undefined });
});

test('the primary-cycle cleanup returns the first defined answer, or a fresh { skipped: true }', async () => {
  const run = (answer) => workService.runPrimaryRoleCleanupAfterCommit({ extensionHost: recordingHost(answer) }, IDENTITY);
  const winner = { ok: false, warnings: ['cleanup needs a look'] };

  assert.equal(await run(answers(undefined, winner, { ok: true })), winner);
  // A falsy first defined answer is replaced by the default; a later extension is not read.
  for (const falsy of [null, 0, '', false]) {
    assert.deepEqual(await run(answers(undefined, falsy, winner)), { skipped: true });
  }
  assert.deepEqual(await run([]), { skipped: true });
  assert.deepEqual(await run(answers(undefined)), { skipped: true });
  // Every call gets its own default object.
  assert.notEqual(await run([]), await run([]));
});

test('the primary-cycle cleanup asks nobody without a client, and a client with no host asks an empty one', async () => {
  const unreachable = recordingHost(() => { throw new Error('must not be asked'); });
  for (const client of [null, undefined, 0, '']) {
    assert.deepEqual(await workService.runPrimaryRoleCleanupAfterCommit(client, IDENTITY, {
      runHook: unreachable.runHook,
    }), { skipped: true });
  }
  assert.equal(unreachable.calls.length, 0);

  for (const client of [{}, { extensionHost: undefined }, { extensionHost: null }]) {
    assert.deepEqual(await workService.runPrimaryRoleCleanupAfterCommit(client, IDENTITY), { skipped: true });
  }
});

test('the primary-cycle cleanup passes a failing host on to its caller, whether the host throws or rejects', async () => {
  const failure = new Error('synthetic host failure');
  const rejecting = { extensionHost: { runHook: async () => { throw failure; } } };
  const throwing = { extensionHost: { runHook: () => { throw failure; } } };

  await assert.rejects(workService.runPrimaryRoleCleanupAfterCommit(rejecting, IDENTITY), (error) => error === failure);
  await assert.rejects(workService.runPrimaryRoleCleanupAfterCommit(throwing, IDENTITY), (error) => error === failure);
});

test('the primary-cycle cleanup runs an injected runner in place of the host, with the full hook name and the payload', async () => {
  const client = {};
  const seen = [];
  const runHook = async (...args) => { seen.push(args); return answers(undefined, { ok: true }); };

  assert.deepEqual(await workService.runPrimaryRoleCleanupAfterCommit(client, IDENTITY, { runHook }), { ok: true });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 2);
  assert.equal(seen[0][0], 'workRole.clearPrimaryJobRoleForMember');
  assert.deepEqual(seen[0][1], { client, ...IDENTITY });
});

// ---- The legacy payroll: removeJobRoleForMember -----------------------------------------------

// Date is frozen for the whole test; the product code reads new Date() in many places.
function startClock(t, startIso) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(startIso) });
  return { at: (isoString) => t.mock.timers.setTime(Date.parse(isoString)) };
}

async function openSyntheticDatabase() {
  resetCoinDatabaseForTests();
  const databasePath = getCoinDatabasePath();
  const relative = path.relative(root, databasePath);
  assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative),
    `synthetic data must stay inside the temporary test root: ${databasePath}`);
  fs.rmSync(databasePath, { force: true });
  fs.rmSync(`${databasePath}.tmp`, { force: true });
  await withQuietLogs(() => initializeNewCoinDatabase({ expectedPath: databasePath }));
}

// A guild-scoped job row as it existed before the global work cutover, which the product can no longer create.
async function insertLegacyJob(userId, guildId) {
  return withCoinTransaction((api) => {
    api.run(
      `INSERT INTO coin_jobs (
        guild_id, user_id, job_name, job_role_id, daily_salary, work_days, total_salary,
        status, is_paid, start_at, pay_at, last_contribution_at, today_task_count,
        today_completed_task_count, no_work_available_today, payroll_status, created_at, updated_at
      ) VALUES (?, ?, '服務生', NULL, 0, 2, 0, 'active', 0, ?, ?, NULL, 0, 0, 0, 'pending', ?, ?)`,
      [guildId, userId, '2026-03-01T01:00:00.000Z', '2026-03-03T14:00:00.000Z', '2026-03-01T01:00:00.000Z', '2026-03-01T01:00:00.000Z']
    );
    return Number(api.get('SELECT last_insert_rowid() AS id').id);
  });
}

// Opens a database holding one due legacy job per [userId, guildId], then runs the payroll with the client `makeClient`
// builds. Returns the job ids, the payroll result and what was logged.
async function runLegacyPayroll(t, jobs, makeClient) {
  const clock = startClock(t, '2026-03-01T01:00:00.000Z');
  await openSyntheticDatabase();
  const jobIds = [];
  for (const [userId, guildId] of jobs) jobIds.push(await insertLegacyJob(userId, guildId));
  clock.at('2026-03-02T04:00:00.000Z');
  await withQuietLogs(() => workService.captureLegacyJobBatch());
  clock.at('2026-03-03T14:00:00.000Z');
  const { value: payroll, lines } = await withQuietLogs(() => workService.processDueJobs(makeClient()));
  const paid = await withCoinDatabase((api) => api.all('SELECT job_id FROM coin_payroll_history ORDER BY job_id'));
  return { jobIds, payroll, lines, paidJobIds: paid.map((row) => row.job_id) };
}

const USERS = Object.freeze({
  array: '740000000000000031',
  nothing: '740000000000000032',
  failing: '740000000000000033',
  elsewhere: '740000000000000034',
});

test('the legacy payroll asks the host with the member and the job name, reads no answer, and warns only when the host fails', async (t) => {
  const guild = createGuild([USERS.array, USERS.nothing, USERS.failing]);
  const failure = new Error('synthetic host failure');
  const host = recordingHost((name, payload) => {
    // One answer per member: an array that is ignored, nothing at all (not even an array), and a failure.
    if (payload.member.id === USERS.array) return answers({ ok: false, warnings: ['ignored'] });
    if (payload.member.id === USERS.failing) throw failure;
    return undefined;
  });
  let guildLookups = 0;
  const client = {
    extensionHost: host,
    guilds: {
      fetch: async (guildId) => {
        guildLookups += 1;
        // The guild of the last job cannot be fetched.
        if (guildId === OTHER_GUILD_ID) throw new Error('unknown guild');
        return guildId === GUILD_ID ? guild : null;
      },
    },
  };

  const run = await runLegacyPayroll(t, [
    [USERS.array, GUILD_ID], [USERS.nothing, GUILD_ID], [USERS.failing, GUILD_ID], [USERS.elsewhere, OTHER_GUILD_ID],
  ], () => client);

  assert.deepEqual([run.payroll.processed, run.payroll.success, run.payroll.fail], [4, 4, 0]);
  assert.deepEqual(run.paidJobIds, run.jobIds);
  assert.equal(guildLookups, 4);
  // Three members were asked, once each, with two arguments: the full hook name and { member, jobName }.
  const asked = host.calls.slice().sort((left, right) => left[1].member.id.localeCompare(right[1].member.id));
  assert.deepEqual(asked.map((args) => args.length), [2, 2, 2]);
  assert.deepEqual(asked.map(([name]) => name), Array(3).fill('workRole.removeJobRoleForMember'));
  assert.deepEqual(asked.map(([, payload]) => Object.keys(payload)), Array(3).fill(['member', 'jobName']));
  assert.deepEqual(asked.map(([, payload]) => payload.jobName), Array(3).fill('服務生'));
  assert.deepEqual(asked.map(([, payload]) => payload.member), [USERS.array, USERS.nothing, USERS.failing].map(guild.memberOf));
  // The answer is not read: an array of answers, or no array at all, raises nothing. Only the failure is logged.
  const warnings = run.lines.filter(([level]) => level === 'warn');
  assert.deepEqual(warnings.map(([, message]) => message), [`發薪後移除工作身分組失敗：job=${run.jobIds[2]}`]);
  assert.equal(warnings[0][2], failure);
});

test('the legacy payroll without a host on the client pays and asks nobody', async (t) => {
  const guild = createGuild([USERS.array]);
  const run = await runLegacyPayroll(t, [[USERS.array, GUILD_ID]], () => ({
    guilds: { fetch: async () => guild },
  }));

  assert.deepEqual([run.payroll.processed, run.payroll.success, run.payroll.fail], [1, 1, 0]);
  assert.deepEqual(run.paidJobIds, run.jobIds);
  assert.deepEqual(run.lines.filter(([level]) => level === 'warn'), []);
});

test('the legacy payroll without a client pays and asks nobody', async (t) => {
  const run = await runLegacyPayroll(t, [[USERS.array, GUILD_ID]], () => null);

  assert.deepEqual([run.payroll.processed, run.payroll.success, run.payroll.fail], [1, 1, 0]);
  assert.deepEqual(run.paidJobIds, run.jobIds);
  assert.deepEqual(run.lines.filter(([level]) => level === 'warn'), []);
});
