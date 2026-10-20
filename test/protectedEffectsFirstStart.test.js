'use strict';

// The first start after the upgrade, end to end: the bootstrap creates the
// ledgers, nothing from before the upgrade is sent, no guild is left (before or after a
// restart), what happens after the upgrade is sent once (a new word chain round and
// its ✅ included), four kinds of ledger damage each stop only their own purpose while the
// rest of the bot keeps working, and the kill switch keeps all eight purposes shut without
// touching a ledger file while the old per-purpose switches change nothing.

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { fileURLToPath } = require('node:url');

const { withCoinDatabase, withCoinTransaction } = require('../src/services/coinDatabase');
const { enqueueFeatureOutboxWithApi } = require('../src/services/featurePlatformService');
const { buildReactionOutboxPayload } = require('../src/services/chainReactionDelivery');
const {
  acceptWordChainMessage,
  processWordChainReactionOutbox,
  startWordChain,
} = require('../src/services/wordChainService');
const {
  processWorkPenaltyAnnouncements,
  processWorkReminders,
  resetWorkReminderRetryStateForTests,
} = require('../src/systems/work/workService');
const { PUBLIC_FEATURES, buildPublicStatusSnapshot } = require('../src/services/publicStatusService');
const { LEGACY_LEDGER_VARIABLES } = require('../src/systems/safety/ledgerBootstrap');
const { PURPOSE_IDS } = require('../src/systems/safety/ledgerLayout');
const {
  BOT_ID,
  createLayout,
  createProcess,
  openCoinDatabase,
  ownerMessages,
  protectedCalls,
  registrations,
} = require('./fixtures/protectedEffectsHarness');

const GUILD_ID = '10000000000000002';
const CHANNEL_ID = '10000000000000003';
const USER_ID = '10000000000000004';
const HOUR_MS = 60 * 60 * 1_000;
const DAY_MS = 24 * HOUR_MS;
const DISCORD_EPOCH = 1_420_070_400_000n;

test.after(() => {
  resetWorkReminderRetryStateForTests();
});

function snowflake(timestamp, increment = 1n) {
  return (((BigInt(timestamp) - DISCORD_EPOCH) << 22n) + increment).toString();
}

function idFor(value) {
  return String(10_000_000_000_000_000n + BigInt(value));
}

// The bot's view of Discord for the scheduled jobs: one guild with one text channel.
function botClient(rest) {
  const channel = { id: CHANNEL_ID, isTextBased: () => true, isSendable: () => true };
  const guild = {
    id: GUILD_ID,
    systemChannelId: null,
    channels: { fetch: async (id) => (id === CHANNEL_ID ? channel : null), cache: { find: () => channel } },
    members: { fetch: async (userId) => ({ id: userId, user: { id: userId } }) },
  };
  return { user: { id: BOT_ID }, rest, guilds: { fetch: async (id) => (id === GUILD_ID ? guild : null) } };
}

async function seedPenalty(id, createdAt) {
  await withCoinTransaction((api) => api.run(
    `INSERT INTO coin_work_penalties
      (id, guild_id, user_id, job_id, job_name, source_type, source_channel_id, penalty_date,
       daily_salary, penalty_amount, status, reason, appeal_deadline_at, created_at, updated_at)
     VALUES (?, ?, ?, 1, '測試職業', 'synthetic', ?, '2026-10-01', 1000, 250, 'active', '合成測試', ?, ?, ?)`,
    [id, GUILD_ID, USER_ID, CHANNEL_ID, new Date(Date.now() + 3 * DAY_MS).toISOString(), createdAt, createdAt]
  ));
}

