'use strict';

// Two guilds, one person in both: what guild A can learn about guild B.
//
// The wallet, bank and chips are one account for every guild a player is in (by design), so the question is not
// whether the money is shared but whether a guild's answer carries anything that tells it about another guild:
//  - /coins answers about the caller only (there is no user option), so a member cannot read a stranger's wallet;
//  - when an administrator looks at another member, the member's global primary job chosen in another server is
//    left out whole: no job name, no "其他伺服器" line, no ID of that server;
//  - the conversation memory of guild B (public records and private summaries) is out of reach from guild A, and
//    the unused helper that read a private summary without looking at the guild is gone;
//  - member data can only be asked for about a member of the guild the command runs in.
//
// The real commands run on a real, temporary coin database; only Discord is faked.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const harness = require('./support/securityAttackHarness');

const root = harness.createAttackEnvironment('xiaoji-cross-guild-');
const memoryPath = path.join(root, 'memory.json');
const previousMemoryPath = process.env.XIAOJI_MEMORY_PATH;
const previousArchiveCapture = process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED;
process.env.XIAOJI_MEMORY_PATH = memoryPath;
delete process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED;

// The administrator check is not what these tests are about; it answers yes.
require('../src/utils/moderation').ensureModerationAccess = async () => ({ ok: true });

const bankCommand = require('../src/commands/bank');
const coinsCommand = require('../src/commands/coins');
const economyCommand = require('../src/commands/economy');
const workCommand = require('../src/commands/work');
const coin = require('../src/services/coinService');
const workService = require('../src/services/workService');
const projection = require('../src/systems/conversation/projection');
const { captureIngressVisibility } = require('../src/systems/conversation/publicVisibility');
const { createRuntimeRewardCoordinator } = require('../src/coordinators/rewardRuntime');
const { configureWorkRewardCoordinator } = require('../src/systems/work/workRewardPort');
const { createGuild, createSlashInteraction } = require('./support/fakeSlashInteraction');
const { formatCoins } = require('../src/utils/coinPresentation');

configureWorkRewardCoordinator(createRuntimeRewardCoordinator());

const GUILD_A = '840000000000000001';
const GUILD_B = '840000000000000002';
const SHARED = '840000000000000011'; // a member of both guilds; chose a primary job in guild B
const B_ONLY = '840000000000000012'; // never joined guild A
const A_ONLY = '840000000000000013'; // chose a primary job in guild A
const ADMIN = '840000000000000014'; // the administrator who asks in guild A
const OPERATOR = '840000000000000099';
const START = '2026-03-02T01:00:00.000Z';
const NOT_A_MEMBER = '只能查詢目前在此伺服器的成員。';
const OTHER_SERVER = '其他伺服器';
const NO_JOB_HERE = '本伺服器沒有進行中的工作';

const previousOwner = process.env.BOT_OWNER_ID;
process.env.BOT_OWNER_ID = OPERATOR;

test.after(() => {
  if (previousOwner === undefined) delete process.env.BOT_OWNER_ID;
  else process.env.BOT_OWNER_ID = previousOwner;
  if (previousMemoryPath === undefined) delete process.env.XIAOJI_MEMORY_PATH;
  else process.env.XIAOJI_MEMORY_PATH = previousMemoryPath;
  if (previousArchiveCapture !== undefined) process.env.XIAOJI_ARCHIVE_CAPTURE_ENABLED = previousArchiveCapture;
  harness.closeAttackDatabase(root);
});

let fundings = 0;
async function fund(guildId, userId, amount) {
  fundings += 1;
  return coin.adjustPlayerBalance(guildId, userId, {
    action: 'add', amount, operatorId: OPERATOR, reason: 'isolation seed', operationId: `cross-guild-fund-${fundings}`,
  });
}

// Guild A knows A_ONLY, SHARED and its administrator; guild B knows B_ONLY and SHARED. SHARED chose its primary
// job in guild B and A_ONLY chose one in guild A.
async function openTwoGuilds(t) {
  const clock = harness.startClock(t, START);
  await harness.openAttackDatabase(root);
  await fund(GUILD_A, SHARED, 1_000);
  await fund(GUILD_B, SHARED, 1_000);
  await fund(GUILD_B, B_ONLY, 7_777);
  await fund(GUILD_A, A_ONLY, 3_000);
  await fund(GUILD_A, ADMIN, 10);
  await workService.startJob(GUILD_B, SHARED, '會計師', 3);
  await workService.startJob(GUILD_B, B_ONLY, '老師', 2);
  await workService.startJob(GUILD_A, A_ONLY, '清潔工', 2);
  clock.at('2026-03-02T14:00:00.000Z');
  assert.deepEqual((await workService.processDueJobs(null)).activations, { checked: 3, activated: 3 });
  return clock;
}

