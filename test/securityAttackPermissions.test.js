'use strict';

// Attack tests for who may run which command: the permission rules of the handlers themselves, run through the real
// interaction handler, the real commands, the real services and a real coin database (test/support/attackSession.js).
//
// The people in it: the bot owner; "admin", a server Administrator in the same guild who is not the bot owner;
// "awayAdmin", an Administrator of a second guild; "member" and "target", ordinary members. Every refusal is held to
// the same bar: the user is told no once and privately, the interaction count is the only table that moves, no file,
// no message, no reaction and no REST request follows, and nobody's wallet changed.
//
// A plain test that passes is a defence that held. A test marked todo is a defect or a gap that is reported and not
// fixed here.

const test = require('node:test');
const assert = require('node:assert/strict');

const attack = require('./support/attackSession');

const session = attack.createAttackSession({ prefix: 'xiaoji-attack-permissions-' });

const coinService = require('../src/services/coinService');
const workService = require('../src/services/workService');
const { withCoinDatabase } = require('../src/services/coinDatabase');
const { COMMAND_CATALOG, getSubcommandAudience } = require('../website/commandCatalog');

const { IDS } = session;
const HOME = IDS.approvedGuild;
const AWAY = IDS.pendingGuild;
const DAY = 86_400_000;
const { OWNER_DENIED, ADMIN_DENIED } = attack;

test.before(async () => {
  await session.open();
  for (const guildId of [HOME, AWAY]) await coinService.setGuildEconomyEnabled(guildId, true, { operatorId: IDS.owner });
  for (const [userId, amount] of [[IDS.member, 5_000], [IDS.target, 5_000], [session.EXTRA_IDS.admin, 5_000]]) {
    await coinService.adjustPlayerBalance(HOME, userId, {
      action: 'add', amount, operatorId: IDS.owner, reason: '權限攻擊測試初始資金', operationId: `attack-permission-seed-${userId}`,
    });
  }
});

test.after(() => session.close());

async function wallets() {
  return withCoinDatabase((api) => api.all('SELECT user_id, balance, total_earned, total_spent FROM coin_wallets ORDER BY user_id'));
}

// A refusal is held to the same bar everywhere.
async function assertRefused(label, outcome, expected, before) {
  attack.assertRanCleanly(outcome, label);
  attack.assertRefusedWith(outcome, expected, label);
  attack.assertChangedNothing(session, outcome, label);
  if (before) assert.deepEqual(await wallets(), before, `${label}: no wallet moved`);
}

// ---------------------------------------------------------------------------------------------------------
// /coin-admin: which forms need the bot owner, and which an Administrator may run
// ---------------------------------------------------------------------------------------------------------

// Every form of /coin-admin, with options that would be accepted from the bot owner.
const COIN_ADMIN_FORMS = Object.freeze([
  { name: 'add for one user', path: 'coin-admin add',
    options: () => ({ user: IDS.target, amount: 100, reason: '攻擊測試加幣' }), ownerOnly: true },
  { name: 'add for a role', path: 'coin-admin add',
    options: () => ({ role: IDS.role, 'campaign-id': 'attack-role-campaign', amount: 100, reason: '攻擊測試身分組加幣' }),
    ownerOnly: true },
  { name: 'remove', path: 'coin-admin remove',
    options: () => ({ user: IDS.target, amount: 100, reason: '攻擊測試扣幣' }), ownerOnly: true },
  { name: 'set', path: 'coin-admin set',
    options: () => ({ user: IDS.target, amount: 1, reason: '攻擊測試設定餘額' }), ownerOnly: true },
  { name: 'reset-user', path: 'coin-admin reset-user',
    options: () => ({ user: IDS.target, confirm: 'RESET', reason: '攻擊測試重置' }), ownerOnly: true },
  // The transaction lookup of one member needs only Administrator; the same subcommand with a campaign-id is the
  // campaign reconciliation, which is owner only (src/commands/coin-admin.js: `campaignHistory`).
  { name: 'history of one campaign', path: 'coin-admin history',
    options: () => ({ 'campaign-id': 'attack-role-campaign', audience: 'member', user: IDS.target }), ownerOnly: true },
  { name: 'history of one campaign, review', path: 'coin-admin history',
    options: () => ({ 'campaign-id': 'attack-role-campaign', audience: 'member', action: 'review', 'review-token': 'a'.repeat(64),
      confirm: '已核對未發', reason: '攻擊測試核對' }), ownerOnly: true },
  { name: 'history of one campaign, import', path: 'coin-admin history',
    options: () => ({ 'campaign-id': 'attack-role-campaign', audience: 'member', user: IDS.target, action: 'import',
      'review-token': 'a'.repeat(64), confirm: '已發對應', 'transaction-id': 1, reason: '攻擊測試匯入' }), ownerOnly: true },
  { name: 'history of one member', path: 'coin-admin history',
    options: () => ({ user: IDS.target }), ownerOnly: false },
  { name: 'enable', path: 'coin-admin enable', options: () => ({}), ownerOnly: false },
  { name: 'disable', path: 'coin-admin disable', options: () => ({}), ownerOnly: false },
]);

