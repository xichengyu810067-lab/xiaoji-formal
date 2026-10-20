'use strict';

// How the /work command and the work system ask extensions about job roles.
//
// src/coordinators/workRoleCoordinator.js is the one place that asks the extension host. The /work command loads it
// directly. The work system does not load coordinators, so the assembly root hands the process's coordinator to
// src/systems/work/workRolePort.js once and the work system asks through that port; until a coordinator is configured the
// port asks the extension host that the client carries, which is what the work system did before there was a port.
// The tests cover:
//   - the coordinator, which answers exactly as the code it replaced did for every kind of reply a host can give;
//   - the port: configured once, the same coordinator again is fine, a different one is refused, and the default;
//   - the two work-system sites (the primary-cycle cleanup and the legacy payroll) asking through the port, and the
//     /work command not going through it;
//   - the assembly: the real src/index.js hands the work system the very coordinator the /work command uses.
// What the extension receives at each site is pinned by test/extensionScopePins.test.js and test/workRoleHostCalls.test.js.
// Only a synthetic coin database in a temporary directory is used, and the one test that starts src/index.js blocks the
// network first and never logs in.

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-work-role-coordinator-'));
process.env.COIN_DB_PATH = path.join(root, 'synthetic.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';
process.env.XIAOJI_AUDIT_DATA_PATH = path.join(root, 'guildAudit.json');
process.env.XIAOJI_INVITER_WHITELIST_PATH = path.join(root, 'inviterWhitelist.json');
process.env.BOT_OWNER_ID = 'owner-user';

const { createWorkRoleCoordinator, workRoleCoordinator } = require('../src/coordinators/workRoleCoordinator');
const { createExtensionHost, getClientExtensionHost } = require('../src/extensions/extensionHost');
const {
  getCoinDatabasePath,
  initializeNewCoinDatabase,
  resetCoinDatabaseForTests,
  withCoinDatabase,
  withCoinTransaction,
} = require('../src/services/coinDatabase');
const workCommand = require('../src/commands/work');
const workService = require('../src/systems/work/workService');
const {
  configureWorkRoleCoordinator,
  getWorkRoleCoordinator,
  resetWorkRoleCoordinatorForTests,
} = require('../src/systems/work/workRolePort');
const logger = require('../src/utils/logger');

const PROJECT_ROOT = path.join(__dirname, '..');
const GUILD_ID = '750000000000000001';
const ADMIN_ID = '750000000000000010';
const PAID_USER_ID = '750000000000000031';
const BOT_ID = '750000000000000099';
const DEFAULT_ROLE_RESULT = Object.freeze({ ok: true, skipped: true, role: null, warnings: [] });
const FAILURE = new Error('synthetic host failure');

test.afterEach(() => {
  resetWorkRoleCoordinatorForTests();
});

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

const answers = (...results) => results.map((result, index) => ({ extensionId: `extension-${index}`, result }));

// A bare stand-in for the extension host that records every runHook call with all of its arguments.
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

// The same stand-in written as a plain function: its reply is returned as it is (or thrown at once), never wrapped in a
// promise of its own.
function plainHost(answer = []) {
  const calls = [];
  return {
    calls,
    runHook(...args) {
      calls.push(args);
      return typeof answer === 'function' ? answer(...args) : answer;
    },
  };
}
const HOST_KINDS = Object.freeze({ 'an async host': recordingHost, 'a plain host': plainHost });

// What a call did: it returned a value, threw at once, or returned a promise that rejected.
async function settle(call) {
  let pending;
  try {
    pending = call();
  } catch (error) {
    return { thrown: error };
  }
  try {
    return { value: await pending };
  } catch (error) {
    return { rejected: error };
  }
}

// Every kind of reply a host can give. Each is a function from (name, payload) to the host's reply.
const HOST_REPLIES = Object.freeze({
  'no extension has the hook': () => [],
  'an extension that answers undefined': () => answers(undefined),
  'two answers': () => answers(undefined, { ok: false, warnings: ['first'] }, { ok: true }),
  'a null first answer': () => answers(null, { ok: true }),
  'a zero first answer': () => answers(0, { ok: true }),
  'an empty text first answer': () => answers('', { ok: true }),
  'a truthy primitive': () => answers('text'),
  'an empty object': () => answers({}),
  'a reply that is not an array': () => undefined,
  'a rejection': async () => { throw FAILURE; },
  'a throw': () => { throw FAILURE; },
});

// ---- The coordinator --------------------------------------------------------------------------

test('the coordinator is a frozen object with three functions, made once for the process, and a factory makes more', () => {
  assert.deepEqual(Object.keys(workRoleCoordinator).sort(), ['hasWorkRoleHook', 'runHook', 'runWorkRoleHook']);
  assert.ok(Object.isFrozen(workRoleCoordinator));
  const another = createWorkRoleCoordinator();
  assert.ok(Object.isFrozen(another));
  assert.notEqual(another, workRoleCoordinator);
  assert.equal(require('../src/coordinators/workRoleCoordinator').workRoleCoordinator, workRoleCoordinator);
});

test('runHook asks the host of the client with the hook name and payload as given, and returns what the host returns', async () => {
  const payload = { member: 'synthetic member' };
  const reply = Promise.resolve(answers({ ok: true }));
  const seen = [];
  const client = { extensionHost: { runHook(...args) { seen.push(args); return reply; } } };

  assert.equal(workRoleCoordinator.runHook(client, 'workRole.someHook', payload), reply);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 2);
  assert.equal(seen[0][0], 'workRole.someHook');
  assert.equal(seen[0][1], payload);
});