// A legacy job with one pending task, due already.
async function seedReminderTask(index, { createdAt, dueAt }) {
  return withCoinTransaction((api) => {
    const userId = idFor(100 + index);
    api.run(
      `INSERT INTO coin_jobs
        (guild_id,user_id,job_name,daily_salary,work_days,total_salary,status,is_paid,start_at,pay_at,
         last_contribution_at,last_reminder_at,today_task_count,today_completed_task_count,
         no_work_available_today,payroll_status,created_at,updated_at)
       VALUES (?,?,'測試',100,1,100,'active',0,?,?,NULL,NULL,0,0,0,'pending',?,?)`,
      [GUILD_ID, userId, createdAt, new Date(Date.now() + 29 * DAY_MS).toISOString(), createdAt, createdAt]
    );
    const jobId = Number(api.get('SELECT last_insert_rowid() AS id').id);
    api.run(
      `INSERT INTO coin_work_tasks
        (guild_id,user_id,job_id,job_name,task_type,status,description,created_at,due_at,updated_at,
         reminder_count,last_reminder_at)
       VALUES (?,?,?,'測試','work_report','pending','合成任務',?,?,?,0,NULL)`,
      [GUILD_ID, userId, jobId, createdAt, dueAt, createdAt]
    );
    return userId;
  });
}

// A ✅ left in the outbox by the version before the upgrade, for a message sent then.
async function seedOldReaction(sentAt) {
  await withCoinTransaction((api) => enqueueFeatureOutboxWithApi(api, {
    guildId: GUILD_ID, featureKey: 'word_chain', eventType: 'discord_reaction',
    dedupeKey: `reaction:${snowflake(sentAt, 7n)}`,
    payload: buildReactionOutboxPayload({ guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: snowflake(sentAt, 7n),
      authorId: USER_ID, sourceFence: 'a'.repeat(64) }),
    availableAt: new Date(sentAt), now: new Date(sentAt),
  }));
}

// A welcome for a member who joined at joinedTimestamp, as welcomeService would ask for it.
function welcomeJoin(proc, memberId, joinedTimestamp) {
  const eventGrant = proc.authority.captureGuildMemberAdd({ botId: BOT_ID, guildId: GUILD_ID, memberId, joinedTimestamp });
  const body = { content: `歡迎 <@${memberId}> 加入伺服器！小吉在這裡向你打招呼～`,
    allowed_mentions: { parse: [], users: [memberId], roles: [], replied_user: false } };
  const effect = { purposeId: 'welcome', action: 'welcome-message.create', target: CHANNEL_ID, method: 'POST',
    route: `/channels/${CHANNEL_ID}/messages`, body };
  return proc.welcome.accept(proc.welcome.issueGrant(eventGrant, effect), effect);
}

function requestsOf(rest, method, pattern) {
  return rest.calls.filter(([verb, route]) => verb === method && pattern.test(route));
}

const reminderMessages = (rest, userId) => requestsOf(rest, 'POST', new RegExp(`^/channels/2${userId.slice(1)}/messages$`, 'u'));
const channelMessages = (rest) => requestsOf(rest, 'POST', new RegExp(`^/channels/${CHANNEL_ID}/messages$`, 'u'));

// The ✅ outbox events still waiting, its dead letters, and the features stored as broken.
function outboxState() {
  return withCoinDatabase((api) => ({
    waiting: Number(api.get("SELECT COUNT(*) AS count FROM feature_outbox WHERE event_type = 'discord_reaction'").count),
    deadLetters: api.all('SELECT feature_key, dead_letter_reason FROM feature_outbox_dead_letters ORDER BY id')
      .map((row) => [row.feature_key, row.dead_letter_reason]),
    broken: api.all("SELECT feature_key FROM feature_health WHERE status = 'broken'").map((row) => row.feature_key),
  }));
}

// The public status page as it reads the stored feature health, with every public command.
async function statusCards(protectedEffects) {
  const snapshot = await buildPublicStatusSnapshot({ isReady: () => true,
    commands: new Map(PUBLIC_FEATURES.flatMap((feature) => feature.commands || []).map((name) => [name, {}])),
    protectedEffects });
  const cards = Object.fromEntries(snapshot.features.map((feature) => [feature.key, feature.status]));
  return { bot: snapshot.bot.status, welcome: cards.welcome, wordChain: cards.word_chain, numberChain: cards.number_chain };
}