test('an ordinary member is refused every form of /coin-admin, and nothing moves', async () => {
  const before = await wallets();
  for (const form of COIN_ADMIN_FORMS) {
    const outcome = await session.run(form.path, { as: 'member', options: form.options() });
    await assertRefused(`member /${form.path} (${form.name})`, outcome, form.ownerOnly ? OWNER_DENIED : ADMIN_DENIED, before);
  }
});

test('a server Administrator who is not the bot owner is refused every owner-only form, campaign history included', async () => {
  const before = await wallets();
  const ownerOnly = COIN_ADMIN_FORMS.filter((form) => form.ownerOnly);
  assert.ok(ownerOnly.length >= 8);
  for (const form of ownerOnly) {
    for (const [as, where] of [['admin', 'home'], ['awayAdmin', 'away']]) {
      const outcome = await session.run(form.path, { as, where, options: form.options() });
      await assertRefused(`${as} /${form.path} (${form.name})`, outcome, OWNER_DENIED, before);
    }
  }
});

test('a server Administrator may look up one member\'s transactions and switch the guild economy, and nothing else', async () => {
  const history = await session.run('coin-admin history', { as: 'admin', options: { user: IDS.target } });
  attack.assertRanCleanly(history, 'admin history');
  assert.match(history.last, /最近交易紀錄|目前沒有吉幣交易紀錄/u);
  assert.deepEqual(session.changesBeyondTheCount(history), [], 'a lookup writes nothing');

  const off = await session.run('coin-admin disable', { as: 'admin' });
  attack.assertRanCleanly(off, 'admin disable');
  assert.equal(off.last, '目前伺服器吉幣系統已停用。');
  assert.ok(Object.hasOwn(off.changes.tables, 'coin_guild_settings'), 'the switch is a stored setting');
  const on = await session.run('coin-admin enable', { as: 'admin' });
  assert.equal(on.last, '目前伺服器吉幣系統已啟用。');
  assert.equal((await coinService.getGuildCoinSettings(HOME)).enabled, true);
});

test('the bot owner passes every form of /coin-admin that the others were refused', async () => {
  try {
    for (const form of COIN_ADMIN_FORMS) {
      const outcome = await session.run(form.path, { as: 'owner', options: form.options() });
      attack.assertRanCleanly(outcome, `owner /${form.path} (${form.name})`);
      assert.notEqual(outcome.last, OWNER_DENIED, `owner /${form.path} (${form.name}) is not refused`);
      assert.doesNotMatch(outcome.last, ADMIN_DENIED);
    }
  } finally {
    // The last form switches the guild economy off; the tests after this one need it on.
    await coinService.setGuildEconomyEnabled(HOME, true, { operatorId: IDS.owner });
  }
});

test('the catalog marks /coin-admin history as admin while its campaign form is owner only', {
  todo: 'the command catalog lists /coin-admin history for Administrators, but history with campaign-id refuses everyone but the bot owner (src/commands/coin-admin.js, ensureBotOwner for campaignHistory)',
}, () => {
  const entry = COMMAND_CATALOG.find((candidate) => candidate.name === 'coin-admin');
  // What the catalog should say once the campaign form is no longer hidden behind the plain audience of the
  // subcommand: that /coin-admin history is not for every Administrator.
  assert.notEqual(getSubcommandAudience(entry, 'history'), 'admin');
});

// ---------------------------------------------------------------------------------------------------------
// /work edit and /work delete: whose submission may be changed
// ---------------------------------------------------------------------------------------------------------

let submissionSequence = 0;

// A work submission of `userId` in `guildId`, made through the real services: a primary job chosen, the cycle
// started three days later, and one report.
async function makeSubmission(userId, guildId = HOME) {
  submissionSequence += 1;
  try {
    await workService.startJob(guildId, userId, workService.JOB_TYPES[0].name, 1);
  } catch (error) {
    if (error?.code !== 'PRIMARY_JOB_EXISTS') throw error;
  }
  session.setTime(Date.now() + 3 * DAY);
  await workService.processDueJobs(null);
  const { activePrimaryJob } = await workService.getWorkStatus(guildId, userId);
  assert.ok(activePrimaryJob, `the job of ${userId} is active`);
  const { reportChannelName } = workService.JOB_TYPES.find((job) => job.name === activePrimaryJob.jobName);
  const report = await workService.reportWork(guildId, userId, {
    taskType: `攻擊測試提交 ${submissionSequence}`, description: `原本的內容 ${submissionSequence}`, channelName: reportChannelName,
  });
  return report.task.id;
}

async function taskRow(guildId, id) {
  return withCoinDatabase((api) => api.get(
    'SELECT user_id, status, description, review_reason FROM coin_work_tasks WHERE guild_id = ? AND id = ?', [guildId, id]
  ));
}