test('runHook reaches the extensions of a real host in their order, and asks an empty host when the client has none', async () => {
  const payload = {};
  const order = [];
  const client = {
    extensionHost: createExtensionHost([
      { id: 'one', hooks: { workRole: { removeJobRoleForMember: async (given) => { order.push(['one', given]); return { from: 'one' }; } } } },
      { id: 'without', hooks: {} },
      { id: 'two', hooks: { workRole: { removeJobRoleForMember: (given) => { order.push(['two', given]); } } } },
    ]),
  };

  assert.deepEqual(await workRoleCoordinator.runHook(client, 'workRole.removeJobRoleForMember', payload), [
    { extensionId: 'one', result: { from: 'one' } },
    { extensionId: 'two', result: undefined },
  ]);
  assert.deepEqual(order.map(([id]) => id), ['one', 'two']);
  assert.ok(order.every(([, given]) => given === payload));

  for (const bare of [{}, { extensionHost: undefined }, { extensionHost: null }, null, undefined]) {
    assert.deepEqual(await workRoleCoordinator.runHook(bare, 'workRole.removeJobRoleForMember', payload), []);
  }
});

test('runHook does not wrap a host that throws at once: the caller sees the throw where it called', () => {
  const client = { extensionHost: { runHook() { throw FAILURE; } } };

  assert.throws(() => workRoleCoordinator.runHook(client, 'workRole.someHook', {}), (error) => error === FAILURE);
});

test('runWorkRoleHook adds the workRole. prefix and passes the payload on as given, with nothing else', async () => {
  const payload = { guild: 'synthetic guild' };
  const host = recordingHost(answers({ total: 1 }));

  assert.deepEqual(await workRoleCoordinator.runWorkRoleHook({ extensionHost: host }, 'syncAllJobRoles', payload), { total: 1 });

  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0].length, 2);
  assert.equal(host.calls[0][0], 'workRole.syncAllJobRoles');
  assert.equal(host.calls[0][1], payload);
});

test('runWorkRoleHook returns the first answer that is not undefined, and the default when that answer is falsy or missing', async () => {
  const run = (reply, ...rest) => workRoleCoordinator.runWorkRoleHook({ extensionHost: recordingHost(reply) }, 'someHook', {}, ...rest);
  const winner = { ok: false, warnings: ['look at this'] };

  assert.equal(await run(answers(undefined, winner, { ok: true })), winner);
  assert.equal(await run(answers('text')), 'text');
  for (const falsy of [null, 0, '', false]) {
    assert.deepEqual(await run(answers(undefined, falsy, winner)), DEFAULT_ROLE_RESULT, `a first defined answer of ${JSON.stringify(falsy)}`);
  }
  assert.deepEqual(await run([]), DEFAULT_ROLE_RESULT);
  assert.deepEqual(await run(answers(undefined, undefined)), DEFAULT_ROLE_RESULT);
  // A client with no host asks an empty one.
  for (const bare of [{}, { extensionHost: null }, null, undefined]) {
    assert.deepEqual(await workRoleCoordinator.runWorkRoleHook(bare, 'someHook', {}), DEFAULT_ROLE_RESULT);
  }
});