// The old per-purpose switches (their values were never read after the upgrade).
const LEGACY_SWITCHES = LEGACY_LEDGER_VARIABLES.filter((name) => name.endsWith('_ENABLED'));
const FS_SYNC_CALLS = ['accessSync', 'copyFileSync', 'existsSync', 'lstatSync', 'mkdirSync', 'openSync', 'opendirSync',
  'readFileSync', 'readdirSync', 'realpathSync', 'renameSync', 'rmSync', 'statSync', 'unlinkSync', 'writeFileSync'];
const FS_CALLBACK_CALLS = ['access', 'copyFile', 'lstat', 'mkdir', 'open', 'opendir', 'readFile', 'readdir', 'realpath',
  'rename', 'rm', 'stat', 'unlink', 'writeFile'];
// Calls whose second argument is a path as well.
const TWO_PATH_CALLS = new Set(['copyFile', 'copyFileSync', 'rename', 'renameSync']);

// Records every fs call (sync, callback, or promise) naming a path in one of the directories
// or the directory itself. A ledger is opened by node:sqlite, below fs, but nothing reaches
// one without checking its folders through fs first; the byte-for-byte file states cover
// the rest.
function watchPaths(t, directories) {
  const roots = directories.map((directory) => path.resolve(directory).toLowerCase());
  const touched = [];
  const inside = (value) => {
    let text = null;
    if (typeof value === 'string') text = value;
    else if (Buffer.isBuffer(value)) text = value.toString('utf8');
    else if (value instanceof URL && value.protocol === 'file:') text = fileURLToPath(value);
    if (text === null) return false;
    const resolved = path.resolve(text).toLowerCase();
    return roots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  };
  const restores = [];
  const wrap = (target, name, label) => {
    const original = target[name];
    const wrapped = function watched(...args) {
      const named = TWO_PATH_CALLS.has(name) ? args.slice(0, 2) : args.slice(0, 1);
      if (named.some(inside)) touched.push(`${label}${name}`);
      return original.apply(this, args);
    };
    Object.assign(wrapped, original);
    target[name] = wrapped;
    assert.equal(target[name], wrapped, `${label}${name} is watched`);
    restores.push(() => { target[name] = original; });
  };
  for (const name of FS_SYNC_CALLS) wrap(fs, name, 'fs.');
  for (const name of FS_CALLBACK_CALLS) wrap(fs, name, 'fs.');
  for (const name of FS_CALLBACK_CALLS) wrap(fs.promises, name, 'fs.promises.');
  const stop = () => {
    while (restores.length) restores.pop()();
  };
  t.after(stop);
  return { touched, stop };
}

// Size, SHA-256, and modification time of every file under the directories.
function fileStates(directories) {
  const states = {};
  for (const directory of directories) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;
      const file = path.join(entry.parentPath || entry.path, entry.name);
      const bytes = fs.readFileSync(file);
      states[path.relative(path.dirname(directory), file)] = [bytes.length,
        crypto.createHash('sha256').update(bytes).digest('hex'), fs.statSync(file).mtimeMs];
    }
  }
  return states;
}