const person = (id, name) => ({ id, username: id, globalName: name, tag: `${id}#0001` });
const guildAMembers = () => createGuild(GUILD_A, [SHARED, A_ONLY, ADMIN]);

async function run(command, options) {
  const { interaction, replies } = createSlashInteraction(options);
  await command.execute(interaction);
  assert.equal(replies.length, 1, `${options.commandName} ${options.subcommand || ''} gave one answer`);
  return replies[0].content;
}

const asAdmin = (command, commandName, subcommand, options = {}) => run(command, {
  commandName, subcommand, guild: guildAMembers(), user: person(ADMIN, 'admin'), ...options,
});

// ---------------------------------------------------------------------------------------------------------
// /coins is for oneself
// ---------------------------------------------------------------------------------------------------------

test('/coins has no user option and answers about the caller, even when a stranger of guild B is named', async (t) => {
  await openTwoGuilds(t);
  assert.deepEqual(coinsCommand.data.toJSON().options || [], [], 'the command offers no option at all');
  assert.equal(coinsCommand.data.toJSON().description, '查詢自己的吉幣餘額');

  const before = await harness.snapshotAllTables();
  const text = await run(coinsCommand, {
    commandName: 'coins', guild: guildAMembers(), user: person(SHARED, 'member'),
    users: { user: person(B_ONLY, 'stranger') },
  });

  assert.ok(text.includes('member 的吉幣資料'), text);
  assert.ok(text.includes('目前餘額：2,000'), text);
  assert.equal(text.includes('stranger'), false, text);
  assert.equal(text.includes('7,777'), false, 'the stranger\'s wallet is not in the answer');
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), [],
    'the caller is already on the roster, so nothing is written');
  const roster = (await coin.getAllPlayers(GUILD_A, { limit: 25 })).map((row) => row.userId);
  assert.equal(roster.includes(B_ONLY), false);
});

// ---------------------------------------------------------------------------------------------------------
// An administrator looking at another member
// ---------------------------------------------------------------------------------------------------------

test('looking at a member whose primary job was chosen in guild B shows nothing of it in guild A', async (t) => {
  await openTwoGuilds(t);
  const shared = person(SHARED, 'shared');
  const answers = {
    workStatusUser: await asAdmin(workCommand, 'work', 'status-user', { users: { user: shared } }),
    workStatusAll: await asAdmin(workCommand, 'work', 'status-all', { integers: { limit: 25 } }),
    economyUser: await asAdmin(economyCommand, 'economy', 'user', { users: { user: shared } }),
    auditWorkOne: await asAdmin(economyCommand, 'economy', 'audit', { strings: { type: 'work' }, users: { user: shared } }),
    auditWorkAll: await asAdmin(economyCommand, 'economy', 'audit', { strings: { type: 'work' }, integers: { limit: 25 } }),
  };

  for (const [name, text] of Object.entries(answers)) {
    assert.equal(text.includes(OTHER_SERVER), false, `${name} names another server: ${text.slice(0, 300)}`);
    assert.equal(text.includes(GUILD_B), false, `${name} carries the id of guild B`);
    assert.equal(text.includes('會計師'), false, `${name} shows the job chosen in guild B`);
    assert.equal(text.includes('老師'), false, `${name} shows the job of a member who only belongs to guild B`);
    assert.equal(text.includes(B_ONLY), false, `${name} lists a member who only belongs to guild B`);
  }
  for (const name of ['workStatusUser', 'economyUser', 'auditWorkOne']) {
    assert.ok(answers[name].includes(NO_JOB_HERE), `${name} says there is no job here: ${answers[name]}`);
  }

  // A job chosen in this guild is a different case: it keeps showing, with this guild's own id.
  const local = await asAdmin(economyCommand, 'economy', 'user', { users: { user: person(A_ONLY, 'local') } });
  assert.ok(local.includes('目前全域主職：清潔工'), local);
  assert.ok(local.includes(GUILD_A), local);
  assert.ok(answers.workStatusAll.includes('清潔工') && answers.workStatusAll.includes(GUILD_A), answers.workStatusAll);
});

// ---------------------------------------------------------------------------------------------------------
// The pay of an earlier cycle
// ---------------------------------------------------------------------------------------------------------

