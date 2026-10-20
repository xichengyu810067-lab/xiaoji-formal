'use strict';

// What an administrator of one server can see and do about work, against a real, temporary coin database.
// Only Discord is faked.
//
//  - The all-members work overview lists the guild's own old jobs and the global primary job of every member of the
//    guild chosen in this server, and nobody outside it. A primary job chosen in another server is left out whole
//    (no job name, no "其他伺服器" line, no ID): this server learns nothing about it. A job chosen in this server
//    keeps showing this server's ID.
//  - /work task-add assigns a duty with a deadline and a salary penalty, so it is only for a member of the server.
//    Somebody outside could never finish it here and would be penalized for it later.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { makeRealTempDir } = require('./support/realTempDir');

const root = makeRealTempDir('xiaoji-work-scope-');
process.env.COIN_DB_PATH = path.join(root, 'work.sqlite');
process.env.COIN_TIMEZONE = 'Asia/Taipei';

require('../src/utils/moderation').ensureModerationAccess = async () => ({ ok: true });

const economyCommand = require('../src/commands/economy');
const workCommand = require('../src/commands/work');
const { initializeNewCoinDatabase, resetCoinDatabaseForTests, withCoinTransaction } = require('../src/services/coinDatabase');
const workService = require('../src/services/workService');
const { count, expectNoWrites } = require('./support/coinDatabaseProbe');
const { createGuild, createSlashInteraction } = require('./support/fakeSlashInteraction');

const HOME = 'work-scope-home-guild';
const OTHER = 'work-scope-other-guild';
const OTHER_SERVER = '其他伺服器';
const NOT_A_MEMBER_FOR_TASK = '只能指派工作任務給目前在此伺服器的成員。';
const NOT_A_MEMBER = '只能查詢目前在此伺服器的成員。';

const person = (id, name) => ({ id, username: id, globalName: name });
const ADMIN = person('work-scope-admin', '管理員');
// A member whose primary job was chosen in HOME.
const LOCAL = person('work-scope-local', '本群成員');
// A member of HOME whose primary job was chosen in another server.
const TRAVELLER = person('work-scope-traveller', '旅人');
// Not a member of HOME; the primary job was chosen in another server.
const OUTSIDER = person('work-scope-outsider', '局外人');
// Members with an old job row (the pre-global kind), one in HOME and one in the other server.
const LEGACY_HOME = person('work-scope-legacy-home', '舊工作本群');
const LEGACY_OTHER = person('work-scope-legacy-other', '舊工作他群');

const ROSTER = [ADMIN.id, LOCAL.id, TRAVELLER.id, LEGACY_HOME.id, LEGACY_OTHER.id];
const homeGuild = () => createGuild(HOME, ROSTER);

// Date is frozen for the whole test; the product code reads new Date() in many places.
function startClock(t, startIso) {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(startIso) });
  return { at: (isoString) => t.mock.timers.setTime(Date.parse(isoString)) };
}

// Mirrors the pre-global job row, which the product can no longer create.
async function insertLegacyJob(guildId, userId) {
  return withCoinTransaction((api) => api.run(
    `INSERT INTO coin_jobs (
      guild_id, user_id, job_name, job_role_id, daily_salary, work_days, total_salary,
      status, is_paid, start_at, pay_at, last_contribution_at, today_task_count,
      today_completed_task_count, no_work_available_today, payroll_status, created_at, updated_at
    ) VALUES (?, ?, '服務生', NULL, 0, 2, 0, 'active', 0, ?, ?, NULL, 0, 0, 0, 'pending', ?, ?)`,
    [guildId, userId, '2026-03-01T01:00:00.000Z', '2026-03-03T14:00:00.000Z',
      '2026-03-01T01:00:00.000Z', '2026-03-01T01:00:00.000Z']
  ));
}

async function run(command, options) {
  const { interaction, replies } = createSlashInteraction(options);
  await command.execute(interaction);
  assert.equal(replies.length, 1, `${options.commandName} ${options.subcommand} gave one answer`);
  return replies[0].content;
}

const workAs = (subcommand, options = {}) => run(workCommand, {
  commandName: 'work', subcommand, guild: homeGuild(), user: ADMIN, ...options,
});
const economyAs = (subcommand, options = {}) => run(economyCommand, {
  commandName: 'economy', subcommand, guild: homeGuild(), user: ADMIN, ...options,
});

const tasksOf = (userId) =>
  count('SELECT COUNT(*) AS count FROM coin_work_tasks WHERE user_id = ?', [userId]);

test.before(async () => {
  await initializeNewCoinDatabase({ expectedPath: process.env.COIN_DB_PATH });
});

test.after(() => {
  resetCoinDatabaseForTests();
  fs.rmSync(root, { recursive: true, force: true });
});