test('first start: nothing from before the upgrade is sent, no guild is left, and new events go out once', async (t) => {
  const layout = createLayout(t, 'first-start');
  await openCoinDatabase(layout, { fresh: true });
  resetWorkReminderRetryStateForTests();
  const beforeUpgrade = Date.now() - 2 * HOUR_MS;
  // Left behind by the version before the upgrade.
  for (const id of [1, 2, 3]) await seedPenalty(id, new Date(beforeUpgrade + id).toISOString());
  const oldUsers = [];
  for (let index = 0; index < 5; index += 1) {
    oldUsers.push(await seedReminderTask(index, { createdAt: new Date(Date.now() - 2 * DAY_MS).toISOString(),
      dueAt: new Date(Date.now() - 36 * HOUR_MS).toISOString() }));
  }
  await seedOldReaction(beforeUpgrade);

  // The first start creates all eight ledgers; the cutover is now.
  const first = createProcess(layout);
  const started = await first.preflight();
  assert.equal(started.ledgers.size, PURPOSE_IDS.length);
  await first.ready();
  const creation = ownerMessages(first.rest);
  assert.equal(creation.length, 1);
  assert.ok(creation[0].includes('已建立'));

  // The scheduled jobs of ready.js.
  const client = botClient(first.rest);
  await processWorkPenaltyAnnouncements(client);
  await processWorkReminders(client);
  await processWordChainReactionOutbox(client, { permissionCheck: () => true });
  assert.equal(welcomeJoin(first, '10000000000000077', beforeUpgrade), false);
  // Nothing old: no penalty announcement, reminder DM, ✅, or welcome; and no guild is left.
  assert.deepEqual(channelMessages(first.rest), []);
  for (const userId of oldUsers) assert.deepEqual(reminderMessages(first.rest, userId), [], userId);
  assert.deepEqual(requestsOf(first.rest, 'PUT', /reactions/u), []);
  // The old ✅ is closed as a terminal computed from its source (its message predates the
  // cutover), which does not mark the feature broken.
  assert.deepEqual(await outboxState(), { waiting: 0, deadLetters: [['word_chain', 'reaction_source_unproven']], broken: [] });
  assert.deepEqual(requestsOf(first.rest, 'DELETE', /^\/users\/@me\/guilds\//u), []);
  // The old reminders were accounted as never sent, so they are not tried again.
  const oldReminders = await withCoinDatabase((api) => api.all(
    `SELECT reminder_count FROM coin_work_tasks WHERE user_id IN (${oldUsers.map(() => '?').join(',')})`, oldUsers));
  assert.ok(oldReminders.every((row) => Number(row.reminder_count) >= 1), JSON.stringify(oldReminders));

  // After the upgrade: one penalty, one due task, and one join are each sent once.
  await new Promise((resolve) => setTimeout(resolve, 5));
  const afterUpgrade = new Date().toISOString();
  await seedPenalty(4, afterUpgrade);
  const newUser = await seedReminderTask(9, { createdAt: afterUpgrade, dueAt: afterUpgrade });
  await new Promise((resolve) => setTimeout(resolve, 5));
  for (let round = 0; round < 2; round += 1) {
    await processWorkPenaltyAnnouncements(client);
    await processWorkReminders(client);
  }
  assert.equal(welcomeJoin(first, '10000000000000078', Date.now()), true);
  await first.welcome.waitForIdleForTests();
  assert.equal(channelMessages(first.rest).length, 2, 'one penalty announcement and one welcome');
  assert.equal(reminderMessages(first.rest, newUser).length, 1);

  // A new word chain round can start (its ✅ fence opens), and its answer gets one ✅.
  const round = await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球',
    now: new Date() });
  assert.deepEqual([round.alreadyActive, round.session.status], [false, 'active']);
  const answerId = snowflake(Date.now(), 12n);
  const answered = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID, messageId: answerId,
    userId: USER_ID, content: '球體', now: new Date() });
  assert.deepEqual([answered.ok, answered.duplicate, Boolean(answered.reactionSource)], [true, false, true]);
  for (let run = 0; run < 2; run += 1) {
    await processWordChainReactionOutbox(client, { permissionCheck: () => true });
  }
  assert.deepEqual(requestsOf(first.rest, 'PUT', /reactions/u).map(([, route]) => route),
    [`/channels/${CHANNEL_ID}/messages/${answerId}/reactions/${encodeURIComponent('✅')}/@me`]);
  // Nothing is stored as broken, so the status page shows the bot operational.
  assert.deepEqual((await outboxState()).broken, []);
  assert.deepEqual(await statusCards(first.protectedEffects),
    { bot: 'operational', welcome: 'normal', wordChain: 'normal', numberChain: 'normal' });
  assert.equal(await first.stop(), 0);

  // A restart: what was sent is not sent again, and still no guild is left.
  await openCoinDatabase(layout);
  const second = createProcess(layout);
  await second.preflight();
  await second.ready();
  await processWorkPenaltyAnnouncements(botClient(second.rest));
  await processWorkReminders(botClient(second.rest));
  await processWordChainReactionOutbox(botClient(second.rest), { permissionCheck: () => true });
  assert.deepEqual(channelMessages(second.rest), []);
  assert.deepEqual(reminderMessages(second.rest, newUser), []);
  assert.deepEqual(requestsOf(second.rest, 'PUT', /reactions/u), []);
  assert.deepEqual(requestsOf(second.rest, 'DELETE', /guilds/u), []);
  assert.equal(await second.stop(), 0);
});