test('the default answer of runWorkRoleHook is a fresh object on each call, and a given default is returned as it is', async () => {
  const run = (...rest) => workRoleCoordinator.runWorkRoleHook({}, 'someHook', {}, ...rest);

  const first = await run();
  first.warnings.push('changed by the caller');
  first.skipped = false;
  const second = await run();
  assert.deepEqual(second, DEFAULT_ROLE_RESULT);
  assert.notEqual(second, first);
  assert.notEqual(second.warnings, first.warnings);

  const given = { total: 0, synced: 0, warnings: [], skipped: true };
  assert.equal(await run(given), given);
  // undefined asks for the default; null does not.
  assert.deepEqual(await run(undefined), DEFAULT_ROLE_RESULT);
  assert.equal(await run(null), null);
});

test('runWorkRoleHook answers for every kind of host reply exactly as the /work helper it replaced did', async () => {
  // The helper src/commands/work.js defined before the coordinator took it over, word for word.
  async function replacedHelper(client, hookName, payload, fallback = { ok: true, skipped: true, role: null, warnings: [] }) {
    const results = await getClientExtensionHost(client).runHook(`workRole.${hookName}`, payload);
    return results.find((item) => item.result !== undefined)?.result || fallback;
  }
  const payload = { member: 'synthetic member' };
  const fallbacks = [[], [{ total: 0, synced: 0, warnings: [], skipped: true }]];

  for (const [kind, makeHost] of Object.entries(HOST_KINDS)) {
    for (const [label, reply] of Object.entries(HOST_REPLIES)) {
      for (const fallbackArgs of fallbacks) {
        const name = `${kind}, ${label}`;
        const before = makeHost(reply);
        const after = makeHost(reply);
        const expected = await settle(() => replacedHelper({ extensionHost: before }, 'someHook', payload, ...fallbackArgs));
        const actual = await settle(() => workRoleCoordinator.runWorkRoleHook({ extensionHost: after }, 'someHook', payload, ...fallbackArgs));

        assert.deepEqual(Object.keys(actual), Object.keys(expected), name);
        if ('value' in expected) {
          assert.deepEqual(actual.value, expected.value, name);
        } else {
          // Only a reply that is not an array fails in the helper itself; the other failures are the host's own.
          assert.equal(actual.rejected.constructor, expected.rejected.constructor, name);
          assert.equal(actual.rejected.message, expected.rejected.message, name);
        }
        assert.deepEqual(after.calls, before.calls, name);
      }
    }
  }
});

// ---- The port ---------------------------------------------------------------------------------

test('with no coordinator configured, the port asks the extension host the client carries, as the work system always did', async () => {
  const fallback = getWorkRoleCoordinator();
  assert.equal(typeof fallback.runHook, 'function');
  assert.ok(Object.isFrozen(fallback));
  assert.notEqual(fallback, workRoleCoordinator);
  const payload = { member: 'synthetic member' };
  const reply = Promise.resolve(answers({ ok: true }));
  const seen = [];
  const client = { extensionHost: { runHook(...args) { seen.push(args); return reply; } } };

  assert.equal(fallback.runHook(client, 'workRole.someHook', payload), reply);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 2);
  assert.equal(seen[0][0], 'workRole.someHook');
  assert.equal(seen[0][1], payload);
  // No host on the client: nobody answers and nothing is thrown.
  for (const bare of [{}, { extensionHost: undefined }, { extensionHost: null }, null, undefined]) {
    assert.deepEqual(await fallback.runHook(bare, 'workRole.someHook', payload), []);
  }
  // The port holds no coordinator of its own: it is the same default each time, until one is configured.
  assert.equal(getWorkRoleCoordinator(), fallback);
});