test('after a member is paid for a job chosen in guild B and chooses again in guild A, the administrator of guild A sees none of the pay', async (t) => {
  const clock = await openTwoGuilds(t);
  await workService.reportWork(GUILD_B, SHARED, { description: 'report made for guild B', channelName: '會計師' });
  clock.at('2026-03-05T14:00:01.000Z');
  assert.equal((await workService.processDueJobs(null)).primaryCycles.settled >= 1, true);
  const paid = (await workService.getWorkStatus(GUILD_B, SHARED)).latestPrimaryPayroll;
  assert.ok(paid && paid.paidAmount > 0 && paid.jobName === '會計師', 'guild B paid the member for the first job');
  assert.equal(paid.sourceGuildId, GUILD_B);

  // The member chooses a new job in guild A: the job row now says guild A, but the pay is still guild B's.
  await workService.startJob(GUILD_A, SHARED, '清潔工', 2);
  const row = await workService.getWorkStatus(GUILD_A, SHARED);
  assert.equal(row.primaryStatusView.sourceGuildId, GUILD_A);
  assert.equal(row.latestPrimaryPayroll.sourceGuildId, GUILD_B);

  const shared = person(SHARED, 'shared');
  const seenByAdmin = {
    workStatusUser: await asAdmin(workCommand, 'work', 'status-user', { users: { user: shared } }),
    economyUser: await asAdmin(economyCommand, 'economy', 'user', { users: { user: shared } }),
  };
  const amount = formatCoins(paid.paidAmount);
  const paidAt = Math.floor(new Date(paid.settledAt).getTime() / 1000);
  for (const [name, text] of Object.entries(seenByAdmin)) {
    assert.equal(text.includes('會計師'), false, `${name} shows the job guild B paid for`);
    assert.equal(text.includes(amount), false, `${name} shows the amount guild B paid: ${amount}`);
    assert.equal(text.includes(`<t:${paidAt}`), false, `${name} shows when guild B paid`);
    assert.equal(text.includes('最近主職實際發薪'), false, `${name} has a line for the pay`);
    assert.equal(text.includes(GUILD_B), false, name);
    // The job the member has now, chosen in this guild, is shown as before.
    assert.ok(text.includes('清潔工'), `${name}: ${text}`);
  }

  // The member looking at themselves sees what they always did.
  const own = await run(workCommand, {
    commandName: 'work', subcommand: 'status', guild: guildAMembers(), user: shared,
  });
  assert.ok(own.includes('最近主職實際發薪') && own.includes('會計師') && own.includes(amount), own);

  // The same member's pay for a job chosen in guild A is shown to guild A's administrator.
  clock.at('2026-03-06T14:00:00.000Z');
  await workService.processDueJobs(null);
  clock.at('2026-03-09T14:00:01.000Z');
  await workService.reportWork(GUILD_A, SHARED, { description: 'report made for guild A', channelName: '清潔工' }).catch(() => {});
  await workService.processDueJobs(null);
  const latest = (await workService.getWorkStatus(GUILD_A, SHARED)).latestPrimaryPayroll;
  if (latest.sourceGuildId === GUILD_A) {
    const again = await asAdmin(workCommand, 'work', 'status-user', { users: { user: shared } });
    assert.ok(again.includes('清潔工') && again.includes(formatCoins(latest.paidAmount)), again);
  }
});

test('the role-sync check of a member does not name a primary job chosen in guild B', async (t) => {
  await openTwoGuilds(t);
  // role-sync defers its answer and edits it, which the plain fake interaction does not do.
  const roleSync = async (target) => {
    const { interaction, replies } = createSlashInteraction({
      commandName: 'work', subcommand: 'role-sync', guild: guildAMembers(), user: person(ADMIN, 'admin'), users: { user: target },
    });
    interaction.deferReply = async () => {};
    interaction.editReply = async (payload) => { replies.push(typeof payload === 'string' ? { content: payload } : payload); };
    await workCommand.execute(interaction);
    return replies.at(-1).content;
  };
  const text = await roleSync(person(SHARED, 'shared'));
  assert.equal(text.includes('會計師'), false, text);
  assert.ok(text.includes('目前沒有進行中的工作'), text);
  const local = await roleSync(person(A_ONLY, 'local'));
  assert.ok(local.includes('清潔工'), local);
});

// ---------------------------------------------------------------------------------------------------------
// Conversation memory
// ---------------------------------------------------------------------------------------------------------

function publicMessage(guildId, channelId, userId, content, id) {
  const channel = { id: channelId, permissionsFor: () => ({ has: () => true }) };
  const message = {
    id, content, author: { id: userId, username: `user-${userId}`, bot: false }, member: { displayName: '成員' },
    client: { user: { id: '999999999999999999' } }, guildId, channelId,
    guild: {
      roles: { everyone: { id: 'everyone' } },
      channels: { cache: new Map([[channelId, channel]]) },
      members: { cache: new Map() },
    },
    channel,
    createdTimestamp: Date.parse('2026-09-30T00:00:00.000Z'),
  };
  captureIngressVisibility(message);
  return message;
}