test('four kinds of ledger damage each stop only their purpose; the Owner hears once and the rest keeps working',
  async (t) => {
    const layout = createLayout(t, 'damage');
    await openCoinDatabase(layout, { fresh: true });
    resetWorkReminderRetryStateForTests();
    const first = createProcess(layout);
    await first.preflight();
    await first.ready();
    // A word chain round that started while everything was healthy.
    await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球',
      now: new Date() });
    assert.equal(await first.stop(), 0);
    const oldWordChain = fs.readFileSync(layout.paths('word-chain.reaction').database);

    // One more clean start and stop moves every ledger past that copy.
    await openCoinDatabase(layout);
    const second = createProcess(layout);
    await second.preflight();
    await second.ready();
    assert.equal(await second.stop(), 0);

    // Four kinds of damage, one purpose each.
    fs.rmSync(layout.paths('work.penalty.announce').database);
    fs.rmSync(layout.paths('work.reminder.dm.send').witness);
    await withCoinTransaction((api) => api.run('DELETE FROM coin_metadata WHERE key = ?',
      ['safety_ledger:number-chain.reaction']));
    fs.writeFileSync(layout.paths('word-chain.reaction').database, oldWordChain);

    // Two minutes later on the ledger clocks, so the Owner-notice budget (one a minute,
    // shared with the AI notices) has room again after the first start's notice.
    await openCoinDatabase(layout);
    const third = createProcess(layout, { bootstrapOptions: { now: () => Date.now() + 2 * 60_000 } });
    const started = await third.preflight();
    const byPurpose = Object.fromEntries(PURPOSE_IDS.map((purposeId) => [purposeId, started.ledgers.has(purposeId)]));
    assert.deepEqual(byPurpose, {
      'owner-safety': true,
      welcome: true,
      'work.penalty.announce': false,
      'work.reminder.dm.prepare': true,
      'work.reminder.dm.send': false,
      'audit.guild.leave': true,
      'word-chain.reaction': false,
      'number-chain.reaction': false,
    });
    await third.ready();

    // The Owner hears once, through the healthy Owner ledger, in fixed text.
    const messages = ownerMessages(third.rest);
    assert.equal(messages.length, 1);
    for (const fragment of ['扣薪公告（LEDGER_PARTIAL', '工作提醒（私訊）（LEDGER_PARTIAL',
      '數字接龍 ✅（LEDGER_REGISTRATION_MISSING', '文字接龍 ✅（LEDGER_ROLLBACK']) {
      assert.ok(messages[0].includes(fragment), `${fragment}\n${messages[0]}`);
    }
    assert.doesNotMatch(messages[0], /\d{17,20}|[A-Za-z]:\\|\.sqlite|XIAOJI_DATA_ROOT/u);

    // Only those cards are broken; the bot is degraded, not out, and the chat stays normal.
    assert.deepEqual(['welcome', 'word_chain', 'number_chain'].map((key) => third.protectedEffects.featureStatus(key)),
      [null, 'broken', 'broken']);
    const statusClient = {
      isReady: () => true,
      commands: new Map(['set-welcome', 'board', 'word-chain', 'number-chain', 'coins', 'daily', 'economy']
        .map((name) => [name, {}])),
      protectedEffects: third.protectedEffects,
    };
    const snapshot = await buildPublicStatusSnapshot(statusClient, { healthReader: async () => [],
      usageReader: async () => [] });
    const cards = Object.fromEntries(snapshot.features.map((feature) => [feature.key, feature.status]));
    assert.deepEqual([cards.core_chat, cards.welcome, cards.word_chain, cards.number_chain],
      ['normal', 'normal', 'broken', 'broken']);
    assert.equal(snapshot.bot.status, 'degraded');

    // The word chain round goes on: the answer is accepted, without a ✅.
    const accepted = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
      messageId: snowflake(Date.now(), 11n), userId: USER_ID, content: '球體', now: new Date() });
    assert.deepEqual([accepted.ok, accepted.duplicate, accepted.reactionSource], [true, false, null]);
    assert.deepEqual(requestsOf(third.rest, 'PUT', /reactions/u), []);
    // A healthy purpose still works: a new member is welcomed.
    assert.equal(welcomeJoin(third, '10000000000000079', Date.now()), true);
    await third.welcome.waitForIdleForTests();
    assert.equal(channelMessages(third.rest).length, 1);

    // The stop ends with the escalation exit code; the damaged files were not rebuilt.
    assert.equal(await third.stop(), 3);
    assert.equal(fs.existsSync(layout.paths('work.penalty.announce').database), false);
    assert.equal((await registrations())['number-chain.reaction'], undefined);
  });