test('the port default and the coordinator give the same outcome for every kind of host reply', async () => {
  const payload = { member: 'synthetic member' };
  const defaultRoles = getWorkRoleCoordinator();

  for (const [kind, makeHost] of Object.entries(HOST_KINDS)) {
    for (const [label, reply] of Object.entries(HOST_REPLIES)) {
      const name = `${kind}, ${label}`;
      const viaDefault = makeHost(reply);
      const viaCoordinator = makeHost(reply);
      const viaHost = makeHost(reply);
      const expected = await settle(() => getClientExtensionHost({ extensionHost: viaHost }).runHook('workRole.someHook', payload));
      const fromDefault = await settle(() => defaultRoles.runHook({ extensionHost: viaDefault }, 'workRole.someHook', payload));
      const fromCoordinator = await settle(() => workRoleCoordinator.runHook({ extensionHost: viaCoordinator }, 'workRole.someHook', payload));

      assert.deepEqual(fromDefault, expected, name);
      assert.deepEqual(fromCoordinator, expected, name);
      assert.deepEqual(viaDefault.calls, viaHost.calls, name);
      assert.deepEqual(viaCoordinator.calls, viaHost.calls, name);
    }
  }
});

test('the port takes one coordinator: the same one again is fine, a different one is refused and changes nothing', () => {
  const first = { runHook() {} };
  const different = { runHook() {} };

  assert.equal(configureWorkRoleCoordinator(first), first);
  assert.equal(getWorkRoleCoordinator(), first);
  assert.equal(configureWorkRoleCoordinator(first), first);
  assert.throws(() => configureWorkRoleCoordinator(different), (error) => error.code === 'WORK_ROLE_COORDINATOR_CONFLICT'
    && /exactly one/u.test(error.message));
  assert.equal(getWorkRoleCoordinator(), first);

  // Only a reset (tests) lets another take its place.
  resetWorkRoleCoordinatorForTests();
  assert.notEqual(getWorkRoleCoordinator(), first);
  assert.equal(configureWorkRoleCoordinator(different), different);
  assert.equal(getWorkRoleCoordinator(), different);
});

test('the port refuses what is not a coordinator and keeps its default', () => {
  const before = getWorkRoleCoordinator();

  for (const notACoordinator of [null, undefined, 0, 'text', {}, { runHook: 'not a function' }, { runWorkRoleHook() {} }]) {
    assert.throws(() => configureWorkRoleCoordinator(notACoordinator), (error) => error.code === 'WORK_ROLE_COORDINATOR_INVALID'
      && /runHook function/u.test(error.message), String(notACoordinator));
  }
  assert.equal(getWorkRoleCoordinator(), before);
  // A refused one does not count as configured: the real one can still be configured.
  assert.equal(configureWorkRoleCoordinator(workRoleCoordinator), workRoleCoordinator);
});

// ---- The work system asks through the port; the /work command does not ------------------------

test('the primary-cycle cleanup asks the configured coordinator in place of the client\'s host, and the default again after a reset', async () => {
  const identity = { cycleId: 'synthetic-cycle', userId: PAID_USER_ID, sourceGuildId: GUILD_ID };
  const unreachable = recordingHost(() => { throw new Error('the client\'s host must not be asked'); });
  const client = { extensionHost: unreachable };
  const seen = [];
  const answer = { ok: false, warnings: ['cleanup needs a look'] };
  configureWorkRoleCoordinator({
    async runHook(...args) { seen.push(args); return answers(undefined, answer); },
  });

  assert.equal(await workService.runPrimaryRoleCleanupAfterCommit(client, identity), answer);

  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 3);
  assert.equal(seen[0][0], client);
  assert.equal(seen[0][1], 'workRole.clearPrimaryJobRoleForMember');
  assert.deepEqual(seen[0][2], { client, ...identity });
  assert.equal(unreachable.calls.length, 0);

  // Without a client nobody is asked, configured or not.
  assert.deepEqual(await workService.runPrimaryRoleCleanupAfterCommit(null, identity), { skipped: true });
  assert.equal(seen.length, 1);

  resetWorkRoleCoordinatorForTests();
  assert.deepEqual(await workService.runPrimaryRoleCleanupAfterCommit(client, identity, {
    runHook: undefined,
  }).catch((error) => error), new Error('the client\'s host must not be asked'));
  assert.equal(unreachable.calls.length, 1);
  assert.equal(unreachable.calls[0][0], 'workRole.clearPrimaryJobRoleForMember');
});