test('/work edit: the author, an Administrator and the bot owner may change a submission; another member may not', async () => {
  const id = await makeSubmission(IDS.member);
  const original = await taskRow(HOME, id);
  assert.equal(original.user_id, IDS.member);
  const content = (text) => ({ 'submission-id': id, content: text });

  const stranger = await session.run('work edit', { as: 'target', options: content('他人的改寫') });
  attack.assertRanCleanly(stranger, 'target edits another member\'s submission');
  assert.equal(stranger.last, '你只能修改自己的工作內容。');
  assert.deepEqual(session.changesBeyondTheCount(stranger), []);
  assert.deepEqual(await taskRow(HOME, id), original, 'the submission is as it was');

  // An Administrator of another guild is a stranger here: the lookup is by the guild the command ran in.
  const awayAdmin = await session.run('work edit', { as: 'awayAdmin', where: 'away', options: content('另一伺服器管理員的改寫') });
  attack.assertRanCleanly(awayAdmin, 'awayAdmin edits a submission of the home guild');
  assert.equal(awayAdmin.last, '找不到這筆工作提交紀錄。');
  assert.deepEqual(session.changesBeyondTheCount(awayAdmin), []);
  assert.deepEqual(await taskRow(HOME, id), original);

  for (const [as, text] of [['member', '作者的改寫'], ['admin', '管理員的改寫'], ['owner', '擁有者的改寫']]) {
    const edited = await session.run('work edit', { as, options: content(text) });
    attack.assertRanCleanly(edited, `${as} edits the submission`);
    assert.match(edited.last, /^已更新你的工作內容/u, as);
    assert.equal((await taskRow(HOME, id)).description, text, `${as}'s text is stored`);
    // The edit is the submission and its audit line, and nothing else.
    const written = Object.keys(edited.changes.tables).filter((table) => table !== 'feature_usage_daily').sort();
    assert.ok(written.includes('coin_work_tasks'), `${as}'s edit changed the submission`);
    assert.deepEqual(written.filter((table) => !['coin_admin_logs', 'coin_work_tasks'].includes(table)), [], `${as}'s edit wrote only the submission and its log`);
  }
});

test('/work delete: the author, an Administrator and the bot owner may delete a submission; another member may not', async () => {
  const mine = await makeSubmission(IDS.target);
  const original = await taskRow(HOME, mine);
  assert.equal(original.user_id, IDS.target);

  const stranger = await session.run('work delete', { as: 'member', options: { 'submission-id': mine } });
  attack.assertRanCleanly(stranger, 'member deletes another member\'s submission');
  assert.equal(stranger.last, '你只能刪除自己的工作內容。');
  assert.deepEqual(session.changesBeyondTheCount(stranger), []);

  const awayAdmin = await session.run('work delete', { as: 'awayAdmin', where: 'away', options: { 'submission-id': mine } });
  attack.assertRanCleanly(awayAdmin, 'awayAdmin deletes a submission of the home guild');
  assert.equal(awayAdmin.last, '找不到這筆工作提交紀錄。');
  assert.deepEqual(session.changesBeyondTheCount(awayAdmin), []);
  assert.deepEqual(await taskRow(HOME, mine), original, 'the submission is as it was');

  const byAdmin = await session.run('work delete', { as: 'admin', options: { 'submission-id': mine } });
  attack.assertRanCleanly(byAdmin, 'admin deletes the submission');
  assert.match(byAdmin.last, /^已刪除該使用者的工作內容/u);
  assert.equal((await taskRow(HOME, mine)).status, 'deleted');

  // The bot owner deletes someone else's submission, and the author deletes their own.
  const second = await makeSubmission(IDS.member);
  const byOwner = await session.run('work delete', { as: 'owner', options: { 'submission-id': second } });
  assert.match(byOwner.last, /^已刪除該使用者的工作內容/u);
  const third = await makeSubmission(IDS.member);
  const byAuthor = await session.run('work delete', { as: 'member', options: { 'submission-id': third } });
  assert.match(byAuthor.last, /^已刪除你的工作內容/u);
});

test('/work edit and /work delete need a guild, and a deleted submission cannot be brought back by an Administrator', async () => {
  const id = await makeSubmission(IDS.member);
  for (const path of ['work edit', 'work delete']) {
    const outcome = await session.run(path, { as: 'owner', where: 'dm', options: { 'submission-id': id, content: '私訊' } });
    assert.equal(outcome.last, '工作系統只能在伺服器內使用。', path);
    assert.deepEqual(session.changesBeyondTheCount(outcome), [], path);
  }
  const deleted = await session.run('work delete', { as: 'member', options: { 'submission-id': id } });
  assert.match(deleted.last, /^已刪除你的工作內容/u);
  const revived = await session.run('work edit', { as: 'admin', options: { 'submission-id': id, content: '復活' } });
  attack.assertRanCleanly(revived, 'admin edits a deleted submission');
  assert.equal(revived.last, '這筆工作已經刪除，請重新提交新的工作內容。');
  assert.deepEqual(session.changesBeyondTheCount(revived), []);
  assert.equal((await taskRow(HOME, id)).status, 'deleted');
});