test('the memory projection exports no helper that reads a private summary without a guild', () => {
  assert.equal('findPrivateSelfMemory' in projection, false);
  assert.equal(Object.keys(projection).some((name) => /findPrivate/u.test(name)), false);
  // It was never exported, so the module text is what shows it is gone: a private summary is read only through
  // getPrivateMemoryContext, which filters by guild and channel.
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'systems', 'conversation', 'projection.js'), 'utf8');
  assert.equal(source.includes('findPrivateSelfMemory'), false);
});

test('guild A cannot read what was said in guild B, in public records or in private summaries', () => {
  projection.clearMemoryForTests();
  const said = publicMessage(GUILD_B, 'channel-b', SHARED, '晚安大家我要睡覺了', 'said-in-b');
  assert.ok(projection.recordPublicMessage(said), 'the public message of guild B is recorded');

  // The same question is answered in guild B (the control) and gets nothing in guild A.
  const question = '我剛剛有沒有說晚安';
  const inB = projection.answerMemoryQuery({
    text: question, message: publicMessage(GUILD_B, 'channel-b', SHARED, question, 'ask-b'),
  });
  assert.match(inB, /說過晚安/u, 'guild B can read its own public record');
  for (const text of [question, '誰說過晚安', '有人剛剛說晚安嗎', `<@${SHARED}> 剛剛有沒有說晚安`]) {
    const inA = projection.answerMemoryQuery({
      text, message: publicMessage(GUILD_A, 'channel-a', SHARED, text, `ask-a-${text}`),
    });
    assert.equal(String(inA).includes('說過晚安'), false, `${text}: ${inA}`);
    assert.equal(String(inA).includes('晚安大家'), false, `${text}: ${inA}`);
  }

  // Private summaries filed in guild B and in a DM: a DM context sees only the DM ones; a guild context sees none.
  const stored = JSON.parse(fs.readFileSync(memoryPath, 'utf8'));
  const record = (guildId, channelId, summary) => ({
    guildId, channelId, userId: SHARED, displayName: '成員', userContentSummary: summary,
    assistantContentSummary: '', timestamp: '2026-09-30T00:00:00.000Z',
  });
  stored.private_user_memory[SHARED] = [
    record(GUILD_B, 'shared-channel', '只在乙群說過的秘密'),
    record(null, 'shared-channel', '私訊裡說過的話'),
  ];
  fs.writeFileSync(memoryPath, JSON.stringify(stored), 'utf8');

  const dm = projection.getPrivateMemoryContext(SHARED, { guildId: null, channelId: 'shared-channel' });
  assert.ok(dm.includes('私訊裡說過的話'), dm);
  assert.equal(dm.includes('乙群說過的秘密'), false, dm);
  for (const guildId of [GUILD_A, GUILD_B]) {
    assert.equal(projection.getPrivateMemoryContext(SHARED, { guildId, channelId: 'shared-channel' }), '',
      'a guild context never gets a private summary');
  }
});

// ---------------------------------------------------------------------------------------------------------
// Member data of one guild only
// ---------------------------------------------------------------------------------------------------------

test('member data can only be asked for about a member of guild A, and the refusals write nothing', async (t) => {
  await openTwoGuilds(t);
  const stranger = person(B_ONLY, 'stranger');
  const before = await harness.snapshotAllTables();

  const refusals = {
    bankBalance: await asAdmin(bankCommand, 'bank', 'balance-user', { users: { user: stranger } }),
    bankFixed: await asAdmin(bankCommand, 'bank', 'fixed-user', { users: { user: stranger } }),
    economyUser: await asAdmin(economyCommand, 'economy', 'user', { users: { user: stranger } }),
    auditBalances: await asAdmin(economyCommand, 'economy', 'audit', { strings: { type: 'balances' }, users: { user: stranger } }),
    auditWork: await asAdmin(economyCommand, 'economy', 'audit', { strings: { type: 'work' }, users: { user: stranger } }),
    workStatusUser: await asAdmin(workCommand, 'work', 'status-user', { users: { user: stranger } }),
  };
  for (const [name, text] of Object.entries(refusals)) {
    assert.equal(text, NOT_A_MEMBER, name);
  }
  assert.deepEqual(harness.changedTables(before, await harness.snapshotAllTables()), []);

  // A member of guild A, asked about the same way, is answered.
  const member = await asAdmin(bankCommand, 'bank', 'balance-user', { users: { user: person(SHARED, 'shared') } });
  assert.match(member, /錢包吉幣：2,000/u);
});