function createMember(id) {
  return { id, toString: () => `<@${id}>` };
}

function createGuild(memberIds = []) {
  const members = new Map(memberIds.map((memberId) => [memberId, createMember(memberId)]));
  return {
    id: GUILD_ID,
    members: {
      me: { id: BOT_ID, permissions: { has: () => true } },
      fetch: async (userId) => members.get(userId) ?? null,
    },
    memberOf: (userId) => members.get(userId),
  };
}

test('the /work command asks the coordinator it loads itself, never the port', async () => {
  const guild = createGuild();
  const host = recordingHost(answers({ total: 2, synced: 2, warnings: [] }));
  const replies = [];
  const interaction = {
    client: { extensionHost: host },
    guild,
    guildId: GUILD_ID,
    channelId: 'room',
    commandName: 'work',
    user: { id: ADMIN_ID },
    memberPermissions: { has: () => true },
    deferred: false,
    replied: false,
    inGuild: () => true,
    options: { getSubcommand: () => 'role-sync', getUser: () => null },
    deferReply: async () => { interaction.deferred = true; },
    editReply: async (payload) => { replies.push(payload); },
    reply: async (payload) => { replies.push(payload); },
  };
  // Another coordinator sits in the port; the command must not notice it.
  const seen = [];
  configureWorkRoleCoordinator({ async runHook(...args) { seen.push(args); return []; } });

  await workCommand.execute(interaction);

  assert.deepEqual(replies, ['工作身分組同步完成：2/2']);
  assert.equal(host.calls.length, 1);
  assert.equal(host.calls[0][0], 'workRole.syncAllJobRoles');
  assert.deepEqual(seen, []);
});

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
async function insertLegacyJob(userId) {
  return withCoinTransaction((api) => {
    api.run(
      `INSERT INTO coin_jobs (
        guild_id, user_id, job_name, job_role_id, daily_salary, work_days, total_salary,
        status, is_paid, start_at, pay_at, last_contribution_at, today_task_count,
        today_completed_task_count, no_work_available_today, payroll_status, created_at, updated_at
      ) VALUES (?, ?, '服務生', NULL, 0, 2, 0, 'active', 0, ?, ?, NULL, 0, 0, 0, 'pending', ?, ?)`,
      [GUILD_ID, userId, '2026-03-01T01:00:00.000Z', '2026-03-03T14:00:00.000Z', '2026-03-01T01:00:00.000Z', '2026-03-01T01:00:00.000Z']
    );
    return Number(api.get('SELECT last_insert_rowid() AS id').id);
  });
}

// Pays one due legacy job to a member the client's guild can find. Returns the job id, the payroll result and the log.
async function payOneLegacyJob(t, client) {
  const clock = startClock(t, '2026-03-01T01:00:00.000Z');
  await openSyntheticDatabase();
  const jobId = await insertLegacyJob(PAID_USER_ID);
  clock.at('2026-03-02T04:00:00.000Z');
  await withQuietLogs(() => workService.captureLegacyJobBatch());
  clock.at('2026-03-03T14:00:00.000Z');
  const { value: payroll, lines } = await withQuietLogs(() => workService.processDueJobs(client));
  const paid = await withCoinDatabase((api) => api.all('SELECT job_id FROM coin_payroll_history'));
  return { jobId, payroll, lines, paidJobIds: paid.map((row) => row.job_id) };
}