test('the kill switch keeps all eight purposes shut, touching no ledger file and sending nothing protected; chat goes on, and the old switches change nothing',
  async (t) => {
    const layout = createLayout(t, 'kill-switch');
    await openCoinDatabase(layout, { fresh: true });
    resetWorkReminderRetryStateForTests();
    const ledgerDirectories = [layout.directories.ledgerDirectory, layout.directories.witnessDirectory];
    const legacyNames = (proc) => proc.logger.lines.filter(([, line]) => line.includes('code=LEDGER_LEGACY_VARIABLES_IGNORED'));
    const checks = { permissionCheck: () => true };

    // Every old switch says false: they are named once and ignored, and all eight purposes start.
    assert.equal(LEGACY_SWITCHES.length, PURPOSE_IDS.length);
    const first = createProcess(layout, { env: Object.fromEntries(LEGACY_SWITCHES.map((name) => [name, 'false'])) });
    // The watch sees the bootstrap at work (the control for the check below).
    const control = watchPaths(t, ledgerDirectories);
    const started = await first.preflight();
    control.stop();
    assert.ok(control.touched.length > 0);
    assert.equal(started.ledgers.size, PURPOSE_IDS.length);
    await first.ready();
    assert.equal(legacyNames(first).length, 1);
    assert.deepEqual([first.owner.isReady(), first.welcome.isReady()], [true, true]);
    for (const purposeId of PURPOSE_IDS.filter((id) => !['owner-safety', 'welcome'].includes(id))) {
      assert.equal(first.publicRuntime.isPurposeReady(purposeId), true, purposeId);
    }
    assert.equal(welcomeJoin(first, '10000000000000080', Date.now()), true);
    await first.welcome.waitForIdleForTests();
    assert.equal(channelMessages(first.rest).length, 1);
    // A word chain round that started while everything was on.
    await startWordChain({ guildId: GUILD_ID, channelId: CHANNEL_ID, actorId: USER_ID, seed: '地球', now: new Date() });
    assert.equal(await first.stop(), 0);

    // Work waiting for the next start: a penalty, a due reminder, a join.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const now = new Date().toISOString();
    await seedPenalty(1, now);
    const reminded = await seedReminderTask(1, { createdAt: now, dueAt: now });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const before = fileStates(ledgerDirectories);
    const registered = await registrations();

    // The kill switch, with every old switch saying true.
    await openCoinDatabase(layout);
    const watch = watchPaths(t, ledgerDirectories);
    const off = createProcess(layout, { env: { ...Object.fromEntries(LEGACY_SWITCHES.map((name) => [name, 'true'])),
      XIAOJI_PROTECTED_EFFECTS: 'off' } });
    const offStarted = await off.preflight();
    assert.equal(offStarted.ledgers.size, 0);
    await off.ready();
    assert.equal(legacyNames(off).length, 1);
    assert.deepEqual([off.owner.isReady(), off.welcome.isReady()], [false, false]);
    for (const purposeId of PURPOSE_IDS.filter((id) => !['owner-safety', 'welcome'].includes(id))) {
      assert.equal(off.publicRuntime.isPurposeReady(purposeId), false, purposeId);
    }
    const client = botClient(off.rest);
    await processWorkPenaltyAnnouncements(client);
    await processWorkReminders(client);
    assert.equal(welcomeJoin(off, '10000000000000081', Date.now()), false);
    // The round goes on without a ✅; a new round elsewhere cannot start (its ✅ fence stays shut).
    const accepted = await acceptWordChainMessage({ guildId: GUILD_ID, channelId: CHANNEL_ID,
      messageId: snowflake(Date.now(), 13n), userId: USER_ID, content: '球體', now: new Date() });
    assert.deepEqual([accepted.ok, accepted.duplicate, accepted.reactionSource], [true, false, null]);
    await processWordChainReactionOutbox(client, checks);
    await assert.rejects(startWordChain({ guildId: '10000000000000005', channelId: '10000000000000006',
      actorId: USER_ID, seed: '地球', now: new Date() }), (error) => error.code === 'REACTION_FENCE_OPEN_FAILED');

    // No protected request at all, and nothing used up: the work stays for a start with the switch on.
    assert.deepEqual(protectedCalls(off.rest), []);
    const waiting = await withCoinDatabase((api) => ({
      penalty: api.get('SELECT announced_at FROM coin_work_penalties WHERE id = 1').announced_at,
      reminders: Number(api.get('SELECT reminder_count FROM coin_work_tasks WHERE user_id = ?', [reminded]).reminder_count),
    }));
    assert.deepEqual(waiting, { penalty: null, reminders: 0 });
    // The three cards say maintenance; the chat stays normal and the bot is not degraded
    // (every public command registered, so no other card is broken).
    assert.deepEqual(['welcome', 'word_chain', 'number_chain'].map((key) => off.protectedEffects.featureStatus(key)),
      ['maintenance', 'maintenance', 'maintenance']);
    const snapshot = await buildPublicStatusSnapshot({
      isReady: () => true,
      commands: new Map(PUBLIC_FEATURES.flatMap((feature) => feature.commands || []).map((name) => [name, {}])),
      protectedEffects: off.protectedEffects,
    }, { healthReader: async () => [], usageReader: async () => [] });
    const cards = Object.fromEntries(snapshot.features.map((feature) => [feature.key, feature.status]));
    assert.deepEqual([cards.core_chat, cards.economy, cards.welcome, cards.word_chain, cards.number_chain],
      ['normal', 'normal', 'maintenance', 'maintenance', 'maintenance']);
    assert.equal(snapshot.bot.status, 'operational');
    assert.equal(await off.stop(), 0);
    watch.stop();

    // Not one fs call reached a ledger folder; all eight ledgers are byte for byte as before.
    assert.deepEqual(watch.touched, []);
    assert.deepEqual(fileStates(ledgerDirectories), before);
    for (const purposeId of PURPOSE_IDS) {
      const paths = layout.paths(purposeId);
      for (const file of [paths.database, paths.anchor, paths.receipt, paths.witness]) {
        assert.equal(fs.existsSync(file), true, `${purposeId} ${path.basename(file)}`);
      }
      for (const file of [paths.wal, paths.shm]) assert.equal(fs.existsSync(file), false, `${purposeId} ${path.basename(file)}`);
    }
    assert.deepEqual(await registrations(), registered);
  });