// One story for every check below: three people choose a primary job (one in HOME, two in the other server),
// the scheduler activates them, and two old jobs exist, one in each server.
test('the work overviews and /work task-add stay inside the server', async (t) => {
  const clock = startClock(t, '2026-03-02T01:00:00.000Z');
  await insertLegacyJob(HOME, LEGACY_HOME.id);
  await insertLegacyJob(OTHER, LEGACY_OTHER.id);
  await workService.startJob(HOME, LOCAL.id, '會計師', 7);
  await workService.startJob(OTHER, TRAVELLER.id, '老師', 7);
  await workService.startJob(OTHER, OUTSIDER.id, '翻譯官', 7);
  clock.at('2026-03-02T14:00:00.000Z');
  const { activations } = await workService.processDueJobs(null);
  assert.deepEqual(activations, { checked: 3, activated: 3 });
  clock.at('2026-03-03T01:00:00.000Z');

  await t.test('getAllWorkStatuses holds this guild\'s old jobs and the primary jobs of its members only', async () => {
    const rows = await workService.getAllWorkStatuses(HOME, { limit: 25, visibleUserIds: ROSTER });

    assert.deepEqual(rows.map((row) => row.userId).sort(), [LEGACY_HOME.id, LOCAL.id, TRAVELLER.id].sort());
    const traveller = rows.find((row) => row.userId === TRAVELLER.id);
    assert.equal(traveller.scope, 'primary');
    assert.equal(traveller.sourceGuildId, OTHER);
    // Without the guild's member list the overview is refused instead of listing everybody.
    await assert.rejects(
      workService.getAllWorkStatuses(HOME, { limit: 25 }),
      (error) => error.code === 'WORK_VISIBILITY_REQUIRED'
    );
  });

  await t.test('/work status-all leaves out a primary job chosen in another server and lists no outsider', async () => {
    const content = await workAs('status-all', { integers: { limit: 25 } });

    assert.ok(content.includes(`<@${LOCAL.id}>`), content);
    assert.ok(content.includes(`選擇來源群 ID：${HOME}`), content);
    assert.equal(content.includes(`<@${TRAVELLER.id}>`), false, content);
    assert.equal(content.includes('老師'), false, content);
    assert.equal(content.includes(OTHER_SERVER), false, content);
    assert.ok(content.includes(`<@${LEGACY_HOME.id}>`), content);
    assert.equal(content.includes(OTHER), false, content);
    assert.equal(content.includes(OUTSIDER.id), false, content);
    assert.equal(content.includes(LEGACY_OTHER.id), false, content);
  });

  await t.test('/economy audit work leaves out a primary job chosen in another server and lists no outsider', async () => {
    const content = await economyAs('audit', { strings: { type: 'work' }, integers: { limit: 25 } });

    assert.ok(content.includes(`來源群 ${HOME}`), content);
    assert.equal(content.includes(OTHER_SERVER), false, content);
    assert.equal(content.includes('老師'), false, content);
    assert.equal(content.includes(`<@${TRAVELLER.id}>`), false, content);
    assert.equal(content.includes(OTHER), false, content);
    assert.equal(content.includes(OUTSIDER.id), false, content);

    const one = await economyAs('audit', { strings: { type: 'work' }, users: { user: TRAVELLER } });
    assert.ok(one.includes('本伺服器沒有進行中的工作'), one);
    assert.equal(one.includes(OTHER_SERVER), false, one);
    assert.equal(one.includes('老師'), false, one);
    assert.equal(one.includes(OTHER), false, one);
  });

  await t.test('/economy user and /work status-user leave out a primary job chosen in another server', async () => {
    const traveller = await economyAs('user', { users: { user: TRAVELLER } });
    assert.ok(traveller.includes('本伺服器沒有進行中的工作'), traveller);
    assert.equal(traveller.includes('老師'), false, traveller);
    assert.equal(traveller.includes(OTHER_SERVER), false, traveller);
    assert.equal(traveller.includes(OTHER), false, traveller);

    const statusUser = await workAs('status-user', { users: { user: TRAVELLER } });
    assert.ok(statusUser.includes('本伺服器沒有進行中的工作'), statusUser);
    assert.equal(statusUser.includes('老師'), false, statusUser);
    assert.equal(statusUser.includes(OTHER_SERVER), false, statusUser);
    assert.equal(statusUser.includes(OTHER), false, statusUser);

    const local = await economyAs('user', { users: { user: LOCAL } });
    assert.ok(local.includes(`目前全域主職：會計師，來源群 ${HOME}`), local);
  });

  await t.test('/economy user and audit work still refuse somebody outside the server', async () => {
    assert.equal(await economyAs('user', { users: { user: OUTSIDER } }), NOT_A_MEMBER);
    assert.equal(
      await economyAs('audit', { strings: { type: 'work' }, users: { user: OUTSIDER } }),
      NOT_A_MEMBER
    );
  });

  await t.test('/work task-add assigns a task to a member of the server', async () => {
    const before = await tasksOf(LOCAL.id);
    const content = await workAs('task-add', {
      users: { user: LOCAL }, strings: { description: '整理公告' }, integers: { 'due-hours': 5 },
    });

    assert.ok(content.startsWith('工作任務已指派。'), content);
    assert.ok(content.includes(`<@${LOCAL.id}>`), content);
    assert.equal(await tasksOf(LOCAL.id), before + 1);
  });

  await t.test('/work task-add refuses somebody outside the server and creates nothing', async () => {
    // The outsider has an active primary job (chosen in another server), so only the member check stops it.
    assert.equal(await tasksOf(OUTSIDER.id), 0);

    const content = await expectNoWrites(() => workAs('task-add', {
      users: { user: OUTSIDER }, strings: { description: '整理公告' },
    }));

    assert.equal(content, NOT_A_MEMBER_FOR_TASK);
    assert.equal(await tasksOf(OUTSIDER.id), 0);
  });
});