test('the legacy payroll asks the configured coordinator after paying, and a coordinator that fails never undoes the payroll', async (t) => {
  const guild = createGuild([PAID_USER_ID]);
  const unreachable = recordingHost(() => { throw new Error('the client\'s host must not be asked'); });
  const client = { extensionHost: unreachable, guilds: { fetch: async () => guild } };
  const seen = [];
  configureWorkRoleCoordinator({
    runHook(...args) {
      seen.push(args);
      return Promise.reject(FAILURE);
    },
  });

  const run = await payOneLegacyJob(t, client);

  assert.deepEqual([run.payroll.processed, run.payroll.success, run.payroll.fail], [1, 1, 0]);
  assert.deepEqual(run.paidJobIds, [run.jobId]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].length, 3);
  assert.equal(seen[0][0], client);
  assert.equal(seen[0][1], 'workRole.removeJobRoleForMember');
  assert.deepEqual(Object.keys(seen[0][2]), ['member', 'jobName']);
  assert.equal(seen[0][2].member, guild.memberOf(PAID_USER_ID));
  assert.equal(seen[0][2].jobName, '服務生');
  assert.equal(unreachable.calls.length, 0);
  // The failure of the coordinator is a warning with the job id, nothing more.
  const warnings = run.lines.filter(([level]) => level === 'warn');
  assert.deepEqual(warnings.map(([, message]) => message), [`發薪後移除工作身分組失敗：job=${run.jobId}`]);
  assert.equal(warnings[0][2], FAILURE);
});

// ---- The assembly -----------------------------------------------------------------------------

// Loaded with --require before src/index.js: no socket can open, no Discord request is answered, and login is a probe.
// The coordinator the module exports is replaced by a recording stand-in that forwards every call to the real one,
// before index.js takes it from the module, and the setter of the work system's port is wrapped too. So the process
// makes no other coordinator, and everything that asks about job roles is seen: the probe asks the work system through
// its port and runs the real /work command loaded by the command loader. The data preflight, which needs a fully
// initialized data directory, is skipped.
const ASSEMBLY_PRELOAD = String.raw`'use strict';
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const blocked = () => { throw new Error('XIAOJI_TEST_NETWORK_BLOCKED'); };
net.connect = blocked;
net.createConnection = blocked;
net.Socket.prototype.connect = blocked;
tls.connect = blocked;
dns.lookup = (hostname, options, callback) => {
  const done = typeof options === 'function' ? options : callback;
  process.nextTick(() => done(new Error('XIAOJI_TEST_NETWORK_BLOCKED')));
};
const path = require('node:path');
const root = process.env.XIAOJI_STARTUP_TEST_ROOT;
const { REST } = require(require.resolve('@discordjs/rest', { paths: [root] }));
REST.prototype.request = async function blockedRequest() { throw new Error('XIAOJI_TEST_REST_BLOCKED'); };
const { Client } = require(require.resolve('discord.js', { paths: [root] }));

const coordinatorModule = require(path.join(root, 'src', 'coordinators', 'workRoleCoordinator.js'));
const real = coordinatorModule.workRoleCoordinator;
const seen = [];
const recording = Object.freeze({
  runHook(...args) { seen.push('runHook'); return real.runHook(...args); },
  runWorkRoleHook(...args) { seen.push('runWorkRoleHook'); return real.runWorkRoleHook(...args); },
});
coordinatorModule.workRoleCoordinator = recording;
const port = require(path.join(root, 'src', 'systems', 'work', 'workRolePort.js'));
const configure = port.configureWorkRoleCoordinator;
const configured = [];
port.configureWorkRoleCoordinator = function recordedConfigure(coordinator) {
  configured.push(coordinator);
  return configure.call(this, coordinator);
};

Client.prototype.login = async function reportingLogin() {
  const report = { configurations: configured.length, givenIsTheRecordingInstance: configured[0] === recording };
  try {
    report.portHoldsIt = port.getWorkRoleCoordinator() === recording;

    // The work system asks through the port.
    const workService = require(path.join(root, 'src', 'systems', 'work', 'workService.js'));
    const hostCalls = [];
    const client = { extensionHost: { runHook: async (...args) => { hostCalls.push(args[0]); return []; } } };
    seen.length = 0;
    const cleanup = await workService.runPrimaryRoleCleanupAfterCommit(client, { cycleId: 'c', userId: 'u', sourceGuildId: 'g' });
    report.cleanup = { result: cleanup, viaCoordinator: seen.slice(), hostAsked: hostCalls.slice() };

    // The /work command, as the command loader loaded it, asks the same object.
    seen.length = 0;
    const replies = [];
    const guild = {
      id: 'synthetic-guild',
      members: { me: { id: 'bot', permissions: { has: () => true } }, fetch: async () => null },
    };
    const interaction = {
      client: this,
      guild,
      guildId: guild.id,
      commandName: 'work',
      user: { id: process.env.BOT_OWNER_ID },
      memberPermissions: { has: () => true },
      deferred: false,
      replied: false,
      inGuild: () => true,
      options: { getSubcommand: () => 'role-sync', getUser: () => null },
      deferReply: async () => { interaction.deferred = true; },
      editReply: async (payload) => { replies.push(payload); },
      reply: async (payload) => { replies.push(payload); },
    };
    await this.commands.get('work').execute(interaction);
    report.command = { viaCoordinator: seen.slice(), replies };

    // A second, different coordinator is refused and the first stays.
    try { port.configureWorkRoleCoordinator({ runHook() {} }); report.second = 'accepted'; } catch (error) { report.second = error.code; }
    report.stillHoldsIt = port.getWorkRoleCoordinator() === recording;
  } catch (error) {
    report.error = String(error && error.message);
  }
  process.stdout.write('XIAOJI_TEST_ROLE_ASSEMBLY ' + JSON.stringify(report) + '\n');
  throw new Error('XIAOJI_TEST_LOGIN_BLOCKED');
};
const preflightPath = require.resolve(path.join(root, 'src', 'platform', 'runtimeDataPreflight.js'));
const preflight = require(preflightPath);
require.cache[preflightPath].exports = { ...preflight, preflightRuntimeData: async () => {} };
`;
const ASSEMBLY_PARENT_KEYS = new Set([
  'COMSPEC', 'NUMBER_OF_PROCESSORS', 'OS', 'PATH', 'PATHEXT', 'PROCESSOR_ARCHITECTURE',
  'SYSTEMDRIVE', 'SYSTEMROOT', 'TEMP', 'TMP', 'TMPDIR', 'WINDIR',
]);

test('the assembly root hands the work system the very coordinator the /work command uses, once', (t) => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoji-work-role-assembly-'));
  t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
  // An empty working directory, so dotenv finds no .env file.
  const cwd = path.join(scratch, 'cwd');
  fs.mkdirSync(cwd);
  const preload = path.join(scratch, 'preload.js');
  fs.writeFileSync(preload, ASSEMBLY_PRELOAD);
  const parentEnv = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => ASSEMBLY_PARENT_KEYS.has(key.toUpperCase())));
  const token = 'synthetic-work-role-token-0123456789';

  const run = spawnSync(process.execPath, ['--require', preload, path.join(PROJECT_ROOT, 'src', 'index.js')], {
    cwd,
    encoding: 'utf8',
    shell: false,
    timeout: 120_000,
    windowsHide: true,
    env: {
      ...parentEnv,
      XIAOJI_STARTUP_TEST_ROOT: PROJECT_ROOT,
      DISCORD_TOKEN: token,
      DISCORD_CLIENT_ID: '123456789012345678',
      BOT_OWNER_ID: '323456789012345678',
    },
  });

  assert.equal(run.signal, null, 'startup must end by itself');
  const line = run.stdout.split('\n').find((candidate) => candidate.startsWith('XIAOJI_TEST_ROLE_ASSEMBLY '));
  assert.ok(line, `startup reached the login probe\n${run.stdout}\n${run.stderr}`);
  assert.deepEqual(JSON.parse(line.slice('XIAOJI_TEST_ROLE_ASSEMBLY '.length)), {
    // The port was configured once, with the instance the coordinator module exports.
    configurations: 1,
    givenIsTheRecordingInstance: true,
    portHoldsIt: true,
    // The work system asked through the port, and so reached the coordinator: its call went to the coordinator, not
    // past it to the host of the client, which the coordinator then asked once.
    cleanup: { result: { skipped: true }, viaCoordinator: ['runHook'], hostAsked: ['workRole.clearPrimaryJobRoleForMember'] },
    // The real /work command, loaded by the command loader, reached the very same object.
    command: { viaCoordinator: ['runWorkRoleHook'], replies: ['工作身分組同步完成：0/0'] },
    // A different coordinator is refused and the first one stays.
    second: 'WORK_ROLE_COORDINATOR_CONFLICT',
    stillHoldsIt: true,
  });
  assert.equal(`${run.stdout}${run.stderr}`.includes(token), false);
});
